/**
 * Pod persistence (handoff §3): pods and the active-pod pointer live in
 * `globalState`; the token never lives here (see storage.ts).
 */
import type { Pod } from '../domain/types';
import type { KeyValueStore } from './storage';

const PODS_KEY = 'codeVerdict.pods';
const ACTIVE_KEY = 'codeVerdict.activePodId';

export class PodStore {
  constructor(private readonly store: KeyValueStore) {}

  list(): Pod[] {
    // Copy: Memento may hand back its cached array, and callers must not
    // mutate shared state behind its back.
    return [...(this.store.get<Pod[]>(PODS_KEY) ?? [])];
  }

  get(id: string): Pod | undefined {
    return this.list().find((p) => p.id === id);
  }

  get activePod(): Pod | undefined {
    const id = this.store.get<string>(ACTIVE_KEY);
    const pods = this.list();
    return pods.find((p) => p.id === id) ?? pods[0];
  }

  findByInstance(providerId: string, instanceUrl: string): Pod | undefined {
    return this.list().find((p) => p.providerId === providerId && p.instanceUrl === instanceUrl);
  }

  async upsert(pod: Pod): Promise<void> {
    const pods = this.list();
    const index = pods.findIndex((p) => p.id === pod.id);
    const next = index >= 0 ? pods.map((p) => (p.id === pod.id ? pod : p)) : [...pods, pod];
    await this.store.update(PODS_KEY, next);
  }

  /**
   * Delete a pod and leave the active pointer valid. The caller owns the
   * state that hangs off the pod (its token, its manual changesets) — this
   * knows only about the two keys it writes.
   */
  async remove(id: string): Promise<void> {
    const pods = this.list();
    const next = pods.filter((p) => p.id !== id);
    // Unknown id: no write at all, so a stale sidebar row firing twice cannot
    // disturb the active pointer.
    if (next.length === pods.length) return;
    await this.store.update(PODS_KEY, next);
    // One condition covers three cases: the removed pod was the active one,
    // it was the last one (`next[0]?.id` is undefined, which clears the key),
    // and the pointer was already dangling. `activePod` falls back to pods[0]
    // regardless, but a stale id left in globalState outlives that fallback —
    // re-create a pod with the same id and it silently becomes active.
    const active = this.store.get<string>(ACTIVE_KEY);
    if (!next.some((p) => p.id === active)) await this.store.update(ACTIVE_KEY, next[0]?.id);
  }

  async setActive(id: string): Promise<void> {
    await this.store.update(ACTIVE_KEY, id);
  }
}
