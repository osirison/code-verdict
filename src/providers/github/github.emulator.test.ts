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
import { EtagCache, GitHubHttp, RATE_FLOORS, RateBudget, hasNextLink, restBaseUrl, graphqlUrl, isDotCom, splitRepoId } from './http';
import type { FetchLike, FetchResponseLike } from './http';
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
  const log: RequestLog = options.log ?? { paths: [] };
  const conn = connect({ ...options, log });
  const diff = await conn.getChangeRequestDiff(CR);
  const anchor = { filePath: 'src/limiter.ts', line: 12, refs: diff.anchorRefs };
  // Only the writes matter to callers that assert on this.
  log.paths.length = 0;
  return { conn, anchor, log };
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

describe('submit progress (#42)', () => {
  it('ticks once per comment on the slow per-comment path', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true });
    const seen: Array<[string, number, number]> = [];
    await conn.submitReview(
      CR,
      {
        comments: [
          { key: 'a', body: 'One.', anchor },
          { key: 'b', body: 'Two.', anchor },
        ],
        summary: 'Summary.',
      },
      (p) => seen.push([p.stage, p.posted, p.total]),
    );
    // Zero first, so the UI can show the total before anything has landed.
    expect(seen.filter((s) => s[0] === 'comments')).toEqual([
      ['comments', 0, 2],
      ['comments', 1, 2],
      ['comments', 2, 2],
    ]);
    expect(seen.some((s) => s[0] === 'summary')).toBe(true);
  });

  it('reports the batch as one step, since it is one request', async () => {
    const { conn, anchor } = await draft();
    const seen: Array<[string, number, number]> = [];
    await conn.submitReview(
      CR,
      { comments: [{ key: 'a', body: 'One.', anchor }], summary: 'S.' },
      (p) => seen.push([p.stage, p.posted, p.total]),
    );
    expect(seen).toEqual([['comments', 0, 1]]);
  });

  it('a submit with no callback behaves exactly as before', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, { comments: [{ key: 'a', body: 'One.', anchor }], summary: 'S.' });
    expect(result.comments.map((c) => c.ok)).toEqual([true]);
  });
});

describe('postedAsSingleReview — how the comments actually went out', () => {
  // The UI tells the user "posted as one review thread". Only the provider
  // knows whether that is true: the capability flag says the platform *can*
  // batch, not that this submit did.
  it('is true when one review carried the comments', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      summary: 'Summary.',
    });
    expect(result.postedAsSingleReview).toBe(true);
  });

  it('is false when the fallback posted them one at a time', async () => {
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }, { key: 'b', body: 'Two.', anchor }],
      summary: 'Summary.',
    });
    expect(result.comments.every((c) => c.ok)).toBe(true);
    // Every comment landed and the summary posted — the old expression read
    // that as "one review", which is exactly the sentence being disproven.
    expect(result.summaryPosted).toBe(true);
    expect(result.postedAsSingleReview).toBe(false);
  });

  it('says nothing about a submit that posted no comments', async () => {
    // The shape a retry sends once the comments already landed: it must not
    // reset an earlier attempt's answer.
    const { conn } = await draft();
    const result = await conn.submitReview(CR, { comments: [], summary: 'S.', requestChanges: true });
    expect(result.requestChangesApplied).toBe(true);
    expect(result.postedAsSingleReview).toBeUndefined();
  });

  it('is false when a refused verdict was downgraded to standalone comments', async () => {
    const { conn, anchor } = await draft({ refuseVerdict: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      approve: true,
    });
    expect(result.postedAsSingleReview).toBe(false);
  });
});

describe('a verdict GitHub will not take — reviewing your own pull request', () => {
  // Live behaviour, captured from api.github.com: POST /pulls/{n}/reviews with
  // APPROVE or REQUEST_CHANGES on your own PR is a 422. Only the event is
  // refused; the comments and summary are fine. Throwing lost the whole review.
  it('still posts the review, and reports the verdict through its own field', async () => {
    const { conn, anchor, log } = await draft({ refuseVerdict: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      summary: 'This summary must survive the refusal.',
      requestChanges: true,
    });
    expect(result.comments.map((c) => [c.key, c.ok])).toEqual([['a', true]]);
    expect(result.summaryPosted).toBe(true);
    expect(result.requestChangesApplied).toBe(false);
    // Terminal, not a generic 422: a caller that retries this gets the same
    // refusal every time and never completes.
    expect(result.requestChangesError?.kind).toBe('verdictRefused');
    expect(result.requestChangesError?.message).toContain('request changes on your own pull request');
    // Never a comment failure (task 5.7).
    expect(result.comments.every((c) => c.error === undefined)).toBe(true);
    // Downgraded to COMMENT and re-sent as one review, not comment-by-comment.
    expect(log.paths.filter((p) => p.endsWith('/comments') && !p.includes('/reviews/'))).toEqual([]);
  });

  it('reports a refused approval as approvalError, not as a thrown submit', async () => {
    const { conn, anchor } = await draft({ refuseVerdict: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      summary: 'Looks good.',
      approve: true,
    });
    expect(result.approvalApplied).toBe(false);
    expect(result.approvalError?.message).toContain('approve your own pull request');
    expect(result.comments.map((c) => c.ok)).toEqual([true]);
  });

  it('survives a refused verdict AND a stale anchor in the same submit', async () => {
    // The downgrade re-sends the review as a COMMENT — which can itself be
    // rejected for a moved line. Without its own fallback that second 422
    // escapes submitReview and the whole review is lost, which is the outcome
    // the downgrade exists to prevent.
    const { conn, anchor } = await draft({ refuseVerdict: true, failReviewPositionOnBatch: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }, { key: 'b', body: 'Two.', anchor }],
      summary: 'Must still land.',
      requestChanges: true,
    });
    expect(result.comments.map((c) => c.ok)).toEqual([true, true]);
    expect(result.postedAsSingleReview).toBe(false);
    expect(result.requestChangesError?.kind).toBe('verdictRefused');
  });

  it('reports a refusal from the per-comment path as verdictRefused too', async () => {
    // Both submit paths reach a verdict review; both must classify it the same
    // way, or the fallback path strands the caller in a retry loop.
    const { conn, anchor } = await draft({ refuseVerdict: true, failReviewPositionOnBatch: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      approve: true,
    });
    expect(result.approvalError?.kind).toBe('verdictRefused');
    expect(result.approvalApplied).toBe(false);
  });

  it('posts the comments standalone when the refused submit carries no summary', async () => {
    // A bodiless COMMENT review is itself a 422, so the downgrade cannot use
    // the batch endpoint here.
    const { conn, anchor } = await draft({ refuseVerdict: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'One.', anchor }],
      approve: true,
    });
    expect(result.comments.map((c) => c.ok)).toEqual([true]);
    expect(result.summaryPosted).toBe(false);
    expect(result.approvalError).toBeDefined();
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

  // Captured verbatim from api.github.com. The invented phrasings above are
  // what the fake used to send; these are what GitHub actually sends, and the
  // regex matched neither until a live submit threw instead of falling back.
  it('maps the live "could not be resolved" phrasing from both endpoints', () => {
    expect(mapGitHubError(422, 'Unprocessable Entity — Line could not be resolved').kind)
      .toBe('staleAnchor');
    expect(
      mapGitHubError(
        422,
        'Validation Failed — pull_request_review_thread.line custom could not be resolved',
      ).kind,
    ).toBe('staleAnchor');
  });

  it('leaves an unresolvable commit_id an ordinary validation failure', () => {
    // Same verb, different subject: re-anchoring cannot fix a bad commit id,
    // so this must not route into the per-comment fallback.
    expect(mapGitHubError(422, 'Validation Failed — commit_id could not be resolved').kind)
      .toBe('unknown');
  });

  it('reads the detail out of a string-valued errors[]', async () => {
    // POST /pulls/{n}/reviews answers with `message: "Unprocessable Entity"`
    // and the reason as a bare string in errors[]. Handling only the object
    // form dropped it, leaving an unclassifiable 422.
    const body = JSON.stringify({
      message: 'Unprocessable Entity',
      errors: ['Line could not be resolved'],
      status: '422',
    });
    const http = new GitHubHttp('https://github.com', 'ghp-test', () =>
      Promise.resolve({
        ok: false,
        status: 422,
        headers: { get: () => null },
        json: () => Promise.resolve(JSON.parse(body) as unknown),
        text: () => Promise.resolve(body),
      }));
    const error: unknown = await http.post('/repos/acme/core/pulls/1/reviews', {}).catch((e: unknown) => e);
    expect(isScmError(error)).toBe(true);
    expect(isScmError(error) ? error.kind : undefined).toBe('staleAnchor');
    expect(isScmError(error) ? error.message : '').toContain('Line could not be resolved');
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

describe('CI runs cost one request per repository', () => {
  it('issues exactly one request per repository, whatever the run count', async () => {
    const log: RequestLog = { paths: [], urls: [] };
    const conn = createGitHubProvider(makeFakeGitHubFetch({ log })).connect(CONFIG);

    await conn.listCiRuns(['acme/core', 'acme/auth-service', 'acme/api-gateway']);

    expect([...log.paths].sort()).toEqual([
      '/repos/acme/api-gateway/actions/runs',
      '/repos/acme/auth-service/actions/runs',
      '/repos/acme/core/actions/runs',
    ]);
    // The shape this replaced: a commit list, then one check-runs request per
    // commit — 1 + N per repository, on a 60s poll.
    expect(log.paths.some((path) => path.endsWith('/commits') || path.includes('/check-runs'))).toBe(false);
  });

  it('asks for the limit it was given, and defaults to the one the caller passes', async () => {
    const log: RequestLog = { paths: [], urls: [] };
    const conn = createGitHubProvider(makeFakeGitHubFetch({ log })).connect(CONFIG);

    await conn.listCiRuns(['acme/core']);
    // The default is the dashboard's own 3 — 20 was a number nothing asked for.
    expect(log.urls?.[0]).toContain('per_page=3');

    await conn.listCiRuns(['acme/core'], 10);
    expect(log.urls?.[1]).toContain('per_page=10');
  });

  it('maps a failed and a passing workflow run onto the neutral CiRun', async () => {
    const runs = await connect().listCiRuns(['acme/core']);

    expect(runs).toEqual([
      {
        id: '32918212053',
        repoId: 'acme/core',
        status: 'failed',
        webUrl: 'https://github.com/acme/core/actions/runs/32918212053',
        ref: 'feat/rate-limit',
        createdAt: '2026-08-20T09:58:00Z',
      },
      {
        id: '32914104866',
        repoId: 'acme/core',
        status: 'success',
        webUrl: 'https://github.com/acme/core/actions/runs/32914104866',
        ref: 'main',
        createdAt: '2026-08-20T08:31:00Z',
      },
    ]);
    // The repository-wide list names the run, never the job that failed inside
    // it — naming that job is one request per run, the fan-out this removed.
    expect(runs[0]?.failedJobName).toBeUndefined();
  });

  it('reads a run still in flight as running, with no conclusion to read', async () => {
    const runs = await connect().listCiRuns(['acme/auth-service']);
    expect(runs.map((run) => [run.status, run.ref])).toEqual([['running', 'feat/rotate']]);
  });

  it('returns nothing for a repository with no runs, rather than throwing', async () => {
    await expect(connect().listCiRuns(['acme/api-gateway'])).resolves.toEqual([]);
  });

  it('keeps the other repositories when one cannot answer', async () => {
    // Actions can be disabled per repository, and on a GHES instance outright.
    const fake = makeFakeGitHubFetch();
    const conn = createGitHubProvider(async (url, init) => {
      if (new URL(url).pathname === '/repos/acme/core/actions/runs') {
        return {
          ok: false, status: 404,
          headers: { get: () => null },
          json: () => Promise.resolve({ message: 'Not Found' }),
          text: () => Promise.resolve('{"message":"Not Found"}'),
        };
      }
      return fake(url, init);
    }).connect(CONFIG);

    const runs = await conn.listCiRuns(['acme/core', 'acme/auth-service']);
    expect(runs.map((run) => run.repoId)).toEqual(['acme/auth-service']);
  });
});

describe('the rate limit the user actually hit', () => {
  /** Verbatim shape of GitHub's primary-limit 403: 403, remaining 0, a reset. */
  function rateLimitedFetch(resetEpoch: number) {
    const body = JSON.stringify({
      message: 'API rate limit exceeded for user ID 93209527. If you reach out to GitHub Support for help, '
        + 'please include the request ID. For more on scraping GitHub, see the documentation.',
    });
    const headers: Record<string, string> = {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': String(resetEpoch),
    };
    return async () => ({
      ok: false,
      status: 403,
      headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(JSON.parse(body) as unknown),
      text: () => Promise.resolve(body),
    });
  }

  it('surfaces a rateLimited error carrying the seconds until it clears', async () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 12 * 60;
    const conn = createGitHubProvider(rateLimitedFetch(resetEpoch)).connect(CONFIG);

    const error: unknown = await conn.listOpenChangeRequests(['acme/core']).catch((e: unknown) => e);
    expect(isScmError(error)).toBe(true);
    if (!isScmError(error)) return;
    expect(error.kind).toBe('rateLimited');
    expect(error.status).toBe(403);
    // Derived from x-ratelimit-reset against the clock, so allow the second or
    // two the test itself takes.
    expect(error.retryAfterSeconds).toBeGreaterThan(12 * 60 - 5);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(12 * 60);
  });

  it('leaves the CI list empty rather than failing the whole pod fetch', async () => {
    const conn = createGitHubProvider(rateLimitedFetch(Math.floor(Date.now() / 1000) + 60)).connect(CONFIG);
    await expect(conn.listCiRuns(['acme/core'])).resolves.toEqual([]);
  });
});

describe('a summary the user cleared is not a summary', () => {
  it('never reports canned verdict text as the user\'s summary', async () => {
    const { conn, anchor } = await draft();
    for (const summary of ['', '   ', undefined]) {
      const result = await conn.submitReview(CR, {
        comments: [{ key: 'a', body: 'x', anchor }],
        summary,
        requestChanges: true,
      });
      // The review still lands (GitHub demands a body), but the UI must not be
      // told the user's summary was posted when canned text was.
      expect(result.requestChangesApplied).toBe(true);
      expect(result.summaryPosted).toBe(false);
    }
  });

  it('routes on whether a summary exists, not on what it says', async () => {
    // A real summary that happens to read like the canned text must still take
    // the batched-review path.
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor }],
      summary: 'See the inline comments.',
    });
    expect(result.summaryPosted).toBe(true);
    expect(result.comments).toEqual([{ key: 'a', ok: true, threadId: 'PRRT_live' }]);
  });
});

describe('threadId is a thread id, in both submit paths', () => {
  it('resolves the GraphQL thread id after a batched review', async () => {
    const { conn, anchor } = await draft();
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor }],
      summary: 's',
    });
    // Comment 8001 lives in thread PRRT_live — not the REST comment id.
    expect(result.comments[0]?.threadId).toBe('PRRT_live');
  });

  it('resolves it after the per-comment fallback too', async () => {
    // The fallback posts to /comments, whose ids are NOT thread ids; storing
    // one would make the Posted reviews panel match nothing.
    const { conn, anchor } = await draft({ failReviewPositionOnBatch: true });
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor }],
      summary: 's',
    });
    const threadId = result.comments[0]?.threadId;
    expect(threadId).toBe('PRRT_outdated');
    expect(threadId).not.toMatch(/^\d+$/);
  });

  it('stores nothing rather than something wrong when resolution fails', async () => {
    const conn = createGitHubProvider(async (url, init) => {
      const i = init as { body?: string } | undefined;
      if (new URL(url).pathname === '/graphql' && /reviewThreads/.test(i?.body ?? '')) {
        return {
          ok: false, status: 500,
          headers: { get: () => null },
          json: () => Promise.resolve({ message: 'boom' }),
          text: () => Promise.resolve('{"message":"boom"}'),
        };
      }
      return makeFakeGitHubFetch()(url, init);
    }).connect(CONFIG);
    const diff = await conn.getChangeRequestDiff(CR);
    const result = await conn.submitReview(CR, {
      comments: [{ key: 'a', body: 'x', anchor: { filePath: 'src/limiter.ts', line: 12, refs: diff.anchorRefs } }],
      summary: 's',
    });
    expect(result.comments[0]?.ok).toBe(true);
    expect(result.comments[0]?.threadId).toBeUndefined();
  });
});


describe('conditional requests — the poll that costs nothing', () => {
  /** A response with header lookup as case-insensitive as a real one. */
  function reply(status: number, body: string, headers: Record<string, string> = {}): FetchResponseLike {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return {
      // `Response.ok` is 200-299, so a 304 arrives here as not-ok — which is
      // why an unhandled one would reach the error mapper as `unknown`.
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
      json: () => Promise.resolve(JSON.parse(body) as unknown),
      text: () => Promise.resolve(body),
    };
  }

  const validatorOf = (init?: { headers?: Record<string, string> }): string | null =>
    init?.headers?.['If-None-Match'] ?? null;

  it('rides a 304 on the second poll and replays the same answer', async () => {
    const log: RequestLog = { paths: [], urls: [], validators: [], statuses: [] };
    const provider = createGitHubProvider(makeFakeGitHubFetch({ log }));

    // Two connections, because that is what production does: `connectionForPod`
    // builds a fresh one on every notifier poll. A cache owned by the client
    // would be cold here, and this whole stage would be a no-op.
    const first = await provider.connect(CONFIG).listCiRuns(['acme/core']);
    const second = await provider.connect(CONFIG).listCiRuns(['acme/core']);

    expect(second).toEqual(first);
    expect(second).not.toHaveLength(0);
    expect(log.validators?.[0]).toBeNull();
    expect(log.validators?.[1]).toMatch(/^W\//);
    // Two requests issued, one charged: only the 200 counts against the limit.
    expect(log.statuses).toEqual([200, 304]);
  });

  it('replaces the remembered body when the resource changes', async () => {
    let body = '[{"id":1}]';
    let etag = 'W/"one"';
    const sent: Array<string | null> = [];
    const http = new GitHubHttp('https://github.com', 'ghp-test', (_url, init) => {
      const validator = validatorOf(init);
      sent.push(validator);
      return Promise.resolve(
        validator === etag ? reply(304, '', { etag }) : reply(200, body, { etag }),
      );
    });

    expect(await http.get('/repos/acme/core/pulls')).toEqual([{ id: 1 }]);
    body = '[{"id":2}]';
    etag = 'W/"two"';
    // The client still holds the first validator, so it asks conditionally and
    // is answered in full — then rides the *new* validator, not the retired one.
    expect(await http.get('/repos/acme/core/pulls')).toEqual([{ id: 2 }]);
    expect(await http.get('/repos/acme/core/pulls')).toEqual([{ id: 2 }]);
    expect(sent).toEqual([null, 'W/"one"', 'W/"two"']);
  });

  it('never sends a validator on a write, and never remembers a write', async () => {
    const sent: Array<[string, string | null]> = [];
    const http = new GitHubHttp('https://github.com', 'ghp-test', (_url, init) => {
      const method = init?.method ?? 'GET';
      sent.push([method, validatorOf(init)]);
      // A validator on an unsafe method is a *precondition*, not a body
      // shortcut: a server honouring it would refuse the write.
      return Promise.resolve(reply(200, '[]', { etag: method === 'GET' ? 'W/"read"' : 'W/"write"' }));
    });

    await http.get('/repos/acme/core/pulls');
    await http.post('/repos/acme/core/pulls', { title: 'x' });
    await http.get('/repos/acme/core/pulls');

    expect(sent).toEqual([
      ['GET', null],
      ['POST', null],
      // The POST's own etag never entered the cache — the GET still rides its own.
      ['GET', 'W/"read"'],
    ]);
  });

  it('re-asks unconditionally when a 304 arrives with nothing to replay', async () => {
    const etags = new EtagCache();
    const sent: Array<string | null> = [];
    let calls = 0;
    const http = new GitHubHttp('https://github.com', 'ghp-test', (_url, init) => {
      calls += 1;
      sent.push(validatorOf(init));
      if (calls === 2) {
        // Evicted while this very request was in flight — the notifier's three
        // pod calls and every page of each share one cache.
        etags.clear();
        return Promise.resolve(reply(304, '', { etag: 'W/"e"' }));
      }
      return Promise.resolve(reply(200, '[{"id":7}]', { etag: 'W/"e"' }));
    }, Date.now, etags);

    await http.get('/repos/acme/core/pulls');
    const second = await http.get('/repos/acme/core/pulls');

    // Not `undefined`: a silent empty answer here empties the dashboard, which
    // is far worse than the one wasted request this costs.
    expect(second).toEqual([{ id: 7 }]);
    expect(calls).toBe(3);
    expect(sent).toEqual([null, 'W/"e"', null]);
  });

  it('assembles every page when both pages come back 304, and still terminates', async () => {
    const NEXT = '<https://api.github.com/repos/acme/core/pulls?per_page=100&page=2>; rel="next"';
    const sent: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      const page = new URL(url).searchParams.get('page') ?? '?';
      const validator = validatorOf(init);
      sent.push(`${page}:${validator ?? '-'}`);
      const etag = page === '1' ? 'W/"p1"' : 'W/"p2"';
      // api.github.com does repeat `link` on a 304 (captured 2026-08-26). This
      // one does not — the case where trusting the live header alone would
      // truncate every paginated list to its first page and look like nothing
      // was wrong.
      if (validator === etag) return Promise.resolve(reply(304, '', { etag }));
      return Promise.resolve(page === '1'
        ? reply(200, '[{"number":1}]', { etag, link: NEXT })
        : reply(200, '[{"number":2}]', { etag }));
    };
    const http = new GitHubHttp('https://github.com', 'ghp-test', fetchImpl);

    expect(await http.getAll('/repos/acme/core/pulls')).toEqual([{ number: 1 }, { number: 2 }]);
    expect(await http.getAll('/repos/acme/core/pulls')).toEqual([{ number: 1 }, { number: 2 }]);
    // Each page has its own URL, its own validator and its own entry.
    expect(sent).toEqual(['1:-', '2:-', '1:W/"p1"', '2:W/"p2"']);
  });

  it('reads the budget off a 304 as readily as off a 200', async () => {
    let calls = 0;
    const http = new GitHubHttp('https://github.com', 'ghp-test', () => {
      calls += 1;
      // The numbers are contrived so the assertion can only pass if the 304's
      // own headers were read. A real *authorized* 304 leaves `remaining`
      // exactly where the 200 left it — that is the point of the whole change.
      return Promise.resolve(calls === 1
        ? reply(200, '[]', { etag: 'W/"e"', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': '1787714876' })
        : reply(304, '', { etag: 'W/"e"', 'x-ratelimit-remaining': '4321', 'x-ratelimit-reset': '1787714876' }));
    });

    await http.get('/repos/acme/core/pulls');
    await http.get('/repos/acme/core/pulls');
    expect(http.rateState('core')).toEqual({ remaining: 4321, resetAt: 1787714876 });
  });

  it('retires a validator the resource stopped issuing', async () => {
    let issuing = true;
    const sent: Array<string | null> = [];
    const http = new GitHubHttp('https://github.com', 'ghp-test', (_url, init) => {
      sent.push(validatorOf(init));
      return Promise.resolve(issuing ? reply(200, '[]', { etag: 'W/"e"' }) : reply(200, '[]'));
    });

    await http.get('/repos/acme/core/pulls');
    issuing = false;
    await http.get('/repos/acme/core/pulls');
    // Keeping the dead etag would mean sending a header that can only ever
    // cost a request, for as long as the process lives.
    await http.get('/repos/acme/core/pulls');
    expect(sent).toEqual([null, 'W/"e"', null]);
  });

  it("never replays one account's body as another account's answer", async () => {
    const etags = new EtagCache();
    const sent: Array<[string, string | null]> = [];
    const fetchImpl: FetchLike = (_url, init) => {
      sent.push([init?.headers?.Authorization ?? '', validatorOf(init)]);
      return Promise.resolve(reply(200, '[]', { etag: 'W/"same-url"' }));
    };
    // One provider serves every pod on a host, so two accounts share this cache.
    const mine = new GitHubHttp('https://github.com', 'ghp-mine', fetchImpl, Date.now, etags);
    const theirs = new GitHubHttp('https://github.com', 'ghp-theirs', fetchImpl, Date.now, etags);

    await mine.get('/repos/acme/core/pulls');
    await theirs.get('/repos/acme/core/pulls');
    await mine.get('/repos/acme/core/pulls');

    expect(sent).toEqual([
      ['Bearer ghp-mine', null],
      ['Bearer ghp-theirs', null],
      ['Bearer ghp-mine', 'W/"same-url"'],
    ]);
  });
});

describe('the cache the validators live in', () => {
  const entry = (body: string) => ({ etag: `W/"${body}"`, body, link: null });

  it('evicts the least recently used, not the first inserted', () => {
    const cache = new EtagCache(2);
    cache.set('a', entry('1'));
    cache.set('b', entry('2'));
    // A poll re-reading 'a' is what makes it the recent one.
    cache.get('a');
    cache.set('c', entry('3'));

    expect(cache.get('a')?.body).toBe('1');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')?.body).toBe('3');
    expect(cache.size).toBe(2);
  });

  it('declines an oversized body rather than evicting the rest to hold it', () => {
    const cache = new EtagCache(8, 4);
    cache.set('small', entry('123'));
    cache.set('huge', entry('123456'));
    // The huge URL keeps paying full price — one request, every poll.
    expect(cache.get('huge')).toBeUndefined();
    expect(cache.get('small')?.body).toBe('123');
  });

  /**
   * The entry bound is not a round number, it is a fan-out. `fetchPodData`
   * asks for three lists per repository and two of them paginate to ten pages,
   * so the URL set a poll cycles through is far wider than the "three per
   * repository" a single-page pod suggests. A bound under it does not degrade
   * gracefully — LRU over a cycle that does not fit hits nothing at all, and
   * the poll silently goes back to full price with the cache still in place.
   */
  it('holds a whole poll of a wide pod, so the cycle does not evict itself', () => {
    const cache = new EtagCache();
    const REPOS = 30;
    const PAGES = 2;
    const urls: string[] = [];
    for (let repo = 0; repo < REPOS; repo += 1) {
      for (let page = 1; page <= PAGES; page += 1) {
        urls.push(`/repos/acme/repo-${repo}/pulls?page=${page}`);
        urls.push(`/repos/acme/repo-${repo}/issues?page=${page}`);
      }
      urls.push(`/repos/acme/repo-${repo}/actions/runs`);
    }
    for (const url of urls) cache.set(url, entry(url));
    // Poll two finds every validator it left behind — the whole point.
    expect(urls.filter((url) => cache.get(url) !== undefined)).toHaveLength(urls.length);
  });

  it('evicts until the total fits, and keeps the running total honest', () => {
    const cache = new EtagCache(8, 8, 8);
    cache.set('a', entry('aaaa'));
    cache.set('b', entry('bbbb'));
    cache.set('c', entry('cccc'));
    expect(cache.get('a')).toBeUndefined();
    expect(cache.size).toBe(2);

    // Deleting must give the bytes back, or the cap ratchets shut.
    cache.delete('b');
    cache.set('d', entry('dddd'));
    expect(cache.get('c')?.body).toBe('cccc');
    expect(cache.get('d')?.body).toBe('dddd');
  });
});

describe('stopping before the wall', () => {
  const NOW_MS = 1_700_000_000_000;
  const RESET_AT = NOW_MS / 1000 + 600;

  /**
   * A server that answers everything, reporting whatever budget the test wants
   * and no validator — so nothing is cached and every allowed request shows up
   * in `sent`.
   */
  function server(
    counts: { core: number; graphql: number },
    sent: string[],
    reset: number = RESET_AT,
  ): FetchLike {
    return (url) => {
      sent.push(url);
      const bucket = url.endsWith('/graphql') ? 'graphql' : 'core';
      const body = bucket === 'graphql' ? '{"data":{"ok":true}}' : '[]';
      const headers: Record<string, string> = {
        'x-ratelimit-remaining': String(counts[bucket]),
        'x-ratelimit-reset': String(reset),
      };
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
        json: () => Promise.resolve(JSON.parse(body) as unknown),
        text: () => Promise.resolve(body),
      });
    };
  }

  const kindOf = (e: unknown): string | undefined => (isScmError(e) ? e.kind : undefined);
  const delayOf = (e: unknown): number | undefined => (isScmError(e) ? e.retryAfterSeconds : undefined);

  it('refuses at the floor without issuing the request', async () => {
    const sent: string[] = [];
    const http = new GitHubHttp(
      'https://github.com', 'ghp-test', server({ core: RATE_FLOORS.background, graphql: 5000 }, sent),
      () => NOW_MS, new EtagCache(), { intent: 'background' },
    );

    await http.get('/repos/acme/core/pulls');
    expect(sent).toHaveLength(1);

    const error: unknown = await http.get('/repos/acme/core/pulls').catch((e: unknown) => e);
    expect(kindOf(error)).toBe('rateLimited');
    // The caller cannot tell this from the 403 it replaces, which is the point:
    // it carries the same kind and the same reset.
    expect(delayOf(error)).toBe(600);
    // Nothing went out. Spending the last requests to be told they are gone is
    // the behaviour this exists to stop.
    expect(sent).toHaveLength(1);
  });

  it('keeps the reserve for the connection that asked for it', async () => {
    const sent: string[] = [];
    const budget = new RateBudget();
    const fetchImpl = server({ core: RATE_FLOORS.background - 10, graphql: 5000 }, sent);
    const poll = new GitHubHttp('https://github.com', 'ghp-test', fetchImpl, () => NOW_MS, new EtagCache(), {
      budget, intent: 'background',
    });
    const user = new GitHubHttp('https://github.com', 'ghp-test', fetchImpl, () => NOW_MS, new EtagCache(), {
      budget, intent: 'interactive',
    });

    await poll.get('/repos/acme/core/pulls');
    expect(kindOf(await poll.get('/repos/acme/core/pulls').catch((e: unknown) => e))).toBe('rateLimited');
    // The whole reason for a reserve: what the user is waiting on still goes.
    await expect(user.get('/repos/acme/core/pulls')).resolves.toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('stops the exhausted bucket only', async () => {
    const sent: string[] = [];
    const http = new GitHubHttp(
      'https://github.com', 'ghp-test', server({ core: 3, graphql: 4999 }, sent),
      () => NOW_MS, new EtagCache(),
    );

    await http.get('/repos/acme/core/pulls');
    // `core` and `graphql` are separate resources with separate counters; a
    // client that pooled them would silence the half that still has budget.
    await expect(http.graphql('query { viewer { login } }', {})).resolves.toEqual({ ok: true });
    expect(kindOf(await http.get('/repos/acme/core/pulls').catch((e: unknown) => e))).toBe('rateLimited');
    expect(sent).toEqual([
      'https://api.github.com/repos/acme/core/pulls',
      'https://api.github.com/graphql',
    ]);
  });

  it('stops the exhausted bucket only, the other way round', async () => {
    const sent: string[] = [];
    const http = new GitHubHttp(
      'https://github.com', 'ghp-test', server({ core: 4999, graphql: 2 }, sent),
      () => NOW_MS, new EtagCache(),
    );

    await http.graphql('query { viewer { login } }', {});
    expect(kindOf(await http.graphql('query { viewer { login } }', {}).catch((e: unknown) => e)))
      .toBe('rateLimited');
    await expect(http.get('/repos/acme/core/pulls')).resolves.toEqual([]);
  });

  it('remembers the budget across the connections one provider hands out', async () => {
    const sent: string[] = [];
    const provider = createGitHubProvider(server({ core: 1, graphql: 5000 }, sent), () => NOW_MS);
    const background = { ...CONFIG, intent: 'background' as const };

    // `connectionForPod` builds a fresh Connection every poll. A budget owned
    // by the client would be re-learned from zero each time, which is why
    // `rateState` could be parsed on every response and still stop nothing.
    await provider.connect(background).listWorkItems(['acme/core']);
    const error: unknown = await provider.connect(background)
      .listWorkItems(['acme/core'])
      .catch((e: unknown) => e);

    expect(kindOf(error)).toBe('rateLimited');
    expect(sent).toHaveLength(1);
  });

  it("never spends one account's reading on another account", async () => {
    const sent: string[] = [];
    const budget = new RateBudget();
    const fetchImpl = server({ core: 1, graphql: 5000 }, sent);
    const opts = { budget, intent: 'background' as const };
    const mine = new GitHubHttp('https://github.com', 'ghp-mine', fetchImpl, () => NOW_MS, new EtagCache(), opts);
    const theirs = new GitHubHttp('https://github.com', 'ghp-theirs', fetchImpl, () => NOW_MS, new EtagCache(), opts);

    await mine.get('/repos/acme/core/pulls');
    expect(kindOf(await mine.get('/repos/acme/core/pulls').catch((e: unknown) => e))).toBe('rateLimited');
    // One provider serves every pod on a host. Two tokens hold two budgets.
    await expect(theirs.get('/repos/acme/core/pulls')).resolves.toEqual([]);
  });

  it('starts spending again once the window has rolled over', async () => {
    const sent: string[] = [];
    let clock = NOW_MS;
    const http = new GitHubHttp(
      'https://github.com', 'ghp-test', server({ core: 0, graphql: 5000 }, sent),
      () => clock, new EtagCache(),
    );

    await http.get('/repos/acme/core/pulls');
    expect(kindOf(await http.get('/repos/acme/core/pulls').catch((e: unknown) => e))).toBe('rateLimited');

    clock = (RESET_AT + 1) * 1000;
    // A reading describes one window. Once that window is gone the reading is
    // not "no budget", it is "no information" — refusing on it forever is how
    // a rate-limit guard becomes the outage.
    await expect(http.get('/repos/acme/core/pulls')).resolves.toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('reads nothing from a response that carries no budget headers', async () => {
    const sent: string[] = [];
    const http = new GitHubHttp('https://github.com', 'ghp-test', (url) => {
      sent.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: () => Promise.resolve([] as unknown),
        text: () => Promise.resolve('[]'),
      });
    }, () => NOW_MS, new EtagCache(), { intent: 'background' });

    await http.get('/repos/acme/core/pulls');
    // `Number(null)` is 0 and 0 is finite, so parsing unconditionally would
    // read a 204, an error page or a proxy that strips headers as "nothing
    // left" — and then refuse everything after it.
    expect(http.rateState('core')).toEqual({});
    await expect(http.get('/repos/acme/core/pulls')).resolves.toEqual([]);
    expect(sent).toHaveLength(2);
  });

  it('will not refuse on half a reading', async () => {
    const budget = new RateBudget();
    budget.observe('acct', 'core', { get: (n) => (n === 'x-ratelimit-remaining' ? '0' : null) });
    // A count with no reset cannot answer "when should I try again?", and a
    // refusal that cannot say when is worse than one wasted request.
    expect(budget.secondsUntilReset('acct', 'core', 50, NOW_MS)).toBeUndefined();
    budget.observe('acct', 'core', { get: (n) => (n === 'x-ratelimit-reset' ? String(RESET_AT) : null) });
    expect(budget.secondsUntilReset('acct', 'core', 50, NOW_MS)).toBe(600);
  });
});
