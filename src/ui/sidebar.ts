import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { fetchPodData, repoIdsOf } from '../app/podQuery';
import { COMMANDS } from '../commands';
import { renderSidebarHtml, type SidebarActiveReview, type SidebarMessage, type SidebarViewState } from './sidebarHtml';
import { toSidebarViewState } from './sidebarState';

export interface VerdictSidebarDeps {
  secrets: vscode.SecretStorage;
  openCr: (ref: { repoId: string; number: string }) => void;
  selectFinding?: (itemId: string) => void;
  onPodChanged?: () => void;
}

export class VerdictSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private refreshSeq = 0;
  private activeReview?: SidebarActiveReview;
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

  setActiveRoute(route?: string): void {
    this.activeRoute = route;
    void this.render();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.webview.onDidReceiveMessage((message: SidebarMessage) => void this.onMessage(message));
    void this.render();
  }

  private async render(): Promise<void> {
    const view = this.view;
    if (!view) return;
    const seq = ++this.refreshSeq;
    const pod = this.podStore.activePod;
    if (!pod) {
      view.webview.html = renderSidebarHtml({
        podName: 'No active pod',
        podMeta: 'Connect GitLab to begin',
        pods: [],
        mergeRequests: [],
        issues: [],
        waitingOnYou: 0,
      }, crypto.randomBytes(16).toString('hex'));
      return;
    }
    try {
      const data = await fetchPodData(await connectionForPod(pod, this.deps.secrets), pod, Date.now());
      if (seq !== this.refreshSeq || this.view !== view) return;
      const state: SidebarViewState = toSidebarViewState(data, this.podStore.list());
      view.webview.html = renderSidebarHtml({ ...state, activeReview: this.activeReview, activeRoute: this.activeRoute }, crypto.randomBytes(16).toString('hex'));
    } catch {
      if (seq !== this.refreshSeq || this.view !== view) return;
      view.webview.html = renderSidebarHtml({
        podName: pod.name,
        podMeta: 'Could not reach GitLab',
        pods: this.podStore.list().map((candidate) => ({
          id: candidate.id,
          name: candidate.name,
          meta: `${repoIdsOf(candidate).length} projects`,
          active: candidate.id === pod.id,
        })),
        mergeRequests: [],
        issues: [],
        waitingOnYou: 0,
      }, crypto.randomBytes(16).toString('hex'));
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
      case 'openReviewTab':
        await vscode.commands.executeCommand(COMMANDS.openReview);
        break;
      case 'openCr':
        this.deps.openCr({ repoId: message.repoId, number: message.number });
        break;
    }
  }
}

/**
 * The Verdict segment of the status bar (spec §14). State-dependent: it names
 * the merge request under review and how much triage is left, so the count is
 * visible without the sidebar open, and reverts to "no active review" the
 * moment the review tab closes.
 */
export class VerdictStatusBar {
  private readonly item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.setActiveReview(undefined);
    this.item.show();
  }

  setActiveReview(review?: SidebarActiveReview): void {
    if (!review) {
      this.item.text = '$(verified) Verdict: no active review';
      this.item.tooltip = 'Code Verdict — open the pod dashboard';
      this.item.command = COMMANDS.openDashboard;
      return;
    }
    const left = review.counts.undecided;
    this.item.text = `$(verified) Verdict: ${review.refLabel ?? review.headline} · ${
      left === 0 ? 'all triaged' : `${left} left`
    }`;
    this.item.tooltip = `${review.headline} — ${review.counts.accepted} accepted, ${review.counts.rejected} rejected, ${review.counts.skipped} skipped`;
    this.item.command = COMMANDS.openReview;
  }

  dispose(): void {
    this.item.dispose();
  }
}
