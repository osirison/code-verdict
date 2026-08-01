<!-- markdownlint-disable-file -->

# Remaining Review States Research

## Scope

Complete suggested work item 2: replicate running, triage, summary, submitted, and changeset states with emulator-backed data.

## Findings

* Running, split triage, queue triage, clean bill, summary, and submitted screens already exist in `src/ui/reviewFlowHtml.ts` and are driven by `src/ui/reviewFlow.ts`.
* In-diff triage was absent even though `src/domain/diffHunks.ts` already parses unified hunks and line numbers.
* The emulator seeds four open merge requests carrying `Part-of: #1180`, but `ChangeRequest` and the GitLab mapper discard descriptions, preventing live changeset detection.
* The provider contract has no multi-diff agent or multi-MR submission operation. Cross-repo findings cannot be represented honestly until that contract is added.

## Selected Approach

1. Add in-diff as a third renderer over the existing review and verdict state.
2. Preserve neutral change-request descriptions and detect trailer groups in the app layer.
3. Add a live changeset dashboard band and overview panel based on real pod query data.
4. Defer generated cross-repo findings and multi-MR submission to a dedicated provider and agent-contract phase.

## Validation

Use focused renderer and detector tests, followed by full tests, type checking, lint, and production build.
