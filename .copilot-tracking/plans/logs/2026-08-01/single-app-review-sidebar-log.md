<!-- markdownlint-disable-file -->

# Single App and Review Sidebar Planning Log

## Selected Path

Use one panel host with route-scoped handlers, then layer breadcrumb and sidebar state over the existing pure renderers and review reducers.

## Implementation Notes

* Migrated all seven feature panel controllers to `AppSurface`.
* Added a route regression test that proves one panel creation, stale-handler retirement, and active breadcrumb dispatch.
* Added sidebar renderer coverage for live progress, filters, findings, and general-list replacement.

## Validation Iterations

* Updated the palette test after intentionally removing ambient `body.vscode-light` behavior.
* Captured the running Extension Development Host against the emulator.
* Removed sidebar horizontal overflow discovered in the first runtime capture.
* Stacked changeset card title and metadata after the final dashboard capture exposed cramped inline text.
* Added route-aware sidebar highlighting after runtime review showed Dashboard remained selected on other routes.

## Final Validation

* Passed 146 tests across 31 files.
* Passed strict TypeScript checking, ESLint, and the production esbuild bundle.
* Confirmed one `Verdict` editor tab, canonical dark palette, populated dashboard, and overflow-free sidebar in the Development Host.

## Plan Deviations

None.
