import { describe, expect, it } from 'vitest';
import { VERDICT_TOKENS_CSS } from './theme';
import type { DashboardViewState } from './dashboardHtml';
import { renderDashboardHtml } from './dashboardHtml';

const state: DashboardViewState = {
  podName: 'Platform squad',
  meta: '6 projects · 9 open MRs',
  scopeCounts: { you: 3, them: 6 },
  stats: {
    waitingOnYou: 3,
    aiCoverage: { reviewed: 7, total: 9 },
    pipelinesFailing: 1,
    projectsInPod: 6,
  },
  fetchedAgo: '2m ago',
  projects: [{ id: '9101', label: 'core', count: 2 }],
  rows: [
    {
      repoId: '9101',
      number: '2841',
      refLabel: '!2841',
      title: 'Refactor token refresh',
      author: 'you',
      branch: 'feat/auth-refresh',
      project: 'core',
      scope: 'them',
      ai: { label: '8 items', cls: 'pill-warn' },
      submitted: false,
      ciStatus: 'success',
      age: '2d',
    },
  ],
  issues: [{ title: 'Key rotation, end to end', project: 'auth-service', assignee: '@kai', milestone: '26.08', age: '6d' }],
  activity: [{ glyph: '✕', cls: 'bad', text: 'Pipeline #90371 failed · e2e:chrome', meta: 'api-gateway · 3h ago' }],
  pipelines: [{ id: '90412', status: 'success', job: 'feat/auth-refresh', age: '2h' }],
};

describe('design tokens (spec §Design tokens)', () => {
  it('carries the Dark+ resolutions as fallbacks on theme variables', () => {
    expect(VERDICT_TOKENS_CSS).toContain('var(--vscode-editor-background, #1f1f1f)');
    expect(VERDICT_TOKENS_CSS).toContain('var(--vscode-sideBar-background, #181818)');
    for (const hex of ['#fc6d26', '#a371f7', '#f85149', '#d29922', '#4a9eff', '#3fb950', '#238636', '#0078d4']) {
      expect(VERDICT_TOKENS_CSS).toContain(hex);
    }
  });

  it('carries the contrast-corrected light overrides under body.vscode-light', () => {
    const light = VERDICT_TOKENS_CSS.slice(VERDICT_TOKENS_CSS.indexOf('body.vscode-light'));
    for (const hex of ['#b3252b', '#8a6100', '#0b62c4', '#116329', '#6b3fc7', '#b8341d', '#595959']) {
      expect(light).toContain(hex);
    }
  });
});

describe('dashboard fidelity (spec §2)', () => {
  const html = renderDashboardHtml(state, 'nonce123');

  it('uses the spec MR table grid and type scale', () => {
    expect(html).toContain('grid-template-columns: minmax(0,1fr) 108px 104px 84px 58px');
    expect(html).toContain('font-size: 27px'); // stat values
    expect(html).toContain('font-size: 12.5px'); // row titles
    expect(html).toContain('font-size: 10.5px'); // meta lines
    expect(html).toContain('letter-spacing: .09em'); // section labels / header
  });

  it('renders the header exactly: pod switcher, scope pills, refresh meta', () => {
    expect(html).toContain('Platform squad');
    expect(html).toContain('6 projects · 9 open MRs');
    expect(html).toContain('Waiting on you · 3');
    expect(html).toContain('Waiting on them · 6');
    expect(html).toContain('⟳ 2m ago');
  });

  it('derives every stat from the state and colors the AI pill by state', () => {
    expect(html).toContain('7/9');
    expect(html).toContain('pill pill-warn');
    expect(html).toContain('8 items');
    expect(html).toContain('!2841 · @you · feat/auth-refresh');
  });

  it('renders the empty-pod state without chips, table header or issues', () => {
    const emptyHtml = renderDashboardHtml(
      { ...state, rows: [], issues: [], activity: [], pipelines: [] },
      'n',
    );
    expect(emptyHtml).toContain('Nothing waiting on you');
    expect(emptyHtml).toContain('Add projects to this pod');
    expect(emptyHtml).not.toContain('class="thead"');
    expect(emptyHtml).not.toContain('data-scope="all"');
  });

  it('keeps the strict CSP and nonce on every asset', () => {
    expect(html).toContain(`style-src 'nonce-nonce123'`);
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).not.toContain('http://');
  });
});
