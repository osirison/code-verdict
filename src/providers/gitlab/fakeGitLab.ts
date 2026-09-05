/**
 * A fake GitLab REST v4 surface for tests, serving the payloads from
 * `spec/specs/Code Verdict - API fixtures.json` plus the routes the
 * provider contract exercises. No sockets — just a FetchLike.
 */
import { loadSpecFixtures } from '../../testing/specFixtures';
import { linesFromUnifiedDiff } from './mappers';
import type { FetchLike, FetchResponseLike } from './http';

export interface FakeGitLabOptions {
  /** 1-based index of the discussion POST that fails with a stale-anchor 400. */
  failDiscussionPostAt?: number;
  /** Every review-investigation route fails with the neutral rate-limited error (task 3.5/4.4). */
  investigationRateLimited?: boolean;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? headers[name] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const PROJECTS = [
  { id: 9101, path_with_namespace: 'hve/platform/core', name: 'core', web_url: 'https://gitlab.example/hve/platform/core' },
  { id: 9102, path_with_namespace: 'hve/platform/auth-service', name: 'auth-service', web_url: 'https://gitlab.example/hve/platform/auth-service' },
  { id: 9103, path_with_namespace: 'hve/platform/api-gateway', name: 'api-gateway', web_url: 'https://gitlab.example/hve/platform/api-gateway' },
  { id: 9104, path_with_namespace: 'hve/platform/billing', name: 'billing', web_url: 'https://gitlab.example/hve/platform/billing' },
  { id: 9105, path_with_namespace: 'hve/platform/notifications', name: 'notifications', web_url: 'https://gitlab.example/hve/platform/notifications' },
];

const GROUP = { id: 4821, full_path: 'hve/platform', name: 'Platform' };

/** Same content the `/changes` route below hands out — kept as one literal so `/compare` and `/changes` describe the same snapshot. */
const TOKEN_TS_DIFF =
  '@@ -63,1 +63,1 @@\n-      logger.error(\'refresh failed\')\n+      logger.error(`refresh failed ${this.refreshToken}`)\n';
const AUTH_SPEC_DIFF = "@@ -10,1 +10,2 @@\n describe('token', () => { /* happy path only */ })\n+  it.todo('401 -> refresh path')\n";
const LOGO_BINARY_DIFF = 'Binary files a/assets/logo.png and b/assets/logo.png differ';
/** Strictly older than !2841's own base/head — proves a pinned read never substitutes the branch tip (task 3.7). */
const PRIOR_BASE_SHA = 'prior-base-1';
const PRIOR_HEAD_SHA = 'prior-head-1';
const PRIOR_FILE_DIFF = '@@ -1,1 +1,1 @@\n-old\n+older\n';

const LINKED_ISSUE = {
  id: 500001,
  iid: 1180,
  project_id: 9101,
  title: 'Support refresh envelope',
  description: 'Needs the retry envelope from !2841.',
  state: 'opened',
  labels: ['backend'],
  assignees: [],
  milestone: null,
  updated_at: '2026-07-20T00:00:00.000Z',
  web_url: 'https://gitlab.example/hve/platform/core/-/issues/1180',
};

export function makeFakeGitLabFetch(opts: FakeGitLabOptions = {}): FetchLike {
  const fixtures = loadSpecFixtures();
  const mr = fixtures.gitlabMergeRequest as Record<string, unknown>;
  const diffRefs = mr.diff_refs as Record<string, string>;
  const baseSha = diffRefs.base_sha ?? '';
  const headSha = diffRefs.head_sha ?? '';
  const discussions = (fixtures.discussionsResponse as { discussions: unknown[] }).discussions;

  let discussionPosts = 0;

  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    const parsed = new URL(url);
    const path = parsed.pathname;
    const page = Number(parsed.searchParams.get('page') ?? '1');
    const route = `${method} ${path}`;

    if (route === 'POST /api/graphql') {
      return json(200, { data: { mergeRequestUpdateReviewerState: { errors: [] } } });
    }
    if (route === 'GET /api/v4/user') return json(200, { username: 'you', name: 'You' });
    if (route === 'GET /api/v4/personal_access_tokens/self') {
      return json(200, { scopes: ['api'], expires_at: '2026-09-10' });
    }

    if (route === 'GET /api/v4/groups/4821') return json(200, GROUP);
    // Served in two pages to exercise x-next-page pagination.
    if (route === 'GET /api/v4/groups/4821/projects') {
      return page === 1
        ? json(200, PROJECTS.slice(0, 3), { 'x-next-page': '2' })
        : json(200, PROJECTS.slice(3));
    }
    if (route === 'GET /api/v4/groups/4821/merge_requests') {
      return json(200, [{ project_id: 9101 }]);
    }
    if (method === 'GET' && /^\/api\/v4\/groups\/[^/]+$/.test(path)) {
      return json(404, { message: '404 Group Not Found' });
    }

    const mrBase = '/api/v4/projects/9101/merge_requests/2841';
    if (opts.investigationRateLimited && /^\/api\/v4\/projects\/9101\/(repository\/(compare|files\/)|search|issues\/1180)/.test(path)) {
      return json(429, { message: '429 Too Many Requests' }, { 'retry-after': '30' });
    }
    if (route === `GET ${mrBase}/changes`) {
      return json(200, {
        diff_refs: diffRefs,
        changes: [
          { old_path: 'src/auth/token.ts', new_path: 'src/auth/token.ts', diff: TOKEN_TS_DIFF },
          { old_path: 'test/auth.spec.ts', new_path: 'test/auth.spec.ts', diff: AUTH_SPEC_DIFF },
        ],
      });
    }
    if (route === `GET ${mrBase}`) return json(200, mr);
    if (route === `GET ${mrBase}/commits`) {
      return json(200, [
        { id: headSha, short_id: headSha.slice(0, 8), title: 'Refactor token refresh', message: 'Refactor token refresh', author_name: 'You' },
      ]);
    }
    if (route === 'GET /api/v4/projects/9101/repository/compare') {
      const from = parsed.searchParams.get('from');
      const to = parsed.searchParams.get('to');
      if (from === baseSha && to === headSha) {
        return json(200, {
          commits: [{ id: to, short_id: to.slice(0, 8), title: 'Refactor token refresh', message: 'Refactor token refresh', author_name: 'You' }],
          diffs: [
            { old_path: 'src/auth/token.ts', new_path: 'src/auth/token.ts', diff: TOKEN_TS_DIFF, new_file: false, renamed_file: false, deleted_file: false, too_large: false },
            { old_path: 'test/auth.spec.ts', new_path: 'test/auth.spec.ts', diff: AUTH_SPEC_DIFF, new_file: false, renamed_file: false, deleted_file: false, too_large: false },
            { old_path: 'assets/logo.png', new_path: 'assets/logo.png', diff: LOGO_BINARY_DIFF, new_file: true, renamed_file: false, deleted_file: false, too_large: false },
            { old_path: 'package-lock.json', new_path: 'package-lock.json', diff: '', new_file: false, renamed_file: false, deleted_file: false, too_large: true },
          ],
          compare_timeout: false,
          compare_same_ref: false,
        });
      }
      if (from === PRIOR_BASE_SHA && to === PRIOR_HEAD_SHA) {
        return json(200, {
          commits: [],
          diffs: [{ old_path: 'src/legacy/old.ts', new_path: 'src/legacy/old.ts', diff: PRIOR_FILE_DIFF, new_file: false, renamed_file: false, deleted_file: false, too_large: false }],
          compare_timeout: false,
          compare_same_ref: false,
        });
      }
      return json(404, { message: '404 Commit Not Found' });
    }
    const filesMatch = path.match(/^\/api\/v4\/projects\/9101\/repository\/files\/(.+)$/);
    if (method === 'GET' && filesMatch) {
      const filePath = decodeURIComponent(filesMatch[1] as string);
      const ref = parsed.searchParams.get('ref');
      if (ref !== baseSha && ref !== headSha) return json(404, { message: '404 Commit Not Found' });
      if (filePath === 'assets/logo.png') {
        const content = Buffer.from([0, 1, 2, 3, 0]).toString('base64');
        return json(200, { file_name: 'logo.png', file_path: filePath, size: 5, encoding: 'base64', content, content_sha256: 'x', ref, blob_id: 'x', commit_id: 'x', last_commit_id: 'x' });
      }
      if (filePath === 'src/auth/token.ts') {
        const text = linesFromUnifiedDiff(TOKEN_TS_DIFF).join('\n');
        const content = Buffer.from(text, 'utf8').toString('base64');
        return json(200, { file_name: 'token.ts', file_path: filePath, size: text.length, encoding: 'base64', content, content_sha256: 'x', ref, blob_id: 'x', commit_id: 'x', last_commit_id: 'x' });
      }
      return json(404, { message: '404 File Not Found' });
    }
    if (route === 'GET /api/v4/projects/9101/search') {
      const scope = parsed.searchParams.get('scope');
      const search = parsed.searchParams.get('search') ?? '';
      const ref = parsed.searchParams.get('ref') ?? '';
      if (scope !== 'blobs') return json(400, { message: '400 Bad Request' });
      const matches = linesFromUnifiedDiff(TOKEN_TS_DIFF)
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => search !== '' && line.includes(search));
      return json(
        200,
        matches.map(({ line, index }) => ({
          basename: 'token', data: line, path: 'src/auth/token.ts', filename: 'src/auth/token.ts', ref, startline: index + 1, project_id: 9101,
        })),
      );
    }
    if (route === 'GET /api/v4/projects/9101/issues/1180') return json(200, LINKED_ISSUE);
    if (route === 'GET /api/v4/projects/9101/issues/1180/discussions') return json(200, []);
    if (route === `POST ${mrBase}/discussions`) {
      discussionPosts += 1;
      if (discussionPosts === opts.failDiscussionPostAt) {
        return json(400, { message: '400 (Bad request) "Note position is invalid"' });
      }
      return json(201, { id: `disc_${discussionPosts}`, individual_note: false });
    }
    if (route === `GET ${mrBase}/discussions`) return json(200, discussions);
    if (method === 'PUT' && path.startsWith(`${mrBase}/discussions/`)) return json(200, {});
    if (method === 'POST' && /\/discussions\/[^/]+\/notes$/.test(path)) return json(201, { id: 1 });
    if (route === `POST ${mrBase}/notes`) return json(201, { id: 2 });
    if (route === `POST ${mrBase}/approve`) return json(201, {});

    // The real list endpoint omits head_pipeline / changes_count / diff_refs
    // (single-MR-only fields) — serve the honest list shape so the provider
    // cannot silently depend on them.
    if (route === 'GET /api/v4/projects/9101/merge_requests') {
      const listShaped = { ...mr };
      delete listShaped.head_pipeline;
      delete listShaped.changes_count;
      delete listShaped.diff_refs;
      return json(200, [listShaped]);
    }
    if (route === 'GET /api/v4/projects/9101/pipelines') {
      return json(200, [
        {
          id: 90412,
          status: 'success',
          sha: headSha,
          ref: 'feat/auth-refresh',
          web_url: 'https://gitlab.example/hve/platform/core/-/pipelines/90412',
        },
      ]);
    }
    if (method === 'GET' && /^\/api\/v4\/projects\/[^/]+\/merge_requests$/.test(path)) {
      return json(200, []);
    }
    if (method === 'GET' && /^\/api\/v4\/projects\/[^/]+\/issues$/.test(path)) return json(200, []);
    if (method === 'GET' && /^\/api\/v4\/projects\/[^/]+\/pipelines$/.test(path)) return json(200, []);

    const projectMatch = path.match(/^\/api\/v4\/projects\/([^/]+)$/);
    if (method === 'GET' && projectMatch) {
      const key = decodeURIComponent(projectMatch[1] as string);
      const project = PROJECTS.find((p) => String(p.id) === key || p.path_with_namespace === key);
      return project ? json(200, project) : json(404, { message: '404 Project Not Found' });
    }

    return json(404, { message: `404 no fake route for ${route}` });
  };
}
