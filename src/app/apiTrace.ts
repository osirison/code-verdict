/**
 * HTTP-level trace of every platform API call, for diagnosing "it fetched
 * nothing / it 403'd / it was slow" without a proxy.
 *
 * It decorates the `fetch` seam rather than each client, so it is
 * provider-agnostic by construction: a provider is traced because
 * `registry.ts` hands its factory a traced fetch, not because the provider
 * knows tracing exists. Every future provider gets it free, and nothing here
 * needs to know which platform is on the other end.
 *
 * What is deliberately *not* recorded: request and response bodies (a diff or
 * a token-bearing payload has no business in a log the user will paste into
 * an issue) and request headers — `Authorization` above all. Only the size of
 * the request body is reported. Credentials also travel in URLs on some
 * hosts, so the URL is redacted before it reaches the sink.
 *
 * The sink is injected and this module imports nothing from `vscode`, so it
 * is unit-testable with a plain in-memory sink; `extension.ts` wires the
 * output channel and honours `codeVerdict.trace.api`.
 */

/** Anything that accepts one line of trace text. `vscode.OutputChannel` satisfies this structurally. */
export interface ApiTraceSink {
  appendLine(line: string): void;
}

/** The part of a fetch response this module reads. It never touches the body — see `tracedFetch`. */
export interface TracedResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
}

/**
 * The shape both provider HTTP clients already inject (`FetchLike`), stated
 * structurally so the app layer does not import a provider type.
 */
export type TraceableFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<TracedResponseLike>;

let currentSink: ApiTraceSink | undefined;

/**
 * Wired at activation and re-wired whenever `codeVerdict.trace.api` changes,
 * in the style of `setSessionProvider`. Absent by default and in tests, which
 * is what makes the wrapper inert.
 */
export function setApiTraceSink(sink: ApiTraceSink | undefined): void {
  currentSink = sink;
}

// Module level, not per wrapper: `tracedFetch` is called once per provider, and
// per-closure counters would hand two different providers the same `[1]`.
let requestCount = 0;

/**
 * Wraps a fetch-shaped function so each call is traced. Behaviour is
 * unchanged in every case that matters: the same response object, the same
 * thrown error, an untouched body (both clients read theirs exactly once —
 * consuming it here would break them), and a sink that throws is swallowed.
 */
export function tracedFetch<F extends TraceableFetch>(inner: F): F {
  const wrapper: TraceableFetch = (url, init) => {
    // Read once per call, not per wrapper: providers are built during
    // activation, before the sink is known, and the setting can be toggled
    // afterwards. With tracing off this is the whole cost — the caller's own
    // promise, no id burned, no string built, no clock read.
    const sink = currentSink;
    if (!sink) return inner(url, init);
    return traceCall(sink, inner, url, init);
  };
  return wrapper as unknown as F;
}

async function traceCall(
  sink: ApiTraceSink,
  inner: TraceableFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
): Promise<TracedResponseLike> {
  const id = (requestCount += 1);
  // Redacted once, then used on the start line and the failure line alike —
  // a raw URL must not reach the sink by either route.
  const method = init?.method ?? 'GET';
  const safeUrl = redactUrl(String(url));
  const body = init?.body;

  emit(sink, () => {
    const operation = graphqlOperation(safeUrl, body);
    const parts = [`[${id}] start ${method} ${safeUrl}`];
    if (operation) parts.push(`op=${operation}`);
    if (body !== undefined) parts.push(`body ${body.length} chars`);
    return parts.join(' ');
  });

  const startedAt = Date.now();
  try {
    const res = await inner(url, init);
    emit(sink, () => `[${id}] done in ${Date.now() - startedAt}ms: ${res.status}${rateSuffix(res)}`);
    return res;
  } catch (e) {
    // The original error is rethrown untouched — the clients wrap network
    // failures in `ScmError` themselves and match on what they threw — but its
    // *message* is redacted like a URL before it is written. Runtimes quote the
    // request back at you inside the message (undici: "Failed to parse URL from
    // <url>"), so a token-bearing URL reaches the sink by this route too, and
    // the rule here is that it reaches the sink by no route at all.
    emit(sink, () => `[${id}] failed after ${Date.now() - startedAt}ms: ${redactUrl(messageOf(e))} (${method} ${safeUrl})`);
    throw e;
  }
}

/**
 * Building the line and appending it are both inside the catch: tracing only
 * describes a request, so neither a disposed output channel nor a response
 * whose headers behave unexpectedly may become the caller's problem.
 */
function emit(sink: ApiTraceSink, line: () => string): void {
  try {
    sink.appendLine(line());
  } catch {
    // Tracing never changes what the caller sees.
  }
}

// Any query parameter whose name ends in `token` — `private_token`,
// `access_token`, plain `token`, and anything else of that family a future
// host invents. Some platforms take a credential in the query string rather
// than a header, so matching the family beats matching three literals for a
// value that must never be logged.
const TOKEN_PARAM = /([?&][^=&#]*token=)[^&#]*/gi;

function redactUrl(url: string): string {
  return url.replace(TOKEN_PARAM, '$1REDACTED');
}

/**
 * Best effort, so `POST /graphql` says which operation it was. `operationName`
 * when the caller sent one, else the first operation the document declares.
 * A body that is not JSON, or not a GraphQL document, just yields nothing.
 */
function graphqlOperation(url: string, body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  // Path only — a query parameter containing "graphql" is not an endpoint.
  const path = url.split(/[?#]/)[0] ?? '';
  if (!/\/graphql$/i.test(path)) return undefined;
  try {
    const parsed = JSON.parse(body) as { operationName?: unknown; query?: unknown };
    if (typeof parsed.operationName === 'string' && parsed.operationName !== '') {
      return parsed.operationName;
    }
    if (typeof parsed.query === 'string') {
      return /\b(?:query|mutation|subscription)\s+([A-Za-z_]\w*)/.exec(parsed.query)?.[1];
    }
  } catch {
    // Not JSON. The URL and timing are still worth a line.
  }
  return undefined;
}

/**
 * Read generically off the response, never through a provider's client: the
 * remaining-call count and its reset time are the first numbers to look at
 * when a host starts refusing requests, and a host that does not send them
 * simply contributes nothing to the line.
 */
function rateSuffix(res: TracedResponseLike): string {
  const remaining = header(res, 'x-ratelimit-remaining');
  const reset = header(res, 'x-ratelimit-reset');
  if (remaining === undefined && reset === undefined) return '';
  const parts: string[] = [];
  if (remaining !== undefined) parts.push(`remaining=${remaining}`);
  if (reset !== undefined) parts.push(`reset=${reset}`);
  return ` rate ${parts.join(' ')}`;
}

function header(res: TracedResponseLike, name: string): string | undefined {
  const value = res.headers?.get(name);
  return value === null || value === undefined || value === '' ? undefined : value;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
