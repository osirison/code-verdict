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
import { isPlanItemState, isRunPhase } from '../domain/harnessActivity';
import type { ActivityEvent, Limitation, PlanItem, RunPhase } from '../domain/harnessActivity';
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
    ids.add(item.id);
    cleaned.push({ id: item.id, description, state: item.state });
  }
  return cleaned;
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
      if (tool === undefined || summary === undefined || !target.ok) return undefined;
      return target.value === undefined ? { ...fact, tool, summary } : { ...fact, tool, summary, target: target.value };
    }
    case 'toolFailed': {
      const tool = sanitizePublicText(fact.tool);
      const reason = sanitizePublicText(fact.reason);
      const target = sanitizeOptionalText(fact.target);
      if (tool === undefined || reason === undefined || !target.ok) return undefined;
      return target.value === undefined ? { ...fact, tool, reason } : { ...fact, tool, reason, target: target.value };
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
 * crossed), as is one whose `sequence` is already present. The result is
 * sorted by sequence; merging the same batch twice is a no-op.
 */
export function mergeActivityEvents(log: ActivityLog, incoming: readonly ActivityEvent[]): ActivityLog {
  const seen = new Set(log.events.map((event) => event.sequence));
  const accepted = incoming.filter(
    (event) =>
      event.runId === log.runId &&
      event.lineageId === log.lineageId &&
      event.attempt === log.attempt &&
      !seen.has(event.sequence),
  );
  if (accepted.length === 0) return log;
  const merged = [...log.events, ...accepted].sort((a, b) => a.sequence - b.sequence);
  return { ...log, events: merged };
}
