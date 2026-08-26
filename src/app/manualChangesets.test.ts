import { describe, expect, it } from 'vitest';
import { ManualChangesetStore } from './manualChangesets';
import type { KeyValueStore } from './storage';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

describe('ManualChangesetStore', () => {
  it('stores records per pod with manual-prefixed ids', async () => {
    const store = new ManualChangesetStore(memoryStore());
    const record = await store.add('pod-a', 'Hand-picked pair', [
      { repoId: '9101', number: '2841' },
      { repoId: '9103', number: '381' },
    ]);

    expect(record.id).toMatch(/^manual:/);
    expect(store.list('pod-a')).toEqual([record]);
    expect(store.list('pod-b')).toEqual([]);
  });

  it('removes only the named record from the named pod', async () => {
    const backing = memoryStore();
    const store = new ManualChangesetStore(backing);
    const first = await store.add('pod-a', 'First', [{ repoId: '1', number: '1' }, { repoId: '2', number: '2' }]);
    const second = await store.add('pod-a', 'Second', [{ repoId: '3', number: '3' }, { repoId: '4', number: '4' }]);
    const other = await store.add('pod-b', 'Other pod', [{ repoId: '5', number: '5' }, { repoId: '6', number: '6' }]);

    await store.remove('pod-a', first.id);

    expect(store.list('pod-a')).toEqual([second]);
    expect(store.list('pod-b')).toEqual([other]);
  });

  it('drops a deleted pod’s whole bucket without disturbing the others', async () => {
    const backing = memoryStore();
    const store = new ManualChangesetStore(backing);
    await store.add('pod-a', 'First', [{ repoId: '1', number: '1' }, { repoId: '2', number: '2' }]);
    await store.add('pod-a', 'Second', [{ repoId: '3', number: '3' }, { repoId: '4', number: '4' }]);
    const other = await store.add('pod-b', 'Other pod', [{ repoId: '5', number: '5' }, { repoId: '6', number: '6' }]);

    await store.removePod('pod-a');

    expect(store.list('pod-a')).toEqual([]);
    expect(store.list('pod-b')).toEqual([other]);
    // The key is gone, not left holding an empty array — a deleted pod should
    // leave nothing behind in globalState.
    expect(backing.get<Record<string, unknown>>('codeVerdict.manualChangesets')).not.toHaveProperty('pod-a');
  });

  it('is a no-op for a pod that never had any', async () => {
    const backing = memoryStore();
    const store = new ManualChangesetStore(backing);
    const other = await store.add('pod-b', 'Other pod', [{ repoId: '5', number: '5' }, { repoId: '6', number: '6' }]);

    await store.removePod('pod-a');

    expect(store.list('pod-b')).toEqual([other]);
  });
});
