/**
 * The coalescing writer behind both review panels' draft persistence (design
 * D9 of `add-app-state-and-incremental-rendering`).
 *
 * `persistDraft` used to run one `workspaceState.update` per triage action —
 * every verdict, every summary keystroke committed on blur. Each update
 * serializes the whole record (the review, every finding, every thread), so a
 * fast keyboard triage paid that cost per keypress. This writer collapses a
 * burst of writes into one.
 *
 * Two rules keep the deferral from corrupting the key it writes to, which is
 * also the retained-review key the run manager owns (the one-writer rule from
 * the archived `add-background-review-runs` design, D7/D7a):
 *
 * - **Every schedule captures a complete record.** The pending write is a
 *   snapshot taken when the action happened, not a closure over live panel
 *   fields — so a write deferred across a navigation still describes the
 *   target it was made for, and a read-back can never see a mixture of two
 *   actions' state (only the last complete snapshot lands).
 * - **The write re-checks the record's generation before landing.** The run
 *   manager overwrites this key wholesale when a re-run succeeds, stamping a
 *   new `ranAt`. A deferred panel write from before that overwrite must drop
 *   itself, or it would silently violate *a cached review is replaced only by
 *   a review that succeeds*. The caller passes the `ranAt` of the record it
 *   loaded; the flush re-reads the key and writes only when the stored
 *   `ranAt` still matches. The `get` and the `update` are adjacent with no
 *   `await` between them, per the contract in `storage.ts`.
 */
import type { RetainedRecord } from './retainedReview';
import type { KeyValueStore } from './storage';

/**
 * How long a burst of actions may share one write. Short enough that a crash
 * loses at most this much triage; long enough to cover keyboard-speed
 * verdicts (auto-advance makes A A A land well inside it). The window is an
 * implementation detail — the flush points in the panels are the contract.
 */
export const DRAFT_WRITE_WINDOW_MS = 300;

interface PendingWrite {
  key: string;
  record: RetainedRecord;
  /**
   * `ranAt` of the record the panel had loaded when it scheduled this write —
   * the generation the write belongs to. `undefined` for a record written
   * before `ranAt` existed. Against a *replacement* that is still correct on
   * its own: any successful re-run stamps a defined `ranAt`, so the
   * comparison fails and the stale write drops. Against a *deletion* it is
   * not, which is why `flush` checks for the key's existence first — a
   * deleted key also reads `undefined`.
   */
  expectedRanAt: string | undefined;
}

export class CoalescedDraftWriter {
  /**
   * One slot, not a queue: consecutive schedules for the same key replace the
   * snapshot, which is the whole point. A schedule for a *different* key
   * flushes the old pending first, so navigating to another target inside the
   * window cannot drop the previous target's triage.
   */
  private pending?: PendingWrite;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly store: KeyValueStore,
    private readonly windowMs: number = DRAFT_WRITE_WINDOW_MS,
  ) {}

  /**
   * Replace the pending write with a fresh, complete snapshot. The window is
   * not restarted by later schedules — the write lands at most `windowMs`
   * after the first unwritten action, so continuous triage cannot postpone
   * durability indefinitely.
   */
  schedule<D extends RetainedRecord>(key: string, record: D, expectedRanAt: string | undefined): void {
    if (this.pending && this.pending.key !== key) this.flushQuietly();
    this.pending = { key, record, expectedRanAt };
    this.timer ??= setTimeout(() => this.flushQuietly(), this.windowMs);
  }

  /**
   * Flush with a swallowed rejection, for the flush points with no message
   * handler above them to turn a storage failure into a toast — the window
   * timer, a hidden tab, a blurred window, dispose. Nothing retries: the
   * pending slot is already clear, so the record simply remains whatever the
   * last successful write left, which is also what a crash inside the window
   * leaves. The alternative is an unhandled rejection in the extension host.
   * The guarded write itself still runs synchronously (see `flush`), so a
   * caller may read the key immediately after this returns.
   */
  flushQuietly(): void {
    void this.flush().then(undefined, () => undefined);
  }

  /**
   * Write the pending record now, or drop it when the stored record is no
   * longer the generation the write was made against.
   *
   * The get/update pair below is synchronous, and `Memento.get` reflects a
   * preceding `update` immediately (`storage.ts`) — so a caller may flush and
   * then `get` the key in the same tick and read what was just written. Both
   * panels' `enterRetained` depend on that.
   */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) return Promise.resolve();
    // The generation guard. No `await` between this `get` and the `update`.
    const stored = this.store.get<{ ranAt?: string }>(pending.key);
    // A key that is gone was deleted deliberately: `pruneClosedRetained`
    // (`retainedReview.ts`) drops the record for a change request that is no
    // longer open, on the pod poll that observes it. Writing here would
    // resurrect it. The `ranAt` comparison below does NOT catch this on its
    // own — a record written before `ranAt` existed carries none, so a
    // deleted key and a legacy generation both read `undefined` and compare
    // equal.
    if (!stored) return Promise.resolve();
    if (stored.ranAt !== pending.expectedRanAt) return Promise.resolve();
    return Promise.resolve(this.store.update(pending.key, pending.record));
  }

  /**
   * Drop the pending write for `key` without landing it — the panel observed
   * a `succeeded` settle for that target, so the run manager has already
   * replaced the record and the pending snapshot describes a review that no
   * longer exists. Keyed, not blanket: a pending write for a *different*
   * target (scheduled just before a navigation) is someone's triage and keeps
   * its timer. The generation guard would drop the write anyway; cancelling
   * here just stops it from being attempted at all.
   */
  cancelFor(key: string): void {
    if (this.pending?.key !== key) return;
    this.pending = undefined;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }
}
