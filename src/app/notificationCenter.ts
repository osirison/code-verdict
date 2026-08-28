/**
 * The notification engine (handoff §11): holds per-pod snapshots, derives
 * events from consecutive polls, routes each through the user's per-event
 * mode, and owns the badge and digest queues. Delivery is injected — this
 * module never imports vscode, so the whole pipeline is testable.
 */
import {
  deriveEvents,
  nextDigestFlush,
  routeNotification,
  type DeriveContext,
  type NotificationPrefs,
  type NotificationSnapshot,
  type VerdictNotification,
} from '../domain/notifications';

export interface PendingNotification extends VerdictNotification {
  /** Epoch ms at enqueue — the quick pick shows when it happened. */
  at: number;
}

export interface NotificationSinks {
  /** An Interrupt-mode event, deliver now (a toast). */
  interrupt(notification: VerdictNotification): void;
  /** The badge queue changed — repaint the 🔔 segment. */
  badgeChanged(pending: readonly PendingNotification[]): void;
  /** The digest cadence elapsed with items queued — deliver the batch. */
  digestFlush(batch: readonly PendingNotification[]): void;
}

export interface NotificationCenterDeps {
  prefs(): NotificationPrefs;
  sinks: NotificationSinks;
  /** Injectable clock for tests. */
  now?(): Date;
  /**
   * How wide a gap between snapshots still counts as a live signal. Defaults to
   * `STALE_SNAPSHOT_MS`, and the notifier widens it because the poll interval
   * is no longer a constant: an interval past this window would re-baseline on
   * every poll, which is not "fewer notifications" but none at all, silently.
   */
  staleAfterMs?(): number;
}

/**
 * A diff across a gap this long is stale news, not a live signal — the
 * pod was inactive (switched away, laptop asleep) and bursting the whole
 * backlog as toasts would be a flood. Re-baseline silently instead.
 *
 * The floor, not the value: a caller that polls on a derived cadence has to
 * widen it to fit, or every one of its polls looks like a pod waking up. See
 * `staleAfterMs`.
 */
export const STALE_SNAPSHOT_MS = 10 * 60_000;

export class NotificationCenter {
  private readonly snapshots = new Map<string, NotificationSnapshot>();
  private badgeQueue: PendingNotification[] = [];
  private digestQueue: PendingNotification[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private disposed = false;

  constructor(private readonly deps: NotificationCenterDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * One poll result for one pod. The first snapshot per pod is a baseline
   * and emits nothing — otherwise activation (or a pod switch) would toast
   * the entire backlog at once. A snapshot far newer than its predecessor
   * re-baselines the same way: only continuously-observed pods diff.
   */
  observe(podId: string, snapshot: NotificationSnapshot, ctx: DeriveContext): void {
    const prev = this.snapshots.get(podId);
    this.snapshots.set(podId, snapshot);
    const staleAfter = this.deps.staleAfterMs?.() ?? STALE_SNAPSHOT_MS;
    if (!prev || snapshot.fetchedAt - prev.fetchedAt > staleAfter) return;
    for (const event of deriveEvents(prev, snapshot, ctx)) this.notify(event);
  }

  /** Route one event (local ones — agent finished — enter here directly). */
  notify(notification: VerdictNotification): void {
    if (this.disposed) return;
    const mode = routeNotification(notification.key, this.deps.prefs(), this.now().getHours());
    switch (mode) {
      case 'Interrupt':
        this.deps.sinks.interrupt(notification);
        return;
      case 'Badge':
        this.pushBadge(notification);
        return;
      case 'Digest':
        this.digestQueue.push({ ...notification, at: this.now().getTime() });
        this.armDigest();
        return;
      case 'Off':
        return;
    }
  }

  /** "Later" on an interrupt toast parks the item on the badge queue. */
  demoteToBadge(notification: VerdictNotification): void {
    if (!this.disposed) this.pushBadge(notification);
  }

  /** The badge queue, oldest first — what the 🔔 quick pick lists. */
  pending(): readonly PendingNotification[] {
    return this.badgeQueue;
  }

  /**
   * The user looked at the list — drop what they saw. `count` scopes the
   * clear to the items that were actually on screen, so a notification
   * arriving while the quick pick was open keeps its badge.
   */
  acknowledge(count?: number): void {
    const seen = Math.min(count ?? this.badgeQueue.length, this.badgeQueue.length);
    if (seen === 0) return;
    this.badgeQueue = this.badgeQueue.slice(seen);
    this.deps.sinks.badgeChanged(this.badgeQueue);
  }

  /** The digest cadence setting changed — re-aim the pending flush. */
  reschedule(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.armDigest();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private pushBadge(notification: VerdictNotification): void {
    this.badgeQueue.push({ ...notification, at: this.now().getTime() });
    this.deps.sinks.badgeChanged(this.badgeQueue);
  }

  /** Lazily armed: no queued items, no timer. */
  private armDigest(): void {
    if (this.timer !== undefined || this.digestQueue.length === 0 || this.disposed) return;
    const now = this.now();
    const flushAt = nextDigestFlush(this.deps.prefs().digestCadence, now);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flushDigest();
    }, Math.max(0, flushAt.getTime() - now.getTime()));
  }

  private flushDigest(): void {
    if (this.disposed || this.digestQueue.length === 0) return;
    const batch = this.digestQueue;
    this.digestQueue = [];
    this.deps.sinks.digestFlush(batch);
  }
}
