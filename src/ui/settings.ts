import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { readToken, type SecretStore } from '../app/storage';
import { COMMANDS } from '../commands';
import { NOTIFICATION_EVENTS, type NotificationMode } from '../domain/notifications';
import { discoverAgents } from '../app/agentDefinitions';
import { agentSearchRoots } from './agentLocations';
import {
  formatConnectionStatus,
  renderSettingsHtml,
  renderSettingsRegions,
  SETTINGS_REGION_IDS,
  type AgentLocationView,
  type SettingsMessage,
  type SettingsRegionId,
  type SettingsViewState,
} from './settingsHtml';
import { AppSurface, type AppRoute } from './appSurface';
import { getProvider } from '../platform/registry';
import { cap } from './vocab';

export interface SettingsPanelDeps {
  podStore: PodStore;
  secrets: SecretStore;
}

export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static async show(deps: SettingsPanelDeps): Promise<void> {
    if (SettingsPanel.current) {
      AppSurface.reveal();
      await SettingsPanel.current.testLiveState();
      return;
    }
    const route = AppSurface.show('settings', 'Verdict: Settings', () => void vscode.commands.executeCommand(COMMANDS.openDashboard));
    SettingsPanel.current = new SettingsPanel(route, deps);
    await SettingsPanel.current.testLiveState();
  }

  private disposed = false;

  // Held state for the two live checks (connection test, agent-location
  // filesystem scan) — refreshed only on open and on an explicit re-test
  // (task 3.1), never as a side effect of an unrelated message. Every other
  // message case patches its own region from config plus these held fields,
  // so a settings toggle never re-tests the connection or re-scans the
  // filesystem.
  private connectionStatus = 'not connected';
  private connected = false;
  private hasToken = false;
  private agentLocations: AgentLocationView[] = [];

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: SettingsPanelDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
    });
    // The document reloaded underneath this route (issue #39 follow-up) —
    // repaint from the fields already held rather than re-testing the
    // connection or re-scanning agent locations a second time.
    route.onReload(() => this.paint(SETTINGS_REGION_IDS));
    route.onMessage((message) => void this.onMessage(message as SettingsMessage));
  }

  /**
   * Runs the two live checks — `testConnection()` and the agent-location
   * scan — and repaints. This is the *only* path that performs either: it is
   * called from `show()` (on open) and from the `testConnection` message
   * (the explicit re-test control). No other message case reaches it.
   */
  private async testLiveState(): Promise<void> {
    const pod = this.deps.podStore.activePod;
    if (!pod || this.disposed) return;
    const token = await readToken(this.deps.secrets, pod.providerId, pod.instanceUrl);
    if (this.disposed) return;
    this.hasToken = token !== undefined;
    try {
      const status = await (await connectionForPod(pod, this.deps.secrets)).testConnection();
      this.connected = status.ok;
      this.connectionStatus = status.ok
        ? formatConnectionStatus(status, pod.username)
        : status.error?.message ?? 'connection failed';
    } catch (error) {
      this.connected = false;
      this.connectionStatus = error instanceof Error ? error.message : String(error);
    }
    if (this.disposed) return;
    this.agentLocations = await this.agentLocationViews();
    if (this.disposed) return;
    // Every region, not just connection/agents: `show()` reaches this method
    // on an already-open panel too (e.g. the reviewer edited settings.json
    // via "Open in editor" and reran the command), and that path is the only
    // one left that still needs to pick up a config change made outside this
    // page — every message case below patches its own region as it happens.
    this.paint(SETTINGS_REGION_IDS);
  }

  /**
   * One row per searched directory, built by running the real discovery — a
   * count derived any other way would report on a search that never happened.
   * `discoverAgents` reports a skip for a configured root it cannot read and
   * stays silent about a missing `.github/agents`, which is the same
   * distinction these rows draw.
   */
  private async agentLocationViews(): Promise<AgentLocationView[]> {
    const roots = agentSearchRoots();
    return Promise.all(roots.map(async (root) => {
      const { agents, skipped } = await discoverAgents([root]);
      const unreadable = skipped.some((skip) => skip.reason === 'the location could not be read');
      return {
        label: root.label,
        configured: root.source === 'location',
        status: unreadable ? ('unreadable' as const) : ('ok' as const),
        agentCount: agents.length,
      };
    }));
  }

  private buildState(pod: { providerId: string; instanceUrl: string }): SettingsViewState {
    const config = vscode.workspace.getConfiguration('codeVerdict');
    const vocabulary = getProvider(pod.providerId).vocabulary;
    return {
      vocabulary,
      instanceUrl: pod.instanceUrl,
      connectionStatus: this.connectionStatus,
      connected: this.connected,
      hasToken: this.hasToken,
      quietMode: config.get<boolean>('notifications.quietMode', false),
      digestCadence: config.get<SettingsViewState['digestCadence']>('notifications.digestCadence', 'End of day'),
      shareRates: config.get<boolean>('shareAcceptRejectRates', false),
      agentLocations: this.agentLocations,
      notifications: NOTIFICATION_EVENTS.map((event) => ({
        key: event.key,
        // The static table stays neutral ("CI run"); the settings list can name
        // the active pod's platform, so it does.
        // Capitalized: it opens the label, and every other row is sentence-cased.
        label: event.label.replace(/\bCI run\b/, cap(vocabulary.ciNoun)),
        hint: event.hint.replace(/\bCI run\b/, vocabulary.ciNoun),
        mode: config.get<NotificationMode>(`notifications.events.${event.key}`, event.defaultMode),
      })),
    };
  }

  /**
   * Patches the named regions from held/config state, falling back to a full
   * `setHtml` only when the page has not yet signalled ready (first paint,
   * or just after a reload) — exactly the `dashboard.ts`/`postedReviews.ts`
   * shape. Never re-runs either live check; callers that need a fresh check
   * go through `testLiveState()` first.
   */
  private paint(regionIds: readonly SettingsRegionId[]): void {
    if (this.disposed) return;
    const pod = this.deps.podStore.activePod;
    if (!pod) return;
    const state = this.buildState(pod);
    const all = renderSettingsRegions(state);
    const regions: Record<string, string> = {};
    for (const id of regionIds) regions[id] = all[id];
    if (!this.route.postRegions(regions)) {
      this.route.setHtml(renderSettingsHtml(state, crypto.randomBytes(16).toString('hex')));
    }
  }

  private async onMessage(message: SettingsMessage): Promise<void> {
    const config = vscode.workspace.getConfiguration('codeVerdict');
    switch (message.type) {
      case 'addAgentLocation': {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: 'Search this folder for agents',
        });
        const folder = picked?.[0];
        if (!folder) return;
        const current = config.get<string[]>('agentLocations') ?? [];
        if (current.includes(folder.fsPath)) return;
        await config.update('agentLocations', [...current, folder.fsPath], vscode.ConfigurationTarget.Global);
        // This case is what the scan is *about* — re-run it and patch only
        // the agents region, never the connection (task 3.1/3.3).
        this.agentLocations = await this.agentLocationViews();
        this.paint(['set-agents']);
        return;
      }
      case 'removeAgentLocation': {
        const current = config.get<string[]>('agentLocations') ?? [];
        await config.update(
          'agentLocations',
          current.filter((entry) => entry.trim() !== message.label),
          vscode.ConfigurationTarget.Global,
        );
        this.agentLocations = await this.agentLocationViews();
        this.paint(['set-agents']);
        return;
      }
      case 'rotateToken': {
        await vscode.commands.executeCommand(COMMANDS.signIn);
        // signIn usually navigates away (onboarding, or straight to the
        // dashboard on the debug bypass), which leaves this route and sets
        // `disposed` — the checks below are for the case it does not (the
        // platform picker was cancelled and control returned here).
        if (this.disposed) return;
        const pod = this.deps.podStore.activePod;
        if (pod) {
          // A cheap local read, not `testConnection()` — 3.1 reserves the
          // live connection check for open and the explicit re-test control.
          this.hasToken = (await readToken(this.deps.secrets, pod.providerId, pod.instanceUrl)) !== undefined;
        }
        this.paint(['set-connection']);
        return;
      }
      case 'testConnection':
        await this.testLiveState();
        return;
      case 'setNotification':
        await config.update(`notifications.events.${message.key}`, message.mode, vscode.ConfigurationTarget.Global);
        this.paint(['set-notifications', 'set-json']);
        return;
      case 'setQuietMode':
        await config.update('notifications.quietMode', message.value, vscode.ConfigurationTarget.Global);
        this.paint(['set-notifications', 'set-json']);
        return;
      case 'setDigestCadence':
        await config.update('notifications.digestCadence', message.value, vscode.ConfigurationTarget.Global);
        this.paint(['set-notifications', 'set-json']);
        return;
      case 'setShareRates':
        await config.update('shareAcceptRejectRates', message.value, vscode.ConfigurationTarget.Global);
        this.paint(['set-privacy', 'set-json']);
        return;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        return;
    }
  }
}
