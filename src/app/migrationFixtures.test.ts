import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './storage';
import { ReviewRunStore } from './reviewRuns';
import { InFlightRunStore } from './reviewRunManager';
import { readRetained, screenForRetained } from './retainedReview';
import {
  LEGACY_CHANGESET_DRAFT,
  LEGACY_IN_FLIGHT_RUN,
  LEGACY_RETAINED_CLEAN,
  LEGACY_RETAINED_PRE_RESULT_FIELDS,
  LEGACY_RETAINED_SUBMITTED,
  LEGACY_RETAINED_TRIAGE_DRAFT,
  LEGACY_RUN_HISTORY,
} from './migrationFixtures';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

describe('legacy migration fixtures (task 1.4) read back under today\'s code', () => {
  it('round-trips the run-history fixture through ReviewRunStore', async () => {
    const store = new ReviewRunStore(memoryStore());
    for (const run of LEGACY_RUN_HISTORY) await store.record(run);

    expect(store.list()).toEqual(LEGACY_RUN_HISTORY);
    expect(store.byRef().get('repo-1!2843')?.outcome).toBe('interrupted');
  });

  it('round-trips the in-flight fixture through InFlightRunStore', async () => {
    const store = new InFlightRunStore(memoryStore());
    await store.add(LEGACY_IN_FLIGHT_RUN);

    expect(store.list()).toEqual([LEGACY_IN_FLIGHT_RUN]);
  });

  it('reads an unsubmitted triage draft as findings awaiting triage', () => {
    const retained = readRetained(LEGACY_RETAINED_TRIAGE_DRAFT);
    expect(retained?.outcome).toBe('findings');
    expect(screenForRetained(retained!)).toBe('triage');
    expect(retained?.draft.failedKeys).toEqual(['i0']);
  });

  it('reads a submitted draft as done', () => {
    const retained = readRetained(LEGACY_RETAINED_SUBMITTED);
    expect(retained?.submittedAt).toBe('2026-07-28T10:00:00.000Z');
    expect(screenForRetained(retained!)).toBe('done');
  });

  it('reads a clean run as clean, with its filtered candidates intact', () => {
    const retained = readRetained(LEGACY_RETAINED_CLEAN);
    expect(retained?.outcome).toBe('clean');
    expect(screenForRetained(retained!)).toBe('clean');
    expect(retained?.draft.review.items).toEqual([]);
  });

  it('falls back to the review\'s own agent and model for a pre-result-fields record', () => {
    const retained = readRetained(LEGACY_RETAINED_PRE_RESULT_FIELDS);
    // No stored `outcome` at all — the fallback in `readRetained`, not a stored value.
    expect(retained?.outcome).toBe('findings');
    expect(retained?.agentId).toBe('builtin-default');
    expect(retained?.modelId).toBe('lm:acme/turbo');
  });

  it('reads a legacy changeset draft with its submit ledger intact', () => {
    const retained = readRetained(LEGACY_CHANGESET_DRAFT);
    expect(retained?.draft.submitState?.postedCommentKeys).toEqual(['i0']);
    expect(retained?.draft.review.repoId).toBe('changeset');
  });
});
