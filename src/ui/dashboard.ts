import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS } from '../commands';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { fetchPodData, repoIdsOf } from '../app/podQuery';
import type { SecretStore } from '../app/storage';
import type { DashboardMessage } from './dashboardHtml';
import { escapeHtml, renderDashboardBody, renderDashboardHtml, renderDashboardLoadingHtml, renderFallbackHtml } from './dashboardHtml';
import type { DashboardDeps } from './dashboardState';
import { toViewState } from './dashboardState';
import { AppSurface, type AppRoute } from './appSurface';
import { tryGetProvider } from '../platform/registry';
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import { repoCountOf } from './vocab';

export class DashboardPanel {
  private static current: DashboardPanel | undefined;

  static async show(podStore: PodStore, secrets: SecretStore, deps: DashboardDeps = {}): Promise<void> {
    if (DashboardPanel.current && !DashboardPanel.current.disposed) {
      AppSurface.reveal();
      await DashboardPanel.current.refresh();
      return;
    }
    // Naming doc: the editor tab reads "Verdict: Dashboard".
    const route = AppSurface.show('dashboard', 'Verdict: Dashboard');
    DashboardPanel.current = new DashboardPanel(route, podStore, secrets, deps);
    await DashboardPanel.current.refresh();
  }

  static async refreshIfOpen(): Promise<void> {
    await DashboardPanel.current?.refresh();
  }

  private disposed = false;
  private refreshSeq = 0;
  /** First refresh on this instance paints the loading skeleton (#39); see refresh(). */
  private painted = false;

  private constructor(
    private readonly route: AppRoute,
    private readonly podStore: PodStore,
    private readonly secrets: SecretStore,
    private readonly deps: DashboardDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      if (DashboardPanel.current === this) DashboardPanel.current = undefined;
    });
    // The document reloaded underneath this route (issue #39 follow-up) —
    // e.g. "Developer: Reload Webviews" recreates the webview from the
    // stored (possibly stale) html. `painted` is already true, so this
    // re-fetches and repaints in full rather than reshowing the skeleton.
    route.onReload(() => void this.refresh());
    route.onMessage((rawMessage) => {
      const message = rawMessage as DashboardMessage;
      switch (message.type) {
        case 'refresh':
          void this.refresh();
          break;
        case 'switchPod':
          void vscode.commands.executeCommand(COMMANDS.switchPod);
          break;
        case 'selectPod':
          void (async () => {
            await this.podStore.setActive(message.podId);
            this.deps.onPodChanged?.();
            await this.refresh();
          })();
          break;
        case 'addRepos':
          void vscode.commands.executeCommand(COMMANDS.addProject);
          break;
        case 'filters':
          void vscode.window.showInformationMessage(
            'Verdict: dashboard filters beyond scope and repository arrive with issue #8.',
          );
          break;
        case 'openCr':
          if (this.deps.openCr) {
            this.deps.openCr({ repoId: message.repoId, number: message.number }, message.submitted);
          } else {
            void vscode.commands.executeCommand(COMMANDS.openReview);
          }
          break;
        case 'openChangeset':
          this.deps.openChangeset?.(message.changesetId);
          break;
        case 'newChangeset':
          this.deps.createChangeset?.();
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
        this.route.setHtml(renderFallbackHtml(
          '<p>No pod configured. Run "Verdict: Sign in" first.</p>',
        ));
      }
      return;
    }
    // First paint on navigation (#39): the pod name and a repo-count meta
    // line are known synchronously, so show the real header immediately
    // instead of leaving the previous screen frozen for the whole fetch. A
    // fresh DashboardPanel is created on every navigation to the dashboard
    // (AppSurface.activate leaves the previous route), so painted === false
    // means exactly "arrived here by navigation" — the ⟳ refresh button
    // never re-triggers this skeleton.
    if (!this.painted) {
      const vocabulary = tryGetProvider(pod.providerId)?.vocabulary ?? NEUTRAL_VOCABULARY;
      this.route.setHtml(renderDashboardLoadingHtml(
        pod.name,
        repoCountOf(vocabulary, repoIdsOf(pod).length),
        crypto.randomBytes(16).toString('hex'),
      ));
      this.painted = true;
    }
    try {
      const connection = await connectionForPod(pod, this.secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      if (!canRender()) return;
      const nonce = crypto.randomBytes(16).toString('hex');
      const submitted = this.deps.submittedRefs?.() ?? new Set<string>();
      const podOptions = this.podStore.list().map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        active: candidate.id === pod.id,
        meta: repoCountOf(
          tryGetProvider(candidate.providerId)?.vocabulary ?? NEUTRAL_VOCABULARY,
          repoIdsOf(candidate).length,
        ),
      }));
      const state = toViewState(
        { ...data, podOptions },
        Date.now(),
        submitted,
        this.deps.changesetOptions?.(),
      );
      // Patch the region in place rather than replacing the whole document
      // (#39) — falling back to setHtml only when the page has not yet
      // signalled ready is exactly today's always-full-render behaviour.
      if (!this.route.postRegions({ 'db-body': renderDashboardBody(state) })) {
        this.route.setHtml(renderDashboardHtml(state, nonce));
      }
    } catch (e) {
      if (!canRender()) return;
      const message = escapeHtml(e instanceof Error ? e.message : String(e));
      this.route.setHtml(renderFallbackHtml(
        `<p>Could not load the pod: ${message}</p><p>Is the emulator running? (<code>npm run emulator</code>)</p>`,
      ));
    }
  }
}
