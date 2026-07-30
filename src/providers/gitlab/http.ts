import { ScmError } from '../../platform/errors';
import { mapGitLabError } from './errors';

/** Structural subset of fetch so tests can inject a fake. */
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

/** Thin REST v4 client: auth header, query building, error normalization. */
export class GitLabHttp {
  private readonly baseUrl: string;

  constructor(
    instanceUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.baseUrl = instanceUrl.replace(/\/+$/, '');
  }

  async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, opts)).data;
  }

  private async requestWithHeaders<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    opts: { query?: Query; body?: unknown } = {},
  ): Promise<{ data: T; headers: { get(name: string): string | null } }> {
    let url = `${this.baseUrl}/api/v4${path}`;
    if (opts.query) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) params.set(key, String(value));
      }
      const qs = params.toString();
      if (qs !== '') url += `?${qs}`;
    }

    const headers: Record<string, string> = { 'PRIVATE-TOKEN': this.token };
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }

    let res: FetchResponseLike;
    try {
      res = await this.fetchImpl(url, { method, headers, body });
    } catch (e) {
      throw new ScmError('network', `Network error reaching ${this.baseUrl}`, { cause: e });
    }

    if (!res.ok) {
      throw mapGitLabError(res.status, await readErrorMessage(res), res.headers);
    }
    if (res.status === 204) return { data: undefined as T, headers: res.headers };
    return { data: (await res.json()) as T, headers: res.headers };
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
  }

  /**
   * GET every page of a list endpoint, following `x-next-page`. Bounded by
   * `maxPages` so one pathological group cannot hammer the instance.
   */
  async getAll<T>(path: string, query?: Query, maxPages = 10): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    for (;;) {
      const { data, headers } = await this.requestWithHeaders<T[]>('GET', path, {
        query: { per_page: 100, ...query, page },
      });
      all.push(...data);
      const next = Number(headers.get('x-next-page'));
      if (!Number.isInteger(next) || next <= page || next > maxPages) break;
      page = next;
    }
    return all;
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, { body });
  }

  put<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('PUT', path, { body, query });
  }
}

async function readErrorMessage(res: FetchResponseLike): Promise<string> {
  try {
    const parsed = (await res.json()) as { message?: unknown; error?: unknown };
    if (typeof parsed.message === 'string') return parsed.message;
    if (typeof parsed.error === 'string') return parsed.error;
    return JSON.stringify(parsed);
  } catch {
    try {
      return await res.text();
    } catch {
      return '';
    }
  }
}

/** GitLab accepts numeric ids or URL-encoded full paths interchangeably. */
export function encodeRepoId(idOrPath: string): string {
  return /^\d+$/.test(idOrPath) ? idOrPath : encodeURIComponent(idOrPath);
}
