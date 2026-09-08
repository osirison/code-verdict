/**
 * Focused detail-retrieval tests for the GitHub provider.
 *
 * This file used to cover the five revision-pinned investigation operations as
 * well: Compare-API binary-versus-tooLarge classification, `readDiff`,
 * `searchDiff`, the 300-file Compare cap, and the notFound-versus-unavailable
 * revision disambiguation. All five operations are gone from every provider —
 * anything computable from two commits is computed from a local object store —
 * and so are the cases that described them. What is left is what this
 * connection is still asked for: a pull request's normalized detail, a linked
 * issue's, the live head for the drift check, and rate-limit propagation in its
 * reset-header form.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../../platform/types';
import { createGitHubProvider } from './githubProvider';
import { makeFakeGitHubFetch } from './fakeGitHub';
import { toNormalizedDetail } from './mappers';
import type { GhPull } from './mappers';

const CONFIG = { instanceUrl: 'https://github.com', credential: { kind: 'token' as const, token: 'ghp-test' } };
const REPO_ID = 'acme/core';
const BASE_SHA = '7c1de9a0b2f3c4d5e6f708192a3b4c5d6e7f8091';
const HEAD_SHA = '9f2c1ab4e5d6708192a3b4c5d6e7f8091a2b3c4d';

function snapshot(headSha = HEAD_SHA, baseSha = BASE_SHA) {
  return { repoId: REPO_ID, baseSha, headSha };
}

function connect(opts: Parameters<typeof makeFakeGitHubFetch>[0] = {}) {
  return createGitHubProvider(makeFakeGitHubFetch(opts)).connect(CONFIG);
}

describe('github provider detail retrieval', () => {
  it('declares the two detail operations it can answer, and declares no investigation operations at all', () => {
    const capabilities = createGitHubProvider().capabilities;
    expect(capabilities.detailRetrieval?.changeRequestDetails.supported).toBe(true);
    expect(capabilities.detailRetrieval?.issueDetails.supported).toBe(true);
    // The declaration has no room left for the five: they are not this
    // provider's to answer, and the type no longer has fields for them.
    expect(Object.keys(capabilities.detailRetrieval ?? {}).sort()).toEqual(['changeRequestDetails', 'issueDetails', 'pagination']);
    expect('reviewInvestigation' in capabilities).toBe(false);
  });

  it('defines none of the five revision-pinned operations on its connection', () => {
    const conn = connect() as unknown as Record<string, unknown>;
    for (const operation of ['listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff']) {
      expect(conn[operation], `${operation} must not come back onto a connection`).toBeUndefined();
    }
  });

  it('getChangeRequestDetails normalizes the pull request without leaking GitHub payload shapes', async () => {
    const conn = connect();
    const result = await conn.getChangeRequestDetails!({ snapshot: snapshot(), number: '2841' });
    expect(result.state).toBe('complete');
    const value = investigationResultValue(result);
    expect(value?.title).toBe('Add per-tenant rate limiting');
    expect(value?.labels).toEqual(['rate-limiting']);
    expect(value?.commits[0]).toMatchObject({ sha: HEAD_SHA, author: 'dana' });
    expect(value?.checkSummaries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'ci', status: 'success', summary: expect.stringContaining('tests passed') }),
        expect.objectContaining({ name: 'license/cla', status: 'success' }),
      ]),
    );
    // The fixture's own body ("Changeset: rate-limiting") carries no `Part-of:` trailer — asserts the mapper doesn't fabricate one.
    expect(value?.relationships).toEqual([]);
  });

  it('getIssueDetails normalizes the linked issue and marks commit/check/relationship sections unavailable', async () => {
    const conn = connect();
    const result = await conn.getIssueDetails!({ snapshot: snapshot(), issueRepoId: REPO_ID, issueNumber: '1180' });
    expect(result.state).toBe('complete');
    const value = investigationResultValue(result);
    expect(value?.title).toBe('Tenants can exhaust the shared bucket');
    expect(value?.discussion[0]?.body).toContain('retry envelope');
    expect(value?.unavailableSections).toEqual(expect.arrayContaining(['commits', 'checkSummaries', 'relationships']));
  });

  it('toNormalizedDetail derives the neutral Part-of: relationship from the pull request body', () => {
    const pull: GhPull = {
      number: 1, title: 't', body: 'Part-of: #99\n\nmore text', state: 'open',
      head: { ref: 'a', sha: 'x' }, base: { ref: 'main', sha: 'y' }, user: { login: 'you' },
      html_url: 'x', updated_at: 'x',
    };
    const detail = toNormalizedDetail(pull, [], [], []);
    expect(detail.relationships).toEqual([{ kind: 'partOf', ref: '99' }]);
  });

  it('getCurrentHead resolves the live head SHA for the pre-completion drift check', async () => {
    const conn = connect();
    const result = await conn.getCurrentHead!({ repoId: REPO_ID, number: '2841' });
    expect(result).toEqual({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA });
  });

  it('surfaces a rate-limited detail read (reset-header form) as the neutral retryable error, not a returned state', async () => {
    const conn = connect({ investigationRateLimited: true });
    await expect(conn.getChangeRequestDetails!({ snapshot: snapshot(), number: '2841' })).rejects.toMatchObject({ kind: 'rateLimited' });
  });

  it('composes the object-source descriptor with the branch the pull request targets, which is what the merge base is computed against', async () => {
    const conn = connect();
    const result = await conn.getObjectSource!({ repoId: REPO_ID, number: '2841' });
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    // `refs/heads/…`, composed here because "which branch does this change
    // request target" is a fact about the change request and lives in no
    // repository — the one thing about the merge base the forge is still asked.
    expect(result.descriptor.mergeTargetRef).toBe('refs/heads/main');
    expect(result.descriptor.refHint).toBe('refs/pull/2841/head');
  });
});
