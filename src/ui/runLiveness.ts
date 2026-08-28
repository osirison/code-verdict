/**
 * The running screen's proof of life, read off the run record.
 *
 * This used to be a class that owned both the counters and a direct
 * `webview.postMessage`, one instance per panel. That tied the numbers to the
 * screen: a run whose panel had gone counted nothing, and a reviewer who came
 * back to a run in flight was shown a blank liveness line under a log that had
 * been parked on the same step for minutes — the exact reading the line exists
 * to rule out.
 *
 * The counters live on the run record now (`ReviewRunManager`), so a run counts
 * whether or not anything is watching, and this is only the mapping from that
 * record to what the renderer takes. The throttle went with the counters; it
 * floors the manager's progress emissions instead.
 */
import type { RunRecord } from '../app/reviewRunManager';
import type { RunLivenessView } from './reviewFlowHtml';

/**
 * The liveness line for a run, or nothing when there is no request in flight.
 *
 * Elapsed is measured here rather than stored, so a render landing between two
 * fragments still agrees with the clock the page is ticking.
 */
export function livenessView(record: RunRecord | undefined, now = Date.now()): RunLivenessView | undefined {
  if (!record || record.status !== 'running' || !record.progress) return undefined;
  return {
    startedAt: record.progress.startedAt,
    elapsedMs: now - record.progress.startedAt,
    fragmentsReceived: record.progress.fragmentsReceived,
    charsReceived: record.progress.charsReceived,
  };
}
