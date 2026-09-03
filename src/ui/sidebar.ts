import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { AppStore } from '../app/appStore';
import { detectChangesets } from '../app/changesets';
import type { PodStore } from '../app/pods';
import { repoIdsOf } from '../app/podQuery';
import type { PodData } from '../app/podQuery';
import { changesetDetectionOptions } from './changesetOptions';
import { COMMANDS, INTERNAL_COMMANDS } from '../commands';
import {
  renderSidebarHtml,
  renderSidebarRegions,
  type SidebarActiveReview,
  type SidebarActiveRun,
  type SidebarMessage,
  type SidebarPendingReview,
  type SidebarSetup,
  type SidebarThreads,
  type SidebarViewState,
} from './sidebarHtml';
import { toSidebarViewState } from './sidebarState';
import { tryGetProvider } from '../platform/registry';
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import { approxDelay, repoCountOf } from './vocab';
import type { PollPause } from './notifier';
import type { CodiconAssets } from './theme';

/** The checklist before the wizard is open — nothing done, everything ahead. */
const IDLE_SETUP: SidebarSetup = {
  steps: [
    { label: `Connect ${NEUTRAL_VOCABULARY.platformName}`, done: false },
    { label: 'Name the pod', done: false },
    { label: `Add ${NEUTRAL_VOCABULARY.repoNounPlural}`, done: false },
  ],
};

/**
 * Everything the paint path needs that only a pod fetch — never a triage
 * action — can change (issue #46 task 2.1). Held across calls so
 * `setActiveReview`/`setPendingReview`/`setThreads`/`setActiveRoute`/
 * `setActiveRuns` can repaint from it without ever reaching the platform;
 * `render()` is the only writer.
 */
type SidebarDataState = Pick<
  SidebarViewState,
  'vocabulary' | 'podName' | 'podMeta' | 'pods' | 'mergeRequests' | 'issues' | 'waitingOnYou' | 'changesets'
>;

/** Seeded before the first fetch even starts, so a patch racing that window
 * has a defined base rather than nothing to patch onto. */
const NO_POD_STATE: SidebarDataState = {
  vocabulary: NEUTRAL_VOCABULARY,
  podName: 'No active pod',
  podMeta: 'Connect to begin',
  pods: [],
  mergeRequests: [],
  issues: [],
  waitingOnYou: 0,
};

function isVerdictReadyMessage(message: unknown): boolean {
  return typeof message === 'object' && message !== null && 'type' in message
    && (message as { type?: unknown }).type === 'verdictReady';
}

export interface VerdictSidebarDeps {
  /** The shared pod-data copy every surface reads (task 6.2). */
  appStore: AppStore;
  extensionUri: vscode.Uri;
  /** Manual changesets + detection settings feed the Changesets nav row. */
  globalState: vscode.Memento;
  openCr: (ref: { repoId: string; number: string }) => void;
  openChangeset?: (changesetId: string) => void;
  /** The manual route stays reachable when nothing was detected (handoff §16). */
  createChangeset?: () => void;
  selectFinding?: (itemId: string) => void;
  selectThread?: (threadId: string) => void;
  /** The ✕ on a run row — stop that review and free its slot. */
  cancelRun?: (key: string) => void;
  useDemoPod?: () => void;
  onPodChanged?: () => void;
}

export class VerdictSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private refreshSeq = 0;
  /**
   * Whether the current webview's REGIONS_SCRIPT has armed itself and
   * echoed `verdictReady` — the same handshake `AppSurface` uses for its
   * panels (appSurface.ts:22-40, 113-131), reimplemented here because a
   * `WebviewView` is not an `AppRoute` (issue #46 task 2.5). `patch()`
   * falls back to a full assignment whenever this is false, so readiness is
   * never load-bearing for correctness, only for avoiding it.
   */
  private ready = false;
  private activeReview?: SidebarActiveReview;
  private pendingReview?: SidebarPendingReview;
  private threads?: SidebarThreads;
  private setup?: SidebarSetup;
  private activeRoute?: string;
  private activeRuns: SidebarActiveRun[] = [];
  /** The data path's last result — see `SidebarDataState`. */
  private podState: SidebarDataState = NO_POD_STATE;

  constructor(
    private readonly podStore: PodStore,
    private readonly deps: VerdictSidebarDeps,
  ) {
    // Pod data now reaches the sidebar through the store (task 6.4): a poll
    // or another screen's fetch that changed the active pod's data repaints
    // the lists without this view fetching anything of its own. Never
    // unsubscribed — the provider lives as long as the extension host, so
    // there is no dispose path for a dangling listener to outlive.
    deps.appStore.subscribe((data) => {
      if (this.view && data.pod.id === this.podStore.activePod?.id) this.applyPodData(data);
    });
  }

  refresh(): void {
    void this.render();
  }

  setActiveReview(review?: SidebarActiveReview): void {
    this.activeReview = review;
    this.patch();
  }

  /** Spec §3 — a review that exists but has not run yet. */
  setPendingReview(pending?: SidebarPendingReview): void {
    this.pendingReview = pending;
    this.patch();
  }

  setThreads(threads?: SidebarThreads): void {
    this.threads = threads;
    this.patch();
  }

  setSetup(setup?: SidebarSetup): void {
    this.setup = setup;
    void this.render();
  }

  setActiveRoute(route?: string): void {
    this.activeRoute = route;
    this.patch();
  }

  /**
   * Reviews in flight. Shown whatever screen the sidebar is on: a background
   * run the reviewer cannot see is a run they will not know finished, and one
   * they cannot stop from where they are is one they have to navigate to first.
   */
  setActiveRuns(runs: readonly SidebarActiveRun[]): void {
    this.activeRuns = [...runs];
    this.patch();
  }

  /** The bundled codicon stylesheet, addressed for this webview's origin. */
  private codicons(webview: vscode.Webview): CodiconAssets | undefined {
    const styleUri = webview.asWebviewUri?.(
      vscode.Uri.joinPath(this.deps.extensionUri, 'media', 'codicons', 'codicon.css'),
    );
    return styleUri ? { styleUri: styleUri.toString(), cspSource: webview.cspSource } : undefined;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    // A freshly (re)resolved view has armed nothing yet, whatever a prior
    // view on this same provider instance had done.
    this.ready = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
    };
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (isVerdictReadyMessage(message)) {
        if (this.ready) {
          // The document reloaded out from under this view ("Developer:
          // Reload Webviews" or similar recreates it from whatever
          // webview.html last assigned, which a patch never touches, so it
          // can be stale) — REGIONS_SCRIPT re-armed and posted verdictReady
          // again. Same handshake as AppSurface's onReload
          // (appSurface.ts:113-131): reset readiness and repaint the full
          // document from held state so the new DOM matches it.
          this.ready = false;
          this.paint(view, this.podState);
          return;
        }
        this.ready = true;
        return;
      }
      void this.onMessage(message as SidebarMessage);
    });
    void this.render();
  }

  /**
   * Merges the data path's held result with the volatile fields every
   * triage-adjacent setter owns, plus the codicon assets for this webview's
   * origin. The setup checklist's IDLE_SETUP fallback is re-derived from the
   * *current* active pod rather than baked in at fetch time, so it stays
   * correct even across a `patch()` that never re-fetches.
   */
  private currentState(webview: vscode.Webview): SidebarViewState {
    return {
      ...this.podState,
      setup: this.setup ?? (this.podStore.activePod ? undefined : IDLE_SETUP),
      threads: this.threads,
      activeReview: this.activeReview,
      pendingReview: this.pendingReview,
      activeRoute: this.activeRoute,
      activeRuns: this.activeRuns,
      codicons: this.codicons(webview),
    };
  }

  /**
   * The paint path (issue #46 task 2.1): a full document assignment from
   * already-held state, no fetch. Used by the data path (render()) after a
   * fetch lands, and as `patch()`'s not-ready fallback.
   */
  private paint(view: vscode.WebviewView, data: SidebarDataState): void {
    this.podState = data;
    // Mirrors AppSurface.setHtml (appSurface.ts:67-70): a full assignment
    // always invalidates readiness, so a patch racing right after this
    // always falls back to another full assignment instead of posting into
    // a document that has not re-armed REGIONS_SCRIPT yet.
    this.ready = false;
    view.webview.html = renderSidebarHtml(this.currentState(view.webview), crypto.randomBytes(16).toString('hex'));
  }

  /**
   * Patches every region a triage-adjacent state change can touch, instead
   * of fetching and reassigning the whole document (issue #46 task 2.1/2.3
   * — recording a verdict used to cost three platform requests and a full
   * webview.html rebuild for pod data that had not changed). Never reaches
   * the platform: `renderSidebarRegions` recomputes the setup → threads →
   * triage → pending → lists precedence fresh from currently-held state
   * every time, so whichever setter fired, the region precedence now picks
   * is the one that repaints — never a stale sibling left behind.
   */
  private patch(): void {
    const view = this.view;
    if (!view) return;
    if (!this.ready) {
      // Not yet armed (page still loading, or resolveWebviewView's own
      // first render() has not painted yet) — readiness is never
      // load-bearing for correctness, so fall back to a full assignment
      // from the same held state (appSurface.ts:31-33).
      this.paint(view, this.podState);
      return;
    }
    const regions = renderSidebarRegions(this.currentState(view.webview));
    void view.webview.postMessage({ type: 'verdict:regions', regions });
  }

  /**
   * Derives the data-path state from a pod snapshot and repaints in full.
   * A full paint, not a patch, because the pod header and the CR/work-item
   * lists deliberately live outside the patchable regions (see
   * renderSidebarHtml) — only the data path ever changes them, and this is
   * the data path's landing point, for both a render() read and a store
   * notification.
   */
  private applyPodData(data: PodData): void {
    const view = this.view;
    const pod = this.podStore.activePod;
    if (!view || !pod) return;
    // The nav row's "N open" rides the fetch that just happened — the
    // changesets are re-derived, never re-fetched.
    const changesets = detectChangesets(
      pod,
      data.changeRequests,
      data.workItems,
      changesetDetectionOptions(this.deps.globalState, pod.id),
    ).map((changeset) => ({ id: changeset.id, name: changeset.name }));
    this.paint(view, { ...toSidebarViewState(data, this.podStore.list()), changesets });
  }

  private async render(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const seq = ++this.refreshSeq;
    const pod = this.podStore.activePod;
    if (!pod) {
      // No pod yet: the sidebar *is* the setup checklist (spec §1), including
      // the demo-pod escape hatch, whether or not the wizard is open —
      // handled by currentState()'s IDLE_SETUP fallback, not stored here.
      this.paint(view, NO_POD_STATE);
      return;
    }
    try {
      // The store serves this read (task 6.2): held data paints at once — a
      // refresh inside the freshness window repaints from the held copy and
      // issues nothing — and a stale entry revalidates behind the paint,
      // the constructor's subscription repainting if it changed anything.
      const read = this.deps.appStore.read(pod);
      const data = read.data ?? (await read.fetch!);
      if (seq !== this.refreshSeq || this.view !== view) return;
      this.applyPodData(data);
    } catch {
      if (seq !== this.refreshSeq || this.view !== view) return;
      // Looked up without throwing: this is the error path, and a pod naming
      // an unregistered provider must be reported here, not crash the handler.
      const provider = tryGetProvider(pod.providerId);
      this.paint(view, {
        vocabulary: provider?.vocabulary ?? NEUTRAL_VOCABULARY,
        podName: pod.name,
        podMeta: provider
          ? `Could not reach ${provider.displayName}`
          : `Provider "${pod.providerId}" is not available`,
        pods: this.podStore.list().map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          meta: repoCountOf(
            tryGetProvider(candidate.providerId)?.vocabulary ?? NEUTRAL_VOCABULARY,
            repoIdsOf(candidate).length,
          ),
          active: candidate.id === pod.id,
        })),
        mergeRequests: [],
        issues: [],
        waitingOnYou: 0,
      });
    }
  }

  private async onMessage(message: SidebarMessage): Promise<void> {
    switch (message.type) {
      case 'refresh':
        await this.render();
        break;
      case 'selectPod':
        await this.podStore.setActive(message.podId);
        this.deps.onPodChanged?.();
        await this.render();
        break;
      case 'deletePod':
        // Straight to the command rather than PodStore.remove here — the modal
        // confirmation and the orphan cleanup live there, and a second copy of
        // that sequence is a second place to get the shared-token rule wrong.
        await vscode.commands.executeCommand(COMMANDS.deletePod, message.podId);
        break;
      case 'openDashboard':
        await vscode.commands.executeCommand(COMMANDS.openDashboard);
        break;
      case 'openChangesets':
        // "Opens the active changeset, or the first one when none is active"
        // (README §15) — with nothing detected, offer the manual route.
        if (message.firstId) this.deps.openChangeset?.(message.firstId);
        else this.deps.createChangeset?.();
        break;
      case 'openPostedReviews':
        await vscode.commands.executeCommand('codeVerdict.internal.postedReviews');
        break;
      case 'openTuning':
        await vscode.commands.executeCommand(COMMANDS.selectAgent);
        break;
      case 'openSettings':
        await vscode.commands.executeCommand(COMMANDS.editCriteria);
        break;
      case 'selectFinding':
        this.deps.selectFinding?.(message.itemId);
        break;
      case 'cancelRun':
        this.deps.cancelRun?.(message.key);
        break;
      case 'selectThread':
        this.deps.selectThread?.(message.threadId);
        break;
      case 'useDemoPod':
        this.deps.useDemoPod?.();
        break;
      case 'openReviewTab':
        await vscode.commands.executeCommand(COMMANDS.openReview);
        break;
      case 'openPostedReviewTab':
        await vscode.commands.executeCommand(INTERNAL_COMMANDS.postedReviews);
        break;
      case 'openCr':
        this.deps.openCr({ repoId: message.repoId, number: message.number });
        break;
      case 'openIssue':
        // Web page, not an in-editor view (issue #40) — that needs a
        // `getWorkItem` provider capability no provider declares yet.
        void vscode.env.openExternal(vscode.Uri.parse(message.webUrl));
        break;
    }
  }
}

/**
 * Verdict's status bar segments (spec §14).
 *
 * The spec's bar is drawn from the prototype, which mocks the whole VS Code
 * window — its `⎇ branch` and `✕ 1 ⚠ 0` segments are the editor's own git and
 * problems indicators, and duplicating them would put two branch names on one
 * bar. Verdict therefore contributes the three segments that are actually its
 * own: the review state, the agent doing the reviewing, the keys hint, and
 * the `🔔` notifications count.
 */
export class VerdictStatusBar {
  private readonly verdict: vscode.StatusBarItem;
  private readonly agent: vscode.StatusBarItem;
  private readonly keys: vscode.StatusBarItem;
  private readonly bell: vscode.StatusBarItem;
  private readonly paused: vscode.StatusBarItem;
  private readonly runs: vscode.StatusBarItem;

  constructor() {
    // Descending priority keeps the segments in spec order, left to right.
    this.verdict = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.agent = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.keys = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.bell = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
    this.paused = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 86);
    // Below the paused segment, so the segments stay in spec order left to right.
    this.runs = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 85);
    this.runs.command = INTERNAL_COMMANDS.showActiveRuns;
    this.keys.text = '$(keyboard) ? keys';
    this.keys.tooltip = 'Verdict keyboard map';
    this.keys.command = INTERNAL_COMMANDS.keyboardHelp;
    this.agent.command = COMMANDS.selectAgent;
    this.bell.command = INTERNAL_COMMANDS.showNotifications;
    this.setActiveReview(undefined);
    this.verdict.show();
  }

  /**
   * How many reviews are in flight. Independent of every other segment: a run
   * belongs to the extension now, not to whatever review happens to be open, so
   * this is the one place a reviewer working somewhere else can see that
   * something is happening. Hidden at zero, like the bell.
   */
  setActiveRuns(count: number): void {
    if (count === 0) {
      this.runs.hide();
      return;
    }
    this.runs.text = `$(sync~spin) ${count}`;
    this.runs.tooltip = `${count} review${count === 1 ? '' : 's'} running — click to list them or cancel one`;
    this.runs.show();
  }

  /**
   * The badge queue count. Independent of the review segments —
   * notifications arrive with no review open. Hidden at zero: an empty
   * bell is noise, not information.
   */
  setNotifications(count: number): void {
    if (count === 0) {
      this.bell.hide();
      return;
    }
    this.bell.text = `$(bell) ${count}`;
    this.bell.tooltip = `${count} Verdict notification${count === 1 ? '' : 's'} waiting — click to view`;
    this.bell.show();
  }

  /**
   * Background polling stopped, and when it starts again. Hidden while polling
   * runs — the ordinary state needs no segment.
   *
   * This is the surface for it rather than a toast: the pause lasts as long as
   * the platform's window, up to an hour, and the user's question during that
   * hour is "is it still paused, and until when?" A toast cannot answer a
   * question asked later. The notifier toasts once, on the way in.
   */
  setPollPaused(pause?: PollPause): void {
    if (!pause) {
      this.paused.hide();
      return;
    }
    const wait = approxDelay(Math.max(0, Math.round((pause.resumesAt - Date.now()) / 1000)));
    this.paused.text = '$(clock) Verdict: updates paused';
    this.paused.tooltip =
      `${pause.platformName} is rate limiting this account — background updates resume in ${wait ?? 'a moment'}.`
      + ' Opening and submitting reviews still work.';
    this.paused.show();
  }

  setActiveReview(review?: SidebarActiveReview): void {
    if (!review) {
      this.verdict.text = '$(verified) Verdict: no active review';
      this.verdict.tooltip = 'Code Verdict — open the pod dashboard';
      this.verdict.command = COMMANDS.openDashboard;
      // The agent and keys segments describe a review in progress; with no
      // review they are noise, not information.
      this.agent.hide();
      this.keys.hide();
      return;
    }
    const left = review.counts.undecided;
    // Changeset scope: "⧉ Verdict: 4 MRs · N left" (spec §15).
    this.verdict.text = `$(verified) ${review.changeset ? '⧉ ' : ''}Verdict: ${review.refLabel ?? review.headline} · ${
      left === 0 ? 'all triaged' : `${left} left`
    }`;
    this.verdict.tooltip = `${review.headline} — ${review.counts.accepted} accepted, ${review.counts.rejected} rejected, ${review.counts.skipped} skipped`;
    this.verdict.command = COMMANDS.openReview;
    this.agent.text = review.agent;
    this.agent.tooltip = `Reviewed with ${review.agent} — click to switch agent`;
    this.agent.show();
    this.keys.show();
  }

  dispose(): void {
    this.verdict.dispose();
    this.agent.dispose();
    this.keys.dispose();
    this.bell.dispose();
    this.paused.dispose();
    this.runs.dispose();
  }
}
