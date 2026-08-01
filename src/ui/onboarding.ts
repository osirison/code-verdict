import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { tokenSecretKey, type SecretStore } from '../app/storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod, PodSource } from '../domain/types';
import type { Connection } from '../platform/provider';
import { getProvider } from '../platform/registry';
import type { Repository } from '../platform/types';
import { renderOnboardingHtml, type OnboardingMessage, type OnboardingSourceView } from './onboardingHtml';

interface DraftSource extends OnboardingSourceView {
  repositories: Repository[];
}

export interface OnboardingDeps {
  podStore: PodStore;
  secrets: SecretStore;
  onComplete: () => void;
}

export class OnboardingPanel {
  private static current: OnboardingPanel | undefined;

  static show(deps: OnboardingDeps): void {
    if (OnboardingPanel.current) {
      OnboardingPanel.current.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.onboarding',
      'Verdict: Setup',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    OnboardingPanel.current = new OnboardingPanel(panel, deps);
    OnboardingPanel.current.render();
  }

  private step: 1 | 2 | 3 = 1;
  private instanceUrl = vscode.workspace.getConfiguration('codeVerdict').get<string>('instanceUrl', 'https://gitlab.com');
  private token = '';
  private connection: Connection | undefined;
  private connectionStatus = 'Not tested yet';
  private connected = false;
  private username: string | undefined;
  private podName = 'Platform squad';
  private sources: DraftSource[] = [];
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: OnboardingDeps,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (OnboardingPanel.current === this) OnboardingPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: OnboardingMessage) => void this.onMessage(message));
  }

  private render(): void {
    if (this.disposed) return;
    this.panel.webview.html = renderOnboardingHtml({
      step: this.step,
      instanceUrl: this.instanceUrl,
      connectionStatus: this.connectionStatus,
      connected: this.connected,
      podName: this.podName,
      sources: this.sources,
      selectedProjects: this.sources.reduce((count, source) => count + source.projects.filter((project) => project.selected).length, 0),
    }, crypto.randomBytes(16).toString('hex'));
  }

  private async onMessage(message: OnboardingMessage): Promise<void> {
    switch (message.type) {
      case 'testConnection':
        await this.testConnection(message.instanceUrl, message.token);
        break;
      case 'setName':
        this.podName = message.name.trim();
        break;
      case 'goStep':
        if (message.step === 2 && !this.connected) return;
        if (message.step === 3 && this.podName === '') return;
        this.step = message.step;
        break;
      case 'addSource':
        await this.addSource(message.input);
        break;
      case 'removeSource':
        this.sources = this.sources.filter((source) => source.key !== message.key);
        break;
      case 'toggleProject': {
        const source = this.sources.find((candidate) => candidate.key === message.key);
        const project = source?.projects.find((candidate) => candidate.id === message.repoId);
        if (project) project.selected = !project.selected;
        break;
      }
      case 'createPod':
        await this.createPod();
        return;
    }
    this.render();
  }

  private async testConnection(instanceUrl: string, token: string): Promise<void> {
    this.instanceUrl = instanceUrl.trim().replace(/\/$/, '');
    this.token = token;
    this.connection = getProvider('gitlab').connect({ instanceUrl: this.instanceUrl, token });
    try {
      const status = await this.connection.testConnection();
      this.connected = status.ok;
      this.username = status.username;
      this.connectionStatus = status.ok
        ? `✓ Connected as @${status.username ?? 'you'} · ${(status.scopes ?? ['unknown scope']).join(', ')}`
        : status.error?.message ?? 'Connection failed';
      if (status.ok) await this.deps.secrets.store(tokenSecretKey(this.instanceUrl), token);
    } catch (error) {
      this.connected = false;
      this.connectionStatus = error instanceof Error ? error.message : String(error);
    }
  }

  private async addSource(input: string): Promise<void> {
    if (!this.connection || input.trim() === '') return;
    const resolved = await this.connection.resolveSource(input.trim());
    if (resolved.kind === 'noMatch' || resolved.kind === 'notVisible') {
      this.connectionStatus = resolved.kind === 'notVisible'
        ? `Project ${resolved.id} is not visible with this token`
        : 'No match — check the id or paste the full URL';
      return;
    }
    const repositories = resolved.kind === 'group' ? resolved.repositories : [resolved.repo];
    const id = resolved.kind === 'group' ? resolved.group.id : resolved.repo.id;
    const key = `${resolved.kind}:${id}`;
    if (this.sources.some((source) => source.key === key)) return;
    this.sources.push({
      key,
      kind: resolved.kind === 'group' ? 'group' : 'project',
      path: resolved.kind === 'group' ? resolved.group.path : resolved.repo.path,
      id,
      repositories,
      projects: repositories.map((repository) => ({
        id: repository.id,
        path: repository.path,
        selected: true,
        openMergeRequests: repository.openChangeRequestCount,
      })),
    });
  }

  private async createPod(): Promise<void> {
    const selected = this.sources.flatMap((source) => source.projects.filter((project) => project.selected));
    if (!this.connected || this.podName === '' || selected.length === 0) return;
    const podSources = this.sources.flatMap((source): PodSource[] => {
      const repoIds = source.projects.filter((project) => project.selected).map((project) => project.id);
      if (repoIds.length === 0) return [];
      return source.kind === 'group'
        ? [{ kind: 'group' as const, groupId: source.id, repoIds }]
        : [{ kind: 'repository' as const, repoId: repoIds[0] as string }];
    });
    const repositories = this.sources.flatMap((source) => source.repositories).filter(
      (repository, index, all) => selected.some((project) => project.id === repository.id)
        && all.findIndex((candidate) => candidate.id === repository.id) === index,
    );
    const pod: Pod = {
      id: `pod_${crypto.randomUUID()}`,
      name: this.podName,
      providerId: 'gitlab',
      instanceUrl: this.instanceUrl,
      sources: podSources,
      criteria: { ...DEFAULT_CRITERIA, categories: [...DEFAULT_CRITERIA.categories] },
      agentId: '',
      repos: repositories.map((repository) => ({ id: repository.id, path: repository.path, name: repository.name })),
      username: this.username,
    };
    await this.deps.podStore.upsert(pod);
    await this.deps.podStore.setActive(pod.id);
    this.deps.onComplete();
    this.panel.dispose();
  }
}