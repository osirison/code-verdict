<!-- markdownlint-disable-file -->

# Remaining Review States Planning Log

## Selected Path

Use existing domain and renderer boundaries. In-diff remains a presentation mode. Changeset detection belongs in the app layer because trailers are provider-neutral text after mapping.

## Deferred Contract Work

Multi-diff agent execution, generated cross-repo findings, and transactional multi-MR submission require explicit contracts. The overview will expose review entry intent without pretending those operations already exist.

## Validation Iterations

* Architecture lint rejected an app-layer test importing concrete fixture-provider data. The test now defines neutral `ChangeRequest` objects locally.
* Review found that every in-diff anchor used blocker red. The renderer now derives the border from each item's severity.
* Review found that an unrun changeset displayed zero blockers as a green success. The metric now displays an unknown value and the combined-run action remains disabled until its contract exists.
