/**
 * A fake GitHub, served through the same `FetchLike` seam the real client
 * uses, so every provider test runs without network.
 *
 * Response shapes follow real payloads captured during design: pull requests
 * carry `head.sha` / `draft` / `requested_reviewers`; review comments carry
 * `commit_id` + `path` + `line` + `side`; checks come from
 * `/commits/{sha}/check-runs` with `status` + `conclusion`.
 *
 * `failReviewPositionOnBatch` is what exercises the provider's two-phase
 * submit: the batched review 422s the way GitHub does when one comment's
 * position is stale, forcing the per-comment fallback.
 */
import type { FetchLike, FetchResponseLike } from './http';

export interface RequestLog {
  /** Every path requested, in order. GraphQL appears as `/graphql`. */
  paths: string[];
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

const CHECK_RUNS = [
  {
    id: 93178061854,
    name: 'ci',
    status: 'completed',
    conclusion: 'success',
    html_url: 'https://github.com/acme/core/actions/runs/1/job/1',
    started_at: '2026-08-20T09:50:00Z',
  },
];

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

  return async (rawUrl, init = {}) => {
    const method = init.method ?? 'GET';
    const url = new URL(rawUrl);
    const path = url.pathname.replace(/^\/api\/v3/, '');
    options.log?.paths.push(path);
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
    if (tail === '/commits' && method === 'GET') return json([{ sha: HEAD_SHA }], extraHeaders);
    if (/^\/commits\/[^/]+\/check-runs$/.test(tail)) {
      return json({ total_count: CHECK_RUNS.length, check_runs: CHECK_RUNS }, extraHeaders);
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
