/**
 * The local source's five operations, against a real bare object store —
 * task group 8 of `add-local-git-investigation`.
 *
 * **Every test here runs real git over a real repository**, for the reason
 * `src/testing/localGitRepository.ts` gives at length: everything this group has
 * to establish is a fact about git, and a recorded fixture can only prove that
 * we parse bytes we wrote down earlier. `-M` detects a rename only if git's own
 * similarity detection says so; binary is git's content determination; `-z`
 * framing is a property of git's output. A transcription of any of those would
 * keep passing on the day it stopped being true.
 *
 * The store is **bare**, built by pushing the fixture's two commits into an
 * empty repository under the ref names design D3 gives acquired objects. Nothing
 * is ever checked out of it, which the last test in this file asserts rather
 * than assumes.
 *
 * Several tests come in pairs: the thing this source does, and a measurement of
 * what the obvious alternative would have done instead. Those pairs are the ones
 * worth keeping — a guard whose absence no test can feel is not a guard.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { pageBoundWithinPolicy, toolCapabilityAvailable } from '../app/harnessToolDispatcher';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import { HOST_TOOL_DEFINITIONS } from '../domain/harnessTools';
import type { MemberCapabilities } from '../platform/provider';
import type { InvestigationSnapshotRef, InvestigationSource } from '../platform/types';
import { investigationResultValue } from '../platform/types';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';
import { gitProcessArguments, runGitInvocation, type GitRunner } from './gitInvocation';
import { createLocalGitSource, LOCAL_GIT_INVESTIGATION_CAPABILITIES, type LocalGitSourceOptions } from './localGitSource';
import type { LocalGitPolicy } from './localGitPolicy';

const gitVersion = gitExecutableVersion();
const REPO_ID = 'acme/core';

/** One invocation this source made, as the child process actually received it. */
interface RecordedInvocation {
  readonly kind: string;
  readonly args: readonly string[];
  readonly gitDir: string | undefined;
}

/**
 * Pushes both pinned commits into an empty bare repository, under the ref names
 * design D3 gives acquired objects. This is what acquisition leaves behind; the
 * transfer itself is `objectAcquisition.test.ts`'s subject, not this file's.
 */
function bareStoreWith(repo: LocalGitFixture, path: string): string {
  const init = runGit(repo, ['init', '--bare', '--quiet', path]);
  expect(init.status, init.stderr).toBe(0);
  const push = runGit(repo, [
    'push',
    '--quiet',
    path,
    `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`,
    `${repo.headSha}:refs/codeverdict/${repo.headSha}`,
  ]);
  expect(push.status, push.stderr).toBe(0);
  return path;
}

describe.skipIf(gitVersion === undefined)('the local source answers the five operations from a bare store (task group 8)', () => {
  let repo: LocalGitFixture;
  let store: string;
  let recorded: RecordedInvocation[] = [];
  let source: InvestigationSource;
  let snapshot: InvestigationSnapshotRef;

  /**
   * A runner that records what really ran and then runs it. The claims below
   * about *which* commands answer an operation cannot be checked from a result,
   * and a substituted runner cannot fake one: what it receives is a
   * `GitInvocationPlan`, which nothing outside the invocation builder can
   * construct.
   */
  const recordingRunner: GitRunner = async (plan, context) => {
    recorded.push({ kind: plan.kind, args: gitProcessArguments(plan, context), gitDir: context.gitDir });
    return runGitInvocation(plan, context);
  };

  function sourceWith(policy?: Partial<LocalGitPolicy>): InvestigationSource {
    const options: LocalGitSourceOptions = { gitDir: store, repoId: REPO_ID, run: recordingRunner, ...(policy ? { policy } : {}) };
    return createLocalGitSource(options);
  }

  beforeAll(() => {
    repo = createTwoCommitRepository({ awkwardPaths: true, lateNulTextFile: true });
    store = bareStoreWith(repo, join(repo.root, 'store.git'));
    snapshot = { repoId: REPO_ID, baseSha: repo.baseSha, headSha: repo.headSha };
  });

  afterAll(() => repo?.cleanup());

  beforeEach(() => {
    recorded = [];
    // A fresh source per test, so one test's memoized manifest cannot make
    // another test's invocation count wrong.
    source = sourceWith();
  });

  /** The manifest as a map, since nothing below depends on git's ordering. */
  async function manifest(from: InvestigationSource = source): Promise<Map<string, { kind: string; binary: boolean; oldPath?: string; addedLines?: number; removedLines?: number; byteSize?: number; contentDeclined?: boolean }>> {
    const result = await from.listChangedFiles({ snapshot });
    expect(result.state).toBe('complete');
    const entries = investigationResultValue(result) ?? [];
    return new Map(entries.map((entry) => [entry.path, entry]));
  }

  // ---- 8.1 listChangedFiles ---------------------------------------------------

  describe('listChangedFiles (task 8.1)', () => {
    it('enumerates every changed file with its kind, its counts, and both paths of a rename', async () => {
      const files = await manifest();

      expect([...files.keys()].sort()).toEqual(
        [
          repo.paths.binary,
          repo.paths.added,
          repo.paths.oversized,
          repo.paths.deleted,
          repo.paths.modified,
          repo.paths.renamedTo,
          repo.lateNulTextPath as string,
          ...repo.awkwardPathList,
        ].sort(),
      );
      expect(files.get(repo.paths.added)).toMatchObject({ kind: 'added', binary: false, addedLines: 1, removedLines: 0 });
      expect(files.get(repo.paths.deleted)).toMatchObject({ kind: 'deleted', binary: false, addedLines: 0, removedLines: 1 });
      expect(files.get(repo.paths.modified)).toMatchObject({ kind: 'modified', binary: false, addedLines: 2, removedLines: 1 });
      expect(files.get(repo.paths.oversized)).toMatchObject({ kind: 'modified', addedLines: repo.oversizedDiffLines, removedLines: 1 });
      expect(files.get(repo.paths.renamedTo)).toMatchObject({ kind: 'renamed', oldPath: repo.paths.renamedFrom, binary: false });
    });

    it('reports exactly the one file git says is binary, and every other file as text', async () => {
      const files = await manifest();
      const binary = [...files.entries()].filter(([, entry]) => entry.binary).map(([path]) => path);
      expect(binary).toEqual([repo.paths.binary]);

      // Agreement with git, pinned: the flag above is `--numstat`'s own `-\t-`
      // for that path and nothing else. If this source ever started deciding
      // binary for itself, the two sides of this assertion would drift apart.
      const raw = runGit(repo, ['diff', '--numstat', '-M', `${repo.baseSha}..${repo.headSha}`]).stdout;
      expect(raw).toContain(`-\t-\t${repo.paths.binary}`);
    });

    it('agrees with git about where a file stops being text: a NUL past the first 8000 bytes is not one', async () => {
      // Git looks for a NUL in a blob's first 8000 bytes and nowhere else
      // (`buffer_is_binary()`). This file's first NUL is at byte 9,600, so git
      // calls it text — and a reader that scanned the whole buffer would call
      // it binary, which is this change's own failure mode pointed the other
      // way: a readable file reported as content nobody can read.
      const path = repo.lateNulTextPath as string;
      const numstat = runGit(repo, ['diff', '--numstat', '-M', `${repo.baseSha}..${repo.headSha}`, '--', path]).stdout;
      expect(numstat.trim()).toBe(`121\t0\t${path}`);

      const files = await manifest();
      expect(files.get(path)).toMatchObject({ kind: 'added', binary: false, addedLines: 121 });
      const read = await source.readFile({ snapshot, revision: 'head', path, startLine: 1, endLine: 1 });
      expect(read.state).toBe('complete');
      expect(investigationResultValue(read)?.text).toBe('x'.repeat(79));
    });

    it('carries the declined-content state only where it refuses the name, never because a diff was missing', async () => {
      // The forge's truncation shape — the thing this state was added for — has
      // no equivalent here: git rendered every file it compared, and this source
      // never infers a state from an answer it did not get. The one entry that
      // carries it is the one whose *name* this source will not pass to git (the
      // module header's "One limitation, settled rather than patched"), which is
      // a fact about this host rather than about content nobody could read.
      const files = await manifest();
      const declined = [...files.entries()].filter(([, entry]) => entry.contentDeclined === true).map(([path]) => path);
      expect(declined).toEqual(repo.awkwardPathList.filter((path) => path.includes('\n')));
    });

    it('is three commands: the counts, the kinds, and the whole diff it takes the per-file sizes from', async () => {
      await manifest();
      // The third is `searchDiff` — one whole-pair diff, split positionally for each file's patch
      // size (`splitPatchSizes`). It is a third invocation rather than 245 per-file ones because
      // it measured at 38ms against 315ms for the same total on this product's own change, and it
      // carries no pathspec at all, which is why it satisfies every assertion below unchanged.
      expect(recorded.map((call) => call.kind)).toEqual(['changedFiles', 'changedFileStatus', 'searchDiff']);
      for (const call of recorded) {
        expect(call.gitDir).toBe(store);
        // `-z` belongs to the two record-parsing commands only: the sizes command reads a patch,
        // where NUL framing has nothing to frame.
        if (call.kind !== 'searchDiff') expect(call.args).toContain('-z');
        expect(call.args).toContain('-M');
        // The textconv gap task group 7 measured: a driver named in the store's
        // own config converts both sides to the same text and empties a real diff.
        expect(call.args).toContain('--no-textconv');
        expect(call.args).toContain(`${repo.baseSha}..${repo.headSha}`);
        expect(call.args.at(-1)).toBe('--');
      }
      expect(recorded[0]?.args).toContain('--numstat');
      expect(recorded[1]?.args).toContain('--name-status');
      // The sizes command asks for the patch itself: neither summary flag, or there would be no
      // bytes to measure.
      expect(recorded[2]?.args).not.toContain('--numstat');
      expect(recorded[2]?.args).not.toContain('--name-status');
    });

    it('reports each file\'s diff size, and reports exactly the bytes readDiff returns for it', async () => {
      // The number the harness prints to the model and budgets a turn against, so it has to be the
      // size of the thing the model will actually receive — not the file's size, and not an
      // estimate from the line counts. Checked against the real `readDiff` of the same path.
      const files = await manifest();
      const sized = [...files.entries()].filter(([, entry]) => entry.byteSize !== undefined);
      expect(sized.length).toBeGreaterThan(0);
      for (const [path, entry] of sized) {
        if (entry.binary || entry.contentDeclined) continue;
        const read = await source.readDiff({ snapshot, path });
        if (read.state !== 'complete') continue;
        expect(Buffer.byteLength(investigationResultValue(read)!.patch, 'utf8'), path).toBe(entry.byteSize);
      }
    });

    it('is defending against something: without -z, git rewrites one of these paths and splits another in two', async () => {
      const quoted = repo.awkwardPathList[0] as string;
      const framed = runGit(repo, ['diff', '--name-status', '-M', `${repo.baseSha}..${repo.headSha}`]).stdout;
      // The path with a quote comes back as a quoted, escaped string — a
      // different value from the path, so a manifest keyed on it matches nothing.
      expect(framed).toContain('\\"ird.ts"');
      expect(framed).not.toContain(quoted);
      if (repo.awkwardPathList.length > 1) {
        // And the path with a newline arrives as two lines, which moves every
        // record after it.
        expect(framed.split('\n').filter((line) => line.includes('lines.ts')).length).toBeGreaterThan(0);
        expect(framed).toContain('two\\nlines.ts');
      }

      // Through the source, both are the paths themselves.
      const files = await manifest();
      for (const path of repo.awkwardPathList) expect(files.get(path)).toMatchObject({ kind: 'modified', binary: false });
    });
  });

  // ---- 8.2 readDiff -------------------------------------------------------------

  describe('readDiff (task 8.2)', () => {
    it(`answers one file's patch at the pinned pair, and echoes the pair back`, async () => {
      const result = await source.readDiff({ snapshot, path: repo.paths.modified });
      expect(result.state).toBe('complete');
      expect(result.snapshot).toEqual(snapshot);
      const page = investigationResultValue(result);
      expect(page?.path).toBe(repo.paths.modified);
      expect(page?.patch).toContain('+export const BURST = 10;');
      expect(page?.patch).toContain('-export const RATE = 100;');
    });

    it('reports a rename as a rename, from either of its two paths', async () => {
      const byNewPath = await source.readDiff({ snapshot, path: repo.paths.renamedTo });
      const page = investigationResultValue(byNewPath);
      expect(page?.isRenamed).toBe(true);
      expect(page?.oldPath).toBe(repo.paths.renamedFrom);
      expect(page?.patch).toContain(`rename from ${repo.paths.renamedFrom}`);
      expect(page?.patch).toContain(`rename to ${repo.paths.renamedTo}`);

      const byOldPath = await source.readDiff({ snapshot, path: repo.paths.renamedFrom });
      expect(investigationResultValue(byOldPath)?.patch).toEqual(page?.patch);
    });

    it('is defending against something: with only the new path in the pathspec, the same rename reads as a whole new file', async () => {
      // What `-M` can see is bounded by what the pathspec admits. The rename is
      // a deletion matched to an addition, so a pathspec carrying only the
      // addition leaves nothing to match it to — and a reviewer is handed a new
      // file to review instead of a move of code that was already reviewed.
      const onlyNew = runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.renamedTo]).stdout;
      expect(onlyNew).toContain('new file mode');
      expect(onlyNew).not.toContain('rename from');

      await source.readDiff({ snapshot, path: repo.paths.renamedTo });
      const diffCall = recorded.find((call) => call.kind === 'diffFile');
      const separator = diffCall?.args.indexOf('--') ?? -1;
      expect(separator).toBeGreaterThan(0);
      expect(diffCall?.args.slice(separator + 1)).toEqual([repo.paths.renamedFrom, repo.paths.renamedTo]);
    });

    it('paginates a diff past one page, and the pages reassemble into the whole patch', async () => {
      const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.diffReads.pageBound;
      const pages: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 50; page += 1) {
        const result = await source.readDiff({ snapshot, path: repo.paths.oversized, cursor });
        const value = investigationResultValue(result);
        expect(value).toBeDefined();
        pages.push(value?.patch ?? '');
        expect(Buffer.byteLength(value?.patch ?? '', 'utf8')).toBeLessThanOrEqual((bound?.maxPageBytes ?? 0) + 1);
        if (result.state !== 'paginated') {
          expect(result.state).toBe('complete');
          break;
        }
        cursor = result.cursor;
      }
      expect(pages.length).toBeGreaterThan(1);

      const whole = runGit(repo, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '-M',
        `${repo.baseSha}..${repo.headSha}`,
        '--',
        repo.paths.oversized,
      ]).stdout;
      expect(pages.join('\n')).toEqual(whole);
    });

    it(`reports a binary file from git's own determination, never as an empty patch`, async () => {
      const result = await source.readDiff({ snapshot, path: repo.paths.binary });
      expect(result.state).toBe('binary');
      // Git's words for the same file, which is where the state came from.
      expect(runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.binary]).stdout).toContain('Binary files');
    });

    it('reports a path this change does not contain as notFound, not as unavailable', async () => {
      const result = await source.readDiff({ snapshot, path: 'src/never-touched.ts' });
      expect(result.state).toBe('notFound');
    });

    it('refuses a path that is not repository-relative in its own words, and never hands it to git', async () => {
      for (const path of ['../outside.ts', '/etc/passwd', '--output=/tmp/pwned.txt']) {
        recorded = [];
        const result = await source.readDiff({ snapshot, path });
        expect(result.state).toBe('unavailable');
        expect(result.state === 'unavailable' ? result.reason : '').toMatch(/file path must/i);
        // The reason is this source's own text, and it never quotes the value back.
        expect(result.state === 'unavailable' ? result.reason : '').not.toContain(path);
        // Task 6.13's guarantee, asserted over what really ran rather than over
        // an empty list. `readDiff` consults the manifest to tell a path this
        // change does not contain from a changed file whose name this source
        // refuses — opposite states, task 10.6 — so the list is not always
        // empty. What it can never contain is the caller's string: the only
        // invocations are this source's own two manifest commands, built from
        // the two pinned shas, ending at the `--` that has no pathspec after it.
        for (const call of recorded) {
          expect(['changedFiles', 'changedFileStatus', 'searchDiff']).toContain(call.kind);
          expect(call.args).not.toContain(path);
          expect(call.args.at(-1)).toBe('--');
        }
      }
    });
  });

  // ---- 8.3 readFile --------------------------------------------------------------

  describe('readFile (task 8.3)', () => {
    it('reads a bounded line range at the head commit', async () => {
      const result = await source.readFile({ snapshot, revision: 'head', path: repo.paths.modified, startLine: 1, endLine: 1 });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)).toMatchObject({
        revision: 'head',
        path: repo.paths.modified,
        startLine: 1,
        endLine: 1,
        text: 'export const RATE = 250;',
      });
      expect(recorded.map((call) => call.kind)).toEqual(['fileAtRevision']);
    });

    it('reads a deleted file at the base commit, and reports it absent at the head', async () => {
      const atBase = await source.readFile({ snapshot, revision: 'base', path: repo.paths.deleted, startLine: 1, endLine: 10 });
      expect(atBase.state).toBe('complete');
      expect(investigationResultValue(atBase)?.text).toContain('LEGACY');

      const atHead = await source.readFile({ snapshot, revision: 'head', path: repo.paths.deleted, startLine: 1, endLine: 10 });
      expect(atHead.state).toBe('notFound');
    });

    it('reports a binary file as binary, by the same test git makes, not by a whole-buffer scan', async () => {
      const result = await source.readFile({ snapshot, revision: 'head', path: repo.paths.binary, startLine: 1, endLine: 1 });
      expect(result.state).toBe('binary');
      expect(result.state === 'binary' ? result.byteSize : 0).toBeGreaterThan(0);
    });

    it('bounds an over-long range and says how many lines are left', async () => {
      const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.fileReads.pageBound;
      const result = await source.readFile({ snapshot, revision: 'head', path: repo.paths.oversized, startLine: 1, endLine: 10_000_000 });
      expect(result.state).toBe('truncated');
      const value = investigationResultValue(result);
      expect(value).toBeDefined();
      expect((value?.endLine ?? 0) - (value?.startLine ?? 0) + 1).toBeLessThanOrEqual(bound?.maxPageSize ?? 0);
      expect(Buffer.byteLength(value?.text ?? '', 'utf8')).toBeLessThanOrEqual((bound?.maxPageBytes ?? 0) + 1);
      expect(result.state === 'truncated' ? result.knownRemainingUnits : 0).toBeGreaterThan(0);
    });

    it('is defending against something: git answers a directory with a tree listing and exit 0', async () => {
      // `git show <rev>:<dir>` succeeds, and what it prints is a header and the
      // directory's entries. Returned as file content it would enter the
      // evidence ledger as text nobody wrote.
      const listing = runGit(repo, ['show', `${repo.headSha}:src`]);
      expect(listing.status).toBe(0);
      expect(listing.stdout).toContain(`tree ${repo.headSha}:src`);

      const result = await source.readFile({ snapshot, revision: 'head', path: 'src', startLine: 1, endLine: 5 });
      expect(result.state).toBe('notFound');
      expect(result.state === 'notFound' ? result.reason : '').toMatch(/directory/i);
    });

    it('reports a first line past the end of the file rather than an empty success', async () => {
      const result = await source.readFile({ snapshot, revision: 'head', path: repo.paths.modified, startLine: 5000, endLine: 5001 });
      expect(result.state).toBe('notFound');
    });
  });

  // ---- 8.4 searchRepository -------------------------------------------------------

  describe('searchRepository (task 8.4)', () => {
    it('searches the content of one commit and returns a location a later read can use', async () => {
      const result = await source.searchRepository({ snapshot, revision: 'head', query: 'BURST' });
      expect(result.state).toBe('complete');
      const matches = investigationResultValue(result) ?? [];
      expect(matches).toEqual([{ path: repo.paths.modified, line: 2, excerpt: 'export const BURST = 10;' }]);

      // The location is enough for a bounded read, which is what the contract
      // asks of it — so the two answers are checked against each other.
      const read = await source.readFile({ snapshot, revision: 'head', path: matches[0]?.path ?? '', startLine: matches[0]?.line ?? 1, endLine: matches[0]?.line ?? 1 });
      expect(investigationResultValue(read)?.text).toBe(matches[0]?.excerpt);
    });

    it('answers a revision where the text is absent with an empty complete, not an unavailable', async () => {
      const result = await source.searchRepository({ snapshot, revision: 'base', query: 'BURST' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)).toEqual([]);
    });

    it('matches a query beginning with a dash literally, in the value position of an explicit option', async () => {
      const result = await source.searchRepository({ snapshot, revision: 'head', query: '-v' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)).toEqual([]);
      const call = recorded.find((invocation) => invocation.kind === 'searchRepository');
      expect(call?.args[(call.args.indexOf('-v')) - 1]).toBe('-e');
      expect(call?.args).toContain('-F');
    });

    it('keeps binary content out of every excerpt', async () => {
      // The fixture's PNG begins with the ASCII letters of its own signature, so
      // a search that read binary files would match inside it.
      const result = await source.searchRepository({ snapshot, revision: 'head', query: 'PNG' });
      expect((investigationResultValue(result) ?? []).map((match) => match.path)).not.toContain(repo.paths.binary);
    });

    it('scopes by path prefix the way both providers do, which a pathspec would not', async () => {
      const scoped = await source.searchRepository({ snapshot, revision: 'head', query: 'RATE', pathScope: 'src/ke' });
      expect((investigationResultValue(scoped) ?? []).map((match) => match.path)).toEqual([repo.paths.modified]);

      // The same string handed to git as a literal pathspec is not a prefix of
      // a path — it is a path — so it selects nothing, and a scope that meant
      // that would answer a different question in silence.
      const asPathspec = runGit(repo, ['grep', '-F', '-e', 'RATE', repo.headSha, '--', 'src/ke']);
      expect(asPathspec.stdout).toBe('');
    });

    it('reports a search at a revision this store does not hold as unresolved, never as no matches', async () => {
      // The two are opposite answers to the model: one says the text is not
      // there, the other says nobody looked. Git exits the same way for both,
      // so the revision is asked about rather than the error text read.
      //
      // `unknown` rather than `unavailable` for the same reason `readDiff` uses
      // it (design D8): the store is refetchable, so a revision it cannot
      // resolve right now is a fact about the store and not about the content.
      const absent = { ...snapshot, headSha: 'f'.repeat(40) };
      const inRepository = await source.searchRepository({ snapshot: absent, revision: 'head', query: 'RATE' });
      expect(inRepository.state).toBe('unknown');
      expect(investigationResultValue(inRepository)).toBeUndefined();

      const inDiff = await source.searchDiff({ snapshot: absent, query: 'RATE' });
      expect(inDiff.state).toBe('unknown');
      expect(investigationResultValue(inDiff)).toBeUndefined();
    });

    it('states its bound and carries a continuation, so a short page is never read as absence', async () => {
      const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.repositorySearch.pageBound?.maxPageSize ?? 0;
      const first = await source.searchRepository({ snapshot, revision: 'head', query: 'export' });
      expect(first.state).toBe('paginated');
      const firstPage = investigationResultValue(first) ?? [];
      expect(firstPage).toHaveLength(bound);

      const second = await source.searchRepository({ snapshot, revision: 'head', query: 'export', cursor: first.state === 'paginated' ? first.cursor : undefined });
      const secondPage = investigationResultValue(second) ?? [];
      expect(secondPage.length).toBeGreaterThan(0);
      // A different page, not the same one again.
      expect(secondPage[0]).not.toEqual(firstPage[0]);
    });
  });

  // ---- 8.5 searchDiff ---------------------------------------------------------------

  describe('searchDiff (task 8.5)', () => {
    it('finds a literal in the diff and reports the line it is really on', async () => {
      const result = await source.searchDiff({ snapshot, query: 'BURST' });
      expect(result.state).toBe('complete');
      expect(investigationResultValue(result)).toEqual([
        { position: { path: repo.paths.modified, side: 'new', line: 2 }, excerpt: 'export const BURST = 10;' },
      ]);
    });

    it('reports a removed line on the old side, at its line number in the base revision', async () => {
      const result = await source.searchDiff({ snapshot, query: 'LEGACY' });
      expect(investigationResultValue(result)).toEqual([
        { position: { path: repo.paths.deleted, side: 'old', line: 1 }, excerpt: 'export const LEGACY = true;' },
      ]);
    });

    it('never puts the query into a git argument', async () => {
      await source.searchDiff({ snapshot, query: 'BURST' });
      const call = recorded.find((invocation) => invocation.kind === 'searchDiff');
      expect(call).toBeDefined();
      for (const argument of call?.args ?? []) expect(argument).not.toContain('BURST');
      // `-G` would select whole files by a regular expression compiled from the
      // caller's string: neither a literal match nor a position.
      expect(call?.args.some((argument) => argument.startsWith('-G'))).toBe(false);
      expect(call?.args).not.toContain('-e');
    });

    it('is defending against something: the patch contains lines that belong to no file, and they are not searched', async () => {
      // `diff --git a/assets/logo.png …` and `Binary files a/assets/logo.png …`
      // both carry the path. A scanner that walked the patch line by line would
      // report a hit inside a file whose content nobody can read.
      const whole = runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`]).stdout;
      expect(whole.split('\n').filter((line) => line.includes('logo.png')).length).toBeGreaterThan(1);

      const result = await source.searchDiff({ snapshot, query: 'logo.png' });
      expect(investigationResultValue(result)).toEqual([]);
    });

    it('reports a match in a file git had to quote at the path itself, not at git\'s spelling of it', async () => {
      // A patch has no NUL-framed form, so git C-quotes a header path
      // containing a quote or a newline whatever `core.quotePath` says. Left
      // as git wrote it, a position's path would be `"b/src/we\\"ird.ts"` —
      // a string that names no file.
      const header = runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.awkwardPathList[0] as string]).stdout;
      expect(header).toContain('+++ "b/src/we\\"ird.ts"');

      const result = await source.searchDiff({ snapshot, query: 'AWKWARD' });
      const matches = investigationResultValue(result) ?? [];
      const added = matches.filter((match) => match.position.side === 'new');
      expect(added.map((match) => match.position.path).sort()).toEqual([...repo.awkwardPathList].sort());

      // The contract's own words for a search result: path and location
      // identity sufficient for a later bounded read. So one is performed.
      const quoted = added.find((match) => match.position.path === repo.awkwardPathList[0]);
      const read = await source.readFile({
        snapshot,
        revision: 'head',
        path: quoted?.position.path ?? '',
        startLine: quoted?.position.line ?? 1,
        endLine: quoted?.position.line ?? 1,
      });
      expect(read.state).toBe('complete');
      expect(investigationResultValue(read)?.text).toBe(quoted?.excerpt);
    });

    it('names a changed file it will not read, and declines its content rather than closing the file', async () => {
      // A newline in a path is one of the control characters task 6.4 refuses
      // before git is invoked, and that refusal is not this group's to
      // overturn: it closes a class of desynchronizing values rather than the
      // one member of it a `-z` reader happens to survive.
      //
      // What *follows* from the refusal is this group's to settle, and it is
      // task 10.6's question. The file really did change, and a forge serves its
      // patch perfectly well, keyed by the path as a JSON string — so the
      // refusal belongs to this host, and the state recording it has to say so.
      // `contentDeclined` does: nothing is closed, the completion gate blocks on
      // it by name (`harnessCompletion.ts`'s `declinedContent`), and a source
      // that can read the path is still free to serve the member. The two
      // alternatives both fail. `unavailable`, which this answered before, is
      // closed by `markTerminal` — irreversibly, and carried across resume.
      // `excludedByPolicy` is counted as *satisfied* by the completion gate, so
      // the run would report itself complete and clean over changed source
      // nobody read, which is the exact failure this change exists to remove.
      const withNewline = repo.awkwardPathList.find((path) => path.includes('\n'));
      if (withNewline === undefined) return; // Not creatable on this platform.

      const files = await manifest();
      expect(files.get(withNewline)).toMatchObject({ kind: 'modified', binary: false, contentDeclined: true });
      // The flag is about the path rule, not about awkward names: the one with
      // a quote in it is passed to git and read like any other file.
      expect(files.get(repo.awkwardPathList[0] as string)?.contentDeclined).toBeUndefined();
      expect(files.get(repo.paths.modified)?.contentDeclined).toBeUndefined();

      const diff = await source.readDiff({ snapshot, path: withNewline });
      expect(diff.state).toBe('contentDeclined');
      expect(diff.state === 'contentDeclined' ? diff.reason : '').toMatch(/control characters/i);
      // The states `harnessAttempt.ts`'s read switch closes a file on. None of
      // them is this one, which is the whole point of the choice above.
      expect(['binary', 'tooLarge', 'unavailable', 'notFound']).not.toContain(diff.state);

      // `readFile` keeps the refusal, deliberately: it targets repository
      // content rather than the change, no file state anywhere is derived from
      // its result, and a request this source will never make is exactly what
      // `unavailable` means here.
      const read = await source.readFile({ snapshot, revision: 'head', path: withNewline, startLine: 1, endLine: 1 });
      expect(read.state).toBe('unavailable');
      expect(read.state === 'unavailable' ? read.reason : '').toMatch(/control characters/i);
    });

    it('bounds its page and states exactly how many matches were left out', async () => {
      const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.diffSearch.pageBound?.maxPageSize ?? 0;
      const result = await source.searchDiff({ snapshot, query: 'export' });
      expect(result.state).toBe('truncated');
      expect(investigationResultValue(result)).toHaveLength(bound);
      expect(result.state === 'truncated' ? result.knownRemainingUnits : 0).toBeGreaterThan(0);
    });

    it('scopes by path prefix', async () => {
      const result = await source.searchDiff({ snapshot, query: 'export', pathScope: repo.paths.added });
      const paths = new Set((investigationResultValue(result) ?? []).map((match) => match.position.path));
      expect([...paths]).toEqual([repo.paths.added]);
    });
  });

  // ---- 8.6 binary, and what a bound stop is instead ---------------------------------

  describe('binary comes from content, and a bound stop is its own state (task 8.6)', () => {
    it('reports a diff stopped at the output bound as unknown, never as binary and never as too large', async () => {
      const bounded = sourceWith({ maxStdoutBytes: 2048 });
      const result = await bounded.readDiff({ snapshot, path: repo.paths.oversized });
      expect(result.state).toBe('unknown');
      expect(result.state === 'unknown' ? result.reason : '').toMatch(/bound/i);

      // The same file through the same source, unbounded, is ordinary text —
      // so the state above described the invocation and not the content.
      const unbounded = await source.readDiff({ snapshot, path: repo.paths.oversized });
      expect(unbounded.state).toBe('paginated');
    });

    it('reports a manifest stopped at the time bound as unknown, and reports nothing about any file', async () => {
      const bounded = sourceWith({ readTimeoutMs: 1 });
      const result = await bounded.listChangedFiles({ snapshot });
      expect(result.state).toBe('unknown');
      expect(investigationResultValue(result)).toBeUndefined();
    });

    it('never returns tooLarge, because a local diff pages instead of being declined', async () => {
      const states = await Promise.all(
        [repo.paths.oversized, repo.paths.modified, repo.paths.binary, repo.paths.added].map(async (path) => (await source.readDiff({ snapshot, path })).state),
      );
      expect(states).not.toContain('tooLarge');
      expect(states).toEqual(['paginated', 'complete', 'binary', 'complete']);
    });

    it('leaves a bound stop non-terminal: the state it returns is one the harness does not close a file on', async () => {
      // `binary`, `tooLarge`, `unavailable` and `notFound` all reach
      // `markTerminal` in `harnessAttempt.ts`'s read switch, and a file closed
      // that way is closed for the whole run. `unknown` does not, which is why
      // a stop at one of this source's own bounds returns it (design D8).
      const bounded = sourceWith({ maxStdoutBytes: 2048 });
      const result = await bounded.readDiff({ snapshot, path: repo.paths.oversized });
      expect(['binary', 'tooLarge', 'unavailable', 'notFound']).not.toContain(result.state);
    });
  });

  // ---- Pinning ------------------------------------------------------------------------

  describe('the source answers only for the repository and the revisions it was pinned to', () => {
    it('refuses a snapshot naming another repository, before any invocation', async () => {
      const other = { ...snapshot, repoId: 'someone-else/core' };
      const result = await source.listChangedFiles({ snapshot: other });
      expect(result.state).toBe('unavailable');
      expect(result.snapshot).toEqual(other);
      expect(recorded).toEqual([]);
    });

    it('refuses a revision that is not a full object id, and never resolves it as a ref', async () => {
      const named = { ...snapshot, headSha: 'main' };
      const result = await source.listChangedFiles({ snapshot: named });
      expect(result.state).toBe('unavailable');
      expect(result.state === 'unavailable' ? result.reason : '').toMatch(/object id/i);
      expect(recorded).toEqual([]);
    });

    it('reports a well-formed object id this store does not hold as a revision it cannot resolve, not as an empty change', async () => {
      // This answered `unavailable` until task 10.6's pass over the failure
      // paths. `harnessAttempt.ts` closes a `readDiff` that answers `unavailable`
      // with `markTerminal`, which is irreversible and carried into every
      // resumed attempt — so a store that lost its objects would permanently
      // close files that read perfectly the moment it was refetched. Design D8's
      // closing invariant puts an unobtainable revision in the same sentence as
      // a timed-out invocation: both "leave the affected file classified and
      // uninspected".
      const absent = { ...snapshot, headSha: 'f'.repeat(40) };
      const result = await source.listChangedFiles({ snapshot: absent });
      expect(result.state).toBe('unknown');
      expect(result.state === 'unknown' ? result.reason : '').toMatch(/object store/i);
      expect(investigationResultValue(result)).toBeUndefined();
      // It asked whether the commit was there rather than reading git's complaint.
      expect(recorded.map((call) => call.kind)).toContain('verifyCommit');
    });

    it('creates no working tree: the store holds an object database and nothing checked out', async () => {
      await source.listChangedFiles({ snapshot });
      await source.readDiff({ snapshot, path: repo.paths.modified });
      await source.readFile({ snapshot, revision: 'head', path: repo.paths.modified, startLine: 1, endLine: 1 });
      await source.searchRepository({ snapshot, revision: 'head', query: 'RATE' });
      await source.searchDiff({ snapshot, query: 'RATE' });

      expect(existsSync(join(store, 'src'))).toBe(false);
      expect(existsSync(join(store, 'assets'))).toBe(false);
      expect(existsSync(join(store, '.git'))).toBe(false);
      expect(readdirSync(store)).not.toContain('index');
      expect(runGit(repo, ['--git-dir', store, 'config', '--local', 'core.bare']).stdout.trim()).toBe('true');
      // And every invocation ran against that directory, never the fixture's own.
      for (const call of recorded) expect(call.gitDir).toBe(store);
    });
  });

  // ---- A store that loses its objects while an attempt is reading it -----------------

  /**
   * Design D8's closing invariant, at the place it was still broken: "No failure
   * path may call `markTerminal` for a state the source did not prove" — an
   * unobtainable revision is named there alongside a timed-out invocation and a
   * suppressed patch, all three of which must "leave the affected file
   * classified and uninspected".
   *
   * A store is not permanent. Eviction deletes whole repository directories
   * (design D3), an attempt's lease goes stale past `maxAttemptElapsedMs`, and
   * `openCacheRepository` discards and rebuilds a directory whose ownership check
   * fails — any of which can land between one read and the next. The objects are
   * content-addressed and the next acquisition puts them back, so none of it may
   * be answered with a state that closes the file: `harnessAttempt.ts`'s read
   * switch closes a `readDiff` on `binary`, `tooLarge`, `notFound` and
   * `unavailable`, and `markTerminal` is irreversible and carried across resume.
   *
   * The objects directory is emptied rather than deleted, because that is the
   * state being described. Measured on 2026-09-11: with `objects/` present and
   * empty, `git diff --numstat <base>..<head>` exits 128 with "Invalid revision
   * range" and `git rev-parse <sha>^{commit}` exits 128 — a repository that has
   * lost its objects. With `objects/` gone, git stops recognizing the directory
   * as a repository at all and `git diff` exits 129 into its own usage text,
   * which is a different failure and not this one.
   */
  describe('a store that loses its objects mid-attempt (task 10.6)', () => {
    /** The states `updateInventoryFromResult` turns into `markTerminal` for a `readDiff`. */
    const CLOSES_THE_FILE = ['binary', 'tooLarge', 'unavailable', 'notFound'];

    function loseTheObjects(gitDir: string): void {
      rmSync(join(gitDir, 'objects'), { recursive: true, force: true });
      mkdirSync(join(gitDir, 'objects'), { recursive: true });
    }

    it('answers a file it read a moment ago with a state that leaves the file re-readable', async () => {
      const evicted = bareStoreWith(repo, join(repo.root, 'evicted-mid-attempt.git'));
      const from = createLocalGitSource({ gitDir: evicted, repoId: REPO_ID, run: recordingRunner });
      expect((await from.readDiff({ snapshot, path: repo.paths.modified })).state).toBe('complete');

      loseTheObjects(evicted);

      const result = await from.readDiff({ snapshot, path: repo.paths.modified });
      expect(CLOSES_THE_FILE).not.toContain(result.state);
      expect(result.state).toBe('unknown');
      expect(result.state === 'unknown' ? result.reason : '').toMatch(/object store/i);
      // Asked, not inferred from git's complaint.
      expect(recorded.map((call) => call.kind)).toContain('verifyCommit');
    });

    it('does not carry a “the commit is there” answer past the moment it was true', async () => {
      const evicted = bareStoreWith(repo, join(repo.root, 'stale-presence.git'));
      const from = createLocalGitSource({ gitDir: evicted, repoId: REPO_ID, run: recordingRunner });
      // Make it ask about both commits while they are still there — a read of a
      // path that is not in the tree is the cheapest way to reach the question.
      // A source that remembered those answers would still believe them below.
      for (const revision of ['base', 'head'] as const) {
        const absent = await from.readFile({ snapshot, revision, path: 'src/never-existed.ts', startLine: 1, endLine: 1 });
        expect(absent.state).toBe('notFound');
      }

      loseTheObjects(evicted);

      const read = await from.readFile({ snapshot, revision: 'head', path: repo.paths.modified, startLine: 1, endLine: 1 });
      // Remembered, this would be "there is no such path" — an absence nobody
      // established, about a file that is right there in the change.
      expect(read.state).toBe('unknown');
      expect(read.state === 'unknown' ? read.reason : '').toMatch(/object store/i);
    });

    it('does not turn a diff that would not render into a path that is not there', async () => {
      // Both commits resolve and the diff still fails: the shape a store missing
      // one tree or one blob has. That is not something a test can carve
      // reliably out of a packfile, so the failure is forced — everything else,
      // including the two commit checks that decide the answer, is real git.
      const failingDiff: GitRunner = async (plan, context) =>
        plan.kind === 'diffFile'
          ? { state: 'failed', exitCode: 128, reason: 'forced for this test', stderrExcerpt: '', durationMs: 1 }
          : runGitInvocation(plan, context);
      const from = createLocalGitSource({ gitDir: store, repoId: REPO_ID, run: failingDiff });

      const result = await from.readDiff({ snapshot, path: repo.paths.modified });
      expect(CLOSES_THE_FILE).not.toContain(result.state);
      expect(result.state).toBe('unknown');
      // The manifest enumerated this path moments earlier, so `notFound` would
      // claim an absence contradicted by this source's own manifest.
      expect(result.state === 'unknown' ? result.reason : '').toMatch(/could not be read/i);
    });
  });

  // ---- 8.7 the capability declaration ---------------------------------------------------

  describe('the capability declaration (task 8.7)', () => {
    it('declares revision-pinned repository search, and the operation does what the declaration says', async () => {
      expect(LOCAL_GIT_INVESTIGATION_CAPABILITIES.repositorySearch.supported).toBe(true);
      const result = await source.searchRepository({ snapshot, revision: 'head', query: 'RATE' });
      expect(result.state).toBe('complete');
      expect((investigationResultValue(result) ?? []).length).toBeGreaterThan(0);
    });

    it('declares nothing it cannot answer from two commits', () => {
      // A bare object id does not identify the change request a detail request
      // is about, so this declaration has no field for one at all: the two
      // detail reads are the connection's, on `detailRetrieval`.
      expect(Object.keys(LOCAL_GIT_INVESTIGATION_CAPABILITIES).sort()).toEqual(
        ['diffReads', 'diffSearch', 'fileReads', 'manifests', 'pagination', 'repositorySearch'],
      );
      expect(Object.keys(source)).toEqual(['capabilities', 'listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff']);
    });

    it('says the same thing whatever policy the source was built with', () => {
      const tight = createLocalGitSource({ gitDir: store, repoId: REPO_ID, policy: { readTimeoutMs: 1, maxStdoutBytes: 1 } });
      expect(tight.capabilities).toBe(LOCAL_GIT_INVESTIGATION_CAPABILITIES);
      expect(source.capabilities).toBe(LOCAL_GIT_INVESTIGATION_CAPABILITIES);
    });
  });
});

/**
 * The declaration's relationship to the policy that withholds the tool, and to
 * the bounds the dispatcher enforces. Neither needs a repository, so neither is
 * skipped on a machine without git.
 */
describe('the declaration is independent of the policy that withholds the tool (task 8.7)', () => {
  // What a member served by this source actually declares: the source's five,
  // composed with the connection's two detail reads, exactly as
  // `withSourceInvestigation` composes them in `harnessRuntime.ts`.
  const capabilities: MemberCapabilities = {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    reviewInvestigation: {
      ...LOCAL_GIT_INVESTIGATION_CAPABILITIES,
      changeRequestDetails: { supported: true },
      issueDetails: { supported: true },
    },
  };
  const searchTool = HOST_TOOL_DEFINITIONS.find((tool) => tool.name === 'searchRepository');

  it('makes the search tool available on its own terms', () => {
    expect(searchTool).toBeDefined();
    expect(toolCapabilityAvailable(searchTool!, capabilities)).toBe(true);
  });

  it(`is withheld by the reviewer scope, which turns the attempt's capabilities off and leaves the source's declaration alone`, () => {
    // This is the transformation `effectiveCapabilities` in
    // `src/app/harnessRuntime.ts` applies when
    // `scopeInvestigationToChangedFiles` is on. It is unchanged by this task —
    // the assertion below reads it out of that file rather than trusting this
    // copy of it — and what is asserted here is the consequence: the tool goes,
    // the declaration stays.
    const scoped: MemberCapabilities = {
      ...capabilities,
      reviewInvestigation: {
        ...capabilities.reviewInvestigation!,
        fileReads: { ...LOCAL_GIT_INVESTIGATION_CAPABILITIES.fileReads, supported: false },
        repositorySearch: { ...LOCAL_GIT_INVESTIGATION_CAPABILITIES.repositorySearch, supported: false },
      },
    };
    // The default is off now: every read is local, so the cost that justified
    // scoping is gone. A reviewer who wants the narrow behaviour still gets it,
    // and this is that behaviour.
    expect(DEFAULT_HARNESS_POLICY.scopeInvestigationToChangedFiles).toBe(false);
    expect(toolCapabilityAvailable(searchTool!, scoped)).toBe(false);
    expect(LOCAL_GIT_INVESTIGATION_CAPABILITIES.repositorySearch.supported).toBe(true);
  });

  /**
   * Still in `harnessRuntime.ts`, and still exactly one copy of the rule. What
   * moved is where it is applied: the thing declaring the five investigation
   * operations is a source, never a provider, so the reviewer's scoping setting
   * is applied to a source's declaration — once, in
   * `scopeInvestigationCapabilities`. Two copies of "which operations scoping
   * withholds" is the drift this assertion exists to catch, so it follows the
   * rule to the function that holds it.
   */
  it('and that withholding still lives in harnessRuntime, untouched by this change', async () => {
    const { readFileSync } = await import('node:fs');
    const runtime = readFileSync('src/app/harnessRuntime.ts', 'utf8');
    const start = runtime.indexOf('function scopeInvestigationCapabilities');
    expect(start).toBeGreaterThan(0);
    const body = runtime.slice(start, runtime.indexOf('\n}', start));
    expect(body).toContain('scopeInvestigationToChangedFiles');
    expect(body).toContain('repositorySearch');
    expect(body).toContain('supported: false');

    // And selection's narrowing seam is the one caller, so a source's
    // declaration cannot take a different route through the same setting.
    expect(runtime).toContain('narrowCapabilities: (capabilities) => scopeInvestigationCapabilities(capabilities, policy)');
  });

  it('declares page bounds that fit the default harness policy, for every tool that pages', () => {
    const pagingTools = HOST_TOOL_DEFINITIONS.filter((tool) => tool.pageSizePolicyField !== undefined && tool.capability !== undefined);
    for (const tool of pagingTools) {
      if (!toolCapabilityAvailable(tool, capabilities)) continue;
      expect({ tool: tool.name, fits: pageBoundWithinPolicy(capabilities, tool.capability!, DEFAULT_HARNESS_POLICY, tool.pageSizePolicyField!) }).toEqual({
        tool: tool.name,
        fits: true,
      });
      const operation = (LOCAL_GIT_INVESTIGATION_CAPABILITIES as unknown as Record<string, { pageBound?: { maxPageBytes?: number } } | undefined>)[tool.capability!];
      const declared = operation?.pageBound?.maxPageBytes;
      if (declared === undefined) continue;
      expect({ tool: tool.name, declared }).toEqual({
        tool: tool.name,
        declared: Math.min(declared, DEFAULT_HARNESS_POLICY.maxToolResultBytes, DEFAULT_HARNESS_POLICY.diffOrFileReadPageBytes),
      });
    }
  });
});

/**
 * Task 8.9's scale case: the shape of the change this whole proposal was
 * measured against. 207 changed files, all but one of them plain text, served
 * complete, with no entry anywhere carrying the state a forge uses to say it
 * would not render the content.
 */
describe.skipIf(gitVersion === undefined)('a manifest the size of the measured change (task 8.9)', () => {
  let repo: LocalGitFixture;
  let source: InvestigationSource;
  let snapshot: InvestigationSnapshotRef;

  beforeAll(() => {
    // Six changed files from the fixture's own shape plus 201 added modules,
    // which is the 207 of `osirison/code-verdict#66`.
    repo = createTwoCommitRepository({ oversizedDiffLines: 20, extraTextFiles: 201 });
    const store = bareStoreWith(repo, join(repo.root, 'store.git'));
    source = createLocalGitSource({ gitDir: store, repoId: REPO_ID });
    snapshot = { repoId: REPO_ID, baseSha: repo.baseSha, headSha: repo.headSha };
  });

  afterAll(() => repo?.cleanup());

  it('enumerates all 207 entries across its pages, terminates complete, and declines none of them', async () => {
    const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.manifests.pageBound?.maxPageSize ?? 0;
    const seen = new Map<string, boolean>();
    let pages = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const result = await source.listChangedFiles({ snapshot, cursor });
      expect(result.snapshot).toEqual(snapshot);
      const entries = investigationResultValue(result) ?? [];
      expect(entries.length).toBeLessThanOrEqual(bound);
      for (const entry of entries) {
        expect(entry.contentDeclined).toBeUndefined();
        seen.set(entry.path, entry.binary);
      }
      pages += 1;
      if (result.state !== 'paginated') {
        expect(result.state).toBe('complete');
        break;
      }
      cursor = result.cursor;
    }

    expect(seen.size).toBe(207);
    expect(pages).toBe(3);
    // 206 of 207 read as text. The one that does not is the one whose content
    // says so — which is the whole difference from the measured run, where 137
    // readable TypeScript files were reported binary because a response did not
    // carry their patch.
    expect([...seen.entries()].filter(([, binary]) => binary).map(([path]) => path)).toEqual([repo.paths.binary]);
    for (const path of repo.extraTextFilePaths) expect(seen.get(path)).toBe(false);
  });
});
