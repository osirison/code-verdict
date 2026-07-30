import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS } from '../commands';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { fetchPodData } from '../app/podQuery';
import type { SecretStore } from '../app/storage';
import type { DashboardMessage } from './dashboardHtml';
import { escapeHtml, renderDashboardHtml, renderFallbackHtml } from './dashboardHtml';
import type { DashboardDeps } from './dashboardState';
import { toViewState } from './dashboardState';

export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  static async show(podStore: PodStore, secrets: SecretStore, deps: DashboardDeps = {}): Promise<void> {
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
    DashboardPanel.current = new DashboardPanel(panel, podStore, secrets, deps);
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
    private readonly deps: DashboardDeps,
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
        case 'switchPod':
          void vscode.commands.executeCommand(COMMANDS.switchPod);
          break;
        case 'addProjects':
          void vscode.commands.executeCommand(COMMANDS.addProject);
          break;
        case 'filters':
          void vscode.window.showInformationMessage(
            'Verdict: dashboard filters beyond scope and project arrive with issue #8.',
          );
          break;
        case 'openCr':
          if (this.deps.openCr) {
            this.deps.openCr({ repoId: message.repoId, number: message.number }, message.submitted);
          } else {
            void vscode.commands.executeCommand(COMMANDS.openReview);
          }
          break;
      }
    });
  }

  async refresh(): Promise<void> {
    // Guard both races: writes after disposal throw, and a slow older fetch
    // must never repaint over a newer one (e.g. after a pod switch).
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
      const submitted = this.deps.submittedRefs?.() ?? new Set<string>();
      this.panel.webview.html = renderDashboardHtml(toViewState(data, Date.now(), submitted), nonce);
    } catch (e) {
      if (!canRender()) return;
      const message = escapeHtml(e instanceof Error ? e.message : String(e));
      this.panel.webview.html = renderFallbackHtml(
        `<p>Could not load the pod: ${message}</p><p>Is the emulator running? (<code>npm run emulator</code>)</p>`,
      );
    }
  }
}
