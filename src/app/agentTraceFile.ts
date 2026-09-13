/**
 * A trace sink that writes every line straight to a file, synchronously.
 *
 * The "Code Verdict: Agent Trace" output channel already has a file behind it — VS Code captures
 * every channel under its own log directory — but that capture is buffered and lands late. A run
 * still dispatching tools was observed with its captured file untouched for two and a half
 * minutes, and a run whose loop needed diagnosing had a file ninety minutes stale. That is fine for
 * a human scrolling a panel and useless for anyone trying to read a live run, which is exactly when
 * the file is wanted.
 *
 * So this writes with `appendFileSync`: the line is on disk before the call returns. A review that
 * hangs, loops, or takes the whole extension host down still leaves a complete trace behind it. The
 * cost is one synchronous write per line, which is nothing next to the model call each line
 * describes.
 *
 * It never throws. A trace that cannot be written must not be able to fail a review, so every
 * filesystem error is swallowed and the inner sink still gets the line.
 */
import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentTraceSink } from './agentTrace';

/**
 * Rotate at 32 MB and keep one previous file, so a long session cannot fill a disk while still
 * leaving enough history to cover several reviews.
 *
 * The sizing used to be justified by "a verbose run with raw payloads on is ~1 MB", which was the
 * measurement that should have raised the alarm rather than set a bound: raw payloads were reaching
 * this file at all, while `agentTrace.ts` printed "never persisted" on every one of those lines.
 * One reviewer's log was found holding 113 full prompts and 111 full model responses, 20 MB, on its
 * way to this bound. `AgentTrace` now writes raw payloads to a live sink this file is not part of,
 * so what lands here is metadata lines only — a few hundred bytes per request, whatever
 * `codeVerdict.trace.rawPayloads` is set to. 32 MB is now many thousands of requests rather than a
 * few dozen, which is the right shape for a file whose purpose is reading a live or hung run.
 */
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;

export interface TraceFileSinkOptions {
  /** Directory to write into. Created if absent. */
  readonly dir: string;
  /** File name within `dir`. */
  readonly fileName?: string;
  /** Also forwarded here, so the output channel keeps working exactly as before. */
  readonly inner?: AgentTraceSink;
  readonly maxBytes?: number;
}

export interface TraceFileSink extends AgentTraceSink {
  /** Absolute path of the file being written, for a caller that wants to tell the reviewer where to look. */
  readonly filePath: string;
}

/**
 * Tees `inner` to a file. Returns a sink whose `appendLine` writes both; if the file write fails,
 * the inner sink still receives the line.
 */
export function createTraceFileSink(options: TraceFileSinkOptions): TraceFileSink {
  const filePath = join(options.dir, options.fileName ?? 'agent-trace.log');
  const previousPath = `${filePath}.1`;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let directoryReady = false;

  function rotateIfLarge(): void {
    try {
      if (statSync(filePath).size < maxBytes) return;
      try {
        unlinkSync(previousPath);
      } catch {
        // No previous file to replace — the rename below creates it.
      }
      renameSync(filePath, previousPath);
    } catch {
      // Either the file does not exist yet (nothing to rotate) or the rotation failed; in both
      // cases appending is still the right next move.
    }
  }

  return {
    filePath,
    appendLine(line: string): void {
      try {
        if (!directoryReady) {
          mkdirSync(options.dir, { recursive: true });
          directoryReady = true;
        }
        rotateIfLarge();
        appendFileSync(filePath, `${line}\n`, 'utf8');
      } catch {
        // Deliberately silent: a trace that cannot be written must never fail the review it is
        // describing, and there is no second channel to report the failure on that would not have
        // the same problem.
      }
      options.inner?.appendLine(line);
    },
  };
}
