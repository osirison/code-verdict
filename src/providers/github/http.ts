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
 * mispredicts the other. The tracking is now acted on: a bucket down to its
 * floor refuses the next request outright instead of spending the remainder
 * and collecting a 403 for it. See `RATE_FLOORS` and `RateBudget`.
 *
 * Every REST GET is conditional. GitHub does not charge a 304 against the
 * primary limit when the request carried an Authorization header, which every
 * request here does, so a poll that finds nothing changed costs nothing. The
 * exemption really is authorization-gated: five *unauthenticated* conditional
 * GETs of the same list against api.github.com on 2026-08-26 took
 * `x-ratelimit-used` from 1 to 5, one per 304.
 */
import { ScmError } from '../../platform/errors';
import type { ConnectionIntent } from '../../platform/provider';
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

/**
 * How much of a bucket must still be standing for a request to be sent.
 *
 * Background polling stops with a reserve intact so that an action the user is
 * waiting on still has somewhere to spend. 50 is sized off the interactive
 * flows: opening a change request is the pull, its files (one page normally,
 * ten at the `getAll` ceiling) and one threads query — 12 requests worst case
 * — and submitting a review is one POST, or one per comment on the
 * comment-by-comment fallback. 50 therefore covers two or three whole flows,
 * and it is 1% of the 5,000/hour authenticated budget, so what the poll gives
 * up for it is a rounding error.
 *
 * Interactive stops at 5 rather than 0 because `remaining` is read from the
 * previous response: between that reading and the next request the same token
 * may have been spent by another window, another editor or the CLI. Five
 * absorbs that skew, and a refusal already shaped as `rateLimited` is a better
 * answer than a 403 that has to be classified back into one.
 */
export const RATE_FLOORS: Record<ConnectionIntent, number> = {
  background: 50,
  interactive: 5,
};

/**
 * What each rate bucket last reported, per account, shared across every
 * connection one provider hands out.
 *
 * Shared for the same reason `EtagCache` is: `connectionForPod` builds a fresh
 * `Connection` for every poll, so anything the client owns is forgotten every
 * 60 seconds — and a budget the client forgets is a budget nothing can stop
 * short of. That is exactly what `rateState` was before this: parsed on every
 * response, read by nobody, and thrown away one poll later.
 *
 * Keyed by account because one provider serves every pod on every host it
 * knows: two tokens on github.com hold independent budgets, and one of them
 * running out must not stop the other. Split by bucket because `core` and
 * `graphql` are independent counters — a client tracking one number
 * mispredicts the other.
 */
export class RateBudget {
  private readonly accounts = new Map<string, Record<RateBucket, RateState>>();

  private states(account: string): Record<RateBucket, RateState> {
    const existing = this.accounts.get(account);
    if (existing !== undefined) return existing;
    const fresh: Record<RateBucket, RateState> = { core: {}, graphql: {} };
    this.accounts.set(account, fresh);
    return fresh;
  }

  /**
   * Record what a response said about its bucket. A header that is absent
   * leaves the previous reading alone: `Number(null)` is 0, so parsing
   * unconditionally would read every header-less response — a 204, an error
   * page, a proxy that strips them — as "nothing left".
   */
  observe(account: string, bucket: RateBucket, headers: { get(name: string): string | null }): void {
    const state = this.states(account)[bucket];
    const remaining = numericHeader(headers, 'x-ratelimit-remaining');
    const reset = numericHeader(headers, 'x-ratelimit-reset');
    if (remaining !== undefined) state.remaining = remaining;
    if (reset !== undefined) state.resetAt = reset;
  }

  state(account: string, bucket: RateBucket): RateState {
    return { ...this.states(account)[bucket] };
  }

  /**
   * Seconds until this bucket's window reopens, when the floor is reached and
   * the window is still shut; `undefined` means send the request.
   *
   * Both halves of the reading must be known. A remaining count with no reset
   * cannot answer "when should I try again?", and a refusal that cannot say
   * when is worse for the caller than one wasted request.
   */
  secondsUntilReset(
    account: string,
    bucket: RateBucket,
    floor: number,
    nowMs: number,
  ): number | undefined {
    const state = this.accounts.get(account)?.[bucket];
    if (state === undefined) return undefined;
    if (state.remaining === undefined || state.resetAt === undefined) return undefined;
    const seconds = Math.ceil(state.resetAt - nowMs / 1000);
    if (seconds <= 0) {
      // The window rolled over. Forget the reading rather than keep refusing
      // against a count that describes a window which no longer exists — the
      // first response through will supply the new one.
      state.remaining = undefined;
      state.resetAt = undefined;
      return undefined;
    }
    return state.remaining > floor ? undefined : seconds;
  }
}

function numericHeader(headers: { get(name: string): string | null }, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
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

/**
 * One remembered GET response, kept because a 304 has no body of its own.
 *
 * The body is the raw response text, re-parsed on every hit rather than stored
 * parsed: `res.json()` hands each caller its own object graph today, and
 * replaying one shared object would let a caller that mutates a row corrupt
 * every later poll.
 */
export interface EtagEntry {
  /** Replayed verbatim — GitHub's validators are weak, `W/"…"`, quotes included. */
  etag: string;
  body: string;
  /** `link` as the 200 carried it. See `replayHeaders`. */
  link: string | null;
}

/**
 * Validators for conditional GETs, bounded, and shared across the connections
 * one provider hands out.
 *
 * Eviction is least-recently-used, because the access pattern is a 60s poll
 * over a fixed set of list URLs with occasional one-off browse requests
 * (a pull request's files, a repository lookup) around them: LRU keeps the
 * poll resident and lets the one-offs age out.
 *
 * The bounds are 512 entries, 1 MiB per entry and 8 MiB in total. The entry
 * count has to clear a whole poll's URL set, because LRU over a cyclic pattern
 * that does not fit degrades to no hits at all — the one way this cache could
 * cost more than it saves — and the set is not 3 per repository but 3 *lists*,
 * each of which `getAll` walks to 10 pages. A 30-repository pod whose lists run
 * two pages already touches 150 URLs, and 128 turned every one of its polls
 * back into a full-price poll while looking like it was working. 512 covers
 * that pod and a 10-repository one several times over.
 *
 * The byte cap is the bound that still binds, and it is left where it is: a
 * `/pulls?per_page=100` page of real pull requests runs to a few hundred KB
 * because each item embeds its head and base repository, so 8 MiB holds a few
 * dozen of them, not 512. A pod both wide and deep enough to exceed that still
 * thrashes, and the answer for it is the shared-fetch redesign rather than
 * tens of megabytes of retained response text in the extension host. A single
 * response over the per-entry cap is left uncached rather than allowed to own
 * an eighth of the total; it keeps paying full price, which is only ever one
 * request.
 */
export class EtagCache {
  /** Map iterates in insertion order, so the first key is the least recent. */
  private readonly entries = new Map<string, EtagEntry>();
  private chars = 0;

  constructor(
    private readonly maxEntries = 512,
    private readonly maxEntryChars = 1024 * 1024,
    private readonly maxTotalChars = 8 * 1024 * 1024,
  ) {}

  get(key: string): EtagEntry | undefined {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, entry: EtagEntry): void {
    this.delete(key);
    if (entry.body.length > this.maxEntryChars) return;
    this.entries.set(key, entry);
    this.chars += entry.body.length;
    while (this.entries.size > this.maxEntries || this.chars > this.maxTotalChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true || oldest.value === undefined) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.chars -= entry.body.length;
    this.entries.delete(key);
  }

  /**
   * Drops every entry. Nothing in the app calls it; the eviction race is what
   * exercises it — a 304 whose entry vanished while the request was in flight
   * cannot be forced any other way.
   */
  clear(): void {
    this.entries.clear();
    this.chars = 0;
  }

  get size(): number {
    return this.entries.size;
  }
}

export class GitHubHttp {
  private readonly restBase: string;
  private readonly graphqlEndpoint: string;
  private readonly budget: RateBudget;
  /** The account this client spends against — see `RateBudget`. */
  private readonly account: string;
  private readonly floor: number;

  constructor(
    instanceUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly now: () => number = Date.now,
    /**
     * Shared by every connection one provider hands out — see
     * `createGitHubProvider`. Defaulted so a client built directly still makes
     * conditional requests, with a cache of its own.
     */
    private readonly etags: EtagCache = new EtagCache(),
    /**
     * `budget` is shared the same way and for the same reason; `intent` is what
     * the caller asked for, and decides which floor this client stops at.
     */
    opts: { budget?: RateBudget; intent?: ConnectionIntent } = {},
  ) {
    this.restBase = restBaseUrl(instanceUrl);
    this.graphqlEndpoint = graphqlUrl(instanceUrl);
    this.budget = opts.budget ?? new RateBudget();
    this.account = `${token}\n${this.restBase}`;
    this.floor = RATE_FLOORS[opts.intent ?? 'interactive'];
  }

  /** What the client last saw for a bucket — separate counters, by design. */
  rateState(bucket: RateBucket): RateState {
    return this.budget.state(this.account, bucket);
  }

  /**
   * Refuse before spending, when this bucket is down to its floor and the
   * window has not reopened.
   *
   * The last few requests are worth more unspent than spent: driving into the
   * wall costs them *and* gets a 403, while stopping short leaves the reserve
   * for whatever the user does next. The error is the same `rateLimited` the
   * 403 would have produced, carrying the same reset, so nothing above the
   * provider can tell the two apart — nor should it.
   *
   * Deliberate: a conditional GET at the floor might have come back 304 and
   * cost nothing. Nothing can know that before sending it, and spending the
   * reserve on that guess is what this exists to stop.
   */
  private guard(bucket: RateBucket): void {
    const seconds = this.budget.secondsUntilReset(this.account, bucket, this.floor, this.now());
    if (seconds === undefined) return;
    throw new ScmError(
      'rateLimited',
      `GitHub's ${bucket} rate limit is down to its last ${this.floor} requests, which Verdict holds`
      + ` back as reserve. The window resets in ${seconds}s.`,
      { retryAfterSeconds: seconds },
    );
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
    this.budget.observe(this.account, bucket, headers);
  }

  /**
   * The URL a validator is remembered under. The query string is part of it:
   * `?state=open&page=2` is a different resource from `?state=open&page=1`, and
   * one etag serving both would replay page 1's rows as page 2.
   */
  private urlFor(path: string, query?: Query): string {
    let url = `${this.restBase}${path}`;
    if (query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs !== '') url += `?${qs}`;
    }
    return url;
  }

  /**
   * The token is part of the key, not just the URL: one provider serves every
   * pod on a host, so two accounts on github.com share this cache, and one
   * account's remembered body must never be replayed as the other's answer.
   */
  private cacheKey(url: string): string {
    return `${this.token}\n${url}`;
  }

  private async send(
    url: string,
    method: string,
    opts: { body?: unknown },
    ifNoneMatch: string | undefined,
  ): Promise<FetchResponseLike> {
    const headers = this.headers(opts.body !== undefined);
    // GET only, enforced where the header is written rather than only where the
    // validator is looked up. GitHub does not support conditional requests on
    // unsafe methods, and on those a validator is a *precondition*: a server
    // honouring it would refuse the write rather than skip a body.
    if (ifNoneMatch !== undefined && method === 'GET') headers['If-None-Match'] = ifNoneMatch;
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      throw new ScmError('network', `Network error reaching ${this.restBase}`, { cause: e });
    }
  }

  private remember(key: string, res: FetchResponseLike, raw: string): void {
    const etag = res.headers.get('etag');
    // A 200 carrying no validator retires the one we held. Keeping it would
    // mean sending an etag this resource no longer answers to, for as long as
    // the process lives — a header that can only ever cost a request.
    if (etag === null || etag === '') {
      this.etags.delete(key);
      return;
    }
    this.etags.set(key, { etag, body: raw, link: res.headers.get('link') });
  }

  private async requestWithHeaders<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    this.guard('core');
    const url = this.urlFor(path, opts.query);
    const key = this.cacheKey(url);
    const remembered = method === 'GET' ? this.etags.get(key) : undefined;

    let res = await this.send(url, method, opts, remembered?.etag);
    // Before the status is judged: a 304 reports the budget as truthfully as a
    // 200 does, and it is the response this client expects to see most often.
    this.observeRate('core', res.headers);

    if (res.status === 304) {
      // Still GET-gated: a write answering 304 must not be handed the body a
      // GET of the same URL left behind.
      const entry = method === 'GET' ? this.etags.get(key) : undefined;
      if (entry !== undefined) {
        return { data: JSON.parse(entry.body) as T, headers: replayHeaders(res.headers, entry) };
      }
      // A 304 has no body of its own, and the entry it refers to can be gone:
      // another request sharing this cache can evict it while this one is in
      // flight. Returning here would hand the dashboard `undefined` and empty
      // it — far worse than one wasted request. Ask again without the
      // validator, once; an unconditional GET cannot 304 for a reason we put
      // there, and a server that answers one anyway falls through to the error
      // path below rather than looping.
      res = await this.send(url, method, opts, undefined);
      this.observeRate('core', res.headers);
    }

    if (!res.ok) {
      throw mapGitHubError(res.status, await readErrorMessage(res), res.headers, this.now());
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    // Read as text and parse here rather than through `res.json()`: a real
    // Response body can be read once, and the raw text is exactly what a later
    // 304 has to replay.
    const raw = await res.text();
    if (method === 'GET') this.remember(key, res, raw);
    return { data: JSON.parse(raw) as T, headers: res.headers };
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
    this.guard('graphql');
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

/**
 * Headers for a replayed 304. Live first: the 304's own `x-ratelimit-*` are the
 * truth about the budget. `link` falls back to the 200's, because `getAll`
 * decides whether another page exists from exactly that header —
 * api.github.com does repeat `link` on a 304 (captured 2026-08-26), but a GHES
 * release or a proxy that dropped it would silently truncate every paginated
 * list to its first page, and nothing would look wrong.
 */
function replayHeaders(
  live: { get(name: string): string | null },
  entry: EtagEntry,
): { get(name: string): string | null } {
  return {
    get(name: string): string | null {
      const value = live.get(name);
      if (value !== null) return value;
      return name.toLowerCase() === 'link' ? entry.link : null;
    },
  };
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
