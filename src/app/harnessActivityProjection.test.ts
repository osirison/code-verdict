import { describe, expect, it } from 'vitest';
import type { ActivityEvent, RunPhase } from '../domain/harnessActivity';
import type { ActivityLog } from './harnessActivityLog';
import { reduceActivity } from './harnessActivityProjection';

const IDENTITY = { runId: 'run-1', lineageId: 'lineage-1', attempt: 1 };

function log(events: readonly ActivityEvent[]): ActivityLog {
  return { ...IDENTITY, events };
}

function base(sequence: number, phase: RunPhase = 'investigating') {
  return {
    ...IDENTITY,
    sequence,
    occurredAt: `2026-09-01T00:00:${String(sequence).padStart(2, '0')}.000Z`,
    phase,
    elapsedMs: sequence * 1000,
  };
}

describe('reduceActivity (task 5.4)', () => {
  it('projects queued/indeterminate/none from an empty log', () => {
    const projection = reduceActivity(log([]));
    expect(projection.lifecycle).toBe('queued');
    expect(projection.completeness).toBe('none');
    expect(projection.progressMode).toBe('indeterminate');
    expect(projection.attention).toBe('none');
    expect(projection.limitations).toEqual([]);
  });

  it("derives lifecycle from the latest event's phase absent a special lifecycle event", () => {
    const projection = reduceActivity(
      log([{ ...base(1, 'verifying'), kind: 'toolCompleted', tool: 'readDiff', summary: 'ok' }]),
    );
    expect(projection.lifecycle).toBe('verifying');
  });

  it('collapses the bootstrap and persisting phases onto planning and completing', () => {
    expect(
      reduceActivity(log([{ ...base(1, 'bootstrap'), kind: 'actionStarted', action: 'Loading context' }])).lifecycle,
    ).toBe('planning');
    expect(
      reduceActivity(log([{ ...base(1, 'persisting'), kind: 'checkpoint', checkpointId: 'c1' }])).lifecycle,
    ).toBe('completing');
  });

  it('sorts out-of-order events by sequence before folding (protocol order, not arrival order)', () => {
    const events: ActivityEvent[] = [
      { ...base(2, 'verifying'), kind: 'actionStarted', action: 'second' },
      { ...base(1, 'investigating'), kind: 'actionStarted', action: 'first' },
    ];
    const projection = reduceActivity(log(events));
    expect(projection.currentAction).toBe('second'); // sequence 2 is the true latest, despite arriving first
    expect(projection.lifecycle).toBe('verifying');
  });

  it('does not double-apply a duplicate (redelivered) event', () => {
    const duplicated: ActivityEvent[] = [
      { ...base(1), kind: 'coverageChanged', coverage: { classified: 1, total: 10, inspected: 0 } },
      // A redelivery with the same sequence must never overwrite the first with a different payload.
      { ...base(1), kind: 'coverageChanged', coverage: { classified: 999, total: 10, inspected: 0 } },
    ];
    const projection = reduceActivity(log(duplicated));
    expect(projection.coverage).toEqual({ classified: 1, total: 10, inspected: 0 });
  });

  it('keeps lifecycle and completeness independent: failed lifecycle with a partial result', () => {
    const projection = reduceActivity(
      log([
        {
          ...base(1),
          kind: 'terminalResult',
          lifecycle: 'failed',
          completeness: 'partial',
          limitations: [{ code: 'budgetExhausted', message: 'Ran out of turns' }],
        },
      ]),
    );
    expect(projection.lifecycle).toBe('failed');
    expect(projection.completeness).toBe('partial');
    expect(projection.result).toEqual({
      completeness: 'partial',
      limitations: [{ code: 'budgetExhausted', message: 'Ran out of turns' }],
    });
  });

  it('keeps lifecycle and completeness independent: cancelled before any evidence is none', () => {
    const projection = reduceActivity(
      log([{ ...base(1), kind: 'terminalResult', lifecycle: 'cancelled', completeness: 'none', limitations: [] }]),
    );
    expect(projection.lifecycle).toBe('cancelled');
    expect(projection.completeness).toBe('none');
  });

  it('reflects an interim partialResult as completeness partial without forcing a terminal lifecycle', () => {
    const projection = reduceActivity(
      log([
        {
          ...base(1, 'verifying'),
          kind: 'partialResult',
          limitations: [{ code: 'unresolvedCandidates', message: '1 unresolved' }],
        },
      ]),
    );
    expect(projection.completeness).toBe('partial');
    expect(projection.lifecycle).toBe('verifying'); // still an active phase; partialResult alone is not terminal
  });

  it('shows determinate progress only once a real denominator exists (determinate units)', () => {
    const withTotal = reduceActivity(
      log([{ ...base(1), kind: 'coverageChanged', coverage: { classified: 5, total: 20, inspected: 2 } }]),
    );
    expect(withTotal.progressMode).toBe('determinate');
    expect(withTotal.progressUnits).toEqual({ completed: 5, total: 20 });
  });

  it('shows indeterminate progress while there is no known total, or nothing has happened yet (indeterminate waits)', () => {
    const noTotal = reduceActivity(log([{ ...base(1), kind: 'coverageChanged', coverage: { classified: 5, inspected: 0 } }]));
    expect(noTotal.progressMode).toBe('indeterminate');
    expect(noTotal.progressUnits).toBeUndefined();

    const waitingOnModel = reduceActivity(log([{ ...base(1), kind: 'actionStarted', action: 'Waiting for model response' }]));
    expect(waitingOnModel.progressMode).toBe('indeterminate');
  });

  it('marks attentionRequired only for a durable pause, not a transient wait', () => {
    const waiting = reduceActivity(log([{ ...base(1), kind: 'waiting', reason: 'Retry-After 30s' }]));
    expect(waiting.attention).toBe('none');
    expect(waiting.lifecycle).toBe('waiting');
    expect(waiting.currentAction).toBe('Retry-After 30s');

    const paused = reduceActivity(log([{ ...base(1), kind: 'paused', reason: 'Awaiting reviewer input' }]));
    expect(paused.attention).toBe('attentionRequired');
    expect(paused.lifecycle).toBe('paused');
  });

  it('clears current action once the attempt reaches a terminal lifecycle', () => {
    const events: ActivityEvent[] = [
      { ...base(1), kind: 'actionStarted', action: 'Inspecting auth' },
      { ...base(2), kind: 'terminalResult', lifecycle: 'succeeded', completeness: 'complete', limitations: [] },
    ];
    const projection = reduceActivity(log(events));
    expect(projection.currentAction).toBeUndefined();
    expect(projection.currentTarget).toBeUndefined();
  });

  it('a terminal event is never masked by a large volume of preceding routine activity (bypasses progress throttling)', () => {
    const routine: ActivityEvent[] = Array.from({ length: 500 }, (_, i) => ({
      ...base(i + 1),
      kind: 'toolCompleted' as const,
      tool: 'readDiff',
      summary: `page ${i}`,
    }));
    const terminal: ActivityEvent = {
      ...base(501),
      kind: 'terminalResult',
      lifecycle: 'succeeded',
      completeness: 'complete',
      limitations: [],
    };
    const projection = reduceActivity(log([...routine, terminal]));
    expect(projection.lifecycle).toBe('succeeded');
    expect(projection.completeness).toBe('complete');
    expect(projection.currentAction).toBeUndefined();
  });

  it('tracks the active plan item across a plan and later state-change events', () => {
    const events: ActivityEvent[] = [
      {
        ...base(1),
        kind: 'planCreated',
        plan: {
          revision: 1,
          items: [
            { id: 'p1', description: 'Inspect auth', state: 'active' },
            { id: 'p2', description: 'Inspect billing', state: 'pending' },
          ],
        },
      },
      { ...base(2), kind: 'planItemStateChanged', itemId: 'p1', state: 'completed' },
      { ...base(3), kind: 'planItemStateChanged', itemId: 'p2', state: 'active' },
    ];
    expect(reduceActivity(log(events)).activePlanItemId).toBe('p2');
  });

  it('surfaces the latest checkpoint id', () => {
    const events: ActivityEvent[] = [
      { ...base(1), kind: 'toolCompleted', tool: 'readDiff', target: 'src/auth/token.ts', summary: 'read 40 lines' },
      { ...base(2), kind: 'checkpoint', checkpointId: 'chk-1' },
    ];
    expect(reduceActivity(log(events)).latestCheckpointId).toBe('chk-1');
  });
});
