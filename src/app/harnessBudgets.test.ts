import { describe, expect, it } from 'vitest';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import {
  budgetWarningLimitation,
  createBudgetTracker,
  LANE_ORDER,
  partitionPool,
  resolveReservePercents,
  type BudgetRequest,
  type BudgetTracker,
} from './harnessBudgets';

/** Small round numbers so every lane balance below is checkable by hand: turns 20 -> 13/4/3, tools 100 -> 65/20/15, bytes 10000 -> 6500/2000/1500. */
const POLICY: HarnessPolicy = normalizeHarnessPolicy({
  maxModelTurnsPerAttempt: 20,
  maxToolRequestsPerAttempt: 100,
  maxEvidenceBytesPerAttempt: 10_000,
  maxToolRequestsPerTurn: 4,
  maxToolResultBytes: 2_000,
  maxElapsedMsPerAttempt: 1_000,
  highRiskReservePercent: 20,
  verificationReservePercent: 15,
  changesetMemberMinimumTurns: 1,
  changesetMemberMinimumToolCalls: 4,
  changesetMemberMinimumEvidenceBytes: 1_000,
});

let counter = 0;
function request(overrides: Partial<BudgetRequest> & Pick<BudgetRequest, 'purpose'>): BudgetRequest {
  counter += 1;
  return { requestId: `req-${counter}`, elapsedMs: 0, ...overrides };
}

function drain(tracker: BudgetTracker, purpose: BudgetRequest['purpose'], pool: 'toolCalls' | 'modelTurns' | 'evidenceBytes', amount: number, memberId?: string): void {
  const outcome = tracker.reserve(request({ purpose, [pool]: amount, hostInitiated: true, memberId }));
  expect(outcome.ok).toBe(true);
}

describe('reserve partitioning (task 8.5 arithmetic)', () => {
  it('floors each reserve and gives ordinary the remainder so lanes sum to the total', () => {
    const percents = resolveReservePercents(POLICY);
    expect(partitionPool(20, percents)).toEqual({ total: 20, ordinary: 13, highRiskReserve: 4, verificationReserve: 3 });
    expect(partitionPool(7, percents)).toEqual({ total: 7, ordinary: 5, highRiskReserve: 1, verificationReserve: 1 });
    expect(partitionPool(1, percents)).toEqual({ total: 1, ordinary: 1, highRiskReserve: 0, verificationReserve: 0 });
    expect(partitionPool(0, percents)).toEqual({ total: 0, ordinary: 0, highRiskReserve: 0, verificationReserve: 0 });
    expect(partitionPool(-5, percents).total).toBe(0);
  });

  it('falls back to the documented defaults when the two percentages cannot both be honoured', () => {
    expect(resolveReservePercents({ highRiskReservePercent: 60, verificationReservePercent: 50 })).toEqual({
      highRiskReservePercent: DEFAULT_HARNESS_POLICY.highRiskReservePercent,
      verificationReservePercent: DEFAULT_HARNESS_POLICY.verificationReservePercent,
      fellBack: true,
    });
    expect(resolveReservePercents({ highRiskReservePercent: 50, verificationReservePercent: 50 }).fellBack).toBe(false);
    const tracker = createBudgetTracker({ ...POLICY, highRiskReservePercent: 90, verificationReservePercent: 90 });
    expect(tracker.state().setupWarnings.map((warning) => warning.code)).toEqual(['reserveFallback']);
    expect(tracker.state().pools.modelTurns.lanes).toMatchObject({ ordinary: { capacity: 13 }, highRiskReserve: { capacity: 4 }, verificationReserve: { capacity: 3 } });
  });

  it('reads every limit from the snapshotted policy object it was given', () => {
    const tracker = createBudgetTracker(POLICY);
    expect(tracker.policy).toEqual(POLICY);
    expect(Object.isFrozen(tracker.policy)).toBe(true);
    expect(tracker.state().pools).toMatchObject({
      modelTurns: { capacity: 20, lanes: { ordinary: { capacity: 13 }, highRiskReserve: { capacity: 4 }, verificationReserve: { capacity: 3 } } },
      toolCalls: { capacity: 100, lanes: { ordinary: { capacity: 65 }, highRiskReserve: { capacity: 20 }, verificationReserve: { capacity: 15 } } },
      evidenceBytes: { capacity: 10_000, lanes: { ordinary: { capacity: 6_500 }, highRiskReserve: { capacity: 2_000 }, verificationReserve: { capacity: 1_500 } } },
    });
    expect(tracker.state().maxElapsedMs).toBe(1_000);
  });
});

describe('atomic reservations and reconciliation (task 8.4)', () => {
  it('grants a request across pools and records it exactly once', () => {
    const tracker = createBudgetTracker(POLICY);
    const outcome = tracker.reserve({ requestId: 'r1', purpose: 'exploration', toolCalls: 2, evidenceBytes: 1_500, elapsedMs: 10 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.replayed).toBe(false);
    expect(outcome.reservation.granted).toEqual({ modelTurns: 0, toolCalls: 2, evidenceBytes: 1_500 });
    expect(outcome.reservation.charges).toEqual([
      { pool: 'toolCalls', lane: 'ordinary', owner: 'shared', amount: 2 },
      { pool: 'evidenceBytes', lane: 'ordinary', owner: 'shared', amount: 1_500 },
    ]);
    expect(tracker.consumption()).toMatchObject({ toolCallsUsed: 2, evidenceBytesUsed: 1_500, modelTurnsUsed: 0, elapsedMs: 10 });
    expect(tracker.entries().map((entry) => entry.kind)).toEqual(['reserved']);
  });

  it('refuses before spending anything when one pool cannot be satisfied', () => {
    const tracker = createBudgetTracker(POLICY);
    drain(tracker, 'exploration', 'toolCalls', 65); // ordinary tool calls gone
    const before = tracker.state();
    const outcome = tracker.reserve({ requestId: 'x', purpose: 'exploration', toolCalls: 1, evidenceBytes: 500, elapsedMs: 5 });
    expect(outcome).toMatchObject({ ok: false, code: 'exhausted', pool: 'toolCalls' });
    expect(tracker.state().pools.evidenceBytes.used).toBe(before.pools.evidenceBytes.used);
    expect(tracker.entries().at(-1)).toMatchObject({ kind: 'refused', code: 'exhausted', requestId: 'x' });
  });

  it('is idempotent by request id and refuses a reused id with different parameters', () => {
    const tracker = createBudgetTracker(POLICY);
    const first = tracker.reserve({ requestId: 'dup', purpose: 'exploration', toolCalls: 3, elapsedMs: 1 });
    const replay = tracker.reserve({ requestId: 'dup', purpose: 'exploration', toolCalls: 3, elapsedMs: 2 });
    expect(first.ok && replay.ok && replay.replayed).toBe(true);
    expect(tracker.consumption().toolCallsUsed).toBe(3);
    expect(tracker.reserve({ requestId: 'dup', purpose: 'exploration', toolCalls: 4, elapsedMs: 3 })).toMatchObject({ ok: false, code: 'requestIdReused' });
    expect(tracker.reserve({ requestId: 'dup', purpose: 'verification', toolCalls: 3, elapsedMs: 3 })).toMatchObject({ ok: false, code: 'requestIdReused' });
    expect(tracker.consumption().toolCallsUsed).toBe(3);
  });

  it('reconciles actual use downwards, releasing the unused remainder, and is idempotent', () => {
    const tracker = createBudgetTracker(POLICY);
    tracker.reserve({ requestId: 'r', purpose: 'exploration', toolCalls: 1, evidenceBytes: 2_000, elapsedMs: 1 });
    const outcome = tracker.reconcile('r', { evidenceBytes: 700 });
    expect(outcome).toMatchObject({ ok: true, released: { modelTurns: 0, toolCalls: 0, evidenceBytes: 1_300 }, replayed: false });
    expect(tracker.consumption().evidenceBytesUsed).toBe(700);
    expect(tracker.reservation('r')?.actual).toEqual({ modelTurns: 0, toolCalls: 1, evidenceBytes: 700 });
    expect(tracker.reconcile('r', { evidenceBytes: 700 })).toMatchObject({ ok: true, replayed: true });
    expect(tracker.consumption().evidenceBytesUsed).toBe(700);
    expect(tracker.reconcile('r', { evidenceBytes: 100 })).toMatchObject({ ok: false, code: 'alreadyReconciled' });
    expect(tracker.consumption().evidenceBytesUsed).toBe(700);
  });

  it('never lets reconciliation grow a reservation: overspend is refused and the grant stays charged', () => {
    const tracker = createBudgetTracker(POLICY);
    tracker.reserve({ requestId: 'r', purpose: 'exploration', evidenceBytes: 1_000, elapsedMs: 1 });
    expect(tracker.reconcile('r', { evidenceBytes: 1_001 })).toMatchObject({ ok: false, code: 'exceedsReservation', pool: 'evidenceBytes' });
    expect(tracker.consumption().evidenceBytesUsed).toBe(1_000);
    expect(tracker.reservation('r')?.actual).toBeUndefined();
    expect(tracker.entries().at(-1)).toMatchObject({ kind: 'reconcileRefused', code: 'exceedsReservation' });
    expect(tracker.reconcile('missing', {})).toMatchObject({ ok: false, code: 'unknownReservation' });
    expect(tracker.reconcile('r', { evidenceBytes: -1 })).toMatchObject({ ok: false, code: 'invalidAmount' });
    expect(tracker.reconcile('r', { evidenceBytes: 2.5 })).toMatchObject({ ok: false, code: 'invalidAmount' });
  });

  it('enforces the single-tool-result bound before touching any pool', () => {
    const tracker = createBudgetTracker(POLICY);
    expect(tracker.reserve({ requestId: 'big', purpose: 'exploration', evidenceBytes: 2_001, elapsedMs: 0 })).toMatchObject({ ok: false, code: 'toolResultBound', pool: 'evidenceBytes' });
    expect(tracker.consumption().evidenceBytesUsed).toBe(0);
  });

  it('caps tool requests per model turn, resets on a new turn, and exempts host-initiated dispatch', () => {
    const tracker = createBudgetTracker(POLICY);
    expect(tracker.beginTurn({ requestId: 't1', purpose: 'exploration', elapsedMs: 0 }).ok).toBe(true);
    expect(tracker.consumption().modelTurnsUsed).toBe(1);
    for (let index = 0; index < 4; index += 1) expect(tracker.reserve({ requestId: `t1-${index}`, purpose: 'exploration', toolCalls: 1, elapsedMs: 1 }).ok).toBe(true);
    expect(tracker.reserve({ requestId: 't1-5', purpose: 'exploration', toolCalls: 1, elapsedMs: 1 })).toMatchObject({ ok: false, code: 'turnToolLimit', pool: 'toolCalls' });
    expect(tracker.reserve({ requestId: 'host', purpose: 'exploration', toolCalls: 1, elapsedMs: 1, hostInitiated: true }).ok).toBe(true);
    expect(tracker.state().toolCallsThisTurn).toBe(4);
    expect(tracker.beginTurn({ requestId: 't2', purpose: 'exploration', elapsedMs: 2 }).ok).toBe(true);
    expect(tracker.state().toolCallsThisTurn).toBe(0);
    expect(tracker.reserve({ requestId: 't2-0', purpose: 'exploration', toolCalls: 4, elapsedMs: 2 }).ok).toBe(true);
    // Reconciling a batch down also frees per-turn headroom for the tool requests that were never dispatched.
    tracker.reconcile('t2-0', { toolCalls: 2 });
    expect(tracker.state().toolCallsThisTurn).toBe(2);
    expect(tracker.reserve({ requestId: 't2-1', purpose: 'exploration', toolCalls: 2, elapsedMs: 2 }).ok).toBe(true);
    // Replaying beginTurn does not reset the counter a second time.
    expect(tracker.beginTurn({ requestId: 't2', purpose: 'exploration', elapsedMs: 2 })).toMatchObject({ ok: true, replayed: true });
    expect(tracker.state().toolCallsThisTurn).toBe(4);
  });

  it('enforces the elapsed-time budget and monotonic elapsed time', () => {
    const tracker = createBudgetTracker(POLICY);
    expect(tracker.reserve({ requestId: 'a', purpose: 'exploration', toolCalls: 1, elapsedMs: 500 }).ok).toBe(true);
    expect(tracker.reserve({ requestId: 'b', purpose: 'exploration', toolCalls: 1, elapsedMs: 499 })).toMatchObject({ ok: false, code: 'clockRegression' });
    expect(tracker.reserve({ requestId: 'c', purpose: 'verification', toolCalls: 1, elapsedMs: 1_000 })).toMatchObject({ ok: false, code: 'timeout' });
    expect(tracker.state().timedOut).toBe(false); // last *accepted* elapsed is 500
    expect(tracker.canContinue('verification', 1_000)).toBe(false);
    expect(tracker.canContinue('verification', 999)).toBe(true);
    expect(tracker.reserve({ requestId: 'd', purpose: 'exploration', elapsedMs: -1 })).toMatchObject({ ok: false, code: 'invalidAmount' });
    expect(tracker.reserve({ requestId: 'e', purpose: 'exploration', toolCalls: 1.5, elapsedMs: 600 })).toMatchObject({ ok: false, code: 'invalidAmount' });
  });

  it('stops new reservations synchronously on cancel while still reconciling finished work', () => {
    const tracker = createBudgetTracker(POLICY);
    tracker.reserve({ requestId: 'r', purpose: 'exploration', evidenceBytes: 1_000, elapsedMs: 1 });
    tracker.cancel();
    tracker.cancel();
    expect(tracker.reserve({ requestId: 's', purpose: 'verification', toolCalls: 1, elapsedMs: 2 })).toMatchObject({ ok: false, code: 'cancelled' });
    expect(tracker.reconcile('r', { evidenceBytes: 10 })).toMatchObject({ ok: true });
    expect(tracker.state().cancelled).toBe(true);
    expect(tracker.canContinue('exploration', 2)).toBe(false);
    expect(tracker.entries().filter((entry) => entry.kind === 'cancelled')).toHaveLength(1);
  });

  it('keeps an append-only ledger with strictly increasing sequence numbers', () => {
    const tracker = createBudgetTracker(POLICY);
    tracker.reserve({ requestId: 'a', purpose: 'exploration', toolCalls: 1, elapsedMs: 1 });
    tracker.reserve({ requestId: 'b', purpose: 'exploration', evidenceBytes: 9_999, elapsedMs: 1 });
    tracker.reconcile('a', { toolCalls: 0 });
    const entries = tracker.entries();
    expect(entries.map((entry) => entry.sequence)).toEqual([1, 2, 3]);
    expect(entries.map((entry) => entry.kind)).toEqual(['reserved', 'refused', 'reconciled']);
    expect(Object.isFrozen(entries)).toBe(true);
  });

  it('warns near a pool limit and when the ordinary lane is exhausted, as limitations the projection can carry', () => {
    const tracker = createBudgetTracker(POLICY);
    for (let index = 0; index < 13; index += 1) expect(tracker.beginTurn({ requestId: `turn-${index}`, purpose: 'exploration', elapsedMs: index }).ok).toBe(true);
    const warnings = tracker.warnings();
    expect(warnings.map((warning) => warning.code)).toEqual(['ordinaryBudgetExhausted']);
    expect(warnings[0]?.pool).toBe('modelTurns');
    for (let index = 0; index < 3; index += 1) expect(tracker.beginTurn({ requestId: `hr-${index}`, purpose: 'highRiskCoverage', elapsedMs: 20 }).ok).toBe(true);
    const near = tracker.warnings();
    expect(near.map((warning) => warning.code).sort()).toEqual(['budgetNearLimit', 'ordinaryBudgetExhausted']);
    expect(near.find((warning) => warning.code === 'budgetNearLimit')).toMatchObject({ pool: 'modelTurns', usedPercent: 80, remaining: 4 });
    expect(budgetWarningLimitation(near[0] as never)).toEqual({ code: near[0]?.code, message: near[0]?.message });
    const outcome = tracker.beginTurn({ requestId: 'hr-3', purpose: 'highRiskCoverage', elapsedMs: 21 });
    expect(outcome.ok && outcome.warnings.length).toBe(2);
  });

  it('reports hard exhaustion once a pool has nothing left in any lane', () => {
    const tracker = createBudgetTracker(POLICY);
    for (let index = 0; index < 13; index += 1) tracker.beginTurn({ requestId: `o-${index}`, purpose: 'exploration', elapsedMs: 1 });
    for (let index = 0; index < 4; index += 1) tracker.beginTurn({ requestId: `h-${index}`, purpose: 'highRiskCoverage', elapsedMs: 1 });
    for (let index = 0; index < 3; index += 1) tracker.beginTurn({ requestId: `v-${index}`, purpose: 'verification', elapsedMs: 1 });
    expect(tracker.state().pools.modelTurns.remaining).toBe(0);
    expect(tracker.state().hardExhausted).toBe(true);
    expect(tracker.canContinue('verification', 1)).toBe(false);
    expect(tracker.consumption()).toMatchObject({ modelTurnsUsed: 20, highRiskReserveUsed: 4, verificationReserveUsed: 3 });
  });
});

describe('reserve partitions and lane access (task 8.5)', () => {
  it('declares lane access per purpose with exploration confined to ordinary', () => {
    expect(LANE_ORDER.exploration).toEqual(['ordinary']);
    expect(LANE_ORDER.highRiskCoverage).toEqual(['ordinary', 'highRiskReserve']);
    expect(LANE_ORDER.verification).toEqual(['verificationReserve', 'ordinary']);
  });

  it('refuses exploration once ordinary is spent even though reserves remain', () => {
    const tracker = createBudgetTracker(POLICY);
    drain(tracker, 'exploration', 'toolCalls', 65);
    expect(tracker.reserve(request({ purpose: 'exploration', toolCalls: 1, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted', pool: 'toolCalls' });
    expect(tracker.state().pools.toolCalls.lanes.highRiskReserve.remaining).toBe(20);
    expect(tracker.state().pools.toolCalls.lanes.verificationReserve.remaining).toBe(15);
    expect(tracker.state().ordinaryExhausted.toolCalls).toBe(true);
    expect(tracker.canContinue('exploration', 1)).toBe(false);
    expect(tracker.canContinue('highRiskCoverage', 1)).toBe(true);
    expect(tracker.canContinue('verification', 1)).toBe(true);
  });

  it('lets high-risk coverage continue from its reserve and never from the verification reserve', () => {
    const tracker = createBudgetTracker(POLICY);
    drain(tracker, 'exploration', 'toolCalls', 65);
    const outcome = tracker.reserve(request({ purpose: 'highRiskCoverage', toolCalls: 20, hostInitiated: true }));
    expect(outcome.ok && outcome.reservation.charges).toEqual([{ pool: 'toolCalls', lane: 'highRiskReserve', owner: 'shared', amount: 20 }]);
    expect(tracker.reserve(request({ purpose: 'highRiskCoverage', toolCalls: 1, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted' });
    expect(tracker.state().pools.toolCalls.lanes.verificationReserve.remaining).toBe(15);
  });

  it('funds final verification from its reserve first, then leftover ordinary, never the high-risk reserve', () => {
    const tracker = createBudgetTracker(POLICY);
    drain(tracker, 'exploration', 'toolCalls', 60); // 5 ordinary left
    const first = tracker.reserve(request({ purpose: 'verification', toolCalls: 17, hostInitiated: true }));
    expect(first.ok && first.reservation.charges).toEqual([
      { pool: 'toolCalls', lane: 'verificationReserve', owner: 'shared', amount: 15 },
      { pool: 'toolCalls', lane: 'ordinary', owner: 'shared', amount: 2 },
    ]);
    expect(tracker.reserve(request({ purpose: 'verification', toolCalls: 4, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted' });
    expect(tracker.state().pools.toolCalls.lanes.highRiskReserve.remaining).toBe(20);
  });

  it('splits one reservation across lanes and unwinds the later lane first on reconciliation', () => {
    const tracker = createBudgetTracker(POLICY);
    drain(tracker, 'exploration', 'toolCalls', 63); // 2 ordinary left
    const outcome = tracker.reserve({ requestId: 'split', purpose: 'highRiskCoverage', toolCalls: 5, elapsedMs: 1, hostInitiated: true });
    expect(outcome.ok && outcome.reservation.charges).toEqual([
      { pool: 'toolCalls', lane: 'ordinary', owner: 'shared', amount: 2 },
      { pool: 'toolCalls', lane: 'highRiskReserve', owner: 'shared', amount: 3 },
    ]);
    tracker.reconcile('split', { toolCalls: 3 });
    expect(tracker.state().pools.toolCalls.lanes.highRiskReserve.used).toBe(1);
    expect(tracker.state().pools.toolCalls.lanes.ordinary.remaining).toBe(0);
  });
});

describe('changeset per-member minimums (task 8.6)', () => {
  const MEMBERS = ['m1', 'm2', 'm3'];

  it('carves each member a private minimum out of ordinary and a private share of the high-risk reserve', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    const state = tracker.state();
    expect(state.setupWarnings).toEqual([]);
    for (const memberId of MEMBERS) {
      expect(state.members[memberId]?.privateOrdinary).toMatchObject({ modelTurns: { capacity: 1 }, toolCalls: { capacity: 4 }, evidenceBytes: { capacity: 1_000 } });
      expect(state.members[memberId]?.privateHighRiskReserve).toMatchObject({ modelTurns: { capacity: 1 }, toolCalls: { capacity: 6 }, evidenceBytes: { capacity: 666 } });
    }
    // Lane totals are unchanged by the carve-out: private + shared still equals the partition.
    expect(state.pools.toolCalls.lanes.ordinary.capacity).toBe(65);
    expect(state.pools.toolCalls.lanes.highRiskReserve.capacity).toBe(20);
  });

  it('drains a member\'s private minimum before the shared pool and never touches another member\'s', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    const first = tracker.reserve(request({ purpose: 'exploration', memberId: 'm1', toolCalls: 4, hostInitiated: true }));
    expect(first.ok && first.reservation.charges).toEqual([{ pool: 'toolCalls', lane: 'ordinary', owner: 'm1', amount: 4 }]);
    const second = tracker.reserve(request({ purpose: 'exploration', memberId: 'm1', toolCalls: 1, hostInitiated: true }));
    expect(second.ok && second.reservation.charges).toEqual([{ pool: 'toolCalls', lane: 'ordinary', owner: 'shared', amount: 1 }]);
    expect(tracker.state().members.m2?.privateOrdinary.toolCalls.used).toBe(0);
    expect(tracker.state().members.m3?.privateOrdinary.toolCalls.used).toBe(0);
  });

  it('keeps every other member\'s minimum available after one member exhausts the shared pool', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    drain(tracker, 'exploration', 'toolCalls', 4 + 53, 'm1'); // m1's private 4 + all 53 shared ordinary
    expect(tracker.reserve(request({ purpose: 'exploration', memberId: 'm1', toolCalls: 1, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted' });
    for (const memberId of ['m2', 'm3']) {
      const outcome = tracker.reserve(request({ purpose: 'exploration', memberId, toolCalls: 4, hostInitiated: true }));
      expect(outcome.ok && outcome.reservation.charges).toEqual([{ pool: 'toolCalls', lane: 'ordinary', owner: memberId, amount: 4 }]);
    }
    expect(tracker.state().ordinaryExhausted.toolCalls).toBe(true);
  });

  it('gives shared (memberless) work access to the shared lane only, never a private slice', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    drain(tracker, 'exploration', 'toolCalls', 53); // shared ordinary gone
    expect(tracker.reserve(request({ purpose: 'exploration', toolCalls: 1, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted' });
    for (const memberId of MEMBERS) expect(tracker.state().members[memberId]?.privateOrdinary.toolCalls.used).toBe(0);
  });

  it('protects each member\'s high-risk reserve share', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    drain(tracker, 'exploration', 'toolCalls', 4 + 53, 'm1');
    const outcome = tracker.reserve(request({ purpose: 'highRiskCoverage', memberId: 'm1', toolCalls: 8, hostInitiated: true }));
    expect(outcome.ok && outcome.reservation.charges).toEqual([
      { pool: 'toolCalls', lane: 'highRiskReserve', owner: 'm1', amount: 6 },
      { pool: 'toolCalls', lane: 'highRiskReserve', owner: 'shared', amount: 2 },
    ]);
    expect(tracker.reserve(request({ purpose: 'highRiskCoverage', memberId: 'm1', toolCalls: 1, hostInitiated: true }))).toMatchObject({ ok: false, code: 'exhausted' });
    expect(tracker.state().members.m2?.privateHighRiskReserve.toolCalls.remaining).toBe(6);
    const m2 = tracker.reserve(request({ purpose: 'highRiskCoverage', memberId: 'm2', toolCalls: 6, hostInitiated: true }));
    expect(m2.ok && m2.reservation.charges).toEqual([
      { pool: 'toolCalls', lane: 'ordinary', owner: 'm2', amount: 4 },
      { pool: 'toolCalls', lane: 'highRiskReserve', owner: 'm2', amount: 2 },
    ]);
  });

  it('refuses a member that has no allocation', () => {
    const tracker = createBudgetTracker(POLICY, { members: MEMBERS });
    expect(tracker.reserve(request({ purpose: 'exploration', memberId: 'm9', toolCalls: 1 }))).toMatchObject({ ok: false, code: 'unknownMember' });
  });

  it('degrades truthfully when the ordinary pool cannot fund every member\'s configured minimum', () => {
    const tracker = createBudgetTracker({ ...POLICY, changesetMemberMinimumEvidenceBytes: 4_000 }, { members: MEMBERS });
    const state = tracker.state();
    expect(state.setupWarnings).toEqual([expect.objectContaining({ code: 'insufficientMemberMinimum', pool: 'evidenceBytes' })]);
    for (const memberId of MEMBERS) expect(state.members[memberId]?.privateOrdinary.evidenceBytes.capacity).toBe(2_166);
    expect(state.pools.evidenceBytes.lanes.ordinary.capacity).toBe(6_500);
    expect(tracker.warnings().map((warning) => warning.code)).toContain('insufficientMemberMinimum');
  });

  it('treats a single member as an individual review: no private slices, member id accepted', () => {
    const tracker = createBudgetTracker(POLICY, { members: ['only'] });
    expect(tracker.state().members).toEqual({});
    const outcome = tracker.reserve(request({ purpose: 'exploration', memberId: 'only', toolCalls: 1 }));
    expect(outcome.ok && outcome.reservation.charges).toEqual([{ pool: 'toolCalls', lane: 'ordinary', owner: 'shared', amount: 1 }]);
    expect(tracker.reserve(request({ purpose: 'exploration', memberId: 'other', toolCalls: 1 })).ok).toBe(true);
  });
});

describe('carried-forward consumption on a resumed attempt (task 14.6)', () => {
  // Ordinary/highRisk/verification for each pool, from this file's own POLICY comment:
  // turns 20 -> 13/4/3, tools 100 -> 65/20/15, bytes 10000 -> 6500/2000/1500.
  it('seeds pool totals cumulatively, resets elapsed time, and copies reserve counts verbatim', () => {
    const tracker = createBudgetTracker(POLICY, {
      carryForward: { modelTurnsUsed: 5, toolCallsUsed: 10, evidenceBytesUsed: 100, elapsedMs: 999_999, highRiskReserveUsed: 2, verificationReserveUsed: 1 },
    });
    expect(tracker.consumption()).toMatchObject({
      modelTurnsUsed: 5, toolCallsUsed: 10, evidenceBytesUsed: 100, elapsedMs: 0, highRiskReserveUsed: 2, verificationReserveUsed: 1,
    });
    const pool = tracker.state().pools.modelTurns;
    expect(pool.lanes.ordinary.used).toBe(5);
    expect(pool.used).toBe(5);
    expect(tracker.entries().map((e) => e.kind)).toEqual(['seeded']);
  });

  it('spends the ordinary lane before spilling into the reserves, in order', () => {
    const tracker = createBudgetTracker(POLICY, {
      carryForward: { modelTurnsUsed: 15, toolCallsUsed: 0, evidenceBytesUsed: 0, elapsedMs: 0, highRiskReserveUsed: 0, verificationReserveUsed: 0 },
    });
    const lanes = tracker.state().pools.modelTurns.lanes;
    expect(lanes.ordinary.used).toBe(13); // ordinary capacity, fully spent first
    expect(lanes.highRiskReserve.used).toBe(2); // the 2 left over
    expect(lanes.verificationReserve.used).toBe(0);
  });

  it('clamps a carried total that exceeds this attempt\'s whole pool capacity and warns rather than throwing', () => {
    const tracker = createBudgetTracker(POLICY, {
      carryForward: { modelTurnsUsed: 25, toolCallsUsed: 0, evidenceBytesUsed: 0, elapsedMs: 0, highRiskReserveUsed: 0, verificationReserveUsed: 0 },
    });
    const pool = tracker.state().pools.modelTurns;
    expect(pool.used).toBe(20); // 13 + 4 + 3: every lane exhausted, never more than capacity
    // Alongside whatever live near-limit/exhausted warnings the now fully-spent pool also reports.
    expect(tracker.warnings()).toContainEqual(
      expect.objectContaining({ code: 'carryForwardClamped', pool: 'modelTurns', remaining: 5 }),
    );
  });

  it('a carried-forward pool that exactly fills ordinary leaves ordinary genuinely exhausted for a later reservation', () => {
    const tracker = createBudgetTracker(POLICY, {
      carryForward: { modelTurnsUsed: 13, toolCallsUsed: 0, evidenceBytesUsed: 0, elapsedMs: 0, highRiskReserveUsed: 0, verificationReserveUsed: 0 },
    });
    expect(tracker.state().ordinaryExhausted.modelTurns).toBe(true);
    expect(tracker.canContinue('exploration', 0)).toBe(false); // exploration only ever draws ordinary
    // highRiskCoverage can still spill into the reserve the ordinary lane can no longer cover.
    const outcome = tracker.reserve(request({ purpose: 'highRiskCoverage', modelTurns: 1, hostInitiated: true }));
    expect(outcome.ok && outcome.reservation.charges).toEqual([{ pool: 'modelTurns', lane: 'highRiskReserve', owner: 'shared', amount: 1 }]);
  });

  it('never charges a carry-forward against a changeset member\'s private slice', () => {
    const tracker = createBudgetTracker({ ...POLICY, changesetMemberMinimumToolCalls: 4 }, {
      members: ['m1', 'm2'],
      carryForward: { modelTurnsUsed: 0, toolCallsUsed: 10, evidenceBytesUsed: 0, elapsedMs: 0, highRiskReserveUsed: 0, verificationReserveUsed: 0 },
    });
    const state = tracker.state();
    expect(state.members.m1?.privateOrdinary.toolCalls.used).toBe(0);
    expect(state.members.m2?.privateOrdinary.toolCalls.used).toBe(0);
    expect(state.pools.toolCalls.lanes.ordinary.used).toBe(10); // charged to the shared lane only
  });
});
