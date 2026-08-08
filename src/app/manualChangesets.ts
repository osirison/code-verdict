/**
 * Hand-built changesets (handoff §16 detection table, route `manual`):
 * "user adds MRs by URL or picks them from the pod. Always available; never
 * make detection the only path." Stored per pod in global state — a group of
 * merge requests is product data, not workspace layout.
 */
import type { KeyValueStore } from './storage';

export interface ManualChangesetRecord {
  /** Always `manual:`-prefixed so ids never collide with detected routes. */
  id: string;
  name: string;
  members: Array<{ repoId: string; number: string }>;
}

const STORE_KEY = 'codeVerdict.manualChangesets';

type StoreShape = Record<string, ManualChangesetRecord[]>;

export class ManualChangesetStore {
  constructor(private readonly store: KeyValueStore) {}

  list(podId: string): ManualChangesetRecord[] {
    return this.all()[podId] ?? [];
  }

  async add(
    podId: string,
    name: string,
    members: Array<{ repoId: string; number: string }>,
  ): Promise<ManualChangesetRecord> {
    const record: ManualChangesetRecord = {
      id: `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      name,
      members,
    };
    const all = this.all();
    await this.store.update(STORE_KEY, { ...all, [podId]: [...(all[podId] ?? []), record] });
    return record;
  }

  async remove(podId: string, id: string): Promise<void> {
    const all = this.all();
    await this.store.update(STORE_KEY, {
      ...all,
      [podId]: (all[podId] ?? []).filter((record) => record.id !== id),
    });
  }

  private all(): StoreShape {
    return this.store.get<StoreShape>(STORE_KEY) ?? {};
  }
}
