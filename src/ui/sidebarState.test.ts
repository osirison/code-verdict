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
import { toSidebarViewState } from './sidebarState';

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
