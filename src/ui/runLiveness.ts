/**
 * The running screen's proof of life, shared by the two panels that stream an
 * `lm:` review (single change request and changeset). Both park their canned
 * log on step 2 for the whole request, so without this the screen looked
 * identical whether the agent was working or dead — the half of the timeout
 * report that survives now that a productive run is no longer cancelled.
 *
 * It owns the throttle as well as the numbers: `render()` per fragment would
 * replace `#flow-body` wholesale many times a second on a fast model,
 * restarting the spinner and rebuilding the DOM under the reviewer.
 */
import type * as vscode from 'vscode';
import type { AgentRunProgress } from '../app/lmAgent';
import type { RunLivenessView } from './reviewFlowHtml';
import { runOutputSummary } from './reviewFlowHtml';

/**
 * Floor between two `run:progress` pushes. Four a second already reads as
 * continuous, and every dropped push is still in `snapshot()`, so nothing is
 * lost by skipping one.
 */
export const PROGRESS_PUSH_MS = 250;

export class RunLiveness {
  private view?: RunLivenessView;
  private lastPush = 0;

  /** A request is starting. Resets the counters so a retry never shows the previous run's totals. */
  start(): void {
    this.view = { startedAt: Date.now(), elapsedMs: 0, fragmentsReceived: 0, charsReceived: 0 };
    this.lastPush = 0;
  }

  /** No request in flight — the running screen renders no liveness line at all. */
  clear(): void {
    this.view = undefined;
  }

  /**
   * Elapsed is re-measured on read rather than stored, so a render that lands
   * between two fragments still agrees with the clock the page is ticking.
   */
  snapshot(): RunLivenessView | undefined {
    return this.view ? { ...this.view, elapsedMs: Date.now() - this.view.startedAt } : undefined;
  }

  /** One fragment landed: keep the numbers, and push them to the page unless the last push was too recent. */
  record(progress: AgentRunProgress, webview: vscode.Webview): void {
    if (!this.view) return;
    // `progress.elapsedMs` is deliberately dropped: it is the agent trace's
    // clock, and `snapshot()` re-measures against `startedAt` so the number the
    // page ticks and the number a render prints come from one clock.
    this.view = {
      ...this.view,
      fragmentsReceived: progress.fragmentsReceived,
      charsReceived: progress.charsReceived,
    };
    const now = Date.now();
    if (now - this.lastPush < PROGRESS_PUSH_MS) return;
    this.lastPush = now;
    void webview.postMessage({
      type: 'run:progress',
      summary: runOutputSummary(progress.fragmentsReceived, progress.charsReceived),
    });
  }
}
