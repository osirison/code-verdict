/**
 * "Skip and use a demo pod" (spec §1): a pod backed by the fixture provider,
 * so the product is explorable — dashboard, review, triage, submit — before
 * anyone has a GitLab token to give it.
 *
 * It is a real pod, not a mode: everything downstream goes through the same
 * platform layer and never learns which provider answered.
 */
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { getProvider } from '../platform/registry';
import type { PodStore } from './pods';

export const DEMO_POD_ID = 'codeVerdict.demoPod';
const DEMO_INSTANCE_URL = 'fixture://demo';
/** The fixture provider's one group — its repositories are the demo pod. */
const DEMO_GROUP_ID = '4821';

export async function createDemoPod(podStore: PodStore): Promise<Pod> {
  const provider = getProvider('fixture');
  const connection = provider.connect({ instanceUrl: DEMO_INSTANCE_URL, token: 'demo' });
  const status = await connection.testConnection();
  // Resolve the demo group through the platform layer rather than hardcoding
  // repository ids here — the fixture data can grow without this file knowing,
  // and the resolved ids are stored explicitly, never "all".
  const resolved = await connection.resolveSource(`group ${DEMO_GROUP_ID}`);
  const repositories = resolved.kind === 'group' ? resolved.repositories : [];
  const pod: Pod = {
    id: DEMO_POD_ID,
    name: 'Demo pod',
    providerId: 'fixture',
    instanceUrl: DEMO_INSTANCE_URL,
    sources: [{ kind: 'group', groupId: DEMO_GROUP_ID, repoIds: repositories.map((repo) => repo.id) }],
    criteria: { ...DEFAULT_CRITERIA, categories: [...DEFAULT_CRITERIA.categories] },
    agentId: '',
    repos: repositories.map((repo) => ({ id: repo.id, path: repo.path, name: repo.name })),
    username: status.username ?? 'you',
  };
  await podStore.upsert(pod);
  await podStore.setActive(pod.id);
  return pod;
}
