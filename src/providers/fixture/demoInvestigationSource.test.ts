/**
 * Focused tests for the demo pod's sample investigation source, and for the two
 * detail reads its connection still answers.
 *
 * Both halves used to be one object: the fixture provider's `Connection`
 * answered the five revision-pinned operations alongside change-request and
 * issue detail. A provider answers no investigation now, so the sample dataset
 * and the five operations moved to `./demoInvestigationSource.ts`, and the
 * cases below moved with whichever half they were about. Nothing in the sample
 * data changed; the assertions are the same pinned-revision,
 * branch-tip-rejection and no-empty-success invariants over the same task-1.3
 * harness fixtures.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../../platform/types';
import * as harnessFixtures from './harnessFixtures';
import { FixtureConnection } from './fixtureProvider';
import { createDemoInvestigationSource, DEMO_INVESTIGATION_CAPABILITIES } from './demoInvestigationSource';
import { describeInvestigationSourceContract } from '../../platform/contract/investigationSourceContract';

const REPO_ID = '9101';
const DEFAULT_HEAD_SHA = '4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9';
const DEFAULT_BASE_SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function snapshot(headSha: string, baseSha = DEFAULT_BASE_SHA, repoId = REPO_ID) {
  return { repoId, baseSha, headSha };
}

function connect(): FixtureConnection {
  return new FixtureConnection();
}

function sampleSource(simulation: { investigationRateLimited?: boolean } = {}) {
  return createDemoInvestigationSource(simulation);
}

describe('the demo pod\'s sample investigation source', () => {
  it('declares the five pinned operations and nothing about the two detail reads, which are the connection\'s', () => {
    const caps = DEMO_INVESTIGATION_CAPABILITIES;
    expect(caps.manifests.supported).toBe(true);
    expect(caps.diffReads.supported).toBe(true);
    expect(caps.fileReads.supported).toBe(true);
    expect(caps.repositorySearch.supported).toBe(true);
    expect(caps.diffSearch.supported).toBe(true);
    expect(caps.pagination.maxPageSize).toBe(harnessFixtures.HUGE_REVIEW_PAGE_SIZE);
    expect('changeRequestDetails' in caps).toBe(false);
    expect('issueDetails' in caps).toBe(false);
  });

  describe('manifest pagination (huge fixture)', () => {
    it('spans more than two pages and terminates complete without dropping files', async () => {
      const source = sampleSource();
      const seen = new Set<string>();
      let cursor: string | undefined;
      let pages = 0;
      for (let i = 0; i < 10; i++) {
        const result = await source.listChangedFiles({ snapshot: snapshot(harnessFixtures.HUGE_REVIEW_DIFF.headSha), cursor });
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
      const source = sampleSource();
      const result = await source.listChangedFiles({ snapshot: snapshot(harnessFixtures.BINARY_AND_RENAMED_DIFF.headSha) });
      const files = investigationResultValue(result) ?? [];
      const renamed = files.find((f) => f.kind === 'renamed');
      const binary = files.find((f) => f.binary);
      expect(renamed?.oldPath).toBe(harnessFixtures.RENAMED_FILE.oldPath);
      expect(renamed?.path).toBe(harnessFixtures.RENAMED_FILE.newPath);
      expect(binary?.path).toBe(harnessFixtures.BINARY_FILE.newPath);
    });

    it('reads the binary file as binary, never as empty text', async () => {
      const source = sampleSource();
      const result = await source.readFile({
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
      const source = sampleSource();
      const result = await source.readFile({
        snapshot: snapshot(DEFAULT_HEAD_SHA),
        revision: 'head',
        path: 'src/auth/token.ts',
        startLine: 1,
        endLine: 1000,
      });
      expect(result.state).toBe('truncated');
      const value = investigationResultValue(result);
      const bound = DEMO_INVESTIGATION_CAPABILITIES!.fileReads.pageBound!.maxPageSize;
      expect(value?.text.split('\n').length).toBe(bound);
      if (result.state === 'truncated') expect(result.knownRemainingUnits).toBeGreaterThan(0);
    });

    it('reports notFound for a path absent from a known snapshot, never an empty complete text', async () => {
      const source = sampleSource();
      const result = await source.readFile({
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
      const source = sampleSource();
      const pinned = await source.listChangedFiles({ snapshot: snapshot(harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA, 'stale-base-1') });
      const pinnedPaths = (investigationResultValue(pinned) ?? []).map((f) => f.path);
      expect(pinnedPaths).toContain('src/order/total.ts');
      expect(pinnedPaths).not.toContain('src/order/discount.ts');

      const later = await source.listChangedFiles({ snapshot: snapshot(harnessFixtures.CHANGED_HEAD_LATER_SHA, 'stale-base-1') });
      const laterPaths = (investigationResultValue(later) ?? []).map((f) => f.path);
      expect(laterPaths).toContain('src/order/discount.ts');
    });

    it('getCurrentHead reveals drift without altering pinned reads', async () => {
      const conn = connect();
      const source = sampleSource();
      const current = await conn.getCurrentHead!(harnessFixtures.CHANGED_HEAD_REF);
      expect(current).toEqual({ repoId: harnessFixtures.CHANGED_HEAD_REF.repoId, state: 'resolved', headSha: harnessFixtures.CHANGED_HEAD_LATER_SHA });

      const pinned = await source.readFile({
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
    it('reports a revision it does not hold as notFound on the manifest and unavailable on every path-scoped read', async () => {
      // The split every provider now makes. A manifest has no path parameter,
      // so its `notFound` can only be about the revisions — which is the one
      // answer design D8's refused-versus-gone rule can read. A path-scoped
      // read's `notFound` already means "no such path", so an unresolvable
      // pair there stays `unavailable` rather than telling a caller a file is
      // absent from a change that could not be resolved at all.
      const source = sampleSource();
      const bogus = snapshot('does-not-exist-sha');
      const manifest = await source.listChangedFiles({ snapshot: bogus });
      const file = await source.readFile({ snapshot: bogus, revision: 'head', path: 'src/auth/token.ts', startLine: 1, endLine: 1 });
      const search = await source.searchRepository({ snapshot: bogus, revision: 'head', query: 'refresh' });
      expect(manifest.state).toBe('notFound');
      expect(file.state).toBe('unavailable');
      expect(search.state).toBe('unavailable');
    });
  });

  describe('oversized diff (design D7 tooLarge/unknown states)', () => {
    it('reports readDiff as tooLarge, never a truncated or empty patch', async () => {
      const source = sampleSource();
      const result = await source.readDiff({
        snapshot: snapshot(harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha),
        path: harnessFixtures.OVERSIZED_FILE_PATH,
      });
      expect(result.state).toBe('tooLarge');
    });

    it('reports searchDiff as unknown completeness rather than a false exhaustive result', async () => {
      const source = sampleSource();
      const result = await source.searchDiff({ snapshot: snapshot(harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha), query: 'anything' });
      expect(result.state).toBe('unknown');
    });
  });

  describe('declined content (add-local-git-investigation, task 3.7)', () => {
    const declinedSnapshot = () =>
      snapshot(harnessFixtures.DECLINED_CONTENT_DIFF.headSha, harnessFixtures.DECLINED_CONTENT_DIFF.baseSha);

    it('enumerates the declined file in full and marks the entry declined, not binary', async () => {
      const source = sampleSource();
      const result = await source.listChangedFiles({ snapshot: declinedSnapshot() });
      expect(result.state).toBe('complete');
      const files = investigationResultValue(result) ?? [];
      expect(files.map((f) => f.path)).toEqual([harnessFixtures.DECLINED_CONTENT_FILE_PATH, harnessFixtures.DECLINED_CONTENT_SERVED_PATH]);
      expect(files[0]).toMatchObject({ contentDeclined: true, binary: false });
      expect(files[1]?.contentDeclined).toBeUndefined();
    });

    it('reports readDiff as contentDeclined for the declined file and serves the other from the same manifest', async () => {
      const source = sampleSource();
      const declined = await source.readDiff({ snapshot: declinedSnapshot(), path: harnessFixtures.DECLINED_CONTENT_FILE_PATH });
      expect(declined.state).toBe('contentDeclined');
      expect(investigationResultValue(declined)).toBeUndefined();
      const served = await source.readDiff({ snapshot: declinedSnapshot(), path: harnessFixtures.DECLINED_CONTENT_SERVED_PATH });
      expect(served.state).toBe('complete');
      expect(investigationResultValue(served)?.patch).toContain('HALF_CENT');
    });

    it('reports searchDiff as unknown completeness rather than an exhaustive search of the part it was given', async () => {
      const source = sampleSource();
      const result = await source.searchDiff({ snapshot: declinedSnapshot(), query: 'CENTS' });
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

  describe('rate-limited sample reads', () => {
    it('surfaces the neutral retryable error instead of any result state', async () => {
      const source = sampleSource({ investigationRateLimited: true });
      await expect(
        source.readFile({ snapshot: snapshot(DEFAULT_HEAD_SHA), revision: 'head', path: 'src/auth/token.ts', startLine: 1, endLine: 1 }),
      ).rejects.toMatchObject({ kind: 'rateLimited' });
    });
  });

  describe('nested AGENTS.md reads (task 6.3)', () => {
    const policySnapshot = snapshot(harnessFixtures.NESTED_AGENTS_MD_DIFF.headSha, 'policy-base-1', 'harness-policy');

    it('reads the root and every nested AGENTS.md as repository content outside the diff', async () => {
      const source = sampleSource();
      for (const file of harnessFixtures.NESTED_AGENTS_MD) {
        const result = await source.readFile({ snapshot: policySnapshot, revision: 'base', path: file.path, startLine: 1, endLine: 50 });
        expect(result.state).toBe('complete');
        expect(investigationResultValue(result)?.text).toBe(file.content);
      }
    });

    it('reports not found for a directory with no AGENTS.md', async () => {
      const source = sampleSource();
      const result = await source.readFile({ snapshot: policySnapshot, revision: 'base', path: 'docs/AGENTS.md', startLine: 1, endLine: 50 });
      expect(result.state).toBe('notFound');
    });
  });
});

/**
 * The shared investigation-source conformance suite, run against the sample
 * source — the second implementation.
 *
 * One implementation and a contract is a description of that implementation.
 * The local git source runs the same suite over a real two-commit repository
 * (`src/localgit/localGitSource.contract.test.ts`); this one runs it over data
 * that never touched a repository at all, which is what keeps the contract a
 * statement about the interface rather than about git.
 */
describeInvestigationSourceContract('demo pod sample source', {
  makeSource: () => createDemoInvestigationSource(),
  makeRateLimitedSource: () => createDemoInvestigationSource({ investigationRateLimited: true }),
  capabilities: DEMO_INVESTIGATION_CAPABILITIES,
  repoId: REPO_ID,
  baseSha: DEFAULT_BASE_SHA,
  headSha: DEFAULT_HEAD_SHA,
  changedFilePath: 'src/auth/token.ts',
  binaryFilePath: harnessFixtures.BINARY_FILE.newPath,
  declinedContent: {
    path: harnessFixtures.DECLINED_CONTENT_FILE_PATH,
    revision: { baseSha: DEFAULT_BASE_SHA, headSha: harnessFixtures.DECLINED_CONTENT_DIFF.headSha },
  },
  priorRevision: { baseSha: DEFAULT_BASE_SHA, headSha: harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA },
  noMatchQuery: 'ZZZ_NO_MATCH_ZZZ',
  matchQuery: 'refresh',
});
