<!-- markdownlint-disable-file -->

# Single App and Review Sidebar Changes

## Related Plan

`.copilot-tracking/plans/2026-08-01/single-app-review-sidebar-plan.instructions.md`

## Implementation Date

2026-08-01

## Added

* `src/ui/appSurface.ts` as the only owner of the Verdict editor webview
* `src/ui/appSurface.test.ts` for single-panel routing, handler replacement, breadcrumbs, and route notifications
* Live review progress, verdict filters, and finding navigation in the persistent sidebar

## Modified

* Migrated dashboard, review, changeset, combined review, posted reviews, onboarding, settings, and tuning controllers to shared app routing
* Added reusable breadcrumbs to editor routes
* Synchronized sidebar state and finding focus with single and combined reviews
* Kept prototype colors independent of ambient VS Code theme classes
* Constrained sidebar content and stacked changeset card metadata for cleaner responsive rendering

## Release Summary

Verdict now behaves as one application in one editor tab, with in-place navigation, dashboard breadcrumbs, route-aware sidebar navigation, and stateful review triage in the sidebar.
