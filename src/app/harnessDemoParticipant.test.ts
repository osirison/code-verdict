import { describe, expect, it } from 'vitest';
import { createDemoModelSeam, DEMO_PARTICIPANT_MODEL_ID } from './harnessDemoParticipant';
import { createHarnessAttempt, type HarnessAttemptMemberInput, type HarnessAttemptOptions, type HarnessModelSeam } from './harnessAttempt';
import { createSynthesisVerification } from './harnessSynthesisVerification';
import type { AgentCancellationToken } from './lmAgent';
import { addedLines } from '../domain/diffHunks';
import { normalizeHarnessPolicy, HARNESS_POLICY_VERSION, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { Connection, InvestigationOperationCapability, ProviderCapabilities } from '../platform/provider';
import type { ChangedFileEntry, ChangedFileManifestResult, ChangeRequestDetailResult, CurrentHeadResult, DiffPageResult } from '../platform/types';

// ---- Shared fixtures (mirrors harnessAttempt.test.ts's own conventions) -------------

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
  const value: ChangedFileEntry[] = files.map((path) => ({ path, kind: 'modified', binary: false, addedLines: 2, removedLines: 0, byteSize: 80 }));
  return { snapshot: SNAPSHOT_REF, state: 'complete', value };
}

/** Builds a diff page whose `positions` are derived from the SAME `addedLines` parse the harness
 * itself (and `demoFindingsForFile`) uses, so a demo-submitted candidate's line always falls
 * inside a real registered evidence location — never a hand-guessed range that happens to work. */
function diffPageFor(path: string, patch: string): DiffPageResult {
  const positions = addedLines(patch).map((anchor) => ({ path, side: 'new' as const, line: anchor.line, endLine: anchor.line }));
  return { snapshot: SNAPSHOT_REF, state: 'complete', value: { path, patch, positions } };
}

function currentHeadResult(headSha: string = SNAPSHOT_REF.headSha): CurrentHeadResult {
  return { repoId: SNAPSHOT_REF.repoId, state: 'resolved', headSha };
}

const PATCH_WITH_FINDING = '@@ -1,1 +1,3 @@\n+const token = fetchToken();\n+console.log(`token=${token}`);\n+return token;';
const PATCH_WITHOUT_FINDING = '@@ -1,1 +1,1 @@\n context line unchanged';

interface FakeConnectionOptions {
  readonly files: readonly string[];
  readonly patches: Readonly<Record<string, string>>;
}

function reviewConnection(options: FakeConnectionOptions): Connection {
  return fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult(),
    listChangedFiles: async () => manifestResult(options.files),
    readDiff: async (request) => diffPageFor(request.path, options.patches[request.path] ?? PATCH_WITHOUT_FINDING),
    getCurrentHead: async () => currentHeadResult(),
  });
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

/** A connection whose `readDiff` requests cancellation as a side effect of resolving — mirrors
 * `harnessAttempt.test.ts`'s own cancellation fixture pattern, adapted so the demo participant's
 * NEXT turn (which would otherwise submit a candidate and move to the next file) instead observes
 * cancellation and never runs. */
function cancellingConnection(options: FakeConnectionOptions, cancel: () => void): Connection {
  return fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult(),
    listChangedFiles: async () => manifestResult(options.files),
    readDiff: async (request) => {
      const result = diffPageFor(request.path, options.patches[request.path] ?? PATCH_WITHOUT_FINDING);
      cancel();
      await Promise.resolve();
      return result;
    },
    getCurrentHead: async () => currentHeadResult(),
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
    modelId: undefined,
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
    ...overrides,
  };
}

/** Counts and records every `askModel` call made through a seam, without changing its behavior. */
function countingSeam(seam: HarnessModelSeam): HarnessModelSeam & { calls: number; phasesSeen: string[] } {
  const wrapper = {
    modelId: seam.modelId,
    calls: 0,
    phasesSeen: [] as string[],
    async askModel(input: Parameters<HarnessModelSeam['askModel']>[0]) {
      wrapper.calls += 1;
      wrapper.phasesSeen.push(input.phase);
      return seam.askModel(input);
    },
  };
  return wrapper;
}

// ---- Tests ----------------------------------------------------------------------------

describe('createDemoModelSeam (task 10.7)', () => {
  it('drives a full attempt to a complete outcome with a real, ledger-cited finding, through the identical phase machinery', async () => {
    const connection = reviewConnection({ files: ['src/a.ts', 'src/b.ts'], patches: { 'src/a.ts': PATCH_WITH_FINDING } });
    const snapshot = testSnapshot();
    const seam = countingSeam(createDemoModelSeam(snapshot));
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.plan).toBeDefined();
    expect(result.plan?.items.length).toBeGreaterThan(0);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.item.file).toBe('src/a.ts');
    expect(result.findings[0]?.evidence.primary.sourceId).toMatch(/^ev_[0-9a-f]{32}$/);

    // Every phase appears, in causal order — the same shape harnessAttempt.test.ts asserts for a real model.
    const phaseOrder: string[] = [];
    for (const event of result.activityLog.events) {
      const last = phaseOrder[phaseOrder.length - 1];
      if (event.phase !== last) phaseOrder.push(event.phase);
    }
    expect(phaseOrder).toEqual(['bootstrap', 'planning', 'investigating', 'verifying', 'completing', 'persisting']);
    const coverageEvents = result.activityLog.events.filter((e) => e.kind === 'coverageChanged');
    expect(coverageEvents.length).toBeGreaterThan(0);

    // The seam that actually did the work saw turns in every model-bearing phase, including
    // at least one 'verifying' call from the 10.6 collaborator's own contradiction check plus
    // the phase loop's own completion-requesting turn.
    expect(new Set(seam.phasesSeen)).toEqual(new Set(['planning', 'investigating', 'verifying']));
    expect(seam.phasesSeen.filter((p) => p === 'verifying').length).toBeGreaterThanOrEqual(2);
  });

  it('a clean file (no anchors qualify) reaches a complete clean outcome with zero findings', async () => {
    const connection = reviewConnection({ files: ['src/clean.ts'], patches: {} });
    const snapshot = testSnapshot();
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(connection)],
      modelSeam: createDemoModelSeam(snapshot),
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.kind).toBe('completeClean');
    expect(result.findings).toHaveLength(0);
  });

  it('fails closed on an unscripted phase (bootstrap/completing/persisting never grant the model a turn)', async () => {
    const seam = createDemoModelSeam(testSnapshot());
    await expect(seam.askModel({ phase: 'completing', repairInstruction: undefined, toolResults: [] })).rejects.toThrow(/completing/);
  });

  it('fails closed on an unexpected repair instruction during investigating (the demo never emits an invalid turn)', async () => {
    const seam = createDemoModelSeam(testSnapshot());
    await seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [] });
    await expect(seam.askModel({ phase: 'investigating', repairInstruction: 'not a real repair instruction', toolResults: [] })).rejects.toThrow();
  });

  it('fails closed if asked for a second plan in the same attempt', async () => {
    const seam = createDemoModelSeam(testSnapshot());
    await seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [] });
    await expect(seam.askModel({ phase: 'planning', repairInstruction: undefined, toolResults: [] })).rejects.toThrow();
  });

  it('shares the same cancellation handling as a real model: cancellation mid-investigation ends the attempt promptly and the demo seam is not asked again', async () => {
    const cancellation = fakeCancellationToken();
    const connection = cancellingConnection({ files: ['src/a.ts'], patches: { 'src/a.ts': PATCH_WITH_FINDING } }, cancellation.cancel);
    const snapshot = testSnapshot();
    const seam = countingSeam(createDemoModelSeam(snapshot));
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
    });

    const result = await attempt.run();

    expect(result.cancelled).toBe(true);
    expect(result.lifecycle).toBe('cancelled');
    expect(result.outcome.completeness).not.toBe('complete');
    const kinds = result.activityLog.events.map((e) => e.kind);
    expect(kinds).toContain('cancelling');
    expect(kinds).toContain('cancelled');
    // Verification never ran: the harness's own pre-turn cancellation check (`isCancelled()` in
    // `runPhaseLoop`/`run()`) stopped the attempt before reaching `verifying`, exactly as it would
    // for a real model's seam — the demo seam saw only its planning and (partial) investigating
    // turns, never a 'verifying' call.
    expect(seam.phasesSeen).not.toContain('verifying');
    expect(seam.calls).toBeGreaterThan(0);
  });
});

describe('demo parity (task 10.9 item 8): a demo attempt and a scripted-model attempt over the same fake review', () => {
  function scriptedRealModelSeam(): HarnessModelSeam {
    const counters: Record<string, number> = {};
    return {
      modelId: 'scripted-real-model',
      async askModel({ phase, repairInstruction, toolResults }) {
        if (phase === 'verifying' && repairInstruction !== undefined) {
          const match = /^candidateId: (.+)$/m.exec(repairInstruction);
          if (!match) throw new Error('scripted model: contradiction directive missing candidateId');
          return JSON.stringify({ candidateId: match[1], contradicted: false });
        }
        const index = counters[phase] ?? 0;
        counters[phase] = index + 1;
        if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed files.' }] }] });
        if (phase === 'investigating') {
          if (index === 0) return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT_REF, path: 'src/a.ts' } }] });
          if (index === 1) {
            const diffResult = toolResults[0];
            if (!diffResult || (diffResult.state !== 'complete' && diffResult.state !== 'paginated' && diffResult.state !== 'truncated')) throw new Error('expected a diff result');
            return JSON.stringify({
              messages: [
                {
                  kind: 'candidateSubmission',
                  candidate: {
                    candidateId: 'scripted-cand-1',
                    memberId: 'm1',
                    file: 'src/a.ts',
                    line: 1,
                    endLine: 1,
                    severity: 'major',
                    category: 'security',
                    confidence: 90,
                    title: 'Token logged in plain text',
                    body: 'A secret value reaches the log sink unredacted.',
                    citations: { primary: { sourceId: diffResult.sourceId, digest: diffResult.digest, path: 'src/a.ts', range: { startLine: 1, endLine: 1 } } },
                  },
                },
              ],
            });
          }
          return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
        }
        if (phase === 'verifying') return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
        throw new Error(`scripted model: no turn expected during phase "${phase}"`);
      },
    };
  }

  it('both attempts publish a plan, complete coverage, register real ledger digests, run verification, and reach the same completion outcome', async () => {
    const patches = { 'src/a.ts': PATCH_WITH_FINDING };
    const snapshot = testSnapshot();

    const demoAttempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(reviewConnection({ files: ['src/a.ts'], patches }))],
      modelSeam: createDemoModelSeam(snapshot),
      policy: testPolicy(),
    });
    const scriptedAttempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(reviewConnection({ files: ['src/a.ts'], patches }))],
      modelSeam: scriptedRealModelSeam(),
      policy: testPolicy(),
    });

    const [demoResult, scriptedResult] = await Promise.all([demoAttempt.run(), scriptedAttempt.run()]);

    for (const result of [demoResult, scriptedResult]) {
      expect(result.lifecycle).toBe('succeeded');
      expect(result.outcome.completeness).toBe('complete');
      expect(result.plan).toBeDefined();
      expect(result.findings.length).toBeGreaterThan(0);
      expect(result.findings[0]?.evidence.primary.sourceId).toMatch(/^ev_[0-9a-f]{32}$/);
      const phaseOrder: string[] = [];
      for (const event of result.activityLog.events) {
        const last = phaseOrder[phaseOrder.length - 1];
        if (event.phase !== last) phaseOrder.push(event.phase);
      }
      expect(phaseOrder).toEqual(['bootstrap', 'planning', 'investigating', 'verifying', 'completing', 'persisting']);
    }
  });

  it('the demo attempt never calls a real model: a throwing decoy seam is never wired in, and the demo seam itself has no model-calling dependency to delegate to', async () => {
    // `HarnessAttemptOptions` accepts exactly one `modelSeam` — there is structurally no second
    // seam parameter for a "real" model to hide behind. This decoy documents and enforces that:
    // it is never passed anywhere, so if it were ever called, that would only be possible via a
    // bug that wires a second, real model path into the demo run.
    const neverCallModel: HarnessModelSeam = {
      modelId: 'must-never-be-called',
      askModel: async () => {
        throw new Error('a real model must never be called during a demo attempt');
      },
    };
    void neverCallModel;

    const snapshot = testSnapshot();
    const seam = countingSeam(createDemoModelSeam(snapshot));
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(reviewConnection({ files: ['src/a.ts'], patches: { 'src/a.ts': PATCH_WITH_FINDING } }))],
      modelSeam: seam,
      policy: testPolicy(),
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    // Every turn the attempt took was answered by the demo seam itself (`seam.calls`), never by
    // any other object — `createHarnessAttempt` has no field through which `neverCallModel`
    // could have participated even if it had been passed.
    expect(seam.calls).toBeGreaterThan(0);
  });

  it('a harness attempt wired to a seam that always throws cannot produce any result — proving the demo attempt\'s success is attributable to the demo participant\'s own logic, not a fallback path', async () => {
    const alwaysThrows: HarnessModelSeam = {
      modelId: DEMO_PARTICIPANT_MODEL_ID,
      askModel: async () => {
        throw new Error('no model available');
      },
    };
    const snapshot = testSnapshot({ modelId: DEMO_PARTICIPANT_MODEL_ID });
    const attempt = createHarnessAttempt({
      ...baseOptions({ synthesisVerification: createSynthesisVerification() }),
      snapshot,
      members: [member(reviewConnection({ files: ['src/a.ts'], patches: {} }))],
      modelSeam: alwaysThrows,
      policy: testPolicy(),
    });

    await expect(attempt.run()).rejects.toThrow('no model available');
  });
});
