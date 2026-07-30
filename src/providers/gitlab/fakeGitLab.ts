/**
 * A fake GitLab REST v4 surface for tests, serving the payloads from
 * `spec/specs/Code Verdict - API fixtures.json` plus the routes the
 * provider contract exercises. No sockets — just a FetchLike.
 */
import { loadSpecFixtures } from '../../testing/specFixtures';
import type { FetchLike, FetchResponseLike } from './http';

export interface FakeGitLabOptions {
  /** 1-based index of the discussion POST that fails with a stale-anchor 400. */
  failDiscussionPostAt?: number;
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

export function makeFakeGitLabFetch(opts: FakeGitLabOptions = {}): FetchLike {
  const fixtures = loadSpecFixtures();
  const mr = fixtures.gitlabMergeRequest as Record<string, unknown>;
  const diffRefs = mr.diff_refs as Record<string, string>;
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
    if (route === `GET ${mrBase}/changes`) {
      return json(200, {
        diff_refs: diffRefs,
        changes: [
          {
            old_path: 'src/auth/token.ts',
            new_path: 'src/auth/token.ts',
            diff: '@@ -60,7 +60,7 @@\n-      logger.error(\'refresh failed\')\n+      logger.error(`refresh failed ${this.refreshToken}`)\n',
          },
          {
            old_path: 'test/auth.spec.ts',
            new_path: 'test/auth.spec.ts',
            diff: "@@ -10,4 +10,6 @@\n describe('token', () => { /* happy path only */ })\n",
          },
        ],
      });
    }
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
          sha: diffRefs.head_sha,
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
