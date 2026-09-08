/**
 * What the dashboard says about a change request, and why. Two user reports
 * land here: a review that came back clean stayed "not run" forever, and the
 * coverage stat could count more reviews than there were rows.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { registerBuiltInProviders } from '../registry';
import type { ReviewRun } from '../app/reviewRuns';
import type { PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import type { ChangeRequest } from '../platform/types';
import type { RunProjection } from '../domain/harnessActivity';
import { formatClock, toViewState } from './dashboardState';

/** A minimal `RunProjection` fixture — task 14.4's dashboard rows read the same shared shape the active review screen and sidebar do, never a dashboard-local re-derivation. */
function projection(lifecycle: RunProjection['lifecycle'], over: Partial<RunProjection> = {}): RunProjection {
  return {
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    lifecycle,
    completeness: 'none',
    elapsedMs: 0,
    progressMode: 'indeterminate',
    attention: 'none',
    limitations: [],
    ...over,
  };
}

beforeAll(() => registerBuiltInProviders());

const pod: Pod = {
  id: 'pod',
  name: 'Platform squad',
  providerId: 'gitlab',
  instanceUrl: 'https://gitlab.example',
  username: 'you',
  sources: [{ kind: 'repository', repoId: '9101' }],
  criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions: '' },
  agentId: '',
  repos: [{ id: '9101', name: 'core', path: 'hve/platform/core' }],
};

function cr(number: string): ChangeRequest {
  return {
    ref: { repoId: '9101', number },
    title: `Change ${number}`,
    description: '',
    state: 'open',
    sourceBranch: `feat/${number}`,
    targetBranch: 'main',
    author: { username: 'kai' },
    reviewers: [{ username: 'you' }],
    webUrl: `https://gitlab.example/9101/-/merge_requests/${number}`,
    updatedAt: '2026-08-25T09:00:00.000Z',
    headSha: `head-${number}`,
    ci: { runId: `run-${number}`, status: 'success' },
  };
}

function data(numbers: string[]): PodData {
  return {
    pod,
    changeRequests: numbers.map(cr),
    workItems: [],
    ciRuns: [],
    fetchedAt: Date.parse('2026-08-25T12:00:00.000Z'),
  };
}

const run = (over: Partial<ReviewRun>): ReviewRun => ({
  repoId: '9101',
  crNumber: '1',
  outcome: 'findings',
  findingCount: 3,
  agentLabel: 'Copilot',
  ranAt: '2026-08-25T11:00:00.000Z',
  ...over,
});

const now = Date.parse('2026-08-25T12:00:00.000Z');
const pillOf = (state: ReturnType<typeof toViewState>, number: string) =>
  state.rows.find((row) => row.number === number)?.ai;

describe('AI review pill', () => {
  it('says "not run" only when the agent has never run on the row', () => {
    const state = toViewState(data(['1']), now, new Set(), undefined, new Map());
    expect(pillOf(state, '1')).toEqual({ label: 'not run', cls: 'pill' });
  });

  it('reports a clean run — the outcome that used to leave the row reading "not run" forever', () => {
    const runs = new Map([['9101!1', run({ outcome: 'clean', findingCount: 0 })]]);
    const state = toViewState(data(['1']), now, new Set(), undefined, runs);
    expect(pillOf(state, '1')).toEqual({ label: 'no findings', cls: 'pill-ok' });
  });

  it('reports findings waiting for triage, and counts one finding in the singular', () => {
    const runs = new Map([
      ['9101!1', run({ crNumber: '1', findingCount: 8 })],
      ['9101!2', run({ crNumber: '2', findingCount: 1 })],
    ]);
    const state = toViewState(data(['1', '2']), now, new Set(), undefined, runs);
    expect(pillOf(state, '1')).toEqual({ label: '8 findings', cls: 'pill-warn' });
    expect(pillOf(state, '2')).toEqual({ label: '1 finding', cls: 'pill-warn' });
  });

  it('lets submitted win over both run outcomes — it is the only state that is on the platform', () => {
    const submitted = new Set(['9101!1', '9101!2']);
    const runs = new Map([
      ['9101!1', run({ crNumber: '1', outcome: 'clean', findingCount: 0 })],
      ['9101!2', run({ crNumber: '2', findingCount: 4 })],
    ]);
    const state = toViewState(data(['1', '2']), now, submitted, undefined, runs);
    expect(pillOf(state, '1')).toEqual({ label: 'submitted', cls: 'pill-agent' });
    expect(pillOf(state, '2')).toEqual({ label: 'submitted', cls: 'pill-agent' });
  });

  it('keeps the row click routing on submitted alone, so a clean row opens the review flow', () => {
    const runs = new Map([['9101!1', run({ outcome: 'clean', findingCount: 0 })]]);
    const state = toViewState(data(['1']), now, new Set(), undefined, runs);
    // No history entry exists for a clean run, so routing it to the posted
    // screen would open an empty one.
    expect(state.rows[0]?.submitted).toBe(false);
  });
});

describe('AI review coverage', () => {
  it('counts rows on this dashboard, never the whole history — the numerator could outrun the denominator', () => {
    // Two entries for change requests that are not open rows here: another
    // pod's, and one that has since closed.
    const submitted = new Set(['9101!1', '4477!77', '9101!999']);
    const state = toViewState(data(['1', '2']), now, submitted, undefined, new Map());
    expect(state.stats.aiCoverage).toEqual({ reviewed: 1, total: 2 });
  });

  it('counts a clean run as reviewed — nothing was submitted, but the agent did run', () => {
    const runs = new Map([['9101!2', run({ crNumber: '2', outcome: 'clean', findingCount: 0 })]]);
    const state = toViewState(data(['1', '2']), now, new Set(['9101!1']), undefined, runs);
    expect(state.stats.aiCoverage).toEqual({ reviewed: 2, total: 2 });
  });

  it('counts a row once when it is both submitted and run', () => {
    const runs = new Map([['9101!1', run({ findingCount: 2 })]]);
    const state = toViewState(data(['1']), now, new Set(['9101!1']), undefined, runs);
    expect(state.stats.aiCoverage).toEqual({ reviewed: 1, total: 1 });
  });
});

describe('refresh label', () => {
  it('stamps the fetch as a wall clock, not an age that is always zero', () => {
    const state = toViewState(data(['1']), now, new Set());
    expect(state.fetchedLabel).toBe(formatClock(Date.parse('2026-08-25T12:00:00.000Z')));
    expect(state.fetchedLabel).not.toContain('ago');
  });

  it('pads both fields to two digits', () => {
    expect(formatClock(new Date(2026, 7, 25, 9, 5).getTime())).toBe('09:05');
    expect(formatClock(new Date(2026, 7, 25, 14, 32).getTime())).toBe('14:32');
  });

  it('moves when the fetch does — the old age was computed against the render, so it never moved', () => {
    const early = toViewState(
      { ...data(['1']), fetchedAt: new Date(2026, 7, 25, 14, 32).getTime() },
      now,
      new Set(),
    );
    const later = toViewState(
      { ...data(['1']), fetchedAt: new Date(2026, 7, 25, 15, 1).getTime() },
      now,
      new Set(),
    );
    expect(early.fetchedLabel).not.toBe(later.fetchedLabel);
  });
});

/**
 * Live run state on a row. A run in flight outranks every recorded outcome,
 * because it is about to replace one — showing last week's verdict on a row
 * whose review is running says the wrong thing about what is being waited for.
 */
describe('a row whose review is running', () => {
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const run = (over: Partial<ReviewRun> = {}): ReviewRun => ({
    repoId: '9101',
    crNumber: '1',
    outcome: 'findings',
    findingCount: 3,
    agentLabel: 'Copilot',
    ranAt: '2026-08-25T10:00:00.000Z',
    ...over,
  });

  it('says a review is running, over whatever the last one concluded — but keeps that retained review visible as a note (task 14.4)', () => {
    const state = toViewState(
      data(['1']),
      now,
      new Set(),
      undefined,
      new Map([['9101!1', run()]]),
      new Map([['9101!1', projection('investigating')]]),
    );
    expect(state.rows[0]?.ai.label).toBe('Investigating');
    expect(state.rows[0]?.ai.cls).toBe('pill-agent');
    // The rerun's pill never conflates with, or hides, the retained review
    // it might replace — the two facts stay visually distinct.
    expect(state.rows[0]?.ai.note).toBe('prev: 3 findings');
  });

  it('says a review is queued, over a submitted review — and names the retained submission as prev', () => {
    const state = toViewState(
      data(['1']),
      now,
      new Set(['9101!1']),
      undefined,
      new Map(),
      new Map([['9101!1', projection('queued')]]),
    );
    expect(state.rows[0]?.ai.label).toBe('Queued');
    expect(state.rows[0]?.ai.note).toBe('prev: submitted');
  });

  it('renders three distinguishable states for one target: a retained complete review, an active rerun over it, and a settled partial rerun (task 14.4/14.8)', () => {
    const retainedOnly = toViewState(data(['1']), now, new Set(), undefined, new Map([['9101!1', run()]]));
    const activeRerun = toViewState(
      data(['1']),
      now,
      new Set(),
      undefined,
      new Map([['9101!1', run()]]),
      new Map([['9101!1', projection('verifying')]]),
    );
    const partialRerun = toViewState(
      data(['1']),
      now,
      new Set(),
      undefined,
      new Map([['9101!1', run({ outcome: 'partial', findingCount: 2, limitations: [{ code: 'coverage', message: 'Coverage did not reach every high-risk file.' }] })]]),
    );

    const pills = [retainedOnly, activeRerun, partialRerun].map((s) => `${s.rows[0]?.ai.label}|${s.rows[0]?.ai.note ?? ''}`);
    // Every one of the three reads differently — never any two the same string.
    expect(new Set(pills).size).toBe(3);
    expect(retainedOnly.rows[0]?.ai).toEqual({ label: '3 findings', cls: 'pill-warn' });
    expect(activeRerun.rows[0]?.ai.label).toBe('Verifying');
    expect(activeRerun.rows[0]?.ai.note).toBe('prev: 3 findings');
    expect(partialRerun.rows[0]?.ai.label).toBe('2 partial');
    expect(partialRerun.rows[0]?.ai.title).toBe('Coverage did not reach every high-risk file.');
  });

  it('goes back to the recorded outcome once the run is over', () => {
    const state = toViewState(data(['1']), now, new Set(), undefined, new Map([['9101!1', run()]]), new Map());
    expect(state.rows[0]?.ai.label).toBe('3 findings');
  });

  it('says an interrupted run was interrupted, not that it found nothing', () => {
    // Falling through to the finding count would report a confident
    // "0 findings" about a run that never produced one.
    const state = toViewState(
      data(['1']),
      now,
      new Set(),
      undefined,
      new Map([['9101!1', run({ outcome: 'interrupted', findingCount: 0 })]]),
    );
    expect(state.rows[0]?.ai.label).toBe('interrupted');
  });

  it('names why an interrupted run cannot resume, when the sweep collected reasons (task 14.6)', () => {
    const state = toViewState(
      data(['1']),
      now,
      new Set(),
      undefined,
      new Map([
        [
          '9101!1',
          run({
            outcome: 'interrupted',
            findingCount: 0,
            resumable: false,
            resumeReasons: [{ code: 'checkpointIntegrity', message: 'The stored snapshot no longer hashes to the digest its checkpoint recorded.' }],
          }),
        ],
      ]),
    );
    expect(state.rows[0]?.ai.label).toBe('interrupted');
    expect(state.rows[0]?.ai.title).toBe('The stored snapshot no longer hashes to the digest its checkpoint recorded.');
  });

  it('leaves rows with no run in flight alone', () => {
    const state = toViewState(
      data(['1', '2']),
      now,
      new Set(),
      undefined,
      new Map(),
      new Map([['9101!1', projection('investigating')]]),
    );
    expect(state.rows.map((row) => row.ai.label)).toEqual(['Investigating', 'not run']);
  });
});
