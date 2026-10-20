## 1. Protocol

- [x] 1.1 Add the `riskProposal` kind: types, bounded parser (1 to 64 entries, identifier and short-text bounds), phase table (planning and investigating), one-per-turn batch rule, completion-request exclusion, batch-rule prose.
- [x] 1.2 Add the branch, the per-message limits and the exclusions to the turn schema; keep schema/parser parity tests green.
- [x] 1.3 Tests: round trip, null and empty optionals, malformed shapes, bounds, wrong phase, two per turn, batch rules, schema parity.

## 2. Attempt

- [x] 2.1 Apply proposals in `processMessages` through `classifyFile`: max of proposal, floor and recorded risk; refuse a path or member outside the inventory without repair; no-op for inspected and terminal files.
- [x] 2.2 Emit the coverage fact on any change; after the forecast has run, re-state it and replace the earlier limitation by reference.
- [x] 2.3 Leave a proposal-only turn out of the actionable-work test.
- [x] 2.4 Remove the "documented protocol gap" comments.
- [x] 2.5 Tests: raise applies, planning classification, below-floor ignored, off-inventory and unknown member refused, inspected no-op, proposal-only turn, late raise shortfall (new and replaced), checkpoint resume.

## 3. Prompt and demo

- [x] 3.1 Add the kind to the model-facing contract; measure the byte cost and move the scoped small-review ceiling.
- [x] 3.2 Demo participant sends one proposal ahead of its first read, never as the last message of a batch.

## 4. Docs

- [x] 4.1 Update `docs/ARCHITECTURE.md` where it describes risk classification.
