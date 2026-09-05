/**
 * The review-flow panel: one webview tab hosting the state machine
 * agent → running → triage/clean → summary → done (handoff §2), with the
 * tab title tracking the state and drafts surviving reloads via
 * workspaceState.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS } from '../commands';
import { toScmError } from '../platform/errors';
import { connectionForPod } from '../app/connections';
import type { AgentDescriptor, ModelDescriptor } from '../app/agents';
import { BUILTIN_AGENT_DESCRIPTOR, BUILT_IN_AGENTS, DEMO_AGENT_DESCRIPTOR } from '../app/agents';
import { type SkippedDefinition } from '../app/agentDefinitions';
import { loadAgentSelection, watchAgentSources } from './agentRefresh';
import { preferredModelFor, selectionFromPod } from '../app/podSelection';
import { AgentRunError, assembleReviewPrompt, countPromptTokens, discoverModels, runFollowUpPrompt } from '../app/lmAgent';
import type { AgentSelectionState } from './agentRefresh';
import type { PodStore } from '../app/pods';
import {
  buildReviewContext,
  budgetAttachments,
  reviewContextTruncatedForPrompt,
  type ReviewContext,
  type ReviewContextEntry,
  type ContextBudgets,
  type Attachment,
} from '../app/reviewContext';
import {
  attachmentKey,
  deduplicateAttachments,
  resolveAttachment,
  type FileAttachmentTarget,
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
  carryRetainedResult,
  clearSubmitLedger,
  draftKeyFor,
  readRetained,
  runKeyForCr,
  screenForRetained,
  type SessionDraft,
} from '../app/retainedReview';
import { CoalescedDraftWriter } from '../app/draftWriter';
import type { ReviewRunManager, RunInput, RunRecord } from '../app/reviewRunManager';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { composeCommentDrafts, composeSummaryBody, performSubmit } from '../app/submit';
import { type AnchorCandidate, movedAnchors, resolveAnchor } from '../domain/anchor';
import { addedLines, diffStats, parseHunks } from '../domain/diffHunks';
import {
  effortForModel,
  effortLabel,
  isEffortLevel,
  normalizeEffortsByModel,
  setEffortForModel,
} from '../domain/effort';
import { composeSummary } from '../domain/summary';
import type { AgentVoice } from '../domain/summary';
import {
  allDecided,
  clearVerdict,
  firstOfSeverity,
  isStale,
  nextUndecided,
  setVerdict,
  verdictCounts,
} from '../domain/reviewState';
import { isReviewItemAnchored, type Category, type Review, type ReviewItem, type Severity } from '../domain/types';
import { SEVERITY_ORDER } from '../domain/criteria';
import { getProvider } from '../platform/registry';
import { isScmError } from '../platform/errors';
import type { ChangeRequest, ChangeRequestDiff, ChangeRequestRef, WorkItem } from '../platform/types';
import { flowCommandMessage } from './flowCommands';
import type { AutoContextItemView, ContextUsageView, FlowMessage, FlowScreen, FlowViewState, SubmitProgressView, TriageItemView } from './reviewFlowHtml';
import { renderReviewFlowBody, renderReviewFlowErrorHtml, renderReviewFlowHtml, renderReviewFlowLoadingHtml, reviewFlowCrumb } from './reviewFlowHtml';
import { AppSurface, type AppRoute } from './appSurface';
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
import { changesetTrailer } from './changesetOptions';
import { escapeHtml } from './theme';
import { renderMarkdown } from './markdown';
import { InDiffEditor, locateInWorkspace } from './inDiffEditor';
import type { SidebarActiveReview, SidebarPendingReview } from './sidebarHtml';
import { findingFollowUpPrompt, followUpQuestion, type AskPreset } from './findingFollowUp';
import { modelVisibleRootLabelForProject, providerRelativePath } from '../app/modelVisiblePath';

/**
 * How often triage asks whether the branch moved under it (handoff §6 —
 * "poll the MR head"). Slow enough to be invisible on the API budget, quick
 * enough that a push lands in the banner while the reviewer is still reading.
 */
const HEAD_POLL_MS = 45_000;

export interface ReviewFlowDeps {
  podStore: PodStore;
  secrets: SecretStore;
  workspaceState: KeyValueStore;
  globalState: KeyValueStore;
  /**
   * Where runs live. The panel triggers one and subscribes to it; it does not
   * own it, and closing the panel does not end it — which is the whole point.
   */
  runs: ReviewRunManager;
  onSubmitted?: () => void;
  onSidebarState?: (state?: SidebarActiveReview) => void;
  /** Spec §3: identity and agent, before any findings exist. */
  onSidebarPending?: (state?: SidebarPendingReview) => void;
  /**
   * Which detected changeset (if any) this MR belongs to — resolved lazily
   * after first paint so the entry-point chip never slows a review open.
   */
  changesetForCr?: (ref: ChangeRequestRef) => Promise<{ id: string; name: string; memberCount: number } | undefined>;
  openChangeset?: (changesetId: string) => void;
}

export class ReviewFlowPanel {
  private static current: ReviewFlowPanel | undefined;

  static async open(deps: ReviewFlowDeps, ref: ChangeRequestRef): Promise<void> {
    const existing = ReviewFlowPanel.current;
    if (existing && !existing.disposed) {
      await existing.load(ref);
      if (!existing.disposed) AppSurface.reveal();
      return;
    }
    const route = AppSurface.show(
      'review',
      'Verdict: Run review',
      () => void vscode.commands.executeCommand(COMMANDS.openDashboard),
    );
    ReviewFlowPanel.current = new ReviewFlowPanel(route, deps);
    await ReviewFlowPanel.current.load(ref);
  }

  /** "Verdict: Open review" — the triage tab for the active MR (naming doc). */
  static revealIfOpen(): boolean {
    const panel = ReviewFlowPanel.current;
    if (!panel || panel.disposed) return false;
    AppSurface.reveal();
    return true;
  }

  static handleCommand(command: string, arg?: unknown): boolean {
    const panel = ReviewFlowPanel.current;
    if (!panel || panel.disposed || !ReviewFlowPanel.isCommandTargetActive()) return false;
    return panel.dispatchCommand(command, arg);
  }

  static isCommandTargetActive(): boolean {
    const panel = ReviewFlowPanel.current;
    return Boolean(panel && !panel.disposed && panel.route.panel.active !== false);
  }

  /** `codeVerdict.showRunDiagnostics`'s own read: this panel's mirrored `RunRecord` (the same one `render()` builds `runError`/`runProjection` from), if this panel is open at all — no focus requirement, unlike `handleCommand`'s keyboard-command routing. */
  static activeRunRecord(): RunRecord | undefined {
    const panel = ReviewFlowPanel.current;
    return panel && !panel.disposed ? panel.runRecord : undefined;
  }

  /**
   * Whether this panel is open at all — `codeVerdict.showRunDiagnostics`'s own "how many review
   * panels were open" count for its not-found report. Deliberately side-effect-free, unlike
   * `revealIfOpen`: a diagnostic count must not itself bring a panel into focus.
   */
  static isOpen(): boolean {
    const panel = ReviewFlowPanel.current;
    return Boolean(panel && !panel.disposed);
  }

  static selectItem(itemId: string): void {
    const panel = ReviewFlowPanel.current;
    if (!panel || panel.disposed || !panel.review?.items.some((item) => item.id === itemId)) return;
    panel.selectedId = itemId;
    panel.render();
    AppSurface.reveal();
  }

  private disposed = false;
  private screen: FlowScreen = 'agent';
  private ref!: ChangeRequestRef;
  /**
   * Optional, not definite-assigned: load() clears it per MR (see its reset
   * block) and it is only set once that MR's fetch returns, so every reader
   * has to cope with the window in between (#39).
   */
  private cr?: ChangeRequest;
  private diff?: ChangeRequestDiff;
  /**
   * What this change is for, built once in `load()` and read twice: the agent
   * prompt gets it, and the triage screen renders the same structure rather
   * than deriving its own — so the reviewer sees exactly what the model saw.
   */
  private reviewContext?: ReviewContext;
  private manualAttachments: Attachment[] = [];
  private referenceAttachments: Attachment[] = [];
  private referenceAttachmentCache: ContextReferenceCache = new Map();
  private removedAttachmentKeys = new Set<string>();
  private unresolvedContextReferences: string[] = [];
  private autoContextEnabled = new Map<string, boolean>();
  private readonly autoContextDefaults = readContextSourceDefaults();
  private readonly referenceResolution = new ContextReferenceResolutionCoordinator();
  private contextUsage?: ContextUsageView;
  private contextUsageEnabled = readContextUsageEnabled();
  private readonly contextUsageCounter = new ContextUsageCounter();
  private contextUsageWatch?: vscode.Disposable;
  private reviewFocusActive = false;
  /** Collapsed until asked for: the findings are what the triage screen is for. */
  private contextOpen = false;
  private readonly contextBudgets: ContextBudgets = readContextBudgets();
  private agents: AgentDescriptor[] = [...BUILT_IN_AGENTS];
  private agentId: string = BUILTIN_AGENT_DESCRIPTOR.id;
  private agentOpen = false;
  private models: ModelDescriptor[] = [];
  private modelId?: string;
  private modelOpen = false;
  private effortOpen = false;
  private selectionNotices: string[] = [];
  private skippedAgents: SkippedDefinition[] = [];
  /** File-system, model-list and settings watchers; all three feed `refreshAgents`. */
  private agentWatches: vscode.Disposable[] = [];
  private review?: Review;
  private threads: Record<string, Array<{ label: string; text: string }>> = {};
  /**
   * itemId → in-progress ask text (task 9.3): the panel's own copy of what is
   * being typed into #ask, committed on debounced input. The panel used to
   * hold nothing for it, so a flow-body patch re-rendered the field empty and
   * the half-typed question was gone — REGIONS_SCRIPT restores focus and
   * selection only, never `value` (D8). Memory-only: unlike the summary and
   * the note, an unasked question is not part of the persisted draft.
   */
  private askDrafts: Record<string, string> = {};
  private mode: 'split' | 'queue' | 'diff' = 'split';
  private selectedId?: string;
  /**
   * The run this panel is looking at, mirrored from the manager. It is a view,
   * not the run: the panel closing or navigating elsewhere drops this field and
   * touches nothing the manager holds.
   */
  private runRecord?: RunRecord;
  /** The completed review this change request currently shows, if any. */
  private retained?: ReturnType<typeof readRetained<SessionDraft>>;
  private runWatch?: vscode.Disposable;
  /**
   * The reviewer opened the pickers from a result that is still retained. The
   * agent screen then owes them a way back to it — nothing has replaced it.
   */
  private newRunFromResult = false;
  private summaryText = '';
  private finalNote = '';
  private postThread = true;
  private requestChanges = true;
  private submitError?: string;
  private failedKeys?: Set<string>;
  private summaryPosted = false;
  /** The request-changes verdict landed — never send it twice (spec §7 ledger). */
  private verdictApplied = false;
  private doneSentence = '';
  private staleHead?: string;
  /** Items whose anchor no longer resolves against the branch's new head. */
  private staleItemIds = new Set<string>();
  private headPoll?: ReturnType<typeof setInterval>;
  private readonly inDiff = new InDiffEditor();
  private inDiffKey = '';
  private focusWatch?: vscode.Disposable;
  /** Coalesces the panel's draft writes and guards them against a newer run's record (D9). */
  private readonly draftWriter: CoalescedDraftWriter;
  private windowFocusWatch?: vscode.Disposable;

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: ReviewFlowDeps,
  ) {
    this.draftWriter = new CoalescedDraftWriter(deps.workspaceState);
    route.onLeave(() => {
      this.disposed = true;
      // Flush point (D9): the panel is going away — land any pending draft
      // write while the record it snapshotted still has an owner.
      this.draftWriter.flushQuietly();
      // Deliberately NOT cancelling the run. Leaving the screen used to end it
      // — the reviewer who glanced at the dashboard came back to the agent
      // picker with nothing to show for the minutes the model had spent. The
      // panel unsubscribes; the run carries on and finishes headlessly.
      this.runWatch?.dispose();
      this.runWatch = undefined;
      this.stopHeadPoll();
      for (const watch of this.agentWatches) watch.dispose();
      this.agentWatches = [];
      this.inDiff.dispose();
      this.focusWatch?.dispose();
      this.focusWatch = undefined;
      this.contextUsageWatch?.dispose();
      this.contextUsageWatch = undefined;
      this.contextUsageCounter.cancel();
      this.windowFocusWatch?.dispose();
      this.windowFocusWatch = undefined;
      this.deps.onSidebarState?.();
      this.deps.onSidebarPending?.();
      this.setReviewFocus(false);
      if (ReviewFlowPanel.current === this) ReviewFlowPanel.current = undefined;
    });
    // Spec §12: "shortcuts apply when the review tab has focus". Tying the
    // context to the tab's existence would arm A/R/S/J/K globally — including
    // in the file in-diff mode opens beside the review, where a keystroke
    // meant for the editor would silently record a verdict.
    this.setReviewFocus(route.panel.active !== false);
    this.focusWatch = route.panel.onDidChangeViewState?.((event) => {
      this.setReviewFocus(event.webviewPanel.active);
      // Flush point (D9): the tab stopped being visible. The reviewer may
      // close the window without ever coming back to it, and a pending
      // coalesced write must not be what that costs them.
      if (!event.webviewPanel.visible) this.draftWriter.flushQuietly();
    });
    // Flush point (D9): the whole editor window lost focus — the closest
    // signal there is to "the reviewer walked away".
    this.windowFocusWatch = vscode.window.onDidChangeWindowState((state) => {
      if (!state.focused) this.draftWriter.flushQuietly();
    });
    // The document reloaded underneath this route (issue #39 follow-up) —
    // e.g. "Developer: Reload Webviews" recreates the webview from the
    // stored (possibly stale) html. This panel's state is already in
    // memory, so a plain re-render (falling back to setHtml since readiness
    // was just reset) is enough — no need to reload() from the network.
    route.onReload(() => this.render());
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
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewFocus',
      this.reviewFocusActive,
    );
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewContextFocus',
      this.reviewFocusActive && this.cr !== undefined && this.screen === 'agent',
    );
  }

  private get panel(): vscode.WebviewPanel {
    return this.route.panel;
  }

  // ---- loading ---------------------------------------------------------------

  private pod() {
    const pod = this.deps.podStore.activePod;
    if (!pod) throw new Error('No pod configured');
    return pod;
  }

  private async connection() {
    return connectionForPod(this.pod(), this.deps.secrets);
  }

  private draftKey(): string {
    return draftKeyFor(this.ref);
  }

  private autoContextItems(): AutoContextItemView[] {
    const context = this.reviewContext;
    if (!context) return [];
    const items: AutoContextItemView[] = [{
      id: 'auto:title',
      kind: 'title',
      label: `Title · ${context.title}`,
      enabled: this.autoContextEnabled.get('auto:title')
        ?? contextSourceEnabledByDefault('title', this.autoContextDefaults),
    }];
    if (context.description) {
      items.push({
        id: 'auto:description',
        kind: 'description',
        label: 'Change request description',
        enabled: this.autoContextEnabled.get('auto:description')
          ?? contextSourceEnabledByDefault('description', this.autoContextDefaults),
      });
    }
    context.linkedItems.forEach((item, index) => {
      const id = `auto:linked:${index}:${item.number}`;
      items.push({
        id,
        kind: 'linkedItem',
        label: `#${item.number}${item.title ? ` · ${item.title}` : ''}`,
        detail: item.resolved ? item.state : 'reference only',
        enabled: this.autoContextEnabled.get(id)
          ?? contextSourceEnabledByDefault('linkedItem', this.autoContextDefaults),
      });
    });
    return items;
  }

  private promptReviewContext(): ReviewContext | undefined {
    const context = this.reviewContext;
    if (!context) return undefined;
    const includeTitle = this.autoContextEnabled.get('auto:title')
      ?? contextSourceEnabledByDefault('title', this.autoContextDefaults);
    const includeDescription = context.description
      ? this.autoContextEnabled.get('auto:description')
        ?? contextSourceEnabledByDefault('description', this.autoContextDefaults)
      : true;
    const linkedItems = context.linkedItems.filter((item, index) =>
      this.autoContextEnabled.get(`auto:linked:${index}:${item.number}`)
        ?? contextSourceEnabledByDefault('linkedItem', this.autoContextDefaults),
    );
    if (!includeTitle && (!context.description || !includeDescription) && linkedItems.length === 0) {
      return undefined;
    }
    return { ...context, includeTitle, includeDescription, linkedItems };
  }

  private attachments(): Attachment[] {
    return deduplicateAttachments([...this.manualAttachments, ...this.referenceAttachments])
      .filter((attachment) => !this.removedAttachmentKeys.has(attachmentKey(attachment)));
  }

  private addManualAttachment(attachment: Attachment): void {
    this.removedAttachmentKeys.delete(attachmentKey(attachment));
    this.manualAttachments = deduplicateAttachments([...this.manualAttachments, attachment]);
  }

  private selectionRange(selection: vscode.Selection): { startLine: number; endLine: number } {
    return attachmentRange(selection);
  }

  private fileTarget(uri: vscode.Uri): FileAttachmentTarget {
    return attachmentFileTarget(uri);
  }

  private workspaceRootLabel(): string | undefined {
    const repository = this.pod().repos?.find((candidate) => candidate.id === this.ref.repoId);
    return modelVisibleRootLabelForProject(
      [repository?.path, repository?.name],
      modelVisibleWorkspaceRoots(),
    );
  }

  private providerFilePath(path: string): string {
    return providerRelativePath(path, this.workspaceRootLabel());
  }

  private async addContext(): Promise<void> {
    const attachment = await pickContextAttachment();
    if (!attachment || this.disposed) return;
    this.addManualAttachment(attachment);
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
      ...this.fileTarget(symbol.location.uri),
      name: symbol.name,
      range: this.selectionRange(new vscode.Selection(symbol.location.range.start, symbol.location.range.end)),
    };
  }

  private resolveInstructionReferences(
    text: string,
    targetIsCurrent: () => boolean = () => true,
  ): Promise<void> {
    return this.referenceResolution.resolve(text, async (isCurrent) => {
      if (!targetIsCurrent()) return;
      const currentReferences = new Set(parseContextReferences(text).map((reference) => reference.raw));
      for (const reference of this.referenceAttachmentCache.keys()) {
        if (!currentReferences.has(reference)) this.referenceAttachmentCache.delete(reference);
      }
      const result = await resolveContextReferences(text, {
        findFile: findReferenceFile,
        findSymbol: (name) => this.findReferenceSymbol(name),
        resolveAttachment: (kind, target) => resolveAttachment(kind, target),
      }, this.referenceAttachmentCache);
      if (this.disposed || !targetIsCurrent() || !isCurrent()) return;
      this.referenceAttachments = result.attachments;
      this.unresolvedContextReferences = result.unresolved;
    });
  }

  private scheduleContextUsage(): void {
    const model = this.selectedModel();
    if (
      !this.contextUsageEnabled
      || this.screen !== 'agent'
      || this.selectedAgent().source === 'demo'
      || !model
      || !model.maxInputTokens
      || !this.diff
    ) {
      this.contextUsageCounter.cancel();
      this.contextUsage = undefined;
      return;
    }
    const prompt = assembleReviewPrompt(
      this.selectedAgent(),
      this.diff,
      this.pod().criteria,
      this.promptReviewContext(),
      {
        attachments: this.attachments(),
        contextBudgets: this.contextBudgets,
        effort: this.selectedEffort(),
      },
    );
    const promptHash = crypto.createHash('sha256').update(prompt).digest('hex');
    const cacheKey = `${model.id}\0${promptHash}`;
    this.contextUsage = undefined;
    this.contextUsageCounter.schedule({
      cacheKey,
      prompt,
      totalTokens: model.maxInputTokens,
      countTokens: (assembled) => countPromptTokens(model.id, assembled),
    }, (usage) => {
      if (this.disposed) return;
      this.contextUsage = usage;
      this.render();
    });
  }

  private loadSeq = 0;

  private async load(ref: ChangeRequestRef): Promise<void> {
    const loadToken = ++this.loadSeq;
    // Navigating to another change request no longer cancels the run on the one
    // being left. It cannot land under the wrong ref either: the manager keys
    // every run by its target, so a result can only ever reach the record for
    // the change request it was triggered for.
    this.runRecord = undefined;
    this.newRunFromResult = false;
    // Full per-MR reset: nothing (verdicts, threads, summary text, the
    // partial-failure ledger) may leak from one MR into another.
    this.ref = ref;
    // cr and diff describe the *previous* MR until this one's fetch returns.
    // Leaving them meant render() could paint that MR's branch, title and
    // web URL under this ref's header for the length of the fetch — which
    // the loading page (#39) made reachable, since it arms the keyboard
    // handler while the fetch is still in flight.
    this.cr = undefined;
    this.diff = undefined;
    // Same reason as cr and diff above: last MR's intent under this ref's
    // header is a wrong answer, and feeding it to this ref's agent run is a
    // worse one.
    this.reviewContext = undefined;
    this.manualAttachments = [];
    this.referenceAttachments = [];
    this.referenceAttachmentCache = new Map();
    this.removedAttachmentKeys = new Set();
    this.unresolvedContextReferences = [];
    this.autoContextEnabled = new Map();
    this.referenceResolution.invalidate();
    this.contextUsage = undefined;
    this.contextUsageCounter.cancel();
    this.contextOpen = false;
    this.review = undefined;
    this.retained = undefined;
    this.threads = {};
    this.askDrafts = {};
    this.selectedId = undefined;
    this.summaryText = '';
    this.finalNote = '';
    this.submitError = undefined;
    this.failedKeys = undefined;
    this.summaryPosted = false;
    this.verdictApplied = false;
    this.threadsAccum = {};
    this.postedIndividually = false;
    this.postedCount = 0;
    this.doneSentence = '';
    this.staleHead = undefined;
    this.staleItemIds = new Set();
    this.agentOpen = false;
    this.memberOfChangeset = undefined;

    // First paint on navigation (#39): refLabel() and the project path need
    // only this.ref (set above) and this.pod(), both synchronous — show
    // them immediately instead of leaving the previous screen frozen for
    // the whole fetch below. load() only ever runs for a fresh navigation —
    // an in-place state change (a verdict, a mode switch, ...) goes through
    // render() alone — so this always repaints.
    const pod = this.pod();
    // Hoisted so the catch below can repaint the same header on an error
    // screen without recomputing it against whatever `this.ref`/`this.pod()`
    // have become by the time the fetch below actually rejects.
    const header = {
      refLabel: this.refLabel(),
      projectPath: pod.repos?.find((r) => r.id === ref.repoId)?.path ?? ref.repoId,
    };
    this.route.setHtml(renderReviewFlowLoadingHtml(header, crypto.randomBytes(16).toString('hex')));

    try {
      const connection = await this.connection();
      if (this.disposed || loadToken !== this.loadSeq) return;
      // listOpenChangeRequests, getChangeRequestDiff and the agent/model
      // discovery are independent reads — getChangeRequestDiff needs only ref,
      // and discovery needs nothing, so the previous sequential chain was
      // pure latency (#39). Attach a no-op catch to the last two immediately:
      // if the CR turns out to be gone below, whichever of them rejects must
      // not surface as an unhandled rejection or bury the clearer "no longer
      // open" message with a second, unrelated one.
      const crsPromise = connection.listOpenChangeRequests([ref.repoId]);
      const diffPromise = connection.getChangeRequestDiff(ref);
      const selectionPromise = loadAgentSelection(selectionFromPod(pod));
      // The work items resolve whatever the description links. A review that
      // cannot start because that list 404'd is worse than one running on the
      // description alone, so this one degrades to [] instead of rejecting —
      // which also covers the unhandled-rejection concern the two catches
      // above exist for.
      const workItemsPromise = connection.listWorkItems([ref.repoId]).catch((): WorkItem[] => []);
      diffPromise.catch(() => undefined);
      selectionPromise.catch(() => undefined);
      const crs = await crsPromise;
      if (this.disposed || loadToken !== this.loadSeq) return;
      const cr = crs.find((c) => c.ref.number === ref.number);
      if (!cr) {
        void vscode.window.showWarningMessage(`Verdict: ${ref.number} is no longer open.`);
        void vscode.commands.executeCommand(COMMANDS.openDashboard);
        return;
      }
      this.cr = cr;
      this.diff = await diffPromise;

      const workItems = await workItemsPromise;
      if (this.disposed || loadToken !== this.loadSeq) return;
      this.reviewContext = buildReviewContext(cr, workItems, { trailer: changesetTrailer() });
      // One reconciliation over everything just discovered: a stored agent
      // whose file is gone, or a model that is no longer offered, falls back
      // here and says so on the screen rather than failing at run time.
      this.applySelection(await selectionPromise);
      await this.resolveInstructionReferences(pod.criteria.extraInstructions);
      if (this.disposed || loadToken !== this.loadSeq) return;
      this.armAgentWatches();

      // What this change request opens on, in order of precedence. A run
      // happening right now outranks everything, because it is about to replace
      // it; then a failure nobody has seen yet; then the completed review, which
      // is the common case and the one that used to be thrown away.
      this.watchRun();
      const hadRetained = this.enterRetained();
      const record = this.deps.runs.get(this.runKey());
      if (record && (record.status === 'queued' || record.status === 'running')) {
        this.attachRun(record);
        this.screen = 'running';
      } else if (record?.status === 'failed') {
        this.attachRun(record);
        this.screen = 'running';
      } else if (!hadRetained) {
        this.screen = 'agent';
      }
      this.scheduleContextUsage();
      this.render();
      void this.resolveChangesetMembership(loadToken);
    } catch (e) {
      // A stale load losing the race to a newer navigation (or the panel
      // closing mid-fetch) is not a failure to report — whatever superseded
      // it, or nothing once disposed, already owns the screen.
      if (this.disposed || loadToken !== this.loadSeq) return;
      // On `main` a rejection here left the previous review fully rendered.
      // Painting the loading skeleton before the fetch (#39) means the same
      // rejection instead stranded the reviewer on a dead spinner: every
      // call site is `void ReviewFlowPanel.open(...)`, so it went to the
      // extension-host console and nothing at all reached the screen.
      const error = toScmError(e);
      void vscode.window.showErrorMessage(`Verdict: ${error.message}`);
      this.route.setHtml(renderReviewFlowErrorHtml(
        header,
        error.message,
        crypto.randomBytes(16).toString('hex'),
      ));
    }
  }

  private memberOfChangeset?: { id: string; name: string; memberCount: number };

  /** §15 entry point "a member MR" — enhance the header once membership is known. */
  private async resolveChangesetMembership(loadToken: number): Promise<void> {
    if (!this.deps.changesetForCr) return;
    const membership = await this.deps.changesetForCr(this.ref).catch(() => undefined);
    if (this.disposed || loadToken !== this.loadSeq) return;
    if (membership?.id === this.memberOfChangeset?.id) return;
    this.memberOfChangeset = membership;
    this.render();
  }

  // ---- staleness (handoff §6) --------------------------------------------------

  /** The lines a finding can legitimately sit on: current additions only. */
  private anchorCandidates(diff: ChangeRequestDiff, file: string): AnchorCandidate[] | undefined {
    const changed = diff.files.find((f) => f.newPath === this.providerFilePath(file));
    if (!changed) return undefined;
    return addedLines(changed.diff);
  }

  private markMoved(diff: ChangeRequestDiff): Set<string> {
    if (!this.review) return new Set();
    return movedAnchors(this.review.items, (file) => this.anchorCandidates(diff, file));
  }

  private startHeadPoll(): void {
    if (this.headPoll || this.disposed) return;
    this.headPoll = setInterval(() => void this.pollHead(), HEAD_POLL_MS);
  }

  private stopHeadPoll(): void {
    if (!this.headPoll) return;
    clearInterval(this.headPoll);
    this.headPoll = undefined;
  }

  /**
   * Ask whether the branch moved while the reviewer was deciding. The diff the
   * agent read is deliberately *not* replaced here — comment positions must
   * keep carrying the refs the agent saw until the reviewer explicitly
   * re-anchors (handoff §14). This only computes what the banner claims.
   */
  private async pollHead(): Promise<void> {
    if (this.disposed || this.screen !== 'triage' || !this.review) return;
    // Identify the review by what it was read against, not by object identity:
    // every verdict replaces `this.review`, and a poll must survive the
    // reviewer working while it is in flight.
    const { number } = this.ref;
    const readHead = this.review.headSha;
    const sameReview = (): boolean =>
      !this.disposed &&
      this.screen === 'triage' &&
      this.ref.number === number &&
      this.review?.headSha === readHead;
    try {
      const connection = await this.connection();
      const crs = await connection.listOpenChangeRequests([this.ref.repoId]);
      if (!sameReview()) return;
      const cr = crs.find((c) => c.ref.number === number);
      if (!cr || cr.headSha === readHead || this.staleHead === cr.headSha) return;
      const fresh = await connection.getChangeRequestDiff(this.ref);
      if (!sameReview()) return;
      this.staleHead = cr.headSha;
      this.staleItemIds = this.markMoved(fresh);
      this.render();
    } catch {
      // A failed poll is not the reviewer's problem — the banner can wait
      // for the next tick rather than interrupting triage with an error.
    }
  }

  /**
   * Queue this panel's state for persistence. Writes are coalesced (D9): a
   * burst of triage actions collapses into one `workspaceState.update`,
   * landed by the writer's window or by the flush points — before submit, on
   * dispose, when the tab stops being visible, when the window loses focus.
   *
   * The put carries the run manager's result fields forward from the RAW
   * record this panel loaded (`this.retained.draft`, never the normalized
   * view — see `carryRetainedResult`). Without that this whole-key put would
   * erase `ranAt`, and the writer's generation guard — which keys on `ranAt`
   * — would read every later write as belonging to a different run and drop
   * it.
   */
  private persistDraft(): void {
    if (!this.review) return;
    // `this.review` only ever originates from the record `enterRetained`
    // read, so `this.retained` names the generation this write belongs to.
    // If that invariant breaks, the guard below drops writes silently.
    this.draftWriter.schedule(this.draftKey(), {
      ...carryRetainedResult(this.retained?.draft),
      review: this.review,
      threads: this.threads,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      failedKeys: this.failedKeys ? [...this.failedKeys] : undefined,
      summaryPosted: this.summaryPosted || undefined,
      verdictApplied: this.verdictApplied || undefined,
      // Without these two a reload between attempts loses every thread id the
      // first attempt resolved, and forgets that it posted comment-by-comment.
      threadsAccum: Object.keys(this.threadsAccum).length > 0 ? this.threadsAccum : undefined,
      postedIndividually: this.postedIndividually || undefined,
      postedCount: this.postedCount || undefined,
    } satisfies SessionDraft, this.retained?.draft.ranAt);
  }

  // ---- running ----------------------------------------------------------------

  /** The manager's key for this panel's change request. */
  private runKey(): string {
    return runKeyForCr(this.ref);
  }

  /**
   * Start a review, or attach to the one already running on this change
   * request. The panel does not own what happens next: it hands the manager
   * everything the run needs and watches the record that comes back.
   *
   * The selection is written to the pod first and separately. That is a
   * preference — what to pre-select next time — and it is deliberately not part
   * of the run, which carries its own copy in the snapshot below and is
   * therefore untouched by anything the reviewer changes afterwards.
   */
  /**
   * `fromCheckpoint` (task 14.6): builds the exact same `RunInput` either
   * way — a resumed attempt's compatibility check depends on that freshness
   * — and only the manager call at the end differs. `resumeRun` returning
   * `undefined` means the offer went stale between render and click (the
   * lineage's checkpoint disappeared, or another panel already claimed it);
   * there is nothing to attach, so this reports it as a notice on the same
   * picker screen rather than silently starting an unrequested plain run.
   */
  private async run(fromCheckpoint = false): Promise<void> {
    if (!this.diff) return;
    const loadToken = this.loadSeq;
    const ref = this.ref;
    const targetIsCurrent = (): boolean => (
      !this.disposed && loadToken === this.loadSeq && ref === this.ref
    );
    const pod = this.pod();
    const diff = this.diff;
    const reviewContext = this.promptReviewContext();
    const attachments = this.attachments();
    const workspaceRootLabel = this.workspaceRootLabel();
    const agentId = this.agentId;
    const agent = this.selectedAgent();
    const agentLabel = agent.label || agentId;
    const modelId = this.modelId;
    const criteria = { ...pod.criteria, categories: [...pod.criteria.categories] };
    const effort = this.selectedEffort();
    const contextBudgets = { ...this.contextBudgets };
    const demo = agentId === DEMO_AGENT_DESCRIPTOR.id;
    const input: RunInput = {
      target: {
        kind: 'cr',
        ref,
        baseSha: diff.baseSha,
        headSha: diff.headSha,
        reviewContext,
        attachments,
        workspaceRootLabel,
      },
      refLabel: this.refLabel(),
      podId: pod.id,
      criteria,
      agent,
      agentLabel,
      modelId: demo ? undefined : modelId,
      effort,
      timeouts: agentRunTimeouts(),
      contextBudgets,
      demo,
    };
    const concurrency = agentRunConcurrency();

    pod.agentId = agentId;
    pod.modelId = modelId;
    pod.effortByModel = normalizeEffortsByModel(pod.effortByModel);
    try {
      await this.deps.podStore.upsert(pod);
    } catch (error) {
      if (!targetIsCurrent()) return;
      throw error;
    }
    if (!targetIsCurrent()) return;

    if (!demo) {
      // A model-backed agent with no model must not reach the transport: an
      // empty id there selects an arbitrary model rather than failing, because
      // `selectChatModels({vendor: undefined, family: undefined})` matches
      // everything.
      let stillThere: ModelDescriptor[];
      try {
        stillThere = await discoverModels();
      } catch (error) {
        if (!targetIsCurrent()) return;
        throw error;
      }
      if (!targetIsCurrent()) return;
      if (modelId === undefined || !stillThere.some((candidate) => candidate.id === modelId)) {
        this.selectionNotices = [`The model "${modelId ?? 'none selected'}" is no longer available.`];
        this.models = stillThere;
        this.screen = 'agent';
        this.render();
        return;
      }
    }

    if (!targetIsCurrent()) return;
    const record = fromCheckpoint ? this.deps.runs.resumeRun(input, concurrency) : this.deps.runs.trigger(input, concurrency);
    if (record === undefined) {
      // The resume offer was stale by the time the reviewer clicked it —
      // never invent an ordinary run instead of the one they asked for.
      // `interruptedPrior` is recomputed on the next `render()` from the
      // manager's current state, so a genuinely gone offer stops being
      // shown at all rather than repeating this notice forever.
      this.selectionNotices = ["The earlier attempt's checkpoint is no longer available to start a new attempt from."];
      this.screen = 'agent';
      this.render();
      return;
    }
    this.newRunFromResult = false;
    this.attachRun(record);
    this.screen = 'running';
    this.render();
  }

  /**
   * Mirror a run's state onto this panel. Subscribed rather than awaited, so a
   * run that was already going when the reviewer arrived paints from wherever
   * it has got to rather than from its beginning.
   */
  private watchRun(): void {
    this.runWatch?.dispose();
    this.runWatch = this.deps.runs.subscribe((record) => {
      if (this.disposed || record.key !== this.runKey()) return;
      this.attachRun(record);
      this.renderRunState(record);
    });
  }

  private attachRun(record: RunRecord): void {
    this.runRecord = record;
  }

  /**
   * What a state change means for the screen. Only `succeeded` moves it: the
   * manager has already written the retained review by then, so the panel reads
   * it back rather than being handed findings out of band — one writer, and no
   * way for an open panel to disagree with a closed one.
   */
  private renderRunState(record: RunRecord): void {
    if (record.status === 'succeeded') {
      this.deps.runs.acknowledge(record.key);
      this.runRecord = undefined;
      // The manager has just replaced this target's retained record (it
      // writes before it settles); a pending draft write snapshots a review
      // that no longer exists. The generation guard would drop it at flush
      // time — cancelling here stops `enterRetained`'s flush from even
      // attempting it (task 4.4).
      this.draftWriter.cancelFor(this.draftKey());
      // Re-entering through load() would refetch the change request for no
      // reason; the record is on disk and everything else is already in hand.
      this.enterRetained();
      this.render();
      return;
    }
    if (record.status === 'cancelled') {
      this.runRecord = undefined;
      // Back to whatever was there before — a retained review, or the pickers.
      if (!this.enterRetained()) this.screen = 'agent';
      this.render();
      return;
    }
    this.render();
  }

  /**
   * Start the pickers from what produced the review being shown, not from
   * whatever the pod happens to hold. The two diverge as soon as any other run
   * writes the pod's selection — a changeset review writes the same two fields
   * — and "re-run this with a different agent" is a comparison against *this*
   * review, so it has to start from this review's agent.
   *
   * A selection that no longer exists is not forced: the picker keeps what it
   * has and says why, the way `applySelection` reports a vanished agent.
   */
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
   * Load the retained review for this change request onto the screen, and say
   * whether there was one. This is the whole of "a completed review is what a
   * target opens on": one reader, used by `load()`, by a finished run, and by a
   * cancelled one.
   */
  private enterRetained(): boolean {
    // A pending coalesced write may hold newer triage than the store; land it
    // first, or this read would revert the screen to the pre-burst state (a
    // cancelled re-run re-entering the review is the reachable case). The
    // flush's get/update pair is synchronous, so the read below sees it.
    this.draftWriter.flushQuietly();
    const retained = readRetained(this.deps.workspaceState.get<SessionDraft>(this.draftKey()));
    if (!retained) {
      // Cleared, not merely left: a change request with no record must not
      // inherit the previous one's, which is what the header line and the
      // clean screen's buckets are drawn from.
      this.retained = undefined;
      this.review = undefined;
      this.askDrafts = {};
      return false;
    }
    const draft = retained.draft;
    this.retained = retained;
    this.review = retained.outcome === 'clean' ? undefined : draft.review;
    // Ask drafts are keyed by finding id, and entering a review is the only
    // way the finding set changes (task 9.3): drop drafts for findings this
    // review no longer has, or a replaced run's draft would sit in memory
    // forever — or surface under an unrelated finding that reused the id.
    const liveItems = new Set((this.review?.items ?? []).map((item) => item.id));
    for (const id of Object.keys(this.askDrafts)) {
      if (!liveItems.has(id)) delete this.askDrafts[id];
    }
    this.threads = draft.threads;
    this.summaryText = draft.summaryText;
    this.finalNote = draft.finalNote;
    this.failedKeys = draft.failedKeys ? new Set(draft.failedKeys) : undefined;
    this.summaryPosted = draft.summaryPosted ?? false;
    this.verdictApplied = draft.verdictApplied ?? false;
    this.threadsAccum = { ...draft.threadsAccum };
    this.postedIndividually = draft.postedIndividually ?? false;
    this.postedCount = draft.postedCount ?? 0;
    this.screen = screenForRetained(retained);
    if (this.review) {
      this.selectedId = nextUndecided(this.review)?.id ?? this.review.items[0]?.id;
      // The diff in hand is the branch as it stands now, so the same fetch that
      // detects a moved head also says which findings moved.
      this.staleHead = isStale(this.review, this.cr?.headSha ?? this.review.headSha) ? this.cr?.headSha : undefined;
      this.staleItemIds = this.staleHead && this.diff ? this.markMoved(this.diff) : new Set();
    } else {
      this.staleHead = undefined;
      this.staleItemIds = new Set();
    }
    if (this.screen === 'done' && !this.doneSentence) {
      this.doneSentence = 'This review was submitted.';
    }
    return true;
  }

  // ---- messages ------------------------------------------------------------------

  /**
   * Every message goes through here so a rejection cannot vanish. The panel
   * dispatches with `void this.onMessage(...)`, so an unhandled rejection went
   * to the extension-host console and the user saw nothing at all — a button
   * that simply did nothing (#41). `approve` was the reported case, but every
   * branch of the switch had the same exposure.
   */
  private async onMessage(m: FlowMessage): Promise<void> {
    try {
      await this.handleMessage(m);
    } catch (e) {
      const error = toScmError(e);
      // A refused verdict is an explanation, not a failure: the platform will
      // never accept it, and there is nothing for the user to retry.
      void (error.kind === 'verdictRefused'
        ? vscode.window.showInformationMessage(`Verdict: ${error.message}`)
        : vscode.window.showErrorMessage(`Verdict: ${error.message}`));
      // The switch may have mutated state before throwing, and the screen it
      // was heading for never rendered.
      this.render();
    }
  }

  private async handleMessage(m: FlowMessage): Promise<void> {
    const pod = this.pod();
    switch (m.type) {
      case 'toggleAgentOpen':
        this.agentOpen = !this.agentOpen;
        break;
      case 'toggleModelOpen':
        this.modelOpen = !this.modelOpen;
        this.effortOpen = false;
        break;
      case 'selectModel':
        this.modelId = m.modelId;
        this.modelOpen = false;
        this.effortOpen = false;
        break;
      case 'toggleEffortOpen':
        if (this.selectedAgent().source !== 'demo' && this.selectedModel()) {
          this.effortOpen = !this.effortOpen;
          this.modelOpen = false;
        }
        break;
      case 'selectEffort':
        if (!this.modelId || !isEffortLevel(m.effort)) break;
        pod.effortByModel = setEffortForModel(pod.effortByModel, this.modelId, m.effort);
        await this.deps.podStore.upsert(pod);
        this.effortOpen = false;
        break;
      case 'dismissNotices':
        this.selectionNotices = [];
        break;
      case 'showSkippedAgents':
        void vscode.window.showWarningMessage(
          `Verdict: skipped ${this.skippedAgents.length} agent file(s) — ` +
            this.skippedAgents.map((skip) => `${skip.path} (${skip.reason})`).join('; '),
        );
        break;
      case 'selectAgent': {
        this.agentId = m.agentId;
        this.agentOpen = false;
        // An agent may name a model it was written for. Applied only here, at
        // the moment of selection, so a reviewer who then picks a different
        // model has the last word.
        const preferred = preferredModelFor(this.selectedAgent(), this.models);
        if (preferred.modelId) this.modelId = preferred.modelId;
        if (preferred.notice) this.selectionNotices = [preferred.notice];
        break;
      }
      case 'setFloor':
        pod.criteria.severityFloor = m.floor;
        await this.deps.podStore.upsert(pod);
        break;
      case 'setConfidence':
        pod.criteria.minConfidence = m.value;
        await this.deps.podStore.upsert(pod);
        break;
      case 'toggleCategory': {
        const set = new Set(pod.criteria.categories);
        if (set.has(m.category)) set.delete(m.category);
        else set.add(m.category);
        pod.criteria.categories = [...set] as Category[];
        await this.deps.podStore.upsert(pod);
        break;
      }
      case 'setInstructions':
        // Per-keystroke, from debounced input (task 9.3): update the
        // in-memory criteria and resolved references only. A podStore.upsert
        // here would be one uncoalesced read-modify-write per character;
        // persistence lands once on blur, below.
        pod.criteria.extraInstructions = m.text;
        await this.resolveInstructionReferences(m.text);
        this.scheduleContextUsage();
        this.render();
        return;
      case 'commitInstructions':
        pod.criteria.extraInstructions = m.text;
        await this.deps.podStore.upsert(pod);
        await this.resolveInstructionReferences(m.text);
        break;
      case 'addContext':
        await this.addContext();
        return;
      case 'removeContextItem': {
        const attachment = this.attachments().find((item) => item.id === m.itemId);
        if (attachment) this.removedAttachmentKeys.add(attachmentKey(attachment));
        break;
      }
      case 'toggleAutoContextItem': {
        const item = this.autoContextItems().find((candidate) => candidate.id === m.itemId);
        if (item) {
          this.autoContextEnabled.set(m.itemId, !item.enabled);
        }
        break;
      }
      case 'run': {
        const loadToken = this.loadSeq;
        const target = this.ref;
        const targetIsCurrent = (): boolean => (
          !this.disposed && loadToken === this.loadSeq && target === this.ref
        );
        await prepareContextReferencesForRun(
          m.instructions ?? pod.criteria.extraInstructions,
          pod.criteria.extraInstructions,
          async (instructions) => {
            if (!targetIsCurrent()) return;
            pod.criteria.extraInstructions = instructions;
            await this.deps.podStore.upsert(pod);
          },
          (instructions) => this.resolveInstructionReferences(instructions, targetIsCurrent),
        );
        if (!targetIsCurrent()) return;
        void this.run();
        return;
      }
      case 'resumeFromCheckpoint': {
        // Task 14.6: identical context-reference resolution to `run` above —
        // the `RunInput` a resumed attempt builds must be exactly as fresh
        // as an ordinary one, since `decideResume` compares it against the
        // stored checkpoint dimension by dimension. Only the final manager
        // call differs (`resumeRun` in `run()`, not `trigger()`), gated by
        // `fromCheckpoint`; the button that dispatches this message is
        // itself only rendered when `interruptedPrior.resumable` said the
        // offer was live.
        const loadToken = this.loadSeq;
        const target = this.ref;
        const targetIsCurrent = (): boolean => (
          !this.disposed && loadToken === this.loadSeq && target === this.ref
        );
        await prepareContextReferencesForRun(
          m.instructions ?? pod.criteria.extraInstructions,
          pod.criteria.extraInstructions,
          async (instructions) => {
            if (!targetIsCurrent()) return;
            pod.criteria.extraInstructions = instructions;
            await this.deps.podStore.upsert(pod);
          },
          (instructions) => this.resolveInstructionReferences(instructions, targetIsCurrent),
        );
        if (!targetIsCurrent()) return;
        void this.run(true);
        return;
      }
      case 'cancel':
        // Two meanings on one message, because the failure screen's "Switch
        // agent" reuses it. A live run is stopped — really stopped, request and
        // slot both. A run that has already failed has nothing left to cancel,
        // so this is the reviewer dismissing the failure and asking for the
        // pickers; without the second branch the button did nothing at all.
        if (this.runRecord && this.runRecord.status !== 'queued' && this.runRecord.status !== 'running') {
          this.deps.runs.acknowledge(this.runKey());
          this.runRecord = undefined;
          this.screen = 'agent';
          break;
        }
        this.deps.runs.cancel(this.runKey());
        return;
      case 'pauseRun':
        // Task 14.6: the button only renders when `runControls.canPause` is
        // true, but a state change can race the click — `pause()` is its
        // own no-op guard for exactly that, so nothing extra is needed here.
        this.deps.runs.pause(this.runKey());
        return;
      case 'resumeRun':
        this.deps.runs.resume(this.runKey());
        return;
      case 'retryRun':
        void this.run();
        return;
      case 'retryLoad':
        // The load-failure screen's only way out (#39). load() resets every
        // per-MR field itself, so this is a fresh attempt, not a resume.
        await this.load(this.ref);
        return;
      case 'openTuning':
        await vscode.commands.executeCommand('codeVerdict.selectAgent');
        return;
      case 'usePartial':
        // The demo agent never produces partials; the lm path reports 0
        // today — reachable once streaming partial parses land.
        this.deps.runs.acknowledge(this.runKey());
        this.runRecord = undefined;
        if (!this.enterRetained()) this.screen = 'agent';
        break;
      case 'newRun':
        // Open the pickers over a result that stays exactly where it is. Only a
        // run that succeeds replaces it, which is what makes a cancelled or
        // failed re-run cost the reviewer nothing.
        this.newRunFromResult = this.retained !== undefined;
        this.preselectFromRetained();
        this.autoContextEnabled = new Map();
        this.manualAttachments = [];
        this.removedAttachmentKeys = new Set();
        await this.resolveInstructionReferences(pod.criteria.extraInstructions);
        this.screen = 'agent';
        break;
      case 'backToResult':
        // The way back from the pickers, and from a run in flight, to the
        // review that is still retained.
        if (!this.enterRetained()) this.screen = 'agent';
        break;
      case 'toggleReviewContext':
        this.contextOpen = !this.contextOpen;
        break;
      case 'setMode':
        this.mode = m.mode;
        break;
      case 'select':
        this.selectedId = m.itemId;
        break;
      case 'verdict': {
        if (!this.review) return;
        const item = this.review.items.find((i) => i.id === m.itemId);
        const applyFix = m.applyFix && Boolean(item?.suggestion) && Boolean(item && isReviewItemAnchored(item));
        this.review = setVerdict(this.review, m.itemId, m.verdict, applyFix);
        const auto = vscode.workspace.getConfiguration('codeVerdict').get<boolean>('autoAdvance', true);
        if (auto) {
          this.selectedId = nextUndecided(this.review, m.itemId)?.id ?? this.selectedId;
        }
        this.persistDraft();
        break;
      }
      case 'undo':
        if (!this.review) return;
        this.review = clearVerdict(this.review, m.itemId);
        this.persistDraft();
        break;
      case 'move': {
        if (!this.review) return;
        const ids = this.review.items.map((i) => i.id);
        const index = Math.max(0, ids.indexOf(this.selectedId ?? ''));
        const next = ids[Math.min(ids.length - 1, Math.max(0, index + m.delta))];
        if (next) this.selectedId = next;
        break;
      }
      case 'jumpSeverity': {
        const target = this.review ? firstOfSeverity(this.review, m.severity) : undefined;
        if (target) this.selectedId = target.id;
        break;
      }
      case 'ask': {
        if (!this.review) return;
        const item = this.review.items.find((i) => i.id === m.itemId);
        if (!item) return;
        await this.ask(item, m.preset, m.text);
        return;
      }
      case 'askDraft':
        // Held only while its finding is on the review (task 9.3): a commit
        // racing a run replacement is dropped rather than stored, so no draft
        // leaks for a finding that is gone. Stored and nothing more — a
        // render here would fight the caret in the very field this protects.
        if (this.review?.items.some((i) => i.id === m.itemId)) this.askDrafts[m.itemId] = m.text;
        return;
      case 'openInEditor': {
        // Land on the flagged line, not just the file — and only when this
        // workspace really holds the reviewed code.
        const item = this.review?.items.find((i) => i.file === m.file && i.line === m.line);
        const located = item ? await locateInWorkspace(item) : undefined;
        if (!located) {
          void vscode.window.showInformationMessage(
            `Verdict: could not open ${m.file} at the flagged line — it is not in this workspace, or the code has changed since the agent read it.`,
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
      case 'reanchor': {
        // Refetch the diff and recompute each item's line from where its
        // flagged code now sits (spec §6: re-anchor = recompute line
        // numbers from the new diff).
        const connection = await this.connection();
        this.diff = await connection.getChangeRequestDiff(this.ref);
        if (this.review && this.diff) {
          const diff = this.diff;
          let moved = 0;
          let lost = 0;
          const items = this.review.items.map((item) => {
            const candidates = this.anchorCandidates(diff, item.file);
            if (!candidates) {
              lost += 1;
              return item;
            }
            const resolved = resolveAnchor(candidates, item);
            if (resolved.state === 'lost') lost += 1;
            if (resolved.state !== 'moved') return item;
            moved += 1;
            const delta = resolved.line - item.line;
            return {
              ...item,
              line: resolved.line,
              endLine: item.endLine === undefined ? undefined : item.endLine + delta,
            };
          });
          this.review = { ...this.review, items, headSha: diff.headSha };
          const sentence = [
            moved > 0 ? `re-anchored ${moved} ${moved === 1 ? 'finding' : 'findings'} to the new HEAD` : '',
            // Honest about what could not be saved: a rewritten line has no
            // anchor to move to, and posting it blind would land in the wrong place.
            lost > 0 ? `${lost} no longer ${lost === 1 ? 'has' : 'have'} matching code — re-run to re-read them` : '',
          ].filter(Boolean).join('; ');
          void vscode.window.showInformationMessage(
            `Verdict: ${sentence || 'every finding still sits where the agent read it.'}`,
          );
        }
        this.staleHead = undefined;
        this.staleItemIds = new Set();
        this.persistDraft();
        break;
      }
      case 'rerun':
        void this.run();
        return;
      case 'generateSummary':
        if (!this.review || !allDecided(this.review)) return;
        this.summaryText = this.generateSummaryText();
        this.screen = 'summary';
        this.persistDraft();
        break;
      case 'editSummary':
        this.summaryText = m.text;
        this.persistDraft();
        return;
      case 'regenerate':
        this.summaryText = this.generateSummaryText();
        break;
      case 'setNote':
        this.finalNote = m.text;
        this.persistDraft();
        return;
      case 'toggleOption':
        if (m.option === 'postThread') this.postThread = !this.postThread;
        else this.requestChanges = !this.requestChanges;
        break;
      case 'submit':
      case 'retrySubmit':
        void this.submit();
        return;
      case 'copyMarkdown':
        await vscode.env.clipboard.writeText(composeSummaryBody(
          this.summaryText,
          this.finalNote,
          this.review,
          this.commentDraftComposition()?.withheld,
        ));
        void vscode.window.showInformationMessage('Verdict: summary copied as markdown.');
        return;
      case 'reconnect':
        void vscode.commands.executeCommand('codeVerdict.signIn');
        return;
      case 'backToTriage':
        this.screen = 'triage';
        break;
      case 'approve': {
        const connection = await this.connection();
        await connection.approve(this.ref);
        void vscode.window.showInformationMessage(`Verdict: approved ${this.refLabel()}.`);
        this.screen = 'agent';
        break;
      }
      case 'lowerBar': {
        const floorIndex = SEVERITY_ORDER.indexOf(pod.criteria.severityFloor);
        pod.criteria.severityFloor = SEVERITY_ORDER[Math.max(0, floorIndex - 1)] as Severity;
        pod.criteria.minConfidence = Math.max(0, pod.criteria.minConfidence - 20);
        await this.deps.podStore.upsert(pod);
        this.screen = 'agent';
        break;
      }
      case 'backToDashboard':
        void vscode.commands.executeCommand(COMMANDS.openDashboard);
        return;
      case 'openMr':
        // Reachable from the loading page, where cr is not fetched yet.
        if (this.cr) void vscode.env.openExternal(vscode.Uri.parse(this.cr.webUrl));
        return;
      case 'trackReplies':
        void vscode.commands.executeCommand('codeVerdict.internal.postedReviews', {
          repoId: this.ref.repoId,
          number: this.ref.number,
        });
        return;
      case 'openChangeset':
        this.deps.openChangeset?.(m.changesetId);
        return;
      case 'setCrossTarget':
        // Cross findings exist only in changeset scope — nothing to do here.
        return;
    }
    this.scheduleContextUsage();
    this.render();
  }

  /** True from the first request until the last one settles — see submit(). */
  private submitting = false;
  private submitProgress?: SubmitProgressView;

  /**
   * Ask the agent about one finding, for real.
   *
   * Both follow-up paths used to be fiction (#37): the preset chips read an
   * `answers` map no agent is required to supply, so they almost always said
   * "the agent has nothing further on this", and the freeform box returned a
   * fixed sentence with the question interpolated into it — the question was
   * never read, let alone answered.
   *
   * The answer is appended through a targeted message rather than a re-render.
   * A full render replaces the document, which drops focus out of the ask box
   * and sends the next keystroke to the triage handler as a verdict (#38).
   */
  private async ask(item: ReviewItem, preset: AskPreset, text?: string): Promise<void> {
    const question = followUpQuestion(preset, text);
    if (question === '') return;
    // The question is sent and the page cleared its field — the held draft is
    // stale from here on, whatever the agent answers (task 9.3). Left in
    // place, the next flow-body patch would render the already-asked question
    // back into #ask. Presets never consume the field, so theirs stays.
    if (preset === 'freeform') delete this.askDrafts[item.id];
    const label = preset === 'freeform' ? 'agent · reply' : `agent · ${preset}`;
    const list = (this.threads[item.id] ??= []);

    // A pre-baked answer, when an agent did supply one, still beats a request.
    const canned = preset === 'freeform' ? undefined : item.answers?.[preset];
    if (canned !== undefined) {
      this.appendAnswer(item.id, list, label, canned);
      this.persistDraft();
      return;
    }
    // The guard is about the *model*: an agent with no model behind it (the
    // demo agent, or a session with no Copilot) cannot answer, whatever the
    // agent itself is.
    if (this.modelId === undefined || this.selectedAgent().source === 'demo') {
      this.appendAnswer(item.id, list, label, 'This agent does not answer follow-up questions.');
      this.persistDraft();
      return;
    }

    this.appendAnswer(item.id, list, label, 'Thinking…');
    const entry = list[list.length - 1] as { label: string; text: string };
    try {
      const hunk = this.diff?.files.find((f) => f.newPath === this.providerFilePath(item.file))?.diff;
      // Shares `streamText`, so it gets the same configured windows: a model
      // slow enough to need a longer one on the review is the same model
      // answering the follow-up.
      entry.text = await runFollowUpPrompt(this.selectedAgent(), this.modelId, findingFollowUpPrompt(item, question, hunk), {
        timeouts: agentRunTimeouts(),
        effort: this.selectedEffort(),
      });
    } catch (e) {
      const error = e instanceof AgentRunError ? e.message : toScmError(e).message;
      entry.text = `The agent could not answer: ${error}`;
    }
    this.postThreadUpdate(item.id, list);
    this.persistDraft();
  }

  /** Appends and pushes it to the webview without rebuilding the document. */
  private appendAnswer(
    itemId: string,
    list: Array<{ label: string; text: string }>,
    label: string,
    text: string,
  ): void {
    list.push({ label, text });
    this.postThreadUpdate(itemId, list);
  }

  private postThreadUpdate(itemId: string, list: Array<{ label: string; text: string }>): void {
    if (this.disposed) return;
    // The answer is Markdown, and the webview patches this into the open card
    // rather than re-rendering the page. Render it here, where `renderMarkdown`
    // lives, and send the HTML alongside the raw text.
    const thread = list.map((entry) => ({ ...entry, html: renderMarkdown(entry.text) }));
    void this.panel.webview.postMessage({ type: 'verdict:thread', itemId, thread });
  }

  private generateSummaryText(): string {
    if (!this.review) return '';
    const voice = vscode.workspace
      .getConfiguration('codeVerdict')
      .get<AgentVoice>('agentVoice', 'terse');
    return composeSummary(this.review, this.agentLabel(), voice);
  }

  private commentDraftComposition() {
    const review = this.review;
    const diff = this.diff;
    if (!review || !diff) return undefined;
    const pod = this.pod();
    return composeCommentDrafts(
      review,
      this.agentLabel(),
      pod.username ?? 'you',
      diff.anchorRefs,
      (file) => this.anchorCandidates(diff, file),
      this.workspaceRootLabel(),
    );
  }

  // ---- submit ---------------------------------------------------------------------

  private threadsAccum: Record<string, string> = {};
  /** Sticky across retries: any comment posted on its own breaks "one review". */
  private postedIndividually = false;
  /** How many comments have actually posted, across every attempt. */
  private postedCount = 0;

  private async submit(): Promise<void> {
    if (!this.review || !this.diff) return;
    // Palette-invoked submits must obey the same gate as the button: a
    // fully-triaged review, from the summary screen.
    if (this.screen !== 'summary' || !allDecided(this.review)) return;
    // The screen is NOT the guard. It stayed 'summary' for the whole submit,
    // so a second click — which a panel that looks frozen invites — passed the
    // check above and started a concurrent submit with the same drafts,
    // posting every comment twice (#42).
    if (this.submitting) return;
    const composition = this.commentDraftComposition();
    if (!composition) return;
    this.submitting = true;
    this.submitProgress = undefined;
    // Flush point (D9): the persisted state must reflect every decision made
    // up to here before the submit begins — a crash mid-submit then resumes
    // from the state the reviewer actually sent.
    await this.draftWriter.flush();
    this.screen = 'submitting';
    this.render();
    const pod = this.pod();
    const provider = getProvider(pod.providerId);
    const { drafts, withheld } = composition;
    try {
      const connection = await this.connection();
      const result = await performSubmit(
        connection,
        this.ref,
        {
          drafts,
          summary: composeSummaryBody(this.summaryText, this.finalNote, this.review, withheld),
          // The author's own request-for-changes is refused the same way their
          // approval is, and `requestChanges` defaults to true — so the summary
          // screen's disabled checkbox is the notice, this is the enforcement.
          // A stale webview can still post toggleOption after the page changed.
          requestChanges: this.requestChanges && provider.capabilities.requestChanges && !this.selfAuthored(),
          asSingleThread: this.postThread && provider.capabilities.batchedReview,
        },
        {
          retryKeys: this.failedKeys,
          summaryAlreadyPosted: this.summaryPosted,
          verdictAlreadyApplied: this.verdictApplied,
        },
        (progress) => {
          if (this.disposed || !this.submitting) return;
          this.submitProgress = progress;
          this.render();
        },
      );

      const failed = result.comments.filter((c) => !c.ok);
      for (const outcome of result.comments) {
        if (outcome.threadId) this.threadsAccum[outcome.key] = outcome.threadId;
      }
      if (result.summaryPosted) this.summaryPosted = true;
      if (result.requestChangesApplied) this.verdictApplied = true;
      if (result.postedAsSingleReview === false) this.postedIndividually = true;
      // A retry only submits the failed remainder, so each success counts once.
      this.postedCount += result.comments.filter((outcome) => outcome.ok).length;
      // A verdict that did not land is a failure like any other: without this
      // the comments post, the draft is cleared, and the request for changes is
      // lost with nothing to retry. `performChangesetSubmit` already surfaces it.
      //
      // A *refused* verdict is the exception. It can never succeed, so holding
      // the flow on the summary screen would strand the review there forever:
      // never recorded in history, its thread ids never stored, while every
      // comment is already live on the platform. Report it on the done screen
      // instead of retrying it.
      const verdictRefused = result.requestChangesError?.kind === 'verdictRefused';
      const verdictFailed = !this.verdictApplied
        && result.requestChangesError !== undefined
        && !verdictRefused;
      if (failed.length > 0 || (!this.summaryPosted && result.summaryError) || verdictFailed) {
        this.failedKeys = new Set(failed.map((c) => c.key));
        const first = failed[0]?.error ?? result.summaryError ?? result.requestChangesError;
        this.submitError = first?.message ?? 'submit failed';
        this.screen = 'summary';
        // The ledger must survive a reload — a later retry may only post
        // the remainder (spec §7) — so this one write does not wait out the
        // coalescing window: schedule and flush in the same breath.
        this.persistDraft();
        await this.draftWriter.flush();
        this.render();
        return;
      }

      const counts = verdictCounts(this.review);
      for (const outcome of result.comments) {
        if (outcome.threadId) this.threadsAccum[outcome.key] = outcome.threadId;
      }
      const threads = { ...this.threadsAccum };
      await new ReviewHistory(this.deps.globalState).add({
        repoId: this.ref.repoId,
        crNumber: this.ref.number,
        podId: pod.id,
        agentId: this.agentId,
        agentLabel: this.agentLabel(),
        submittedAt: new Date().toISOString(),
        counts,
        threads,
        postedComments: this.postedCount,
        items: this.review.items
          .filter((i) => this.review?.verdicts[i.id]?.verdict === 'accepted')
          .map((i) => ({ id: i.id, title: i.title, severity: i.severity, file: i.file, line: i.line })),
        observations: this.review.items.flatMap((item) => {
          const verdict = this.review?.verdicts[item.id]?.verdict;
          return verdict
            ? [{ category: item.category, confidence: item.confidence, verdict, severity: item.severity }]
            : [];
        }),
        // From the ledger, not this attempt: a retry deliberately withholds a
        // verdict that already landed, so its result carries no flag.
        requestedChanges: this.verdictApplied,
      });
      // Not a deletion. Clearing the ledger is the whole of what this is
      // entitled to do — nothing that landed may be posted twice — and
      // deleting the record took the review with it, so a submitted change
      // request re-opened on the agent picker with no trace of what was
      // posted. `submittedAt` is what routes it to the done screen instead.
      const submittedDraft = this.deps.workspaceState.get<SessionDraft>(this.draftKey());
      if (submittedDraft) {
        await this.deps.workspaceState.update(
          this.draftKey(),
          clearSubmitLedger(submittedDraft, new Date().toISOString()),
        );
      }
      this.submitError = undefined;
      this.failedKeys = undefined;
      // "as one review thread" only when a single review really was created:
      // a submit with no summary, and every per-comment fallback, post
      // standalone comments instead. `postedIndividually` is what the provider
      // reported about this submit and every earlier attempt on this draft —
      // the capability alone only says the platform *can* batch.
      const postedAsOneReview = provider.capabilities.batchedReview
        && this.postThread
        && !this.postedIndividually
        && result.summaryPosted
        && result.comments.every((outcome) => outcome.ok);
      this.doneSentence = [
        `${counts.accepted} inline ${counts.accepted === 1 ? 'comment' : 'comments'} posted${postedAsOneReview ? ' as one review thread' : ''}${this.verdictApplied ? ', changes requested' : ''}.`,
        // Deliberately not phrased as an error: everything the user wrote did
        // land, and there is nothing for them to retry.
        verdictRefused ? `The request for changes was not applied: ${result.requestChangesError?.message ?? 'refused'}.` : '',
        counts.rejected > 0 ? `${counts.rejected} dismissed findings stayed local.` : '',
      ]
        .filter(Boolean)
        .join(' ');
      this.screen = 'done';
      this.deps.onSubmitted?.();
      this.render();
    } catch (e) {
      this.submitError = isScmError(e) ? e.message : e instanceof Error ? e.message : String(e);
      this.screen = 'summary';
      this.render();
    } finally {
      // In a finally, so a throw cannot wedge the panel: with the flag left
      // set, every later submit would return at the guard and the review
      // could never be sent again.
      this.submitting = false;
      this.submitProgress = undefined;
    }
  }

  // ---- commands from the palette / keybindings -------------------------------------

  dispatchCommand(command: string, arg?: unknown): boolean {
    const message = flowCommandMessage(command, arg, this.selectedId);
    if (!message) return false;
    void this.onMessage(message);
    return true;
  }

  // ---- rendering --------------------------------------------------------------------

  private refLabel(): string {
    return getProvider(this.pod().providerId).vocabulary.formatCrRef(this.ref.number);
  }

  private agentLabel(): string {
    return this.selectedAgent().label || this.agentId;
  }

  /**
   * Three things can invalidate the pickers while the screen is open: an
   * agent file changing on disk, the model list changing, and the configured
   * locations changing. All three land here rather than each re-implementing
   * discovery, so there is one path that re-discovers, reconciles and renders.
   */
  private applySelection(next: AgentSelectionState): void {
    this.agents = next.agents;
    this.models = next.models;
    this.skippedAgents = next.skippedAgents;
    this.agentId = next.agentId;
    this.modelId = next.modelId;
    // Replace rather than append: these notices describe the current state of
    // the pickers, and a stale one from two refreshes ago describes nothing.
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
    // Only the selection screen shows the pickers; re-rendering mid-triage
    // would rebuild the screen under the reviewer for no visible gain.
    if (this.screen === 'agent') this.render();
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

  /** Never undefined: the built-in agent is always in `this.agents`. */
  private selectedAgent(): AgentDescriptor {
    return this.agents.find((a) => a.id === this.agentId) ?? BUILTIN_AGENT_DESCRIPTOR;
  }

  private selectedModel(): ModelDescriptor | undefined {
    return this.models.find((m) => m.id === this.modelId);
  }

  private selectedEffort() {
    return effortForModel(this.pod().effortByModel, this.modelId);
  }

  /**
   * Did the signed-in user open this change request? The same comparison
   * `podQuery.ts` and `dashboardState.ts` make. `Pod.username` is optional, so
   * a missing one is *unknown*, never yes — answering yes on a guess would hide
   * the approval from a reviewer entitled to give it, and the platform's own
   * refusal (`verdictRefused`) already covers the unknown case. Read off the
   * pod, not off the view state's `username`, which falls back to the literal
   * 'you' and would match an author of that name.
   */
  private selfAuthored(): boolean {
    const you = this.pod().username;
    return you !== undefined && this.cr?.author.username === you;
  }

  private render(): void {
    // The loading page (#39) ships the full page script, so the keyboard
    // handler and the message dispatch are both armed during the fetch
    // window in load() — a stray keypress (jumpSeverity) or an unhandled
    // message type can reach here through the switch's implicit fall-through
    // to render() before this.cr is assigned. Before it exists, the loading
    // page already showing is the correct thing to leave on screen.
    if (this.disposed || !this.cr) return;
    const pod = this.pod();
    const stats = this.diff ? diffStats(this.diff.files.map((f) => f.diff)) : { added: 0, removed: 0 };
    const items: TriageItemView[] = (this.review?.items ?? []).map((item) => ({
      item,
      verdict: this.review?.verdicts[item.id]?.verdict,
      applyFix: this.review?.verdicts[item.id]?.applyFix,
      thread: this.threads[item.id] ?? [],
      askDraft: this.askDrafts[item.id],
      lineMoved: this.staleItemIds.has(item.id),
    }));
    const counts = this.review
      ? verdictCounts(this.review)
      : { accepted: 0, rejected: 0, skipped: 0, undecided: 0 };
    const withheldInlineItemIds = this.commentDraftComposition()?.withheld.map((item) => item.id) ?? [];
    const history = new ReviewHistory(this.deps.globalState).list().filter((r) => r.podId === pod.id);
    const produced = history.reduce(
      (n, r) => n + r.counts.accepted + r.counts.rejected + r.counts.skipped,
      0,
    );
    const acceptRate =
      produced > 0
        ? Math.round((history.reduce((n, r) => n + r.counts.accepted, 0) / produced) * 100)
        : undefined;
    // The same one-entry array `assembleReviewPrompt` wraps this context in
    // (task 15.8 removed `runLmAgent`, which used to do this; the pure
    // builder survives for the pre-run context-usage estimate and wraps
    // context identically): the truncation notice has to answer for the
    // prompt that estimate measures, and the budget it is measured against
    // counts entry labels too.
    const contextEntries: ReviewContextEntry[] = this.reviewContext ? [{ context: this.reviewContext }] : [];
    // Task 14.6: the one derivation both `runControls` (live pause/resume/
    // cancel) and `interruptedPrior` (resume-from-checkpoint) read below —
    // never re-derived per field.
    const controls = this.deps.runs.controlsFor(this.runKey(), this.ref);
    const state: FlowViewState = {
      vocabulary: getProvider(pod.providerId).vocabulary,
      screen: this.screen,
      submitProgress: this.submitProgress,
      acceptRate,
      selfAuthored: this.selfAuthored(),
      memberOfChangeset: this.memberOfChangeset,
      header: {
        refLabel: this.refLabel(),
        projectPath: pod.repos?.find((r) => r.id === this.ref.repoId)?.path ?? this.ref.repoId,
        branch: this.cr.sourceBranch,
        fileCount: this.diff?.files.length ?? 0,
        added: stats.added,
        removed: stats.removed,
        title: this.cr.title,
      },
      agents: this.agents,
      agentId: this.agentId,
      agentOpen: this.agentOpen,
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
      criteria: pod.criteria,
      attachments: budgetAttachments(this.attachments()),
      autoContextItems: this.autoContextItems(),
      contextUsage: this.contextUsage,
      unresolvedContextReferences: this.unresolvedContextReferences,
      // Task 14.1 (design.md D14): the shared reducer's own projection and
      // ordered activity — never a fixed step list or a fragment count.
      runProjection: this.runRecord?.projection,
      runActivity: this.runRecord?.checkpoint?.activityLog.events,
      runStartedAt: this.runRecord?.startedAt,
      runError: this.runRecord?.status === 'failed' && this.runRecord.failure
        ? { ...this.runRecord.failure, partialCount: 0 }
        : undefined,
      runQueued: this.runRecord?.status === 'queued',
      // Task 14.6: both fields below come from the one derivation
      // (`deriveRunControls`, via `controlsFor`) so this screen and the
      // running screen's control row can never disagree about what the
      // manager will accept. Live pause/resume/cancel and the
      // resume-from-checkpoint offer are structurally exclusive — the
      // derivation only ever populates one side, never both — because a
      // target either has a live run to control or a stored interrupted
      // outcome to offer a new attempt against, never both at once. A
      // control this run's current lifecycle (or stored outcome) does not
      // accept is omitted entirely, the same as the running screen's row;
      // a stale click racing a state change is refused as a silent no-op by
      // the manager itself either way.
      runControls: this.runRecord
        ? { canPause: controls.canPause, canResume: controls.canResume, canCancel: controls.canCancel }
        : undefined,
      // The demo agent has no checkpoint continuity contract (`resumeRun`
      // itself refuses a `demo` input) — a reviewer who switched to it since
      // the interrupted attempt must see only the restart path, not an
      // offer that would silently refuse when clicked.
      interruptedPrior:
        controls.canResumeFromCheckpoint || controls.resumeReasons
          ? { resumable: controls.canResumeFromCheckpoint && this.selectedAgent().source !== 'demo', reasons: controls.resumeReasons }
          : undefined,
      // The retained review stays reachable from the pickers and from a run in
      // flight: neither of them has replaced it yet.
      retainedAvailable: this.retained !== undefined && (this.screen === 'running' || this.newRunFromResult),
      retainedMeta: this.retained
        ? { ranAt: this.retained.ranAt, agentLabel: this.retained.agentLabel ?? this.agentLabel(), modelLabel: this.reviewModelLabel(), effortLabel: effortLabel(this.retained.draft.review.effort) }
        : undefined,
      // Task 14.2 (design.md D14/D16): the same retained record's own
      // lineage/activity fields, never re-derived.
      retainedDetails: this.retained
        ? {
            completeness: this.retained.completeness,
            protocolProvenance: this.retained.protocolProvenance,
            lineageId: this.retained.lineageId,
            attempt: this.retained.attempt,
            limitations: this.retained.limitations,
            activity: this.retained.activity,
          }
        : undefined,
      mode: this.mode,
      items,
      selectedId: this.selectedId,
      diffLines: this.mode === 'diff'
        ? this.diff?.files
          .filter((file) => file.newPath === this.providerFilePath(
            items.find((view) => view.item.id === this.selectedId)?.item.file ?? '',
          ))
          .flatMap((file) => parseHunks(file.diff).flatMap((hunk) => hunk.lines))
        : undefined,
      counts,
      context: contextEntries.length > 0
        ? {
            open: this.contextOpen,
            truncated: reviewContextTruncatedForPrompt(contextEntries, this.contextBudgets),
            entries: contextEntries,
          }
        : undefined,
      stale: this.staleHead
        ? {
            newHead: this.staleHead,
            affected: this.staleItemIds.size,
            // Callers need to know an accepted decision may now be misplaced —
            // that is the part of the banner that costs the reviewer work.
            affectedAccepted: [...this.staleItemIds].filter(
              (id) => this.review?.verdicts[id]?.verdict === 'accepted',
            ).length,
          }
        : undefined,
      // From the retained record, not from a live response: the response object
      // is gone once the run is over, and these two are the whole content of
      // the clean screen, which has to survive being re-opened.
      candidates: this.retained?.candidates ?? [],
      filesRead: this.retained?.filesRead ?? this.diff?.files.length ?? 0,
      attachmentWarnings: this.retained?.attachmentWarnings ?? [],
      summaryText: this.summaryText,
      withheldInlineItemIds,
      finalNote: this.finalNote,
      postThread: this.postThread,
      requestChanges: this.requestChanges,
      supportsRequestChanges: getProvider(pod.providerId).capabilities.requestChanges,
      submitError: this.submitError,
      username: pod.username ?? 'you',
      doneSentence: this.doneSentence,
      crWebUrl: this.cr.webUrl,
    };
    this.panel.title =
      this.screen === 'agent'
        ? `Verdict: Run review · ${state.header.refLabel}`
        : this.screen === 'done'
          ? `Verdict: Posted · ${state.header.refLabel}`
          : `Verdict: Review · ${state.header.refLabel}`;
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewContextFocus',
      this.reviewFocusActive && this.cr !== undefined && this.screen === 'agent',
    );
    // Patch the region in place rather than replacing the whole document
    // (#39) — render() runs on every screen transition (triage, summary,
    // submitting, ...), so this is what stops each of those from rebuilding
    // the entire page. Falling back to setHtml only when the page has not
    // yet signalled ready is exactly today's always-full-render behaviour.
    const agentLabel = this.agentLabel();
    if (!this.route.postRegions({
      'flow-body': renderReviewFlowBody(state, agentLabel),
      'app-crumb-current': escapeHtml(reviewFlowCrumb(state)),
    })) {
      this.route.setHtml(renderReviewFlowHtml(state, agentLabel, crypto.randomBytes(16).toString('hex')));
    }
    this.deps.onSidebarState?.(this.review ? {
      headline: `${state.header.refLabel} · ${state.header.title}`,
      refLabel: state.header.refLabel,
      context: state.header.branch,
      agent: this.agentLabel(),
      added: state.header.added,
      removed: state.header.removed,
      counts,
      items: this.review.items.map((item) => ({
        id: item.id,
        title: item.title,
        file: item.file,
        severity: item.severity,
        category: item.category,
        confidence: item.confidence,
        verdict: this.review?.verdicts[item.id]?.verdict,
        selected: item.id === this.selectedId,
        lineMoved: this.staleItemIds.has(item.id),
      })),
    } : undefined);
    // Spec §3 is the Run-review screen specifically — its copy ("pick an
    // agent and run the review") would be wrong mid-run and absurd on the
    // clean bill, where a run just finished.
    this.deps.onSidebarPending?.(this.review || this.screen !== 'agent' ? undefined : {
      headline: `${state.header.refLabel} · ${state.header.title}`,
      refLabel: state.header.refLabel,
      context: state.header.branch,
      agent: this.agentLabel(),
      added: state.header.added,
      removed: state.header.removed,
    });
    // Triage is the only screen that watches the branch, and the editor only
    // carries decorations while the reviewer is actually in "In diff".
    if (this.screen === 'triage') this.startHeadPoll();
    else this.stopHeadPoll();
    this.syncInDiffEditor(items);
  }

  /**
   * Mirror the selected finding into the editor when in-diff mode is showing.
   * Keyed so a re-render for an unrelated reason does not re-open the file.
   */
  private syncInDiffEditor(items: TriageItemView[]): void {
    const target =
      this.screen === 'triage' && this.mode === 'diff'
        ? items.find((view) => view.item.id === this.selectedId) ?? items[0]
        : undefined;
    const key = target ? `${target.item.id}:${target.verdict ?? 'undecided'}` : '';
    if (key === this.inDiffKey) return;
    this.inDiffKey = key;
    void this.inDiff.show(
      target
        ? { item: target.item, verdict: target.verdict, agentLabel: this.agentLabel() }
        : undefined,
    );
  }
}
