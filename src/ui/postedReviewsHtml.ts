/**
 * Posted reviews (spec/README.md §9) — pure renderer. Tracks author
 * replies across every review submitted in the pod.
 */
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import { formatAge } from './dashboardState';
import type { ThreadStatus } from '../domain/threadStatus';

import { escapeHtml as e, renderPage } from './theme';

export interface PostedRow {
  view: PostedReviewView;
  refLabel: string;
  title: string;
  project: string;
  age: string;
}

export interface PostedViewState {
  podName: string;
  now: number;
  waitingOnYouTotal: number;
  rows: PostedRow[];
  selectedIndex: number;
  expandedThreadId?: string;
  /** threadId → second-opinion text, appended on demand. */
  opinions: Record<string, string>;
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
.rev-project { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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

function threadRow(t: PostedThreadView, expanded: boolean, opinion: string | undefined, now: number): string {
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
      ${t.status === 'stale' ? `<div class="stale-note">⚠ Line moved in new commits — GitLab dropped the anchor.</div>` : ''}
      ${opinion ? `<div class="entry entry-agent"><div class="entry-label">agent · second opinion</div>${e(opinion)}</div>` : ''}
      ${
        open
          ? `<div class="th-actions">
        <button class="btn btn-agent" data-opinion="${e(t.threadId)}">Ask the agent</button>
        <button class="btn btn-ok" data-resolve="${e(t.threadId)}">Resolve thread</button>
        <button class="btn" data-concede="${e(t.threadId)}">Concede — they're right</button>
        <div class="reply-row"><input class="input" data-reply="${e(t.threadId)}" placeholder="Reply…"><span class="kbd">⌘↩</span></div>
      </div>`
          : `<div class="closed-note">✓ ${e(t.closedBy ?? 'closed')}<button class="btn" data-reopen="${e(t.threadId)}">Re-open thread</button></div>`
      }
    </div>`
        : ''
    }
  </div>`;
}

export function renderPostedReviewsHtml(state: PostedViewState, nonce: string): string {
  const selected = state.rows[state.selectedIndex];
  const body =
    state.rows.length === 0
      ? `<header><h1>Reviews you contributed to · ${e(state.podName)}</h1><div class="head-right"><button class="tool" id="back-dash">Dashboard</button></div></header>
         <div class="empty">Nothing submitted yet — run a review and submit it, then track the replies here.</div>`
      : `<header>
      <h1>Reviews you contributed to · ${e(state.podName)}</h1>
      <span class="on-you">${state.waitingOnYouTotal} on you</span>
      <div class="head-right"><button class="tool" id="refresh">⟳ Refresh</button> <button class="tool" id="back-dash">Dashboard</button></div>
    </header>
    <div class="thead"><div>Merge request</div><div>Threads</div><div>Project</div><div>Age</div></div>
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
        <div class="rev-project">${e(row.project)}</div>
        <div class="cell-age">${e(row.age)}</div>
      </div>`,
      )
      .join('')}
    ${
      selected
        ? `<div class="sel-bar">
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
        .map((t) => threadRow(t, state.expandedThreadId === t.threadId, state.opinions[t.threadId], state.now))
        .join('')}
    </div>`
        : ''
    }`;

  const script = `
    const vscode = acquireVsCodeApi();
    const post = (m) => vscode.postMessage(m);
    document.getElementById('refresh')?.addEventListener('click', () => post({ type: 'refresh' }));
    document.getElementById('back-dash')?.addEventListener('click', () => post({ type: 'backToDashboard' }));
    document.getElementById('rerun')?.addEventListener('click', () => post({ type: 'rerun' }));
    document.querySelectorAll('.rev-row').forEach((row) =>
      row.addEventListener('click', () => post({ type: 'selectReview', index: Number(row.dataset.index) })));
    document.querySelectorAll('[data-toggle]').forEach((el) =>
      el.addEventListener('click', () => post({ type: 'toggleThread', threadId: el.dataset.toggle })));
    document.querySelectorAll('[data-resolve]').forEach((el) =>
      el.addEventListener('click', (ev) => { ev.stopPropagation(); post({ type: 'resolve', threadId: el.dataset.resolve, resolved: true }); }));
    document.querySelectorAll('[data-reopen]').forEach((el) =>
      el.addEventListener('click', (ev) => { ev.stopPropagation(); post({ type: 'resolve', threadId: el.dataset.reopen, resolved: false }); }));
    document.querySelectorAll('[data-concede]').forEach((el) =>
      el.addEventListener('click', (ev) => { ev.stopPropagation(); post({ type: 'concede', threadId: el.dataset.concede }); }));
    document.querySelectorAll('[data-opinion]').forEach((el) =>
      el.addEventListener('click', (ev) => { ev.stopPropagation(); post({ type: 'secondOpinion', threadId: el.dataset.opinion }); }));
    document.querySelectorAll('[data-reply]').forEach((el) =>
      el.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && el.value.trim()) {
          post({ type: 'reply', threadId: el.dataset.reply, text: el.value });
          el.value = '';
        }
      }));
  `;

  return renderPage({ title: 'Verdict: Posted reviews', nonce, css: CSS, body, script });
}
