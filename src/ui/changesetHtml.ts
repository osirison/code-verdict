import type { Severity } from '../domain/types';
import type { CiStatus } from '../platform/types';
import { cap, countOf, repoCountOf, type Vocabulary } from './vocab';
import { escapeHtml as e, renderPage } from './theme';

/** One side of a finding that only exists between repos (README §15 section 3). */
export interface ChangesetFindingSide {
  project: string;
  location: string;
  role: string;
}

export interface ChangesetFindingView {
  id: string;
  severity: Severity;
  title: string;
  confidence?: number;
  sides: ChangesetFindingSide[];
}

export interface ChangesetViewState {
  /** Platform nouns for the active pod's provider — never hardcoded here. */
  vocabulary: Vocabulary;
  id: string;
  name: string;
  /** Branch- and manual-detected groups have no linked issue — no chip. */
  linkedIssue?: string;
  detectionDetail: string;
  /** Manual groups can be dissolved from their own screen. */
  manual?: boolean;
  added: number;
  removed: number;
  reviewed: number;
  pipelinesPassing: number;
  crossRepoBlockers?: number;
  /** undefined → no combined run has produced findings yet. */
  findings?: ChangesetFindingView[];
  members: Array<{
    repoId: string;
    number: string;
    project: string;
    refLabel: string;
    title: string;
    ciStatus?: CiStatus;
    reviewed: boolean;
    reason?: string;
  }>;
}

export type ChangesetMessage =
  | { type: 'openMember'; repoId: string; number: string }
  | { type: 'openFinding'; changesetId: string; itemId: string }
  | { type: 'reviewTogether'; changesetId: string }
  | { type: 'removeChangeset'; changesetId: string }
  | { type: 'back' };

const CSS = `
.wrap { max-width: 900px; padding: 26px 30px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }
.title-row { display: flex; align-items: center; gap: 10px; }
.glyph { color: var(--agent); font-size: 21px; }
h1 { color: var(--fg-max); font-size: 19px; font-weight: 600; }
.issue { color: var(--fg); background: var(--bg3); border-radius: 3px; padding: 4px 7px; font: 10.5px/1 var(--font-mono); }
.subline { color: var(--fg-dimmer); font: 12px/1.5 var(--font-mono); }
.readiness { display: grid; grid-template-columns: repeat(3, 130px) minmax(0,1fr); border: 1px solid var(--line2); border-radius: 6px; overflow: hidden; }
.metric { padding: 12px 14px; border-right: 1px solid var(--line); }
.metric-value { color: var(--sev-major); font: 600 15px/1.2 var(--font-mono); }
.metric-value.ok { color: var(--ok); }
.metric-label { margin-top: 4px; color: var(--fg-dimmer); font-size: 10.5px; }
.readiness-note { align-self: center; padding: 12px 16px; color: var(--fg-dim); font-size: 11.5px; line-height: 1.5; }
.agent-note { margin-left: 8px; color: var(--agent); font: 10.5px/1 var(--font-mono); text-transform: none; }
.empty-findings { border: 1px solid var(--agent-b); border-left: 3px solid var(--agent); background: var(--agent-f); border-radius: 6px; padding: 14px 16px; color: var(--fg-dim); font-size: 12px; }
.findings { display: flex; flex-direction: column; gap: 10px; }
.finding-card { display: block; width: 100%; border: 1px solid var(--line2); border-radius: 6px; background: var(--card); padding: 12px 14px; cursor: pointer; text-align: left; color: var(--fg); font-family: var(--font-ui); }
.finding-card:hover { border-color: var(--agent); }
.finding-head { display: flex; align-items: center; gap: 9px; }
.finding-title { flex: 1; color: var(--fg-hi); font-size: 12.5px; font-weight: 600; }
.finding-confidence { color: var(--fg-dimmer); font: 10.5px/1 var(--font-mono); }
.finding-side { display: grid; grid-template-columns: 96px minmax(0,1fr); gap: 10px; margin-top: 8px; align-items: baseline; }
.side-repo { color: var(--agent); font: 10.5px/1.4 var(--font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.side-location { color: var(--fg); font: 11.5px/1.4 var(--font-mono); }
.side-role { color: var(--fg-dimmer); font: 11px/1.4 var(--font-ui); margin-left: 8px; }
.order { display: flex; flex-direction: column; }
.member { display: grid; grid-template-columns: 24px minmax(0,1fr) 130px; gap: 10px; align-items: center; border: 0; border-bottom: 1px solid var(--row); background: none; color: var(--fg); padding: 11px 4px; cursor: pointer; text-align: left; font-family: var(--font-ui); }
.member:hover { background: var(--bg3); }
.step { width: 20px; height: 20px; display: grid; place-items: center; border-radius: 50%; background: var(--bg3); color: var(--fg-dim); font: 10px/1 var(--font-mono); }
.member-title { color: var(--fg-hi); font-size: 12.5px; font-weight: 500; }
.member-meta { color: var(--fg-dimmer); font: 10.5px/1.4 var(--font-mono); }
.reason { color: var(--fg-dimmer); font-size: 11px; }
.state { text-align: right; font: 10.5px/1.5 var(--font-mono); }
.footer { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--line); padding-top: 18px; }
.footer-note { margin-left: auto; color: var(--fg-dimmer); font-size: 11px; }
.remove-link { border: 0; background: none; padding: 0; color: var(--fg-dimmer); font-size: 11px; cursor: pointer; }
.remove-link:hover { color: var(--sev-blocker); text-decoration: underline; }
`;

/**
 * The readiness strip's closing sentence names the trap (handoff §16): green
 * pipelines say nothing about failures that only exist between the repos.
 */
function readinessSentence(state: ChangesetViewState): string {
  const v = state.vocabulary;
  const failing = state.members.length - state.pipelinesPassing;
  const crossCount = state.findings?.length;
  if (failing > 0 && crossCount !== undefined) {
    return `${failing === 1 ? `One ${v.ciNoun} is` : `${failing} ${v.ciNounPlural} are`} still red. Cross-repo findings below hold regardless.`;
  }
  if (crossCount === undefined) {
    return `${failing === 0 ? `${cap(v.ciNounPlural)} are green.` : `${failing} ${failing === 1 ? v.ciNoun : v.ciNounPlural} still need attention.`} Review every diff together to expose failures that cannot be seen inside one repository.`;
  }
  if (crossCount === 0) {
    return `${cap(v.ciNounPlural)} are green. The combined run found nothing that only exists between these repos.`;
  }
  return `${cap(v.ciNounPlural)} are green, but ${crossCount} finding${crossCount === 1 ? ' only exists' : 's only exist'} between these repos — each ${v.changeRequestAbbrev} is clean on its own.`;
}

/**
 * The spec labels this section "agent read all 4 diffs together" (README §15) —
 * past tense, describing a run that happened. Before any combined run it would
 * claim one did, directly under an empty state saying none has, so the
 * pre-run label is the same sentence in the present tense.
 */
function agentNote(state: ChangesetViewState): string {
  return state.findings
    ? `agent read all ${state.members.length} diffs together`
    : `agent reads all ${state.members.length} diffs together`;
}

function renderFindings(state: ChangesetViewState): string {
  if (!state.findings) {
    return '<div class="empty-findings">No combined review has run yet. Cross-repo findings appear here only after an agent reads every member diff together.</div>';
  }
  if (state.findings.length === 0) {
    return '<div class="empty-findings">The combined run read every member diff together and found nothing that only exists between these repos.</div>';
  }
  return `<div class="findings">${state.findings.map((finding) => `<button class="finding-card" data-finding="${e(finding.id)}"><div class="finding-head"><span class="sev sev-${finding.severity}">${finding.severity}</span><span class="finding-title">${e(finding.title)}</span>${finding.confidence === undefined ? '' : `<span class="finding-confidence">confidence ${finding.confidence}%</span>`}</div>${finding.sides.map((side) => `<div class="finding-side"><span class="side-repo">${e(side.project)}</span><span><span class="side-location">${e(side.location)}</span><span class="side-role">${e(side.role)}</span></span></div>`).join('')}</button>`).join('')}</div>`;
}

export function renderChangesetHtml(state: ChangesetViewState, nonce: string): string {
  const v = state.vocabulary;
  const allPipelines = state.pipelinesPassing === state.members.length;
  const allReviewed = state.reviewed === state.members.length;
  const members = state.members.map((member, index) => `<button class="member" data-repo="${e(member.repoId)}" data-number="${e(member.number)}"><span class="step">${index + 1}</span><span><span class="member-title">${e(member.refLabel)} · ${e(member.title)}</span><span class="member-meta">${e(member.project)}</span>${member.reason ? `<span class="reason">${e(member.reason)}</span>` : ''}</span><span class="state"><span class="${member.reviewed ? 'ok' : 'warn'}">${member.reviewed ? 'reviewed' : 'not reviewed'}</span><br><span class="${member.ciStatus === 'success' ? 'ok' : member.ciStatus === 'failed' ? 'bad' : 'dimmer'}">${e(v.ciNoun)} ${e(member.ciStatus ?? 'none')}</span></span></button>`).join('');
  const body = `<main class="wrap"><header><div class="title-row"><span class="glyph">⧉</span><h1>${e(state.name)}</h1>${state.linkedIssue ? `<span class="issue">${e(state.linkedIssue)}</span>` : ''}</div><div class="subline">${e(countOf(v, state.members.length))} · ${e(repoCountOf(v, new Set(state.members.map((member) => member.repoId)).size))} · +${state.added} −${state.removed} · detected from ${e(state.detectionDetail)}</div></header><section class="readiness"><div class="metric"><div class="metric-value ${allPipelines ? 'ok' : ''}">${state.pipelinesPassing}/${state.members.length}</div><div class="metric-label">${e(v.ciNounPlural)}</div></div><div class="metric"><div class="metric-value ${allReviewed ? 'ok' : ''}">${state.reviewed}/${state.members.length}</div><div class="metric-label">reviewed</div></div><div class="metric"><div class="metric-value ${state.crossRepoBlockers === 0 ? 'ok' : ''}">${state.crossRepoBlockers ?? '—'}</div><div class="metric-label">cross-repo blockers</div></div><div class="readiness-note">${readinessSentence(state)}</div></section><section><div class="section-label">Findings that only exist between these repos <span class="agent-note">${agentNote(state)}</span></div>${renderFindings(state)}</section><section><div class="section-label">Merge order <span class="dimmer">· derived from what each ${e(v.changeRequestAbbrev)} reads and writes</span></div><div class="order">${members}</div></section><footer class="footer"><button class="btn btn-brand" id="review-together">Review all ${state.members.length} ${e(v.changeRequestAbbrev)}s together</button><button class="btn" id="back">Back to dashboard</button>${state.manual ? '<button class="remove-link" id="remove-changeset">Remove changeset</button>' : ''}<span class="footer-note">One agent run over every diff · one summary posted to all ${state.members.length} ${e(v.changeRequestAbbrev)}s</span></footer></main>`;
  const changesetId = JSON.stringify(state.id);
  const script = `const vscode=window.verdictVscode;const post=(message)=>vscode.postMessage(message);document.querySelectorAll('[data-repo]').forEach((row)=>row.addEventListener('click',()=>post({type:'openMember',repoId:row.dataset.repo,number:row.dataset.number})));document.querySelectorAll('[data-finding]').forEach((card)=>card.addEventListener('click',()=>post({type:'openFinding',changesetId:${changesetId},itemId:card.dataset.finding})));document.getElementById('review-together')?.addEventListener('click',()=>post({type:'reviewTogether',changesetId:${changesetId}}));document.getElementById('remove-changeset')?.addEventListener('click',()=>post({type:'removeChangeset',changesetId:${changesetId}}));document.getElementById('back')?.addEventListener('click',()=>post({type:'back'}));`;
  return renderPage({ title: `Verdict: Changeset · ${state.name}`, nonce, css: CSS, body, script, breadcrumb: { current: state.name } });
}
