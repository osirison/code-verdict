import { renderPage, escapeHtml, type CodiconAssets } from './theme';

/**
 * Chrome icons are codicons (issue #6). Glyphs the spec names in prose —
 * the ✓/✕/⤼ verdicts, the ▾ file caret, ⚠, and the ○/✓ setup marks — stay as
 * written characters: they are content the spec dictates, not chrome.
 */
function icon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

export interface SidebarPod {
  id: string;
  name: string;
  meta: string;
  active: boolean;
}

export interface SidebarMergeRequest {
  repoId: string;
  number: string;
  label: string;
  title: string;
  project: string;
  waiting: boolean;
}

export interface SidebarIssue {
  label: string;
  title: string;
  project: string;
}

export interface SidebarReviewItem {
  id: string;
  title: string;
  file: string;
  severity: 'blocker' | 'major' | 'minor' | 'nit';
  category?: string;
  confidence?: number;
  verdict?: 'accepted' | 'rejected' | 'skipped';
  selected: boolean;
  /** New commits moved this finding off the agent's line (spec §5). */
  lineMoved?: boolean;
}

export interface SidebarActiveReview {
  headline: string;
  /** "!2841" on its own — the status bar shows this without the title. */
  refLabel?: string;
  context: string;
  agent: string;
  added: number;
  removed: number;
  counts: { accepted: number; rejected: number; skipped: number; undecided: number };
  items: SidebarReviewItem[];
}

/** Spec §1: the sidebar mirrors the wizard's three steps while it runs. */
export interface SidebarSetup {
  steps: Array<{ label: string; done: boolean; meta?: string }>;
}

/**
 * Spec §3: before a review has run, the sidebar names the merge request and
 * the agent — and nothing else. No counts, no tree, no filter pills.
 */
export interface SidebarPendingReview {
  headline: string;
  refLabel?: string;
  context: string;
  agent: string;
  added: number;
  removed: number;
}

/** Spec §9: the posted-reviews thread list. */
export interface SidebarThread {
  id: string;
  title: string;
  meta: string;
  status: 'awaiting' | 'replied' | 'resolved' | 'conceded' | 'stale';
  selected: boolean;
}

export interface SidebarThreads {
  headline: string;
  context: string;
  summary: Array<{ status: SidebarThread['status']; label: string }>;
  threads: SidebarThread[];
}

export interface SidebarViewState {
  podName: string;
  podMeta: string;
  pods: SidebarPod[];
  mergeRequests: SidebarMergeRequest[];
  issues: SidebarIssue[];
  waitingOnYou: number;
  /** Precedence, highest first: setup → threads → review → pending → lists. */
  setup?: SidebarSetup;
  threads?: SidebarThreads;
  activeReview?: SidebarActiveReview;
  pendingReview?: SidebarPendingReview;
  activeRoute?: string;
  codicons?: CodiconAssets;
}

export type SidebarMessage =
  | { type: 'refresh' }
  | { type: 'selectPod'; podId: string }
  | { type: 'openDashboard' }
  | { type: 'openPostedReviews' }
  | { type: 'openTuning' }
  | { type: 'openSettings' }
  | { type: 'selectFinding'; itemId: string }
  | { type: 'selectThread'; threadId: string }
  | { type: 'openPostedReviewTab' }
  | { type: 'useDemoPod' }
  | { type: 'openReviewTab' }
  | { type: 'openCr'; repoId: string; number: string };

const CSS = `
body { min-height: 100vh; background: var(--bg2); color: var(--fg); font-size: 12.5px; }
.side { width: 100%; min-width: 0; min-height: 100vh; display: flex; flex-direction: column; overflow: hidden; background: var(--bg2); }
.head { display: flex; align-items: center; justify-content: space-between; padding: 10px 12px; }
.brand { color: var(--fg); font-size: 11px; font-weight: 600; letter-spacing: .09em; text-transform: uppercase; }
.head-tools { display: flex; gap: 12px; align-items: center; color: var(--fg-dim2); font-family: var(--font-mono); font-size: 12px; }
.icon-btn { border: none; background: none; color: inherit; cursor: pointer; font: inherit; padding: 0; }
.nav { display: flex; flex-direction: column; }
.nav-row { display: flex; align-items: center; gap: 9px; width: 100%; border: none; background: none; color: var(--fg-dim); padding: 8px 12px; cursor: pointer; font: 400 12.5px/1.3 var(--font-ui); text-align: left; }
.nav-row:hover { background: var(--hover); color: var(--fg-hi); }
.nav-row.active { background: var(--bg3); color: var(--fg-hi); }
.nav-glyph { width: 13px; color: var(--fg-dim2); font-family: var(--font-mono); font-size: 12px; text-align: center; }
.nav-row.active .nav-glyph { color: var(--accent); }
.nav-label { flex: 1; }
.nav-count { color: var(--fg-dimmer); font-family: var(--font-mono); font-size: 10.5px; }
.divider { border-top: 1px solid var(--line); margin-top: 4px; }
.section { padding: 11px 12px 8px; color: var(--fg-dimmer); font-size: 10px; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; }
.pod-list, .list { display: flex; flex-direction: column; padding-bottom: 8px; }
.pod-row { display: grid; grid-template-columns: 12px minmax(0, 1fr); column-gap: 7px; width: 100%; border: none; background: none; color: var(--fg-dim); padding: 7px 12px; cursor: pointer; font-family: var(--font-ui); text-align: left; }
.pod-row:hover { background: var(--hover); }
.pod-row.active { background: var(--sel); color: var(--fg-hi); }
.pod-check { color: var(--accent); font-family: var(--font-mono); font-size: 10px; padding-top: 2px; }
.pod-name { font-size: 12px; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pod-meta { grid-column: 2; margin-top: 2px; color: var(--fg-dimmer); font-family: var(--font-mono); font-size: 10.5px; }
.review { display: grid; grid-template-columns: 7px minmax(0, 1fr); column-gap: 8px; width: 100%; border: none; background: none; color: var(--fg); padding: 8px 12px; cursor: pointer; text-align: left; }
.review > span:last-child, .issue > span { min-width: 0; }
.review:hover { background: var(--hover); }
.review-dot { width: 7px; height: 7px; border-radius: 50%; margin-top: 4px; background: var(--fg-dimmer); }
.review-dot.waiting { background: var(--sev-major); }
.review-title { color: var(--fg-hi); font: 500 12px/1.3 var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-meta { margin-top: 2px; color: var(--fg-dimmer); font: 10.5px/1.3 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; padding: 7px 12px; color: var(--fg-dim); }
.issue-label { color: var(--agent); font: 10.5px/1.3 var(--font-mono); }
.issue-title { font: 400 11.5px/1.3 var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-project { grid-column: 2; color: var(--fg-dimmer); font: 10px/1.3 var(--font-mono); }
.empty { padding: 7px 12px 10px; color: var(--fg-dimmer); font: 11.5px/1.4 var(--font-ui); }
.review-context { border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); padding: 12px; }
.review-context-head { display: flex; align-items: flex-start; gap: 8px; }
.review-mark { width: 18px; height: 18px; border-radius: 4px; display: grid; place-items: center; flex: none; background: var(--brand); color: #fff; font: 700 10px/1 var(--font-ui); }
.review-context-title { color: var(--fg-hi); font: 600 12.5px/1.35 var(--font-ui); }
.review-context-meta { margin-top: 3px; color: var(--fg-dimmer); font: 10.5px/1.35 var(--font-mono); }
.review-agent { display: flex; justify-content: space-between; margin-top: 10px; color: var(--fg-dim); font-size: 11px; }
.progress { height: 4px; display: flex; margin-top: 10px; overflow: hidden; border-radius: 2px; background: var(--line); }
.progress span { height: 100%; }
.progress-accepted { background: var(--ok); }
.progress-rejected { background: var(--sev-blocker); }
.progress-skipped { background: var(--fg-dim2); }
.review-counts { display: flex; gap: 9px; margin-top: 7px; color: var(--fg-dim); font: 10px/1 var(--font-mono); }
.review-counts .left { margin-left: auto; color: var(--fg-hi); }
.review-filters { display: flex; gap: 5px; padding: 9px 10px; border-bottom: 1px solid var(--line); }
.review-filter { border: 1px solid var(--line2); border-radius: 12px; padding: 3px 7px; background: none; color: var(--fg-dim); font: 10px/1 var(--font-ui); cursor: pointer; }
.review-filter:hover, .review-filter.active { border-color: var(--accent); color: var(--fg-hi); }
/* The tree groups by file (spec §5): a ▾ file row, then indented items. */
.file-row { display: flex; align-items: center; gap: 6px; width: 100%; padding: 7px 11px 5px; border: 0; background: none; color: var(--fg-dim); text-align: left; font: 500 11px/1.3 var(--font-mono); cursor: default; }
.file-row[hidden] { display: none; }
.file-caret { color: var(--fg-dimmer); font-size: 9px; }
.file-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
.file-count { color: var(--fg-dimmer); font-size: 10px; }
.finding { display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: start; gap: 7px; width: 100%; padding: 6px 11px 6px 28px; border: 0; border-left: 2px solid transparent; background: none; color: var(--fg); text-align: left; cursor: pointer; }
.finding:hover { background: var(--hover); }
.finding.selected { background: var(--sel); border-left-color: var(--accent); }
.finding[hidden] { display: none; }
.finding-dot { width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--fg-dimmer); }
.finding-dot.blocker { background: var(--sev-blocker); }
.finding-dot.major { background: var(--sev-major); }
.finding-dot.minor { background: var(--sev-minor); }
.finding-title { display: block; overflow: hidden; color: var(--fg-hi); font: 500 11.5px/1.3 var(--font-ui); text-overflow: ellipsis; white-space: nowrap; }
/* Decided items read as done — struck through and dimmed (spec §5). */
.finding.decided .finding-title { color: var(--fg-dimmer); text-decoration: line-through; }
.finding-moved { display: block; margin-top: 2px; color: var(--sev-major); font: 9.5px/1.3 var(--font-mono); }
.finding-verdict { color: var(--fg-dim2); font: 10px/1 var(--font-mono); }
.finding-verdict.accepted { color: var(--ok); }
.finding-verdict.rejected { color: var(--sev-blocker); }
.foot { margin-top: auto; border-top: 1px solid var(--line); padding: 10px 12px; color: var(--fg-dimmer); font: 10.5px/1.4 var(--font-mono); }
.foot-link { border: 0; background: none; padding: 0; color: var(--accent); font: 11px/1.4 var(--font-ui); cursor: pointer; }
.foot-link:hover { text-decoration: underline; }
/* Setup checklist (spec §1) — ○/✓ marks with live meta under each step. */
.checklist { display: flex; flex-direction: column; padding-bottom: 8px; }
.check-row { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 8px; padding: 6px 12px; color: var(--fg-dim); }
.check-mark { color: var(--fg-dimmer); font: 11px/1.4 var(--font-mono); }
.check-row.done .check-mark { color: var(--ok); }
.check-label { display: block; font: 12px/1.35 var(--font-ui); }
.check-row.done .check-label { color: var(--fg-hi); }
.check-meta { display: block; margin-top: 2px; overflow: hidden; color: var(--fg-dimmer); font: 10.5px/1.35 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
/* Posted-reviews thread list (spec §9). */
.thread-summary { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; color: var(--fg-dim); font: 10.5px/1.3 var(--font-mono); }
.thread-summary-row { display: flex; align-items: center; gap: 7px; }
.thread-dot { width: 7px; height: 7px; flex: none; border-radius: 50%; background: var(--fg-dimmer); }
.thread-dot.awaiting { background: var(--sev-major); }
.thread-dot.replied { background: var(--agent); }
.thread-dot.resolved { background: var(--ok); }
.thread-dot.conceded { background: var(--fg-dim2); }
.thread-dot.stale { background: var(--sev-blocker); }
.thread-row { display: grid; grid-template-columns: 7px minmax(0, 1fr); align-items: start; gap: 8px; width: 100%; padding: 7px 12px; border: 0; border-left: 2px solid transparent; background: none; color: var(--fg); text-align: left; cursor: pointer; }
.thread-row:hover { background: var(--hover); }
.thread-row.selected { background: var(--sel); border-left-color: var(--accent); }
.thread-row .thread-dot { margin-top: 4px; }
.thread-title { display: block; overflow: hidden; color: var(--fg-hi); font: 500 11.5px/1.3 var(--font-ui); text-overflow: ellipsis; white-space: nowrap; }
.thread-meta { display: block; margin-top: 2px; overflow: hidden; color: var(--fg-dimmer); font: 9.5px/1.3 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
/* Codicon chrome sits on the mono baseline the prototype uses for nav glyphs. */
.nav-glyph .codicon { font-size: 14px; vertical-align: -2px; }
.icon-btn .codicon { font-size: 14px; }
`;

/** ✓ / ✕ / ⤼ once decided, the agent's confidence while it is still open. */
function verdictGlyph(item: SidebarReviewItem): string {
  if (item.verdict === 'accepted') return '✓';
  if (item.verdict === 'rejected') return '✕';
  if (item.verdict === 'skipped') return '⤼';
  return item.confidence === undefined ? '·' : `${item.confidence}%`;
}

/**
 * The triage tree, grouped by file (spec §5). Rows carry the data the filter
 * pills need so filtering stays in the webview — a verdict never costs a
 * round trip to re-render the sidebar.
 */
function renderReviewTree(items: readonly SidebarReviewItem[]): string {
  const e = escapeHtml;
  const files = [...new Set(items.map((item) => item.file))];
  return files
    .map((file) => {
      const inFile = items.filter((item) => item.file === file);
      const rows = inFile
        .map(
          (item) => `<button class="finding ${item.selected ? 'selected' : ''} ${
            item.verdict === 'accepted' || item.verdict === 'rejected' ? 'decided' : ''
          }" data-finding="${e(item.id)}" data-file="${e(file)}" data-verdict="${e(item.verdict ?? 'undecided')}" data-category="${e(item.category ?? '')}" title="${e(item.title)}">
        <span class="finding-dot ${item.severity}"></span>
        <span><span class="finding-title">${e(item.title)}</span>${
          item.lineMoved ? '<span class="finding-moved">⚠ line moved</span>' : ''
        }</span>
        <span class="finding-verdict ${item.verdict ?? ''}">${e(verdictGlyph(item))}</span>
      </button>`,
        )
        .join('');
      return `<div class="file-row" data-file-row="${e(file)}"><span class="file-caret">▾</span><span class="file-path">${e(file)}</span><span class="file-count">${inFile.length}</span></div>${rows}`;
    })
    .join('');
}

/** "All 8 / Open 5 / Security 3" — every pill carries its own count (spec §5). */
function renderFilterPills(items: readonly SidebarReviewItem[]): string {
  const e = escapeHtml;
  const open = items.filter((item) => !item.verdict).length;
  const security = items.filter((item) => item.category === 'security').length;
  const pills: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: 'All', count: items.length },
    { key: 'undecided', label: 'Open', count: open },
  ];
  if (security > 0) pills.push({ key: 'category:security', label: 'Security', count: security });
  return pills
    .map(
      (pill, index) => `<button class="review-filter ${index === 0 ? 'active' : ''}" data-review-filter="${e(pill.key)}">${e(pill.label)} ${pill.count}</button>`,
    )
    .join('');
}

/** Spec §1: "a Setup checklist mirroring the three steps with ○/✓ marks". */
function renderSetup(setup: SidebarSetup): string {
  const e = escapeHtml;
  const rows = setup.steps
    .map(
      (step) => `<div class="check-row ${step.done ? 'done' : ''}">
      <span class="check-mark">${step.done ? '✓' : '○'}</span>
      <span><span class="check-label">${e(step.label)}</span>${step.meta ? `<span class="check-meta">${e(step.meta)}</span>` : ''}</span>
    </div>`,
    )
    .join('');
  return `<div class="divider"></div><div class="section">Setup</div><div class="checklist">${rows}</div>`;
}

/** Spec §3: identity and agent, and explicitly no triage UI. */
function renderPending(pending: SidebarPendingReview): string {
  const e = escapeHtml;
  return `<section><div class="review-context">
    <div class="review-context-head"><span class="review-mark">!</span><span><span class="review-context-title">${e(pending.headline)}</span><span class="review-context-meta">${e(pending.context)} · <span class="ok">+${pending.added}</span> · <span class="bad">−${pending.removed}</span></span></span></div>
    <div class="review-agent"><span>Agent · <span class="agent-fg">${e(pending.agent)}</span></span></div>
  </div>
  <div class="empty">No review items yet. Pick an agent and run the review.</div></section>`;
}

/** Spec §9: status summary over the thread list. No counters, no filter pills. */
function renderThreads(threads: SidebarThreads): string {
  const e = escapeHtml;
  const summary = threads.summary
    .map((row) => `<div class="thread-summary-row"><span class="thread-dot ${row.status}"></span><span>${e(row.label)}</span></div>`)
    .join('');
  const rows = threads.threads
    .map(
      (thread) => `<button class="thread-row ${thread.selected ? 'selected' : ''}" data-thread="${e(thread.id)}" title="${e(thread.title)}">
      <span class="thread-dot ${thread.status}"></span>
      <span><span class="thread-title">${e(thread.title)}</span><span class="thread-meta">${e(thread.meta)}</span></span>
    </button>`,
    )
    .join('');
  return `<section>
    <div class="review-context"><div class="review-context-head"><span class="review-mark">!</span><span><span class="review-context-title">${e(threads.headline)}</span><span class="review-context-meta">${e(threads.context)}</span></span></div>
    <div class="thread-summary">${summary}</div></div>
    <div class="list">${rows || '<div class="empty">No threads on this review yet.</div>'}</div>
  </section>`;
}

export function renderSidebarHtml(state: SidebarViewState, nonce: string): string {
  const e = escapeHtml;
  const podRows = state.pods.length > 0
    ? state.pods.map((pod) => `<button class="pod-row ${pod.active ? 'active' : ''}" data-pod="${e(pod.id)}">
        <span class="pod-check">${pod.active ? '✓' : ''}</span>
        <span class="pod-name">${e(pod.name)}</span>
        <span class="pod-meta">${e(pod.meta)}</span>
      </button>`).join('')
    : '<div class="empty">No pods configured</div>';
  const mergeRequestRows = state.mergeRequests.length > 0
    ? state.mergeRequests.map((mr) => `<button class="review" data-cr-repo="${e(mr.repoId)}" data-cr-number="${e(mr.number)}">
        <span class="review-dot ${mr.waiting ? 'waiting' : ''}"></span>
        <span><span class="review-title">${e(mr.title)}</span><span class="review-meta">${e(mr.label)} · ${e(mr.project)}</span></span>
      </button>`).join('')
    : '<div class="empty">No open merge requests</div>';
  const issueRows = state.issues.length > 0
    ? state.issues.map((issue) => `<div class="issue">
        <span class="issue-label">${e(issue.label)}</span><span class="issue-title">${e(issue.title)}</span>
        <span class="issue-project">${e(issue.project)}</span>
      </div>`).join('')
    : '<div class="empty">No issues in progress</div>';
  const activeReview = state.activeReview;
  const decided = activeReview ? activeReview.items.length - activeReview.counts.undecided : 0;
  const progressWidth = (count: number) => activeReview?.items.length ? (count / activeReview.items.length) * 100 : 0;
  const reviewTree = activeReview ? renderReviewTree(activeReview.items) : '';
  const filterPills = activeReview ? renderFilterPills(activeReview.items) : '';
  const reviewSection = activeReview ? `<section>
    <div class="review-context"><div class="review-context-head"><span class="review-mark">!</span><span><span class="review-context-title">${e(activeReview.headline)}</span><span class="review-context-meta">${e(activeReview.context)} · <span class="ok">+${activeReview.added}</span> · <span class="bad">−${activeReview.removed}</span></span></span></div>
    <div class="review-agent"><span>Agent · <span class="agent-fg">${e(activeReview.agent)}</span></span><span>${decided}/${activeReview.items.length}</span></div>
    <div class="progress"><span class="progress-accepted" style="width:${progressWidth(activeReview.counts.accepted)}%"></span><span class="progress-rejected" style="width:${progressWidth(activeReview.counts.rejected)}%"></span><span class="progress-skipped" style="width:${progressWidth(activeReview.counts.skipped)}%"></span></div>
    <div class="review-counts"><span class="ok">${activeReview.counts.accepted} acc</span><span class="bad">${activeReview.counts.rejected} rej</span><span>${activeReview.counts.skipped} skip</span><span class="left">${activeReview.counts.undecided} left</span></div></div>
    <div class="review-filters">${filterPills}</div>
    <div class="list">${reviewTree}</div>
  </section>` : '';

  // One precedence rule, evaluated once, so the states cannot flap.
  const screen = state.setup
    ? 'setup'
    : state.threads
      ? 'threads'
      : activeReview
        ? 'triage'
        : state.pendingReview
          ? 'pending'
          : 'lists';

  const navRows = [
    { id: 'dashboard', route: 'dashboard', icon: 'dashboard', label: 'Pod dashboard', count: `${state.mergeRequests.length}` },
    { id: 'posted-reviews', route: 'posted', icon: 'comment-discussion', label: 'Posted reviews', count: `${state.waitingOnYou}` },
    { id: 'tuning', route: 'tuning', icon: 'graph', label: 'Agent tuning' },
    { id: 'settings', route: 'settings', icon: 'gear', label: 'Settings' },
  ]
    // Spec §1: the later rows are hidden until setup completes — there is
    // nothing behind them yet.
    .filter((row) => screen !== 'setup' || row.id === 'dashboard')
    .map((row) => `<button class="nav-row ${state.activeRoute === row.route ? 'active' : ''}" id="${row.id}"><span class="nav-glyph">${icon(row.icon)}</span><span class="nav-label">${e(row.label)}</span>${row.count === undefined ? '' : `<span class="nav-count">${e(row.count)}</span>`}</button>`)
    .join('');

  const main =
    screen === 'setup'
      ? renderSetup(state.setup as SidebarSetup)
      : screen === 'threads'
        ? renderThreads(state.threads as SidebarThreads)
        : screen === 'triage'
          ? reviewSection
          : screen === 'pending'
            ? renderPending(state.pendingReview as SidebarPendingReview)
            : `<div class="divider"></div><div class="section">Merge requests</div><div class="list">${mergeRequestRows}</div><div class="divider"></div><div class="section">Issues · in progress</div><div class="list">${issueRows}</div>`;

  const footer =
    screen === 'setup'
      ? '<button class="foot-link" id="use-demo-pod">Skip and use a demo pod</button>'
      : screen === 'threads'
        ? '<button class="foot-link" id="open-posted-tab">Open posted review</button>'
        : screen === 'triage' || screen === 'pending'
          ? '<button class="foot-link" id="open-review-tab">Open review tab</button>'
          : `${e(state.podName)} · ${e(state.podMeta)}`;

  const body = `<main class="side">
    <header class="head"><span class="brand">Verdict</span><span class="head-tools"><button class="icon-btn" id="refresh" title="Refresh">${icon('refresh')}</button><span class="icon-btn">${icon('ellipsis')}</span></span></header>
    <nav class="nav" aria-label="Verdict navigation">${navRows}</nav>
    ${screen === 'setup' ? '' : `<div class="divider"></div><div class="section">Pods</div><div class="pod-list">${podRows}</div>`}
    ${main}
    <footer class="foot">${footer}</footer>
  </main>`;

  const script = `
    const vscode = window.verdictVscode;
    const post = (message) => vscode.postMessage(message);
    document.getElementById('refresh')?.addEventListener('click', () => post({ type: 'refresh' }));
    document.getElementById('dashboard')?.addEventListener('click', () => post({ type: 'openDashboard' }));
    document.getElementById('posted-reviews')?.addEventListener('click', () => post({ type: 'openPostedReviews' }));
    document.getElementById('tuning')?.addEventListener('click', () => post({ type: 'openTuning' }));
    document.getElementById('settings')?.addEventListener('click', () => post({ type: 'openSettings' }));
    document.querySelectorAll('[data-pod]').forEach((row) => row.addEventListener('click', () => post({ type: 'selectPod', podId: row.dataset.pod })));
    document.querySelectorAll('[data-cr-repo]').forEach((row) => row.addEventListener('click', () => post({ type: 'openCr', repoId: row.dataset.crRepo, number: row.dataset.crNumber })));
    document.querySelectorAll('[data-finding]').forEach((row) => row.addEventListener('click', () => post({ type: 'selectFinding', itemId: row.dataset.finding })));
    document.getElementById('open-review-tab')?.addEventListener('click', () => post({ type: 'openReviewTab' }));
    document.getElementById('open-posted-tab')?.addEventListener('click', () => post({ type: 'openPostedReviewTab' }));
    document.getElementById('use-demo-pod')?.addEventListener('click', () => post({ type: 'useDemoPod' }));
    document.querySelectorAll('[data-thread]').forEach((row) => row.addEventListener('click', () => post({ type: 'selectThread', threadId: row.dataset.thread })));
    const matches = (row, filter) => {
      if (filter === 'all') return true;
      if (filter.startsWith('category:')) return row.dataset.category === filter.slice('category:'.length);
      return row.dataset.verdict === filter;
    };
    document.querySelectorAll('[data-review-filter]').forEach((button) => button.addEventListener('click', () => {
      document.querySelectorAll('[data-review-filter]').forEach((candidate) => candidate.classList.remove('active'));
      button.classList.add('active');
      const filter = button.dataset.reviewFilter;
      const shown = {};
      document.querySelectorAll('[data-finding]').forEach((row) => {
        row.hidden = !matches(row, filter);
        if (!row.hidden) shown[row.dataset.file] = true;
      });
      // A file heading with nothing under it is noise — hide it with its items.
      document.querySelectorAll('[data-file-row]').forEach((row) => { row.hidden = !shown[row.dataset.fileRow]; });
    }));
  `;

  return renderPage({ title: 'Verdict', nonce, css: CSS, body, script, embedded: true, codicons: state.codicons });
}