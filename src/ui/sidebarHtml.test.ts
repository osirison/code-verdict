import { describe, expect, it } from 'vitest';
import { renderSidebarHtml, type SidebarViewState } from './sidebarHtml';

const state: SidebarViewState = {
  podName: 'Platform squad',
  podMeta: '6 projects',
  pods: [
    { id: 'platform', name: 'Platform squad', meta: '6 projects', active: true },
    { id: 'payments', name: 'Payments', meta: '3 projects', active: false },
  ],
  mergeRequests: [
    { repoId: '9101', number: '2841', label: '!2841', title: 'Refactor token refresh', project: 'core', waiting: true },
  ],
  issues: [{ label: '#1180', title: 'Key rotation, end to end', project: 'api-gateway' }],
  waitingOnYou: 1,
  activeRoute: 'dashboard',
};

describe('sidebar fidelity (prototype navigation)', () => {
  it('renders the complete pod, navigation, merge request, and issue structure', () => {
    const html = renderSidebarHtml(state, 'nonce123');

    expect(html).toContain('font-size: 12.5px');
    expect(html).toContain('Pod dashboard');
    expect(html).toContain('nav-row active" id="dashboard"');
    expect(html).toContain('Posted reviews');
    expect(html).toContain('Agent tuning');
    expect(html).toContain('Settings');
    expect(html).toContain('Platform squad');
    expect(html).toContain('Payments');
    expect(html).toContain('Merge requests');
    expect(html).toContain('Refactor token refresh');
    expect(html).toContain('Issues · in progress');
    expect(html).toContain('Key rotation, end to end');
  });

  it('includes only CSP-safe typed message hooks for all navigation actions', () => {
    const html = renderSidebarHtml(state, 'nonce123');

    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'selectPod'");
    expect(html).toContain("type: 'openCr'");
    expect(html).toContain("type: 'openDashboard'");
    expect(html).toContain("type: 'openPostedReviews'");
  });

  it('replaces the general lists with live review progress, filters, and findings', () => {
    const html = renderSidebarHtml({
      ...state,
      activeReview: {
        headline: '!2841 · Refactor token refresh',
        context: 'feat/token-refresh',
        agent: 'Copilot review',
        added: 42,
        removed: 9,
        counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 1 },
        items: [
          { id: 'one', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', verdict: 'accepted', selected: false },
          { id: 'two', title: 'Missing expiry guard', file: 'src/session.ts', severity: 'blocker', selected: true },
        ],
      },
    }, 'nonce123');

    expect(html).toContain('1 acc');
    expect(html).toContain('1 left');
    expect(html).toContain('Refresh token can race');
    expect(html).toContain('data-review-filter="undecided"');
    expect(html).toContain("type: 'selectFinding'");
    expect(html).not.toContain('Issues · in progress');
  });
});