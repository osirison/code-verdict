/**
 * VS Code delivery for the notification engine (handoff §11, spec §13).
 *
 * The spec's toast stack is drawn from the prototype, which mocks the whole
 * VS Code window — a real webview can only toast over itself, and background
 * events arrive with no Verdict tab visible at all. Interrupts therefore use
 * the editor's own notifications (the same deviation the status bar made for
 * spec §14); titles stay CR-first exactly as §13 writes them.
 *
 * Event detection is a poll of the active pod — one batched query plus the
 * submitted reviews' threads — on a background interval and on window focus,
 * as spec §16 prescribes for all data fetching.
 */
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import { NotificationCenter, type PendingNotification } from '../app/notificationCenter';
import { fetchPodData } from '../app/podQuery';
import type { PodStore } from '../app/pods';
import type { ReviewHistory } from '../app/reviewHistory';
import type { SecretStore } from '../app/storage';
import {
  NOTIFICATION_EVENTS,
  type DigestCadence,
  type NotificationMode,
  type NotificationPrefs,
  type VerdictNotification,
} from '../domain/notifications';
import { getProvider } from '../platform/registry';
import type { ChangeRequestRef, ReviewThread } from '../platform/types';
import { AppSurface } from './appSurface';

/** Slower than the triage head poll — notifications are not latency-critical. */
const POLL_MS = 60_000;
/** A focus flurry (Alt-Tab ping-pong) must not fan out extra requests. */
const FOCUS_THROTTLE_MS = 15_000;

export function readNotificationPrefs(): NotificationPrefs {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return {
    modes: Object.fromEntries(
      NOTIFICATION_EVENTS.map((event) => [
        event.key,
        config.get<NotificationMode>(`notifications.events.${event.key}`, event.defaultMode),
      ]),
    ),
    quietMode: config.get<boolean>('notifications.quietMode', false),
    digestCadence: config.get<DigestCadence>('notifications.digestCadence', 'End of day'),
  };
}

export interface NotifierDeps {
  podStore: PodStore;
  secrets: SecretStore;
  reviewHistory: ReviewHistory;
  /** Repaint the status bar's 🔔 segment. */
  onBadgeCount(count: number): void;
  openReview(ref: ChangeRequestRef): void;
  openPostedReviews(ref: ChangeRequestRef): void;
}

export class VerdictNotifier implements vscode.Disposable {
  readonly center: NotificationCenter;
  private interval?: ReturnType<typeof setInterval>;
  private focusWatch?: vscode.Disposable;
  private lastPollAt = 0;
  private polling = false;
  private disposed = false;

  constructor(private readonly deps: NotifierDeps) {
    this.center = new NotificationCenter({
      prefs: readNotificationPrefs,
      sinks: {
        interrupt: (notification) => this.toast(notification),
        badgeChanged: (pending) => this.deps.onBadgeCount(pending.length),
        digestFlush: (batch) => this.digestToast(batch),
      },
    });
  }

  /** Fire and forget — activation must not block on network I/O. */
  start(): void {
    this.interval = setInterval(() => void this.poll(), POLL_MS);
    this.focusWatch = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - this.lastPollAt >= FOCUS_THROTTLE_MS) void this.poll();
    });
    void this.poll();
  }

  /** ReviewFlow's `onReviewReady` — a local event, no poll involved. */
  reviewReady(info: { ref?: ChangeRequestRef; refLabel: string; itemCount: number }): void {
    const items =
      info.itemCount === 0 ? 'no items' : `${info.itemCount} item${info.itemCount === 1 ? '' : 's'}`;
    this.center.notify({
      key: 'agentFinished',
      title: `Review ready · ${items} on ${info.refLabel}`,
      crRef: info.ref,
    });
  }

  /** The 🔔 segment was clicked: list, jump on pick, clear on close. */
  async showPending(): Promise<void> {
    const pending = [...this.center.pending()];
    if (pending.length === 0) {
      void vscode.window.showInformationMessage('Verdict: nothing is waiting on you.');
      return;
    }
    await this.pickAndJump(pending, `${pending.length} waiting`);
    // Viewed is acknowledged — Esc counts; the list was on screen. Scoped
    // to what was shown: an item arriving mid-pick keeps its badge.
    this.center.acknowledge(pending.length);
  }

  dispose(): void {
    this.disposed = true;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.focusWatch?.dispose();
    this.center.dispose();
  }

  // ---- delivery ---------------------------------------------------------------------

  private toast(notification: VerdictNotification): void {
    const open = this.opener(notification);
    const actions = open ? [open.label, 'Later'] : ['Later'];
    void vscode.window.showInformationMessage(notification.title, ...actions).then((picked) => {
      if (picked === 'Later') this.center.demoteToBadge(notification);
      else if (picked && picked === open?.label) open.run();
    });
  }

  private digestToast(batch: readonly PendingNotification[]): void {
    const only = batch.length === 1 ? batch[0] : undefined;
    const title = only ? only.title : `Digest · ${batch.length} updates on your reviews`;
    void vscode.window.showInformationMessage(title, 'Show').then((picked) => {
      if (!picked) return;
      if (only) this.opener(only)?.run();
      else void this.pickAndJump(batch, `${batch.length} updates`);
    });
  }

  private async pickAndJump(
    items: readonly PendingNotification[],
    placeHolder: string,
  ): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      items.map((notification) => ({
        label: notification.title,
        detail: notification.detail,
        notification,
      })),
      { placeHolder, matchOnDetail: true },
    );
    if (picked) this.opener(picked.notification)?.run();
  }

  /**
   * Where a notification leads: review-shaped events reach their review
   * surface, thread-shaped ones reach Posted reviews, pipelines only have
   * their web page. A changeset run has no single CR — its triage screen is
   * already on the app surface, so revealing it is the whole jump.
   */
  private opener(n: VerdictNotification): { label: string; run: () => void } | undefined {
    switch (n.key) {
      case 'agentFinished':
        return {
          label: 'Start triage',
          run: () => (n.crRef ? this.deps.openReview(n.crRef) : void AppSurface.reveal()),
        };
      case 'reviewRequested':
      case 'authorPushed':
        return n.crRef
          ? { label: 'Open review', run: () => this.deps.openReview(n.crRef as ChangeRequestRef) }
          : undefined;
      case 'replyPosted':
      case 'mentioned':
      case 'threadStale':
        return n.crRef
          ? { label: 'Open thread', run: () => this.deps.openPostedReviews(n.crRef as ChangeRequestRef) }
          : undefined;
      case 'pipelineFailed':
        return n.webUrl
          ? { label: 'Open pipeline', run: () => void vscode.env.openExternal(vscode.Uri.parse(n.webUrl as string)) }
          : undefined;
    }
  }

  // ---- detection --------------------------------------------------------------------

  /**
   * The last good thread list per submitted review — a dropped
   * `listThreads` call must not shrink the snapshot, or the next good poll
   * would see every thread as new.
   */
  private readonly threadCache = new Map<string, ReviewThread[]>();

  private async poll(): Promise<void> {
    if (this.polling || this.disposed) return;
    const pod = this.deps.podStore.activePod;
    if (!pod) return;
    this.polling = true;
    this.lastPollAt = Date.now();
    try {
      const connection = await connectionForPod(pod, this.deps.secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      // Reply polling is per submitted review (handoff §16), scoped to CRs
      // still open — merged and closed ones leave the live set, which also
      // bounds the fan-out as history accumulates.
      const openRefs = new Set(data.changeRequests.map((cr) => `${cr.ref.repoId}!${cr.ref.number}`));
      const submitted = this.deps.reviewHistory
        .list()
        .filter((review) => review.podId === pod.id && openRefs.has(`${review.repoId}!${review.crNumber}`));
      const threads: ReviewThread[] = (
        await Promise.all(
          submitted.map(async (review) => {
            const key = `${pod.id}/${review.repoId}!${review.crNumber}`;
            try {
              const fetched = await connection.listThreads({ repoId: review.repoId, number: review.crNumber });
              this.threadCache.set(key, fetched);
              return fetched;
            } catch {
              return this.threadCache.get(key) ?? [];
            }
          }),
        )
      ).flat();
      if (this.disposed) return;
      const vocabulary = getProvider(pod.providerId).vocabulary;
      this.center.observe(
        pod.id,
        { fetchedAt: data.fetchedAt, changeRequests: data.changeRequests, ciRuns: data.ciRuns, threads },
        {
          you: pod.username,
          submittedRefs: this.deps.reviewHistory.submittedRefs(),
          formatRef: (number) => vocabulary.formatCrRef(number),
        },
      );
    } catch {
      // A failed poll is nobody's problem — the next tick retries.
    } finally {
      this.polling = false;
    }
  }
}
