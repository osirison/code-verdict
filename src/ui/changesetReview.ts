import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentDescriptor } from '../app/agents';
import { DEMO_AGENT_DESCRIPTOR } from '../app/agents';
import type { DetectedChangeset } from '../app/changesets';
import { detectChangesets } from '../app/changesets';
import type { ChangesetAgentMember } from '../app/combinedAgent';
import { runDemoChangesetAgent } from '../app/combinedAgent';
import { connectionForPod } from '../app/connections';
import type { ChangesetSubmitState } from '../app/changesetSubmit';
import { buildChangesetSubmitPlans, performChangesetSubmit } from '../app/changesetSubmit';
import { DEMO_AGENT_ID } from '../app/demoAgent';
import { AgentRunError, discoverLmAgents, runLmChangesetAgent } from '../app/lmAgent';
import { fetchPodData } from '../app/podQuery';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { composeSummaryBody } from '../app/submit';
import type { AgentReviewResponse } from '../domain/agentResponse';
import { parseHunks } from '../domain/diffHunks';
import { SEVERITY_ORDER } from '../domain/criteria';
import { composeSummary, type AgentVoice } from '../domain/summary';
import { allDecided, clearVerdict, createReview, nextUndecided, setVerdict, verdictCounts } from '../domain/reviewState';
import type { Category, Review, Severity } from '../domain/types';
import { getProvider } from '../platform/registry';
import type { FlowMessage, FlowScreen, FlowViewState, TriageItemView } from './reviewFlowHtml';
import { renderReviewFlowHtml } from './reviewFlowHtml';
import { AppSurface, type AppRoute } from './appSurface';
import type { SidebarActiveReview } from './sidebarHtml';

interface ChangesetDraft {
  review: Review;
  threads: Record<string, Array<{ label: string; text: string }>>;
  summaryText: string;
  finalNote: string;
  submitState?: ChangesetSubmitState;
}

export interface ChangesetReviewDeps {
  podStore: PodStore;
  secrets: SecretStore;
  workspaceState: KeyValueStore;
  globalState: KeyValueStore;
  openSingle: (ref: { repoId: string; number: string }) => void;
  openDashboard: () => void;
  onSubmitted?: () => void;
  onSidebarState?: (state?: SidebarActiveReview) => void;
  /** The combined agent finished — the notification engine's local event. */
  onReviewReady?: (info: { label: string; itemCount: number }) => void;
}

export class ChangesetReviewPanel {
  private static current: ChangesetReviewPanel | undefined;

  static async open(deps: ChangesetReviewDeps, changesetId: string): Promise<void> {
    const route = AppSurface.show(`changesetReview:${changesetId}`, 'Verdict: Review changeset', deps.openDashboard);
    const controller = new ChangesetReviewPanel(route, deps, changesetId);
    ChangesetReviewPanel.current = controller;
    await controller.load();
  }

  static selectItem(itemId: string): void {
    const panel = ChangesetReviewPanel.current;
    if (!panel || panel.disposed || !panel.review?.items.some((item) => item.id === itemId)) return;
    panel.selectedId = itemId;
    panel.render();
    AppSurface.reveal();
  }

  private disposed = false;
  private changeset!: DetectedChangeset;
  private members: ChangesetAgentMember[] = [];
  private agents: AgentDescriptor[] = [DEMO_AGENT_DESCRIPTOR];
  private agentId = DEMO_AGENT_ID;
  private agentOpen = false;
  private screen: FlowScreen = 'agent';
  private mode: 'split' | 'queue' | 'diff' = 'split';
  private response?: AgentReviewResponse;
  private review?: Review;
  private selectedId?: string;
  private threads: Record<string, Array<{ label: string; text: string }>> = {};
  private runSteps: string[] = [];
  private runStep = 0;
  private runError?: { message: string; requestId: string; partialCount: number; code: string };
  private runToken = 0;
  private summaryText = '';
  private finalNote = '';
  private postThread = true;
  private requestChanges = true;
  private submitError?: string;
  private submitState?: ChangesetSubmitState;
  private doneSentence = '';

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: ChangesetReviewDeps,
    private readonly changesetId: string,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      this.runToken += 1;
      this.deps.onSidebarState?.();
      if (ChangesetReviewPanel.current === this) ChangesetReviewPanel.current = undefined;
    });
    route.onMessage((message) => void this.onMessage(message as FlowMessage));
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

  private pod() {
    const pod = this.deps.podStore.activePod;
    if (!pod) throw new Error('No pod configured');
    return pod;
  }

  private draftKey(): string {
    return `codeVerdict.changesetDraft.${this.changesetId}`;
  }

  private async load(): Promise<void> {
    try {
      const pod = this.pod();
      const connection = await connectionForPod(pod, this.deps.secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      const changeset = detectChangesets(pod, data.changeRequests, data.workItems).find((candidate) => candidate.id === this.changesetId);
      if (!changeset) throw new Error('Changeset is no longer available');
      this.changeset = changeset;
      const [members, agents] = await Promise.all([
        Promise.all(changeset.members.map(async (member) => ({
          ref: member.ref,
          projectPath: member.projectPath,
          diff: await connection.getChangeRequestDiff(member.ref),
        }))),
        discoverLmAgents(),
      ]);
      this.members = members;
      this.agents = [DEMO_AGENT_DESCRIPTOR, ...agents];
      const podAgent = pod.agentId;
      if (podAgent && this.agents.some((agent) => agent.id === podAgent)) this.agentId = podAgent;
      const draft = this.deps.workspaceState.get<ChangesetDraft>(this.draftKey());
      if (draft) {
        this.review = draft.review;
        this.threads = draft.threads;
        this.summaryText = draft.summaryText;
        this.finalNote = draft.finalNote;
        this.submitState = draft.submitState;
        this.selectedId = nextUndecided(draft.review)?.id ?? draft.review.items[0]?.id;
        this.screen = 'triage';
      }
      this.render();
    } catch (error) {
      void vscode.window.showErrorMessage(`Verdict: ${error instanceof Error ? error.message : String(error)}`);
      this.deps.openDashboard();
    }
  }

  private async persist(): Promise<void> {
    if (!this.review) return;
    await this.deps.workspaceState.update(this.draftKey(), {
      review: this.review,
      threads: this.threads,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      submitState: this.submitState,
    } satisfies ChangesetDraft);
  }

  private async run(): Promise<void> {
    const token = ++this.runToken;
    this.screen = 'running';
    this.runError = undefined;
    this.runStep = 0;
    const pod = this.pod();
    pod.agentId = this.agentId;
    await this.deps.podStore.upsert(pod);
    try {
      if (this.agentId === DEMO_AGENT_ID) {
        const result = runDemoChangesetAgent(this.members, pod.criteria);
        this.runSteps = result.steps;
        for (let index = 0; index <= result.steps.length; index += 1) {
          if (this.disposed || token !== this.runToken) return;
          this.runStep = index;
          this.render();
          await new Promise((resolve) => setTimeout(resolve, 260));
        }
        if (!this.disposed && token === this.runToken) this.finishRun(result.response);
        return;
      }
      this.runSteps = [
        'Resolving agent from Copilot workspace…',
        `Indexing every diff across ${this.members.length} merge requests…`,
        'Cross-referencing contracts between repositories…',
        'Scoring findings against project criteria…',
        'Items ready',
      ];
      this.runStep = 2;
      this.render();
      const response = await runLmChangesetAgent(this.agentId, this.members, pod.criteria);
      if (!this.disposed && token === this.runToken) this.finishRun(response);
    } catch (error) {
      if (this.disposed || token !== this.runToken) return;
      const failure = error instanceof AgentRunError ? error : new AgentRunError(String(error), '------', false);
      this.runError = {
        message: failure.message,
        requestId: failure.requestId,
        partialCount: 0,
        code: failure.timedOut ? 'copilot.request.timeout · 90000ms' : 'copilot.request.error',
      };
      this.render();
    }
  }

  private finishRun(response: AgentReviewResponse): void {
    this.response = response;
    this.deps.onReviewReady?.({ label: this.changeset.name, itemCount: response.items.length });
    if (response.items.length === 0) {
      this.review = undefined;
      this.screen = 'clean';
      this.render();
      return;
    }
    this.review = createReview({
      repoId: 'changeset',
      crNumber: this.changeset.id,
      agentId: response.agentId,
      criteria: this.pod().criteria,
      response,
    });
    this.threads = {};
    this.submitState = undefined;
    this.submitError = undefined;
    this.selectedId = this.review.items[0]?.id;
    this.screen = 'triage';
    void this.persist();
    this.render();
  }

  private async onMessage(message: FlowMessage): Promise<void> {
    const pod = this.pod();
    switch (message.type) {
      case 'toggleAgentOpen': this.agentOpen = !this.agentOpen; break;
      case 'selectAgent': this.agentId = message.agentId; this.agentOpen = false; break;
      case 'setFloor': pod.criteria.severityFloor = message.floor; await this.deps.podStore.upsert(pod); break;
      case 'setConfidence': pod.criteria.minConfidence = message.value; await this.deps.podStore.upsert(pod); break;
      case 'toggleCategory': {
        const categories = new Set(pod.criteria.categories);
        if (categories.has(message.category)) categories.delete(message.category); else categories.add(message.category);
        pod.criteria.categories = [...categories] as Category[];
        await this.deps.podStore.upsert(pod);
        break;
      }
      case 'setInstructions': pod.criteria.extraInstructions = message.text; await this.deps.podStore.upsert(pod); break;
      case 'run': void this.run(); return;
      case 'cancel': this.runToken += 1; this.screen = 'agent'; break;
      case 'retryRun': case 'rerun': void this.run(); return;
      case 'usePartial': this.runError = undefined; this.screen = 'agent'; break;
      case 'setMode': this.mode = message.mode; break;
      case 'select': this.selectedId = message.itemId; break;
      case 'verdict': {
        if (!this.review) return;
        const item = this.review.items.find((candidate) => candidate.id === message.itemId);
        this.review = setVerdict(this.review, message.itemId, message.verdict, message.applyFix && Boolean(item?.suggestion));
        if (vscode.workspace.getConfiguration('codeVerdict').get<boolean>('autoAdvance', true)) {
          this.selectedId = nextUndecided(this.review, message.itemId)?.id ?? this.selectedId;
        }
        await this.persist();
        break;
      }
      case 'undo': if (this.review) { this.review = clearVerdict(this.review, message.itemId); await this.persist(); } break;
      case 'move': {
        const ids = this.review?.items.map((item) => item.id) ?? [];
        const current = Math.max(0, ids.indexOf(this.selectedId ?? ''));
        this.selectedId = ids[Math.min(ids.length - 1, Math.max(0, current + message.delta))] ?? this.selectedId;
        break;
      }
      case 'jumpSeverity': this.selectedId = this.review?.items.find((item) => item.severity === message.severity)?.id ?? this.selectedId; break;
      case 'ask': {
        const item = this.review?.items.find((candidate) => candidate.id === message.itemId);
        if (!item) return;
        const list = (this.threads[item.id] ??= []);
        const label = message.preset === 'freeform' ? 'agent · reply' : `agent · ${message.preset}`;
        if (message.preset === 'freeform' || !list.some((entry) => entry.label === label)) {
          list.push({ label, text: message.preset === 'freeform' ? `On "${message.text?.trim()}": compare both repository contracts before changing either side.` : item.answers?.[message.preset] ?? 'The combined diff provides no further detail.' });
        }
        await this.persist();
        break;
      }
      case 'openInEditor':
        void vscode.window.showTextDocument(vscode.Uri.file(message.file), { preview: true }).then(
          undefined,
          () => vscode.window.showInformationMessage(
            `Verdict: ${message.file} is not in this workspace — it lives in the reviewed repository.`,
          ),
        );
        return;
      case 'generateSummary':
        if (!this.review || !allDecided(this.review)) return;
        this.summaryText = this.generateSummary();
        this.screen = 'summary';
        await this.persist();
        break;
      case 'editSummary': this.summaryText = message.text; await this.persist(); return;
      case 'regenerate': this.summaryText = this.generateSummary(); break;
      case 'setNote': this.finalNote = message.text; await this.persist(); return;
      case 'toggleOption': if (message.option === 'postThread') this.postThread = !this.postThread; else this.requestChanges = !this.requestChanges; break;
      case 'submit': case 'retrySubmit': void this.submit(); return;
      case 'copyMarkdown': await vscode.env.clipboard.writeText(composeSummaryBody(this.summaryText, this.finalNote)); return;
      case 'backToTriage': this.screen = 'triage'; break;
      case 'lowerBar': {
        const index = SEVERITY_ORDER.indexOf(pod.criteria.severityFloor);
        pod.criteria.severityFloor = SEVERITY_ORDER[Math.max(0, index - 1)] as Severity;
        pod.criteria.minConfidence = Math.max(0, pod.criteria.minConfidence - 20);
        await this.deps.podStore.upsert(pod);
        this.screen = 'agent';
        break;
      }
      case 'reviewSingle': if (message.repoId && message.number) this.deps.openSingle({ repoId: message.repoId, number: message.number }); return;
      case 'backToDashboard': case 'approve': this.deps.openDashboard(); return;
      case 'openMr': {
        const item = this.review?.items.find((candidate) => candidate.id === this.selectedId);
        const member = this.changeset.members.find((candidate) => candidate.ref.repoId === item?.repoId && candidate.ref.number === item.crNumber) ?? this.changeset.members[0];
        if (member) void vscode.env.openExternal(vscode.Uri.parse(member.webUrl));
        return;
      }
      case 'trackReplies': this.deps.openDashboard(); return;
      case 'openTuning': await vscode.commands.executeCommand('codeVerdict.selectAgent'); return;
      case 'reconnect': await vscode.commands.executeCommand('codeVerdict.signIn'); return;
      case 'reanchor': void this.run(); return;
    }
    this.render();
  }

  private generateSummary(): string {
    if (!this.review) return '';
    const voice = vscode.workspace.getConfiguration('codeVerdict').get<AgentVoice>('agentVoice', 'terse');
    return composeSummary(this.review, this.agentLabel(), voice);
  }

  private async submit(): Promise<void> {
    if (!this.review || this.screen !== 'summary' || !allDecided(this.review)) return;
    const pod = this.pod();
    const provider = getProvider(pod.providerId);
    const footer = `Part of changeset “${this.changeset.name}” (${this.changeset.linkedIssue}) — reviewed together across ${this.members.length} repositories with ${this.agentLabel()}.`;
    const summary = `${composeSummaryBody(this.summaryText, this.finalNote)}\n\n---\n\n${footer}`;
    const plans = buildChangesetSubmitPlans(
      this.review,
      this.members.map((member) => ({ ref: member.ref, anchorRefs: member.diff.anchorRefs, projectLabel: member.projectPath })),
      this.agentLabel(),
      pod.username ?? 'you',
      summary,
      this.requestChanges && provider.capabilities.requestChanges,
      this.postThread && provider.capabilities.batchedReview,
    );
    const connection = await connectionForPod(pod, this.deps.secrets);
    const result = await performChangesetSubmit(connection, plans, this.submitState);
    this.submitState = result.state;
    await this.persist();
    if (!result.complete) {
      this.submitError = result.failures[0]?.message ?? 'Some merge requests rejected the review';
      this.render();
      return;
    }
    const history = new ReviewHistory(this.deps.globalState);
    const submittedAt = new Date().toISOString();
    for (const member of this.members) {
      const memberItems = this.review.items.filter((item) => item.repoId === member.ref.repoId && item.crNumber === member.ref.number);
      const memberReview: Review = { ...this.review, items: memberItems };
      const counts = verdictCounts(memberReview);
      await history.add({
        repoId: member.ref.repoId,
        crNumber: member.ref.number,
        podId: pod.id,
        agentId: this.agentId,
        agentLabel: this.agentLabel(),
        submittedAt,
        counts,
        threads: Object.fromEntries(memberItems.flatMap((item) => {
          const threadId = result.state.threadIds[item.id];
          return threadId ? [[item.id, threadId]] : [];
        })),
        items: memberItems.filter((item) => this.review?.verdicts[item.id]?.verdict === 'accepted').map((item) => ({ id: item.id, title: item.title, severity: item.severity, file: item.file, line: item.line })),
        observations: memberItems.flatMap((item) => {
          const verdict = this.review?.verdicts[item.id]?.verdict;
          return verdict
            ? [{ category: item.category, confidence: item.confidence, verdict, severity: item.severity }]
            : [];
        }),
        requestedChanges: result.state.requestChangesRefs.includes(`${member.ref.repoId}!${member.ref.number}`),
      });
    }
    await this.deps.workspaceState.update(this.draftKey(), undefined);
    const counts = verdictCounts(this.review);
    this.doneSentence = `${counts.accepted} inline comments posted across ${this.members.length} merge requests. ${counts.rejected} dismissed findings stayed local.`;
    this.submitError = undefined;
    this.screen = 'done';
    this.deps.onSubmitted?.();
    this.render();
  }

  private agentLabel(): string {
    return this.agents.find((agent) => agent.id === this.agentId)?.label ?? this.agentId;
  }

  private render(): void {
    if (this.disposed || !this.changeset) return;
    const pod = this.pod();
    const items: TriageItemView[] = (this.review?.items ?? []).map((item) => ({
      item,
      verdict: this.review?.verdicts[item.id]?.verdict,
      applyFix: this.review?.verdicts[item.id]?.applyFix,
      thread: this.threads[item.id] ?? [],
      projectLabel: pod.repos?.find((repository) => repository.id === item.repoId)?.name ?? item.repoId,
      refLabel: item.crNumber ? `!${item.crNumber}` : undefined,
    }));
    const selected = items.find((view) => view.item.id === this.selectedId) ?? items[0];
    const selectedMember = this.members.find((member) => member.ref.repoId === selected?.item.repoId && member.ref.number === selected.item.crNumber);
    const diffLines = this.mode === 'diff'
      ? selectedMember?.diff.files
        .filter((file) => file.newPath === selected?.item.file)
        .flatMap((file) => parseHunks(file.diff).flatMap((hunk) => hunk.lines))
      : undefined;
    const counts = this.review ? verdictCounts(this.review) : { accepted: 0, rejected: 0, skipped: 0, undecided: 0 };
    const totalFiles = this.members.reduce((count, member) => count + member.diff.files.length, 0);
    const history = new ReviewHistory(this.deps.globalState).list().filter((record) => record.podId === pod.id);
    const produced = history.reduce((count, record) => count + record.counts.accepted + record.counts.rejected + record.counts.skipped, 0);
    const state: FlowViewState = {
      screen: this.screen,
      changeset: {
        id: this.changeset.id,
        name: this.changeset.name,
        linkedIssue: this.changeset.linkedIssue,
        memberCount: this.members.length,
        projectCount: new Set(this.members.map((member) => member.ref.repoId)).size,
        refs: this.members.map((member) => `!${member.ref.number}`),
        repoLabels: Object.fromEntries(this.members.map((member) => [member.ref.repoId, member.projectPath])),
      },
      header: {
        refLabel: this.members.map((member) => `!${member.ref.number}`).join(' · '),
        projectPath: `${this.members.length} projects`,
        branch: this.changeset.linkedIssue,
        fileCount: totalFiles,
        added: this.response?.stats?.linesAdded ?? 0,
        removed: this.response?.stats?.linesRemoved ?? 0,
        title: this.changeset.name,
      },
      agents: this.agents,
      agentId: this.agentId,
      agentOpen: this.agentOpen,
      criteria: pod.criteria,
      acceptRate: produced > 0 ? Math.round((history.reduce((count, record) => count + record.counts.accepted, 0) / produced) * 100) : undefined,
      runSteps: this.runSteps,
      runStep: this.runStep,
      runError: this.runError,
      mode: this.mode,
      items,
      selectedId: this.selectedId,
      diffLines,
      counts,
      candidates: this.response?.candidates ?? [],
      filesRead: this.response?.stats?.filesRead ?? totalFiles,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      postThread: this.postThread,
      requestChanges: this.requestChanges,
      supportsRequestChanges: providerCapabilities(pod.providerId).requestChanges,
      submitError: this.submitError,
      username: pod.username ?? 'you',
      doneSentence: this.doneSentence,
      crWebUrl: this.changeset.members[0]?.webUrl ?? '',
    };
    this.panel.title = this.screen === 'done' ? `Verdict: Posted · ${this.members.length} MRs` : `Verdict: Review · ${this.members.length} MRs`;
    this.panel.webview.html = renderReviewFlowHtml(state, this.agentLabel(), crypto.randomBytes(16).toString('hex'));
    this.deps.onSidebarState?.(this.review ? {
      headline: this.changeset.name,
      refLabel: `${this.members.length} MRs`,
      context: `${this.members.length} MRs · ${state.header.fileCount} files`,
      agent: this.agentLabel(),
      added: state.header.added,
      removed: state.header.removed,
      counts,
      items: this.review.items.map((item) => ({
        id: item.id,
        title: item.title,
        file: `${state.changeset?.repoLabels?.[item.repoId ?? ''] ?? item.repoId} · ${item.file}`,
        severity: item.severity,
        category: item.category,
        confidence: item.confidence,
        verdict: this.review?.verdicts[item.id]?.verdict,
        selected: item.id === this.selectedId,
      })),
    } : undefined);
  }
}

function providerCapabilities(providerId: string) {
  return getProvider(providerId).capabilities;
}