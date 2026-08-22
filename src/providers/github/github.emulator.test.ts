/**
 * The GitHub paths the shared contract suite does not reach: the batched
 * review and its per-comment fallback, capability honesty, pagination, issue
 * filtering, check aggregation, and the error mapping.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../../platform/provider';
import { isScmError } from '../../platform/errors';
import { createGitHubProvider, githubProvider } from './githubProvider';
import { makeFakeGitHubFetch, type FakeGitHubOptions, type RequestLog } from './fakeGitHub';
import { mapGitHubError } from './errors';
import { hasNextLink, restBaseUrl, graphqlUrl, isDotCom, splitRepoId } from './http';
import { toCiStatus, toCiSummary, toFileDiff } from './mappers';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://github.com',
  credential: { kind: 'token', token: 'ghp-test' },
};

function connect(options: FakeGitHubOptions = {}) {
  return createGitHubProvider(makeFakeGitHubFetch(options)).connect(CONFIG);
}

const CR = { repoId: 'acme/core', number: '2841' };

async function draft(options: FakeGitHubOptions = {}) {
  const conn = connect(options);
  const diff = await conn.getChangeRequestDiff(CR);
  const anchor = { filePath: 'src/limiter.ts', line: 12, refs: diff.anchorRefs };
  return { conn, anchor };
}

describe('batched review — the normal path', () => {
  it('posts one review carrying every comment and the summary', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [
        { key: 'a', body: 'Bound this by tenant.', anchor },
        { key: 'b', body: 'Same here.', anchor, suggestion: { old: 'x', new: 'y' } },
      ],
      summary: 'Two findings.',
    });
    expect(result.comments.map((c) => [c.key, c.ok])).toEqual([['a', true], ['b', true]]);
    expect(result.summaryPosted).toBe(true);
  });

  it('carries the approve verdict and reports it applied', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'Fine.', anchor }],
      summary: 'Looks good.',
      approve: true,
    });
    expect(result.approvalApplied).toBe(true);
    expect(result.requestChangesApplied).toBeUndefined();
  });

  it('reports request-changes separately from approval', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'Blocker.', anchor }],
      requestChanges: true,
    });
    expect(result.requestChangesApplied).toBe(true);
    expect(result.approvalApplied).toBeUndefined();
  });

  it('posts nothing when there is nothing to post', async () => {
    const conn = connect();
    const result = await conn.submitReview(CR, { comments: [] });
    expect(result).toEqual({ comments: [], summaryPosted: false });
  });
});

describe('per-comment fallback — when the batch will not take it', () => {
  it('falls back on a position rejection and reports each comment individually', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true, failCommentAt: 2 });
    const result = await conn.submitReview(CR, {
      comments: [
        { key: 'lands', body: 'One.', anchor },
        { key: 'stale', body: 'Two.', anchor },
        { key: 'also-lands', body: 'Three.', anchor },
      ],
      summary: 'Must not be posted.',
    });
    expect(result.comments.map((c) => [c.key, c.ok])).toEqual([
      ['lands', true],
      ['stale', false],
      ['also-lands', true],
    ]);
    expect(result.comments[1]?.error?.kind).toBe('staleAnchor');
    // The summary is withheld over an incomplete review.
    expect(result.summaryPosted).toBe(false);
  });

  it('still lands the verdict when a comment failed, rather than dropping it', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true, failCommentAt: 1 });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'stale', body: 'One.', anchor }],
      summary: 'Withheld.',
      requestChanges: true,
    });
    expect(result.comments[0]?.ok).toBe(false);
    expect(result.summaryPosted).toBe(false);
    expect(result.requestChangesApplied).toBe(true);
  });

  it('keeps going past a per-comment position failure', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true, failCommentAt: 1 });
    const result = await conn.submitReview(CR, {
      comments: [
        { key: 'one', body: 'a', anchor },
        { key: 'two', body: 'b', anchor },
      ],
    });
    // A stale anchor is that comment's problem alone.
    expect(result.comments.map((c) => c.ok)).toEqual([false, true]);
  });

  it('stops posting after a fatal failure instead of hammering the rest', async () => {
    const { conn, anchor } = await draft({
      failReviewPositionOnBatch: true,
      failCommentAtWith: { at: 2, status: 401, message: 'Bad credentials' },
    });
    const result = await conn.submitReview(CR, {
      comments: [
        { key: 'one', body: 'a', anchor },
        { key: 'two', body: 'b', anchor },
        { key: 'three', body: 'c', anchor },
      ],
    });
    expect(result.comments.map((c) => [c.key, c.ok])).toEqual([
      ['one', true],
      ['two', false],
      ['three', false],
    ]);
    // The third was never attempted — it carries the failure that doomed it.
    expect(result.comments[1]?.error?.kind).toBe('auth');
    expect(result.comments[2]?.error?.kind).toBe('auth');
  });

  it('throws rather than returning a result when nothing could be attempted', async () => {
    const { conn, anchor } = await draft({ failAllWrites: { status: 401, message: 'Bad credentials' } });
    await expect(
      conn.submitReview(CR, { comments: [{ key: 'a', body: 'x', anchor }], summary: 's' }),
    ).rejects.toMatchObject({ kind: 'auth' });
  });
});

describe('review threads over GraphQL', () => {
  it('reports an outdated thread as having lost its anchor', async () => {
    const threads = await connect().listThreads(CR);
    const live = threads.find((t) => t.id === 'PRRT_live');
    const outdated = threads.find((t) => t.id === 'PRRT_outdated');
    expect(live?.anchorPresent).toBe(true);
    expect(live?.notes.map((n) => n.author.username)).toEqual(['you', 'dana']);
    expect(outdated?.anchorPresent).toBe(false);
  });

  it('resolves and unresolves through the mutations that only GraphQL has', async () => {
    const conn = connect();
    await expect(conn.resolveThread(CR, 'PRRT_live', true)).resolves.toBeUndefined();
    await expect(conn.resolveThread(CR, 'PRRT_live', false)).resolves.toBeUndefined();
    await expect(conn.replyToThread(CR, 'PRRT_live', 'Thanks.')).resolves.toBeUndefined();
  });
});

describe('listing', () => {
  it('returns open pull requests with the fields staleness detection needs', async () => {
    const crs = await connect().listOpenChangeRequests(['acme/core', 'acme/auth-service']);
    expect(crs.map((cr) => cr.ref.number)).toEqual(['2841', '812']);
    const [core] = crs;
    expect(core?.headSha).toBeTruthy();
    expect(core?.sourceBranch).toBe('feat/rate-limit');
    expect(core?.targetBranch).toBe('main');
    expect(core?.reviewers.map((r) => r.username)).toEqual(['you']);
    expect(core?.ci?.status).toBe('success');
    expect(crs.find((cr) => cr.ref.number === '812')?.draft).toBe(true);
  });

  it('excludes pull requests from the issues endpoint', async () => {
    const items = await connect().listWorkItems(['acme/core']);
    expect(items.map((i) => i.number)).toEqual(['1180']);
  });

  it('reports a repository with no open pull requests as empty, not as an error', async () => {
    await expect(connect().listOpenChangeRequests(['acme/api-gateway'])).resolves.toEqual([]);
  });

  it('marks renamed, added and deleted files and keeps both rename paths', async () => {
    const diff = await connect().getChangeRequestDiff(CR);
    const renamed = diff.files.find((f) => f.newPath === 'src/renamed-new.ts');
    expect(renamed?.oldPath).toBe('src/renamed-old.ts');
    expect(renamed?.isRenamed).toBe(true);
    expect(diff.files.find((f) => f.newPath === 'src/added.ts')?.isNew).toBe(true);
    expect(diff.files.find((f) => f.newPath === 'src/gone.ts')?.isDeleted).toBe(true);
  });
});

describe('source resolution', () => {
  it('reports a well-formed but invisible repository as notVisible, adding nothing', async () => {
    await expect(connect().resolveSource('acme/nope')).resolves.toEqual({
      kind: 'notVisible',
      id: 'acme/nope',
    });
  });

  it('reports a bare name that is not an organization as noMatch', async () => {
    await expect(connect().resolveSource('nosuchorg')).resolves.toEqual({ kind: 'noMatch' });
  });

  it('resolves an organization to its repositories for explicit selection', async () => {
    const resolved = await connect().resolveSource('acme');
    expect(resolved.kind).toBe('group');
    if (resolved.kind === 'group') {
      expect(resolved.repositories.map((r) => r.id)).toEqual([
        'acme/core',
        'acme/auth-service',
        'acme/api-gateway',
      ]);
    }
  });
});

describe('auth modes are declared per host', () => {
  it('offers the editor session on github.com and token only elsewhere', () => {
    expect(githubProvider.authModesFor('https://github.com')).toEqual(['session', 'token']);
    expect(githubProvider.authModesFor('https://ghe.example.test')).toEqual(['token']);
  });

  it('routes the API to api.github.com or to the enterprise /api/v3 prefix', () => {
    expect(restBaseUrl('https://github.com')).toBe('https://api.github.com');
    expect(restBaseUrl('https://ghe.example.test/')).toBe('https://ghe.example.test/api/v3');
    expect(graphqlUrl('https://github.com')).toBe('https://api.github.com/graphql');
    expect(graphqlUrl('https://ghe.example.test')).toBe('https://ghe.example.test/api/graphql');
    expect(isDotCom('https://github.com')).toBe(true);
    expect(isDotCom('https://ghe.example.test')).toBe(false);
  });

  it('declares only capabilities it implements', () => {
    expect(githubProvider.capabilities).toEqual({
      suggestions: true,
      approvals: true,
      requestChanges: true,
      threadResolution: true,
      groupHierarchy: true,
      batchedReview: true,
    });
  });
});

describe('error mapping', () => {
  it('maps a rejected comment position to staleAnchor', () => {
    expect(mapGitHubError(422, 'line must be part of the diff').kind).toBe('staleAnchor');
    expect(mapGitHubError(422, 'position is invalid').kind).toBe('staleAnchor');
  });

  it('keeps a non-position 422 out of the staleAnchor bucket', () => {
    expect(mapGitHubError(422, 'Validation failed: body cannot be blank').kind).toBe('unknown');
  });

  it('maps both primary and secondary rate limiting, carrying the delay', () => {
    const primary = mapGitHubError(403, 'API rate limit exceeded', {
      get: (n) => (n.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null),
    });
    expect(primary.kind).toBe('rateLimited');

    const secondary = mapGitHubError(429, 'You have exceeded a secondary rate limit', {
      get: (n) => (n.toLowerCase() === 'retry-after' ? '60' : null),
    });
    expect(secondary.kind).toBe('rateLimited');
    expect(secondary.retryAfterSeconds).toBe(60);
  });

  it('derives the delay from x-ratelimit-reset when there is no retry-after', () => {
    const now = 1_000_000_000_000;
    const resetEpoch = now / 1000 + 90;
    const err = mapGitHubError(429, 'rate limited', {
      get: (n) => (n.toLowerCase() === 'x-ratelimit-reset' ? String(resetEpoch) : null),
    }, now);
    expect(err.retryAfterSeconds).toBe(90);
  });

  it('keeps a plain 403 as insufficient scope, not as rate limiting', () => {
    expect(mapGitHubError(403, 'Resource not accessible by personal access token').kind)
      .toBe('insufficientScope');
  });

  it('maps 401 to auth and 404 to notFound', () => {
    expect(mapGitHubError(401, 'Bad credentials').kind).toBe('auth');
    expect(mapGitHubError(404, 'Not Found').kind).toBe('notFound');
  });

  it('surfaces an invalid repository id as a normalized error', () => {
    expect(() => splitRepoId('notarepo')).toThrow();
    try {
      splitRepoId('notarepo');
    } catch (e) {
      expect(isScmError(e)).toBe(true);
    }
  });
});

describe('pagination and status aggregation', () => {
  it('reads rel="next" out of a Link header, and only that', () => {
    expect(hasNextLink('<https://api.github.com/x?page=2>; rel="next"')).toBe(true);
    expect(hasNextLink('<https://api.github.com/x?page=9>; rel="last"')).toBe(false);
    expect(hasNextLink(null)).toBe(false);
  });

  it('reads the pull request check state from the rollup, in one query per repo', () => {
    expect(toCiSummary(null)).toBeUndefined();
    expect(toCiSummary({ state: 'SUCCESS', contexts: { nodes: [{ databaseId: 7, permalink: 'u' }] } }))
      .toEqual({ runId: '7', status: 'success', webUrl: 'u' });
    expect(toCiSummary({ state: 'FAILURE', contexts: { nodes: [
      { databaseId: 1, name: 'a', conclusion: 'SUCCESS', permalink: 'ok' },
      { databaseId: 2, name: 'b', conclusion: 'FAILURE', permalink: 'bad' },
    ] } })).toEqual({ runId: '2', status: 'failed', webUrl: 'bad' });
    expect(toCiSummary({ state: 'PENDING', contexts: { nodes: [] } }))
      .toMatchObject({ status: 'pending' });
    // A rollup GitHub reports as absent is no CI, not a failed one.
    expect(toCiSummary({ state: null })).toBeUndefined();
  });

  it('falls back to a status context name when there is no numeric run id', () => {
    expect(toCiSummary({ state: 'FAILURE', contexts: { nodes: [
      { context: 'ci/jenkins', state: 'FAILURE', targetUrl: 'https://ci.example/1' },
    ] } })).toEqual({ runId: 'ci/jenkins', status: 'failed', webUrl: 'https://ci.example/1' });
  });

  it('reads non-blocking conclusions as success, and cancellation as canceled', () => {
    expect(toCiStatus({ status: 'completed', conclusion: 'neutral' })).toBe('success');
    expect(toCiStatus({ status: 'completed', conclusion: 'skipped' })).toBe('success');
    expect(toCiStatus({ status: 'completed', conclusion: 'cancelled' })).toBe('canceled');
    expect(toCiStatus({ status: 'completed', conclusion: 'timed_out' })).toBe('failed');
    expect(toCiStatus({ status: 'queued' })).toBe('pending');
  });

  it('keeps a file with no patch listable, with no hunks to anchor to', () => {
    expect(toFileDiff({ filename: 'assets/logo.png', status: 'modified' }).diff).toBe('');
  });
});

describe("GitHub requires a review body — the shapes the app actually retries with", () => {
  it('retries the remainder as plain comments once the summary already posted', async () => {
    // submit.ts sends { comments: [...remaining], summary: undefined } on retry.
    // Creating a second bodiless COMMENT review for that would 422.
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'redo', body: 'Retried.', anchor }],
      summary: undefined,
    });
    expect(result.comments).toEqual([{ key: 'redo', ok: true, threadId: expect.any(String) }]);
    expect(result.summaryPosted).toBe(false);
  });

  it('lands a verdict-only review with no comments and no summary', async () => {
    // changesetSubmit.ts retries the verdict with { comments: [], summary: undefined }.
    const conn = connect();
    const result = await conn.submitReview(CR, {
      comments: [],
      summary: undefined,
      requestChanges: true,
    });
    expect(result.requestChangesApplied).toBe(true);
    expect(result.requestChangesError).toBeUndefined();
  });

  it('still lands the verdict when the summary is withheld after a partial failure', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true, failCommentAt: 1 });
    const result = await conn.submitReview(CR, {
      comments: [
        { key: 'stale', body: 'a', anchor },
        { key: 'ok', body: 'b', anchor },
      ],
      summary: 'Withheld over an incomplete review.',
      requestChanges: true,
    });
    expect(result.summaryPosted).toBe(false);
    expect(result.requestChangesApplied).toBe(true);
    expect(result.requestChangesError).toBeUndefined();
  });

  it('sends commit_id top-level on the review and per-comment on the comment endpoint', async () => {
    // The emulator rejects a commit_id inside comments[] and a missing one on
    // /comments, so both passing proves the placement.
    const { conn, anchor } = await draft();
    await expect(conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor }],
      summary: 's',
    })).resolves.toMatchObject({ summaryPosted: true });

    const fallback = await draft({ failReviewPositionOnBatch: true });
    await expect(fallback.conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor: fallback.anchor }],
      summary: 's',
    })).resolves.toMatchObject({ comments: [{ key: 'a', ok: true, threadId: expect.any(String) }] });
  });

  it('reports only the verdict it actually sent when both flags are set', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor }],
      summary: 's',
      approve: true,
      requestChanges: true,
    });
    // One event goes out; claiming both would record a verdict never made.
    expect(result.approvalApplied).toBe(true);
    expect(result.requestChangesApplied).toBeUndefined();
  });
});

describe('source input is validated against the connected host', () => {
  it('refuses a URL for another platform or host', async () => {
    const conn = connect();
    await expect(conn.resolveSource('https://gitlab.com/hve/platform/core')).resolves.toEqual({ kind: 'noMatch' });
    await expect(conn.resolveSource('https://ghe.acme.test/acme/core')).resolves.toEqual({ kind: 'noMatch' });
  });

  it("refuses GitHub's own site pages", async () => {
    await expect(connect().resolveSource('https://github.com/settings/tokens')).resolves.toEqual({ kind: 'noMatch' });
  });
});

describe('list calls are batched per repository, never per change request', () => {
  it('costs the same number of requests whatever the pull-request count', async () => {
    const log: RequestLog = { paths: [] };
    const conn = createGitHubProvider(makeFakeGitHubFetch({ log })).connect(CONFIG);

    await conn.listOpenChangeRequests(['acme/core']);
    const oneRepo = log.paths.length;
    // One REST list + one GraphQL rollup. The contract in
    // src/platform/provider.ts forbids one request per change request.
    expect(log.paths.filter((p) => p.endsWith('/pulls'))).toHaveLength(1);
    expect(log.paths.filter((p) => p === '/graphql')).toHaveLength(1);
    expect(log.paths.some((p) => p.includes('/check-runs'))).toBe(false);
    expect(oneRepo).toBe(2);

    log.paths.length = 0;
    await conn.listOpenChangeRequests(['acme/core', 'acme/auth-service', 'acme/api-gateway']);
    // Scales with repositories, not with pull requests.
    expect(log.paths).toHaveLength(6);
  });

  it('still fills CI status from the batched rollup', async () => {
    const crs = await connect().listOpenChangeRequests(['acme/core']);
    expect(crs[0]?.ci).toEqual({
      runId: '93178061854',
      status: 'success',
      webUrl: 'https://github.com/acme/core/actions/runs/1/job/1',
    });
  });

  it('lists pull requests even when the checks query fails outright', async () => {
    // Checks are decoration: a token without the scope must not empty the list.
    const conn = createGitHubProvider(async (url, init) => {
      if (new URL(url).pathname === '/graphql' && /statusCheckRollup/.test(init?.body ?? '')) {
        return {
          ok: false, status: 403,
          headers: { get: () => null },
          json: () => Promise.resolve({ message: 'Forbidden' }),
          text: () => Promise.resolve('{"message":"Forbidden"}'),
        };
      }
      return makeFakeGitHubFetch()(url, init);
    }).connect(CONFIG);

    const crs = await conn.listOpenChangeRequests(['acme/core']);
    expect(crs).toHaveLength(1);
    expect(crs[0]?.ci).toBeUndefined();
  });
});
