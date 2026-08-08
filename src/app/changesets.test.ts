import { describe, expect, it } from 'vitest';
import type { Pod } from '../domain/types';
import type { ChangeRequest } from '../platform/types';
import { detectChangesets } from './changesets';
import { deriveMergeOrder } from './mergeOrder';

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

describe('changeset detection — trailer route', () => {
  it('groups shared Part-of trailers and names the group from its issue', () => {
    const [changeset] = detectChangesets(pod, CHANGE_REQUESTS, [{
      id: '1180', repoId: '9101', number: '1180', title: 'Key rotation, end to end', state: 'open',
      updatedAt: '2026-07-30T00:00:00.000Z', webUrl: 'https://gitlab.example/issues/1180',
    }]);

    expect(changeset?.name).toBe('Key rotation, end to end');
    expect(changeset?.linkedIssue).toBe('#1180');
    expect(changeset?.detection).toBe('trailer');
    expect(changeset?.members).toHaveLength(4);
    expect(changeset?.members.map((member) => member.projectPath)).toContain('hve/web/console');
  });

  it('does not promote a trailer used by only one merge request', () => {
    expect(detectChangesets(pod, CHANGE_REQUESTS.slice(0, 1), [])).toEqual([]);
  });

  it('counts a merge request once when its description repeats the same trailer', () => {
    const repeated = CHANGE_REQUESTS.map((changeRequest, index) => index === 0
      ? { ...changeRequest, description: 'Part-of: #1180\nPart-of: #1180' }
      : changeRequest);

    expect(detectChangesets(pod, repeated, [])[0]?.members).toHaveLength(4);
  });

  it('honours a configured trailer, with or without its colon, and escapes regex metacharacters', () => {
    const dependsOn = CHANGE_REQUESTS.map((changeRequest) => ({
      ...changeRequest,
      description: 'Depends-On: #77\n\nBody.',
    }));

    expect(detectChangesets(pod, dependsOn, [], { trailer: 'Depends-On' })[0]?.id).toBe('trailer:77');
    expect(detectChangesets(pod, dependsOn, [], { trailer: 'Depends-On:' })[0]?.detectionDetail)
      .toBe('Depends-On: #77 in every description');
    // The default trailer no longer matches these descriptions.
    expect(detectChangesets(pod, dependsOn, [], { branchFallback: false })).toEqual([]);
    // A metacharacter in the setting must not blow up or over-match.
    expect(detectChangesets(pod, dependsOn, [], { trailer: 'Part.of', branchFallback: false })).toEqual([]);
  });

  it('prefers a work item living in a member repository when issue numbers collide', () => {
    const collision = [
      {
        id: 'other', repoId: '9999', number: '1180', title: 'Unrelated issue elsewhere', state: 'open' as const,
        updatedAt: '2026-07-30T00:00:00.000Z', webUrl: 'https://gitlab.example/other/issues/1180',
      },
      {
        id: '1180', repoId: '9102', number: '1180', title: 'Key rotation, end to end', state: 'open' as const,
        updatedAt: '2026-07-30T00:00:00.000Z', webUrl: 'https://gitlab.example/issues/1180',
      },
    ];

    expect(detectChangesets(pod, CHANGE_REQUESTS, collision)[0]?.name).toBe('Key rotation, end to end');
  });
});

describe('changeset detection — branch route', () => {
  const noTrailer = CHANGE_REQUESTS.map((changeRequest) => ({
    ...changeRequest,
    description: 'No trailer here.',
  }));

  it('groups a shared source branch across projects when no trailer claims the members', () => {
    const [changeset] = detectChangesets(pod, noTrailer, []);

    expect(changeset?.id).toBe('branch:feat/key-rotation');
    expect(changeset?.detection).toBe('branch');
    expect(changeset?.detectionDetail).toBe('shared branch name feat/key-rotation');
    expect(changeset?.linkedIssue).toBeUndefined();
    expect(changeset?.name).toBe('Refactor token refresh');
    expect(changeset?.members).toHaveLength(4);
  });

  it('leaves trailer-claimed members out of branch groups', () => {
    // All four share a branch AND a trailer — order of preference says the
    // trailer group wins and no duplicate branch group appears.
    const changesets = detectChangesets(pod, CHANGE_REQUESTS, []);

    expect(changesets).toHaveLength(1);
    expect(changesets[0]?.detection).toBe('trailer');
  });

  it('ignores a branch reused inside a single repository', () => {
    const sameRepo = noTrailer.slice(0, 2).map((changeRequest) => ({
      ...changeRequest,
      ref: { repoId: '9101', number: changeRequest.ref.number },
    }));

    expect(detectChangesets(pod, sameRepo, [])).toEqual([]);
  });

  it('can be switched off', () => {
    expect(detectChangesets(pod, noTrailer, [], { branchFallback: false })).toEqual([]);
  });
});

describe('changeset detection — manual route', () => {
  const noTrailer = CHANGE_REQUESTS.map((changeRequest) => ({
    ...changeRequest,
    description: 'No trailer here.',
    sourceBranch: `own-branch-${changeRequest.ref.number}`,
  }));

  it('resolves stored members against the open change requests', () => {
    const [changeset] = detectChangesets(pod, noTrailer, [], {
      manual: [{
        id: 'manual:abc',
        name: 'Hand-picked pair',
        members: [
          { repoId: '9101', number: '2841' },
          { repoId: '9103', number: '381' },
        ],
      }],
    });

    expect(changeset?.id).toBe('manual:abc');
    expect(changeset?.detection).toBe('manual');
    expect(changeset?.detectionDetail).toBe('manual selection');
    expect(changeset?.members.map((member) => member.ref.number)).toEqual(['2841', '381']);
  });

  it('drops a manual group with fewer than two still-open members', () => {
    const changesets = detectChangesets(pod, noTrailer.slice(0, 1), [], {
      manual: [{
        id: 'manual:abc',
        name: 'Mostly merged',
        members: [
          { repoId: '9101', number: '2841' },
          { repoId: '9103', number: '381' },
        ],
      }],
    });

    expect(changesets).toEqual([]);
  });
});

describe('merge order derivation', () => {
  const members = CHANGE_REQUESTS.map((changeRequest) => ({
    ref: changeRequest.ref,
    description: changeRequest.description,
  }));

  it('places the writer side of a cross finding before its readers, with span roles as reasons', () => {
    const order = deriveMergeOrder(
      [...members].reverse(),
      [{
        cross: true,
        spans: [
          { repoId: '9103', location: 'src/routes/session.ts:88', role: 'renames the field' },
          { repoId: '9210', location: 'src/api/session.ts:41', role: 'still reads the old name' },
        ],
      }],
    );

    const gateway = order.findIndex((step) => step.member.ref.repoId === '9103');
    const consoleStep = order.findIndex((step) => step.member.ref.repoId === '9210');
    expect(gateway).toBeGreaterThanOrEqual(0);
    expect(gateway).toBeLessThan(consoleStep);
    expect(order[gateway]?.reason).toBe('renames the field');
    expect(order[consoleStep]?.reason).toBe('still reads the old name');
  });

  it('keeps detection order and description-derived reasons when nothing constrains the members', () => {
    const order = deriveMergeOrder(members, []);

    expect(order.map((step) => step.member.ref.number)).toEqual(['2841', '812', '381', '1509']);
    expect(order[0]?.reason).toBe('Ships key rotation.');
  });

  it('omits the reason entirely when there is no signal', () => {
    const order = deriveMergeOrder([{ ref: { repoId: '9101', number: '1' }, description: 'One paragraph only.' }], []);

    expect(order[0]?.reason).toBeUndefined();
  });

  it('survives contradictory findings without hiding members', () => {
    const order = deriveMergeOrder(members.slice(0, 2), [
      { cross: true, spans: [{ repoId: '9101', location: 'a:1', role: 'writes a' }, { repoId: '9102', location: 'b:1', role: 'reads a' }] },
      { cross: true, spans: [{ repoId: '9102', location: 'b:2', role: 'writes b' }, { repoId: '9101', location: 'a:2', role: 'reads b' }] },
    ]);

    expect(order).toHaveLength(2);
  });
});
