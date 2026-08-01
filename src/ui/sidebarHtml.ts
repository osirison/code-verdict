import { renderPage, escapeHtml } from './theme';

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
  verdict?: 'accepted' | 'rejected' | 'skipped';
  selected: boolean;
}

export interface SidebarActiveReview {
  headline: string;
  context: string;
  agent: string;
  added: number;
  removed: number;
  counts: { accepted: number; rejected: number; skipped: number; undecided: number };
  items: SidebarReviewItem[];
}

export interface SidebarViewState {
  podName: string;
  podMeta: string;
  pods: SidebarPod[];
  mergeRequests: SidebarMergeRequest[];
  issues: SidebarIssue[];
  waitingOnYou: number;
  activeReview?: SidebarActiveReview;
  activeRoute?: string;
}

export type SidebarMessage =
  | { type: 'refresh' }
  | { type: 'selectPod'; podId: string }
  | { type: 'openDashboard' }
  | { type: 'openPostedReviews' }
  | { type: 'openTuning' }
  | { type: 'openSettings' }
  | { type: 'selectFinding'; itemId: string }
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
.finding { display: grid; grid-template-columns: 8px minmax(0,1fr) auto; gap: 7px; width: 100%; padding: 8px 11px; border: 0; background: none; color: var(--fg); text-align: left; cursor: pointer; }
.finding:hover { background: var(--hover); }
.finding.selected { background: var(--sel); }
.finding[hidden] { display: none; }
.finding-dot { width: 7px; height: 7px; margin-top: 4px; border-radius: 50%; background: var(--fg-dimmer); }
.finding-dot.blocker { background: var(--sev-blocker); }
.finding-dot.major { background: var(--sev-major); }
.finding-dot.minor { background: var(--sev-minor); }
.finding-title { display: block; overflow: hidden; color: var(--fg-hi); font: 500 11.5px/1.3 var(--font-ui); text-overflow: ellipsis; white-space: nowrap; }
.finding-file { display: block; margin-top: 2px; overflow: hidden; color: var(--fg-dimmer); font: 9.5px/1.3 var(--font-mono); text-overflow: ellipsis; white-space: nowrap; }
.finding-verdict { color: var(--fg-dim2); font: 10px/1 var(--font-mono); }
.finding-verdict.accepted { color: var(--ok); }
.finding-verdict.rejected { color: var(--sev-blocker); }
.foot { margin-top: auto; border-top: 1px solid var(--line); padding: 10px 12px; color: var(--fg-dimmer); font: 10.5px/1.4 var(--font-mono); }
`;

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
  const reviewTree = activeReview?.items.map((item) => `<button class="finding ${item.selected ? 'selected' : ''}" data-finding="${e(item.id)}" data-verdict="${e(item.verdict ?? 'undecided')}">
    <span class="finding-dot ${item.severity}"></span><span><span class="finding-title">${e(item.title)}</span><span class="finding-file">${e(item.file)}</span></span><span class="finding-verdict ${item.verdict ?? ''}">${item.verdict === 'accepted' ? '✓' : item.verdict === 'rejected' ? '×' : item.verdict === 'skipped' ? '−' : '·'}</span>
  </button>`).join('') ?? '';
  const reviewSection = activeReview ? `<section>
    <div class="review-context"><div class="review-context-head"><span class="review-mark">!</span><span><span class="review-context-title">${e(activeReview.headline)}</span><span class="review-context-meta">${e(activeReview.context)} · <span class="ok">+${activeReview.added}</span> · <span class="bad">−${activeReview.removed}</span></span></span></div>
    <div class="review-agent"><span>Agent · <span class="agent-fg">${e(activeReview.agent)}</span></span><span>${decided}/${activeReview.items.length}</span></div>
    <div class="progress"><span class="progress-accepted" style="width:${progressWidth(activeReview.counts.accepted)}%"></span><span class="progress-rejected" style="width:${progressWidth(activeReview.counts.rejected)}%"></span><span class="progress-skipped" style="width:${progressWidth(activeReview.counts.skipped)}%"></span></div>
    <div class="review-counts"><span class="ok">${activeReview.counts.accepted} acc</span><span class="bad">${activeReview.counts.rejected} rej</span><span>${activeReview.counts.skipped} skip</span><span class="left">${activeReview.counts.undecided} left</span></div></div>
    <div class="review-filters"><button class="review-filter active" data-review-filter="all">All</button><button class="review-filter" data-review-filter="undecided">Open</button><button class="review-filter" data-review-filter="accepted">Accepted</button><button class="review-filter" data-review-filter="rejected">Rejected</button></div>
    <div class="list">${reviewTree}</div>
  </section>` : '';

  const body = `<main class="side">
    <header class="head"><span class="brand">Verdict</span><span class="head-tools"><button class="icon-btn" id="refresh" title="Refresh">⟳</button><span>⋯</span></span></header>
    <nav class="nav" aria-label="Verdict navigation">
      <button class="nav-row ${state.activeRoute === 'dashboard' ? 'active' : ''}" id="dashboard"><span class="nav-glyph">▦</span><span class="nav-label">Pod dashboard</span><span class="nav-count">${state.mergeRequests.length}</span></button>
      <button class="nav-row ${state.activeRoute === 'posted' ? 'active' : ''}" id="posted-reviews"><span class="nav-glyph">◍</span><span class="nav-label">Posted reviews</span><span class="nav-count">${state.waitingOnYou}</span></button>
      <button class="nav-row ${state.activeRoute === 'tuning' ? 'active' : ''}" id="tuning"><span class="nav-glyph">◔</span><span class="nav-label">Agent tuning</span></button>
      <button class="nav-row ${state.activeRoute === 'settings' ? 'active' : ''}" id="settings"><span class="nav-glyph">⚙</span><span class="nav-label">Settings</span></button>
    </nav>
    <div class="divider"></div>
    <div class="section">Pods</div><div class="pod-list">${podRows}</div>
    ${activeReview ? reviewSection : `<div class="divider"></div><div class="section">Merge requests</div><div class="list">${mergeRequestRows}</div><div class="divider"></div><div class="section">Issues · in progress</div><div class="list">${issueRows}</div>`}
    <footer class="foot">${e(state.podName)} · ${e(state.podMeta)}</footer>
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
    document.querySelectorAll('[data-review-filter]').forEach((button) => button.addEventListener('click', () => {
      document.querySelectorAll('[data-review-filter]').forEach((candidate) => candidate.classList.remove('active'));
      button.classList.add('active');
      document.querySelectorAll('[data-finding]').forEach((row) => { row.hidden = button.dataset.reviewFilter !== 'all' && row.dataset.verdict !== button.dataset.reviewFilter; });
    }));
  `;

  return renderPage({ title: 'Verdict', nonce, css: CSS, body, script, embedded: true });
}