/**
 * Posted reviews (spec/README.md §9) — pure renderer. Tracks author
 * replies across every review submitted in the pod.
 */
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import { formatAge } from './dashboardState';
import type { ThreadStatus } from '../domain/threadStatus';

import { escapeHtml as e, renderPage } from './theme';
import { cap, type Vocabulary } from './vocab';

export interface PostedRow {
  view: PostedReviewView;
  refLabel: string;
  title: string;
  project: string;
  age: string;
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
  waitingOnYouTotal: number;
  rows: PostedRow[];
  selectedIndex: number;
  expandedThreadId?: string;
  /** threadId → second-opinion text, appended on demand. */
  opinions: Record<string, string>;
  /**
   * True while the initial fetch is still in flight (issue #39): `rows` is
   * empty and `pendingRows` — the local history cache, with no fetch
   * required — renders instead, title and counts standing in as skeletons.
   */
  loading?: boolean;
  pendingRows?: PostedPendingRow[];
}

export type PostedMessage =
  | { type: 'selectReview'; index: number }
  | { type: 'toggleThread'; threadId: string }
  | { type: 'resolve'; threadId: string; resolved: boolean }
  | { type: 'concede'; threadId: string }
  | { type: 'reply'; threadId: string; text: string }
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
`;

function threadRow(t: PostedThreadView, expanded: boolean, opinion: string | undefined, now: number, vocabulary: Vocabulary): string {
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
      <div class="entry entry-you"><div class="entry-label">you · posted comment</div>${e(t.yourBody)}</div>
      ${t.replies
        .map(
          (r) => `<div class="entry entry-author"><div class="entry-label">@${e(r.author)} · ${e(formatAge(r.at, now))} ago</div>${e(r.body)}</div>`,
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
          <input class="input" data-reply="${e(t.threadId)}" placeholder="Reply…">
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
 * The list header and its rows (issue #39): the reply-total badge changes
 * with the fetch, so it lives here rather than outside the patched region —
 * a refresh must not leave a stale "N on you" count next to fresh rows.
 */
function postedRowsRegion(state: PostedViewState): string {
  if (state.loading) {
    const rows = (state.pendingRows ?? [])
      .map(
        (row) => `<div class="rev-row">
        <div>
          <div class="rev-title">${e(row.refLabel)} · <span class="skel" style="width:130px;height:12px"></span></div>
          <div class="breakdown skel" style="width:150px;height:10px;margin-top:4px"></div>
        </div>
        <div><span class="badge skel" style="width:90px;height:18px"></span></div>
        <div class="rev-repo">${e(row.project)}</div>
        <div class="cell-age">${e(row.age)}</div>
      </div>`,
      )
      .join('');
    return `<header>
      <h1>Reviews you contributed to · ${e(state.podName)}</h1>
      <span class="on-you skel" style="width:60px;height:14px"></span>
      <div class="head-right"><button class="tool" id="refresh">⟳ Refresh</button> <button class="tool" id="back-dash">Dashboard</button></div>
    </header>
    <div class="thead"><div>${e(cap(state.vocabulary.changeRequestNoun))}</div><div>Threads</div><div>${e(cap(state.vocabulary.repoNoun))}</div><div>Age</div></div>
    ${rows}`;
  }
  if (state.rows.length === 0) {
    return `<header><h1>Reviews you contributed to · ${e(state.podName)}</h1><div class="head-right"><button class="tool" id="back-dash">Dashboard</button></div></header>
         <div class="empty">Nothing submitted yet — run a review and submit it, then track the replies here.</div>`;
  }
  return `<header>
      <h1>Reviews you contributed to · ${e(state.podName)}</h1>
      <span class="on-you">${state.waitingOnYouTotal} on you</span>
      <div class="head-right"><button class="tool" id="refresh">⟳ Refresh</button> <button class="tool" id="back-dash">Dashboard</button></div>
    </header>
    <div class="thead"><div>${e(cap(state.vocabulary.changeRequestNoun))}</div><div>Threads</div><div>${e(cap(state.vocabulary.repoNoun))}</div><div>Age</div></div>
    ${state.rows
      .map(
        (row, index) => `<div class="rev-row ${index === state.selectedIndex ? 'selected' : ''}" data-index="${index}">
        <div>
          <div class="rev-title">${e(row.refLabel)} · ${e(row.title)}</div>
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
  const selected = state.rows[state.selectedIndex];
  if (!selected) return '';
  return `<div class="sel-bar">
      <div>
        <div class="who">${e(selected.refLabel)} · ${e(selected.title)}</div>
        <div class="sub">${e(selected.project)} · submitted ${e(selected.age)} ago · ${e(selected.view.agentLabel)}</div>
      </div>
      <div class="grow"></div>
      <div class="sel-count you"><b>${selected.view.counts.you}</b>waiting on you</div>
      <div class="sel-count author"><b>${selected.view.counts.author}</b>waiting on the author</div>
      <div class="sel-count closed"><b>${selected.view.counts.closed}</b>closed</div>
      <button class="btn" id="rerun">Re-run agent on the fix</button>
    </div>
    <div class="threads">
      ${selected.view.threads
        .map((t) => threadRow(t, state.expandedThreadId === t.threadId, state.opinions[t.threadId], state.now, state.vocabulary))
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
  document.addEventListener('click', (ev) => { if (ev.target.closest('#refresh')) post({ type: 'refresh' }); });
  document.addEventListener('click', (ev) => { if (ev.target.closest('#back-dash')) post({ type: 'backToDashboard' }); });
  document.addEventListener('click', (ev) => { if (ev.target.closest('#rerun')) post({ type: 'rerun' }); });
  document.addEventListener('click', (ev) => {
    const row = ev.target.closest('.rev-row');
    if (row) post({ type: 'selectReview', index: Number(row.dataset.index) });
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
  // One submit path for the key and the button — a single-line input has no
  // reason to require the ⌘/Ctrl chord (#33), and a chord is still exactly
  // an Enter keydown, so plain 'Enter' keeps both working with one check.
  // The input is never cleared here: on success 'reply' round-trips into a
  // refresh(), which patches #pr-detail with a freshly-built (and so blank)
  // field — or, before the page has signalled ready, replaces the whole
  // document, same result; on failure nothing re-renders and the typed text
  // stays put for a retry, instead of vanishing with the failed send.
  function submitReply(input) {
    const text = input.value.trim();
    if (!text) return;
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

export function renderPostedReviewsHtml(state: PostedViewState, nonce: string): string {
  const body = `<div id="pr-rows">${postedRowsRegion(state)}</div><div id="pr-detail">${postedDetailRegion(state)}</div>`;
  return renderPage({ title: 'Verdict: Posted reviews', nonce, css: CSS, body, script: SCRIPT, breadcrumb: { current: 'Posted reviews' } });
}
