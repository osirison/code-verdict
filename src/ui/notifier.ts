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
import type { AppStore } from '../app/appStore';
import { connectionForPod } from '../app/connections';
import { NotificationCenter, STALE_SNAPSHOT_MS, type PendingNotification } from '../app/notificationCenter';
import { repoIdsOf } from '../app/podQuery';
import type { PodStore } from '../app/pods';
import { DEFAULT_POLL_INTERVAL_SECONDS, pollIntervalMs } from '../app/pollSchedule';
import type { ReviewHistory } from '../app/reviewHistory';
import type { SecretStore } from '../app/storage';
import {
  NOTIFICATION_EVENTS,
  type DigestCadence,
  type NotificationMode,
  type NotificationPrefs,
  type VerdictNotification,
} from '../domain/notifications';
import type { ResultCompleteness } from '../domain/harnessLifecycle';
import { toScmError } from '../platform/errors';
import { getProvider, tryGetProvider } from '../platform/registry';
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import type { Pod } from '../domain/types';
import type { ChangeRequestRef, ReviewThread } from '../platform/types';
import { AppSurface } from './appSurface';

/**
 * A focus flurry (Alt-Tab ping-pong) must not fan out extra requests.
 *
 * A floor, not the gap: the gap is a quarter of the interval this pod earned,
 * and 15s is what a quarter of the original fixed 60s came to. Left as a bare
 * constant it would be the hole in the whole budget — a 20-repository pod earns
 * a 240s interval and costs 80 requests a poll, so an hour of Alt-Tab at 15s
 * issues ~19,000 requests against an allowance of 1,200. Scaling it keeps the
 * 4x headroom the design already accepted at every pod size instead of only at
 * the one it was written for. What survives that 4x is nearly free in charged
 * terms once validators are held, and full price on a cold cache, which is the
 * case the allowance is sized for.
 */
const FOCUS_THROTTLE_MS = 15_000;

/**
 * How long to stand down when the platform reported no reset with its refusal.
 * A minute, because that is what a secondary rate limit sends in `retry-after`
 * when it sends anything at all; guessing an hour would silence a pod for an
 * hour over a burst that cleared in seconds.
 */
const BLIND_BACKOFF_SECONDS = 60;

/**
 * Longest stand-down, whatever the platform said. GitHub's primary window is
 * an hour, so an honest reset never exceeds this; a number beyond it is a bad
 * clock or a bad header, and sleeping on it would be indistinguishable from
 * the notifier having died.
 */
const MAX_PAUSE_MS = 60 * 60_000;

/**
 * Added to the reported reset before polling again. The reset is a wall-clock
 * instant on the platform's clock, not ours: landing a second early re-arms
 * the pause for a whole further window, and nothing about that failure would
 * look different from the first one.
 */
const RESUME_MARGIN_MS = 5_000;

/** Background polling has stopped, and when it starts again. */
export interface PollPause {
  platformName: string;
  /** Epoch ms. */
  resumesAt: number;
}

/**
 * The floor for the poll interval; the effective one scales with the pod (see
 * `pollIntervalMs`). Read per poll rather than cached, so changing it takes
 * effect on the next tick instead of the next window.
 */
export function readPollIntervalSeconds(): number {
  return vscode.workspace
    .getConfiguration('codeVerdict')
    .get<number>('notifications.pollIntervalSeconds', DEFAULT_POLL_INTERVAL_SECONDS);
}

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
  /**
   * The poll's pod fetch goes through here (task 6.3/D5): the store owns
   * caching and single-flight, the notifier keeps owning the schedule. The
   * thread fan-out below still uses `secrets` for its own connection.
   */
  appStore: AppStore;
  secrets: SecretStore;
  reviewHistory: ReviewHistory;
  /** Repaint the status bar's 🔔 segment. */
  onBadgeCount(count: number): void;
  /**
   * Background polling paused or resumed — `undefined` means running again.
   * The status bar carries it: a paused poll is a state the user can be in for
   * an hour, and a state you stay in belongs on a surface that stays up, not
   * in a toast that scrolls away.
   */
  onPollPaused(pause?: PollPause): void;
  openReview(ref: ChangeRequestRef): void;
  openPostedReviews(ref: ChangeRequestRef): void;
}

export class VerdictNotifier implements vscode.Disposable {
  readonly center: NotificationCenter;
  /**
   * A timeout re-armed after every poll, not a fixed interval: the interval is
   * derived from the pod's fan-out and from whether the budget is spent, and
   * neither is known when `start()` runs.
   */
  private timer?: ReturnType<typeof setTimeout>;
  private focusWatch?: vscode.Disposable;
  private lastPollAt = 0;
  private polling = false;
  private disposed = false;
  /** Epoch ms before which polling must not run at all. 0 means running. */
  private pausedUntil = 0;
  /**
   * Which pod's budget ran out. A pause belongs to an account, not to the
   * notifier: switching to a pod on another host — or another token on the
   * same one — must not inherit somebody else's exhausted window and go
   * silent for the rest of it.
   */
  private pausedPodId?: string;
  /** One notice per exhaustion, cleared only by a poll that succeeds. */
  private pauseAnnounced = false;
  /**
   * Submitted reviews the last poll queried threads for — one request each, so
   * it belongs in the interval. Zero until the first poll, which is the right
   * starting guess: a pod with no history costs nothing extra.
   */
  private submittedReviews = 0;

  constructor(private readonly deps: NotifierDeps) {
    this.center = new NotificationCenter({
      prefs: readNotificationPrefs,
      // The engine re-baselines silently across a gap it reads as a pod waking
      // up, and its default gap is 10 minutes — shorter than the interval a
      // pod of more than fifty repositories earns, and shorter than the cap.
      // Left at the default, such a pod would poll forever and never derive a
      // single event. Two intervals plus a minute keeps one dropped or slow
      // poll inside the window while still catching a genuine sleep.
      staleAfterMs: () => Math.max(STALE_SNAPSHOT_MS, 2 * this.intervalMs() + 60_000),
      sinks: {
        interrupt: (notification) => this.toast(notification),
        badgeChanged: (pending) => this.deps.onBadgeCount(pending.length),
        digestFlush: (batch) => this.digestToast(batch),
      },
    });
  }

  /** Fire and forget — activation must not block on network I/O. */
  start(): void {
    this.focusWatch = vscode.window.onDidChangeWindowState((state) => {
      if (state.focused && Date.now() - this.lastPollAt >= this.focusGapMs()) void this.poll();
    });
    void this.poll();
  }

  /**
   * A run belonging to another pod names it in the title, because "Review
   * ready on !2841" is confusing when !2841 is not in the pod on screen —
   * and drops the `crRef`, since "Start triage" resolves a ref against the
   * *active* pod and a ref from another pod would open a change request
   * that pod cannot see.
   */
  private otherPodSuffix(podId: string | undefined): { name?: string; dropRef: boolean } {
    const activePod = this.deps.podStore.activePod;
    const other =
      podId !== undefined && activePod !== undefined && podId !== activePod.id
        ? this.deps.podStore.list().find((pod) => pod.id === podId)
        : undefined;
    return { name: other?.name, dropRef: other !== undefined };
  }

  /**
   * A run finished successfully — a local event, no poll involved. It now
   * arrives from the run manager rather than from a panel, which means it
   * can land while the reviewer is on a different pod entirely (see
   * `otherPodSuffix`).
   *
   * Task 14.7 (spec `review-run-activity`: "the notification distinguishes
   * complete, partial, failed, and cancelled outcomes"): `succeeded` may
   * still be `completeness: 'partial'` (D2 — an attempt that validated
   * findings without satisfying every completion condition), so this never
   * says "ready" for a result that stopped short of complete.
   */
  reviewReady(info: { ref?: ChangeRequestRef; refLabel: string; itemCount: number; podId?: string; completeness: ResultCompleteness }): void {
    const items =
      info.itemCount === 0 ? 'no items' : `${info.itemCount} item${info.itemCount === 1 ? '' : 's'}`;
    const { name, dropRef } = this.otherPodSuffix(info.podId);
    const headline = info.completeness === 'partial' ? 'Partial results' : 'Review ready';
    this.center.notify({
      key: 'agentFinished',
      title: `${headline} · ${items} on ${info.refLabel}${name ? ` (${name})` : ''}`,
      crRef: dropRef ? undefined : info.ref,
    });
  }

  /**
   * The `failed`/`cancelled` counterpart to `reviewReady` (task 14.7):
   * `ReviewRunManager`'s `onRunOutcome` fires this for every terminal
   * lifecycle `reviewReady` does not cover, whichever settlement path
   * produced it (a cooperative result, the cancel grace timeout, or a
   * genuine crash) — so a run that stops without a triage-ready result
   * still tells the reviewer it stopped, rather than going silent. Never
   * announces a partial as though the review finished: "kept as partial"
   * is the whole of what a validated-but-incomplete result gets to claim.
   */
  runEnded(info: { lifecycle: 'failed' | 'cancelled'; completeness: ResultCompleteness; refLabel: string; ref?: ChangeRequestRef; podId?: string; findingCount?: number }): void {
    const { name, dropRef } = this.otherPodSuffix(info.podId);
    const verb = info.lifecycle === 'failed' ? 'Review failed' : 'Review cancelled';
    const kept =
      info.findingCount !== undefined && info.findingCount > 0
        ? ` · ${info.findingCount} finding${info.findingCount === 1 ? '' : 's'} kept as partial`
        : '';
    this.center.notify({
      key: 'agentFinished',
      title: `${verb}${kept} · ${info.refLabel}${name ? ` (${name})` : ''}`,
      crRef: dropRef ? undefined : info.ref,
    });
  }

  /**
   * Task 14.7: activation's interrupted sweep (`sweepInterruptedRuns`)
   * closed one or more nonterminal attempts left behind by the last
   * session — one summary, not a toast per target (a reviewer who left
   * several running overnight does not need a flood on the next launch).
   * No single change request to jump to across a batch, so the opener
   * below reveals the app surface rather than opening one review.
   */
  runsInterrupted(count: number): void {
    if (count === 0) return;
    this.center.notify({
      key: 'agentFinished',
      title: `${count} review${count === 1 ? '' : 's'} interrupted by the restart`,
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
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
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
    const pod = this.deps.podStore.activePod;
    const vocabulary = pod ? getProvider(pod.providerId).vocabulary : NEUTRAL_VOCABULARY;
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
          ? { label: `Open ${vocabulary.ciNoun}`, run: () => void vscode.env.openExternal(vscode.Uri.parse(n.webUrl as string)) }
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
    if (!pod) {
      this.scheduleNext(this.intervalMs());
      return;
    }
    // Polling into a shut window is what turns one refusal into a refusal a
    // minute for the rest of the window. Re-arm on the way out rather than
    // trusting whatever brought us here: a focus poll has no timer of its own,
    // and a clock that stepped backwards would fire the resume timer early and
    // leave the notifier with nothing scheduled at all.
    const pauseLeft = this.pausedPodId === pod.id ? this.pausedUntil - Date.now() : 0;
    if (pauseLeft > 0) {
      this.scheduleNext(pauseLeft);
      return;
    }
    this.polling = true;
    this.lastPollAt = Date.now();
    let nextIn = this.intervalMs();
    try {
      // The store runs the pod fetch now (task 6.3/D5): a tick that lands
      // inside the freshness window — a focus poll just after a screen
      // fetched — is served from the held copy and costs nothing, which is
      // the continuation of the focus throttle #50 added. The fetch the
      // store does start declares `background` (task 6.3a) so the provider
      // keeps its interactive reserve, and a rejection surfaces here
      // unchanged, so the rate-limit stand-down below still sees the error.
      const data = await this.deps.appStore.revalidate(pod);
      // Reply polling is per submitted review (handoff §16), scoped to CRs
      // still open — merged and closed ones leave the live set, which also
      // bounds the fan-out as history accumulates.
      const openRefs = new Set(data.changeRequests.map((cr) => `${cr.ref.repoId}!${cr.ref.number}`));
      const submitted = this.deps.reviewHistory
        .list()
        .filter((review) => review.podId === pod.id && openRefs.has(`${review.repoId}!${review.crNumber}`));
      this.submittedReviews = submitted.length;
      // Threads are per change request, not pod-keyed, so the store never
      // holds them: this fan-out stays here, on a connection the notifier
      // builds itself — still declared background, because these requests
      // too run on a schedule nobody asked for and must not be what spends
      // the last of the budget before the user opens a review.
      let threads: ReviewThread[] = [];
      if (submitted.length > 0) {
        const connection = await connectionForPod(pod, this.deps.secrets, { intent: 'background' });
        threads = (
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
      }
      if (this.disposed) return;
      const vocabulary = getProvider(pod.providerId).vocabulary;
      this.center.observe(
        pod.id,
        { fetchedAt: data.fetchedAt, changeRequests: data.changeRequests, ciRuns: data.ciRuns, threads },
        {
          you: pod.username,
          submittedRefs: this.deps.reviewHistory.submittedRefs(),
          formatRef: (number) => vocabulary.formatCrRef(number),
          ciNoun: vocabulary.ciNoun,
        },
      );
      this.resumePolling();
    } catch (e) {
      // A failed poll is nobody's problem — the next tick retries. Except the
      // one failure retrying cannot fix: an exhausted budget answers every
      // request the same way until its window rolls over.
      nextIn = this.afterFailure(e, pod);
    } finally {
      this.polling = false;
      this.scheduleNext(nextIn);
    }
  }

  // ---- cadence ----------------------------------------------------------------------

  private scheduleNext(delayMs: number): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.disposed) return;
    this.timer = setTimeout(() => void this.poll(), delayMs);
  }

  /**
   * How long a focused window must wait before it may poll. The scheduled
   * cadence bounds the background cost; without this the focus path would not
   * be bound by anything, and it is the cheaper of the two to trigger.
   */
  private focusGapMs(): number {
    return Math.max(FOCUS_THROTTLE_MS, this.intervalMs() / 4);
  }

  /** What this pod has earned, given what it costs to poll. */
  private intervalMs(): number {
    const pod = this.deps.podStore.activePod;
    return pollIntervalMs({
      repoCount: pod ? repoIdsOf(pod).length : 0,
      submittedReviews: this.submittedReviews,
      baseSeconds: readPollIntervalSeconds(),
    });
  }

  /**
   * Rate limiting is the one poll failure with a known duration, so it is the
   * one that changes the cadence: stand down until the window the platform
   * named, and tell the user once. Every other failure keeps the ordinary
   * interval — a network blip is not a reason to go quiet for an hour.
   */
  private afterFailure(e: unknown, pod: Pod): number {
    const error = toScmError(e);
    if (error.kind !== 'rateLimited') return this.intervalMs();
    const seconds = error.retryAfterSeconds ?? BLIND_BACKOFF_SECONDS;
    const waitMs = Math.min(Math.max(seconds, 0) * 1000 + RESUME_MARGIN_MS, MAX_PAUSE_MS);
    this.pausedUntil = Date.now() + waitMs;
    this.pausedPodId = pod.id;
    this.announcePause(pod, this.pausedUntil);
    return waitMs;
  }

  /**
   * The status bar is repainted every time, because it shows a resume time
   * that moves. The toast fires once per exhaustion — the flag clears only on
   * a poll that succeeds, so a resume attempt that is refused again extends
   * the pause silently instead of announcing it a second time.
   */
  private announcePause(pod: Pod, resumesAt: number): void {
    const vocabulary = tryGetProvider(pod.providerId)?.vocabulary ?? NEUTRAL_VOCABULARY;
    this.deps.onPollPaused({ platformName: vocabulary.platformName, resumesAt });
    if (this.pauseAnnounced) return;
    this.pauseAnnounced = true;
    void vscode.window.showWarningMessage(
      `Verdict paused background updates — ${vocabulary.platformName} is rate limiting this account.`
      + ' The status bar shows when they resume; opening and submitting reviews still work.',
    );
  }

  private resumePolling(): void {
    if (this.pausedUntil === 0 && !this.pauseAnnounced) return;
    this.pausedUntil = 0;
    this.pausedPodId = undefined;
    this.pauseAnnounced = false;
    this.deps.onPollPaused(undefined);
  }
}
