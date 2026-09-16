import { describe, expect, it } from 'vitest';
import type { ActivityEvent } from '../domain/harnessActivity';
import {
  appendActivityEvent,
  createActivityLog,
  mergeActivityEvents,
  type ActivityLog,
} from './harnessActivityLog';
import { planCreatedFact } from './harnessActivityPlan';

function context(elapsedMs: number, occurredAt: string) {
  return { occurredAt, phase: 'investigating' as const, elapsedMs };
}

function withOnePlan(log: ActivityLog): ActivityLog {
  const plan = { revision: 1, items: [{ id: 'p1', description: 'Inspect auth', state: 'pending' as const }] };
  return appendActivityEvent(log, planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
}

describe('appendActivityEvent (tasks 5.1/5.2)', () => {
  it('assigns monotonic sequence numbers starting at 1', () => {
    let log = createActivityLog('run-1', 'lineage-1', 1);
    log = appendActivityEvent(log, { kind: 'resuming' }, context(0, '2026-09-01T00:00:00.000Z'));
    log = appendActivityEvent(log, { kind: 'cancelling' }, context(1000, '2026-09-01T00:00:01.000Z'));
    expect(log.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('stamps every event with the log identity, never something the caller could supply', () => {
    const log = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 2),
      { kind: 'resuming' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    expect(log.events[0]).toMatchObject({ runId: 'run-1', lineageId: 'lineage-1', attempt: 2 });
  });

  it('scopes sequence numbering to one attempt: a new attempt never continues a prior one\'s count (attempt boundaries)', () => {
    const attempt1 = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 1),
      { kind: 'resuming' },
      context(9000, '2026-09-01T00:00:09.000Z'),
    );
    const attempt2 = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 2),
      { kind: 'resuming' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    expect(attempt1.events[0]).toMatchObject({ sequence: 1, attempt: 1 });
    expect(attempt2.events[0]).toMatchObject({ sequence: 1, attempt: 2 });
  });

  it('never mutates the log passed in (immutable append)', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const appended = appendActivityEvent(log, { kind: 'resuming' }, context(0, '2026-09-01T00:00:00.000Z'));
    expect(log.events).toHaveLength(0);
    expect(appended.events).toHaveLength(1);
    expect(appended).not.toBe(log);
  });

  it('fails closed on a malformed context and leaves the log byte-for-byte unchanged', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(log, { kind: 'resuming' }, {
      occurredAt: 'not-a-date',
      phase: 'investigating',
      elapsedMs: 0,
    });
    expect(rejected).toBe(log);
  });

  it('fails closed on elapsed time or wall-clock time moving backwards', () => {
    const log = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 1),
      { kind: 'resuming' },
      context(5000, '2026-09-01T00:00:05.000Z'),
    );
    const rejected = appendActivityEvent(log, { kind: 'cancelling' }, context(1000, '2026-09-01T00:00:01.000Z'));
    expect(rejected).toBe(log);
  });

  it('rejects a planItemStateChanged fact for an identifier no plan ever declared (fail closed, stable identifiers)', () => {
    const log = withOnePlan(createActivityLog('run-1', 'lineage-1', 1));
    const rejected = appendActivityEvent(
      log,
      { kind: 'planItemStateChanged', itemId: 'ghost', state: 'active' },
      context(1000, '2026-09-01T00:00:01.000Z'),
    );
    expect(rejected).toBe(log);
  });

  it('accepts a planItemStateChanged fact for a previously declared identifier', () => {
    const log = withOnePlan(createActivityLog('run-1', 'lineage-1', 1));
    const accepted = appendActivityEvent(
      log,
      { kind: 'planItemStateChanged', itemId: 'p1', state: 'active' },
      context(1000, '2026-09-01T00:00:01.000Z'),
    );
    expect(accepted.events).toHaveLength(2);
  });

  it('carries a member-scoped plan item\'s memberId through sanitization, and leaves a shared item without one (task 13.3)', () => {
    const plan = {
      revision: 1,
      items: [
        { id: 'core-1', description: 'Inspect authorization changes', state: 'pending' as const, memberId: 'core' },
        { id: 'shared-1', description: 'Confirm the billing schema matches core', state: 'pending' as const },
      ],
    };
    const log = appendActivityEvent(createActivityLog('run-1', 'lineage-1', 1), planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
    const event = log.events[0];
    if (event?.kind !== 'planCreated') throw new Error('expected planCreated');
    expect(event.plan.items[0]).toEqual({ id: 'core-1', description: 'Inspect authorization changes', state: 'pending', memberId: 'core' });
    expect(event.plan.items[1]).not.toHaveProperty('memberId');
  });

  it('carries a limitation\'s candidateId through sanitization, and leaves one with no candidateId without one (task: banner aggregation)', () => {
    const log = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 1),
      {
        kind: 'terminalResult',
        lifecycle: 'failed',
        completeness: 'partial',
        limitations: [
          { code: 'unverifiableCitation', message: 'Candidate cand-a could not be checked for contradiction.', candidateId: 'cand-a' },
          { code: 'headChanged', message: 'The target head changed after the snapshot was taken.' },
        ],
      },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    const event = log.events[0];
    if (event?.kind !== 'terminalResult') throw new Error('expected terminalResult');
    expect(event.limitations[0]).toEqual({ code: 'unverifiableCitation', message: 'Candidate cand-a could not be checked for contradiction.', candidateId: 'cand-a' });
    expect(event.limitations[1]).not.toHaveProperty('candidateId');
  });

  it('fails closed on a plan item with a blank memberId', () => {
    const plan = { revision: 1, items: [{ id: 'p1', description: 'x', state: 'pending' as const, memberId: '  ' }] };
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(log, planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
    expect(rejected).toBe(log);
  });

  it('fails closed on a plan item id carrying a control character, consistent with the protocol\'s own identifier rule', () => {
    const plan = { revision: 1, items: [{ id: 'p1\np2', description: 'x', state: 'pending' as const }] };
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(log, planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
    expect(rejected).toBe(log);
  });

  it('fails closed on a plan item id with leading or trailing whitespace', () => {
    const plan = { revision: 1, items: [{ id: ' p1', description: 'x', state: 'pending' as const }] };
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(log, planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
    expect(rejected).toBe(log);
  });

  it('fails closed on a plan item memberId carrying a control character', () => {
    const plan = { revision: 1, items: [{ id: 'p1', description: 'x', state: 'pending' as const, memberId: 'core\t1' }] };
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(log, planCreatedFact(plan), context(0, '2026-09-01T00:00:00.000Z'));
    expect(rejected).toBe(log);
  });

  it('fails closed on toolCompleted/toolFailed metadata carrying a memberId with a control character', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(
      log,
      { kind: 'toolCompleted', tool: 'readFile', summary: 'ok', memberId: 'core\n1' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    expect(rejected).toBe(log);
  });

  it('rejects a fact whose required text sanitizes to nothing', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const rejected = appendActivityEvent(
      log,
      { kind: 'toolCompleted', tool: 'readDiff', summary: '   ' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    expect(rejected).toBe(log);
  });

  it('redacts a secret embedded in an otherwise legitimate summary, keeping the event (secret redaction)', () => {
    const log = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 1),
      { kind: 'toolCompleted', tool: 'readFile', summary: 'Fetched using token=abc123secretvalue' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    const event = log.events[0];
    expect(event?.kind).toBe('toolCompleted');
    if (event?.kind === 'toolCompleted') {
      expect(event.summary).not.toContain('abc123secretvalue');
      expect(event.summary).toContain('[REDACTED]');
    }
  });

  it('drops an optional target field entirely rather than storing it empty', () => {
    const log = appendActivityEvent(
      createActivityLog('run-1', 'lineage-1', 1),
      { kind: 'actionStarted', action: 'Inspecting authorization changes' },
      context(0, '2026-09-01T00:00:00.000Z'),
    );
    const event = log.events[0];
    expect(event && 'target' in event).toBe(false);
  });
});

describe('mergeActivityEvents (tasks 5.1/5.2 — out-of-order and duplicate delivery, attempt boundaries)', () => {
  const base = { runId: 'run-1', lineageId: 'lineage-1', attempt: 1, phase: 'investigating' as const };

  function resumingEvent(sequence: number, occurredAt: string): ActivityEvent {
    return { ...base, sequence, occurredAt, elapsedMs: sequence * 1000, kind: 'resuming' };
  }

  it('sorts incoming events by protocol sequence, not arrival order', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const merged = mergeActivityEvents(log, [
      resumingEvent(2, '2026-09-01T00:00:02.000Z'),
      resumingEvent(1, '2026-09-01T00:00:01.000Z'),
    ]);
    expect(merged.events.map((e) => e.sequence)).toEqual([1, 2]);
  });

  it('does not create duplicate activity from a redelivered event', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const once = mergeActivityEvents(log, [resumingEvent(1, '2026-09-01T00:00:01.000Z')]);
    const twice = mergeActivityEvents(once, [resumingEvent(1, '2026-09-01T00:00:01.000Z')]);
    expect(twice.events).toHaveLength(1);
    expect(twice).toBe(once); // merging the same batch again is a true no-op
  });

  /**
   * The duplicate rule used to read only the events already stored, never the batch being merged,
   * so two events carrying the same NEW sequence were both accepted. Executed against the real
   * function before the fix: one batch, two events, both sequence 1, produced a log of 2 events
   * with sequences 1,1 — a sequence is the log's ordering key and its replay identity, so that log
   * can apply an event twice and hand the same number out again.
   */
  it('accepts a redelivered event only once when both copies arrive in the same batch', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const merged = mergeActivityEvents(log, [
      resumingEvent(1, '2026-09-01T00:00:01.000Z'),
      resumingEvent(1, '2026-09-01T00:00:01.000Z'),
    ]);
    expect(merged.events).toHaveLength(1);
    expect(merged.events.map((e) => e.sequence)).toEqual([1]);
  });

  it('rejects the whole batch when two different events claim one sequence', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const cancelling: ActivityEvent = { ...base, sequence: 1, occurredAt: '2026-09-01T00:00:01.000Z', elapsedMs: 1000, kind: 'cancelling' };
    const merged = mergeActivityEvents(log, [resumingEvent(1, '2026-09-01T00:00:01.000Z'), cancelling]);
    // Not "first wins": nothing here can tell which fact the run produced, so the log is left
    // byte-for-byte unchanged rather than silently keeping one of two contradictory events.
    expect(merged).toBe(log);
    expect(merged.events).toHaveLength(0);
  });

  it('rejects a batch whole, discarding events that would otherwise have been accepted', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const conflicting: ActivityEvent = { ...base, sequence: 2, occurredAt: '2026-09-01T00:00:02.000Z', elapsedMs: 2000, kind: 'cancelling' };
    const merged = mergeActivityEvents(log, [
      resumingEvent(1, '2026-09-01T00:00:01.000Z'),
      resumingEvent(2, '2026-09-01T00:00:02.000Z'),
      conflicting,
    ]);
    expect(merged).toBe(log);
  });

  it('treats a batch-internal duplicate of an already-stored sequence as the no-op it is', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const once = mergeActivityEvents(log, [resumingEvent(1, '2026-09-01T00:00:01.000Z')]);
    // Both copies are dropped by the already-stored rule before the batch-internal rule sees them,
    // so a redelivering transport that repeats a whole batch is still a true no-op.
    const twice = mergeActivityEvents(once, [resumingEvent(1, '2026-09-01T00:00:01.000Z'), resumingEvent(1, '2026-09-01T00:00:01.000Z')]);
    expect(twice).toBe(once);
  });

  /**
   * `mergeActivityEvents` used to check only identity and sequence
   * uniqueness, never routing an incoming event's fact through the same
   * `sanitizeFact` pass `appendActivityEvent` applies — so a
   * `planItemStateChanged` event naming an item no plan in this log ever
   * declared, which `appendActivityEvent` refuses outright, was accepted
   * verbatim through this path. It has zero production callers today (only
   * this test exercises it), but the module's own header claims nothing
   * unsanitized can reach the log, which this closes for real.
   */
  it('drops an incoming event that fails the same fail-closed validation appendActivityEvent applies, without failing the rest of the batch', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const unknownItem: ActivityEvent = {
      ...base,
      sequence: 1,
      occurredAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 1000,
      kind: 'planItemStateChanged',
      itemId: 'no-such-plan-item',
      state: 'completed',
    };
    const merged = mergeActivityEvents(log, [unknownItem, resumingEvent(2, '2026-09-01T00:00:02.000Z')]);
    expect(merged.events).toHaveLength(1);
    expect(merged.events[0]).toMatchObject({ kind: 'resuming', sequence: 2 });
  });

  it('validates a planItemStateChanged event against a plan that arrives earlier in the same batch, not only against what was already stored', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const planEvent: ActivityEvent = {
      ...base,
      sequence: 1,
      occurredAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 1000,
      kind: 'planCreated',
      plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect auth', state: 'pending' }] },
    };
    const stateEvent: ActivityEvent = {
      ...base,
      sequence: 2,
      occurredAt: '2026-09-01T00:00:02.000Z',
      elapsedMs: 2000,
      kind: 'planItemStateChanged',
      itemId: 'p1',
      state: 'completed',
    };
    const merged = mergeActivityEvents(log, [planEvent, stateEvent]);
    expect(merged.events.map((e) => e.kind)).toEqual(['planCreated', 'planItemStateChanged']);
  });

  /**
   * `mergeActivityEvents` used to cross-validate `incoming` in raw array (arrival) order —
   * `knownIds` only grew as a `planCreated`/`planRevised` event was iterated — so a batch delivered
   * out of order (exactly the "transport that can redeliver or reorder" case this function exists
   * for) validated a `planItemStateChanged` event against `knownIds` before the plan it depends on,
   * arriving later in the array despite its lower sequence, had been processed — failing
   * `sanitizeFact`'s known-item check and dropping the event for good (its sequence is never
   * claimed, so nothing resurfaces it on a later merge). The trailing `.sort()` only reorders what
   * already survived; it can never resurrect an event dropped during validation. Same fixture as
   * the "arrives earlier in the same batch" test above, with the array order reversed relative to
   * sequence order — this is the one case that test's own array order could not catch.
   */
  it('cross-validates by protocol sequence, not array arrival order: a plan-dependent event delivered before its plan in the array must still be accepted', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const planEvent: ActivityEvent = {
      ...base,
      sequence: 1,
      occurredAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 1000,
      kind: 'planCreated',
      plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect auth', state: 'pending' }] },
    };
    const stateEvent: ActivityEvent = {
      ...base,
      sequence: 2,
      occurredAt: '2026-09-01T00:00:02.000Z',
      elapsedMs: 2000,
      kind: 'planItemStateChanged',
      itemId: 'p1',
      state: 'completed',
    };
    // The state-change event (sequence 2) arrives FIRST in the array, its plan (sequence 1) second.
    const merged = mergeActivityEvents(log, [stateEvent, planEvent]);
    expect(merged.events.map((e) => e.kind)).toEqual(['planCreated', 'planItemStateChanged']);
  });

  /**
   * `mergeActivityEvents`' own doc comment claims "every incoming event is put through the same
   * fail-closed sanitization `appendActivityEvent` applies to a caller-supplied fact" — but only the
   * per-kind fact fields ever reached `sanitizeFact`; the common/base fields (`phase`, `elapsedMs`,
   * `occurredAt`, `sequence`) were copied verbatim from the incoming event with no equivalent of
   * `appendActivityEvent`'s own `validContext`. A garbage `phase`, a negative `elapsedMs`, and an
   * unparsable `occurredAt` all used to be accepted into the log unchanged.
   */
  it('drops an incoming event whose base fields are invalid, exactly as appendActivityEvent\'s validContext would', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const garbagePhase: ActivityEvent = { ...base, phase: 'not-a-real-phase' as unknown as typeof base.phase, sequence: 1, occurredAt: '2026-09-01T00:00:01.000Z', elapsedMs: 1000, kind: 'resuming' };
    const negativeElapsed: ActivityEvent = { ...base, sequence: 2, occurredAt: '2026-09-01T00:00:02.000Z', elapsedMs: -999999, kind: 'resuming' };
    const unparsableTime: ActivityEvent = { ...base, sequence: 3, occurredAt: 'not-a-date', elapsedMs: 3000, kind: 'resuming' };
    const merged = mergeActivityEvents(log, [garbagePhase, negativeElapsed, unparsableTime]);
    expect(merged.events).toHaveLength(0);
    expect(merged).toBe(log);
  });

  /**
   * A `NaN` sequence used to be accepted verbatim (`JSON.stringify` renders it as `sequence: null`),
   * poisoning every later `appendActivityEvent` on that log: `nextSequence` computes `last.sequence +
   * 1`, and `NaN + 1` is `NaN` forever. `nextSequence` never produces anything but a positive
   * integer starting at 1, so an incoming event claiming otherwise cannot be a real member of this
   * log's own ordering.
   */
  it('drops an incoming event with a NaN or non-positive-integer sequence rather than admitting it and poisoning every later append', () => {
    const log = createActivityLog('run-1', 'lineage-1', 1);
    const nanSequence: ActivityEvent = { ...base, sequence: NaN, occurredAt: '2026-09-01T00:00:01.000Z', elapsedMs: 1000, kind: 'resuming' };
    const merged = mergeActivityEvents(log, [nanSequence]);
    expect(merged.events).toHaveLength(0);
    expect(merged).toBe(log);
  });

  it('drops an event from another attempt so attempt boundaries are never crossed', () => {
    const log = createActivityLog('run-1', 'lineage-1', 2);
    const foreign: ActivityEvent = {
      ...base,
      attempt: 1,
      sequence: 1,
      occurredAt: '2026-09-01T00:00:01.000Z',
      elapsedMs: 0,
      kind: 'resuming',
    };
    const merged = mergeActivityEvents(log, [foreign]);
    expect(merged.events).toHaveLength(0);
    expect(merged).toBe(log);
  });
});
