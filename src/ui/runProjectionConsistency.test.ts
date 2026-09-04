/**
 * Task 14.1/14.3 (design.md D14: "every review surface projects the same
 * current truth"). The active review screen and the sidebar's active-run
 * list are two independent renderers fed by two independent state builders
 * (`reviewFlow.ts` / `sidebarState.ts`) — nothing in the type system stops
 * one of them from quietly growing its own second read of "what is this run
 * doing right now". This file feeds one `RunProjection` through both and
 * asserts the lifecycle label, current action, and progress figure it
 * produces cannot disagree — the requirement explicitly asked to be
 * asserted directly rather than trusted.
 */
import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { RunProjection } from '../domain/harnessActivity';
import type { RunRecord } from '../app/reviewRunManager';
import type { FlowViewState } from './reviewFlowHtml';
import { renderReviewFlowBody } from './reviewFlowHtml';
import type { SidebarViewState } from './sidebarHtml';
import { renderSidebarHtml } from './sidebarHtml';
import { toSidebarActiveRuns } from './sidebarState';
import { elapsedClock, runLifecycleLabel } from './vocab';

const flowBase: FlowViewState = {
  vocabulary: GITLAB_VOCABULARY,
  screen: 'running',
  header: {
    refLabel: '!2841',
    projectPath: 'hve/platform/core',
    branch: 'feat/auth-refresh',
    fileCount: 9,
    added: 284,
    removed: 91,
    title: 'Refactor token refresh',
  },
  agents: [{ id: 'agent', label: 'HVE Core / PR Review', description: 'Reviews diffs', source: 'workspace', instructions: 'Review it.', origin: '.github/agents' }],
  agentId: 'agent',
  agentOpen: false,
  models: [],
  modelOpen: false,
  effort: 'none',
  effortOpen: false,
  effortComparisonDisclosure: false,
  selectionNotices: [],
  attachmentWarnings: [],
  skippedAgents: [],
  criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions: '' },
  attachments: [],
  autoContextItems: [],
  unresolvedContextReferences: [],
  mode: 'diff',
  items: [],
  counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 0 },
  candidates: [],
  filesRead: 0,
  summaryText: '',
  finalNote: '',
  postThread: true,
  requestChanges: true,
  supportsRequestChanges: true,
  username: 'you',
  doneSentence: '',
  crWebUrl: 'https://gitlab.example/hve/platform/core/-/merge_requests/2841',
};

const sidebarBase: SidebarViewState = {
  vocabulary: GITLAB_VOCABULARY,
  podName: 'Platform squad',
  podMeta: '3 projects',
  pods: [],
  mergeRequests: [],
  issues: [],
  waitingOnYou: 0,
};

/** Only `key`/`input.refLabel`/`projection` are read by `toSidebarActiveRuns`; the rest is cast away. */
function runRecord(refLabel: string, projection: RunProjection): RunRecord {
  return { key: `repo-1!${refLabel}`, input: { refLabel } as RunRecord['input'], projection } as RunRecord;
}

function renderBoth(projection: RunProjection): { flow: string; sidebar: string } {
  const flow = renderReviewFlowBody({ ...flowBase, runProjection: projection }, 'HVE Core');
  const sidebar = renderSidebarHtml(
    { ...sidebarBase, activeRuns: toSidebarActiveRuns([runRecord(flowBase.header.refLabel, projection)]) },
    'nonce123',
  );
  return { flow, sidebar };
}

describe('the active review screen and the sidebar cannot show contradicting lifecycle or progress (D14)', () => {
  it('render the identical lifecycle label for every canonical lifecycle value', () => {
    const lifecycles: RunProjection['lifecycle'][] = [
      'queued', 'planning', 'investigating', 'verifying', 'completing', 'waiting', 'paused', 'resuming', 'cancelling',
    ];
    for (const lifecycle of lifecycles) {
      const projection: RunProjection = {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
        lifecycle, completeness: 'none', elapsedMs: 12_000,
        progressMode: 'indeterminate', attention: 'none', limitations: [],
      };
      const { flow, sidebar } = renderBoth(projection);
      const label = runLifecycleLabel(lifecycle);
      expect(flow, `flow screen for ${lifecycle}`).toContain(label);
      expect(sidebar, `sidebar for ${lifecycle}`).toContain(label);
    }
  });

  it('render the identical current action text', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none',
      currentAction: 'Reading src/auth/token.ts', elapsedMs: 5_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const { flow, sidebar } = renderBoth(projection);
    expect(flow).toContain('Reading src/auth/token.ts');
    expect(sidebar).toContain('Reading src/auth/token.ts');
  });

  it('render the identical elapsed clock while progress is indeterminate', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none', elapsedMs: 185_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const { flow, sidebar } = renderBoth(projection);
    const clock = elapsedClock(projection.elapsedMs);
    expect(flow).toContain(clock);
    expect(sidebar).toContain(clock);
  });

  it('render the identical determinate progress fraction — neither invents its own percentage', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none', elapsedMs: 90_000,
      progressMode: 'determinate', progressUnits: { completed: 5, total: 20 },
      coverage: { classified: 5, total: 20, inspected: 0 },
      attention: 'none', limitations: [],
    };
    const { flow, sidebar } = renderBoth(projection);
    // The flow screen's own bar renders the percentage; the sidebar renders
    // the same completed/total pair as a fraction — both read off exactly
    // `projection.progressUnits`, never a second computation.
    expect(flow).toContain('width="25"'); // 5/20 = 25%
    expect(sidebar).toContain('5/20');
  });

  it('never contradict on attention: a paused run is flagged consistently', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'paused', completeness: 'none',
      currentAction: 'Waiting on a rate limit', elapsedMs: 30_000,
      progressMode: 'indeterminate', attention: 'attentionRequired', limitations: [],
    };
    const { flow, sidebar } = renderBoth(projection);
    expect(flow).toContain('Paused');
    expect(flow).toContain('Waiting on a rate limit');
    expect(sidebar).toContain('run-row-attention');
    expect(sidebar).toContain('Paused');
  });
});
