import type { HostDescriptor } from '../platform/provider';
import type { Vocabulary } from './vocab';
import { escapeHtml, renderPage, type RouteAssets } from './theme';

export interface OnboardingSourceView {
  key: string;
  kind: 'group' | 'repo';
  path: string;
  id: string;
  projects: Array<{ id: string; path: string; selected: boolean; openMergeRequests?: number }>;
}

export interface OnboardingViewState {
  /** Nouns and onboarding prose for the provider being connected. */
  vocabulary: Vocabulary;
  host: HostDescriptor;
  /**
   * The provider offers the editor's account for this host. When it does, that
   * is the default path and the token field is the fallback, not the gate.
   */
  sessionAvailable?: boolean;
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
  | { type: 'useSession'; instanceUrl: string }
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
.repo { display: grid; grid-template-columns: 18px minmax(0,1fr) auto; gap: 8px; padding: 8px 13px 8px 26px; cursor: pointer; color: var(--fg); }
.repo.selected { background: var(--sel-soft); }
.repo-path { font: 12px/1.3 var(--font-mono); }
.repo-meta { color: var(--fg-dimmer); font: 10.5px/1.3 var(--font-mono); }
.footer { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding-top: 18px; }
.footer-note { margin-left: auto; color: var(--fg-dimmer); font-size: 11px; }
`;

/**
 * Bound once on `document`, not per element (issue #39): this screen is
 * about to move to region patching (task 7.3), which replaces a container's
 * innerHTML wholesale and would drop any listener bound directly to a node
 * inside it. Delegation means the patched markup never needs re-binding.
 *
 * `#back` and `#next` read the current step from their own
 * `data-current-step` attribute rather than closing over `state.step` at
 * script-build time: the trap phase 1 hit is a value baked into the script
 * string that stays correct only as long as the script is rebuilt on every
 * state change. Once this screen patches instead of reassigning the whole
 * document, the script outlives the state it was built from — a baked step
 * number would keep sending the wizard back to (or past) whatever step was
 * current when the page first painted. A distinct attribute name from the
 * step nav's own `data-step` keeps the two `[data-step]`/`#back`/`#next`
 * matchers from colliding.
 */
const SCRIPT = `
const vscode = window.verdictVscode; const post = (message) => vscode.postMessage(message);
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-step]');
  if (button) post({ type: 'goStep', step: Number(button.dataset.step) });
});
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#test')) post({ type: 'testConnection', instanceUrl: document.getElementById('instance').value, token: document.getElementById('token').value });
});
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#use-session')) post({ type: 'useSession', instanceUrl: document.getElementById('instance').value });
});
document.addEventListener('change', (ev) => {
  if (ev.target.id === 'pod-name') post({ type: 'setName', name: ev.target.value });
});
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-name]');
  if (button) post({ type: 'setName', name: button.dataset.name });
});
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-sample]');
  if (button) { const input = document.getElementById('source'); if (input) input.value = button.dataset.sample; }
});
document.addEventListener('click', (ev) => {
  if (ev.target.closest('#add')) post({ type: 'addSource', input: document.getElementById('source').value });
});
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-remove]');
  if (button) post({ type: 'removeSource', key: button.dataset.remove });
});
// Narrowed to this screen's picker-row class (task 8.1): every screen's
// delegated listeners share one resident shell document, and a bare
// [data-repo] also matches the dashboard's rows and chips and the changeset
// screen's member rows.
document.addEventListener('click', (ev) => {
  const row = ev.target.closest('.repo[data-repo]');
  if (row) post({ type: 'toggleProject', key: row.dataset.source, repoId: row.dataset.repo });
});
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('#back');
  if (button) post({ type: 'goStep', step: Math.max(1, Number(button.dataset.currentStep) - 1) });
});
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('#next');
  if (!button) return;
  const step = Number(button.dataset.currentStep);
  if (step === 3) post({ type: 'createPod' });
  else post({ type: 'goStep', step: step + 1 });
});
`;

/**
 * The data-dependent part of the page (issue #39 task 7.3): the step nav,
 * the current step's content and the footer, all wrapped by the full page in
 * the same `id="onb-body"` container — one source of markup, no duplication.
 * A step change swaps which `content` branch renders, but never which
 * container holds it: `onb-body` wraps the step nav too, so the patch always
 * covers the element that decides which step is showing, not just its
 * innards. `#back`/`#next` read `data-current-step` off themselves at click
 * time (task 7.1) rather than closing over `state.step`, so the script never
 * goes stale across a step change even though it is bound once for the
 * page's whole lifetime.
 */
export function renderOnboardingBody(state: OnboardingViewState): string {
  const e = escapeHtml;
  const v = state.vocabulary;
  const h = state.host;
  const steps = ['Connect', 'Name the pod', `Add ${v.repoNounPlural}`].map((label, index) => {
    const number = index + 1;
    const done = number < state.step;
    return `<button class="step ${done ? 'done' : number === state.step ? 'current' : ''}" data-step="${number}" ${number > state.step ? 'disabled' : ''}><span class="step-num">${done ? '✓' : number}</span>${label}</button>`;
  }).join('');
  const sourceCards = state.sources.map((source) => `<div class="source"><div class="source-head"><span class="kind">${e(source.kind === 'group' ? v.groupNoun : v.repoNoun)}</span><span class="source-path">${e(source.path)}</span><span class="source-id">${source.kind === 'group' ? 'group' : 'id'} ${e(source.id)}</span><button class="remove" data-remove="${e(source.key)}">✕</button></div>${source.projects.map((project) => `<div class="repo ${project.selected ? 'selected' : ''}" data-source="${e(source.key)}" data-repo="${e(project.id)}"><span>${project.selected ? '☑' : '☐'}</span><span class="repo-path">${e(project.path)}</span><span class="repo-meta">${project.openMergeRequests ? `${project.openMergeRequests} open ${e(v.changeRequestAbbrev)}s` : `no open ${e(v.changeRequestAbbrev)}s`}</span></div>`).join('')}</div>`).join('');
  const content = state.step === 1
    ? `<section class="content"><h1>Welcome to Code Verdict</h1><p class="lede">Connect ${e(v.platformName)} to get started.${state.sessionAvailable ? ` Use the ${e(v.platformName)} account you are already signed in to, or ${e(h.tokenHint)}.` : ` Use ${e(h.tokenHint)}.`} Nothing is written to settings.json — a token lives in the VS Code secret store.</p><div class="fields"><div class="field"><label>${e(h.instanceUrlLabel)}</label><input class="input" id="instance" value="${e(state.instanceUrl)}"></div>${state.sessionAvailable ? `<div class="field"><label>Account</label><button class="btn btn-accent" id="use-session">Use my ${e(v.platformName)} account</button></div>` : ''}<div class="field"><label>Access token${state.sessionAvailable ? ' <span class="dimmer">· optional</span>' : ''}</label><input class="input" id="token" type="password" placeholder="${e(h.tokenPlaceholder)}"></div></div><div><button class="btn" id="test">Test connection</button></div><span class="status ${state.connected ? 'ok' : ''}">${e(state.connectionStatus)}</span></section>`
    : state.step === 2
      ? `<section class="content"><h1>Name your pod</h1><p class="lede">A pod is a named set of ${e(v.platformName)} ${e(v.repoNounPlural)} you review together.</p><input class="input name" id="pod-name" value="${e(state.podName)}" placeholder="Platform squad"><div class="suggestions">${['Platform squad', 'Payments', 'My work'].map((name) => `<button class="chip" data-name="${name}">${name}</button>`).join('')}</div></section>`
      : `<section class="content"><h1>Add ${e(v.repoNounPlural)} to ${e(state.podName)}</h1><p class="lede">${e(h.sourceInputHint)} Choose which ${e(v.repoNounPlural)} the pod watches.</p><div class="source-input"><input class="input" id="source" placeholder="${e(h.sourceInputPlaceholder)}"><button class="btn btn-accent" id="add">Add</button></div><span class="status">${e(h.sourceInputHint)}</span><div class="samples">${h.sourceSamples.map((sample) => `<button class="chip" data-sample="${e(sample.value)}">${e(sample.label)}</button>`).join('')}</div><div class="sources">${sourceCards}</div></section>`;
  return `<div class="steps">${steps}</div>${content}<footer class="footer"><button class="btn" id="back" data-current-step="${state.step}" ${state.step === 1 ? 'disabled' : ''}>Back</button><button class="btn ${state.step === 3 ? 'btn-brand' : 'btn-accent'}" id="next" data-current-step="${state.step}">${state.step === 3 ? `Create pod · ${state.selectedProjects} ${e(v.repoNounPlural)}` : 'Continue'}</button><span class="footer-note">${state.step === 3 ? `${state.selectedProjects} selected across ${state.sources.length} sources` : ''}</span></footer>`;
}

/** This screen's contribution to the resident shell (design D7, task 8.3). */
export const ONBOARDING_ROUTE: RouteAssets = { className: 'route-onboarding', css: CSS, script: SCRIPT };

export function renderOnboardingHtml(state: OnboardingViewState, nonce: string): string {
  const body = `<main class="wrap"><div id="onb-body">${renderOnboardingBody(state)}</div></main>`;
  return renderPage({ title: 'Verdict: Setup', nonce, css: CSS, body, script: SCRIPT, breadcrumb: { current: `Connect ${state.vocabulary.platformName}` }, routeClass: ONBOARDING_ROUTE.className });
}