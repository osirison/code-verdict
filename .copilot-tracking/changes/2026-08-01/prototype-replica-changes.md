<!-- markdownlint-disable-file -->

# Prototype Replica Changes

## Phase 1

The native VS Code tree provider was replaced by a CSP-safe webview sidebar.
It renders prototype-style navigation, pod rows, live merge requests, and live
issues from the active pod query.

## Modified Files

* `src/extension.ts` registers the webview provider and synchronizes pod changes.
* `src/ui/dashboard.ts` and `src/ui/dashboardState.ts` notify sibling views when
  the dashboard changes the active pod.
* `src/ui/sidebar.ts` owns live provider queries and typed sidebar messages.
* `src/app/debugBootstrap.test.ts` verifies sidebar data against real HTTP
  emulator fixtures.

## Added Files

* `src/ui/sidebarHtml.ts` renders the prototype-style sidebar.
* `src/ui/sidebarState.ts` projects active-pod data into sidebar state.
* `src/ui/sidebarHtml.test.ts` verifies structure and CSP-safe interactions.

## Validation

* `npx vitest run src/ui/sidebarHtml.test.ts src/ui/dashboardHtml.test.ts`
* `npx vitest run src/app/debugBootstrap.test.ts`
* `npm run typecheck`
* `npm test`
* `npm run build`