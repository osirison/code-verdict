<!-- markdownlint-disable-file -->

# Combined Changeset Reviews Planning Log

## Selected Path

Reuse the review reducer and renderer while keeping a separate changeset controller. This limits risk to the mature single-MR orchestration and makes multi-MR retry state explicit.

## Alternatives Rejected

* Flattening all diffs into a fake single MR would lose provider anchors and permit comments to land on the wrong repository.
* Running one agent per MR cannot produce cross-repository findings.
* Reusing the single-MR submit function in a loop without a ledger would repost successful comments after partial failure.

## Implementation Notes

* Added strict member, file, and added-line validation before findings enter review state.
* Routed accepted findings through each member's own anchor references and included readable project paths for cross-repository spans.
* Persisted successful comment, summary, and request-change operations in the changeset draft before exposing retry.
* Added one history record per member after complete submission.

## Validation Iterations

* Corrected the emulator acceptance test to retain the emulator instance used for server-state assertions.
* Removed one unused controller type import reported by ESLint.
* Passed 144 tests across 30 files, strict TypeScript checking, ESLint, and the production esbuild bundle.

## Plan Deviations

* The final emulator test validates provider routing and summary fan-out in one end-to-end flow instead of introducing a separate controller harness.
