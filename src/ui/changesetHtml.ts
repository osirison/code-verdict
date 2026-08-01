import type { CiStatus } from '../platform/types';
import { escapeHtml as e, renderPage } from './theme';

export interface ChangesetViewState {
  id: string;
  name: string;
  linkedIssue: string;
  detectionDetail: string;
  added: number;
  removed: number;
  reviewed: number;
  pipelinesPassing: number;
  crossRepoBlockers?: number;
  members: Array<{
    repoId: string;
    project: string;
    refLabel: string;
    title: string;
    ciStatus?: CiStatus;
    reviewed: boolean;
    reason: string;
  }>;
}

export type ChangesetMessage =
  | { type: 'openMember'; repoId: string; number: string }
  | { type: 'reviewTogether'; changesetId: string }
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
`;

export function renderChangesetHtml(state: ChangesetViewState, nonce: string): string {
  const allPipelines = state.pipelinesPassing === state.members.length;
  const allReviewed = state.reviewed === state.members.length;
  const members = state.members.map((member, index) => `<button class="member" data-repo="${e(member.repoId)}" data-number="${e(member.refLabel.replace(/^\D+/, ''))}"><span class="step">${index + 1}</span><span><span class="member-title">${e(member.refLabel)} · ${e(member.title)}</span><span class="member-meta">${e(member.project)}</span><span class="reason">${e(member.reason)}</span></span><span class="state"><span class="${member.reviewed ? 'ok' : 'warn'}">${member.reviewed ? 'reviewed' : 'not reviewed'}</span><br><span class="${member.ciStatus === 'success' ? 'ok' : member.ciStatus === 'failed' ? 'bad' : 'dimmer'}">pipeline ${e(member.ciStatus ?? 'none')}</span></span></button>`).join('');
  const body = `<main class="wrap"><header><div class="title-row"><span class="glyph">⧉</span><h1>${e(state.name)}</h1><span class="issue">${e(state.linkedIssue)}</span></div><div class="subline">${state.members.length} merge requests · ${new Set(state.members.map((member) => member.repoId)).size} projects · +${state.added} −${state.removed} · detected from ${e(state.detectionDetail)}</div></header><section class="readiness"><div class="metric"><div class="metric-value ${allPipelines ? 'ok' : ''}">${state.pipelinesPassing}/${state.members.length}</div><div class="metric-label">pipelines</div></div><div class="metric"><div class="metric-value ${allReviewed ? 'ok' : ''}">${state.reviewed}/${state.members.length}</div><div class="metric-label">reviewed</div></div><div class="metric"><div class="metric-value ${state.crossRepoBlockers === 0 ? 'ok' : ''}">${state.crossRepoBlockers ?? '—'}</div><div class="metric-label">cross-repo blockers</div></div><div class="readiness-note">${allPipelines ? 'Pipelines are green.' : `${state.members.length - state.pipelinesPassing} pipelines still need attention.`} Review every diff together to expose failures that cannot be seen inside one repository.</div></section><section><div class="section-label">Findings that only exist between these repos <span class="agent-note">agent reads all ${state.members.length} diffs together</span></div><div class="empty-findings">No combined review has run yet. Cross-repo findings appear here only after an agent reads every member diff together.</div></section><section><div class="section-label">Merge order <span class="dimmer">· refined from what each MR reads and writes</span></div><div class="order">${members}</div></section><footer class="footer"><button class="btn btn-brand" id="review-together">Review all ${state.members.length} MRs together</button><button class="btn" id="back">Back to dashboard</button><span class="footer-note">One agent run over every diff · one summary posted to all ${state.members.length} MRs</span></footer></main>`;
  const script = `const vscode=window.verdictVscode;const post=(message)=>vscode.postMessage(message);document.querySelectorAll('[data-repo]').forEach((row)=>row.addEventListener('click',()=>post({type:'openMember',repoId:row.dataset.repo,number:row.dataset.number})));document.getElementById('review-together')?.addEventListener('click',()=>post({type:'reviewTogether',changesetId:'${e(state.id)}'}));document.getElementById('back')?.addEventListener('click',()=>post({type:'back'}));`;
  return renderPage({ title: `Verdict: Changeset · ${state.name}`, nonce, css: CSS, body, script, breadcrumb: { current: state.name } });
}