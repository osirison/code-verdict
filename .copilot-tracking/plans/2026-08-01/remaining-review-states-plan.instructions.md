<!-- markdownlint-disable-file -->

# Remaining Review States Plan

## User Requests

* Continue suggested work item 2: replicate remaining review states, including running, triage, summary, submitted, and changeset.

## Context Summary

Research: `.copilot-tracking/research/2026-08-01/remaining-review-states-research.md`

Applicable source specification: `spec/README.md` sections 3 through 8 and 15.

## Implementation Checklist

* [x] Add focused in-diff renderer tests <!-- parallelizable: false -->
* [x] Implement parsed in-diff triage and shared verdict actions <!-- parallelizable: false -->
* [x] Preserve change-request descriptions in provider mappings <!-- parallelizable: false -->
* [x] Detect trailer-based changesets from pod data <!-- parallelizable: false -->
* [x] Render dashboard changeset cards and a live overview panel <!-- parallelizable: false -->
* [x] Run complete validation <!-- parallelizable: false -->

## Success Criteria

* All three triage modes share selection, verdict, thread, and summary state.
* The emulator's `Part-of: #1180` group appears without fixture-only UI data.
* The changeset overview uses real member, repository, pipeline, and diff totals.
* Unsupported multi-MR agent and submission behavior is not simulated.
