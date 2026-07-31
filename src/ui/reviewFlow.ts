/**
 * The review-flow panel: one webview tab hosting the state machine
 * agent → running → triage/clean → summary → done (handoff §2), with the
 * tab title tracking the state and drafts surviving reloads via
 * workspaceState.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { connectionForPod } from '../app/connections';
import type { AgentDescriptor } from '../app/agents';
import { DEMO_AGENT_DESCRIPTOR } from '../app/agents';
import { runDemoAgent } from '../app/demoAgent';
import { AgentRunError, discoverLmAgents, runLmAgent } from '../app/lmAgent';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { composeCommentDrafts, composeSummaryBody, performSubmit } from '../app/submit';
import type { AgentReviewResponse } from '../domain/agentResponse';
import { addedLines, diffStats } from '../domain/diffHunks';
import { composeSummary } from '../domain/summary';
import type { AgentVoice } from '../domain/summary';
import {
  allDecided,
  clearVerdict,
  createReview,
  nextUndecided,
  setVerdict,
  verdictCounts,
} from '../domain/reviewState';
import type { Category, Review, Severity, Verdict } from '../domain/types';
import { SEVERITY_ORDER } from '../domain/criteria';
import { getProvider } from '../platform/registry';
import { isScmError } from '../platform/errors';
import type { ChangeRequest, ChangeRequestDiff, ChangeRequestRef } from '../platform/types';
import type { FlowMessage, FlowScreen, FlowViewState, TriageItemView } from './reviewFlowHtml';
import { renderReviewFlowHtml } from './reviewFlowHtml';
import { DashboardPanel } from './dashboard';

interface SessionDraft {
  review: Review;
  threads: Record<string, Array<{ label: string; text: string }>>;
  summaryText: string;
  finalNote: string;
  /** Partial-failure ledger — must survive reloads so a retry never re-posts what already landed (spec §7). */
  failedKeys?: string[];
  summaryPosted?: boolean;
}

export interface ReviewFlowDeps {
  podStore: PodStore;
  secrets: SecretStore;
  workspaceState: KeyValueStore;
  globalState: KeyValueStore;
  onSubmitted?: () => void;
}

export class ReviewFlowPanel {
  private static current: ReviewFlowPanel | undefined;

  static async open(deps: ReviewFlowDeps, ref: ChangeRequestRef): Promise<void> {
    const existing = ReviewFlowPanel.current;
    if (existing && !existing.disposed) {
      await existing.load(ref);
      if (!existing.disposed) existing.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.review',
      'Verdict: Run review',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    ReviewFlowPanel.current = new ReviewFlowPanel(panel, deps);
    await ReviewFlowPanel.current.load(ref);
  }

  static handleCommand(command: string): boolean {
    const panel = ReviewFlowPanel.current;
    if (!panel || panel.disposed) return false;
    return panel.dispatchCommand(command);
  }

  private disposed = false;
  private screen: FlowScreen = 'agent';
  private ref!: ChangeRequestRef;
  private cr!: ChangeRequest;
  private diff?: ChangeRequestDiff;
  private agents: AgentDescriptor[] = [DEMO_AGENT_DESCRIPTOR];
  private agentId: string = DEMO_AGENT_DESCRIPTOR.id;
  private agentOpen = false;
  private review?: Review;
  private response?: AgentReviewResponse;
  private threads: Record<string, Array<{ label: string; text: string }>> = {};
  private mode: 'split' | 'queue' = 'split';
  private selectedId?: string;
  private runSteps: string[] = [];
  private runStep = 0;
  private runError?: { message: string; requestId: string; partialCount: number; code: string };
  private runToken = 0;
  private summaryText = '';
  private finalNote = '';
  private postThread = true;
  private requestChanges = true;
  private submitError?: string;
  private failedKeys?: Set<string>;
  private summaryPosted = false;
  private doneSentence = '';
  private staleHead?: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: ReviewFlowDeps,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      this.runToken += 1;
      void vscode.commands.executeCommand('setContext', 'verdict.reviewFocus', false);
      if (ReviewFlowPanel.current === this) ReviewFlowPanel.current = undefined;
    });
    panel.onDidChangeViewState(() => {
      void vscode.commands.executeCommand('setContext', 'verdict.reviewFocus', this.panel.active);
    });
    void vscode.commands.executeCommand('setContext', 'verdict.reviewFocus', true);
    panel.webview.onDidReceiveMessage((m: FlowMessage) => void this.onMessage(m));
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
    return `codeVerdict.draft.${this.ref.repoId}!${this.ref.number}`;
  }

  private loadSeq = 0;

  private async load(ref: ChangeRequestRef): Promise<void> {
    const loadToken = ++this.loadSeq;
    // Cancel any in-flight run for the previous MR — its completion must
    // never land findings under this ref's review or draft key.
    this.runToken += 1;
    this.runSteps = [];
    this.runStep = 0;
    this.runError = undefined;
    // Full per-MR reset: nothing (verdicts, threads, summary text, the
    // partial-failure ledger) may leak from one MR into another.
    this.ref = ref;
    this.review = undefined;
    this.response = undefined;
    this.threads = {};
    this.selectedId = undefined;
    this.summaryText = '';
    this.finalNote = '';
    this.submitError = undefined;
    this.failedKeys = undefined;
    this.summaryPosted = false;
    this.threadsAccum = {};
    this.doneSentence = '';
    this.staleHead = undefined;
    this.agentOpen = false;

    const connection = await this.connection();
    const crs = await connection.listOpenChangeRequests([ref.repoId]);
    if (this.disposed || loadToken !== this.loadSeq) return;
    const cr = crs.find((c) => c.ref.number === ref.number);
    if (!cr) {
      void vscode.window.showWarningMessage(`Verdict: ${ref.number} is no longer open.`);
      this.panel.dispose();
      return;
    }
    this.cr = cr;
    this.diff = await connection.getChangeRequestDiff(ref);
    this.agents = [DEMO_AGENT_DESCRIPTOR, ...(await discoverLmAgents())];
    if (this.disposed || loadToken !== this.loadSeq) return;
    const pod = this.pod();
    if (pod.agentId && this.agents.some((a) => a.id === pod.agentId)) {
      this.agentId = pod.agentId;
    }

    // A surviving draft re-enters triage (spec: drafts lose no work),
    // including the partial-failure ledger.
    const draft = this.deps.workspaceState.get<SessionDraft>(this.draftKey());
    if (draft && draft.review.headSha) {
      this.review = draft.review;
      this.threads = draft.threads;
      this.summaryText = draft.summaryText;
      this.finalNote = draft.finalNote;
      this.failedKeys = draft.failedKeys ? new Set(draft.failedKeys) : undefined;
      this.summaryPosted = draft.summaryPosted ?? false;
      this.screen = 'triage';
      this.selectedId = nextUndecided(draft.review)?.id ?? draft.review.items[0]?.id;
      this.staleHead = draft.review.headSha === cr.headSha ? undefined : cr.headSha;
    } else {
      this.screen = 'agent';
    }
    this.render();
  }

  private async persistDraft(): Promise<void> {
    if (!this.review) return;
    await this.deps.workspaceState.update(this.draftKey(), {
      review: this.review,
      threads: this.threads,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      failedKeys: this.failedKeys ? [...this.failedKeys] : undefined,
      summaryPosted: this.summaryPosted || undefined,
    } satisfies SessionDraft);
  }

  // ---- running ----------------------------------------------------------------

  private async run(): Promise<void> {
    if (!this.diff) return;
    const token = ++this.runToken;
    this.screen = 'running';
    this.runError = undefined;
    this.runStep = 0;
    const pod = this.pod();
    pod.agentId = this.agentId;
    await this.deps.podStore.upsert(pod);

    if (this.agentId === DEMO_AGENT_DESCRIPTOR.id) {
      const { response, steps } = runDemoAgent(this.diff, pod.criteria);
      this.runSteps = steps;
      // Walk the log like the spec's progress screen — a log, not a spinner.
      for (let i = 0; i <= steps.length; i++) {
        if (this.disposed || token !== this.runToken) return;
        this.runStep = i;
        this.render();
        await new Promise((resolve) => setTimeout(resolve, 320));
      }
      if (this.disposed || token !== this.runToken) return;
      this.finishRun(response);
      return;
    }

    const lmStats = diffStats(this.diff.files.map((f) => f.diff));
    this.runSteps = [
      'Resolving agent from Copilot workspace…',
      `Indexing ${this.diff.files.length} changed files (+${lmStats.added} −${lmStats.removed})…`,
      'Cross-referencing module history…',
      'Scoring findings against project criteria…',
      'Items ready',
    ];
    this.runStep = 2;
    this.render();
    try {
      const response = await runLmAgent(this.agentId, this.diff, pod.criteria);
      if (this.disposed || token !== this.runToken) return;
      this.finishRun(response);
    } catch (e) {
      if (this.disposed || token !== this.runToken) return;
      const err = e instanceof AgentRunError ? e : new AgentRunError(String(e), '------', false);
      this.runError = {
        message: err.message,
        requestId: err.requestId,
        partialCount: 0,
        code: err.timedOut ? 'copilot.request.timeout · 90000ms' : 'copilot.request.error',
      };
      this.render();
    }
  }

  private finishRun(response: AgentReviewResponse): void {
    const pod = this.pod();
    this.response = response;
    if (response.items.length === 0) {
      // The superseded draft must not resurrect a dead review on next open.
      void this.deps.workspaceState.update(this.draftKey(), undefined);
      this.review = undefined;
      this.screen = 'clean';
      this.render();
      return;
    }
    this.review = createReview({
      repoId: this.ref.repoId,
      crNumber: this.ref.number,
      agentId: response.agentId,
      criteria: pod.criteria,
      response,
    });
    this.threads = {};
    // A fresh run supersedes any previous submit attempt's ledger.
    this.submitError = undefined;
    this.failedKeys = undefined;
    this.summaryPosted = false;
    this.threadsAccum = {};
    this.selectedId = this.review.items[0]?.id;
    this.staleHead = undefined;
    this.screen = 'triage';
    void this.persistDraft();
    this.render();
  }

  // ---- messages ------------------------------------------------------------------

  private async onMessage(m: FlowMessage): Promise<void> {
    const pod = this.pod();
    switch (m.type) {
      case 'toggleAgentOpen':
        this.agentOpen = !this.agentOpen;
        break;
      case 'selectAgent':
        this.agentId = m.agentId;
        this.agentOpen = false;
        break;
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
        pod.criteria.extraInstructions = m.text;
        await this.deps.podStore.upsert(pod);
        break;
      case 'run':
        void this.run();
        return;
      case 'cancel':
        this.runToken += 1;
        this.screen = 'agent';
        break;
      case 'retryRun':
        void this.run();
        return;
      case 'openTuning':
        void vscode.window.showInformationMessage(
          'Verdict: the agent scorecard arrives with issue #13.',
        );
        return;
      case 'usePartial':
        // The demo agent never produces partials; the lm path reports 0
        // today — reachable once streaming partial parses land.
        this.runError = undefined;
        this.screen = 'agent';
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
        const applyFix = m.applyFix && Boolean(item?.suggestion);
        this.review = setVerdict(this.review, m.itemId, m.verdict, applyFix);
        const auto = vscode.workspace.getConfiguration('codeVerdict').get<boolean>('autoAdvance', true);
        if (auto) {
          this.selectedId = nextUndecided(this.review, m.itemId)?.id ?? this.selectedId;
        }
        await this.persistDraft();
        break;
      }
      case 'undo':
        if (!this.review) return;
        this.review = clearVerdict(this.review, m.itemId);
        await this.persistDraft();
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
        const target = this.review?.items.find((i) => i.severity === m.severity);
        if (target) this.selectedId = target.id;
        break;
      }
      case 'ask': {
        if (!this.review) return;
        const item = this.review.items.find((i) => i.id === m.itemId);
        if (!item) return;
        const list = (this.threads[m.itemId] ??= []);
        if (m.preset === 'freeform') {
          list.push({ label: 'agent · reply', text: this.freeformAnswer(m.text ?? '') });
        } else {
          const label = `agent · ${m.preset}`;
          // Idempotent — asking twice does not duplicate (spec).
          if (!list.some((t) => t.label === label)) {
            list.push({ label, text: item.answers?.[m.preset] ?? 'The agent has nothing further on this.' });
          }
        }
        await this.persistDraft();
        break;
      }
      case 'openInEditor':
        void vscode.window.showTextDocument(vscode.Uri.file(m.file), { preview: true }).then(
          undefined,
          () =>
            vscode.window.showInformationMessage(
              `Verdict: ${m.file} is not in this workspace — it lives in the reviewed repository.`,
            ),
        );
        return;
      case 'reanchor': {
        // Refetch the diff and recompute each item's line from where its
        // flagged code now sits (spec §6: re-anchor = recompute line
        // numbers from the new diff).
        const connection = await this.connection();
        this.diff = await connection.getChangeRequestDiff(this.ref);
        if (this.review && this.diff) {
          const diff = this.diff;
          let moved = 0;
          const items = this.review.items.map((item) => {
            const file = diff.files.find((f) => f.newPath === item.file);
            if (!file) return item;
            const match = addedLines(file.diff).find((a) => a.text.trim() === item.code.trim());
            if (!match || match.line === item.line) return item;
            moved += 1;
            return { ...item, line: match.line };
          });
          this.review = { ...this.review, items, headSha: diff.headSha };
          if (moved > 0) {
            void vscode.window.showInformationMessage(
              `Verdict: re-anchored ${moved} ${moved === 1 ? 'finding' : 'findings'} to the new HEAD.`,
            );
          }
        }
        this.staleHead = undefined;
        await this.persistDraft();
        break;
      }
      case 'rerun':
        void this.run();
        return;
      case 'generateSummary':
        if (!this.review || !allDecided(this.review)) return;
        this.summaryText = this.generateSummaryText();
        this.screen = 'summary';
        await this.persistDraft();
        break;
      case 'editSummary':
        this.summaryText = m.text;
        await this.persistDraft();
        return;
      case 'regenerate':
        this.summaryText = this.generateSummaryText();
        break;
      case 'setNote':
        this.finalNote = m.text;
        await this.persistDraft();
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
        await vscode.env.clipboard.writeText(composeSummaryBody(this.summaryText, this.finalNote));
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
        void DashboardPanel.show(this.deps.podStore, this.deps.secrets, {
          submittedRefs: () => new ReviewHistory(this.deps.globalState).submittedRefs(),
        });
        return;
      case 'openMr':
        void vscode.env.openExternal(vscode.Uri.parse(this.cr.webUrl));
        return;
      case 'trackReplies':
        void vscode.commands.executeCommand('codeVerdict.openReview');
        return;
      case 'help':
        void vscode.window.showInformationMessage(
          'Verdict keys — A accept · ⇧A accept comment-only · R reject · S skip · J/K move · 1–4 jump to severity · U undo. Full overlay arrives with issue #14.',
        );
        return;
    }
    this.render();
  }

  private freeformAnswer(question: string): string {
    return `On "${question.trim()}": the finding stands as written — the flagged line is the concrete risk, and the suggested change (where present) is the smallest fix that removes it.`;
  }

  private generateSummaryText(): string {
    if (!this.review) return '';
    const voice = vscode.workspace
      .getConfiguration('codeVerdict')
      .get<AgentVoice>('agentVoice', 'terse');
    return composeSummary(this.review, this.agentLabel(), voice);
  }

  // ---- submit ---------------------------------------------------------------------

  private threadsAccum: Record<string, string> = {};

  private async submit(): Promise<void> {
    if (!this.review || !this.diff) return;
    // Palette-invoked submits must obey the same gate as the button: a
    // fully-triaged review, from the summary screen.
    if (this.screen !== 'summary' || !allDecided(this.review)) return;
    const pod = this.pod();
    const provider = getProvider(pod.providerId);
    const you = pod.username ?? 'you';
    const drafts = composeCommentDrafts(this.review, this.agentLabel(), you, this.diff.anchorRefs);
    try {
      const connection = await this.connection();
      const result = await performSubmit(
        connection,
        this.ref,
        {
          drafts,
          summary: composeSummaryBody(this.summaryText, this.finalNote),
          requestChanges: this.requestChanges && provider.capabilities.requestChanges,
          asSingleThread: this.postThread && provider.capabilities.batchedReview,
        },
        { retryKeys: this.failedKeys, summaryAlreadyPosted: this.summaryPosted },
      );

      const failed = result.comments.filter((c) => !c.ok);
      for (const outcome of result.comments) {
        if (outcome.threadId) this.threadsAccum[outcome.key] = outcome.threadId;
      }
      if (result.summaryPosted) this.summaryPosted = true;
      if (failed.length > 0 || (!this.summaryPosted && result.summaryError)) {
        this.failedKeys = new Set(failed.map((c) => c.key));
        const first = failed[0]?.error ?? result.summaryError;
        this.submitError = first?.message ?? 'submit failed';
        this.screen = 'summary';
        // The ledger must survive a reload — a later retry may only post
        // the remainder (spec §7).
        await this.persistDraft();
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
        items: this.review.items
          .filter((i) => this.review?.verdicts[i.id]?.verdict === 'accepted')
          .map((i) => ({ id: i.id, title: i.title, severity: i.severity, file: i.file, line: i.line })),
        requestedChanges: result.requestChangesApplied === true,
      });
      await this.deps.workspaceState.update(this.draftKey(), undefined);
      this.submitError = undefined;
      this.failedKeys = undefined;
      this.doneSentence = [
        `${counts.accepted} inline ${counts.accepted === 1 ? 'comment' : 'comments'} posted${this.postThread && provider.capabilities.batchedReview ? ' as one review thread' : ''}${result.requestChangesApplied ? ', changes requested' : ''}.`,
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
    }
  }

  // ---- commands from the palette / keybindings -------------------------------------

  dispatchCommand(command: string): boolean {
    const simple: Record<string, FlowMessage | undefined> = {
      'codeVerdict.acceptItem': this.selectedId
        ? { type: 'verdict', itemId: this.selectedId, verdict: 'accepted' as Verdict, applyFix: true }
        : undefined,
      'codeVerdict.acceptItemApplyFix': this.selectedId
        ? { type: 'verdict', itemId: this.selectedId, verdict: 'accepted' as Verdict, applyFix: true }
        : undefined,
      'codeVerdict.rejectItem': this.selectedId
        ? { type: 'verdict', itemId: this.selectedId, verdict: 'rejected' as Verdict, applyFix: false }
        : undefined,
      'codeVerdict.skipItem': this.selectedId
        ? { type: 'verdict', itemId: this.selectedId, verdict: 'skipped' as Verdict, applyFix: false }
        : undefined,
      'codeVerdict.nextItem': { type: 'move', delta: 1 },
      'codeVerdict.prevItem': { type: 'move', delta: -1 },
      'codeVerdict.generateSummary': { type: 'generateSummary' },
      'codeVerdict.submitReview': { type: 'submit' },
      'codeVerdict.runReview': { type: 'run' },
    };
    const message = simple[command];
    if (!message) return false;
    void this.onMessage(message);
    return true;
  }

  // ---- rendering --------------------------------------------------------------------

  private refLabel(): string {
    return getProvider(this.pod().providerId).vocabulary.formatCrRef(this.ref.number);
  }

  private agentLabel(): string {
    return this.agents.find((a) => a.id === this.agentId)?.label ?? this.agentId;
  }

  private render(): void {
    if (this.disposed) return;
    const pod = this.pod();
    const stats = this.diff ? diffStats(this.diff.files.map((f) => f.diff)) : { added: 0, removed: 0 };
    const items: TriageItemView[] = (this.review?.items ?? []).map((item) => ({
      item,
      verdict: this.review?.verdicts[item.id]?.verdict,
      applyFix: this.review?.verdicts[item.id]?.applyFix,
      thread: this.threads[item.id] ?? [],
    }));
    const counts = this.review
      ? verdictCounts(this.review)
      : { accepted: 0, rejected: 0, skipped: 0, undecided: 0 };
    const history = new ReviewHistory(this.deps.globalState).list().filter((r) => r.podId === pod.id);
    const produced = history.reduce(
      (n, r) => n + r.counts.accepted + r.counts.rejected + r.counts.skipped,
      0,
    );
    const acceptRate =
      produced > 0
        ? Math.round((history.reduce((n, r) => n + r.counts.accepted, 0) / produced) * 100)
        : undefined;
    const state: FlowViewState = {
      screen: this.screen,
      acceptRate,
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
      criteria: pod.criteria,
      runSteps: this.runSteps,
      runStep: this.runStep,
      runError: this.runError,
      mode: this.mode,
      items,
      selectedId: this.selectedId,
      counts,
      stale: this.staleHead
        ? { newHead: this.staleHead, affected: this.review?.items.length ?? 0 }
        : undefined,
      candidates: this.response?.candidates ?? [],
      filesRead: this.response?.stats?.filesRead ?? this.diff?.files.length ?? 0,
      summaryText: this.summaryText,
      finalNote: this.finalNote,
      postThread: this.postThread,
      requestChanges: this.requestChanges,
      supportsRequestChanges: getProvider(pod.providerId).capabilities.requestChanges,
      submitError: this.submitError,
      username: pod.username ?? 'you',
      doneSentence: this.doneSentence,
      crWebUrl: this.cr.webUrl,
    };
    const nonce = crypto.randomBytes(16).toString('hex');
    this.panel.title =
      this.screen === 'agent'
        ? `Verdict: Run review · ${state.header.refLabel}`
        : this.screen === 'done'
          ? `Verdict: Posted · ${state.header.refLabel}`
          : `Verdict: Review · ${state.header.refLabel}`;
    this.panel.webview.html = renderReviewFlowHtml(state, this.agentLabel(), nonce);
  }
}
