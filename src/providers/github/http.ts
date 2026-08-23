/**
 * GitHub REST + GraphQL client over one injected fetch seam, so every test
 * runs without network.
 *
 * Why both protocols: REST covers repositories, pull requests, issues, diffs
 * and posting reviews. Review-thread *resolution* has no REST equivalent —
 * `resolveReviewThread` / `unresolveReviewThread` exist only as GraphQL
 * mutations, and `isOutdated` / `isResolved` are fields on the GraphQL
 * `PullRequestReviewThread` type. Verified against the live API during design.
 *
 * Rate limits are tracked per bucket because `core` and `graphql` are separate
 * resources with independent counters — a client tracking one number
 * mispredicts the other.
 */
import { ScmError } from '../../platform/errors';
import { mapGitHubError } from './errors';

export interface FetchResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponseLike>;

export type Query = Record<string, string | number | boolean | undefined>;

export type RateBucket = 'core' | 'graphql';

export interface RateState {
  remaining?: number;
  /** Epoch seconds, as GitHub reports it. */
  resetAt?: number;
}

/** github.com uses api.github.com; GHES serves the API under /api/v3. */
export function restBaseUrl(instanceUrl: string): string {
  const trimmed = instanceUrl.replace(/\/+$/, '');
  const host = hostOf(trimmed);
  if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
    return 'https://api.github.com';
  }
  return `${trimmed}/api/v3`;
}

/** github.com's GraphQL lives at api.github.com/graphql; GHES at /api/graphql. */
export function graphqlUrl(instanceUrl: string): string {
  const trimmed = instanceUrl.replace(/\/+$/, '');
  const host = hostOf(trimmed);
  if (host === 'github.com' || host === 'www.github.com' || host === 'api.github.com') {
    return 'https://api.github.com/graphql';
  }
  return `${trimmed}/api/graphql`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function isDotCom(instanceUrl: string): boolean {
  const host = hostOf(instanceUrl.replace(/\/+$/, ''));
  return host === 'github.com' || host === 'www.github.com' || host === 'api.github.com';
}

export class GitHubHttp {
  private readonly restBase: string;
  private readonly graphqlEndpoint: string;
  private readonly rate: Record<RateBucket, RateState> = { core: {}, graphql: {} };

  constructor(
    instanceUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
  ) {
    this.restBase = restBaseUrl(instanceUrl);
    this.graphqlEndpoint = graphqlUrl(instanceUrl);
  }

  /** What the client last saw for a bucket — separate counters, by design. */
  rateState(bucket: RateBucket): RateState {
    return { ...this.rate[bucket] };
  }

  private headers(json: boolean): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (json) headers['Content-Type'] = 'application/json';
    return headers;
  }

  private observeRate(bucket: RateBucket, headers: { get(name: string): string | null }): void {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(remaining)) this.rate[bucket].remaining = remaining;
    if (Number.isFinite(reset)) this.rate[bucket].resetAt = reset;
  }

  private async requestWithHeaders<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    let url = `${this.restBase}${path}`;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs !== '') url += `?${qs}`;
    }

    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: this.headers(opts.body !== undefined),
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new ScmError('network', `Network error reaching ${this.restBase}`, { cause: e });
    }

    this.observeRate('core', res.headers);
    if (!res.ok) {
      throw mapGitHubError(res.status, await readErrorMessage(res), res.headers, this.now());
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    return { data: (await res.json()) as T, headers: res.headers };
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body });
  }

  /**
   * GET every page, following the `Link: rel="next"` header — GitHub's own
   * pagination contract. Bounded by `maxPages` so one pathological repository
   * cannot hammer the instance.
   */
  async getAll<T>(path: string, query?: Query, maxPages = 10): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const { data, headers } = await this.requestWithHeaders<T[]>('GET', path, {
        query: { per_page: 100, ...query, page },
      });
      all.push(...(Array.isArray(data) ? data : []));
      if (!hasNextLink(headers.get('link')) || page >= maxPages) break;
      page += 1;
    }
    return all;
  }

  /** GraphQL — used only where REST cannot do the job. Separate rate bucket. */
  async graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(this.graphqlEndpoint, {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify({ query, variables }),
      });
    } catch (e) {
      throw new ScmError('network', `Network error reaching ${this.graphqlEndpoint}`, { cause: e });
    }
    this.observeRate('graphql', res.headers);
    if (!res.ok) {
      throw mapGitHubError(res.status, await readErrorMessage(res), res.headers, this.now());
    }
    const payload = (await res.json()) as { data?: T; errors?: Array<{ message?: string; type?: string }> };
    if (payload.errors && payload.errors.length > 0) {
      const message = payload.errors.map((e) => e.message ?? 'GraphQL error').join('; ');
      // GraphQL reports authorization failures in the body with HTTP 200.
      if (payload.errors.some((e) => e.type === 'FORBIDDEN' || e.type === 'INSUFFICIENT_SCOPES')) {
        throw new ScmError('insufficientScope', message);
      }
      if (payload.errors.some((e) => e.type === 'NOT_FOUND')) {
        throw new ScmError('notFound', message);
      }
      throw new ScmError('unknown', message);
    }
    if (payload.data === undefined) {
      throw new ScmError('unknown', 'GraphQL response carried no data');
    }
    return payload.data;
  }
}

/** `<...>; rel="next"` anywhere in the Link header means another page exists. */
export function hasNextLink(link: string | null): boolean {
  if (!link) return false;
  return /;\s*rel="?next"?/i.test(link);
}

async function readErrorMessage(res: FetchResponseLike): Promise<string> {
  // Read the body exactly once — with real fetch, a failed json() consumes the
  // stream and a text() fallback would throw "Body is unusable".
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return '';
  }
  try {
    const parsed = JSON.parse(raw) as {
      message?: unknown;
      errors?: Array<string | { message?: unknown; field?: unknown; code?: unknown }>;
    };
    // `errors[]` carries two shapes. Object entries are the documented
    // validation form; POST /pulls/{n}/reviews instead returns bare strings
    // ("Line could not be resolved") under a generic "Unprocessable Entity"
    // message. Dropping the string form loses the only text that says *why* —
    // and the batched-review rejection is exactly that case, so the caller
    // saw an unclassifiable 422 and could not fall back.
    const detail = Array.isArray(parsed.errors)
      ? parsed.errors
          .map((e) => {
            if (typeof e === 'string') return e;
            // Anything else — null included — must not throw: the outer catch
            // would return the raw JSON body as the user-facing message.
            if (typeof e !== 'object' || e === null) return '';
            return [e.field, e.code, e.message].filter((part) => typeof part === 'string').join(' ');
          })
          .filter((part) => part !== '')
          .join('; ')
      : '';
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    return [message, detail].filter((part) => part !== '').join(' — ') || raw;
  } catch {
    return raw;
  }
}

/** GitHub repo ids are `owner/repo`; every REST path is /repos/{owner}/{repo}. */
export function splitRepoId(repoId: string): { owner: string; repo: string } {
  const slash = repoId.indexOf('/');
  if (slash <= 0 || slash === repoId.length - 1) {
    throw new ScmError('notFound', `Not a GitHub repository id: ${repoId}`);
  }
  return { owner: repoId.slice(0, slash), repo: repoId.slice(slash + 1) };
}
