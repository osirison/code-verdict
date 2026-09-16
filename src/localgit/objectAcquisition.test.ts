/**
 * Acquisition against a real git remote — tasks 7.3, 7.4, 7.5, 7.10, 7.11 and
 * 7.12 of `add-local-git-investigation`.
 *
 * **There is a real server here, and it speaks the real protocol.** The remote
 * is `git http-backend`, git's own CGI, driven by a `node:http` server bound to
 * `127.0.0.1` and nothing else — no test in this file reaches the network. Every
 * fetch is a real negotiation, a real pack, and a real object-id check by the
 * git that is installed on this machine. That matters most for the two claims
 * this group rests on: that a shallow fetch of a bare object id puts exactly the
 * pinned commit in the store, and that a ref hint cannot substitute a different
 * one.
 *
 * **What is emulated, and why it had to be.** One test remote refuses to serve
 * an object nobody named. Stock `git-http-backend` cannot be configured to do
 * that, which was measured on 2026-09-11 rather than assumed — all three
 * configurations, against the same server, with the same git 2.55.0:
 *
 * - ref advertised, any `uploadpack` setting: a fetch of the bare object id is
 *   served, because the object is the tip of an advertised ref;
 * - `uploadpack.hideRefs=refs/pull` under protocol v0: the bare object id is
 *   refused with "Server does not allow request for unadvertised object", and a
 *   fetch naming the hidden ref is refused with "couldn't find remote ref" — so
 *   the hint cannot succeed either;
 * - the same under protocol v2: the bare object id is *served*, hidden ref or
 *   not.
 *
 * A forge that refuses bare ids while serving the same commit under
 * `refs/pull/<n>/head` — the case design D8's ref hint exists for — is therefore
 * not reachable from git's own configuration, and the policy is applied in the
 * test remote's HTTP layer instead: a request that asks for objects nobody named
 * is answered 403. Everything on either side of that gate is genuine, including
 * the refusal the client sees, the retry, the transfer and the verification. The
 * second case above is genuine end to end and is tested as itself.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { gitProcessArguments, planGitInvocation, runGitInvocation, type GitRunner } from './gitInvocation';
import { lockStaleFor, type LocalGitPolicy } from './localGitPolicy';
import { createObjectCache } from './objectAcquisition';
import { cacheEntryPaths, objectCacheRoot, readCacheEntryMetadata, type RepositoryIdentity } from './objectCache';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';

const gitVersion = gitExecutableVersion();

/** git's own CGI, wherever this git keeps its helpers. */
function gitHttpBackend(): string | undefined {
  const located = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (located.status !== 0) return undefined;
  const candidate = join((located.stdout ?? '').trim(), 'git-http-backend');
  return existsSync(candidate) ? candidate : undefined;
}

const backend = gitHttpBackend();

interface ObjectSourceRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  /** Object ids this request asked the remote for, read off the protocol's own `want` lines. */
  readonly wants: readonly string[];
  /** Whether this request named the hint ref — in protocol v2 the client asks for it by name before it asks for objects. */
  readonly namedHint: boolean;
  readonly refused: boolean;
}

interface ObjectSource {
  readonly url: string;
  readonly requests: readonly ObjectSourceRequest[];
  /** How many times this remote was asked for one object id. */
  timesWanted(objectId: string): number;
  close(): Promise<void>;
}

interface ObjectSourceOptions {
  /** Directory holding the served repository; the repository is `<projectRoot>/<repositoryName>`. */
  readonly projectRoot: string;
  readonly repositoryName: string;
  readonly emptyConfig: string;
  /**
   * Which wire protocol the remote offers. v2 unless a test needs v0 — git's
   * client chooses v2 by default, so v2 is what production talks.
   */
  readonly protocol?: 'v0' | 'v2';
  /**
   * The policy a forge applies and `git-http-backend` cannot be configured into
   * (see this file's header). `unauthorized` answers every request 401 with a
   * challenge, which is what a rejected or missing credential looks like on the
   * wire (design D8's credentials row, task 10.3/10.4).
   */
  readonly refuse?: 'nothing' | 'objectIdsNobodyNamed' | 'unauthorized';
  /** The ref a client may name to be served; only meaningful with the refusal policy above. */
  readonly hintRef?: string;
}

async function startObjectSource(options: ObjectSourceOptions): Promise<ObjectSource> {
  const requests: ObjectSourceRequest[] = [];
  const sockets = new Set<Socket>();
  // Reset at the start of every fetch — the capability advertisement is the
  // first request of one — so naming a ref serves that fetch and not the next.
  let namedInThisFetch = false;

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const text = body.toString('latin1');
      const path = request.url ?? '';
      if (options.refuse === 'unauthorized') {
        requests.push({ path, authorization: request.headers.authorization, wants: [], namedHint: false, refused: true });
        response.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="git"' });
        response.end('who are you');
        return;
      }
      if (path.includes('/info/refs')) namedInThisFetch = false;
      const namedHint = options.hintRef !== undefined && text.includes(options.hintRef);
      if (namedHint) namedInThisFetch = true;
      const wants = [...text.matchAll(/want ([0-9a-f]{40})/g)].map((match) => match[1] ?? '');
      const refused = options.refuse === 'objectIdsNobodyNamed' && wants.length > 0 && !namedInThisFetch;
      requests.push({ path, authorization: request.headers.authorization, wants, namedHint, refused });
      if (refused) {
        response.writeHead(403, { 'Content-Type': 'text/plain' });
        response.end('this remote serves objects you can name');
        return;
      }

      const [pathInfo, query] = path.split('?');
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: options.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method ?? 'GET',
        PATH_INFO: pathInfo ?? '',
        QUERY_STRING: query ?? '',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        // Measured: without this the backend waits for an end of input it never
        // sees, and the fetch hangs rather than failing.
        CONTENT_LENGTH: String(body.length),
        REMOTE_ADDR: '127.0.0.1',
        GIT_CONFIG_GLOBAL: options.emptyConfig,
        GIT_CONFIG_SYSTEM: options.emptyConfig,
      };
      const encoding = request.headers['content-encoding'];
      if (encoding !== undefined) environment.HTTP_CONTENT_ENCODING = String(encoding);
      const offered = request.headers['git-protocol'];
      // Forwarding this header is what makes the remote speak v2; a remote that
      // does not forward it answers in v0, which is a real deployment and the
      // one the hidden-ref case needs.
      if ((options.protocol ?? 'v2') === 'v2' && offered !== undefined) environment.GIT_PROTOCOL = String(offered);

      const child = spawn(backend ?? '', [], { env: environment });
      // Observed twice on 2026-09-11, only under a full-suite run and never in
      // this file alone: `write EPIPE` out of this line, reported as an uncaught
      // exception on a run where all 3,035 tests passed. `git-http-backend` can
      // answer and exit before the body reaches it — a request it refuses needs
      // none of the body — and writing to a pipe whose reader is gone fails that
      // way. The request is over by then and nothing here has to act on it, but
      // an unhandled `error` on a stream is an uncaught exception, and vitest
      // attributes one of those to whichever test happened to be in flight.
      //
      // It is load-dependent and did not reproduce on demand afterwards — twelve
      // further full-suite runs, six with this handler and six without, were all
      // clean — so this handler is reasoned from the stack rather than pinned by
      // a failing test. It closes the class: this stream has no error worth
      // reporting, because the only one it can produce is a reader that already
      // finished.
      child.stdin.on('error', () => undefined);
      child.stdin.end(body);
      let buffered = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (headersSent) {
          response.write(chunk);
          return;
        }
        buffered = Buffer.concat([buffered, chunk]);
        const separator = buffered.indexOf('\r\n\r\n');
        if (separator === -1) return;
        const headers: Record<string, string> = {};
        let status = 200;
        for (const line of buffered.subarray(0, separator).toString('utf8').split('\r\n')) {
          const colon = line.indexOf(':');
          if (colon === -1) continue;
          const name = line.slice(0, colon).trim();
          const value = line.slice(colon + 1).trim();
          if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10);
          else headers[name] = value;
        }
        response.writeHead(status, headers);
        response.write(buffered.subarray(separator + 4));
        headersSent = true;
      });
      child.on('close', () => {
        if (!headersSent) response.writeHead(500);
        response.end();
      });
    });
  });
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}/${options.repositoryName}`,
    requests,
    timesWanted: (objectId: string) => requests.filter((entry) => entry.wants.includes(objectId) && !entry.refused).length,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.skipIf(gitVersion === undefined || backend === undefined)('obtaining the pinned commits', () => {
  let repo: LocalGitFixture;
  /** Served over HTTP; holds the two pinned commits on branches and two more under `refs/pull/*` only. */
  let remoteRoot: string;
  let remoteName: string;
  let emptyConfig: string;
  /** Reachable from no branch on the remote, only from `refs/pull/7/head` — the force-pushed head design D8 describes. */
  let unreachableSha: string;
  /** What `refs/pull/9/head` points at: a different commit, for the hint that answers with the wrong one. */
  let otherSha: string;

  let root: string;
  let servers: ObjectSource[];

  const IDENTITY: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'acme/core' };

  function commitOnTop(label: string): string {
    writeFileSync(join(repo.dir, `${label}.ts`), `export const ${label.toUpperCase()} = 1;\n`);
    runGit(repo, ['add', '--all']);
    runGit(repo, ['commit', '-m', label]);
    return runGit(repo, ['rev-parse', 'HEAD']).stdout.trim();
  }

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 20 });
    remoteRoot = mkdtempSync(join(tmpdir(), 'code-verdict-remote-'));
    remoteName = 'acme-core.git';
    emptyConfig = join(remoteRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const remote = join(remoteRoot, remoteName);
    runGit(repo, ['init', '--bare', '--quiet', remote]);
    // Both pinned commits are branch tips on the remote, which is what a forge
    // serving a change request looks like: the target branch and the change's
    // head both advertised.
    runGit(repo, ['push', '--quiet', remote, `${repo.baseSha}:refs/heads/main`, `${repo.headSha}:refs/heads/change`]);

    unreachableSha = commitOnTop('unreachable');
    otherSha = commitOnTop('other');
    runGit(repo, ['reset', '--hard', repo.headSha]);
    // Pushed only to the forge-side refs, so no branch on the remote reaches
    // either of them.
    runGit(repo, ['push', '--quiet', remote, `${unreachableSha}:refs/pull/7/head`, `${otherSha}:refs/pull/9/head`]);
  });

  afterAll(() => {
    repo?.cleanup();
    if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = objectCacheRoot(mkdtempSync(join(tmpdir(), 'code-verdict-storage-')));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function source(options: Partial<ObjectSourceOptions> = {}): Promise<ObjectSource> {
    const server = await startObjectSource({ projectRoot: remoteRoot, repositoryName: remoteName, emptyConfig, ...options });
    servers.push(server);
    return server;
  }

  /** Runs git against the cache from outside the module under test, so an assertion never reads its own answer back. */
  function inCache(gitDir: string, args: readonly string[]): string {
    const result = runGit(repo, ['--git-dir', gitDir, ...args]);
    return result.stdout.trim();
  }

  describe('a commit fetched by object id (tasks 7.3, 7.4)', () => {
    it('arrives under a ref named after it, one commit deep, and is verified before acquisition is reported', async () => {
      const server = await source();
      const cache = createObjectCache({ root });
      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, authorizationHeaderValue: 'Bearer token-for-the-remote', mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });

      expect(outcome.state).toBe('acquired');
      if (outcome.state !== 'acquired') return;
      expect([...outcome.fetched].sort()).toEqual([repo.baseSha, repo.headSha].sort());
      expect(outcome.alreadyPresent).toEqual([]);

      for (const commit of [repo.baseSha, repo.headSha]) {
        expect(inCache(outcome.gitDir, ['rev-parse', `refs/codeverdict/${commit}`])).toBe(commit);
        expect(inCache(outcome.gitDir, ['rev-parse', `${commit}^{commit}`])).toBe(commit);
        // Depth 1: the pinned commit and nothing behind it (design D3, task 7.9).
        expect(Number(inCache(outcome.gitDir, ['rev-list', '--count', commit]))).toBeLessThanOrEqual(2);
      }
      // Nothing is checked out, ever: the store is bare and has no working tree.
      expect(inCache(outcome.gitDir, ['rev-parse', '--is-bare-repository'])).toBe('true');
      expect(existsSync(join(outcome.gitDir, 'index'))).toBe(false);

      // The credential travelled as a header, which is the only place design D7
      // allows it; `gitInvocation.adversarial.test.ts` proves the other half,
      // that it is in no argument.
      expect(server.requests.some((request) => request.authorization === 'Bearer token-for-the-remote')).toBe(true);
      outcome.lease.release();
    });

    it('records the entry so a later run can find, date and size it (task 7.2)', async () => {
      const server = await source();
      const cache = createObjectCache({ root, now: () => 1_750_000_000_000 });
      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });
      expect(outcome.state).toBe('acquired');

      const metadata = readCacheEntryMetadata(cacheEntryPaths(root, IDENTITY));
      expect(metadata?.identity).toEqual(IDENTITY);
      expect(metadata?.lastUsedAtMs).toBe(1_750_000_000_000);
      expect(metadata?.sizeBytes).toBeGreaterThan(0);
      expect([...(metadata?.commits ?? [])].sort()).toEqual([repo.baseSha, repo.headSha].sort());
      if (outcome.state === 'acquired') outcome.lease.release();
    });

    it('two attempts wanting the same commit converge on one ref and one fetch', async () => {
      const server = await source();
      const cache = createObjectCache({ root });
      const request = {
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        headCommit: repo.headSha,
      };
      const first = await cache.acquire({ ...request, attemptId: 'attempt-1' });
      const second = await cache.acquire({ ...request, attemptId: 'attempt-2' });

      expect(first.state).toBe('acquired');
      expect(second.state).toBe('acquired');
      if (first.state !== 'acquired' || second.state !== 'acquired') return;
      expect([...first.fetched].sort()).toEqual([repo.baseSha, repo.headSha].sort());
      // The second attempt found what the first left, and paid nothing.
      expect(second.fetched).toEqual([]);
      expect([...second.alreadyPresent].sort()).toEqual([repo.baseSha, repo.headSha].sort());
      expect(first.gitDir).toBe(second.gitDir);
      expect(server.timesWanted(repo.headSha)).toBe(1);
      first.lease.release();
      second.lease.release();
    });

    it('never reports a commit as acquired when it is not in the store afterwards (task 7.4)', async () => {
      // A remote that says yes and sends nothing. Git's own object-id checks make
      // this unreachable in practice, which is exactly why the verification has
      // to be tested through a runner that can lie: design D8 makes "the fetched
      // object is not the pinned sha" a hard failure, and a hard failure nobody
      // has ever exercised is a comment.
      const server = await source();
      const lyingRunner: GitRunner = async (plan, context) =>
        plan.kind === 'fetchCommit'
          ? { state: 'ok', stdout: Buffer.alloc(0), exitCode: 0, stderrExcerpt: '', durationMs: 1 }
          : runGitInvocation(plan, context);
      const cache = createObjectCache({ root, run: lyingRunner });

      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });

      expect(outcome.state).toBe('commitUnobtainable');
      if (outcome.state !== 'commitUnobtainable') return;
      expect(outcome.code).toBe('wrongObject');
      expect(outcome.commit).toBe(repo.headSha);
      expect(inCache(cacheEntryPaths(root, IDENTITY).gitDir, ['rev-parse', '--verify', '--quiet', `${repo.headSha}^{commit}`])).toBe('');
    });
  });

  describe('the ref-hint retry (task 7.5)', () => {
    it('is defending against something: this remote really does refuse the object id it will serve under a name', async () => {
      // The gate, exercised directly through the same builder acquisition uses,
      // so the retry below is measured against a refusal that happens rather
      // than one that is described.
      //
      // Everything that talks to this server is asynchronous on purpose. The
      // server runs in this process, so a synchronous git — `spawnSync`, which
      // `runGit` is — blocks the event loop the server needs to answer on, and
      // the fetch waits for a reply nobody can send. Measured: it deadlocks
      // until the suite is killed. `runGit` is used here only against local
      // directories, where there is no server in the loop.
      const server = await source({ refuse: 'objectIdsNobodyNamed', hintRef: 'refs/pull/7/head' });
      const store = mkdtempSync(join(tmpdir(), 'code-verdict-direct-'));
      const probe = join(store, 'probe.git');
      runGit(repo, ['init', '--bare', '--quiet', probe]);
      try {
        const byId = planGitInvocation({ kind: 'fetchCommit', fetchUrl: server.url, commit: unreachableSha, depth: 1 });
        expect(byId.ok).toBe(true);
        if (!byId.ok) return;
        expect((await runGitInvocation(byId.plan, { gitDir: probe })).state).toBe('failed');

        const byName = planGitInvocation({ kind: 'fetchCommit', fetchUrl: server.url, commit: unreachableSha, depth: 1, refHint: 'refs/pull/7/head' });
        expect(byName.ok).toBe(true);
        if (!byName.ok) return;
        expect((await runGitInvocation(byName.plan, { gitDir: probe })).state).toBe('ok');
        expect(inCache(probe, ['rev-parse', `refs/codeverdict/${unreachableSha}`])).toBe(unreachableSha);
      } finally {
        rmSync(store, { recursive: true, force: true });
      }
    });

    it('retries with the opaque hint and accepts the object only because it verified as the pinned one', async () => {
      const server = await source({ refuse: 'objectIdsNobodyNamed', hintRef: 'refs/pull/7/head' });
      const cache = createObjectCache({ root });
      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, refHint: 'refs/pull/7/head', mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: unreachableSha,
      });

      expect(outcome.state).toBe('acquired');
      if (outcome.state !== 'acquired') return;
      // The pinned head arrived through the hint, and the commit its diff is
      // against arrived with the target branch in the same operation.
      expect(outcome.fetched).toContain(unreachableSha);
      expect(outcome.baseSha).toBe(repo.baseSha);
      // The object id was asked for first and refused; only then was the hint used.
      const refusedFirst = server.requests.findIndex((request) => request.refused);
      const namedLater = server.requests.findIndex((request) => request.namedHint);
      expect(refusedFirst).toBeGreaterThanOrEqual(0);
      expect(namedLater).toBeGreaterThan(refusedFirst);
      expect(inCache(outcome.gitDir, ['rev-parse', `refs/codeverdict/${unreachableSha}`])).toBe(unreachableSha);
      outcome.lease.release();
    });

    it('refuses a hint that resolves to a different commit, and leaves no ref behind that says otherwise', async () => {
      // `refs/pull/9/head` exists and resolves — it simply holds the wrong
      // commit. Without the check by object id this is exactly how a review ends
      // up reading code that is not the code it was asked about.
      const server = await source({ refuse: 'objectIdsNobodyNamed', hintRef: 'refs/pull/9/head' });
      const cache = createObjectCache({ root });
      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, refHint: 'refs/pull/9/head', mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: unreachableSha,
      });

      expect(outcome.state).toBe('commitUnobtainable');
      if (outcome.state !== 'commitUnobtainable') return;
      expect(outcome.code).toBe('hintMismatch');
      expect(outcome.commit).toBe(unreachableSha);
      const gitDir = cacheEntryPaths(root, IDENTITY).gitDir;
      // The commit the hint really pointed at did arrive, and it is not allowed
      // to keep the pinned commit's name. The ref is the whole of the guarantee:
      // `isHeld` requires the ref to name the commit *and* the object to be
      // present, so a ref that is gone cannot be read through however many
      // objects a deeper fetch happened to bring with it. Asserting the object
      // absent as well would be asserting the fetch depth, not the safety
      // property — and at depth 10 an ancestor of what the hint pointed at
      // legitimately lands in the database.
      expect(inCache(gitDir, ['rev-parse', '--verify', '--quiet', `refs/codeverdict/${unreachableSha}`])).toBe('');
    });

    it('reports a remote that refuses a commit it still holds as refused, never as gone', async () => {
      // Genuine end to end: protocol v0 with `uploadpack.hideRefs` set on the
      // remote itself. Measured on 2026-09-11, this refuses the object id with
      // "Server does not allow request for unadvertised object" and the ref by
      // name with "couldn't find remote ref" — a commit the remote is holding
      // and will not serve either way, which is design D8's own row.
      runGit(repo, ['--git-dir', join(remoteRoot, remoteName), 'config', 'uploadpack.hideRefs', 'refs/pull']);
      try {
        const server = await source({ protocol: 'v0' });
        const cache = createObjectCache({ root });
        const outcome = await cache.acquire({
          identity: IDENTITY,
          descriptor: { fetchUrl: server.url, refHint: 'refs/pull/7/head', mergeTargetRef: 'refs/heads/main' },
          attemptId: 'attempt-1',
          headCommit: unreachableSha,
        });

        expect(outcome.state).toBe('commitUnobtainable');
        if (outcome.state !== 'commitUnobtainable') return;
        expect(outcome.code).toBe('fetchFailed');
        // Design D8: a refusal establishes nothing about whether the commit
        // exists, and task 9.9 settles that with the provider. This reason must
        // not pre-empt it.
        expect(outcome.reason).not.toMatch(/gone|missing|absent|deleted|no longer|does not exist/i);
        // Both attempts really were made — the hint was tried, not skipped.
        expect(server.requests.filter((request) => request.path.includes('/info/refs')).length).toBeGreaterThanOrEqual(2);
      } finally {
        runGit(repo, ['--git-dir', join(remoteRoot, remoteName), 'config', '--unset', 'uploadpack.hideRefs']);
      }
    });
  });

  describe('two attempts at once (task 7.11)', () => {
    it('serves both, fetches the shared commit once, and blocks neither', async () => {
      const server = await source();
      const cache = createObjectCache({ root });
      const request = { identity: IDENTITY, descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' }, headCommit: repo.headSha };

      const [first, second] = await Promise.all([
        cache.acquire({ ...request, attemptId: 'attempt-1' }),
        cache.acquire({ ...request, attemptId: 'attempt-2' }),
      ]);

      expect(first.state).toBe('acquired');
      expect(second.state).toBe('acquired');
      if (first.state !== 'acquired' || second.state !== 'acquired') return;
      // One of them did the work and the other found it done; which one is a
      // race, and either way round is correct.
      const fetched = [...first.fetched, ...second.fetched].sort();
      expect(fetched).toEqual([repo.baseSha, repo.headSha].sort());
      // The head is asked for once across both attempts: it is an object id, so
      // once the store holds it there is nothing to re-read, and the second
      // attempt fetches only the target branch.
      expect(server.timesWanted(repo.headSha)).toBe(1);
      // The target branch is a *name*, and where it points now is exactly what a
      // merge base is computed against, so each attempt does re-read it. That is
      // the cost of computing the base here instead of taking a forge's word for
      // it, and it is one refspec rather than two.
      expect(server.timesWanted(repo.baseSha)).toBeGreaterThanOrEqual(1);
      for (const commit of [repo.baseSha, repo.headSha]) {
        expect(inCache(first.gitDir, ['rev-parse', `refs/codeverdict/${commit}`])).toBe(commit);
      }
      first.lease.release();
      second.lease.release();
    });
  });

  describe('the reviewer’s own repository (task 7.10)', () => {
    /** Every file under a directory, by content, size and modification time. */
    function snapshot(directory: string): Map<string, string> {
      const state = new Map<string, string>();
      const walk = (current: string): void => {
        for (const entry of readdirSync(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          const stats = lstatSync(path);
          if (stats.isDirectory()) {
            walk(path);
            continue;
          }
          const digest = stats.isFile() ? createHash('sha256').update(readFileSync(path)).digest('hex') : 'not-a-file';
          state.set(relative(directory, path), `${digest}:${String(stats.size)}:${String(stats.mtimeMs)}`);
        }
      };
      walk(directory);
      return state;
    }

    it('is never read, written, fetched into, or borrowed from — including when it is the repository under review', async () => {
      const server = await source();
      // The identity of the repository the reviewer happens to have open. The
      // cache path comes from the identity and nothing else, so this is the case
      // where a path built from anything the workspace knows would collide.
      const openWorkspace: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'acme/the-open-one' };

      const before = snapshot(repo.dir);
      const seen: Array<{ readonly kind: string; readonly gitDir: string | undefined; readonly args: readonly string[] }> = [];
      const watchful: GitRunner = async (plan, context) => {
        seen.push({ kind: plan.kind, gitDir: context.gitDir, args: gitProcessArguments(plan, context) });
        return runGitInvocation(plan, context);
      };

      const cache = createObjectCache({ root, run: watchful });
      const outcome = await cache.acquire({
        identity: openWorkspace,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });
      expect(outcome.state).toBe('acquired');
      if (outcome.state !== 'acquired') return;

      // 1. The reviewer's repository is byte-for-byte what it was, `.git` and all.
      expect(snapshot(repo.dir)).toEqual(before);

      // 2. Every invocation ran against the cache, and none of them so much as
      //    named the reviewer's directory. This is the half a snapshot cannot
      //    prove: a read leaves no trace.
      expect(seen.length).toBeGreaterThan(0);
      for (const invocation of seen) {
        expect(invocation.gitDir).toBeDefined();
        expect(invocation.gitDir?.startsWith(root)).toBe(true);
        for (const argument of invocation.args) expect(argument.includes(repo.dir)).toBe(false);
      }

      // 3. No alternates donor. Design D3 rejects even the weak form of pointing
      //    at a clone the reviewer owns, and this is the file that would do it.
      expect(existsSync(join(outcome.gitDir, 'objects', 'info', 'alternates'))).toBe(false);

      // 4. The store is under the extension's own cache root, not under the
      //    workspace, however the identity was spelled.
      expect(outcome.gitDir.startsWith(root)).toBe(true);
      expect(outcome.gitDir.startsWith(repo.dir)).toBe(false);
      outcome.lease.release();
    });
  });

  /**
   * Design D8's credentials row, and the boundary that makes it safe (tasks
   * 10.3, 10.4).
   *
   * Both halves matter. A source that will not authorize the fetch has to be
   * nameable, because "credentials refused" is the one acquisition failure a
   * reviewer can act on, and because the fetch never got as far as asking about
   * a commit — so nothing may be said about the pinned revisions. And a source
   * that authorizes the connection but declines to serve an object nobody
   * advertised must NOT be read as that: it answers 403, git reports it in the
   * same family of words, and reading it as a credential problem would skip the
   * ref-hint retry that actually recovers it.
   */
  describe('an object source that will not authorize the fetch (design D8, task 10.3)', () => {
    it('is reported as refused credentials, says nothing about the revisions, and stops after one request', async () => {
      const server = await source({ refuse: 'unauthorized' });
      const cache = createObjectCache({ root });

      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, authorizationHeaderValue: 'Bearer no-longer-valid', refHint: 'refs/pull/7/head', mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });

      expect(outcome.state).toBe('unavailable');
      if (outcome.state !== 'unavailable') return;
      expect(outcome.code).toBe('credentialsRefused');
      expect(outcome.reason).toMatch(/would not authorize this fetch/);
      // Not `commitUnobtainable`: this says nothing about whether the platform
      // still holds the commit, so selection must not take the question to the
      // provider as a possible absence (design D8, task 9.9).
      expect(outcome).not.toHaveProperty('commit');
      // The ref-hint retry is skipped: the same source refusing the same
      // credential will refuse the retry, and design D8 calls this failure
      // non-retryable.
      expect(server.requests.every((request) => request.namedHint === false)).toBe(true);
    });

    it('never reads a forge’s refusal to serve an unadvertised object as a credential problem', async () => {
      // The 403 case task 7.5 exists for. If this ever came back
      // `credentialsRefused`, the ref-hint retry would be skipped and a
      // force-pushed head would stop being reachable at all.
      const server = await source({ refuse: 'objectIdsNobodyNamed', hintRef: 'refs/pull/7/head' });
      const cache = createObjectCache({ root });

      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: unreachableSha,
      });

      expect(outcome.state).toBe('commitUnobtainable');
      if (outcome.state !== 'commitUnobtainable') return;
      expect(outcome.code).toBe('fetchFailed');
      expect(outcome.commit).toBe(unreachableSha);
    });
  });

  describe('a cache location that cannot be written (task 7.12)', () => {
    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('declares itself unavailable with that reason, and asks the remote for nothing', async () => {
      const server = await source();
      const readOnly = mkdtempSync(join(tmpdir(), 'code-verdict-read-only-'));
      chmodSync(readOnly, 0o500);
      try {
        const cache = createObjectCache({ root: join(readOnly, 'object-cache') });
        const outcome = await cache.acquire({
          identity: IDENTITY,
          descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
          attemptId: 'attempt-1',
          headCommit: repo.headSha,
        });

        expect(outcome.state).toBe('unavailable');
        if (outcome.state !== 'unavailable') return;
        expect(outcome.code).toBe('cacheUnwritable');
        expect(outcome.reason).toMatch(/could not be created or written to/);
        // Nothing anywhere else: no fetch was attempted, and the location it
        // could not write to is still empty.
        expect(server.requests).toEqual([]);
        expect(readdirSync(readOnly)).toEqual([]);
      } finally {
        chmodSync(readOnly, 0o700);
        rmSync(readOnly, { recursive: true, force: true });
      }
    });
  });

  describe('eviction after an acquisition (task 7.8)', () => {
    it('never removes the objects the acquisition just obtained', async () => {
      const server = await source();
      // A bound one byte wide: eviction runs at the end of every acquisition, and
      // this is the state in which it would take the entry that was just written
      // if the lease did not hold it.
      const cache = createObjectCache({ root, policy: { cacheMaxBytes: 1 } });
      const outcome = await cache.acquire({
        identity: IDENTITY,
        descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
        attemptId: 'attempt-1',
        headCommit: repo.headSha,
      });

      expect(outcome.state).toBe('acquired');
      if (outcome.state !== 'acquired') return;
      for (const commit of [repo.baseSha, repo.headSha]) {
        expect(inCache(outcome.gitDir, ['rev-parse', `refs/codeverdict/${commit}`])).toBe(commit);
      }

      // And once the attempt lets go, the same bound does remove it.
      outcome.lease.release();
      await cache.evict();
      expect(existsSync(cacheEntryPaths(root, IDENTITY).directory)).toBe(false);
    });
  });
});

/**
 * The one case the ladder gets wrong if the warm-store shortcut is applied to
 * every rung rather than only the first.
 *
 * A second attempt on a repository whose head is already held fetches only the
 * target branch, because a commit id cannot have changed since. That is right
 * for the first rung and wrong for every later one: if the merge base is deeper
 * than the history already held, deepening only the branch reaches the common
 * ancestor on one side and never on the other. The refusal that follows would
 * claim no ancestor exists "on either side", which is false, and a fresh cache
 * would have served the same change.
 *
 * The fixture is that shape exactly: a head held at depth 1 from an earlier
 * fetch, and a target branch whose merge base with it is further back than one
 * commit.
 */
describe.skipIf(gitExecutableVersion() === undefined)('escalating the ladder deepens both sides, not only the branch', () => {
  let repo: LocalGitFixture;
  let remoteRoot: string;
  let root: string;
  let servers: ObjectSource[];
  let emptyConfig: string;

  const IDENTITY: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'acme/deep' };

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 4 });
    remoteRoot = mkdtempSync(join(tmpdir(), 'code-verdict-deep-'));
    emptyConfig = join(remoteRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const remote = join(remoteRoot, 'acme-deep.git');
    runGit(repo, ['init', '--bare', '--quiet', remote]);
    // `main` at the base commit, the change's head on its own branch: the merge
    // base is one commit behind the head, so a head held at depth 1 does not
    // contain it and the ladder has to deepen the head side to find it.
    runGit(repo, ['push', '--quiet', remote, `${repo.baseSha}:refs/heads/main`, `${repo.headSha}:refs/heads/change`]);
  });

  afterAll(() => {
    repo?.cleanup();
    if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'code-verdict-deep-cache-'));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('finds the merge base on a warm store whose held head is shallower than the base', async () => {
    const server = await startObjectSource({ projectRoot: remoteRoot, repositoryName: 'acme-deep.git', emptyConfig });
    servers.push(server);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };

    // Attempt 1, at depth 1: the head lands in the store and the merge base is
    // not in the history either side holds, so this refuses. That is correct,
    // and it is the state attempt 2 starts from.
    const shallow = createObjectCache({ root, policy: { fetchDepth: 1, mergeBaseDepthFactor: 1, mergeBaseMaxDepth: 1 } });
    const first = await shallow.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: repo.headSha });
    expect(first.state).toBe('commitUnobtainable');
    if (first.state === 'commitUnobtainable') expect(first.code).toBe('mergeBaseNotFound');

    // Attempt 2 with a real ladder. The head is already held, so the first rung
    // asks only for the branch; when that does not produce a merge base, the
    // escalation has to fetch both sides or the head stays one commit deep
    // forever.
    const laddered = createObjectCache({ root, policy: { fetchDepth: 1, mergeBaseDepthFactor: 10, mergeBaseMaxDepth: 10 } });
    const second = await laddered.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-2', headCommit: repo.headSha });

    expect(second.state, second.state === 'commitUnobtainable' ? second.reason : '').toBe('acquired');
    if (second.state !== 'acquired') return;
    expect(second.baseSha).toBe(repo.baseSha);
    expect(second.depthReached).toBeGreaterThan(1);
    second.lease.release();
  });
});

/**
 * The merge base acquisition accepts is the one a full clone would report — or
 * the attempt fails and says what it could not establish.
 *
 * **The live failure this group was written for.** `git merge-base` in a
 * shallow store answers over the history that was fetched, not over the
 * repository. It cannot say which of the two it answered, and a wrong answer
 * looks exactly like a right one: an object id, exit 0. Measured on 2026-09-11
 * through `createObjectCache` with the default policy, git 2.55.0, against the
 * `git-http-backend` remote below, on the shape the first case builds:
 *
 *     DEFAULT-POLICY OUTCOME {"state":"acquired","baseSha":"4dd2d4b…","depthReached":10}
 *     TRUE MERGE BASE = 542cc47…   ACCEPTED BASE = 4dd2d4b…
 *
 * The review then reads a diff against an older commit than the change request
 * is against — every commit between the two shows up as part of the change —
 * with no error anywhere. That is the failure this whole line of work exists to
 * prevent, arriving from inside the thing that replaced the forge.
 *
 * **Every case here asserts against a real full clone of the same remote**,
 * never against a sha this file computed some other way: "what a full clone
 * reports" is the property, so the test asks a full clone.
 */
describe.skipIf(gitVersion === undefined || backend === undefined)('the merge base is the one a full clone would report', () => {
  let repo: LocalGitFixture;
  let remoteRoot: string;
  let emptyConfig: string;
  let root: string;
  let servers: ObjectSource[];

  const IDENTITY: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'acme/shaped' };

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 4 });
    remoteRoot = mkdtempSync(join(tmpdir(), 'code-verdict-shaped-'));
    emptyConfig = join(remoteRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
  });

  afterAll(() => {
    repo?.cleanup();
    if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = objectCacheRoot(mkdtempSync(join(tmpdir(), 'code-verdict-shaped-cache-')));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  function git(args: readonly string[]): string {
    const result = runGit(repo, args);
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed (${String(result.status)}): ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  /** History with a shape, built from empty commits: the graph is the fixture, not the file contents. */
  function commitsOn(branch: string, at: string, count: number, label: string): string {
    git(['checkout', '--quiet', '-B', branch, at]);
    for (let i = 1; i <= count; i += 1) git(['commit', '--quiet', '--allow-empty', '-m', `${label}-${String(i)}`]);
    return git(['rev-parse', 'HEAD']);
  }

  /** A bare remote under the served root, holding exactly the refs named. */
  function publish(name: string, refspecs: readonly string[]): string {
    git(['init', '--bare', '--quiet', join(remoteRoot, name)]);
    git(['push', '--quiet', join(remoteRoot, name), ...refspecs]);
    return name;
  }

  /**
   * The answer this rule is measured against: a real `git clone` of the same
   * remote, with no depth, asked the same question. Empty when the two have no
   * common ancestor, which is what `merge-base` reports with exit 1.
   */
  function mergeBaseFromFullClone(remoteName: string, head: string): string {
    const clone = join(remoteRoot, `full-${remoteName}`);
    rmSync(clone, { recursive: true, force: true });
    git(['clone', '--bare', '--quiet', join(remoteRoot, remoteName), clone]);
    return runGit(repo, ['--git-dir', clone, 'merge-base', head, 'refs/heads/main']).stdout.trim();
  }

  async function serving(remoteName: string): Promise<ObjectSource> {
    const server = await startObjectSource({ projectRoot: remoteRoot, repositoryName: remoteName, emptyConfig });
    servers.push(server);
    return server;
  }

  /**
   * The shape that produces a wrong answer with no error: the head is a merge
   * commit that reaches an *older* common ancestor by a short path, while the
   * true merge base sits deeper than the first fetch on that side.
   *
   *     X ── m1 ── T ── m2 ── m3          <- refs/heads/main, the target branch
   *     │           └── f1 … f12 ─┐
   *     └── Y ────────────────────┴── M   <- the pinned head, a merge commit
   *
   * `X` is two commits from `M` and five from `main`, so a depth-10 fetch holds
   * it from both sides and `git merge-base` answers it. `T` — the real merge
   * base — is fourteen commits from `M`, past the boundary, so the head side
   * cannot reach it and git never considers it.
   */
  function buildCounterexample(name: string): { readonly remoteName: string; readonly head: string } {
    const oldAncestor = git(['rev-parse', repo.baseSha]);
    const mainTip = commitsOn(`${name}-main`, oldAncestor, 4, 'm');
    // `T`, two behind the tip: the fork point the change was branched from.
    const trueBase = git(['rev-parse', `${mainTip}~2`]);

    const side = `${name}-side`;
    commitsOn(side, oldAncestor, 1, 'Y');

    commitsOn(`${name}-feature`, trueBase, 12, 'f');
    git(['merge', '--quiet', '--no-ff', '-m', 'M', side]);
    const head = git(['rev-parse', 'HEAD']);

    const remoteName = publish(`${name}.git`, [`${mainTip}:refs/heads/main`, `${head}:refs/heads/change`]);
    return { remoteName, head };
  }

  it('refuses the older common ancestor a shallow store answers with, and reports the one a full clone does', async () => {
    const { remoteName, head } = buildCounterexample('counterexample');
    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };

    // The production policy, unmodified: 10, then x10 twice, bounded at 1000.
    const cache = createObjectCache({ root });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    const fullClone = mergeBaseFromFullClone(remoteName, head);
    expect(fullClone).toMatch(/^[0-9a-f]{40}$/);
    expect(outcome.state, outcome.state === 'commitUnobtainable' ? outcome.reason : '').toBe('acquired');
    if (outcome.state !== 'acquired') return;
    expect(outcome.baseSha).toBe(fullClone);
    outcome.lease.release();
  });

  it('never substitutes an unproven answer when the bound is reached, and says what it could not establish', async () => {
    const { remoteName, head } = buildCounterexample('bounded');
    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };

    // One rung and no deeper: the candidate is there, the proof is not.
    const cache = createObjectCache({ root, policy: { fetchDepth: 10, mergeBaseMaxDepth: 10 } });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    expect(outcome.state).toBe('commitUnobtainable');
    if (outcome.state !== 'commitUnobtainable') {
      if (outcome.state === 'acquired') outcome.lease.release();
      return;
    }
    // The wrong answer is the one a shallow store would have handed back.
    const wrong = git(['rev-parse', repo.baseSha]);
    expect(outcome.reason).not.toContain(wrong);
    expect(outcome.reason).toMatch(/could not be established|deep enough/i);
  });

  it('proves the merge base on the first rung of an ordinary change, without a second fetch', async () => {
    const trunk = commitsOn('linear-main', repo.baseSha, 30, 'b');
    const forkPoint = trunk;
    const head = commitsOn('linear-change', forkPoint, 3, 'c');
    git(['checkout', '--quiet', 'linear-main']);
    git(['commit', '--quiet', '--allow-empty', '-m', 'trunk-moves']);
    const mainTip = git(['rev-parse', 'HEAD']);
    const remoteName = publish('linear.git', [`${mainTip}:refs/heads/main`, `${head}:refs/heads/change`]);

    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };
    const cache = createObjectCache({ root });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    expect(outcome.state, outcome.state === 'commitUnobtainable' ? outcome.reason : '').toBe('acquired');
    if (outcome.state !== 'acquired') return;
    expect(outcome.baseSha).toBe(mergeBaseFromFullClone(remoteName, head));
    // The first rung answered, and the proof cost no extra round trip: a
    // deepening would have moved this to 100.
    expect(outcome.depthReached).toBe(10);
    // And it really was proven rather than waved through: this store still has
    // a shallow boundary, it is just deeper than the merge base on both sides.
    expect(runGit(repo, ['--git-dir', outcome.gitDir, 'rev-parse', '--is-shallow-repository']).stdout.trim()).toBe('true');
    outcome.lease.release();
  });

  it('deepens once when the merge base is behind the first fetch, and proves it there', async () => {
    const forkPoint = commitsOn('deepen-main', repo.baseSha, 8, 'b');
    const head = commitsOn('deepen-change', forkPoint, 15, 'g');
    git(['checkout', '--quiet', 'deepen-main']);
    for (let i = 1; i <= 3; i += 1) git(['commit', '--quiet', '--allow-empty', '-m', `m${String(i)}`]);
    const mainTip = git(['rev-parse', 'HEAD']);
    const remoteName = publish('deepen.git', [`${mainTip}:refs/heads/main`, `${head}:refs/heads/change`]);

    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };
    const cache = createObjectCache({ root });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    expect(outcome.state, outcome.state === 'commitUnobtainable' ? outcome.reason : '').toBe('acquired');
    if (outcome.state !== 'acquired') return;
    expect(outcome.baseSha).toBe(forkPoint);
    expect(outcome.baseSha).toBe(mergeBaseFromFullClone(remoteName, head));
    expect(outcome.depthReached).toBe(100);
    outcome.lease.release();
  });

  /**
   * The candidate that needs no boundary at all: the target branch's own tip.
   *
   * `merge-base` answering the target tip means the target tip is an ancestor of
   * the head, and nothing can beat one of the two pinned revisions — every
   * common ancestor of the pair is an ancestor of both. So asking how deep the
   * history goes *above* it is asking about history the answer does not depend
   * on, and refusing for want of it would refuse a review that is provably
   * right. The shape below has exactly that frontier: a long leg merged into the
   * head, cut off well above the merge base.
   */
  it('accepts the target branch’s own tip without asking how deep the history above it goes', async () => {
    const oldAncestor = git(['rev-parse', repo.baseSha]);
    const mainTip = commitsOn('tip-main', oldAncestor, 2, 'm');
    const longLeg = 'tip-long';
    commitsOn(longLeg, oldAncestor, 15, 'l');
    commitsOn('tip-feature', mainTip, 3, 'f');
    git(['merge', '--quiet', '--no-ff', '-m', 'M', longLeg]);
    const head = git(['rev-parse', 'HEAD']);
    const remoteName = publish('tip.git', [`${mainTip}:refs/heads/main`, `${head}:refs/heads/change`]);

    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };
    // One rung and no deeper: without the rule above, the long leg's boundary
    // sits above the candidate and this would refuse at the bound.
    const cache = createObjectCache({ root, policy: { fetchDepth: 10, mergeBaseMaxDepth: 10 } });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    expect(outcome.state, outcome.state === 'commitUnobtainable' ? outcome.reason : '').toBe('acquired');
    if (outcome.state !== 'acquired') return;
    expect(outcome.baseSha).toBe(mainTip);
    expect(outcome.baseSha).toBe(mergeBaseFromFullClone(remoteName, head));
    expect(outcome.depthReached).toBe(10);
    outcome.lease.release();
  });

  it('reports a change request with no common ancestor at all as its own fact, not as an unproven base', async () => {
    const mainTip = commitsOn('unrelated-main', repo.baseSha, 3, 'b');
    // A root commit of its own, written with plumbing so the working tree is
    // never touched: `--orphan` leaves the checkout in a state the next case
    // would have to clean up, and what this case needs is a parentless commit,
    // not a branch.
    const head = git(['commit-tree', '-m', 'a history of its own', `${mainTip}^{tree}`]);
    const remoteName = publish('unrelated.git', [`${mainTip}:refs/heads/main`, `${head}:refs/heads/change`]);

    const server = await serving(remoteName);
    const descriptor = { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' };
    const cache = createObjectCache({ root });
    const outcome = await cache.acquire({ identity: IDENTITY, descriptor, attemptId: 'attempt-1', headCommit: head });

    // A full clone agrees there is none, which is what makes this a different
    // fact from "not in the history that was fetched".
    expect(mergeBaseFromFullClone(remoteName, head)).toBe('');
    expect(outcome.state).toBe('commitUnobtainable');
    if (outcome.state !== 'commitUnobtainable') {
      if (outcome.state === 'acquired') outcome.lease.release();
      return;
    }
    expect(outcome.code).toBe('mergeBaseNotFound');
    expect(outcome.reason).toContain('no common ancestor');
  });
});

/**
 * The deepening ladder ends, and the lock knows how long it can take.
 *
 * **The live failure.** The acquisition loop computed its next rung itself —
 * `depth = Math.min(depth * policy.mergeBaseDepthFactor, policy.mergeBaseMaxDepth)`
 * — while `lockStaleFor` counted rungs with its own arithmetic. The two
 * disagreed about `mergeBaseDepthFactor: 1`. Multiplying a depth by 1 leaves it
 * where it was, so the loop's `depth >= mergeBaseMaxDepth` exit never came and
 * the ladder had no end: measured on 2026-09-11 against the `git-http-backend`
 * remote below, 13 identical depth-10 fetches went out before the verifier's own
 * guard stopped the run. Each rung is a real network round trip, so this was an
 * unbounded run of fetches rather than a hang. `lockStaleFor` meanwhile refused
 * to count a rung for a factor that could not deepen, derived 1 rung — 540,000
 * ms — and a second attempt could have declared that lock stale and seized it
 * while the first was still fetching.
 *
 * `normalizeLocalGitPolicy` accepted the factor (and floored 1.5 to 1), so the
 * schedule was only discovered to be impossible on the thirteenth fetch. Both
 * readers now consume `depthLadder`, and the schedule is checked where it is
 * built.
 *
 * The two cases below are deliberately different in kind. The first runs the
 * real loop against the real remote, because the claim is about fetches that
 * really go out. The second drives a grid of schedules through a runner that
 * answers everything, because the claim is about arithmetic and a grid of real
 * ladders would be twenty round trips for an answer no round trip is needed to
 * give.
 */
describe.skipIf(gitVersion === undefined)('the deepening ladder always ends', () => {
  let repo: LocalGitFixture;
  let remoteRoot: string;
  let emptyConfig: string;
  let root: string;
  let servers: ObjectSource[];

  /** One repository, one head, one target branch — the shape is not what this group varies. */
  const REMOTE = 'ladder.git';

  const identityFor = (repoId: string): RepositoryIdentity => ({ providerId: 'github', instanceUrl: 'https://api.github.com', repoId });

  /** How long `lockStaleFor` allows for one rung, so a threshold can be read back as a rung count. */
  const perRungMs = (policy: LocalGitPolicy): number => 2 * policy.fetchTimeoutMs + 10 * policy.readTimeoutMs;

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 4 });
    remoteRoot = mkdtempSync(join(tmpdir(), 'code-verdict-ladder-'));
    emptyConfig = join(remoteRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    runGit(repo, ['init', '--bare', '--quiet', join(remoteRoot, REMOTE)]);
    runGit(repo, ['push', '--quiet', join(remoteRoot, REMOTE), `${repo.baseSha}:refs/heads/main`, `${repo.headSha}:refs/heads/change`]);
  });

  afterAll(() => {
    repo?.cleanup();
    if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = objectCacheRoot(mkdtempSync(join(tmpdir(), 'code-verdict-ladder-cache-')));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await server.close();
    rmSync(root, { recursive: true, force: true });
  });

  /** The `--depth=` this plan carries, read off the arguments git would actually be given. */
  function depthOf(plan: Parameters<GitRunner>[0], context: Parameters<GitRunner>[1]): number {
    const flag = gitProcessArguments(plan, context).find((argument) => argument.startsWith('--depth='));
    return flag === undefined ? 0 : Number(flag.slice('--depth='.length));
  }

  const ok = (text = ''): Awaited<ReturnType<GitRunner>> => ({ state: 'ok', stdout: Buffer.from(text), exitCode: 0, stderrExcerpt: '', durationMs: 1 });

  /**
   * A store that never finds a merge base and never stops being shallow, so the
   * loop runs its schedule to the last rung instead of exiting early.
   *
   * `cap` is the tripwire, and it is here rather than in a test timeout on
   * purpose: a loop that never advances also never yields to a timer, so the
   * run wedges instead of failing. Counting the fetches fails on the fetch that
   * proves the schedule is not a schedule, and says how many there were.
   */
  function runsEveryRung(cap: number, fetches: 'really' | 'answered'): { readonly run: GitRunner; readonly depths: number[] } {
    const depths: number[] = [];
    const run: GitRunner = async (plan, context) => {
      switch (plan.kind) {
        case 'fetchCommit':
        case 'fetchMergeTarget': {
          depths.push(depthOf(plan, context));
          if (depths.length > cap) throw new Error(`the ladder ran ${String(depths.length)} fetches: ${depths.join(', ')}`);
          return fetches === 'really' ? runGitInvocation(plan, context) : ok();
        }
        // A fetch that was answered rather than run leaves nothing in the store,
        // so the presence checks are answered too: what this mode measures is
        // the rungs, and a rung the store cannot satisfy ends the loop for a
        // reason that has nothing to do with the schedule.
        case 'readCommitRef':
        case 'verifyCommit':
          return fetches === 'answered' ? ok(`${repo.headSha}\n`) : runGitInvocation(plan, context);
        case 'readMergeTargetRef':
          return fetches === 'answered' ? ok(`${repo.baseSha}\n`) : runGitInvocation(plan, context);
        // No merge base in this store, ever.
        case 'mergeBase':
          return ok();
        // And always more history to go looking in, so the ladder never stops early.
        case 'isShallow':
          return ok('true\n');
        default:
          return runGitInvocation(plan, context);
      }
    };
    return { run, depths };
  }

  it('stops after the schedule’s last rung against a real remote, even when the factor cannot deepen', async () => {
    const server = await startObjectSource({ projectRoot: remoteRoot, repositoryName: REMOTE, emptyConfig });
    servers.push(server);
    // Eight is comfortably more than the three rungs the default schedule has,
    // and far fewer than the thirteen the unbounded loop had reached when it was
    // stopped from outside.
    const ladder = runsEveryRung(8, 'really');
    const cache = createObjectCache({ root, run: ladder.run, policy: { mergeBaseDepthFactor: 1 } });

    const outcome = await cache.acquire({
      identity: identityFor('acme/ladder'),
      descriptor: { fetchUrl: server.url, mergeTargetRef: 'refs/heads/main' },
      attemptId: 'attempt-1',
      headCommit: repo.headSha,
    });

    // A factor of 1 is not a shallower ladder, it is one that never ends, so the
    // policy is normalized to the schedule that does: 10, 100, 1000.
    expect(ladder.depths).toEqual([10, 100, 1000]);
    expect(outcome.state).toBe('commitUnobtainable');
    if (outcome.state !== 'commitUnobtainable') {
      if (outcome.state === 'acquired') outcome.lease.release();
      return;
    }
    expect(outcome.code).toBe('mergeBaseNotFound');
    expect(outcome.reason).toContain('1000');
  });

  /**
   * Every rung the loop asks for, for schedules a caller might actually pass —
   * including the three that used to be accepted and could not be run.
   *
   * The depths are written out rather than recomputed from the policy, so this
   * says what the schedule *is* instead of agreeing with whatever the code
   * derives.
   */
  const SCHEDULES: readonly { readonly name: string; readonly policy: Partial<LocalGitPolicy>; readonly depths: readonly number[] }[] = [
    { name: 'the default schedule', policy: {}, depths: [10, 100, 1000] },
    { name: 'a factor of 1, which cannot deepen', policy: { mergeBaseDepthFactor: 1 }, depths: [10, 100, 1000] },
    { name: 'a factor that floors to 1', policy: { mergeBaseDepthFactor: 1.5 }, depths: [10, 100, 1000] },
    { name: 'a bound above what the seam will fetch', policy: { mergeBaseMaxDepth: 5000 }, depths: [10, 100, 1000] },
    { name: 'a start above what the seam will fetch', policy: { fetchDepth: 2000 }, depths: [10, 100, 1000] },
    { name: 'a doubling ladder', policy: { fetchDepth: 1, mergeBaseDepthFactor: 2, mergeBaseMaxDepth: 8 }, depths: [1, 2, 4, 8] },
    { name: 'a bound already met by the first fetch', policy: { fetchDepth: 10, mergeBaseMaxDepth: 10 }, depths: [10] },
    { name: 'a bound the first fetch overshoots', policy: { fetchDepth: 100, mergeBaseMaxDepth: 10 }, depths: [100] },
  ];

  it.each(SCHEDULES)('runs $name once each and derives the lock’s threshold from the same rungs', async ({ policy, depths }) => {
    const ladder = runsEveryRung(depths.length + 4, 'answered');
    const cache = createObjectCache({ root, run: ladder.run, policy });

    const outcome = await cache.acquire({
      identity: identityFor(`acme/${depths.join('-')}`),
      descriptor: { fetchUrl: 'https://git.example.test/acme/repo.git', mergeTargetRef: 'refs/heads/main' },
      attemptId: 'attempt-1',
      headCommit: repo.headSha,
    });

    expect(ladder.depths).toEqual([...depths]);
    // The lock's staleness threshold is the same rung count, not a second one
    // that happens to agree: a threshold derived for fewer rungs than the loop
    // runs is a lock another attempt may take while this one is still fetching.
    expect(lockStaleFor(cache.policy) / perRungMs(cache.policy)).toBe(depths.length);
    expect(outcome.state).toBe('commitUnobtainable');
    if (outcome.state !== 'commitUnobtainable') {
      if (outcome.state === 'acquired') outcome.lease.release();
      return;
    }
    expect(outcome.code).toBe('mergeBaseNotFound');
    expect(outcome.reason).toContain(String(depths[depths.length - 1]));
  });

  it('reports a bound above the seam’s limit as the depth this review will fetch, not as a refused request', async () => {
    const ladder = runsEveryRung(8, 'answered');
    const cache = createObjectCache({ root, run: ladder.run, policy: { mergeBaseMaxDepth: 5000 } });

    const outcome = await cache.acquire({
      identity: identityFor('acme/over-bound'),
      descriptor: { fetchUrl: 'https://git.example.test/acme/repo.git', mergeTargetRef: 'refs/heads/main' },
      attemptId: 'attempt-1',
      headCommit: repo.headSha,
    });

    // What this used to be: the ladder reached 5000, the invocation seam refused
    // to plan a fetch that deep, and the review ended `requestRefused` quoting
    // the seam's rule about fetch depths — the fetch planner's limit named to
    // somebody who set a policy bound, on a review that never asked for a
    // refused request.
    expect(outcome.state).toBe('commitUnobtainable');
    if (outcome.state !== 'commitUnobtainable') {
      if (outcome.state === 'acquired') outcome.lease.release();
      return;
    }
    expect(outcome.code).toBe('mergeBaseNotFound');
    expect(outcome.reason).toContain('as deep as this review will fetch');
    expect(outcome.reason).toContain('1000');
    expect(ladder.depths.every((depth) => depth <= 1000)).toBe(true);
  });
});
