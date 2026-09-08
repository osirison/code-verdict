/**
 * The measurement this whole change exists for, asserted on both paths — task
 * 10.5 of `add-local-git-investigation`.
 *
 * Measured against `osirison/code-verdict#66` on 2026-09-10: 207 changed
 * files, every one of them plain TypeScript.
 *
 * | source                            | usable diff | classified binary |
 * | --------------------------------- | ----------- | ----------------- |
 * | GitHub compare API (the old path) | 69 of 207   | **137**           |
 * | local git over the same commits   | **207**     | **0**             |
 *
 * The local source must serve all 207 with nothing reported binary. The
 * provider half of the comparison is now a structural claim rather than a
 * behavioural one — see the second describe below — because the provider has no
 * operation left that could enumerate or read a change at all.
 *
 * **Why this file sits under `src/providers/`.** Only files in this directory
 * may import a concrete provider (`eslint.config.mjs`), and half of what is
 * asserted here is that the real GitHub provider maps the real response shape
 * the way the change says it does. The other half imports `src/localgit`,
 * which nothing forbids.
 *
 * The repository is real and built locally, for the reason
 * `src/testing/localGitRepository.ts` gives at length: every claim below is a
 * claim about what git does with two commits, and a recorded fixture would
 * stop testing that the moment it stopped being git.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { investigationResultValue, type InvestigationSnapshotRef, type InvestigationSource } from '../../platform/types';
import { createLocalGitSource } from '../../localgit/localGitSource';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../../testing/localGitRepository';
import { createGitHubProvider } from './githubProvider';

const REPO_ID = 'osirison/code-verdict';
const MEASURED_FILE_COUNT = 207;

const gitVersion = gitExecutableVersion();

/**
 * The fixture's own five changed entries — a modification, an addition, a
 * deletion, a rename and an oversized text file — plus 202 ordinary modules,
 * with the fixture's binary file left out so the change really is all text.
 */
const EXTRA_TEXT_FILES = MEASURED_FILE_COUNT - 5;

describe.skipIf(gitVersion === undefined)('the measured change, served by the local source (task 10.5)', () => {
  let repo: LocalGitFixture;
  let source: InvestigationSource;
  let snapshot: InvestigationSnapshotRef;
  /** Every path the local manifest enumerated, in its own order — the list the provider half is then handed. */
  let paths: string[];

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 20, extraTextFiles: EXTRA_TEXT_FILES, omitBinaryFile: true });
    const store = `${repo.root}/measured-store.git`;
    const init = runGit(repo, ['init', '--bare', '--quiet', store]);
    if (init.status !== 0) throw new Error(`could not create the store: ${init.stderr}`);
    const push = runGit(repo, [
      'push',
      '--quiet',
      store,
      `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`,
      `${repo.headSha}:refs/codeverdict/${repo.headSha}`,
    ]);
    if (push.status !== 0) throw new Error(`could not fill the store: ${push.stderr}`);

    source = createLocalGitSource({ gitDir: store, repoId: REPO_ID });
    snapshot = { repoId: REPO_ID, baseSha: repo.baseSha, headSha: repo.headSha };
    paths = [];
  });

  afterAll(() => repo?.cleanup());

  it(`enumerates all ${String(MEASURED_FILE_COUNT)} files, terminates complete, and reports zero of them binary`, async () => {
    let cursor: string | undefined;
    let pages = 0;
    let terminal = '';
    for (let page = 0; page < 50; page += 1) {
      const result = await source.listChangedFiles({ snapshot, cursor });
      expect(result.snapshot).toEqual(snapshot);
      for (const entry of investigationResultValue(result) ?? []) {
        paths.push(entry.path);
        // The two assertions the whole change is for, made per entry rather
        // than in aggregate so a failure names the file.
        expect({ path: entry.path, binary: entry.binary }).toEqual({ path: entry.path, binary: false });
        expect(entry.contentDeclined).toBeUndefined();
      }
      pages += 1;
      terminal = result.state;
      if (result.state !== 'paginated') break;
      cursor = result.cursor;
    }

    expect(paths).toHaveLength(MEASURED_FILE_COUNT);
    expect(new Set(paths).size).toBe(MEASURED_FILE_COUNT);
    expect(terminal).toBe('complete');
    expect(pages).toBeGreaterThan(1);
  });

  it('serves a readable diff for every one of them, which is the 207-of-207 the proposal measured', async () => {
    expect(paths).toHaveLength(MEASURED_FILE_COUNT);
    const unreadable: { path: string; state: string }[] = [];
    for (const path of paths) {
      const result = await source.readDiff({ snapshot, path });
      // `paginated` counts: the oversized file's diff is larger than one page,
      // and a first page with a continuation is a diff that was served.
      if (result.state !== 'complete' && result.state !== 'paginated') unreadable.push({ path, state: result.state });
    }
    expect(unreadable).toEqual([]);
  });
});

/**
 * The other half of the measurement, and what is left of it.
 *
 * It used to read the same 207-file response through the GitHub provider and
 * assert two things: that the 137 came back as content the platform declined
 * rather than as binary, and that the change was therefore unservable by that
 * provider. Neither assertion has a subject any more. The provider answers no
 * manifest, so there is nothing to map; there is no serviceability check,
 * because "could the forge serve this change" is not a question anyone asks
 * once every review reads from git.
 *
 * What replaces it is the structural fact that makes the whole comparison moot:
 * this provider cannot be asked. The 137 files were written off because the
 * host asked a forge to compute a diff; the fix is not a better mapping of the
 * answer, it is not asking.
 */
describe('the same change is no longer askable of the provider (task 10.5)', () => {
  it('defines no operation that could enumerate or read this change', () => {
    const connection = createGitHubProvider().connect({
      instanceUrl: 'https://github.com',
      credential: { kind: 'token', token: 'ghp-test' },
    }) as unknown as Record<string, unknown>;
    for (const operation of ['listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff']) {
      expect(connection[operation], `${operation} would be a second route to the 137 written-off files`).toBeUndefined();
    }
    expect('reviewInvestigation' in createGitHubProvider().capabilities).toBe(false);
  });
});
