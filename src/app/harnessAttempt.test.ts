import { describe, expect, it } from 'vitest';
import {
  classifyFile,
  createHarnessAttempt,
  defaultSynthesisVerification,
  isSmallReview,
  type HarnessAttemptMemberInput,
  type HarnessAttemptOptions,
  type HarnessModelSeam,
  type SynthesisVerificationRunner,
} from './harnessAttempt';
import { createSynthesisVerification } from './harnessSynthesisVerification';
import type { AgentCancellationToken } from './lmAgent';
import { createBudgetTracker } from './harnessBudgets';
import { DEFAULT_RISK_FLOOR_RULES } from './harnessRiskFloors';
import type { HostToolResult } from './harnessToolDispatcher';
import { normalizeHarnessPolicy, HARNESS_POLICY_VERSION, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { RunPhase } from '../domain/harnessActivity';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { Connection, InvestigationOperationCapability, ProviderCapabilities } from '../platform/provider';
import type {
  ChangedFileEntry,
  ChangedFileManifestResult,
  ChangeRequestDetailResult,
  CurrentHeadResult,
  DiffPageResult,
} from '../platform/types';

// ---- Fixtures -----------------------------------------------------------------------

const SNAPSHOT_REF = { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' };

function notImplemented(): never {
  throw new Error('not implemented in this fake Connection');
}

function fakeConnection(methods: Partial<Connection>): Connection {
  return {
    testConnection: notImplemented,
    resolveSource: notImplemented,
    listGroupRepositories: notImplemented,
    getRepository: notImplemented,
    listOpenChangeRequests: notImplemented,
    listWorkItems: notImplemented,
    listCiRuns: notImplemented,
    getChangeRequestDiff: notImplemented,
    submitReview: notImplemented,
    listThreads: notImplemented,
    resolveThread: notImplemented,
    replyToThread: notImplemented,
    approve: notImplemented,
    ...methods,
  };
}

/** Deliberately tiny and uniform across every test: this is a *declared ceiling* compared against
 * policy fields, never a bound on how many entries a fake handler actually returns in one page. */
const PAGE_BOUND: InvestigationOperationCapability = { supported: true, pageBound: { maxPageSize: 1 } };

function fullCapabilities(): ProviderCapabilities {
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    reviewInvestigation: {
      manifests: PAGE_BOUND,
      diffReads: PAGE_BOUND,
      fileReads: PAGE_BOUND,
      repositorySearch: PAGE_BOUND,
      diffSearch: PAGE_BOUND,
      changeRequestDetails: PAGE_BOUND,
      issueDetails: PAGE_BOUND,
      pagination: { maxPageSize: 1 },
    },
  };
}

function testPolicy(overrides: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return normalizeHarnessPolicy({
    maxElapsedMsPerAttempt: 10_000_000,
    maxModelTurnsPerAttempt: 200,
    maxToolRequestsPerAttempt: 200,
    maxToolRequestsPerTurn: 50,
    maxToolResultBytes: 1_000_000,
    maxEvidenceBytesPerAttempt: 10_000_000,
    manifestPageSize: 1000,
    diffOrFileReadPageLines: 1000,
    protocolRepairsPerPhase: 2,
    checkpointCadenceToolCalls: 1000,
    ...overrides,
  });
}

function changeRequestDetailResult(): ChangeRequestDetailResult {
  return {
    snapshot: SNAPSHOT_REF,
    state: 'complete',
    value: { title: 'Test change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
  };
}

function manifestResult(files: readonly string[]): ChangedFileManifestResult {
  const value: ChangedFileEntry[] = files.map((path) => ({ path, kind: 'modified', binary: false, addedLines: 5, removedLines: 1, byteSize: 100 }));
  return { snapshot: SNAPSHOT_REF, state: 'complete', value };
}

function diffPageResult(path: string): DiffPageResult {
  return {
    snapshot: SNAPSHOT_REF,
    state: 'complete',
    value: { path, patch: `@@ -1,1 +1,1 @@\n-old\n+new\n`, positions: [{ path, side: 'new', line: 1, endLine: 1 }] },
  };
}

function currentHeadResult(headSha: string = SNAPSHOT_REF.headSha): CurrentHeadResult {
  return { repoId: SNAPSHOT_REF.repoId, state: 'resolved', headSha };
}

interface FakeConnectionOptions {
  readonly files: readonly string[];
  readonly getCurrentHead?: Connection['getCurrentHead'];
  readonly readDiff?: Connection['readDiff'];
}

function reviewConnection(options: FakeConnectionOptions): Connection {
  return fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult(),
    listChangedFiles: async () => manifestResult(options.files),
    readDiff: options.readDiff ?? (async (request) => diffPageResult(request.path)),
    getCurrentHead: options.getCurrentHead ?? (async () => currentHeadResult()),
  });
}

function testSnapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: 'm1',
        providerId: 'fixture',
        instanceUrl: 'https://example.test',
        ref: { repoId: SNAPSHOT_REF.repoId, number: '42' },
        baseSha: SNAPSHOT_REF.baseSha,
        headSha: SNAPSHOT_REF.headSha,
        providerCapabilitySignature: 'sig-1',
        rootAgentsPolicy: { present: false },
        context: { autoContextEnabled: false, titleIncluded: false, descriptionIncluded: false, linkedItemIdsIncluded: [], attachments: [] },
      },
    ],
    agentId: 'built-in',
    agentInstructions: 'Review the change carefully.',
    agentInstructionsDigest: 'digest-instructions',
    personaLabel: 'Built-in reviewer',
    modelId: 'test-model',
    modelCapability: { vendor: 'test', family: 'test', maxInputTokens: undefined },
    effort: 'none',
    effortInstructionDigest: 'digest-effort',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'digest-extra',
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
    ...overrides,
  };
}

function member(connection: Connection): HarnessAttemptMemberInput {
  return { memberId: 'm1', connection, capabilities: fullCapabilities() };
}

// ---- Scripted model seam --------------------------------------------------------------

type ScriptCall = { readonly repairInstruction: string | undefined; readonly toolResults: readonly HostToolResult[] };
type ScriptEntry = string | ((call: ScriptCall) => string);

interface RecordedCall {
  readonly phase: RunPhase;
  readonly modelId: string;
  readonly repairInstruction: string | undefined;
}

function scriptedModelSeam(script: Partial<Record<RunPhase, readonly ScriptEntry[]>>, modelId = 'test-model'): HarnessModelSeam & { readonly calls: RecordedCall[] } {
  const counters: Partial<Record<RunPhase, number>> = {};
  const calls: RecordedCall[] = [];
  return {
    modelId,
    calls,
    async askModel({ phase, repairInstruction, toolResults }) {
      calls.push({ phase, modelId, repairInstruction });
      const list = script[phase];
      if (!list || list.length === 0) throw new Error(`scriptedModelSeam: phase "${phase}" was never scripted.`);
      const index = counters[phase] ?? 0;
      counters[phase] = index + 1;
      const entry = list[Math.min(index, list.length - 1)] as ScriptEntry;
      return typeof entry === 'function' ? entry({ repairInstruction, toolResults }) : entry;
    },
  };
}

function messages(...entries: readonly unknown[]): string {
  return JSON.stringify({ messages: entries });
}

const PLAN_TURN = messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed files.' }] });

function readDiffMessage(path: string): unknown {
  return { kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT_REF, path } };
}

function stopMessage(): unknown {
  return { kind: 'publicRationale', rationale: 'No further work is needed right now.' };
}

const STOP_TURN = messages(stopMessage());

function completionRequestMessage(): unknown {
  return { kind: 'completionRequest', rationale: 'Coverage looks complete.' };
}

const COMPLETION_TURN = messages(completionRequestMessage());

function sourceRefFrom(result: HostToolResult): { sourceId: string; digest: string } {
  if (result.state !== 'complete' && result.state !== 'paginated' && result.state !== 'truncated') {
    throw new Error(`Expected a content-bearing tool result, got state "${result.state}".`);
  }
  if (result.sourceId === undefined || result.digest === undefined) {
    throw new Error('Tool result carries no sourceId/digest.');
  }
  return { sourceId: result.sourceId, digest: result.digest };
}

function candidateSubmissionMessage(candidateId: string, path: string, ref: { sourceId: string; digest: string }): unknown {
  return {
    kind: 'candidateSubmission',
    candidate: {
      candidateId,
      memberId: 'm1',
      file: path,
      line: 1,
      endLine: 1,
      severity: 'major',
      category: 'errorHandling',
      confidence: 80,
      title: `Issue in ${path}`,
      body: 'A real issue found during investigation.',
      citations: { primary: { sourceId: ref.sourceId, digest: ref.digest, path, range: { startLine: 1, endLine: 1 } } },
    },
  };
}

/** Passes every verification clause without asking the model — the collaborator's own concern (task 10.6) is not this pass's job to implement. */
const passthroughVerification: SynthesisVerificationRunner = async (input) =>
  Object.freeze({ findings: input.findings, contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true });

/** Same as `passthroughVerification`, but demonstrates the collaborator itself using the one injected model seam (10.4). */
function verificationThatAsksModel(): SynthesisVerificationRunner {
  return async (input) => {
    await input.modelSeam.askModel({ phase: 'verifying', repairInstruction: undefined, toolResults: [] });
    return { findings: input.findings, contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true };
  };
}

function fakeCancellationToken(): { token: AgentCancellationToken; cancel: () => void } {
  let cancelled = false;
  const listeners: Array<() => void> = [];
  return {
    token: {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested(listener: () => void) {
        listeners.push(listener);
        return {
          dispose() {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

let clockValue = 0;
function makeClock(): () => number {
  clockValue = 0;
  return () => {
    clockValue += 1;
    return clockValue;
  };
}

function baseOptions(overrides: Partial<HarnessAttemptOptions> = {}): Omit<HarnessAttemptOptions, 'snapshot' | 'members' | 'modelSeam'> {
  return {
    clock: makeClock(),
    now: () => new Date(2026, 0, 1, 0, 0, clockValue).toISOString(),
    synthesisVerification: passthroughVerification,
    ...overrides,
  };
}

// ---- Pure-helper tests -----------------------------------------------------------------

describe('classifyFile (10.3 risk classification)', () => {
  it('a host risk floor overrides a model proposal that is too low', () => {
    const entry: ChangedFileEntry = { path: 'src/auth/login.ts', kind: 'modified', binary: false };
    const result = classifyFile(entry, 'low', DEFAULT_RISK_FLOOR_RULES);
    expect(result.risk).toBe('high'); // path.auth floor beats the model's 'low' proposal
    expect(result.floorReasons.some((reason) => reason.ruleId === 'path.auth')).toBe(true);
  });

  it('a model proposal above the floor is preserved', () => {
    const entry: ChangedFileEntry = { path: 'src/plain.ts', kind: 'modified', binary: false };
    const result = classifyFile(entry, 'high', DEFAULT_RISK_FLOOR_RULES);
    expect(result.risk).toBe('high');
  });

  it('with no proposal at all, the floor alone decides (the committed protocol carries no risk-proposal message)', () => {
    const entry: ChangedFileEntry = { path: 'src/plain.ts', kind: 'modified', binary: false };
    const result = classifyFile(entry, undefined, DEFAULT_RISK_FLOOR_RULES);
    expect(result.risk).toBe('low');
  });
});

describe('isSmallReview (10.5 threshold)', () => {
  it('a review that fits one manifest page and the ordinary evidence lane is small', () => {
    const policy = testPolicy({ manifestPageSize: 100, maxEvidenceBytesPerAttempt: 1_000_000, highRiskReservePercent: 20, verificationReservePercent: 15 });
    expect(isSmallReview(5, 1_000, policy)).toBe(true);
  });

  it('too many files fails the threshold even with tiny byte totals', () => {
    const policy = testPolicy({ manifestPageSize: 3, maxEvidenceBytesPerAttempt: 1_000_000 });
    expect(isSmallReview(10, 10, policy)).toBe(false);
  });

  it('too many bytes fails the threshold even with a small file count', () => {
    const policy = testPolicy({ manifestPageSize: 100, maxEvidenceBytesPerAttempt: 1_000, highRiskReservePercent: 20, verificationReservePercent: 15 });
    // Ordinary evidence lane is well under maxEvidenceBytesPerAttempt once reserves are carved out.
    expect(isSmallReview(2, 999, policy)).toBe(false);
  });
});

describe('budget reserve isolation (10.3: the exact contract HarnessAttempt.choosePurpose relies on)', () => {
  it('ordinary ("exploration") investigation cannot consume the verification reserve', () => {
    const policy = testPolicy({ maxToolRequestsPerAttempt: 10, verificationReservePercent: 50, highRiskReservePercent: 0, maxToolRequestsPerTurn: 100 });
    const budget = createBudgetTracker(policy);
    let elapsedMs = 0;
    let granted = true;
    let count = 0;
    while (granted && count < 20) {
      const outcome = budget.reserve({ requestId: `explore-${count}`, purpose: 'exploration', toolCalls: 1, elapsedMs });
      granted = outcome.ok;
      count += 1;
      elapsedMs += 1;
    }
    // The ordinary lane is now fully spent; a further exploration request must be refused outright.
    const nextExploration = budget.reserve({ requestId: 'explore-more', purpose: 'exploration', toolCalls: 1, elapsedMs });
    expect(nextExploration.ok).toBe(false);
    // The verification reserve is untouched and still grants a 'verification'-purpose request.
    const verification = budget.reserve({ requestId: 'verify-1', purpose: 'verification', toolCalls: 1, elapsedMs });
    expect(verification.ok).toBe(true);
    if (verification.ok) {
      expect(verification.reservation.charges.some((charge) => charge.lane === 'verificationReserve')).toBe(true);
    }
  });
});

// ---- Full-attempt tests -----------------------------------------------------------------

describe('HarnessAttempt.run (10.3 phase transitions)', () => {
  it('a full attempt over a small fake review reaches a complete outcome, with every phase in causal order and a validated finding', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-1', 'file1.ts', ref));
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), investigatingTurn2, STOP_TURN],
      verifying: [COMPLETION_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.kind).toBe('completeFindings');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.item.file).toBe('file1.ts');
    expect(result.plan?.items).toHaveLength(1);

    // Every phase appears, in causal order.
    const phaseOrder: RunPhase[] = [];
    for (const event of result.activityLog.events) {
      const last = phaseOrder[phaseOrder.length - 1];
      if (event.phase !== last) phaseOrder.push(event.phase);
    }
    expect(phaseOrder).toEqual(['bootstrap', 'planning', 'investigating', 'verifying', 'completing', 'persisting']);

    // Candidates remain provisional until synthesis/verification/host-validation finish: the plan
    // and evidence events precede the terminal result.
    const planIndex = result.activityLog.events.findIndex((e) => e.kind === 'planCreated');
    const terminalIndex = result.activityLog.events.findIndex((e) => e.kind === 'terminalResult');
    expect(planIndex).toBeGreaterThanOrEqual(0);
    expect(terminalIndex).toBeGreaterThan(planIndex);
    expect(result.activityLog.events[terminalIndex]).toMatchObject({ lifecycle: 'succeeded', completeness: 'complete' });
  });

  it('plan revision mid-investigation retains prior item ids and records the rationale, and the earlier plan stays visible', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const revisionTurn = messages(
      { kind: 'planRevised', items: [{ id: 'p1', description: 'Investigate the changed files.', state: 'completed' }, { id: 'p2', description: 'A newly discovered logical unit.' }], rationale: 'A cross-cutting concern was found.' },
      readDiffMessage('file1.ts'),
    );
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [revisionTurn, STOP_TURN],
      verifying: [COMPLETION_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    const created = result.activityLog.events.find((e) => e.kind === 'planCreated');
    const revised = result.activityLog.events.find((e) => e.kind === 'planRevised');
    expect(created).toBeDefined();
    expect(revised).toBeDefined();
    if (created?.kind === 'planCreated' && revised?.kind === 'planRevised') {
      expect(created.plan.items.map((item) => item.id)).toEqual(['p1']);
      expect(revised.plan.items.map((item) => item.id)).toEqual(['p1', 'p2']);
      expect(revised.plan.rationale).toBe('A cross-cutting concern was found.');
      expect(revised.plan.revision).toBe(created.plan.revision + 1);
    }
    // The prior plan event is retained in activity, not overwritten.
    expect(result.activityLog.events.filter((e) => e.kind === 'planCreated' || e.kind === 'planRevised')).toHaveLength(2);
    expect(result.plan?.items.map((item) => item.id)).toEqual(['p1', 'p2']);
  });

  it('budget exhaustion mid-investigation yields a truthful partial, never a silent complete', async () => {
    const files = ['file1.ts', 'file2.ts', 'file3.ts'];
    const connection = reviewConnection({ files });
    // Bootstrap spends 2 (getChangeRequestDetails + listChangedFiles). Exactly 5 total tool-call
    // slots: file1+file2 reads (2), then one candidateSubmission (1) — exactly exhausting the
    // pool — leaves file3's own readDiff attempt (issued in the same turn as the submission)
    // refused for lack of budget, not because the model chose to skip it.
    const policy = testPolicy({ maxToolRequestsPerAttempt: 5, highRiskReservePercent: 0, verificationReservePercent: 0, maxToolRequestsPerTurn: 10 });
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-1', 'file1.ts', ref), readDiffMessage('file3.ts'));
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts'), readDiffMessage('file2.ts')), investigatingTurn2, STOP_TURN],
      verifying: [COMPLETION_TURN, STOP_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.lifecycle).not.toBe('succeeded');
    // A validated finding survived (file1 was inspected and its candidate accepted before the
    // budget ran out), so this is a truthful partial, not a bare failure with nothing to show.
    expect(result.outcome.kind).toBe('partialFindings');
    expect(result.findings).toHaveLength(1);
    // file3 was never inspected — refused by the budget, not skipped by the model (it was asked for).
    const file3ToolFailed = result.activityLog.events.find((e) => e.kind === 'toolFailed' && e.tool === 'readDiff' && e.target === 'file3.ts');
    expect(file3ToolFailed).toBeDefined();
    expect(result.outcome.limitations.some((l) => l.code === 'insufficientRiskCoverage' || l.code === 'budgetExhausted')).toBe(true);
  });

  it('cancellation mid-investigation ends the attempt promptly, emits cancelling then cancelled, and a late tool result is ignored', async () => {
    const cancellation = fakeCancellationToken();
    const connection = reviewConnection({
      files: ['file1.ts'],
      readDiff: async (request) => {
        // Cancel right as this in-flight call starts, then yield one microtask — simulating a
        // provider response that resolves *after* cancellation was requested. `dispatch`'s
        // post-await cancellation check must discard this content rather than register it.
        cancellation.cancel();
        await Promise.resolve();
        return diffPageResult(request.path);
      },
    });
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), STOP_TURN],
      verifying: [COMPLETION_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
    });

    const result = await attempt.run();

    expect(result.cancelled).toBe(true);
    expect(result.lifecycle).toBe('cancelled');
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.limitations.some((l) => l.code === 'cancelled')).toBe(true);

    const kinds = result.activityLog.events.map((e) => e.kind);
    const cancellingIndex = kinds.indexOf('cancelling');
    const cancelledIndex = kinds.indexOf('cancelled');
    expect(cancellingIndex).toBeGreaterThanOrEqual(0);
    expect(cancelledIndex).toBeGreaterThan(cancellingIndex);

    // The late readDiff result was fetched but discarded: the dispatch is recorded as a failure
    // ("cancelled"), never as a completed tool call feeding evidence or coverage.
    const readDiffOutcome = result.activityLog.events.find((e) => (e.kind === 'toolCompleted' || e.kind === 'toolFailed') && e.tool === 'readDiff');
    expect(readDiffOutcome?.kind).toBe('toolFailed');
    if (readDiffOutcome?.kind === 'toolFailed') expect(readDiffOutcome.reason.toLowerCase()).toContain('cancel');
    // Verification never ran; the run stopped before reaching it.
    expect(result.activityLog.events.some((e) => e.kind === 'actionStarted' && e.action.includes('Synthesizing'))).toBe(false);
  });

  it('repair exhaustion in a phase ends the attempt truthfully', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const seam = scriptedModelSeam({
      planning: ['this is not a valid protocol turn at all'],
      // Never reached if planning never produces a plan, but scripted so a stray extra ask never throws.
      verifying: [STOP_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy({ protocolRepairsPerPhase: 1 }),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('failed');
    expect(result.outcome.completeness).toBe('none');
    expect(result.plan).toBeUndefined();
    // Exactly 1 + maxRepairs asks: `runHarnessTurn`'s own bound, never retried indefinitely.
    const planningCalls = seam.calls.filter((c) => c.phase === 'planning');
    expect(planningCalls).toHaveLength(2);
    expect(result.activityLog.events.some((e) => e.kind === 'toolFailed' && e.tool === 'modelTurn')).toBe(true);
    expect(result.outcome.limitations.some((l) => l.code === 'noPlan')).toBe(true);
  });
});

describe('HarnessAttempt.run (10.9: candidate flow — invalid citation blocks completion)', () => {
  it('a finding whose cited evidence fails post-verification revalidation is dropped, not counted as retained, and blocks a complete verdict', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-1', 'file1.ts', ref));
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), investigatingTurn2, STOP_TURN],
      verifying: [COMPLETION_TURN],
    });
    // Simulates a citation that becomes unresolvable by the time synthesis/verification hands
    // back its findings (e.g. a tampered/drifted digest) — every verification pass reports
    // complete, isolating the effect to the host's own post-verification citation revalidation
    // (`revalidateFindings`, called from `harnessAttempt.ts`'s `runSynthesisVerification`), never
    // to a stage the collaborator itself failed to run.
    const tamperingVerification: SynthesisVerificationRunner = async (input) => ({
      findings: input.findings.map((finding) => ({
        ...finding,
        evidence: { ...finding.evidence, primary: { ...finding.evidence.primary, digest: '0'.repeat(64) } },
      })),
      contradictionPassComplete: true,
      deduplicationComplete: true,
      finalVerificationComplete: true,
    });
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: tamperingVerification }),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.outcome.completeness).not.toBe('complete');
    // The invalidated finding is not silently kept as if it were still valid.
    expect(result.findings).toHaveLength(0);
    expect(result.outcome.limitations.some((l) => l.code === 'invalidCitations')).toBe(true);
  });
});

describe('HarnessAttempt.run (10.9: the real 10.6 collaborator, end to end — a skipped stage refuses the gate, a genuinely completed one does not)', () => {
  it('a contradiction stage that never gets a parseable verdict leaves contradictionPassComplete false end to end, and the gate refuses a complete verdict', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-1', 'file1.ts', ref));
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), investigatingTurn2, STOP_TURN],
      // The first three calls are the real collaborator's contradiction check (1 initial ask +
      // `protocolRepairsPerPhase` (2) repairs, all unparseable); the next two are the phase loop's
      // own turn: a completion request the host must refuse, then a stop.
      verifying: ['not parseable as a verdict', 'still not parseable', 'never parseable', COMPLETION_TURN, STOP_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.limitations.some((l) => l.code === 'contradictionPending')).toBe(true);
    // Not silently dropped: the unconfirmed finding is kept (a verification-machinery failure is
    // not grounds to discard an already-validated finding), so this is a truthful partial, not a
    // bare failure with nothing to show.
    expect(result.findings).toHaveLength(1);
    expect(result.outcome.kind).toBe('partialFindings');
  });

  it('a contradiction stage that genuinely runs and contradicts the only finding removes it and reaches a complete clean outcome', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-1', 'file1.ts', ref));
    };
    const respondToVerifyingCall: ScriptEntry = (call) => {
      if (call.repairInstruction === undefined) return COMPLETION_TURN;
      const match = /^candidateId: (.+)$/m.exec(call.repairInstruction);
      if (!match) throw new Error(`unexpected verifying repairInstruction shape: ${call.repairInstruction}`);
      return JSON.stringify({ candidateId: match[1], contradicted: true, reason: 'Contradicted by evidence two lines up.' });
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), investigatingTurn2, STOP_TURN],
      verifying: [respondToVerifyingCall],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.kind).toBe('completeClean');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.findings).toHaveLength(0);
  });
});

describe('HarnessAttempt.run (10.4: one model, many phases)', () => {
  it('uses exactly one model identity across planning, investigating, and verifying — including inside the injected synthesis/verification collaborator', async () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), STOP_TURN],
      // Index 0 is consumed by the collaborator's own call (content is discarded, never parsed);
      // index 1 is the phase loop's real turn.
      verifying: ['ignored-by-the-collaborator', COMPLETION_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      synthesisVerification: verificationThatAsksModel(),
    });

    const result = await attempt.run();

    expect(result.outcome.completeness).toBe('complete');
    const phasesSeen = new Set(seam.calls.map((c) => c.phase));
    expect(phasesSeen.has('planning')).toBe(true);
    expect(phasesSeen.has('investigating')).toBe(true);
    expect(phasesSeen.has('verifying')).toBe(true);
    // At least two calls tagged 'verifying': the collaborator's own and the phase loop's.
    expect(seam.calls.filter((c) => c.phase === 'verifying').length).toBeGreaterThanOrEqual(2);
    const identities = new Set(seam.calls.map((c) => c.modelId));
    expect(identities.size).toBe(1);
    expect([...identities][0]).toBe('test-model');
  });

  it('refuses construction when the model seam does not match the snapshot\'s selected model', () => {
    const connection = reviewConnection({ files: ['file1.ts'] });
    const seam = scriptedModelSeam({ planning: [PLAN_TURN] }, 'a-different-model');
    expect(() =>
      createHarnessAttempt({
        ...baseOptions(),
        snapshot: testSnapshot({ modelId: 'test-model' }),
        members: [member(connection)],
        modelSeam: seam,
        policy: testPolicy(),
      }),
    ).toThrow(/model/i);
  });
});

describe('HarnessAttempt.run (10.5: small-review fast path)', () => {
  const SMALL_FILES = ['file1.ts', 'file2.ts'];
  const NORMAL_FILES = Array.from({ length: 10 }, (_, i) => `file${i + 1}.ts`);

  /** One `readDiff` per turn (rather than batching every file into a single turn) so the turn
   * count is genuinely proportional to review size — a realistic model that inspects and reasons
   * about one file before moving to the next, not an artifact of how the fixture is scripted. */
  function investigatingReadEachInOwnTurn(files: readonly string[]): readonly ScriptEntry[] {
    return [...files.map((path) => messages(readDiffMessage(path))), STOP_TURN];
  }

  it('a small review and a normal-size review reach the same structural artifacts, with fewer turns for the small one', async () => {
    const policy = testPolicy({ manifestPageSize: 5, maxToolRequestsPerTurn: 20 });

    const smallConnection = reviewConnection({ files: SMALL_FILES });
    const smallSeam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: investigatingReadEachInOwnTurn(SMALL_FILES),
      verifying: [COMPLETION_TURN],
    });
    const smallAttempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(smallConnection)],
      modelSeam: smallSeam,
      policy,
    });
    const smallResult = await smallAttempt.run();

    const normalConnection = reviewConnection({ files: NORMAL_FILES });
    const normalSeam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: investigatingReadEachInOwnTurn(NORMAL_FILES),
      verifying: [COMPLETION_TURN],
    });
    const normalAttempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(normalConnection)],
      modelSeam: normalSeam,
      policy,
    });
    const normalResult = await normalAttempt.run();

    // Same structural shape: a published plan, complete coverage, verification ran, completion evaluated.
    for (const result of [smallResult, normalResult]) {
      expect(result.plan).toBeDefined();
      expect(result.outcome.completeness).toBe('complete');
      const coverageEvents = result.activityLog.events.filter((e) => e.kind === 'coverageChanged');
      expect(coverageEvents.length).toBeGreaterThan(0);
      const lastCoverage = coverageEvents[coverageEvents.length - 1];
      if (lastCoverage?.kind === 'coverageChanged') expect(lastCoverage.coverage.total).toBeDefined();
    }

    expect(smallResult.small).toBe(true);
    expect(normalResult.small).toBe(false);
    // Fewer turns through the *same* machinery — never a shortcut past it.
    expect(smallResult.turnsUsed).toBeLessThan(normalResult.turnsUsed);
    expect(smallResult.toolCallsUsed).toBeLessThan(normalResult.toolCallsUsed);
  });

  it('a small review cannot reach complete without verification actually having run (the fast path never skips the gate)', async () => {
    const connection = reviewConnection({ files: SMALL_FILES });
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: investigatingReadEachInOwnTurn(SMALL_FILES),
      verifying: [COMPLETION_TURN, STOP_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: defaultSynthesisVerification }),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy({ manifestPageSize: 5 }),
    });

    const result = await attempt.run();

    expect(result.small).toBe(true);
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.limitations.some((l) => l.code === 'verificationPending' || l.code === 'contradictionPending' || l.code === 'deduplicationPending')).toBe(true);
  });
});
