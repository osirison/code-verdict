/**
 * Public plan, sanitized activity, and the shared `RunProjection` every
 * surface renders from (task 2.3 of `add-agentic-review-harness`, design.md
 * D5/D14, spec `review-run-activity`).
 *
 * `RunProjection.coverage` is a small display summary, not the per-file
 * inventory/risk model — that richer tracking model belongs to task 2.4
 * (`harnessCoverage.ts`) and is deliberately not imported here, so this file
 * has no forward dependency on a task implemented after it.
 */
import type { AttemptNumber, LineageId, ResultCompleteness, RunLifecycle, RunId } from './harnessLifecycle';

export const PLAN_ITEM_STATES = ['pending', 'active', 'completed', 'skipped', 'blocked', 'failed'] as const;

export type PlanItemState = (typeof PLAN_ITEM_STATES)[number];

/**
 * Stable across plan revisions within a lineage (D5, review-run-activity).
 * `memberId` scopes an item to one changeset member; absent means the item
 * is shared cross-member work (D15, task 13.3) — an individual (non-
 * changeset) review's items are always shared, since there is only one
 * member to begin with.
 */
export interface PlanItem {
  id: string;
  description: string;
  state: PlanItemState;
  memberId?: string;
}

/** A revision appends history; it never silently overwrites the prior plan. */
export interface Plan {
  revision: number;
  items: readonly PlanItem[];
  /** Concise public reason this revision replaced the last one; absent on the first plan. */
  rationale?: string;
}

export const RUN_PHASES = [
  'bootstrap',
  'planning',
  'investigating',
  'verifying',
  'completing',
  'persisting',
] as const;

export type RunPhase = (typeof RUN_PHASES)[number];

export interface Limitation {
  code: string;
  message: string;
}

interface ActivityEventBase {
  runId: RunId;
  lineageId: LineageId;
  attempt: AttemptNumber;
  /** Protocol order — consumers project by this, never by arrival order. */
  sequence: number;
  occurredAt: string;
  phase: RunPhase;
  elapsedMs: number;
}

/**
 * A truthful denominator only when a real one exists; otherwise progress stays indeterminate.
 *
 * `classified`/`total` and `inspected`/`requiredInspected`/`requiredTotal` answer different
 * questions and are never collapsed into one number: the first pair is the whole changed-file
 * inventory, the second is how much of the subset a run's required-inspection rule actually
 * covers. `requiredTotal` — files whose classified risk falls in the required set, regardless of
 * inspection state — can grow over the course of a run even after `total` is known: a file's risk
 * is not always classified the moment it is enumerated, so `requiredTotal` only ever counts what
 * classification has established so far. `requiredInspected` predates `requiredTotal`; a
 * checkpoint persisted before this field existed carries the former without the latter, and a
 * renderer must treat that combination as its own case rather than reading it as "0 required".
 */
export interface CoverageProgress {
  classified: number;
  total?: number;
  inspected: number;
  requiredInspected?: number;
  requiredTotal?: number;
}

/**
 * Optional timing/size metadata a `toolCompleted`/`toolFailed` fact may carry — added so the run
 * diagnostics report can answer "where did the time go" without a second, parallel activity
 * channel (reuses these two existing event kinds rather than adding a new one). Every field is
 * optional so every caller and fixture that predates this addition stays valid unchanged.
 *
 * The same two event kinds already carry a model turn's own outcome, by convention, as
 * `tool: 'modelTurn'` (`harnessAttempt.ts`'s `runPhaseLoop`) — `bytesSent`/`bytesReceived` take on
 * a different meaning there than for a real host tool call: for a model turn, `bytesSent` is the
 * prompt's byte length and `bytesReceived` is the reply's; for a real tool call nothing is "sent"
 * in that sense, so only `bytesReceived` (the content bytes returned) is ever set.
 *
 * `resultState` is the provider/tool result's own state string (`'complete'`, `'refused'`,
 * `'binary'`, ...) — richer than the `toolCompleted`/`toolFailed` split alone. `retryWaitMs`/
 * `retryCount` are the transient-retry backoff time this one call spent waiting, surfaced from
 * `../app/harnessRetry.ts`'s own already-computed delays (never recomputed here) via
 * `../app/harnessToolDispatcher.ts`'s `dispatch`.
 */
export interface ActivityCallMetadata {
  durationMs?: number;
  /** The changeset member a real tool call was dispatched against; absent for a whole-attempt tool or for a `tool: 'modelTurn'` fact. */
  memberId?: string;
  bytesSent?: number;
  bytesReceived?: number;
  resultState?: string;
  retryWaitMs?: number;
  retryCount?: number;
}

export type ActivityEvent =
  | (ActivityEventBase & { kind: 'planCreated'; plan: Plan })
  | (ActivityEventBase & { kind: 'planRevised'; plan: Plan })
  | (ActivityEventBase & { kind: 'planItemStateChanged'; itemId: string; state: PlanItemState })
  | (ActivityEventBase & { kind: 'actionStarted'; action: string; target?: string })
  | (ActivityEventBase & { kind: 'toolCompleted'; tool: string; target?: string; summary: string } & ActivityCallMetadata)
  | (ActivityEventBase & { kind: 'toolFailed'; tool: string; target?: string; reason: string } & ActivityCallMetadata)
  | (ActivityEventBase & { kind: 'coverageChanged'; coverage: CoverageProgress })
  | (ActivityEventBase & { kind: 'checkpoint'; checkpointId: string })
  | (ActivityEventBase & { kind: 'waiting'; reason: string })
  | (ActivityEventBase & { kind: 'paused'; reason: string })
  | (ActivityEventBase & { kind: 'resuming' })
  | (ActivityEventBase & { kind: 'cancelling' })
  | (ActivityEventBase & { kind: 'cancelled' })
  | (ActivityEventBase & { kind: 'partialResult'; limitations: readonly Limitation[] })
  | (ActivityEventBase & {
      kind: 'terminalResult';
      lifecycle: RunLifecycle;
      completeness: ResultCompleteness;
      limitations: readonly Limitation[];
    });

export type ActivityEventKind = ActivityEvent['kind'];

export type ProgressMode = 'determinate' | 'indeterminate';

/**
 * Whether a paused or waiting run needs the reviewer, not why — the lifecycle
 * value and the latest `waiting`/`paused` activity event already carry that.
 */
export type AttentionState = 'none' | 'attentionRequired';

export interface ResultSummary {
  completeness: ResultCompleteness;
  findingCount?: number;
  limitations: readonly Limitation[];
}

/** What the active review, sidebar, dashboard, status bar, and retained details all render from. */
export interface RunProjection {
  runId: RunId;
  lineageId: LineageId;
  attempt: AttemptNumber;
  lifecycle: RunLifecycle;
  completeness: ResultCompleteness;
  phase?: RunPhase;
  currentAction?: string;
  currentTarget?: string;
  elapsedMs: number;
  progressMode: ProgressMode;
  progressUnits?: { completed: number; total?: number };
  coverage?: CoverageProgress;
  activePlanItemId?: string;
  attention: AttentionState;
  latestCheckpointId?: string;
  limitations: readonly Limitation[];
  result?: ResultSummary;
}

export function isPlanItemState(value: unknown): value is PlanItemState {
  return (PLAN_ITEM_STATES as readonly unknown[]).includes(value);
}

export function parsePlanItemState(value: unknown): PlanItemState | undefined {
  return isPlanItemState(value) ? value : undefined;
}

export function isRunPhase(value: unknown): value is RunPhase {
  return (RUN_PHASES as readonly unknown[]).includes(value);
}

export function parseRunPhase(value: unknown): RunPhase | undefined {
  return isRunPhase(value) ? value : undefined;
}
