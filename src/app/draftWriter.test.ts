/**
 * The coalescing writer on its own: the window, the flush, the generation
 * guard and the keyed cancel. The panel-level behaviour (what gets scheduled,
 * when the flush points fire) lives in `src/ui/reviewFlow.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CoalescedDraftWriter, DRAFT_WRITE_WINDOW_MS } from './draftWriter';
import { retainedFromRun, type RetainedRecord } from './retainedReview';
import type { KeyValueStore } from './storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Review } from '../domain/types';

function review(summary: string): Review {
  return {
    repoId: 'repo-1',
    crNumber: '7',
    agentId: 'agent:builtin',
    criteria: DEFAULT_CRITERIA,
    headSha: 'aaaa',
    items: [],
    verdicts: {},
    summary,
  };
}

function record(summaryText: string, ranAt?: string): RetainedRecord {
  const base = retainedFromRun({
    review: review('r'),
    ranAt: ranAt ?? '2026-09-01T10:14:00.000Z',
    agentId: 'agent:builtin',
    agentLabel: 'Default review',
  });
  return { ...base, ranAt, summaryText };
}

function memoryStore(): KeyValueStore & { updates: number } {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update(key, value) {
      this.updates += 1;
      map.set(key, value);
      return Promise.resolve();
    },
    updates: 0,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CoalescedDraftWriter', () => {
  it('collapses consecutive schedules for one key into one update carrying the last record', async () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);

    writer.schedule('k', record('one', undefined), undefined);
    writer.schedule('k', record('two', undefined), undefined);
    writer.schedule('k', record('three', undefined), undefined);
    expect(store.updates).toBe(0);

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    expect(store.updates).toBe(1);
    expect(store.get<RetainedRecord>('k')?.summaryText).toBe('three');
  });

  it('flush() lands the pending write synchronously enough for a same-tick read-back', () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);

    writer.schedule('k', record('now', undefined), undefined);
    void writer.flush();

    // No timers advanced, no promises awaited: the get/update pair inside
    // flush is synchronous, which is what lets a panel flush-then-read.
    expect(store.get<RetainedRecord>('k')?.summaryText).toBe('now');
  });

  it('flush() with nothing pending writes nothing', async () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);
    await writer.flush();
    expect(store.updates).toBe(0);
  });

  it('drops the write when the stored ranAt is no longer the one the write was made against', async () => {
    const store = memoryStore();
    await store.update('k', record('theirs', '2026-09-02T08:00:00.000Z'));
    store.updates = 0;
    const writer = new CoalescedDraftWriter(store);

    // Scheduled against the generation this panel loaded (an older ranAt).
    writer.schedule('k', record('mine', '2026-09-01T10:14:00.000Z'), '2026-09-01T10:14:00.000Z');
    await writer.flush();

    expect(store.updates).toBe(0);
    expect(store.get<RetainedRecord>('k')?.summaryText).toBe('theirs');
  });

  it('writes when the stored ranAt still matches, including the pre-change undefined', async () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);

    // A legacy record never carried ranAt; undefined-to-undefined matches.
    writer.schedule('k', record('legacy', undefined), undefined);
    await writer.flush();
    expect(store.get<RetainedRecord>('k')?.summaryText).toBe('legacy');
  });

  it('cancelFor drops only the pending write for that key', async () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);

    writer.schedule('a', record('a1', undefined), undefined);
    writer.cancelFor('b');
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);
    expect(store.get<RetainedRecord>('a')?.summaryText).toBe('a1');

    store.updates = 0;
    writer.schedule('a', record('a2', undefined), 'mismatched-on-purpose');
    writer.cancelFor('a');
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);
    // Cancelled before the window fired: not even a guarded attempt was made.
    expect(store.updates).toBe(0);
    expect(store.get<RetainedRecord>('a')?.summaryText).toBe('a1');
  });

  it('a schedule for a different key lands the previous key\'s pending write first', async () => {
    const store = memoryStore();
    const writer = new CoalescedDraftWriter(store);

    writer.schedule('a', record('a-final', undefined), undefined);
    // Navigating to another target inside the window must not drop a's triage.
    writer.schedule('b', record('b-final', undefined), undefined);
    expect(store.get<RetainedRecord>('a')?.summaryText).toBe('a-final');

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);
    expect(store.get<RetainedRecord>('b')?.summaryText).toBe('b-final');
    expect(store.updates).toBe(2);
  });
});
