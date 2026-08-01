<!-- markdownlint-disable-file -->

# Remaining Review States Changes

## Related Plan

`.copilot-tracking/plans/2026-08-01/remaining-review-states-plan.instructions.md`

## Summary

* Added the third triage presentation with parsed unified-diff lines and shared verdict state
* Preserved provider-neutral change-request descriptions and detected shared `Part-of` trailers
* Added emulator-backed changeset cards and a live overview panel
* Added focused renderer, detector, and provider acceptance tests

## Modified

* `src/ui/reviewFlow.ts`
* `src/ui/reviewFlowHtml.ts`
* `src/platform/types.ts`
* `src/providers/gitlab/mappers.ts`
* `src/providers/fixture/data.ts`
* `src/ui/dashboard.ts`
* `src/ui/dashboardState.ts`
* `src/ui/dashboardHtml.ts`
* `src/extension.ts`
* `src/providers/gitlab/gitlab.emulator.test.ts`

## Added

* `src/ui/reviewFlowHtml.test.ts`
* `src/app/changesets.ts`
* `src/app/changesets.test.ts`
* `src/ui/changeset.ts`
* `src/ui/changesetHtml.ts`
* `src/ui/changesetHtml.test.ts`

## Deferred

Multi-diff agent execution, generated cross-repo findings, and multi-MR submission remain a separate contract phase. The overview marks their results unknown and does not expose a working action prematurely.