import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { deriveStats, fetchPodData, repoIdsOf, repoLabel } from '../app/podQuery';
import type { PodData } from '../app/podQuery';
import type { SecretStore } from '../app/storage';
import { getProvider } from '../platform/registry';
import type { DashboardMessage, DashboardViewState } from './dashboardHtml';
import { escapeHtml, renderDashboardHtml, renderFallbackHtml } from './dashboardHtml';

function formatAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function toViewState(data: PodData, now: number): DashboardViewState {
  const pod = data.pod;
  const vocabulary = getProvider(pod.providerId).vocabulary;
  const counts = new Map<string, number>();
  for (const cr of data.changeRequests) {
    counts.set(cr.ref.repoId, (counts.get(cr.ref.repoId) ?? 0) + 1);
  }
  return {
    podName: pod.name,
    meta: `${repoIdsOf(pod).length} ${vocabulary.repoNoun}s · ${data.changeRequests.length} open ${vocabulary.changeRequestAbbrev}s`,
    stats: deriveStats(data),
    fetchedAgo: `${formatAge(new Date(data.fetchedAt).toISOString(), now)} ago`,
    projects: repoIdsOf(pod).map((id) => ({
      id,
      label: repoLabel(pod, id),
      count: counts.get(id) ?? 0,
    })),
    rows: data.changeRequests.map((cr) => ({
      repoId: cr.ref.repoId,
      number: cr.ref.number,
      refLabel: vocabulary.formatCrRef(cr.ref.number),
      title: cr.title,
      author: cr.author.username,
      branch: cr.sourceBranch,
      project: repoLabel(pod, cr.ref.repoId),
      aiState: 'not run',
      ciStatus: cr.ci?.status,
      age: formatAge(cr.updatedAt, now),
    })),
    issues: data.workItems.slice(0, 8).map((wi) => ({
      title: wi.title,
      project: repoLabel(pod, wi.repoId),
      assignee: wi.assignee ? `@${wi.assignee.username}` : '—',
      milestone: wi.milestone ?? '—',
      age: formatAge(wi.updatedAt, now),
    })),
    pipelines: [...data.ciRuns]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, 3)
      .map((run) => ({
      id: run.id,
      status: run.status,
      ref: run.ref ?? '',
      project: repoLabel(pod, run.repoId),
      age: run.createdAt ? formatAge(run.createdAt, now) : '',
    })),
  };
}

export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  static async show(podStore: PodStore, secrets: SecretStore): Promise<void> {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      await DashboardPanel.current.refresh();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.dashboard',
      'Verdict: Dashboard',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    DashboardPanel.current = new DashboardPanel(panel, podStore, secrets);
    await DashboardPanel.current.refresh();
  }

  static async refreshIfOpen(): Promise<void> {
    await DashboardPanel.current?.refresh();
  }

  private disposed = false;
  private refreshSeq = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly podStore: PodStore,
    private readonly secrets: SecretStore,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: DashboardMessage) => {
      switch (message.type) {
        case 'refresh':
          void this.refresh();
          break;
        case 'openCr':
          void vscode.window.showInformationMessage(
            `Verdict: running a review on ${message.number} arrives with issue #9 (agent integration).`,
          );
          break;
      }
    });
  }

  async refresh(): Promise<void> {
    // Guard both races: writes after the panel is disposed throw, and a
    // slow older fetch must never repaint over a newer one (e.g. after a
    // pod switch — the screen would contradict the active pod).
    const seq = ++this.refreshSeq;
    const canRender = (): boolean => !this.disposed && seq === this.refreshSeq;

    const pod = this.podStore.activePod;
    if (!pod) {
      if (canRender()) {
        this.panel.webview.html = renderFallbackHtml(
          '<p>No pod configured. Run "Verdict: Sign in to GitLab" first.</p>',
        );
      }
      return;
    }
    try {
      const connection = await connectionForPod(pod, this.secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      if (!canRender()) return;
      const nonce = crypto.randomBytes(16).toString('hex');
      this.panel.webview.html = renderDashboardHtml(toViewState(data, Date.now()), nonce);
    } catch (e) {
      if (!canRender()) return;
      const message = escapeHtml(e instanceof Error ? e.message : String(e));
      this.panel.webview.html = renderFallbackHtml(
        `<p>Could not load the pod: ${message}</p><p>Is the emulator running? (<code>npm run emulator</code>)</p>`,
      );
    }
  }
}
