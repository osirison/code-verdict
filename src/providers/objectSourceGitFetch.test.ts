/**
 * The object-source descriptor's `Authorization` header, proven against a real
 * `git fetch` — the assertion whose absence shipped a broken fetch.
 *
 * **What went wrong, and why no test failed.** On 2026-09-09 a review of
 * `osirison/code-verdict!66` stopped with "A local object store could not
 * serve this change (The object source would not authorize this fetch with the
 * credential this connection has for it.) and 166 of 243 enumerated file(s)
 * arrived with no content served." The refusal was correct — GitHub's compare
 * response had declined two thirds of the change, so reporting a clean review
 * of the rest would have been a lie — but the local fetch that would have
 * rescued it should have worked, and did not: both providers composed
 * `Authorization: Bearer <token>`, which is the REST API's scheme, and
 * neither forge's git transport accepts it.
 *
 * Three kinds of test already covered this value and none of them could fail.
 * Task 2.6 (`objectSourceDescriptor.test.ts`) proves the credential never
 * *leaks* into a URL, a log line or an error. The descriptor tests prove the
 * header is *present*. The provider contract suite proves it is *non-empty*.
 * Nothing asserted it is *accepted*, because the only thing that can accept or
 * reject it is a git server, and every fake in this repository ignored the
 * header entirely. A wrong form passed the whole suite and failed in front of
 * a user.
 *
 * **What this file does instead.** It runs the real thing end to end: the real
 * provider composes the descriptor from a real `Credential`, the descriptor's
 * header is carried into a real `git fetch` by the real acquisition path, and
 * the remote at the other end is `git http-backend` behind a gate that applies
 * the forge's own documented and measured authorization rule — `fakeGitHub.ts`
 * and `fakeGitLab.ts` state those rules, and this file is where they are
 * enforced against a client. A header form that the forge would reject now
 * fails here instead of in a review.
 *
 * The gate is the only emulated part, and it has to be: the rules it applies
 * are recorded in the two fakes together with what was measured, what was read
 * out of documentation, and what a fake of this kind cannot promise.
 *
 * **The fetch location is local; the header is not.** Each test replaces the
 * descriptor's `fetchUrl` with this file's own remote — no test here reaches
 * the network — and changes nothing else. `authorizationHeaderValue` is taken
 * exactly as the provider composed it, because that value is the subject.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createObjectCache } from '../localgit/objectAcquisition';
import { objectCacheRoot, type RepositoryIdentity } from '../localgit/objectCache';
import type { ConnectionConfig } from '../platform/provider';
import type { ChangeRequestRef, ObjectSourceDescriptor } from '../platform/types';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';
import { createGitHubProvider } from './github/githubProvider';
import { gitHubAcceptsGitAuthorization, makeFakeGitHubFetch } from './github/fakeGitHub';
import { createGitLabProvider } from './gitlab/gitlabProvider';
import { gitLabAcceptsGitAuthorization, makeFakeGitLabFetch } from './gitlab/fakeGitLab';

const gitVersion = gitExecutableVersion();

/** git's own CGI, wherever this git keeps its helpers. Absent on a machine that installed git without it, which skips rather than fails. */
function gitHttpBackend(): string | undefined {
  const located = spawnSync('git', ['--exec-path'], { encoding: 'utf8' });
  if (located.status !== 0) return undefined;
  const candidate = join((located.stdout ?? '').trim(), 'git-http-backend');
  return existsSync(candidate) ? candidate : undefined;
}

const backend = gitHttpBackend();

/** Shaped like the real ones, distinctive enough that a substring match cannot hit one by accident. */
const GITHUB_TOKEN = 'gho_objectSourceGitFetch_4f1c9ab27de3';
const GITLAB_TOKEN = 'glpat-objectSourceGitFetch-7b25e0dc';

const GITHUB_CR: ChangeRequestRef = { repoId: 'acme/core', number: '2841' };
const GITLAB_CR: ChangeRequestRef = { repoId: '9101', number: '2841' };

/**
 * The value both providers composed before this was fixed, kept as a literal
 * so the regression has a name in the suite. Measured against
 * `https://github.com/osirison/code-verdict.git` with a real token on
 * 2026-09-09: exit 128, git falling through to askpass at the challenge.
 */
const REJECTED_BEARER_FORM = `Bearer ${GITHUB_TOKEN}`;

interface RemoteRequest {
  readonly authorization: string | undefined;
  readonly rejected: boolean;
}

interface ForgeRemote {
  readonly url: string;
  readonly requests: readonly RemoteRequest[];
  close(): Promise<void>;
}

interface ForgeRemoteOptions {
  readonly projectRoot: string;
  readonly repositoryName: string;
  readonly emptyConfig: string;
  /** The forge's own rule, from its fake. Everything it turns away is answered the way a forge answers an unauthenticated git client. */
  readonly accepts: (headerValue: string | undefined) => boolean;
}

/**
 * `git http-backend` behind one forge's authorization rule.
 *
 * The CGI plumbing is the same as `../localgit/objectAcquisition.test.ts`'s
 * remote, which is the fuller one — it also models refusing to serve objects
 * nobody advertised, records the protocol's `want` lines, and documents the
 * measurements behind both. This one is deliberately smaller: it exists to
 * answer a single question about the request headers, and lifting the other
 * remote into a shared helper would drag its refusal policies and its
 * protocol-version switching into a file that has no use for either.
 *
 * A rejected request is answered 401 with a `WWW-Authenticate` challenge,
 * which is what a forge does to a git client whose credential it will not
 * take, and what git's transport turns into the askpass fallthrough the live
 * failure died on.
 */
async function startForgeRemote(options: ForgeRemoteOptions): Promise<ForgeRemote> {
  const requests: RemoteRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks);
      const authorization = request.headers.authorization;
      if (!options.accepts(authorization)) {
        requests.push({ authorization, rejected: true });
        response.writeHead(401, { 'Content-Type': 'text/plain', 'WWW-Authenticate': 'Basic realm="git"' });
        response.end('who are you');
        return;
      }
      requests.push({ authorization, rejected: false });

      const [pathInfo, query] = (request.url ?? '').split('?');
      const environment: Record<string, string> = {
        PATH: process.env.PATH ?? '',
        GIT_PROJECT_ROOT: options.projectRoot,
        GIT_HTTP_EXPORT_ALL: '1',
        REQUEST_METHOD: request.method ?? 'GET',
        PATH_INFO: pathInfo ?? '',
        QUERY_STRING: query ?? '',
        CONTENT_TYPE: request.headers['content-type'] ?? '',
        // Without this the backend waits for an end of input it never sees, and
        // the fetch hangs rather than failing — measured in the fuller remote.
        CONTENT_LENGTH: String(body.length),
        REMOTE_ADDR: '127.0.0.1',
        GIT_CONFIG_GLOBAL: options.emptyConfig,
        GIT_CONFIG_SYSTEM: options.emptyConfig,
      };
      const encoding = request.headers['content-encoding'];
      if (encoding !== undefined) environment.HTTP_CONTENT_ENCODING = String(encoding);
      // Forwarded so the remote speaks v2, which is what production talks.
      const offered = request.headers['git-protocol'];
      if (offered !== undefined) environment.GIT_PROTOCOL = String(offered);

      const child = spawn(backend ?? '', [], { env: environment });
      // The backend can answer and exit before the body reaches it, and an
      // unhandled `error` on a stream is an uncaught exception vitest charges
      // to whichever test is in flight. Same reasoning as the fuller remote's.
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
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

describe.skipIf(gitVersion === undefined || backend === undefined)('the descriptor’s credential is a form the forge’s git endpoints accept', () => {
  let repo: LocalGitFixture;
  let remoteRoot: string;
  let remoteName: string;
  let emptyConfig: string;
  let root: string;
  let remotes: ForgeRemote[];

  const IDENTITY: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'acme/core' };

  beforeAll(() => {
    repo = createTwoCommitRepository();
    remoteRoot = mkdtempSync(join(tmpdir(), 'code-verdict-forge-remote-'));
    remoteName = 'acme-core.git';
    emptyConfig = join(remoteRoot, 'empty.gitconfig');
    writeFileSync(emptyConfig, '');
    const remote = join(remoteRoot, remoteName);
    runGit(repo, ['init', '--bare', '--quiet', remote]);
    runGit(repo, ['push', '--quiet', remote, `${repo.headSha}:refs/heads/main`]);
  });

  afterAll(() => {
    repo?.cleanup();
    if (remoteRoot) rmSync(remoteRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    root = objectCacheRoot(mkdtempSync(join(tmpdir(), 'code-verdict-forge-storage-')));
    remotes = [];
  });

  afterEach(async () => {
    for (const remote of remotes) await remote.close();
    rmSync(root, { recursive: true, force: true });
  });

  async function remoteGuardedBy(accepts: (headerValue: string | undefined) => boolean): Promise<ForgeRemote> {
    const remote = await startForgeRemote({ projectRoot: remoteRoot, repositoryName: remoteName, emptyConfig, accepts });
    remotes.push(remote);
    return remote;
  }

  /** The pinned commit, fetched with this descriptor, through the production acquisition path. */
  async function fetchThrough(descriptor: ObjectSourceDescriptor): Promise<string> {
    const cache = createObjectCache({ root });
    // The target branch is what the merge base is computed against, so a real
    // acquisition asks for it alongside the head. The local fixture repository
    // has a `main`, so the descriptor names it and the whole production path —
    // fetch, merge-base, pin — runs against a real remote.
    const outcome = await cache.acquire({
      identity: IDENTITY,
      descriptor: { ...descriptor, mergeTargetRef: 'refs/heads/main' },
      attemptId: 'attempt-1',
      headCommit: repo.headSha,
    });
    if (outcome.state !== 'acquired') return `${outcome.state}:${'code' in outcome ? outcome.code : ''}`;
    outcome.lease.release();
    return 'acquired';
  }

  async function githubDescriptor(config: ConnectionConfig): Promise<ObjectSourceDescriptor> {
    const result = await createGitHubProvider(makeFakeGitHubFetch()).connect(config).getObjectSource!(GITHUB_CR);
    if (result.state !== 'available') throw new Error(`the provider composed no descriptor: ${result.reason}`);
    return result.descriptor;
  }

  async function gitlabDescriptor(config: ConnectionConfig): Promise<ObjectSourceDescriptor> {
    const result = await createGitLabProvider(makeFakeGitLabFetch()).connect(config).getObjectSource!(GITLAB_CR);
    if (result.state !== 'available') throw new Error(`the provider composed no descriptor: ${result.reason}`);
    return result.descriptor;
  }

  describe('GitHub', () => {
    it('fetches the pinned commit with the header the provider composed for a personal access token', async () => {
      const remote = await remoteGuardedBy((value) => gitHubAcceptsGitAuthorization(value, GITHUB_TOKEN));
      const descriptor = await githubDescriptor({ instanceUrl: 'https://github.com', credential: { kind: 'token', token: GITHUB_TOKEN } });

      expect(await fetchThrough({ ...descriptor, fetchUrl: remote.url })).toBe('acquired');
      // Non-vacuity: the remote really did see a credential and really did take
      // it, so "acquired" is not a remote that never asked.
      expect(remote.requests.length).toBeGreaterThan(0);
      expect(remote.requests.every((request) => !request.rejected)).toBe(true);
      expect(remote.requests.every((request) => (request.authorization ?? '').startsWith('Basic '))).toBe(true);
    });

    it('fetches with the header composed for an editor session, which is the same form', async () => {
      const remote = await remoteGuardedBy((value) => gitHubAcceptsGitAuthorization(value, GITHUB_TOKEN));
      const descriptor = await githubDescriptor({ instanceUrl: 'https://github.com', credential: { kind: 'session', accessToken: GITHUB_TOKEN } });

      expect(await fetchThrough({ ...descriptor, fetchUrl: remote.url })).toBe('acquired');
      expect(remote.requests.every((request) => !request.rejected)).toBe(true);
    });

    it('would have failed with the bearer form the live run sent — the gate is real, and this is the regression it holds', async () => {
      const remote = await remoteGuardedBy((value) => gitHubAcceptsGitAuthorization(value, GITHUB_TOKEN));

      expect(await fetchThrough({ fetchUrl: remote.url, authorizationHeaderValue: REJECTED_BEARER_FORM })).toBe('unavailable:credentialsRefused');
      expect(remote.requests.some((request) => request.rejected && request.authorization === REJECTED_BEARER_FORM)).toBe(true);
    });
  });

  describe('GitLab', () => {
    it('fetches the pinned commit with the header the provider composed for a personal access token', async () => {
      const remote = await remoteGuardedBy((value) => gitLabAcceptsGitAuthorization(value, { token: GITLAB_TOKEN }));
      const descriptor = await gitlabDescriptor({ instanceUrl: 'https://gitlab.example', credential: { kind: 'token', token: GITLAB_TOKEN } });

      expect(await fetchThrough({ ...descriptor, fetchUrl: remote.url })).toBe('acquired');
      expect(remote.requests.length).toBeGreaterThan(0);
      expect(remote.requests.every((request) => !request.rejected)).toBe(true);
    });

    it('fetches with the header composed for an editor session against an instance that requires the OAuth username', async () => {
      // The case the two credential kinds diverge on: GitLab takes any non-empty
      // username with a personal access token and `oauth2` with an OAuth token.
      // This gate is what catches a provider that sent its personal-access-token
      // username for both — the test above cannot, because that gate accepts any
      // non-empty username. The mirror case, `oauth2` for both, is caught by
      // `objectSourceDescriptor.test.ts`, which asserts the decoded pair for a
      // personal access token exactly.
      const remote = await remoteGuardedBy((value) => gitLabAcceptsGitAuthorization(value, { token: GITLAB_TOKEN, oauth: true }));
      const descriptor = await gitlabDescriptor({ instanceUrl: 'https://gitlab.example', credential: { kind: 'session', accessToken: GITLAB_TOKEN } });

      expect(await fetchThrough({ ...descriptor, fetchUrl: remote.url })).toBe('acquired');
      expect(remote.requests.every((request) => !request.rejected)).toBe(true);
    });

    it('would have failed with the bearer form the live run sent', async () => {
      const remote = await remoteGuardedBy((value) => gitLabAcceptsGitAuthorization(value, { token: GITLAB_TOKEN }));

      expect(await fetchThrough({ fetchUrl: remote.url, authorizationHeaderValue: `Bearer ${GITLAB_TOKEN}` })).toBe('unavailable:credentialsRefused');
      expect(remote.requests.some((request) => request.rejected)).toBe(true);
    });
  });
});

/**
 * The rules themselves, asserted without a git process.
 *
 * The fetches above prove the descriptor passes each forge's gate; these prove
 * the gate is the rule the fakes say it is, including the forms no provider
 * composes. Without them a gate that accepted everything would still make
 * every fetch above pass.
 */
describe('the authorization rules the fakes model', () => {
  const encode = (username: string, secret: string): string => `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`;

  it('GitHub takes either measured Basic form and refuses a bearer token or a missing header', () => {
    expect(gitHubAcceptsGitAuthorization(encode('x-access-token', GITHUB_TOKEN), GITHUB_TOKEN)).toBe(true);
    expect(gitHubAcceptsGitAuthorization(encode(GITHUB_TOKEN, 'x-oauth-basic'), GITHUB_TOKEN)).toBe(true);
    expect(gitHubAcceptsGitAuthorization(`Bearer ${GITHUB_TOKEN}`, GITHUB_TOKEN)).toBe(false);
    expect(gitHubAcceptsGitAuthorization(`token ${GITHUB_TOKEN}`, GITHUB_TOKEN)).toBe(false);
    expect(gitHubAcceptsGitAuthorization(undefined, GITHUB_TOKEN)).toBe(false);
    // A well-formed header carrying the wrong secret is a rejected fetch too.
    expect(gitHubAcceptsGitAuthorization(encode('x-access-token', 'some-other-token'), GITHUB_TOKEN)).toBe(false);
    expect(gitHubAcceptsGitAuthorization('Basic not-base64-at-all!!', GITHUB_TOKEN)).toBe(false);
  });

  it('GitLab reads the token out of the password half only, and pins the username for an OAuth token', () => {
    expect(gitLabAcceptsGitAuthorization(encode('private-token', GITLAB_TOKEN), { token: GITLAB_TOKEN })).toBe(true);
    expect(gitLabAcceptsGitAuthorization(encode('oauth2', GITLAB_TOKEN), { token: GITLAB_TOKEN })).toBe(true);
    // Documented: the username may be any string, but not an empty one.
    expect(gitLabAcceptsGitAuthorization(encode('', GITLAB_TOKEN), { token: GITLAB_TOKEN })).toBe(false);
    // The username half is never a place GitLab looks for a token.
    expect(gitLabAcceptsGitAuthorization(encode(GITLAB_TOKEN, 'x-oauth-basic'), { token: GITLAB_TOKEN })).toBe(false);
    expect(gitLabAcceptsGitAuthorization(`Bearer ${GITLAB_TOKEN}`, { token: GITLAB_TOKEN })).toBe(false);

    // An OAuth access token takes `oauth2` and nothing else.
    expect(gitLabAcceptsGitAuthorization(encode('oauth2', GITLAB_TOKEN), { token: GITLAB_TOKEN, oauth: true })).toBe(true);
    expect(gitLabAcceptsGitAuthorization(encode('private-token', GITLAB_TOKEN), { token: GITLAB_TOKEN, oauth: true })).toBe(false);
  });
});
