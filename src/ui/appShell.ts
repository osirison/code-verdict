/**
 * The resident shell (design D7, task 8.3): one document per panel lifetime,
 * carrying the union of every route's CSS and bootstrap script, with the
 * active route's content in `#app-route` and its breadcrumb in
 * `#app-breadcrumb`. Navigation patches those two regions (task 8.4) —
 * before this, every route entry pushed a whole new document (~40 KB for the
 * review flow) across the IPC boundary, reparsed CSS, re-ran bootstrap
 * scripts and discarded scroll and focus.
 *
 * Pure HTML composition, no `vscode` import — `AppSurface` owns when a shell
 * is assigned versus patched.
 *
 * What the union relies on, established by the task 8.1 audit:
 * - every route's CSS is scoped under its `RouteAssets.className` (the
 *   pre-union audit found colliding unscoped selectors between screens:
 *   `header`, `section`, `h1`, `pre`, `.wrap`, `.thead`, `.empty`, `.step`,
 *   `.section`, `.label`, `.status`, `.suggestions`, `.footer`, `.tool`,
 *   `.head-right`, `.subline`, `.hint`, and the `.skel-*` sizing classes);
 * - every route's script is `document`-level delegated listeners that match
 *   nothing while their screen is absent, with ids and selectors deduplicated
 *   across screens (`#refresh`/`#back-dash`/`#rerun`/`#back` were shared,
 *   and `[data-repo]`/`[data-mode]`/`[data-changeset]` matched across
 *   screens) so one click can never post the same understood message twice.
 */
import { renderPage, scopeRouteCss, type RouteAssets, type RouteRegions } from './theme';
import { DASHBOARD_ROUTE } from './dashboardHtml';
import { REVIEW_FLOW_ROUTE } from './reviewFlowHtml';
import { POSTED_REVIEWS_ROUTE } from './postedReviewsHtml';
import { CHANGESET_ROUTE } from './changesetHtml';
import { SETTINGS_ROUTE } from './settingsHtml';
import { TUNING_ROUTE } from './tuningHtml';
import { ONBOARDING_ROUTE } from './onboardingHtml';

/**
 * Every full-page screen the panel can show. The review flow and the
 * changeset review are one entry — they share `reviewFlowHtml.ts`. The
 * sidebar is deliberately absent: it is a separate `WebviewView`, not an
 * `AppRoute`, and D7 does not reach it.
 */
export const SHELL_ROUTES: readonly RouteAssets[] = [
  DASHBOARD_ROUTE,
  REVIEW_FLOW_ROUTE,
  POSTED_REVIEWS_ROUTE,
  CHANGESET_ROUTE,
  SETTINGS_ROUTE,
  TUNING_ROUTE,
  ONBOARDING_ROUTE,
];

/** The union CSS — each route's rules scoped under its ancestor class, so no two screens' selectors can collide (task 8.2). */
const SHELL_CSS = SHELL_ROUTES.map((route) => scopeRouteCss(route.className, route.css)).join('\n');

/**
 * The union bootstrap — each route's script in its own IIFE, because the
 * screens' scripts declare same-named top-level consts (`vscode`, `post`,
 * `on`); concatenated bare, the redeclaration is a SyntaxError that kills
 * the entire bootstrap, REGIONS_SCRIPT included, and the page never arms.
 */
const SHELL_SCRIPT = SHELL_ROUTES.map((route) => `;(() => {\n${route.script}\n})();`).join('\n');

/**
 * The one document `AppSurface` assigns per panel lifetime — on first paint
 * and again when `onReload` reports the webview was recreated. `regions` is
 * the current route's content, extracted from the document its screen
 * rendered (see `extractRouteRegions`), so the first paint shows the route
 * immediately rather than an empty shell waiting for a patch it could not
 * receive before `verdictReady` — readiness stays non-load-bearing.
 */
export function renderShellDocument(opts: {
  title: string;
  nonce: string;
  regions: RouteRegions;
  /**
   * The `AppSurface` route id of the content in `regions`, stamped on
   * `#app-route` (task 9.4) so the page's per-route view-state snapshots
   * have a key for the route the document loaded with — without it, the
   * first navigation away could not save that route's scroll and expanded
   * sections under any name.
   */
  routeKey?: string;
}): string {
  return renderPage({
    title: opts.title,
    nonce: opts.nonce,
    css: SHELL_CSS,
    body: opts.regions.route,
    script: SHELL_SCRIPT,
    breadcrumbHtml: opts.regions.crumb,
    routeKey: opts.routeKey,
  });
}
