import { describe, expect, it } from 'vitest';
import { getProvider } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { deriveStats, fetchPodData, repoIdsOf } from './podQuery';

const pod: Pod = {
  id: 'pod_test',
  name: 'Platform squad',
  providerId: 'fixture',
  instanceUrl: 'https://gitlab.example',
  sources: [
    { kind: 'group', groupId: '4821', repoIds: ['9101', '9102', '9103', '9104', '9105'] },
    { kind: 'repository', repoId: '9210' },
  ],
  criteria: DEFAULT_CRITERIA,
  agentId: '',
  username: 'you',
};

describe('pod query', () => {
  it('derives every dashboard number from one batched query', async () => {
    registerBuiltInProviders();
    const connection = getProvider('fixture').connect({ instanceUrl: 'x', credential: { kind: 'token', token: 'demo'  } });
    const data = await fetchPodData(connection, pod, 1_000);

    expect(repoIdsOf(pod)).toHaveLength(6);
    expect(data.changeRequests.length).toBeGreaterThan(0);
    expect(data.fetchedAt).toBe(1_000);

    const stats = deriveStats(data);
    expect(stats.projectsInPod).toBe(6);
    // Fixture data: !812, !1509 and !385 name you as reviewer and are
    // authored by others; !2841 is yours.
    expect(stats.waitingOnYou).toBe(3);
    // !381 and !804 have failed pipelines.
    expect(stats.pipelinesFailing).toBe(2);
    expect(stats.aiCoverage).toEqual({ reviewed: 0, total: data.changeRequests.length });
  });

  it('deduplicates repo ids across sources', () => {
    const overlapping: Pod = {
      ...pod,
      sources: [
        { kind: 'group', groupId: '4821', repoIds: ['9101', '9102'] },
        { kind: 'repository', repoId: '9101' },
      ],
    };
    expect(repoIdsOf(overlapping)).toEqual(['9101', '9102']);
  });
});
