/**
 * The structurally-safe checkpoint shape and its one build function (task
 * 11.2 of `add-agentic-review-harness`, design.md D8/D13).
 *
 * D13 names exactly what a checkpoint may never carry: provider clients,
 * model stream handles, cancellation handles, raw prompts, raw model
 * fragments, hidden reasoning, secrets, full tool arguments, full tool-output
 * blobs. `PersistedCheckpoint` makes that structural rather than merely
 * observed — every field is one of the already-established persisted shapes
 * (`ActivityEvent`, `RetainedEvidenceRecord`, `TrackedCandidate`,
 * `BudgetConsumption`, `MemberCoverage`, `UnresolvedWork`, `RunProjection`,
 * `Plan`), none of which has a field typed to hold a client, a stream, a
 * handle, a full request/response object, or unbounded free text — so a
 * caller cannot construct a `PersistedCheckpoint` literal that smuggles any
 * of those in without a type error, not merely a runtime check. The one
 * deliberate exception (D8/D13) is `RetainedEvidenceRecord.exactContent`:
 * present only for a source a retained citation actually needs, via
 * `toRetainedEvidenceRecord`'s existing `includeExactContent` flag, computed
 * here from the checkpoint's own candidates rather than left to a caller.
 *
 * `buildCheckpoint` is the one funnel: it is the only function in this
 * change that produces a `PersistedCheckpoint`, and it accepts only
 * `CheckpointBuildInput` — value snapshots from the already-tested
 * collaborators (`EvidenceLedger.sources()`, `CandidateTracker.all()`,
 * `BudgetTracker.consumption()`, `ChangedFileInventory.coverage()`, an
 * attempt's own `ActivityEvent[]`), never a client, stream, or cancellation
 * token. `HarnessRunStore.writeCheckpoint` (task 11.1) accepts only the
 * *output* `PersistedCheckpoint`, so every write path funnels through here.
 *
 * Two fields the raw input could otherwise carry unsanitized are
 * deliberately re-derived rather than trusted as given:
 * - `plan` is never accepted as a separate field. It is read back out of the
 *   *already-sanitized* activity (the latest `planCreated`/`planRevised`
 *   event's `plan`), which passed `appendActivityEvent`'s sanitizer on the
 *   way in — never from a caller's own possibly-unsanitized `Plan` value
 *   (`harnessAttempt.ts` tracks one such raw local variable internally, set
 *   directly from model output, precisely to avoid exposing it here).
 * - `contradicted[].reason` is a collaborator-supplied string
 *   (`SynthesisVerificationRunner` is a public injectable seam, so it is
 *   never assumed pre-sanitized) and is re-run through
 *   `sanitizePublicText` here; an entry whose reason fails sanitization is
 *   dropped rather than persisted raw (fail closed, matching every other
 *   module in this change).
 */
import { compactActivity, jsonByteLength } from './harnessActivityCompaction';
import { reduceActivity } from './harnessActivityProjection';
import { sanitizePublicText } from './harnessActivitySanitizer';
import type { CheckpointReason, ContradictedFindingRecord } from './harnessAttempt';
import type { TrackedCandidate } from './harnessCandidateValidation';
import {
  toRetainedEvidenceRecord,
  type LedgerEvidenceSource,
  type RetainedEvidenceRecord,
} from './harnessEvidenceLedger';
import type { ActivityEvent, Plan, RunPhase, RunProjection } from '../domain/harnessActivity';
import type { BudgetConsumption, MemberCoverage, UnresolvedWork } from '../domain/harnessCoverage';
import type { AttemptNumber, LineageId, RunId } from '../domain/harnessLifecycle';
import type { HarnessPolicy } from '../domain/harnessPolicy';

// ---- Retry state (D13 "retries"; shape only — not yet fed by a live counter) -------

/**
 * D13 lists "retries" among what a checkpoint persists. No attempt-level
 * retry counter exists yet to read: `harnessRetry.ts`'s `runWithRetry` scopes
 * its own attempt count to one dispatch call and never publishes a running
 * total, and wiring one through is integration work (task 12.1's territory,
 * once a live attempt actually owns a checkpoint store). This shape exists so
 * that wiring is possible without a parallel persisted type when it lands;
 * `INITIAL_RETRY_STATE` is what `buildCheckpoint` uses until then.
 */
export interface RetryState {
  readonly waiting: boolean;
  readonly transientAttempts: number;
  readonly lastWaitReason?: string;
}

export const INITIAL_RETRY_STATE: RetryState = Object.freeze({ waiting: false, transientAttempts: 0 });

export function isRetryState(value: unknown): value is RetryState {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.waiting !== 'boolean') return false;
  if (typeof record.transientAttempts !== 'number' || !Number.isFinite(record.transientAttempts) || record.transientAttempts < 0) return false;
  if (record.lastWaitReason !== undefined && typeof record.lastWaitReason !== 'string') return false;
  return true;
}

export function parseRetryState(value: unknown): RetryState | undefined {
  return isRetryState(value) ? value : undefined;
}

// ---- The persisted checkpoint --------------------------------------------------------

/**
 * One point-in-time bundle: phase/reason/continuation metadata plus every
 * other line item D13 lists a checkpoint needs to eventually support resume
 * (tasks 11.5-11.8, not built in this pass — `compatible`/
 * `incompatibilityReasons` only carries this pass's bound-driven signal; the
 * richer digest/head/model/policy compatibility checks are 11.5's job).
 */
export interface PersistedCheckpoint {
  readonly checkpointId: string;
  readonly runId: RunId;
  readonly lineageId: LineageId;
  readonly attempt: AttemptNumber;
  readonly phase: RunPhase;
  readonly reason: CheckpointReason;
  readonly occurredAt: string;
  readonly elapsedMs: number;
  /** `sha256Hex(canonicalStringify(snapshot))` — identity only, never the snapshot's own content duplicated into every checkpoint. */
  readonly snapshotDigest: string;
  /** Derived from the sanitized activity below, never a separately-supplied raw value (see file header). */
  readonly plan?: Plan;
  readonly projection: RunProjection;
  /** Compacted per task 11.3 (`compactActivity`). */
  readonly activity: readonly ActivityEvent[];
  /** Metadata/digests for every source; `exactContent` present only for a source a retained citation needs. */
  readonly evidence: readonly RetainedEvidenceRecord[];
  readonly candidates: readonly TrackedCandidate[];
  readonly contradicted: readonly ContradictedFindingRecord[];
  readonly budget: BudgetConsumption;
  readonly coverage: readonly MemberCoverage[];
  readonly unresolved: UnresolvedWork;
  readonly retry: RetryState;
  /** This record's own serialized size (task 11.4's accounting unit); computed once, over everything but itself. */
  readonly bytes: number;
  /** False only when protected/required content alone still exceeds a per-attempt activity bound (11.3/11.4) — never because content was silently dropped. `HarnessRunStore` (11.1/11.4) may also flip this false on a per-lineage byte bound it alone can see. */
  readonly compatible: boolean;
  readonly incompatibilityReasons: readonly string[];
}

// ---- Input: value snapshots only, never a client/stream/handle ----------------------

export interface CheckpointBuildInput {
  readonly checkpointId: string;
  readonly runId: RunId;
  readonly lineageId: LineageId;
  readonly attempt: AttemptNumber;
  readonly phase: RunPhase;
  readonly reason: CheckpointReason;
  readonly occurredAt: string;
  readonly elapsedMs: number;
  readonly snapshotDigest: string;
  /** The attempt's full (uncompacted) sanitized activity; `buildCheckpoint` compacts it. */
  readonly activityEvents: readonly ActivityEvent[];
  /** `EvidenceLedger.sources()` — every source registered so far, cited or not; `buildCheckpoint` decides which keep `exactContent`. */
  readonly evidenceSources: readonly LedgerEvidenceSource[];
  readonly candidates: readonly TrackedCandidate[];
  readonly contradicted: readonly ContradictedFindingRecord[];
  readonly budget: BudgetConsumption;
  readonly coverage: readonly MemberCoverage[];
  readonly unresolved: UnresolvedWork;
  readonly retry?: RetryState;
}

function latestPlanFrom(events: readonly ActivityEvent[]): Plan | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as ActivityEvent;
    if (event.kind === 'planCreated' || event.kind === 'planRevised') return event.plan;
  }
  return undefined;
}

/** Source identifiers a currently-retained (accepted) finding actually cites — the only ones D8/D13 allow `exactContent` for. */
function requiredSourceIds(candidates: readonly TrackedCandidate[]): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const candidate of candidates) {
    const finding = candidate.finding;
    if (!finding) continue;
    ids.add(finding.evidence.primary.sourceId);
    for (const supporting of finding.evidence.supporting) ids.add(supporting.sourceId);
  }
  return ids;
}

function sanitizeContradicted(entries: readonly ContradictedFindingRecord[]): readonly ContradictedFindingRecord[] {
  const cleaned: ContradictedFindingRecord[] = [];
  for (const entry of entries) {
    const reason = sanitizePublicText(entry.reason);
    if (reason === undefined) continue; // fail closed: dropped rather than persisted raw
    cleaned.push({ candidateId: entry.candidateId, reason });
  }
  return cleaned;
}

/**
 * The one funnel every checkpoint write goes through. Pure: never reads a
 * clock (every timestamp arrives on `input`) and never mutates its
 * arguments.
 */
export function buildCheckpoint(
  input: CheckpointBuildInput,
  policy: Pick<HarnessPolicy, 'maxActivityEventsPerAttempt' | 'maxActivityBytesPerAttempt'>,
): PersistedCheckpoint {
  const compaction = compactActivity(input.activityEvents, policy);
  const plan = latestPlanFrom(compaction.events);
  const projection = reduceActivity({
    runId: input.runId,
    lineageId: input.lineageId,
    attempt: input.attempt,
    events: compaction.events,
  });

  const required = requiredSourceIds(input.candidates);
  const evidence = input.evidenceSources.map((source) =>
    toRetainedEvidenceRecord(source, { includeExactContent: required.has(source.sourceId) }),
  );
  const contradicted = sanitizeContradicted(input.contradicted);
  const retry = input.retry ?? INITIAL_RETRY_STATE;

  const incompatibilityReasons: string[] = [];
  if (!compaction.withinEventBound) {
    incompatibilityReasons.push(
      `Activity has ${compaction.eventCount} protected/unfoldable events, exceeding the ${policy.maxActivityEventsPerAttempt}-event bound even after coalescing every routine tool-progress run.`,
    );
  }
  if (!compaction.withinByteBound) {
    incompatibilityReasons.push(
      `Activity is ${compaction.byteLength} bytes, exceeding the ${policy.maxActivityBytesPerAttempt}-byte bound even after coalescing every routine tool-progress run.`,
    );
  }

  const draft: Omit<PersistedCheckpoint, 'bytes'> = {
    checkpointId: input.checkpointId,
    runId: input.runId,
    lineageId: input.lineageId,
    attempt: input.attempt,
    phase: input.phase,
    reason: input.reason,
    occurredAt: input.occurredAt,
    elapsedMs: input.elapsedMs,
    snapshotDigest: input.snapshotDigest,
    plan,
    projection,
    activity: compaction.events,
    evidence,
    candidates: input.candidates,
    contradicted,
    budget: input.budget,
    coverage: input.coverage,
    unresolved: input.unresolved,
    retry,
    compatible: incompatibilityReasons.length === 0,
    incompatibilityReasons,
  };
  return { ...draft, bytes: jsonByteLength(draft) };
}

/** Marks an otherwise-built checkpoint incompatible for a reason `buildCheckpoint` itself cannot see (a per-lineage bound only `HarnessRunStore` knows about) — never strips protected content or cited evidence to "fix" it. */
export function markIncompatible(checkpoint: PersistedCheckpoint, reason: string): PersistedCheckpoint {
  if (checkpoint.incompatibilityReasons.includes(reason)) return checkpoint;
  return { ...checkpoint, compatible: false, incompatibilityReasons: [...checkpoint.incompatibilityReasons, reason] };
}
