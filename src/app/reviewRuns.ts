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
 * without satisfying the host completion gate — `findingCount` validated
 * findings survived, which may be zero (a `failed` attempt's own live settle
 * records this outcome regardless of finding count, so its checkpoint's
 * plan/coverage stay reachable for a fresh-budget new attempt even when
 * nothing was found yet). Explicitly its own outcome, never folded into
 * `findings`: a partial result is not retained as the target's complete
 * review (`retainedReview.ts`'s `partialDraftKeyFor`, a separate key) and
 * must never be presented as if it were one.
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
   * Task 12.7 (extended for the budget-exhausted resume feature): whether a
   * stored harness checkpoint for this entry's lineage passed
   * `harnessResume.ts`'s stored-checkpoint integrity check
   * (`checkCheckpointIntegrity`) — the *offer*, not a live compatibility
   * decision against the current head/model/policy (`decideResume`'s
   * remaining dimensions, checked live only once a reviewer actually clicks
   * through). Two different writers set this, for two different outcomes,
   * never confused for each other by a reader (`ReviewRunManager.
   * deriveRunControls` keys on `outcome` first): the activation sweep for an
   * `interrupted` entry (a crash — carried-forward budget on resume), and
   * `ReviewRunManager.completeAttempt`'s own live `failed` settle (or the
   * sweep's live-terminal-checkpoint branch, if the extension host stopped
   * before that live settle's own write landed) for a `partial` entry whose
   * underlying attempt ended `failed`, most commonly on a budget-exhaustion
   * blocker (fresh budget on resume). Absent whenever no checkpoint data was
   * available to check at all, or checked from a lifecycle this feature
   * gives no offer for at all (`succeeded`, or a `partial` entry whose
   * attempt was `cancelled` rather than `failed`).
   */
  resumable?: boolean;
  /**
   * Task 14.4/14.6: every failing dimension `checkCheckpointIntegrity`
   * (`harnessResume.ts`) found, when there was a checkpoint to check at all
   * — present only alongside `resumable: false`, so a UI reading this never
   * has to fabricate a reason for a resumable run or an entry nothing
   * checked. This is the *stored-checkpoint-integrity* subset of the full
   * resume decision (`decideResume`'s remaining live head/model/policy
   * dimensions still need a live candidate snapshot, checked only once a
   * reviewer actually clicks through — see `ReviewRun.resumable`'s own doc
   * comment) — enough to tell a reviewer truthfully why the checkpoint
   * itself cannot be trusted, never a claim that every resume dimension was
   * checked.
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
  /**
   * Task 14.6 (extended for the budget-exhausted resume feature): the
   * harness lineage this entry's checkpoint data (`resumable`/
   * `resumeReasons` above) came from — the durable target-to-lineage lookup
   * a resume control needs once `InFlightRunStore`'s own entry is gone (for
   * an `interrupted` entry, the activation sweep clears it unconditionally,
   * the same call that writes this record; a live `failed` settle never had
   * one to begin with — `ReviewRunManager.completeAttempt` reads
   * `RunRecord.lineageId` directly). Present only when a writer actually had
   * a `lineageId` to record alongside a computed `resumable`; absent for
   * every entry from before this field existed and for every outcome this
   * feature gives no offer for (`clean`, `findings`, and a `partial` entry
   * whose attempt was `cancelled` rather than `failed`).
   */
  lineageId?: string;
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
   * `record()`, but only when no row already stored for this ref is at least
   * as fresh as `run` itself — compared by `ranAt`, the same field `list()`/
   * `byRef()` already expose as "when did this happen". Plain `record()`
   * trusts its caller to be reporting the newest event on the ref, which
   * `ReviewRunManager`'s live settle path always is (it stamps `ranAt` from
   * the clock at the moment it writes, for the ref it just finished). The
   * activation sweep (`reviewRunManager.ts`'s `sweepInterruptedRuns`) cannot
   * make that promise: it derives `ranAt` from a leftover in-flight marker's
   * own `startedAt`, captured before a crash, and its write can land well
   * after a *newer* run on the same target — one that started after the
   * crash and has already recorded its own richer row — because the sweep's
   * loop runs one leftover entry at a time with awaits in between. Skipping
   * the write when the stored row is already this fresh or fresher is what
   * keeps that race from clobbering the newer row with stale, crash-derived
   * data. Ties keep the stored row: a marker's `startedAt` can never postdate
   * a settle that raced ahead of it, so an equal `ranAt` only happens when
   * the stored row already *is* this same event.
   */
  async recordIfFresher(run: ReviewRun): Promise<void> {
    const existing = this.list().find((r) => r.repoId === run.repoId && r.crNumber === run.crNumber);
    if (existing && existing.ranAt >= run.ranAt) return;
    await this.record(run);
  }

  /**
   * Keyed the same way `submittedRefs()` is, so the dashboard can ask both
   * questions about one row with one lookup each.
   */
  byRef(): ReadonlyMap<string, ReviewRun> {
    return new Map(this.list().map((run) => [crKey(run.repoId, run.crNumber), run]));
  }
}
