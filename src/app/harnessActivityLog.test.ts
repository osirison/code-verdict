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
