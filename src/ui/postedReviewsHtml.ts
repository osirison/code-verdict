/**
 * Posted reviews (spec/README.md §9) — pure renderer. Tracks author
 * replies across every review submitted in the pod.
 */
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import { formatAge } from './dashboardState';
import { replyDraftKey, selectedPostedRow } from './postedReviewsState';
import type { ThreadStatus } from '../domain/threadStatus';

import { escapeHtml as e, renderPage, type RouteAssets } from './theme';
import { MARKDOWN_CSS, renderMarkdown } from './markdown';
import { cap, type Vocabulary } from './vocab';

export interface PostedRow {
  view: PostedReviewView;
  refLabel: string;
  title: string;
  project: string;
  age: string;
  /**
   * The change request this review was posted to is no longer open — merged
   * or closed. Derived in `postedReviewsState.buildPostedRows` from absence
   * in the batched open list, never stored.
   */
  archived: boolean;
}

/**
 * A row before the fetch that would build a real `PostedRow` (issue #39):
 * only what `ReviewHistory` already knows locally — no `view`, since that
 * needs a live connection (threads, counts, agent label).
 */
export interface PostedPendingRow {
  refLabel: string;
  project: string;
  age: string;
}

export interface PostedViewState {
  /** Platform nouns for the active pod's provider — never hardcoded here. */
  vocabulary: Vocabulary;
  podName: string;
  now: number;
  /**
   * Counted over the visible rows only. A thread still open on a change
   * request that has already merged or closed is not work the reviewer can
   * act on, and a badge inflated with unreachable threads is the same
   * complaint archiving fixes, one line further up the screen.
   */
  waitingOnYouTotal: number;
  /** The visible subset — archived rows are absent unless `showArchived`. */
  rows: PostedRow[];
  /** Whether the archived rows are part of `rows` right now. */
  showArchived: boolean;
  /** Archived rows across the whole history — shown even while the filter is off. */
  archivedCount: number;
  /**
   * The selected review by ref, not by index into `rows`: the visible set
   * changes with the filter, so an index would select a different review the
   * moment archived rows appear or disappear. Absent selects the first
   * visible row, which is what index 0 used to mean.
   */
  selectedRef?: { repoId: string; number: string };
  expandedThreadId?: string;
  /** threadId → second-opinion text, appended on demand. */
  opinions: Record<string, string>;
  /**
   * `replyDraftKey(repoId, crNumber, threadId)` → in-progress reply text
   * (issue #46 task 9.3). The host's own copy, committed on debounced input
   * (never `change`, which only fires on blur), so a patch from an action on
   * one thread re-renders every OTHER thread's reply field from text that is
   * actually current instead of leaving `value` unset and losing it. Rendered
   * back into the field rather than restored via `REGIONS_SCRIPT`, which
   * restores focus and selection only, never `value` (design D8).
   */
  replyDrafts: Record<string, string>;
  /**
   * True while the initial fetch is still in flight (issue #39): `rows` is
   * empty and `pendingRows` — the local history cache, with no fetch
   * required — renders instead, title and counts standing in as skeletons.
   */
  loading?: boolean;
  pendingRows?: PostedPendingRow[];
}

export type PostedMessage =
  | { type: 'selectReview'; repoId: string; number: string }
  | { type: 'toggleArchived' }
  | { type: 'toggleThread'; threadId: string }
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'concede'; threadId: string }
  | { type: 'reply'; threadId: string; text: string }
  /** Debounced `input` on the reply field (task 9.3) — never rendered from, only stored. */
  | { type: 'replyDraft'; threadId: string; text: string }
  | { type: 'secondOpinion'; threadId: string }
  | { type: 'rerun' }
  | { type: 'refresh' }
  | { type: 'backToDashboard' };

const STATUS_CHIP: Record<ThreadStatus, { label: string; cls: string }> = {
  awaiting: { label: 'awaiting author', cls: 'pill' },
  replied: { label: 'replied', cls: 'pill-info' },
  resolved: { label: 'resolved', cls: 'pill-ok' },
  conceded: { label: 'conceded', cls: 'pill' },
  stale: { label: 'thread stale', cls: 'pill-warn' },
};

const CSS = `
header { display: flex; align-items: baseline; gap: 12px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
header h1 { font-size: 14px; font-weight: 600; color: var(--fg-hi); }
header .on-you { font-size: 11.5px; color: var(--sev-minor); }
.head-right { margin-left: auto; }
.tool { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); border: 1px solid var(--line2); border-radius: 4px; background: none; padding: 4px 9px; cursor: pointer; }
.tool:hover { background: var(--hover); }
.tool.active { background: var(--accent); color: var(--accent-fg); border-color: transparent; }

.thead, .rev-row { display: grid; grid-template-columns: minmax(0,1fr) 190px 92px 58px; gap: 10px; padding: 0 20px; align-items: center; }
.thead { font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-dimmer); padding: 10px 20px 6px; }
.rev-row { padding-top: 11px; padding-bottom: 11px; border-bottom: 1px solid var(--row); cursor: pointer; }
.rev-row:hover { background: var(--bg3); }
.rev-row.selected { background: var(--sel); }
.rev-title { font-size: 12.5px; font-weight: 500; color: var(--fg-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rev-ref { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); margin-top: 2px; }
.breakdown { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dim); margin-top: 2px; }
.rev-repo { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.badge { font-family: var(--font-mono); font-size: 10.5px; padding: 3px 7px; border-radius: 3px; }
.badge-you { color: var(--sev-minor); background: var(--sev-minor-t); }
.badge-none { color: var(--fg-dimmer); background: var(--nit-t); }
.cell-age { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }
/* A revealed archived row has to read as archived, or the filter looks
   broken: same row, dimmed, with the pill saying why it is normally absent. */
.rev-row.archived .rev-title { color: var(--fg-dim); }
.pill-archived { margin-left: 7px; color: var(--fg-dimmer); background: var(--nit-t); }

.sel-bar { display: flex; align-items: center; gap: 18px; background: var(--bg2); padding: 12px 20px; border-bottom: 1px solid var(--line); }
.sel-bar .who { font-size: 13px; font-weight: 600; color: var(--fg-hi); }
.sel-bar .sub { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); margin-top: 2px; }
.sel-count { text-align: center; font-size: 10.5px; color: var(--fg-dim); }
.sel-count b { display: block; font-size: 15px; font-weight: 600; font-family: var(--font-mono); }
.sel-count.you b { color: var(--sev-minor); }
.sel-count.author b { color: var(--fg-dim); }
.sel-count.closed b { color: var(--ok); }
.sel-bar .grow { flex: 1; }

.threads { padding: 8px 0 40px; }
.th-row { padding: 10px 20px; border-bottom: 1px solid var(--row); }
.th-head { display: flex; align-items: center; gap: 10px; cursor: pointer; }
.th-title { font-size: 12.5px; font-weight: 500; color: var(--fg-hi); flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.th-loc { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }
.th-body { margin-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.entry { padding: 9px 13px; font-size: 12.5px; line-height: 1.6; color: var(--fg); }
.entry-label { font-family: var(--font-mono); font-size: 9.5px; text-transform: uppercase; letter-spacing: .07em; margin-bottom: 4px; }
.entry-you { border-left: 2px solid var(--accent); background: var(--sel-soft); }
.entry-you .entry-label { color: var(--accent); }
.entry-author { border-left: 2px solid var(--sev-minor); background: var(--sev-minor-t); }
.entry-author .entry-label { color: var(--sev-minor); }
.entry-agent { border-left: 2px solid var(--agent); background: var(--agent-f); }
.entry-agent .entry-label { color: var(--agent); }
.stale-note { font-size: 11.5px; color: var(--sev-major); }
.closed-note { font-size: 11.5px; color: var(--ok); display: flex; gap: 12px; align-items: center; }
.th-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.btn-agent { background: none; border: 1px solid var(--agent-b); color: var(--agent); }
.btn-agent:hover { background: var(--agent-t); }
.reply-row { display: flex; gap: 8px; align-items: center; flex: 1; }
.empty { text-align: center; padding: 70px 20px; color: var(--fg-dim); font-size: 12.5px; }
.empty .btn { margin-top: 14px; }

/* Loading-skeleton sizes (issue #39), sized by a class here, not a style
   attribute: this page's CSP authorises nonce'd style elements only, and a
   nonce never covers a style attribute, so the bars rendered at zero size
   (issue #45). */
.skel-title { width: 130px; height: 12px; }
.skel-meta { width: 150px; height: 10px; margin-top: 4px; }
.skel-badge { width: 90px; height: 18px; }
.skel-count { width: 60px; height: 14px; }
${MARKDOWN_CSS}
`;

function threadRow(t: PostedThreadView, expanded: boolean, opinion: string | undefined, now: number, vocabulary: Vocabulary, draft: string): string {
  const chip = STATUS_CHIP[t.status];
  const open = t.status !== 'resolved' && t.status !== 'conceded';
  return `<div class="th-row" data-thread="${e(t.threadId)}">
    <div class="th-head" data-toggle="${e(t.threadId)}">
      ${t.severity ? `<span class="sev sev-${e(t.severity)}">${e(t.severity)}</span>` : ''}
      <span class="th-title">${e(t.title)}</span>
      ${t.file ? `<span class="th-loc">${e(t.file)}${t.line !== undefined ? `:${e(String(t.line))}` : ''}</span>` : ''}
      <span class="pill ${chip.cls}">${e(chip.label)}</span>
    </div>
    ${
      expanded
        ? `<div class="th-body">
      <div class="entry entry-you md"><div class="entry-label">you · posted comment</div>${renderMarkdown(t.yourBody)}</div>
      ${t.replies
        .map(
          // The entry class is chosen per reply, not fixed to .entry-author:
          // `replies` carries your own notes as well as theirs, and a reply of
          // yours rendered in the author's colour reads as the author
          // conceding your point back to you. .entry-you is the same treatment
          // the posted comment above gets, which is what makes the alternation
          // legible as a conversation.
          (r) => `<div class="entry md ${r.yours ? 'entry-you' : 'entry-author'}"><div class="entry-label">${r.yours ? 'you' : `@${e(r.author)}`} · ${e(formatAge(r.at, now))} ago</div>${renderMarkdown(r.body)}</div>`,
        )
        .join('')}
      ${t.status === 'stale' ? `<div class="stale-note">⚠ Line moved in new commits — ${e(vocabulary.platformName)} dropped the anchor.</div>` : ''}
      ${opinion ? `<div class="entry entry-agent"><div class="entry-label">agent · second opinion</div>${e(opinion)}</div>` : ''}
      ${
        open
          ? `<div class="th-actions">
        <button class="btn btn-agent" data-opinion="${e(t.threadId)}">Ask the agent</button>
        <button class="btn btn-ok" data-resolve="${e(t.threadId)}">Resolve thread</button>
        <button class="btn" data-concede="${e(t.threadId)}">Concede — they're right</button>
        <div class="reply-row">
          <input class="input" id="reply-input" data-reply="${e(t.threadId)}" value="${e(draft)}" placeholder="Reply…">
          <button class="btn" data-reply-send="${e(t.threadId)}">Send</button>
          <span class="kbd">↩</span>
        </div>
      </div>`
          : `<div class="closed-note">✓ ${e(t.closedBy ?? 'closed')}<button class="btn" data-reopen="${e(t.threadId)}">Re-open thread</button></div>`
      }
    </div>`
        : ''
    }
  </div>`;
}

/**
 * The `.head-right` tools. The archived filter carries its count in the
 * label even while it is off: an archived review has to read as one click
 * away, not as gone — that visibility is also what makes the `maxPages`
 * truncation in `buildPostedRows` survivable.
 */
function headTools(state: PostedViewState): string {
  return `<div class="head-right"><button class="tool ${state.showArchived ? 'active' : ''}" data-archived-filter aria-pressed="${state.showArchived}">Archived · ${state.archivedCount}</button> <button class="tool" id="pr-refresh">⟳ Refresh</button> <button class="tool" id="pr-back-dash">Dashboard</button></div>`;
}

/**
 * The list header and its rows (issue #39): the reply-total badge changes
 * with the fetch, so it lives here rather than outside the patched region —
 * a refresh must not leave a stale "N on you" count next to fresh rows.
 */
function postedRowsRegion(state: PostedViewState): string {
  if (state.loading) {
    // Every pending row renders, archived or not, and the header carries no
    // filter: `pendingRows` come from local history *before* the fetch that
    // says which change requests are still open, so nothing here could know
    // what is archived. Guessing would flicker a row out and back in; the
    // patch settles it a moment later instead.
    const rows = (state.pendingRows ?? [])
      .map(
        (row) => `<div class="rev-row">
        <div>
          <div class="rev-title">${e(row.refLabel)} · <span class="skel skel-title"></span></div>
          <div class="breakdown skel skel-meta"></div>
        </div>
        <div><span class="badge skel skel-badge"></span></div>
        <div class="rev-repo">${e(row.project)}</div>
        <div class="cell-age">${e(row.age)}</div>
      </div>`,
      )
      .join('');
    return `<header>
      <h1>Reviews you contributed to · ${e(state.podName)}</h1>
      <span class="on-you skel skel-count"></span>
      <div class="head-right"><button class="tool" id="pr-refresh">⟳ Refresh</button> <button class="tool" id="pr-back-dash">Dashboard</button></div>
    </header>
    <div class="thead"><div>${e(cap(state.vocabulary.changeRequestNoun))}</div><div>Threads</div><div>${e(cap(state.vocabulary.repoNoun))}</div><div>Age</div></div>
    ${rows}`;
  }
  if (state.rows.length === 0) {
    // Three ways to be empty and only one of them is "nothing submitted".
    // Rendering that copy over a history made entirely of archived reviews
    // is the lie this change exists to remove, so the other two say what the
    // filter is doing and hand back the way to see them.
    const head = state.showArchived || state.archivedCount > 0
      ? headTools(state)
      : `<div class="head-right"><button class="tool" id="pr-back-dash">Dashboard</button></div>`;
    const body = state.archivedCount > 0
      ? `Every review you submitted here is archived — each ${e(state.vocabulary.changeRequestNoun)} has since been merged or closed.<div><button class="btn" data-archived-filter>Show ${state.archivedCount} archived</button></div>`
      : state.showArchived
        ? 'Nothing submitted yet, archived included — run a review and submit it, then track the replies here.'
        : 'Nothing submitted yet — run a review and submit it, then track the replies here.';
    return `<header><h1>Reviews you contributed to · ${e(state.podName)}</h1>${head}</header>
         <div class="empty">${body}</div>`;
  }
  const selected = selectedPostedRow(state.rows, state.selectedRef);
  return `<header>
      <h1>Reviews you contributed to · ${e(state.podName)}</h1>
      <span class="on-you">${state.waitingOnYouTotal} on you</span>
      ${headTools(state)}
    </header>
    <div class="thead"><div>${e(cap(state.vocabulary.changeRequestNoun))}</div><div>Threads</div><div>${e(cap(state.vocabulary.repoNoun))}</div><div>Age</div></div>
    ${state.rows
      .map(
        // Addressed by ref, never by index: the visible set shrinks and grows
        // with the filter, so an index would point at a different review the
        // moment archived rows join or leave it.
        (row) => `<div class="rev-row ${row === selected ? 'selected' : ''}${row.archived ? ' archived' : ''}" data-repo="${e(row.view.repoId)}" data-number="${e(row.view.crNumber)}">
        <div>
          <div class="rev-title">${e(row.refLabel)} · ${e(row.title)}${row.archived ? '<span class="pill pill-archived">archived</span>' : ''}</div>
          <div class="breakdown">${row.view.counts.you} you · ${row.view.counts.author} author · ${row.view.counts.closed} closed</div>
        </div>
        <div>${
          row.view.counts.you > 0
            ? `<span class="badge badge-you">${row.view.counts.you} waiting on you</span>`
            : `<span class="badge badge-none">nothing on you</span>`
        }</div>
        <div class="rev-repo">${e(row.project)}</div>
        <div class="cell-age">${e(row.age)}</div>
      </div>`,
      )
      .join('')}`;
}

/** The selected review's thread panel (issue #39) — empty while nothing is selected, including throughout `loading`. */
function postedDetailRegion(state: PostedViewState): string {
  // The same resolution the list uses, from the same rows — the detail panel
  // must never render a review the list is not showing, or a resolve/reply
  // would land on a different change request than the one on screen.
  const selected = selectedPostedRow(state.rows, state.selectedRef);
  if (!selected) return '';
  return `<div class="sel-bar">
      <div>
        <div class="who">${e(selected.refLabel)} · ${e(selected.title)}${selected.archived ? '<span class="pill pill-archived">archived</span>' : ''}</div>
        <div class="sub">${e(selected.project)} · submitted ${e(selected.age)} ago · ${e(selected.view.agentLabel)}</div>
      </div>
      <div class="grow"></div>
      <div class="sel-count you"><b>${selected.view.counts.you}</b>waiting on you</div>
      <div class="sel-count author"><b>${selected.view.counts.author}</b>waiting on the author</div>
      <div class="sel-count closed"><b>${selected.view.counts.closed}</b>closed</div>
      <button class="btn" id="pr-rerun">Re-run agent on the fix</button>
    </div>
    <div class="threads">
      ${selected.view.threads
        .map((t) => threadRow(
          t,
          state.expandedThreadId === t.threadId,
          state.opinions[t.threadId],
          state.now,
          state.vocabulary,
          state.replyDrafts[replyDraftKey(selected.view.repoId, selected.view.crNumber, t.threadId)] ?? '',
        ))
        .join('')}
    </div>`;
}

/** Both patchable regions, from the same helpers the full page uses — one source of markup (issue #39). */
export function renderPostedReviewsRegions(state: PostedViewState): Record<string, string> {
  return { 'pr-rows': postedRowsRegion(state), 'pr-detail': postedDetailRegion(state) };
}

/**
 * Bound once on `document`, not per element (issue #39): a region patch
 * replaces `#pr-rows`/`#pr-detail`'s innerHTML wholesale, which would drop
 * any listener bound to an element inside them. Delegation means the patched
 * markup needs no re-binding at all.
 */
const SCRIPT = `
  const vscode = window.verdictVscode;
  const post = (m) => vscode.postMessage(m);
  // pr- prefixed ids (task 8.1): this screen and others coexist in one
  // resident shell document, where a bare #refresh / #back-dash / #rerun
  // would collide with the dashboard's and the review flow's controls — two
  // delegated listeners on one id means two messages per click, and both
  // panels understand 'refresh'/'rerun', so the action would run twice.
  document.addEventListener('click', (ev) => { if (ev.target.closest('#pr-refresh')) post({ type: 'refresh' }); });
  document.addEventListener('click', (ev) => { if (ev.target.closest('#pr-back-dash')) post({ type: 'backToDashboard' }); });
  document.addEventListener('click', (ev) => { if (ev.target.closest('#pr-rerun')) post({ type: 'rerun' }); });
  // An attribute, not an id like #refresh: the header tool and the
  // all-archived empty state's button are the same control rendered twice,
  // and two elements sharing one id is invalid. The extension owns the state
  // either way — the visible set decides which review is selected, so
  // filtering inside the page would leave the panel, the detail region and
  // the sidebar pointing at a row nobody can see.
  document.addEventListener('click', (ev) => { if (ev.target.closest('[data-archived-filter]')) post({ type: 'toggleArchived' }); });
  // The loading skeleton's rows are .rev-row too, so they look selectable —
  // but they carry no ref, because pendingRows are built before the fetch.
  // Guard it the way dashboardHtml's openMrRow already guards its own
  // skeleton rows (#39).
  const selectRevRow = (row) => {
    if (row.dataset.number === undefined) return;
    post({ type: 'selectReview', repoId: row.dataset.repo, number: row.dataset.number });
  };
  document.addEventListener('click', (ev) => {
    const row = ev.target.closest('.rev-row');
    if (row) selectRevRow(row);
  });
  // .th-head (data-toggle) and .th-body (the resolve/concede/opinion/reply
  // actions below) are SIBLINGS inside .th-row, not ancestor and descendant —
  // closest('[data-toggle]') starting from an action button never matches,
  // so it cannot also fire the toggle. Never widen this to '.th-row': that
  // would make the header and the actions the same delegation target and
  // reintroduce exactly the double-fire the stopPropagation() calls below
  // guard against.
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-toggle]');
    if (el) post({ type: 'toggleThread', threadId: el.dataset.toggle });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-resolve]');
    if (!el) return;
    ev.stopPropagation();
    post({ type: 'resolve', threadId: el.dataset.resolve, resolved: true });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-reopen]');
    if (!el) return;
    ev.stopPropagation();
    post({ type: 'resolve', threadId: el.dataset.reopen, resolved: false });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-concede]');
    if (!el) return;
    ev.stopPropagation();
    post({ type: 'concede', threadId: el.dataset.concede });
  });
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-opinion]');
    if (!el) return;
    ev.stopPropagation();
    post({ type: 'secondOpinion', threadId: el.dataset.opinion });
  });
  // Commits the in-progress text into the panel's held per-thread draft (task
  // 9.3) so a patch from acting on a DIFFERENT thread never overwrites what
  // this one is mid-typing, and so the panel's own clearing on a successful
  // send (below) has a real field to blank rather than guessing at one.
  // Debounced, not committed on every keystroke — 'change' (the previous
  // event) only fires on blur, which is what left mid-typing text nowhere
  // but the DOM; per-thread, not one shared timer, so switching to a
  // different thread mid-debounce cannot cancel a commit this one is still
  // waiting on.
  const replyDraftTimers = new Map();
  document.addEventListener('input', (ev) => {
    const el = ev.target.closest('[data-reply]');
    if (!el) return;
    const threadId = el.dataset.reply;
    clearTimeout(replyDraftTimers.get(threadId));
    const text = el.value;
    replyDraftTimers.set(threadId, setTimeout(() => {
      replyDraftTimers.delete(threadId);
      post({ type: 'replyDraft', threadId, text });
    }, 300));
  });
  // Land every pending draft before anything that can repaint this region.
  //
  // A debounce timer outliving the action that consumes it is how typed text
  // gets lost, and this screen's own local actions — expanding another
  // thread, toggling archived, selecting a different review — all patch
  // #pr-detail from the panel's held drafts without touching the platform.
  // Inside the 300ms window that patch re-renders the reply field from the
  // draft as it was BEFORE the last keystrokes, and REGIONS_SCRIPT never
  // restores the value, so those keystrokes are gone. Capture phase, so this
  // runs before the delegated handlers below; blur as well, because a
  // palette command or a click outside the webview never produces one here.
  const flushReplyDrafts = () => {
    for (const field of document.querySelectorAll('[data-reply]')) {
      const threadId = field.dataset.reply;
      if (!replyDraftTimers.has(threadId)) continue;
      clearTimeout(replyDraftTimers.get(threadId));
      replyDraftTimers.delete(threadId);
      post({ type: 'replyDraft', threadId, text: field.value });
    }
  };
  document.addEventListener('click', flushReplyDrafts, true);
  document.addEventListener('blur', flushReplyDrafts, true);
  window.addEventListener('blur', flushReplyDrafts);
  // One submit path for the key and the button — a single-line input has no
  // reason to require the ⌘/Ctrl chord (#33), and a chord is still exactly
  // an Enter keydown, so plain 'Enter' keeps both working with one check.
  // The input is never cleared here: a successful 'reply' clears the panel's
  // held draft for this thread (task 7.4b) before it patches #pr-detail, so
  // the value this re-render emits is genuinely empty rather than a DOM node
  // being blanked out from under the reviewer mid-keystroke. A failed send
  // leaves the held draft alone and patches nothing at all, so the typed text
  // stays exactly as it was, for a retry.
  function submitReply(input) {
    const text = input.value.trim();
    if (!text) return;
    // Cancel this thread's pending debounce commit before sending: without
    // this, a commit still in flight when the reply round-trip finishes can
    // land AFTER the host clears the draft on success, writing the
    // already-sent text back in — the next unrelated patch of this region
    // would then replay it as though it were never sent.
    clearTimeout(replyDraftTimers.get(input.dataset.reply));
    replyDraftTimers.delete(input.dataset.reply);
    post({ type: 'reply', threadId: input.dataset.reply, text });
  }
  document.addEventListener('keydown', (ev) => {
    const el = ev.target.closest('[data-reply]');
    if (el && ev.key === 'Enter') submitReply(el);
  });
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-reply-send]');
    if (!btn) return;
    ev.stopPropagation();
    const input = btn.closest('.reply-row')?.querySelector('[data-reply]');
    if (input) submitReply(input);
  });
`;

/** This screen's contribution to the resident shell (design D7, task 8.3). */
export const POSTED_REVIEWS_ROUTE: RouteAssets = { className: 'route-posted', css: CSS, script: SCRIPT };

export function renderPostedReviewsHtml(state: PostedViewState, nonce: string): string {
  const body = `<div id="pr-rows">${postedRowsRegion(state)}</div><div id="pr-detail">${postedDetailRegion(state)}</div>`;
  return renderPage({ title: 'Verdict: Posted reviews', nonce, css: CSS, body, script: SCRIPT, breadcrumb: { current: 'Posted reviews' }, routeClass: POSTED_REVIEWS_ROUTE.className });
}
