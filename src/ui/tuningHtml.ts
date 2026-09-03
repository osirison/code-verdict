import { escapeHtml, renderPage, type RouteAssets } from './theme';
import type { TuningRate, TuningViewState } from './tuningState';

export type TuningMessage = { type: 'applySuggestion'; suggestionId: string };

/**
 * `entry.rate` is continuous, so it cannot each get a named class — quantised
 * to the nearest 5% instead, the only width a data-driven bar can take under
 * this page's CSP (`style-src 'nonce-…'`), which drops the `style="width:…"`
 * attribute this bar used to carry silently (issue #45). 5 points is under
 * what a 6px-tall bar can show; the cost lands at the edges — a true rate
 * under 2.5% rounds down to an invisible 0%-wide bar instead of a sliver.
 */
const WIDTH_STEP = 5;
function widthClass(pct: number): string {
  return `w-${Math.max(0, Math.min(100, Math.round(pct / WIDTH_STEP) * WIDTH_STEP))}`;
}
const WIDTH_CSS = Array.from({ length: 100 / WIDTH_STEP + 1 }, (_, i) => `.w-${i * WIDTH_STEP} { width: ${i * WIDTH_STEP}%; }`).join('\n');

const CSS = `
.wrap { max-width: 860px; padding: 26px 30px; display: flex; flex-direction: column; gap: 24px; }
.head { display: flex; flex-direction: column; gap: 7px; }
.agent { color: var(--agent); font: 11px/1 var(--font-mono); }
h1 { color: var(--fg-max); font-size: 22px; font-weight: 600; line-height: 1.2; }
.subline { color: var(--fg-dim); font-size: 12.5px; line-height: 1.6; }
.section { display: flex; flex-direction: column; gap: 9px; }
.label { color: var(--fg-dimmer); font-size: 10px; font-weight: 500; letter-spacing: .09em; text-transform: uppercase; }
.rate-row { display: flex; align-items: center; gap: 11px; }
.rate-label { width: 150px; flex: none; color: var(--fg); font-size: 12px; line-height: 1.3; }
.rate-label.off { color: var(--fg-dimmer); }
.track { flex: 1; height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; }
.bar { display: block; height: 100%; background: var(--sev-blocker); }
.bar.mid { background: var(--sev-major); }
.bar.good { background: var(--ok); }
${WIDTH_CSS}
.rate { width: 42px; flex: none; text-align: right; font: 11px/1 var(--font-mono); }
.counts { width: 52px; flex: none; text-align: right; color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); }
.suggestions { gap: 10px; }
.suggestion { display: flex; align-items: flex-start; gap: 14px; border: 1px solid var(--line); border-radius: 6px; padding: 13px 15px; }
.suggestion-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.suggestion-title { color: var(--fg-hi); font-size: 12.5px; font-weight: 600; line-height: 1.3; }
.suggestion-body { color: var(--fg-dim); font-size: 11.5px; line-height: 1.6; text-wrap: pretty; }
.suggestion .btn { margin-left: auto; flex: none; }
.btn.applied, .btn.applied:hover { background: var(--line); color: var(--fg-dimmer); border-color: transparent; cursor: default; }
.empty { border: 1px dashed var(--line2); border-radius: 6px; padding: 18px; color: var(--fg-dimmer); font-size: 12.5px; line-height: 1.6; }
.footnote { color: var(--fg-dimmer); font-size: 11px; line-height: 1.5; }
`;

function rows(rates: readonly TuningRate[]): string {
  return rates.map((entry) => {
    const tone = entry.rate >= 70 ? 'good' : entry.rate >= 40 ? 'mid' : '';
    return `<div class="rate-row"><span class="rate-label ${entry.enabled === false ? 'off' : ''}">${escapeHtml(entry.label)}${entry.enabled === false ? ' · off' : ''}</span>
      <span class="track"><span class="bar ${tone} ${widthClass(entry.rate)}"></span></span>
      <span class="rate">${entry.produced > 0 ? `${entry.rate}%` : '—'}</span><span class="counts">${entry.accepted}/${entry.produced}</span></div>`;
  }).join('');
}

function suggestionButton(suggestion: TuningViewState['suggestions'][number]): string {
  return suggestion.applied
    ? '<button class="btn applied" disabled>✓ applied</button>'
    : `<button class="btn btn-accent" data-suggestion="${escapeHtml(suggestion.id)}">${escapeHtml(suggestion.action)}</button>`;
}

/**
 * Bound once on `document`, not per element (issue #39): this screen is
 * about to move to region patching (task 7.3), which replaces a container's
 * innerHTML wholesale and would drop any listener bound directly to a node
 * inside it. Delegation means the patched markup never needs re-binding.
 */
const SCRIPT = `
const vscode = window.verdictVscode;
document.addEventListener('click', (ev) => {
  const button = ev.target.closest('[data-suggestion]');
  if (button) vscode.postMessage({ type: 'applySuggestion', suggestionId: button.dataset.suggestion });
});
`;

/**
 * The data-dependent part of the page (issue #39 task 7.3), covering both
 * the empty-scorecard and normal branches — wrapped by the full page in the
 * same `id="tune-body"` container in EITHER case, so a patch aimed at it
 * always finds something to replace. Before this, the empty branch and the
 * populated one were different top-level markup with no shared container id;
 * a patch built from one state landing while the page showed the other
 * would target an id that only exists in the state it was NOT built from,
 * and `REGIONS_SCRIPT` skips a missing id rather than throwing — so it would
 * silently do nothing instead of switching branches.
 */
export function renderTuningBody(state: TuningViewState): string {
  const header = `<header class="head"><span class="agent">${escapeHtml(state.agentLabel)}</span><h1>${escapeHtml(state.headline)}</h1><span class="subline">${escapeHtml(state.subline)}</span></header>`;
  if (state.empty) {
    return `${header}
      <div class="empty">The scorecard derives from your verdicts. Accept rates by category and confidence — and the criteria suggestions they generate — appear after your first submitted review.</div>`;
  }
  // "No evidence" and "evidence says healthy" are different claims: histories
  // predating per-finding observations must not render the all-healthy copy.
  const noSuggestions = state.hasObservations
    ? 'Nothing to change. Every category you have on is accepted more than a quarter of the time, and the confidence floor is where the data says it should be.'
    : 'These reviews predate per-finding decision records, so there is nothing to derive suggestions from. The next submitted review fills the charts.';
  const suggestions = state.suggestions.length > 0
    ? state.suggestions.map((suggestion) => `<div class="suggestion"><div class="suggestion-copy"><span class="suggestion-title">${escapeHtml(suggestion.title)}</span><span class="suggestion-body">${escapeHtml(suggestion.body)}</span></div>${suggestionButton(suggestion)}</div>`).join('')
    : `<div class="empty">${noSuggestions}</div>`;
  return `${header}
    <section class="section"><div class="label">Accept rate by category</div>${rows(state.categories)}</section>
    <section class="section"><div class="label">Accept rate by agent confidence</div>${rows(state.confidence)}</section>
    <section class="section suggestions"><div class="label">Tune the criteria</div>${suggestions}<span class="footnote">Applied changes land in this pod’s review criteria — the next run uses them.</span></section>`;
}

/** This screen's contribution to the resident shell (design D7, task 8.3). */
export const TUNING_ROUTE: RouteAssets = { className: 'route-tuning', css: CSS, script: SCRIPT };

export function renderTuningHtml(state: TuningViewState, nonce: string): string {
  const body = `<main class="wrap"><div id="tune-body">${renderTuningBody(state)}</div></main>`;
  return renderPage({ title: 'Verdict: Agent tuning', nonce, css: CSS, body, script: SCRIPT, breadcrumb: { current: 'Agent tuning' }, routeClass: TUNING_ROUTE.className });
}