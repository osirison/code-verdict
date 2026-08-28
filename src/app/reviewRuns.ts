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
 */
export type ReviewRunOutcome = 'clean' | 'findings' | 'interrupted';

export interface ReviewRun {
  repoId: string;
  crNumber: string;
  outcome: ReviewRunOutcome;
  /** 0 on a clean run; kept explicit so the pill never has to infer a count. */
  findingCount: number;
  agentLabel: string;
  ranAt: string;
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
