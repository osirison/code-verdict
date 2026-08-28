/**
 * A fake GitHub, served through the same `FetchLike` seam the real client
 * uses, so every provider test runs without network.
 *
 * Response shapes follow real payloads captured during design: pull requests
 * carry `head.sha` / `draft` / `requested_reviewers`; review comments carry
 * `commit_id` + `path` + `line` + `side`; workflow runs come from
 * `/actions/runs` with `status` + `conclusion` + `head_branch`.
 *
 * The workflow-run payloads below were captured on 2026-08-26 from
 * api.github.com (`vercel/next.js`, `microsoft/vscode`, unauthenticated) and
 * trimmed to the fields a response really carries in that position — including
 * `conclusion: null` on a run still `in_progress`, and a `name` that is the
 * run's display name rather than a workflow or job name.
 *
 * `failReviewPositionOnBatch` is what exercises the provider's two-phase
 * submit: the batched review 422s the way GitHub does when one comment's
 * position is stale, forcing the per-comment fallback.
 *
 * Every GET answers with an `etag` and honours `If-None-Match` with a 304,
 * because that is what the client's whole rate-limit budget now rests on.
 * Conditional requests are RFC 9110, not a GitHub invention, so the mechanism
 * is not something to capture — but the surrounding detail is, and it was:
 * against api.github.com on 2026-08-26 the validator came back
 * `W/"4258f9258a…"` (weak, quoted, hex), and the 304 repeated `etag`, `link`
 * and every `x-ratelimit-*` header the 200 carried. The digest below is a
 * fixture-local hash rather than GitHub's own — only its shape is copied.
 */
import type { FetchLike, FetchResponseLike } from './http';

export interface RequestLog {
  /** Every path requested, in order. GraphQL appears as `/graphql`. */
  paths: string[];
  /** Full URLs, for a test that has to see the query string (per_page). */
  urls?: string[];
  /** The `If-None-Match` sent with each request, `null` where none was. */
  validators?: Array<string | null>;
  /** The status served for each request — how the issued/charged split is read. */
  statuses?: number[];
}

export interface FakeGitHubOptions {
  /** Collects every request, so a test can assert the call count. */
  log?: RequestLog;
  /** The batched review endpoint rejects with a position 422. */
  failReviewPositionOnBatch?: boolean;
  /** In the per-comment fallback, the Nth comment (1-based) fails with a position 422. */
  failCommentAt?: number;
  /** In the fallback, the Nth comment fails with this status — for fatal kinds. */
  failCommentAtWith?: { at: number; status: number; message: string };
  /** Every write fails with this status/message. */
  failAllWrites?: { status: number; message: string };
  /** The instance refuses APPROVE / REQUEST_CHANGES — you are the PR author. */
  refuseVerdict?: boolean;
  /** Extra headers on every response — used to drive rate-limit mapping. */
  headers?: Record<string, string>;
}

const ORG = { login: 'acme', name: 'Acme Engineering' };

const REPOS = [
  { full_name: 'acme/core', name: 'core', html_url: 'https://github.com/acme/core' },
  { full_name: 'acme/auth-service', name: 'auth-service', html_url: 'https://github.com/acme/auth-service' },
  { full_name: 'acme/api-gateway', name: 'api-gateway', html_url: 'https://github.com/acme/api-gateway' },
];

const HEAD_SHA = '9f2c1ab4e5d6708192a3b4c5d6e7f8091a2b3c4d';

const PULLS: Record<string, unknown[]> = {
  'acme/core': [
    {
      number: 2841,
      title: 'Add per-tenant rate limiting',
      body: 'Changeset: rate-limiting',
      state: 'open',
      merged_at: null,
      draft: false,
      head: { ref: 'feat/rate-limit', sha: HEAD_SHA },
      base: { ref: 'main' },
      user: { login: 'dana' },
      requested_reviewers: [{ login: 'you' }],
      html_url: 'https://github.com/acme/core/pull/2841',
      updated_at: '2026-08-20T10:00:00Z',
      changed_files: 4,
    },
  ],
  'acme/auth-service': [
    {
      number: 812,
      title: 'Rotate signing keys',
      state: 'open',
      merged_at: null,
      draft: true,
      head: { ref: 'feat/rotate', sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd' },
      base: { ref: 'main' },
      user: { login: 'you' },
      requested_reviewers: [],
      html_url: 'https://github.com/acme/auth-service/pull/812',
      updated_at: '2026-08-19T09:00:00Z',
      changed_files: 2,
    },
  ],
  'acme/api-gateway': [],
};

const ISSUES: Record<string, unknown[]> = {
  'acme/core': [
    {
      number: 1180,
      title: 'Tenants can exhaust the shared bucket',
      body: 'One tenant can spend the whole shared bucket in a burst and starve the rest.\n\nWanted: a per-tenant limit that degrades to the shared bucket when unset.',
      state: 'open',
      assignee: { login: 'dana' },
      milestone: { title: 'Q3 hardening' },
      updated_at: '2026-08-18T08:00:00Z',
      html_url: 'https://github.com/acme/core/issues/1180',
    },
    // A pull request surfacing through the issues endpoint — must be filtered out.
    {
      number: 2841,
      title: 'Add per-tenant rate limiting',
      state: 'open',
      updated_at: '2026-08-20T10:00:00Z',
      html_url: 'https://github.com/acme/core/pull/2841',
      pull_request: { url: 'https://api.github.com/repos/acme/core/pulls/2841' },
    },
  ],
  'acme/auth-service': [],
  'acme/api-gateway': [],
};

const FILES = [
  {
    filename: 'src/limiter.ts',
    status: 'modified',
    patch: '@@ -10,6 +10,12 @@\n context\n+const a = 1\n+const b = 2\n',
  },
  { filename: 'src/added.ts', status: 'added', patch: '@@ -0,0 +1,3 @@\n+new file\n' },
  { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1,3 +0,0 @@\n-old file\n' },
  {
    filename: 'src/renamed-new.ts',
    previous_filename: 'src/renamed-old.ts',
    status: 'renamed',
    patch: '@@ -1,1 +1,1 @@\n-a\n+b\n',
  },
];

/**
 * `GET /repos/{owner}/{repo}/actions/runs` — newest first, every branch, as
 * the live endpoint orders it. api-gateway has none: a repository with Actions
 * off answers 200 with an empty list, not an error.
 */
const WORKFLOW_RUNS: Record<string, unknown[]> = {
  'acme/core': [
    {
      id: 32918212053,
      name: 'CI',
      head_branch: 'feat/rate-limit',
      head_sha: HEAD_SHA,
      path: '.github/workflows/ci.yml',
      display_title: 'Add per-tenant rate limiting',
      run_number: 412,
      event: 'pull_request',
      status: 'completed',
      conclusion: 'failure',
      html_url: 'https://github.com/acme/core/actions/runs/32918212053',
      created_at: '2026-08-20T09:58:00Z',
      updated_at: '2026-08-20T10:06:12Z',
      run_attempt: 1,
      run_started_at: '2026-08-20T09:58:04Z',
    },
    {
      id: 32914104866,
      name: 'CI',
      head_branch: 'main',
      head_sha: '7c1de9a0b2f3c4d5e6f708192a3b4c5d6e7f8091',
      path: '.github/workflows/ci.yml',
      display_title: 'Merge pull request #2838',
      run_number: 411,
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      html_url: 'https://github.com/acme/core/actions/runs/32914104866',
      created_at: '2026-08-20T08:31:00Z',
      updated_at: '2026-08-20T08:39:44Z',
      run_attempt: 1,
      run_started_at: '2026-08-20T08:31:02Z',
    },
  ],
  'acme/auth-service': [
    {
      id: 32920670894,
      // A workflow whose `run-name:` sets this per run — the reason the mapper
      // never reads `name` as a job name.
      name: 'Rotate signing keys (attempt 2)',
      head_branch: 'feat/rotate',
      head_sha: 'aa11bb22cc33dd44ee55ff6677889900aabbccdd',
      path: '.github/workflows/keys.yml',
      run_number: 88,
      event: 'push',
      status: 'in_progress',
      // Null until the run completes — captured, not assumed.
      conclusion: null,
      html_url: 'https://github.com/acme/auth-service/actions/runs/32920670894',
      created_at: '2026-08-20T09:12:00Z',
      updated_at: '2026-08-20T09:12:30Z',
      run_attempt: 1,
      run_started_at: '2026-08-20T09:12:03Z',
    },
  ],
  'acme/api-gateway': [],
};

/**
 * A weak validator over the body, in the shape api.github.com sends. The digest
 * is FNV-1a rather than GitHub's algorithm — what a test can assert is that the
 * same body yields the same validator and a changed body does not.
 */
function weakEtag(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `W/"${hash.toString(16).padStart(8, '0')}${text.length.toString(16)}"`;
}

function headerOf(headers: Record<string, string> | undefined, name: string): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (key.toLowerCase() === wanted) return value;
  }
  return null;
}

/** The same 200, with the validator the client will send back next time. */
function withEtag(res: FetchResponseLike, text: string, etag: string): FetchResponseLike {
  return {
    ok: res.ok,
    status: res.status,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : res.headers.get(name)) },
    json: () => Promise.resolve(JSON.parse(text) as unknown),
    text: () => Promise.resolve(text),
  };
}

/**
 * A 304: no body at all, and `ok` false — `Response.ok` is 200-299, which is
 * why an unhandled 304 would reach the error mapper. Every other header the
 * 200 carried is repeated, as api.github.com repeats them.
 */
function notModified(res: FetchResponseLike, etag: string): FetchResponseLike {
  return {
    ok: false,
    status: 304,
    headers: { get: (name) => (name.toLowerCase() === 'etag' ? etag : res.headers.get(name)) },
    json: () => Promise.reject(new Error('a 304 carries no body')),
    text: () => Promise.resolve(''),
  };
}

function json(body: unknown, headers: Record<string, string> = {}): FetchResponseLike {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(JSON.parse(text) as unknown),
    text: () => Promise.resolve(text),
  };
}

function error(
  status: number,
  message: string,
  headers: Record<string, string> = {},
  errors?: ReadonlyArray<string | Record<string, string>>,
): FetchResponseLike {
  const text = JSON.stringify(errors === undefined ? { message } : { message, errors });
  return {
    ok: false,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(JSON.parse(text) as unknown),
    text: () => Promise.resolve(text),
  };
}

/** Matches `/repos/{owner}/{repo}` and the tail after it. */
function repoRoute(path: string): { repoId: string; tail: string } | undefined {
  const match = path.match(/^\/repos\/([^/]+)\/([^/]+)(.*)$/);
  if (!match) return undefined;
  return {
    repoId: `${decodeURIComponent(match[1] as string)}/${decodeURIComponent(match[2] as string)}`,
    tail: match[3] ?? '',
  };
}

export function makeFakeGitHubFetch(options: FakeGitHubOptions = {}): FetchLike {
  // Thread state is per fake, and mutable: the shared contract suite now
  // replies to a thread and resolves it, then asserts the next listThreads
  // plays that back. A static response table cannot answer that question, and
  // a fake that silently ignores a write is exactly how an unimplemented
  // mutation passes its own tests.
  const threads = initialThreads();
  const extraHeaders = Object.fromEntries(
    Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  let commentAttempt = 0;

  const route: FetchLike = async (rawUrl, init = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/api\/v3/, '');
    const isWrite = method !== 'GET';

    if (isWrite && options.failAllWrites) {
      return error(options.failAllWrites.status, options.failAllWrites.message, extraHeaders);
    }

    if (path === '/graphql') {
      return json(graphqlResponse(init.body ?? '', threads), extraHeaders);
    }

    if (path === '/user') return json({ login: 'you', name: 'You' }, extraHeaders);

    if (path === `/orgs/${ORG.login}`) return json(ORG, extraHeaders);
    if (path === `/orgs/${ORG.login}/repos`) return json(REPOS, extraHeaders);
    if (path.startsWith('/orgs/')) return error(404, 'Not Found', extraHeaders);

    const route = repoRoute(path);
    if (!route) return error(404, 'Not Found', extraHeaders);
    const { repoId, tail } = route;
    const known = REPOS.some((repo) => repo.full_name === repoId);

    if (tail === '') {
      const repo = REPOS.find((r) => r.full_name === repoId);
      return repo ? json(repo, extraHeaders) : error(404, 'Not Found', extraHeaders);
    }
    if (!known) return error(404, 'Not Found', extraHeaders);

    if (tail === '/pulls' && method === 'GET') return json(PULLS[repoId] ?? [], extraHeaders);
    if (tail === '/issues' && method === 'GET') return json(ISSUES[repoId] ?? [], extraHeaders);
    if (tail === '/actions/runs' && method === 'GET') {
      // The endpoint honours per_page, and the provider asks for exactly the
      // limit it wants — a fake that ignored it would hide an unbounded fetch.
      const perPage = Number(url.searchParams.get('per_page') ?? '30');
      const runs = (WORKFLOW_RUNS[repoId] ?? []).slice(0, Number.isFinite(perPage) ? perPage : 30);
      return json({ total_count: (WORKFLOW_RUNS[repoId] ?? []).length, workflow_runs: runs }, extraHeaders);
    }

    const pullMatch = tail.match(/^\/pulls\/(\d+)(.*)$/);
    if (pullMatch) {
      const number = Number(pullMatch[1]);
      const rest = pullMatch[2] ?? '';
      const pull = (PULLS[repoId] ?? []).find((p) => (p as { number: number }).number === number);

      if (rest === '' && method === 'GET') {
        return pull ? json(pull, extraHeaders) : error(404, 'Not Found', extraHeaders);
      }
      if (rest === '/files' && method === 'GET') return json(FILES, extraHeaders);

      // A batched review's own comments, in creation order.
      if (/^\/reviews\/\d+\/comments$/.test(rest) && method === 'GET') {
        return json([{ id: 8001 }, { id: 8002 }, { id: 8003 }], extraHeaders);
      }

      if (rest === '/reviews' && method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as {
          comments?: Array<Record<string, unknown>>;
          body?: string;
          event?: string;
        };
        const hasComments = Array.isArray(body.comments) && body.comments.length > 0;

        // Real GitHub: "Required when using REQUEST_CHANGES or COMMENT for the
        // event parameter." Modelling it is what stops the suite from blessing
        // a request the live API rejects.
        if ((body.event === 'REQUEST_CHANGES' || body.event === 'COMMENT')
          && (body.body === undefined || body.body === '')) {
          return error(422, 'Validation Failed — body is required', extraHeaders);
        }
        // Real GitHub: comments[] items take no commit_id (it is top-level).
        const stray = (body.comments ?? []).find((c) => c.commit_id !== undefined);
        if (stray) {
          return error(422, 'Validation Failed — commit_id is not a valid comment field', extraHeaders);
        }
        // Real GitHub: an author cannot approve or request changes on their
        // own pull request. The detail is a bare string in errors[], like the
        // position rejection below.
        if (options.refuseVerdict && (body.event === 'APPROVE' || body.event === 'REQUEST_CHANGES')) {
          const verb = body.event === 'APPROVE' ? 'approve' : 'request changes on';
          return error(422, 'Unprocessable Entity', extraHeaders, [
            `Review Can not ${verb} your own pull request`,
          ]);
        }
        if (options.failReviewPositionOnBatch && hasComments) {
          // Verbatim from api.github.com: the detail is a bare STRING in
          // `errors[]`, and `message` is the generic status text. A fake that
          // pre-flattens this into `message` never exercises the client's
          // `errors[]` handling — which is how a dropped string entry survived
          // three review rounds and a green suite.
          return error(422, 'Unprocessable Entity', extraHeaders, ['Line could not be resolved']);
        }
        return json({ id: 555, state: body.event ?? 'COMMENTED', commit_id: HEAD_SHA }, extraHeaders);
      }

      if (rest === '/comments' && method === 'POST') {
        const body = JSON.parse(init.body ?? '{}') as { commit_id?: string };
        // Real GitHub requires commit_id on THIS endpoint, unlike the review one.
        if (body.commit_id === undefined) {
          return error(422, 'Validation Failed — commit_id is required', extraHeaders);
        }
        commentAttempt += 1;
        const fatal = options.failCommentAtWith;
        if (fatal !== undefined && commentAttempt === fatal.at) {
          return error(fatal.status, fatal.message, extraHeaders);
        }
        if (options.failCommentAt !== undefined && commentAttempt === options.failCommentAt) {
          // The single-comment endpoint uses the other shape: object entries,
          // and "Validation Failed" as the message.
          return error(422, 'Validation Failed', extraHeaders, [
            { resource: 'PullRequestReviewComment', code: 'custom',
              field: 'pull_request_review_thread.line', message: 'could not be resolved' },
          ]);
        }
        return json({ id: 9000 + commentAttempt, commit_id: HEAD_SHA }, extraHeaders);
      }
    }

    return error(404, 'Not Found', extraHeaders);
  };

  // The conditional layer sits outside every route, so one implementation
  // covers all of them: hash the 200 the route would have served, and serve a
  // 304 instead when the client sends that same validator back.
  return async (rawUrl, init = {}) => {
    const method = init.method ?? 'GET';
    const sent = headerOf(init.headers, 'if-none-match');
    options.log?.paths.push(new URL(rawUrl).pathname.replace(/^\/api\/v3/, ''));
    options.log?.urls?.push(rawUrl);
    options.log?.validators?.push(sent);

    const res = await route(rawUrl, init);
    if (method !== 'GET' || res.status !== 200) {
      options.log?.statuses?.push(res.status);
      return res;
    }
    const text = await res.text();
    const etag = weakEtag(text);
    if (sent === etag) {
      options.log?.statuses?.push(304);
      return notModified(res, etag);
    }
    options.log?.statuses?.push(200);
    return withEtag(res, text, etag);
  };
}

interface FakeThreadNode {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  resolvedBy: { login: string } | null;
  comments: { nodes: Array<{ id: string; databaseId: number; body: string; createdAt: string; author: { login: string } }> };
}

/** The GraphQL operations the provider uses: read threads, resolve, reply. */
function graphqlResponse(body: string, threads: FakeThreadNode[]): unknown {
  const parsed = JSON.parse(body || '{}') as { query?: string; variables?: Record<string, unknown> };
  const query = parsed.query ?? '';
  const threadId = parsed.variables?.threadId as string | undefined;
  const target = threads.find((thread) => thread.id === threadId);

  if (/resolveReviewThread|unresolveReviewThread/.test(query)) {
    const resolved = /(?<!un)resolveReviewThread/.test(query);
    if (target) {
      target.isResolved = resolved;
      target.resolvedBy = resolved ? { login: 'you' } : null;
    }
    return { data: { thread: { id: threadId, isResolved: resolved } } };
  }
  if (/addPullRequestReviewThreadReply/.test(query)) {
    const id = `C_reply_${target ? target.comments.nodes.length + 1 : 0}`;
    if (target) {
      target.comments.nodes.push({
        id,
        // Distinct from the seeded ids so thread-id resolution cannot match a
        // reply by accident.
        databaseId: 70000 + target.comments.nodes.length,
        body: String(parsed.variables?.body ?? ''),
        createdAt: '2026-08-20T13:00:00Z',
        author: { login: 'you' },
      });
    }
    return { data: { addPullRequestReviewThreadReply: { comment: { id } } } };
  }
  if (/statusCheckRollup/.test(query)) {
    const repoId = `${parsed.variables?.owner as string}/${parsed.variables?.repo as string}`;
    const pulls = (PULLS[repoId] ?? []) as Array<{ number: number }>;
    return {
      data: {
        repository: {
          pullRequests: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: pulls.map((pull) => ({
              number: pull.number,
              commits: {
                nodes: [{
                  commit: {
                    statusCheckRollup: {
                      state: 'SUCCESS',
                      contexts: {
                        nodes: [{
                          __typename: 'CheckRun',
                          databaseId: 93178061854,
                          name: 'ci',
                          conclusion: 'SUCCESS',
                          status: 'COMPLETED',
                          permalink: 'https://github.com/acme/core/actions/runs/1/job/1',
                        }],
                      },
                    },
                  },
                }],
              },
            })),
          },
        },
      },
    };
  }
  return {
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: threads,
          },
        },
      },
    },
  };
}

/** A fresh copy per fake, so one test's reply cannot leak into the next. */
function initialThreads(): FakeThreadNode[] {
  return [
    {
      id: 'PRRT_live',
      isResolved: false,
      isOutdated: false,
      path: 'src/limiter.ts',
      line: 12,
      resolvedBy: null,
      comments: {
        nodes: [
          { id: 'C_1', databaseId: 8001, body: 'Bound this by tenant.', createdAt: '2026-08-20T11:00:00Z', author: { login: 'you' } },
          { id: 'C_2', databaseId: 8002, body: 'Good catch — fixing.', createdAt: '2026-08-20T12:00:00Z', author: { login: 'dana' } },
        ],
      },
    },
    {
      id: 'PRRT_outdated',
      isResolved: false,
      // Force-pushed past: the neutral `anchorPresent: false`.
      isOutdated: true,
      path: 'src/limiter.ts',
      line: null,
      resolvedBy: null,
      comments: {
        nodes: [
          { id: 'C_3', databaseId: 9001, body: 'This moved.', createdAt: '2026-08-20T11:30:00Z', author: { login: 'you' } },
        ],
      },
    },
  ];
}
