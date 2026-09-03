/**
 * The resident shell (design D7, tasks 8.3, 8.6, 8.7): one document carrying
 * every route's CSS and script, with routes swapped through `#app-route`.
 * These tests pin the union's composition — the navigation behaviour itself
 * (one assignment across two routes, the reload path) lives in
 * `appSurface.test.ts`, where the surface that drives it is.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { renderShellDocument, SHELL_ROUTES } from './appShell';
import { extractRouteRegions } from './theme';
import { renderDashboardHtml, type DashboardViewState } from './dashboardHtml';
import { renderPostedReviewsHtml, type PostedViewState } from './postedReviewsHtml';
import { renderSettingsHtml, type SettingsViewState } from './settingsHtml';
import { GITHUB_VOCABULARY, GITLAB_VOCABULARY } from '../testing/specFixtures';

const dashboardState: DashboardViewState = {
  vocabulary: GITLAB_VOCABULARY,
  podName: 'Platform squad',
  meta: '6 repositories · 9 open changes',
  scopeCounts: { you: 3, them: 6 },
  stats: { waitingOnYou: 3, aiCoverage: { reviewed: 1, total: 2 }, pipelinesFailing: 0, projectsInPod: 6 },
  fetchedLabel: '14:32',
  projects: [{ id: '9101', label: 'core', count: 1 }],
  rows: [{
    repoId: '9101', number: '2841', refLabel: '!2841', title: 'Refactor token refresh',
    author: 'kai', branch: 'feat/auth-refresh', project: 'core', scope: 'you',
    ai: { label: 'no findings', cls: 'pill-ok' }, submitted: false, ciStatus: 'success', age: '2d',
  }],
  issues: [],
  activity: [],
  pipelines: [],
};

const settingsState: SettingsViewState = {
  vocabulary: GITHUB_VOCABULARY,
  instanceUrl: 'https://github.example',
  connectionStatus: 'connected as @you · api scope',
  context: {
    sectionBudget: 4_000,
    totalBudget: 12_000,
    maxLinkedItems: 5,
    includeTitle: true,
    includeDescription: true,
    includeLinkedItems: true,
    usageEnabled: true,
  },
  connected: true,
  hasToken: true,
  quietMode: false,
  digestCadence: 'End of day',
  shareRates: false,
  notifications: [{ key: 'reviewReplies', label: 'Replies to your reviews', hint: 'Author replied', mode: 'Badge' }],
  agentLocations: [],
};

/** A route's content re-hosted in the shell, the way AppSurface does it. */
function shellShowing(routeHtml: string): string {
  const regions = extractRouteRegions(routeHtml);
  expect(regions).toBeDefined();
  return renderShellDocument({ title: 'Verdict', nonce: 'nonce123', regions: regions! });
}

describe('the union (task 8.3)', () => {
  it('carries every route exactly once, CSS scoped and scripts isolated', () => {
    const doc = renderShellDocument({
      title: 'Verdict',
      nonce: 'nonce123',
      regions: { crumb: '', route: '<div class="route-dashboard"></div>' },
    });
    for (const route of SHELL_ROUTES) {
      // Scoped, not bare: an unscoped union is where the dashboard's and the
      // posted screen's `.thead`, or tuning's and onboarding's `h1`, collide.
      expect(doc.match(new RegExp(`\\.${route.className} \\{`, 'g'))).toHaveLength(1);
    }
    // One IIFE per route: the screens' scripts declare same-named top-level
    // consts, so concatenated bare they would be a SyntaxError that kills
    // the whole bootstrap.
    expect(doc.match(/;\(\(\) => \{/g)?.length).toBeGreaterThanOrEqual(SHELL_ROUTES.length);
    // Still a single nonce'd script tag — the CSP admits nothing else.
    expect(doc.match(/<script/g)).toHaveLength(1);
    expect(doc).toContain('<script nonce="nonce123">');
    // The shell's swap points and the armed-page handshake.
    expect(doc).toContain('id="app-route"');
    expect(doc).toContain('id="app-breadcrumb"');
    expect(doc).toContain("verdictVscode.postMessage({ type: 'verdictReady' })");
  });

  it('gives every route a distinct ancestor class', () => {
    const names = new Set(SHELL_ROUTES.map((route) => route.className));
    expect(names.size).toBe(SHELL_ROUTES.length);
  });

  /**
   * A tripwire for ui-responsiveness's "Every screen behaves this way"
   * scenario (`screenRedrawCoverage.test.ts`): that test's table is not
   * derived from `SHELL_ROUTES` at runtime (the sidebar and the shared
   * review/changeset-review route need their own rows regardless), so this
   * pin is what forces a maintainer to notice — a new screen joining the
   * union without a redraw-coverage row would otherwise pass silently.
   */
  it('pins the route count — a new screen here needs a row in screenRedrawCoverage.test.ts', () => {
    expect(SHELL_ROUTES.length).toBe(7);
  });
});

describe('two routes rendered into one document (task 8.6)', () => {
  it('the dashboard, hosted in the shell, keeps its own markup while every other route rides along', () => {
    const doc = shellShowing(renderDashboardHtml(dashboardState, 'nonce123'));
    // The screen's own assertions, unchanged by the union.
    expect(doc).toContain('id="db-body"');
    expect(doc).toContain('Platform squad');
    expect(doc).toContain('Refactor token refresh');
    expect(doc).toContain('<div class="route-dashboard">');
    // And the other routes' assets are present in the same document.
    expect(doc).toContain('.route-settings {');
    expect(doc).toContain('.route-flow {');
    expect(doc).toContain("on('test-connection', 'testConnection')");
  });

  it('the settings screen, hosted in the shell, keeps its regions and breadcrumb while the dashboard rides along', () => {
    const doc = shellShowing(renderSettingsHtml(settingsState, 'nonce123'));
    expect(doc).toContain('id="set-connection"');
    expect(doc).toContain('connected as @you');
    expect(doc).toContain('id="app-crumb-current"');
    expect(doc).toContain('Settings');
    expect(doc).toContain('<div class="route-settings">');
    expect(doc).toContain('.route-dashboard {');
    expect(doc).toContain("closest('#pr-refresh')");
  });
});

describe('every screen\'s script armed at once (tasks 8.1, 8.3)', () => {
  const postedState: PostedViewState = {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    now: 0,
    waitingOnYouTotal: 0,
    rows: [],
    showArchived: false,
    archivedCount: 0,
    opinions: {},
    replyDrafts: {},
    loading: true,
    pendingRows: [],
  };

  /** The shell running in jsdom — all seven route scripts live, like the real panel. */
  function loadShell(routeHtml: string): { dom: JSDOM; posted: unknown[] } {
    const posted: unknown[] = [];
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(shellShowing(routeHtml), {
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: (message: unknown) => posted.push(message),
        });
      },
    });
    return { dom, posted };
  }

  it('one click posts exactly one message — no other screen\'s listener double-fires it', () => {
    // Before the pr- prefix (task 8.1), the dashboard's and the posted
    // screen's delegated listeners both matched #refresh, and both panels
    // understand 'refresh' — every click of ⟳ would have fetched twice.
    const dashboard = loadShell(renderDashboardHtml(dashboardState, 'nonce123'));
    dashboard.dom.window.document.getElementById('refresh')!
      .dispatchEvent(new dashboard.dom.window.MouseEvent('click', { bubbles: true }));
    expect(dashboard.posted.filter((m) => (m as { type: string }).type === 'refresh')).toHaveLength(1);

    const postedReviews = loadShell(renderPostedReviewsHtml(postedState, 'nonce123'));
    postedReviews.dom.window.document.getElementById('pr-refresh')!
      .dispatchEvent(new postedReviews.dom.window.MouseEvent('click', { bubbles: true }));
    expect(postedReviews.posted.filter((m) => (m as { type: string }).type === 'refresh')).toHaveLength(1);
  });

  it('the review flow\'s keyboard map is inert while another screen is showing', () => {
    const { dom, posted } = loadShell(renderDashboardHtml(dashboardState, 'nonce123'));
    posted.length = 0;
    dom.window.document.body.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'j', bubbles: true }),
    );
    // Without the .route-flow guard, j would post {type:'move'} into the
    // dashboard panel from a screen that is not even loaded.
    expect(posted.filter((m) => (m as { type: string }).type === 'move')).toHaveLength(0);
  });
});

describe('the first-paint size bound (task 8.7)', () => {
  /**
   * Raised from 108,000 when the context-controls change (#62/#63) landed on
   * main: it added ~300 lines to the review flow's renderer and ~70 to
   * settings, and the union carries both. That is this bound working as
   * intended — growth is allowed, but it has to be noticed and restated.
   *
   * Measured 110,234 characters when set (union of seven routes' CSS and
   * scripts plus tokens, base CSS and the keys overlay); 103,011 after
   * REGIONS_SCRIPT grew the view-state snapshot/restore and the per-route
   * retention (design D8, tasks 9.1/9.4) — that growth is the mechanism and
   * its shipped rationale, accepted deliberately. The margin is kept
   * deliberately thin — about 5% — because this budget's one job is to make
   * growth deliberate: ordinary edits to an existing screen fit, while a new
   * screen joining the union (5–15k of CSS and script) must trip this test
   * and raise the number consciously, with the cost stated. The shell is
   * paid once per panel lifetime; before D7 every navigation paid ~40k.
   */
  const BUDGET_CHARS = 116_000;

  it(`the shell document stays under ${BUDGET_CHARS} characters`, () => {
    const doc = renderShellDocument({
      title: 'Verdict',
      nonce: 'n'.repeat(32),
      regions: { crumb: '', route: '<div class="route-dashboard"></div>' },
    });
    expect(doc.length).toBeLessThan(BUDGET_CHARS);
  });
});
