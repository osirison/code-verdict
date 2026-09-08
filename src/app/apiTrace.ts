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
 * Full content is the point of this channel: the complete request URL
 * (including its query string), method, status, request body and response
 * body all reach the sink, because a developer debugging their own
 * extension needs exactly what was sent and exactly what came back, not a
 * summary. Two things stay non-negotiable regardless: credentials are
 * redacted before anything reaches the sink — every line of it, not only the
 * bodies: the URL, the GraphQL operation name, the failure line and both
 * bodies all go through the shared `redactSecrets`
 * (`./harnessActivitySanitizer.ts` — reused, not reimplemented, per this
 * codebase's standing rule), with `redactTracedText` below adding the two
 * URL-shaped rules a general redactor has no way to know about. And
 * request *headers* are never logged at all, `Authorization` above every
 * other — the one thing this module still declines to print by construction
 * rather than by redaction, since a header is not part of what was asked
 * for and printing it would only be one more place a credential could leak
 * from. A body that is larger than this module cares to write whole is
 * still never silently cut: what is written is written in full, and the
 * omitted tail is named by its exact byte count (`formatTracedBody` below).
 *
 * The sink is injected and this module imports nothing from `vscode`, so it
 * is unit-testable with a plain in-memory sink; `extension.ts` wires the
 * output channel and honours `codeVerdict.trace.api`. The clock is injected
 * too (`tracedFetch`'s own `now` parameter, defaulting to `Date.now`) —
 * every line's own leading time-of-day and every elapsed-time reading come
 * from it, never from a bare inline `Date.now()` call, matching every other
 * module's clock pattern in this codebase.
 */
import { redactSecrets } from './harnessActivitySanitizer';
import { formatTimeOfDay } from './traceClock';

/** Anything that accepts one line of trace text. `vscode.OutputChannel` satisfies this structurally. */
export interface ApiTraceSink {
  appendLine(line: string): void;
}

/**
 * The part of a fetch response this module reads. `clone` is optional and read defensively:
 * every production caller (`registry.ts`'s `tracedFetch(fetch)`) wraps the real global `fetch`,
 * whose `Response` always has one, but a structural test double is not required to. Reading the
 * body for the trace goes through this method's own return value exclusively, never through `res`
 * itself — the real caller downstream (a provider's HTTP client) still gets an untouched, unread
 * response no matter what this module does with the clone. A double with no `clone` simply gets no
 * response-body line: never a thrown error, and never a swallowed read of the real one.
 */
export interface TracedResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  clone?(): { text(): Promise<string> };
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
 *
 * `now` is the injected wall clock (defaults to `Date.now`, the composition root's own choice at
 * every other call site in this codebase) — never read inline inside `traceCall`, so a test can
 * hand in a deterministic one instead of relying on global fake-timer patching.
 */
export function tracedFetch<F extends TraceableFetch>(inner: F, now: () => number = Date.now): F {
  const wrapper: TraceableFetch = (url, init) => {
    // Read once per call, not per wrapper: providers are built during
    // activation, before the sink is known, and the setting can be toggled
    // afterwards. With tracing off this is the whole cost — the caller's own
    // promise, no id burned, no string built, no clock read.
    const sink = currentSink;
    if (!sink) return inner(url, init);
    return traceCall(sink, inner, url, init, now);
  };
  return wrapper as unknown as F;
}

async function traceCall(
  sink: ApiTraceSink,
  inner: TraceableFetch,
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } | undefined,
  now: () => number,
): Promise<TracedResponseLike> {
  const id = (requestCount += 1);
  // Redacted once, then used on the start line and the failure line alike —
  // a raw URL must not reach the sink by either route.
  const method = init?.method ?? 'GET';
  const safeUrl = redactTracedText(String(url));
  const body = init?.body;

  emit(sink, now, () => {
    // The operation name comes out of a caller-supplied body, so it is caller-controlled text like
    // any other — short and identifier-shaped in every real GraphQL document, which is exactly why
    // it would be the last place anyone looked for a credential.
    const operation = graphqlOperation(safeUrl, body);
    const parts = [`[${id}] start ${method} ${safeUrl}`];
    if (operation) parts.push(`op=${redactSecrets(operation)}`);
    return parts.join(' ');
  });
  if (body !== undefined) {
    emit(sink, now, () => `[${id}] request body (${Buffer.byteLength(body, 'utf8')} bytes): ${formatTracedBody(body)}`);
  }

  const startedAt = now();
  try {
    const res = await inner(url, init);
    emit(sink, now, () => `[${id}] done in ${now() - startedAt}ms: ${res.status}${rateSuffix(res)}`);
    await emitResponseBody(sink, now, id, res);
    return res;
  } catch (e) {
    // The original error is rethrown untouched — the clients wrap network
    // failures in `ScmError` themselves and match on what they threw — but its
    // *message* is fully redacted before it is written. Runtimes quote the
    // request back at you inside the message (undici: "Failed to parse URL from
    // <url>"), so a token-bearing URL reaches the sink by this route too, and
    // a host's own error text can carry a credential that was never in the URL
    // at all — `remote rejected: sent {"apiKey":"…"}`. This line used to see
    // only the query-parameter rule, so everything else in it printed verbatim.
    emit(sink, now, () => `[${id}] failed after ${now() - startedAt}ms: ${redactTracedText(messageOf(e))} (${method} ${safeUrl})`);
    throw e;
  }
}

/**
 * The response-body line — always attempted when the response offers a `clone()`, even for a
 * non-2xx status: a 403 or 422's own body is usually the one thing that actually explains it.
 * Reads through the clone exclusively (see `TracedResponseLike.clone`'s own comment), never the
 * `res` the real caller goes on to read. Awaited before `traceCall` returns, so the request-body
 * and response-body lines for one request always land in the sink in order — the deliberate
 * trade-off this makes is a real one: the caller's own promise does not resolve until the clone's
 * body has been read, so tracing costs a small delay on every traced call, not only a hypothetical
 * one. Accepted because this only ever runs behind `codeVerdict.trace.api`, off by default and
 * switched on by a developer already choosing to trade a little latency for a channel with
 * everything in it, in the order it happened.
 */
async function emitResponseBody(sink: ApiTraceSink, now: () => number, id: number, res: TracedResponseLike): Promise<void> {
  const cloned = res.clone?.();
  if (!cloned) return;
  try {
    const text = await cloned.text();
    emit(sink, now, () => `[${id}] response body (${Buffer.byteLength(text, 'utf8')} bytes): ${formatTracedBody(text)}`);
  } catch (e) {
    // A clone can still fail to read (a stream error after the headers already arrived) — worth a
    // line of its own rather than silence, but never worth failing the request over. Redacted for
    // the same reason `traceCall`'s own failure line is: a runtime can quote the request URL —
    // token-bearing query string included — back into an error message, and a stream error can
    // carry whatever the host put in it.
    emit(sink, now, () => `[${id}] response body could not be read for tracing: ${redactTracedText(messageOf(e))}`);
  }
}

/**
 * Building the line and appending it are both inside the catch: tracing only
 * describes a request, so neither a disposed output channel nor a response
 * whose headers behave unexpectedly may become the caller's problem.
 */
function emit(sink: ApiTraceSink, now: () => number, line: () => string): void {
  try {
    sink.appendLine(`${formatTimeOfDay(now())} ${line()}`);
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

// `scheme://<user>:<credential>@host/…` — the shape a git remote carries, and the one nothing here
// looked at: the credential sits under a username, not under a key name, so no pattern in
// `redactSecrets` matches it and `TOKEN_PARAM` above only ever knew about query parameters. Only
// the password half is replaced; the username, the host and the path all still read, which is the
// whole reason this channel exists. A URL with a bare username and no `:` is left alone — a
// username is not a credential.
const URL_USERINFO = /(\/\/[^/@\s:]+:)[^/@\s]*@/g;

/**
 * Redacted in this order on purpose. `redactSecrets` runs first, so a credential the host holds, a
 * `?client_secret=`-style parameter and an `Authorization:` fragment quoted into an error message
 * are all gone before anything URL-specific looks; `redactUrl`'s own two rules then catch the two
 * shapes that are not credential-shaped to a general redactor at all — a value under a
 * `*token`-named parameter, and a password in a URL's userinfo. Running them the other way round
 * would leave `redactSecrets` rewriting the word `REDACTED` this function had just written.
 *
 * Every line this module emits goes through this, not only the body lines. Before, the URL and the
 * failure line went through `redactUrl` alone — one regex, one parameter family — so a credential
 * in a path segment, in a differently-named parameter, in a URL's userinfo, or in the text of a
 * thrown error reached the sink verbatim. Measured against the real wrapper.
 */
function redactTracedText(text: string): string {
  return redactSecrets(text).replace(TOKEN_PARAM, '$1REDACTED').replace(URL_USERINFO, '$1REDACTED@');
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

/**
 * Generous but bounded: full content is the point of this channel, but a body has no upper bound
 * any host guarantees, and a multi-megabyte diff or result page has no business being pasted whole
 * into VS Code's output-channel renderer. 100 KB comfortably covers every JSON payload this
 * extension's own providers send or receive in the ordinary course of a review (a page of issues,
 * a posted review body, a GraphQL response) while still bounding the pathological case.
 */
const MAX_TRACED_BODY_BYTES = 100_000;

/**
 * Redacts, then bounds — never the other way round, so a secret that happens to sit past the byte
 * cutoff is still caught before the cutoff runs (`redactSecrets` runs over the whole text first).
 * A body under the cap is written whole, verbatim. One over it is never silently cut: what is
 * shown is shown in full up to the cap, followed by plainly stating how many further bytes were
 * left out — never merged into an ellipsis a reader could mistake for the content itself just
 * having ended there.
 */
function formatTracedBody(text: string): string {
  const redacted = redactSecrets(text);
  const buf = Buffer.from(redacted, 'utf8');
  if (buf.byteLength <= MAX_TRACED_BODY_BYTES) return redacted;
  const shown = buf.subarray(0, MAX_TRACED_BODY_BYTES).toString('utf8');
  const omitted = buf.byteLength - MAX_TRACED_BODY_BYTES;
  return `${shown}\n…(${omitted} more byte(s) omitted, ${buf.byteLength} bytes total)`;
}
