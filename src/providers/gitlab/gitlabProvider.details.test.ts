/**
 * Focused detail-retrieval tests for the GitLab provider.
 *
 * This file used to cover the five revision-pinned investigation operations as
 * well: Compare-API `too_large`/`compare_timeout` mapping, `readDiff`,
 * `searchDiff`, `searchRepository`, and the notFound-versus-unavailable
 * revision disambiguation. All five are gone from every provider — anything
 * computable from two commits is computed from a local object store — and so
 * are the cases that described them. GitLab could pin a repository search with
 * `ref` where GitHub could not, and it lost the operation all the same: the
 * point was never which forge is better at it, but that a second route to a
 * diff is how the fallback comes back.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../../platform/types';
import { loadSpecFixtures } from '../../testing/specFixtures';
import { createGitLabProvider } from './gitlabProvider';
import { makeFakeGitLabFetch } from './fakeGitLab';
import { toNormalizedDetail } from './mappers';
import type { GlMergeRequest } from './mappers';

const CONFIG = { instanceUrl: 'https://gitlab.example', credential: { kind: 'token' as const, token: 'glpat-test' } };
const REPO_ID = '9101';

const fixtures = loadSpecFixtures();
const diffRefs = (fixtures.gitlabMergeRequest as { diff_refs: { base_sha: string; head_sha: string } }).diff_refs;

function snapshot(headSha = diffRefs.head_sha, baseSha = diffRefs.base_sha) {
  return { repoId: REPO_ID, baseSha, headSha };
}

function connect(opts: Parameters<typeof makeFakeGitLabFetch>[0] = {}) {
  return createGitLabProvider(makeFakeGitLabFetch(opts)).connect(CONFIG);
}

describe('gitlab provider detail retrieval', () => {
  it('declares the two detail operations it can answer, and declares no investigation operations at all', () => {
    const capabilities = createGitLabProvider().capabilities;
    expect(capabilities.detailRetrieval?.changeRequestDetails.supported).toBe(true);
    expect(capabilities.detailRetrieval?.issueDetails.supported).toBe(true);
    expect(Object.keys(capabilities.detailRetrieval ?? {}).sort()).toEqual(['changeRequestDetails', 'issueDetails', 'pagination']);
    expect('reviewInvestigation' in capabilities).toBe(false);
  });

  it('defines none of the five revision-pinned operations on its connection', () => {
    const conn = connect() as unknown as Record<string, unknown>;
    for (const operation of ['listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff']) {
      expect(conn[operation], `${operation} must not come back onto a connection`).toBeUndefined();
    }
  });

  it('getChangeRequestDetails normalizes the MR without leaking GitLab payload shapes', async () => {
    const conn = connect();
    const result = await conn.getChangeRequestDetails!({ snapshot: snapshot(), number: '2841' });
    expect(result.state).toBe('complete');
    const value = investigationResultValue(result);
    expect(value?.title).toBe('Refactor token refresh');
    // The `gitlabMergeRequest` fixture carries no `description`, so no `Part-of:` relationship can be derived — asserts the mapper doesn't fabricate one.
    expect(value?.relationships).toEqual([]);
    expect(value?.checkSummaries[0]?.status).toBe('success');
  });

  it('getIssueDetails normalizes the linked issue and marks commit/check sections unavailable', async () => {
    const conn = connect();
    const result = await conn.getIssueDetails!({ snapshot: snapshot(), issueRepoId: REPO_ID, issueNumber: '1180' });
    expect(result.state).toBe('complete');
    const value = investigationResultValue(result);
    expect(value?.title).toBe('Support refresh envelope');
    expect(value?.unavailableSections).toEqual(expect.arrayContaining(['commits', 'checkSummaries', 'relationships']));
  });

  it('toNormalizedDetail derives the neutral Part-of: relationship from the MR description', () => {
    const mr: GlMergeRequest = {
      iid: 1, project_id: 9101, title: 't', description: 'Part-of: #99\n\nmore text', state: 'opened',
      source_branch: 'a', target_branch: 'main', author: { username: 'you' }, web_url: 'x', updated_at: 'x', sha: 'x',
    };
    const detail = toNormalizedDetail(mr, [], []);
    expect(detail.relationships).toEqual([{ kind: 'partOf', ref: '99' }]);
  });

  it('getCurrentHead resolves the live head SHA for the pre-completion drift check', async () => {
    const conn = connect();
    const result = await conn.getCurrentHead!({ repoId: REPO_ID, number: '2841' });
    expect(result).toEqual({ repoId: REPO_ID, state: 'resolved', headSha: diffRefs.head_sha });
  });

  it('surfaces a rate-limited detail read as the neutral retryable error, not a returned state', async () => {
    const conn = connect({ investigationRateLimited: true });
    await expect(conn.getChangeRequestDetails!({ snapshot: snapshot(), number: '2841' })).rejects.toMatchObject({ kind: 'rateLimited' });
  });

  it('composes the object-source descriptor with the branch the merge request targets, which is what the merge base is computed against', async () => {
    const conn = connect();
    const result = await conn.getObjectSource!({ repoId: REPO_ID, number: '2841' });
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.descriptor.mergeTargetRef).toBe('refs/heads/main');
    expect(result.descriptor.refHint).toBe('refs/merge-requests/2841/head');
  });
});
