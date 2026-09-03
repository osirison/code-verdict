import { describe, expect, it } from 'vitest';
import type { ChangedFileEntry, InvestigationSnapshotRef } from '../platform/types';
import {
  blockerLimitation,
  classifyOutcome,
  COMPLETION_CLAUSES,
  evaluateCompletion,
  MAX_MISSING_CONDITIONS,
  respondToCompletionRequest,
  type CompletionEvaluationInput,
} from './harnessCompletion';
import { createChangedFileInventory, type ChangedFileInventory } from './harnessInventory';

const SNAPSHOT: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };

function entry(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, ...overrides };
}

/** One member, complete manifest, every file classified and inspected. */
function completeInventory(paths = ['src/a.ts', 'src/b.ts']): ChangedFileInventory {
  const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
  inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: paths.map((path) => entry(path)) });
  for (const path of paths) {
    inventory.classify('m1', path, { risk: 'low' });
    inventory.markInspected('m1', path);
  }
  return inventory;
}

/** Every D11 clause satisfied. Each test below breaks exactly one thing. */
function passing(overrides: Partial<CompletionEvaluationInput> = {}): CompletionEvaluationInput {
  return {
    heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'head-1' } }],
    inventory: completeInventory(),
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    citations: { revalidated: true, invalidatedCount: 0 },
    passes: { contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true },
    budget: { hardExhausted: false, timedOut: false },
    ...overrides,
  };
}

describe('deterministic completion gate (task 8.7)', () => {
  it('is eligible with no blockers when every clause passes', () => {
    const evaluation = evaluateCompletion(passing());
    expect(evaluation.eligible).toBe(true);
    expect(evaluation.blockers).toEqual([]);
    expect(evaluation.details).toEqual([]);
    expect(evaluation.repairable).toBe(false);
    for (const clause of COMPLETION_CLAUSES) expect(evaluation.clauses[clause]).toBe(true);
  });

  it('fails headUnchanged when the provider reports a different head', () => {
    const evaluation = evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'head-2' } }] }));
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.clauses.headUnchanged).toBe(false);
    expect(evaluation.blockers).toEqual(['headChanged']);
    expect(evaluation.details[0]).toMatchObject({ blocker: 'headChanged', clause: 'headUnchanged', memberId: 'm1', repairable: false });
    expect(COMPLETION_CLAUSES.filter((clause) => !evaluation.clauses[clause])).toEqual(['headUnchanged']);
  });

  it('fails headUnchanged as a provider limit when the head was never checked or cannot be resolved', () => {
    expect(evaluateCompletion(passing({ heads: [] })).blockers).toEqual(['providerLimit']);
    expect(evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: undefined }] })).blockers).toEqual(['providerLimit']);
    expect(evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'unavailable' } }] })).blockers).toEqual(['providerLimit']);
    expect(evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'notFound' } }] })).clauses.headUnchanged).toBe(false);
  });

  it('fails inventoryCompleteForEveryMember while a continuation is pending (repairable)', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'paginated', value: [entry('a')], cursor: 'c' });
    inventory.classify('m1', 'a', { risk: 'low' });
    inventory.markInspected('m1', 'a');
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.clauses.inventoryCompleteForEveryMember).toBe(false);
    expect(evaluation.blockers).toEqual(['incompleteInventory']);
    expect(evaluation.repairable).toBe(true);
    expect(COMPLETION_CLAUSES.filter((clause) => !evaluation.clauses[clause])).toEqual(['inventoryCompleteForEveryMember']);
  });

  it('fails inventoryCompleteForEveryMember as a provider limit when enumeration was truncated (not repairable)', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'truncated', value: [entry('a')], knownRemainingUnits: 300 });
    inventory.classify('m1', 'a', { risk: 'low' });
    inventory.markInspected('m1', 'a');
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.blockers).toEqual(['incompleteInventory', 'providerLimit']);
    expect(evaluation.repairable).toBe(false);
  });

  it('fails everyFileClassified for an unvisited file', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a'), entry('b')] });
    inventory.classify('m1', 'a', { risk: 'low' });
    inventory.markInspected('m1', 'a');
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.blockers).toEqual(['unclassifiedFiles']);
    expect(evaluation.details[0]).toMatchObject({ path: 'b', repairable: true });
    expect(COMPLETION_CLAUSES.filter((clause) => !evaluation.clauses[clause])).toEqual(['everyFileClassified']);
  });

  it('fails configuredRiskCoverageSatisfied for a required-risk file that was classified but not inspected', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    inventory.classify('m1', 'a', { risk: 'high' });
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.blockers).toEqual(['insufficientRiskCoverage']);
    expect(COMPLETION_CLAUSES.filter((clause) => !evaluation.clauses[clause])).toEqual(['configuredRiskCoverageSatisfied']);
    // Relaxed rules that do not require inspection at this level make the same inventory pass.
    const relaxed = evaluateCompletion(passing({ inventory, coverageRules: { requireInspection: ['medium'], reserveEligible: ['high'], contradictionCheck: [] } }));
    expect(relaxed.eligible).toBe(true);
  });

  it('treats unavailable and oversized files as completion blockers, binary and policy-excluded as satisfied', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a'), entry('b'), entry('c'), entry('d')] });
    for (const path of ['a', 'b', 'c', 'd']) inventory.classify('m1', path, { risk: 'high' });
    inventory.markTerminal('m1', 'a', 'binary', 'binary content');
    inventory.markTerminal('m1', 'b', 'excludedByPolicy', 'generated per AGENTS.md');
    expect(evaluateCompletion(passing({ inventory })).blockers).toEqual(['insufficientRiskCoverage']);
    inventory.markTerminal('m1', 'c', 'oversized', 'diff exceeds the result ceiling');
    inventory.markTerminal('m1', 'd', 'unavailable', 'provider returned unavailable');
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.blockers).toEqual(['unavailableOversizedPatch']);
    expect(evaluation.details.map((detail) => detail.path)).toEqual(['c', 'd']);
    expect(evaluation.repairable).toBe(false);
  });

  it('fails the unresolved-work clauses independently', () => {
    const fetches = evaluateCompletion(passing({ unresolved: { unresolvedFetches: 2, unresolvedCandidates: 0 } }));
    expect(fetches.blockers).toEqual(['unresolvedFetches']);
    expect(COMPLETION_CLAUSES.filter((clause) => !fetches.clauses[clause])).toEqual(['noUnresolvedFetches']);
    const candidates = evaluateCompletion(passing({ unresolved: { unresolvedFetches: 0, unresolvedCandidates: 1 } }));
    expect(candidates.blockers).toEqual(['unresolvedCandidates']);
    expect(COMPLETION_CLAUSES.filter((clause) => !candidates.clauses[clause])).toEqual(['noUnresolvedCandidates']);
  });

  it('fails everyRetainedCitationValid when citations were not revalidated or some were invalidated', () => {
    expect(evaluateCompletion(passing({ citations: { revalidated: false, invalidatedCount: 0 } })).blockers).toEqual(['verificationPending']);
    const invalid = evaluateCompletion(passing({ citations: { revalidated: true, invalidatedCount: 3 } }));
    expect(invalid.blockers).toEqual(['invalidCitations']);
    expect(COMPLETION_CLAUSES.filter((clause) => !invalid.clauses[clause])).toEqual(['everyRetainedCitationValid']);
  });

  it('fails each verification-pass clause independently', () => {
    const contradiction = evaluateCompletion(passing({ passes: { contradictionPassComplete: false, deduplicationComplete: true, finalVerificationComplete: true } }));
    expect(contradiction.blockers).toEqual(['contradictionPending']);
    expect(COMPLETION_CLAUSES.filter((clause) => !contradiction.clauses[clause])).toEqual(['contradictionPassComplete']);
    const dedupe = evaluateCompletion(passing({ passes: { contradictionPassComplete: true, deduplicationComplete: false, finalVerificationComplete: true } }));
    expect(dedupe.blockers).toEqual(['deduplicationPending']);
    const verification = evaluateCompletion(passing({ passes: { contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: false } }));
    expect(verification.blockers).toEqual(['verificationPending']);
    expect(COMPLETION_CLAUSES.filter((clause) => !verification.clauses[clause])).toEqual(['finalVerificationComplete']);
  });

  it('evaluates every clause without short-circuiting, so several failures all appear', () => {
    const evaluation = evaluateCompletion(
      passing({
        heads: [],
        unresolved: { unresolvedFetches: 1, unresolvedCandidates: 1 },
        citations: { revalidated: true, invalidatedCount: 1 },
        passes: { contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false },
      }),
    );
    expect(evaluation.blockers).toEqual([
      'providerLimit',
      'unresolvedFetches',
      'unresolvedCandidates',
      'invalidCitations',
      'contradictionPending',
      'deduplicationPending',
      'verificationPending',
    ]);
    expect(COMPLETION_CLAUSES.filter((clause) => evaluation.clauses[clause])).toEqual([
      'inventoryCompleteForEveryMember',
      'everyFileClassified',
      'configuredRiskCoverageSatisfied',
    ]);
  });

  it('adds budget exhaustion and timeout only as explanations of an otherwise failed predicate', () => {
    expect(evaluateCompletion(passing({ budget: { hardExhausted: true, timedOut: true } })).eligible).toBe(true);
    expect(evaluateCompletion(passing({ budget: { hardExhausted: true, timedOut: true } })).blockers).toEqual([]);
    const failed = evaluateCompletion(passing({ unresolved: { unresolvedFetches: 1, unresolvedCandidates: 0 }, budget: { hardExhausted: true, timedOut: true } }));
    expect(failed.blockers).toEqual(['unresolvedFetches', 'budgetExhausted', 'timeout']);
    expect(failed.repairable).toBe(false);
  });

  it('bounds per-clause details while still counting every failure', () => {
    const paths = Array.from({ length: 12 }, (_, index) => `f${index}.ts`);
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: paths.map((path) => entry(path)) });
    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.details).toHaveLength(5);
    expect(evaluation.blockers).toEqual(['unclassifiedFiles']);
    expect(evaluation.repairable).toBe(true);
  });

  it('evaluates head and inventory per member of a changeset', () => {
    const m2Snapshot: InvestigationSnapshotRef = { repoId: 'repo-2', baseSha: 'b2', headSha: 'h2' };
    const inventory = createChangedFileInventory([
      { memberId: 'm1', snapshot: SNAPSHOT },
      { memberId: 'm2', snapshot: m2Snapshot },
    ]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    inventory.classify('m1', 'a', { risk: 'low' });
    inventory.markInspected('m1', 'a');
    inventory.acceptManifestPage('m2', { snapshot: m2Snapshot, state: 'paginated', value: [entry('x')], cursor: 'c' });
    const evaluation = evaluateCompletion(
      passing({
        inventory,
        heads: [
          { memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'head-1' } },
          { memberId: 'm2', snapshotHeadSha: 'h2', currentHead: { repoId: 'repo-2', state: 'resolved', headSha: 'h3' } },
        ],
      }),
    );
    expect(evaluation.blockers).toEqual(['headChanged', 'incompleteInventory', 'unclassifiedFiles']);
    expect(evaluation.details.every((detail) => detail.memberId === 'm2')).toBe(true);
  });
});

describe('outcome classification (task 8.8)', () => {
  it('maps a passing gate with findings to complete findings that replace the retained review', () => {
    const outcome = classifyOutcome(evaluateCompletion(passing()), 3);
    expect(outcome).toEqual({ kind: 'completeFindings', completeness: 'complete', findingCount: 3, limitations: [], replacesRetainedReview: true, clean: false });
  });

  it('maps a passing gate with no findings to complete clean', () => {
    const outcome = classifyOutcome(evaluateCompletion(passing()), 0);
    expect(outcome).toEqual({ kind: 'completeClean', completeness: 'complete', findingCount: 0, limitations: [], replacesRetainedReview: true, clean: true });
  });

  it('maps a failing gate with findings to partial findings carrying every blocker as a limitation', () => {
    const evaluation = evaluateCompletion(passing({ unresolved: { unresolvedFetches: 0, unresolvedCandidates: 2 }, budget: { hardExhausted: true, timedOut: false } }));
    const outcome = classifyOutcome(evaluation, 2, { limitations: [{ code: 'budgetNearLimit', message: 'x' }] });
    expect(outcome.kind).toBe('partialFindings');
    expect(outcome.completeness).toBe('partial');
    expect(outcome.replacesRetainedReview).toBe(false);
    expect(outcome.clean).toBe(false);
    expect(outcome.limitations.map((limitation) => limitation.code)).toEqual(['budgetNearLimit', 'unresolvedCandidates', 'budgetExhausted']);
  });

  it('never treats incomplete no-findings as clean', () => {
    const evaluation = evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'other' } }] }));
    const outcome = classifyOutcome(evaluation, 0);
    expect(outcome).toMatchObject({ kind: 'failed', completeness: 'none', findingCount: 0, replacesRetainedReview: false, clean: false });
    expect(outcome.limitations).toEqual([blockerLimitation('headChanged')]);
  });

  it('keeps validated findings only as partial after cancellation, even when the gate would have passed', () => {
    const cancelled = classifyOutcome(evaluateCompletion(passing()), 1, { cancelled: true });
    expect(cancelled).toMatchObject({ kind: 'partialFindings', completeness: 'partial', replacesRetainedReview: false, clean: false });
    expect(cancelled.limitations.map((limitation) => limitation.code)).toEqual(['cancelled']);
    const cancelledEmpty = classifyOutcome(evaluateCompletion(passing()), 0, { cancelled: true });
    expect(cancelledEmpty).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });

  it('treats a garbage finding count as zero rather than guessing', () => {
    expect(classifyOutcome(evaluateCompletion(passing()), -1).kind).toBe('completeClean');
    expect(classifyOutcome(evaluateCompletion(passing()), Number.NaN).findingCount).toBe(0);
  });

  it('describes every blocker with a fixed public message', () => {
    expect(blockerLimitation('unavailableOversizedPatch')).toEqual({ code: 'unavailableOversizedPatch', message: expect.stringMatching(/unavailable or too large/) });
  });
});

describe('advisory completion request', () => {
  it('grants when the gate passes', () => {
    expect(respondToCompletionRequest(evaluateCompletion(passing()), { canContinue: true })).toEqual({ granted: true });
  });

  it('returns bounded repairable missing conditions while budget remains', () => {
    const paths = Array.from({ length: 30 }, (_, index) => `f${index}.ts`);
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: paths.map((path) => entry(path)) });
    const evaluation = evaluateCompletion(passing({ inventory, unresolved: { unresolvedFetches: 1, unresolvedCandidates: 1 }, citations: { revalidated: false, invalidatedCount: 0 } }));
    const response = respondToCompletionRequest(evaluation, { canContinue: true });
    expect(response.granted).toBe(false);
    if (response.granted) return;
    expect(response.repairable).toBe(true);
    expect(response.missingConditions.length).toBeLessThanOrEqual(MAX_MISSING_CONDITIONS);
    expect(response.blockers).toEqual(['unclassifiedFiles', 'unresolvedFetches', 'unresolvedCandidates', 'verificationPending']);
  });

  it('is not repairable when budget is gone or a blocker cannot be worked', () => {
    const repairableGate = evaluateCompletion(passing({ unresolved: { unresolvedFetches: 1, unresolvedCandidates: 0 } }));
    expect(respondToCompletionRequest(repairableGate, { canContinue: false })).toMatchObject({ granted: false, repairable: false });
    const changedHead = evaluateCompletion(passing({ heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'x' } }] }));
    expect(respondToCompletionRequest(changedHead, { canContinue: true })).toMatchObject({ granted: false, repairable: false, blockers: ['headChanged'] });
  });
});
