/**
 * Pure HTML for the pod dashboard webview (spec §2, first working pass —
 * full fidelity tracked in issue #8). No `vscode` import: unit-testable.
 * Colors come from VS Code theme variables, never hex (spec rule).
 */
import type { CiStatus } from '../platform/types';

export interface DashboardRow {
  repoId: string;
  number: string;
  refLabel: string;
  title: string;
  author: string;
  branch: string;
  project: string;
  aiState: string;
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

export interface DashboardPipelineRow {
  id: string;
  status: CiStatus;
  ref: string;
  project: string;
  age: string;
}

export interface DashboardViewState {
  podName: string;
  meta: string;
  stats: {
    waitingOnYou: number;
    aiCoverage: { reviewed: number; total: number };
    pipelinesFailing: number;
    projectsInPod: number;
  };
  fetchedAgo: string;
  projects: Array<{ id: string; label: string; count: number }>;
  rows: DashboardRow[];
  issues: DashboardIssueRow[];
  pipelines: DashboardPipelineRow[];
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CI_CLASS: Record<CiStatus, string> = {
  success: 'ok',
  failed: 'bad',
  running: 'run',
  pending: 'dim',
  canceled: 'dim',
  none: 'dim',
};

const CI_LABEL: Record<CiStatus, string> = {
  success: 'passed',
  failed: 'failed',
  running: 'running',
  pending: 'pending',
  canceled: 'canceled',
  none: '—',
};

export function renderDashboardHtml(state: DashboardViewState, nonce: string): string {
  const e = escapeHtml;
  const empty = state.rows.length === 0;

  const statCards = [
    { label: 'Waiting on you', value: String(state.stats.waitingOnYou), cls: state.stats.waitingOnYou > 0 ? 'warn' : '' },
    { label: 'AI review coverage', value: `${state.stats.aiCoverage.reviewed}/${state.stats.aiCoverage.total}`, cls: 'ok' },
    { label: 'Pipelines failing', value: String(state.stats.pipelinesFailing), cls: state.stats.pipelinesFailing > 0 ? 'bad' : '' },
    { label: 'Projects in pod', value: String(state.stats.projectsInPod), cls: '' },
  ]
    .map(
      (c) => `<div class="stat"><div class="stat-label">${e(c.label)}</div><div class="stat-value ${c.cls}">${e(c.value)}</div></div>`,
    )
    .join('');

  const chips = empty
    ? ''
    : [
        `<button class="chip active" data-project="*">All projects · ${state.rows.length}</button>`,
        ...state.projects
          .filter((p) => p.count > 0)
          .map((p) => `<button class="chip" data-project="${e(p.id)}">${e(p.label)} · ${p.count}</button>`),
      ].join('');

  const mrRows = state.rows
    .map(
      (r) => `
      <div class="row mr-row" data-project="${e(r.repoId)}" data-number="${e(r.number)}" tabindex="0">
        <div class="cell-main">
          <div class="title">${e(r.title)}</div>
          <div class="meta mono">${e(r.refLabel)} · @${e(r.author)} · ${e(r.branch)}</div>
        </div>
        <div class="mono dim">${e(r.project)}</div>
        <div><span class="pill">${e(r.aiState)}</span></div>
        <div class="mono ${r.ciStatus ? CI_CLASS[r.ciStatus] : 'dim'}">${r.ciStatus ? CI_LABEL[r.ciStatus] : '—'}</div>
        <div class="dim mono">${e(r.age)}</div>
      </div>`,
    )
    .join('');

  const issueRows = state.issues
    .map(
      (i) => `
      <div class="row">
        <div class="cell-main"><div class="title">${e(i.title)}</div></div>
        <div class="mono dim">${e(i.project)}</div>
        <div class="dim">${e(i.assignee)}</div>
        <div class="dim mono">${e(i.milestone)}</div>
        <div class="dim mono">${e(i.age)}</div>
      </div>`,
    )
    .join('');

  const pipelineRows = state.pipelines
    .map(
      (p) => `
      <div class="pipeline">
        <span class="mono ${CI_CLASS[p.status]}">${p.status === 'failed' ? '✕' : p.status === 'success' ? '✓' : '◔'}</span>
        <span class="mono">#${e(p.id)}</span>
        <span class="dim mono">${e(p.ref)}</span>
        <span class="dim mono">${e(p.project)}</span>
        <span class="dim mono">${e(p.age)}</span>
      </div>`,
    )
    .join('');

  const body = empty
    ? `<div class="empty">
         <h2>Nothing waiting on you</h2>
         <p class="dim">${e(state.podName)} watches ${state.stats.projectsInPod} projects and none of them have open merge requests.</p>
       </div>`
    : `<div class="stats">${statCards}</div>
       <section>
         <div class="section-label">Merge requests</div>
         <div class="chips">${chips}</div>
         <div class="table-head"><div>Title</div><div>Project</div><div>AI review</div><div>Pipeline</div><div>Age</div></div>
         ${mrRows}
       </section>
       ${
         state.issues.length > 0
           ? `<section><div class="section-label">Issues · in progress</div>${issueRows}</section>`
           : ''
       }
       ${
         state.pipelines.length > 0
           ? `<section><div class="section-label">Pipelines · last 3</div>${pipelineRows}</section>`
           : ''
       }`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root {
    --line: var(--vscode-widget-border, rgba(128,128,128,.25));
    --dim: var(--vscode-descriptionForeground);
    --ok: var(--vscode-charts-green);
    --bad: var(--vscode-charts-red);
    --run: var(--vscode-charts-blue);
    --warn: var(--vscode-charts-yellow);
    --mono: var(--vscode-editor-font-family, monospace);
    --hover: var(--vscode-list-hoverBackground);
  }
  * { box-sizing: border-box; margin: 0; }
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; padding: 0; }
  .mono { font-family: var(--mono); font-size: 11px; }
  .dim { color: var(--dim); }
  .ok { color: var(--ok); } .bad { color: var(--bad); } .run { color: var(--run); } .warn { color: var(--warn); }
  header { display: flex; align-items: baseline; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--line); }
  header h1 { font-size: 14px; font-weight: 600; }
  header .spacer { flex: 1; }
  button.refresh { background: none; border: 1px solid var(--line); color: var(--vscode-foreground); border-radius: 4px; padding: 3px 10px; cursor: pointer; font-family: var(--mono); font-size: 11px; }
  button.refresh:hover { background: var(--hover); }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--line); border-bottom: 1px solid var(--line); }
  .stat { background: var(--vscode-editor-background); padding: 14px 20px; }
  .stat-label { font-size: 11px; color: var(--dim); }
  .stat-value { font-size: 27px; font-weight: 600; font-family: var(--mono); }
  section { padding: 14px 0 4px; }
  .section-label { font-size: 10px; font-weight: 500; text-transform: uppercase; letter-spacing: .09em; color: var(--dim); padding: 0 20px 8px; }
  .chips { display: flex; gap: 6px; flex-wrap: wrap; padding: 0 20px 10px; }
  .chip { background: none; border: 1px solid var(--line); color: var(--dim); border-radius: 11px; padding: 3px 10px; cursor: pointer; font-size: 11px; }
  .chip.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .table-head, .row { display: grid; grid-template-columns: minmax(0,1fr) 118px 104px 84px 58px; gap: 10px; padding: 8px 20px; align-items: center; }
  .table-head { font-size: 10px; text-transform: uppercase; letter-spacing: .09em; color: var(--dim); padding-bottom: 4px; }
  .row { border-bottom: 1px solid var(--line); }
  .mr-row { cursor: pointer; }
  .mr-row:hover, .mr-row:focus { background: var(--hover); outline: none; }
  .title { font-size: 12.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .meta { color: var(--dim); margin-top: 2px; font-size: 10.5px; }
  .pill { border: 1px solid var(--line); border-radius: 3px; padding: 2px 8px; font-size: 11px; color: var(--dim); font-family: var(--mono); }
  .pipeline { display: flex; gap: 12px; padding: 6px 20px; align-items: baseline; }
  .empty { text-align: center; padding: 60px 20px; }
  .empty h2 { font-size: 16px; margin-bottom: 8px; }
</style>
<title>Verdict: Dashboard</title>
</head>
<body>
  <header>
    <h1>${e(state.podName)}</h1>
    <span class="dim">${e(state.meta)}</span>
    <span class="spacer"></span>
    <span class="dim mono">⟳ ${e(state.fetchedAgo)}</span>
    <button class="refresh" id="refresh">Refresh</button>
  </header>
  ${body}
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh')?.addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    for (const chip of document.querySelectorAll('.chip')) {
      chip.addEventListener('click', () => {
        document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
        chip.classList.add('active');
        const project = chip.dataset.project;
        for (const row of document.querySelectorAll('.mr-row')) {
          row.style.display = project === '*' || row.dataset.project === project ? '' : 'none';
        }
      });
    }
    for (const row of document.querySelectorAll('.mr-row')) {
      row.addEventListener('click', () =>
        vscode.postMessage({ type: 'openCr', repoId: row.dataset.project, number: row.dataset.number }),
      );
    }
  </script>
</body>
</html>`;
}
