/**
 * The git process seam — tasks 6.1 through 6.9 and 6.19 of
 * `add-local-git-investigation`.
 *
 * What is asserted here is the builder's own behavior: which arguments each
 * operation produces, what it refuses before git ever runs, what environment
 * the child is given, and what the version probe answers. The tests that prove
 * a guard by *removing* it — argument injection, pattern injection, pathspec
 * magic, the marker sinks, hostile machine configuration and prompts — live in
 * `gitInvocation.adversarial.test.ts`, and the two that read this module's own
 * syntax tree live in `gitInvocation.structural.test.ts`.
 *
 * Every test that runs git runs the real one, against the real two-commit
 * repository from `../testing/localGitRepository.ts`. Nothing here is recorded:
 * the whole point of this change is that git's answer, not a transcription of
 * it, is what a review sees.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_GIT_BOUNDS,
  MINIMUM_GIT_VERSION,
  gitProcessArguments,
  gitProcessEnvironment,
  isFullObjectId,
  localRefForCommit,
  meetsMinimumGitVersion,
  parseGitVersion,
  planGitInvocation,
  probeGitSupport,
  refusePath,
  refuseQuery,
  resetGitSupportProbe,
  runGitInvocation,
  type GitInvocationPlan,
  type GitOperation,
  type GitProcessContext,
} from './gitInvocation';
import { createTwoCommitRepository, gitExecutableVersion, type LocalGitFixture } from '../testing/localGitRepository';

const gitVersion = gitExecutableVersion();

const BASE = '4a48144a31f4129d1b927ea1383424668fc5290c';
const HEAD = '13e93bc982dbb8072d2f5f6fdb47e7654914399e';
const SHA256 = 'a'.repeat(64);

/** Unwraps a plan, failing the test rather than silently skipping its assertions. */
function planned(operation: GitOperation): GitInvocationPlan {
  const result = planGitInvocation(operation);
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.refusal.code}`);
  return result.plan;
}

function argumentsFor(operation: GitOperation, context: GitProcessContext = {}): readonly string[] {
  return gitProcessArguments(planned(operation), context);
}

describe('revisions are full object ids and nothing else (task 6.3)', () => {
  it('accepts a 40-character and a 64-character lowercase hex id', () => {
    expect(isFullObjectId(BASE)).toBe(true);
    expect(isFullObjectId(SHA256)).toBe(true);
  });

  it('refuses ref names, abbreviations, uppercase and near-misses', () => {
    for (const revision of ['main', 'HEAD', 'v1.2.3', BASE.slice(0, 12), BASE.toUpperCase(), `${BASE}0`, '', 'refs/heads/main']) {
      expect(isFullObjectId(revision)).toBe(false);
    }
  });

  it('refuses a non-id revision from every operation that takes one, with this module’s own reason', () => {
    const operations: GitOperation[] = [
      { kind: 'verifyCommit', revision: 'main' },
      { kind: 'fetchCommit', fetchUrl: 'https://example.invalid/r.git', commit: 'main', depth: 1 },
      { kind: 'changedFiles', base: 'main', head: HEAD },
      { kind: 'changedFiles', base: BASE, head: 'main' },
      { kind: 'diffFile', base: 'main', head: HEAD, path: 'src/a.ts' },
      { kind: 'searchDiff', base: BASE, head: 'main' },
      { kind: 'fileAtRevision', revision: 'main', path: 'src/a.ts' },
      { kind: 'searchRepository', revision: 'main', query: 'rate' },
      { kind: 'parentlessCommitsAbove', head: 'main', candidate: BASE },
      { kind: 'parentlessCommitsAbove', head: HEAD, candidate: 'main' },
      { kind: 'readCommitObject', commit: 'main' },
    ];
    for (const operation of operations) {
      const result = planGitInvocation(operation);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.refusal.code).toBe('revisionNotObjectId');
      expect(result.refusal.reason).toContain('object id');
      // Not git's text: git would have said `fatal: ambiguous argument 'main'`.
      expect(result.refusal.reason).not.toContain('fatal');
    }
  });

  /**
   * The fixture provider's harness fixtures pin revisions by *name* —
   * `small-base-1`, `huge-base-1`, `declined-base-1` — and they stay valid
   * exactly as they are. Nothing tightened here reaches them: the validator is
   * scoped to this seam, and the fixture provider reports no object source at
   * all (`fixtureProvider.getObjectSource` answers `unavailable`), so design
   * D5's selection never picks the local source for a fixture pod and no
   * fixture revision ever arrives at a git argument. This test records that as
   * a checked fact rather than a claim in a comment.
   */
  it('refuses the fixture provider’s revision names, which is why the local source is never selected for a fixture pod', () => {
    for (const revision of ['small-base-1', 'small-head-1', 'huge-base-1', 'declined-base-1']) {
      expect(isFullObjectId(revision)).toBe(false);
    }
  });
});

describe('paths are refused before git sees them (task 6.4)', () => {
  const refusals: ReadonlyArray<{ path: string; why: string }> = [
    { path: '/etc/passwd', why: 'absolute' },
    { path: 'C:/Windows/win.ini', why: 'drive letter' },
    { path: 'C:\\Windows\\win.ini', why: 'drive letter with backslashes' },
    { path: '\\\\host\\share\\file.ts', why: 'UNC prefix' },
    { path: '../outside.ts', why: 'parent component' },
    { path: 'src/../../outside.ts', why: 'parent component in the middle' },
    { path: './src/a.ts', why: 'current-directory component' },
    { path: 'src//a.ts', why: 'empty component' },
    { path: 'src/a.ts/', why: 'trailing separator' },
    { path: '--output=/tmp/pwned.txt', why: 'leading dash' },
    { path: '-rf', why: 'leading dash' },
    { path: '', why: 'empty' },
    { path: `src/${'a'.repeat(5000)}.ts`, why: 'longer than the bound' },
  ];

  it.each(refusals)('refuses $why', ({ path }) => {
    const refusal = refusePath(path);
    expect(refusal).toBeDefined();
    expect(refusal?.reason).toBeTruthy();
  });

  it('refuses a path carrying a NUL or another control byte, before Node can throw its own error', () => {
    // Measured: `spawn` with a NUL in an argument throws
    // `ERR_INVALID_ARG_VALUE: The argument 'args[2]' must be a string without
    // null bytes`. An uncaught TypeError from Node is precisely the raw
    // platform text this refusal exists to replace.
    const nul = String.fromCharCode(0);
    const bell = String.fromCharCode(7);
    for (const path of [`src/a${nul}b.ts`, `src/a${bell}b.ts`]) {
      expect(refusePath(path)?.code).toBe('pathNotRepositoryRelative');
    }
  });

  it('accepts the ordinary repository-relative paths a review actually asks for', () => {
    for (const path of ['src/a.ts', 'a.ts', 'src/deep/nested/file.tsx', 'src/with space.ts', 'src/uni-Ω.ts', ':weird.ts']) {
      expect(refusePath(path)).toBeUndefined();
    }
  });

  it('states the rule and never quotes the value back', () => {
    const refusal = refusePath('/etc/passwd');
    expect(refusal?.reason).toContain('relative to the repository root');
    // The reason is a record that travels: quoting an unbounded model-supplied
    // value into it is what the marker-string convention exists to prevent.
    expect(refusal?.reason).not.toContain('/etc/passwd');
  });

  it('refuses the whole operation when any one of several paths is bad', () => {
    const result = planGitInvocation({ kind: 'changedFiles', base: BASE, head: HEAD, paths: ['src/a.ts', '../escape.ts'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('pathNotRepositoryRelative');
  });
});

describe('queries are refused before git sees them (tasks 6.4, 6.11)', () => {
  it('refuses an empty query, a control byte and a query past the byte bound', () => {
    expect(refuseQuery('')?.code).toBe('queryEmpty');
    expect(refuseQuery('   ')?.code).toBe('queryEmpty');
    expect(refuseQuery(`rate${String.fromCharCode(0)}limit`)?.code).toBe('queryControlBytes');
    // Measured: a 300,000-byte argument fails the invocation with `E2BIG`, a
    // raw errno for a caller that asked an ordinary question.
    expect(refuseQuery('x'.repeat(5000))?.code).toBe('queryTooLong');
  });

  it('accepts a query that looks like an option, because placement is what makes it safe', () => {
    expect(refuseQuery('-v')).toBeUndefined();
    expect(refuseQuery('--output=/tmp/pwned.txt')).toBeUndefined();
  });
});

describe('the arguments each operation produces (tasks 6.1, 6.2, 6.8)', () => {
  it('puts the shared prefix in front of every repository operation', () => {
    const args = argumentsFor({ kind: 'changedFiles', base: BASE, head: HEAD });
    // The whole prefix, not its first few entries: these `-c` pins are the only
    // thing standing between the repository's own config and the answer, since
    // the environment closes the machine's configuration files and reaches
    // `$GIT_DIR/config` not at all. Asserting a slice would let one be deleted
    // without a test noticing. Each is measured in `commonArguments`.
    expect(args.slice(0, 19)).toEqual([
      '--literal-pathspecs',
      '-c',
      'credential.helper=',
      '-c',
      'core.askPass=',
      '-c',
      'core.quotePath=false',
      '-c',
      'gc.auto=0',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'core.bigFileThreshold=512m',
      '-c',
      'diff.noprefix=false',
      '-c',
      'grep.column=false',
    ]);
  });

  it('asks for the parentless commits above a candidate merge base, with the exclusion in the revision grammar', () => {
    const args = argumentsFor({ kind: 'parentlessCommitsAbove', head: HEAD, candidate: BASE });
    // `--not` is an option and would arrive as a revision after
    // `--end-of-options`; `^` is part of the revision grammar and survives it.
    expect(args.slice(-6)).toEqual(['rev-list', '--max-parents=0', '--end-of-options', HEAD, 'refs/codeverdict/merge-target', `^${BASE}`]);
    expect(args).not.toContain('--not');
  });

  it('reads a commit’s own object, which is where its real parents are recorded', () => {
    const args = argumentsFor({ kind: 'readCommitObject', commit: HEAD });
    expect(args.slice(-4)).toEqual(['cat-file', 'commit', '--end-of-options', HEAD]);
  });

  it('reads the repository’s own configuration as its own keys, unexpanded', () => {
    const args = argumentsFor({ kind: 'listRepositoryConfig' });
    expect(args.slice(-5)).toEqual(['config', '--list', '--local', '--no-includes', '-z']);
  });

  it('asks for NUL-framed numstat over the pinned pair', () => {
    const args = argumentsFor({ kind: 'changedFiles', base: BASE, head: HEAD });
    expect(args).toContain('--numstat');
    expect(args).toContain('-z');
    expect(args).toContain('-M');
    expect(args).toContain(`${BASE}..${HEAD}`);
    expect(args.at(-1)).toBe('--');
  });

  it('reads one file’s diff with the external diff program and textconv both disabled', () => {
    const args = argumentsFor({ kind: 'diffFile', base: BASE, head: HEAD, path: 'src/kept.ts' });
    expect(args).toContain('--no-ext-diff');
    // Both, for every diff-shaped operation: an external diff program replaces
    // the patch, a textconv filter replaces the content the patch is computed
    // from, and only one of the two is off by default.
    expect(args).toContain('--no-textconv');
    expect(args.slice(-2)).toEqual(['--', 'src/kept.ts']);
  });

  it('turns textconv off for the manifest and the diff search as well, not only the single-file read', () => {
    for (const operation of [
      { kind: 'changedFiles', base: BASE, head: HEAD } as const,
      { kind: 'searchDiff', base: BASE, head: HEAD } as const,
    ]) {
      expect(argumentsFor(operation)).toContain('--no-textconv');
    }
  });

  it('reads a file at one revision as an object name, with textconv off', () => {
    const args = argumentsFor({ kind: 'fileAtRevision', revision: HEAD, path: 'src/kept.ts' });
    expect(args).toContain('show');
    expect(args).toContain('--no-textconv');
    expect(args.at(-1)).toBe(`${HEAD}:src/kept.ts`);
  });

  it('searches literally, after -e, at an explicit commit', () => {
    const args = argumentsFor({ kind: 'searchRepository', revision: HEAD, query: 'rate limit', paths: ['src'] });
    const pattern = args.indexOf('rate limit');
    expect(args[pattern - 1]).toBe('-e');
    expect(args[pattern - 2]).toBe('-F');
    expect(args[pattern + 1]).toBe(HEAD);
    expect(args[pattern + 2]).toBe('--');
    expect(args).toContain('-z');
    // Git's own default for grep, written out so the search depends on the flag
    // and not on the default staying what it is.
    expect(args).toContain('--no-textconv');
  });

  it('carries no query at all for a diff search, because that literal is matched host-side', () => {
    const args = argumentsFor({ kind: 'searchDiff', base: BASE, head: HEAD, paths: ['src/kept.ts'] });
    expect(args).not.toContain('-e');
    expect(args).not.toContain('-G');
    expect(args.slice(-2)).toEqual(['--', 'src/kept.ts']);
  });

  it('composes a fetch that writes one ref named after the commit, at the requested depth', () => {
    const args = argumentsFor({ kind: 'fetchCommit', fetchUrl: 'https://example.invalid/acme/core.git', commit: HEAD, depth: 1 });
    expect(args).toContain('--depth=1');
    expect(args).toContain('--no-tags');
    expect(args).toContain('--no-write-fetch-head');
    expect(args).toContain('--no-recurse-submodules');
    expect(args.at(-2)).toBe('https://example.invalid/acme/core.git');
    expect(args.at(-1)).toBe(`+${HEAD}:${localRefForCommit(HEAD)}`);
    // The transport allowlist is a second lock under the URL check.
    expect(args).toContain('protocol.allow=never');
  });

  it('uses the opaque ref hint as the source of the same local ref, never as a second destination', () => {
    const args = argumentsFor({
      kind: 'fetchCommit',
      fetchUrl: 'https://example.invalid/acme/core.git',
      commit: HEAD,
      depth: 1,
      refHint: 'refs/pull/2841/head',
    });
    expect(args.at(-1)).toBe(`+refs/pull/2841/head:${localRefForCommit(HEAD)}`);
  });

  it('refuses a ref hint that could split the refspec or carry whitespace', () => {
    for (const refHint of ['refs/pull/1/head:refs/heads/main', 'refs/pull/1/head --upload-pack=sh', `refs/${String.fromCharCode(0)}`, '']) {
      const result = planGitInvocation({ kind: 'fetchCommit', fetchUrl: 'https://example.invalid/r.git', commit: HEAD, depth: 1, refHint });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('refHintUnsafe');
    }
  });

  it('refuses a fetch depth that is not a small whole number', () => {
    for (const depth of [0, -1, 1.5, 100_000, Number.NaN]) {
      const result = planGitInvocation({ kind: 'fetchCommit', fetchUrl: 'https://example.invalid/r.git', commit: HEAD, depth });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('depthOutOfRange');
    }
  });

  it('asks for a version without a repository prefix, because it answers without a repository', () => {
    expect(argumentsFor({ kind: 'version' })).toEqual(['--version']);
  });
});

describe('the fetch transport is validated before any fetch (task 6.19)', () => {
  const refused = [
    'ext::sh -c "touch /tmp/pwned"',
    'file:///etc',
    'ssh://git@example.invalid/acme/core.git',
    'git://example.invalid/acme/core.git',
    'git+ssh://example.invalid/acme/core.git',
    'ftp://example.invalid/acme/core.git',
    '/var/lib/repos/core.git',
    'example.invalid:acme/core.git',
    'https://token@example.invalid/acme/core.git',
    'https://user:pass@example.invalid/acme/core.git',
  ];

  it.each(refused)('refuses %s with a stated reason and no invocation', (fetchUrl) => {
    const result = planGitInvocation({ kind: 'fetchCommit', fetchUrl, commit: HEAD, depth: 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('fetchUrlTransport');
    expect(result.refusal.reason).toContain('http or https');
    expect(result.refusal.reason).not.toContain(fetchUrl);
  });

  it('accepts plain http and https', () => {
    for (const fetchUrl of ['http://127.0.0.1:8080/r.git', 'https://example.invalid/acme/core.git']) {
      expect(planGitInvocation({ kind: 'fetchCommit', fetchUrl, commit: HEAD, depth: 1 }).ok).toBe(true);
    }
  });
});

describe('the child environment is constructed, not inherited (tasks 6.5, 6.6, 6.7)', () => {
  it('names an empty configuration, literal pathspecs, no prompt and a fixed locale', () => {
    const env = gitProcessEnvironment({ gitDir: '/cache/abc.git' });
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null');
    expect(env.GIT_CONFIG_SYSTEM).toBe('/dev/null');
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(env.GIT_ATTR_NOSYSTEM).toBe('1');
    expect(env.GIT_LITERAL_PATHSPECS).toBe('1');
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GIT_ASKPASS).toBe('');
    expect(env.SSH_ASKPASS).toBe('');
    expect(env.LC_ALL).toBe('C');
    expect(env.GIT_DIR).toBe('/cache/abc.git');
  });

  it('inherits nothing that could carry configuration into the child', () => {
    const env = gitProcessEnvironment({});
    // `HOME` is how `~/.gitconfig` is found; `XDG_CONFIG_HOME` is the other
    // location; `GIT_*` variables set on this process are the third channel.
    expect('HOME' in env).toBe(false);
    expect('XDG_CONFIG_HOME' in env).toBe(false);
    expect('GIT_EXTERNAL_DIFF' in env).toBe(false);
    expect('GIT_CONFIG_PARAMETERS' in env).toBe(false);
    expect('GIT_ALTERNATE_OBJECT_DIRECTORIES' in env).toBe(false);
    // PATH is the one exception, and it is how git is found at all.
    expect(env.PATH).toBe(process.env.PATH ?? '');
  });

  it('puts the credential in the environment as an extra header, and never in an argument', () => {
    const context: GitProcessContext = { credentialHeaderValue: 'Bearer secret-value', gitDir: '/cache/abc.git' };
    const env = gitProcessEnvironment(context);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.GIT_CONFIG_KEY_0).toBe('http.extraHeader');
    expect(env.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer secret-value');

    const args = argumentsFor({ kind: 'fetchCommit', fetchUrl: 'https://example.invalid/r.git', commit: HEAD, depth: 1 }, context);
    for (const argument of args) expect(argument).not.toContain('secret-value');
  });

  it('declares no config entries at all when there is no credential', () => {
    const env = gitProcessEnvironment({});
    expect('GIT_CONFIG_COUNT' in env).toBe(false);
    expect('GIT_CONFIG_VALUE_0' in env).toBe(false);
  });

  it('reapplies the editor’s proxy setting explicitly, since global configuration is ignored', () => {
    const args = argumentsFor({ kind: 'changedFiles', base: BASE, head: HEAD }, { proxyUrl: 'http://proxy.corp:3128' });
    const at = args.indexOf('http.proxy=http://proxy.corp:3128');
    expect(at).toBeGreaterThan(0);
    // Always the value half of `-c`, so the argument can never begin with a
    // dash however the setting is spelled.
    expect(args[at - 1]).toBe('-c');
    expect(args.indexOf('diff')).toBeGreaterThan(at);
  });

  it('adds no proxy argument when none is configured', () => {
    const args = argumentsFor({ kind: 'changedFiles', base: BASE, head: HEAD });
    expect(args.join(' ')).not.toContain('http.proxy');
  });
});

describe('the version probe (task 6.9)', () => {
  it('reads the version out of every shape git reports it in', () => {
    expect(parseGitVersion('git version 2.55.0')?.raw).toBe('2.55.0');
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)')?.raw).toBe('2.39.3');
    expect(parseGitVersion('git version 2.44.0.windows.1')?.raw).toBe('2.44.0');
    expect(parseGitVersion('git version 2.32')?.raw).toBe('2.32.0');
    expect(parseGitVersion('not git at all')).toBeUndefined();
  });

  /**
   * The floor is 2.32.0 because `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` landed
   * there, and without them the machine's own configuration reaches the child —
   * which is not a degradation to accept quietly. Everything else the seam uses
   * is older: `GIT_CONFIG_COUNT` 2.31, `--no-write-fetch-head` 2.29,
   * `--end-of-options` 2.24, `protocol.allow` 2.12, `--literal-pathspecs` 1.9.
   */
  it('accepts 2.32.0 and newer and refuses anything older', () => {
    expect(MINIMUM_GIT_VERSION.raw).toBe('2.32.0');
    for (const raw of ['2.32.0', '2.32.1', '2.33.0', '2.55.0', '3.0.0']) {
      expect(meetsMinimumGitVersion(parseGitVersion(`git version ${raw}`)!)).toBe(true);
    }
    for (const raw of ['2.31.9', '2.30.0', '2.20.1', '1.9.0']) {
      expect(meetsMinimumGitVersion(parseGitVersion(`git version ${raw}`)!)).toBe(false);
    }
  });

  it('answers unsupported, once, when there is no git to run', async () => {
    resetGitSupportProbe();
    const support = await probeGitSupport({ executable: join(tmpdir(), 'code-verdict-no-such-git') });
    expect(support.state).toBe('unsupported');
    if (support.state === 'unsupported') expect(support.reason).toContain('git');

    // Memoized per session: the second call must not re-run the probe, or a
    // machine with no git pays for the answer at every tool call.
    const again = await probeGitSupport({ executable: 'git' });
    expect(again).toBe(support);
    resetGitSupportProbe();
  });

  it.skipIf(process.platform === 'win32')('answers unsupported, naming the version, when git is too old', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-verdict-oldgit-'));
    const fake = join(dir, 'git');
    // Spawned directly, not through a shell — the script's own interpreter line
    // is what runs it, which is the same thing that happens for the real git.
    writeFileSync(fake, '#!/bin/sh\necho "git version 2.20.1"\n');
    chmodSync(fake, 0o755);
    try {
      resetGitSupportProbe();
      const support = await probeGitSupport({ executable: fake });
      expect(support.state).toBe('unsupported');
      if (support.state !== 'unsupported') return;
      expect(support.reason).toContain('2.20.1');
      expect(support.reason).toContain('2.32.0');
      expect(support.version?.raw).toBe('2.20.1');
    } finally {
      resetGitSupportProbe();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(gitVersion === undefined)('answers supported on a machine with a current git', async () => {
    resetGitSupportProbe();
    const support = await probeGitSupport();
    expect(support.state).toBe('supported');
    if (support.state === 'supported') expect(support.version.major).toBeGreaterThanOrEqual(2);
    resetGitSupportProbe();
  });
});

describe.skipIf(gitVersion === undefined)('running a plan against a real repository (tasks 6.1, 6.8)', () => {
  let repo: LocalGitFixture;
  let context: GitProcessContext;

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 400 });
    context = { gitDir: join(repo.dir, '.git') };
  });

  afterAll(() => repo?.cleanup());

  it('answers the manifest for the pinned pair, NUL-framed', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha }), context);
    expect(outcome.state).toBe('ok');
    if (outcome.state !== 'ok') return;
    const records = outcome.stdout.toString('utf8').split(String.fromCharCode(0)).filter((record) => record !== '');
    expect(records.some((record) => record.endsWith(repo.paths.added))).toBe(true);
    expect(records.some((record) => record.endsWith(repo.paths.deleted))).toBe(true);
    // Git's own binary determination, which is the whole point of computing
    // this locally: two dashes where the line counts would be.
    expect(records.some((record) => record === `-\t-\t${repo.paths.binary}`)).toBe(true);
  });

  it('reads one file at one revision by object name', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'fileAtRevision', revision: repo.headSha, path: repo.paths.modified }), context);
    expect(outcome.state).toBe('ok');
    if (outcome.state !== 'ok') return;
    expect(outcome.stdout.toString('utf8')).toContain('RATE = 250');
  });

  it('verifies an object id names a commit that is present, and reports one that is not', async () => {
    const present = await runGitInvocation(planned({ kind: 'verifyCommit', revision: repo.headSha }), context);
    expect(present.state).toBe('ok');
    if (present.state === 'ok') expect(present.stdout.toString('utf8').trim()).toBe(repo.headSha);

    const absent = await runGitInvocation(planned({ kind: 'verifyCommit', revision: 'b'.repeat(40) }), context);
    expect(absent.state).toBe('failed');
    if (absent.state === 'failed') expect(absent.reason).toContain('exit status');
  });

  it('treats “no match” as a successful search, not a failed invocation', async () => {
    // `git grep` exits 1 when nothing matched — measured. Classifying that as a
    // failure would hand group 8 an error where the honest answer is an empty
    // result, and the difference between the two decides whether a file is
    // recorded as inspected.
    const outcome = await runGitInvocation(
      planned({ kind: 'searchRepository', revision: repo.headSha, query: 'no-such-string-anywhere' }),
      context,
    );
    expect(outcome.state).toBe('ok');
    if (outcome.state !== 'ok') return;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.stdout.length).toBe(0);
  });

  it('finds a literal that is present, framed by NUL', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'searchRepository', revision: repo.headSha, query: 'RATE = 250' }), context);
    expect(outcome.state).toBe('ok');
    if (outcome.state !== 'ok') return;
    expect(outcome.exitCode).toBe(0);
    const text = outcome.stdout.toString('utf8');
    expect(text).toContain(repo.paths.modified);
    expect(text).toContain(String.fromCharCode(0));
  });

  it('stops a child that produces more than the output cap, and says so without saying anything about the content', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.oversized }), {
      ...context,
      bounds: { maxStdoutBytes: 512 },
    });
    expect(outcome.state).toBe('outputCapped');
    if (outcome.state !== 'outputCapped') return;
    expect(outcome.capBytes).toBe(512);
    expect(outcome.reason).toContain('512');
    // Never a terminal file state: this says the invocation stopped, and
    // nothing at all about whether the file is readable (design D8).
    expect(outcome.reason).not.toContain('binary');
  });

  it('reads the same file whole when the cap is the real one', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.oversized }), context);
    expect(outcome.state).toBe('ok');
    if (outcome.state !== 'ok') return;
    expect(outcome.stdout.length).toBeGreaterThan(512);
    expect(DEFAULT_GIT_BOUNDS.maxStdoutBytes).toBe(64 * 1024 * 1024);
  });

  it('creates an object store with no working tree at all', async () => {
    // Design D3: one bare repository per repository identity, `core.bare=true`,
    // and every answer from the object database by commit id. Task 7.1 owns the
    // cache layout; the invocation that builds it is here, so that a later
    // group has no reason to spawn git of its own.
    const dir = mkdtempSync(join(tmpdir(), 'code-verdict-cache-'));
    const gitDir = join(dir, 'store.git');
    try {
      const outcome = await runGitInvocation(planned({ kind: 'initBare' }), { gitDir });
      expect(outcome.state).toBe('ok');
      expect(readFileSync(join(gitDir, 'config'), 'utf8')).toContain('bare = true');
      expect(existsSync(join(gitDir, 'objects'))).toBe(true);
      // Nothing is ever checked out: there is no index and no work tree.
      expect(existsSync(join(dir, 'store'))).toBe(false);
      expect(existsSync(join(gitDir, 'index'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a bad object name as a failure with this module’s own words, keeping git’s text out of the result’s reason', async () => {
    const outcome = await runGitInvocation(planned({ kind: 'fileAtRevision', revision: repo.headSha, path: 'src/not-there.ts' }), context);
    expect(outcome.state).toBe('failed');
    if (outcome.state !== 'failed') return;
    expect(outcome.reason).toBe('The git operation did not complete (exit status 128).');
    // Git's own text is kept as a diagnostic for this process and is not the
    // reason anything above will report.
    expect(outcome.stderrExcerpt).toContain('does not exist');
  });
});
