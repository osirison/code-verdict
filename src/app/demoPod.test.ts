import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoPod, DEMO_POD_ID } from './demoPod';
import { PodStore } from './pods';
import { registerBuiltInProviders } from '../registry';
import { connectionForPod } from './connections';
import { fetchPodData, repoIdsOf } from './podQuery';
import type { KeyValueStore, SecretStore } from './storage';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string) => values.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      values.set(key, value);
    },
  };
}

/** The demo pod has no token — the secret store is deliberately empty. */
const noSecrets: SecretStore = {
  get: async () => undefined,
  store: async () => {},
};

describe('demo pod (spec §1 "Skip and use a demo pod")', () => {
  beforeEach(() => {
    registerBuiltInProviders();
  });

  it('creates an active pod on the fixture provider with resolved project ids', async () => {
    const podStore = new PodStore(memoryStore());

    const pod = await createDemoPod(podStore);

    expect(pod.id).toBe(DEMO_POD_ID);
    expect(pod.providerId).toBe('fixture');
    expect(podStore.activePod?.id).toBe(DEMO_POD_ID);
    // Explicit ids, never "all" — the same rule onboarding step 3 follows.
    const [source] = pod.sources;
    expect(source?.kind).toBe('group');
    expect(source && 'repoIds' in source ? source.repoIds.length : 0).toBeGreaterThan(0);
    expect(repoIdsOf(pod)).toEqual(pod.repos?.map((repo) => repo.id));
  });

  it('answers a full pod query with no token in the secret store', async () => {
    const podStore = new PodStore(memoryStore());
    const pod = await createDemoPod(podStore);

    const data = await fetchPodData(await connectionForPod(pod, noSecrets), pod, Date.parse('2026-08-07T12:00:00Z'));

    // The point of the escape hatch: a populated dashboard before any token.
    expect(data.changeRequests.length).toBeGreaterThan(0);
  });

  it('is idempotent — skipping twice does not fork a second demo pod', async () => {
    const podStore = new PodStore(memoryStore());

    await createDemoPod(podStore);
    await createDemoPod(podStore);

    expect(podStore.list().filter((pod) => pod.id === DEMO_POD_ID)).toHaveLength(1);
  });
});
