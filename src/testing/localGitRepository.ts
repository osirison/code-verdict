/**
 * A real, disposable, two-commit git repository for tests — task 1.4 of
 * `add-local-git-investigation`.
 *
 * **Why a real repository and not a recorded fixture.** A recording can only
 * prove that we parse bytes we wrote down earlier. Everything groups 6-8 have
 * to establish is a fact about git itself, and none of it survives being
 * transcribed:
 *
 * - `-M` detects a rename only if git's own similarity detection says so.
 * - Binary is git's content determination, not a filename rule — the whole
 *   point of the change is that nobody else's guess is allowed to stand in
 *   for it.
 * - `-z` framing, and whether a path with a quote or a newline in it
 *   desynchronizes parsing, is a property of git's output, not of ours.
 * - The adversarial cases (6.10-6.13) are assertions about what git does with
 *   `--output=…` before and after `--`. A recording of the safe case cannot
 *   fail when the unsafe one is introduced, which makes it worthless as a
 *   guard.
 *
 * The measurement this whole change rests on is what git answered for two real
 * commits. A fixture that stopped being git would quietly stop testing that.
 *
 * **No network, and nothing outside the temporary directory.** The repository
 * is built locally from files this module writes, under `os.tmpdir()`, and has
 * no remote. Nothing here reads or writes the repository this project lives
 * in.
 *
 * **The environment is constructed, not inherited** — the same rule design D7
 * puts on the production invocation builder, applied here for a different
 * reason: a machine whose `~/.gitconfig` sets `commit.gpgsign = true` would
 * otherwise hang the suite waiting on a passphrase nobody can see, and one
 * with no `user.email` would fail every commit. `GIT_CONFIG_GLOBAL` and
 * `GIT_CONFIG_SYSTEM` point at an empty file this module creates, identity and
 * timestamps come from `GIT_*` variables, and `LC_ALL=C` keeps git's own text
 * stable. Only `PATH` is inherited, because it is how git is found at all.
 *
 * Fixed identity plus fixed timestamps make the commit ids deterministic:
 * two builds of the same fixture produce the same two shas. That is a property
 * worth having and `localGitRepository.test.ts` asserts it, rather than this
 * file hard-coding two hex literals a git version could one day invalidate.
 *
 * This is the first module in `src/` to spawn a child process at all. It is
 * test-only, reached from no production path, and it is not the invocation
 * builder task 6.1 describes — that one is production code with validation,
 * timeouts and output caps this deliberately does not duplicate.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every changed path in the fixture, by the kind of change it demonstrates. */
export interface LocalGitFixturePaths {
  /** Text, present in both commits, edited in the second. */
  readonly modified: string;
  /** Text, absent from the base commit. */
  readonly added: string;
  /** Text, absent from the head commit. */
  readonly deleted: string;
  /** Renamed with byte-identical content, so detection is an exact match rather than a similarity judgement. */
  readonly renamedFrom: string;
  readonly renamedTo: string;
  /** Contains NUL bytes in both commits, and different ones in each — git decides this from the content. */
  readonly binary: string;
  /** Text, and its diff alone is larger than the read bound. */
  readonly oversized: string;
}

export interface LocalGitFixture {
  /** The repository itself — a normal repository with a working tree, and no remote. */
  readonly dir: string;
  /** The temporary root `cleanup` removes; holds `dir` and the empty git config. */
  readonly root: string;
  readonly baseSha: string;
  readonly headSha: string;
  /**
   * The branch a change request built on this fixture would target, pointing at
   * `baseSha`. It is what acquisition computes the merge base against, so
   * `git merge-base <headSha> <targetRef>` is exactly `baseSha`.
   */
  readonly targetRef: string;
  readonly paths: LocalGitFixturePaths;
  /** How many added lines the oversized file's diff carries. */
  readonly oversizedDiffLines: number;
  /** The bulk text files added in the head commit, in the order they were written; empty unless `extraTextFiles` asked for them. */
  readonly extraTextFilePaths: readonly string[];
  /** The files whose names carry a quote or a newline; empty unless `awkwardPaths` asked for them. */
  readonly awkwardPathList: readonly string[];
  /** The text file whose first NUL byte sits past git's own binary window; present only when `lateNulTextFile` asked for it. */
  readonly lateNulTextPath?: string;
  /** The sanitized environment the repository was built with, so a caller reads it the same way it was written. */
  readonly env: Readonly<Record<string, string>>;
  cleanup(): void;
}

export interface LocalGitFixtureOptions {
  /**
   * Lines added to the oversized file, injected rather than fixed: design
   * "Configurable Initial Defaults" says bounds are policy values and tests
   * bring their own. The default clears the largest read bound the providers
   * declare today (20,000 lines / 256 KiB per page) on both counts at once.
   */
  readonly oversizedDiffLines?: number;
  /**
   * Ordinary text files added in the head commit, on top of the six files
   * above — for the one thing the six cannot demonstrate: a manifest the size
   * of the change this whole proposal was measured against.
   *
   * That change is 207 files, all plain TypeScript, of which GitHub's compare
   * response declined to render 137. Tasks 8.9 and 10.5 both assert over a
   * manifest of that size, so the option lives here rather than being built
   * twice in two test files.
   *
   * Defaults to 0, which is what keeps every existing caller — and the two
   * commit ids `localGitRepository.test.ts` pins as deterministic —
   * byte-identical to before this option existed.
   */
  readonly extraTextFiles?: number;
  /**
   * Add text files whose *names* are the reason every read in this source is
   * `-z` framed: one containing a double quote, and — off Windows, where the
   * character is not legal in a filename — one containing a newline.
   *
   * Both are ordinary repository paths git stores happily, and both break a
   * reader that frames records by lines or trusts git's unquoted output.
   * Measured: without `-z`, `git diff --name-status` reports the first as
   * `"src/we\"ird.ts"` — a different string from the path, so a manifest entry
   * keyed on it matches nothing — and the second as two lines, which
   * desynchronizes every record after it.
   *
   * Defaults to false, so the two commit ids `localGitRepository.test.ts` pins
   * as deterministic, and the exact record list it asserts, are unchanged.
   */
  readonly awkwardPaths?: boolean;
  /**
   * Leave the binary file out of both commits, so every changed file in the
   * fixture is plain text.
   *
   * There is exactly one thing this is for: task 10.5's assurance case is the
   * measured change itself — 207 files, every one of them plain TypeScript,
   * which the forge reported 137 of as binary. "Zero files reported binary"
   * cannot be asserted over a fixture that contains a real image, and dropping
   * the image from the assertion instead would weaken the very claim the test
   * exists to make.
   *
   * `paths.binary` still names the path; with this option no commit contains
   * it. Defaults to false, so every existing caller — and the two commit ids
   * `localGitRepository.test.ts` pins as deterministic — is unchanged.
   */
  readonly omitBinaryFile?: boolean;
  /**
   * Add a text file whose first NUL byte sits *past* the first 8000 bytes.
   *
   * That number is git's own: `buffer_is_binary()` looks for a NUL in the first
   * 8000 bytes of a blob and nowhere else, so this file is text to git — measured
   * on 2026-09-11, `--numstat` reports `121\t0` for it and its patch is an
   * ordinary one — while a reader that scanned the whole buffer would call it
   * binary. There is no way to tell those two rules apart without a file that
   * falls between them, which is what this is.
   *
   * Defaults to false, so no existing fixture gains a seventh changed file.
   */
  readonly lateNulTextFile?: boolean;
}

const PATHS: LocalGitFixturePaths = {
  modified: 'src/kept.ts',
  added: 'src/added.ts',
  deleted: 'src/gone.ts',
  renamedFrom: 'src/renamed-old.ts',
  renamedTo: 'src/renamed-new.ts',
  binary: 'assets/logo.png',
  oversized: 'src/generated/table.ts',
};

const DEFAULT_OVERSIZED_DIFF_LINES = 20_001;

/** Byte-identical across the rename, so `-M` reports a 100% match and not a rewrite. */
/** The branch left at the base commit, so a merge base computed against it is the base. */
const TARGET_BRANCH = 'target';

const RENAMED_CONTENT = 'export function limit(tenant: string): number {\n  return 100;\n}\n';

export interface GitInvocation {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The git version on this machine, or `undefined` when there is no git to ask.
 *
 * A test that needs a repository calls this first and skips itself when it
 * answers `undefined`. Skipping is the honest outcome: a machine without git
 * cannot run the local source either, and design D8 gives that case its own
 * state rather than a failure.
 */
export function gitExecutableVersion(): string | undefined {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) return undefined;
    return probe.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs git inside a fixture with that fixture's own environment. Arguments are
 * an array and there is no shell anywhere in this module — the same structural
 * rule design D7 puts on the production builder, honoured here so a test
 * cannot demonstrate safe behavior through an unsafe helper.
 */
export function runGit(fixture: Pick<LocalGitFixture, 'dir' | 'env'>, args: readonly string[]): GitInvocation {
  const result = spawnSync('git', [...args], { cwd: fixture.dir, env: { ...fixture.env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function write(dir: string, relativePath: string, content: string | Uint8Array): void {
  const full = join(dir, relativePath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

function generatedTable(lines: number): string {
  const rows: string[] = [];
  for (let i = 1; i <= lines; i += 1) rows.push(`export const ROW_${String(i).padStart(6, '0')} = 'generated row ${i}';`);
  return `${rows.join('\n')}\n`;
}

/**
 * A PNG-shaped byte string: the real 8-byte signature (which starts with a
 * NUL-adjacent high byte and contains a NUL in the IHDR length that follows)
 * plus payload bytes including NUL, so git's own content check reports binary
 * for the reason it would report it for a real image.
 */
function binaryBytes(seed: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const payload: number[] = [];
  for (let i = 0; i < 64; i += 1) payload.push((i * seed) % 256);
  return Uint8Array.from([...signature, 0x00, 0x00, 0x00, 0x0d, ...payload, 0x00]);
}

/**
 * 9,606 bytes: 120 lines of 80 bytes, then a NUL, then one more line. The NUL
 * lands at byte 9,600, which is past the 8,000-byte window git looks in.
 */
function lateNulContent(): string {
  const line = `${'x'.repeat(79)}\n`;
  return `${line.repeat(120)}${String.fromCharCode(0)}tail\n`;
}

/** Where the bulk files live, so they cannot collide with any of the six named paths. */
function extraTextFilePath(index: number): string {
  return `src/bulk/module-${String(index).padStart(6, '0')}.ts`;
}

export function createTwoCommitRepository(options: LocalGitFixtureOptions = {}): LocalGitFixture {
  const oversizedDiffLines = options.oversizedDiffLines ?? DEFAULT_OVERSIZED_DIFF_LINES;
  const extraTextFilePaths: string[] = [];
  for (let i = 1; i <= (options.extraTextFiles ?? 0); i += 1) extraTextFilePaths.push(extraTextFilePath(i));
  const lateNulTextPath = options.lateNulTextFile === true ? 'src/late-nul.ts' : undefined;
  const awkwardPathList: string[] = [];
  if (options.awkwardPaths) {
    awkwardPathList.push('src/we"ird.ts');
    // A newline is legal in a path on POSIX and refused by the Windows
    // filesystem, so the harder of the two cases is added only where it can
    // exist at all, and `awkwardPathList` states which ones really were made
    // rather than leaving a caller to work it out.
    if (process.platform !== 'win32') awkwardPathList.push('src/two\nlines.ts');
  }
  const root = mkdtempSync(join(tmpdir(), 'code-verdict-git-'));
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });

  // An existing but empty file, rather than a path that does not exist: git
  // accepts both, and a real empty file is the version that cannot be
  // mistaken for a misconfiguration while reading the fixture.
  const emptyConfig = join(root, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'Code Verdict Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@code-verdict.invalid',
    GIT_COMMITTER_NAME: 'Code Verdict Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@code-verdict.invalid',
  };
  function git(args: readonly string[], extraEnv: Record<string, string> = {}): string {
    const result = spawnSync('git', [...args], { cwd: dir, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    if (result.error) throw result.error;
    if ((result.status ?? -1) !== 0) {
      throw new Error(`git ${args.join(' ')} failed (${String(result.status)}): ${(result.stderr ?? '').trim()}`);
    }
    return (result.stdout ?? '').trim();
  }

  function commit(message: string, isoDate: string): string {
    git(['add', '--all']);
    git(['commit', '-m', message], { GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate });
    return git(['rev-parse', 'HEAD']);
  }

  try {
    // `-b main` because the default branch name is otherwise a config value,
    // and config is exactly what this fixture refuses to read.
    git(['init', '-b', 'main']);

    write(dir, PATHS.modified, 'export const RATE = 100;\n');
    write(dir, PATHS.deleted, 'export const LEGACY = true;\n');
    write(dir, PATHS.renamedFrom, RENAMED_CONTENT);
    // Deliberately shares no line with the head revision's version: if the
    // two had a common first line the diff would carry one fewer addition
    // than `oversizedDiffLines` says, and a bound test set exactly at the
    // limit would pass for the wrong reason.
    write(dir, PATHS.oversized, 'export const ROWS: readonly string[] = [];\n');
    if (!options.omitBinaryFile) write(dir, PATHS.binary, binaryBytes(3));
    for (const path of awkwardPathList) write(dir, path, 'export const AWKWARD = 1;\n');
    const baseSha = commit('base', '2026-09-10T00:00:00+00:00');

    write(dir, PATHS.modified, 'export const RATE = 250;\nexport const BURST = 10;\n');
    write(dir, PATHS.added, 'export function reset(): void {}\n');
    rmSync(join(dir, PATHS.deleted));
    rmSync(join(dir, PATHS.renamedFrom));
    write(dir, PATHS.renamedTo, RENAMED_CONTENT);
    write(dir, PATHS.oversized, generatedTable(oversizedDiffLines));
    if (!options.omitBinaryFile) write(dir, PATHS.binary, binaryBytes(7));
    // Each one differs from the others, so a manifest cannot pass a test by
    // reporting the same entry N times, and every one of them is plain text
    // with no NUL anywhere: the point they exist to make is that a source
    // reading the content reports zero of them as binary.
    for (const [index, path] of extraTextFilePaths.entries()) {
      write(dir, path, `export const MODULE_${String(index + 1)} = 'bulk module ${String(index + 1)}';\n`);
    }
    for (const path of awkwardPathList) write(dir, path, 'export const AWKWARD = 2;\n');
    if (lateNulTextPath) write(dir, lateNulTextPath, lateNulContent());
    const headSha = commit('head', '2026-09-10T00:01:00+00:00');
    // The branch a change request built on this fixture would target, left
    // pointing at the base commit. Acquisition computes the merge base itself
    // now — `git merge-base <head> <target>` — so a fixture with no branch
    // behind the head has nothing for it to compute against, and a fixture
    // whose only branch is at the head computes the head. Naming it separately
    // from `main` keeps `main` where every existing case expects it. Creating a
    // branch writes no commit, so the two commit ids stay deterministic.
    git(['branch', TARGET_BRANCH, baseSha]);

    return {
      dir,
      root,
      baseSha,
      headSha,
      targetRef: `refs/heads/${TARGET_BRANCH}`,
      paths: PATHS,
      oversizedDiffLines,
      extraTextFilePaths,
      awkwardPathList,
      ...(lateNulTextPath === undefined ? {} : { lateNulTextPath }),
      env,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
  } catch (e) {
    rmSync(root, { recursive: true, force: true });
    throw e;
  }
}
