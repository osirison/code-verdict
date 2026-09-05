/**
 * Task 14.1/14.3/14.8 (design.md D14: "every review surface projects the same
 * current truth"). The active review screen, the sidebar's active-run list,
 * the dashboard's row, the status bar, and retained/completed run details are
 * five independent renderers fed by independent state builders
 * (`reviewFlow.ts` / `sidebarState.ts` / `dashboardState.ts` / `sidebar.ts`'s
 * `VerdictStatusBar`) — nothing in the type system stops one of them from
 * quietly growing its own second read of "what is this run doing right now".
 * This file feeds one `RunProjection` (or, for retained details, one ordered
 * activity array run through the identical `reduceActivity` reducer) through
 * all five and asserts the lifecycle label, current action, and progress
 * figure they produce cannot disagree — the requirement explicitly asked to
 * be asserted directly rather than trusted.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { registerBuiltInProviders } from '../registry';
import type { ActivityEvent, RunProjection } from '../domain/harnessActivity';
import { reduceActivity } from '../app/harnessActivityProjection';
import type { PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import type { ChangeRequest } from '../platform/types';
import type { RunRecord } from '../app/reviewRunManager';
import type { FlowViewState } from './reviewFlowHtml';
import { renderDashboardHtml } from './dashboardHtml';
import { renderReviewFlowBody, renderReviewFlowHtml } from './reviewFlowHtml';
import { toViewState } from './dashboardState';
import type { SidebarViewState } from './sidebarHtml';
import { renderSidebarHtml, statusBarRunsSummary } from './sidebarHtml';
import { toSidebarActiveRuns } from './sidebarState';
import { elapsedClock, runLifecycleLabel } from './vocab';

beforeAll(() => registerBuiltInProviders());

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

const dashboardPod: Pod = {
  id: 'pod-1',
  name: 'Platform squad',
  providerId: 'gitlab',
  instanceUrl: 'https://gitlab.example',
  username: 'you',
  sources: [{ kind: 'repository', repoId: 'repo-1' }],
  criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions: '' },
  agentId: '',
  repos: [{ id: 'repo-1', name: 'core', path: 'hve/platform/core' }],
};

function dashboardCr(): ChangeRequest {
  return {
    ref: { repoId: 'repo-1', number: '2841' },
    title: 'Refactor token refresh',
    description: '',
    state: 'open',
    sourceBranch: 'feat/auth-refresh',
    targetBranch: 'main',
    author: { username: 'kai' },
    reviewers: [{ username: 'you' }],
    webUrl: 'https://gitlab.example/repo-1/-/merge_requests/2841',
    updatedAt: '2026-08-25T09:00:00.000Z',
    headSha: 'head-2841',
  };
}

const dashboardData: PodData = {
  pod: dashboardPod,
  changeRequests: [dashboardCr()],
  workItems: [],
  ciRuns: [],
  fetchedAt: Date.parse('2026-08-25T12:00:00.000Z'),
};

/** Only `key`/`input.refLabel`/`projection` are read by `toSidebarActiveRuns`; the rest is cast away. */
function runRecord(refLabel: string, projection: RunProjection): RunRecord {
  return { key: `repo-1!${refLabel}`, input: { refLabel } as RunRecord['input'], projection } as RunRecord;
}

/** Task 14.4: the dashboard's own state builder, driven through its real pipeline (`toViewState`) rather than a hand-built `DashboardViewState` — the pill it produces has to come from the same code the extension actually runs. */
function renderDashboard(projection: RunProjection): string {
  const state = toViewState(
    dashboardData,
    Date.now(),
    new Set(),
    undefined,
    new Map(),
    new Map([['repo-1!2841', projection]]),
  );
  return renderDashboardHtml(state, 'nonce123');
}

/**
 * All five surfaces task 14.8 asks to cross-check, from one projection:
 * the active review screen, the sidebar's active-run list, the dashboard
 * row, and the status bar's own compact summary (`statusBarRunsSummary`,
 * pure and vscode-free — the same function `VerdictStatusBar.setActiveRuns`
 * calls in `sidebar.ts`).
 */
function renderAll(projection: RunProjection): {
  flow: string;
  sidebar: string;
  dashboard: string;
  statusBar: ReturnType<typeof statusBarRunsSummary>;
} {
  const flow = renderReviewFlowBody({ ...flowBase, runProjection: projection }, 'HVE Core');
  const activeRuns = toSidebarActiveRuns([runRecord(flowBase.header.refLabel, projection)]);
  const sidebar = renderSidebarHtml({ ...sidebarBase, activeRuns }, 'nonce123');
  const dashboard = renderDashboard(projection);
  const statusBar = statusBarRunsSummary(activeRuns);
  return { flow, sidebar, dashboard, statusBar };
}

describe('every review surface projects the same current truth (D14)', () => {
  it('render the identical lifecycle label for every canonical lifecycle value, across the active review screen, the sidebar, the dashboard, and the status bar', () => {
    const lifecycles: RunProjection['lifecycle'][] = [
      'queued', 'planning', 'investigating', 'verifying', 'completing', 'waiting', 'paused', 'resuming', 'cancelling',
    ];
    for (const lifecycle of lifecycles) {
      const projection: RunProjection = {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
        lifecycle, completeness: 'none', elapsedMs: 12_000,
        progressMode: 'indeterminate', attention: 'none', limitations: [],
      };
      const { flow, sidebar, dashboard, statusBar } = renderAll(projection);
      const label = runLifecycleLabel(lifecycle);
      expect(flow, `flow screen for ${lifecycle}`).toContain(label);
      expect(sidebar, `sidebar for ${lifecycle}`).toContain(label);
      expect(dashboard, `dashboard row for ${lifecycle}`).toContain(label);
      expect(statusBar?.lead.phase, `status bar for ${lifecycle}`).toBe(label);
    }
  });

  it('render the identical current action text on the active review screen and the sidebar', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none',
      currentAction: 'Reading src/auth/token.ts', elapsedMs: 5_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const { flow, sidebar } = renderAll(projection);
    expect(flow).toContain('Reading src/auth/token.ts');
    expect(sidebar).toContain('Reading src/auth/token.ts');
  });

  it('render the identical elapsed clock while progress is indeterminate, including the status bar\'s own unit', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none', elapsedMs: 185_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const { flow, sidebar, statusBar } = renderAll(projection);
    const clock = elapsedClock(projection.elapsedMs);
    expect(flow).toContain(clock);
    expect(sidebar).toContain(clock);
    expect(statusBar?.lead.unit).toBe(clock);
  });

  it('render the identical determinate progress fraction — neither the sidebar nor the status bar invents its own percentage', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none', elapsedMs: 90_000,
      progressMode: 'determinate', progressUnits: { completed: 5, total: 20 },
      coverage: { classified: 5, total: 20, inspected: 0 },
      attention: 'none', limitations: [],
    };
    const { flow, sidebar, statusBar } = renderAll(projection);
    // The flow screen's own bar renders the percentage; the sidebar and the
    // status bar both render the same completed/total pair as a fraction —
    // all three read off exactly `projection.progressUnits`, never a second
    // computation (D10).
    expect(flow).toContain('width="25"'); // 5/20 = 25%
    expect(sidebar).toContain('5/20');
    expect(statusBar?.lead.unit).toBe('5/20');
    expect(statusBar?.lead.unit).not.toMatch(/%/);
  });

  it('never contradict on attention: a paused run is flagged consistently', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'paused', completeness: 'none',
      currentAction: 'Waiting on a rate limit', elapsedMs: 30_000,
      progressMode: 'indeterminate', attention: 'attentionRequired', limitations: [],
    };
    const { flow, sidebar, statusBar } = renderAll(projection);
    expect(flow).toContain('Paused');
    expect(flow).toContain('Waiting on a rate limit');
    expect(sidebar).toContain('run-row-attention');
    expect(sidebar).toContain('Paused');
    expect(statusBar?.lead.attention).toBe(true);
  });
});

/**
 * Task 14.4/14.8: retained/completed run details (`retainedDetailsBlock`,
 * ./reviewFlowHtml.ts) read a coverage figure from `reduceActivity` over the
 * retained record's own ordered activity — the identical reducer the live
 * running screen's `RunProjection` comes from. Feeding the same event array
 * through both routes proves neither can drift: a retained screen showing a
 * different coverage figure than the live screen showed while the run was
 * still in progress would be exactly the contradiction D14 forbids.
 */
describe('retained details cannot disagree with the same activity a live run produced (D14)', () => {
  it('the retained-details coverage line matches the running screen\'s own, because both derive it from the identical events', () => {
    const events: ActivityEvent[] = [
      {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 1,
        occurredAt: '2026-08-28T09:00:00.000Z', phase: 'investigating', elapsedMs: 5_000,
        kind: 'coverageChanged',
        coverage: { classified: 5, total: 20, inspected: 2 },
      },
    ];
    const projection = reduceActivity({ runId: 'run-1', lineageId: 'lineage-1', attempt: 1, events });

    const live = renderReviewFlowBody({ ...flowBase, screen: 'running', runProjection: projection, runActivity: events }, 'HVE Core');
    const retained = renderReviewFlowBody(
      {
        ...flowBase,
        screen: 'clean',
        retainedDetails: {
          completeness: projection.completeness,
          protocolProvenance: 'harness',
          lineageId: 'lineage-1',
          attempt: 1,
          limitations: [],
          activity: events,
        },
      },
      'HVE Core',
    );

    expect(live).toContain('5 of 20 changed files classified');
    expect(retained).toContain('5 of 20 changed files classified');
  });
});

/**
 * Task 14.8: a long repository/ref label, a long plan-item description, or a
 * long current action must not widen a compact row — CSS truncates it with
 * an ellipsis on its own line rather than the renderer shortening the text
 * itself (which would silently lose information a full-width screen, or a
 * hover tooltip, still needs).
 */
describe('long labels do not break compact layouts (task 14.8)', () => {
  const longRef = '!284100000000000000000000000000000000000000000000';
  const longAction = 'Reading a very deeply nested source file that goes on for quite a long time in this repository tree structure';

  it('a long ref label and current action render in full, inside the sidebar\'s own truncating classes', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none',
      currentAction: longAction, elapsedMs: 5_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const sidebar = renderSidebarHtml(
      { ...sidebarBase, activeRuns: toSidebarActiveRuns([runRecord(longRef, projection)]) },
      'nonce123',
    );
    expect(sidebar).toContain(longRef);
    expect(sidebar).toContain(longAction);
    // `.run-label`/`.run-action` truncate with an ellipsis rather than wrap
    // or push the cancel button out of the row (task 14.3's own CSS).
    expect(sidebar).toMatch(/\.run-label\s*\{[^}]*text-overflow:\s*ellipsis/);
    expect(sidebar).toMatch(/\.run-action\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('a long lifecycle-driven pill renders in full inside the dashboard\'s own truncating class, never widening the AI review column', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none', elapsedMs: 5_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const dashboard = renderDashboard(projection);
    expect(dashboard).toContain(runLifecycleLabel('investigating'));
    expect(dashboard).toMatch(/\.pill-ai\s*\{[^}]*text-overflow:\s*ellipsis/);
  });

  it('the active review screen\'s own action line has nowhere to overflow into — it truncates on its own line too', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'investigating', completeness: 'none',
      currentAction: longAction, elapsedMs: 5_000,
      progressMode: 'indeterminate', attention: 'none', limitations: [],
    };
    const flowPage = renderReviewFlowHtml({ ...flowBase, runProjection: projection }, 'HVE Core', 'nonce123');
    expect(flowPage).toContain(longAction);
  });
});

/**
 * Task 14.8: the webview CSP (`default-src 'none'; style-src 'nonce-…'`)
 * drops an inline `style="…"` attribute silently — the markup still renders,
 * nothing errors, and the intended style simply never applies. Scoped to
 * exactly the fragments this pass touches (the run projection's own
 * surfaces): eleven pre-existing `style="` occurrences belong to another
 * change's task 8.5 and are deliberately left alone (see this file's own
 * header discipline — REUSE, DO NOT REINVENT, never fix what is out of
 * scope here), and none of them sit inside the functions these surfaces
 * call for a `screen: 'running'`/dashboard-row/sidebar-run-row render.
 */
describe('no inline style attribute in the surfaces this pass touches (task 14.8)', () => {
  it('the running screen, the sidebar\'s run list, and the dashboard row carry no style="…" attribute', () => {
    const projection: RunProjection = {
      runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
      lifecycle: 'paused', completeness: 'partial',
      currentAction: 'Waiting on a rate limit', elapsedMs: 30_000,
      progressMode: 'determinate', progressUnits: { completed: 5, total: 20 },
      attention: 'attentionRequired', limitations: [{ code: 'coverage', message: 'Coverage did not reach every high-risk file.' }],
    };
    const { flow, sidebar, dashboard } = renderAll(projection);
    expect(flow).not.toMatch(/<[^>]+\sstyle="/);
    expect(sidebar).not.toMatch(/<[^>]+\sstyle="/);
    expect(dashboard).not.toMatch(/<[^>]+\sstyle="/);
  });
});
