import { describe, expect, it } from 'vitest';
import type { KeyValueStore } from './storage';
import { ReviewRunStore } from './reviewRuns';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

const run = (over: Partial<Parameters<ReviewRunStore['record']>[0]> = {}) => ({
  repoId: '9101',
  crNumber: '2841',
  outcome: 'findings' as const,
  findingCount: 3,
  agentLabel: 'Copilot',
  ranAt: '2026-08-25T10:00:00.000Z',
  ...over,
});

describe('review-run store', () => {
  it('records a clean run — the outcome that used to be written nowhere at all', async () => {
    const store = new ReviewRunStore(memoryStore());
    await store.record(run({ outcome: 'clean', findingCount: 0 }));

    expect(store.list()).toEqual([
      { repoId: '9101', crNumber: '2841', outcome: 'clean', findingCount: 0, agentLabel: 'Copilot', ranAt: '2026-08-25T10:00:00.000Z' },
    ]);
  });

  it('keeps the latest run per change request, not a growing log', async () => {
    const store = new ReviewRunStore(memoryStore());
    await store.record(run({ outcome: 'findings', findingCount: 3, ranAt: '2026-08-25T10:00:00.000Z' }));
    await store.record(run({ outcome: 'clean', findingCount: 0, ranAt: '2026-08-25T11:00:00.000Z' }));

    expect(store.list()).toHaveLength(1);
    expect(store.list()[0]?.outcome).toBe('clean');
    expect(store.list()[0]?.ranAt).toBe('2026-08-25T11:00:00.000Z');
  });

  it('keys runs per repository, so the same number in two repositories does not collide', async () => {
    const store = new ReviewRunStore(memoryStore());
    await store.record(run({ repoId: '9101', outcome: 'clean', findingCount: 0 }));
    await store.record(run({ repoId: '4477', outcome: 'findings', findingCount: 2 }));

    const byRef = store.byRef();
    expect(byRef.get('9101!2841')?.outcome).toBe('clean');
    expect(byRef.get('4477!2841')?.findingCount).toBe(2);
  });

  // Review comment on PR #47 claimed `record` can lose a run: two concurrent
  // calls read the same array, both append, the second write wins. It cannot
  // happen — `list()` and `store.update()` sit in one synchronous block with
  // no await between them, so nothing can run in between — but the claim
  // deserves the scenario it named, run rather than argued.
  it('keeps both runs when two records for different change requests overlap', async () => {
    const store = new ReviewRunStore(memoryStore());

    // Deliberately not awaited in turn: both calls are in flight together,
    // which is exactly the interleaving the finding described.
    await Promise.all([
      store.record(run({ crNumber: '2841', findingCount: 3 })),
      store.record(run({ crNumber: '2999', findingCount: 1 })),
    ]);

    expect(store.list()).toHaveLength(2);
    expect(store.byRef().get('9101!2841')?.findingCount).toBe(3);
    expect(store.byRef().get('9101!2999')?.findingCount).toBe(1);
  });

  it('reads an empty store without throwing, and never hands out its own array', async () => {
    const backing = memoryStore();
    const store = new ReviewRunStore(backing);
    expect(store.list()).toEqual([]);

    await store.record(run());
    store.list().push(run({ crNumber: '9999' }));
    expect(store.list()).toHaveLength(1);
  });
});
