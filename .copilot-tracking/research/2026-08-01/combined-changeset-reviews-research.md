<!-- markdownlint-disable-file -->

# Combined Changeset Reviews Research

## Scope

Implement suggested work item 1: one agent run across every changeset diff, cross-repository findings, shared triage, and partial-failure-aware submission across member merge requests.

## Findings

* `ReviewItem` and the agent parser already support `repoId`, `crNumber`, `cross`, and `spans`.
* The review reducer is item-oriented and can be reused unchanged for a changeset.
* Single-MR agent runners accept one `ChangeRequestDiff`; a combined adapter must label every hunk and validate returned routing fields.
* Provider submission is per merge request and already returns per-comment outcomes. A changeset orchestrator can maintain successful comment keys and summary refs to retry only missing work.
* The existing review renderer can remain the sole triage UI if it receives optional changeset scope metadata and per-item repository labels.

## Selected Approach

1. Add deterministic and LM combined-agent runners over labelled member diffs.
2. Add pure changeset submission planning and retry orchestration.
3. Add changeset scope rendering to the existing review screens.
4. Add a dedicated changeset review panel controller that uses the shared reducer and renderer.
5. Seed a concrete emulator cross-repository contract mismatch so demo findings anchor to real lines.

## Security and Correctness

* Reject agent items whose repository, MR, file, or line does not match a supplied member diff.
* Never post an item to any MR except its validated `crNumber` and `repoId`.
* Persist successful comment and summary operations before retrying.
* Do not merge or gate repositories.
