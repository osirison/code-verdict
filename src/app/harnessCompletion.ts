/**
 * The deterministic host completion gate and outcome classification (tasks
 * 8.7/8.8 of `add-agentic-review-harness`, design.md D11, spec
 * `agentic-review-harness` "The host decides whether completion is valid",
 * `background-review-runs` "Lifecycle and result completeness are
 * independent").
 *
 * `evaluateCompletion` evaluates every clause of D11's predicate
 * independently — no short-circuit — so removing any single condition
 * surfaces exactly its own blocker (the mutation tests task 16.7 will lean
 * on). The model's `requestCompletion` is advisory: `respondToCompletionRequest`
 * turns a failed evaluation into bounded missing conditions only while the
 * blockers are repairable and budget remains; otherwise the caller finalizes.
 *
 * `classifyOutcome` maps a decision plus the validated-finding count to
 * `complete findings | complete clean | partial findings | failed (none)`.
 * "Clean" is reachable through exactly one path: every clause passed and no
 * finding survived. Incomplete-with-no-findings is `none`, never clean.
 * Lifecycle is deliberately not decided here — completeness and lifecycle are
 * independent (D2), and the run manager (section 12) owns the lifecycle.
 *
 * Budget exhaustion and timeout are not predicate clauses: a run whose every
 * clause passes is complete even if its budget is spent. They are reported as
 * explanatory blockers only alongside a failing clause, so `eligible: true`
 * never coexists with a non-empty blocker list.
 */
import type { Limitation } from '../domain/harnessActivity';
import type { CompletionBlocker, CompletionDecision, UnresolvedWork } from '../domain/harnessCoverage';
import type { ResultCompleteness } from '../domain/harnessLifecycle';
import type { CurrentHeadResult } from '../platform/types';
import type { ChangedFileInventory, ManifestEnumerationState } from './harnessInventory';
import { DEFAULT_RISK_COVERAGE_RULES, isReserveEligible, requiresInspection, type RiskCoverageRules } from './harnessRiskFloors';

export const COMPLETION_CLAUSES = [
  'headUnchanged',
  'inventoryCompleteForEveryMember',
  'everyFileClassified',
  'configuredRiskCoverageSatisfied',
  'noUnresolvedFetches',
  'noUnresolvedCandidates',
  'everyRetainedCitationValid',
  'contradictionPassComplete',
  'deduplicationComplete',
  'finalVerificationComplete',
] as const;

/** One entry per AND-clause of D11's predicate, in the design's order. */
export type CompletionClause = (typeof COMPLETION_CLAUSES)[number];

export interface MemberHeadCheck {
  readonly memberId: string;
  readonly snapshotHeadSha: string;
  /** The pre-completion provider check; `undefined` means it was never performed, which cannot pass. */
  readonly currentHead: CurrentHeadResult | undefined;
}

export interface CitationRevalidationSummary {
  /** Whether `revalidateFindings` ran after synthesis/verification on this attempt. */
  readonly revalidated: boolean;
  readonly invalidatedCount: number;
}

export interface VerificationPasses {
  readonly contradictionPassComplete: boolean;
  readonly deduplicationComplete: boolean;
  readonly finalVerificationComplete: boolean;
}

export interface BudgetExhaustionFacts {
  readonly hardExhausted: boolean;
  readonly timedOut: boolean;
}

export interface CompletionEvaluationInput {
  readonly heads: readonly MemberHeadCheck[];
  readonly inventory: ChangedFileInventory;
  readonly coverageRules?: RiskCoverageRules;
  readonly unresolved: UnresolvedWork;
  readonly citations: CitationRevalidationSummary;
  readonly passes: VerificationPasses;
  readonly budget?: BudgetExhaustionFacts;
}

export interface CompletionBlockerDetail {
  readonly blocker: CompletionBlocker;
  readonly clause?: CompletionClause;
  readonly memberId?: string;
  readonly path?: string;
  readonly message: string;
  /** Whether more investigation on this attempt could clear it (an in-progress manifest can; a truncated one cannot). */
  readonly repairable: boolean;
}

export interface CompletionEvaluation extends CompletionDecision {
  readonly clauses: Readonly<Record<CompletionClause, boolean>>;
  /** Bounded per clause; `repairable` below is computed over every failure, not just these. */
  readonly details: readonly CompletionBlockerDetail[];
  /** False when eligible (nothing to repair) or when any failure cannot be cleared by more investigation on this attempt. */
  readonly repairable: boolean;
}

const MAX_DETAILS_PER_CLAUSE = 5;

function pushBounded(details: CompletionBlockerDetail[], perClause: Map<CompletionClause, number>, detail: CompletionBlockerDetail & { clause: CompletionClause }): void {
  const count = perClause.get(detail.clause) ?? 0;
  if (count >= MAX_DETAILS_PER_CLAUSE) return;
  perClause.set(detail.clause, count + 1);
  details.push(Object.freeze(detail));
}

function inventoryBlockersFor(state: ManifestEnumerationState): readonly CompletionBlocker[] {
  switch (state) {
    case 'complete':
      return [];
    case 'inProgress':
      return ['incompleteInventory'];
    case 'truncated':
    case 'unavailable':
      return ['incompleteInventory', 'providerLimit'];
  }
}

/** Blockers the model can still act on with more turns; the rest cannot be repaired by further investigation. */
const REPAIRABLE_BLOCKERS: ReadonlySet<CompletionBlocker> = new Set<CompletionBlocker>([
  'unclassifiedFiles',
  'insufficientRiskCoverage',
  'unresolvedFetches',
  'unresolvedCandidates',
  'invalidCitations',
  'contradictionPending',
  'deduplicationPending',
  'verificationPending',
  // Unlike `declinedContent`, which is the source stating a policy it will
  // state again next turn, a read that resolved to nothing may well resolve on
  // the next one: a bound the invocation happened to hit, an object store that
  // recovered, a transient failure of a path the manifest still enumerates.
  // So the gate tells the model to read the file again rather than letting the
  // caller finalize a partial run over it — bounded, as every repairable
  // blocker is, by whether the budget would still grant the turn
  // (`respondToCompletionRequest`).
  'readFailed',
]);

export function evaluateCompletion(input: CompletionEvaluationInput): CompletionEvaluation {
  const rules = input.coverageRules ?? DEFAULT_RISK_COVERAGE_RULES;
  const clauses = {} as Record<CompletionClause, boolean>;
  const details: CompletionBlockerDetail[] = [];
  const perClause = new Map<CompletionClause, number>();
  const blockers = new Set<CompletionBlocker>();
  let failures = 0;
  let unrepairableFailures = 0;

  function fail(
    clause: CompletionClause,
    blocker: CompletionBlocker,
    message: string,
    where: { memberId?: string; path?: string } = {},
    repairable: boolean = REPAIRABLE_BLOCKERS.has(blocker),
  ): void {
    clauses[clause] = false;
    blockers.add(blocker);
    failures += 1;
    if (!repairable) unrepairableFailures += 1;
    pushBounded(details, perClause, { blocker, clause, message, repairable, ...where });
  }

  // 1. headUnchanged — one check per member; an unperformed or unresolved check cannot pass.
  clauses.headUnchanged = true;
  const inventoryMembers = input.inventory.members();
  const checkedMembers = new Set(input.heads.map((head) => head.memberId));
  for (const member of inventoryMembers) {
    if (!checkedMembers.has(member.memberId)) fail('headUnchanged', 'providerLimit', `Head of member ${member.memberId} was not verified before completion.`, { memberId: member.memberId });
  }
  for (const head of input.heads) {
    if (head.currentHead === undefined) {
      fail('headUnchanged', 'providerLimit', `Head of member ${head.memberId} was not verified before completion.`, { memberId: head.memberId });
    } else if (head.currentHead.state !== 'resolved' || head.currentHead.headSha === undefined) {
      fail('headUnchanged', 'providerLimit', `The provider could not resolve the current head of member ${head.memberId} (${head.currentHead.state}).`, { memberId: head.memberId });
    } else if (head.currentHead.headSha !== head.snapshotHeadSha) {
      fail('headUnchanged', 'headChanged', `Member ${head.memberId} head moved from ${head.snapshotHeadSha} to ${head.currentHead.headSha}.`, { memberId: head.memberId });
    }
  }

  // 2. inventoryCompleteForEveryMember
  clauses.inventoryCompleteForEveryMember = true;
  for (const member of inventoryMembers) {
    for (const blocker of inventoryBlockersFor(member.enumeration)) {
      const message =
        blocker === 'providerLimit'
          ? `Member ${member.memberId}: ${member.reason ?? 'the provider limited the changed-file manifest'}.`
          : `Member ${member.memberId}: changed-file enumeration is ${member.enumeration} (${member.files.length} known so far).`;
      fail('inventoryCompleteForEveryMember', blocker, message, { memberId: member.memberId }, member.enumeration === 'inProgress');
    }
  }

  // 3. everyFileClassified, 4. configuredRiskCoverageSatisfied — per file, independent of clause 2.
  clauses.everyFileClassified = true;
  clauses.configuredRiskCoverageSatisfied = true;
  for (const member of inventoryMembers) {
    for (const file of member.files) {
      switch (file.state) {
        case 'unvisited':
          fail('everyFileClassified', 'unclassifiedFiles', `${file.path} has not been classified.`, { memberId: member.memberId, path: file.path });
          break;
        case 'classified':
          // Checked before risk, and independent of it. A declined file is not
          // uninspected by the host's choice, the way a low-risk file is: the
          // source refused to serve content the host asked for, and a run that
          // reports itself complete over it is claiming a review of bytes
          // nobody saw. Leaving this to the risk floors would make the
          // guarantee depend on the file's extension — a declined `.ts` blocks
          // completion through the source-code floor while a declined `.md`
          // does not — and the fix this blocker exists for was measured on a
          // change where the state was assigned wrongly to two thirds of it.
          if (file.contentDeclined === true) {
            fail('configuredRiskCoverageSatisfied', 'declinedContent', `${file.path}: the investigation source did not serve this file's content, so it was never read.`, { memberId: member.memberId, path: file.path });
          } else if (file.readFailed === true) {
            // The same reasoning as the branch above, for the other way a
            // source can leave a changed file unread. Design D8 closes by
            // promising that "an unobtainable revision, a timed-out invocation
            // and a suppressed patch all leave the affected file classified and
            // uninspected, which the completion gate already refuses to call
            // complete" — and before this branch existed that sentence was
            // false for a low-risk file: the `unknown` result closed nothing
            // (correctly) and blocked nothing (not correctly), so a run whose
            // every read of a `.md` file failed ended eligible with no blockers
            // at all. Checked ahead of risk, and independent of it, for the
            // reason `declinedContent` is: a guarantee that holds for a failed
            // read of a `.ts` file and not of a `.md` one is a guarantee about
            // file extensions, not about coverage.
            fail('configuredRiskCoverageSatisfied', 'readFailed', `${file.path}: a read of this file resolved to nothing the investigation source established, so it was never read.`, { memberId: member.memberId, path: file.path });
          } else if (file.risk !== undefined && requiresInspection(file.risk, rules)) {
            fail('configuredRiskCoverageSatisfied', 'insufficientRiskCoverage', `${file.path} (${file.risk} risk) was classified but never inspected.`, { memberId: member.memberId, path: file.path });
          }
          break;
        case 'unavailable':
        case 'oversized':
          fail('configuredRiskCoverageSatisfied', 'unavailableOversizedPatch', `${file.path}: ${file.reason ?? file.state}.`, { memberId: member.memberId, path: file.path });
          break;
        case 'inspected':
        case 'excludedByPolicy':
        case 'binary':
          break;
      }
    }
  }

  // 5./6. unresolved work
  clauses.noUnresolvedFetches = true;
  if (input.unresolved.unresolvedFetches > 0) fail('noUnresolvedFetches', 'unresolvedFetches', `${input.unresolved.unresolvedFetches} tool fetch(es) have not resolved.`);
  clauses.noUnresolvedCandidates = true;
  if (input.unresolved.unresolvedCandidates > 0) fail('noUnresolvedCandidates', 'unresolvedCandidates', `${input.unresolved.unresolvedCandidates} candidate finding(s) remain unresolved.`);

  // 7. everyRetainedCitationValid
  clauses.everyRetainedCitationValid = true;
  if (!input.citations.revalidated) fail('everyRetainedCitationValid', 'verificationPending', 'Retained citations have not been revalidated after synthesis.');
  if (input.citations.invalidatedCount > 0) fail('everyRetainedCitationValid', 'invalidCitations', `${input.citations.invalidatedCount} retained citation(s) no longer resolve.`);

  // 8.-10. verification passes
  clauses.contradictionPassComplete = true;
  if (!input.passes.contradictionPassComplete) fail('contradictionPassComplete', 'contradictionPending', 'The contradiction pass has not completed.');
  clauses.deduplicationComplete = true;
  if (!input.passes.deduplicationComplete) fail('deduplicationComplete', 'deduplicationPending', 'Deduplication has not completed.');
  clauses.finalVerificationComplete = true;
  if (!input.passes.finalVerificationComplete) fail('finalVerificationComplete', 'verificationPending', 'Final verification has not completed.');

  const eligible = COMPLETION_CLAUSES.every((clause) => clauses[clause]);
  if (!eligible && input.budget) {
    if (input.budget.hardExhausted) {
      blockers.add('budgetExhausted');
      unrepairableFailures += 1;
      details.push(Object.freeze({ blocker: 'budgetExhausted', message: 'A hard run budget is exhausted; remaining conditions cannot be worked.', repairable: false }));
    }
    if (input.budget.timedOut) {
      blockers.add('timeout');
      unrepairableFailures += 1;
      details.push(Object.freeze({ blocker: 'timeout', message: 'The attempt reached its elapsed-time limit.', repairable: false }));
    }
  }
  return Object.freeze({
    eligible,
    blockers: Object.freeze([...blockers]),
    clauses: Object.freeze(clauses),
    details: Object.freeze(details),
    repairable: !eligible && failures > 0 && unrepairableFailures === 0,
  });
}

// ---- Coverage-versus-budget forecast ----------------------------------------

/** One pool's remaining lane capacity at the moment of the forecast, read off `BudgetState.pools[pool].lanes`. */
export interface CoverageForecastLanes {
  readonly ordinaryRemaining: number;
  readonly highRiskReserveRemaining: number;
}

export interface CoverageForecastInput {
  readonly inventory: ChangedFileInventory;
  readonly coverageRules?: RiskCoverageRules;
  readonly toolCalls: CoverageForecastLanes;
  readonly modelTurns: CoverageForecastLanes;
  readonly maxToolRequestsPerTurn: number;
}

export interface CoverageShortfall {
  /** Files whose risk requires inspection and that are still only `classified`. */
  readonly requiredReads: number;
  /** Of those, how many may draw the high-risk reserve (`RiskCoverageRules.reserveEligible`). */
  readonly reserveEligibleReads: number;
  /** The most file reads the investigation lanes could fund, under the floors documented on `forecastCoverageShortfall`. */
  readonly fundableReads: number;
  readonly limitation: Limitation;
}

/**
 * Compares required coverage against the budget lanes investigation may draw, at the one moment
 * both are first fully known: the manifest is enumerated (bootstrap pages it to exhaustion) and
 * every file is classified (`classifyAllUnvisited`, the first step of `investigating`).
 *
 * Nothing did this before, and a live run paid 80% of its budget to discover what was provable
 * up front. A 204-file change under the default policy partitions `toolCalls` 256 into
 * ordinary 167 / high-risk 51 / verification 38 and `modelTurns` 64 into 43/12/9. Reading each
 * file once needs 204 `readDiff` calls, plus four bootstrap host calls already charged to the
 * ordinary lane — but exploration may only ever draw `ordinary` (`LANE_ORDER`), and the change's
 * files were floored `medium` (source code), which the default rules exclude from the high-risk
 * reserve. So at least ~40 files that *required* inspection could never legally be read, however
 * well the model spent its turns. The run duly consumed the ordinary and verification lanes to
 * zero (205 of 256 calls, 52 of 64 turns — the remainders were exactly the two untouched
 * high-risk lanes) and stopped with `insufficientRiskCoverage`, reported only *after* the spend.
 * This forecast states the same arithmetic before the first investigating turn, so the reviewer
 * learns "this change is bigger than one attempt's budget" at the start, with exact counts — not
 * from a post-hoc limitations list. The exact counts also matter because the gate's per-clause
 * detail bound (`MAX_DETAILS_PER_CLAUSE`) truthfully names only the first few uninspected files.
 *
 * Two deliberate floors keep the claim honest — this predicts a *lane shortfall*, never the
 * run's outcome:
 * - Each required file costs at least one tool call to leave `classified` by any route (a
 *   `readDiff` that returns content, or one that discovers a terminal state), and at least
 *   `1/maxToolRequestsPerTurn` of a model turn. Real runs also spend calls on searches,
 *   submissions and re-reads, so a change this forecast passes can still fall short; one it
 *   flags cannot finish from the investigation lanes alone.
 * - Only the lanes investigation purposes may draw are counted: `ordinary` for every file,
 *   plus `highRiskReserve` for reserve-eligible files. The verification reserve is excluded
 *   on purpose even though reads issued during `verifying` draw it and do mark files
 *   inspected (`updateInventoryFromResult` has no phase guard — the 204-file run inspected
 *   ~38 files that way): that lane exists for verification, and coverage that only completes
 *   by consuming it has no budget left to verify with. Hence the limitation's wording:
 *   the remainder "could only be read by consuming the verification reserve".
 *
 * Returns `undefined` while the lanes can fund every required read — the common case, and the
 * reason this is a one-shot check rather than a per-turn nag.
 *
 * For a changeset the lane remainings are pool-level aggregates (private per-member slices
 * included), so the true fundable count can be lower still — one member cannot draw another's
 * private slice. Aggregates keep this an upper bound, which is the direction a floor must err.
 */
export function forecastCoverageShortfall(input: CoverageForecastInput): CoverageShortfall | undefined {
  const rules = input.coverageRules ?? DEFAULT_RISK_COVERAGE_RULES;
  let requiredReads = 0;
  let reserveEligibleReads = 0;
  for (const member of input.inventory.members()) {
    for (const file of member.files) {
      if (file.state !== 'classified' || file.risk === undefined || !requiresInspection(file.risk, rules)) continue;
      requiredReads += 1;
      if (isReserveEligible(file.risk, rules)) reserveEligibleReads += 1;
    }
  }
  if (requiredReads === 0) return undefined;

  // Best-case allocation: ordinary goes to the files that can use nothing else first; whatever
  // is left tops up the reserve-eligible files beyond their own lane. An upper bound by
  // construction, so `requiredReads > fundableReads` is proof, not pessimism.
  const nonReserveReads = requiredReads - reserveEligibleReads;
  const ordinaryToNonReserve = Math.min(nonReserveReads, input.toolCalls.ordinaryRemaining);
  const fundableByToolCalls =
    ordinaryToNonReserve +
    Math.min(reserveEligibleReads, input.toolCalls.highRiskReserveRemaining + (input.toolCalls.ordinaryRemaining - ordinaryToNonReserve));
  // Turn purposes are coarse (`choosePurpose`): the high-risk turn lane is reachable only while
  // reserve-eligible coverage remains, so it counts only when such files exist at all.
  const fundableTurns = input.modelTurns.ordinaryRemaining + (reserveEligibleReads > 0 ? input.modelTurns.highRiskReserveRemaining : 0);
  const fundableReads = Math.max(0, Math.min(fundableByToolCalls, fundableTurns * input.maxToolRequestsPerTurn));
  if (requiredReads <= fundableReads) return undefined;

  return Object.freeze({
    requiredReads,
    reserveEligibleReads,
    fundableReads,
    limitation: Object.freeze({
      code: 'coverageExceedsBudget',
      message:
        `${requiredReads} file(s) require inspection but the investigation budget can fund at most ${fundableReads} more file read(s); ` +
        `the rest could only be read by consuming the verification reserve. ` +
        `Raise the run budgets or review this change in smaller pieces.`,
    }),
  });
}

// ---- Outcome classification (task 8.8) --------------------------------------

export const COMPLETION_OUTCOME_KINDS = ['completeFindings', 'completeClean', 'partialFindings', 'failed'] as const;

export type CompletionOutcomeKind = (typeof COMPLETION_OUTCOME_KINDS)[number];

export interface CompletionOutcome {
  readonly kind: CompletionOutcomeKind;
  readonly completeness: ResultCompleteness;
  readonly findingCount: number;
  readonly limitations: readonly Limitation[];
  /** Only a complete result may replace a complete retained review (D2/D16). */
  readonly replacesRetainedReview: boolean;
  /** True only for `completeClean`; a partial or failed run with no findings is never clean. */
  readonly clean: boolean;
  /**
   * `evaluation.details` verbatim (task 13.4): one member's incompleteness must not be hidden
   * inside `limitations`' deduplicated, member-anonymous blocker codes — a changeset with one
   * incomplete member among several complete ones needs the aggregate result to name which
   * member and why. Empty whenever `eligible` is true, since `evaluateCompletion` only ever
   * pushes a detail alongside a failing clause. Additive and optional so every existing
   * `CompletionOutcome` construction site and assertion (`.limitations`, `toMatchObject`)
   * keeps working unchanged. Present only from `classifyOutcome` itself; other
   * `CompletionOutcome` construction sites (bootstrap failure, the legacy one-shot adapter)
   * predate any per-member evaluation and correctly leave it absent.
   */
  readonly blockerDetails?: readonly CompletionBlockerDetail[];
}

export interface ClassifyOutcomeOptions {
  /** The reviewer cancelled: validated findings survive only as partial, never as complete. */
  readonly cancelled?: boolean;
  /** Additional limitations the caller already knows (budget warnings, bootstrap limits). */
  readonly limitations?: readonly Limitation[];
}

const BLOCKER_MESSAGES: Readonly<Record<CompletionBlocker, string>> = Object.freeze({
  headChanged: 'The target head changed after the snapshot was taken.',
  incompleteInventory: 'The changed-file inventory is incomplete.',
  unclassifiedFiles: 'Some changed files were never classified.',
  insufficientRiskCoverage: 'Files at a risk level that requires inspection were not inspected.',
  unresolvedFetches: 'Some tool fetches never resolved.',
  unresolvedCandidates: 'Some candidate findings remain unresolved and are not shown.',
  invalidCitations: 'Some retained citations no longer resolve to model-visible evidence.',
  contradictionPending: 'The contradiction pass did not complete.',
  deduplicationPending: 'Deduplication did not complete.',
  verificationPending: 'Final verification did not complete.',
  budgetExhausted: 'A run budget was exhausted.',
  timeout: 'The attempt reached its elapsed-time limit.',
  providerLimit: 'A provider limit prevented complete investigation.',
  unavailableOversizedPatch: 'Some changed content was unavailable or too large to inspect.',
  declinedContent: 'The investigation source did not serve some changed files, so they were never read.',
  readFailed: 'Reading some changed files resolved to nothing the investigation source established, so they were never read.',
});

export function blockerLimitation(blocker: CompletionBlocker): Limitation {
  return { code: blocker, message: BLOCKER_MESSAGES[blocker] };
}

export function classifyOutcome(evaluation: CompletionEvaluation, findingCount: number, options: ClassifyOutcomeOptions = {}): CompletionOutcome {
  const count = Number.isInteger(findingCount) && findingCount >= 0 ? findingCount : 0;
  const limitations: Limitation[] = [...(options.limitations ?? [])];
  const complete = evaluation.eligible && options.cancelled !== true;
  if (!complete) {
    for (const blocker of evaluation.blockers) limitations.push(blockerLimitation(blocker));
    if (options.cancelled === true) limitations.push({ code: 'cancelled', message: 'The reviewer cancelled the run before completion.' });
  }
  // `evaluation.details` is always empty when `eligible` (no clause ever failed to push one), so this
  // key is omitted whenever there is nothing to report — every existing exact-equality assertion on a
  // complete outcome keeps matching a literal with no `blockerDetails` field at all.
  const blockerDetails = evaluation.details.length > 0 ? { blockerDetails: evaluation.details } : {};
  if (complete) {
    return Object.freeze({
      kind: count > 0 ? 'completeFindings' : 'completeClean',
      completeness: 'complete',
      findingCount: count,
      limitations: Object.freeze(limitations),
      replacesRetainedReview: true,
      clean: count === 0,
      ...blockerDetails,
    });
  }
  if (count > 0) {
    return Object.freeze({ kind: 'partialFindings', completeness: 'partial', findingCount: count, limitations: Object.freeze(limitations), replacesRetainedReview: false, clean: false, ...blockerDetails });
  }
  return Object.freeze({ kind: 'failed', completeness: 'none', findingCount: 0, limitations: Object.freeze(limitations), replacesRetainedReview: false, clean: false, ...blockerDetails });
}

// ---- Advisory completion request (D11 "repairable early completion") ----------

export const MAX_MISSING_CONDITIONS = 10;

export interface CompletionRequestBudget {
  /** Whether the budget tracker would still grant a turn and a tool call for the remaining work. */
  readonly canContinue: boolean;
}

export type CompletionRequestResponse =
  | { readonly granted: true }
  | {
      readonly granted: false;
      /** True when every blocker is repairable and budget remains — the harness may continue. */
      readonly repairable: boolean;
      readonly missingConditions: readonly CompletionBlockerDetail[];
      readonly blockers: readonly CompletionBlocker[];
    };

export function respondToCompletionRequest(evaluation: CompletionEvaluation, budget: CompletionRequestBudget): CompletionRequestResponse {
  if (evaluation.eligible) return { granted: true };
  const repairable = budget.canContinue && evaluation.repairable;
  return {
    granted: false,
    repairable,
    missingConditions: Object.freeze(evaluation.details.slice(0, MAX_MISSING_CONDITIONS)),
    blockers: evaluation.blockers,
  };
}
