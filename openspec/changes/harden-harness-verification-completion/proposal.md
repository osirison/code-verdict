## Why

Two defects in the review harness let a run claim more than it did.

1. A finding whose contradiction check the host had given up on still let the run end
   `succeeded`/`complete`. The no-progress bound (`MAX_UNVERIFIABLE_CONTRADICTION_STREAK`) retires
   a candidate after three identical failures so the model is no longer told to repair it — right —
   but it also made the contradiction and final-verification passes read complete. The completion
   gate then passed, the run was persisted `succeeded`, the retained review was replaced, and the
   unchecked finding was shown as an ordinary one with only a limitation line to say otherwise.
   An unchecked finding is not a checked finding; a run that could not check one is partial.

2. Contradiction checks were the only model calls in an attempt that drew on no budget. The pass
   calls the model directly, outside the turn loop's `beginTurn`, so a pass over many findings ran
   on past the model-turn pool and past the elapsed-time limit — the limit is checked only when a
   reservation is made or a retry is about to wait, and nothing in the pass made either. The re-run
   triggered by a completion request mid-turn had no gate at all.

## What Changes

- The completion gate takes the retired candidates that still survive as input and fails the
  contradiction-pass clause for each, as a failure nothing on this attempt can repair. The
  evaluation stays repairable while other repairable work is open and becomes unrepairable once
  retirements are all that is left. No new blocker code: the clause fails under
  `contradictionPending`, with a detail naming the candidate and the cause.
- A completion request denied as unrepairable during `verifying` ends the phase, so the run
  finalizes truthfully instead of repeating identical denials until the budget runs out — the
  hang the no-progress bound was added to close would otherwise return the moment a retirement
  stopped granting completion.
- The run ends `partialFindings`/`failed` with the findings still delivered on the failure card,
  the retained review untouched, and the start-a-fresh-attempt offer kept. A retirement a later
  re-run resolves is still retracted, so a complete outcome stays reachable.
- Every contradiction check reserves one model turn from the shared `modelTurns` pool (purpose
  `verification`, host-initiated, through `reserve`, never `beginTurn`) before its first ask; repair
  asks are absorbed under that reservation, and the attempt clock is re-read before each repair.
  A refusal or the elapsed limit stops the pass the way cancellation does: the unasked findings are
  kept, none is recorded as failed, and one limitation names the unchecked count and the reason.
  The mid-turn re-run goes through the same reservation.
- A pass the budget stopped never counts as "every unverified candidate retired", and never
  retracts a retirement for a candidate it did not re-ask.

## Impact

- `src/app/harnessCompletion.ts` — `retiredContradictions` input, `disclose` helper.
- `src/app/harnessAttempt.ts` — `reserveModelCall`, `ContradictionPassStop`, retired survivors fed
  to the gate, phase end on an unrepairable denial, `contradictionPassStopped` limitation.
- `src/app/harnessSynthesisVerification.ts` — reservation per finding, elapsed re-check per repair,
  `stoppedEarly`.
- Existing expectations that change: the two no-progress-bound tests that asserted `succeeded`
  over a retired finding now assert `partialFindings`.
- No persisted shape changes: the reservation draws the existing pool and lanes.
