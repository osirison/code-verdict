## 1. Completion gate

- [x] 1.1 Add `retiredContradictions` to `CompletionEvaluationInput`, with a `disclose` helper that fails `contradictionPassComplete` under `contradictionPending` as a non-repairable detail without counting toward the repairability of the rest.
- [x] 1.2 Tests: retired candidates alone make the evaluation unrepairable; a retirement alongside repairable work leaves it repairable; an empty list changes nothing.

## 2. Attempt

- [x] 2.1 Feed every retired candidate still among the delivered findings to the gate (`retiredSurvivors`), sorted.
- [x] 2.2 End the `verifying` phase when a completion request is denied as unrepairable (`ProcessMessagesOutcome.completionDeniedUnrepairably`).
- [x] 2.3 Keep the no-progress bound and both counters; they still clear live blockers and never grant completion on their own. Update their doc comments.
- [x] 2.4 Supply `reserveModelCall` to the collaborator as a host-initiated one-turn `budget.reserve` of purpose `verification`.
- [x] 2.5 Record a stopped pass as one `contradictionPassStopped` limitation (replaced on re-run), guard retraction and the bound on `stoppedEarly`.
- [x] 2.6 Tests: the finding-1 and finding-3 shapes end `partialFindings` within four verifying turns; a retired-then-verified candidate ends complete; the pool running out mid-pass makes no further call and keeps the retirement; a stopped pass never reads as "every candidate retired"; the elapsed limit mid-pass ends partial with a timeout blocker and the unchecked count; every check adds one turn to the attempt's tally.

## 3. Collaborator

- [x] 3.1 Reserve once per finding before its first ask, after the directive proved askable; absorb repairs under it; re-check the elapsed limit before each repair.
- [x] 3.2 On refusal or the limit, stop the stage as cancellation does: keep the remainder, emit no `unverified` entries, set `stoppedEarly` (except for a `cancelled` refusal, which the run's own cancelled limitation already discloses).
- [x] 3.3 Tests: refusal makes no model call and names the unchecked count; one reservation covers repairs; an unexcerptable citation reserves nothing; a repair past the limit is not sent.

## 4. Budget tracker

- [x] 4.1 Test that a host-initiated model-turn reservation charges the pool through the verification lane and leaves the per-turn tool counter alone, unlike `beginTurn`.

## 5. Docs

- [x] 5.1 Update `docs/ARCHITECTURE.md` where it describes completion and verification budgets.
- [x] 5.2 Update the module headers of `harnessSynthesisVerification.ts` and the `MAX_UNVERIFIABLE_CONTRADICTION_STREAK` doc comment.
