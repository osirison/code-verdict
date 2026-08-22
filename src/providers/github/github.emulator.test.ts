/**
 * The GitHub paths the shared contract suite does not reach: the batched
 * review and its per-comment fallback, capability honesty, pagination, issue
 * filtering, check aggregation, and the error mapping.
 */
import { describe, expect, it } from 'vitest';
import type { ConnectionConfig } from '../../platform/provider';
import { isScmError } from '../../platform/errors';
import { createGitHubProvider, githubProvider } from './githubProvider';
import { makeFakeGitHubFetch, type FakeGitHubOptions } from './fakeGitHub';
import { mapGitHubError } from './errors';
import { hasNextLink, restBaseUrl, graphqlUrl, isDotCom, splitRepoId } from './http';
import { aggregateCiStatus, toCiStatus, toFileDiff } from './mappers';

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

  it('takes the worst check state as the pull request state', () => {
    expect(aggregateCiStatus([])).toBe('none');
    expect(aggregateCiStatus([
      { id: 1, name: 'a', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'b', status: 'completed', conclusion: 'failure' },
    ])).toBe('failed');
    expect(aggregateCiStatus([
      { id: 1, name: 'a', status: 'completed', conclusion: 'success' },
      { id: 2, name: 'b', status: 'in_progress' },
    ])).toBe('running');
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
