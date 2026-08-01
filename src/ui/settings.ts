import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { PodStore } from '../app/pods';
import { tokenSecretKey, type SecretStore } from '../app/storage';
import { COMMANDS } from '../commands';
import {
  renderSettingsHtml,
  type NotificationMode,
  type NotificationSettingView,
  type SettingsMessage,
  type SettingsViewState,
} from './settingsHtml';

export interface SettingsPanelDeps {
  podStore: PodStore;
  secrets: SecretStore;
}

const EVENTS: ReadonlyArray<Omit<NotificationSettingView, 'mode'>> = [
  { key: 'agentFinished', label: 'Agent finished a review', hint: 'Review results are ready to triage.' },
  { key: 'replyPosted', label: 'Reply on a comment you posted', hint: 'An author replied to your review.' },
  { key: 'authorPushed', label: 'Author pushed a fix', hint: 'The merge request changed after review.' },
  { key: 'pipelineFailed', label: 'Pipeline failed', hint: 'A watched pipeline needs attention.' },
  { key: 'reviewRequested', label: 'Review requested from you', hint: 'A merge request is waiting on you.' },
  { key: 'mentioned', label: 'You were mentioned', hint: 'A discussion mentioned your username.' },
  { key: 'threadStale', label: 'A posted thread went stale', hint: 'New commits moved a reviewed line.' },
];

export class SettingsPanel {
  private static current: SettingsPanel | undefined;

  static async show(deps: SettingsPanelDeps): Promise<void> {
    if (SettingsPanel.current) {
      SettingsPanel.current.panel.reveal();
      await SettingsPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.settings',
      'Verdict: Settings',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    SettingsPanel.current = new SettingsPanel(panel, deps);
    await SettingsPanel.current.render();
  }

  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: SettingsPanelDeps,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (SettingsPanel.current === this) SettingsPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: SettingsMessage) => void this.onMessage(message));
  }

  private async render(): Promise<void> {
    const pod = this.deps.podStore.activePod;
    if (!pod || this.disposed) return;
    const config = vscode.workspace.getConfiguration('codeVerdict');
    const token = await this.deps.secrets.get(tokenSecretKey(pod.instanceUrl));
    let connected = false;
    let connectionStatus = 'not connected';
    try {
      const status = await (await connectionForPod(pod, this.deps.secrets)).testConnection();
      connected = status.ok;
      connectionStatus = status.ok
        ? `connected as @${status.username ?? pod.username ?? 'you'} · ${(status.scopes ?? ['unknown scope']).join(', ')}`
        : status.error?.message ?? 'connection failed';
    } catch (error) {
      connectionStatus = error instanceof Error ? error.message : String(error);
    }
    if (this.disposed) return;
    const defaults: Record<string, NotificationMode> = {
      agentFinished: 'Interrupt', replyPosted: 'Interrupt', authorPushed: 'Badge',
      pipelineFailed: 'Digest', reviewRequested: 'Interrupt', mentioned: 'Badge', threadStale: 'Digest',
    };
    const state: SettingsViewState = {
      instanceUrl: pod.instanceUrl,
      connectionStatus,
      connected,
      hasToken: token !== undefined,
      quietMode: config.get<boolean>('notifications.quietMode', false),
      digestCadence: config.get<SettingsViewState['digestCadence']>('notifications.digestCadence', 'End of day'),
      shareRates: config.get<boolean>('shareAcceptRejectRates', false),
      notifications: EVENTS.map((event) => ({
        ...event,
        mode: config.get<NotificationMode>(`notifications.events.${event.key}`, defaults[event.key] ?? 'Off'),
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