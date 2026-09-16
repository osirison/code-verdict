/**
 * Public plan creation, revision, and plan-item transition facts (task 5.3
 * of `add-agentic-review-harness`, design.md D5/D14, spec
 * `review-run-activity`). These build `ActivityFact` values for
 * `appendActivityEvent` (`./harnessActivityLog`), which sanitizes plan text
 * again regardless — a caller that constructs a `Plan` some other way still
 * cannot smuggle unsanitized text into the log.
 */
import type { ActivityEvent, Plan, PlanItem, PlanItemState } from '../domain/harnessActivity';
import type { ActivityFact } from './harnessActivityLog';
import { sanitizePublicText } from './harnessActivitySanitizer';
import { orderActivity } from './harnessActivityProjection';

export interface PlanItemInput {
  id: string;
  description: string;
  state?: PlanItemState;
  /** Scopes this item to one changeset member; omit for shared cross-member work (task 13.3). */
  memberId?: string;
}

function buildItems(items: readonly PlanItemInput[]): readonly PlanItem[] | undefined {
  if (items.length === 0) return undefined; // fail closed: a plan with no items is not a valid plan
  const ids = new Set<string>();
  const built: PlanItem[] = [];
  for (const item of items) {
    if (item.id.trim() === '' || ids.has(item.id)) return undefined; // fail closed: empty or duplicate id
    const description = sanitizePublicText(item.description);
    if (description === undefined) return undefined;
    if (item.memberId !== undefined && item.memberId.trim() === '') return undefined; // fail closed: present-but-blank member id
    ids.add(item.id);
    built.push({ id: item.id, description, state: item.state ?? 'pending', ...(item.memberId !== undefined ? { memberId: item.memberId } : {}) });
  }
  return built;
}

/** The first plan of a lineage: revision 1, no rationale — nothing came before it to justify one. */
export function createPlan(items: readonly PlanItemInput[]): Plan | undefined {
  const built = buildItems(items);
  return built ? { revision: 1, items: built } : undefined;
}

/**
 * A later plan. Every item id `previous` listed must still be present —
 * completed or no-longer-needed work is marked `completed`, `skipped`, or
 * `blocked`, never silently dropped, so an identifier stays resolvable
 * across revisions (`review-run-activity`: "Plan items SHALL have stable
 * identifiers across plan revisions"). The prior revision is not mutated
 * here; it stays whatever `planCreated`/`planRevised` event already
 * recorded it, which is how "the previous revision remains available in
 * retained activity" holds without this module tracking history itself.
 */
export function revisePlan(previous: Plan, items: readonly PlanItemInput[], rationale: string): Plan | undefined {
  const built = buildItems(items);
  if (!built) return undefined;
  const sanitizedRationale = sanitizePublicText(rationale);
  if (sanitizedRationale === undefined) return undefined;
  const nextIds = new Set(built.map((item) => item.id));
  for (const item of previous.items) {
    if (!nextIds.has(item.id)) return undefined; // fail closed: a prior item vanished instead of transitioning state
  }
  return { revision: previous.revision + 1, items: built, rationale: sanitizedRationale };
}

export function planCreatedFact(plan: Plan): Extract<ActivityFact, { kind: 'planCreated' }> {
  return { kind: 'planCreated', plan };
}

export function planRevisedFact(plan: Plan): Extract<ActivityFact, { kind: 'planRevised' }> {
  return { kind: 'planRevised', plan };
}

/** `appendActivityEvent` rejects an `itemId` that no plan in this log ever declared. */
export function planItemStateChangedFact(
  itemId: string,
  state: PlanItemState,
): Extract<ActivityFact, { kind: 'planItemStateChanged' }> {
  return { kind: 'planItemStateChanged', itemId, state };
}

/**
 * Every plan revision an attempt's ordered activity recorded, oldest first
 * (task 14.1/14.2, design.md D5: "a revision appends history rather than
 * silently overwriting the prior plan"). `RunProjection` (`../domain/
 * harnessActivity.ts`) carries only `activePlanItemId` — the full plan and
 * its revision history are not projected fields, they are this direct,
 * ordered read of `planCreated`/`planRevised` events, which is why every
 * screen that shows the plan reads the same ordered activity `RunRecord`
 * already carries (`checkpoint.activityLog.events` while a run is live,
 * the retained record's own `activity` once it has settled) rather than a
 * second plan-tracking structure of its own.
 */
export function planHistory(events: readonly ActivityEvent[]): readonly Plan[] {
  const revisions: Plan[] = [];
  // Defensive, like `reduceActivity` (`./harnessActivityProjection.ts`)
  // itself: a caller may hand this a raw persisted or replayed array, not
  // only one built in protocol-sequence order (spec `review-run-activity`:
  // "Consumers SHALL order events by protocol sequence rather than arrival
  // time"). Retained/completed run details (task 14.2) read exactly such a
  // deserialized array back from storage.
  for (const event of orderActivity(events)) {
    if (event.kind === 'planCreated' || event.kind === 'planRevised') revisions.push(event.plan);
  }
  return revisions;
}
