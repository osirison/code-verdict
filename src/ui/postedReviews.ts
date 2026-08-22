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
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import { formatAge } from './dashboardState';
import { escapeHtml, renderFallbackHtml } from './dashboardHtml';
import type { PostedMessage, PostedRow } from './postedReviewsHtml';
import { renderPostedReviewsHtml } from './postedReviewsHtml';
import { AppSurface, type AppRoute } from './appSurface';
import type { SidebarThread, SidebarThreads } from './sidebarHtml';
import { COMMANDS } from '../commands';

export interface PostedReviewsDeps {
  podStore: PodStore;
  secrets: SecretStore;
  globalState: KeyValueStore;
  /** Re-run agent on the fix — routes back into the review flow. */
  openReviewFlow: (ref: { repoId: string; number: string }) => void;
  /** Spec §9: the sidebar mirrors this screen's threads while it is open. */
  onSidebarThreads?: (threads?: SidebarThreads) => void;
}

export class PostedReviewsPanel {
  private static current: PostedReviewsPanel | undefined;

  static async show(
    deps: PostedReviewsDeps,
    focusRef?: { repoId: string; number: string },
  ): Promise<void> {
    if (PostedReviewsPanel.current && !PostedReviewsPanel.current.disposed) {
      PostedReviewsPanel.current.focusRef = focusRef;
      AppSurface.reveal();
      await PostedReviewsPanel.current.refresh();
      return;
    }
    const route = AppSurface.show('posted', 'Verdict: Posted reviews', () => void vscode.commands.executeCommand(COMMANDS.openDashboard));
    PostedReviewsPanel.current = new PostedReviewsPanel(route, deps);
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
    private readonly route: AppRoute,
    private readonly deps: PostedReviewsDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      this.deps.onSidebarThreads?.(undefined);
      if (PostedReviewsPanel.current === this) PostedReviewsPanel.current = undefined;
    });
    route.onMessage((message) => void this.onMessage(message as PostedMessage));
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

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

  /** Select a thread from the sidebar list — expands it on this screen. */
  static selectThread(threadId: string): void {
    const panel = PostedReviewsPanel.current;
    if (!panel || panel.disposed) return;
    const index = panel.rows.findIndex((row) =>
      row.view.threads.some((thread) => thread.threadId === threadId),
    );
    if (index < 0) return;
    panel.selectedIndex = index;
    panel.expandedThreadId = threadId;
    panel.render();
    AppSurface.reveal();
  }

  private publishSidebarThreads(): void {
    const view = this.selectedView();
    if (!view) {
      this.deps.onSidebarThreads?.(undefined);
      return;
    }
    const row = this.rows[this.selectedIndex];
    const count = (status: SidebarThread['status']): number =>
      view.threads.filter((thread) => thread.status === status).length;
    const summary = ([
      ['awaiting', 'waiting on you'],
      ['replied', 'replied'],
      ['resolved', 'resolved'],
      ['conceded', 'conceded'],
      ['stale', 'anchor lost'],
    ] as Array<[SidebarThread['status'], string]>)
      .filter(([status]) => count(status) > 0)
      .map(([status, label]) => ({ status, label: `${count(status)} ${label}` }));
    this.deps.onSidebarThreads?.({
      headline: `${row?.refLabel ?? view.crNumber} · ${row?.title ?? ''}`.trim(),
      context: `${row?.project ?? view.repoId} · ${view.agentLabel}`,
      summary,
      threads: view.threads.map((thread) => ({
        id: thread.threadId,
        title: thread.title,
        meta: thread.file ? `${thread.file}${thread.line ? `:${thread.line}` : ''}` : thread.status,
        status: thread.status,
        selected: thread.threadId === this.expandedThreadId,
      })),
    });
  }

  private render(): void {
    if (this.disposed) return;
    this.publishSidebarThreads();
    const nonce = crypto.randomBytes(16).toString('hex');
    const renderPod = this.pod ?? this.deps.podStore.activePod;
    this.panel.webview.html = renderPostedReviewsHtml(
      {
        vocabulary: renderPod ? getProvider(renderPod.providerId).vocabulary : NEUTRAL_VOCABULARY,
        podName: renderPod?.name ?? '',
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
