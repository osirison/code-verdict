import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../app/reviewRunManager';
import { livenessView } from './runLiveness';

function record(over: Partial<RunRecord> = {}): RunRecord {
  return {
    key: 'repo-1!2841',
    input: {} as RunRecord['input'],
    status: 'running',
    queuedAt: 1_000,
    startedAt: 1_000,
    steps: ['One', 'Two'],
    step: 1,
    progress: { startedAt: 1_000, fragmentsReceived: 4, charsReceived: 512 },
    ...over,
  };
}

describe('livenessView', () => {
  it('measures elapsed at read time, against the clock the page is ticking', () => {
    // Stored elapsed would disagree with the page whenever a render landed
    // between two fragments.
    expect(livenessView(record(), 6_000)).toEqual({
      startedAt: 1_000,
      elapsedMs: 5_000,
      fragmentsReceived: 4,
      charsReceived: 512,
    });
  });

  it('shows nothing for a run that has not started streaming', () => {
    expect(livenessView(record({ status: 'queued', progress: undefined }))).toBeUndefined();
  });

  it('shows nothing once the run is over', () => {
    for (const status of ['succeeded', 'failed', 'cancelled'] as const) {
      expect(livenessView(record({ status, progress: undefined }))).toBeUndefined();
    }
  });

  it('shows nothing when there is no run at all', () => {
    expect(livenessView(undefined)).toBeUndefined();
  });

  it('reports a run that has produced nothing yet, rather than hiding it', () => {
    // Zero fragments is the state the line exists for: the request is alive and
    // has said nothing, which is not the same as no request.
    expect(livenessView(record({ progress: { startedAt: 1_000, fragmentsReceived: 0, charsReceived: 0 } }), 3_000))
      .toMatchObject({ fragmentsReceived: 0, charsReceived: 0, elapsedMs: 2_000 });
  });
});
