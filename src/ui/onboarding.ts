import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { tokenSecretKey, type SecretStore } from '../app/storage';
import type { Credential } from '../platform/provider';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod, PodSource } from '../domain/types';
import type { Connection } from '../platform/provider';
import { defaultProviderId, getProvider } from '../platform/registry';
import { acquireSessionFor, sessionAvailableFor } from '../app/connections';
import { cap } from './vocab';
import type { Repository } from '../platform/types';
import { renderOnboardingHtml, type OnboardingMessage, type OnboardingSourceView } from './onboardingHtml';
import type { SidebarSetup } from './sidebarHtml';
import { AppSurface, type AppRoute } from './appSurface';
import { COMMANDS } from '../commands';

interface DraftSource extends OnboardingSourceView {
  repositories: Repository[];
}

export interface OnboardingDeps {
  podStore: PodStore;
  secrets: SecretStore;
  onComplete: () => void;
  /** Which platform the new pod targets; the sign-in chooser supplies it. */
  providerId?: string;
  /** Live progress for the sidebar's Setup checklist (spec §1). */
  onSetupState?: (setup?: SidebarSetup) => void;
}

/** "gitlab.example.com" — the host is the useful half of the instance URL. */
function hostOf(instanceUrl: string): string {
  try {
    return new URL(instanceUrl).host;
  } catch {
    return instanceUrl;
  }
}

export class OnboardingPanel {
  private static current: OnboardingPanel | undefined;

  static show(deps: OnboardingDeps): void {
    if (OnboardingPanel.current) {
      AppSurface.reveal();
      return;
    }
    const route = AppSurface.show('onboarding', 'Verdict: Setup', () => void vscode.commands.executeCommand(COMMANDS.openDashboard));
    OnboardingPanel.current = new OnboardingPanel(route, deps);
    OnboardingPanel.current.render();
  }

  private step: 1 | 2 | 3 = 1;
  /** Which platform this pod targets — from the sign-in chooser. */
  private readonly providerId: string;
  private instanceUrl: string;
  private token = '';
  private connection: Connection | undefined;
  private connectionStatus = 'Not tested yet';
  private connected = false;
  private username: string | undefined;
  private podName = 'Platform squad';
  private sources: DraftSource[] = [];
  private disposed = false;

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: OnboardingDeps,
  ) {
    this.providerId = deps.providerId ?? defaultProviderId();
    // An explicit setting wins; otherwise the chosen provider's own default host.
    const configured = vscode.workspace.getConfiguration('codeVerdict').get<string>('instanceUrl');
    this.instanceUrl =
      configured !== undefined && configured !== ''
        ? configured
        : getProvider(this.providerId).host.defaultInstanceUrl;
    route.onLeave(() => {
      this.disposed = true;
      this.deps.onSetupState?.(undefined);
      if (OnboardingPanel.current === this) OnboardingPanel.current = undefined;
    });
    route.onMessage((message) => void this.onMessage(message as OnboardingMessage));
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

  private render(): void {
    if (this.disposed) return;
    const selectedProjects = this.sources.reduce(
      (count, source) => count + source.projects.filter((project) => project.selected).length,
      0,
    );
    const provider = getProvider(this.providerId);
    this.panel.webview.html = renderOnboardingHtml({
      vocabulary: provider.vocabulary,
      host: provider.host,
      sessionAvailable: sessionAvailableFor(this.providerId, this.instanceUrl),
      step: this.step,
      instanceUrl: this.instanceUrl,
      connectionStatus: this.connectionStatus,
      connected: this.connected,
      podName: this.podName,
      sources: this.sources,
      selectedProjects,
    }, crypto.randomBytes(16).toString('hex'));
    // Spec §1: the sidebar checklist mirrors these steps with live meta.
    this.deps.onSetupState?.({
      steps: [
        {
          label: `Connect ${provider.vocabulary.platformName}`,
          done: this.connected,
          meta: this.connected ? hostOf(this.instanceUrl) : undefined,
        },
        { label: 'Name the pod', done: this.step > 2 && this.podName !== '', meta: this.podName || undefined },
        {
          label: `Add ${provider.vocabulary.repoNounPlural}`,
          done: selectedProjects > 0,
          meta: selectedProjects > 0 ? `${selectedProjects} selected` : undefined,
        },
      ],
    });
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
      case 'useSession':
        await this.connectWithSession(message.instanceUrl);
        break;
      case 'createPod':
        await this.createPod();
        return;
    }
    this.render();
  }

  /**
   * The editor-account path (spec: "does not require a pasted token"). Nothing
   * is written to the secret store — `connectionForPod` re-acquires the session
   * from the editor whenever the pod is used.
   */
  private async connectWithSession(instanceUrl: string): Promise<void> {
    this.instanceUrl = instanceUrl.trim().replace(/\/$/, '');
    const provider = getProvider(this.providerId);
    const accessToken = await acquireSessionFor(this.providerId, this.instanceUrl, {
      createIfNone: true,
    });
    if (accessToken === undefined) {
      this.connected = false;
      this.connectionStatus = `No ${provider.vocabulary.platformName} account available — paste a token instead.`;
      this.render();
      return;
    }
    this.token = '';
    this.connection = provider.connect({
      instanceUrl: this.instanceUrl,
      credential: { kind: 'session', accessToken },
    });
    await this.applyStatus();
    this.render();
  }

  /** Shared by both credential paths: read the status and describe it. */
  private async applyStatus(): Promise<void> {
    try {
      const status = await this.connection!.testConnection();
      this.connected = status.ok;
      this.username = status.username;
      this.connectionStatus = status.ok
        ? `✓ Connected as @${status.username ?? 'you'} · ${(status.scopes ?? ['unknown scope']).join(', ')}`
        : status.error?.message ?? 'Connection failed';
    } catch (e) {
      this.connected = false;
      this.connectionStatus = e instanceof Error ? e.message : String(e);
    }
  }

  private async testConnection(instanceUrl: string, token: string): Promise<void> {
    this.instanceUrl = instanceUrl.trim().replace(/\/$/, '');
    this.token = token;
    const provider = getProvider(this.providerId);
    // Onboarding's credential follows the mode the provider declares for this
    // host: a session where the editor can supply one, the pasted token otherwise.
    const modes = provider.authModesFor(this.instanceUrl);
    const credential: Credential = modes.includes('none')
      ? { kind: 'none' }
      : { kind: 'token', token };
    this.connection = provider.connect({ instanceUrl: this.instanceUrl, credential });
    try {
      const status = await this.connection.testConnection();
      this.connected = status.ok;
      this.username = status.username;
      this.connectionStatus = status.ok
        ? `✓ Connected as @${status.username ?? 'you'} · ${(status.scopes ?? ['unknown scope']).join(', ')}`
        : status.error?.message ?? 'Connection failed';
      if (status.ok && credential.kind === 'token') {
        await this.deps.secrets.store(tokenSecretKey(this.providerId, this.instanceUrl), token);
      }
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
        ? `${cap(getProvider(this.providerId).vocabulary.repoNoun)} ${resolved.id} is not visible with this token`
        : 'No match — check the id or paste the full URL';
      return;
    }
    const repositories = resolved.kind === 'group' ? resolved.repositories : [resolved.repo];
    const id = resolved.kind === 'group' ? resolved.group.id : resolved.repo.id;
    const key = `${resolved.kind}:${id}`;
    if (this.sources.some((source) => source.key === key)) return;
    this.sources.push({
      key,
      kind: resolved.kind === 'group' ? 'group' : 'repo',
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
      providerId: this.providerId,
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
  }
}