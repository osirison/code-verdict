/**
 * Review-run history (globalState): what the agent RETURNED, which is not
 * what was submitted. `ReviewHistory` means "this review was posted to the
 * platform" and `submittedRefs()` feeds the posted-review screen and the
 * tuning scorecard — so a run that came back clean must never be faked as an
 * entry there. Without this store a clean run wrote nothing at all: the
 * dashboard kept reading "not run" for a change request the agent had
 * already cleared, and pressing ⟳ changed nothing, which is what made the
 * refresh button look dead.
 *
 * Latest run per change request wins. A re-run supersedes its predecessor —
 * only the current verdict on the current head is worth showing.
 */
import { crKey } from './postedReviews';
import type { KeyValueStore } from './storage';
import type { Limitation } from '../domain/harnessActivity';

/**
 * `clean` = the agent ran and returned nothing; `findings` = it ran and left
 * N items waiting for triage. Both are "reviewed" for coverage purposes; only
 * a `ReviewHistory` entry is "submitted".
 *
 * `interrupted` = it was still running when the extension host stopped. A
 * `vscode.lm` stream cannot be reattached afterwards, so the run is genuinely
 * gone; recording it is how the change request avoids silently reading
 * whatever it read before, which is indistinguishable from never having run.
 * It is neither reviewed nor submitted, and counts towards no coverage.
 *
 * `partial` (task 12.5, design.md D11) = the run ended (failed or cancelled)
 * with some validated findings but did not satisfy the host completion gate.
 * Explicitly its own outcome, never folded into `findings`: a partial result
 * is not retained as the target's complete review (`retainedReview.ts`'s
 * `partialDraftKeyFor`, a separate key) and must never be presented as if it
 * were one.
 */
export type ReviewRunOutcome = 'clean' | 'findings' | 'interrupted' | 'partial';

export interface ReviewRun {
  repoId: string;
  crNumber: string;
  outcome: ReviewRunOutcome;
  /** 0 on a clean run; kept explicit so the pill never has to infer a count. */
  findingCount: number;
  agentLabel: string;
  ranAt: string;
  /**
   * Task 12.7: for an `interrupted` entry the activation sweep could match
   * against a stored harness checkpoint, whether `harnessResume.ts`'s stored-
   * checkpoint integrity check (`checkCheckpointIntegrity`) found the
   * checkpoint itself sound — the *offer*, not a live compatibility decision
   * against the current head/model/policy (`decideResume`'s remaining
   * dimensions), which needs a live snapshot no code path feeding the
   * activation sweep builds yet. Absent whenever no checkpoint data was
   * available to check at all (the ordinary case today, and every entry not
   * produced by the sweep).
   */
  resumable?: boolean;
  /**
   * Task 14.4/14.6: every failing dimension `checkCheckpointIntegrity`
   * (`harnessResume.ts`) found for an `interrupted` entry, when there was
   * a checkpoint to check at all — present only alongside `resumable:
   * false`, so a UI reading this never has to fabricate a reason for a
   * resumable run or an entry the sweep had nothing to check. This is the
   * *stored-checkpoint-integrity* subset of the full resume decision
   * (`decideResume`'s remaining live head/model/policy dimensions still
   * need a live candidate snapshot no code path here builds yet — see
   * `ReviewRun.resumable`'s own doc comment) — enough to tell a reviewer
   * truthfully why the checkpoint itself cannot be trusted, never a claim
   * that every resume dimension was checked.
   */
  resumeReasons?: readonly Limitation[];
  /**
   * Task 14.4: `HarnessAttemptResult.outcome.limitations` for a `partial`
   * entry — why the run stopped short of `complete`, the same reasons
   * `retainedReview.ts`'s own `RetainedResult.limitations` carries for a
   * durably retained partial. Absent for `clean`/`findings`/`interrupted`,
   * which have none of their own to report here.
   */
  limitations?: readonly Limitation[];
}

const KEY = 'codeVerdict.reviewRuns';

export class ReviewRunStore {
  constructor(private readonly store: KeyValueStore) {}

  list(): ReviewRun[] {
    return [...(this.store.get<ReviewRun[]>(KEY) ?? [])];
  }

  /** Latest-wins: the previous run on the same ref is dropped, not appended. */
  async record(run: ReviewRun): Promise<void> {
    const all = this.list().filter(
      (r) => !(r.repoId === run.repoId && r.crNumber === run.crNumber),
    );
    all.push(run);
    await this.store.update(KEY, all);
  }

  /**
   * Keyed the same way `submittedRefs()` is, so the dashboard can ask both
   * questions about one row with one lookup each.
   */
  byRef(): ReadonlyMap<string, ReviewRun> {
    return new Map(this.list().map((run) => [crKey(run.repoId, run.crNumber), run]));
  }
}
