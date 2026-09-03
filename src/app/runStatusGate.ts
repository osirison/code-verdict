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
 */
import type { RunStatus } from './reviewRunManager';

export class RunStatusGate {
  private readonly lastStatus = new Map<string, RunStatus>();

  /**
   * Whether `key`'s status actually changed since the last call for it —
   * and, if so, remembers the new one. A terminal status (anything but
   * `queued`/`running`) is forgotten immediately after: the run is over, and
   * the key may be reused later by an unrelated run that deserves its own
   * fresh `queued` → `running` transition rather than being compared against
   * a status the run manager will never see again on this key.
   */
  changed(key: string, status: RunStatus): boolean {
    const previous = this.lastStatus.get(key);
    if (previous === status) return false;
    this.lastStatus.set(key, status);
    if (status !== 'queued' && status !== 'running') this.lastStatus.delete(key);
    return true;
  }
}
