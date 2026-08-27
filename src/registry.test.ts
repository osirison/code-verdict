import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerBuiltInProviders } from './registry';
import { getProvider } from './platform/registry';
import { setApiTraceSink, type ApiTraceSink } from './app/apiTrace';

/**
 * What `apiTrace.test.ts` cannot prove: that the registered providers are
 * actually built over the traced fetch. A revert to the modules' untraced
 * singletons breaks nothing else in the suite — it just silently stops
 * tracing, which is the failure this file exists to catch.
 */

// `registerBuiltInProviders` reads the global `fetch` when it builds the
// providers, so the stub has to be in place before it runs — hence module
// scope, and a mutable handler each test points where it needs to.
let handler: (url: string, init?: { headers?: Record<string, string> }) => Promise<unknown> = () =>
  Promise.reject(new Error('no handler'));
vi.stubGlobal('fetch', (url: string, init?: { headers?: Record<string, string> }) => handler(url, init));
registerBuiltInProviders();

function reply(body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: (name: string) => headers[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function sink(): ApiTraceSink & { lines: string[] } {
  const lines: string[] = [];
  return { lines, appendLine: (line) => void lines.push(line) };
}

const TOKEN = 'SECRET-PAT-VALUE';

afterEach(() => {
  setApiTraceSink(undefined);
});

describe('registerBuiltInProviders', () => {
  it('traces the calls a token-authenticated connection makes, without logging the token', async () => {
    const s = sink();
    setApiTraceSink(s);
    handler = (url) => reply(url.endsWith('/user') ? { id: 1, username: 'u' } : { scopes: ['api'] });

    const status = await getProvider('gitlab')
      .connect({ instanceUrl: 'https://gl.example.test', credential: { kind: 'token', token: TOKEN } })
      .testConnection();

    expect(status.ok).toBe(true);
    expect(s.lines[0]).toMatch(/^\[\d+\] start GET https:\/\/gl\.example\.test\/api\/v4\/user$/);
    expect(s.lines[1]).toMatch(/^\[\d+\] done in \d+ms: 200$/);
    // The Authorization header carries the token on every one of these calls.
    for (const line of s.lines) expect(line).not.toContain(TOKEN);
  });

  it('reports the rate-limit headers a host sends, read off the response and not from any provider', async () => {
    const s = sink();
    setApiTraceSink(s);
    handler = () => reply({ login: 'octo' }, { 'x-ratelimit-remaining': '4987', 'x-ratelimit-reset': '1756140000' });

    await getProvider('github')
      .connect({ instanceUrl: 'https://github.example.test', credential: { kind: 'token', token: TOKEN } })
      .testConnection();

    expect(s.lines[0]).toMatch(/start GET https:\/\/github\.example\.test\/api\/v3\/user$/);
    expect(s.lines[1]).toMatch(/done in \d+ms: 200 rate remaining=4987 reset=1756140000$/);
  });

  it('writes nothing when no sink is set — the default state of every install', async () => {
    const s = sink();
    handler = () => reply({ login: 'octo' });

    const status = await getProvider('github')
      .connect({ instanceUrl: 'https://github.example.test', credential: { kind: 'token', token: TOKEN } })
      .testConnection();

    expect(status).toEqual({ ok: true, username: 'octo' });
    expect(s.lines).toEqual([]);
  });
});
