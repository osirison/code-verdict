/**
 * The ordered, append-only activity log for one attempt: the typed facts a
 * caller may add, and the sole function that turns a fact into a full
 * `ActivityEvent` (tasks 5.1/5.2 of `add-agentic-review-harness`,
 * design.md D2/D5/D14, spec `review-run-activity`).
 *
 * `ActivityEvent` and its common `runId`/`lineageId`/`attempt`/`sequence`/
 * `occurredAt`/`phase`/`elapsedMs` fields already exist in
 * `../domain/harnessActivity` (task 2.3) — this module does not redefine
 * that union. What it adds is the app-layer surface the design's builder
 * and reducer actually run on: `ActivityLog` (the ordered container),
 * `ActivityFact` (what a caller supplies — everything in `ActivityEvent`
 * except the base fields, which the log itself assigns), and
 * `appendActivityEvent`, the only sanctioned way to add one. Every fact is
 * validated and sanitized inside `appendActivityEvent`
 * (`./harnessActivitySanitizer`) before it can become part of the log, so
 * nothing unsanitized can reach it short of hand-constructing an
 * `ActivityEvent` and skipping this module entirely — which no other module
 * in this change does.
 */
import { canonicalStringify } from './contentDigest';
import { isPlanItemState, isRunPhase } from '../domain/harnessActivity';
import type { ActivityCallMetadata, ActivityEvent, Limitation, PlanItem, RunPhase } from '../domain/harnessActivity';
import { isResultCompleteness, isRunLifecycle } from '../domain/harnessLifecycle';
import type { AttemptNumber, LineageId, RunId } from '../domain/harnessLifecycle';
import { sanitizePublicText } from './harnessActivitySanitizer';

/** Mirrors `ActivityEventBase` (`../domain/harnessActivity`, not exported there) — every event kind carries these. */
interface ActivityEventCommonFields {
  runId: RunId;
  lineageId: LineageId;
  attempt: AttemptNumber;
  sequence: number;
  occurredAt: string;
  phase: RunPhase;
  elapsedMs: number;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** What a caller supplies to add one event — the base fields are assigned by `appendActivityEvent`, never by the caller. */
export type ActivityFact = DistributiveOmit<ActivityEvent, keyof ActivityEventCommonFields>;

/** The base fields only the caller (a future `HarnessAttempt`) can know: current phase, wall-clock time, and elapsed time. */
export interface ActivityContext {
  occurredAt: string;
  phase: RunPhase;
  elapsedMs: number;
}

export interface ActivityLog {
  readonly runId: RunId;
  readonly lineageId: LineageId;
  readonly attempt: AttemptNumber;
  readonly events: readonly ActivityEvent[];
}

/** A fresh, empty log for one attempt. Sequence numbering restarts at 1 regardless of any prior attempt's last sequence. */
export function createActivityLog(runId: RunId, lineageId: LineageId, attempt: AttemptNumber): ActivityLog {
  return { runId, lineageId, attempt, events: [] };
}

function nextSequence(log: ActivityLog): number {
  const last = log.events[log.events.length - 1];
  return last ? last.sequence + 1 : 1;
}

function knownPlanItemIds(events: readonly ActivityEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.kind === 'planCreated' || event.kind === 'planRevised') {
      for (const item of event.plan.items) ids.add(item.id);
    }
  }
  return ids;
}

/** `undefined` in, `undefined` out; present-but-unsanitizable fails the whole fact closed. */
function sanitizeOptionalText(raw: string | undefined): { ok: false } | { ok: true; value: string | undefined } {
  if (raw === undefined) return { ok: true, value: undefined };
  const cleaned = sanitizePublicText(raw);
  return cleaned === undefined ? { ok: false } : { ok: true, value: cleaned };
}

function sanitizePlanItems(items: readonly PlanItem[]): readonly PlanItem[] | undefined {
  const cleaned: PlanItem[] = [];
  const ids = new Set<string>();
  for (const item of items) {
    if (item.id.trim() === '' || ids.has(item.id)) return undefined; // fail closed: empty or duplicate id
    if (!isPlanItemState(item.state)) return undefined;
    const description = sanitizePublicText(item.description);
    if (description === undefined) return undefined;
    if (item.memberId !== undefined && item.memberId.trim() === '') return undefined; // fail closed: present-but-blank member id
    ids.add(item.id);
    cleaned.push({ id: item.id, description, state: item.state, ...(item.memberId !== undefined ? { memberId: item.memberId } : {}) });
  }
  return cleaned;
}

/** `undefined` in, `{ok:true, value: undefined}` out; present-but-negative-or-non-finite fails the whole fact closed — mirrors `sanitizeFact`'s existing `coverageChanged` numeric checks. */
function sanitizeOptionalNonNegativeFinite(raw: number | undefined): { ok: false } | { ok: true; value: number | undefined } {
  if (raw === undefined) return { ok: true, value: undefined };
  return Number.isFinite(raw) && raw >= 0 ? { ok: true, value: raw } : { ok: false };
}

/**
 * Validates the optional timing/size fields `toolCompleted`/`toolFailed` may carry
 * (`ActivityCallMetadata`, `../domain/harnessActivity.ts`) — every one host-computed, never model
 * text, so no `sanitizePublicText` pass is needed, but every numeric field still fails the whole
 * fact closed if negative or non-finite (matching `coverageChanged`'s own rule), `memberId` fails
 * closed if present-but-blank (matching `sanitizePlanItems`' own rule), and `resultState` is
 * bounded to a short identifier token (matching `sanitizeLimitations`' own bound on `code`) since
 * it is a `HostToolResult.state` value, never free text.
 */
function sanitizeCallMetadata(fact: ActivityCallMetadata): { ok: false } | { ok: true; value: ActivityCallMetadata } {
  const durationMs = sanitizeOptionalNonNegativeFinite(fact.durationMs);
  const bytesSent = sanitizeOptionalNonNegativeFinite(fact.bytesSent);
  const bytesReceived = sanitizeOptionalNonNegativeFinite(fact.bytesReceived);
  const retryWaitMs = sanitizeOptionalNonNegativeFinite(fact.retryWaitMs);
  const retryCount = sanitizeOptionalNonNegativeFinite(fact.retryCount);
  if (!durationMs.ok || !bytesSent.ok || !bytesReceived.ok || !retryWaitMs.ok || !retryCount.ok) return { ok: false };
  if (fact.memberId !== undefined && fact.memberId.trim() === '') return { ok: false };
  if (fact.resultState !== undefined && !/^[A-Za-z][A-Za-z0-9]*$/.test(fact.resultState)) return { ok: false };
  return {
    ok: true,
    value: {
      ...(durationMs.value !== undefined ? { durationMs: durationMs.value } : {}),
      ...(fact.memberId !== undefined ? { memberId: fact.memberId } : {}),
      ...(bytesSent.value !== undefined ? { bytesSent: bytesSent.value } : {}),
      ...(bytesReceived.value !== undefined ? { bytesReceived: bytesReceived.value } : {}),
      ...(fact.resultState !== undefined ? { resultState: fact.resultState } : {}),
      ...(retryWaitMs.value !== undefined ? { retryWaitMs: retryWaitMs.value } : {}),
      ...(retryCount.value !== undefined ? { retryCount: retryCount.value } : {}),
    },
  };
}

function sanitizeLimitations(limitations: readonly Limitation[]): readonly Limitation[] | undefined {
  const cleaned: Limitation[] = [];
  for (const limitation of limitations) {
    if (!/^[A-Za-z][A-Za-z0-9]*$/.test(limitation.code)) return undefined; // fail closed: a code is a short token, not free text
    const message = sanitizePublicText(limitation.message);
    if (message === undefined) return undefined;
    cleaned.push({ code: limitation.code, message });
  }
  return cleaned;
}

/**
 * Fail-closed per-kind validation and sanitization: `undefined` means
 * `appendActivityEvent` must refuse the fact and leave the log unchanged.
 * `knownItemIds` is a thunk so the scan over every existing event only runs
 * for the one fact kind that needs it.
 */
function sanitizeFact(fact: ActivityFact, knownItemIds: () => Set<string>): ActivityFact | undefined {
  switch (fact.kind) {
    case 'planCreated':
    case 'planRevised': {
      const items = sanitizePlanItems(fact.plan.items);
      if (!items) return undefined;
      if (fact.plan.rationale === undefined) return { ...fact, plan: { revision: fact.plan.revision, items } };
      const rationale = sanitizePublicText(fact.plan.rationale);
      if (rationale === undefined) return undefined;
      return { ...fact, plan: { revision: fact.plan.revision, items, rationale } };
    }
    case 'planItemStateChanged':
      // Fail closed: no plan in this log ever declared this identifier.
      return knownItemIds().has(fact.itemId) ? fact : undefined;
    case 'actionStarted': {
      const action = sanitizePublicText(fact.action);
      if (action === undefined) return undefined;
      const target = sanitizeOptionalText(fact.target);
      if (!target.ok) return undefined;
      return target.value === undefined ? { ...fact, action } : { ...fact, action, target: target.value };
    }
    case 'toolCompleted': {
      const tool = sanitizePublicText(fact.tool);
      const summary = sanitizePublicText(fact.summary);
      const target = sanitizeOptionalText(fact.target);
      const metadata = sanitizeCallMetadata(fact);
      if (tool === undefined || summary === undefined || !target.ok || !metadata.ok) return undefined;
      return { ...fact, tool, summary, ...(target.value !== undefined ? { target: target.value } : {}), ...metadata.value };
    }
    case 'toolFailed': {
      const tool = sanitizePublicText(fact.tool);
      const reason = sanitizePublicText(fact.reason);
      const target = sanitizeOptionalText(fact.target);
      const metadata = sanitizeCallMetadata(fact);
      if (tool === undefined || reason === undefined || !target.ok || !metadata.ok) return undefined;
      return { ...fact, tool, reason, ...(target.value !== undefined ? { target: target.value } : {}), ...metadata.value };
    }
    case 'coverageChanged': {
      const { classified, total, inspected, requiredInspected } = fact.coverage;
      const nonNegativeFinite = (n: number) => Number.isFinite(n) && n >= 0;
      if (!nonNegativeFinite(classified) || !nonNegativeFinite(inspected)) return undefined;
      if (total !== undefined && !nonNegativeFinite(total)) return undefined;
      if (requiredInspected !== undefined && !nonNegativeFinite(requiredInspected)) return undefined;
      return fact;
    }
    case 'checkpoint': {
      const checkpointId = sanitizePublicText(fact.checkpointId);
      return checkpointId === undefined ? undefined : { ...fact, checkpointId };
    }
    case 'waiting':
    case 'paused': {
      const reason = sanitizePublicText(fact.reason);
      return reason === undefined ? undefined : { ...fact, reason };
    }
    case 'resuming':
    case 'cancelling':
    case 'cancelled':
      return fact;
    case 'partialResult': {
      const limitations = sanitizeLimitations(fact.limitations);
      return limitations === undefined ? undefined : { ...fact, limitations };
    }
    case 'terminalResult': {
      if (!isRunLifecycle(fact.lifecycle) || !isResultCompleteness(fact.completeness)) return undefined;
      const limitations = sanitizeLimitations(fact.limitations);
      return limitations === undefined ? undefined : { ...fact, limitations };
    }
    default: {
      const exhaustive: never = fact;
      return exhaustive;
    }
  }
}

function validContext(log: ActivityLog, context: ActivityContext): boolean {
  if (!isRunPhase(context.phase)) return false;
  if (!Number.isFinite(context.elapsedMs) || context.elapsedMs < 0) return false;
  if (typeof context.occurredAt !== 'string' || Number.isNaN(Date.parse(context.occurredAt))) return false;
  const last = log.events[log.events.length - 1];
  if (!last) return true;
  // Elapsed time and wall-clock time must not run backwards within one attempt.
  if (context.elapsedMs < last.elapsedMs) return false;
  if (Date.parse(context.occurredAt) < Date.parse(last.occurredAt)) return false;
  return true;
}

/**
 * The only sanctioned way to add an event. A fact that fails validation or
 * sanitization, or a context that is malformed or moves time backwards,
 * leaves the log byte-for-byte unchanged (fail closed) — it is never
 * possible to observe a log that partially reflects a rejected fact.
 */
export function appendActivityEvent(log: ActivityLog, fact: ActivityFact, context: ActivityContext): ActivityLog {
  if (!validContext(log, context)) return log;
  const sanitized = sanitizeFact(fact, () => knownPlanItemIds(log.events));
  if (!sanitized) return log;
  // Base fields plus a validated fact of one kind together satisfy `ActivityEvent`; TS cannot
  // verify that merge across a distributive Omit, hence the assertion.
  const event = {
    runId: log.runId,
    lineageId: log.lineageId,
    attempt: log.attempt,
    sequence: nextSequence(log),
    occurredAt: context.occurredAt,
    phase: context.phase,
    elapsedMs: context.elapsedMs,
    ...sanitized,
  } as ActivityEvent;
  return { ...log, events: [...log.events, event] };
}

/**
 * Reconciles an externally supplied batch of already-sequenced events
 * (checkpoint rehydration, a transport that can redeliver or reorder) into
 * this log. An event whose `runId`/`lineageId`/`attempt` does not match this
 * log's own identity is dropped (fail closed — attempt boundaries are never
 * crossed), as is one whose `sequence` this log already holds. Within one
 * batch, a sequence may be claimed once: a second event carrying it is
 * dropped when it is byte-identical to the first and rejects the WHOLE batch
 * when it is not. The result is sorted by sequence; merging the same batch
 * twice is a no-op.
 *
 * **The failure this closes.** `seen` was built once, from the events already
 * stored, and the filter never added an accepted sequence back into it — so
 * the "already present" rule only ever saw the log, never the batch being
 * merged. Executed against this function before the fix:
 *
 *     input:  one batch, two events, both sequence 1
 *     result: events after merge: 2, sequences: 1,1
 *
 * The doc comment above claimed both halves and only the second was true.
 * After the first merge those sequences are stored, so re-merging the same
 * batch really was a no-op; a duplicate *inside* one batch was accepted
 * twice. A sequence is this log's ordering key and its identity for replay:
 * two events sharing one means replayed activity can apply an event twice,
 * and `nextSequence` (which reads the last event) can hand the same number
 * out again.
 *
 * **Why identical duplicates are kept and differing ones are not.** The two
 * causes are different bugs and deserve different answers. A transport that
 * redelivers sends the same event twice — nothing is lost by keeping one, and
 * rejecting the batch over it would throw away every legitimate event beside
 * it. Two *different* events sharing a sequence cannot both be right: the
 * sender assigned one number to two facts, which is a defect at the source,
 * and silently keeping either one hides it behind a log that looks complete.
 * Failing the whole batch closed is what `sanitizePlanItems` above already
 * does for a duplicate plan-item id, and what `appendActivityEvent` does for
 * any rejected fact: the log is left byte-for-byte unchanged rather than
 * partially reflecting an input nobody can interpret. Sameness is decided by
 * `canonicalStringify` (`./contentDigest`), the codebase's one structural
 * comparison, so field order in the delivered object cannot make two copies
 * of one event look like two events.
 */
export function mergeActivityEvents(log: ActivityLog, incoming: readonly ActivityEvent[]): ActivityLog {
  const stored = new Set(log.events.map((event) => event.sequence));
  const claimed = new Map<number, ActivityEvent>();
  for (const event of incoming) {
    if (event.runId !== log.runId || event.lineageId !== log.lineageId || event.attempt !== log.attempt) continue;
    if (stored.has(event.sequence)) continue;
    const first = claimed.get(event.sequence);
    if (first === undefined) {
      claimed.set(event.sequence, event);
      continue;
    }
    // Fail closed: one sequence, two different facts. Nothing here can tell which the run actually
    // produced, so the batch is refused whole rather than resolved by arrival order.
    if (canonicalStringify(first) !== canonicalStringify(event)) return log;
  }
  if (claimed.size === 0) return log;
  const merged = [...log.events, ...claimed.values()].sort((a, b) => a.sequence - b.sequence);
  return { ...log, events: merged };
}
