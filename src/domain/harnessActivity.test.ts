import { describe, expect, it } from 'vitest';
import {
  isPlanItemState,
  isRunPhase,
  parsePlanItemState,
  parseRunPhase,
  PLAN_ITEM_STATES,
  RUN_PHASES,
  type ActivityEvent,
  type Plan,
  type RunProjection,
} from './harnessActivity';

function baseFields(sequence: number) {
  return {
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    sequence,
    occurredAt: `2026-09-01T00:00:0${sequence}.000Z`,
    phase: 'investigating' as const,
    elapsedMs: sequence * 1000,
  };
}

describe('harness activity, plan, and RunProjection types (task 2.3)', () => {
  it('accepts every plan-item state and fails closed on garbage', () => {
    for (const state of PLAN_ITEM_STATES) expect(isPlanItemState(state)).toBe(true);
    expect(parsePlanItemState('bogus')).toBeUndefined();
    expect(parsePlanItemState(undefined)).toBeUndefined();
  });

  it('accepts every run phase and fails closed on garbage', () => {
    for (const phase of RUN_PHASES) expect(isRunPhase(phase)).toBe(true);
    expect(parseRunPhase('reasoning')).toBeUndefined();
    expect(parseRunPhase(0)).toBeUndefined();
  });

  it('appends plan revisions rather than overwriting, keeping stable item ids', () => {
    const first: Plan = { revision: 1, items: [{ id: 'p1', description: 'Inspect auth', state: 'active' }] };
    const revised: Plan = {
      revision: 2,
      items: [
        { id: 'p1', description: 'Inspect auth', state: 'completed' },
        { id: 'p2', description: 'Inspect billing', state: 'pending' },
      ],
      rationale: 'A schema consumer was found in another member',
    };
    expect(revised.items.map((i) => i.id)).toContain(first.items[0]!.id);
    expect(revised.rationale).toBeDefined();
    expect(first.rationale).toBeUndefined();
  });

  it('orders activity events by protocol sequence rather than arrival order', () => {
    const events: ActivityEvent[] = [
      { ...baseFields(2), kind: 'resuming' },
      { ...baseFields(1), kind: 'waiting', reason: 'Retry-After 30s' },
    ];
    const ordered = [...events].sort((a, b) => a.sequence - b.sequence);
    expect(ordered.map((e) => e.kind)).toEqual(['waiting', 'resuming']);
  });

  it('narrows the activity union on kind', () => {
    const event: ActivityEvent = { ...baseFields(1), kind: 'toolFailed', tool: 'readDiff', reason: 'unavailable' };
    if (event.kind === 'toolFailed') {
      expect(event.reason).toBe('unavailable');
    } else {
      throw new Error('expected toolFailed');
    }
  });

  it('keeps completeness independent of lifecycle in the terminal event and result summary', () => {
    const event: ActivityEvent = {
      ...baseFields(9),
      kind: 'terminalResult',
      lifecycle: 'failed',
      completeness: 'partial',
      limitations: [{ code: 'unresolvedCandidates', message: '1 candidate unresolved' }],
    };
    expect(event.lifecycle).toBe('failed');
    expect(event.completeness).toBe('partial');

    const projection: RunProjection = {
      runId: 'run-1',
      lineageId: 'lineage-1',
      attempt: 1,
      lifecycle: 'failed',
      completeness: 'partial',
      elapsedMs: 9000,
      progressMode: 'indeterminate',
      attention: 'none',
      limitations: event.limitations,
      result: { completeness: 'partial', limitations: event.limitations },
    };
    expect(projection.result?.completeness).toBe('partial');
    expect(projection.lifecycle).toBe('failed');
  });
});
