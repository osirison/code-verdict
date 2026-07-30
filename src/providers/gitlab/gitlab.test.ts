import { describe, expect, it } from 'vitest';
import { loadSpecFixtures } from '../../testing/specFixtures';
import { mapGitLabError } from './errors';
import { buildCommentBody, buildPosition, toReviewThread } from './mappers';
import type { GlDiscussion } from './mappers';
import { createGitLabProvider } from './gitlabProvider';
import { makeFakeGitLabFetch } from './fakeGitLab';

const fixtures = loadSpecFixtures();

describe('mapGitLabError (errorResponses fixtures)', () => {
  it('maps the five failure branches onto the taxonomy', () => {
    expect(mapGitLabError(401, '401 Unauthorized').kind).toBe('auth');
    expect(mapGitLabError(403, '403 Forbidden — insufficient_scope').kind).toBe('insufficientScope');
    expect(mapGitLabError(400, '400 (Bad request) "Note position is invalid"').kind).toBe('staleAnchor');
    expect(mapGitLabError(404, '404 Project Not Found').kind).toBe('notFound');
    const rate = mapGitLabError(429, '', { get: (n) => (n === 'Retry-After' ? '38' : null) });
    expect(rate.kind).toBe('rateLimited');
    expect(rate.retryAfterSeconds).toBe(38);
  });

  it('does not treat other 400s as stale anchors', () => {
    expect(mapGitLabError(400, 'something else entirely').kind).toBe('unknown');
  });
});

describe('outbound payloads reproduce the postDiscussionRequest fixture', () => {
  const reference = fixtures.postDiscussionRequest as { body: string; position: Record<string, unknown> };

  it('buildCommentBody is byte-compatible with the fixture body', () => {
    const body = buildCommentBody({
      key: 'itm_01H9Z4',
      body:
        '**Refresh token logged in error path** · blocker · security · CWE-532\n\n' +
        'Secret material reaches the log sink. Log shipping is not scrubbed, so the token lands in retained storage. Redact, or log only the token id.',
      suggestion: {
        old: 'logger.error(`refresh failed ${this.refreshToken}`)',
        new: "logger.error('refresh failed', { tokenId: this.tokenId })",
      },
      footer:
        '<sub>Flagged by HVE Core · PR Review (96% confidence), accepted by @you via Code Verdict.</sub>',
      anchor: { filePath: 'src/auth/token.ts', line: 63, refs: {} },
    });
    expect(body).toBe(reference.body);
  });

  it('buildPosition is field-compatible with the fixture position', () => {
    const mr = fixtures.gitlabMergeRequest as { diff_refs: Record<string, string> };
    const position = buildPosition({
      filePath: 'src/auth/token.ts',
      line: 63,
      refs: mr.diff_refs,
    });
    expect(position).toEqual(reference.position);
  });

  it('rejects anchors that do not carry GitLab diff_refs', () => {
    expect(() => buildPosition({ filePath: 'a.ts', line: 1, refs: { commit_id: 'gh-shaped' } })).toThrow(
      /diff_refs/,
    );
  });
});

describe('toReviewThread', () => {
  const discussions = (fixtures.discussionsResponse as { discussions: GlDiscussion[] }).discussions;
  const crRef = { repoId: '9101', number: '2841' };

  it('marks the force-pushed discussion anchor as dropped (position: null)', () => {
    const threads = discussions.map((d) => toReviewThread(d, crRef));
    const byId = new Map(threads.map((t) => [t.id, t]));
    expect(byId.get('c3fcd3d76192e4007dfb496cca67e13b')?.anchorPresent).toBe(false);
    expect(byId.get('d41d8cd98f00b204e9800998ecf8427e')?.anchorPresent).toBe(true);
  });

  it('derives discussion resolution from resolvable notes', () => {
    const threads = discussions.map((d) => toReviewThread(d, crRef));
    const resolved = threads.find((t) => t.id === 'b1946ac92492d2347c6235b4d2611184');
    expect(resolved?.resolved).toBe(true);
  });
});

describe('submitReview against the fake instance', () => {
  const CONFIG = { instanceUrl: 'https://gitlab.example', token: 'glpat-test' };

  it('aborts the remaining batch after an auth failure instead of hammering', async () => {
    let calls = 0;
    const conn = createGitLabProvider(async (url, init) => {
      const inner = makeFakeGitLabFetch();
      if ((init?.method ?? 'GET') === 'POST' && url.includes('/discussions')) {
        calls += 1;
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          json: async () => ({ message: '401 Unauthorized' }),
          text: async () => '401 Unauthorized',
        };
      }
      return inner(url, init);
    }).connect(CONFIG);

    const refs = (fixtures.gitlabMergeRequest as { diff_refs: unknown }).diff_refs;
    const result = await conn.submitReview(
      { repoId: '9101', number: '2841' },
      {
        comments: [
          { key: 'a', body: 'x', anchor: { filePath: 'src/auth/token.ts', line: 63, refs } },
          { key: 'b', body: 'y', anchor: { filePath: 'src/auth/token.ts', line: 88, refs } },
        ],
        summary: 'never posted',
      },
    );

    expect(calls).toBe(1);
    expect(result.comments.map((c) => c.ok)).toEqual([false, false]);
    expect(result.comments[1]?.error?.kind).toBe('auth');
    expect(result.summaryPosted).toBe(false);
  });
});
