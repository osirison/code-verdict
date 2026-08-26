import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { detectChangesets } from '../app/changesets';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { fetchPodData, repoIdsOf } from '../app/podQuery';
import { changesetDetectionOptions } from './changesetOptions';
import { COMMANDS, INTERNAL_COMMANDS } from '../commands';
import {
  renderSidebarHtml,
  type SidebarActiveReview,
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

export interface VerdictSidebarDeps {
  secrets: vscode.SecretStorage;
  extensionUri: vscode.Uri;
  /** Manual changesets + detection settings feed the Changesets nav row. */
  globalState: vscode.Memento;
  openCr: (ref: { repoId: string; number: string }) => void;
  openChangeset?: (changesetId: string) => void;
  /** The manual route stays reachable when nothing was detected (handoff §16). */
  createChangeset?: () => void;
  selectFinding?: (itemId: string) => void;
  selectThread?: (threadId: string) => void;
  useDemoPod?: () => void;
  onPodChanged?: () => void;
}

export class VerdictSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private refreshSeq = 0;
  private activeReview?: SidebarActiveReview;
  private pendingReview?: SidebarPendingReview;
  private threads?: SidebarThreads;
  private setup?: SidebarSetup;
  private activeRoute?: string;

  constructor(
    private readonly podStore: PodStore,
    private readonly deps: VerdictSidebarDeps,
  ) {}

  refresh(): void {
    void this.render();
  }

  setActiveReview(review?: SidebarActiveReview): void {
    this.activeReview = review;
    void this.render();
  }

  /** Spec §3 — a review that exists but has not run yet. */
  setPendingReview(pending?: SidebarPendingReview): void {
    this.pendingReview = pending;
    void this.render();
  }

  setThreads(threads?: SidebarThreads): void {
    this.threads = threads;
    void this.render();
  }

  setSetup(setup?: SidebarSetup): void {
    this.setup = setup;
    void this.render();
  }

  setActiveRoute(route?: string): void {
    this.activeRoute = route;
    void this.render();
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
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.deps.extensionUri, 'media')],
    };
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: SidebarMessage) => void this.onMessage(message));
    void this.render();
  }

  /**
   * Every screen's state carries the same chrome — the per-screen shells and
   * the codicon assets ride along whichever data path produced the lists.
   */
  private paint(view: vscode.WebviewView, state: SidebarViewState): void {
    view.webview.html = renderSidebarHtml(
      {
        ...state,
        setup: this.setup ?? state.setup,
        threads: this.threads,
        activeReview: this.activeReview,
        pendingReview: this.pendingReview,
        activeRoute: this.activeRoute,
        codicons: this.codicons(view.webview),
      },
      crypto.randomBytes(16).toString('hex'),
    );
  }

  private async render(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const seq = ++this.refreshSeq;
    const pod = this.podStore.activePod;
    if (!pod) {
      // No pod yet: the sidebar *is* the setup checklist (spec §1), including
      // the demo-pod escape hatch, whether or not the wizard is open.
      this.paint(view, {
        vocabulary: NEUTRAL_VOCABULARY,
        podName: 'No active pod',
        podMeta: 'Connect to begin',
        pods: [],
        mergeRequests: [],
        issues: [],
        waitingOnYou: 0,
        setup: this.setup ?? IDLE_SETUP,
      });
      return;
    }
    try {
      const data = await fetchPodData(await connectionForPod(pod, this.deps.secrets), pod, Date.now());
      if (seq !== this.refreshSeq || this.view !== view) return;
      // The nav row's "N open" rides the fetch that just happened — the
      // changesets are re-derived, never re-fetched.
      const changesets = detectChangesets(
        pod,
        data.changeRequests,
        data.workItems,
        changesetDetectionOptions(this.deps.globalState, pod.id),
      ).map((changeset) => ({ id: changeset.id, name: changeset.name }));
      this.paint(view, { ...toSidebarViewState(data, this.podStore.list()), changesets });
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

  constructor() {
    // Descending priority keeps the segments in spec order, left to right.
    this.verdict = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.agent = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
    this.keys = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 88);
    this.bell = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 87);
    this.paused = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 86);
    this.keys.text = '$(keyboard) ? keys';
    this.keys.tooltip = 'Verdict keyboard map';
    this.keys.command = INTERNAL_COMMANDS.keyboardHelp;
    this.agent.command = COMMANDS.selectAgent;
    this.bell.command = INTERNAL_COMMANDS.showNotifications;
    this.setActiveReview(undefined);
    this.verdict.show();
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
  }
}
