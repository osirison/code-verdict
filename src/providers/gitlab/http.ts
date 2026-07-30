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
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, { query });
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
