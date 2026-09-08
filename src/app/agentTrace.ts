/**
 * Structured trace of one `runPrompt()` call (issue #35, then narrowed to
 * metadata-only by task 15.6 of `add-agentic-review-harness`, design.md
 * D13): request identity, model vendor/family, the size and digest of the
 * prompt actually sent, the arrival of the first streamed fragment and of any
 * fragment that came after a stall, the size/digest/parse-outcome of the
 * response text collected before JSON extraction, and final timing and outcome.
 *
 * D13: "`AgentTrace`... records only request identifiers, model identity,
 * phase, byte/token counts, timings, digests, error codes, and redacted
 * summaries." This is a diagnostic channel, not a debugging dump: no method
 * here accepts a string and writes it to the sink verbatim. Every text-shaped
 * value either becomes a size + `sha256Hex` digest (`prompt`/`response` —
 * reused from `./contentDigest.ts`, not a second hash convention) or is
 * routed through the shared `sanitizeErrorReason` (`./harnessActivitySanitizer.ts`)
 * before it reaches `appendLine` (`failure`, and `response`'s optional parse-failure
 * `detail`). A digest and a byte count are still enough for a developer to
 * tell two different prompts or two different model responses apart, and to
 * confirm a retry sent byte-identical content — the two things issue #35's
 * raw dump was actually used for — without the sink ever holding the prompt,
 * the model's output, or a fragment of either.
 *
 * `vscode.lm` only hands back text fragments, never the model's internal
 * reasoning, so this is a request/response trace — not a chain-of-thought
 * log. Do not describe it as one. `nonTextPart`/`debugRawPart` below exist
 * because a provider's `response.stream` can still emit a reasoning (or
 * other non-text) part alongside the text `lmAgent.ts` actually reads — this
 * class traces that a part like that arrived, and — only under
 * `codeVerdict.trace.rawPayloads`, and only into the live output channel —
 * what it contained; it does not turn this into a log of the model's
 * reasoning process, only a record that this stream carried more than text.
 *
 * This class writes to two sinks, not one, and the difference is the whole
 * point of the split: `sink` is durable (`lmAgent.ts`'s `installAgentTraceFile`
 * tees it into `agent-trace.log` with `appendFileSync`) and only ever receives
 * the metadata lines above; `liveSink` is the live output channel and is the
 * only thing the three `debugRaw*` methods write to. See `debugRawPrompt` for
 * the measurement that made that split necessary — those methods used to print
 * "never persisted" onto lines that were being written straight to disk.
 *
 * The sink is injected and this module imports nothing from `vscode`, so it
 * is unit-testable with a plain in-memory sink. `lmAgent.ts` (which already
 * depends on `vscode`) is responsible for wiring the default sink to
 * `vscode.window.createOutputChannel`.
 *
 * Every line this class writes leads with a local time-of-day, milliseconds
 * included (`./traceClock.ts`'s `formatTimeOfDay`, the same formatter
 * `apiTrace.ts` uses) — never an elapsed-since-start count, so a line here
 * can be lined up by eye against a line in the API trace, or against
 * whatever the reviewer watched happen on screen. The clock is injected
 * (the constructor's own `now`, defaulting to `Date.now`) rather than read
 * inline, matching every other module's clock pattern in this codebase.
 */
import { sha256Hex } from './contentDigest';
import { sanitizeErrorReason } from './harnessActivitySanitizer';
import { formatTimeOfDay } from './traceClock';

/** Anything that accepts one line of trace text. `vscode.OutputChannel` satisfies this structurally. */
export interface AgentTraceSink {
  appendLine(line: string): void;
}

/**
 * Why the request was cancelled — lets a caller branch on the cause instead of
 * parsing the message, and name the right setting in the failure card.
 * `'firstOutput'` is the time-to-first-token window: the request produced no
 * part of any kind, which is a different condition from `'inactivity'` — a
 * stream that started and then went quiet — and the two point at different
 * settings (see the limits comment in `lmAgent.ts`). `'ceiling'` is the long
 * checkpoint window, which cancels only when nothing at all arrived during it,
 * not a wall-clock cap. `'caller'` is not a limit at all: the reviewer asked
 * for the run to stop, so there is no window to lengthen and nothing to report
 * as a failure.
 */
export type AgentTimeoutReason = 'firstOutput' | 'inactivity' | 'ceiling' | 'caller';

/**
 * Snapshot handed to a caller's progress callback as fragments arrive.
 * Enough to drive a "still alive" indicator on the running screen without
 * the caller re-deriving counts itself.
 */
export interface AgentRunProgress {
  requestId: string;
  fragmentsReceived: number;
  charsReceived: number;
  elapsedMs: number;
}

export type AgentProgressCallback = (progress: AgentRunProgress) => void;

/**
 * How long a stream may go quiet between fragments before `fragment` below says so — the second of
 * the two lines that survived the removal of the per-token trace line.
 *
 * `fragment` used to emit one line per streamed token. Two live runs on 2026-09-09 measured what
 * that costs: 20,506 of 56,099 lines (37% of the file, 1.3MB of 3.7MB) in one, 34,396 of 95,592 in
 * the other. It made the trace unreadable by eye, made it slow to grep, and pushed the file toward
 * `./agentTraceFile.ts`'s 32MB rotation bound far faster than the content anyone actually reads.
 * What the per-token line legitimately carried was time-to-first-token and mid-stream stalls, and
 * both are visible in a handful of lines instead of thousands.
 *
 * 10s, chosen against both bounds it sits between:
 *
 * - Above any real cadence. Across 54,827 measured gaps between fragments in those two runs, the
 *   median gap was 0ms, p99 was 191ms, and the single largest gap seen anywhere was 1,142ms. 10s is
 *   roughly nine times the worst gap a healthy stream has ever produced here, so ordinary streaming
 *   never trips it — measured, not guessed: at this threshold both runs emit zero stall lines.
 * - Well below the watchdog. `lmAgent.ts`'s `INACTIVITY_TIMEOUT_MS` cancels a run after 90s of
 *   silence. At 10s a gap gets named in the trace while the run is still alive and recoverable, so
 *   a reviewer reading a run that later died of inactivity can see it creeping toward the bound —
 *   a 40s gap, then a 70s one — instead of finding only the cancellation. A stall line is written
 *   when the *next* fragment arrives, so a gap that never ends produces no line here at all; that
 *   case is the watchdog's, and `failure` records it.
 *
 * The pattern this deliberately does log on every fragment is the one `lmAgent.ts`'s own timeout
 * comment names: a model that streams one fragment every ~60s. That is a run living at two-thirds
 * of the watchdog window, and it should be loud. It is also bounded — one line a minute — which is
 * the reason there is no separate rate limiter here. The threshold IS the rate limit: a stall line
 * needs 10s of silence in front of it, so a request can produce at most 6 a minute and 360 an hour,
 * against the 20,501 lines one request produced in the run that motivated this. Capping it beyond
 * that would delete exactly the signal a retry decision is made on — whether the stream stalled
 * once or kept stalling.
 */
export const STALL_GAP_MS = 10_000;

/** `[req] label (N bytes, sha256=<hex>)` — the shared shape `prompt`/`response` both emit. */
function sizedDigestLine(label: string, text: string): string {
  return `${label} (${Buffer.byteLength(text, 'utf8')} bytes, sha256=${sha256Hex(text)})`;
}

/**
 * `nonTextResponse`'s own part-type list, deduped with a repeat count and in first-seen order —
 * `Object{callId,name,input} ×3, Object{kind} ×1` rather than the same descriptor repeated N
 * times. Every other line this class emits is a bounded, fixed-shape line (the marker test below
 * asserts every line stays under 500 chars); without this a stream that yields hundreds of parts
 * this runtime cannot classify would blow that bound out on the one line built from a
 * caller-controlled list.
 */
function summarizeDescriptors(descriptors: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const descriptor of descriptors) counts.set(descriptor, (counts.get(descriptor) ?? 0) + 1);
  return [...counts.entries()].map(([descriptor, count]) => (count > 1 ? `${descriptor} ×${count}` : descriptor)).join(', ');
}

/**
 * `debugRawPart`'s own raw-content formatter — best-effort JSON, falling back to `String(part)`
 * for a value `JSON.stringify` cannot handle (a circular structure, a function-only object). Used
 * only behind `codeVerdict.trace.rawPayloads`; metadata callers (`nonTextPart`/`nonTextResponse`)
 * never call this, and never need to — they only ever read a part's type and property names.
 */
function describeRawPart(part: unknown): string {
  try {
    const json = JSON.stringify(part);
    return json !== undefined ? json : String(part);
  } catch {
    return String(part);
  }
}

/** One instance per `runPrompt()` call — not reused across requests. */
export class AgentTrace {
  private readonly startedAt: number;
  private fragmentsReceived = 0;
  private charsReceived = 0;
  /** When the previous fragment arrived, on this instance's own injected clock; `undefined` until the first one does. `fragment` below measures every gap against this, never against the last fragment it happened to log, so one stall does not make the rest of the stream noisy. */
  private lastFragmentAt: number | undefined;

  /** Set the first time a raw payload is written, so the "withheld from the file" note below is emitted once per request rather than once per raw line. */
  private rawPayloadNoted = false;

  constructor(
    private readonly sink: AgentTraceSink,
    readonly requestId: string,
    private readonly vendor: string,
    private readonly family: string,
    /** Injected wall clock, defaulting to `Date.now` — drives both this class's own elapsed-time math and every line's leading time-of-day (`emit` below). `lmAgent.ts`'s `streamText` passes its own `clockNow` through, so the two stay one clock rather than two independent readings of "now". */
    private readonly now: () => number = Date.now,
    /**
     * Where the three `debugRaw*` methods write, and the ONLY thing they write to. Separate from
     * `sink` because `sink` is durable: `installAgentTraceFile` (`./lmAgent.ts`) tees it into
     * `agent-trace.log` with `appendFileSync`, which is how this class came to be writing full
     * prompts and full model replies to disk while printing "never persisted" on every one of
     * them. Only the caller that composes the sinks knows which of them is the live channel, so
     * only that caller can supply this. Absent, the raw methods write nothing at all — a raw
     * payload with nowhere live to go must not fall back to the durable sink, which is the exact
     * mistake being fixed.
     */
    private readonly liveSink?: AgentTraceSink,
  ) {
    this.startedAt = this.now();
    this.emit(`[${requestId}] start ${new Date(this.startedAt).toISOString()} vendor=${vendor} family=${family}`);
  }

  /** Every line this class writes goes through here — one place that prepends the local time-of-day, so no call site can forget it. */
  private emit(line: string): void {
    this.sink.appendLine(`${formatTimeOfDay(this.now())} ${line}`);
  }

  /**
   * The one path raw, unredacted model input/output takes. It reaches `liveSink` and nothing else.
   *
   * The durable sink is not left silently short of a line, though: a trace file that simply omits
   * the raw text reads as if the setting had been off. One note per request says the payload
   * existed, that it was withheld on purpose, and where a reviewer can actually see it. Once per
   * request, not once per raw line — three raw lines a request would otherwise triple a file this
   * setting already makes large.
   */
  private emitLive(line: string): void {
    const live = this.liveSink;
    if (!live) return;
    if (!this.rawPayloadNoted) {
      this.rawPayloadNoted = true;
      this.emit(
        `[${this.requestId}] raw payloads for this request go to the "Code Verdict: Agent Trace" output channel only (codeVerdict.trace.rawPayloads) — deliberately not written to agent-trace.log`,
      );
    }
    live.appendLine(`${formatTimeOfDay(this.now())} ${line}`);
  }

  /**
   * The assembled prompt (diff + criteria + instructions) — size and digest only, never its text.
   * Returns the byte count logged so a caller (`lmAgent.ts`'s `streamText`) that also needs it —
   * for an empty-response message, or for a diagnostics timing record — reads the one number this
   * class already computed rather than calling `Buffer.byteLength` on the same text a second time.
   */
  prompt(text: string): number {
    const bytes = Buffer.byteLength(text, 'utf8');
    this.emit(`[${this.requestId}] prompt (${bytes} bytes, sha256=${sha256Hex(text)})`);
    return bytes;
  }

  /**
   * Records one streamed fragment; returns the snapshot for the caller's onProgress callback.
   * Never logs the fragment's own text — only its length.
   *
   * Counting and emitting are two different things here, and only the second one is conditional.
   * Every call increments the counters and returns a full snapshot, because `lmAgent.ts`'s
   * `streamText` passes that straight to `onProgress` and the running screen's "still alive"
   * indicator is driven by it — a fragment this method chose not to log still has to advance the
   * numbers the reviewer is watching. Only two of those calls write a line:
   *
   * - The FIRST fragment, whose elapsed time is the time to first token. A 207KB prompt once
   *   produced nothing for 90s and the inactivity watchdog killed a healthy request that was still
   *   ingesting it; that is why `lmAgent.ts` has a separate `firstOutputMs` window at all, and this
   *   is the line that says where a run actually sat against it.
   * - A fragment that arrived more than `STALL_GAP_MS` after the one before it, naming the gap.
   *   A long gap mid-stream is the failure a retry can fix, and reading consecutive timestamps was
   *   the only way to see one while every fragment had a line of its own.
   *
   * Everything else is silent. The totals the per-token lines used to carry are already on the
   * closing `done`/`success` line ("across N fragment(s)"), which counts every call including the
   * silent ones — see `STALL_GAP_MS` above for the measurements that made one line per token
   * untenable and for why the threshold is 10s.
   */
  fragment(text: string): AgentRunProgress {
    this.fragmentsReceived += 1;
    this.charsReceived += text.length;
    const at = this.now();
    const elapsedMs = at - this.startedAt;
    const previousAt = this.lastFragmentAt;
    this.lastFragmentAt = at;
    const counts = `fragment #${this.fragmentsReceived} (+${text.length} chars, ${this.charsReceived} total)`;
    if (previousAt === undefined) {
      this.emit(`[${this.requestId}] +${elapsedMs}ms ${counts} — time to first token`);
    } else {
      const gapMs = at - previousAt;
      if (gapMs > STALL_GAP_MS) {
        this.emit(`[${this.requestId}] +${elapsedMs}ms ${counts} — stall: ${gapMs}ms since fragment #${this.fragmentsReceived - 1}`);
      }
    }
    return { requestId: this.requestId, fragmentsReceived: this.fragmentsReceived, charsReceived: this.charsReceived, elapsedMs };
  }

  /**
   * Size, digest and parse outcome of the response text collected before JSON
   * extraction — never the text itself. Call this on every attempt, success
   * or failure: a failure here is exactly the case issue #35 was filed for,
   * and a digest is enough to confirm on a later run whether the model
   * produced byte-identical output without the sink ever holding it.
   *
   * `detail` (a parse-failure description) crosses the same redaction
   * boundary every other public diagnostic field in this codebase does
   * (`sanitizeErrorReason`) before it reaches the sink — callers must not
   * forward a raw parser message that itself quotes input bytes (a `SyntaxError`
   * from `JSON.parse` does exactly that); `lmAgent.ts` classifies that case to
   * a fixed, safe description before calling this.
   */
  response(text: string, parsed: boolean, detail?: string): void {
    const outcome = parsed ? 'parsed OK' : `parse FAILED${detail ? `: ${sanitizeErrorReason(detail)}` : ''}`;
    this.emit(`[${this.requestId}] ${sizedDigestLine('response', text)}, ${outcome}`);
  }

  /**
   * Size and digest of a non-empty response text collected before any downstream parser has
   * looked at it — for `runHarnessModelTurn`/`runFollowUpPrompt`, neither of which parses
   * anything at this layer (the protocol parse happens later, in
   * `../domain/harnessProtocol.ts`'s `parseModelTurn`; a follow-up answer is never parsed at
   * all), so `response`'s own `parsed` boolean would have to guess. This method asserts no parse
   * verdict at all, honestly. Never called for a zero-byte reply — `streamText` calls
   * `emptyResponse` instead, before `finish` runs (see this file's own "empty response" fix).
   */
  received(text: string): void {
    this.emit(`[${this.requestId}] ${sizedDigestLine('response', text)}, received (not parsed at this layer)`);
  }

  success(itemCount: number): void {
    const elapsedMs = this.now() - this.startedAt;
    this.emit(
      `[${this.requestId}] done in ${elapsedMs}ms: ${itemCount} item(s) across ${this.fragmentsReceived} fragment(s)`,
    );
  }

  /** `success`'s own counterpart for a caller (every caller today) that never counts items at this layer — see `received`'s own comment on why claiming a count here would be a guess. */
  done(): void {
    const elapsedMs = this.now() - this.startedAt;
    this.emit(`[${this.requestId}] done in ${elapsedMs}ms across ${this.fragmentsReceived} fragment(s)`);
  }

  /**
   * The empty-response fix: a stream that yields no fragments at all is never a successful turn,
   * and must never be logged as one. Named plainly — "the model returned nothing" — rather than
   * folded into `response`'s "parsed OK"/"parse FAILED" wording, which would either lie (OK) or
   * misdescribe a transport-empty reply as a JSON parse problem (FAILED). Carries the model
   * identity, the prompt size, and how long the request took — everything a reviewer needs to
   * tell "the model is slow" from "the model sent nothing back" without re-running anything.
   */
  emptyResponse(promptBytes: number, elapsedMs: number): void {
    this.emit(
      `[${this.requestId}] EMPTY RESPONSE after ${elapsedMs}ms: vendor=${this.vendor} family=${this.family} returned 0 bytes across ${this.fragmentsReceived} fragment(s) for a ${promptBytes}-byte prompt. The stream itself yielded no parts at all.`,
    );
  }

  /**
   * "Never silently discard a part" (`lmAgent.ts`'s `streamText`, the `response.stream` fix):
   * logged immediately, every time `textFromPart` cannot resolve one stream item to text — a
   * tool-call part (none are ever requested today, but the type permits one), a reasoning part,
   * or a future part type neither this runtime's `instanceof` nor the duck-typed `value`/`text`
   * check recognizes. `descriptor` is metadata only — a constructor name plus that part's own
   * property names — never a property's value, so this line is safe to log unconditionally,
   * independent of `codeVerdict.trace.rawPayloads`. The part's actual content, when a reviewer
   * needs to see it, is `debugRawPart`'s job below.
   */
  nonTextPart(index: number, descriptor: string): void {
    this.emit(`[${this.requestId}] part #${index} carried no text (${descriptor})`);
  }

  /**
   * The second of the three now-distinguished empty-turn cases (`emptyResponse` above is the
   * first; a downstream protocol-parse failure on non-empty text, e.g. `../domain/harnessProtocol.ts`'s
   * `noJson`/`invalidEnvelope`, is the third and was already distinct before this change). This one
   * fires when `response.stream` yielded one or more parts and none of them carried text — the
   * hypothesis this whole fix exists to catch: `response.text` filters a part this runtime cannot
   * classify as text out of existence, silently, with no error and no fragment, which used to be
   * indistinguishable from a model that genuinely sent nothing. `descriptors` names every part type
   * seen, in the order they arrived, deduped with a repeat count so a stream of many identical junk
   * parts still produces one bounded line rather than an unbounded one.
   *
   * `partCount` is taken as its own parameter rather than read off `descriptors.length`: a real
   * text part with a zero-length value (a genuine, if degenerate, streamed delta) is described in
   * `descriptors` too so the type list is never falsely empty, but `lmAgent.ts`'s `streamText`
   * counts every part that arrived regardless of whether it ended up in that list — the two can
   * legitimately differ, and the count this line reports must be the honest one either way.
   */
  nonTextResponse(promptBytes: number, elapsedMs: number, partCount: number, descriptors: readonly string[]): void {
    const types = summarizeDescriptors(descriptors);
    this.emit(
      `[${this.requestId}] STREAM PRODUCED PARTS BUT NO TEXT after ${elapsedMs}ms: vendor=${this.vendor} family=${this.family} — the stream yielded ${partCount} part(s) but none carried text (types: ${types || 'none'}) for a ${promptBytes}-byte prompt.`,
    );
  }

  /**
   * The full, unredacted prompt/response text — the only two methods in this class that ever write
   * raw model input/output anywhere, and both called from exactly one place: `lmAgent.ts`'s
   * `streamText`, gated by the `codeVerdict.trace.rawPayloads` setting read there. No other module
   * constructs an `AgentTrace`, imports these methods, or receives this text by any other path —
   * `harnessActivityLog.ts`/`harnessCheckpoint.ts`/`harnessDiagnostics.ts` never import this class
   * at all. Off by default; a reviewer switches this setting on only to see why a live request
   * misbehaved. This text is never sanitized and never bounded.
   *
   * ## What these lines used to claim, and why the claim is gone
   *
   * They printed "debug only, never persisted" on every line. That was false, and the code said so
   * two files away: `installAgentTraceFile` (`./lmAgent.ts`, wired from `../extension.ts` at
   * activation) tees this class's ordinary sink into `agent-trace.log` and writes every line with
   * `appendFileSync`. One reviewer's current log was found holding 113 full prompts and 111 full
   * model responses — 20 MB — under the VS Code log directory, rotating at 32 MB and surviving
   * across sessions. Raw payloads are exempt from redaction BECAUSE they were documented as
   * live-only, so the exemption was resting entirely on a claim nothing upheld.
   *
   * The fix is behavioural, not editorial: this text now goes to `liveSink` (see the constructor)
   * and to nothing else, so it is absent from `agent-trace.log` by construction rather than by a
   * promise. What is honestly claimable stops there, and the wording stops there with it — VS Code
   * captures the contents of every output channel into its own log directory (see
   * `./agentTraceFile.ts`'s header, which is why that file exists at all), so the live channel is
   * not a guarantee that nothing reaches a disk. It is the removal of the large, session-spanning,
   * synchronously-written copy this extension was making itself, and of a claim it could not keep.
   */
  debugRawPrompt(text: string): void {
    this.emitLive(`[${this.requestId}] RAW PROMPT (codeVerdict.trace.rawPayloads is on — live output channel only):\n${text}`);
  }

  /** See `debugRawPrompt`'s own comment — the same debug-only, live-sink-only path for the model's raw reply text. */
  debugRawResponse(text: string): void {
    this.emitLive(`[${this.requestId}] RAW RESPONSE (codeVerdict.trace.rawPayloads is on — live output channel only):\n${text}`);
  }

  /**
   * See `debugRawPrompt`'s own comment — the same debug-only, live-sink-only path, for one
   * `response.stream` part `textFromPart` could not resolve to text. Never called for a part that
   * did yield text (that text already reaches the live sink, concatenated, through
   * `debugRawResponse`). This is "the raw-payload setting should now also be able to show the part
   * types" made concrete: `nonTextPart` above names the type unconditionally and reaches the
   * durable sink; this shows the part's actual content too, under the same opt-in setting and the
   * same live-only rule every other raw dump in this class follows.
   */
  debugRawPart(index: number, part: unknown): void {
    this.emitLive(
      `[${this.requestId}] RAW PART #${index} (codeVerdict.trace.rawPayloads is on — live output channel only): ${describeRawPart(part)}`,
    );
  }

  /**
   * `limit` is set only when a timeout cancelled the run; other failures (bad contract, no model,
   * network) omit it. `message` is redacted before it reaches the sink — the thrown `AgentRunError`
   * a caller sees is a separate, unredacted value this method never touches.
   *
   * Carries the fragment and character counts because a failed run never reaches `done`/`success`,
   * and this is the only line it ends on. While `fragment` wrote a line per streamed token those
   * counts were implicit — the last of thousands of fragment lines sat directly above the failure
   * with the running totals on it. Now that it does not, a run the inactivity watchdog killed would
   * otherwise say when it died and never how much it had produced first, which is the difference
   * between "the model sent two tokens and stopped" and "the model streamed for four minutes and
   * then stopped". Every failure exit path in `lmAgent.ts`'s `streamText` — timeout, caller
   * cancellation, contract mismatch, and the generic catch — goes through this one method, so
   * saying it here says it once. Not a duplicate of the `done` line: a run emits one or the other,
   * never both.
   */
  failure(message: string, limit?: AgentTimeoutReason): void {
    const elapsedMs = this.now() - this.startedAt;
    const suffix = limit ? ` (${limit} limit)` : '';
    const received = `${this.fragmentsReceived} fragment(s) and ${this.charsReceived} chars received`;
    this.emit(`[${this.requestId}] failed after ${elapsedMs}ms${suffix}, ${received}: ${sanitizeErrorReason(message)}`);
  }
}
