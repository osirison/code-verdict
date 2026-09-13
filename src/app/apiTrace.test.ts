import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setApiTraceSink,
  tracedFetch,
  type ApiTraceSink,
  type TracedResponseLike,
  type TraceableFetch,
} from './apiTrace';
import { clearRegisteredSecretValues, registerSecretValue } from './harnessActivitySanitizer';

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

/** `clone` is omitted by default — most tests here have no interest in a response-body line, and
 * a double with no `clone` produces none (see `apiTrace.ts`'s own `TracedResponseLike` comment).
 * Pass `body` to opt into one, with an independent `clone().text()` so a test can also assert the
 * original object's own `text`/`json` (if it has any) are never touched. */
function response(status = 200, headers: Record<string, string> = {}, body?: string): TracedResponseLike {
  const base: TracedResponseLike = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
  if (body === undefined) return base;
  return { ...base, clone: () => ({ text: async () => body }) };
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
// assert its shape and its consistency across a request's lines — never a
// literal number, which would depend on execution order.
const ID = String.raw`\[\d+\]`;
// Every line's own leading local time-of-day, `HH:MM:SS.mmm` — asserted by shape only. The exact
// digits depend on the runner's clock (and, unless a fixed `now` is injected, its time zone), so a
// test must never assert them literally; see the "the clock is injected" tests below for that.
const TIME = String.raw`\d{2}:\d{2}:\d{2}\.\d{3}`;

/** The `[id]` token off any line this module writes, for tests spanning more than one request. */
function idOf(line: string | undefined): string | undefined {
  return line?.match(/\[\d+\]/)?.[0];
}

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
      new RegExp(`^${TIME} ${ID} start GET https://api\\.example\\.test/repos/o/r/items\\?state=open$`),
    );
    expect(s.lines[1]).toMatch(new RegExp(`^${TIME} ${ID} done in \\d+ms: 200$`));
    // One request, one id: the completion line is attributable to its start.
    expect(idOf(s.lines[1])).toBe(idOf(s.lines[0]));
  });

  it('every line starts with a local time-of-day, milliseconds included, not an elapsed count', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())('https://api.example.test/items');

    expect(s.lines.length).toBeGreaterThan(0);
    for (const line of s.lines) expect(line).toMatch(new RegExp(`^${TIME} `));
  });

  it('the clock is injected: an injected `now` drives the leading time-of-day, not a bare Date.now() read', async () => {
    const s = sink();
    setApiTraceSink(s);
    // A fixed instant, unrelated to the runner's own clock or time zone — 09:05:03.007 local.
    const fixed = new Date();
    fixed.setHours(9, 5, 3, 7);
    const now = () => fixed.getTime();

    await tracedFetch(okFetch(), now)('https://api.example.test/items');

    expect(s.lines[0]).toMatch(new RegExp(`^09:05:03\\.007 ${ID} start`));
    expect(s.lines[1]).toMatch(new RegExp(`^09:05:03\\.007 ${ID} done`));
  });

  it('names the method and shows the full request body, not just its size', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(201)))('https://api.example.test/items', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });

    expect(s.lines[0]).toMatch(new RegExp(`^${TIME} ${ID} start POST https://api\\.example\\.test/items$`));
    expect(s.lines[1]).toMatch(new RegExp(`^${TIME} ${ID} request body \\(7 bytes\\): \\{"a":1\\}$`));
    expect(s.lines[2]).toMatch(/done in \d+ms: 201$/);
  });

  it('shows the full response body alongside the status', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(200, {}, '{"items":[1,2,3]}')))('https://api.example.test/items');

    const bodyLine = s.lines.find((l) => l.includes('response body'));
    expect(bodyLine).toMatch(new RegExp(`^${TIME} ${ID} response body \\(17 bytes\\): \\{"items":\\[1,2,3]}$`));
  });

  it('logs the response body for a non-2xx status too — the error detail is usually in there', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(422, {}, '{"message":"Validation failed"}')))('https://api.example.test/items');

    const bodyLine = s.lines.find((l) => l.includes('response body'));
    expect(bodyLine).toContain('{"message":"Validation failed"}');
  });

  it('reads the response body through a clone, never the original — the real caller can still read it once', async () => {
    const s = sink();
    setApiTraceSink(s);
    const cloneText = vi.fn(async () => '{"ok":true}');
    const originalText = vi.fn();
    const originalJson = vi.fn();
    const res = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      clone: () => ({ text: cloneText }),
      text: originalText,
      json: originalJson,
    } as unknown as TracedResponseLike;

    await tracedFetch(okFetch(res))('https://api.example.test/items');

    expect(cloneText).toHaveBeenCalledTimes(1);
    expect(originalText).not.toHaveBeenCalled();
    expect(originalJson).not.toHaveBeenCalled();
    expect(s.lines.some((l) => l.includes('{"ok":true}'))).toBe(true);
  });

  it('a clone that fails to read still gets a line, redacted like every other failure message this module writes', async () => {
    const s = sink();
    setApiTraceSink(s);
    const res: TracedResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      clone: () => ({
        text: async () => {
          throw new TypeError('Failed to parse URL from https://api.example.test/x?private_token=SECRET9');
        },
      }),
    };

    await tracedFetch(okFetch(res))('https://api.example.test/items');

    const bodyLine = s.lines.find((l) => l.includes('response body could not be read'));
    expect(bodyLine).toBeDefined();
    expect(bodyLine).not.toContain('SECRET9');
    expect(bodyLine).toContain('private_token=REDACTED');
  });

  it('a response with no clone() gets no response-body line, never a thrown error', async () => {
    const s = sink();
    setApiTraceSink(s);

    await expect(tracedFetch(okFetch(response(200)))('https://api.example.test/items')).resolves.toBeDefined();

    expect(s.lines.some((l) => l.includes('response body'))).toBe(false);
  });

  it('a body over the cap is written in full up to the cap, then plainly states the omitted byte count — never a silent cut', async () => {
    const s = sink();
    setApiTraceSink(s);
    const big = 'x'.repeat(150_000);

    await tracedFetch(okFetch(response(200, {}, big)))('https://api.example.test/items');

    const bodyLine = s.lines.find((l) => l.includes('response body')) as string;
    expect(bodyLine).toContain('x'.repeat(100_000));
    expect(bodyLine).not.toContain('x'.repeat(100_001));
    expect(bodyLine).toContain('50000 more byte(s) omitted');
    expect(bodyLine).toContain('150000 bytes total');
  });

  it('redacts a secret embedded in the response body, not only the URL', async () => {
    const s = sink();
    setApiTraceSink(s);
    const secret = 'ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    await tracedFetch(okFetch(response(200, {}, `{"token":"${secret}"}`)))('https://api.example.test/items');

    for (const line of s.lines) expect(line).not.toContain(secret);
    expect(s.lines.some((l) => l.includes('[REDACTED]'))).toBe(true);
  });

  it('redacts a secret embedded in the request body', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())('https://api.example.test/items', {
      method: 'POST',
      body: 'Authorization: Bearer sk-live-SECRETSECRETSECRET1234567890',
    });

    for (const line of s.lines) {
      expect(line).not.toContain('SECRETSECRETSECRET1234567890');
      expect(line).not.toContain('Bearer');
    }
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

      expect(s.lines[1]).toMatch(new RegExp(`^${TIME} ${ID} done in 1500ms: 200$`));
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
      new RegExp(`^${TIME} ${ID} failed after \\d+ms: TypeError: fetch failed \\(GET https://api\\.example\\.test/items\\)$`),
    );
  });

  it('never lets an Authorization or PRIVATE-TOKEN header reach the sink — headers are never printed at all', async () => {
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

    const startLines = s.lines.filter((l) => l.includes(' start '));
    expect(startLines[0]).toContain('start POST https://api.example.test/graphql op=ResolveThread');
    expect(startLines[1]).toContain('start POST https://api.example.test/graphql op=ThreadsForItem');
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

    const startLines = s.lines.filter((l) => l.includes(' start '));
    expect(startLines).toHaveLength(2);
    expect(startLines[0]).not.toContain('op=');
    expect(startLines[1]).not.toContain('op=');
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

  it('survives a sink that throws even while tracing a response body', async () => {
    setApiTraceSink({
      appendLine(): void {
        throw new Error('output channel disposed');
      },
    });

    await expect(
      tracedFetch(okFetch(response(200, {}, '{"a":1}')))('https://api.example.test/items'),
    ).resolves.toBeDefined();
  });

  it('passes the caller through unchanged: same url and init reach the inner fetch', async () => {
    setApiTraceSink(sink());
    const inner = okFetch();
    const init = { method: 'PATCH', headers: { Authorization: 'Bearer x' }, body: '{"b":2}' };

    await tracedFetch(inner)('https://api.example.test/items/1', init);

    expect(inner.calls).toEqual([['https://api.example.test/items/1', init]]);
  });

  it('never reads the original response body when there is no clone() — the client may only read it once', async () => {
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

    const ids = s.lines.map((line) => idOf(line));
    expect(new Set(ids).size).toBe(2);
  });
});

/**
 * The channel the reported leak actually arrived through, and the one this module's body tracing
 * exists for. `codeVerdict.trace.api` writes whole request and response bodies, so a JSON body is
 * exactly the shape a credential reaches this sink in.
 *
 * Worth stating why these are not already covered above: the existing response-body test uses
 * `ghp_aaaa…`, which the GitHub-PAT standalone pattern recognises on sight. It passed no matter
 * what the key around it looked like, so it proved the standalone pattern worked and said nothing
 * at all about the quoted JSON key it was written in. The secrets below are deliberately opaque —
 * no prefix, no scheme word, nothing any standalone pattern knows — so the only thing that can
 * redact them is the key they sit under, or the fact that the host holds them.
 */
describe('tracedFetch: a credential in a JSON body', () => {
  const OPAQUE = 'Zk3mQp7xTv2rLw8sNb4c';

  afterEach(clearRegisteredSecretValues);

  it('redacts an opaque secret under a quoted JSON key in a response body', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch(response(200, {}, `{"data":{"apiKey":"${OPAQUE}","id":7}}`)))(
      'https://api.example.test/items',
    );

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    expect(s.lines.some((line) => line.includes('response body') && line.includes('[REDACTED]'))).toBe(true);
    // The rest of the body is still there: redaction, not suppression.
    expect(s.lines.find((line) => line.includes('response body'))).toContain('"id":7');
  });

  it('redacts an opaque secret under a quoted JSON key in a request body', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())('https://api.example.test/items', {
      method: 'POST',
      body: JSON.stringify({ query: 'mutation X { y }', variables: { refresh_token: OPAQUE } }),
    });

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    expect(s.lines.some((line) => line.includes('request body') && line.includes('[REDACTED]'))).toBe(true);
  });

  // The layer that does not depend on the body's shape at all: this value sits under a key nothing
  // would flag, in a body nothing would suspect, and it is removed because the host holds it.
  it('redacts a credential the host registered, wherever in the body it appears', async () => {
    const s = sink();
    setApiTraceSink(s);
    const held = 'held-credential-for-the-api-trace-9f3e';
    registerSecretValue(held);

    await tracedFetch(okFetch(response(200, {}, `{"note":"issued for ${held}","id":3}`)))(
      'https://api.example.test/items',
    );

    for (const line of s.lines) expect(line).not.toContain(held);
    expect(s.lines.find((line) => line.includes('response body'))).toContain('[REDACTED]');
  });

  // The byte count on the line is the body's own size, measured before redaction: a reader
  // comparing it against what the host said it sent must not be handed the post-redaction length.
  it('still reports the original body size, not the redacted one', async () => {
    const s = sink();
    setApiTraceSink(s);
    const body = `{"apiKey":"${OPAQUE}"}`;

    await tracedFetch(okFetch(response(200, {}, body)))('https://api.example.test/items');

    expect(s.lines.find((line) => line.includes('response body'))).toContain(
      `response body (${Buffer.byteLength(body, 'utf8')} bytes)`,
    );
  });
});

/**
 * The adversarial pass found that only the BODY lines ever reached `redactSecrets`. The URL and the
 * failure line went through `redactUrl` alone — one regex for query parameters whose name ends in
 * `token` — so every other way a credential can ride a URL or an error message reached the sink in
 * plain text. Measured against the real wrapper before the fix; each case below printed the
 * credential in full.
 */
describe('tracedFetch: the URL and failure lines, which never reached the shared redactor', () => {
  const OPAQUE = 'Zk3mQp7xTv2rLw8sNb4cQq';

  afterEach(clearRegisteredSecretValues);

  it('redacts a credential the host holds when it rides in the URL path', async () => {
    const s = sink();
    setApiTraceSink(s);
    registerSecretValue(OPAQUE);

    await tracedFetch(okFetch())(`https://host.example.test/api/v4/jobs/${OPAQUE}/artifacts`);

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    expect(s.lines[0]).toContain('[REDACTED]');
  });

  it('redacts a query parameter whose name is a credential name the token-parameter family misses', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())(
      `https://host.example.test/api/v4/x?private_key=${OPAQUE}&client_secret=${OPAQUE}&credentials=${OPAQUE}&page=2`,
    );

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    // Redaction, not suppression: the ordinary parameter beside them still reads.
    expect(s.lines[0]).toContain('page=2');
  });

  /**
   * `https://<user>:<credential>@host/...` — the shape a git remote carries and the one no layer
   * here looked at: the password sits under a username, not a key name, so no pattern matched it,
   * and `redactUrl` only ever knew about query parameters. The username here is deliberately NOT
   * credential-named, which is the case the keyed pattern cannot reach on its own.
   */
  it('redacts a credential carried in a URL userinfo section', async () => {
    const s = sink();
    setApiTraceSink(s);

    await tracedFetch(okFetch())(`https://oauth2:${OPAQUE}@host.example.test/owner/repo.git/info/refs`);

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    // The rest of the URL still reads, which is the whole reason this channel exists.
    expect(s.lines[0]).toContain('host.example.test/owner/repo.git/info/refs');
  });

  it('redacts a credential a thrown error carries in its own text, not only one quoted from the URL', async () => {
    const s = sink();
    setApiTraceSink(s);
    const inner: TraceableFetch = () =>
      Promise.reject(new Error(`remote rejected: sent {"apiKey":"${OPAQUE}"} with Authorization: Bearer ${OPAQUE}`));

    await expect(tracedFetch(inner)('https://host.example.test/api/v4/x')).rejects.toThrow(Error);

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    expect(s.lines.some((line) => line.includes('failed after') && line.includes('[REDACTED]'))).toBe(true);
  });

  it('redacts a credential in the error raised while reading a response body for tracing', async () => {
    const s = sink();
    setApiTraceSink(s);
    const failing: TracedResponseLike = {
      ok: true,
      status: 200,
      headers: { get: () => null },
      clone: () => ({
        text: () => Promise.reject(new Error(`stream aborted for token=${OPAQUE}`)),
      }),
    };

    await tracedFetch(okFetch(failing))('https://host.example.test/api/v4/x');

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
    expect(s.lines.some((line) => line.includes('could not be read for tracing'))).toBe(true);
  });

  it('redacts a credential smuggled through a GraphQL operation name', async () => {
    const s = sink();
    setApiTraceSink(s);
    registerSecretValue(OPAQUE);

    await tracedFetch(okFetch())('https://api.example.test/graphql', {
      method: 'POST',
      body: JSON.stringify({ operationName: `Resolve_${OPAQUE}`, query: 'mutation Resolve { x }' }),
    });

    for (const line of s.lines) expect(line).not.toContain(OPAQUE);
  });
});
