import { renderPage, escapeHtml, type CodiconAssets } from './theme';
import { cap, type Vocabulary } from './vocab';

/**
 * Chrome icons are codicons (issue #6). Glyphs the spec names in prose —
 * the ✓/✕/⤼ verdicts, the ▾ file caret, ⚠, and the ○/✓ setup marks — stay as
 * written characters: they are content the spec dictates, not chrome.
 */
function icon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

/**
 * The triage progress segments are a continuous value, so they cannot each
 * get a named class — quantised to the nearest 5% instead, the only width a
 * data-driven bar can take under this webview's CSP (`style-src
 * 'nonce-…'`), which drops the `style="width:…"` attribute these segments
 * used to carry silently (issue #45). 5 points is under what a 4px-tall bar
 * can show; the cost lands at the edges — a true share under 2.5% rounds
 * down to an invisible 0%-wide segment instead of a sliver, and the three
 * segments here are rounded independently, so their sum can drift from the
 * true total by up to 7.5 points either way.
 */
const WIDTH_STEP = 5;
const WIDTH_CSS = Array.from({ length: 100 / WIDTH_STEP + 1 }, (_, i) => `.w-${i * WIDTH_STEP} { width: ${i * WIDTH_STEP}%; }`).join('\n');

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
  repoId: string;
  number: string;
  /** Navigation target (issue #40) — opened with `vscode.env.openExternal`. */
  webUrl: string;
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
  /** The finding only exists between repos — ⧉ in the tree, "Cross-repo" pill (spec §15). */
  cross?: boolean;
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
  /** Changeset scope: ⧉ chrome and the Cross-repo filter pill (spec §15). */
  changeset?: boolean;
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

/**
 * One review in flight. Shown outside the run screen because that is the whole
 * point of a background run: the reviewer is somewhere else, and still needs to
 * know something is happening and be able to stop it.
 */
export interface SidebarActiveRun {
  key: string;
  label: string;
  state: 'running' | 'queued';
  /** Milliseconds since it was triggered, formatted by the renderer. */
  elapsedMs: number;
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
  /** Platform nouns for the active pod's provider — never hardcoded here. */
  vocabulary: Vocabulary;
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
  /** Reviews running or waiting for a slot. Rendered above whatever screen shows. */
  activeRuns?: SidebarActiveRun[];
  /** Detected changesets — the nav row shows "N open" and opens the first (spec §15). */
  changesets?: Array<{ id: string; name: string }>;
  activeRoute?: string;
  codicons?: CodiconAssets;
}

export type SidebarMessage =
  | { type: 'refresh' }
  | { type: 'selectPod'; podId: string }
  | { type: 'deletePod'; podId: string }
  | { type: 'openDashboard' }
  | { type: 'openChangesets'; firstId?: string }
  | { type: 'openPostedReviews' }
  | { type: 'openTuning' }
  | { type: 'openSettings' }
  | { type: 'selectFinding'; itemId: string }
  | { type: 'cancelRun'; key: string }
  | { type: 'selectThread'; threadId: string }
  | { type: 'openPostedReviewTab' }
  | { type: 'useDemoPod' }
  | { type: 'openReviewTab' }
  | { type: 'openCr'; repoId: string; number: string }
  | { type: 'openIssue'; webUrl: string };

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
.pod-list, .list, .run-list { display: flex; flex-direction: column; padding-bottom: 8px; }
/* One review in flight. The dot pulses only while a run is actually streaming;
   a queued one is still, because nothing is happening on it yet. */
.run-row { display: flex; align-items: center; gap: 8px; padding: 5px 12px; }
.run-dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: run-pulse 1.4s ease-in-out infinite; }
.run-dot.queued { background: var(--fg-dimmer); animation: none; }
.run-label { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.run-meta { flex: none; color: var(--fg-dimmer); font-family: var(--font-mono); font-size: 10.5px; }
.run-cancel { flex: none; background: none; border: 0; color: var(--fg-dimmer); cursor: pointer; padding: 0 2px; font-size: 11px; }
.run-cancel:hover { color: var(--fg); }
@keyframes run-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
/* The row is two controls, so the selection background moves to the wrapper —
   otherwise the delete button sits outside the highlight it belongs to. */
.pod-row-wrap { display: flex; align-items: stretch; width: 100%; }
.pod-row-wrap:hover { background: var(--hover); }
.pod-row-wrap.active { background: var(--sel); }
.pod-row { display: grid; grid-template-columns: 12px minmax(0, 1fr); column-gap: 7px; flex: 1; min-width: 0; border: none; background: none; color: var(--fg-dim); padding: 7px 12px; cursor: pointer; font-family: var(--font-ui); text-align: left; }
.pod-row.active { color: var(--fg-hi); }
/* Hidden until the row is hovered so the list stays as quiet as the prototype,
   but still reachable by keyboard — :focus-visible brings it back. */
.pod-delete { display: flex; align-items: center; border: none; background: none; color: var(--fg-dimmer); padding: 0 10px; cursor: pointer; font: inherit; opacity: 0; }
.pod-row-wrap:hover .pod-delete, .pod-delete:focus-visible { opacity: 1; }
.pod-delete:hover, .pod-delete:focus-visible { color: var(--fg-hi); }
.pod-delete .codicon { font-size: 13px; }
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
.issue { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; width: 100%; border: none; background: none; padding: 7px 12px; color: var(--fg-dim); cursor: pointer; text-align: left; }
.issue:hover { background: var(--hover); }
.issue-label { color: var(--agent); font: 10.5px/1.3 var(--font-mono); }
.issue-title { font: 400 11.5px/1.3 var(--font-ui); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.issue-repo { grid-column: 2; color: var(--fg-dimmer); font: 10px/1.3 var(--font-mono); }
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
${WIDTH_CSS}
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
/* Cross-repo items: ⧉ in the severity's colour, in the dot's grid slot. */
.finding-cross { color: var(--fg-dimmer); font: 10px/1.4 var(--font-mono); }
.finding-cross.blocker { color: var(--sev-blocker); }
.finding-cross.major { color: var(--sev-major); }
.finding-cross.minor { color: var(--sev-minor); }
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
          }" data-finding="${e(item.id)}" data-file="${e(file)}" data-verdict="${e(item.verdict ?? 'undecided')}" data-category="${e(item.category ?? '')}" data-cross="${item.cross ? 'true' : ''}" title="${e(item.title)}">
        ${
          // Spec §15: cross-repo items swap the dot for ⧉ but keep the
          // severity colour — the glyph, not a colour change, is the signal.
          item.cross
            ? `<span class="finding-cross ${item.severity}">⧉</span>`
            : `<span class="finding-dot ${item.severity}"></span>`
        }
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

/**
 * "All 8 / Open 5 / Security 3" — every pill carries its own count (spec §5).
 * In changeset scope the third pill becomes "Cross-repo N" instead of
 * Security (spec §15): the queue's special population is the findings that
 * only exist between the repos.
 */
function renderFilterPills(items: readonly SidebarReviewItem[], changesetScope: boolean): string {
  const e = escapeHtml;
  const open = items.filter((item) => !item.verdict).length;
  const pills: Array<{ key: string; label: string; count: number }> = [
    { key: 'all', label: 'All', count: items.length },
    { key: 'undecided', label: 'Open', count: open },
  ];
  if (changesetScope) {
    const cross = items.filter((item) => item.cross).length;
    if (cross > 0) pills.push({ key: 'cross', label: 'Cross-repo', count: cross });
  } else {
    const security = items.filter((item) => item.category === 'security').length;
    if (security > 0) pills.push({ key: 'category:security', label: 'Security', count: security });
  }
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

/**
 * Reviews in flight, above whatever screen the sidebar is showing.
 *
 * Nothing at all when nothing is running: an empty section is a claim that
 * there is something to see. Elapsed rather than a percentage, because a run
 * that has parked on the same step for two minutes is exactly the case the
 * reviewer needs to notice.
 */
function renderActiveRuns(runs: readonly SidebarActiveRun[]): string {
  if (runs.length === 0) return '';
  const rows = runs
    .map(
      (run) => `<div class="run-row">
      <span class="run-dot ${run.state === 'queued' ? 'queued' : ''}"></span>
      <span class="run-label">${escapeHtml(run.label)}</span>
      <span class="run-meta">${run.state === 'queued' ? 'queued' : escapeHtml(formatElapsed(run.elapsedMs))}</span>
      <button class="run-cancel" data-cancel-run="${escapeHtml(run.key)}" title="Cancel this review">✕</button>
    </div>`,
    )
    .join('');
  const running = runs.filter((run) => run.state === 'running').length;
  return `<div class="divider"></div><div class="section">Running · ${running} of ${runs.length}</div><div class="run-list">${rows}</div>`;
}

/** `0:42`, `12:07` — a stopwatch, not a duration phrase. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
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

/**
 * Precedence, highest first: setup → threads → triage → pending → lists.
 * The one place that decides which arm wins (issue #46 task 2.3) — the full
 * page and every region patch (`renderSidebarRegions` below) call this
 * instead of each keeping its own copy of the ternary chain, so a patch
 * computed from a different rule than the full render is never how two
 * regions could end up disagreeing about which one is allowed to show
 * anything.
 */
export type SidebarScreen = 'setup' | 'threads' | 'triage' | 'pending' | 'lists';

export function sidebarScreen(state: SidebarViewState): SidebarScreen {
  return state.setup
    ? 'setup'
    : state.threads
      ? 'threads'
      : state.activeReview
        ? 'triage'
        : state.pendingReview
          ? 'pending'
          : 'lists';
}

/**
 * The nav rows — filtered to just Dashboard during setup (spec §1) and
 * carrying the active route's highlight. The first detected changeset's id
 * rides a data attribute rather than a value the bootstrap script closes
 * over: `#sidebar-nav` is itself a patchable region, and a script-load-time
 * closure would go stale the moment a patch (not a full reload) changed
 * which changeset is first.
 */
function renderNavRows(state: SidebarViewState, screen: SidebarScreen): string {
  const e = escapeHtml;
  return [
    { id: 'dashboard', route: 'dashboard', icon: 'dashboard', label: 'Pod dashboard', count: `${state.mergeRequests.length}` },
    // ⧉ is spec-named changeset content (README §15), not chrome — it stays a
    // character while the other rows use codicons.
    { id: 'changesets', route: 'changeset', glyph: '⧉', label: 'Changesets', count: `${(state.changesets ?? []).length} open` },
    { id: 'posted-reviews', route: 'posted', icon: 'comment-discussion', label: 'Posted reviews', count: `${state.waitingOnYou}` },
    { id: 'tuning', route: 'tuning', icon: 'graph', label: 'Agent tuning' },
    { id: 'settings', route: 'settings', icon: 'gear', label: 'Settings' },
  ]
    // Spec §1: the later rows are hidden until setup completes — there is
    // nothing behind them yet.
    .filter((row) => screen !== 'setup' || row.id === 'dashboard')
    .map((row) => `<button class="nav-row ${state.activeRoute === row.route ? 'active' : ''}" id="${row.id}"${
      row.id === 'changesets' ? ` data-first-changeset-id="${e(state.changesets?.[0]?.id ?? '')}"` : ''
    }><span class="nav-glyph">${'glyph' in row && row.glyph ? e(row.glyph) : icon(row.icon ?? '')}</span><span class="nav-label">${e(row.label)}</span>${row.count === undefined ? '' : `<span class="nav-count">${e(row.count)}</span>`}</button>`)
    .join('');
}

/** Spec §5 — the triage screen: counts, progress bar, filter pills, tree. */
function renderReviewSection(activeReview: SidebarActiveReview): string {
  const e = escapeHtml;
  const decided = activeReview.items.length - activeReview.counts.undecided;
  /**
   * The three segments are quantised CUMULATIVELY, not one by one.
   *
   * Rounding each width independently to `WIDTH_STEP` lets three roundings
   * accumulate: 2/2/1 of 7 items is 28.6/28.6/14.3, which rounds to
   * 30/30/15 = 75 against a true 71.4. On a stacked bar that shows as a gap
   * before the undecided remainder, or as an overrun past it. Rounding the
   * running boundary instead makes each width the difference of two rounded
   * values, so the segments always add up to the rounded total and no one
   * segment is ever more than a step from its true share.
   */
  const total = activeReview.items.length;
  const segmentWidths = (counts: readonly number[]): number[] => {
    if (total === 0) return counts.map(() => 0);
    let running = 0;
    let placed = 0;
    return counts.map((count) => {
      running += count;
      const boundary = Math.round((running / total) * 100 / WIDTH_STEP) * WIDTH_STEP;
      const width = boundary - placed;
      placed = boundary;
      return width;
    });
  };
  const [acceptedWidth, rejectedWidth, skippedWidth] = segmentWidths([
    activeReview.counts.accepted,
    activeReview.counts.rejected,
    activeReview.counts.skipped,
  ]);
  const reviewTree = renderReviewTree(activeReview.items);
  const filterPills = renderFilterPills(activeReview.items, activeReview.changeset ?? false);
  return `<section>
    <div class="review-context"><div class="review-context-head"><span class="review-mark">!</span><span><span class="review-context-title">${e(activeReview.headline)}</span><span class="review-context-meta">${e(activeReview.context)} · <span class="ok">+${activeReview.added}</span> · <span class="bad">−${activeReview.removed}</span></span></span></div>
    <div class="review-agent"><span>Agent · <span class="agent-fg">${e(activeReview.agent)}</span></span><span>${decided}/${activeReview.items.length}</span></div>
    <div class="progress"><span class="progress-accepted w-${acceptedWidth}"></span><span class="progress-rejected w-${rejectedWidth}"></span><span class="progress-skipped w-${skippedWidth}"></span></div>
    <div class="review-counts"><span class="ok">${activeReview.counts.accepted} acc</span><span class="bad">${activeReview.counts.rejected} rej</span><span>${activeReview.counts.skipped} skip</span><span class="left">${activeReview.counts.undecided} left</span></div></div>
    <div class="review-filters">${filterPills}</div>
    <div class="list">${reviewTree}</div>
  </section>`;
}

/** The default screen: open change requests and in-progress issues. */
function renderListsSection(state: SidebarViewState): string {
  const e = escapeHtml;
  const mergeRequestRows = state.mergeRequests.length > 0
    ? state.mergeRequests.map((mr) => `<button class="review" data-cr-repo="${e(mr.repoId)}" data-cr-number="${e(mr.number)}">
        <span class="review-dot ${mr.waiting ? 'waiting' : ''}"></span>
        <span><span class="review-title">${e(mr.title)}</span><span class="review-meta">${e(mr.label)} · ${e(mr.project)}</span></span>
      </button>`).join('')
    : `<div class="empty">No open ${e(state.vocabulary.changeRequestNounPlural)}</div>`;
  const issueRows = state.issues.length > 0
    ? state.issues.map((issue) => `<button class="issue" data-issue-repo="${e(issue.repoId)}" data-issue-number="${e(issue.number)}" data-issue-url="${e(issue.webUrl)}">
        <span class="issue-label">${e(issue.label)}</span><span class="issue-title">${e(issue.title)}</span>
        <span class="issue-repo">${e(issue.project)}</span>
      </button>`).join('')
    : '<div class="empty">No issues in progress</div>';
  return `<div class="divider"></div><div class="section">${e(cap(state.vocabulary.changeRequestNounPlural))}</div><div class="list">${mergeRequestRows}</div><div class="divider"></div><div class="section">Issues · in progress</div><div class="list">${issueRows}</div>`;
}

/**
 * The `#sidebar-active-review` region (issue #46 task 2.2/2.3): triage,
 * pending, or the default lists screen — never threads or setup, which own
 * their own slot. Blank whenever precedence picked one of those two, so
 * this region can never show stale content behind whichever one is
 * actually showing.
 */
function renderActiveReviewRegion(state: SidebarViewState, screen: SidebarScreen): string {
  if (screen === 'triage') return renderReviewSection(state.activeReview as SidebarActiveReview);
  if (screen === 'pending') return renderPending(state.pendingReview as SidebarPendingReview);
  if (screen === 'lists') return renderListsSection(state);
  return '';
}

/**
 * The footer link/text also follows the precedence, so it has to be
 * repatched alongside the two content regions whenever a state change could
 * move the screen (issue #46 task 2.3) — a footer left behind would still
 * offer "Open review tab" after the triage that put it there ended.
 */
function renderFooterRegion(state: SidebarViewState, screen: SidebarScreen): string {
  const e = escapeHtml;
  return screen === 'setup'
    ? '<button class="foot-link" id="use-demo-pod">Skip and use a demo pod</button>'
    : screen === 'threads'
      ? '<button class="foot-link" id="open-posted-tab">Open posted review</button>'
      : screen === 'triage' || screen === 'pending'
        ? '<button class="foot-link" id="open-review-tab">Open review tab</button>'
        : `${e(state.podName)} · ${e(state.podMeta)}`;
}

/**
 * Every region a triage-adjacent state change can touch, computed together
 * from the full current precedence so a caller never has to reason about
 * which subset to repatch: whichever setter fired, patching this whole set
 * from currently-held state always lands the arm precedence picked and
 * blanks every other one (issue #46 task 2.1/2.3). Same shape as
 * `renderPostedReviewsRegions` (postedReviewsHtml.ts:329) — one function
 * producing every id a caller might patch, from one state snapshot.
 *
 * `sidebar-nav` and `sidebar-active-runs` are included too even though only
 * `setActiveRoute`/`setActiveRuns` actually change them, so the full page
 * render below can build every region through this single function rather
 * than keeping a second copy of the markup.
 */
export function renderSidebarRegions(state: SidebarViewState): Record<string, string> {
  const screen = sidebarScreen(state);
  return {
    'sidebar-nav': renderNavRows(state, screen),
    'sidebar-active-runs': renderActiveRuns(state.activeRuns ?? []),
    'sidebar-threads': screen === 'threads' ? renderThreads(state.threads as SidebarThreads) : '',
    'sidebar-active-review': renderActiveReviewRegion(state, screen),
    'sidebar-footer': renderFooterRegion(state, screen),
  };
}

export function renderSidebarHtml(state: SidebarViewState, nonce: string): string {
  const e = escapeHtml;
  const screen = sidebarScreen(state);
  const regions = renderSidebarRegions(state);
  // Not a region: nothing in task 2.3 ever changes which pod is active or
  // the pod list without going through the data path (render()), so unlike
  // the ids above there is nothing for a patch to target here.
  const podRows = state.pods.length > 0
    ? state.pods.map((pod) => `<div class="pod-row-wrap ${pod.active ? 'active' : ''}">
        <button class="pod-row ${pod.active ? 'active' : ''}" data-pod="${e(pod.id)}">
          <span class="pod-check">${pod.active ? '✓' : ''}</span>
          <span class="pod-name">${e(pod.name)}</span>
          <span class="pod-meta">${e(pod.meta)}</span>
        </button>
        <button class="pod-delete" data-pod-delete="${e(pod.id)}" title="Delete pod" aria-label="Delete pod ${e(pod.name)}">${icon('trash')}</button>
      </div>`).join('')
    : '<div class="empty">No pods configured</div>';

  const body = `<main class="side">
    <header class="head"><span class="brand">Verdict</span><span class="head-tools"><button class="icon-btn" id="refresh" title="Refresh">${icon('refresh')}</button><span class="icon-btn">${icon('ellipsis')}</span></span></header>
    <nav class="nav" id="sidebar-nav" aria-label="Verdict navigation">${regions['sidebar-nav']}</nav>
    <div id="sidebar-active-runs">${regions['sidebar-active-runs']}</div>
    ${screen === 'setup' ? '' : `<div class="divider"></div><div class="section">Pods</div><div class="pod-list">${podRows}</div>`}
    <div id="sidebar-threads">${regions['sidebar-threads']}</div>
    <div id="sidebar-active-review">${regions['sidebar-active-review']}</div>
    ${screen === 'setup' ? renderSetup(state.setup as SidebarSetup) : ''}
    <footer class="foot" id="sidebar-footer">${regions['sidebar-footer']}</footer>
  </main>`;

  // Bound on document, not on each row (issue #46 task 2.4): a region patch
  // replaces #sidebar-nav/#sidebar-active-runs/#sidebar-threads/
  // #sidebar-active-review/#sidebar-footer's innerHTML wholesale, which
  // would drop a listener bound directly to an element inside them.
  // Matching with closest() means the patched markup never needs
  // re-binding, the same reasoning as reviewFlowHtml.ts:1267-1274.
  const script = `
    const vscode = window.verdictVscode;
    const post = (message) => vscode.postMessage(message);
    document.addEventListener('click', (ev) => { if (ev.target.closest('#refresh')) post({ type: 'refresh' }); });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-cancel-run]');
      if (el) post({ type: 'cancelRun', key: el.dataset.cancelRun });
    });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#dashboard')) post({ type: 'openDashboard' }); });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('#changesets');
      if (el) post({ type: 'openChangesets', firstId: el.dataset.firstChangesetId || undefined });
    });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#posted-reviews')) post({ type: 'openPostedReviews' }); });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#tuning')) post({ type: 'openTuning' }); });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#settings')) post({ type: 'openSettings' }); });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-pod]');
      if (el) post({ type: 'selectPod', podId: el.dataset.pod });
    });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-pod-delete]');
      if (el) post({ type: 'deletePod', podId: el.dataset.podDelete });
    });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-cr-repo]');
      if (el) post({ type: 'openCr', repoId: el.dataset.crRepo, number: el.dataset.crNumber });
    });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-issue-url]');
      if (el) post({ type: 'openIssue', webUrl: el.dataset.issueUrl });
    });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-finding]');
      if (el) post({ type: 'selectFinding', itemId: el.dataset.finding });
    });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#open-review-tab')) post({ type: 'openReviewTab' }); });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#open-posted-tab')) post({ type: 'openPostedReviewTab' }); });
    document.addEventListener('click', (ev) => { if (ev.target.closest('#use-demo-pod')) post({ type: 'useDemoPod' }); });
    document.addEventListener('click', (ev) => {
      const el = ev.target.closest('[data-thread]');
      if (el) post({ type: 'selectThread', threadId: el.dataset.thread });
    });
    const matches = (row, filter) => {
      if (filter === 'all') return true;
      if (filter === 'cross') return row.dataset.cross === 'true';
      if (filter.startsWith('category:')) return row.dataset.category === filter.slice('category:'.length);
      return row.dataset.verdict === filter;
    };
    document.addEventListener('click', (ev) => {
      const button = ev.target.closest('[data-review-filter]');
      if (!button) return;
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
    });
  `;

  return renderPage({ title: 'Verdict', nonce, css: CSS, body, script, embedded: true, regions: true, codicons: state.codicons });
}