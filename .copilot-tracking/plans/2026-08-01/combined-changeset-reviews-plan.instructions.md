<!-- markdownlint-disable-file -->

# Combined Changeset Reviews Plan

## User Requests

* Continue suggested work item 1: implement combined changeset reviews.

## Context

Research: `.copilot-tracking/research/2026-08-01/combined-changeset-reviews-research.md`

Specification: `spec/README.md` section 15 and `spec/specs/Code Verdict - developer handoff.md` section 16.

## Implementation Checklist

* [x] Add combined-agent contract and deterministic cross-repo finding tests <!-- parallelizable: false -->
* [x] Add per-MR submission planning and retry-ledger tests <!-- parallelizable: true -->
* [x] Implement combined demo and LM agent execution <!-- parallelizable: false -->
* [x] Implement partial-failure-aware changeset submission <!-- parallelizable: false -->
* [x] Extend shared review renderer for changeset scope <!-- parallelizable: false -->
* [x] Implement and wire changeset review panel <!-- parallelizable: false -->
* [x] Validate emulator anchors, full tests, typecheck, lint, and build <!-- parallelizable: false -->

## Success Criteria

* Every finding is validated against an owning changeset member and real diff anchor.
* Cross-repository findings show both sides and enter the normal triage queue.
* Accepted comments land only on their owning MR; summaries land on every member MR.
* Retry never reposts successful comments or summaries.
* Combined review state survives panel reloads.
