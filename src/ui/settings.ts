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
  type AgentLocationView,
  type SettingsMessage,
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
      await SettingsPanel.current.render();
      return;
    }
    const route = AppSurface.show('settings', 'Verdict: Settings', () => void vscode.commands.executeCommand(COMMANDS.openDashboard));
    SettingsPanel.current = new SettingsPanel(route, deps);
    await SettingsPanel.current.render();
  }

  private disposed = false;

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: SettingsPanelDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
    });
    route.onMessage((message) => void this.onMessage(message as SettingsMessage));
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

  private async render(): Promise<void> {
    const pod = this.deps.podStore.activePod;
    if (!pod || this.disposed) return;
    const config = vscode.workspace.getConfiguration('codeVerdict');
    const token = await readToken(this.deps.secrets, pod.providerId, pod.instanceUrl);
    let connected = false;
    let connectionStatus = 'not connected';
    try {
      const status = await (await connectionForPod(pod, this.deps.secrets)).testConnection();
      connected = status.ok;
      connectionStatus = status.ok
        ? formatConnectionStatus(status, pod.username)
        : status.error?.message ?? 'connection failed';
    } catch (error) {
      connectionStatus = error instanceof Error ? error.message : String(error);
    }
    if (this.disposed) return;
    const vocabulary = getProvider(pod.providerId).vocabulary;
    const state: SettingsViewState = {
      vocabulary,
      instanceUrl: pod.instanceUrl,
      connectionStatus,
      connected,
      hasToken: token !== undefined,
      quietMode: config.get<boolean>('notifications.quietMode', false),
      digestCadence: config.get<SettingsViewState['digestCadence']>('notifications.digestCadence', 'End of day'),
      shareRates: config.get<boolean>('shareAcceptRejectRates', false),
      agentLocations: await this.agentLocationViews(),
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
    this.panel.webview.html = renderSettingsHtml(state, crypto.randomBytes(16).toString('hex'));
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
        if (!folder) break;
        const current = config.get<string[]>('agentLocations') ?? [];
        if (current.includes(folder.fsPath)) break;
        await config.update('agentLocations', [...current, folder.fsPath], vscode.ConfigurationTarget.Global);
        break;
      }
      case 'removeAgentLocation': {
        const current = config.get<string[]>('agentLocations') ?? [];
        await config.update(
          'agentLocations',
          current.filter((entry) => entry.trim() !== message.label),
          vscode.ConfigurationTarget.Global,
        );
        break;
      }
      case 'rotateToken':
        await vscode.commands.executeCommand(COMMANDS.signIn);
        break;
      case 'setNotification':
        await config.update(`notifications.events.${message.key}`, message.mode, vscode.ConfigurationTarget.Global);
        break;
      case 'setQuietMode':
        await config.update('notifications.quietMode', message.value, vscode.ConfigurationTarget.Global);
        break;
      case 'setDigestCadence':
        await config.update('notifications.digestCadence', message.value, vscode.ConfigurationTarget.Global);
        break;
      case 'setShareRates':
        await config.update('shareAcceptRejectRates', message.value, vscode.ConfigurationTarget.Global);
        break;
      case 'openSettingsJson':
        await vscode.commands.executeCommand('workbench.action.openSettingsJson');
        return;
    }
    await this.render();
  }
}