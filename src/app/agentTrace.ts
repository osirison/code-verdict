/**
 * Structured trace of one `runPrompt()` call (issue #35): request identity,
 * the prompt actually sent, each streamed fragment with elapsed time, the
 * raw text collected before JSON extraction (previously discarded on parse
 * failure — the one artefact needed to diagnose it), and final timing and
 * outcome.
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

/** Anything that accepts one line of trace text. `vscode.OutputChannel` satisfies this structurally. */
export interface AgentTraceSink {
  appendLine(line: string): void;
}

/** Which backstop cancelled the run — lets a caller branch on the cause instead of parsing the message. */
export type AgentTimeoutReason = 'inactivity' | 'ceiling';

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

  /** The assembled prompt (diff + criteria + instructions) exactly as sent to the model. */
  prompt(text: string): void {
    this.sink.appendLine(`[${this.requestId}] prompt (${text.length} chars):\n${text}`);
  }

  /** Records one streamed fragment; returns the snapshot for the caller's onProgress callback. */
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
   * The full text collected before JSON extraction, plus whether it parsed.
   * Call this on every attempt, success or failure — a failure here is
   * exactly the case issue #35 was filed for: the raw text used to be
   * thrown away right when it was most needed.
   */
  rawText(text: string, parsed: boolean, detail?: string): void {
    const outcome = parsed ? 'parsed OK' : `parse FAILED${detail ? `: ${detail}` : ''}`;
    this.sink.appendLine(`[${this.requestId}] raw text before JSON extraction (${text.length} chars, ${outcome}):\n${text}`);
  }

  success(itemCount: number): void {
    const elapsedMs = Date.now() - this.startedAt;
    this.sink.appendLine(
      `[${this.requestId}] done in ${elapsedMs}ms: ${itemCount} item(s) across ${this.fragmentsReceived} fragment(s)`,
    );
  }

  /** `limit` is set only when a timeout cancelled the run; other failures (bad contract, no model, network) omit it. */
  failure(message: string, limit?: AgentTimeoutReason): void {
    const elapsedMs = Date.now() - this.startedAt;
    const suffix = limit ? ` (${limit} limit)` : '';
    this.sink.appendLine(`[${this.requestId}] failed after ${elapsedMs}ms${suffix}: ${message}`);
  }
}
