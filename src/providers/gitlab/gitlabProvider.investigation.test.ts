/**
 * Focused review-investigation tests for the GitLab provider (task 4.3/4.4).
 * `gitlab.contract.test.ts` proves the shared conformance suite passes;
 * these tests exercise GitLab-specific mapping the shared suite doesn't
 * touch directly: Compare API `too_large`/`compare_timeout`, `readDiff`,
 * `searchDiff`, `getIssueDetails`, `getCurrentHead`, the notFound-vs-
 * unavailable revision disambiguation, and rate-limit propagation.
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

describe('gitlab provider investigation operations (task 4.3/4.4)', () => {
  it('declares every review-investigation operation as honestly supported', () => {
    const caps = createGitLabProvider().capabilities.reviewInvestigation;
    expect(caps).toBeDefined();
    expect(caps?.manifests.supported).toBe(true);
    expect(caps?.diffReads.supported).toBe(true);
    expect(caps?.fileReads.supported).toBe(true);
    expect(caps?.repositorySearch.supported).toBe(true);
    expect(caps?.diffSearch.supported).toBe(true);
    expect(caps?.changeRequestDetails.supported).toBe(true);
    expect(caps?.issueDetails.supported).toBe(true);
  });

  describe('manifest and diff reads via the Compare API', () => {
    it('classifies binary and too_large files from Compare without an empty-success payload', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot() });
      const files = investigationResultValue(result) ?? [];
      expect(files.find((f) => f.path === 'assets/logo.png')?.binary).toBe(true);
      expect(files.find((f) => f.path === 'src/auth/token.ts')?.addedLines).toBeGreaterThan(0);
    });

    it('reports a too_large diff as tooLarge, never as empty complete content', async () => {
      const conn = connect();
      const result = await conn.readDiff!({ snapshot: snapshot(), path: 'package-lock.json' });
      expect(result.state).toBe('tooLarge');
      expect(investigationResultValue(result)).toBeUndefined();
    });

    it('reports a binary diff as binary', async () => {
      const conn = connect();
      const result = await conn.readDiff!({ snapshot: snapshot(), path: 'assets/logo.png' });
      expect(result.state).toBe('binary');
    });

    it('reads the exact patch for a normal changed file', async () => {
      const conn = connect();
      const result = await conn.readDiff!({ snapshot: snapshot(), path: 'src/auth/token.ts' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)?.patch).toContain('refresh failed');
    });
  });

  describe('searchDiff (in-memory over the pinned Compare result)', () => {
    it('finds a match inside the changed diff', async () => {
      const conn = connect();
      const result = await conn.searchDiff!({ snapshot: snapshot(), query: 'refresh' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)?.length ?? 0).toBeGreaterThan(0);
    });

    it('excludes too_large and binary files from diff search', async () => {
      const conn = connect();
      const result = await conn.searchDiff!({ snapshot: snapshot(), query: 'a' });
      const paths = (investigationResultValue(result) ?? []).map((m) => m.position.path);
      expect(paths).not.toContain('package-lock.json');
      expect(paths).not.toContain('assets/logo.png');
    });
  });

  describe('revision resolution', () => {
    it('reports an unresolvable base/head pair as unavailable, never notFound', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot('nope-head', 'nope-base') });
      expect(result.state).toBe('unavailable');
    });

    it('disambiguates a bad revision (unavailable) from a bad path (notFound) on readFile', async () => {
      const conn = connect();
      const badRevision = await conn.readFile!({ snapshot: snapshot('nope-head', 'nope-base'), revision: 'head', path: 'src/auth/token.ts', startLine: 1, endLine: 1 });
      expect(badRevision.state).toBe('unavailable');

      const badPath = await conn.readFile!({ snapshot: snapshot(), revision: 'head', path: 'no/such/file.ts', startLine: 1, endLine: 1 });
      expect(badPath.state).toBe('notFound');
    });

    it('pins a diff read to a prior revision, never substituting the current tip (task 3.7)', async () => {
      const conn = connect();
      const priorSnapshot = { repoId: REPO_ID, baseSha: 'prior-base-1', headSha: 'prior-head-1' };
      const result = await conn.readDiff!({ snapshot: priorSnapshot, path: 'src/legacy/old.ts' });
      expect(result.snapshot).toEqual(priorSnapshot);
      expect(investigationResultValue(result)?.patch).toContain('older');
    });
  });

  describe('normalized details', () => {
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
  });

  it('getCurrentHead resolves the live head SHA for the pre-completion drift check', async () => {
    const conn = connect();
    const result = await conn.getCurrentHead!({ repoId: REPO_ID, number: '2841' });
    expect(result).toEqual({ repoId: REPO_ID, state: 'resolved', headSha: diffRefs.head_sha });
  });

  it('surfaces a rate-limited investigation read as the neutral retryable error, not a returned state', async () => {
    const conn = connect({ investigationRateLimited: true });
    await expect(conn.readDiff!({ snapshot: snapshot(), path: 'src/auth/token.ts' })).rejects.toMatchObject({ kind: 'rateLimited' });
  });
});
