/**
 * Task 8.9: the named coverage/budget/completion scenarios, driven through
 * the real fixture provider (manifests, diff pages, current-head checks) and
 * the section-7 ledger/candidate tracker rather than hand-built inventories,
 * so the section-8 modules are proven against the same neutral results the
 * dispatcher (section 9) will hand them.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy } from '../domain/harnessPolicy';
import type { Connection } from '../platform/provider';
import { getProvider } from '../platform/registry';
import { investigationResultValue, type ChangedFileEntry, type CurrentHeadResult, type InvestigationSnapshotRef } from '../platform/types';
import { registerBuiltInProviders } from '../registry';
import { createBudgetTracker, type BudgetTracker } from './harnessBudgets';
import { createCandidateTracker, validateCandidate, type CandidateTracker } from './harnessCandidateValidation';
import { classifyOutcome, evaluateCompletion, respondToCompletionRequest, type CompletionEvaluationInput } from './harnessCompletion';
import { createEvidenceLedger, type EvidenceLedger } from './harnessEvidenceLedger';
import { coverageChangedFact, createChangedFileInventory, type ChangedFileInventory } from './harnessInventory';
import { applyRiskFloor, computeRiskFloor, DEFAULT_RISK_COVERAGE_RULES, isReserveEligible } from './harnessRiskFloors';

/**
 * Mirrors of `src/providers/fixture/{data,harnessFixtures}.ts`. ESLint forbids importing a concrete provider
 * module from `src/app`, so the connection comes from the registry and these identities are restated here;
 * the scenarios below assert the provider's own results (page counts, file kinds, head drift) against them.
 */
const FIXTURE = {
  demo: { repoId: '9101', number: '2841', baseSha: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', headSha: '4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9' },
  huge: { repoId: 'harness-huge', number: '1', baseSha: 'huge-base-1', headSha: 'huge-head-1', pageSize: 100, fileCount: 250 },
  oversized: { repoId: 'harness-oversized', number: '1', baseSha: 'oversized-base-1', headSha: 'oversized-head-1', path: 'package-lock.json' },
  mixed: { repoId: 'harness-mixed', number: '1', baseSha: 'mixed-base-1', headSha: 'mixed-head-1', renamedOld: 'src/legacy/tokenStore.ts', renamedNew: 'src/auth/tokenStore.ts', binary: 'assets/logo.png' },
  stale: { repoId: 'harness-stale', number: '1', baseSha: 'stale-base-1', headSha: 'stale-head-snapshot-1', laterHeadSha: 'stale-head-later-2' },
} as const;

const MEMBER = 'm1';
const NOW = '2026-09-03T12:00:00.000Z';
const POLICY = normalizeHarnessPolicy({
  maxModelTurnsPerAttempt: 10,
  maxToolRequestsPerAttempt: 20,
  maxEvidenceBytesPerAttempt: 200_000,
  maxToolRequestsPerTurn: 8,
  maxToolResultBytes: 64 * 1024,
  maxElapsedMsPerAttempt: 5_000,
  highRiskReservePercent: 20,
  verificationReservePercent: 15,
});

interface Harness {
  conn: Connection;
  snapshot: InvestigationSnapshotRef;
  inventory: ChangedFileInventory;
  budget: BudgetTracker;
  candidates: CandidateTracker;
  ledger: EvidenceLedger;
  head: CurrentHeadResult | undefined;
  /** Monotonic attempt clock shared by every reservation in one scenario. */
  clock: number;
}

function tick(harness: Harness): number {
  harness.clock += 1;
  return harness.clock;
}

function snapshotFor(fixture: { repoId: string; baseSha: string; headSha: string }): InvestigationSnapshotRef {
  return { repoId: fixture.repoId, baseSha: fixture.baseSha, headSha: fixture.headSha };
}

async function start(fixture: { repoId: string; number: string; baseSha: string; headSha: string }, policy = POLICY): Promise<Harness> {
  const conn = getProvider('fixture').connect({ instanceUrl: 'fixture', credential: { kind: 'token', token: 'demo' } });
  const snapshot = snapshotFor(fixture);
  const inventory = createChangedFileInventory([{ memberId: MEMBER, snapshot }]);
  const budget = createBudgetTracker(policy);
  const ledger = createEvidenceLedger({ runId: 'run-1', lineageId: 'lineage-1', attempt: 1 }, [
    { memberId: MEMBER, repositoryId: snapshot.repoId, baseSha: snapshot.baseSha, headSha: snapshot.headSha, changeRequestNumber: fixture.number },
  ]);
  const head = await conn.getCurrentHead?.({ repoId: fixture.repoId, number: fixture.number });
  return { conn, snapshot, inventory, budget, candidates: createCandidateTracker({ maxRepairsPerCandidate: POLICY.protocolRepairsPerPhase }), ledger, head, clock: 0 };
}

/** Pages the whole manifest through host-initiated tool reservations, stopping after `maxPages` if given. */
async function enumerate(harness: Harness, maxPages = Number.POSITIVE_INFINITY): Promise<number> {
  let cursor: string | undefined;
  let pages = 0;
  while (pages < maxPages) {
    const reserved = harness.budget.reserve({ requestId: `manifest-${harness.clock}`, purpose: 'exploration', toolCalls: 1, elapsedMs: tick(harness), hostInitiated: true });
    if (!reserved.ok) throw new Error(`manifest reservation refused: ${reserved.code}`);
    const result = await harness.conn.listChangedFiles!({ snapshot: harness.snapshot, cursor });
    const accepted = harness.inventory.acceptManifestPage(MEMBER, result);
    if (!accepted.ok) throw new Error(`manifest page refused: ${accepted.code}`);
    pages += 1;
    if (result.state !== 'paginated') break;
    cursor = result.cursor;
  }
  return pages;
}

function classifyAll(harness: Harness, entriesByPath?: ReadonlyMap<string, ChangedFileEntry>): void {
  for (const file of harness.inventory.member(MEMBER)?.files ?? []) {
    const entry: ChangedFileEntry = entriesByPath?.get(file.path) ?? { path: file.path, oldPath: file.oldPath, kind: file.kind, binary: file.binary, addedLines: file.addedLines, removedLines: file.removedLines, byteSize: file.byteSize };
    const floor = computeRiskFloor({ entry });
    const applied = applyRiskFloor('low', floor);
    const outcome = harness.inventory.classify(MEMBER, file.path, { risk: applied.risk, logicalUnit: floor.reasons[0]?.reason ?? 'general' });
    if (!outcome.ok) throw new Error(`classify refused: ${outcome.code}`);
  }
}

/** Reads every classified file's diff page, inspecting text and marking binary/oversized content explicitly. */
async function inspectAll(harness: Harness): Promise<void> {
  for (const file of harness.inventory.member(MEMBER)?.files ?? []) {
    if (file.state !== 'classified') continue;
    const purpose = file.risk !== undefined && isReserveEligible(file.risk) ? 'highRiskCoverage' : 'exploration';
    const requestId = `diff-${harness.clock}`;
    const reserved = harness.budget.reserve({ requestId, purpose, toolCalls: 1, evidenceBytes: POLICY.maxToolResultBytes, elapsedMs: tick(harness), hostInitiated: true });
    if (!reserved.ok) throw new Error(`diff reservation refused: ${reserved.code}`);
    const result = await harness.conn.readDiff!({ snapshot: harness.snapshot, path: file.path });
    const page = investigationResultValue(result);
    if (page) {
      const registered = harness.ledger.registerDiffPage(MEMBER, result);
      if (!registered.ok) throw new Error(`ledger refused: ${registered.code}`);
      harness.budget.reconcile(requestId, { evidenceBytes: Buffer.byteLength(page.patch, 'utf8') });
      harness.inventory.markInspected(MEMBER, file.path);
    } else {
      harness.budget.reconcile(requestId, { evidenceBytes: 0 });
      if (result.state === 'binary') harness.inventory.markTerminal(MEMBER, file.path, 'binary', 'binary content cannot be inspected as text');
      else if (result.state === 'tooLarge') harness.inventory.markTerminal(MEMBER, file.path, 'oversized', `diff exceeds the ${POLICY.maxToolResultBytes}-byte single-result ceiling`);
      else harness.inventory.markTerminal(MEMBER, file.path, 'unavailable', `provider returned ${result.state}`);
    }
  }
}

function gate(harness: Harness, overrides: Partial<CompletionEvaluationInput> = {}): CompletionEvaluationInput {
  const state = harness.budget.state();
  return {
    heads: [{ memberId: MEMBER, snapshotHeadSha: harness.snapshot.headSha, currentHead: harness.head }],
    inventory: harness.inventory,
    coverageRules: DEFAULT_RISK_COVERAGE_RULES,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: harness.candidates.unresolvedCount() },
    citations: { revalidated: true, invalidatedCount: 0 },
    passes: { contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true },
    budget: { hardExhausted: state.hardExhausted, timedOut: state.timedOut },
    ...overrides,
  };
}

const DEMO_SNAPSHOT = snapshotFor(FIXTURE.demo);

describe('task 8.9 scenarios', () => {
  beforeAll(() => {
    registerBuiltInProviders();
  });

  it('complete findings: a fully inspected demo review with one validated finding replaces the retained review', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    await inspectAll(harness);
    expect(harness.inventory.everyMemberComplete()).toBe(true);
    // The fixture provider's `readDiff` returns no anchor positions (task 4.1 gap), so cite a positioned page
    // built from the very patch the provider returned for the inspected file.
    const fetched = harness.ledger.sources().find((source) => source.path === 'src/auth/token.ts');
    expect(fetched).toBeDefined();
    const positioned = harness.ledger.registerDiffPage(MEMBER, {
      snapshot: DEMO_SNAPSHOT,
      state: 'complete',
      value: { path: 'src/auth/token.ts', patch: fetched?.exactContent ?? '', positions: [{ path: 'src/auth/token.ts', side: 'new', line: 63 }] },
    });
    expect(positioned.ok).toBe(true);
    if (!positioned.ok) return;
    const token = positioned.source;
    const line = token.locations.find((location) => location.side === 'new')?.range.startLine;
    expect(line).toBe(63);
    const outcome = validateCandidate(
      {
        candidateId: 'cand-1',
        memberId: MEMBER,
        file: 'src/auth/token.ts',
        line,
        severity: 'major',
        category: 'errorHandling',
        confidence: 85,
        title: 'Expiry is not validated',
        body: 'The refreshed token is used without checking its expiry.',
        citations: { primary: { sourceId: token.sourceId, digest: token.digest, path: 'src/auth/token.ts', range: { startLine: line } } },
      },
      { ledger: harness.ledger, criteria: DEFAULT_CRITERIA, changedPathsByMember: new Map([[MEMBER, new Set(['src/auth/token.ts'])]]), now: NOW },
    );
    expect(outcome.state).toBe('accepted');
    harness.candidates.record(outcome);
    expect(harness.candidates.blocksCompletion()).toBe(false);
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.eligible).toBe(true);
    expect(respondToCompletionRequest(evaluation, { canContinue: harness.budget.canContinue('verification', tick(harness)) })).toEqual({ granted: true });
    const result = classifyOutcome(evaluation, harness.candidates.triageFindings().length);
    expect(result).toMatchObject({ kind: 'completeFindings', completeness: 'complete', findingCount: 1, replacesRetainedReview: true, clean: false });
    expect(coverageChangedFact(harness.inventory, DEFAULT_RISK_COVERAGE_RULES.requireInspection).coverage.total).toBe(harness.inventory.counts().known);
  });

  it('complete clean: the same fully inspected review with no surviving candidate is clean', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    await inspectAll(harness);
    harness.candidates.record({ state: 'rejected', candidateId: 'cand-x', reasons: [{ code: 'primary:unknownSource', message: 'fabricated' }] });
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.eligible).toBe(true);
    expect(classifyOutcome(evaluation, harness.candidates.triageFindings().length)).toMatchObject({ kind: 'completeClean', completeness: 'complete', clean: true, replacesRetainedReview: true });
  });

  it('early completion request: refused with bounded repairable conditions while budget remains, and not repairable once it is gone', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toEqual(['unclassifiedFiles']);
    const withBudget = respondToCompletionRequest(evaluation, { canContinue: harness.budget.canContinue('exploration', 50) });
    expect(withBudget).toMatchObject({ granted: false, repairable: true });
    if (withBudget.granted) return;
    expect(withBudget.missingConditions.length).toBeGreaterThan(0);
    expect(withBudget.missingConditions.every((condition) => condition.blocker === 'unclassifiedFiles' && condition.repairable)).toBe(true);
    harness.budget.cancel();
    expect(respondToCompletionRequest(evaluation, { canContinue: harness.budget.canContinue('exploration', 50) })).toMatchObject({ granted: false, repairable: false });
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });

  it('incomplete inventory: a huge review with one page pending has no denominator and can never be clean', async () => {
    const roomy = normalizeHarnessPolicy({ ...POLICY, maxToolRequestsPerAttempt: 400, maxEvidenceBytesPerAttempt: 8 * 1024 * 1024 });
    const harness = await start(FIXTURE.huge, roomy);
    const pages = await enumerate(harness, 1);
    expect(pages).toBe(1);
    expect(harness.inventory.member(MEMBER)?.enumeration).toBe('inProgress');
    expect(harness.inventory.counts().known).toBe(FIXTURE.huge.pageSize);
    expect(harness.inventory.counts().total).toBeUndefined();
    expect(coverageChangedFact(harness.inventory).coverage.total).toBeUndefined();
    classifyAll(harness);
    await inspectAll(harness);
    const evaluation = evaluateCompletion(gate(harness, { heads: [{ memberId: MEMBER, snapshotHeadSha: harness.snapshot.headSha, currentHead: { repoId: FIXTURE.huge.repoId, state: 'resolved', headSha: harness.snapshot.headSha } }] }));
    expect(evaluation.blockers).toEqual(['incompleteInventory']);
    expect(evaluation.repairable).toBe(true);
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
    expect(classifyOutcome(evaluation, 2)).toMatchObject({ kind: 'partialFindings', completeness: 'partial', replacesRetainedReview: false });
    // Finishing enumeration restores the denominator without losing any earlier page.
    await enumerate(harness);
    expect(harness.inventory.counts().total).toBe(FIXTURE.huge.fileCount);
  });

  it('provider limit: a truncated manifest blocks completion and is not repairable by more turns', async () => {
    const harness = await start(FIXTURE.demo);
    const truncated = harness.inventory.acceptManifestPage(MEMBER, { snapshot: DEMO_SNAPSHOT, state: 'truncated', value: [{ path: 'src/a.ts', kind: 'modified', binary: false }], knownRemainingUnits: 299 });
    expect(truncated.ok).toBe(true);
    classifyAll(harness);
    harness.inventory.markInspected(MEMBER, 'src/a.ts');
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.blockers).toEqual(['incompleteInventory', 'providerLimit']);
    expect(respondToCompletionRequest(evaluation, { canContinue: true })).toMatchObject({ granted: false, repairable: false });
    expect(classifyOutcome(evaluation, 0).limitations.map((limitation) => limitation.code)).toEqual(['incompleteInventory', 'providerLimit']);
  });

  it('unavailable oversized patch: the too-large fixture is an explicit oversized file that blocks a clean result', async () => {
    const harness = await start(FIXTURE.oversized);
    await enumerate(harness);
    classifyAll(harness);
    await inspectAll(harness);
    const file = harness.inventory.file(MEMBER, FIXTURE.oversized.path);
    expect(file?.state).toBe('oversized');
    expect(file?.reason).toMatch(/exceeds/);
    expect(harness.inventory.counts()).toMatchObject({ oversized: 1, inspected: 0, total: 1 });
    const evaluation = evaluateCompletion(gate(harness, { heads: [{ memberId: MEMBER, snapshotHeadSha: harness.snapshot.headSha, currentHead: { repoId: FIXTURE.oversized.repoId, state: 'resolved', headSha: harness.snapshot.headSha } }] }));
    expect(evaluation.blockers).toEqual(['unavailableOversizedPatch']);
    expect(evaluation.repairable).toBe(false);
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });

  it('binary and renamed: an explicit binary decision satisfies coverage while the renamed file is inspected', async () => {
    const harness = await start(FIXTURE.mixed);
    await enumerate(harness);
    expect(harness.inventory.file(MEMBER, FIXTURE.mixed.renamedNew)).toMatchObject({ kind: 'renamed', oldPath: FIXTURE.mixed.renamedOld });
    classifyAll(harness);
    expect(harness.inventory.file(MEMBER, FIXTURE.mixed.renamedNew)?.risk).toBe('high'); // renamed *into* src/auth
    expect(harness.inventory.file(MEMBER, FIXTURE.mixed.binary)?.risk).toBe('medium');
    await inspectAll(harness);
    expect(harness.inventory.counts()).toMatchObject({ binary: 1, inspected: 1, total: 2 });
    const evaluation = evaluateCompletion(gate(harness, { heads: [{ memberId: MEMBER, snapshotHeadSha: harness.snapshot.headSha, currentHead: { repoId: FIXTURE.mixed.repoId, state: 'resolved', headSha: harness.snapshot.headSha } }] }));
    expect(evaluation.eligible).toBe(true);
  });

  it('changed head: the provider reports a later head, so validated findings are at most partial', async () => {
    const harness = await start(FIXTURE.stale);
    expect(harness.head).toEqual({ repoId: FIXTURE.stale.repoId, state: 'resolved', headSha: FIXTURE.stale.laterHeadSha });
    await enumerate(harness);
    classifyAll(harness);
    await inspectAll(harness);
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.blockers).toEqual(['headChanged']);
    expect(evaluation.repairable).toBe(false);
    expect(classifyOutcome(evaluation, 1)).toMatchObject({ kind: 'partialFindings', completeness: 'partial', replacesRetainedReview: false, clean: false });
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });

  it('unresolved candidates: a repairable candidate blocks completion until repaired or rejected at the repair limit', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    await inspectAll(harness);
    const repairable = { state: 'repairable' as const, candidateId: 'cand-2', reasons: [{ code: 'primary:missingRange', message: 'range omitted' }] };
    harness.candidates.record(repairable);
    expect(harness.candidates.blocksCompletion()).toBe(true);
    let evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.blockers).toEqual(['unresolvedCandidates']);
    expect(respondToCompletionRequest(evaluation, { canContinue: true })).toMatchObject({ granted: false, repairable: true });
    expect(classifyOutcome(evaluation, harness.candidates.triageFindings().length)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
    for (let repair = 0; repair <= POLICY.protocolRepairsPerPhase; repair += 1) harness.candidates.record(repairable);
    expect(harness.candidates.get('cand-2')?.state).toBe('rejected');
    evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.eligible).toBe(true);
    expect(harness.candidates.triageFindings()).toEqual([]);
    expect(classifyOutcome(evaluation, 0).kind).toBe('completeClean');
  });

  it('high-risk reserve use: once ordinary is spent, only high-risk coverage continues and verification stays reserved', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    const highRisk = harness.inventory.member(MEMBER)?.files.filter((file) => file.risk === 'high') ?? [];
    expect(highRisk.map((file) => file.path)).toContain('src/auth/token.ts');
    const ordinaryToolCalls = harness.budget.state().pools.toolCalls.lanes.ordinary.remaining;
    expect(harness.budget.reserve({ requestId: 'spend-ordinary', purpose: 'exploration', toolCalls: ordinaryToolCalls, elapsedMs: 10, hostInitiated: true }).ok).toBe(true);
    expect(harness.budget.state().ordinaryExhausted.toolCalls).toBe(true);
    expect(harness.budget.canContinue('exploration', 11)).toBe(false);
    expect(harness.budget.canContinue('highRiskCoverage', 11)).toBe(true);
    const reserveRead = harness.budget.reserve({ requestId: 'hr-read', purpose: 'highRiskCoverage', toolCalls: 1, evidenceBytes: 1_000, elapsedMs: 11, hostInitiated: true });
    expect(reserveRead.ok && reserveRead.reservation.charges.find((charge) => charge.pool === 'toolCalls')?.lane).toBe('highRiskReserve');
    expect(harness.budget.consumption().highRiskReserveUsed).toBe(1);
    expect(harness.budget.state().pools.toolCalls.lanes.verificationReserve.used).toBe(0);
    expect(harness.budget.warnings().map((warning) => warning.code)).toContain('ordinaryBudgetExhausted');
  });

  it('exhausted ordinary and hard budgets: exhausted ordinary makes early completion unrepairable; a hard-exhausted pool is named as a blocker', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    const pool = harness.budget.state().pools.toolCalls;
    harness.budget.reserve({ requestId: 'o', purpose: 'exploration', toolCalls: pool.lanes.ordinary.remaining, elapsedMs: 1, hostInitiated: true });
    const stillRepairable = evaluateCompletion(gate(harness));
    expect(stillRepairable.blockers).toEqual(['insufficientRiskCoverage']);
    expect(respondToCompletionRequest(stillRepairable, { canContinue: harness.budget.canContinue('exploration', 2) })).toMatchObject({ granted: false, repairable: false });
    harness.budget.reserve({ requestId: 'h', purpose: 'highRiskCoverage', toolCalls: pool.lanes.highRiskReserve.remaining, elapsedMs: 2, hostInitiated: true });
    harness.budget.reserve({ requestId: 'v', purpose: 'verification', toolCalls: pool.lanes.verificationReserve.remaining, elapsedMs: 3, hostInitiated: true });
    expect(harness.budget.state().hardExhausted).toBe(true);
    expect(harness.budget.reserve({ requestId: 'more', purpose: 'verification', toolCalls: 1, elapsedMs: 4, hostInitiated: true })).toMatchObject({ ok: false, code: 'exhausted', pool: 'toolCalls' });
    const evaluation = evaluateCompletion(gate(harness));
    expect(evaluation.blockers).toEqual(['insufficientRiskCoverage', 'budgetExhausted']);
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
    expect(classifyOutcome(evaluation, 1).limitations.map((limitation) => limitation.code)).toEqual(['insufficientRiskCoverage', 'budgetExhausted']);
  });

  it('timeout: elapsed time at the limit refuses new dispatch and names timeout alongside the unfinished work', async () => {
    const harness = await start(FIXTURE.demo);
    await enumerate(harness);
    classifyAll(harness);
    expect(harness.budget.reserve({ requestId: 'late', purpose: 'exploration', toolCalls: 1, elapsedMs: POLICY.maxElapsedMsPerAttempt, hostInitiated: true })).toMatchObject({ ok: false, code: 'timeout' });
    // The tracker only records accepted clocks; the caller reports the timeout it observed.
    const evaluation = evaluateCompletion(gate(harness, { budget: { hardExhausted: false, timedOut: true } }));
    expect(evaluation.blockers).toEqual(['insufficientRiskCoverage', 'timeout']);
    expect(evaluation.repairable).toBe(false);
    expect(classifyOutcome(evaluation, 0)).toMatchObject({ kind: 'failed', completeness: 'none', clean: false });
  });
});
