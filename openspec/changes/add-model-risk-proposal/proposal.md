## Why

The harness spec says the model classifies risk, the design says "the model proposes risk and
logical units", and `docs/ARCHITECTURE.md` says the model's proposal is maximized against the host
floor and can raise a file's risk. None of that was true in the code. The protocol had no message
for it, so every file was classified from the deterministic floor alone and the model had no way to
say that a file was riskier than its path suggested. The gap was recorded in code comments as
"task 10.1 is committed" and was never a product decision.

## What Changes

- A new protocol message kind, `riskProposal`: a bounded list (1 to 64 entries) of
  `{ memberId, path, risk, logicalUnit?, reason? }`. Legal in planning and investigating, not in
  verifying; at most one per turn; malformed input goes through the normal bounded repair path.
- The host applies the higher of the proposal, its floor, and the risk already recorded. It
  never lowers a risk, never adds a file to the inventory, and leaves inspected and terminal files
  alone. A path or member that is not in the inventory is refused with a recorded failed activity
  entry and no repair request.
- Any change reaches the activity channel as a coverage fact. A raise made after the
  coverage-versus-budget forecast has run re-states that forecast, replacing the earlier statement
  in place.
- A turn containing only risk proposals is not investigation work: it is answered like a stop.
- The turn schema, the batch-rule prose and the model-facing contract list the new kind.
- The demo participant sends one proposal during investigating.
- Resume needs no new persisted field: applied risk and logical unit already round-trip through the
  checkpoint's coverage records.

Not changed: "Coverage and risk govern investigation" (`add-local-git-investigation` modifies it),
and the two requirements `harden-harness-verification-completion` modifies.

## Impact

- Prompt: about 270 bytes more per model turn. The scoped small-review cost ceiling moves from
  87,000 to 90,000 bytes (measured 86,890 before, 88,787 after); the unscoped one stays at 94,000
  (91,958 before, 93,855 after).
- A model that raises many files to `high` lets turns draw the high-risk reserve and subjects
  findings on those files to the contradiction check. That is the same trade the host floor
  already makes for sensitive paths, now available to the model; it adds obligations rather than
  removing them.
