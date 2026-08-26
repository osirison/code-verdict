import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { VERDICT_TOKENS_CSS } from './theme';
import type { DashboardViewState } from './dashboardHtml';
import { renderDashboardHtml, renderDashboardLoadingHtml } from './dashboardHtml';

const state: DashboardViewState = {
  vocabulary: GITLAB_VOCABULARY,
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

describe('design tokens (POC :root block, verbatim)', () => {
  it('carries the exact POC dark palette', () => {
    const dark = VERDICT_TOKENS_CSS.slice(0, VERDICT_TOKENS_CSS.indexOf('[data-verdict-theme="light"]'));
    for (const decl of [
      '--bg: #1f1f1f', '--bg2: #181818', '--bg3: #252525', '--card: #242424', '--code: #141414',
      '--row: #232323', '--line: #2b2b2b', '--line2: #3c3c3c', '--hover: #383838',
      '--fg-hi: #e8e8e8', '--fg-dimmer: #6e7681', '--accent: #0078d4', '--sel: #04395e',
      '--brand: #fc6d26', '--agent: #a371f7', '--sev-blocker: #f85149', '--sev-major: #d29922',
      '--sev-minor: #4a9eff', '--ok: #3fb950', '--ok-strong: #238636', '--add-bg: #1b3a24',
      '--del-bg: #3a1e1e',
    ]) {
      expect(dark).toContain(decl);
    }
    // JetBrains Mono leads the mono stack, like the POC.
    expect(dark).toContain('--font-mono: "JetBrains Mono"');
  });

  it('keeps the optional POC light palette behind an explicit Verdict theme', () => {
    const light = VERDICT_TOKENS_CSS.slice(VERDICT_TOKENS_CSS.indexOf('[data-verdict-theme="light"]'));
    expect(VERDICT_TOKENS_CSS).not.toContain('body.vscode-light');
    for (const decl of [
      '--bg: #ffffff', '--bg2: #f3f3f3', '--bg3: #e8e8e8', '--card: #fafafa', '--hover: #dcdcdc',
      '--sev-blocker: #b3252b', '--sev-major: #8a6100', '--sev-minor: #0b62c4', '--ok: #116329',
      '--agent: #6b3fc7', '--brand: #b8341d', '--sel: #cce4f7', '--link: #0066bf',
    ]) {
      expect(light).toContain(decl);
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

  it('renders the pod picker menu and an issues section in the left panel', () => {
    const html = renderDashboardHtml(
      {
        ...state,
        issues: [],
        podOptions: [
          { id: 'pod-1', name: 'Platform squad', active: true, meta: '6 projects · 9 open MRs' },
          { id: 'pod-2', name: 'Payments', active: false, meta: '3 projects · 2 open MRs' },
        ],
      },
      'nonce123',
    );
    expect(html).toContain('data-pod-menu');
    expect(html).toContain('Payments');
    expect(html).toContain('Issues · in progress');
    expect(html).toContain('No issues in progress');
  });

  it('renders detected changesets as the two-column prototype band', () => {
    const html = renderDashboardHtml({
      ...state,
      changesets: [{
        id: 'trailer:1180', name: 'Key rotation, end to end', memberCount: 4,
        projectCount: 4, state: '2 blocked', stateClass: 'pill-bad',
      }],
    }, 'nonce123');

    expect(html).toContain('grid-template-columns: repeat(2, minmax(0,1fr))');
    expect(html).toContain('Changesets <span class="dimmer">· merge requests that ship together</span>');
    expect(html).toContain('Key rotation, end to end');
    expect(html).toContain('4 MRs · 4 projects');
    expect(html).toContain('.changeset-card .row-title, .changeset-card .row-meta { display: block; }');
    expect(html).toContain("type: 'openChangeset'");
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

  it('binds listeners once on document, not per element (issue #39 region patching)', () => {
    // A region patch replaces #db-body's innerHTML wholesale, which drops
    // any listener bound directly to an element inside it — delegation on
    // document survives the patch without re-binding.
    expect(html).not.toContain("querySelectorAll('[data-pod-id]').forEach");
    expect(html).toContain("ev.target.closest('[data-pod-id]')");
    expect(html).not.toContain("row.addEventListener('click', open)");
    expect(html).toContain("ev.target.closest('.mr-row')");
  });
});

describe('loading skeleton (issue #39 — navigation must not wait on the fetch)', () => {
  it('shows the pod name and meta immediately, with skeleton placeholders and no MR rows', () => {
    const html = renderDashboardLoadingHtml('Platform squad', '6 projects · 9 open MRs', 'nonce123');

    expect(html).toContain('Platform squad');
    expect(html).toContain('6 projects · 9 open MRs');
    expect(html).toContain('class="skel skel-title"');
    expect(html).not.toContain('class="mr-row" data-repo=');
    expect(html).not.toContain('data-number=');
  });

  it('wraps the skeleton in the same #db-body region the data patch targets', () => {
    const html = renderDashboardLoadingHtml('Platform squad', '6 projects · 9 open MRs', 'n');
    expect(html).toContain('id="db-body"');
  });

  it('ships the full page script so delegated listeners are already armed before data arrives', () => {
    const html = renderDashboardLoadingHtml('Platform squad', '6 projects · 9 open MRs', 'n');
    expect(html).toContain("post({ type: 'refresh' })");
    expect(html).toContain("ev.target.closest('.mr-row')");
  });

  it('sizes every skeleton placeholder from a CSS class, never a style attribute (issue #45 — the CSP blocks style attributes, not style elements)', () => {
    const html = renderDashboardLoadingHtml('Platform squad', '6 projects · 9 open MRs', 'nonce123');
    expect(html).not.toContain('style="');
  });

  it('guards skeleton rows against posting an openCr with no ref — Number(undefined) is NaN', () => {
    const html = renderDashboardLoadingHtml('Platform squad', '6 projects · 9 open MRs', 'n');
    expect(html).toContain('row.dataset.number === undefined) return');
  });
});
