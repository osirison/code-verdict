import { describe, expect, it } from 'vitest';
import type { ChangedFileEntry, InvestigationSnapshotRef } from '../platform/types';
import {
  blockerLimitation,
  classifyOutcome,
  COMPLETION_CLAUSES,
  evaluateCompletion,
  forecastCoverageShortfall,
  MAX_MISSING_CONDITIONS,
  respondToCompletionRequest,
  type CompletionEvaluationInput,
  type CoverageForecastInput,
} from './harnessCompletion';
import { applyCoverageSeed, createChangedFileInventory, type ChangedFileInventory } from './harnessInventory';
import { preLocalGitCheckpointCoverage } from './migrationFixtures';
import type { MemberCoverage } from '../domain/harnessCoverage';

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

  it('names the incomplete member in the aggregate outcome without hiding it behind the other member\'s success (task 13.4)', () => {
    // A dedicated changeset scenario: m1 (e.g. "core") is fully inspected and its head is
    // unchanged; m2 (e.g. "billing") has a still-paginating manifest. The aggregate result must
    // say which member blocked completion and why, not just that *something* is incomplete —
    // `.limitations` alone (deduplicated, member-anonymous blocker codes) cannot do that; this
    // is what `blockerDetails` (task 13.4) exists to carry through `classifyOutcome`.
    const m2Snapshot: InvestigationSnapshotRef = { repoId: 'harness-cs-billing', baseSha: 'b2', headSha: 'h2' };
    const inventory = createChangedFileInventory([
      { memberId: 'core', snapshot: SNAPSHOT },
      { memberId: 'billing', snapshot: m2Snapshot },
    ]);
    inventory.acceptManifestPage('core', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    inventory.classify('core', 'a', { risk: 'low' });
    inventory.markInspected('core', 'a');
    inventory.acceptManifestPage('billing', { snapshot: m2Snapshot, state: 'paginated', value: [entry('x')], cursor: 'c' });
    const evaluation = evaluateCompletion(
      passing({
        inventory,
        heads: [
          { memberId: 'core', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'head-1' } },
          { memberId: 'billing', snapshotHeadSha: 'h2', currentHead: { repoId: 'harness-cs-billing', state: 'resolved', headSha: 'h2' } },
        ],
      }),
    );
    const outcome = classifyOutcome(evaluation, 0);
    expect(outcome.completeness).not.toBe('complete');
    expect(outcome.blockerDetails?.length).toBeGreaterThan(0);
    expect(outcome.blockerDetails?.every((detail) => detail.memberId === 'billing')).toBe(true);
    expect(outcome.blockerDetails?.some((detail) => detail.message.includes('billing'))).toBe(true);
    // The generic, member-anonymous limitations stay exactly as every other caller already
    // relies on — `blockerDetails` is additive, not a replacement.
    expect(outcome.limitations).toEqual([blockerLimitation('incompleteInventory'), blockerLimitation('unclassifiedFiles')]);
  });
});

/**
 * `add-local-git-investigation` task 10.6, the resumed half.
 *
 * A low-risk file whose content the source declined does not block completion
 * through the risk floors — inspection is required at medium and above — so the
 * only thing standing between it and a run reported complete and clean is the
 * declined flag itself. This proves the flag survives the round trip a resumed
 * attempt makes: into the checkpoint's coverage and back onto a freshly
 * enumerated inventory.
 */
describe('a declined file replayed from a checkpoint still blocks completion (task 10.6)', () => {
  it('refuses a resumed run that would otherwise report itself complete and clean over content nobody was served', () => {
    const first = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    first.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/notes.md')] });
    first.classify('m1', 'docs/notes.md', { risk: 'low' });
    first.markContentDeclined('m1', 'docs/notes.md');

    const resumed = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    resumed.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/notes.md')] });
    applyCoverageSeed(resumed, [first.coverage('m1')!]);

    const evaluation = evaluateCompletion(passing({ inventory: resumed }));
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toEqual(['declinedContent']);
    expect(evaluation.details[0]).toMatchObject({ path: 'docs/notes.md', blocker: 'declinedContent' });

    // The control that makes the assertion about the decline and not about the
    // file: the same replay without it is complete and clean.
    const readable = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    readable.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/notes.md')] });
    readable.classify('m1', 'docs/notes.md', { risk: 'low' });
    applyCoverageSeed(readable, [readable.coverage('m1')!]);
    expect(evaluateCompletion(passing({ inventory: readable })).eligible).toBe(true);
  });
});

/**
 * `add-local-git-investigation` task 10.6, the case design D8 promised and the
 * gate did not keep.
 *
 * D8 closes: "An unobtainable revision, a timed-out invocation and a suppressed
 * patch all leave the affected file classified and uninspected, which the
 * completion gate already refuses to call complete." The first half was true —
 * an `unknown` read closes nothing. The second half was false at low risk:
 * inspection is required at medium and above, so a `.md` file whose diff the
 * source never served left the gate eligible with zero blockers, and the run
 * ended complete and clean.
 */
describe('a file whose read established nothing blocks completion at every risk level (task 10.6)', () => {
  function inventoryWithFailedRead(risk: 'low' | 'medium' | 'high'): ChangedFileInventory {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/notes.md')] });
    inventory.classify('m1', 'docs/notes.md', { risk });
    inventory.markReadFailed('m1', 'docs/notes.md');
    return inventory;
  }

  it('refuses a run whose only unread file is low risk, which no risk floor would have caught', () => {
    const evaluation = evaluateCompletion(passing({ inventory: inventoryWithFailedRead('low') }));
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toEqual(['readFailed']);
    expect(evaluation.clauses.configuredRiskCoverageSatisfied).toBe(false);
    expect(evaluation.details[0]).toMatchObject({ path: 'docs/notes.md', blocker: 'readFailed' });
    expect(classifyOutcome(evaluation, 0).clean).toBe(false);
  });

  it('is repairable, because the very next read of the file may return the diff', () => {
    const evaluation = evaluateCompletion(passing({ inventory: inventoryWithFailedRead('low') }));
    expect(evaluation.repairable).toBe(true);
    expect(respondToCompletionRequest(evaluation, { canContinue: true })).toMatchObject({ granted: false, repairable: true });
  });

  it('stops blocking once the file is actually read', () => {
    const inventory = inventoryWithFailedRead('medium');
    inventory.markInspected('m1', 'docs/notes.md');
    expect(evaluateCompletion(passing({ inventory })).eligible).toBe(true);
  });

  it('survives the round trip through a checkpoint onto a resumed attempt', () => {
    const first = inventoryWithFailedRead('low');
    const resumed = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    resumed.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/notes.md')] });
    applyCoverageSeed(resumed, [first.coverage('m1')!]);

    expect(evaluateCompletion(passing({ inventory: resumed })).blockers).toEqual(['readFailed']);
  });
});

/**
 * `add-local-git-investigation` task 10.6, the half that reaches records
 * already on disk. A checkpoint written by the build that mapped a patchless
 * compare entry to `binary` carries that guess as a terminal state, and the
 * gate counts a terminal `binary` as satisfied — so replaying one unchecked
 * hands the resumed attempt the same complete-and-clean verdict over source
 * nobody read.
 */
describe('a binary state replayed from a pre-change checkpoint cannot make a run complete (task 10.6)', () => {
  function freshlyEnumerated(): ChangedFileInventory {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    // What the source says about the same three files today: it enumerated the
    // first two and did not serve their content.
    inventory.acceptManifestPage('m1', {
      snapshot: SNAPSHOT,
      state: 'complete',
      value: [
        entry('src/app/harnessInventory.ts', { contentDeclined: true, addedLines: undefined, removedLines: undefined }),
        entry('docs/notes.md', { contentDeclined: true, addedLines: undefined, removedLines: undefined }),
        entry('src/app/harnessCompletion.ts'),
      ],
    });
    return inventory;
  }

  it('refuses the resumed run rather than replaying the guess the old build recorded', () => {
    const inventory = freshlyEnumerated();
    applyCoverageSeed(inventory, preLocalGitCheckpointCoverage() as MemberCoverage[]);

    const evaluation = evaluateCompletion(passing({ inventory }));
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toEqual(['declinedContent']);
    expect(evaluation.details.map((detail) => detail.path)).toEqual(['src/app/harnessInventory.ts', 'docs/notes.md']);
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });

  it('still lets a corroborated binary state satisfy the gate, so resumable work is not thrown away', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', {
      snapshot: SNAPSHOT,
      state: 'complete',
      value: [entry('src/app/harnessInventory.ts', { binary: true }), entry('docs/notes.md', { binary: true }), entry('src/app/harnessCompletion.ts')],
    });
    applyCoverageSeed(inventory, preLocalGitCheckpointCoverage() as MemberCoverage[]);

    expect(evaluateCompletion(passing({ inventory })).eligible).toBe(true);
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

describe('coverage-versus-budget forecast (the 204-file live run)', () => {
  /** `count` medium-risk classified files (require inspection, not reserve-eligible) plus `highCount` high-risk ones. */
  function classifiedInventory(count: number, highCount = 0): ChangedFileInventory {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    const paths = [
      ...Array.from({ length: count }, (_, index) => `src/medium${index}.ts`),
      ...Array.from({ length: highCount }, (_, index) => `src/high${index}.ts`),
    ];
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: paths.map((path) => entry(path)) });
    for (let index = 0; index < count; index += 1) inventory.classify('m1', `src/medium${index}.ts`, { risk: 'medium' });
    for (let index = 0; index < highCount; index += 1) inventory.classify('m1', `src/high${index}.ts`, { risk: 'high' });
    return inventory;
  }

  function forecastInput(overrides: Partial<CoverageForecastInput> & { inventory: ChangedFileInventory }): CoverageForecastInput {
    return {
      toolCalls: { ordinaryRemaining: 100, highRiskReserveRemaining: 20 },
      modelTurns: { ordinaryRemaining: 40, highRiskReserveRemaining: 10 },
      maxToolRequestsPerTurn: 8,
      ...overrides,
    };
  }

  it('is silent while the investigation lanes can fund every required read', () => {
    expect(forecastCoverageShortfall(forecastInput({ inventory: classifiedInventory(100) }))).toBeUndefined();
  });

  it('is silent when nothing requires inspection (low-risk or already-inspected files)', () => {
    const inventory = completeInventory(); // everything inspected
    expect(forecastCoverageShortfall(forecastInput({ inventory }))).toBeUndefined();
    const low = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    low.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('docs/readme.md')] });
    low.classify('m1', 'docs/readme.md', { risk: 'low' });
    expect(forecastCoverageShortfall(forecastInput({ inventory: low, toolCalls: { ordinaryRemaining: 0, highRiskReserveRemaining: 0 } }))).toBeUndefined();
  });

  it('reports a shortfall when required reads exceed the ordinary tool-call lane, with exact counts in the limitation', () => {
    // The live shape in miniature: medium-risk files may draw only `ordinary`, so the untouched
    // high-risk lane does not count toward what is fundable.
    const shortfall = forecastCoverageShortfall(
      forecastInput({ inventory: classifiedInventory(12), toolCalls: { ordinaryRemaining: 5, highRiskReserveRemaining: 51 } }),
    );
    expect(shortfall).toMatchObject({ requiredReads: 12, reserveEligibleReads: 0, fundableReads: 5 });
    expect(shortfall?.limitation.code).toBe('coverageExceedsBudget');
    expect(shortfall?.limitation.message).toContain('12 file(s) require inspection');
    expect(shortfall?.limitation.message).toContain('at most 5 more file read(s)');
    expect(shortfall?.limitation.message).toContain('verification reserve');
  });

  it('counts the high-risk lane only for reserve-eligible files, and lets leftover ordinary top them up', () => {
    // 4 medium + 4 high against ordinary 5, high-risk 2: mediums take 4 of ordinary, highs take
    // the reserve 2 plus the 1 leftover ordinary — 7 fundable of 8 required.
    const shortfall = forecastCoverageShortfall(
      forecastInput({ inventory: classifiedInventory(4, 4), toolCalls: { ordinaryRemaining: 5, highRiskReserveRemaining: 2 } }),
    );
    expect(shortfall).toMatchObject({ requiredReads: 8, reserveEligibleReads: 4, fundableReads: 7 });
    // The same mix with one more reserve unit is exactly fundable — and silent.
    expect(
      forecastCoverageShortfall(forecastInput({ inventory: classifiedInventory(4, 4), toolCalls: { ordinaryRemaining: 5, highRiskReserveRemaining: 3 } })),
    ).toBeUndefined();
  });

  it('reports a shortfall on the turn floor even when tool calls alone would suffice', () => {
    // 24 mediums need ceil(24/8) = 3 turns; only 2 ordinary turns remain and the high-risk turn
    // lane is unreachable with no reserve-eligible file.
    const shortfall = forecastCoverageShortfall(
      forecastInput({
        inventory: classifiedInventory(24),
        toolCalls: { ordinaryRemaining: 100, highRiskReserveRemaining: 0 },
        modelTurns: { ordinaryRemaining: 2, highRiskReserveRemaining: 10 },
      }),
    );
    expect(shortfall).toMatchObject({ requiredReads: 24, fundableReads: 16 });
  });
});
