/**
 * Structured trace of one `runPrompt()` call (issue #35, then narrowed to
 * metadata-only by task 15.6 of `add-agentic-review-harness`, design.md
 * D13): request identity, model vendor/family, the size and digest of the
 * prompt actually sent, each streamed fragment's count and elapsed time, the
 * size/digest/parse-outcome of the response text collected before JSON
 * extraction, and final timing and outcome.
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
 * log. Do not describe it as one.
 *
 * The sink is injected and this module imports nothing from `vscode`, so it
 * is unit-testable with a plain in-memory sink. `lmAgent.ts` (which already
 * depends on `vscode`) is responsible for wiring the default sink to
 * `vscode.window.createOutputChannel`.
 */
import { sha256Hex } from './contentDigest';
import { sanitizeErrorReason } from './harnessActivitySanitizer';

/** Anything that accepts one line of trace text. `vscode.OutputChannel` satisfies this structurally. */
export interface AgentTraceSink {
  appendLine(line: string): void;
}

/**
 * Why the request was cancelled — lets a caller branch on the cause instead of
 * parsing the message, and name the right setting in the failure card.
 * `'ceiling'` is the long checkpoint window, which cancels only when nothing at
 * all arrived during it (see the limits comment in `lmAgent.ts`), not a
 * wall-clock cap. `'caller'` is not a limit at all: the reviewer asked for the
 * run to stop, so there is no window to lengthen and nothing to report as a
 * failure.
 */
export type AgentTimeoutReason = 'inactivity' | 'ceiling' | 'caller';

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

/** `[req] label (N bytes, sha256=<hex>)` — the shared shape `prompt`/`response` both emit. */
function sizedDigestLine(label: string, text: string): string {
  return `${label} (${Buffer.byteLength(text, 'utf8')} bytes, sha256=${sha256Hex(text)})`;
}

/** One instance per `runPrompt()` call — not reused across requests. */
export class AgentTrace {
  private readonly startedAt = Date.now();
  private fragmentsReceived = 0;
  private charsReceived = 0;

  constructor(
    private readonly sink: AgentTraceSink,
    readonly requestId: string,
    vendor: string,
    family: string,
  ) {
    this.sink.appendLine(
      `[${requestId}] start ${new Date(this.startedAt).toISOString()} vendor=${vendor} family=${family}`,
    );
  }

  /** The assembled prompt (diff + criteria + instructions) — size and digest only, never its text. */
  prompt(text: string): void {
    this.sink.appendLine(`[${this.requestId}] ${sizedDigestLine('prompt', text)}`);
  }

  /** Records one streamed fragment; returns the snapshot for the caller's onProgress callback. Never logs the fragment's own text — only its length. */
  fragment(text: string): AgentRunProgress {
    this.fragmentsReceived += 1;
    this.charsReceived += text.length;
    const elapsedMs = Date.now() - this.startedAt;
    this.sink.appendLine(
      `[${this.requestId}] +${elapsedMs}ms fragment #${this.fragmentsReceived} (+${text.length} chars, ${this.charsReceived} total)`,
    );
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
    this.sink.appendLine(`[${this.requestId}] ${sizedDigestLine('response', text)}, ${outcome}`);
  }

  success(itemCount: number): void {
    const elapsedMs = Date.now() - this.startedAt;
    this.sink.appendLine(
      `[${this.requestId}] done in ${elapsedMs}ms: ${itemCount} item(s) across ${this.fragmentsReceived} fragment(s)`,
    );
  }

  /** `limit` is set only when a timeout cancelled the run; other failures (bad contract, no model, network) omit it. `message` is redacted before it reaches the sink — the thrown `AgentRunError` a caller sees is a separate, unredacted value this method never touches. */
  failure(message: string, limit?: AgentTimeoutReason): void {
    const elapsedMs = Date.now() - this.startedAt;
    const suffix = limit ? ` (${limit} limit)` : '';
    this.sink.appendLine(`[${this.requestId}] failed after ${elapsedMs}ms${suffix}: ${sanitizeErrorReason(message)}`);
  }
}
