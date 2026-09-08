/**
 * The object-source descriptor, across every provider that produces one —
 * tasks 2.4 and 2.6 of `add-local-git-investigation`.
 *
 * Two things are checked here that the shared provider contract suite cannot
 * check. The suite asserts the descriptor's *shape* — an `http`/`https`
 * location, no key a caller must interpret — against whatever a harness hands
 * it; this file asserts the *values* each real provider composes, including
 * the ref hint whose whole purpose is that no neutral code may ever learn what
 * it looks like. It sits beside `providerPageBounds.test.ts` for the same
 * reason that file exists: some properties are about the shipped providers
 * themselves, and only a test that names them can hold them.
 *
 * The second half is the credential, and it is the reason this file scans
 * sinks rather than just reading return values. The descriptor is the first
 * thing in this codebase that hands a credential to a caller on purpose, and
 * the caller's next move (task 6.6) is to put it in a child process's
 * environment. Everything in between — the location it is sent to, the trace
 * of the request that produced it, the reason given when there is no
 * descriptor at all, the error text when the platform refuses — is a channel
 * it could leak through instead.
 *
 * The marker convention is the existing one (`harnessCheckpoint.test.ts`'s
 * task-11.2 marker test, generalized by
 * `harnessPersistenceInspection.assurance.test.ts`): plant a distinctive
 * literal in a real value, drive the production path, then scan every sink for
 * it and assert the one sanctioned place still has it, so the scan cannot pass
 * by the value never having travelled at all. Task 6.16 extends the same
 * markers to the git invocation's own sinks — argv, activity, checkpoints,
 * diagnostics — once there is an invocation to extend them to.
 *
 * Activity events are deliberately not scanned: nothing at the provider layer
 * writes one. The sinks that exist at this boundary are the API trace channel
 * (`../app/apiTrace.ts`, the "provider log"), the returned values themselves,
 * and thrown error text.
 *
 * **The marker no longer travels as text, and the scan had to follow it.** On
 * 2026-09-09 a live review failed because the header these tests check was
 * `Bearer <token>`, which no forge's git transport accepts; the fix composes
 * `Basic base64("<username>:<token>")` instead, and both providers now send
 * that. The credential is therefore base64 inside the value, so a scan looking
 * for the plain marker would pass on a sink that copied the header verbatim —
 * the leak these tests exist to catch, wearing an encoding. `carriesCredential`
 * decodes every base64-looking run before searching, and the non-vacuity check
 * decodes the pair rather than matching a substring of it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setApiTraceSink, tracedFetch, type ApiTraceSink } from '../app/apiTrace';
import type { ConnectionConfig } from '../platform/provider';
import type { ChangeRequestRef } from '../platform/types';
import { createGitHubProvider } from './github/githubProvider';
import { makeFakeGitHubFetch } from './github/fakeGitHub';
import { createGitLabProvider } from './gitlab/gitlabProvider';
import { makeFakeGitLabFetch } from './gitlab/fakeGitLab';
import { fixtureProvider } from './fixture/fixtureProvider';

/**
 * The planted credential. Distinctive enough that a substring scan cannot hit
 * it by accident, and shaped like the tokens it stands in for.
 */
const CREDENTIAL_MARKER = 'MARKER_CREDENTIAL_2_6_ghp_7d41b9e2';

/** The decoded `username:secret` inside a `Basic` header value — the credential as it now travels. */
function basicPayload(headerValue: string | undefined): string {
  const match = /^Basic (\S+)$/.exec(headerValue ?? '');
  return match === null ? '' : Buffer.from(match[1] as string, 'base64').toString('utf8');
}

/**
 * Does this text carry the credential, as text or as base64?
 *
 * Every base64-looking run is decoded and searched as well as the text itself,
 * at all four alignments, because a copy of the header value that started
 * anywhere but a group boundary would otherwise decode to noise and pass.
 *
 * What this covers is a sink that copied the value, or a group-aligned or
 * offset run containing it. It does not cover a sink that copied a *fragment*
 * of the payload — the decode of a fragment holds a fragment of the marker,
 * and this searches for the whole one. That is the realistic shape of the leak
 * either way: a log line or an error message copies a header value whole.
 */
function carriesCredential(text: string): boolean {
  if (text.includes(CREDENTIAL_MARKER)) return true;
  for (const run of text.match(/[A-Za-z0-9+/=]{16,}/g) ?? []) {
    for (const offset of [0, 1, 2, 3]) {
      if (Buffer.from(run.slice(offset), 'base64').toString('utf8').includes(CREDENTIAL_MARKER)) return true;
    }
  }
  return false;
}

const GITHUB_CONFIG: ConnectionConfig = {
  instanceUrl: 'https://github.com',
  credential: { kind: 'token', token: CREDENTIAL_MARKER },
};
const GITLAB_CONFIG: ConnectionConfig = {
  instanceUrl: 'https://gitlab.example',
  credential: { kind: 'token', token: CREDENTIAL_MARKER },
};

const GITHUB_CR: ChangeRequestRef = { repoId: 'acme/core', number: '2841' };
const GITHUB_CR_OTHER_REPO: ChangeRequestRef = { repoId: 'acme/auth-service', number: '812' };
const GITLAB_CR: ChangeRequestRef = { repoId: '9101', number: '2841' };
const GITLAB_CR_OTHER_PROJECT: ChangeRequestRef = { repoId: '9102', number: '812' };

/** Collects every line the API trace channel would have written. */
function traceSink(): ApiTraceSink & { readonly lines: string[] } {
  const lines: string[] = [];
  return { lines, appendLine: (line: string) => void lines.push(line) };
}

// `setApiTraceSink` is module state, not per-test state: leaving one installed
// would trace every later test in this process into a dead array.
afterEach(() => setApiTraceSink(undefined));

describe('GitHub composes an object-source descriptor (task 2.4)', () => {
  it('names an https clone location and the pull request’s own ref hint', async () => {
    const conn = createGitHubProvider(makeFakeGitHubFetch()).connect(GITHUB_CONFIG);
    const result = await conn.getObjectSource!(GITHUB_CR);

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    // `acme/core` reports no `clone_url`, so this is the `html_url` + `.git`
    // fallback — the same value by GitHub's own construction.
    expect(result.descriptor.fetchUrl).toBe('https://github.com/acme/core.git');
    expect(result.descriptor.refHint).toBe('refs/pull/2841/head');
  });

  it('takes the platform’s own clone_url when the repository reports one', async () => {
    const conn = createGitHubProvider(makeFakeGitHubFetch()).connect(GITHUB_CONFIG);
    const result = await conn.getObjectSource!(GITHUB_CR_OTHER_REPO);

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.descriptor.fetchUrl).toBe('https://github.com/acme/auth-service.git');
    expect(result.descriptor.refHint).toBe('refs/pull/812/head');
  });

  it('reports unavailable with a reason when the repository cannot be read, rather than throwing', async () => {
    const conn = createGitHubProvider(makeFakeGitHubFetch()).connect(GITHUB_CONFIG);
    const result = await conn.getObjectSource!({ repoId: 'acme/does-not-exist', number: '1' });

    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') return;
    expect(result.reason).toContain('notFound');
  });
});

describe('GitLab composes an object-source descriptor (task 2.4)', () => {
  it('names an https clone location and the merge request’s own ref hint', async () => {
    const conn = createGitLabProvider(makeFakeGitLabFetch()).connect(GITLAB_CONFIG);
    const result = await conn.getObjectSource!(GITLAB_CR);

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    expect(result.descriptor.fetchUrl).toBe('https://gitlab.example/hve/platform/core.git');
    expect(result.descriptor.refHint).toBe('refs/merge-requests/2841/head');
  });

  it('takes the instance’s own http_url_to_repo, even on a different host than its web URL', async () => {
    const conn = createGitLabProvider(makeFakeGitLabFetch()).connect(GITLAB_CONFIG);
    const result = await conn.getObjectSource!(GITLAB_CR_OTHER_PROJECT);

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    // Composing from `web_url` would have produced
    // `https://gitlab.example/hve/platform/auth-service.git` — a host that
    // does not serve this project's git.
    expect(result.descriptor.fetchUrl).toBe('https://git.gitlab.example/hve/platform/auth-service.git');
  });

  it('reports unavailable with a reason when the project cannot be read, rather than throwing', async () => {
    const conn = createGitLabProvider(makeFakeGitLabFetch()).connect(GITLAB_CONFIG);
    const result = await conn.getObjectSource!({ repoId: '7777', number: '1' });

    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') return;
    expect(result.reason).toContain('notFound');
  });
});

describe('the fixture provider states that it has no object source (task 2.4)', () => {
  it('reports unavailable with a reason rather than naming a location nothing serves', async () => {
    const conn = fixtureProvider.connect({ instanceUrl: 'https://demo.invalid', credential: { kind: 'none' } });
    const result = await conn.getObjectSource!(GITLAB_CR);

    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') return;
    expect(result.reason.trim()).not.toBe('');
    expect(result.reason).toContain('sample data');
  });
});

describe('the descriptor’s credential reaches no other sink (task 2.6)', () => {
  it('GitHub: the marker is in the header value and in nothing else — not the location, not the log, not an error', async () => {
    const sink = traceSink();
    setApiTraceSink(sink);
    const conn = createGitHubProvider(tracedFetch(makeFakeGitHubFetch(), () => 1_700_000_000_000)).connect(GITHUB_CONFIG);

    const result = await conn.getObjectSource!(GITHUB_CR);
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;

    // Non-vacuity, both halves: the credential really did travel (or the scan
    // below proves nothing), and the log really did record the request that
    // carried it (or "no marker in the log" is just an empty log).
    // Decoded, not substring-matched: the value is `Basic base64(…)` now, and
    // this is also where GitHub's username for git over HTTPS is pinned.
    expect(basicPayload(result.descriptor.authorizationHeaderValue)).toBe(`x-access-token:${CREDENTIAL_MARKER}`);
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.join('\n')).toContain('/repos/acme/core');

    // The one sanctioned place, and nowhere else in the descriptor.
    expect(carriesCredential(result.descriptor.fetchUrl)).toBe(false);
    expect(carriesCredential(JSON.stringify({ ...result.descriptor, authorizationHeaderValue: undefined }))).toBe(false);
    for (const line of sink.lines) expect(carriesCredential(line)).toBe(false);

    // The unavailable reason is a sink too — it is what a run records as a
    // limitation, and it is written while the credential is in scope.
    const refused = await conn.getObjectSource!({ repoId: 'acme/does-not-exist', number: '1' });
    expect(refused.state).toBe('unavailable');
    if (refused.state === 'unavailable') expect(carriesCredential(refused.reason)).toBe(false);

    // And a thrown platform error, which travels furthest of all: it reaches
    // the model as a tool failure.
    const thrown = await conn.getRepository('acme/does-not-exist').catch((e: unknown) => e);
    expect(carriesCredential(String(thrown))).toBe(false);
    expect(carriesCredential(JSON.stringify(thrown))).toBe(false);
    for (const line of sink.lines) expect(carriesCredential(line)).toBe(false);
  });

  it('GitLab: the marker is in the header value and in nothing else — not the location, not the log, not an error', async () => {
    const sink = traceSink();
    setApiTraceSink(sink);
    const conn = createGitLabProvider(tracedFetch(makeFakeGitLabFetch(), () => 1_700_000_000_000)).connect(GITLAB_CONFIG);

    const result = await conn.getObjectSource!(GITLAB_CR);
    expect(result.state).toBe('available');
    if (result.state !== 'available') return;

    // GitLab's username for a personal access token, pinned here for the same
    // reason GitHub's is: the value this file exists to check is the whole
    // header, and on GitLab the username is the half that varies by kind.
    expect(basicPayload(result.descriptor.authorizationHeaderValue)).toBe(`private-token:${CREDENTIAL_MARKER}`);
    expect(sink.lines.length).toBeGreaterThan(0);
    expect(sink.lines.join('\n')).toContain('/projects/9101');

    expect(carriesCredential(result.descriptor.fetchUrl)).toBe(false);
    expect(carriesCredential(JSON.stringify({ ...result.descriptor, authorizationHeaderValue: undefined }))).toBe(false);
    for (const line of sink.lines) expect(carriesCredential(line)).toBe(false);

    const refused = await conn.getObjectSource!({ repoId: '7777', number: '1' });
    expect(refused.state).toBe('unavailable');
    if (refused.state === 'unavailable') expect(carriesCredential(refused.reason)).toBe(false);

    const thrown = await conn.getRepository('7777').catch((e: unknown) => e);
    expect(carriesCredential(String(thrown))).toBe(false);
    expect(carriesCredential(JSON.stringify(thrown))).toBe(false);
    for (const line of sink.lines) expect(carriesCredential(line)).toBe(false);
  });

  it('omits the header value entirely for a connection that carries no credential', async () => {
    const conn = createGitHubProvider(makeFakeGitHubFetch()).connect({
      instanceUrl: 'https://github.com',
      credential: { kind: 'none' },
    });
    const result = await conn.getObjectSource!(GITHUB_CR);

    expect(result.state).toBe('available');
    if (result.state !== 'available') return;
    // Absent, not an empty pair: `Basic base64("x-access-token:")` is a
    // credential a remote can reject in its own way, and "no credential" must
    // be indistinguishable from never having been asked for one.
    expect('authorizationHeaderValue' in result.descriptor).toBe(false);
  });
});
