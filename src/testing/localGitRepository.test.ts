/**
 * Proves the two-commit fixture (task 1.4 of `add-local-git-investigation`) is
 * what the later task groups will assume it is, and proves it against real
 * git rather than against this module's intentions.
 *
 * Every assertion here is about git's answer, not ours: which kinds it
 * reports, that it calls the rename a rename, that it calls the binary file
 * binary from its content, and that the oversized file's diff really does
 * exceed the read bound. Those are the facts groups 6-8 build on, and this is
 * where they stop being claims.
 *
 * The whole file skips when there is no git on the machine. That is the same
 * answer design D8 gives the local source itself — no git means the source is
 * unsupported, not that something failed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from './localGitRepository';

const gitVersion = gitExecutableVersion();

/** Small on purpose: the bound this exercises is injected, so nothing here needs 20,000 real lines. */
const OVERSIZED_LINES = 40;
const READ_BOUND_LINES = 25;

describe.skipIf(gitVersion === undefined)('the two-commit local repository fixture', () => {
  let repo: LocalGitFixture;

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: OVERSIZED_LINES });
  });

  afterAll(() => {
    repo?.cleanup();
  });

  it('is a repository with two commits and no remote, under the system temporary directory', () => {
    expect(repo.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(repo.baseSha).not.toBe(repo.headSha);
    // Nothing to fetch from and nothing to push to: the fixture is entirely local.
    expect(runGit(repo, ['remote']).stdout.trim()).toBe('');
    expect(runGit(repo, ['rev-list', '--count', repo.headSha]).stdout.trim()).toBe('2');
  });

  it('reports all five change kinds between the pinned pair, and the rename as an exact rename', () => {
    const status = runGit(repo, ['diff', '--name-status', '-z', '-M', `${repo.baseSha}..${repo.headSha}`]);
    expect(status.status).toBe(0);
    const fields = status.stdout.split('\0').filter((field) => field !== '');
    // NUL-delimited, `<status>\0<path>` per entry and `<status>\0<old>\0<new>`
    // for a rename — the framing the local source will parse.
    expect(fields).toEqual([
      'M', repo.paths.binary,
      'A', repo.paths.added,
      'M', repo.paths.oversized,
      'D', repo.paths.deleted,
      'M', repo.paths.modified,
      'R100', repo.paths.renamedFrom, repo.paths.renamedTo,
    ]);
  });

  it('reports the binary file as binary from its content, with no line counts to give', () => {
    const numstat = runGit(repo, ['diff', '--numstat', '-z', '-M', `${repo.baseSha}..${repo.headSha}`]);
    const records = numstat.stdout.split('\0').filter((field) => field !== '');
    // `-` for both counts is git saying it cannot count line changes in this
    // content. This is the determination GitHub's compare response never makes
    // and `isBinaryCompareFile` guesses at.
    expect(records.slice(0, 1)).toEqual([`-\t-\t${repo.paths.binary}`]);
    expect(runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.binary]).stdout).toContain('Binary files');
  });

  it('counts real line changes for every text file, including the renamed one', () => {
    const numstat = runGit(repo, ['diff', '--numstat', '-z', '-M', `${repo.baseSha}..${repo.headSha}`]);
    const counts = new Map<string, string>();
    for (const record of numstat.stdout.split('\0').filter((field) => field !== '')) {
      const [added, removed, path] = record.split('\t');
      if (path !== undefined && path !== '') counts.set(path, `${added}/${removed}`);
    }
    expect(counts.get(repo.paths.added)).toBe('1/0');
    expect(counts.get(repo.paths.deleted)).toBe('0/1');
    expect(counts.get(repo.paths.modified)).toBe('2/1');
    expect(counts.get(repo.paths.oversized)).toBe(`${OVERSIZED_LINES}/1`);
  });

  it('gives the oversized text file a diff larger than the read bound, and the others one well under it', () => {
    const oversized = runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.oversized]);
    expect(oversized.stdout.split('\n').length).toBeGreaterThan(READ_BOUND_LINES);
    const small = runGit(repo, ['diff', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.modified]);
    expect(small.stdout.split('\n').length).toBeLessThan(READ_BOUND_LINES);
  });

  it('reads a deleted file at the base revision and an added file at the head revision', () => {
    // The two reads no forge endpoint answers well: content at a revision the
    // path no longer exists at, and content at a revision it did not yet.
    expect(runGit(repo, ['show', `${repo.baseSha}:${repo.paths.deleted}`]).stdout).toContain('LEGACY');
    expect(runGit(repo, ['show', `${repo.headSha}:${repo.paths.added}`]).stdout).toContain('reset');
    expect(runGit(repo, ['show', `${repo.headSha}:${repo.paths.deleted}`]).status).not.toBe(0);
  });

  it('builds the same two commit ids every time, so a test may pin them', () => {
    const second = createTwoCommitRepository({ oversizedDiffLines: OVERSIZED_LINES });
    try {
      expect(second.baseSha).toBe(repo.baseSha);
      expect(second.headSha).toBe(repo.headSha);
      expect(second.dir).not.toBe(repo.dir);
    } finally {
      second.cleanup();
    }
  });

  it('changes the head commit when the injected bound changes, so two sizes are two fixtures', () => {
    const larger = createTwoCommitRepository({ oversizedDiffLines: OVERSIZED_LINES + 1 });
    try {
      expect(larger.baseSha).toBe(repo.baseSha);
      expect(larger.headSha).not.toBe(repo.headSha);
    } finally {
      larger.cleanup();
    }
  });
});
