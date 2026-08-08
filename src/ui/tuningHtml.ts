import { escapeHtml, renderPage } from './theme';
import type { TuningRate, TuningViewState } from './tuningState';

export type TuningMessage = { type: 'applySuggestion'; suggestionId: string };

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
      <span class="track"><span class="bar ${tone}" style="width:${entry.rate}%"></span></span>
      <span class="rate">${entry.produced > 0 ? `${entry.rate}%` : '—'}</span><span class="counts">${entry.accepted}/${entry.produced}</span></div>`;
  }).join('');
}

function suggestionButton(suggestion: TuningViewState['suggestions'][number]): string {
  return suggestion.applied
    ? '<button class="btn applied" disabled>✓ applied</button>'
    : `<button class="btn btn-accent" data-suggestion="${escapeHtml(suggestion.id)}">${escapeHtml(suggestion.action)}</button>`;
}

export function renderTuningHtml(state: TuningViewState, nonce: string): string {
  const header = `<header class="head"><span class="agent">${escapeHtml(state.agentLabel)}</span><h1>${escapeHtml(state.headline)}</h1><span class="subline">${escapeHtml(state.subline)}</span></header>`;
  if (state.empty) {
    const body = `<main class="wrap">${header}
      <div class="empty">The scorecard derives from your verdicts. Accept rates by category and confidence — and the criteria suggestions they generate — appear after your first submitted review.</div></main>`;
    return renderPage({ title: 'Verdict: Agent tuning', nonce, css: CSS, body, script: '', breadcrumb: { current: 'Agent tuning' } });
  }
  const suggestions = state.suggestions.length > 0
    ? state.suggestions.map((suggestion) => `<div class="suggestion"><div class="suggestion-copy"><span class="suggestion-title">${escapeHtml(suggestion.title)}</span><span class="suggestion-body">${escapeHtml(suggestion.body)}</span></div>${suggestionButton(suggestion)}</div>`).join('')
    : '<div class="empty">Nothing to change. Every category you have on is accepted more than a quarter of the time, and the confidence floor is where the data says it should be.</div>';
  const body = `<main class="wrap">${header}
    <section class="section"><div class="label">Accept rate by category</div>${rows(state.categories)}</section>
    <section class="section"><div class="label">Accept rate by agent confidence</div>${rows(state.confidence)}</section>
    <section class="section suggestions"><div class="label">Tune the criteria</div>${suggestions}<span class="footnote">Applied changes land in this pod’s review criteria — the next run uses them.</span></section></main>`;
  const script = `const vscode = window.verdictVscode; document.querySelectorAll('[data-suggestion]').forEach((button) => button.addEventListener('click', () => vscode.postMessage({ type: 'applySuggestion', suggestionId: button.dataset.suggestion })));`;
  return renderPage({ title: 'Verdict: Agent tuning', nonce, css: CSS, body, script, breadcrumb: { current: 'Agent tuning' } });
}