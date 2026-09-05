/**
 * Activity compaction for one attempt's persisted checkpoint (task 11.3 of
 * `add-agentic-review-harness`, design.md D13, spec `review-run-activity`).
 *
 * D13: "Compaction preserves terminal transitions, plan revisions, failures,
 * checkpoints, coverage changes, and result events. It may coalesce routine
 * repeated tool-progress events while keeping aggregate counts and first/last
 * timestamps." This module implements exactly that split and nothing more:
 *
 * - **Protected** (never coalesced, never dropped): every `ActivityEvent`
 *   kind except `toolCompleted` — `planCreated`/`planRevised` (plan
 *   revisions), `planItemStateChanged` (not "routine progress": it is part of
 *   the plan's own state, not narration about it), `actionStarted`,
 *   `toolFailed` (failures), `coverageChanged` (coverage changes),
 *   `checkpoint`, `waiting`/`paused`/`resuming`/`cancelling`/`cancelled`
 *   (lifecycle transitions), `partialResult`/`terminalResult` (results).
 * - **Coalescable**: only `toolCompleted` — D13's own example of "routine
 *   repeated tool-progress events" — and only a *consecutive* run of them
 *   sharing the same `tool` value, with no other event of any kind between
 *   them (a different tool, or any protected kind, ends the run). A run of
 *   two or more folds into one `toolCompleted` event whose `summary` names
 *   the aggregate count and the first/last `occurredAt`, so the record stays
 *   truthful rather than just shorter; a lone `toolCompleted` (a "run" of
 *   one) is left exactly as it was.
 *
 * Because only `toolCompleted` is ever touched, and a `toolCompleted` event
 * carries no citation-relevant identifier (a citation resolves against the
 * evidence ledger's `sourceId`/`digest`, never against activity), this
 * compaction can never remove data a retained citation or a resume needs —
 * that half of D13's rule ("if eviction removes data required... the
 * checkpoint becomes incompatible") is therefore satisfied structurally by
 * this module and never triggered by it. The bound-driven half (an attempt
 * whose *protected* events alone still exceed `maxActivityEventsPerAttempt`/
 * `maxActivityBytesPerAttempt` after this best-effort coalescing) is
 * reported back via `withinEventBound`/`withinByteBound` rather than solved
 * here — `harnessCheckpoint.ts` (task 11.2) is what turns "still over bound"
 * into an incompatible checkpoint, since only it decides what a checkpoint
 * as a whole is allowed to do about that.
 */
import { sanitizePublicText, MAX_PUBLIC_TEXT_LENGTH } from './harnessActivitySanitizer';
import type { ActivityEvent } from '../domain/harnessActivity';
import type { HarnessPolicy } from '../domain/harnessPolicy';

/** One formula, reused by every module that needs a persisted record's serialized size (`harnessCheckpoint.ts`, `harnessRunStore.ts`). */
export function jsonByteLength(value: unknown): number {
  const text = JSON.stringify(value);
  return text === undefined ? 0 : Buffer.byteLength(text, 'utf8');
}

export interface ActivityCompactionResult {
  /** Protected events unchanged, coalescable runs folded — still in sequence order. */
  readonly events: readonly ActivityEvent[];
  /** How many runs of 2+ `toolCompleted` events were folded into one. */
  readonly coalescedGroups: number;
  /** Total events removed by coalescing (never counts a lone, unfoldable event). */
  readonly coalescedEventsRemoved: number;
  readonly eventCount: number;
  readonly byteLength: number;
  /** False only when protected events alone (nothing left to legitimately coalesce) exceed the policy bound. */
  readonly withinEventBound: boolean;
  readonly withinByteBound: boolean;
}

type ToolCompletedEvent = Extract<ActivityEvent, { kind: 'toolCompleted' }>;

function isToolCompleted(event: ActivityEvent): event is ToolCompletedEvent {
  return event.kind === 'toolCompleted';
}

function dedupeAndSort(events: readonly ActivityEvent[]): ActivityEvent[] {
  const seen = new Set<number>();
  const deduped: ActivityEvent[] = [];
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (seen.has(event.sequence)) continue;
    seen.add(event.sequence);
    deduped.push(event);
  }
  return deduped;
}

/** Folds a run of 2+ same-tool `toolCompleted` events into one, keeping the last event's identity/sequence so ordering among surviving events is unaffected. */
function foldToolCompletedRun(run: readonly ToolCompletedEvent[]): ActivityEvent {
  const first = run[0] as ToolCompletedEvent;
  const last = run[run.length - 1] as ToolCompletedEvent;
  const sameTarget = run.every((event) => event.target === first.target);
  const rawSummary = `${run.length} similar "${last.tool}" completions between ${first.occurredAt} and ${last.occurredAt}.`;
  const summary = sanitizePublicText(rawSummary) ?? rawSummary.slice(0, MAX_PUBLIC_TEXT_LENGTH);
  return {
    ...last,
    summary,
    target: sameTarget ? first.target : undefined,
  };
}

/**
 * Compacts one attempt's ordered activity per the rules above, then reports
 * whether the result fits the two per-attempt activity bounds from
 * `HarnessPolicy`. Pure: never mutates `events`, never reads a clock (byte
 * size is computed from the events' own already-recorded timestamps).
 */
export function compactActivity(
  events: readonly ActivityEvent[],
  policy: Pick<HarnessPolicy, 'maxActivityEventsPerAttempt' | 'maxActivityBytesPerAttempt'>,
): ActivityCompactionResult {
  const sorted = dedupeAndSort(events);
  const compacted: ActivityEvent[] = [];
  let group: ToolCompletedEvent[] = [];
  let coalescedGroups = 0;
  let coalescedEventsRemoved = 0;

  function flushGroup(): void {
    if (group.length === 0) return;
    if (group.length === 1) {
      compacted.push(group[0] as ToolCompletedEvent);
    } else {
      compacted.push(foldToolCompletedRun(group));
      coalescedGroups += 1;
      coalescedEventsRemoved += group.length - 1;
    }
    group = [];
  }

  for (const event of sorted) {
    if (isToolCompleted(event)) {
      const openTool = group[group.length - 1]?.tool;
      if (openTool !== undefined && openTool !== event.tool) flushGroup();
      group.push(event);
    } else {
      flushGroup();
      compacted.push(event);
    }
  }
  flushGroup();

  const eventCount = compacted.length;
  const byteLength = jsonByteLength(compacted);
  return {
    events: compacted,
    coalescedGroups,
    coalescedEventsRemoved,
    eventCount,
    byteLength,
    withinEventBound: eventCount <= policy.maxActivityEventsPerAttempt,
    withinByteBound: byteLength <= policy.maxActivityBytesPerAttempt,
  };
}
