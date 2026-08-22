import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { readToken, type SecretStore } from '../app/storage';
import { COMMANDS } from '../commands';
import { NOTIFICATION_EVENTS, type NotificationMode } from '../domain/notifications';
import {
  formatConnectionStatus,
  renderSettingsHtml,
  type SettingsMessage,
  type SettingsViewState,
} from './settingsHtml';
import { AppSurface, type AppRoute } from './appSurface';
import { getProvider } from '../platform/registry';

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
    const state: SettingsViewState = {
      vocabulary: getProvider(pod.providerId).vocabulary,
      instanceUrl: pod.instanceUrl,
      connectionStatus,
      connected,
      hasToken: token !== undefined,
      quietMode: config.get<boolean>('notifications.quietMode', false),
      digestCadence: config.get<SettingsViewState['digestCadence']>('notifications.digestCadence', 'End of day'),
      shareRates: config.get<boolean>('shareAcceptRejectRates', false),
      notifications: NOTIFICATION_EVENTS.map((event) => ({
        key: event.key,
        label: event.label,
        hint: event.hint,
        mode: config.get<NotificationMode>(`notifications.events.${event.key}`, event.defaultMode),
      })),
    };
    this.panel.webview.html = renderSettingsHtml(state, crypto.randomBytes(16).toString('hex'));
  }

  private async onMessage(message: SettingsMessage): Promise<void> {
    const config = vscode.workspace.getConfiguration('codeVerdict');
    switch (message.type) {
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