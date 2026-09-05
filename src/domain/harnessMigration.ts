/**
 * Legacy-read half of task 2.7 (`add-agentic-review-harness`, design.md D16,
 * migration plan step 1): a legacy successful review or run-history record —
 * written before any harness field existed — remains readable under
 * `legacy-one-shot` protocol provenance without fabricating a plan,
 * evidence, or coverage report for it. `LegacyReviewRead` and
 * `LegacyRunHistoryRead` have no plan/evidence/coverage fields at all, so
 * nothing here can invent one.
 *
 * The other half of 2.7 — unknown/malformed persisted enum values failing
 * closed — needs no new code: it is proved in this module's test by reusing
 * the `parseX` guards tasks 2.1-2.5 already export from their own files.
 */
import type { Review } from './types';
import { type ResultCompleteness } from './harnessLifecycle';
import { type ProtocolProvenance } from './harnessEvidence';

/** A retained review/triage draft is only ever written for a run that produced a result (`RetainedOutcome`). */
export interface LegacyReviewRead {
  crNumber: string;
  repoId: string;
  completeness: Extract<ResultCompleteness, 'complete'>;
  protocolProvenance: Extract<ProtocolProvenance, 'legacy-one-shot'>;
}

export function readLegacyReview(review: Pick<Review, 'crNumber' | 'repoId'>): LegacyReviewRead {
  return {
    crNumber: review.crNumber,
    repoId: review.repoId,
    completeness: 'complete',
    protocolProvenance: 'legacy-one-shot',
  };
}

export interface LegacyRunHistoryRead {
  completeness: ResultCompleteness;
  /** Absent for `interrupted`/`partial`: there is no complete result to attribute a legacy protocol to. */
  protocolProvenance?: ProtocolProvenance;
}

/**
 * Mirrors `ReviewRunOutcome` (`src/app/reviewRuns.ts`) structurally, without
 * importing the app layer. `'partial'` (task 12.5) can never actually reach
 * this *legacy* reader in practice — nothing before the harness ever wrote
 * it — but the branch keeps this mirror accurate rather than narrower than
 * the type it mirrors, and reports the same completeness `readRetained`'s
 * own partial-key default would.
 */
export function readLegacyRunHistory(run: { outcome: 'clean' | 'findings' | 'interrupted' | 'partial' }): LegacyRunHistoryRead {
  if (run.outcome === 'interrupted') return { completeness: 'none' };
  if (run.outcome === 'partial') return { completeness: 'partial' };
  return { completeness: 'complete', protocolProvenance: 'legacy-one-shot' };
}
