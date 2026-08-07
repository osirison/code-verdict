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

describe('triage tree (spec §5 sidebar)', () => {
  const withReview = (items: NonNullable<SidebarViewState['activeReview']>['items']) =>
    renderSidebarHtml(
      {
        ...state,
        activeReview: {
          headline: '!2841 · Refactor token refresh',
          refLabel: '!2841',
          context: 'feat/token-refresh',
          agent: 'Copilot review',
          added: 42,
          removed: 9,
          counts: { accepted: 1, rejected: 1, skipped: 0, undecided: 1 },
          items,
        },
      },
      'nonce123',
    );

  const items: NonNullable<SidebarViewState['activeReview']>['items'] = [
    { id: 'one', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', category: 'concurrency', confidence: 88, verdict: 'accepted', selected: false },
    { id: 'two', title: 'Key id is not checked', file: 'src/auth.ts', severity: 'blocker', category: 'security', confidence: 96, selected: true },
    { id: 'three', title: 'Session never expires', file: 'src/session.ts', severity: 'minor', category: 'security', confidence: 71, verdict: 'rejected', selected: false },
  ];

  it('groups the findings under one row per file with its count', () => {
    const html = withReview(items);

    expect(html).toContain('data-file-row="src/auth.ts"');
    expect(html).toContain('data-file-row="src/session.ts"');
    // Two findings live in src/auth.ts, one in src/session.ts.
    expect(html).toContain('<span class="file-path">src/auth.ts</span><span class="file-count">2</span>');
    expect(html).toContain('<span class="file-path">src/session.ts</span><span class="file-count">1</span>');
  });

  it('shows confidence while open and a verdict glyph once decided', () => {
    const html = withReview(items);

    expect(html).toContain('>96%<');
    expect(html).toContain('finding-verdict accepted">✓<');
    expect(html).toContain('finding-verdict rejected">✕<');
  });

  it('strikes through decided findings and marks the active one', () => {
    const html = withReview(items);

    expect(html).toContain('.finding.decided .finding-title');
    expect(html).toContain('text-decoration: line-through');
    expect(html).toContain('.finding.selected { background: var(--sel); border-left-color: var(--accent); }');
    expect(html).toContain('class="finding  decided" data-finding="one"');
    expect(html).toContain('class="finding selected " data-finding="two"');
  });

  it('flags a finding whose anchor moved under it', () => {
    const html = withReview([{ ...items[1]!, lineMoved: true }]);

    expect(html).toContain('⚠ line moved');
  });

  it('counts every filter pill and offers the review tab in the footer', () => {
    const html = withReview(items);

    expect(html).toContain('data-review-filter="all">All 3<');
    expect(html).toContain('data-review-filter="undecided">Open 1<');
    expect(html).toContain('data-review-filter="category:security">Security 2<');
    expect(html).toContain('Open review tab');
    expect(html).toContain("type: 'openReviewTab'");
  });

  it('omits the security pill when nothing in the review is a security finding', () => {
    const html = withReview([items[0]!]);

    expect(html).not.toContain('category:security');
  });
});