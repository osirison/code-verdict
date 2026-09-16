/**
 * The gate behind a run's dashboard repaint (spec: "Data that has not
 * changed notifies nobody" — Scenario: Progress within an unchanged status).
 *
 * A streaming run reports progress at a 250 ms floor; only a status change
 * moves anything the dashboard actually paints from it — a row's pill.
 * Repainting on every emission would issue four platform fetches a second
 * per streaming run (`DashboardPanel.refreshIfOpen()` refetches the whole
 * pod) — worse than the burst the notifier's focus throttle exists to
 * prevent. `changed()` is the one place that decides whether an emission is
 * one screens need to hear about.
 *
 * Extracted out of `extension.ts`'s `runManager.onChange` closure (task
 * 10.1) so the guard can be unit-tested on its own: `activate()` wires
 * together the whole command surface, every panel and the notifier, and
 * building all of that in a test just to drive one run's status through
 * `onChange` is impractical — this is the whole guard, with no `vscode`
 * import, isolated from everything else that closure does.
 *
 * Generic over the key it dedupes on: the legacy `RunStatus` this file's own
 * test drives (default), or the canonical `RunLifecycle` the dashboard's
 * `onChange` actually keys on (task 14.4) — `planning`/`investigating`/
 * `verifying`/`completing` all collapse to one `RunStatus` of `'running'`, so
 * a `RunStatus`-keyed gate would swallow a phase advance the dashboard's row
 * needs to repaint for. `activate()` supplies `isTerminalLifecycle` as the
 * terminal predicate to get that finer key; the default below reproduces the
 * original `RunStatus` rule for anyone constructing the gate without one.
 */
import type { RunStatus } from './reviewRunManager';

function isTerminalRunStatus(status: string): boolean {
  return status !== 'queued' && status !== 'running';
}

export class RunStatusGate<T extends string = RunStatus> {
  private readonly lastStatus = new Map<string, T>();

  constructor(private readonly isTerminal: (status: T) => boolean = isTerminalRunStatus) {}

  /**
   * Whether `key`'s status actually changed since the last call for it —
   * and, if so, remembers the new one. A terminal status is forgotten
   * immediately after: the run is over, and the key may be reused later by
   * an unrelated run that deserves its own fresh first transition rather
   * than being compared against a status the run manager will never see
   * again on this key.
   */
  changed(key: string, status: T): boolean {
    const previous = this.lastStatus.get(key);
    if (previous === status) return false;
    this.lastStatus.set(key, status);
    if (this.isTerminal(status)) this.lastStatus.delete(key);
    return true;
  }
}
