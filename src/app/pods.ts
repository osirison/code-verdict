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

  async setActive(id: string): Promise<void> {
    await this.store.update(ACTIVE_KEY, id);
  }
}
