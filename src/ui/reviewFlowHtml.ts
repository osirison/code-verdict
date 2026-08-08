/**
 * The review-flow screens (spec/README.md §3–§8) as pure renderers:
 * Run review → Running (with the failure card) → Triage (split / queue / in-diff)
 * → Clean bill → Summary (with the submit-failure banner) → Submitted.
 */
import type { CandidateBucket } from '../domain/agentResponse';
import type { Category, Criteria, ReviewItem, Severity, Verdict } from '../domain/types';
import type { AgentDescriptor } from '../app/agents';
import type { HunkLine } from '../domain/diffHunks';
import { escapeHtml as e } from './dashboardHtml';
import { renderPage } from './theme';

export type FlowScreen = 'agent' | 'running' | 'triage' | 'clean' | 'summary' | 'done';

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
}

export interface ChangesetReviewScope {
  id: string;
  name: string;
  linkedIssue: string;
  memberCount: number;
  projectCount: number;
  refs: string[];
  repoLabels?: Record<string, string>;
}

export interface FlowViewState {
  screen: FlowScreen;
  header: FlowHeaderInfo;
  agents: AgentDescriptor[];
  agentId: string;
  agentOpen: boolean;
  criteria: Criteria;
  /** "56% accepted in this pod" — undefined hides the tuning link. */
  acceptRate?: number;
  // running
  runSteps: string[];
  runStep: number;
  runError?: { message: string; requestId: string; partialCount: number; code: string };
  // triage
  mode: 'split' | 'queue' | 'diff';
  items: TriageItemView[];
  selectedId?: string;
  diffLines?: HunkLine[];
  counts: { accepted: number; rejected: number; skipped: number; undecided: number };
  stale?: { newHead: string; affected: number; affectedAccepted?: number };
  changeset?: ChangesetReviewScope;
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
  | { type: 'setFloor'; floor: Severity }
  | { type: 'setConfidence'; value: number }
  | { type: 'toggleCategory'; category: Category }
  | { type: 'setInstructions'; text: string }
  | { type: 'run' }
  | { type: 'cancel' }
  | { type: 'usePartial' }
  | { type: 'retryRun' }
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
  | { type: 'reviewSingle'; repoId: string; number: string };

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
  nit: 'Everything, nits included — noisy on large MRs.',
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
.fail-card { text-align: left; border: 1px solid var(--sev-blocker-b); border-left: 3px solid var(--sev-blocker); background: var(--card); border-radius: 6px; padding: 16px 18px; display: flex; flex-direction: column; gap: 10px; }
.fail-title { font-size: 13.5px; font-weight: 600; color: var(--fg-hi); }
.fail-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }

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
.cross-side { display: grid; grid-template-columns: 90px 190px minmax(0,1fr); gap: 8px; padding: 7px 12px; border-top: 1px solid var(--agent-b); font-size: 11.5px; }
.cross-repo { color: var(--agent); font-family: var(--font-mono); }
.cross-location { color: var(--fg); font-family: var(--font-mono); }
.cross-role { color: var(--fg-dimmer); }
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
.options-row { display: flex; gap: 20px; font-size: 12px; color: var(--fg); }
.submit-fail { border: 1px solid var(--sev-blocker-b); border-left: 3px solid var(--sev-blocker); background: var(--card); border-radius: 6px; padding: 14px 16px; display: flex; flex-direction: column; gap: 8px; }
.actions-row { display: flex; gap: 10px; align-items: center; }
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

function renderRunReview(s: FlowViewState): string {
  const agent = s.agents.find((a) => a.id === s.agentId) ?? s.agents[0];
  const catHint = (() => {
    const on = s.criteria.categories;
    if (on.length === 0) return 'Pick at least one category — the agent has nothing to look for.';
    const first = ALL_CATEGORY_LABELS[on[0] as Category];
    const last = ALL_CATEGORY_LABELS[on[on.length - 1] as Category];
    return `${on.length} categories active — from ${first} to ${last}.`;
  })();

  return `<div class="wrap">
    ${subline(s.header)}
    <div>
      <h1>Run an AI review</h1>
      <p class="lede">Agents come from your Copilot workspace. Criteria are saved per project and follow every run.</p>
    </div>
    <div class="agent-select">
      <button class="agent-row" id="agent-toggle">
        <span class="agent-dot"></span>
        <span class="agent-name">${e(agent?.label ?? 'Select an agent')}</span>
        <span class="agent-badge">${agent?.source === 'demo' ? 'workspace' : 'copilot'}</span>
        <span class="agent-caret">${s.agentOpen ? '▲' : '▼'}</span>
      </button>
      ${
        s.agentOpen
          ? `<div class="agent-menu">
        <div class="agent-menu-head">Copilot agents in this workspace</div>
        ${s.agents
          .map(
            (a) => `<div class="agent-option ${a.id === s.agentId ? 'active' : ''}" data-agent="${e(a.id)}">
            <span>${a.id === s.agentId ? '✓' : '&nbsp;'}</span>
            <span class="agent-name">${e(a.label)}</span>
            <span class="desc">${e(a.description)}</span>
            <span class="agent-badge">${a.source === 'demo' ? 'workspace' : 'copilot'}</span>
          </div>`,
          )
          .join('')}
        <div class="agent-menu-foot">Manage agents in Copilot settings…</div>
      </div>`
          : ''
      }
      <div class="agent-sub">${e(agent?.description ?? '')}${s.acceptRate !== undefined ? `<a href="#" id="tuning-link">${s.acceptRate}% accepted in this pod →</a>` : ''}</div>
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
      <button class="btn btn-brand" id="run">Run review</button>
      <button class="btn" id="cancel">Cancel</button>
      <span class="footer-hint">${s.header.fileCount} files, +${s.header.added} −${s.header.removed} go to the agent — never the whole repo.</span>
    </div>
  </div>`;
}

// ---- §4 Running -------------------------------------------------------------

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
    ? `<div class="changeset-scope"><span class="glyph">⧉</span><span><strong>Reviewing ${e(s.changeset.name)} · ${s.changeset.memberCount} MRs</strong> · findings are labelled with the repo they land in</span><a href="#" id="review-single">Review this MR alone</a></div>`
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
  ${s.stale ? staleBanner(s, s.stale) : ''}`;
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

function itemDetail(view: TriageItemView, agentLabel: string, repoLabels?: Record<string, string>): string {
  const item = view.item;
  const owner = view.projectLabel && view.refLabel ? `<span class="agent-fg">${e(view.projectLabel)} · ${e(view.refLabel)}</span> · ` : '';
  const cross = item.cross && item.spans?.length
    ? `<div class="cross-card"><div class="cross-head">⧉ spans two repositories</div>${item.spans.map((span) => `<div class="cross-side"><span class="cross-repo">${e(repoLabels?.[span.repoId] ?? span.repoId)}</span><span class="cross-location">${e(span.location)}</span><span class="cross-role">${e(span.role)}</span></div>`).join('')}</div>`
    : '';
  return `
    <div>${sevChip(item.severity)}${item.cross ? '<span class="pill pill-agent">⧉ cross-repo</span>' : ''}${movedChip(view)}</div>
    <div class="detail-title">${e(item.title)}</div>
    <div class="detail-meta">${owner}${e(item.file)}:${item.line} · ${e(ALL_CATEGORY_LABELS[item.category].toLowerCase())} · confidence ${item.confidence}% · <span class="agent-fg">${e(agentLabel)}</span></div>
    ${cross}
    <p class="prose">${e(item.body)}</p>
    <div class="code-card">
      <div class="code-head"><span>${e(item.file)}:${item.line}</span><a href="#" id="open-editor" data-file="${e(item.file)}" data-line="${item.line}">Open in editor</a></div>
      <div class="code-body">${e(item.code)}</div>
    </div>
    ${
      item.suggestion
        ? `<div class="code-card">
        <div class="sugg-head">Suggested change · posts as a GitLab suggestion</div>
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
    ${view.thread
      .map(
        (t) => `<div class="thread-entry"><div class="thread-label">${e(t.label)}</div><div class="thread-text">${e(t.text)}</div></div>`,
      )
      .join('')}
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
    ${selected ? itemDetail(selected, agentLabel, s.changeset?.repoLabels) : '<p class="prose">No review items.</p>'}
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
        ${selected.thread
          .map(
            (t) => `<div class="thread-entry"><div class="thread-label">${e(t.label)}</div><div class="thread-text">${e(t.text)}</div></div>`,
          )
          .join('')}`
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
    ? `<div class="code-card"><div class="sugg-head">Suggested change · posts as a GitLab suggestion</div><div class="sugg-del">- ${e(item.suggestion.old)}</div><div class="sugg-add">+ ${e(item.suggestion.new)}</div></div>`
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

function renderClean(s: FlowViewState): string {
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
    <div class="actions-row" style="justify-content:center">
      <button class="btn btn-ok" id="approve">Approve merge request</button>
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
      <h1>${s.changeset ? `Submit review across ${s.changeset.memberCount} merge requests` : 'Submit review to GitLab'}</h1>
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
      ${rejected.map((v) => `<div class="rejected-row">${e(v.item.title)} — false positive</div>`).join('')}
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
          ? `<label><input type="checkbox" id="opt-changes" ${s.requestChanges ? 'checked' : ''}> Request changes</label>`
          : ''
      }
    </div>
    ${s.changeset ? `<div class="hint">Accepted comments route to their owning MR; the summary is posted to every member and cross-linked to ${e(s.changeset.linkedIssue)}.</div>` : ''}
    ${
      s.submitError
        ? `<div class="submit-fail">
        <div class="fail-title">GitLab rejected the request · ${e(s.submitError)}</div>
        <div class="lede">Nothing is lost — the summary, the ${s.counts.accepted} line comments and your final note are still here.</div>
        <div class="actions-row">
          <button class="btn btn-accent" id="reconnect">Reconnect GitLab</button>
          <button class="btn" id="retry-submit">Retry submit</button>
        </div>
      </div>`
        : ''
    }
    <div class="actions-row">
      <button class="btn btn-brand" id="submit">${s.changeset ? `Submit across ${s.changeset.memberCount} MRs` : 'Submit to GitLab'}</button>
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
    <h1>${s.changeset ? `Review submitted across ${s.changeset.memberCount} MRs` : `Review submitted to ${e(s.header.refLabel)}`}</h1>
    <p class="lede">${e(s.doneSentence)}</p>
    <div class="actions-row" style="justify-content:center">
      <button class="btn btn-accent" id="track-replies">Track replies</button>
      <button class="btn" id="back-dash">Back to dashboard</button>
      <button class="btn" id="open-mr">Open MR in GitLab</button>
    </div>
  </div>`;
}

// ---- dispatcher -----------------------------------------------------------------

const SCRIPT = `
const vscode = window.verdictVscode;
const post = (m) => vscode.postMessage(m);
const on = (id, type, extra) => document.getElementById(id)?.addEventListener('click', (ev) => { ev.preventDefault(); post({ type, ...(extra ?? {}) }); });

on('agent-toggle', 'toggleAgentOpen');
document.querySelectorAll('.agent-option').forEach((el) => el.addEventListener('click', () => post({ type: 'selectAgent', agentId: el.dataset.agent })));
document.getElementById('floor')?.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-floor]'); if (b) post({ type: 'setFloor', floor: b.dataset.floor }); });
document.getElementById('conf')?.addEventListener('change', (ev) => post({ type: 'setConfidence', value: Number(ev.target.value) }));
document.getElementById('conf')?.addEventListener('input', (ev) => { const el = document.getElementById('conf-val'); if (el) el.textContent = ev.target.value + '%'; });
document.getElementById('cats')?.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-cat]'); if (b) post({ type: 'toggleCategory', category: b.dataset.cat }); });
document.getElementById('extra')?.addEventListener('change', (ev) => post({ type: 'setInstructions', text: ev.target.value }));
on('run', 'run'); on('cancel', 'cancel');
on('use-partial', 'usePartial'); on('retry-run', 'retryRun'); on('switch-agent', 'cancel');
document.getElementById('mode')?.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-mode]'); if (b) post({ type: 'setMode', mode: b.dataset.mode }); });
on('reanchor', 'reanchor'); on('rerun', 'rerun');

const itemId = () => document.querySelector('[data-item]')?.dataset.item;
const verdict = (v, applyFix) => { const id = itemId(); if (id) post({ type: 'verdict', itemId: id, verdict: v, applyFix }); };
document.getElementById('accept')?.addEventListener('click', () => verdict('accepted', true));
document.getElementById('accept-comment')?.addEventListener('click', () => { const id = itemId(); if (id) post({ type: 'verdict', itemId: id, verdict: 'accepted', applyFix: false }); });
document.getElementById('reject')?.addEventListener('click', () => verdict('rejected', false));
document.getElementById('skip')?.addEventListener('click', () => verdict('skipped', false));
on('prev-item', 'move', { delta: -1 }); on('next-item', 'move', { delta: 1 });
document.querySelectorAll('.pip[data-select]').forEach((p) => p.addEventListener('click', () => post({ type: 'select', itemId: p.dataset.select })));
document.querySelectorAll('.preset').forEach((p) => p.addEventListener('click', () => { const id = itemId(); if (id) post({ type: 'ask', itemId: id, preset: p.dataset.preset }); }));
document.getElementById('ask')?.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { const id = itemId(); if (id && ev.target.value.trim()) { post({ type: 'ask', itemId: id, preset: 'freeform', text: ev.target.value }); ev.target.value = ''; } }
});
document.getElementById('open-editor')?.addEventListener('click', (ev) => { ev.preventDefault(); const el = ev.currentTarget; post({ type: 'openInEditor', file: el.dataset.file, line: Number(el.dataset.line) }); });
on('gen-summary', 'generateSummary');

document.getElementById('summary-text')?.addEventListener('change', (ev) => post({ type: 'editSummary', text: ev.target.value }));
on('regenerate', 'regenerate');
document.getElementById('final-note')?.addEventListener('change', (ev) => post({ type: 'setNote', text: ev.target.value }));
document.querySelectorAll('[data-note]').forEach((c) => c.addEventListener('click', () => { const t = document.getElementById('final-note'); if (t) { t.value = c.dataset.note; post({ type: 'setNote', text: c.dataset.note }); } }));
document.getElementById('clear-note')?.addEventListener('click', (ev) => { ev.preventDefault(); const t = document.getElementById('final-note'); if (t) t.value = ''; post({ type: 'setNote', text: '' }); });
document.getElementById('opt-thread')?.addEventListener('change', () => post({ type: 'toggleOption', option: 'postThread' }));
document.getElementById('opt-changes')?.addEventListener('change', () => post({ type: 'toggleOption', option: 'requestChanges' }));
on('submit', 'submit'); on('retry-submit', 'retrySubmit'); on('reconnect', 'reconnect'); on('back-triage', 'backToTriage'); on('copy-md', 'copyMarkdown');
on('approve', 'approve'); on('lower-bar', 'lowerBar'); on('back-dash', 'backToDashboard');
on('track-replies', 'trackReplies'); on('open-mr', 'openMr'); on('tuning-link', 'openTuning');
document.getElementById('review-single')?.addEventListener('click', (ev) => { ev.preventDefault(); const el = document.querySelector('[data-item]'); if (el) post({ type: 'reviewSingle', repoId: el.dataset.repoId, number: el.dataset.crNumber }); });

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

export function renderReviewFlowHtml(s: FlowViewState, agentLabel: string, nonce: string): string {
  const body =
    s.screen === 'agent'
      ? renderRunReview(s)
      : s.screen === 'running'
        ? renderRunning(s)
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
  const title =
    s.changeset && s.screen !== 'done'
      ? `Verdict: Review · ${s.changeset.memberCount} MRs`
      : s.screen === 'agent'
      ? `Verdict: Run review · ${s.header.refLabel}`
      : s.screen === 'done'
        ? `Verdict: Posted · ${s.header.refLabel}`
        : `Verdict: Review · ${s.header.refLabel}`;
  return renderPage({
    title,
    nonce,
    css: CSS,
    body,
    script: SCRIPT,
    breadcrumb: { current: s.changeset ? s.changeset.name : `${s.header.refLabel} · ${s.header.title}` },
  });
}
