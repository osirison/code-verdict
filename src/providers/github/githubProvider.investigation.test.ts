/**
 * Focused review-investigation tests for the GitHub provider (task 4.6/4.7).
 * `github.contract.test.ts` proves the shared conformance suite passes;
 * these tests exercise GitHub-specific mapping the shared suite doesn't
 * touch directly: Compare API binary-vs-tooLarge classification, `readDiff`,
 * `searchDiff`, `getIssueDetails`, `getCurrentHead`, the notFound-vs-
 * unavailable revision disambiguation, the 300-file Compare cap, and
 * rate-limit propagation in its reset-header form.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../../platform/types';
import { createGitHubProvider } from './githubProvider';
import { makeFakeGitHubFetch } from './fakeGitHub';
import { toChangedFileEntry, toNormalizedDetail } from './mappers';
import type { GhFile, GhPull } from './mappers';

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

describe('github provider investigation operations (task 4.6/4.7)', () => {
  it('declares every review-investigation operation honestly, including the real repositorySearch gap', () => {
    const caps = createGitHubProvider().capabilities.reviewInvestigation;
    expect(caps).toBeDefined();
    expect(caps?.manifests.supported).toBe(true);
    expect(caps?.diffReads.supported).toBe(true);
    expect(caps?.fileReads.supported).toBe(true);
    expect(caps?.diffSearch.supported).toBe(true);
    expect(caps?.changeRequestDetails.supported).toBe(true);
    expect(caps?.issueDetails.supported).toBe(true);
    // GitHub's code search only indexes each repository's default branch and
    // takes no ref/commit parameter — never revision-pinnable.
    expect(caps?.repositorySearch.supported).toBe(false);
  });

  describe('manifest and diff reads via the Compare API', () => {
    it('classifies binary (no line counts) and tooLarge (counted, unrendered) files without an empty-success payload', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot() });
      const files = investigationResultValue(result) ?? [];
      expect(files.find((f) => f.path === 'assets/logo.png')?.binary).toBe(true);
      expect(files.find((f) => f.path === 'package-lock.json')?.binary).toBe(false);
      expect(files.find((f) => f.path === 'src/limiter.ts')?.addedLines).toBeGreaterThan(0);
    });

    it('reports a tooLarge diff as tooLarge, never as empty complete content', async () => {
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
      const result = await conn.readDiff!({ snapshot: snapshot(), path: 'src/limiter.ts' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)?.patch).toContain('const a = 1');
    });

    it('reports a renamed file with both paths', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot() });
      const renamed = (investigationResultValue(result) ?? []).find((f) => f.path === 'src/renamed-new.ts');
      expect(renamed).toMatchObject({ kind: 'renamed', oldPath: 'src/renamed-old.ts' });
    });
  });

  describe('searchDiff (in-memory over the pinned Compare result)', () => {
    it('finds a match inside the changed diff', async () => {
      const conn = connect();
      const result = await conn.searchDiff!({ snapshot: snapshot(), query: 'context' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)?.length ?? 0).toBeGreaterThan(0);
    });

    it('excludes tooLarge and binary files from diff search', async () => {
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
      const badRevision = await conn.readFile!({
        snapshot: snapshot('nope-head', 'nope-base'), revision: 'head', path: 'src/limiter.ts', startLine: 1, endLine: 1,
      });
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

  describe('the Compare API\u2019s 300-file cap', () => {
    it('reports the manifest truncated once the comparison hits the platform cap, complete otherwise', async () => {
      const capped = Array.from({ length: 300 }, (_, i) => ({
        filename: `src/generated/file-${i}.ts`, status: 'modified' as const, patch: '@@ -1,1 +1,1 @@\n-a\n+b\n', additions: 1, deletions: 1,
      }));
      const fetchImpl = async () => ({
        ok: true, status: 200,
        headers: { get: () => null },
        json: async () => ({ files: capped }),
        text: async () => JSON.stringify({ files: capped }),
      });
      const conn = createGitHubProvider(fetchImpl).connect(CONFIG);
      const result = await conn.listChangedFiles!({ snapshot: snapshot() });
      // 300 exceeds the manifest page bound (100), so the first call pages — walk to the end.
      let cursor: string | undefined;
      let last = result;
      for (let page = 0; page < 10 && last.state === 'paginated'; page += 1) {
        cursor = last.cursor;
        last = await conn.listChangedFiles!({ snapshot: snapshot(), cursor });
      }
      expect(last.state).toBe('truncated');
    });

    it('reports complete when the comparison is under the cap', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot() });
      let last = result;
      let cursor: string | undefined;
      for (let page = 0; page < 10 && last.state === 'paginated'; page += 1) {
        cursor = last.cursor;
        last = await conn.listChangedFiles!({ snapshot: snapshot(), cursor });
      }
      expect(last.state).toBe('complete');
    });
  });

  describe('normalized details', () => {
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
  });

  it('getCurrentHead resolves the live head SHA for the pre-completion drift check', async () => {
    const conn = connect();
    const result = await conn.getCurrentHead!({ repoId: REPO_ID, number: '2841' });
    expect(result).toEqual({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA });
  });

  it('surfaces a rate-limited investigation read (reset-header form) as the neutral retryable error, not a returned state', async () => {
    const conn = connect({ investigationRateLimited: true });
    await expect(conn.readDiff!({ snapshot: snapshot(), path: 'src/limiter.ts' })).rejects.toMatchObject({ kind: 'rateLimited' });
  });

  it('toChangedFileEntry treats a patchless, zero-count file as binary, and a patchless counted file as not binary', () => {
    const binary: GhFile = { filename: 'a.png', status: 'modified', additions: 0, deletions: 0 };
    const large: GhFile = { filename: 'b.json', status: 'modified', additions: 10, deletions: 5 };
    expect(toChangedFileEntry(binary).binary).toBe(true);
    expect(toChangedFileEntry(large).binary).toBe(false);
  });
});
