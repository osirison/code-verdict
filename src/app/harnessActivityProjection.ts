/**
 * The pure activity reducer: folds one attempt's ordered activity events
 * into the single `RunProjection` every surface renders from (task 5.4 of
 * `add-agentic-review-harness`, design.md D2/D14, spec
 * `review-run-activity`).
 *
 * Lifecycle and completeness are derived by two independent passes that
 * share no state — a terminal event's `lifecycle` value can never influence
 * the derived `completeness` or vice versa (D2: "no lifecycle label SHALL
 * imply completeness by itself").
 *
 * `RunProjection` (task 2.3) has no dedicated field for a `waiting`/`paused`
 * event's public reason. Rather than widen that frozen type, this reducer
 * repurposes `currentAction` to carry it while the run is waiting or
 * paused — the field is already free-form descriptive text, and every other
 * lifecycle already renders `currentAction` from the latest public action.
 */
import type {
  ActivityEvent,
  AttentionState,
  CoverageProgress,
  Limitation,
  PlanItemState,
  ProgressMode,
  RunPhase,
  RunProjection,
} from '../domain/harnessActivity';
import type { ResultCompleteness, RunLifecycle } from '../domain/harnessLifecycle';
import type { ActivityLog } from './harnessActivityLog';

function sortBySequence(events: readonly ActivityEvent[]): ActivityEvent[] {
  return [...events].sort((a, b) => a.sequence - b.sequence);
}

/** Drops a redelivered event (identical sequence) so it cannot double-apply during the fold. */
function dedupeBySequence(events: readonly ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<number>();
  const deduped: ActivityEvent[] = [];
  for (const event of events) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    deduped.push(event);
  }
  return deduped;
}

/**
 * Sorted and deduped by protocol sequence (spec `review-run-activity`:
 * "Consumers SHALL order events by protocol sequence rather than arrival
 * time... a duplicate event does not create duplicate activity"). Exported
 * so every other reader of a raw activity array — `planHistory`
 * (`./harnessActivityPlan.ts`) and the retained/live activity feed
 * (`../ui/reviewFlowHtml.ts`, tasks 14.1/14.2) — normalizes exactly the way
 * `reduceActivity` below does, rather than each trusting arrival order on
 * its own. This matters most for *persisted* activity (task 14.2's retained
 * details read a deserialized array back from storage), which carries no
 * transport-order guarantee at all.
 */
export function orderActivity(events: readonly ActivityEvent[]): ActivityEvent[] {
  return dedupeBySequence(sortBySequence(events));
}

/**
 * Phases with no lifecycle value of their own collapse to the nearest one:
 * `bootstrap` precedes planning, and `persisting` is still `completing` from
 * the reviewer's point of view (D2's lifecycle diagram names neither).
 */
function lifecycleForPhase(phase: RunPhase): RunLifecycle {
  switch (phase) {
    case 'bootstrap':
    case 'planning':
      return 'planning';
    case 'investigating':
      return 'investigating';
    case 'verifying':
      return 'verifying';
    case 'completing':
    case 'persisting':
      return 'completing';
  }
}

function deriveLifecycle(events: readonly ActivityEvent[]): RunLifecycle {
  const last = events[events.length - 1];
  if (!last) return 'queued';
  switch (last.kind) {
    case 'terminalResult':
      return last.lifecycle;
    case 'waiting':
    case 'paused':
    case 'resuming':
    case 'cancelling':
    case 'cancelled':
      return last.kind;
    default:
      return lifecycleForPhase(last.phase);
  }
}

/** Newest-first: whichever of `partialResult`/`terminalResult` happened last wins. */
function deriveCompleteness(events: readonly ActivityEvent[]): ResultCompleteness {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'terminalResult') return event.completeness;
    if (event.kind === 'partialResult') return 'partial';
  }
  return 'none';
}

const TERMINAL_LIFECYCLES = new Set<RunLifecycle>(['succeeded', 'failed', 'cancelled', 'interrupted']);

function deriveCurrentAction(
  events: readonly ActivityEvent[],
  lifecycle: RunLifecycle,
): { currentAction?: string; currentTarget?: string } {
  if (TERMINAL_LIFECYCLES.has(lifecycle)) return {}; // nothing is "current" once the attempt is over
  const last = events[events.length - 1];
  if (last && (last.kind === 'waiting' || last.kind === 'paused')) return { currentAction: last.reason };
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'actionStarted') return { currentAction: event.action, currentTarget: event.target };
  }
  return {};
}

interface PlanItemTrace {
  state: PlanItemState;
  updatedAtSequence: number;
}

/** A tie (two items marked active by the very same event) resolves to whichever this fold visits first — deterministic, not meaningful enough to track listed order too. */
function deriveActivePlanItemId(events: readonly ActivityEvent[]): string | undefined {
  const items = new Map<string, PlanItemTrace>();
  for (const event of events) {
    if (event.kind === 'planCreated' || event.kind === 'planRevised') {
      for (const item of event.plan.items) items.set(item.id, { state: item.state, updatedAtSequence: event.sequence });
    } else if (event.kind === 'planItemStateChanged') {
      items.set(event.itemId, { state: event.state, updatedAtSequence: event.sequence });
    }
  }
  let activeId: string | undefined;
  let activeAtSequence = -1;
  for (const [id, trace] of items) {
    if (trace.state === 'active' && trace.updatedAtSequence > activeAtSequence) {
      activeId = id;
      activeAtSequence = trace.updatedAtSequence;
    }
  }
  return activeId;
}

function deriveCoverage(events: readonly ActivityEvent[]): CoverageProgress | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'coverageChanged') return event.coverage;
  }
  return undefined;
}

function deriveLatestCheckpointId(events: readonly ActivityEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'checkpoint') return event.checkpointId;
  }
  return undefined;
}

/** The most recent `partialResult`/`terminalResult` reports the whole limitation set at that point, not a delta. */
function deriveLimitations(events: readonly ActivityEvent[]): readonly Limitation[] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'partialResult' || event.kind === 'terminalResult') return event.limitations;
  }
  return [];
}

function deriveResult(events: readonly ActivityEvent[]): RunProjection['result'] {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind === 'terminalResult') return { completeness: event.completeness, limitations: event.limitations };
  }
  return undefined;
}

/** `paused` is the durable stop the design says needs reviewer or policy action; `waiting` is transient and auto-resolves. */
function deriveAttention(lifecycle: RunLifecycle): AttentionState {
  return lifecycle === 'paused' ? 'attentionRequired' : 'none';
}

/** Truthful progress per `review-run-activity`: determinate only with a real denominator (`coverage.total`). */
function deriveProgress(coverage: CoverageProgress | undefined): {
  progressMode: ProgressMode;
  progressUnits?: { completed: number; total?: number };
} {
  if (!coverage || coverage.total === undefined) return { progressMode: 'indeterminate' };
  return { progressMode: 'determinate', progressUnits: { completed: coverage.classified, total: coverage.total } };
}

/**
 * The pure reducer. Sorts and dedupes defensively — a caller may hand this
 * a raw persisted or replayed array, not only one built through
 * `appendActivityEvent`/`mergeActivityEvents` — then derives every
 * `RunProjection` field from the ordered result. Never mutates `log`, and
 * always reflects the complete current log: nothing here samples, batches,
 * or otherwise delays a terminal event behind routine activity volume.
 */
export function reduceActivity(log: ActivityLog): RunProjection {
  const events = orderActivity(log.events);
  const last = events[events.length - 1];
  const lifecycle = deriveLifecycle(events);
  const coverage = deriveCoverage(events);
  const { currentAction, currentTarget } = deriveCurrentAction(events, lifecycle);
  const { progressMode, progressUnits } = deriveProgress(coverage);

  return {
    runId: log.runId,
    lineageId: log.lineageId,
    attempt: log.attempt,
    lifecycle,
    completeness: deriveCompleteness(events),
    phase: last?.phase,
    currentAction,
    currentTarget,
    elapsedMs: last?.elapsedMs ?? 0,
    progressMode,
    progressUnits,
    coverage,
    activePlanItemId: deriveActivePlanItemId(events),
    attention: deriveAttention(lifecycle),
    latestCheckpointId: deriveLatestCheckpointId(events),
    limitations: deriveLimitations(events),
    result: deriveResult(events),
  };
}
