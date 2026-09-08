/**
 * The guards, proved by attacking them — tasks 6.10 through 6.13 and 6.16
 * through 6.18 of `add-local-git-investigation`.
 *
 * Every test in this file was run against a deliberately broken builder before
 * it was run against the real one, and every one of them failed. What each
 * removal actually produced, rather than what it might have:
 *
 * - remove the `--` from the diff builder, and both injection tests fail on
 *   placement, because there is no separator left for a path to be behind. No
 *   file appears, because the value those tests can get past the leading-dash
 *   refusal is inert either way — which is why the first test below assembles
 *   the unsafe argument order by hand against real git and finds the file it
 *   wrote. That one is where the file-write proof lives;
 * - remove `-e`, and the pattern test comes back empty, exit 1, where it should
 *   have found the one line holding the literal `-v`: the query was parsed as
 *   an option and the revision took its place as the pattern, so the search
 *   silently answered a different question;
 * - remove `-F`, and the literal test gets 80 bytes back — the line the query
 *   did not name, matched because a dot became a wildcard;
 * - remove `--literal-pathspecs` and `GIT_LITERAL_PATHSPECS` together, and the
 *   magic test gets a seven-entry manifest where it expected none: the
 *   exclusion applied and quietly narrowed the change under review;
 * - inherit `process.env` instead of constructing one, and the machine
 *   configuration test's diff stops matching the clean one, every line replaced
 *   by a temporary file path;
 * - let a credential helper through (drop `-c credential.helper=` and inherit
 *   the environment), and the challenge test sees two requests instead of one:
 *   git authenticated with a credential the reviewer never chose;
 * - kill the child instead of its process group, and the timeout test finds an
 *   orphaned `git-remote-http` still holding the socket open;
 * - remove `--no-textconv` from the diff arguments, and the diff of a file that
 *   really changed comes back empty, because a filter named by the repository's
 *   own attributes converted both revisions to the same text — and the filter
 *   ran, twice;
 * - remove any one of the `-c` pins in `commonArguments`, and the "answers
 *   every operation identically" test fails on that one: without
 *   `core.bigFileThreshold` a one-line TypeScript file is reported binary,
 *   without `core.attributesFile` a second file is, without `diff.noprefix` the
 *   patch header loses its `a/`/`b/` prefixes, and without `grep.column` the
 *   search output grows a field;
 * - unfreeze the plan's arguments, and the splice that was measured against the
 *   real builder succeeds again: `--output=…` lands in front of the `--` and the
 *   file is written;
 * - drop the runtime check that a plan is one of ours, and an object literal
 *   cast to the type runs whatever arguments it carries.
 *
 * That is the whole reason these run real git against a real repository. A test
 * that cannot fail when the guard is removed asserts nothing, and a recorded
 * fixture of the safe case can never fail that way.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitProcessArguments, gitProcessEnvironment, planGitInvocation, runGitInvocation, type GitInvocationPlan, type GitOperation, type GitProcessContext } from './gitInvocation';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';

const gitVersion = gitExecutableVersion();

function planned(operation: GitOperation): GitInvocationPlan {
  const result = planGitInvocation(operation);
  if (!result.ok) throw new Error(`expected a plan, got refusal: ${result.refusal.code}`);
  return result.plan;
}

/**
 * A local HTTP server standing in for a remote git host.
 *
 * Everything about acquisition that has to be proved here — that the credential
 * travels in a header rather than an argument, that a challenge fails instead
 * of prompting, that a silent server is stopped by the time bound — needs a
 * remote that answers on our terms. `127.0.0.1` and nothing else: no test in
 * this suite reaches the network.
 */
interface ProbeServer {
  readonly url: string;
  readonly requests: ReadonlyArray<{ readonly path: string; readonly authorization: string | undefined }>;
  close(): Promise<void>;
}

async function startProbeServer(mode: 'challenge' | 'silent'): Promise<ProbeServer> {
  const requests: Array<{ path: string; authorization: string | undefined }> = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ path: request.url ?? '', authorization: request.headers.authorization });
    if (mode === 'silent') return;
    response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="probe"' });
    response.end('unauthorized');
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/acme/core.git`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        // A silent server holds its sockets open by design, and `close` waits
        // for them, so they are torn down explicitly rather than hanging the
        // suite on the very condition the test created.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Process ids of git's HTTP transport helper for one remote, for the "nothing
 * left waiting" check.
 *
 * Scoped to the URL rather than counting every `git-remote-http` on the machine.
 * The unscoped census was measured failing intermittently once this directory
 * gained a second suite that fetches for real (`objectAcquisition.test.ts`):
 * vitest runs files in parallel workers, so another worker's perfectly healthy
 * fetch appears in a machine-wide count and is read here as a helper this test's
 * invocation left behind. The reviewer's own `git pull` in another terminal
 * would do the same. The helper's own argument list carries the URL it was
 * started for, so asking about that remote answers the question this test is
 * actually asking, and answers it about nothing else.
 */
function transportHelperPids(remoteUrl: string): readonly string[] {
  if (process.platform !== 'linux') return [];
  const listed = spawnSync('ps', ['--no-headers', '-o', 'pid=,args=', '-C', 'git-remote-http'], { encoding: 'utf8' });
  return (listed.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && line.includes(remoteUrl))
    .map((line) => line.split(/\s+/)[0] ?? '');
}

describe.skipIf(gitVersion === undefined)('the git seam under attack', () => {
  let repo: LocalGitFixture;
  let context: GitProcessContext;
  let scratch: string;
  /**
   * A third commit on the fixture, holding one line that contains the literal
   * text `-v`. Without it, "a query beginning with a dash is matched literally"
   * could only ever assert an empty result, which is also what a query that was
   * eaten as an option produces — the two would be indistinguishable and the
   * test would pass against the unsafe builder.
   */
  let baitSha: string;
  const BAIT_PATH = 'src/dash-bait.ts';

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 40 });
    context = { gitDir: join(repo.dir, '.git') };
    scratch = mkdtempSync(join(tmpdir(), 'code-verdict-adversarial-'));
    writeFileSync(join(repo.dir, BAIT_PATH), "export const FLAG = '-v';\n");
    runGit(repo, ['add', '--all']);
    runGit(repo, ['commit', '-m', 'bait']);
    baitSha = runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
  });

  afterAll(() => {
    repo?.cleanup();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  describe('argument injection (task 6.10)', () => {
    it('is defending against something: the same value before the separator really does write a file', () => {
      // The attack, run for real, so that the defense below is measured against
      // git's actual behavior on this machine rather than against a comment.
      // Nothing in this repository produces this argument order — it is
      // assembled here, by hand, on purpose.
      const target = join(scratch, 'attack-proof.txt');
      expect(existsSync(target)).toBe(false);
      const attack = runGit(repo, ['diff', '--numstat', '-M', `${repo.baseSha}..${repo.headSha}`, `--output=${target}`]);
      expect(attack.status).toBe(0);
      expect(existsSync(target)).toBe(true);
      rmSync(target, { force: true });
    });

    it('writes no file when a path is git’s own --output option', async () => {
      const target = join(scratch, 'pwned.txt');
      const path = `--output=${target}`;

      // The builder refuses a leading dash outright, which is the first lock.
      const refusal = planGitInvocation({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path });
      expect(refusal.ok).toBe(false);
      expect(existsSync(target)).toBe(false);

      // The second lock is placement, and it has to hold for a value the first
      // lock would let through. `--output` reaches git as an ordinary pathspec
      // here, so this runs the real invocation and then looks for the file.
      const disguised = `x${path}`;
      const plan = planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: disguised });
      const args = gitProcessArguments(plan, context);
      const separator = args.indexOf('--');
      expect(separator).toBeGreaterThan(0);
      expect(args.indexOf(disguised)).toBeGreaterThan(separator);

      const outcome = await runGitInvocation(plan, context);
      expect(outcome.state).toBe('ok');
      expect(existsSync(target)).toBe(false);
      expect(existsSync(`${target}`.replace('pwned', 'xpwned'))).toBe(false);
    });

    it('never emits a path before the separator, for any operation that takes one', () => {
      const cases: ReadonlyArray<{ operation: GitOperation; paths: readonly string[] }> = [
        { operation: { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha, paths: ['src/a.ts', 'src/b.ts'] }, paths: ['src/a.ts', 'src/b.ts'] },
        { operation: { kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: 'src/a.ts' }, paths: ['src/a.ts'] },
        { operation: { kind: 'searchDiff', base: repo.baseSha, head: repo.headSha, paths: ['src/a.ts'] }, paths: ['src/a.ts'] },
        { operation: { kind: 'searchRepository', revision: repo.headSha, query: 'rate', paths: ['src/a.ts'] }, paths: ['src/a.ts'] },
      ];
      for (const { operation, paths } of cases) {
        const args = gitProcessArguments(planned(operation), context);
        const separator = args.indexOf('--');
        expect(separator).toBeGreaterThan(0);
        for (const path of paths) expect(args.indexOf(path)).toBeGreaterThan(separator);
      }
    });
  });

  describe('pattern injection (task 6.11)', () => {
    it('matches a query beginning with a dash literally instead of parsing it as an option', async () => {
      // Measured: `git grep -F '-v' <rev>` reads `-v` as invert-match and the
      // revision as the pattern, and prints every line of every file — the
      // search answers a question nobody asked, and returns content the query
      // excluded. After `-e` the same string matches nothing.
      const plan = planned({ kind: 'searchRepository', revision: baitSha, query: '-v' });

      // The behavioural assertion first, so that removing `-e` fails this test
      // on what git did rather than on where an argument sat. The repository
      // contains one line holding the literal `-v`, so a search that really ran
      // finds it; a search whose query was eaten as an option finds nothing,
      // because the revision then becomes the pattern.
      const outcome = await runGitInvocation(plan, context);
      expect(outcome.state).toBe('ok');
      if (outcome.state !== 'ok') return;
      expect(outcome.exitCode).toBe(0);
      expect(outcome.stdout.toString('utf8')).toContain(BAIT_PATH);

      const args = gitProcessArguments(plan, context);
      expect(args[args.indexOf('-v') - 1]).toBe('-e');
    });

    it('never compiles the model’s string as a regular expression', async () => {
      // Why `-F` matters beyond option parsing. `RATE = 25.` is not in the
      // repository; `RATE = 250;` is. As a literal the first matches nothing.
      // As a basic regular expression the dot matches the semicolon and it
      // returns the line — content the model did not ask for, entering the
      // evidence ledger as though it had.
      const literal = await runGitInvocation(planned({ kind: 'searchRepository', revision: repo.headSha, query: 'RATE = 25.' }), context);
      expect(literal.state).toBe('ok');
      if (literal.state !== 'ok') return;
      expect(literal.stdout.length).toBe(0);

      // Non-vacuity: the same search finds the line when the query really names
      // it, so the empty result above is the literal rule and not a broken
      // search.
      const present = await runGitInvocation(planned({ kind: 'searchRepository', revision: repo.headSha, query: 'RATE = 250;' }), context);
      expect(present.state).toBe('ok');
      if (present.state !== 'ok') return;
      expect(present.stdout.toString('utf8')).toContain(repo.paths.modified);

      const args = gitProcessArguments(planned({ kind: 'searchRepository', revision: repo.headSha, query: 'RATE = 25.' }), context);
      expect(args[args.indexOf('-e') - 1]).toBe('-F');
    });
  });

  describe('pathspec magic (task 6.12)', () => {
    /** The whole manifest, so a narrowed one is visibly narrowed. */
    async function manifestPaths(paths?: readonly string[]): Promise<readonly string[]> {
      const outcome = await runGitInvocation(planned({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha, paths }), context);
      expect(outcome.state).toBe('ok');
      if (outcome.state !== 'ok') return [];
      return outcome.stdout
        .toString('utf8')
        .split(String.fromCharCode(0))
        .filter((record) => record !== '')
        .map((record) => record.split('\t')[2] ?? '');
    }

    it('treats an exclusion pattern as a literal path that matches nothing', async () => {
      const everything = await manifestPaths();
      expect(everything.length).toBeGreaterThan(3);
      expect(everything).toContain(repo.paths.modified);

      // Without literal pathspecs this is git's exclude magic: the manifest
      // comes back with every file *except* the named one, which is a review
      // quietly not looking at the file the change is about. With it, the value
      // is a path, and no path is named that.
      const excluded = await manifestPaths([`:(exclude)${repo.paths.modified}`]);
      expect(excluded).toEqual([]);
    });

    it('cannot re-root the operation with a top-level magic pathspec', async () => {
      // `:/…` means "from the repository root" to git's pathspec parser. Read
      // literally it is a path whose first component is `:`, which names
      // nothing, so the manifest comes back empty instead of widened.
      expect(await manifestPaths([`:/${repo.paths.modified}`])).toEqual([]);
      expect(await manifestPaths([':(glob)**/*.ts'])).toEqual([]);
    });

    it('refuses the bare `:/` form earlier still, as a path with an empty component', () => {
      // Not a special case for pathspec magic — `:/` is refused by the same
      // rule that refuses `src//a.ts`, because neither is a path git stores in
      // its index. A refusal is a stronger outcome than a literal match, and it
      // arrives before git is invoked at all.
      const result = planGitInvocation({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha, paths: [':/'] });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.refusal.code).toBe('pathNotRepositoryRelative');
    });

    it('has the guard in both places, so removing either one alone changes nothing', () => {
      expect(gitProcessEnvironment(context).GIT_LITERAL_PATHSPECS).toBe('1');
      expect(gitProcessArguments(planned({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha }), context)[0]).toBe('--literal-pathspecs');
    });
  });

  describe('path refusal happens before git runs (task 6.13)', () => {
    const nul = String.fromCharCode(0);
    const paths = ['/etc/passwd', '../../etc/passwd', 'C:\\Windows\\win.ini', '\\\\host\\share\\x.ts', `src/a${nul}b.ts`, '-rf'];

    it.each(paths)('refuses %j with this source’s own reason and produces no plan to run', (path) => {
      const result = planGitInvocation({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      // There is no invocation to make: `runGitInvocation` takes a plan, and a
      // refusal is not one. The refusal is a value, not a caught error.
      expect(result.refusal.reason).toBeTruthy();
      // Git's own refusals for these read `fatal: /etc/passwd: '/etc/passwd' is
      // outside repository at …`. None of that shape may reach a caller.
      expect(result.refusal.reason).not.toContain('fatal');
      expect(result.refusal.reason).not.toContain('usage:');
      expect(result.refusal.reason).not.toContain(path);
    });

    it('still plans and runs the ordinary path that the refusals are measured against', async () => {
      const outcome = await runGitInvocation(planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.modified }), context);
      expect(outcome.state).toBe('ok');
    });
  });

  describe('nothing model-supplied and no credential reaches another sink (task 6.16)', () => {
    // The existing convention (`harnessCheckpoint.test.ts`, generalized by
    // `harnessPersistenceInspection.assurance.test.ts`): plant a distinctive
    // literal in a real value, drive the production path, then assert it is in
    // the one sanctioned place and nowhere else — so the scan cannot pass by
    // the value never having travelled.
    //
    // The sinks that exist at this layer are the argument list, the child's
    // environment, and every field of the outcome a caller could persist or
    // report. Activity events, checkpoints and diagnostics are not written by
    // anything here; tasks 10.1-10.3 add them, and this convention travels with
    // them.
    const PATH_MARKER = 'MARKER_PATH_6_16_a1b2c3d4';
    const QUERY_MARKER = 'MARKER_QUERY_6_16_e5f60718';
    const CREDENTIAL_MARKER = 'MARKER_CREDENTIAL_6_16_ghp_29a3b4c5';

    it('keeps a model-supplied path in the argument list and out of every reason', async () => {
      const path = `src/${PATH_MARKER}.ts`;
      const plan = planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path });
      const args = gitProcessArguments(plan, context);
      // Non-vacuity: it really did travel, in the one place it belongs.
      expect(args.indexOf(path)).toBeGreaterThan(args.indexOf('--'));

      const outcome = await runGitInvocation(plan, context);
      expect(outcome.state).toBe('ok');
      expect(JSON.stringify(outcome)).not.toContain(PATH_MARKER);

      // And the refusal path, which is the reason that travels furthest.
      const refused = planGitInvocation({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: `/${PATH_MARKER}/x.ts` });
      expect(refused.ok).toBe(false);
      if (!refused.ok) expect(JSON.stringify(refused.refusal)).not.toContain(PATH_MARKER);
    });

    it('keeps a model-supplied query in the argument list and out of every reason', async () => {
      const plan = planned({ kind: 'searchRepository', revision: repo.headSha, query: QUERY_MARKER });
      const args = gitProcessArguments(plan, context);
      expect(args[args.indexOf(QUERY_MARKER) - 1]).toBe('-e');

      const outcome = await runGitInvocation(plan, context);
      expect(outcome.state).toBe('ok');
      expect(JSON.stringify(outcome)).not.toContain(QUERY_MARKER);
    });

    it('sends the credential as a header and puts it in no argument, no outcome and no error text', async () => {
      const server = await startProbeServer('challenge');
      try {
        const credentialContext: GitProcessContext = { ...context, credentialHeaderValue: `Bearer ${CREDENTIAL_MARKER}`, bounds: { fetchTimeoutMs: 15_000 } };
        const plan = planned({ kind: 'fetchCommit', fetchUrl: server.url, commit: repo.headSha, depth: 1 });

        const args = gitProcessArguments(plan, credentialContext);
        for (const argument of args) expect(argument).not.toContain(CREDENTIAL_MARKER);
        expect(gitProcessEnvironment(credentialContext).GIT_CONFIG_VALUE_0).toBe(`Authorization: Bearer ${CREDENTIAL_MARKER}`);

        const outcome = await runGitInvocation(plan, credentialContext);

        // Non-vacuity, and the point of task 6.6: the credential really did
        // reach the remote, through the header, from the environment.
        expect(server.requests.length).toBeGreaterThan(0);
        expect(server.requests[0]?.authorization).toBe(`Bearer ${CREDENTIAL_MARKER}`);

        // Every other channel. `stderrExcerpt` matters most: git echoes the URL
        // it was given in its error text, which is why the credential is never
        // put in a URL.
        expect(outcome.state).toBe('failed');
        expect(JSON.stringify(outcome)).not.toContain(CREDENTIAL_MARKER);
        if (outcome.state === 'failed') {
          expect(outcome.reason).not.toContain(CREDENTIAL_MARKER);
          expect(outcome.stderrExcerpt).not.toContain(CREDENTIAL_MARKER);
          expect(outcome.stderrExcerpt).toContain('127.0.0.1');
        }
      } finally {
        await server.close();
      }
    });
  });

  describe('machine configuration cannot change a result (task 6.17)', () => {
    const ambient = ['HOME', 'XDG_CONFIG_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_EXTERNAL_DIFF', 'GIT_ATTR_NOSYSTEM'];
    const saved = new Map<string, string | undefined>();

    /**
     * A git configuration of the kind a corporate laptop or a curious user
     * really has: an external diff program, a textconv filter, an alias and a
     * credential helper. Every one of them changes what git answers, and two of
     * them run a program of the configuration's choosing.
     */
    function installHostileConfiguration(): void {
      const home = join(scratch, 'hostile-home');
      mkdirSync(home, { recursive: true });
      const attributes = join(home, 'attributes');
      writeFileSync(attributes, '*.ts diff=hostile\n');
      const config = join(home, '.gitconfig');
      writeFileSync(
        config,
        [
          '[core]',
          `\tattributesFile = ${attributes}`,
          '[diff]',
          '\texternal = /bin/echo EXTERNAL',
          '[diff "hostile"]',
          '\ttextconv = /bin/echo',
          '[alias]',
          '\tst = !echo pwned',
          '[credential]',
          '\thelper = "!f() { echo username=u; echo password=p; }; f"',
          '',
        ].join('\n'),
      );
      for (const name of ambient) saved.set(name, process.env[name]);
      process.env.HOME = home;
      process.env.XDG_CONFIG_HOME = home;
      process.env.GIT_CONFIG_GLOBAL = config;
      process.env.GIT_CONFIG_SYSTEM = config;
      process.env.GIT_EXTERNAL_DIFF = '/bin/echo';
    }

    afterEach(() => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      saved.clear();
    });

    it.skipIf(process.platform === 'win32')('answers identically with a hostile configuration applied to this process', async () => {
      const operations: GitOperation[] = [
        { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha },
        { kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.modified },
        { kind: 'fileAtRevision', revision: repo.headSha, path: repo.paths.modified },
        { kind: 'searchRepository', revision: repo.headSha, query: 'RATE' },
      ];
      const clean: string[] = [];
      for (const operation of operations) {
        const outcome = await runGitInvocation(planned(operation), context);
        expect(outcome.state).toBe('ok');
        clean.push(outcome.state === 'ok' ? outcome.stdout.toString('utf8') : '');
      }
      // Non-vacuity: these are real answers, not four empty strings.
      expect(clean[1]).toContain('RATE = 250');

      installHostileConfiguration();
      for (const [index, operation] of operations.entries()) {
        const outcome = await runGitInvocation(planned(operation), context);
        expect(outcome.state).toBe('ok');
        expect(outcome.state === 'ok' ? outcome.stdout.toString('utf8') : '').toBe(clean[index]);
      }

      // What the comparison is worth, stated as its own fact: with that same
      // configuration applied, git's answer changes. Measured on 2026-09-11 —
      // `diff.external = /bin/echo EXTERNAL` replaces the whole patch with the
      // echo's output, and the textconv filter replaces every line of it with a
      // temporary file path even when `--no-ext-diff` is passed. Configuration
      // isolation, not the flag, is what stops the second one.
      const withConfiguration = spawnSync(
        'git',
        ['diff', '--no-ext-diff', '--no-color', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.modified],
        { cwd: repo.dir, env: { ...process.env, GIT_DIR: join(repo.dir, '.git') }, encoding: 'utf8' },
      );
      expect(withConfiguration.stdout).not.toContain('RATE = 250');
    });

    it.skipIf(process.platform === 'win32')('consults no credential helper, so a challenge still fails instead of authenticating', async () => {
      const server = await startProbeServer('challenge');
      try {
        installHostileConfiguration();
        const outcome = await runGitInvocation(planned({ kind: 'fetchCommit', fetchUrl: server.url, commit: repo.headSha, depth: 1 }), {
          ...context,
          bounds: { fetchTimeoutMs: 15_000 },
        });
        expect(outcome.state).toBe('failed');
        // One request and no second one: a helper that answered the challenge
        // would have produced a retry carrying Basic credentials the reviewer
        // never chose.
        expect(server.requests.length).toBe(1);
        expect(server.requests[0]?.authorization).toBeUndefined();
      } finally {
        await server.close();
      }
    });
  });

  /**
   * The cache repository is a directory this extension creates, and its own
   * `$GIT_DIR/config` is read by every invocation no matter what the
   * environment says. `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` at `/dev/null`
   * close the machine's files and reach this one not at all, so the guards here
   * are the `-c` pins in `commonArguments` and the `--no-textconv` in
   * `DIFF_ARGUMENTS`. Every test below runs against a bare repository built by
   * the production builder — the shape design D3 describes — with the two
   * fixture commits pushed into it.
   */
  describe('configuration inside the repository we run against (finding 1)', () => {
    let bare: string;
    let bareContext: GitProcessContext;
    /** Raw git against the bare repository, for measuring the attacks themselves. */
    let asBare: { dir: string; env: Record<string, string> };
    let hostileRan: string;
    let hostileScript: string;
    let hostileAttributes: string;

    beforeAll(async () => {
      bare = join(scratch, 'cache.git');
      bareContext = { gitDir: bare };
      asBare = { dir: repo.dir, env: { ...repo.env, GIT_DIR: bare } };
      const created = await runGitInvocation(planned({ kind: 'initBare' }), bareContext);
      expect(created.state).toBe('ok');
      // Pushed under the ref names design D3 gives acquired commits, so the
      // objects are reachable rather than dangling, exactly as group 7 will
      // write them.
      runGit(repo, ['push', bare, `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`, `${repo.headSha}:refs/codeverdict/${repo.headSha}`]);

      hostileRan = join(scratch, 'hostile-ran.log');
      hostileScript = join(scratch, 'hostile-textconv.sh');
      hostileAttributes = join(scratch, 'hostile-attributes');
      // The config-named attributes file claims a different path from the one
      // `info/attributes` claims below, so that the `-c core.attributesFile`
      // pin is load-bearing on its own. Both files set the same attribute, and
      // `info/attributes` outranks this one wherever they overlap, so one path
      // each is the only way to see both guards work.
      writeFileSync(hostileAttributes, `${repo.paths.added} -diff\n`);
      // Records that it ran, and converts every revision of a file to the same
      // text — the quiet version of the attack, where the diff is not corrupted
      // but empty.
      writeFileSync(hostileScript, `#!/bin/sh\necho ran >> ${hostileRan}\necho "ONE TEXT FOR EVERY REVISION"\n`);
      chmodSync(hostileScript, 0o755);
    });

    /**
     * Appends to the bare repository's own config, and writes the attributes
     * file inside the repository directory.
     *
     * `$GIT_DIR/info/attributes` is the half of this no argument can neutralize
     * — measured on 2026-09-11, `-c core.attributesFile=/dev/null`,
     * `--attr-source=<empty tree>` and `GIT_ATTR_SOURCE` all leave it in force,
     * as gitattributes(5) says they will: it is the highest-precedence source.
     * So the driver it assigns is assigned no matter what, and `--no-textconv`
     * is what stops the driver from deciding what the diff says.
     */
    function installHostileRepositoryConfiguration(): void {
      mkdirSync(join(bare, 'info'), { recursive: true });
      writeFileSync(join(bare, 'info', 'attributes'), `${repo.paths.modified} diff=hostile\n`);
      writeFileSync(
        join(bare, 'config'),
        [
          '[core]',
          `\tattributesFile = ${hostileAttributes}`,
          // Every file reads as binary below this, including a one-line
          // TypeScript file. Measured: `-\t-` from `--numstat`, and
          // `Binary files a/… and b/… differ` from the patch.
          '\tbigFileThreshold = 1',
          '[diff]',
          '\texternal = /bin/echo EXTERNAL',
          '\tnoprefix = true',
          '[diff "hostile"]',
          `\ttextconv = ${hostileScript}`,
          '[grep]',
          '\tcolumn = true',
          '',
        ].join('\n'),
        { flag: 'a' },
      );
    }

    function restoreCleanRepositoryConfiguration(): void {
      writeFileSync(join(bare, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n');
      rmSync(join(bare, 'info', 'attributes'), { force: true });
      rmSync(hostileRan, { force: true });
    }

    afterEach(() => restoreCleanRepositoryConfiguration());

    it('is defending against something: a textconv driver in that config empties a real diff and runs its program', () => {
      installHostileRepositoryConfiguration();
      // The arguments this seam used before `--no-textconv` was added, run for
      // real. `--no-ext-diff` is present, and it does not help: an external
      // diff program and a textconv filter are two different doors.
      const attack = runGit(asBare, ['diff', '--no-ext-diff', '--no-color', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.modified]);
      expect(attack.status).toBe(0);
      // Empty, for a file that really changed. Nothing about this looks broken:
      // a review would record the file as read and unmodified.
      expect(attack.stdout).toBe('');
      expect(existsSync(hostileRan)).toBe(true);
    });

    it('answers the true patch with that same driver configured, and never runs it', async () => {
      installHostileRepositoryConfiguration();
      const outcome = await runGitInvocation(planned({ kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.modified }), bareContext);
      expect(outcome.state).toBe('ok');
      if (outcome.state !== 'ok') return;
      const patch = outcome.stdout.toString('utf8');
      expect(patch).toContain('-export const RATE = 100;');
      expect(patch).toContain('+export const RATE = 250;');
      // The filter is a program of the configuration's choosing. Not running it
      // is a separate fact from getting the right answer.
      expect(existsSync(hostileRan)).toBe(false);
    });

    it('answers every operation identically with that whole configuration in place', async () => {
      const operations: GitOperation[] = [
        { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha },
        { kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.modified },
        { kind: 'fileAtRevision', revision: repo.headSha, path: repo.paths.modified },
        { kind: 'searchRepository', revision: repo.headSha, query: 'RATE' },
      ];
      const clean: string[] = [];
      for (const operation of operations) {
        const outcome = await runGitInvocation(planned(operation), bareContext);
        expect(outcome.state).toBe('ok');
        clean.push(outcome.state === 'ok' ? outcome.stdout.toString('utf8') : '');
      }
      // Non-vacuity: real answers, not four empty strings.
      expect(clean[0]).toContain(repo.paths.added);
      expect(clean[1]).toContain('RATE = 250');
      expect(clean[3]).toContain('RATE');

      installHostileRepositoryConfiguration();
      for (const [index, operation] of operations.entries()) {
        const outcome = await runGitInvocation(planned(operation), bareContext);
        expect(outcome.state).toBe('ok');
        expect(outcome.state === 'ok' ? outcome.stdout.toString('utf8') : '').toBe(clean[index]);
      }

      // What that identity is worth, measured beside it: without the pins, the
      // same repository answers `-\t-` for a one-line TypeScript file, which is
      // the everything-is-binary state this whole change exists to remove.
      const unpinned = runGit(asBare, ['diff', '--numstat', '-M', `${repo.baseSha}..${repo.headSha}`, '--', repo.paths.modified]);
      expect(unpinned.stdout.trim()).toBe(`-\t-\t${repo.paths.modified}`);
      // And an extra NUL-separated column field per match, which would
      // desynchronize the framing `-z` was chosen for.
      const unpinnedSearch = runGit(asBare, ['grep', '--no-color', '-I', '-n', '-z', '-F', '-e', 'RATE', repo.headSha, '--']);
      expect(unpinnedSearch.stdout.split(String.fromCharCode(0)).length).toBeGreaterThan(clean[3]!.split(String.fromCharCode(0)).length);
    });

    it('runs no hook the repository directory carries, on the one operation that writes a ref', () => {
      // A hook is the worst member of this class: not a changed answer but a
      // program, run by a ref update. Measured here rather than asserted from a
      // comment — `git fetch` writing one ref ran this hook three times
      // (preparing, prepared, committed).
      const hookLog = join(scratch, 'hook-ran.log');
      const hook = join(bare, 'hooks', 'reference-transaction');
      writeFileSync(hook, `#!/bin/sh\necho "$1" >> ${hookLog}\nexit 0\n`);
      chmodSync(hook, 0o755);
      try {
        runGit(asBare, ['fetch', '--no-tags', '--depth=1', repo.dir, `+${repo.headSha}:refs/codeverdict/probe`]);
        expect(existsSync(hookLog)).toBe(true);
        rmSync(hookLog, { force: true });

        runGit(asBare, ['-c', 'core.hooksPath=/dev/null', 'fetch', '--no-tags', '--depth=1', repo.dir, `+${repo.baseSha}:refs/codeverdict/probe`]);
        expect(existsSync(hookLog)).toBe(false);
      } finally {
        rmSync(hook, { force: true });
        rmSync(hookLog, { force: true });
      }

      // And the pin that closes it is on every invocation the builder produces,
      // including the fetch — which is the only one that writes a ref, and the
      // only one this seam can point at a remote it was given.
      const fetchArguments = gitProcessArguments(planned({ kind: 'fetchCommit', fetchUrl: 'https://example.invalid/acme/core.git', commit: repo.headSha, depth: 1 }), bareContext);
      expect(fetchArguments).toContain('core.hooksPath=/dev/null');
    });
  });

  /**
   * Finding 3. Construction was already closed — `tsc` rejects an object
   * literal, a same-shape class and a class with its own private field — but a
   * validated plan was still a mutable array behind a `readonly` type, and a
   * `readonly` cast is not something eslint reports.
   */
  describe('a plan cannot be changed, or invented, after validation (finding 3)', () => {
    it('is defending against something: the same splice used to place an option in front of the separator', () => {
      // The mutation, spelled exactly as it was measured against the builder on
      // 2026-09-11, when it produced `state: 'ok'` and a written file.
      const plan = planned({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha });
      const attempt = (): unknown => (plan.args as string[]).splice(1, 0, `--output=${join(scratch, 'never-written.txt')}`);
      expect(attempt).toThrow(TypeError);
      // The other array, which decides whether a failed invocation is reported
      // as a success rather than what it ran.
      expect(() => (plan.successExitCodes as number[]).push(128)).toThrow(TypeError);
      // And no property of the plan can be replaced wholesale either.
      expect(() => Object.defineProperty(plan, 'args', { value: ['--version'] })).toThrow(TypeError);
    });

    it('runs the arguments that were validated, even where the mutation is swallowed', async () => {
      const target = join(scratch, 'swallowed-mutation.txt');
      const plan = planned({ kind: 'changedFiles', base: repo.baseSha, head: repo.headSha });
      try {
        (plan.args as string[]).splice(1, 0, `--output=${target}`);
      } catch {
        // A caller that wraps its own mistake in a try/catch gets no more than
        // a caller that does not: the plan is unchanged either way.
      }
      const outcome = await runGitInvocation(plan, context);
      expect(outcome.state).toBe('ok');
      if (outcome.state !== 'ok') return;
      expect(outcome.stdout.toString('utf8')).toContain(repo.paths.added);
      expect(existsSync(target)).toBe(false);
    });

    it('starts no process for a plan-shaped object that was never planned', async () => {
      const target = join(scratch, 'forged-plan.txt');
      // The private field is a compile-time guarantee and this extension ships
      // as bundled JavaScript, so the runtime check is the half that survives.
      // These are the arguments the first test in this file proved really do
      // write a file.
      const forged = {
        kind: 'changedFiles',
        args: ['diff', '--numstat', '-M', `${repo.baseSha}..${repo.headSha}`, `--output=${target}`],
        timeBound: 'read',
        needsRepository: true,
        successExitCodes: [0],
      } as unknown as GitInvocationPlan;
      const outcome = await runGitInvocation(forged, context);
      expect(outcome.state).toBe('unavailable');
      if (outcome.state !== 'unavailable') return;
      expect(outcome.reason).toBe('The git operation was not one this extension planned.');
      expect(existsSync(target)).toBe(false);
    });
  });

  describe('an invocation that would prompt (task 6.18)', () => {
    it('fails in milliseconds with a stated reason, and leaves nothing waiting', async () => {
      const server = await startProbeServer('challenge');
      const before = new Set(transportHelperPids(server.url));
      try {
        const outcome = await runGitInvocation(planned({ kind: 'fetchCommit', fetchUrl: server.url, commit: repo.headSha, depth: 1 }), {
          ...context,
          bounds: { fetchTimeoutMs: 30_000 },
        });
        expect(outcome.state).toBe('failed');
        if (outcome.state !== 'failed') return;
        // The reason is this module's own; git's text stays a diagnostic. The
        // duration is the assertion that matters: the invocation ended on its
        // own, far short of the 30-second bound, rather than being stopped by
        // it. Measured against this server, git exits 128 in about 16 ms.
        expect(outcome.reason).toContain('exit status');
        expect(outcome.durationMs).toBeLessThan(5_000);
        expect(outcome.stderrExcerpt).toContain('terminal prompts disabled');
      } finally {
        await server.close();
      }
      for (const pid of transportHelperPids(server.url)) expect(before.has(pid)).toBe(true);
    });

    it('stops a fetch that a silent remote would hold open forever, and reaps its transport helper', async () => {
      const server = await startProbeServer('silent');
      const before = new Set(transportHelperPids(server.url));
      let leftBehind: readonly string[] = [];
      try {
        const started = Date.now();
        const outcome = await runGitInvocation(planned({ kind: 'fetchCommit', fetchUrl: server.url, commit: repo.headSha, depth: 1 }), {
          ...context,
          bounds: { fetchTimeoutMs: 700 },
        });
        expect(outcome.state).toBe('timedOut');
        if (outcome.state !== 'timedOut') return;
        expect(outcome.limitMs).toBe(700);
        expect(Date.now() - started).toBeLessThan(10_000);
        expect(outcome.reason).toContain('700');

        // Counted here, while the server is still holding the connection open,
        // and not after the teardown. Measured on 2026-09-11: killing the git
        // process alone leaves `git-remote-http` running, orphaned, blocked on
        // that socket — and it exits the instant the socket goes away, so a
        // count taken after `server.close()` finds nothing either way and
        // proves nothing. Signalling the whole process group is what makes this
        // empty.
        await new Promise((resolve) => setTimeout(resolve, 250));
        leftBehind = transportHelperPids(server.url).filter((pid) => !before.has(pid));
      } finally {
        await server.close();
      }
      expect(leftBehind).toEqual([]);
    });
  });
});
