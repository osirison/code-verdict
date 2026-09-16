/**
 * Sidebar issue state carries a navigation target through the mapping
 * (issue #40) — `webUrl`/`repoId`/`number` used to be discarded, leaving a
 * row with nothing to open.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { clearProviders } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import type { PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import type { RunRecord } from '../app/reviewRunManager';
import type { RunProjection } from '../domain/harnessActivity';
import { toSidebarActiveRuns, toSidebarViewState } from './sidebarState';

function pod(): Pod {
  return {
    id: 'platform',
    name: 'Platform squad',
    providerId: 'gitlab',
    instanceUrl: 'https://gitlab.example',
    sources: [{ kind: 'repository', repoId: '9105' }],
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: [], extraInstructions: '' },
    agentId: '',
    repos: [{ id: '9105', path: 'hve/platform/notifications', name: 'notifications' }],
  };
}

afterEach(() => clearProviders());

describe('sidebar issue state carries a navigation target (issue #40)', () => {
  it('keeps repoId, number and webUrl through the work-item mapping', () => {
    registerBuiltInProviders();
    const activePod = pod();
    const data: PodData = {
      pod: activePod,
      changeRequests: [],
      workItems: [{
        id: 'w1',
        repoId: '9105',
        number: '1180',
        title: 'Key rotation, end to end',
        state: 'open',
        updatedAt: '2026-08-01T00:00:00Z',
        webUrl: 'https://gitlab.example/hve/platform/notifications/-/issues/1180',
      }],
      ciRuns: [],
      fetchedAt: 0,
    };

    const state = toSidebarViewState(data, [activePod]);

    expect(state.issues).toEqual([{
      repoId: '9105',
      number: '1180',
      webUrl: 'https://gitlab.example/hve/platform/notifications/-/issues/1180',
      label: '#1180',
      title: 'Key rotation, end to end',
      project: 'notifications',
    }]);
  });
});

/** Only `key`/`input.refLabel`/`projection` are read by `toSidebarActiveRuns`; the rest is cast away. */
function runRecord(refLabel: string, projection: RunProjection): RunRecord {
  return {
    key: `repo-1!${refLabel}`,
    input: { refLabel } as RunRecord['input'],
    projection,
  } as RunRecord;
}

describe('the sidebar active-run list mirrors each record\'s own projection (task 14.3, design.md D14)', () => {
  it('copies lifecycle, current action, elapsed time, progress, and attention straight off the projection — never recomputed', () => {
    const projection: RunProjection = {
      runId: 'run-1',
      lineageId: 'lineage-1',
      attempt: 1,
      lifecycle: 'investigating',
      completeness: 'none',
      currentAction: 'Reading src/auth/token.ts',
      elapsedMs: 42_000,
      progressMode: 'determinate',
      progressUnits: { completed: 5, total: 20 },
      attention: 'attentionRequired',
      limitations: [],
    };

    expect(toSidebarActiveRuns([runRecord('!2841', projection)])).toEqual([{
      key: 'repo-1!!2841',
      label: '!2841',
      lifecycle: 'investigating',
      currentAction: 'Reading src/auth/token.ts',
      elapsedMs: 42_000,
      progressMode: 'determinate',
      progressUnits: { completed: 5, total: 20 },
      attention: 'attentionRequired',
    }]);
  });

  it('reports an empty list for no active runs', () => {
    expect(toSidebarActiveRuns([])).toEqual([]);
  });
});
