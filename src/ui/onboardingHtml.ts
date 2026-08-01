import { escapeHtml, renderPage } from './theme';

export interface OnboardingSourceView {
  key: string;
  kind: 'group' | 'project';
  path: string;
  id: string;
  projects: Array<{ id: string; path: string; selected: boolean; openMergeRequests?: number }>;
}

export interface OnboardingViewState {
  step: 1 | 2 | 3;
  instanceUrl: string;
  connectionStatus: string;
  connected: boolean;
  podName: string;
  sources: OnboardingSourceView[];
  selectedProjects: number;
}

export type OnboardingMessage =
  | { type: 'testConnection'; instanceUrl: string; token: string }
  | { type: 'setName'; name: string }
  | { type: 'goStep'; step: 1 | 2 | 3 }
  | { type: 'addSource'; input: string }
  | { type: 'removeSource'; key: string }
  | { type: 'toggleProject'; key: string; repoId: string }
  | { type: 'createPod' };

const CSS = `
.wrap { max-width: 820px; padding: 26px 30px; display: flex; flex-direction: column; gap: 24px; }
.steps { display: flex; gap: 8px; align-items: center; }
.step { display: flex; align-items: center; gap: 8px; border: none; border-radius: 16px; background: none; color: var(--fg-dimmer); padding: 5px 10px 5px 5px; font: 500 12px/1 var(--font-ui); }
.step.done, .step.current { color: var(--fg-hi); cursor: pointer; }
.step.current { background: var(--bg3); }
.step-num { width: 20px; height: 20px; display: grid; place-items: center; border: 1px solid var(--line2); border-radius: 50%; font: 10px/1 var(--font-mono); }
.step.done .step-num { border-color: var(--ok-strong); background: var(--ok-strong); color: #fff; }
.step.current .step-num { border-color: var(--accent); background: var(--accent); color: #fff; }
.content { display: flex; flex-direction: column; gap: 18px; }
h1 { color: var(--fg-max); font-size: 19px; font-weight: 600; line-height: 1.25; }
.lede { max-width: 64ch; color: var(--fg-dim); font-size: 12.5px; line-height: 1.6; text-wrap: pretty; }
.fields { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; max-width: 600px; }
.field { display: flex; flex-direction: column; gap: 6px; }
.field label { color: var(--fg-dim); font-size: 11px; }
.status { color: var(--fg-dimmer); font: 11px/1.4 var(--font-mono); }
.status.ok { color: var(--ok); }
.name { max-width: 400px; font-family: var(--font-ui); font-size: 13px; font-weight: 500; }
.suggestions, .samples { display: flex; gap: 8px; flex-wrap: wrap; }
.source-input { display: flex; gap: 8px; max-width: 640px; }
.source-input .input { flex: 1; }
.sources { display: flex; flex-direction: column; gap: 10px; }
.source { border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.source-head { display: flex; align-items: center; gap: 9px; padding: 9px 12px; background: var(--bg2); }
.kind { color: var(--agent); background: var(--agent-t); padding: 3px 6px; border-radius: 3px; font: 600 9.5px/1 var(--font-mono); text-transform: uppercase; }
.source-path { color: var(--fg-hi); font: 500 12.5px/1.3 var(--font-mono); }
.source-id { color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); }
.remove { margin-left: auto; border: none; background: none; color: var(--fg-dim); cursor: pointer; }
.project { display: grid; grid-template-columns: 18px minmax(0,1fr) auto; gap: 8px; padding: 8px 13px 8px 26px; cursor: pointer; color: var(--fg); }
.project.selected { background: var(--sel-soft); }
.project-path { font: 12px/1.3 var(--font-mono); }
.project-meta { color: var(--fg-dimmer); font: 10.5px/1.3 var(--font-mono); }
.footer { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding-top: 18px; }
.footer-note { margin-left: auto; color: var(--fg-dimmer); font-size: 11px; }
`;

export function renderOnboardingHtml(state: OnboardingViewState, nonce: string): string {
  const e = escapeHtml;
  const steps = ['Connect', 'Name the pod', 'Add projects'].map((label, index) => {
    const number = index + 1;
    const done = number < state.step;
    return `<button class="step ${done ? 'done' : number === state.step ? 'current' : ''}" data-step="${number}" ${number > state.step ? 'disabled' : ''}><span class="step-num">${done ? '✓' : number}</span>${label}</button>`;
  }).join('');
  const sourceCards = state.sources.map((source) => `<div class="source"><div class="source-head"><span class="kind">${source.kind}</span><span class="source-path">${e(source.path)}</span><span class="source-id">${source.kind === 'group' ? 'group' : 'id'} ${e(source.id)}</span><button class="remove" data-remove="${e(source.key)}">✕</button></div>${source.projects.map((project) => `<div class="project ${project.selected ? 'selected' : ''}" data-source="${e(source.key)}" data-repo="${e(project.id)}"><span>${project.selected ? '☑' : '☐'}</span><span class="project-path">${e(project.path)}</span><span class="project-meta">${project.openMergeRequests ? `${project.openMergeRequests} open MRs` : 'no open MRs'}</span></div>`).join('')}</div>`).join('');
  const content = state.step === 1
    ? `<section class="content"><h1>Welcome to Code Verdict</h1><p class="lede">Connect your GitLab to get started. A personal access token with <code>api</code> scope — stored in the VS Code secret store, never in settings.json.</p><div class="fields"><div class="field"><label>Instance URL</label><input class="input" id="instance" value="${e(state.instanceUrl)}"></div><div class="field"><label>Access token</label><input class="input" id="token" type="password" placeholder="glpat-…"></div></div><div><button class="btn" id="test">Test connection</button></div><span class="status ${state.connected ? 'ok' : ''}">${e(state.connectionStatus)}</span></section>`
    : state.step === 2
      ? `<section class="content"><h1>Name your pod</h1><p class="lede">A pod is a named set of GitLab projects you review together.</p><input class="input name" id="pod-name" value="${e(state.podName)}" placeholder="Platform squad"><div class="suggestions">${['Platform squad', 'Payments', 'My work'].map((name) => `<button class="chip" data-name="${name}">${name}</button>`).join('')}</div></section>`
      : `<section class="content"><h1>Add projects to ${e(state.podName)}</h1><p class="lede">Add a project URL, numeric project id, or a GitLab group and choose which projects the pod watches.</p><div class="source-input"><input class="input" id="source" placeholder="https://gitlab.com/hve/platform/core · 9102 · group 4821"><button class="btn btn-accent" id="add">Add</button></div><span class="status">Accepts a full URL, a numeric project id, or “group &lt;id&gt;”.</span><div class="samples"><button class="chip" data-sample="https://gitlab.com/hve/platform/core">project URL</button><button class="chip" data-sample="9102">project id</button><button class="chip" data-sample="group 4821">group 4821</button></div><div class="sources">${sourceCards}</div></section>`;
  const body = `<main class="wrap"><div class="steps">${steps}</div>${content}<footer class="footer"><button class="btn" id="back" ${state.step === 1 ? 'disabled' : ''}>Back</button><button class="btn ${state.step === 3 ? 'btn-brand' : 'btn-accent'}" id="next">${state.step === 3 ? `Create pod · ${state.selectedProjects} projects` : 'Continue'}</button><span class="footer-note">${state.step === 3 ? `${state.selectedProjects} selected across ${state.sources.length} sources` : ''}</span></footer></main>`;
  const script = `
    const vscode = window.verdictVscode; const post = (message) => vscode.postMessage(message);
    document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => post({ type: 'goStep', step: Number(button.dataset.step) })));
    document.getElementById('test')?.addEventListener('click', () => post({ type: 'testConnection', instanceUrl: document.getElementById('instance').value, token: document.getElementById('token').value }));
    document.getElementById('pod-name')?.addEventListener('change', (event) => post({ type: 'setName', name: event.target.value }));
    document.querySelectorAll('[data-name]').forEach((button) => button.addEventListener('click', () => post({ type: 'setName', name: button.dataset.name })));
    document.querySelectorAll('[data-sample]').forEach((button) => button.addEventListener('click', () => { document.getElementById('source').value = button.dataset.sample; }));
    document.getElementById('add')?.addEventListener('click', () => post({ type: 'addSource', input: document.getElementById('source').value }));
    document.querySelectorAll('[data-remove]').forEach((button) => button.addEventListener('click', () => post({ type: 'removeSource', key: button.dataset.remove })));
    document.querySelectorAll('[data-repo]').forEach((row) => row.addEventListener('click', () => post({ type: 'toggleProject', key: row.dataset.source, repoId: row.dataset.repo })));
    document.getElementById('back')?.addEventListener('click', () => post({ type: 'goStep', step: ${Math.max(1, state.step - 1)} }));
    document.getElementById('next')?.addEventListener('click', () => ${state.step === 3 ? "post({ type: 'createPod' })" : `post({ type: 'goStep', step: ${state.step + 1} })`});
  `;
  return renderPage({ title: 'Verdict: Setup', nonce, css: CSS, body, script, breadcrumb: { current: 'Connect GitLab' } });
}