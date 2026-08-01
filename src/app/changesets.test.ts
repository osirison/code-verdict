import { describe, expect, it } from 'vitest';
import type { Pod } from '../domain/types';
import type { ChangeRequest } from '../platform/types';
import { detectChangesets } from './changesets';

const pod: Pod = {
  id: 'pod',
  name: 'Platform squad',
  providerId: 'gitlab',
  instanceUrl: 'https://gitlab.example',
  sources: [],
  criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions: '' },
  agentId: '',
  repos: [
    { id: '9101', name: 'core', path: 'hve/platform/core' },
    { id: '9102', name: 'auth-service', path: 'hve/platform/auth-service' },
    { id: '9103', name: 'api-gateway', path: 'hve/platform/api-gateway' },
    { id: '9210', name: 'console', path: 'hve/web/console' },
  ],
};

const CHANGE_REQUESTS: ChangeRequest[] = [
  ['9101', '2841', 'Refactor token refresh'],
  ['9102', '812', 'Rotate signing keys on schedule'],
  ['9103', '381', 'Propagate rotated key ids'],
  ['9210', '1509', 'Show key expiry banner'],
].map(([repoId, number, title]) => ({
  ref: { repoId: repoId as string, number: number as string },
  title: title as string,
  description: 'Part-of: #1180\n\nShips key rotation.',
  state: 'open',
  sourceBranch: 'feat/key-rotation',
  targetBranch: 'main',
  author: { username: 'kai' },
  reviewers: [],
  webUrl: `https://gitlab.example/${repoId}/-/merge_requests/${number}`,
  updatedAt: '2026-07-30T00:00:00.000Z',
  headSha: `head-${repoId}-${number}`,
  ci: { runId: `pipeline-${number}`, status: 'success' },
}));

describe('changeset detection', () => {
  it('groups shared Part-of trailers and names the group from its issue', () => {
    const [changeset] = detectChangesets(pod, CHANGE_REQUESTS, [{
      id: '1180', repoId: '9101', number: '1180', title: 'Key rotation, end to end', state: 'open',
      updatedAt: '2026-07-30T00:00:00.000Z', webUrl: 'https://gitlab.example/issues/1180',
    }]);

    expect(changeset?.name).toBe('Key rotation, end to end');
    expect(changeset?.linkedIssue).toBe('#1180');
    expect(changeset?.members).toHaveLength(4);
    expect(changeset?.members.map((member) => member.projectPath)).toContain('hve/web/console');
  });

  it('does not promote a trailer used by only one merge request', () => {
    expect(detectChangesets(pod, CHANGE_REQUESTS.slice(0, 1), [])).toEqual([]);
  });
});