<!-- markdownlint-disable-file -->

# Combined Changeset Reviews Changes

## Related Plan

`.copilot-tracking/plans/2026-08-01/combined-changeset-reviews-plan.instructions.md`

## Implementation Date

2026-08-01

## Added

* `src/app/combinedAgent.ts` and tests for combined execution, cross-repository findings, and response validation
* `src/app/changesetSubmit.ts` and tests for per-MR routing and retry ledgers
* `src/ui/changesetReview.ts` for combined loading, triage, summary, persistence, and submission

## Modified

* `src/app/lmAgent.ts` to send every labelled member diff in one LM request
* `src/ui/reviewFlowHtml.ts` to show changeset scope, owning MRs, and both sides of cross-repository findings
* `src/ui/changeset.ts` and `src/extension.ts` to open the combined review panel
* `emulator/world.ts` to seed a producer-consumer contract mismatch across two repositories
* `src/providers/gitlab/gitlab.emulator.test.ts` to prove routed comments and summary fan-out against the real provider mapping

## Release Summary

Combined changesets can now run one agent across all member diffs, triage validated cross-repository findings, and submit retry-safe reviews to each owning merge request.
