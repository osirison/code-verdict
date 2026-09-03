/**
 * Hierarchical harness budgets with atomic reservations, actual-use
 * reconciliation, partitioned reserves, and per-member minimums (tasks
 * 8.4/8.5/8.6 of `add-agentic-review-harness`, design.md D12/D15, spec
 * `agentic-review-harness` "Budgets and retries degrade truthfully").
 *
 * Every numeric limit comes from the `HarnessPolicy` snapshotted onto the
 * run — this module reads the policy object it is given and nothing else.
 *
 * Model of the accounting:
 *
 * - Three counted pools (`modelTurns`, `toolCalls`, `evidenceBytes`), each
 *   partitioned at creation into three lanes: `ordinary`, `highRiskReserve`,
 *   `verificationReserve`. A reservation names a *purpose*; the purpose fixes
 *   which lanes it may draw from (`LANE_ORDER`). Exploration can only ever
 *   touch `ordinary`, so reserve capacity is protected structurally — there
 *   is no code path by which an exploration request reaches a reserve lane.
 * - For a changeset (more than one member) each member also owns a private
 *   slice of `ordinary` (the policy's per-member minimum) and of
 *   `highRiskReserve`. A member-scoped request drains its private slice
 *   before the shared lane, and no other member's request can ever be
 *   charged to it, which is what "before changeset members may consume
 *   shared budget" means here.
 * - Elapsed time and the per-turn tool cap are hard gates checked on every
 *   reservation rather than pools that are drawn down.
 * - `reserve` is all-or-nothing across pools: the charges are computed first
 *   and applied only if every pool can be satisfied, so a request is refused
 *   *before* anything is spent. `reconcile` may only release the difference
 *   between what was granted and what was actually used; it can never grow a
 *   reservation, so usage is monotonic except for that bounded release.
 * - Both operations are idempotent by `requestId`: a replayed reservation
 *   returns the original grant without charging again, and a replayed
 *   reconciliation returns the original result. A `requestId` reused for a
 *   different request is refused.
 * - The entry log is append-only; every view (`state()`, `consumption()`)
 *   is derived from bucket balances the log explains.
 */
import type { Limitation } from '../domain/harnessActivity';
import type { BudgetConsumption } from '../domain/harnessCoverage';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';

export const BUDGET_POOLS = ['modelTurns', 'toolCalls', 'evidenceBytes'] as const;
export type BudgetPool = (typeof BUDGET_POOLS)[number];

export const BUDGET_LANES = ['ordinary', 'highRiskReserve', 'verificationReserve'] as const;
export type BudgetLane = (typeof BUDGET_LANES)[number];

export const RESERVATION_PURPOSES = ['exploration', 'highRiskCoverage', 'verification'] as const;
export type ReservationPurpose = (typeof RESERVATION_PURPOSES)[number];

/** Which lanes each purpose may draw from, in order. Exploration never reaches a reserve. */
export const LANE_ORDER: Readonly<Record<ReservationPurpose, readonly BudgetLane[]>> = Object.freeze({
  exploration: Object.freeze(['ordinary'] as const),
  highRiskCoverage: Object.freeze(['ordinary', 'highRiskReserve'] as const),
  verification: Object.freeze(['verificationReserve', 'ordinary'] as const),
});

export const SHARED_OWNER = 'shared';

export type PoolAmounts = Readonly<Record<BudgetPool, number>>;

export interface PoolPartition {
  readonly total: number;
  readonly ordinary: number;
  readonly highRiskReserve: number;
  readonly verificationReserve: number;
}

export interface ReservePercents {
  readonly highRiskReservePercent: number;
  readonly verificationReservePercent: number;
  /** True when the policy's two percentages summed past 100 and the design defaults were used instead. */
  readonly fellBack: boolean;
}

/** Percentages that cannot both be honoured fall back to the documented defaults, per `HarnessPolicy`'s own fallback rule. */
export function resolveReservePercents(policy: Pick<HarnessPolicy, 'highRiskReservePercent' | 'verificationReservePercent'>): ReservePercents {
  const usable =
    Number.isFinite(policy.highRiskReservePercent) &&
    Number.isFinite(policy.verificationReservePercent) &&
    policy.highRiskReservePercent >= 0 &&
    policy.verificationReservePercent >= 0 &&
    policy.highRiskReservePercent + policy.verificationReservePercent <= 100;
  if (usable) {
    return { highRiskReservePercent: policy.highRiskReservePercent, verificationReservePercent: policy.verificationReservePercent, fellBack: false };
  }
  return {
    highRiskReservePercent: DEFAULT_HARNESS_POLICY.highRiskReservePercent,
    verificationReservePercent: DEFAULT_HARNESS_POLICY.verificationReservePercent,
    fellBack: true,
  };
}

/** Reserves floor; ordinary takes the remainder, so the three lanes always sum exactly to `total`. */
export function partitionPool(total: number, percents: ReservePercents): PoolPartition {
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0;
  const highRiskReserve = Math.floor((safeTotal * percents.highRiskReservePercent) / 100);
  const verificationReserve = Math.floor((safeTotal * percents.verificationReservePercent) / 100);
  return Object.freeze({ total: safeTotal, ordinary: safeTotal - highRiskReserve - verificationReserve, highRiskReserve, verificationReserve });
}

export interface BudgetRequest {
  /** Idempotency key: the tool/turn request identifier (D12 "idempotent by request identifier"). */
  readonly requestId: string;
  readonly purpose: ReservationPurpose;
  /** Present for member-scoped work in a changeset; absent for shared cross-member work or an individual review. */
  readonly memberId?: string;
  readonly modelTurns?: number;
  readonly toolCalls?: number;
  readonly evidenceBytes?: number;
  /** Caller-supplied attempt clock; the tracker never reads a wall clock itself. */
  readonly elapsedMs: number;
  /** Host-initiated dispatch (bootstrap manifest paging, head checks) is not part of a model turn and skips the per-turn cap. */
  readonly hostInitiated?: boolean;
}

export interface BudgetCharge {
  readonly pool: BudgetPool;
  readonly lane: BudgetLane;
  readonly owner: string;
  readonly amount: number;
}

export interface Reservation {
  readonly requestId: string;
  readonly purpose: ReservationPurpose;
  readonly memberId?: string;
  readonly granted: PoolAmounts;
  readonly charges: readonly BudgetCharge[];
  readonly hostInitiated: boolean;
  /** Set once `reconcile` has been applied. */
  readonly actual?: PoolAmounts;
}

export type ReservationRefusal =
  | 'cancelled'
  | 'timeout'
  | 'clockRegression'
  | 'invalidAmount'
  | 'unknownMember'
  | 'requestIdReused'
  | 'toolResultBound'
  | 'turnToolLimit'
  | 'exhausted';

export interface BudgetWarning {
  readonly code: 'budgetNearLimit' | 'ordinaryBudgetExhausted' | 'reserveFallback' | 'insufficientMemberMinimum';
  readonly pool?: BudgetPool;
  readonly memberId?: string;
  readonly usedPercent?: number;
  readonly remaining?: number;
  readonly message: string;
}

export type ReserveOutcome =
  | { readonly ok: true; readonly reservation: Reservation; readonly replayed: boolean; readonly warnings: readonly BudgetWarning[] }
  | { readonly ok: false; readonly code: ReservationRefusal; readonly pool?: BudgetPool; readonly message: string; readonly warnings: readonly BudgetWarning[] };

export type ReconcileRefusal = 'unknownReservation' | 'exceedsReservation' | 'alreadyReconciled' | 'invalidAmount';

export type ReconcileOutcome =
  | { readonly ok: true; readonly reservation: Reservation; readonly released: PoolAmounts; readonly replayed: boolean }
  | { readonly ok: false; readonly code: ReconcileRefusal; readonly pool?: BudgetPool; readonly message: string };

type ReconcileSuccess = Extract<ReconcileOutcome, { ok: true }>;

export interface BudgetLedgerEntry {
  readonly sequence: number;
  readonly elapsedMs: number;
  readonly kind: 'reserved' | 'refused' | 'reconciled' | 'reconcileRefused' | 'cancelled';
  readonly requestId?: string;
  readonly purpose?: ReservationPurpose;
  readonly memberId?: string;
  readonly code?: ReservationRefusal | ReconcileRefusal;
  readonly amounts?: PoolAmounts;
}

export interface LaneBalance {
  readonly capacity: number;
  readonly used: number;
  readonly remaining: number;
}

export interface PoolBalance extends LaneBalance {
  readonly lanes: Readonly<Record<BudgetLane, LaneBalance>>;
}

export interface MemberBalance {
  readonly privateOrdinary: Readonly<Record<BudgetPool, LaneBalance>>;
  readonly privateHighRiskReserve: Readonly<Record<BudgetPool, LaneBalance>>;
}

export interface BudgetState {
  readonly cancelled: boolean;
  readonly lastElapsedMs: number;
  readonly maxElapsedMs: number;
  readonly pools: Readonly<Record<BudgetPool, PoolBalance>>;
  readonly members: Readonly<Record<string, MemberBalance>>;
  readonly toolCallsThisTurn: number;
  /** Ordinary lane (shared plus every private slice) fully spent for the pool. */
  readonly ordinaryExhausted: Readonly<Record<BudgetPool, boolean>>;
  /** A pool with nothing left in any lane, or elapsed time at its limit — no further dispatch of any purpose is possible. */
  readonly hardExhausted: boolean;
  readonly timedOut: boolean;
  readonly setupWarnings: readonly BudgetWarning[];
}

export interface BudgetTrackerOptions {
  /** Changeset members; more than one enables per-member minimums (D15). */
  readonly members?: readonly string[];
  /** Percent of a pool's total capacity at which `budgetNearLimit` warnings begin. Default 80. */
  readonly nearLimitPercent?: number;
}

export interface BudgetTracker {
  readonly policy: Readonly<HarnessPolicy>;
  readonly reservePercents: ReservePercents;
  reserve(request: BudgetRequest): ReserveOutcome;
  /** Reserve one model turn and reset the per-turn tool counter. */
  beginTurn(request: Omit<BudgetRequest, 'modelTurns' | 'toolCalls' | 'evidenceBytes' | 'hostInitiated'>): ReserveOutcome;
  /** Record what a reservation actually used; releases the unused remainder, never charges more. */
  reconcile(requestId: string, actual: Partial<PoolAmounts>): ReconcileOutcome;
  /** Stop every new reservation synchronously; reconciliation of work already done stays allowed. */
  cancel(): void;
  reservation(requestId: string): Reservation | undefined;
  /** Whether a one-turn, one-tool-call request of this purpose would currently be granted. */
  canContinue(purpose: ReservationPurpose, elapsedMs: number, memberId?: string): boolean;
  state(): BudgetState;
  consumption(): BudgetConsumption;
  warnings(): readonly BudgetWarning[];
  entries(): readonly BudgetLedgerEntry[];
}

interface Bucket {
  readonly pool: BudgetPool;
  readonly lane: BudgetLane;
  readonly owner: string;
  readonly capacity: number;
  used: number;
}

interface MutableReservation {
  readonly requestId: string;
  readonly purpose: ReservationPurpose;
  readonly memberId?: string;
  readonly granted: PoolAmounts;
  readonly charges: BudgetCharge[];
  readonly hostInitiated: boolean;
  actual?: PoolAmounts;
  reconcileResult?: ReconcileSuccess;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function amountsOf(request: Pick<BudgetRequest, 'modelTurns' | 'toolCalls' | 'evidenceBytes'>): PoolAmounts | undefined {
  const amounts = { modelTurns: request.modelTurns ?? 0, toolCalls: request.toolCalls ?? 0, evidenceBytes: request.evidenceBytes ?? 0 };
  return BUDGET_POOLS.every((pool) => isNonNegativeInteger(amounts[pool])) ? Object.freeze(amounts) : undefined;
}

function sameAmounts(a: PoolAmounts, b: PoolAmounts): boolean {
  return BUDGET_POOLS.every((pool) => a[pool] === b[pool]);
}

function poolTotal(policy: HarnessPolicy, pool: BudgetPool): number {
  switch (pool) {
    case 'modelTurns':
      return policy.maxModelTurnsPerAttempt;
    case 'toolCalls':
      return policy.maxToolRequestsPerAttempt;
    case 'evidenceBytes':
      return policy.maxEvidenceBytesPerAttempt;
  }
}

function memberMinimum(policy: HarnessPolicy, pool: BudgetPool): number {
  switch (pool) {
    case 'modelTurns':
      return policy.changesetMemberMinimumTurns;
    case 'toolCalls':
      return policy.changesetMemberMinimumToolCalls;
    case 'evidenceBytes':
      return policy.changesetMemberMinimumEvidenceBytes;
  }
}

function balance(capacity: number, used: number): LaneBalance {
  return Object.freeze({ capacity, used, remaining: capacity - used });
}

export function budgetWarningLimitation(warning: BudgetWarning): Limitation {
  return { code: warning.code, message: warning.message };
}

export function createBudgetTracker(policy: HarnessPolicy, options: BudgetTrackerOptions = {}): BudgetTracker {
  const frozenPolicy: Readonly<HarnessPolicy> = Object.freeze({ ...policy });
  const reservePercents = resolveReservePercents(frozenPolicy);
  const nearLimitPercent = options.nearLimitPercent ?? 80;
  const members = [...new Set(options.members ?? [])];
  const changeset = members.length > 1;
  const setupWarnings: BudgetWarning[] = [];
  if (reservePercents.fellBack) {
    setupWarnings.push({
      code: 'reserveFallback',
      message: `Reserve percentages ${policy.highRiskReservePercent}% + ${policy.verificationReservePercent}% exceed 100%; using ${reservePercents.highRiskReservePercent}%/${reservePercents.verificationReservePercent}%.`,
    });
  }

  const buckets: Bucket[] = [];
  const partitions = {} as Record<BudgetPool, PoolPartition>;
  for (const pool of BUDGET_POOLS) {
    const partition = partitionPool(poolTotal(frozenPolicy, pool), reservePercents);
    partitions[pool] = partition;
    let sharedOrdinary = partition.ordinary;
    let sharedHighRisk = partition.highRiskReserve;
    if (changeset) {
      const wanted = memberMinimum(frozenPolicy, pool);
      const perMember = Math.min(wanted, Math.floor(partition.ordinary / members.length));
      if (perMember < wanted) {
        setupWarnings.push({
          code: 'insufficientMemberMinimum',
          pool,
          message: `${pool}: ordinary capacity ${partition.ordinary} cannot give ${members.length} members the minimum ${wanted} each; each receives ${perMember}.`,
        });
      }
      const perMemberHighRisk = Math.floor(partition.highRiskReserve / members.length);
      for (const memberId of members) {
        buckets.push({ pool, lane: 'ordinary', owner: memberId, capacity: perMember, used: 0 });
        buckets.push({ pool, lane: 'highRiskReserve', owner: memberId, capacity: perMemberHighRisk, used: 0 });
        sharedOrdinary -= perMember;
        sharedHighRisk -= perMemberHighRisk;
      }
    }
    buckets.push({ pool, lane: 'ordinary', owner: SHARED_OWNER, capacity: sharedOrdinary, used: 0 });
    buckets.push({ pool, lane: 'highRiskReserve', owner: SHARED_OWNER, capacity: sharedHighRisk, used: 0 });
    buckets.push({ pool, lane: 'verificationReserve', owner: SHARED_OWNER, capacity: partition.verificationReserve, used: 0 });
  }

  const reservations = new Map<string, MutableReservation>();
  const entries: BudgetLedgerEntry[] = [];
  let cancelled = false;
  let lastElapsedMs = 0;
  let toolCallsThisTurn = 0;
  let highRiskReserveUsed = 0;
  let verificationReserveUsed = 0;

  function log(entry: Omit<BudgetLedgerEntry, 'sequence'>): void {
    entries.push(Object.freeze({ sequence: entries.length + 1, ...entry }));
  }

  function bucket(pool: BudgetPool, lane: BudgetLane, owner: string): Bucket | undefined {
    return buckets.find((candidate) => candidate.pool === pool && candidate.lane === lane && candidate.owner === owner);
  }

  function candidateBuckets(pool: BudgetPool, purpose: ReservationPurpose, memberId: string | undefined): Bucket[] {
    const ordered: Bucket[] = [];
    for (const lane of LANE_ORDER[purpose]) {
      if (memberId !== undefined) {
        const privateBucket = bucket(pool, lane, memberId);
        if (privateBucket) ordered.push(privateBucket);
      }
      const shared = bucket(pool, lane, SHARED_OWNER);
      if (shared) ordered.push(shared);
    }
    return ordered;
  }

  /** Plans charges without applying them; `undefined` when the pool cannot be fully satisfied. */
  function plan(pool: BudgetPool, amount: number, purpose: ReservationPurpose, memberId: string | undefined): BudgetCharge[] | undefined {
    if (amount === 0) return [];
    const charges: BudgetCharge[] = [];
    let remaining = amount;
    for (const candidate of candidateBuckets(pool, purpose, memberId)) {
      const available = candidate.capacity - candidate.used;
      if (available <= 0) continue;
      const take = Math.min(available, remaining);
      charges.push(Object.freeze({ pool, lane: candidate.lane, owner: candidate.owner, amount: take }));
      remaining -= take;
      if (remaining === 0) return charges;
    }
    return undefined;
  }

  function view(reservation: MutableReservation): Reservation {
    return Object.freeze({
      requestId: reservation.requestId,
      purpose: reservation.purpose,
      ...(reservation.memberId !== undefined ? { memberId: reservation.memberId } : {}),
      granted: reservation.granted,
      charges: Object.freeze([...reservation.charges]),
      hostInitiated: reservation.hostInitiated,
      ...(reservation.actual !== undefined ? { actual: reservation.actual } : {}),
    });
  }

  function laneBalance(pool: BudgetPool, lane: BudgetLane): LaneBalance {
    let capacity = 0;
    let used = 0;
    for (const candidate of buckets) {
      if (candidate.pool === pool && candidate.lane === lane) {
        capacity += candidate.capacity;
        used += candidate.used;
      }
    }
    return balance(capacity, used);
  }

  function poolBalance(pool: BudgetPool): PoolBalance {
    const lanes = {} as Record<BudgetLane, LaneBalance>;
    let capacity = 0;
    let used = 0;
    for (const lane of BUDGET_LANES) {
      lanes[lane] = laneBalance(pool, lane);
      capacity += lanes[lane].capacity;
      used += lanes[lane].used;
    }
    return Object.freeze({ ...balance(capacity, used), lanes: Object.freeze(lanes) });
  }

  function currentWarnings(): BudgetWarning[] {
    const warnings: BudgetWarning[] = [...setupWarnings];
    for (const pool of BUDGET_POOLS) {
      const total = poolBalance(pool);
      if (total.capacity > 0) {
        const usedPercent = Math.floor((total.used * 100) / total.capacity);
        if (usedPercent >= nearLimitPercent) {
          warnings.push({ code: 'budgetNearLimit', pool, usedPercent, remaining: total.remaining, message: `${pool}: ${usedPercent}% of ${total.capacity} used; ${total.remaining} remaining.` });
        }
      }
      if (total.lanes.ordinary.remaining === 0) {
        warnings.push({ code: 'ordinaryBudgetExhausted', pool, remaining: 0, message: `${pool}: ordinary budget exhausted; only high-risk coverage and verification may continue.` });
      }
    }
    return warnings;
  }

  function refuse(request: BudgetRequest, code: ReservationRefusal, message: string, pool?: BudgetPool): ReserveOutcome {
    log({ elapsedMs: request.elapsedMs, kind: 'refused', requestId: request.requestId, purpose: request.purpose, memberId: request.memberId, code });
    return { ok: false, code, ...(pool !== undefined ? { pool } : {}), message, warnings: currentWarnings() };
  }

  function timedOut(elapsedMs: number): boolean {
    return elapsedMs >= frozenPolicy.maxElapsedMsPerAttempt;
  }

  function reserveInternal(request: BudgetRequest, resetTurn: boolean): ReserveOutcome {
    const amounts = amountsOf(request);
    if (amounts === undefined || !Number.isFinite(request.elapsedMs) || request.elapsedMs < 0) {
      return refuse(request, 'invalidAmount', 'Budget amounts and elapsed time must be non-negative integers.');
    }
    const existing = reservations.get(request.requestId);
    if (existing) {
      const matches =
        existing.purpose === request.purpose &&
        existing.memberId === request.memberId &&
        existing.hostInitiated === (request.hostInitiated === true) &&
        sameAmounts(existing.granted, amounts);
      if (!matches) return refuse(request, 'requestIdReused', `Request ${request.requestId} was already reserved with different parameters.`);
      return { ok: true, reservation: view(existing), replayed: true, warnings: currentWarnings() };
    }
    if (cancelled) return refuse(request, 'cancelled', 'The attempt was cancelled; no new budget can be reserved.');
    if (request.elapsedMs < lastElapsedMs) return refuse(request, 'clockRegression', `Elapsed time ${request.elapsedMs}ms is earlier than the last recorded ${lastElapsedMs}ms.`);
    if (timedOut(request.elapsedMs)) return refuse(request, 'timeout', `Elapsed time ${request.elapsedMs}ms reached the attempt limit of ${frozenPolicy.maxElapsedMsPerAttempt}ms.`);
    if (request.memberId !== undefined && changeset && !members.includes(request.memberId)) {
      return refuse(request, 'unknownMember', `Member ${request.memberId} has no budget allocation in this attempt.`);
    }
    if (amounts.evidenceBytes > frozenPolicy.maxToolResultBytes) {
      return refuse(request, 'toolResultBound', `${amounts.evidenceBytes} bytes exceeds the single-tool-result bound of ${frozenPolicy.maxToolResultBytes}.`, 'evidenceBytes');
    }
    if (request.hostInitiated !== true && amounts.toolCalls > 0 && toolCallsThisTurn + amounts.toolCalls > frozenPolicy.maxToolRequestsPerTurn) {
      return refuse(request, 'turnToolLimit', `${toolCallsThisTurn + amounts.toolCalls} tool requests in one turn exceeds the limit of ${frozenPolicy.maxToolRequestsPerTurn}.`, 'toolCalls');
    }
    const memberScope = changeset ? request.memberId : undefined;
    const charges: BudgetCharge[] = [];
    for (const pool of BUDGET_POOLS) {
      const planned = plan(pool, amounts[pool], request.purpose, memberScope);
      if (planned === undefined) {
        return refuse(request, 'exhausted', `${pool}: ${amounts[pool]} requested for ${request.purpose} but the allowed lanes cannot supply it.`, pool);
      }
      charges.push(...planned);
    }
    // Every pool can be satisfied: apply atomically.
    for (const charge of charges) {
      const target = bucket(charge.pool, charge.lane, charge.owner) as Bucket;
      target.used += charge.amount;
    }
    if (charges.some((charge) => charge.lane === 'highRiskReserve')) highRiskReserveUsed += 1;
    if (charges.some((charge) => charge.lane === 'verificationReserve')) verificationReserveUsed += 1;
    lastElapsedMs = request.elapsedMs;
    if (resetTurn) toolCallsThisTurn = 0;
    else if (request.hostInitiated !== true) toolCallsThisTurn += amounts.toolCalls;
    const reservation: MutableReservation = {
      requestId: request.requestId,
      purpose: request.purpose,
      memberId: request.memberId,
      granted: amounts,
      charges,
      hostInitiated: request.hostInitiated === true,
    };
    reservations.set(request.requestId, reservation);
    log({ elapsedMs: request.elapsedMs, kind: 'reserved', requestId: request.requestId, purpose: request.purpose, memberId: request.memberId, amounts });
    return { ok: true, reservation: view(reservation), replayed: false, warnings: currentWarnings() };
  }

  return {
    policy: frozenPolicy,
    reservePercents,

    reserve: (request) => reserveInternal(request, false),

    beginTurn: (request) => reserveInternal({ ...request, modelTurns: 1 }, true),

    reconcile(requestId, actualInput) {
      const reservation = reservations.get(requestId);
      if (!reservation) return { ok: false, code: 'unknownReservation', message: `No reservation ${requestId} exists.` };
      const actual = amountsOf({
        modelTurns: actualInput.modelTurns ?? reservation.granted.modelTurns,
        toolCalls: actualInput.toolCalls ?? reservation.granted.toolCalls,
        evidenceBytes: actualInput.evidenceBytes ?? reservation.granted.evidenceBytes,
      });
      if (actual === undefined) return { ok: false, code: 'invalidAmount', message: 'Actual usage must be non-negative integers.' };
      if (reservation.reconcileResult) {
        if (reservation.actual !== undefined && sameAmounts(reservation.actual, actual)) return { ...reservation.reconcileResult, replayed: true };
        return { ok: false, code: 'alreadyReconciled', message: `Reservation ${requestId} was already reconciled with different actual usage.` };
      }
      for (const pool of BUDGET_POOLS) {
        if (actual[pool] > reservation.granted[pool]) {
          log({ elapsedMs: lastElapsedMs, kind: 'reconcileRefused', requestId, code: 'exceedsReservation', amounts: actual });
          return {
            ok: false,
            code: 'exceedsReservation',
            pool,
            message: `${pool}: actual ${actual[pool]} exceeds the reserved ${reservation.granted[pool]}; the reservation stays fully charged.`,
          };
        }
      }
      const released = { modelTurns: 0, toolCalls: 0, evidenceBytes: 0 };
      for (const pool of BUDGET_POOLS) {
        let toRelease = reservation.granted[pool] - actual[pool];
        released[pool] = toRelease;
        // Unwind the last charges first, so a shared lane is refilled before a member's private slice.
        for (let index = reservation.charges.length - 1; index >= 0 && toRelease > 0; index -= 1) {
          const charge = reservation.charges[index] as BudgetCharge;
          if (charge.pool !== pool) continue;
          const give = Math.min(charge.amount, toRelease);
          const target = bucket(pool, charge.lane, charge.owner) as Bucket;
          target.used -= give;
          toRelease -= give;
        }
      }
      if (!reservation.hostInitiated) toolCallsThisTurn = Math.max(0, toolCallsThisTurn - released.toolCalls);
      reservation.actual = actual;
      const outcome: ReconcileSuccess = { ok: true, reservation: view(reservation), released: Object.freeze(released), replayed: false };
      reservation.reconcileResult = outcome;
      log({ elapsedMs: lastElapsedMs, kind: 'reconciled', requestId, amounts: actual });
      return outcome;
    },

    cancel() {
      if (cancelled) return;
      cancelled = true;
      log({ elapsedMs: lastElapsedMs, kind: 'cancelled' });
    },

    reservation(requestId) {
      const reservation = reservations.get(requestId);
      return reservation ? view(reservation) : undefined;
    },

    canContinue(purpose, elapsedMs, memberId) {
      if (cancelled || timedOut(elapsedMs) || elapsedMs < lastElapsedMs) return false;
      const memberScope = changeset ? memberId : undefined;
      return plan('modelTurns', 1, purpose, memberScope) !== undefined && plan('toolCalls', 1, purpose, memberScope) !== undefined;
    },

    state() {
      const pools = {} as Record<BudgetPool, PoolBalance>;
      const ordinaryExhausted = {} as Record<BudgetPool, boolean>;
      let poolExhausted = false;
      for (const pool of BUDGET_POOLS) {
        pools[pool] = poolBalance(pool);
        ordinaryExhausted[pool] = pools[pool].lanes.ordinary.remaining === 0;
        if (pools[pool].remaining === 0) poolExhausted = true;
      }
      const memberBalances: Record<string, MemberBalance> = {};
      if (changeset) {
        for (const memberId of members) {
          const privateOrdinary = {} as Record<BudgetPool, LaneBalance>;
          const privateHighRiskReserve = {} as Record<BudgetPool, LaneBalance>;
          for (const pool of BUDGET_POOLS) {
            const ordinary = bucket(pool, 'ordinary', memberId) as Bucket;
            const highRisk = bucket(pool, 'highRiskReserve', memberId) as Bucket;
            privateOrdinary[pool] = balance(ordinary.capacity, ordinary.used);
            privateHighRiskReserve[pool] = balance(highRisk.capacity, highRisk.used);
          }
          memberBalances[memberId] = Object.freeze({ privateOrdinary: Object.freeze(privateOrdinary), privateHighRiskReserve: Object.freeze(privateHighRiskReserve) });
        }
      }
      const isTimedOut = timedOut(lastElapsedMs);
      return Object.freeze({
        cancelled,
        lastElapsedMs,
        maxElapsedMs: frozenPolicy.maxElapsedMsPerAttempt,
        pools: Object.freeze(pools),
        members: Object.freeze(memberBalances),
        toolCallsThisTurn,
        ordinaryExhausted: Object.freeze(ordinaryExhausted),
        hardExhausted: poolExhausted || isTimedOut,
        timedOut: isTimedOut,
        setupWarnings: Object.freeze([...setupWarnings]),
      });
    },

    consumption() {
      return Object.freeze({
        modelTurnsUsed: poolBalance('modelTurns').used,
        toolCallsUsed: poolBalance('toolCalls').used,
        evidenceBytesUsed: poolBalance('evidenceBytes').used,
        elapsedMs: lastElapsedMs,
        // Counts of reservations that drew on each reserve — a unit-consistent measure across the three pools.
        highRiskReserveUsed,
        verificationReserveUsed,
      });
    },

    warnings: () => Object.freeze(currentWarnings()),
    entries: () => Object.freeze([...entries]),
  };
}
