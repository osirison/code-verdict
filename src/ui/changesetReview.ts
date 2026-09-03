import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { AgentDescriptor, ModelDescriptor } from '../app/agents';
import { BUILTIN_AGENT_DESCRIPTOR, BUILT_IN_AGENTS } from '../app/agents';
import { type SkippedDefinition } from '../app/agentDefinitions';
import { loadAgentSelection, watchAgentSources, type AgentSelectionState } from './agentRefresh';
import { preferredModelFor, selectionFromPod } from '../app/podSelection';
import type { DetectedChangeset } from '../app/changesets';
import { detectChangesets } from '../app/changesets';
import type { ChangesetAgentMember } from '../app/combinedAgent';
import { changesetHeadSha, changesetMemberForAttachment, parseChangesetHeadSha } from '../app/combinedAgent';
import { connectionForPod } from '../app/connections';
import type { ChangesetSubmitMember, ChangesetSubmitState } from '../app/changesetSubmit';
import { buildChangesetSubmitPlans, performChangesetSubmit } from '../app/changesetSubmit';
import { DEMO_AGENT_ID } from '../app/demoAgent';
import { modelVisiblePath, modelVisibleRootLabelForProject, workspaceRootForProject } from '../app/modelVisiblePath';
import { AgentRunError, assembleChangesetReviewPrompt, changesetContextEntries, countPromptTokens, runFollowUpPrompt } from '../app/lmAgent';
import { fetchPodData } from '../app/podQuery';
import type { PodStore } from '../app/pods';
import {
  budgetAttachments,
  buildReviewContext,
  reviewContextTruncatedForPrompt,
  type Attachment,
  type ContextBudgets,
  type ReviewContext,
} from '../app/reviewContext';
import {
  attachmentKey,
  deduplicateAttachments,
  resolveAttachment,
  type SymbolAttachmentTarget,
} from '../app/attachments';
import {
  ContextReferenceResolutionCoordinator,
  parseContextReferences,
  prepareContextReferencesForRun,
  resolveContextReferences,
  type ContextReferenceCache,
} from '../app/contextReferences';
import { ReviewHistory } from '../app/reviewHistory';
import {
  changesetDraftKeyFor,
  clearChangesetSubmitLedger,
  mergeRetainedDraft,
  readRetained,
  runKeyForChangeset,
  screenForRetained,
  type ChangesetDraft,
} from '../app/retainedReview';
import type { ReviewRunManager, RunInput, RunRecord } from '../app/reviewRunManager';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { composeSummaryBody } from '../app/submit';
import { addedLines, diffStats, parseHunks } from '../domain/diffHunks';
import {
  effortForModel,
  effortLabel,
  isEffortLevel,
  normalizeEffortsByModel,
  setEffortForModel,
} from '../domain/effort';
import { SEVERITY_ORDER } from '../domain/criteria';
import { composeSummary, type AgentVoice } from '../domain/summary';
import { allDecided, clearVerdict, nextUndecided, setVerdict, verdictCounts } from '../domain/reviewState';
import { isReviewItemAnchored, type Category, type Review, type ReviewItem, type Severity } from '../domain/types';
import { getProvider } from '../platform/registry';
import { toScmError } from '../platform/errors';
import { repoCountOf } from './vocab';
import { agentRunConcurrency, agentRunTimeouts } from './agentRunOptions';
import {
  contextSourceEnabledByDefault,
  readContextBudgets,
  readContextSourceDefaults,
  readContextUsageEnabled,
} from './contextOptions';
import { ContextUsageCounter } from './contextUsage';
import {
  attachmentFileTarget,
  attachmentRange,
  findReferenceFile,
  modelVisibleWorkspaceRoots,
  pickContextAttachment,
} from './contextAttachmentPicker';
import { changesetDetectionOptions } from './changesetOptions';
import { flowCommandMessage } from './flowCommands';
import type { AutoContextItemView, ContextUsageView, FlowMessage, FlowScreen, FlowViewState, TriageItemView } from './reviewFlowHtml';
import { renderReviewFlowHtml } from './reviewFlowHtml';
import { livenessView } from './runLiveness';
import { AppSurface, type AppRoute } from './appSurface';
import { locateInWorkspace } from './inDiffEditor';
import type { SidebarActiveReview } from './sidebarHtml';
import { renderMarkdown } from './markdown';
import { findingFollowUpPrompt, followUpQuestion, type AskPreset } from './findingFollowUp';

export interface ChangesetReviewDeps {
  podStore: PodStore;
  secrets: SecretStore;
  workspaceState: KeyValueStore;
  globalState: KeyValueStore;
  /** Where runs live — see `ReviewFlowDeps.runs`. The panel watches, never owns. */
  runs: ReviewRunManager;
  openSingle: (ref: { repoId: string; number: string }) => void;
  openDashboard: () => void;
  onSubmitted?: () => void;
  onSidebarState?: (state?: SidebarActiveReview) => void;
}

interface MemberAttachment {
  repoId: string;
  crNumber: string;
  attachment: Attachment;
}

export class ChangesetReviewPanel {
  private static current: ChangesetReviewPanel | undefined;

  static async open(deps: ChangesetReviewDeps, changesetId: string, selectItemId?: string): Promise<void> {
    const route = AppSurface.show(`changesetReview:${changesetId}`, 'Verdict: Review changeset', deps.openDashboard);
    const controller = new ChangesetReviewPanel(route, deps, changesetId);
    controller.pendingSelectId = selectItemId;
    ChangesetReviewPanel.current = controller;
    await controller.load();
  }

  /** "Verdict: Open review" also means the changeset triage tab when that is the active review. */
  static revealIfOpen(): boolean {
    const panel = ChangesetReviewPanel.current;
    if (!panel || panel.disposed) return false;
    AppSurface.reveal();
    return true;
  }

  static handleCommand(command: string, arg?: unknown): boolean {
    const panel = ChangesetReviewPanel.current;
    if (!panel || panel.disposed || !ChangesetReviewPanel.isCommandTargetActive()) return false;
    const message = flowCommandMessage(command, arg, panel.selectedId);
    if (!message) return false;
    void panel.onMessage(message);
    return true;
  }

  static isCommandTargetActive(): boolean {
    const panel = ChangesetReviewPanel.current;
    return Boolean(panel && !panel.disposed && panel.route.panel.active !== false);
  }

  static selectItem(itemId: string): void {
    const panel = ChangesetReviewPanel.current;
    if (!panel || panel.disposed || !panel.review?.items.some((item) => item.id === itemId)) return;
    panel.selectedId = itemId;
    panel.render();
    AppSurface.reveal();
  }

  private disposed = false;
  private pendingSelectId?: string;
  private reviewFocusActive = false;
  private focusWatch?: vscode.Disposable;
  private changeset!: DetectedChangeset;
  private members: ChangesetAgentMember[] = [];
  private agents: AgentDescriptor[] = [...BUILT_IN_AGENTS];
  private agentId = BUILTIN_AGENT_DESCRIPTOR.id;
  private models: ModelDescriptor[] = [];
  private modelId?: string;
  private modelOpen = false;
  private effortOpen = false;
  private selectionNotices: string[] = [];
  private skippedAgents: SkippedDefinition[] = [];
  /** Same three sources the single-CR panel watches; this screen is the same screen. */
  private agentWatches: vscode.Disposable[] = [];
  private agentOpen = false;
  /** Collapsed until asked for: the findings are what the triage screen is for. */
  private contextOpen = false;
  private readonly contextBudgets: ContextBudgets = readContextBudgets();
  private memberAttachments: MemberAttachment[] = [];
  private referenceAttachments: MemberAttachment[] = [];
  private referenceAttachmentCache: ContextReferenceCache = new Map();
  private removedAttachmentKeys = new Set<string>();
  private unresolvedContextReferences: string[] = [];
  private readonly referenceResolution = new ContextReferenceResolutionCoordinator();
  private autoContextEnabled = new Map<string, boolean>();
  private readonly autoContextDefaults = readContextSourceDefaults();
  private contextUsage?: ContextUsageView;
  private contextUsageEnabled = readContextUsageEnabled();
  private readonly contextUsageCounter = new ContextUsageCounter();
  private contextUsageWatch?: vscode.Disposable;
  private screen: FlowScreen = 'agent';
  private mode: 'split' | 'queue' | 'diff' = 'split';
  private review?: Review;
  private selectedId?: string;
  private threads: Record<string, Array<{ label: string; text: string }>> = {};
  /** This panel's view of the run, mirrored from the manager (see `ReviewFlowPanel`). */
  private runRecord?: RunRecord;
  private runWatch?: vscode.Disposable;
  private newRunFromResult = false;
  private retained?: ReturnType<typeof readRetained<ChangesetDraft>>;
  private summaryText = '';
  private finalNote = '';
  private postThread = true;
  private requestChanges = true;
  private submitError?: string;
  private submitState?: ChangesetSubmitState;
  private stale?: { newHead: string; affected: number; affectedAccepted: number };
  private doneSentence = '';

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: ChangesetReviewDeps,
    private readonly changesetId: string,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      // Unsubscribed, not cancelled — see `ReviewFlowPanel`'s onLeave.
      this.runWatch?.dispose();
      this.runWatch = undefined;
      for (const watch of this.agentWatches) watch.dispose();
      this.agentWatches = [];
      this.focusWatch?.dispose();
      this.focusWatch = undefined;
      this.contextUsageWatch?.dispose();
      this.contextUsageWatch = undefined;
      this.contextUsageCounter.cancel();
      this.setReviewFocus(false);
      this.deps.onSidebarState?.();
      if (ChangesetReviewPanel.current === this) ChangesetReviewPanel.current = undefined;
    });
    // The single-letter triage keys follow the tab's *active* state, never its
    // existence — same rule as ReviewFlowPanel, or A/R/S would fire in
    // whatever editor sits beside the review.
    this.setReviewFocus(route.panel.active !== false);
    this.focusWatch = route.panel.onDidChangeViewState?.((event) =>
      this.setReviewFocus(event.webviewPanel.active),
    );
    route.onMessage((message) => void this.onMessage(message as FlowMessage));
    this.contextUsageWatch = vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('codeVerdict.contextUsage.enabled')) return;
      this.contextUsageEnabled = readContextUsageEnabled();
      this.scheduleContextUsage();
      this.render();
    });
  }

  private setReviewFocus(active: boolean): void {
    this.reviewFocusActive = active && !this.disposed;
    void vscode.commands.executeCommand('setContext', 'verdict.reviewFocus', this.reviewFocusActive);
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewContextFocus',
      this.reviewFocusActive && this.screen === 'agent',
    );
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

  private pod() {
    const pod = this.deps.podStore.activePod;
    if (!pod) throw new Error('No pod configured');
    return pod;
  }

  private draftKey(): string {
    return changesetDraftKeyFor(this.changesetId);
  }

  private memberKey(member: Pick<ChangesetAgentMember, 'ref'>): string {
    return `${member.ref.repoId}!${member.ref.number}`;
  }

  private autoContextId(member: ChangesetAgentMember, kind: string): string {
    return `auto:${this.memberKey(member)}:${kind}`;
  }

  private autoContextItems(): AutoContextItemView[] {
    return this.members.flatMap((member) => {
      const context = member.context;
      if (!context) return [];
      const prefix = member.projectPath;
      const items: AutoContextItemView[] = [{
        id: this.autoContextId(member, 'title'),
        kind: 'title',
        label: `${prefix} · Title · ${context.title}`,
        enabled: this.autoContextEnabled.get(this.autoContextId(member, 'title'))
          ?? contextSourceEnabledByDefault('title', this.autoContextDefaults),
      }];
      if (context.description) {
        items.push({
          id: this.autoContextId(member, 'description'),
          kind: 'description',
          label: `${prefix} · Change request description`,
          enabled: this.autoContextEnabled.get(this.autoContextId(member, 'description'))
            ?? contextSourceEnabledByDefault('description', this.autoContextDefaults),
        });
      }
      context.linkedItems.forEach((item, index) => {
        const id = this.autoContextId(member, `linked:${index}:${item.number}`);
        items.push({
          id,
          kind: 'linkedItem',
          label: `${prefix} · #${item.number}${item.title ? ` · ${item.title}` : ''}`,
          detail: item.resolved ? item.state : 'reference only',
          enabled: this.autoContextEnabled.get(id)
            ?? contextSourceEnabledByDefault('linkedItem', this.autoContextDefaults),
        });
      });
      return items;
    });
  }

  private promptContext(member: ChangesetAgentMember): ReviewContext | undefined {
    const context = member.context;
    if (!context) return undefined;
    const includeTitle = this.autoContextEnabled.get(this.autoContextId(member, 'title'))
      ?? contextSourceEnabledByDefault('title', this.autoContextDefaults);
    const includeDescription = context.description
      ? this.autoContextEnabled.get(this.autoContextId(member, 'description'))
        ?? contextSourceEnabledByDefault('description', this.autoContextDefaults)
      : true;
    const linkedItems = context.linkedItems.filter((item, index) =>
      this.autoContextEnabled.get(this.autoContextId(member, `linked:${index}:${item.number}`))
        ?? contextSourceEnabledByDefault('linkedItem', this.autoContextDefaults),
    );
    if (!includeTitle && (!context.description || !includeDescription) && linkedItems.length === 0) return undefined;
    return { ...context, includeTitle, includeDescription, linkedItems };
  }

  private attachmentsForMember(member: ChangesetAgentMember): Attachment[] {
    return this.attachmentEntries()
      .filter((entry) => entry.repoId === member.ref.repoId && entry.crNumber === member.ref.number)
      .map((entry) => entry.attachment);
  }

  private attachmentEntryKey(entry: MemberAttachment): string {
    return `${entry.repoId}!${entry.crNumber}:${attachmentKey(entry.attachment)}`;
  }

  private attachmentEntries(): MemberAttachment[] {
    const entries = new Map<string, MemberAttachment>();
    for (const entry of [...this.memberAttachments, ...this.referenceAttachments]) {
      const key = this.attachmentEntryKey(entry);
      if (!this.removedAttachmentKeys.has(key) && !entries.has(key)) entries.set(key, entry);
    }
    return [...entries.values()];
  }

  private promptMembers(): ChangesetAgentMember[] {
    return this.members.map((member) => ({
      ...member,
      context: this.promptContext(member),
      attachments: this.attachmentsForMember(member),
    }));
  }

  private attachmentViewId(entry: MemberAttachment): string {
    return `${entry.repoId}!${entry.crNumber}:${entry.attachment.id}`;
  }

  private attachmentViews(): Attachment[] {
    return this.attachmentEntries().map((entry) => {
      const member = this.members.find((candidate) => (
        candidate.ref.repoId === entry.repoId && candidate.ref.number === entry.crNumber
      ));
      return {
        ...entry.attachment,
        id: this.attachmentViewId(entry),
        label: `${member?.projectPath ?? entry.repoId} · ${entry.attachment.label}`,
      };
    });
  }

  private async addContext(): Promise<void> {
    const member = this.members.length === 1
      ? this.members[0]
      : (await vscode.window.showQuickPick(
          this.members.map((candidate) => ({
            label: candidate.projectPath,
            description: `!${candidate.ref.number}`,
            member: candidate,
          })),
          { placeHolder: 'Select changeset member' },
        ))?.member;
    if (!member || this.disposed) return;
    const attachment = await pickContextAttachment();
    if (!attachment || this.disposed) return;
    const entry = { repoId: member.ref.repoId, crNumber: member.ref.number, attachment };
    this.removedAttachmentKeys.delete(this.attachmentEntryKey(entry));
    const existing = this.memberAttachments
      .filter((candidate) => candidate.repoId === member.ref.repoId && candidate.crNumber === member.ref.number)
      .map((candidate) => candidate.attachment);
    const deduplicated = deduplicateAttachments([...existing, attachment]);
    this.memberAttachments = [
      ...this.memberAttachments.filter((entry) => (
        entry.repoId !== member.ref.repoId || entry.crNumber !== member.ref.number
      )),
      ...deduplicated.map((candidate) => ({
        repoId: member.ref.repoId,
        crNumber: member.ref.number,
        attachment: candidate,
      })),
    ];
    this.scheduleContextUsage();
    this.render();
  }

  private async findReferenceSymbol(name: string): Promise<SymbolAttachmentTarget | undefined> {
    const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      'vscode.executeWorkspaceSymbolProvider',
      name,
    ) ?? [];
    const exact = symbols.filter((symbol) => symbol.name === name);
    if (exact.length !== 1) return undefined;
    const symbol = exact[0] as vscode.SymbolInformation;
    return {
      ...attachmentFileTarget(symbol.location.uri),
      name: symbol.name,
      range: attachmentRange(new vscode.Selection(symbol.location.range.start, symbol.location.range.end)),
    };
  }

  private resolveInstructionReferences(
    text: string,
    targetIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.referenceResolution.resolve(text, async (isCurrent) => {
      if (!targetIsCurrent()) return;
      const references = parseContextReferences(text);
      const current = new Set(references.map((reference) => reference.raw));
      for (const reference of this.referenceAttachmentCache.keys()) {
        if (!current.has(reference)) this.referenceAttachmentCache.delete(reference);
      }
      const result = await resolveContextReferences(text, {
        findFile: findReferenceFile,
        findSymbol: (name) => this.findReferenceSymbol(name),
        resolveAttachment: (kind, target) => resolveAttachment(kind, target),
      }, this.referenceAttachmentCache);
      if (this.disposed || !targetIsCurrent() || !isCurrent()) return;
      const unresolved = new Set(result.unresolved);
      this.referenceAttachments = references.flatMap((reference) => {
        const attachment = this.referenceAttachmentCache.get(reference.raw);
        if (!attachment) return [];
        const member = changesetMemberForAttachment(this.members, attachment);
        if (!member) {
          unresolved.add(reference.raw);
          return [];
        }
        return [{ repoId: member.ref.repoId, crNumber: member.ref.number, attachment }];
      });
      this.unresolvedContextReferences = [...unresolved];
    });
  }

  private scheduleContextUsage(): void {
    const model = this.models.find((candidate) => candidate.id === this.modelId);
    if (
      !this.contextUsageEnabled
      || this.screen !== 'agent'
      || this.selectedAgent().source === 'demo'
      || !model?.maxInputTokens
      || this.members.length === 0
    ) {
      this.contextUsageCounter.cancel();
      this.contextUsage = undefined;
      return;
    }
    const prompt = assembleChangesetReviewPrompt(
      this.selectedAgent(),
      this.promptMembers(),
      this.pod().criteria,
      { contextBudgets: this.contextBudgets, effort: this.selectedEffort() },
    );
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    this.contextUsage = undefined;
    this.contextUsageCounter.schedule({
      cacheKey: `${model.id}\0${promptHash}`,
      prompt,
      totalTokens: model.maxInputTokens,
      countTokens: (assembled) => countPromptTokens(model.id, assembled),
    }, (usage) => {
      if (this.disposed) return;
      this.contextUsage = usage;
      this.render();
    });
  }

  private async load(): Promise<void> {
    try {
      const pod = this.pod();
      const connection = await connectionForPod(pod, this.deps.secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      const options = changesetDetectionOptions(this.deps.globalState, pod.id);
      const changeset = detectChangesets(pod, data.changeRequests, data.workItems, options).find((candidate) => candidate.id === this.changesetId);
      if (!changeset) throw new Error('Changeset is no longer available');
      this.changeset = changeset;
      const workspaceRoots = modelVisibleWorkspaceRoots();
      const [members, selection] = await Promise.all([
        Promise.all(changeset.members.map(async (member) => {
          const repository = pod.repos?.find((candidate) => candidate.id === member.ref.repoId);
          const projectIdentifiers = [member.projectPath, repository?.path, repository?.name];
          return {
            ref: member.ref,
            projectPath: member.projectPath,
            diff: await connection.getChangeRequestDiff(member.ref),
            // fetchPodData already fetched the pod's work items for detection —
            // resolving each member's links off that batch costs no request.
            context: buildReviewContext(member, data.workItems, { trailer: options.trailer }),
            workspaceRootLabel: modelVisibleRootLabelForProject(projectIdentifiers, workspaceRoots),
            workspaceRootSourceUri: workspaceRootForProject(projectIdentifiers, workspaceRoots)?.sourceUri,
          };
        })),
        loadAgentSelection(selectionFromPod(pod)),
      ]);
      this.members = members;
      await this.resolveInstructionReferences(pod.criteria.extraInstructions);
      this.applySelection(selection);
      this.armAgentWatches();
      // Same precedence as the single-change-request panel: a run happening now,
      // then a failure nobody has seen, then the completed review.
      this.watchRun();
      this.enterRetained();
      const record = this.deps.runs.get(this.runKey());
      if (record && record.status !== 'succeeded') {
        this.runRecord = record;
        this.screen = 'running';
      }
      if (this.pendingSelectId && this.review?.items.some((item) => item.id === this.pendingSelectId)) {
        this.selectedId = this.pendingSelectId;
      }
      this.pendingSelectId = undefined;
      this.scheduleContextUsage();
      this.render();
    } catch (error) {
      void vscode.window.showErrorMessage(`Verdict: ${error instanceof Error ? error.message : String(error)}`);
      this.deps.openDashboard();
    }
  }

  /**
   * A restored draft was read against the heads recorded in its composite
   * `headSha` — when members moved on since, say so rather than silently
   * triaging against history. The banner's re-run is the changeset re-anchor.
   */
  private markStaleMembers(review: Review): void {
    const previous = parseChangesetHeadSha(review.headSha);
    const moved = new Set(
      this.members
        .filter((member) => previous.get(`${member.ref.repoId}!${member.ref.number}`) !== member.diff.headSha)
        .map((member) => `${member.ref.repoId}!${member.ref.number}`),
    );
    if (moved.size === 0) {
      this.stale = undefined;
      return;
    }
    const affected = review.items.filter((item) => moved.has(`${item.repoId}!${item.crNumber}`));
    this.stale = {
      newHead: changesetHeadSha(this.members),
      affected: affected.length,
      affectedAccepted: affected.filter((item) => review.verdicts[item.id]?.verdict === 'accepted').length,
    };
  }

  private async persist(): Promise<void> {
    if (!this.review) return;
    const key = this.draftKey();
    const edited = {
      review: this.review,
      threads: this.threads,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      submitState: this.submitState,
    } satisfies ChangesetDraft;
    await this.deps.workspaceState.update(
      key,
      mergeRetainedDraft(this.deps.workspaceState.get<ChangesetDraft>(key), edited),
    );
  }

  /** The manager's key for this changeset. */
  private runKey(): string {
    return runKeyForChangeset(this.changesetId);
  }

  /**
   * Start a review of the whole changeset, or attach to the one already running
   * on it. Same shape as the single-change-request panel: the selection is
   * persisted as a preference, the run carries its own copy.
   */
  private async run(): Promise<void> {
    const pod = this.pod();
    const runVocabulary = getProvider(pod.providerId).vocabulary;
    const effort = this.selectedEffort();
    pod.agentId = this.agentId;
    pod.modelId = this.modelId;
    pod.effortByModel = normalizeEffortsByModel(pod.effortByModel);
    await this.deps.podStore.upsert(pod);
    if (this.disposed) return;

    const demo = this.agentId === DEMO_AGENT_ID;
    // A model-backed agent with no model must not reach the transport: an empty
    // id there selects an arbitrary model rather than failing.
    if (!demo && this.modelId === undefined) {
      this.selectionNotices = [`${this.selectedAgent().label} needs a model, and none is selected.`];
      this.screen = 'agent';
      this.render();
      return;
    }

    const input: RunInput = {
      target: { kind: 'changeset', changesetId: this.changesetId, members: this.promptMembers() },
      refLabel: this.changeset.name,
      podId: pod.id,
      criteria: pod.criteria,
      agent: this.selectedAgent(),
      agentLabel: this.selectedAgent().label || this.agentId,
      modelId: demo ? undefined : this.modelId,
      effort,
      timeouts: agentRunTimeouts(),
      contextBudgets: this.contextBudgets,
      steps: [
        'Resolving agent from Copilot workspace…',
        `Indexing every diff across ${this.members.length} ${runVocabulary.changeRequestNounPlural}…`,
        'Cross-referencing contracts between repositories…',
        `Scoring findings against ${runVocabulary.repoNoun} criteria…`,
        'Items ready',
      ],
      demo,
    };

    this.newRunFromResult = false;
    this.runRecord = this.deps.runs.trigger(input, agentRunConcurrency());
    this.screen = 'running';
    this.render();
  }

  /** Mirror the manager's state for this changeset onto the screen. */
  private watchRun(): void {
    this.runWatch?.dispose();
    this.runWatch = this.deps.runs.subscribe((record) => {
      if (this.disposed || record.key !== this.runKey()) return;
      this.runRecord = record;
      if (record.status === 'succeeded') {
        this.deps.runs.acknowledge(record.key);
        this.runRecord = undefined;
        this.enterRetained();
      } else if (record.status === 'cancelled') {
        this.runRecord = undefined;
        if (!this.enterRetained()) this.screen = 'agent';
      }
      this.render();
    });
  }

  /** Start the pickers from what produced the shown review — see `ReviewFlowPanel`. */
  private preselectFromRetained(): void {
    const retained = this.retained;
    if (!retained) return;
    const notices: string[] = [];
    if (this.agents.some((agent) => agent.id === retained.agentId)) {
      this.agentId = retained.agentId;
    } else if (retained.agentLabel) {
      notices.push(`The agent that produced this review, "${retained.agentLabel}", is no longer available.`);
    }
    if (retained.modelId !== undefined) {
      if (this.models.some((model) => model.id === retained.modelId)) {
        this.modelId = retained.modelId;
      } else {
        notices.push(`The model that produced this review, "${retained.modelId}", is no longer available.`);
      }
    }
    if (notices.length > 0) this.selectionNotices = notices;
  }

  /**
   * Load the retained review for this changeset, and say whether there was one.
   * The clean branch used to persist nothing at all, so a reload after a clean
   * re-run walked back into the *previous* run's findings; a clean record is
   * what stops that as well as making the clean screen re-openable.
   */
  private enterRetained(): boolean {
    const retained = readRetained(this.deps.workspaceState.get<ChangesetDraft>(this.draftKey()));
    if (!retained) {
      this.retained = undefined;
      this.review = undefined;
      return false;
    }
    const draft = retained.draft;
    this.retained = retained;
    this.review = retained.outcome === 'clean' ? undefined : draft.review;
    this.threads = draft.threads;
    this.summaryText = draft.summaryText;
    this.finalNote = draft.finalNote;
    this.submitState = draft.submitState;
    this.screen = screenForRetained(retained);
    if (this.review) {
      this.selectedId = nextUndecided(this.review)?.id ?? this.review.items[0]?.id;
      this.markStaleMembers(this.review);
    } else {
      this.stale = undefined;
    }
    if (this.screen === 'done' && !this.doneSentence) {
      this.doneSentence = 'This review was submitted.';
    }
    return true;
  }

  private async onMessage(message: FlowMessage): Promise<void> {
    const pod = this.pod();
    switch (message.type) {
      case 'toggleAgentOpen': this.agentOpen = !this.agentOpen; break;
      case 'selectAgent': {
        this.agentId = message.agentId;
        this.agentOpen = false;
        const preferred = preferredModelFor(this.selectedAgent(), this.models);
        if (preferred.modelId) this.modelId = preferred.modelId;
        if (preferred.notice) this.selectionNotices = [preferred.notice];
        break;
      }
      case 'toggleModelOpen': this.modelOpen = !this.modelOpen; this.effortOpen = false; break;
      case 'selectModel': this.modelId = message.modelId; this.modelOpen = false; this.effortOpen = false; break;
      case 'toggleEffortOpen':
        if (this.selectedAgent().source !== 'demo' && this.models.some((model) => model.id === this.modelId)) {
          this.effortOpen = !this.effortOpen;
          this.modelOpen = false;
        }
        break;
      case 'selectEffort':
        if (!this.modelId || !isEffortLevel(message.effort)) break;
        pod.effortByModel = setEffortForModel(pod.effortByModel, this.modelId, message.effort);
        await this.deps.podStore.upsert(pod);
        this.effortOpen = false;
        break;
      case 'dismissNotices': this.selectionNotices = []; break;
      case 'showSkippedAgents':
        void vscode.window.showWarningMessage(
          `Verdict: skipped ${this.skippedAgents.length} agent file(s) — `
            + this.skippedAgents.map((skip) => `${skip.path} (${skip.reason})`).join('; '),
        );
        break;
      case 'setFloor': pod.criteria.severityFloor = message.floor; await this.deps.podStore.upsert(pod); break;
      case 'setConfidence': pod.criteria.minConfidence = message.value; await this.deps.podStore.upsert(pod); break;
      case 'toggleCategory': {
        const categories = new Set(pod.criteria.categories);
        if (categories.has(message.category)) categories.delete(message.category); else categories.add(message.category);
        pod.criteria.categories = [...categories] as Category[];
        await this.deps.podStore.upsert(pod);
        break;
      }
      case 'setInstructions':
        pod.criteria.extraInstructions = message.text;
        await this.deps.podStore.upsert(pod);
        await this.resolveInstructionReferences(message.text);
        break;
      case 'addContext': await this.addContext(); return;
      case 'removeContextItem': {
        const entry = this.attachmentEntries().find((candidate) => this.attachmentViewId(candidate) === message.itemId);
        if (entry) this.removedAttachmentKeys.add(this.attachmentEntryKey(entry));
        break;
      }
      case 'toggleAutoContextItem': {
        const item = this.autoContextItems().find((candidate) => candidate.id === message.itemId);
        if (item) this.autoContextEnabled.set(message.itemId, !item.enabled);
        break;
      }
      case 'run': {
        const targetIsCurrent = (): boolean => !this.disposed;
        const instructions = message.instructions ?? pod.criteria.extraInstructions;
        await prepareContextReferencesForRun(
          instructions,
          pod.criteria.extraInstructions,
          async (latest) => {
            if (!targetIsCurrent()) return;
            pod.criteria.extraInstructions = latest;
            await this.deps.podStore.upsert(pod);
          },
          (latest) => this.resolveInstructionReferences(latest, targetIsCurrent),
        );
        if (!targetIsCurrent()) return;
        void this.run();
        return;
      }
      // Two meanings on one message — see `ReviewFlowPanel`. A live run is
      // stopped; a failed one is dismissed back to the pickers, which is what
      // the failure screen's "Switch agent" asks for.
      case 'cancel':
        if (this.runRecord && this.runRecord.status !== 'queued' && this.runRecord.status !== 'running') {
          this.deps.runs.acknowledge(this.runKey());
          this.runRecord = undefined;
          this.screen = 'agent';
          break;
        }
        this.deps.runs.cancel(this.runKey());
        return;
      case 'retryRun': case 'rerun': void this.run(); return;
      case 'usePartial':
        this.deps.runs.acknowledge(this.runKey());
        this.runRecord = undefined;
        if (!this.enterRetained()) this.screen = 'agent';
        break;
      case 'newRun':
        // The pickers, over a result that stays exactly where it is, started
        // from what produced it — see `ReviewFlowPanel.preselectFromRetained`.
        this.newRunFromResult = this.retained !== undefined;
        this.preselectFromRetained();
        this.memberAttachments = [];
        this.removedAttachmentKeys = new Set();
        await this.resolveInstructionReferences(pod.criteria.extraInstructions);
        this.screen = 'agent';
        break;
      case 'backToResult':
        if (!this.enterRetained()) this.screen = 'agent';
        break;
      case 'toggleReviewContext': this.contextOpen = !this.contextOpen; break;
      case 'setMode': this.mode = message.mode; break;
      case 'select': this.selectedId = message.itemId; break;
      case 'verdict': {
        if (!this.review) return;
        const item = this.review.items.find((candidate) => candidate.id === message.itemId);
        this.review = setVerdict(
          this.review,
          message.itemId,
          message.verdict,
          message.applyFix && Boolean(item?.suggestion) && Boolean(item && isReviewItemAnchored(item)),
        );
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
        await this.ask(item, message.preset, message.text);
        return;
      }
      case 'openInEditor': {
        const item = this.review?.items.find((candidate) => (
          candidate.file === message.file && candidate.line === message.line
        ));
        const located = item ? await locateInWorkspace(item) : undefined;
        if (!located) {
          void vscode.window.showInformationMessage(
            `Verdict: ${message.file} is not in this workspace — it lives in the reviewed repository.`,
          );
          return;
        }
        const editor = await vscode.window.showTextDocument(located.document, { preview: true });
        const position = new vscode.Position(located.line - 1, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
          located.document.lineAt(located.line - 1).range,
          vscode.TextEditorRevealType.InCenterIfOutsideViewport,
        );
        return;
      }
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
      case 'copyMarkdown': await vscode.env.clipboard.writeText(composeSummaryBody(
        this.summaryText,
        this.finalNote,
        this.review,
        this.withheldInlineItems(),
      )); return;
      case 'backToTriage': this.screen = 'triage'; break;
      case 'lowerBar': {
        const index = SEVERITY_ORDER.indexOf(pod.criteria.severityFloor);
        pod.criteria.severityFloor = SEVERITY_ORDER[Math.max(0, index - 1)] as Severity;
        pod.criteria.minConfidence = Math.max(0, pod.criteria.minConfidence - 20);
        await this.deps.podStore.upsert(pod);
        this.screen = 'agent';
        break;
      }
      case 'setCrossTarget': {
        // Re-route a cross finding's comment to another of its sides — only
        // to a side that resolves to an added line of that member's diff.
        if (!this.review) return;
        const item = this.review.items.find((candidate) => candidate.id === message.itemId);
        const span = item?.spans?.find((candidate) => candidate.repoId === message.repoId && candidate.location === message.location);
        const member = this.members.find((candidate) => candidate.ref.repoId === message.repoId);
        const anchor = member && span ? spanAnchor(span.location, member) : undefined;
        if (!item || !member || !anchor) return;
        this.review = {
          ...this.review,
          items: this.review.items.map((candidate) => candidate.id === item.id
            ? { ...candidate, repoId: member.ref.repoId, crNumber: member.ref.number, file: anchor.file, line: anchor.line, code: anchor.text }
            : candidate),
        };
        await this.persist();
        break;
      }
      case 'reviewSingle': if (message.repoId && message.number) this.deps.openSingle({ repoId: message.repoId, number: message.number }); return;
      // A changeset spans several change requests, so there is no single one to
      // approve; renderClean stops offering the button once `changeset` is set.
      // This stays as the fallback for a stale page that still posts 'approve'.
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
    this.scheduleContextUsage();
    this.render();
  }

  private generateSummary(): string {
    if (!this.review) return '';
    const voice = vscode.workspace.getConfiguration('codeVerdict').get<AgentVoice>('agentVoice', 'terse');
    return composeSummary(this.review, this.agentLabel(), voice);
  }

  private async ask(item: Review['items'][number], preset: AskPreset, text?: string): Promise<void> {
    const question = followUpQuestion(preset, text);
    if (question === '') return;
    const label = preset === 'freeform' ? 'agent · reply' : `agent · ${preset}`;
    const list = (this.threads[item.id] ??= []);
    const canned = preset === 'freeform' ? undefined : item.answers?.[preset];
    if (canned !== undefined) {
      list.push({ label, text: canned });
      this.postThreadUpdate(item.id, list);
      await this.persist();
      return;
    }
    if (this.modelId === undefined || this.selectedAgent().source === 'demo') {
      list.push({ label, text: 'This agent does not answer follow-up questions.' });
      this.postThreadUpdate(item.id, list);
      await this.persist();
      return;
    }

    list.push({ label, text: 'Thinking…' });
    const entry = list[list.length - 1] as { label: string; text: string };
    this.postThreadUpdate(item.id, list);
    try {
      const member = this.members.find((candidate) => (
        candidate.ref.repoId === item.repoId && candidate.ref.number === item.crNumber
      ));
      const hunk = member?.diff.files.find((file) => (
        modelVisiblePath(file.newPath, member.workspaceRootLabel) === item.file
      ))?.diff;
      entry.text = await runFollowUpPrompt(
        this.selectedAgent(),
        this.modelId,
        findingFollowUpPrompt(item, question, hunk),
        { timeouts: agentRunTimeouts(), effort: this.selectedEffort() },
      );
    } catch (error) {
      const message = error instanceof AgentRunError ? error.message : toScmError(error).message;
      entry.text = `The agent could not answer: ${message}`;
    }
    this.postThreadUpdate(item.id, list);
    await this.persist();
  }

  private postThreadUpdate(itemId: string, list: Array<{ label: string; text: string }>): void {
    if (this.disposed) return;
    void this.panel.webview.postMessage({
      type: 'verdict:thread',
      itemId,
      thread: list.map((entry) => ({ ...entry, html: renderMarkdown(entry.text) })),
    });
  }

  private submitMembers(): ChangesetSubmitMember[] {
    return this.members.map((member) => ({
      ref: member.ref,
      anchorRefs: member.diff.anchorRefs,
      candidatesFor: (file: string) => {
        const changed = member.diff.files.find((candidate) => (
          modelVisiblePath(candidate.newPath, member.workspaceRootLabel) === file
        ));
        return changed ? addedLines(changed.diff) : undefined;
      },
      projectLabel: member.projectPath,
      workspaceRootLabel: member.workspaceRootLabel,
    }));
  }

  private withheldInlineItems(): ReviewItem[] {
    if (!this.review) return [];
    const pod = this.pod();
    return buildChangesetSubmitPlans(
      this.review,
      this.submitMembers(),
      this.agentLabel(),
      pod.username ?? 'you',
      '',
      false,
      false,
    ).flatMap((plan) => plan.withheld);
  }

  private async submit(): Promise<void> {
    if (!this.review || this.screen !== 'summary' || !allDecided(this.review)) return;
    const pod = this.pod();
    const provider = getProvider(pod.providerId);
    const issueRef = this.changeset.linkedIssue ? ` (${this.changeset.linkedIssue})` : '';
    const footer = `Part of changeset “${this.changeset.name}”${issueRef} — reviewed together across ${this.members.length} repositories with ${this.agentLabel()}.`;
    const summary = `${composeSummaryBody(this.summaryText, this.finalNote, this.review)}\n\n---\n\n${footer}`;
    const plans = buildChangesetSubmitPlans(
      this.review,
      this.submitMembers(),
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
      this.submitError = result.failures[0]?.message ?? `Some ${getProvider(this.pod().providerId).vocabulary.changeRequestNounPlural} rejected the review`;
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
        items: memberItems.filter((item) => this.review?.verdicts[item.id]?.verdict === 'accepted').map((item) => ({
          id: item.id,
          title: item.title,
          severity: item.severity,
          file: item.file,
          line: item.line,
          // The changeset screen re-reads these after submit clears the draft.
          cross: item.cross ?? false,
          spans: item.spans,
          confidence: item.confidence,
        })),
        observations: memberItems.flatMap((item) => {
          const verdict = this.review?.verdicts[item.id]?.verdict;
          return verdict
            ? [{ category: item.category, confidence: item.confidence, verdict, severity: item.severity }]
            : [];
        }),
        requestedChanges: result.state.requestChangesRefs.includes(`${member.ref.repoId}!${member.ref.number}`),
      });
    }
    // Same reason as the single-change-request path: the ledger is transient,
    // the review it was attached to is not.
    const submittedDraft = this.deps.workspaceState.get<ChangesetDraft>(this.draftKey());
    if (submittedDraft) {
      await this.deps.workspaceState.update(
        this.draftKey(),
        clearChangesetSubmitLedger(submittedDraft, new Date().toISOString()),
      );
    }
    const counts = verdictCounts(this.review);
    this.doneSentence = `${counts.accepted} inline comments posted across ${this.members.length} ${getProvider(this.pod().providerId).vocabulary.changeRequestNounPlural}. ${counts.rejected} dismissed findings stayed local.`;
    this.submitError = undefined;
    this.screen = 'done';
    this.deps.onSubmitted?.();
    this.render();
  }

  private agentLabel(): string {
    return this.selectedAgent().label || this.agentId;
  }


  /**
   * How the stored review's model should read on the triage meta line. The
   * label when it is still available, the bare id when it is not (better than
   * nothing — it still names what ran), and undefined for a demo review or
   * one stored before models were recorded, which renders as "model unknown".
   */
  private reviewModelLabel(): string | undefined {
    const modelId = this.review?.modelId;
    if (modelId === undefined) return undefined;
    return this.models.find((model) => model.id === modelId)?.label ?? modelId;
  }

  private applySelection(next: AgentSelectionState): void {
    this.agents = next.agents;
    this.models = next.models;
    this.skippedAgents = next.skippedAgents;
    this.agentId = next.agentId;
    this.modelId = next.modelId;
    this.selectionNotices = next.selectionNotices;
  }

  private armAgentWatches(): void {
    if (this.agentWatches.length > 0) return;
    this.agentWatches = watchAgentSources(() => void this.refreshAgents());
  }

  private async refreshAgents(): Promise<void> {
    if (this.disposed) return;
    const next = await loadAgentSelection({ agentId: this.agentId, modelId: this.modelId });
    if (this.disposed) return;
    this.applySelection(next);
    this.scheduleContextUsage();
    if (this.screen === 'agent') this.render();
  }

  /** Never undefined: the built-in agent is always in `this.agents`. */
  private selectedAgent(): AgentDescriptor {
    return this.agents.find((agent) => agent.id === this.agentId) ?? BUILTIN_AGENT_DESCRIPTOR;
  }

  private selectedEffort() {
    return effortForModel(this.pod().effortByModel, this.modelId);
  }

  /**
   * The sides of a cross finding the user may re-target the comment to
   * (handoff §16: "spans[0] by convention, overridable in the UI"). A side
   * qualifies only when its location is an added line of that member's diff —
   * the same ownership rule `validateChangesetResponse` enforces on agents.
   */
  private crossTargets(item: Review['items'][number]): TriageItemView['crossTargets'] {
    if (!item.cross || !item.spans) return undefined;
    const targets = item.spans.flatMap((span) => {
      const member = this.members.find((candidate) => candidate.ref.repoId === span.repoId);
      const anchor = member && spanAnchor(span.location, member);
      return member && anchor
        ? [{
            repoId: member.ref.repoId,
            number: member.ref.number,
            location: span.location,
            active: item.repoId === member.ref.repoId && item.crNumber === member.ref.number
              && item.file === anchor.file && item.line === anchor.line,
          }]
        : [];
    });
    return targets.length > 1 ? targets : undefined;
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
      crossTargets: this.crossTargets(item),
    }));
    const selected = items.find((view) => view.item.id === this.selectedId) ?? items[0];
    const selectedMember = this.members.find((member) => member.ref.repoId === selected?.item.repoId && member.ref.number === selected.item.crNumber);
    const diffLines = this.mode === 'diff'
      ? selectedMember?.diff.files
        .filter((file) => modelVisiblePath(file.newPath, selectedMember.workspaceRootLabel) === selected?.item.file)
        .flatMap((file) => parseHunks(file.diff).flatMap((hunk) => hunk.lines))
      : undefined;
    const counts = this.review ? verdictCounts(this.review) : { accepted: 0, rejected: 0, skipped: 0, undecided: 0 };
    const totalFiles = this.members.reduce((count, member) => count + member.diff.files.length, 0);
    // "The summed diff stat" (spec §15) — literal sums over the member diffs.
    const memberStats = diffStats(this.members.flatMap((member) => member.diff.files.map((file) => file.diff)));
    const history = new ReviewHistory(this.deps.globalState).list().filter((record) => record.podId === pod.id);
    const produced = history.reduce((count, record) => count + record.counts.accepted + record.counts.rejected + record.counts.skipped, 0);
    const vocabulary = getProvider(pod.providerId).vocabulary;
    // The same contexts the prompt carries, under labels a human reads instead
    // of the wire format's — see ReviewContextView.truncated for why the
    // measurement below still runs against the prompt's own entries.
    const contextEntries = this.members.flatMap((member) => (member.context
      ? [{ context: member.context, label: `${member.projectPath} · ${vocabulary.formatCrRef(member.ref.number)}` }]
      : []));
    const state: FlowViewState = {
      vocabulary,
      screen: this.screen,
      changeset: {
        id: this.changeset.id,
        name: this.changeset.name,
        linkedIssue: this.changeset.linkedIssue,
        memberCount: this.members.length,
        projectCount: new Set(this.members.map((member) => member.ref.repoId)).size,
        refs: this.members.map((member) => vocabulary.formatCrRef(member.ref.number)),
        repoLabels: Object.fromEntries(this.members.map((member) => [member.ref.repoId, member.projectPath])),
      },
      header: {
        refLabel: this.members.map((member) => vocabulary.formatCrRef(member.ref.number)).join(' · '),
        projectPath: repoCountOf(vocabulary, this.members.length),
        branch: this.changeset.linkedIssue ?? this.changeset.detectionDetail,
        fileCount: totalFiles,
        added: memberStats.added,
        removed: memberStats.removed,
        title: this.changeset.name,
      },
      agents: this.agents,
      agentId: this.agentId,
      models: this.models,
      modelId: this.modelId,
      modelOpen: this.modelOpen,
      effort: this.selectedEffort(),
      effortOpen: this.effortOpen,
      effortComparisonDisclosure: (this.retained?.draft.review.items.length ?? 0) > 0 && this.screen === 'agent',
      reviewModelLabel: this.reviewModelLabel(),
      reviewEffortLabel: this.review ? effortLabel(this.review.effort) : undefined,
      selectionNotices: this.selectionNotices,
      skippedAgents: this.skippedAgents,
      agentOpen: this.agentOpen,
      criteria: pod.criteria,
      attachments: budgetAttachments(this.attachmentViews()),
      autoContextItems: this.autoContextItems(),
      contextUsage: this.contextUsage,
      unresolvedContextReferences: this.unresolvedContextReferences,
      acceptRate: produced > 0 ? Math.round((history.reduce((count, record) => count + record.counts.accepted, 0) / produced) * 100) : undefined,
      runSteps: this.runRecord?.steps ?? [],
      runStep: this.runRecord?.step ?? 0,
      runLive: livenessView(this.runRecord),
      runError: this.runRecord?.status === 'failed' && this.runRecord.failure
        ? { ...this.runRecord.failure, partialCount: 0 }
        : undefined,
      runQueued: this.runRecord?.status === 'queued',
      retainedAvailable: this.retained !== undefined && (this.screen === 'running' || this.newRunFromResult),
      retainedMeta: this.retained
        ? { ranAt: this.retained.ranAt, agentLabel: this.retained.agentLabel ?? this.selectedAgent().label, modelLabel: this.reviewModelLabel(), effortLabel: effortLabel(this.retained.draft.review.effort) }
        : undefined,
      mode: this.mode,
      items,
      selectedId: this.selectedId,
      diffLines,
      counts,
      context: contextEntries.length > 0
        ? {
            open: this.contextOpen,
            truncated: reviewContextTruncatedForPrompt(changesetContextEntries(this.members), this.contextBudgets),
            entries: contextEntries,
          }
        : undefined,
      stale: this.stale,
      // From the retained record — see `ReviewFlowPanel`.
      candidates: this.retained?.candidates ?? [],
      filesRead: this.retained?.filesRead ?? totalFiles,
      attachmentWarnings: this.retained?.attachmentWarnings ?? [],
      summaryText: this.summaryText,
      withheldInlineItemIds: this.withheldInlineItems().map((item) => item.id),
      finalNote: this.finalNote,
      postThread: this.postThread,
      requestChanges: this.requestChanges,
      supportsRequestChanges: providerCapabilities(pod.providerId).requestChanges,
      submitError: this.submitError,
      username: pod.username ?? 'you',
      doneSentence: this.doneSentence,
      crWebUrl: this.changeset.members[0]?.webUrl ?? '',
    };
    const abbrev = `${this.members.length} ${vocabulary.changeRequestAbbrev}s`;
    this.panel.title = this.screen === 'done' ? `Verdict: Posted · ${abbrev}` : `Verdict: Review · ${abbrev}`;
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewContextFocus',
      this.reviewFocusActive && this.screen === 'agent',
    );
    this.panel.webview.html = renderReviewFlowHtml(state, this.agentLabel(), crypto.randomBytes(16).toString('hex'));
    this.deps.onSidebarState?.(this.review ? {
      // Spec §15: the chrome names the changeset — `⧉ <name>` over
      // "N MRs · N repos" with the summed diff stat.
      headline: `⧉ ${this.changeset.name}`,
      refLabel: abbrev,
      changeset: true,
      context: `${abbrev} · ${new Set(this.members.map((member) => member.ref.repoId)).size} repos`,
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
        cross: item.cross,
        verdict: this.review?.verdicts[item.id]?.verdict,
        selected: item.id === this.selectedId,
      })),
    } : undefined);
  }
}

function providerCapabilities(providerId: string) {
  return getProvider(providerId).capabilities;
}

/** `path/to/file.ts:88` → a real added-line anchor in that member's diff, or nothing. */
function spanAnchor(
  location: string,
  member: ChangesetAgentMember,
): { file: string; line: number; text: string } | undefined {
  const separator = location.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const file = location.slice(0, separator);
  const line = Number(location.slice(separator + 1));
  if (!Number.isInteger(line)) return undefined;
  const diffFile = member.diff.files.find((candidate) => (
    modelVisiblePath(candidate.newPath, member.workspaceRootLabel) === file
  ));
  const added = diffFile ? addedLines(diffFile.diff).find((candidate) => candidate.line === line) : undefined;
  return added ? { file, line, text: added.text.trim() } : undefined;
}