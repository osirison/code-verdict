/**
 * Every document that can reach `webview.html` carries the strict CSP.
 *
 * Written as one enumeration rather than a test per screen, on purpose. The
 * failure this guards against is not a screen losing its policy — it is a
 * *new* document arriving without one, which is exactly what a per-function
 * test cannot see: nobody adding `renderWhateverHtml` next month will think
 * to add a CSP test for it. So the table below is checked against the
 * modules' own exports, and a `render…Html` function with no row here fails
 * the first test in the file. The row is the only thing an author has to
 * remember, and forgetting it is loud.
 *
 * What the policy has to be, not merely that one exists: `default-src
 * 'none'`, with scripts and styles admitted only through that render's
 * nonce. A permissive policy silences VS Code's missing-CSP warning and
 * buys nothing, so the assertions tie the policy back to the document —
 * a page carrying a `<script nonce="X">` must name that same X in
 * `script-src`.
 *
 * And the other half of that policy: an inline `style="…"` attribute or an
 * inline `onclick="…"` handler needs `'unsafe-inline'`, so under this CSP
 * the browser drops it silently, with nothing logged and nothing thrown
 * (issue #45 — progress bars sized by an attribute that never applied).
 * Every document here is checked for both.
 *
 * Each screen's actual content is asserted in that screen's own test file.
 * This one is about the envelope, which is why the fixtures below are the
 * smallest state each renderer accepts rather than realistic states.
 */
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INLINE_STYLE_ATTRIBUTE } from '../testing/inlineStyle';
import { GITLAB_HOST, GITHUB_VOCABULARY, GITLAB_VOCABULARY } from '../testing/specFixtures';
import * as appShell from './appShell';
import * as changesetHtml from './changesetHtml';
import * as dashboardHtml from './dashboardHtml';
import * as onboardingHtml from './onboardingHtml';
import * as postedReviewsHtml from './postedReviewsHtml';
import * as reviewFlowHtml from './reviewFlowHtml';
import * as settingsHtml from './settingsHtml';
import * as sidebarHtml from './sidebarHtml';
import * as theme from './theme';
import * as tuningHtml from './tuningHtml';

const NONCE = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

/**
 * The modules that hold webview documents, and the naming convention that
 * marks one: `render…Html` is a whole document here, while `render…Body` and
 * `render…Regions` are fragments patched into one that already exists.
 */
const DOCUMENT_MODULES: Record<string, Record<string, unknown>> = {
  changesetHtml,
  dashboardHtml,
  onboardingHtml,
  postedReviewsHtml,
  reviewFlowHtml,
  settingsHtml,
  sidebarHtml,
  tuningHtml,
};
const DOCUMENT_EXPORT = /^render\w*Html$/;

// ---- fixtures: the least state each renderer accepts ----------------------

const flowState = {
  vocabulary: GITLAB_VOCABULARY,
  screen: 'done',
  header: { refLabel: '!2841', projectPath: 'hve/platform/core', branch: 'feat/x', fileCount: 1, added: 1, removed: 0, title: 'Refactor token refresh' },
  doneSentence: 'Posted 1 finding.',
  crWebUrl: 'https://gitlab.example/hve/core/-/merge_requests/2841',
} as unknown as reviewFlowHtml.FlowViewState;

const changesetState = {
  vocabulary: GITLAB_VOCABULARY,
  id: 'cs-1',
  name: 'Auth rotation',
  detectionDetail: 'branch feat/auth-refresh',
  added: 1,
  removed: 0,
  reviewed: 0,
  pipelinesPassing: 0,
  members: [],
} as unknown as changesetHtml.ChangesetViewState;

const postedState = {
  vocabulary: GITHUB_VOCABULARY,
  podName: 'Platform squad',
  now: 1_700_000_000_000,
  waitingOnYouTotal: 0,
  rows: [],
  showArchived: false,
  archivedCount: 0,
  opinions: {},
  replyDrafts: {},
} as unknown as postedReviewsHtml.PostedViewState;

const dashboardState = {
  vocabulary: GITLAB_VOCABULARY,
  podName: 'Platform squad',
  meta: '6 repositories · 9 open changes',
  scopeCounts: { you: 0, them: 0 },
  stats: { waitingOnYou: 0, aiCoverage: { reviewed: 0, total: 0 }, pipelinesFailing: 0, projectsInPod: 6 },
  fetchedLabel: '14:32',
  projects: [],
  rows: [],
  issues: [],
  activity: [],
  pipelines: [],
} as unknown as dashboardHtml.DashboardViewState;

const settingsState = {
  vocabulary: GITHUB_VOCABULARY,
  instanceUrl: 'https://github.example',
  connectionStatus: 'connected as @you',
  harness: {
    maxElapsedSecondsPerAttempt: 1_800,
    maxModelTurnsPerAttempt: 64,
    maxToolRequestsPerAttempt: 256,
    maxEvidenceMegabytesPerAttempt: 8,
    highRiskReservePercent: 20,
    verificationReservePercent: 15,
    transientRetriesPerOperation: 3,
    checkpointCadenceToolCalls: 10,
    retainedCheckpointsPerLineage: 3,
    maxActivityEventsPerAttempt: 1_000,
    terminalAttemptHistoryCount: 5,
    terminalAttemptHistoryMaxAgeDays: 30,
    requireInspectionMinRisk: 'low',
  },
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
  notifications: [],
  agentLocations: [],
} as unknown as settingsHtml.SettingsViewState;

const onboardingState = {
  vocabulary: GITLAB_VOCABULARY,
  host: GITLAB_HOST,
  step: 1,
  instanceUrl: 'https://github.example',
  connectionStatus: 'not connected',
  connected: false,
  podName: '',
  sources: [],
  selectedProjects: 0,
} as unknown as onboardingHtml.OnboardingViewState;

const sidebarState = {
  vocabulary: GITHUB_VOCABULARY,
  podName: 'Platform squad',
  podMeta: '2 repositories',
  pods: [],
  mergeRequests: [],
  issues: [],
  waitingOnYou: 0,
} as unknown as sidebarHtml.SidebarViewState;

const tuningState = {
  agentLabel: 'HVE Core / PR Review',
  headline: 'Nothing submitted yet',
  subline: 'The scorecard fills in after your first review',
  empty: true,
  hasObservations: false,
  categories: [],
  confidence: [],
  suggestions: [],
} as unknown as Parameters<typeof tuningHtml.renderTuningHtml>[0];

/**
 * Every webview document the extension can produce, by the export that
 * produces it. `renderShellDocument` and `renderPage` are listed by hand:
 * they are documents too, but neither matches the `render…Html` convention
 * the enumeration check reads.
 */
const DOCUMENTS: Record<string, () => string> = {
  'changesetHtml.renderChangesetHtml': () => changesetHtml.renderChangesetHtml(changesetState, NONCE),
  'changesetHtml.renderChangesetLoadingHtml': () => changesetHtml.renderChangesetLoadingHtml('Platform squad', 'Auth rotation', 'cs-1', NONCE),
  'dashboardHtml.renderDashboardHtml': () => dashboardHtml.renderDashboardHtml(dashboardState, NONCE),
  'dashboardHtml.renderDashboardLoadingHtml': () => dashboardHtml.renderDashboardLoadingHtml('Platform squad', '6 repositories', NONCE),
  'dashboardHtml.renderFallbackHtml': () => dashboardHtml.renderFallbackHtml('<p>No pod configured.</p>'),
  'onboardingHtml.renderOnboardingHtml': () => onboardingHtml.renderOnboardingHtml(onboardingState, NONCE),
  'postedReviewsHtml.renderPostedReviewsHtml': () => postedReviewsHtml.renderPostedReviewsHtml(postedState, NONCE),
  'reviewFlowHtml.renderReviewFlowHtml': () => reviewFlowHtml.renderReviewFlowHtml(flowState, 'agent', NONCE),
  'reviewFlowHtml.renderReviewFlowLoadingHtml': () => reviewFlowHtml.renderReviewFlowLoadingHtml({ refLabel: '!2841', projectPath: 'hve/core' }, NONCE),
  'reviewFlowHtml.renderReviewFlowErrorHtml': () => reviewFlowHtml.renderReviewFlowErrorHtml({ refLabel: '!2841', projectPath: 'hve/core' }, 'Could not reach GitLab', NONCE),
  'settingsHtml.renderSettingsHtml': () => settingsHtml.renderSettingsHtml(settingsState, NONCE),
  'sidebarHtml.renderSidebarHtml': () => sidebarHtml.renderSidebarHtml(sidebarState, NONCE),
  'sidebarHtml.renderSidebarPlaceholderHtml': () => sidebarHtml.renderSidebarPlaceholderHtml(NONCE),
  'tuningHtml.renderTuningHtml': () => tuningHtml.renderTuningHtml(tuningState, NONCE),
  'appShell.renderShellDocument': () => appShell.renderShellDocument({
    title: 'Verdict',
    nonce: NONCE,
    regions: { crumb: '', route: '<div class="route-dashboard"></div>' },
  }),
  'theme.renderPage': () => theme.renderPage({ title: 'Verdict', nonce: NONCE, css: '', body: '<p>x</p>' }),
};

// ---- helpers --------------------------------------------------------------

const CSP_META = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/;

/** The `<script>`/`<style>` element *contents*, which are not markup and must not be scanned for attributes. */
function withoutElementContents(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '<script></script>')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, '<style></style>');
}

/** `default-src 'none'` → `{ 'default-src': ["'none'"] }`. */
function directives(policy: string): Record<string, string[]> {
  const parsed: Record<string, string[]> = {};
  for (const clause of policy.split(';')) {
    const [name, ...sources] = clause.trim().split(/\s+/);
    if (name) parsed[name] = sources;
  }
  return parsed;
}

const names = Object.keys(DOCUMENTS);

describe('every webview document carries the strict CSP', () => {
  it('has a row here for every render…Html export, so a new document cannot be added without one', () => {
    // Both halves matter. Read off the modules' exports, a new document
    // function in a module already listed is caught; read off the directory,
    // a whole new `…Html.ts` module is caught too — without the second the
    // table would quietly stop covering the thing it claims to cover the
    // moment someone adds a screen.
    // Read from the source tree the way every other directory-walking test
    // here does (sourceHygiene.test.ts, harnessNoOneShotBypass.test.ts): a
    // path relative to the project root, not to the compiled module.
    const onDisk = readdirSync(join('src', 'ui'))
      .filter((file) => file.endsWith('Html.ts'))
      .map((file) => file.replace(/\.ts$/, ''));
    expect(onDisk.length).toBeGreaterThan(0);
    expect(Object.keys(DOCUMENT_MODULES).sort()).toEqual(onDisk.sort());

    const exported = Object.entries(DOCUMENT_MODULES).flatMap(([module, members]) =>
      Object.keys(members).filter((member) => DOCUMENT_EXPORT.test(member)).map((member) => `${module}.${member}`));
    expect(exported.length).toBeGreaterThan(0);
    expect(names).toEqual(expect.arrayContaining(exported));
  });

  it.each(names)('%s emits a Content-Security-Policy meta tag', (name) => {
    expect(DOCUMENTS[name]!()).toMatch(CSP_META);
  });

  it.each(names)('%s admits nothing by default and scripts and styles only by nonce', (name) => {
    const html = DOCUMENTS[name]!();
    const policy = CSP_META.exec(html)![1]!;
    const parsed = directives(policy);

    expect(parsed['default-src']).toEqual(["'none'"]);
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    // Safe only because no fixture here passes `codicons`: the sidebar's real
    // document admits the webview's own `cspSource` in style-src and
    // font-src, and that source carries a wildcard host. A row that renders
    // with codicons has to scope this check to the nonce sources rather than
    // read the wildcard as a loosened policy.
    expect(policy).not.toContain('*');

    // Tied to the document, not just present: a page that ships a script or a
    // style element has to name that element's own nonce. A policy naming a
    // different nonce than the markup passes a "has a CSP" check and renders
    // a blank page.
    for (const [element, directive] of [['script', 'script-src'], ['style', 'style-src']] as const) {
      const inDocument = new RegExp(`<${element}\\s+nonce="([^"]+)"`).exec(html);
      if (!inDocument) continue;
      expect(parsed[directive]).toContain(`'nonce-${inDocument[1]}'`);
    }
  });

  it.each(names)('%s carries no inline style attribute or event handler', (name) => {
    const markup = withoutElementContents(DOCUMENTS[name]!());
    expect(markup).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    expect(markup).not.toMatch(/<[^>]+\son[a-z]+\s*=\s*["']/i);
  });
});
