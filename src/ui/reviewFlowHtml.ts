/**
 * The review-flow screens (spec/README.md §3–§8) as pure renderers:
 * Run review → Running (with the failure card) → Triage (split / queue / in-diff)
 * → Clean bill → Summary (with the submit-failure banner) → Submitted.
 */
import type { CandidateBucket } from '../domain/agentResponse';
import type { Category, Criteria, ReviewItem, Severity, Verdict } from '../domain/types';
import type { AgentDescriptor, ModelDescriptor } from '../app/agents';
import type { HunkLine } from '../domain/diffHunks';
import type { LinkedWorkItem, ReviewContextEntry } from '../app/reviewContext';
import type { Vocabulary } from './vocab';
import { cap, countOf } from './vocab';
import { escapeHtml as e } from './dashboardHtml';
import { renderPage } from './theme';

export type FlowScreen = 'agent' | 'running' | 'triage' | 'clean' | 'summary' | 'submitting' | 'done';

/**
 * What the submit is doing, mirrored from the provider. Submitting is the
 * longest operation in the product and used to run behind an unchanged summary
 * screen, so it looked like the panel had frozen (#42).
 */
export interface SubmitProgressView {
  stage: 'comments' | 'summary' | 'verdict';
  posted: number;
  total: number;
}

/**
 * Proof the run is alive, for the running screen. The canned five-step log
 * parks on step 2 for the whole request, so a healthy multi-minute review and
 * a dead one used to look identical — that is half of what the timeout report
 * was about, the other half being that the run was then cancelled. These are
 * `AgentRunProgress` counters, straight from the fragments as they land.
 */
export interface RunLivenessView {
  /** Epoch ms the request started, so the page can tick its own clock between fragments. */
  startedAt: number;
  /** Elapsed at render time — the renderer stays pure rather than reading the clock itself. */
  elapsedMs: number;
  fragmentsReceived: number;
  charsReceived: number;
}

export interface FlowHeaderInfo {
  refLabel: string;
  projectPath: string;
  branch: string;
  fileCount: number;
  added: number;
  removed: number;
  title: string;
}

export interface TriageItemView {
  item: ReviewItem;
  verdict?: Verdict;
  applyFix?: boolean;
  thread: Array<{ label: string; text: string }>;
  projectLabel?: string;
  refLabel?: string;
  /** New commits moved this finding off the line the agent read (spec §5). */
  lineMoved?: boolean;
  /**
   * The sides of a cross finding its comment may be re-targeted to
   * (handoff §16: "spans[0] by convention, overridable in the UI").
   * Only sides that resolve to a real added-line anchor appear here.
   */
  crossTargets?: Array<{ repoId: string; number: string; location: string; active: boolean }>;
}

/**
 * What the agent was told this change is for, as the triage screen shows it.
 * `entries` are the same `ReviewContext` values `renderReviewContextPrompt`
 * was built from — never a second derivation, which could disagree with what
 * was actually reviewed.
 */
export interface ReviewContextView {
  /**
   * Open or collapsed. Kept in the panel rather than in a `<details>` element
   * because the region patch (#39) replaces `#flow-body` wholesale on every
   * verdict, which would slam an open box shut mid-triage.
   */
  open: boolean;
  /**
   * The prompt carried less than what follows — one of the context budgets cut
   * it. The panel answers this with `reviewContextTruncatedForPrompt` over the
   * entries the prompt itself was given, labels included: the total budget
   * counts those, so the screen's own labels would answer for a prompt that
   * was never sent.
   */
  truncated: boolean;
  /** One block per change request under review; `label` names the member in changeset scope. */
  entries: readonly ReviewContextEntry[];
}

export interface ChangesetReviewScope {
  id: string;
  name: string;
  /** Branch- and manual-detected changesets have no linked issue. */
  linkedIssue?: string;
  memberCount: number;
  projectCount: number;
  refs: string[];
  repoLabels?: Record<string, string>;
}

export interface FlowViewState {
  /** Platform nouns for the active pod's provider — never hardcoded here. */
  vocabulary: Vocabulary;
  screen: FlowScreen;
  /** Set only while `screen` is 'submitting'. */
  submitProgress?: SubmitProgressView;
  header: FlowHeaderInfo;
  agents: AgentDescriptor[];
  agentId: string;
  agentOpen: boolean;
  /** Copilot chat models. Empty when Copilot is absent — the screen says so rather than showing an empty picker. */
  models: ModelDescriptor[];
  /** Unset when no model is available, and whenever the demo agent is selected. */
  modelId?: string;
  modelOpen: boolean;
  /** What reconciliation silently changed — a stale agent or model. Rendered on the screen, not as a toast. */
  selectionNotices: string[];
  /** Agent files that could not be parsed. Reported as a count with the detail behind it. */
  skippedAgents: Array<{ path: string; reason: string }>;
  criteria: Criteria;
  /** "56% accepted in this pod" — undefined hides the tuning link. */
  acceptRate?: number;
  /**
   * The signed-in user opened this change request. Optional because the answer
   * can be genuinely unknown — `Pod.username` is optional, so a pod that has
   * not resolved one yet cannot tell. Unknown must render as *not* the author:
   * the platform's own refusal (`verdictRefused`, platform/errors.ts) is the
   * backstop, and hiding the controls on a guess would strip a reviewer of the
   * verdict they are entitled to give.
   */
  selfAuthored?: boolean;
  // running
  runSteps: string[];
  runStep: number;
  /** Set only while an `lm:` request is in flight; the demo agent walks its own log instead. */
  runLive?: RunLivenessView;
  runError?: { message: string; requestId: string; partialCount: number; code: string };
  // triage
  mode: 'split' | 'queue' | 'diff';
  items: TriageItemView[];
  selectedId?: string;
  diffLines?: HunkLine[];
  counts: { accepted: number; rejected: number; skipped: number; undecided: number };
  /**
   * The model that produced the findings currently in triage, resolved from
   * the *stored* review rather than the live picker — reopening a review must
   * say what ran it, not what happens to be selected now. Undefined for a
   * review stored before models were separate, and for a demo review.
   */
  reviewModelLabel?: string;
  /** Absent until the change request's own fetch returns — the box renders nothing at all rather than a shell. */
  context?: ReviewContextView;
  stale?: { newHead: string; affected: number; affectedAccepted?: number };
  changeset?: ChangesetReviewScope;
  /** Set on a single-CR review whose MR belongs to a detected changeset (§15 entry point "a member MR"). */
  memberOfChangeset?: { id: string; name: string; memberCount: number };
  // clean
  candidates: CandidateBucket[];
  filesRead: number;
  // summary
  summaryText: string;
  finalNote: string;
  postThread: boolean;
  requestChanges: boolean;
  supportsRequestChanges: boolean;
  submitError?: string;
  username: string;
  // done
  doneSentence: string;
  crWebUrl: string;
}

export type FlowMessage =
  | { type: 'toggleAgentOpen' }
  | { type: 'selectAgent'; agentId: string }
  | { type: 'toggleModelOpen' }
  | { type: 'selectModel'; modelId: string }
  | { type: 'dismissNotices' }
  | { type: 'showSkippedAgents' }
  | { type: 'setFloor'; floor: Severity }
  | { type: 'setConfidence'; value: number }
  | { type: 'toggleCategory'; category: Category }
  | { type: 'setInstructions'; text: string }
  | { type: 'run' }
  | { type: 'cancel' }
  | { type: 'usePartial' }
  | { type: 'retryRun' }
  | { type: 'toggleReviewContext' }
  | { type: 'setMode'; mode: 'split' | 'queue' | 'diff' }
  | { type: 'select'; itemId: string }
  | { type: 'verdict'; itemId: string; verdict: Verdict; applyFix: boolean }
  | { type: 'undo'; itemId: string }
  | { type: 'move'; delta: 1 | -1 }
  | { type: 'jumpSeverity'; severity: Severity }
  | { type: 'ask'; itemId: string; preset: 'explain' | 'fix' | 'similar' | 'why' | 'freeform'; text?: string }
  | { type: 'openInEditor'; file: string; line: number }
  | { type: 'reanchor' }
  | { type: 'rerun' }
  | { type: 'generateSummary' }
  | { type: 'editSummary'; text: string }
  | { type: 'regenerate' }
  | { type: 'setNote'; text: string }
  | { type: 'toggleOption'; option: 'postThread' | 'requestChanges' }
  | { type: 'submit' }
  | { type: 'copyMarkdown' }
  | { type: 'retrySubmit' }
  | { type: 'reconnect' }
  | { type: 'backToTriage' }
  | { type: 'approve' }
  | { type: 'lowerBar' }
  | { type: 'backToDashboard' }
  | { type: 'openMr' }
  | { type: 'trackReplies' }
  | { type: 'openTuning' }
  | { type: 'reviewSingle'; repoId: string; number: string }
  | { type: 'setCrossTarget'; itemId: string; repoId: string; location: string }
  | { type: 'openChangeset'; changesetId: string }
  | { type: 'retryLoad' };

export const SEVERITIES: readonly Severity[] = ['nit', 'minor', 'major', 'blocker'];

export const ALL_CATEGORY_LABELS: Record<Category, string> = {
  security: 'Security',
  concurrency: 'Concurrency',
  errorHandling: 'Error handling',
  performance: 'Performance',
  craftsmanship: 'Craftsmanship',
  apiContract: 'API contract',
  tests: 'Tests',
  docs: 'Docs & comments',
  style: 'Style',
};

const CATEGORY_COLOR: Record<Category, string> = {
  security: 'var(--sev-blocker)',
  concurrency: 'var(--agent)',
  errorHandling: 'var(--sev-major)',
  performance: 'var(--sev-minor)',
  craftsmanship: 'var(--ok)',
  apiContract: 'var(--brand)',
  tests: 'var(--ok-strong)',
  docs: 'var(--fg-dim)',
  style: 'var(--fg-dimmer)',
};

const FLOOR_HINTS: Record<Severity, string> = {
  nit: 'Everything, nits included — noisy on large diffs.',
  minor: 'Balanced: minor, major, blocker.',
  major: 'Major and blocker only — quieter, misses smaller gaps.',
  blocker: 'Blockers only — fastest pass, misses test gaps.',
};

const CSS = `
.wrap { max-width: 760px; margin: 0 auto; padding: 26px 30px; display: flex; flex-direction: column; gap: 22px; }
.wrap-wide { max-width: 840px; }
.subline { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dimmer); }
h1 { font-size: 19px; font-weight: 600; color: var(--fg-max); }
.lede { font-size: 12.5px; line-height: 1.6; color: var(--fg-dim); }

.agent-select { position: relative; }
.agent-row { display: flex; align-items: center; gap: 9px; border: 1px solid var(--line2); border-radius: 5px; background: var(--bg2); padding: 9px 11px; cursor: pointer; width: 100%; color: var(--fg); font-family: var(--font-ui); }
.agent-row:hover { border-color: var(--accent); }
.agent-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--agent); flex: none; }
.agent-name { font-size: 12.5px; font-weight: 600; color: var(--fg-hi); }
.agent-badge { font-family: var(--font-mono); font-size: 9.5px; color: var(--agent); border: 1px solid var(--agent-b); border-radius: 3px; padding: 2px 6px; }
.agent-caret { margin-left: auto; color: var(--fg-dimmer); font-size: 9px; }
.agent-menu { position: absolute; top: calc(100% + 4px); left: 0; right: 0; background: var(--bg3); border: 1px solid var(--line2); border-radius: 6px; box-shadow: 0 10px 28px rgba(0,0,0,.5); z-index: 30; }
.agent-menu-head { padding: 8px 12px 4px; font-size: 9.5px; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-dimmer); }
.agent-option { display: flex; align-items: center; gap: 9px; padding: 8px 12px; cursor: pointer; }
.agent-option:hover { background: var(--hover); }
.agent-option.active { background: var(--sel); }
.agent-option .desc { font-size: 11px; color: var(--fg-dim); }
.agent-menu-foot { border-top: 1px solid var(--line2); padding: 8px 12px; font-size: 11px; color: var(--link); }
.agent-sub { font-size: 11.5px; color: var(--fg-dim); margin-top: 8px; }
.agent-sub a { margin-left: 8px; }
.agent-origin { font-family: var(--font-mono); font-size: 9.5px; color: var(--fg-dimmer); margin-left: auto; }
.agent-row.inert { cursor: default; opacity: .6; }
.agent-row.inert:hover { border-color: var(--line2); }
.picker-stack { display: flex; flex-direction: column; gap: 10px; }
.picker-label { font-size: 11px; color: var(--fg-dim); margin-bottom: 5px; }
.notice { display: flex; align-items: flex-start; gap: 8px; border: 1px solid var(--line2); border-left: 2px solid var(--agent); border-radius: 4px; background: var(--bg2); padding: 8px 11px; font-size: 11.5px; color: var(--fg-dim); }
.notice .dismiss { margin-left: auto; color: var(--fg-dimmer); cursor: pointer; background: none; border: none; font-family: var(--font-ui); font-size: 11.5px; }

.crit-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.crit-label { font-size: 11px; color: var(--fg-dim); margin-bottom: 6px; }
.floor { display: grid; grid-template-columns: repeat(4, 1fr); gap: 2px; background: var(--bg3); border-radius: 5px; padding: 2px; }
.floor button { border: none; background: none; color: var(--fg-dim); font-family: var(--font-mono); font-size: 11px; padding: 6px 0; border-radius: 4px; cursor: pointer; }
.floor button.active { background: var(--accent); color: var(--accent-fg); }
.hint { font-size: 11px; color: var(--fg-dimmer); margin-top: 6px; }
input[type=range] { width: 100%; accent-color: var(--accent); }
.cats { display: flex; flex-wrap: wrap; gap: 8px; }
.cat { font-size: 11px; padding: 6px 11px; border-radius: 14px; border: 1px solid var(--line2); color: var(--fg-dimmer); background: none; cursor: pointer; font-family: var(--font-ui); }
textarea.extra { width: 100%; min-height: 74px; font-family: var(--font-mono); font-size: 12px; line-height: 1.7; background: var(--bg2); color: var(--fg); border: 1px solid var(--line2); border-radius: 5px; padding: 10px 12px; resize: vertical; outline: none; }
.footer-row { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding-top: 18px; }
.footer-hint { margin-left: auto; font-size: 11px; color: var(--fg-dimmer); }

.run-col { max-width: 420px; margin: 60px auto; text-align: center; display: flex; flex-direction: column; gap: 16px; }
.spinner { width: 14px; height: 14px; border: 2px solid var(--agent); border-top-color: transparent; border-radius: 50%; animation: spin .8s linear infinite; margin: 0 auto; }
.progress { height: 4px; background: var(--bg3); border-radius: 2px; overflow: hidden; }
.progress > div { height: 100%; background: var(--agent); transition: width .5s ease; }
.runlog { text-align: left; display: flex; flex-direction: column; gap: 7px; font-size: 12px; }
.runlog .done { color: var(--fg-dimmer); }
.runlog .now { color: var(--fg); }
/* The live counters under the bar. Monospace so the ticking clock and the
   growing character count do not shuffle the line sideways every second. */
.run-live { display: flex; align-items: center; justify-content: center; gap: 8px; font-family: var(--font-mono); font-size: 11px; color: var(--fg-dimmer); }
.run-live b { color: var(--fg); font-weight: 600; }
.run-live .sep { opacity: .45; }
.fail-card { text-align: left; border: 1px solid var(--sev-blocker-b); border-left: 3px solid var(--sev-blocker); background: var(--card); border-radius: 6px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.fail-title { font-size: 13.5px; font-weight: 600; color: var(--fg-hi); }
.fail-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }
/* Loading-page skeleton bars (issue #39), sized by a class rather than a
   style attribute — this page's CSP authorises nonce'd style elements
   only, and a nonce never covers a style attribute, so the bars rendered at
   zero height (issue #45). */
.skel-title { width: 220px; height: 16px; margin: 0 auto; }
.skel-meta { width: 320px; height: 12px; margin: 0 auto; }

.tri-head { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
.tri-title { font-size: 14px; font-weight: 600; color: var(--fg-hi); }
.tri-meta { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dimmer); }
.tallies { display: flex; gap: 6px; }
.mode { margin-left: auto; }
.stale { display: flex; align-items: center; gap: 12px; background: var(--sev-major-t); padding: 10px 20px; font-size: 11.5px; color: var(--fg); }
.stale b { font-size: 12px; font-weight: 600; display: block; }
.stale .grow { flex: 1; }
.changeset-scope { display: flex; align-items: center; gap: 10px; padding: 9px 20px; border-bottom: 1px solid var(--agent-b); background: var(--agent-f); color: var(--fg); font-size: 11.5px; }
.changeset-scope .glyph { color: var(--agent); font-size: 14px; }
.changeset-scope strong { color: var(--fg-hi); font-weight: 600; }
.changeset-scope a { margin-left: auto; }
/* What the change is for. Collapsed it is one row; open it scrolls inside its
   own height so the selected finding stays where it was. The pre-wrap that
   keeps an author's line breaks lives here rather than on the element: this
   page's CSP authorises nonce'd style elements only, so a style attribute
   silently never applies (issue #45). */
.ctx { border-bottom: 1px solid var(--line); background: var(--bg2); }
.ctx-head { display: flex; align-items: center; gap: 9px; width: 100%; padding: 9px 20px; border: none; background: none; color: var(--fg-dim); font-family: var(--font-ui); font-size: 11.5px; text-align: left; cursor: pointer; }
.ctx-head:hover { color: var(--fg); }
.ctx-caret { color: var(--fg-dimmer); font-size: 9px; }
.ctx-label { color: var(--fg-hi); font-weight: 600; }
.ctx-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }
.ctx-chip { margin-left: auto; border: 1px solid var(--sev-major); border-radius: 10px; padding: 2px 8px; font-size: 10px; color: var(--sev-major); }
.ctx-body { max-height: 260px; overflow-y: auto; padding: 0 20px 14px; display: flex; flex-direction: column; gap: 12px; }
.ctx-note { font-size: 11px; line-height: 1.5; color: var(--fg-dimmer); }
.ctx-cut { background: var(--sev-major-t); border-radius: 4px; padding: 7px 10px; font-size: 11.5px; line-height: 1.5; color: var(--fg); }
.ctx-block { display: flex; flex-direction: column; gap: 7px; }
.ctx-block-head { font-size: 12.5px; font-weight: 600; color: var(--fg-hi); overflow-wrap: anywhere; }
.ctx-text { font-size: 12px; line-height: 1.6; color: var(--fg); white-space: pre-wrap; overflow-wrap: anywhere; }
.ctx-none { font-size: 11.5px; line-height: 1.5; color: var(--fg-dimmer); }
.ctx-item { display: flex; flex-direction: column; gap: 5px; border-left: 2px solid var(--line2); padding-left: 11px; }
.ctx-item-head { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); overflow-wrap: anywhere; }

.detail { max-width: 820px; margin: 0 auto; padding: 24px 30px 120px; display: flex; flex-direction: column; gap: 16px; }
.detail-title { font-size: 15.5px; font-weight: 600; color: var(--fg-max); }
.detail-meta { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dimmer); }
.detail-meta .agent-fg { color: var(--agent); }
.prose { font-size: 13px; line-height: 1.65; max-width: 70ch; text-wrap: pretty; color: var(--fg); }
.code-card { border: 1px solid var(--line); border-radius: 6px; background: var(--code); overflow: hidden; }
.code-head { display: flex; justify-content: space-between; padding: 7px 12px; background: var(--bg2); font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dim); }
.code-body { padding: 10px 12px; font-family: var(--font-mono); font-size: 12px; line-height: 1.75; white-space: pre-wrap; color: var(--fg); }
.sugg-head { padding: 7px 12px; background: var(--bg2); font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dim); }
.sugg-del { background: var(--del-bg); color: var(--del-fg); padding: 4px 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; }
.sugg-add { background: var(--add-bg); color: var(--add-fg); padding: 4px 12px; font-family: var(--font-mono); font-size: 12px; white-space: pre-wrap; }
.presets { display: flex; flex-wrap: wrap; gap: 8px; }
.preset:hover { border-color: var(--agent); }
.thread-entry { border-left: 2px solid var(--agent); background: var(--agent-f); padding: 10px 14px; }
.thread-label { font-size: 9.5px; text-transform: uppercase; letter-spacing: .07em; color: var(--agent); margin-bottom: 4px; font-family: var(--font-mono); }
.thread-text { font-size: 12.5px; line-height: 1.6; color: var(--fg); }
.cross-card { border: 1px solid var(--agent-b); border-left: 3px solid var(--agent); border-radius: 6px; background: var(--agent-f); overflow: hidden; }
.cross-head { padding: 8px 12px; color: var(--agent); font: 600 10px/1.2 var(--font-mono); text-transform: uppercase; }
.cross-side { display: grid; grid-template-columns: 90px 190px minmax(0,1fr) auto; gap: 8px; padding: 7px 12px; border-top: 1px solid var(--agent-b); font-size: 11.5px; align-items: baseline; }
.cross-repo { color: var(--agent); font-family: var(--font-mono); }
.cross-location { color: var(--fg); font-family: var(--font-mono); }
.cross-role { color: var(--fg-dimmer); }
.cross-target { border: 1px solid var(--agent-b); border-radius: 10px; background: none; color: var(--agent); font: 10px/1 var(--font-ui); padding: 3px 8px; cursor: pointer; }
.cross-target:hover { border-color: var(--agent); }
.cross-target-active { white-space: nowrap; }
.cs-note { color: var(--agent); font-size: 11.5px; line-height: 1.5; }
.ask-row { display: flex; gap: 8px; align-items: center; }
.ask-row .prompt { color: var(--fg-dimmer); font-family: var(--font-mono); }
.action-bar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 13px 22px; background: var(--bg2); border-top: 1px solid var(--line); }
.key { opacity: .65; font-family: var(--font-mono); font-size: 10px; margin-left: 6px; }
.bar-count { margin-left: auto; font-size: 11.5px; color: var(--fg-dim); }

.deck { max-width: 720px; margin: 24px auto 120px; padding: 0 20px; }
.pips { display: flex; gap: 4px; margin-bottom: 10px; }
.pip { width: 16px; height: 4px; border-radius: 2px; background: var(--line2); border: none; padding: 0; cursor: pointer; }
.pip.acc { background: var(--ok); } .pip.rej { background: var(--sev-blocker); } .pip.skp { background: var(--fg-dimmer); } .pip.cur { background: var(--fg-hi); }
.peek { height: 16px; background: var(--bg3); border-radius: 8px 8px 0 0; margin: 0 14px; }
.qcard { background: var(--card); border: 1px solid var(--line2); border-radius: 8px; padding: 20px 22px; display: flex; flex-direction: column; gap: 12px; animation: tin .18s ease-out; }
.qtitle { font-size: 18px; font-weight: 600; color: var(--fg-max); }
.qrow { display: flex; gap: 8px; align-items: center; }
.deck-actions { display: flex; gap: 10px; margin-top: 14px; }
.deck-actions .grow { flex: 1; }
.deck-foot { display: flex; justify-content: space-between; margin-top: 12px; font-size: 11.5px; color: var(--fg-dim); }

.diff-wrap { max-width: 1040px; margin: 0 auto 100px; padding: 20px 30px; }
.diff-file-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; background: var(--bg2); border: 1px solid var(--line); border-radius: 6px 6px 0 0; }
.diff-file-path { color: var(--fg-hi); font: 500 11.5px/1.3 var(--font-mono); }
.diff-file-count { margin-left: auto; color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); }
.diff-nav { border: 0; background: none; color: var(--fg-dim); cursor: pointer; }
.diff-code { border: 1px solid var(--line); border-top: 0; background: var(--code); overflow: hidden; }
.diff-line { display: grid; grid-template-columns: 56px 22px minmax(0,1fr); min-height: 24px; font: 12.5px/1.9 var(--font-mono); }
.diff-line.add { background: var(--add-bg); color: var(--add-fg); }
.diff-line.del { background: var(--del-bg); color: var(--del-fg); }
.diff-line.diff-flagged { border-left: 2px solid var(--item-sev); background: var(--del-bg); }
.diff-gutter { padding-right: 9px; color: var(--gutter); text-align: right; user-select: none; }
.diff-prefix { color: var(--gutter); text-align: center; user-select: none; }
.diff-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.peek-widget { margin: 8px 40px 8px 56px; border: 1px solid var(--line2); border-radius: 6px; background: var(--card); animation: tin .18s ease-out; overflow: hidden; }
.peek-head { display: flex; align-items: center; gap: 8px; border-left: 3px solid var(--item-sev); padding: 9px 12px; background: var(--bg2); }
.peek-title { min-width: 0; color: var(--fg-hi); font-size: 12.5px; font-weight: 600; }
.peek-count { margin-left: auto; color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); }
.peek-body { display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; }
.peek-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ask-link { margin-left: auto; color: var(--agent); }

.clean-col { max-width: 660px; margin: 0 auto; padding: 40px 30px; display: flex; flex-direction: column; gap: 18px; text-align: center; }
.ok-circle { width: 44px; height: 44px; border-radius: 50%; background: var(--ok-strong-t); color: var(--ok); display: flex; align-items: center; justify-content: center; font-size: 18px; margin: 0 auto; }
.filtered { text-align: left; }
.filtered .bucket { display: flex; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--row); font-size: 12.5px; }
.filtered .why { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dimmer); }
.self-note { border: 1px dashed var(--line2); border-radius: 6px; padding: 12px 14px; font-size: 12px; line-height: 1.6; color: var(--fg-dim); }

.tally-blocks { display: flex; gap: 10px; }
.tally { flex: 1; border-radius: 6px; padding: 12px 14px; text-align: center; font-size: 12px; }
.tally b { display: block; font-family: var(--font-mono); font-size: 22px; font-weight: 600; }
.tally-acc { background: var(--ok-strong); color: #fff; }
.tally-rej { background: var(--line); border: 1px solid var(--sev-blocker); color: var(--sev-blocker); }
.tally-skip { background: var(--line); border: 1px solid var(--line2); color: var(--fg-dim); }
.sum-card-head { display: flex; justify-content: space-between; padding: 9px 14px; background: var(--bg2); border-bottom: 1px solid var(--line); font-size: 11px; color: var(--fg-dim); }
textarea.summary { width: 100%; min-height: 96px; border: none; background: var(--card); color: var(--fg); font-size: 12.5px; line-height: 1.7; padding: 12px 14px; resize: vertical; outline: none; font-family: var(--font-ui); }
.comment-row { display: grid; grid-template-columns: 20px 148px minmax(0,1fr) 90px; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--row); font-size: 12px; align-items: center; }
.comment-loc { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dim); }
.comment-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sugg-mark { color: var(--agent); font-family: var(--font-mono); font-size: 10.5px; text-align: right; }
.rejected-row { color: var(--fg-dimmer); font-size: 12px; padding: 7px 14px; border-bottom: 1px solid var(--row); }
.empty-comments { border: 1px dashed var(--line2); border-radius: 6px; padding: 18px; text-align: center; font-size: 12px; color: var(--fg-dimmer); }
.options-row { display: flex; gap: 20px; font-size: 12px; color: var(--fg); align-items: center; flex-wrap: wrap; }
.options-row .opt-off { color: var(--fg-dimmer); }
.options-row .opt-why { font-size: 11px; color: var(--fg-dimmer); }
.submit-fail { border: 1px solid var(--sev-blocker-b); border-left: 3px solid var(--sev-blocker); background: var(--card); border-radius: 6px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.actions-row { display: flex; gap: 10px; align-items: center; }
/* Was style="justify-content:center" on the clean screen's row, which the page
   CSP silently dropped — a nonce authorises <style>, never a style attribute (#45). */
.actions-center { justify-content: center; }
.posts-as { margin-left: auto; font-size: 11px; color: var(--fg-dimmer); }

.done-col { max-width: 560px; margin: 80px auto; text-align: center; display: flex; flex-direction: column; gap: 16px; }
`;

function sevChip(severity: Severity): string {
  return `<span class="sev sev-${severity}">${severity}</span>`;
}

function catPill(category: Category): string {
  return `<span class="pill" style="color:${CATEGORY_COLOR[category]};background:color-mix(in srgb, ${CATEGORY_COLOR[category]} 13%, transparent)">${e(ALL_CATEGORY_LABELS[category])}</span>`;
}

function subline(h: FlowHeaderInfo): string {
  return `<div class="subline">${e(h.refLabel)} · ${e(h.projectPath)} · ${e(h.branch)} · ${h.fileCount} files, +${h.added} −${h.removed}</div>`;
}

// ---- §3 Run review ---------------------------------------------------------

/** The origin badge on a picker row — where this agent came from. */
function agentOrigin(a: AgentDescriptor): string {
  if (a.source === 'builtin') return 'built-in';
  if (a.source === 'demo') return 'demo';
  return a.origin ?? a.source;
}

function agentPicker(s: FlowViewState, agent: AgentDescriptor | undefined): string {
  return `<div class="agent-select">
      <div class="picker-label">Agent</div>
      <button class="agent-row" id="agent-toggle">
        <span class="agent-dot"></span>
        <span class="agent-name">${e(agent?.label ?? 'Select an agent')}</span>
        <span class="agent-badge">${e(agentOrigin(agent ?? BUILTIN_FALLBACK))}</span>
        <span class="agent-caret">${s.agentOpen ? '▲' : '▼'}</span>
      </button>
      ${
        s.agentOpen
          ? `<div class="agent-menu">
        <div class="agent-menu-head">Agents</div>
        ${s.agents
          .map(
            (a) => `<div class="agent-option ${a.id === s.agentId ? 'active' : ''}" data-agent="${e(a.id)}">
            <span>${a.id === s.agentId ? '✓' : '&nbsp;'}</span>
            <span class="agent-name">${e(a.label)}</span>
            <span class="desc">${e(a.description)}</span>
            <span class="agent-origin">${e(agentOrigin(a))}</span>
          </div>`,
          )
          .join('')}
        <div class="agent-menu-foot">Agents are <code>*.agent.md</code> files — add more locations in Settings.</div>
      </div>`
          : ''
      }
      <div class="agent-sub">${e(agent?.description ?? '')}${s.acceptRate !== undefined ? `<a href="#" id="tuning-link">${s.acceptRate}% accepted in this pod →</a>` : ''}</div>
    </div>`;
}

/**
 * The model half. Hidden behaviour differs from the agent picker in two ways
 * the spec calls for: the demo agent neutralises it (it calls no model), and
 * an empty model list states why rather than offering an empty menu.
 */
function modelPicker(s: FlowViewState, agent: AgentDescriptor | undefined): string {
  if (agent?.source === 'demo') {
    return `<div class="agent-select">
      <div class="picker-label">Model</div>
      <button class="agent-row inert" id="model-inert" disabled>
        <span class="agent-name">Not used by this agent</span>
        <span class="agent-origin">the demo agent generates findings from the diff</span>
      </button>
    </div>`;
  }
  if (s.models.length === 0) {
    return `<div class="agent-select">
      <div class="picker-label">Model</div>
      <button class="agent-row inert" id="model-inert" disabled>
        <span class="agent-name">No model available</span>
        <span class="agent-origin">sign in to Copilot, or pick the demo agent</span>
      </button>
    </div>`;
  }
  const model = s.models.find((m) => m.id === s.modelId) ?? s.models[0];
  return `<div class="agent-select">
      <div class="picker-label">Model</div>
      <button class="agent-row" id="model-toggle">
        <span class="agent-name">${e(model?.label ?? 'Select a model')}</span>
        <span class="agent-badge">copilot</span>
        <span class="agent-caret">${s.modelOpen ? '▲' : '▼'}</span>
      </button>
      ${
        s.modelOpen
          ? `<div class="agent-menu">
        <div class="agent-menu-head">Copilot models in this workspace</div>
        ${s.models
          .map(
            (m) => `<div class="agent-option ${m.id === s.modelId ? 'active' : ''}" data-model="${e(m.id)}">
            <span>${m.id === s.modelId ? '✓' : '&nbsp;'}</span>
            <span class="agent-name">${e(m.label)}</span>
            <span class="desc">${e(m.description)}</span>
          </div>`,
          )
          .join('')}
      </div>`
          : ''
      }
    </div>`;
}

/** Only reached when `s.agents` is somehow empty; keeps `agentOrigin` total. */
const BUILTIN_FALLBACK: AgentDescriptor = {
  id: '', label: '', description: '', source: 'builtin', instructions: '',
};

function renderRunReview(s: FlowViewState): string {
  const agent = s.agents.find((a) => a.id === s.agentId) ?? s.agents[0];
  const needsModel = agent !== undefined && agent.source !== 'demo';
  const runBlocked = needsModel && s.models.length === 0;
  const catHint = (() => {
    const on = s.criteria.categories;
    if (on.length === 0) return 'Pick at least one category — the agent has nothing to look for.';
    const first = ALL_CATEGORY_LABELS[on[0] as Category];
    const last = ALL_CATEGORY_LABELS[on[on.length - 1] as Category];
    return `${on.length} categories active — from ${first} to ${last}.`;
  })();

  return `<div class="wrap">
    ${subline(s.header)}
    ${
      s.memberOfChangeset
        ? `<div class="cs-note">⧉ Part of ${e(s.memberOfChangeset.name)} · ${s.memberOfChangeset.memberCount} ${e(s.vocabulary.changeRequestAbbrev)}s ship together — <a href="#" id="open-changeset" data-changeset="${e(s.memberOfChangeset.id)}">open the changeset</a></div>`
        : ''
    }
    <div>
      <h1>Run an AI review</h1>
      <p class="lede">The agent is what to look for; the model is what runs it. Criteria are saved per ${e(s.vocabulary.repoNoun)} and follow every run.</p>
    </div>
    ${
      s.selectionNotices.length > 0
        ? `<div class="notice"><span>${s.selectionNotices.map((n) => e(n)).join(' ')}</span><button class="dismiss" id="dismiss-notices">Dismiss</button></div>`
        : ''
    }
    ${
      s.skippedAgents.length > 0
        ? `<div class="notice"><span>${s.skippedAgents.length} agent ${s.skippedAgents.length === 1 ? 'file was' : 'files were'} skipped because ${s.skippedAgents.length === 1 ? 'it could' : 'they could'} not be read.</span><button class="dismiss" id="show-skipped">Show which</button></div>`
        : ''
    }
    <div class="picker-stack">
      ${agentPicker(s, agent)}
      ${modelPicker(s, agent)}
    </div>
    <div class="crit-grid">
      <div>
        <div class="crit-label">Report at or above</div>
        <div class="floor" id="floor">
          ${SEVERITIES.map((sev) => `<button data-floor="${sev}" class="${s.criteria.severityFloor === sev ? 'active' : ''}">${sev}</button>`).join('')}
        </div>
        <div class="hint">${e(FLOOR_HINTS[s.criteria.severityFloor])}</div>
      </div>
      <div>
        <div class="crit-label">Minimum confidence · <span id="conf-val">${s.criteria.minConfidence}%</span></div>
        <input type="range" id="conf" min="0" max="100" step="5" value="${s.criteria.minConfidence}">
      </div>
    </div>
    <div>
      <div class="crit-label">Categories</div>
      <div class="cats" id="cats">
        ${(Object.keys(ALL_CATEGORY_LABELS) as Category[])
          .map((c) => {
            const on = s.criteria.categories.includes(c);
            const style = on
              ? `style="color:${CATEGORY_COLOR[c]};background:color-mix(in srgb, ${CATEGORY_COLOR[c]} 13%, transparent);border-color:transparent"`
              : '';
            return `<button class="cat" data-cat="${c}" ${style}>${e(ALL_CATEGORY_LABELS[c])}${on ? ' ✓' : ''}</button>`;
          })
          .join('')}
      </div>
      <div class="hint">${e(catHint)}</div>
    </div>
    <div>
      <div class="crit-label">Extra instructions</div>
      <textarea class="extra" id="extra" placeholder="Terse. No praise. Cite the rule or CVE class.">${e(s.criteria.extraInstructions)}</textarea>
    </div>
    <div class="footer-row">
      <button class="btn btn-brand" id="run"${runBlocked ? ' disabled' : ''}>Run review</button>
      <button class="btn" id="cancel">Cancel</button>
      <span class="footer-hint">${
        runBlocked
          ? e(`${agent?.label ?? 'This agent'} needs a Copilot model, and none is available.`)
          : `${s.header.fileCount} files, +${s.header.added} −${s.header.removed} go to the agent — never the whole repo.`
      }</span>
    </div>
  </div>`;
}

// ---- §4 Running -------------------------------------------------------------

function renderSubmitting(s: FlowViewState): string {
  const p = s.submitProgress;
  const total = p?.total ?? 0;
  // The verdict and summary are single requests with nothing to count, so the
  // bar only tracks comments; it holds at full while the last two go out.
  const pct = p?.stage === 'comments' && total > 0
    ? Math.round((p.posted / total) * 100)
    : total > 0 ? 100 : 0;
  const line = p === undefined
    ? 'Starting…'
    : p.stage === 'comments'
      ? `Posting ${p.posted} of ${total} inline ${total === 1 ? 'comment' : 'comments'}…`
      : p.stage === 'summary'
        ? 'Posting the summary…'
        : 'Applying the verdict…';
  return `<div class="run-col">
    <div class="spinner"></div>
    <div class="agent-name">Submitting your review</div>
    <div class="dim">${pct}%</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    <div class="runlog"><div class="now">· ${e(line)}</div></div>
    <div class="dim">Leave this open — closing it will not stop what has already been posted.</div>
  </div>`;
}

/** `m:ss`. The page's own ticker in SCRIPT repeats this format — the two must agree. */
function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The counters as one line. Exported because the panel pushes this same
 * string into the page between renders (`run:progress`, so a fast model does
 * not rebuild `#flow-body` many times a second) — a second formatter over
 * there would eventually describe the same run differently.
 */
export function runOutputSummary(fragmentsReceived: number, charsReceived: number): string {
  if (fragmentsReceived === 0) return 'waiting for the first output';
  const chars = String(charsReceived).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${fragmentsReceived} ${fragmentsReceived === 1 ? 'fragment' : 'fragments'} · ${chars} characters`;
}

/**
 * `startedAt` rides in the markup so the clock keeps ticking between
 * fragments: a model that streams once a minute would otherwise freeze the
 * number for 60s at a time, which is exactly what read as a hung run.
 */
function runLiveness(live: RunLivenessView | undefined): string {
  if (!live) return '';
  return `<div class="run-live">
      <span><b id="run-elapsed" data-started="${live.startedAt}">${e(elapsedClock(live.elapsedMs))}</b> elapsed</span>
      <span class="sep">·</span>
      <span id="run-output">${e(runOutputSummary(live.fragmentsReceived, live.charsReceived))}</span>
    </div>`;
}

function renderRunning(s: FlowViewState): string {
  const agent = s.agents.find((a) => a.id === s.agentId);
  const pct = Math.round((Math.min(s.runStep, s.runSteps.length) / Math.max(1, s.runSteps.length)) * 100);
  if (s.runError) {
    return `<div class="run-col">
      <div class="fail-card">
        <div class="fail-title">Agent stopped · ${e(s.runError.message)}</div>
        <div>The run did not complete. ${s.runError.partialCount > 0 ? `${s.runError.partialCount} findings arrived before it stopped.` : 'No findings arrived before it stopped.'}</div>
        <div class="actions-row">
          ${s.runError.partialCount > 0 ? `<button class="btn btn-accent" id="use-partial">Use ${s.runError.partialCount} partial findings</button>` : ''}
          <button class="btn" id="retry-run">Retry</button>
          <button class="btn" id="switch-agent">Switch to Fast Diff Review</button>
        </div>
        <div class="fail-meta">${e(s.runError.code)} · request id ${e(s.runError.requestId)}</div>
      </div>
    </div>`;
  }
  return `<div class="run-col">
    <div class="spinner"></div>
    <div class="agent-name">${e(agent?.label ?? '')}</div>
    <div class="dim">${pct}%</div>
    <div class="progress"><div style="width:${pct}%"></div></div>
    ${runLiveness(s.runLive)}
    <div class="runlog">
      ${s.runSteps
        .map((step, i) =>
          i < s.runStep
            ? `<div class="done">✓ ${e(step)}</div>`
            : i === s.runStep
              ? `<div class="now">· ${e(step)}</div>`
              : `<div class="done" style="opacity:.4">${e(step)}</div>`,
        )
        .join('')}
    </div>
  </div>`;
}

// ---- §5 Triage ---------------------------------------------------------------

function triageHeader(s: FlowViewState): string {
  const bySev = (sev: Severity) => s.items.filter((i) => i.item.severity === sev).length;
  const tallies = (['blocker', 'major', 'minor', 'nit'] as Severity[])
    .filter((sev) => bySev(sev) > 0)
    .map((sev) => `<span class="sev sev-${sev}">${bySev(sev)} ${sev}</span>`)
    .join('');
  const scope = s.changeset
    ? `<div class="changeset-scope"><span class="glyph">⧉</span><span><strong>Reviewing ${e(s.changeset.name)} · ${s.changeset.memberCount} ${e(s.vocabulary.changeRequestAbbrev)}s</strong> · findings are labelled with the repo they land in</span><a href="#" id="review-single">Review this ${e(s.vocabulary.changeRequestAbbrev)} alone</a></div>`
    : '';
  return `${scope}<div class="tri-head">
    <div>
      <div class="tri-title">${e(s.header.title)}</div>
      <div class="tri-meta">${e(s.header.refLabel)} · ${e(s.header.projectPath)}</div>
    </div>
    <div class="tallies">${tallies}</div>
    <div class="seg mode" id="mode">
      <button data-mode="split" class="${s.mode === 'split' ? 'active' : ''}">Split</button>
      <button data-mode="queue" class="${s.mode === 'queue' ? 'active' : ''}">Queue</button>
      <button data-mode="diff" class="${s.mode === 'diff' ? 'active' : ''}">In diff</button>
    </div>
  </div>
  ${s.stale ? staleBanner(s, s.stale) : ''}${reviewContextPanel(s)}`;
}

/**
 * What the change is for, on the screen where the human decides whether to
 * keep each finding. `state.context` carries the very `ReviewContext` values
 * the prompt was assembled from (`app/reviewContext.ts`), so the two cannot
 * disagree: a screen showing more than the agent read, or less, would be
 * describing a review that did not happen.
 *
 * Collapsed by default and height-capped when open, because findings are what
 * this screen is for — a description the length of a design doc would push the
 * selected one under the fold at any editor width.
 */
function reviewContextPanel(s: FlowViewState): string {
  const view = s.context;
  if (!view || view.entries.length === 0) return '';
  const vocabulary = s.vocabulary;
  const linked = view.entries.flatMap((entry) => entry.context.linkedItems);
  const linkSummary =
    linked.length === 0
      ? `no ${vocabulary.workItemNoun} linked`
      : `${linked.length} ${linked.length === 1 ? vocabulary.workItemNoun : vocabulary.workItemNounPlural} linked`;
  // In changeset scope the count of blocks is what the row has to say; a
  // single review has one block, so it can say whether that block has prose.
  const scopeSummary =
    view.entries.length === 1
      ? view.entries[0]?.context.description
        ? `${cap(vocabulary.changeRequestNoun)} description`
        : `no ${vocabulary.changeRequestNoun} description`
      : countOf(vocabulary, view.entries.length);

  const linkedItem = (item: LinkedWorkItem): string => {
    if (!item.resolved) {
      // Both providers list open items only, so a closed one lands here too —
      // the reference is genuinely all the agent got.
      return `<div class="ctx-item"><div class="ctx-item-head">#${e(item.number)}</div>
        <div class="ctx-none">The agent was given this reference only — the ${e(vocabulary.workItemNoun)} itself could not be read.</div></div>`;
    }
    const body = item.description
      ? `<div class="ctx-text">${e(item.description)}</div>`
      : `<div class="ctx-none">This ${e(vocabulary.workItemNoun)} has no description.</div>`;
    // Joined from what is there: `resolved` guarantees the number alone.
    const head = [`#${e(item.number)}`, item.state ? e(item.state) : '', item.title ? e(item.title) : '']
      .filter((part) => part !== '')
      .join(' · ');
    return `<div class="ctx-item"><div class="ctx-item-head">${head}</div>${body}</div>`;
  };

  const block = (entry: ReviewContextEntry): string => {
    const { context, label } = entry;
    const description = context.description
      ? `<div class="ctx-text">${e(context.description)}</div>`
      : `<div class="ctx-none">No description on this ${e(vocabulary.changeRequestNoun)} — the agent was given the title alone.</div>`;
    const items =
      context.linkedItems.length === 0
        ? `<div class="ctx-none">No ${e(vocabulary.workItemNoun)} is linked from the description — the agent was given this ${e(vocabulary.changeRequestNoun)} alone.</div>`
        : context.linkedItems.map(linkedItem).join('');
    return `<div class="ctx-block">
      <div class="ctx-block-head">${label ? `${e(label)} · ` : ''}${e(context.title)}</div>
      ${description}${items}
    </div>`;
  };

  return `<div class="ctx">
    <button class="ctx-head" id="ctx-toggle">
      <span class="ctx-caret">${view.open ? '▾' : '▸'}</span>
      <span class="ctx-label">What ${view.entries.length === 1 ? 'this change is' : 'these changes are'} for</span>
      <span class="ctx-meta">${e(scopeSummary)} · ${e(linkSummary)}</span>
      ${view.truncated ? '<span class="ctx-chip">agent saw a shortened copy</span>' : ''}
    </button>
    ${
      view.open
        ? `<div class="ctx-body">
      <div class="ctx-note">Handed to the agent ahead of the diffs as intent, not as evidence — a finding still has to point at a line the diff changed.</div>
      ${view.truncated ? '<div class="ctx-cut">The agent was given a shortened copy: some of the text below did not fit its prompt. Judge what it missed against the whole of it.</div>' : ''}
      ${view.entries.map(block).join('')}
    </div>`
        : ''
    }
  </div>`;
}

/**
 * The banner names exactly what moved (spec §5). "N findings" when the anchors
 * really shifted, and a quieter line when the push left every anchor intact —
 * claiming work that is not there would train the reviewer to ignore it.
 */
function staleBanner(s: FlowViewState, stale: NonNullable<FlowViewState['stale']>): string {
  const accepted = stale.affectedAccepted ?? 0;
  const detail =
    stale.affected === 0
      ? `Every finding still sits on the line the agent read — re-run only if the new commits changed the ground under them.`
      : `${stale.affected} ${stale.affected === 1 ? 'finding' : 'findings'}${
          accepted > 0
            ? ` — including ${accepted === 1 ? 'one you accepted' : `${accepted} you accepted`} —`
            : ''
        } no longer ${stale.affected === 1 ? 'sits' : 'sit'} on the ${stale.affected === 1 ? 'line' : 'lines'} the agent read.`;
  return `<div class="stale">⚠ <div class="grow"><b>New commits on ${e(s.header.branch)} while you were reviewing</b>
     ${detail}</div>
     <button class="btn btn-accent" id="reanchor">Re-anchor to HEAD</button>
     <button class="btn" id="rerun">Re-run agent</button></div>`;
}

/** Spec §5: an item whose anchor drifted carries a "line moved" chip. */
function movedChip(view?: TriageItemView): string {
  return view?.lineMoved ? '<span class="pill pill-warn">⚠ line moved</span>' : '';
}

function itemDetail(view: TriageItemView, agentLabel: string, vocabulary: Vocabulary, repoLabels?: Record<string, string>, modelLabel?: string): string {
  const item = view.item;
  const owner = view.projectLabel && view.refLabel ? `<span class="agent-fg">${e(view.projectLabel)} · ${e(view.refLabel)}</span> · ` : '';
  const targetControl = (span: NonNullable<ReviewItem['spans']>[number]): string => {
    const target = view.crossTargets?.find((candidate) => candidate.repoId === span.repoId && candidate.location === span.location);
    if (!target) return '';
    return target.active
      ? '<span class="pill pill-agent cross-target-active">comment posts here</span>'
      : `<button class="cross-target" data-cross-target="${e(item.id)}" data-target-repo="${e(target.repoId)}" data-target-location="${e(target.location)}">post here instead</button>`;
  };
  const cross = item.cross && item.spans?.length
    ? `<div class="cross-card"><div class="cross-head">⧉ spans two repositories</div>${item.spans.map((span) => `<div class="cross-side"><span class="cross-repo">${e(repoLabels?.[span.repoId] ?? span.repoId)}</span><span class="cross-location">${e(span.location)}</span><span class="cross-role">${e(span.role)}</span>${targetControl(span)}</div>`).join('')}</div>`
    : '';
  return `
    <div>${sevChip(item.severity)}${item.cross ? '<span class="pill pill-agent">⧉ cross-repo</span>' : ''}${movedChip(view)}</div>
    <div class="detail-title">${e(item.title)}</div>
    <div class="detail-meta">${owner}${e(item.file)}:${item.line} · ${e(ALL_CATEGORY_LABELS[item.category].toLowerCase())} · confidence ${item.confidence}% · <span class="agent-fg">${e(agentLabel)}</span> · ${e(modelLabel ?? 'model unknown')}</div>
    ${cross}
    <p class="prose">${e(item.body)}</p>
    <div class="code-card">
      <div class="code-head"><span>${e(item.file)}:${item.line}</span><a href="#" id="open-editor" data-file="${e(item.file)}" data-line="${item.line}">Open in editor</a></div>
      <div class="code-body">${e(item.code)}</div>
    </div>
    ${
      item.suggestion
        ? `<div class="code-card">
        <div class="sugg-head">Suggested change · posts as a ${e(vocabulary.platformName)} suggestion</div>
        <div class="sugg-del">- ${e(item.suggestion.old)}</div>
        <div class="sugg-add">+ ${e(item.suggestion.new)}</div>
      </div>`
        : ''
    }
    <div class="presets">
      <button class="chip preset" data-preset="explain">Explain the risk</button>
      <button class="chip preset" data-preset="fix">Show me a fix</button>
      <button class="chip preset" data-preset="similar">Find similar in repo</button>
      <button class="chip preset" data-preset="why">Why flagged?</button>
    </div>
    <div class="thread-list" data-thread-for="${e(view.item.id)}">${view.thread
      .map(
        (t) => `<div class="thread-entry"><div class="thread-label">${e(t.label)}</div><div class="thread-text">${e(t.text)}</div></div>`,
      )
      .join('')}</div>
    <div class="ask-row">
      <span class="prompt">▸</span>
      <input class="input" id="ask" placeholder="Ask the agent about this finding…">
      <span class="kbd">⌘↩</span>
    </div>`;
}

function renderTriageSplit(s: FlowViewState, agentLabel: string): string {
  const selected = s.items.find((v) => v.item.id === s.selectedId) ?? s.items[0];
  const decided = s.items.length - s.counts.undecided;
  const all = s.counts.undecided === 0;
  return `${triageHeader(s)}
  <div class="detail" data-item="${e(selected?.item.id ?? '')}" data-repo-id="${e(selected?.item.repoId ?? '')}" data-cr-number="${e(selected?.item.crNumber ?? '')}">
    ${selected ? itemDetail(selected, agentLabel, s.vocabulary, s.changeset?.repoLabels, s.reviewModelLabel) : '<p class="prose">No review items.</p>'}
  </div>
  <div class="action-bar">
    <button class="btn btn-ok" id="accept">Accept<span class="key">A</span></button>
    <button class="btn btn-danger" id="reject">Reject<span class="key">R</span></button>
    <button class="btn" id="skip">Skip<span class="key">S</span></button>
    <span class="bar-count">${decided} of ${s.items.length} triaged</span>
    <button class="btn ${all ? 'btn-brand' : 'btn-inert'}" id="gen-summary" ${all ? '' : 'disabled'}>Generate summary →</button>
  </div>`;
}

function renderTriageQueue(s: FlowViewState, _agentLabel: string): string {
  const selected = s.items.find((v) => v.item.id === s.selectedId) ?? s.items[0];
  const decided = s.items.length - s.counts.undecided;
  const all = s.counts.undecided === 0;
  const pips = s.items
    .map((v) => {
      const cls =
        v.item.id === selected?.item.id
          ? 'cur'
          : v.verdict === 'accepted'
            ? 'acc'
            : v.verdict === 'rejected'
              ? 'rej'
              : v.verdict === 'skipped'
                ? 'skp'
                : '';
      return `<button class="pip ${cls}" data-select="${e(v.item.id)}" title="${e(v.item.title)}"></button>`;
    })
    .join('');
  return `${triageHeader(s)}
  <div class="deck" data-item="${e(selected?.item.id ?? '')}" data-repo-id="${e(selected?.item.repoId ?? '')}" data-cr-number="${e(selected?.item.crNumber ?? '')}">
    <div class="pips">${pips}</div>
    <div class="peek"></div>
    <div class="qcard">
      ${
        selected
          ? `<div class="qrow">${sevChip(selected.item.severity)}${selected.item.cross ? '<span class="pill pill-agent">⧉ cross-repo</span>' : ''}${catPill(selected.item.category)}${movedChip(selected)}<span class="dim">confidence ${selected.item.confidence}%</span></div>
        <div class="qtitle">${e(selected.item.title)}</div>
        <div class="detail-meta">${selected.projectLabel && selected.refLabel ? `<span class="agent-fg">${e(selected.projectLabel)} · ${e(selected.refLabel)}</span> · ` : ''}${e(selected.item.file)}:${selected.item.line}</div>
        <div class="code-card"><div class="code-body">${e(selected.item.code)}</div></div>
        <p class="prose">${e(selected.item.body)}</p>
        <div class="presets">
          <button class="chip preset" data-preset="explain">Explain the risk</button>
          <button class="chip preset" data-preset="fix">Show me a fix</button>
          <button class="chip preset" data-preset="similar">Find similar in repo</button>
          <button class="chip preset" data-preset="why">Why flagged?</button>
        </div>
        <div class="thread-list" data-thread-for="${e(selected.item.id)}">${selected.thread
          .map(
            (t) => `<div class="thread-entry"><div class="thread-label">${e(t.label)}</div><div class="thread-text">${e(t.text)}</div></div>`,
          )
          .join('')}</div>`
          : ''
      }
    </div>
    <div class="deck-actions">
      <button class="btn btn-danger grow" id="reject">← Reject</button>
      <button class="btn" id="skip">↓ Skip</button>
      <button class="btn btn-ok grow" id="accept">Accept →</button>
    </div>
    <div class="deck-foot">
      <span>${decided} of ${s.items.length} triaged</span>
      <a href="#" id="gen-summary" class="${all ? '' : 'dimmer'}">Generate summary →</a>
    </div>
  </div>`;
}

function renderTriageDiff(s: FlowViewState): string {
  const selected = s.items.find((view) => view.item.id === s.selectedId) ?? s.items[0];
  if (!selected) return `${triageHeader(s)}<div class="detail"><p class="prose">No review items.</p></div>`;
  const itemIndex = Math.max(0, s.items.findIndex((view) => view.item.id === selected.item.id));
  const item = selected.item;
  const severityColor = item.severity === 'nit' ? 'var(--fg-dim)' : `var(--sev-${item.severity})`;
  const suggestion = item.suggestion
    ? `<div class="code-card"><div class="sugg-head">Suggested change · posts as a ${e(s.vocabulary.platformName)} suggestion</div><div class="sugg-del">- ${e(item.suggestion.old)}</div><div class="sugg-add">+ ${e(item.suggestion.new)}</div></div>`
    : '';
  const thread = selected.thread.map((entry) => `<div class="thread-entry"><div class="thread-label">${e(entry.label)}</div><div class="thread-text">${e(entry.text)}</div></div>`).join('');
  const widget = `<div class="peek-widget" data-item="${e(item.id)}" data-repo-id="${e(item.repoId ?? '')}" data-cr-number="${e(item.crNumber ?? '')}" style="--item-sev:${severityColor}">
    <div class="peek-head">${sevChip(item.severity)}${movedChip(selected)}<span class="peek-title">${e(item.title)}</span><span class="peek-count">${item.confidence}% · ${itemIndex + 1} of ${s.items.length}</span></div>
    <div class="peek-body"><p class="prose">${e(item.body)}</p>${suggestion}${thread}
      <div class="peek-actions">
        <button class="btn btn-ok" id="accept">${item.suggestion ? 'Accept &amp; apply' : 'Accept'}</button>
        ${item.suggestion ? '<button class="btn" id="accept-comment">Accept, comment only</button>' : ''}
        <button class="btn btn-danger" id="reject">Reject</button><button class="btn" id="skip">Skip</button>
        <a href="#" class="ask-link preset" data-preset="explain">Ask agent <span class="kbd">⌘↩</span></a>
      </div>
    </div>
  </div>`;
  const lines = (s.diffLines ?? []).map((line) => {
    const lineNumber = line.newLine ?? line.oldLine;
    const flagged = line.newLine === item.line;
    const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
    return `<div class="diff-line ${line.kind} ${flagged ? 'diff-flagged' : ''}" style="--item-sev:${severityColor}"><span class="diff-gutter">${lineNumber ?? ''}</span><span class="diff-prefix">${prefix}</span><span class="diff-text">${e(line.text)}</span></div>${flagged ? widget : ''}`;
  }).join('');
  return `${triageHeader(s)}<div class="diff-wrap">
    <div class="diff-file-head"><span class="diff-file-path">${selected.projectLabel && selected.refLabel ? `${e(selected.projectLabel)} · ${e(selected.refLabel)} · ` : ''}${e(item.file)}</span><span class="diff-file-count">${itemIndex + 1} of ${s.items.length}</span><button class="diff-nav" id="prev-item" title="Previous finding">↑ prev</button><button class="diff-nav" id="next-item" title="Next finding">↓ next</button></div>
    <div class="diff-code">${lines || widget}</div>
  </div>`;
}

// ---- §6 Clean bill -----------------------------------------------------------

/**
 * Why the author's own verdict controls are missing. Neither platform accepts
 * APPROVE or REQUEST_CHANGES from the change request's author — the refusal is
 * terminal and already classified as `verdictRefused` (platform/errors.ts), so
 * offering the control only bought the reviewer a click and an error toast.
 * `verdict` reads into the sentence: "an approval", "a request for changes".
 */
function selfAuthoredNote(s: FlowViewState, verdict: string): string {
  return `You opened this ${e(s.vocabulary.changeRequestNoun)} — ${e(s.vocabulary.platformName)} does not accept ${verdict} from its author.`;
}

function renderClean(s: FlowViewState): string {
  // Two reasons never to offer the approval. The author's own is refused by the
  // platform (see selfAuthoredNote). A changeset spans several change requests,
  // so there is no single one to approve — changesetReview.ts handles 'approve'
  // as 'backToDashboard', meaning the green button approved nothing and quietly
  // navigated away.
  const approvable = !s.selfAuthored && !s.changeset;
  const totalFiltered = s.candidates.reduce((n, c) => n + c.count, 0);
  const bucketLine = (c: CandidateBucket): { label: string; why: string } =>
    c.reason === 'belowSeverityFloor'
      ? {
          label: `${c.count} ${c.severity}s below the severity floor`,
          why: `floor is ${s.criteria.severityFloor} — raise or lower it in Run review`,
        }
      : c.reason === 'belowConfidence'
        ? {
            label: `${c.count} observations below ${s.criteria.minConfidence}% confidence`,
            why: `highest scored ${c.confidence}%`,
          }
        : {
            label: `${c.count} findings in switched-off categories`,
            why: `${c.category} is off in this pod's criteria`,
          };
  return `<div class="clean-col">
    <div class="ok-circle">✓</div>
    <h1>No findings above your criteria</h1>
    <p class="lede">${s.filesRead} files read, ${totalFiltered} candidate observations scored — none cleared the ${s.criteria.severityFloor} floor at ${s.criteria.minConfidence}% confidence.</p>
    ${
      s.candidates.length > 0
        ? `<div class="card filtered">
      <div class="sum-card-head">Filtered out</div>
      ${s.candidates
        .map((c) => {
          const b = bucketLine(c);
          return `<div class="bucket"><span>${e(b.label)}</span><span class="why">${e(b.why)}</span></div>`;
        })
        .join('')}
    </div>`
        : ''
    }
    ${s.selfAuthored ? `<div class="self-note">${selfAuthoredNote(s, 'an approval')}</div>` : ''}
    <div class="actions-row actions-center">
      ${approvable ? `<button class="btn btn-ok" id="approve">Approve ${e(s.vocabulary.changeRequestNoun)}</button>` : ''}
      <button class="btn" id="lower-bar">Lower the bar and re-run</button>
      <button class="btn" id="back-dash">Back to dashboard</button>
    </div>
  </div>`;
}

// ---- §7 Summary ---------------------------------------------------------------

function renderSummary(s: FlowViewState): string {
  const accepted = s.items.filter((v) => v.verdict === 'accepted');
  const rejected = s.items.filter((v) => v.verdict === 'rejected');
  return `<div class="wrap wrap-wide">
    ${subline(s.header)}
    <div>
      <h1>${s.changeset ? `Submit review across ${s.changeset.memberCount} ${e(s.vocabulary.changeRequestNounPlural)}` : `Submit review to ${e(s.vocabulary.platformName)}`}</h1>
      <p class="lede">${s.items.length} findings triaged — ${s.counts.accepted} accepted, ${s.counts.rejected} rejected, ${s.counts.skipped} skipped.</p>
    </div>
    <div class="tally-blocks">
      <div class="tally tally-acc"><b>${s.counts.accepted}</b>accepted</div>
      <div class="tally tally-rej"><b>${s.counts.rejected}</b>rejected</div>
      <div class="tally tally-skip"><b>${s.counts.skipped}</b>skipped</div>
    </div>
    <div class="card">
      <div class="sum-card-head"><span>Summary comment · editable</span><a href="#" id="regenerate">Regenerate</a></div>
      <textarea class="summary" id="summary-text">${e(s.summaryText)}</textarea>
    </div>
    ${s.changeset ? `<div class="cs-note">⧉ Posted to all ${s.changeset.memberCount} ${e(s.vocabulary.changeRequestNounPlural)} in this changeset, each comment landing in the repo it belongs to, cross-linked to ${e(s.changeset.linkedIssue ?? s.changeset.name)}.</div>` : ''}
    <div class="card">
      <div class="sum-card-head"><span>Line comments to post (${s.counts.accepted})</span></div>
      ${
        accepted.length === 0
          ? `<div class="empty-comments">Accepted items become inline comments here — nothing is accepted yet.</div>`
          : accepted
              .map(
                (v) => `<div class="comment-row">
          <span>☑</span>
          <span class="comment-loc">${v.projectLabel ? `${e(v.projectLabel)} · ` : ''}${e(v.item.file.split('/').pop() ?? v.item.file)}:${v.item.line}</span>
          <span class="comment-title">${e(v.item.title)}</span>
          <span class="sugg-mark">${v.applyFix && v.item.suggestion ? '+suggestion' : ''}</span>
        </div>`,
              )
              .join('')
      }
    </div>
    ${
      rejected.length > 0
        ? `<div class="card">
      <div class="sum-card-head"><span>Rejected findings · rationale stays local</span></div>
      ${rejected.map((v) => `<div class="rejected-row">${v.projectLabel ? `${e(v.projectLabel)} · ` : ''}${e(v.item.title)} — false positive</div>`).join('')}
    </div>`
        : ''
    }
    <div>
      <div class="crit-label">Final instructions</div>
      <textarea class="extra" id="final-note" placeholder="Anything the author should know before they read the comments — merge conditions, follow-up issues, what you deliberately did not review.">${e(s.finalNote)}</textarea>
      <div class="presets" style="margin-top:8px">
        <button class="chip" data-note="Merge once both blockers are fixed; the minor items can follow up.">Merge conditions</button>
        <button class="chip" data-note="Scope note: only the changed files were reviewed — the migration path was not.">Scope note</button>
        <button class="chip" data-note="Good change overall — pushing back only on the items above.">Thanks + push back</button>
        <a href="#" id="clear-note" class="dimmer" style="align-self:center;font-size:11px">clear</a>
      </div>
    </div>
    <div class="options-row">
      <label><input type="checkbox" id="opt-thread" ${s.postThread ? 'checked' : ''}> Post as single review thread</label>
      ${
        s.supportsRequestChanges
          // Two different absences. A provider without the capability shows
          // nothing — there is no such verdict to explain. The author of this
          // change request has the verdict but cannot cast it, so the option
          // stays visible, off and disabled, carrying the reason.
          ? s.selfAuthored
            ? `<label class="opt-off"><input type="checkbox" id="opt-changes" disabled> Request changes</label><span class="opt-why">${selfAuthoredNote(s, 'a request for changes')}</span>`
            : `<label><input type="checkbox" id="opt-changes" ${s.requestChanges ? 'checked' : ''}> Request changes</label>`
          : ''
      }
    </div>
    ${
      s.submitError
        ? `<div class="submit-fail">
        <div class="fail-title">${e(s.vocabulary.platformName)} rejected the request · ${e(s.submitError)}</div>
        <div class="lede">Nothing is lost — the summary, the ${s.counts.accepted} line comments and your final note are still here.</div>
        <div class="actions-row">
          <button class="btn btn-accent" id="reconnect">Reconnect ${e(s.vocabulary.platformName)}</button>
          <button class="btn" id="retry-submit">Retry submit</button>
        </div>
      </div>`
        : ''
    }
    <div class="actions-row">
      <button class="btn btn-brand" id="submit">${s.changeset ? `Submit across ${s.changeset.memberCount} ${e(s.vocabulary.changeRequestAbbrev)}s` : `Submit to ${e(s.vocabulary.platformName)}`}</button>
      <button class="btn" id="copy-md">Copy as markdown</button>
      <button class="btn" id="back-triage">Back to triage</button>
      <span class="posts-as">posts as @${e(s.username)}</span>
    </div>
  </div>`;
}

// ---- §8 Submitted --------------------------------------------------------------

function renderDone(s: FlowViewState): string {
  return `<div class="done-col">
    <div class="ok-circle">✓</div>
    <h1>${s.changeset ? `Review submitted across ${s.changeset.memberCount} ${e(s.vocabulary.changeRequestAbbrev)}s` : `Review submitted to ${e(s.header.refLabel)}`}</h1>
    <p class="lede">${e(s.doneSentence)}</p>
    <div class="actions-row" style="justify-content:center">
      <button class="btn btn-accent" id="track-replies">Track replies</button>
      <button class="btn" id="back-dash">Back to dashboard</button>
      <button class="btn" id="open-mr">Open ${e(s.vocabulary.changeRequestAbbrev)} in ${e(s.vocabulary.platformName)}</button>
    </div>
  </div>`;
}

// ---- dispatcher -----------------------------------------------------------------

/**
 * Bound once on \`document\` for the whole page's lifetime, not per element
 * (issue #39): a region patch replaces \`#flow-body\`'s innerHTML wholesale
 * on every screen transition — triage, summary, submitting, and so on all
 * go through the same render() — which would drop any listener bound to an
 * element inside it. Delegation means the patched markup needs no
 * re-binding at all, so \`on()\` below now delegates by id instead of binding
 * to the element directly, and every other per-element \`getElementById\` /
 * \`querySelectorAll(...).forEach\` binding does the same.
 */
const SCRIPT = `
const vscode = window.verdictVscode;
const post = (m) => vscode.postMessage(m);
const on = (id, type, extra) => document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#' + id)) return;
  ev.preventDefault();
  post({ type, ...(extra ?? {}) });
});

on('agent-toggle', 'toggleAgentOpen');
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('.agent-option');
  if (!el) return;
  if (el.dataset.model) post({ type: 'selectModel', modelId: el.dataset.model });
  else if (el.dataset.agent) post({ type: 'selectAgent', agentId: el.dataset.agent });
});
on('model-toggle', 'toggleModelOpen');
on('dismiss-notices', 'dismissNotices');
on('show-skipped', 'showSkippedAgents');
document.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-floor]'); if (b) post({ type: 'setFloor', floor: b.dataset.floor }); });
document.addEventListener('change', (ev) => { if (ev.target.id === 'conf') post({ type: 'setConfidence', value: Number(ev.target.value) }); });
document.addEventListener('input', (ev) => {
  if (ev.target.id !== 'conf') return;
  const el = document.getElementById('conf-val');
  if (el) el.textContent = ev.target.value + '%';
});
document.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-cat]'); if (b) post({ type: 'toggleCategory', category: b.dataset.cat }); });
document.addEventListener('change', (ev) => { if (ev.target.id === 'extra') post({ type: 'setInstructions', text: ev.target.value }); });
on('run', 'run'); on('cancel', 'cancel');
on('use-partial', 'usePartial'); on('retry-run', 'retryRun'); on('switch-agent', 'cancel');
on('retry-load', 'retryLoad');
document.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-mode]'); if (b) post({ type: 'setMode', mode: b.dataset.mode }); });
on('reanchor', 'reanchor'); on('rerun', 'rerun'); on('ctx-toggle', 'toggleReviewContext');

const itemId = () => document.querySelector('[data-item]')?.dataset.item;
const verdict = (v, applyFix) => { const id = itemId(); if (id) post({ type: 'verdict', itemId: id, verdict: v, applyFix }); };
document.addEventListener('click', (ev) => { if (ev.target.closest('#accept')) verdict('accepted', true); });
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#accept-comment')) return;
  const id = itemId();
  if (id) post({ type: 'verdict', itemId: id, verdict: 'accepted', applyFix: false });
});
document.addEventListener('click', (ev) => { if (ev.target.closest('#reject')) verdict('rejected', false); });
document.addEventListener('click', (ev) => { if (ev.target.closest('#skip')) verdict('skipped', false); });
on('prev-item', 'move', { delta: -1 }); on('next-item', 'move', { delta: 1 });
document.addEventListener('click', (ev) => {
  const p = ev.target.closest('.pip[data-select]');
  if (p) post({ type: 'select', itemId: p.dataset.select });
});
document.addEventListener('click', (ev) => {
  const p = ev.target.closest('.preset');
  if (!p) return;
  const id = itemId();
  if (id) post({ type: 'ask', itemId: id, preset: p.dataset.preset });
});
// The running screen ticks its own clock. Driving it from the host would only
// move the number when a fragment lands, and the gap between two fragments is
// precisely when a frozen screen reads as a dead run. Format must match
// elapsedClock() above; the guard is that neither element exists off the
// running screen.
setInterval(() => {
  const el = document.getElementById('run-elapsed');
  const started = Number(el && el.dataset.started);
  if (!el || !started) return;
  const total = Math.max(0, Math.floor((Date.now() - started) / 1000));
  el.textContent = Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
}, 1000);
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.type !== 'run:progress') return;
  const el = document.getElementById('run-output');
  // textContent: the counters are host-composed, but this element sits inches
  // from model output and the rest of this page holds the same line.
  if (el) el.textContent = data.summary;
});
// The agent's answer arrives as a message and is patched into place. Rendering
// the whole document instead would rebuild the ask box mid-question: focus
// falls back to <body>, and A/R/S then land on the triage handler as verdicts.
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.type !== 'verdict:thread') return;
  // CSS.escape, not a hand-rolled strip: item ids come straight from the
  // agent's JSON. Stripping quotes changed the value, so an id containing one
  // stopped matching its own element, and an id ending in a backslash escaped
  // the closing quote and made querySelector throw — killing the very handler
  // that delivers the answer.
  const host = document.querySelector('[data-thread-for="' + CSS.escape(String(data.itemId)) + '"]');
  if (!host) return;
  host.replaceChildren(...(data.thread || []).map((t) => {
    const entry = document.createElement('div');
    entry.className = 'thread-entry';
    const label = document.createElement('div');
    label.className = 'thread-label';
    label.textContent = t.label;
    const text = document.createElement('div');
    text.className = 'thread-text';
    // textContent, not innerHTML: this is model output.
    text.textContent = t.text;
    entry.append(label, text);
    return entry;
  }));
});
document.addEventListener('keydown', (ev) => {
  if (ev.target.id !== 'ask') return;
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { const id = itemId(); if (id && ev.target.value.trim()) { post({ type: 'ask', itemId: id, preset: 'freeform', text: ev.target.value }); ev.target.value = ''; } }
});
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('#open-editor');
  if (!el) return;
  ev.preventDefault();
  post({ type: 'openInEditor', file: el.dataset.file, line: Number(el.dataset.line) });
});
on('gen-summary', 'generateSummary');

document.addEventListener('change', (ev) => { if (ev.target.id === 'summary-text') post({ type: 'editSummary', text: ev.target.value }); });
on('regenerate', 'regenerate');
document.addEventListener('change', (ev) => { if (ev.target.id === 'final-note') post({ type: 'setNote', text: ev.target.value }); });
document.addEventListener('click', (ev) => {
  const c = ev.target.closest('[data-note]');
  if (!c) return;
  const t = document.getElementById('final-note');
  if (t) { t.value = c.dataset.note; post({ type: 'setNote', text: c.dataset.note }); }
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#clear-note')) return;
  ev.preventDefault();
  const t = document.getElementById('final-note');
  if (t) t.value = '';
  post({ type: 'setNote', text: '' });
});
document.addEventListener('change', (ev) => { if (ev.target.id === 'opt-thread') post({ type: 'toggleOption', option: 'postThread' }); });
document.addEventListener('change', (ev) => { if (ev.target.id === 'opt-changes') post({ type: 'toggleOption', option: 'requestChanges' }); });
on('submit', 'submit'); on('retry-submit', 'retrySubmit'); on('reconnect', 'reconnect'); on('back-triage', 'backToTriage'); on('copy-md', 'copyMarkdown');
on('approve', 'approve'); on('lower-bar', 'lowerBar'); on('back-dash', 'backToDashboard');
on('track-replies', 'trackReplies'); on('open-mr', 'openMr'); on('tuning-link', 'openTuning');
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#review-single')) return;
  ev.preventDefault();
  const el = document.querySelector('[data-item]');
  if (el) post({ type: 'reviewSingle', repoId: el.dataset.repoId, number: el.dataset.crNumber });
});
document.addEventListener('click', (ev) => {
  const el = ev.target.closest('#open-changeset');
  if (!el) return;
  ev.preventDefault();
  post({ type: 'openChangeset', changesetId: el.dataset.changeset });
});
document.addEventListener('click', (ev) => {
  const b = ev.target.closest('[data-cross-target]');
  if (b) post({ type: 'setCrossTarget', itemId: b.dataset.crossTarget, repoId: b.dataset.targetRepo, location: b.dataset.targetLocation });
});

// Keyboard (spec §12 Triage group) — active while the review tab has focus.
document.addEventListener('keydown', (ev) => {
  if (ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement) return;
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return; // never hijack Cmd/Ctrl chords
  const map = { a: () => verdict('accepted', !ev.shiftKey ? true : false), r: () => verdict('rejected', false), s: () => verdict('skipped', false), j: () => post({ type: 'move', delta: 1 }), k: () => post({ type: 'move', delta: -1 }), u: () => { const id = itemId(); if (id) post({ type: 'undo', itemId: id }); } };
  const jump = { '1': 'blocker', '2': 'major', '3': 'minor', '4': 'nit' };
  const key = ev.key.toLowerCase();
  if (map[key]) { ev.preventDefault(); map[key](); }
  else if (jump[ev.key]) { ev.preventDefault(); post({ type: 'jumpSeverity', severity: jump[ev.key] }); }
});
`;

/**
 * The screen-dependent part of the page (issue #39), shared by the full page
 * and the region patch — one source of markup, no duplication. Wrapped by
 * both in the same `id="flow-body"` container.
 */
export function renderReviewFlowBody(s: FlowViewState, agentLabel: string): string {
  return s.screen === 'agent'
    ? renderRunReview(s)
    : s.screen === 'running'
      ? renderRunning(s)
      : s.screen === 'submitting'
        ? renderSubmitting(s)
        : s.screen === 'triage'
          ? s.mode === 'queue'
            ? renderTriageQueue(s, agentLabel)
            : s.mode === 'diff'
              ? renderTriageDiff(s)
              : renderTriageSplit(s, agentLabel)
          : s.screen === 'clean'
            ? renderClean(s)
            : s.screen === 'summary'
              ? renderSummary(s)
              : renderDone(s);
}

/** The breadcrumb's current-crumb text — shared so the region patch can update it without a full page's worth of markup. */
export function reviewFlowCrumb(s: Pick<FlowViewState, 'changeset' | 'header'>): string {
  return s.changeset ? s.changeset.name : `${s.header.refLabel} · ${s.header.title}`;
}

function reviewFlowTitle(s: FlowViewState): string {
  return s.changeset && s.screen !== 'done'
    ? `Verdict: Review · ${s.changeset.memberCount} ${s.vocabulary.changeRequestAbbrev}s`
    : s.screen === 'agent'
      ? `Verdict: Run review · ${s.header.refLabel}`
      : s.screen === 'done'
        ? `Verdict: Posted · ${s.header.refLabel}`
        : `Verdict: Review · ${s.header.refLabel}`;
}

export function renderReviewFlowHtml(s: FlowViewState, agentLabel: string, nonce: string): string {
  const body = `<div id="flow-body">${renderReviewFlowBody(s, agentLabel)}</div>`;
  return renderPage({
    title: reviewFlowTitle(s),
    nonce,
    css: CSS,
    body,
    script: SCRIPT,
    breadcrumb: { current: reviewFlowCrumb(s) },
  });
}

/**
 * First paint on navigation, before the fetch (issue #39): only `refLabel`
 * and `projectPath` are known synchronously — `this.cr` is not yet assigned,
 * so a full `FlowViewState` cannot be constructed. Wrapped in the same
 * `id="flow-body"` container so the data patch that lands later can replace
 * it wholesale, and ships the same script so delegated listeners are already
 * armed by the time that patch arrives.
 */
export function renderReviewFlowLoadingHtml(header: { refLabel: string; projectPath: string }, nonce: string): string {
  const body = `<div id="flow-body"><div class="wrap">
    <div class="subline">${e(header.refLabel)} · ${e(header.projectPath)}</div>
    <div class="run-col">
      <div class="spinner"></div>
      <div class="skel skel-title"></div>
      <div class="skel skel-meta"></div>
    </div>
  </div></div>`;
  return renderPage({
    title: `Verdict: Run review · ${header.refLabel}`,
    nonce,
    css: CSS,
    body,
    script: SCRIPT,
    breadcrumb: { current: header.refLabel },
  });
}

/**
 * The fetch inside `load()` rejected (issue #39): before this screen existed,
 * a rejection there left the reviewer parked on the loading skeleton
 * forever, with nothing but an extension-host toast to explain it. Reuses
 * the running screen's `.fail-card` styling and the loading page's
 * breadcrumb — its ‹ Dashboard button is wired by `AppSurface` itself, so it
 * works here unchanged — plus a Retry that re-issues the same load.
 */
export function renderReviewFlowErrorHtml(
  header: { refLabel: string; projectPath: string },
  message: string,
  nonce: string,
): string {
  const body = `<div id="flow-body"><div class="wrap">
    <div class="subline">${e(header.refLabel)} · ${e(header.projectPath)}</div>
    <div class="run-col">
      <div class="fail-card">
        <div class="fail-title">Could not load this review</div>
        <div>${e(message)}</div>
        <div class="actions-row">
          <button class="btn btn-accent" id="retry-load">Retry</button>
        </div>
      </div>
    </div>
  </div></div>`;
  return renderPage({
    title: `Verdict: Run review · ${header.refLabel}`,
    nonce,
    css: CSS,
    body,
    script: SCRIPT,
    breadcrumb: { current: header.refLabel },
  });
}
