/**
 * The Posted-reviews panel (spec §9): joins the review history with live
 * discussions, one connection per pod, statuses derived per thread.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import type { PostedReviewView } from '../app/postedReviews';
import { ThreadFlags, buildPostedReview, composeSecondOpinion, crKey } from '../app/postedReviews';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { getProvider } from '../platform/registry';
import { formatAge } from './dashboardState';
import { escapeHtml, renderFallbackHtml } from './dashboardHtml';
import type { PostedMessage, PostedRow } from './postedReviewsHtml';
import { renderPostedReviewsHtml } from './postedReviewsHtml';

export interface PostedReviewsDeps {
  podStore: PodStore;
  secrets: SecretStore;
  globalState: KeyValueStore;
  /** Re-run agent on the fix — routes back into the review flow. */
  openReviewFlow: (ref: { repoId: string; number: string }) => void;
}

export class PostedReviewsPanel {
  private static current: PostedReviewsPanel | undefined;

  static async show(
    deps: PostedReviewsDeps,
    focusRef?: { repoId: string; number: string },
  ): Promise<void> {
    if (PostedReviewsPanel.current && !PostedReviewsPanel.current.disposed) {
      PostedReviewsPanel.current.focusRef = focusRef;
      PostedReviewsPanel.current.panel.reveal();
      await PostedReviewsPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.posted',
      'Verdict: Posted reviews',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    PostedReviewsPanel.current = new PostedReviewsPanel(panel, deps);
    PostedReviewsPanel.current.focusRef = focusRef;
    await PostedReviewsPanel.current.refresh();
  }

  static async refreshIfOpen(): Promise<void> {
    await PostedReviewsPanel.current?.refresh();
  }

  private disposed = false;
  private refreshSeq = 0;
  private focusRef?: { repoId: string; number: string };
  private pod?: ReturnType<PodStore['list']>[number];
  private rows: PostedRow[] = [];
  private selectedIndex = 0;
  private expandedThreadId?: string;
  private opinions: Record<string, string> = {};

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PostedReviewsDeps,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (PostedReviewsPanel.current === this) PostedReviewsPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((m: PostedMessage) => void this.onMessage(m));
  }

  private selectedView(): PostedReviewView | undefined {
    return this.rows[this.selectedIndex]?.view;
  }

  private async onMessage(m: PostedMessage): Promise<void> {
    // The pod captured at refresh time — never pair a freshly-switched
    // pod's connection with rows fetched for the previous one.
    const pod = this.pod;
    if (!pod) return;
    const view = this.selectedView();
    try {
      switch (m.type) {
        case 'selectReview':
          this.selectedIndex = m.index;
          this.expandedThreadId = undefined;
          this.render();
          return;
        case 'toggleThread':
          this.expandedThreadId = this.expandedThreadId === m.threadId ? undefined : m.threadId;
          this.render();
          return;
        case 'resolve': {
          if (!view) return;
          const connection = await connectionForPod(pod, this.deps.secrets);
          await connection.resolveThread(
            { repoId: view.repoId, number: view.crNumber },
            m.threadId,
            m.resolved,
          );
          if (!m.resolved) {
            await new ThreadFlags(this.deps.globalState).unconcede(
              crKey(view.repoId, view.crNumber),
              m.threadId,
            );
          }
          await this.refresh();
          return;
        }
        case 'concede': {
          if (!view) return;
          // Resolve on the platform FIRST — the local flag only lands once
          // the resolution stuck, so a failure leaves no phantom concede.
          const connection = await connectionForPod(pod, this.deps.secrets);
          await connection.resolveThread(
            { repoId: view.repoId, number: view.crNumber },
            m.threadId,
            true,
          );
          await new ThreadFlags(this.deps.globalState).concede(
            crKey(view.repoId, view.crNumber),
            m.threadId,
          );
          await this.refresh();
          return;
        }
        case 'reply': {
          if (!view) return;
          const connection = await connectionForPod(pod, this.deps.secrets);
          await connection.replyToThread(
            { repoId: view.repoId, number: view.crNumber },
            m.threadId,
            m.text,
          );
          await this.refresh();
          return;
        }
        case 'secondOpinion': {
          const thread = view?.threads.find((t) => t.threadId === m.threadId);
          if (thread) {
            this.opinions[m.threadId] = composeSecondOpinion(thread);
            this.expandedThreadId = m.threadId;
            this.render();
          }
          return;
        }
        case 'rerun':
          if (view) this.deps.openReviewFlow({ repoId: view.repoId, number: view.crNumber });
          return;
        case 'refresh':
          await this.refresh();
          return;
        case 'backToDashboard':
          void vscode.commands.executeCommand('codeVerdict.openDashboard');
          return;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Verdict: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  async refresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    const canRender = (): boolean => !this.disposed && seq === this.refreshSeq;
    const pod = this.deps.podStore.activePod;
    if (!pod) {
      if (canRender()) {
        this.panel.webview.html = renderFallbackHtml('<p>No pod configured.</p>');
      }
      return;
    }
    try {
      const history = new ReviewHistory(this.deps.globalState)
        .list()
        .filter((r) => r.podId === pod.id)
        .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
      const connection = await connectionForPod(pod, this.deps.secrets);
      const flags = new ThreadFlags(this.deps.globalState);
      const vocabulary = getProvider(pod.providerId).vocabulary;
      const crs = await connection.listOpenChangeRequests([
        ...new Set(history.map((r) => r.repoId)),
      ]);
      const now = Date.now();
      const rows = await Promise.all(
        history.map(async (entry) => {
          const view = await buildPostedReview(
            connection,
            entry,
            pod.username ?? 'you',
            flags.conceded(crKey(entry.repoId, entry.crNumber)),
          );
          const cr = crs.find(
            (c) => c.ref.repoId === entry.repoId && c.ref.number === entry.crNumber,
          );
          return {
            view,
            refLabel: vocabulary.formatCrRef(entry.crNumber),
            title: cr?.title ?? `${vocabulary.formatCrRef(entry.crNumber)}`,
            project: pod.repos?.find((r) => r.id === entry.repoId)?.name ?? entry.repoId,
            age: formatAge(entry.submittedAt, now),
          } satisfies PostedRow;
        }),
      );
      if (!canRender()) return;
      this.pod = pod;
      this.rows = rows;
      if (this.focusRef) {
        const wanted = this.focusRef;
        const index = rows.findIndex(
          (r) => r.view.repoId === wanted.repoId && r.view.crNumber === wanted.number,
        );
        if (index >= 0) this.selectedIndex = index;
        this.focusRef = undefined;
      }
      if (this.selectedIndex >= rows.length) this.selectedIndex = 0;
      this.render();
    } catch (e) {
      if (!canRender()) return;
      this.panel.webview.html = renderFallbackHtml(
        `<p>Could not load posted reviews: ${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`,
      );
    }
  }

  private render(): void {
    if (this.disposed) return;
    const nonce = crypto.randomBytes(16).toString('hex');
    this.panel.webview.html = renderPostedReviewsHtml(
      {
        podName: this.pod?.name ?? this.deps.podStore.activePod?.name ?? '',
        now: Date.now(),
        waitingOnYouTotal: this.rows.reduce((n, r) => n + r.view.counts.you, 0),
        rows: this.rows,
        selectedIndex: this.selectedIndex,
        expandedThreadId: this.expandedThreadId,
        opinions: this.opinions,
      },
      nonce,
    );
  }
}
