import { describe, expect, it } from 'vitest';
import { compactActivity, jsonByteLength } from './harnessActivityCompaction';
import type { ActivityEvent } from '../domain/harnessActivity';

const RUN_ID = 'run-1';
const LINEAGE_ID = 'lineage-1';
const ATTEMPT = 1;

function base(sequence: number, occurredAt: string) {
  return { runId: RUN_ID, lineageId: LINEAGE_ID, attempt: ATTEMPT, sequence, occurredAt, phase: 'investigating' as const, elapsedMs: sequence * 1000 };
}

function toolCompleted(sequence: number, occurredAt: string, tool = 'readDiff', target = 'file1.ts'): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'toolCompleted', tool, target, summary: '1 unit(s) returned.' };
}

function toolFailed(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'toolFailed', tool: 'readDiff', target: 'file2.ts', reason: 'The provider returned unavailable.' };
}

function coverageChanged(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'coverageChanged', coverage: { classified: sequence, inspected: sequence } };
}

function checkpoint(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'checkpoint', checkpointId: `ckpt-${sequence}` };
}

function planCreated(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'planCreated', plan: { revision: 1, items: [{ id: 'p1', description: 'Investigate.', state: 'active' }] } };
}

function planItemStateChanged(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'planItemStateChanged', itemId: 'p1', state: 'completed' };
}

function terminalResult(sequence: number, occurredAt: string): ActivityEvent {
  return { ...base(sequence, occurredAt), kind: 'terminalResult', lifecycle: 'succeeded', completeness: 'complete', limitations: [] };
}

const GENEROUS_POLICY = { maxActivityEventsPerAttempt: 1000, maxActivityBytesPerAttempt: 1024 * 1024 };

describe('compactActivity (11.3)', () => {
  it('folds a consecutive run of same-tool toolCompleted events into one, keeping an aggregate count and first/last timestamps', () => {
    const events = [
      toolCompleted(1, '2026-01-01T00:00:00.000Z'),
      toolCompleted(2, '2026-01-01T00:00:01.000Z'),
      toolCompleted(3, '2026-01-01T00:00:02.000Z'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);

    expect(result.events).toHaveLength(1);
    expect(result.coalescedGroups).toBe(1);
    expect(result.coalescedEventsRemoved).toBe(2);
    const folded = result.events[0];
    expect(folded?.kind).toBe('toolCompleted');
    if (folded?.kind === 'toolCompleted') {
      expect(folded.summary).toContain('3');
      expect(folded.summary).toContain('2026-01-01T00:00:00.000Z');
      expect(folded.summary).toContain('2026-01-01T00:00:02.000Z');
      // Keeps the last event's identity so ordering among surviving events is unaffected.
      expect(folded.sequence).toBe(3);
      expect(folded.occurredAt).toBe('2026-01-01T00:00:02.000Z');
    }
  });

  it('does not coalesce a lone toolCompleted event (a run of one stays as-is)', () => {
    const events = [toolCompleted(1, '2026-01-01T00:00:00.000Z')];
    const result = compactActivity(events, GENEROUS_POLICY);
    expect(result.events).toEqual(events);
    expect(result.coalescedGroups).toBe(0);
  });

  it('a different tool ends the run: two separate tools produce two separate folded groups', () => {
    const events = [
      toolCompleted(1, '2026-01-01T00:00:00.000Z', 'readDiff'),
      toolCompleted(2, '2026-01-01T00:00:01.000Z', 'readDiff'),
      toolCompleted(3, '2026-01-01T00:00:02.000Z', 'searchRepository'),
      toolCompleted(4, '2026-01-01T00:00:03.000Z', 'searchRepository'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);
    expect(result.events).toHaveLength(2);
    expect(result.events.every((e) => e.kind === 'toolCompleted')).toBe(true);
    expect(result.coalescedGroups).toBe(2);
  });

  it('a protected event between two toolCompleted events ends the run, even for the same tool', () => {
    const events = [
      toolCompleted(1, '2026-01-01T00:00:00.000Z'),
      coverageChanged(2, '2026-01-01T00:00:01.000Z'),
      toolCompleted(3, '2026-01-01T00:00:02.000Z'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);
    // Nothing folds: each toolCompleted is a run of one, and coverageChanged survives untouched.
    expect(result.events).toHaveLength(3);
    expect(result.coalescedGroups).toBe(0);
    expect(result.events.map((e) => e.kind)).toEqual(['toolCompleted', 'coverageChanged', 'toolCompleted']);
  });

  it('a mixed-target run drops the target rather than misrepresenting a single one', () => {
    const events = [
      toolCompleted(1, '2026-01-01T00:00:00.000Z', 'readDiff', 'file1.ts'),
      toolCompleted(2, '2026-01-01T00:00:01.000Z', 'readDiff', 'file2.ts'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);
    const folded = result.events[0];
    expect(folded?.kind).toBe('toolCompleted');
    if (folded?.kind === 'toolCompleted') expect(folded.target).toBeUndefined();
  });

  it('preserves every protected event class: plan revisions, lifecycle/terminal events, failures, checkpoints, coverage changes, and results', () => {
    const events: ActivityEvent[] = [
      planCreated(1, '2026-01-01T00:00:00.000Z'),
      planItemStateChanged(2, '2026-01-01T00:00:01.000Z'),
      toolFailed(3, '2026-01-01T00:00:02.000Z'),
      checkpoint(4, '2026-01-01T00:00:03.000Z'),
      coverageChanged(5, '2026-01-01T00:00:04.000Z'),
      terminalResult(6, '2026-01-01T00:00:05.000Z'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);
    expect(result.events).toEqual(events);
    expect(result.coalescedGroups).toBe(0);
  });

  it('routine toolCompleted runs interleaved with protected events: only the routine runs coalesce', () => {
    const events: ActivityEvent[] = [
      planCreated(1, '2026-01-01T00:00:00.000Z'),
      toolCompleted(2, '2026-01-01T00:00:01.000Z'),
      toolCompleted(3, '2026-01-01T00:00:02.000Z'),
      toolCompleted(4, '2026-01-01T00:00:03.000Z'),
      coverageChanged(5, '2026-01-01T00:00:04.000Z'),
      toolFailed(6, '2026-01-01T00:00:05.000Z'),
      terminalResult(7, '2026-01-01T00:00:06.000Z'),
    ];
    const result = compactActivity(events, GENEROUS_POLICY);
    expect(result.events.map((e) => e.kind)).toEqual(['planCreated', 'toolCompleted', 'coverageChanged', 'toolFailed', 'terminalResult']);
    expect(result.coalescedGroups).toBe(1);
    expect(result.coalescedEventsRemoved).toBe(2);
  });

  it('reports the event-count bound as satisfied once coalescing brings it under, and unsatisfied when protected events alone exceed it', () => {
    const routineHeavy = Array.from({ length: 10 }, (_, i) => toolCompleted(i + 1, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    const tightPolicy = { maxActivityEventsPerAttempt: 2, maxActivityBytesPerAttempt: 1024 * 1024 };
    const routineResult = compactActivity(routineHeavy, tightPolicy);
    expect(routineResult.eventCount).toBe(1); // fully coalesced to one event
    expect(routineResult.withinEventBound).toBe(true);

    const protectedHeavy: ActivityEvent[] = Array.from({ length: 5 }, (_, i) => coverageChanged(i + 1, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    const protectedResult = compactActivity(protectedHeavy, tightPolicy);
    expect(protectedResult.eventCount).toBe(5); // nothing here can legitimately be dropped
    expect(protectedResult.withinEventBound).toBe(false);
  });

  it('reports the byte bound similarly: coalescing can satisfy it, but protected content alone cannot be shrunk further', () => {
    const routineHeavy = Array.from({ length: 20 }, (_, i) => toolCompleted(i + 1, `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`));
    const tinyBytePolicy = { maxActivityEventsPerAttempt: 1000, maxActivityBytesPerAttempt: jsonByteLength([toolCompleted(1, '2026-01-01T00:00:00.000Z')]) + 200 };
    const result = compactActivity(routineHeavy, tinyBytePolicy);
    expect(result.coalescedGroups).toBe(1);
    expect(result.withinByteBound).toBe(true);
  });

  it('is idempotent: compacting an already-compacted log changes nothing further', () => {
    const events = [toolCompleted(1, '2026-01-01T00:00:00.000Z'), toolCompleted(2, '2026-01-01T00:00:01.000Z')];
    const once = compactActivity(events, GENEROUS_POLICY);
    const twice = compactActivity(once.events, GENEROUS_POLICY);
    expect(twice.events).toEqual(once.events);
    expect(twice.coalescedGroups).toBe(0);
  });

  it('drops a redelivered duplicate (same sequence) before compacting, defensively like the activity reducer', () => {
    const events = [toolCompleted(1, '2026-01-01T00:00:00.000Z'), toolCompleted(1, '2026-01-01T00:00:00.000Z')];
    const result = compactActivity(events, GENEROUS_POLICY);
    expect(result.events).toHaveLength(1);
  });
});

describe('jsonByteLength', () => {
  it('matches Buffer.byteLength over the JSON serialization, in UTF-8', () => {
    const value = { a: 'héllo', b: 1 };
    expect(jsonByteLength(value)).toBe(Buffer.byteLength(JSON.stringify(value), 'utf8'));
  });
});
