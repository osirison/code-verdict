/**
 * The review-flow panel: one webview tab hosting the state machine
 * agent → running → triage/clean → summary → done (handoff §2), with the
 * tab title tracking the state and drafts surviving reloads via
 * workspaceState.
 */
import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { COMMANDS } from '../commands';
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
import { type AnchorCandidate, movedAnchors, resolveAnchor } from '../domain/anchor';
import { diffStats, parseHunks } from '../domain/diffHunks';
import { composeSummary } from '../domain/summary';
import type { AgentVoice } from '../domain/summary';
import {
  allDecided,
  clearVerdict,
  createReview,
  firstOfSeverity,
  isStale,
  nextUndecided,
  setVerdict,
  verdictCounts,
} from '../domain/reviewState';
import type { Category, Review, Severity } from '../domain/types';
import { SEVERITY_ORDER } from '../domain/criteria';
import { getProvider } from '../platform/registry';
import { isScmError } from '../platform/errors';
import type { ChangeRequest, ChangeRequestDiff, ChangeRequestRef } from '../platform/types';
import { flowCommandMessage } from './flowCommands';
import type { FlowMessage, FlowScreen, FlowViewState, TriageItemView } from './reviewFlowHtml';
import { renderReviewFlowHtml } from './reviewFlowHtml';
import { AppSurface, type AppRoute } from './appSurface';
import { InDiffEditor, locateInWorkspace } from './inDiffEditor';
import type { SidebarActiveReview, SidebarPendingReview } from './sidebarHtml';

/**
 * How often triage asks whether the branch moved under it (handoff §6 —
 * "poll the MR head"). Slow enough to be invisible on the API budget, quick
 * enough that a push lands in the banner while the reviewer is still reading.
 */
const HEAD_POLL_MS = 45_000;

interface SessionDraft {
  review: Review;
  threads: Record<string, Array<{ label: string; text: string }>>;
  summaryText: string;
  finalNote: string;
  /** Partial-failure ledger — must survive reloads so a retry never re-posts what already landed (spec §7). */
  failedKeys?: string[];
  summaryPosted?: boolean;
  verdictApplied?: boolean;
  /** itemId → thread id for comments that already landed, across attempts. */
  threadsAccum?: Record<string, string>;
  /** Sticky: once any comment posted on its own, the review is not one review. */
  postedIndividually?: boolean;
}

export interface ReviewFlowDeps {
  podStore: PodStore;
  secrets: SecretStore;
  workspaceState: KeyValueStore;
  globalState: KeyValueStore;
  onSubmitted?: () => void;
  onSidebarState?: (state?: SidebarActiveReview) => void;
  /** Spec §3: identity and agent, before any findings exist. */
  onSidebarPending?: (state?: SidebarPendingReview) => void;
  /** The agent finished a run — the notification engine's local event. */
  onReviewReady?: (info: { ref: ChangeRequestRef; refLabel: string; itemCount: number }) => void;
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
    if (!panel || panel.disposed) return false;
    return panel.dispatchCommand(command, arg);
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
  private cr!: ChangeRequest;
  private diff?: ChangeRequestDiff;
  private agents: AgentDescriptor[] = [DEMO_AGENT_DESCRIPTOR];
  private agentId: string = DEMO_AGENT_DESCRIPTOR.id;
  private agentOpen = false;
  private review?: Review;
  private response?: AgentReviewResponse;
  private threads: Record<string, Array<{ label: string; text: string }>> = {};
  private mode: 'split' | 'queue' | 'diff' = 'split';
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

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: ReviewFlowDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      this.runToken += 1;
      this.stopHeadPoll();
      this.inDiff.dispose();
      this.focusWatch?.dispose();
      this.focusWatch = undefined;
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
    this.focusWatch = route.panel.onDidChangeViewState?.((event) =>
      this.setReviewFocus(event.webviewPanel.active),
    );
    route.onMessage((message) => void this.onMessage(message as FlowMessage));
  }

  private setReviewFocus(active: boolean): void {
    void vscode.commands.executeCommand(
      'setContext',
      'verdict.reviewFocus',
      active && !this.disposed,
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
    this.verdictApplied = false;
    this.threadsAccum = {};
    this.postedIndividually = false;
    this.doneSentence = '';
    this.staleHead = undefined;
    this.staleItemIds = new Set();
    this.agentOpen = false;
    this.memberOfChangeset = undefined;

    const connection = await this.connection();
    const crs = await connection.listOpenChangeRequests([ref.repoId]);
    if (this.disposed || loadToken !== this.loadSeq) return;
    const cr = crs.find((c) => c.ref.number === ref.number);
    if (!cr) {
      void vscode.window.showWarningMessage(`Verdict: ${ref.number} is no longer open.`);
      void vscode.commands.executeCommand(COMMANDS.openDashboard);
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
      this.verdictApplied = draft.verdictApplied ?? false;
      this.threadsAccum = { ...draft.threadsAccum };
      this.postedIndividually = draft.postedIndividually ?? false;
      this.screen = 'triage';
      this.selectedId = nextUndecided(draft.review)?.id ?? draft.review.items[0]?.id;
      // The diff just fetched is the branch as it stands now, so the same
      // fetch that detects the moved head also says which findings moved.
      this.staleHead = isStale(draft.review, cr.headSha) ? cr.headSha : undefined;
      this.staleItemIds = this.staleHead ? this.markMoved(this.diff) : new Set();
    } else {
      this.screen = 'agent';
    }
    this.render();
    void this.resolveChangesetMembership(loadToken);
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

  /** The lines a finding can legitimately sit on: everything the new diff shows. */
  private anchorCandidates(diff: ChangeRequestDiff, file: string): AnchorCandidate[] | undefined {
    const changed = diff.files.find((f) => f.newPath === file);
    if (!changed) return undefined;
    return parseHunks(changed.diff)
      .flatMap((hunk) => hunk.lines)
      .filter((line) => line.newLine !== undefined)
      .map((line) => ({ line: line.newLine as number, text: line.text }));
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

  private async persistDraft(): Promise<void> {
    if (!this.review) return;
    await this.deps.workspaceState.update(this.draftKey(), {
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
      `Scoring findings against ${getProvider(this.pod().providerId).vocabulary.repoNoun} criteria…`,
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
    this.deps.onReviewReady?.({
      ref: this.ref,
      refLabel: this.refLabel(),
      itemCount: response.items.length,
    });
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
    this.verdictApplied = false;
    this.threadsAccum = {};
    this.postedIndividually = false;
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
        await vscode.commands.executeCommand('codeVerdict.selectAgent');
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
        const target = this.review ? firstOfSeverity(this.review, m.severity) : undefined;
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
            return { ...item, line: resolved.line };
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
        void vscode.commands.executeCommand(COMMANDS.openDashboard);
        return;
      case 'openMr':
        void vscode.env.openExternal(vscode.Uri.parse(this.cr.webUrl));
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
  /** Sticky across retries: any comment posted on its own breaks "one review". */
  private postedIndividually = false;

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
        {
          retryKeys: this.failedKeys,
          summaryAlreadyPosted: this.summaryPosted,
          verdictAlreadyApplied: this.verdictApplied,
        },
      );

      const failed = result.comments.filter((c) => !c.ok);
      for (const outcome of result.comments) {
        if (outcome.threadId) this.threadsAccum[outcome.key] = outcome.threadId;
      }
      if (result.summaryPosted) this.summaryPosted = true;
      if (result.requestChangesApplied) this.verdictApplied = true;
      if (result.postedAsSingleReview === false) this.postedIndividually = true;
      // A verdict that did not land is a failure like any other: without this
      // the comments post, the draft is cleared, and the request for changes is
      // lost with nothing to retry. `performChangesetSubmit` already surfaces it.
      const verdictFailed = !this.verdictApplied && result.requestChangesError !== undefined;
      if (failed.length > 0 || (!this.summaryPosted && result.summaryError) || verdictFailed) {
        this.failedKeys = new Set(failed.map((c) => c.key));
        const first = failed[0]?.error ?? result.summaryError ?? result.requestChangesError;
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
      await this.deps.workspaceState.update(this.draftKey(), undefined);
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
      lineMoved: this.staleItemIds.has(item.id),
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
      vocabulary: getProvider(pod.providerId).vocabulary,
      screen: this.screen,
      acceptRate,
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
      criteria: pod.criteria,
      runSteps: this.runSteps,
      runStep: this.runStep,
      runError: this.runError,
      mode: this.mode,
      items,
      selectedId: this.selectedId,
      diffLines: this.mode === 'diff'
        ? this.diff?.files
          .filter((file) => file.newPath === items.find((view) => view.item.id === this.selectedId)?.item.file)
          .flatMap((file) => parseHunks(file.diff).flatMap((hunk) => hunk.lines))
        : undefined,
      counts,
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
