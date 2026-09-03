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

/** Stable across plan revisions within a lineage (D5, review-run-activity). */
export interface PlanItem {
  id: string;
  description: string;
  state: PlanItemState;
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

/** A truthful denominator only when a real one exists; otherwise progress stays indeterminate. */
export interface CoverageProgress {
  classified: number;
  total?: number;
  inspected: number;
  requiredInspected?: number;
}

export type ActivityEvent =
  | (ActivityEventBase & { kind: 'planCreated'; plan: Plan })
  | (ActivityEventBase & { kind: 'planRevised'; plan: Plan })
  | (ActivityEventBase & { kind: 'planItemStateChanged'; itemId: string; state: PlanItemState })
  | (ActivityEventBase & { kind: 'actionStarted'; action: string; target?: string })
  | (ActivityEventBase & { kind: 'toolCompleted'; tool: string; target?: string; summary: string })
  | (ActivityEventBase & { kind: 'toolFailed'; tool: string; target?: string; reason: string })
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
