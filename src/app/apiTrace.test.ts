import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setApiTraceSink,
  tracedFetch,
  type ApiTraceSink,
  type TracedResponseLike,
  type TraceableFetch,
} from './apiTrace';

// apiTrace imports nothing from `vscode` — these tests prove that: no
// `vi.mock('vscode', ...)` anywhere in this file, just a plain in-memory sink.
function sink(): ApiTraceSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string): void {
      lines.push(line);
    },
  };
}

function response(status = 200, headers: Record<string, string> = {}): TracedResponseLike {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

/** A fetch that always succeeds, and records what it was called with. */
function okFetch(res: TracedResponseLike = response()): TraceableFetch & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  const impl = (url: string, init?: unknown) => {
    calls.push([url, init]);
    return Promise.resolve(res);
  };
  return Object.assign(impl as TraceableFetch, { calls });
}

// The request id is a module-level counter shared by every wrapper, so tests
// assert its shape and its consistency across a request's two lines — never a
// literal number, which would depend on execution order.
const ID = String.raw`\[\d+\]`;

afterEach(() => {
  setApiTraceSink(undefined);
});

describe('tracedFetch', () => {
  it('logs method, URL and status for a successful call, and returns the response untouched', async () => {
    const s = sink();
    setApiTraceSink(s);
    const res = response(200);

    const result = await tracedFetch(okFetch(res))('https://api.example.test/repos/o/r/items?state=open');

    expect(result).toBe(res);
    expect(s.lines[0]).toMatch(
      new RegExp(`^${ID} start GET https://api\\.example\\.test/repos/o/r/items\\?state=open$`),
    );
    expect(s.lines[1]).toMatch(new RegExp(`^${ID} done in \\d+ms: 200$`));
    // One request, one id: the completion line is attributable to its start.
    expect(s.lines[1]?.split(' ')[0]).toBe(s.lines[0]?.split(' ')[0]);
  });

  it('names the method and reports the request body size', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(201)))('https://api.example.test/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });

    expect(s.lines[0]).toMatch(new RegExp(`^${ID} start POST https://api\\.example\\.test/items body 7 chars$`));
    expect(s.lines[1]).toMatch(/done in \d+ms: 201$/);
  });

  it('logs a non-2xx status as the outcome rather than a failure', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(404)))('https://api.example.test/missing');

    expect(s.lines[1]).toMatch(/done in \d+ms: 404$/);
  });

  it('records elapsed time in ms', async () => {
    vi.useFakeTimers();
    try {
      const s = sink();
      setApiTraceSink(s);
      let settle: ((res: TracedResponseLike) => void) | undefined;
      const inner: TraceableFetch = () => new Promise((resolve) => { settle = resolve; });

      const pending = tracedFetch(inner)('https://api.example.test/slow');
      // Let traceCall reach its await before the clock moves.
      await Promise.resolve();
      vi.advanceTimersByTime(1_500);
      settle?.(response(200));
      await pending;

      expect(s.lines[1]).toMatch(new RegExp(`^${ID} done in 1500ms: 200$`));
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs a network failure with the URL and rethrows the original error', async () => {
    const s = sink();
    setApiTraceSink(s);
    const boom = new TypeError('fetch failed');
    const inner: TraceableFetch = () => Promise.reject(boom);

    await expect(tracedFetch(inner)('https://api.example.test/items')).rejects.toBe(boom);

    expect(s.lines[1]).toMatch(
      new RegExp(`^${ID} failed after \\d+ms: TypeError: fetch failed \\(GET https://api\\.example\\.test/items\\)$`),
    );
  });

  it('never lets an Authorization header reach the sink', async () => {
    const s = sink();
    setApiTraceSink(s);
    const secret = 'SUPER-SECRET-TOKEN-VALUE';

    await tracedFetch(okFetch())('https://api.example.test/items', {
      method: 'GET',
      headers: { Authorization: `Bearer ${secret}`, 'PRIVATE-TOKEN': secret },
    });
    // …and on the failing path too, which builds its own line.
    const inner: TraceableFetch = () => Promise.reject(new Error('nope'));
    await expect(
      tracedFetch(inner)('https://api.example.test/items', {
        headers: { Authorization: `Bearer ${secret}` },
      }),
    ).rejects.toThrow('nope');

    expect(s.lines).toHaveLength(4);
    for (const line of s.lines) {
      expect(line).not.toContain(secret);
      expect(line.toLowerCase()).not.toContain('authorization');
      expect(line).not.toContain('Bearer');
    }
  });

  it('redacts any token-bearing query parameter, on both the start and failure lines', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())(
      'https://host.example.test/api/v4/projects/1?private_token=SECRET1&state=open&access_token=SECRET2&token=SECRET3',
    );
    const inner: TraceableFetch = () => Promise.reject(new Error('down'));
    await expect(tracedFetch(inner)('https://host.example.test/api/v4/x?token=SECRET4')).rejects.toThrow('down');

    expect(s.lines[0]).toContain(
      'https://host.example.test/api/v4/projects/1?private_token=REDACTED&state=open&access_token=REDACTED&token=REDACTED',
    );
    expect(s.lines[2]).toContain('https://host.example.test/api/v4/x?token=REDACTED');
    for (const line of s.lines) expect(line).not.toMatch(/SECRET\d/);
  });

  it('redacts a token the error message itself quotes back, not just the URL argument', async () => {
    const s = sink();
    setApiTraceSink(s);
    // Runtimes echo the request into the message — undici's "Failed to parse
    // URL from <url>" is the common one — so the failure line has a second way
    // to carry a credential that redacting `safeUrl` alone does not close.
    const inner: TraceableFetch = () =>
      Promise.reject(new TypeError('Failed to parse URL from https://host.example.test/api/v4/x?private_token=SECRET5'));

    await expect(tracedFetch(inner)('https://host.example.test/api/v4/x')).rejects.toThrow(TypeError);

    expect(s.lines[1]).toContain('Failed to parse URL from https://host.example.test/api/v4/x?private_token=REDACTED');
    for (const line of s.lines) expect(line).not.toContain('SECRET5');
  });

  it('names the GraphQL operation, preferring operationName over the document', async () => {
    const s = sink();
    setApiTraceSink(s);
    const post = (body: string) =>
      tracedFetch(okFetch())('https://api.example.test/graphql', { method: 'POST', body });

    await post(JSON.stringify({ operationName: 'ResolveThread', query: 'mutation Other { x }' }));
    await post(JSON.stringify({ query: 'query ThreadsForItem($id: ID!) { node(id: $id) { id } }' }));

    expect(s.lines[0]).toContain('start POST https://api.example.test/graphql op=ResolveThread');
    expect(s.lines[2]).toContain('start POST https://api.example.test/graphql op=ThreadsForItem');
  });

  it('never throws on a body that is not a GraphQL document, and names no operation for a REST POST', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())('https://api.example.test/graphql', { method: 'POST', body: 'not json{' });
    // A REST path is never parsed, even when the body happens to carry a `query`.
    await tracedFetch(okFetch())('https://api.example.test/items?graphql=1', {
      method: 'POST',
      body: JSON.stringify({ query: 'query Nope { x }' }),
    });

    expect(s.lines[0]).not.toContain('op=');
    expect(s.lines[2]).not.toContain('op=');
  });

  it('reports the rate-limit headers when the host sends them, and stays silent when it does not', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(
      okFetch(response(200, { 'x-ratelimit-remaining': '4987', 'x-ratelimit-reset': '1756140000' })),
    )('https://api.example.test/items');
    await tracedFetch(okFetch(response(200)))('https://api.example.test/items');

    expect(s.lines[1]).toMatch(/done in \d+ms: 200 rate remaining=4987 reset=1756140000$/);
    expect(s.lines[3]).toMatch(/done in \d+ms: 200$/);
  });

  it('is a pass-through with no sink set: same promise, same value, nothing logged', async () => {
    const s = sink();
    const res = response(200);
    const inner = Promise.resolve(res);
    const calls: string[] = [];
    const wrapped = tracedFetch((url: string) => {
      calls.push(url);
      return inner;
    });

    // The caller's own promise, not a re-wrapped one — with tracing off the
    // wrapper adds nothing at all.
    const pending = wrapped('https://api.example.test/items');
    expect(pending).toBe(inner);
    expect(await pending).toBe(res);
    expect(calls).toEqual(['https://api.example.test/items']);
    expect(s.lines).toEqual([]);
  });

  it('still rethrows the original error with no sink set', async () => {
    const boom = new Error('offline');
    const inner: TraceableFetch = () => Promise.reject(boom);
    await expect(tracedFetch(inner)('https://api.example.test/items')).rejects.toBe(boom);
  });

  it('survives a sink that throws, on every line it writes', async () => {
    setApiTraceSink({
      appendLine(): void {
        throw new Error('output channel disposed');
      },
    });
    const res = response(200);

    expect(await tracedFetch(okFetch(res))('https://api.example.test/items')).toBe(res);

    const boom = new Error('fetch failed');
    const inner: TraceableFetch = () => Promise.reject(boom);
    await expect(tracedFetch(inner)('https://api.example.test/items')).rejects.toBe(boom);
  });

  it('passes the caller through unchanged: same url and init reach the inner fetch', async () => {
    setApiTraceSink(sink());
    const inner = okFetch();
    const init = { method: 'PATCH', headers: { Authorization: 'Bearer x' }, body: '{"b":2}' };

    await tracedFetch(inner)('https://api.example.test/items/1', init);

    expect(inner.calls).toEqual([['https://api.example.test/items/1', init]]);
  });

  it('never reads the response body — the clients may only read it once', async () => {
    setApiTraceSink(sink());
    const json = vi.fn();
    const text = vi.fn();
    const res = { ...response(200), json, text } as unknown as TracedResponseLike;

    await tracedFetch(okFetch(res))('https://api.example.test/items');

    expect(json).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('gives concurrent requests distinct ids', async () => {
    const s = sink();
    setApiTraceSink(s);
    const wrapped = tracedFetch(okFetch());

    await Promise.all([wrapped('https://api.example.test/a'), wrapped('https://api.example.test/b')]);

    const ids = s.lines.map((line) => line.split(' ')[0]);
    expect(new Set(ids).size).toBe(2);
  });
});
