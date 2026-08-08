/**
 * Pod dashboard (spec/README.md §2) — pure HTML, no `vscode` import.
 * Layout, spacing, type scale and copy follow the POC exactly; colors are
 * the design-system tokens (theme variables with Dark+ fallbacks).
 *
 * Glyph note: the POC's few Unicode glyphs (◈ ✕ ✓ ⚑ ◔ ▼ ⟳) are kept inside
 * webviews as designed — native chrome (sidebar, status bar) uses Codicons.
 */
import type { CiStatus } from '../platform/types';
import { escapeHtml, renderPage } from './theme';

export { escapeHtml };

export type RowScope = 'you' | 'them' | 'none';

export interface DashboardRow {
  repoId: string;
  number: string;
  refLabel: string;
  title: string;
  author: string;
  branch: string;
  project: string;
  scope: RowScope;
  ai: { label: string; cls: 'pill-warn' | 'pill-bad' | 'pill-ok' | 'pill-agent' | 'pill' };
  submitted: boolean;
  ciStatus?: CiStatus;
  age: string;
}

export interface DashboardIssueRow {
  title: string;
  project: string;
  assignee: string;
  milestone: string;
  age: string;
}

export interface ActivityEntry {
  glyph: '✕' | '◈' | '✓' | '⚑';
  cls: 'bad' | 'agent-fg' | 'ok' | 'warn';
  text: string;
  meta: string;
}

export interface DashboardPipelineRow {
  id: string;
  status: CiStatus;
  job: string;
  age: string;
}

export interface DashboardViewState {
  podName: string;
  meta: string;
  scopeCounts: { you: number; them: number };
  stats: {
    waitingOnYou: number;
    aiCoverage: { reviewed: number; total: number };
    pipelinesFailing: number;
    projectsInPod: number;
  };
  fetchedAgo: string;
  podOptions?: Array<{ id: string; name: string; active: boolean; meta: string }>;
  projects: Array<{ id: string; label: string; count: number }>;
  changesets?: Array<{
    id: string;
    name: string;
    memberCount: number;
    projectCount: number;
    state: string;
    stateClass: 'pill-bad' | 'pill-warn' | 'pill-ok';
  }>;
  rows: DashboardRow[];
  issues: DashboardIssueRow[];
  activity: ActivityEntry[];
  pipelines: DashboardPipelineRow[];
}

/** The webview → extension message contract. */
export type DashboardMessage =
  | { type: 'refresh' }
  | { type: 'openCr'; repoId: string; number: string; submitted: boolean }
  | { type: 'openChangeset'; changesetId: string }
  | { type: 'newChangeset' }
  | { type: 'switchPod' }
  | { type: 'selectPod'; podId: string }
  | { type: 'addProjects' }
  | { type: 'filters' };

/** Script-free page for error / no-pod states, with the same strict CSP. */
export function renderFallbackHtml(messageHtml: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none';">
<title>Verdict: Dashboard</title>
</head>
<body>${messageHtml}</body>
</html>`;
}

const CI_TEXT: Record<CiStatus, { label: string; cls: string }> = {
  success: { label: 'passed', cls: 'ok' },
  failed: { label: 'failed', cls: 'bad' },
  running: { label: 'running', cls: 'info' },
  pending: { label: 'pending', cls: 'dimmer' },
  canceled: { label: 'canceled', cls: 'dimmer' },
  none: { label: '—', cls: 'dimmer' },
};

const CSS = `
header { position: relative; display: flex; align-items: center; gap: 14px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
.pod-wrap { position: relative; display: inline-flex; align-items: center; }
.pod-switch { display: flex; align-items: baseline; gap: 8px; cursor: pointer; background: none; border: none; color: var(--fg); font-family: var(--font-ui); padding: 0; }
.pod-switch h1 { font-size: 14px; font-weight: 600; color: var(--fg-hi); }
.pod-switch .meta { font-size: 11px; color: var(--fg-dim); }
.pod-switch .caret { font-size: 9px; color: var(--fg-dimmer); }
.pod-menu { position: absolute; top: calc(100% + 8px); left: 0; min-width: 260px; background: var(--bg3); border: 1px solid var(--line2); border-radius: 6px; box-shadow: 0 10px 28px rgba(0,0,0,.5); padding: 6px; z-index: 25; }
.pod-menu[hidden] { display: none; }
.pod-option { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: none; background: none; color: var(--fg); font-family: var(--font-ui); font-size: 12px; border-radius: 4px; cursor: pointer; text-align: left; }
.pod-option:hover { background: var(--hover); }
.pod-option.active { background: var(--sel); color: var(--fg-hi); }
.pod-option .meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dim); }
.pod-option .check { color: var(--accent); font-size: 11px; width: 12px; text-align: center; }
.scope { display: inline-flex; background: var(--bg3); border-radius: 5px; padding: 2px; gap: 2px; }
.scope button { border: none; background: none; color: var(--fg-dim); font-size: 11px; font-family: var(--font-ui); padding: 4px 10px; border-radius: 4px; cursor: pointer; }
.scope button.active { background: var(--accent); color: var(--accent-fg); }
.head-right { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.head-right .tool { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); border: 1px solid var(--line2); border-radius: 4px; background: none; padding: 4px 9px; cursor: pointer; }
.head-right .tool:hover { background: var(--hover); }

.stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); }
.stat { background: var(--bg); padding: 14px 20px; }
.stat-label { font-size: 11px; color: var(--fg-dim); }
.stat-value { font-size: 27px; font-weight: 600; font-family: var(--font-mono); color: var(--fg-hi); margin: 2px 0; }
.stat-note { font-size: 11px; color: var(--fg-dimmer); }

.split { display: grid; grid-template-columns: 2.4fr 1fr; align-items: start; }
.col-right { border-left: 1px solid var(--line); min-height: 100%; }
section { padding: 16px 0 6px; }
.section-pad { padding: 0 20px 8px; }
.chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 20px 10px; }
.chips .chip { padding: 4px 10px; }
.changeset-grid { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; padding: 0 20px 12px; }
.changeset-card { display: grid; grid-template-columns: 22px minmax(0,1fr) auto; gap: 9px; align-items: center; border: 1px solid var(--line2); border-radius: 6px; background: var(--card); padding: 11px 12px; color: var(--fg); cursor: pointer; text-align: left; font-family: var(--font-ui); }
.changeset-card:hover { border-color: var(--agent); background: var(--bg3); }
.changeset-glyph { color: var(--agent); font-size: 16px; }
.changeset-card .row-title, .changeset-card .row-meta { display: block; }
.new-changeset { float: right; border: 0; background: none; color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); cursor: pointer; padding: 0; }
.new-changeset:hover { color: var(--accent); }
.changeset-empty { padding: 0 20px 12px; color: var(--fg-dimmer); font-size: 11.5px; }

.thead, .mr-row, .issue-row { display: grid; grid-template-columns: minmax(0,1fr) 108px 104px 84px 58px; gap: 10px; padding: 0 20px; align-items: center; }
.thead { font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .09em; color: var(--fg-dimmer); padding-bottom: 6px; }
.mr-row, .issue-row { padding-top: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--row); }
.mr-row { cursor: pointer; }
.mr-row:hover, .mr-row:focus { background: var(--bg3); outline: none; }
.mr-row[hidden], .chip[hidden] { display: none; }
.issue-empty { color: var(--fg-dim); font-size: 12px; }
.row-title { font-size: 12.5px; font-weight: 500; color: var(--fg-hi); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.row-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); margin-top: 3px; }
.cell-project { font-family: var(--font-mono); font-size: 11px; color: var(--fg-dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell-ci { font-family: var(--font-mono); font-size: 11px; font-weight: 500; }
.cell-age { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); }

.activity-row { display: flex; gap: 10px; padding: 8px 20px; align-items: flex-start; }
.activity-glyph { font-family: var(--font-mono); font-size: 13px; flex: none; }
.activity-text { font-size: 12px; line-height: 1.45; color: var(--fg); }
.activity-meta { font-family: var(--font-mono); font-size: 10.5px; color: var(--fg-dimmer); margin-top: 2px; }
.pipe-row { display: flex; gap: 12px; padding: 7px 20px; align-items: baseline; font-family: var(--font-mono); font-size: 11px; }

.empty { text-align: center; padding: 70px 20px; }
.empty h2 { font-size: 16px; font-weight: 600; color: var(--fg-hi); margin-bottom: 8px; }
.empty p { font-size: 12.5px; color: var(--fg-dim); margin-bottom: 18px; }
.empty .btn { margin: 0 4px; }
`;

export function renderDashboardHtml(state: DashboardViewState, nonce: string): string {
  const e = escapeHtml;
  const empty = state.rows.length === 0;

  const podOptions = (state.podOptions ?? []).map((pod) => `
      <button class="pod-option ${pod.active ? 'active' : ''}" type="button" data-pod-id="${e(pod.id)}">
        <span>${e(pod.name)}</span>
        <span class="meta">${e(pod.meta)}</span>
        <span class="check">${pod.active ? '✓' : ''}</span>
      </button>`).join('');

  const header = `
  <header>
    <div class="pod-wrap">
      <button class="pod-switch" id="pod-switch" title="Switch pod" type="button">
        <h1>${e(state.podName)}</h1>
        <span class="meta">${e(state.meta)}</span>
        <span class="caret">▼</span>
      </button>
      <div class="pod-menu" data-pod-menu hidden>
        ${podOptions}
      </div>
    </div>
    ${
      empty
        ? ''
        : `<div class="scope" id="scope">
      <button class="active" data-scope="all">All</button>
      <button data-scope="you">Waiting on you · ${state.scopeCounts.you}</button>
      <button data-scope="them">Waiting on them · ${state.scopeCounts.them}</button>
    </div>`
    }
    <div class="head-right">
      <button class="tool" id="refresh" title="Refresh">⟳ ${e(state.fetchedAgo)}</button>
      <button class="tool" id="filters">Filters</button>
    </div>
  </header>`;

  const statCards = [
    {
      label: 'Waiting on you',
      value: String(state.stats.waitingOnYou),
      valueCls: '',
      note: state.stats.waitingOnYou > 0 ? `${state.stats.waitingOnYou} need your reply` : 'all clear',
      noteCls: state.stats.waitingOnYou > 0 ? 'warn' : 'dimmer',
    },
    {
      label: 'AI review coverage',
      value: `${state.stats.aiCoverage.reviewed}/${state.stats.aiCoverage.total}`,
      valueCls: 'ok',
      note: 'open MRs reviewed',
      noteCls: 'dimmer',
    },
    {
      label: 'Pipelines failing',
      value: String(state.stats.pipelinesFailing),
      valueCls: state.stats.pipelinesFailing > 0 ? 'bad' : '',
      note: state.stats.pipelinesFailing > 0 ? 'blocking merges' : 'all green',
      noteCls: state.stats.pipelinesFailing > 0 ? 'bad' : 'dimmer',
    },
    { label: 'Projects in pod', value: String(state.stats.projectsInPod), valueCls: '', note: 'watched', noteCls: 'dimmer' },
  ]
    .map(
      (c) => `<div class="stat">
        <div class="stat-label">${e(c.label)}</div>
        <div class="stat-value ${c.valueCls}">${e(c.value)}</div>
        <div class="stat-note ${c.noteCls}">${e(c.note)}</div>
      </div>`,
    )
    .join('');

  const chips = [
    `<button class="chip active" data-project="*">All projects · ${state.rows.length}</button>`,
    ...state.projects
      .filter((p) => p.count > 0)
      .map((p) => `<button class="chip" data-project="${e(p.id)}">${e(p.label)} · ${p.count}</button>`),
  ].join('');

  const changesetCards = (state.changesets ?? []).map((changeset) => `
    <button class="changeset-card" data-changeset="${e(changeset.id)}">
      <span class="changeset-glyph">⧉</span>
      <span><span class="row-title">${e(changeset.name)}</span><span class="row-meta">${changeset.memberCount} MRs · ${changeset.projectCount} projects</span></span>
      <span class="pill ${changeset.stateClass}">${e(changeset.state)}</span>
    </button>`).join('');

  const mrRows = state.rows
    .map(
      (r) => `
      <div class="mr-row" data-project="${e(r.repoId)}" data-scope="${r.scope}" data-number="${e(r.number)}" data-submitted="${r.submitted}" tabindex="0">
        <div>
          <div class="row-title">${e(r.title)}</div>
          <div class="row-meta">${e(r.refLabel)} · @${e(r.author)} · ${e(r.branch)}</div>
        </div>
        <div class="cell-project">${e(r.project)}</div>
        <div><span class="pill ${r.ai.cls}">${e(r.ai.label)}</span></div>
        <div class="cell-ci ${r.ciStatus ? CI_TEXT[r.ciStatus].cls : 'dimmer'}">${r.ciStatus ? CI_TEXT[r.ciStatus].label : '—'}</div>
        <div class="cell-age">${e(r.age)}</div>
      </div>`,
    )
    .join('');

  const issueRows = state.issues
    .map(
      (i) => `
      <div class="issue-row">
        <div class="row-title">${e(i.title)}</div>
        <div class="cell-project">${e(i.project)}</div>
        <div class="cell-project">${e(i.assignee)}</div>
        <div class="cell-project">${e(i.milestone)}</div>
        <div class="cell-age">${e(i.age)}</div>
      </div>`,
    )
    .join('');

  const activityRows = state.activity
    .map(
      (a) => `
      <div class="activity-row">
        <span class="activity-glyph ${a.cls}">${a.glyph}</span>
        <div>
          <div class="activity-text">${e(a.text)}</div>
          <div class="activity-meta">${e(a.meta)}</div>
        </div>
      </div>`,
    )
    .join('');

  const pipelineRows = state.pipelines
    .map(
      (p) => `
      <div class="pipe-row">
        <span class="${CI_TEXT[p.status].cls}">${p.status === 'failed' ? '✕' : p.status === 'success' ? '✓' : '◔'}</span>
        <span>#${e(p.id)}</span>
        <span class="dimmer">${e(p.job)}</span>
        <span class="dimmer">${e(p.age)}</span>
      </div>`,
    )
    .join('');

  const body = empty
    ? `${header}
       <div class="empty">
         <h2>Nothing waiting on you</h2>
         <p>${e(state.podName)} watches ${state.stats.projectsInPod} projects and none of them have open merge requests.</p>
         <button class="btn btn-accent" id="add-projects">Add projects to this pod</button>
         <button class="btn" id="switch-pod-empty">Switch pod</button>
       </div>`
    : `${header}
       <div class="stats">${statCards}</div>
       <div class="split">
         <div>
           <section><div class="section-label section-pad">Changesets <span class="dimmer">· merge requests that ship together</span><button class="new-changeset" id="new-changeset">+ new</button></div>${changesetCards ? `<div class="changeset-grid">${changesetCards}</div>` : '<div class="changeset-empty">Nothing detected — group merge requests with a shared trailer or branch, or pick them by hand.</div>'}</section>
           <section>
             <div class="section-label section-pad">Merge requests</div>
             <div class="chips">${chips}</div>
             <div class="thead"><div>Title</div><div>Project</div><div>AI review</div><div>Pipeline</div><div>Age</div></div>
             ${mrRows}
           </section>
           <section>
             <div class="section-label section-pad">Issues · in progress</div>
             ${state.issues.length > 0 ? issueRows : '<div class="issue-row issue-empty">No issues in progress</div>'}
           </section>
         </div>
         <div class="col-right">
           ${
             state.activity.length > 0
               ? `<section><div class="section-label section-pad">Activity</div>${activityRows}</section>`
               : ''
           }
           ${
             state.pipelines.length > 0
               ? `<section><div class="section-label section-pad">Pipelines · last 3</div>${pipelineRows}</section>`
               : ''
           }
         </div>
       </div>`;

  const script = `
    const vscode = window.verdictVscode;
    const post = (m) => vscode.postMessage(m);
    const podMenu = document.querySelector('[data-pod-menu]');
    const togglePodMenu = () => {
      if (!podMenu) return;
      const open = podMenu.hasAttribute('hidden');
      podMenu.toggleAttribute('hidden', !open);
    };

    document.getElementById('refresh')?.addEventListener('click', () => post({ type: 'refresh' }));
    document.getElementById('filters')?.addEventListener('click', () => post({ type: 'filters' }));
    document.getElementById('pod-switch')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      togglePodMenu();
    });
    document.getElementById('switch-pod-empty')?.addEventListener('click', () => post({ type: 'switchPod' }));
    document.getElementById('add-projects')?.addEventListener('click', () => post({ type: 'addProjects' }));
    document.querySelectorAll('[data-pod-id]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const podId = btn.dataset.podId;
        if (podId) post({ type: 'selectPod', podId });
        if (podMenu) podMenu.setAttribute('hidden', '');
      });
    });
    document.addEventListener('click', (ev) => {
      if (!podMenu || podMenu.hasAttribute('hidden')) return;
      if (ev.target instanceof Node && !ev.target.closest('.pod-wrap')) {
        podMenu.setAttribute('hidden', '');
      }
    });

    let scopeSel = 'all';
    let projectSel = '*';
    const applyFilters = () => {
      const counts = new Map();
      for (const row of document.querySelectorAll('.mr-row')) {
        const scopeOk = scopeSel === 'all' || row.dataset.scope === scopeSel;
        if (scopeOk) counts.set(row.dataset.project, (counts.get(row.dataset.project) ?? 0) + 1);
        row.hidden = !(scopeOk && (projectSel === '*' || row.dataset.project === projectSel));
      }
      for (const chip of document.querySelectorAll('.chip[data-project]')) {
        if (chip.dataset.project === '*') continue;
        chip.hidden = scopeSel !== 'all' && !counts.has(chip.dataset.project);
      }
    };
    document.getElementById('scope')?.addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-scope]');
      if (!btn) return;
      document.querySelectorAll('#scope button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      scopeSel = btn.dataset.scope;
      applyFilters();
      // If the selected project has no rows under the new scope, fall back
      // to All projects instead of leaving the table blank.
      const activeChip = document.querySelector('.chip[data-project="' + projectSel + '"]');
      if (projectSel !== '*' && activeChip?.hidden) {
        projectSel = '*';
        document.querySelectorAll('.chip[data-project]').forEach((c) => c.classList.remove('active'));
        document.querySelector('.chip[data-project="*"]')?.classList.add('active');
        applyFilters();
      }
    });
    for (const chip of document.querySelectorAll('.chip[data-project]')) {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip[data-project]').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        projectSel = chip.dataset.project;
        applyFilters();
      });
    }
    for (const row of document.querySelectorAll('.mr-row')) {
      const open = () => post({ type: 'openCr', repoId: row.dataset.project, number: row.dataset.number, submitted: row.dataset.submitted === 'true' });
      row.addEventListener('click', open);
      row.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') open(); });
    }
    document.querySelectorAll('[data-changeset]').forEach((card) => card.addEventListener('click', () => post({ type: 'openChangeset', changesetId: card.dataset.changeset })));
    document.getElementById('new-changeset')?.addEventListener('click', () => post({ type: 'newChangeset' }));
  `;

  return renderPage({ title: 'Verdict: Dashboard', nonce, css: CSS, body, script });
}
