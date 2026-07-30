/**
 * In-process adapter: exposes a GitLabEmulator as a fetch-shaped function
 * (structurally compatible with the GitLab provider's injectable FetchLike)
 * so tests run against the emulator with no sockets.
 */
import type { EmResponse, GitLabEmulator } from './engine';

export interface EmulatorFetchResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type EmulatorFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<EmulatorFetchResponse>;

function toResponse(res: EmResponse): EmulatorFetchResponse {
  const headers = Object.fromEntries(
    Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const text = JSON.stringify(res.body);
  return {
    ok: res.status < 400,
    status: res.status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  };
}

export function emulatorFetch(emulator: GitLabEmulator): EmulatorFetch {
  return async (url, init = {}) =>
    toResponse(
      emulator.handle({
        method: init.method ?? 'GET',
        url,
        headers: init.headers ?? {},
        body: init.body,
      }),
    );
}
