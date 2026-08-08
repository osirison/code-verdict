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

describe('per-screen sidebar states (spec §1/§3/§9)', () => {
  it('mirrors the wizard as a checklist and offers the demo pod', () => {
    const html = renderSidebarHtml(
      {
        ...state,
        setup: {
          steps: [
            { label: 'Connect GitLab', done: true, meta: 'gitlab.example.com' },
            { label: 'Name the pod', done: true, meta: 'Platform squad' },
            { label: 'Add projects', done: false, meta: '5 selected' },
          ],
        },
      },
      'nonce123',
    );

    expect(html).toContain('Setup');
    expect(html).toContain('check-row done');
    expect(html).toContain('gitlab.example.com');
    expect(html).toContain('5 selected');
    expect(html).toContain('Skip and use a demo pod');
    expect(html).toContain("type: 'useDemoPod'");
    // Spec §1: the later rows are hidden until setup completes.
    expect(html).toContain('id="dashboard"');
    expect(html).not.toContain('id="posted-reviews"');
    expect(html).not.toContain('id="tuning"');
    expect(html).not.toContain('id="settings"');
  });

  it('names the merge request and agent before a run, with no triage UI', () => {
    const html = renderSidebarHtml(
      {
        ...state,
        pendingReview: {
          headline: '!2841 · Refactor token refresh',
          context: 'feat/token-refresh',
          agent: 'HVE Core / PR Review',
          added: 284,
          removed: 91,
        },
      },
      'nonce123',
    );

    expect(html).toContain('!2841 · Refactor token refresh');
    expect(html).toContain('HVE Core / PR Review');
    expect(html).toContain('No review items yet. Pick an agent and run the review.');
    expect(html).not.toContain('data-review-filter="');
    expect(html).not.toContain('progress-accepted"');
    expect(html).toContain('Open review tab');
  });

  it('lists posted threads with status dots and no triage counters or pills', () => {
    const html = renderSidebarHtml(
      {
        ...state,
        threads: {
          headline: '!2833 · Session store',
          context: 'core · HVE Core / PR Review',
          summary: [
            { status: 'awaiting', label: '3 waiting on you' },
            { status: 'resolved', label: '2 resolved' },
          ],
          threads: [
            { id: 't1', title: 'Token cache is unlocked', meta: 'src/auth.ts:63', status: 'awaiting', selected: true },
            { id: 't2', title: 'Missing expiry guard', meta: 'src/session.ts:12', status: 'resolved', selected: false },
          ],
        },
      },
      'nonce123',
    );

    expect(html).toContain('3 waiting on you');
    expect(html).toContain('thread-dot awaiting');
    expect(html).toContain('thread-row selected');
    expect(html).toContain('src/auth.ts:63');
    expect(html).toContain('Open posted review');
    expect(html).toContain("type: 'selectThread'");
    // Spec §9 is explicit: no triage counters, no filter pills here.
    expect(html).not.toContain('data-review-filter="');
    expect(html).not.toContain('acc</span>');
  });

  it('resolves state precedence — setup wins over threads, threads over triage', () => {
    const threads = {
      headline: '!2833',
      context: 'core',
      summary: [],
      threads: [{ id: 't1', title: 'A thread', meta: 'x.ts:1', status: 'awaiting' as const, selected: false }],
    };
    const activeReview = {
      headline: '!2841',
      context: 'feat/x',
      agent: 'agent',
      added: 1,
      removed: 0,
      counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 1 },
      items: [{ id: 'one', title: 'A finding', file: 'a.ts', severity: 'major' as const, selected: true }],
    };

    const bothThreadsAndReview = renderSidebarHtml({ ...state, threads, activeReview }, 'n');
    expect(bothThreadsAndReview).toContain('A thread');
    expect(bothThreadsAndReview).not.toContain('A finding');

    const allThree = renderSidebarHtml(
      { ...state, setup: { steps: [{ label: 'Connect GitLab', done: false }] }, threads, activeReview },
      'n',
    );
    expect(allThree).toContain('Skip and use a demo pod');
    expect(allThree).not.toContain('A thread');
  });
});

describe('codicon chrome (issue #6)', () => {
  it('renders nav and toolbar icons as codicons, admitting the font in the CSP', () => {
    const html = renderSidebarHtml(
      { ...state, codicons: { styleUri: 'vscode-resource://codicon.css', cspSource: 'vscode-resource:' } },
      'nonce123',
    );

    expect(html).toContain('codicon codicon-dashboard');
    expect(html).toContain('codicon codicon-comment-discussion');
    expect(html).toContain('codicon codicon-graph');
    expect(html).toContain('codicon codicon-gear');
    expect(html).toContain('codicon codicon-refresh');
    expect(html).toContain('<link rel="stylesheet" href="vscode-resource://codicon.css">');
    expect(html).toContain('font-src vscode-resource:;');
    expect(html).toContain("style-src 'nonce-nonce123' vscode-resource:;");
    // The old Unicode chrome is gone.
    expect(html).not.toContain('▦');
    expect(html).not.toContain('⚙');
  });

  it('keeps the glyphs the spec names in prose', () => {
    const html = renderSidebarHtml(
      {
        ...state,
        codicons: { styleUri: 'u', cspSource: 'c' },
        activeReview: {
          headline: '!2841',
          context: 'feat/x',
          agent: 'agent',
          added: 1,
          removed: 0,
          counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
          items: [{ id: 'one', title: 'A finding', file: 'a.ts', severity: 'major', verdict: 'accepted', selected: true }],
        },
      },
      'nonce123',
    );

    expect(html).toContain('▾');
    expect(html).toContain('✓');
  });

  it('falls back to the strict no-font CSP when codicons are unavailable', () => {
    const html = renderSidebarHtml(state, 'nonce123');

    expect(html).toContain("style-src 'nonce-nonce123';");
    expect(html).not.toContain('font-src');
    expect(html).not.toContain('<link rel="stylesheet"');
  });
});
describe('changeset scope in the sidebar (spec §15)', () => {
  const crossItems: NonNullable<SidebarViewState['activeReview']>['items'] = [
    { id: 'a', title: 'Cross finding', file: 'api-gateway · src/routes/session.ts', severity: 'blocker', category: 'apiContract', cross: true, selected: true },
    { id: 'b', title: 'Local finding', file: 'console · src/api/session.ts', severity: 'major', category: 'security', selected: false },
  ];
  const scoped = renderSidebarHtml({
    ...state,
    activeReview: {
      headline: '⧉ Key rotation, end to end',
      refLabel: '4 MRs',
      changeset: true,
      context: '4 MRs · 4 repos',
      agent: 'HVE Core / PR Review',
      added: 812,
      removed: 247,
      counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 2 },
      items: crossItems,
    },
  }, 'n');

  it('renders the Changesets nav row with its open count and ⧉ glyph', () => {
    const html = renderSidebarHtml({ ...state, changesets: [{ id: 'trailer:1180', name: 'Key rotation, end to end' }] }, 'n');
    expect(html).toContain('id="changesets"');
    expect(html).toContain('1 open');
    expect(html).toContain('⧉');
    expect(html).toContain("type: 'openChangesets', firstId: \"trailer:1180\"");
  });

  it('replaces the Security pill with Cross-repo in changeset scope', () => {
    expect(scoped).toContain('data-review-filter="cross"');
    expect(scoped).toContain('Cross-repo 1');
    expect(scoped).not.toContain('Security 1');
  });

  it('keeps the Security pill outside changeset scope', () => {
    const single = renderSidebarHtml({
      ...state,
      activeReview: {
        headline: 'Refactor token refresh',
        context: 'core · !2841',
        agent: 'HVE Core / PR Review',
        added: 284,
        removed: 91,
        counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 2 },
        items: crossItems.map((item) => ({ ...item, cross: false })),
      },
    }, 'n');
    expect(single).toContain('Security 1');
    expect(single).not.toContain('data-review-filter="cross"');
  });

  it('swaps the severity dot for a severity-coloured ⧉ on cross items', () => {
    expect(scoped).toContain('finding-cross blocker');
    expect(scoped).toContain('data-cross="true"');
    // The non-cross item keeps its dot.
    expect(scoped).toContain('finding-dot major');
  });
});
