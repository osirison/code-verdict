/**
 * Focused review-investigation tests for the fixture provider (task 4.2).
 * `fixture.contract.test.ts` proves the shared conformance suite passes;
 * these tests exercise operations and states the shared suite does not touch
 * directly (readDiff, searchDiff, getIssueDetails, getCurrentHead) and prove
 * pinned-revision/branch-tip-rejection/no-empty-success invariants using the
 * task-1.3 harness fixtures.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../../platform/types';
import * as harnessFixtures from './harnessFixtures';
import { FixtureConnection, fixtureProvider } from './fixtureProvider';

const REPO_ID = '9101';
const DEFAULT_HEAD_SHA = '4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9';
const DEFAULT_BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function snapshot(headSha: string, baseSha = DEFAULT_BASE_SHA, repoId = REPO_ID) {
  return { repoId, baseSha, headSha };
}

function connect(): FixtureConnection {
  return new FixtureConnection();
}

describe('fixture provider investigation operations (task 4.1/4.2)', () => {
  it('declares every review-investigation operation as honestly supported', () => {
    const caps = fixtureProvider.capabilities.reviewInvestigation;
    expect(caps).toBeDefined();
    expect(caps?.manifests.supported).toBe(true);
    expect(caps?.diffReads.supported).toBe(true);
    expect(caps?.fileReads.supported).toBe(true);
    expect(caps?.repositorySearch.supported).toBe(true);
    expect(caps?.diffSearch.supported).toBe(true);
    expect(caps?.changeRequestDetails.supported).toBe(true);
    expect(caps?.issueDetails.supported).toBe(true);
    expect(caps?.pagination.maxPageSize).toBe(harnessFixtures.HUGE_REVIEW_PAGE_SIZE);
  });

  describe('manifest pagination (huge fixture)', () => {
    it('spans more than two pages and terminates complete without dropping files', async () => {
      const conn = connect();
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (let i = 0; i < 10; i++) {
        const result = await conn.listChangedFiles!({ snapshot: snapshot(harnessFixtures.HUGE_REVIEW_DIFF.headSha), cursor });
        pages++;
        for (const f of investigationResultValue(result) ?? []) seen.add(f.path);
        if (result.state !== 'paginated') {
          expect(result.state).toBe('complete');
          break;
        }
        cursor = result.cursor;
      }
      expect(pages).toBeGreaterThan(2);
      expect(seen.size).toBe(harnessFixtures.HUGE_REVIEW_FILE_COUNT);
    });
  });

  describe('renamed and binary classification', () => {
    it('classifies the renamed file with distinct old/new paths and the binary file as binary', async () => {
      const conn = connect();
      const result = await conn.listChangedFiles!({ snapshot: snapshot(harnessFixtures.BINARY_AND_RENAMED_DIFF.headSha) });
      const files = investigationResultValue(result) ?? [];
      const renamed = files.find((f) => f.kind === 'renamed');
      const binary = files.find((f) => f.binary);
      expect(renamed?.oldPath).toBe(harnessFixtures.RENAMED_FILE.oldPath);
      expect(renamed?.path).toBe(harnessFixtures.RENAMED_FILE.newPath);
      expect(binary?.path).toBe(harnessFixtures.BINARY_FILE.newPath);
    });

    it('reads the binary file as binary, never as empty text', async () => {
      const conn = connect();
      const result = await conn.readFile!({
        snapshot: snapshot(DEFAULT_HEAD_SHA),
        revision: 'head',
        path: harnessFixtures.BINARY_FILE.newPath,
        startLine: 1,
        endLine: 1,
      });
      expect(result.state).toBe('binary');
      expect(investigationResultValue(result)).toBeUndefined();
    });
  });

  describe('bounded file reads', () => {
    it('truncates a full read of the default changed file to the declared page bound', async () => {
      const conn = connect();
      const result = await conn.readFile!({
        snapshot: snapshot(DEFAULT_HEAD_SHA),
        revision: 'head',
        path: 'src/auth/token.ts',
        startLine: 1,
        endLine: 1000,
      });
      expect(result.state).toBe('truncated');
      const value = investigationResultValue(result);
      const bound = fixtureProvider.capabilities.reviewInvestigation!.fileReads.pageBound!.maxPageSize;
      expect(value?.text.split('\n').length).toBe(bound);
      if (result.state === 'truncated') expect(result.knownRemainingUnits).toBeGreaterThan(0);
    });

    it('reports notFound for a path absent from a known snapshot, never an empty complete text', async () => {
      const conn = connect();
      const result = await conn.readFile!({
        snapshot: snapshot(DEFAULT_HEAD_SHA),
        revision: 'head',
        path: 'no/such/file.ts',
        startLine: 1,
        endLine: 1,
      });
      expect(result.state).toBe('notFound');
    });
  });

  describe('pinned revision and branch-tip rejection (changed-head fixture)', () => {
    it('never substitutes the later head for a manifest pinned to the earlier snapshot', async () => {
      const conn = connect();
      const pinned = await conn.listChangedFiles!({ snapshot: snapshot(harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA, 'stale-base-1') });
      const pinnedPaths = (investigationResultValue(pinned) ?? []).map((f) => f.path);
      expect(pinnedPaths).toContain('src/order/total.ts');
      expect(pinnedPaths).not.toContain('src/order/discount.ts');

      const later = await conn.listChangedFiles!({ snapshot: snapshot(harnessFixtures.CHANGED_HEAD_LATER_SHA, 'stale-base-1') });
      const laterPaths = (investigationResultValue(later) ?? []).map((f) => f.path);
      expect(laterPaths).toContain('src/order/discount.ts');
    });

    it('getCurrentHead reveals drift without altering pinned reads', async () => {
      const conn = connect();
      const current = await conn.getCurrentHead!(harnessFixtures.CHANGED_HEAD_REF);
      expect(current).toEqual({ repoId: harnessFixtures.CHANGED_HEAD_REF.repoId, state: 'resolved', headSha: harnessFixtures.CHANGED_HEAD_LATER_SHA });

      const pinned = await conn.readFile!({
        snapshot: snapshot(harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA, 'stale-base-1'),
        revision: 'head',
        path: 'src/order/total.ts',
        startLine: 1,
        endLine: 100,
      });
      expect(pinned.snapshot.headSha).toBe(harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA);
    });
  });

  describe('unresolvable revisions never report empty success', () => {
    it('reports unavailable for a totally unknown snapshot on every operation', async () => {
      const conn = connect();
      const bogus = snapshot('does-not-exist-sha');
      const manifest = await conn.listChangedFiles!({ snapshot: bogus });
      const file = await conn.readFile!({ snapshot: bogus, revision: 'head', path: 'src/auth/token.ts', startLine: 1, endLine: 1 });
      const search = await conn.searchRepository!({ snapshot: bogus, revision: 'head', query: 'refresh' });
      expect(manifest.state).toBe('unavailable');
      expect(file.state).toBe('unavailable');
      expect(search.state).toBe('unavailable');
    });
  });

  describe('oversized diff (design D7 tooLarge/unknown states)', () => {
    it('reports readDiff as tooLarge, never a truncated or empty patch', async () => {
      const conn = connect();
      const result = await conn.readDiff!({
        snapshot: snapshot(harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha),
        path: harnessFixtures.OVERSIZED_FILE_PATH,
      });
      expect(result.state).toBe('tooLarge');
    });

    it('reports searchDiff as unknown completeness rather than a false exhaustive result', async () => {
      const conn = connect();
      const result = await conn.searchDiff!({ snapshot: snapshot(harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha), query: 'anything' });
      expect(result.state).toBe('unknown');
    });
  });

  describe('normalized details', () => {
    it('normalizes change-request details with a relationship parsed from the description trailer', async () => {
      const conn = connect();
      const result = await conn.getChangeRequestDetails!({ snapshot: snapshot(DEFAULT_HEAD_SHA), number: '2841' });
      const value = investigationResultValue(result);
      expect(value?.relationships).toEqual([{ kind: 'partOf', ref: '1180' }]);
      expect(value?.discussion.length).toBeGreaterThan(0);
      expect(value?.unavailableSections).toContain('commits');
    });

    it('returns the long issue fixture discussion in full', async () => {
      const conn = connect();
      const result = await conn.getIssueDetails!({
        snapshot: snapshot(DEFAULT_HEAD_SHA),
        issueRepoId: harnessFixtures.LONG_ISSUE.repoId,
        issueNumber: harnessFixtures.LONG_ISSUE.number,
      });
      const value = investigationResultValue(result);
      expect(value?.discussion.length).toBe(harnessFixtures.LONG_DISCUSSION_NOTE_COUNT);
      expect(value?.title).toBe(harnessFixtures.LONG_ISSUE.title);
    });

    it('reports notFound for an issue the fixture has never heard of', async () => {
      const conn = connect();
      const result = await conn.getIssueDetails!({ snapshot: snapshot(DEFAULT_HEAD_SHA), issueRepoId: 'nope', issueNumber: '404' });
      expect(result.state).toBe('notFound');
    });
  });

  describe('rate-limited investigation reads', () => {
    it('surfaces the neutral retryable error instead of any result state', async () => {
      const conn = connect();
      conn.simulate.investigationRateLimited = true;
      await expect(
        conn.readFile!({ snapshot: snapshot(DEFAULT_HEAD_SHA), revision: 'head', path: 'src/auth/token.ts', startLine: 1, endLine: 1 }),
      ).rejects.toMatchObject({ kind: 'rateLimited' });
    });
  });

  describe('nested AGENTS.md reads (task 6.3)', () => {
    const policySnapshot = snapshot(harnessFixtures.NESTED_AGENTS_MD_DIFF.headSha, 'policy-base-1', 'harness-policy');

    it('reads the root and every nested AGENTS.md as repository content outside the diff', async () => {
      const conn = connect();
      for (const file of harnessFixtures.NESTED_AGENTS_MD) {
        const result = await conn.readFile!({ snapshot: policySnapshot, revision: 'base', path: file.path, startLine: 1, endLine: 50 });
        expect(result.state).toBe('complete');
        expect(investigationResultValue(result)?.text).toBe(file.content);
      }
    });

    it('reports not found for a directory with no AGENTS.md', async () => {
      const conn = connect();
      const result = await conn.readFile!({ snapshot: policySnapshot, revision: 'base', path: 'docs/AGENTS.md', startLine: 1, endLine: 50 });
      expect(result.state).toBe('notFound');
    });
  });
});
