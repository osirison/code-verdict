import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDemoInvestigationSource, SAMPLE_DATA_PROVIDER_ID } from '../registry';
import { fakeInvestigationSource } from '../testing/investigationDouble';
import type { InvestigationOperations, InvestigationSource } from '../platform/types';
import { dirname, join } from 'node:path';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { checkCheckpointIntegrity, nextAttemptNumber, ResumeIncompatibleError } from './harnessResume';
import { computeSnapshotDigest } from './harnessCheckpoint';
import { createHarnessRunStore, type HarnessRunStore } from './harnessRunStore';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import { DEFAULT_RISK_COVERAGE_RULES, type RiskCoverageRules } from './harnessRiskFloors';
import { BUILTIN_AGENT_DESCRIPTOR, DEMO_AGENT_DESCRIPTOR } from './agents';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import { ReviewRunManager, type CrRunTarget, type RunInput, type RunRecord } from './reviewRunManager';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import type { Connection, ScmProvider, MemberCapabilities } from '../platform/provider';
import { INVESTIGATION_CONTRACT_VERSION, type ObjectSourceResult } from '../platform/types';
import { normalizeLocalGitPolicy } from '../localgit/localGitPolicy';
import type { AcquisitionOutcome, ObjectCache } from '../localgit/objectAcquisition';
import type { CacheLease } from '../localgit/objectCache';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';

// ---- Fixture identity: the harness snapshot's own member-key formula, mirrored here ----

const REPO_ID = 'repo-e2e';
const CR_NUMBER = '101';
const BASE_SHA = 'base-e2e-1';
const HEAD_SHA = 'head-e2e-1';
const FILE_PATH = 'src/a.ts';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;
const PROVIDER_ID = 'fake-e2e-provider';
const POD_ID = 'pod-e2e-1';

// ---- Fakes: a Connection, a provider, a pod store, a model turn — no fixture provider ----

function notImplemented(): never {
  throw new Error('not implemented in this fake connection');
}

function fakeConnection(methods: Partial<Connection & InvestigationOperations>): Connection & Partial<InvestigationOperations> {
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

function e2eConnection(): Connection {
  return fakeConnection({
    getChangeRequestDetails: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: { title: 'A small end-to-end change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
    }),
    listChangedFiles: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 3, removedLines: 1, byteSize: 120 }],
    }),
    readDiff: async (request) => ({
      snapshot: request.snapshot,
      state: 'complete',
      value: {
        path: request.path,
        patch: '@@ -1,1 +1,1 @@\n-old\n+new\n',
        positions: [{ path: request.path, side: 'new', line: 1, endLine: 1 }],
      },
    }),
    readFile: async (request) => ({ snapshot: request.snapshot, state: 'notFound', reason: 'no such file in this fixture' }),
    getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
  });
}

function e2eCapabilities(): MemberCapabilities {
  const supported = { supported: true, pageBound: { maxPageSize: 100 } };
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    // What the *provider* declares: the two forge-only detail reads. The five
    // pinned operations below are the member's composed set, which
    // `withSourceInvestigation` builds from a source — no provider declares one.
    detailRetrieval: { changeRequestDetails: supported, issueDetails: supported, pagination: { maxPageSize: 100 } },
    reviewInvestigation: {
      manifests: supported,
      diffReads: supported,
      fileReads: supported,
      repositorySearch: supported,
      diffSearch: supported,
      changeRequestDetails: supported,
      issueDetails: supported,
      pagination: { maxPageSize: 100 },
    },
  };
}

function fakePodStore() {
  return {
    list: () => [
      {
        id: POD_ID,
        name: 'E2E pod',
        providerId: PROVIDER_ID,
        instanceUrl: 'https://example.test',
        sources: [],
        authMode: 'none' as const,
      },
    ],
  };
}

/**
 * The connection the current test registered, remembered so the deps below can
 * hand its five investigation operations to the member as a *source*.
 *
 * They used to ride on the connection itself. They do not any more — no forge
 * answers investigation — so a suite that drives the real runtime supplies the
 * source the way a host does, out of the same fake bag. Nothing about what the
 * fake answers changed; only which object is asked.
 */
let registeredConnection: (Connection & Partial<InvestigationOperations>) | undefined;

/** What the host would supply for this pod: the same bag, as a source. */
function suppliedSource(): InvestigationSource | undefined {
  return registeredConnection ? fakeInvestigationSource(registeredConnection) : undefined;
}

function registerFakeProvider(connection: Connection & Partial<InvestigationOperations>): void {
  registeredConnection = connection;
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake E2E',
    capabilities: e2eCapabilities(),
    vocabulary: {} as ScmProvider['vocabulary'],
    host: {} as ScmProvider['host'],
    authModesFor: () => ['none'],
    connect: () => connection,
  } as unknown as ScmProvider;
  registerProvider(provider);
}

const fakeSecrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };

/**
 * A scripted "model" driven entirely by the *real rendered prompt text*
 * (`./harnessModelSeam.ts`'s `renderModelPrompt`, via `createLiveModelSeam`)
 * — never a hand-built `HarnessModelSeam`. Extracting the prior turn's
 * `sourceId`/`digest` straight out of the rendered prompt (rather than
 * hardcoding one) is what proves the model is actually told the evidence
 * source's identifier by the real seam, not by test scaffolding.
 */
function scriptedRunTurn(): (modelId: string, prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  return async (_modelId: string, prompt: string) => {
    if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
      const match = /candidateId: (\S+)/.exec(prompt);
      return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
    }
    const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
    if (phase === 'planning') {
      return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] }] });
    }
    if (phase === 'investigating') {
      investigatingCalls += 1;
      if (investigatingCalls === 1) {
        return JSON.stringify({
          messages: [
            {
              kind: 'toolRequest',
              tool: 'readDiff',
              memberId: MEMBER_ID,
              request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH },
            },
          ],
        });
      }
      if (investigatingCalls === 2) {
        const citation = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
        if (!citation) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
        return JSON.stringify({
          messages: [
            {
              kind: 'candidateSubmission',
              candidate: {
                candidateId: 'cand-1',
                memberId: MEMBER_ID,
                file: FILE_PATH,
                line: 1,
                endLine: 1,
                severity: 'major',
                category: 'errorHandling',
                confidence: 90,
                title: 'Issue found during investigation',
                body: 'A real issue found in the changed file.',
                citations: { primary: { sourceId: citation[1], digest: citation[2], path: FILE_PATH, range: { startLine: 1, endLine: 1 } } },
              },
            },
          ],
        });
      }
      return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
    }
    if (phase === 'verifying') {
      return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
    }
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}", prompt starts: ${prompt.slice(0, 120)}`);
  };
}

function jsonMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (map.has(key) ? (JSON.parse(JSON.stringify(map.get(key))) as T) : undefined),
    update: async (key: string, value: unknown) => {
      if (value === undefined) {
        map.delete(key);
        return;
      }
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    keys: () => [...map.keys()],
  };
}

function runInput(overrides: Partial<RunInput> = {}): RunInput {
  const target: CrRunTarget = {
    kind: 'cr',
    ref: { repoId: REPO_ID, number: CR_NUMBER },
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
  };
  return {
    target,
    refLabel: `!${CR_NUMBER}`,
    podId: POD_ID,
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: BUILTIN_AGENT_DESCRIPTOR.label,
    modelId: 'lm:test/test-model',
    effort: 'none',
    timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    demo: false,
    ...overrides,
  };
}

function noopRunOptions(identity: { runId: string; lineageId: string; attempt: number }) {
  return {
    identity,
    timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
    onProgress: () => {},
    onAttachmentWarnings: () => {},
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    onCheckpoint: () => {},
  };
}

let harnessRunStore: HarnessRunStore;
let store: KeyValueStore;
let connection: Connection;
let deps: HarnessRuntimeDeps;

beforeEach(() => {
  clearProviders();
  connection = e2eConnection();
  registerFakeProvider(connection);
  store = jsonMemoryStore();
  harnessRunStore = createHarnessRunStore(store, { now: () => Date.parse('2026-09-04T00:00:00.000Z') });
  deps = {
    investigationSource: () => suppliedSource(),
    podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
    secrets: fakeSecrets,
    discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
    countTokens: async () => undefined,
    runTurn: scriptedRunTurn(),
    revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
    harnessRunStore,
  };
});

afterEach(() => {
  clearProviders();
});

describe('createReviewHarnessFactory — the real runtime wiring (task 15.7)', () => {
  it('runs a real review through typed turns against a fake Connection and fake model, dispatches tools, registers evidence, evaluates completion, writes a checkpoint, and reaches a terminal outcome', async () => {
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-e2e-1', lineageId: 'lineage-e2e-1', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.item.file).toBe(FILE_PATH);

    // The snapshot and at least one checkpoint were actually persisted to the store — not just
    // reported to the manager through `onCheckpoint`'s reporting-only callback.
    const storedSnapshot = harnessRunStore.readSnapshot(identity.lineageId as never, identity.attempt as never);
    expect(storedSnapshot).toBeDefined();
    const checkpoints = harnessRunStore.checkpointsFor(identity.lineageId as never);
    expect(checkpoints.length).toBeGreaterThan(0);

    // A checkpoint written on the live path is readable by the store and accepted by the resume
    // compatibility check.
    const latest = harnessRunStore.latestCheckpoint(identity.lineageId as never)!;
    expect(checkCheckpointIntegrity(storedSnapshot!, latest)).toEqual([]);
    expect(latest.snapshotDigest).toBe(computeSnapshotDigest(storedSnapshot!));

    // Task 14.6: the *last* checkpoint of a completed attempt must itself project as terminal, not
    // merely as whichever phase last ran. `harnessAttempt.ts`'s `runPersisting` used to fire its
    // 'persisting' phase-boundary checkpoint before appending the terminal activity fact, so this
    // checkpoint's own `activityLog` snapshot never carried the fact that ended the run — every
    // attempt, successful or not, landed in `HarnessRunStore` looking merely mid-flight, and
    // `sweepInterruptedRuns`/any future resume-compatibility check reading the stored checkpoint
    // alone (rather than the live `RunRecord`) could not tell a genuinely completed lineage from an
    // interrupted one.
    expect(latest.projection.lifecycle).toBe('succeeded');
  });

  it('fails truthfully with no fallback when the selected model is no longer available', async () => {
    const missingModelDeps: HarnessRuntimeDeps = { ...deps, discoverModel: async () => undefined };
    const factory = createReviewHarnessFactory(missingModelDeps);
    const identity = { runId: 'run-e2e-2', lineageId: 'lineage-e2e-2', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    await expect(attempt.run()).rejects.toThrow(/no longer available/);
  });

  it('fails truthfully with no fallback when the model itself rejects (a refusing/unavailable model)', async () => {
    const refusing: HarnessRuntimeDeps = {
      ...deps,
      runTurn: async () => {
        throw new Error('Model test-model is no longer available');
      },
    };
    const factory = createReviewHarnessFactory(refusing);
    const identity = { runId: 'run-e2e-3', lineageId: 'lineage-e2e-3', attempt: 1 };
    const attempt = factory.create(runInput(), noopRunOptions(identity));

    await expect(attempt.run()).rejects.toThrow(/no longer available/);
  });
});

/** Runs `scriptedRunTurn`'s own real planning/investigating script, then throws once the model
 * reaches the verifying phase — the real turn loop's own phase-boundary checkpoints (planning,
 * investigating) have already fired and been durably written by then, so this stands in for an
 * extension-host restart mid-attempt without needing a real one. */
function scriptedRunTurnInterruptedAtVerifying(): (modelId: string, prompt: string) => Promise<string> {
  const inner = scriptedRunTurn();
  return async (modelId, prompt) => {
    const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
    if (phase === 'verifying') throw new Error('simulated extension host restart mid-attempt');
    return inner(modelId, prompt);
  };
}

describe('resuming an interrupted attempt (task 14.6)', () => {
  it('a compatible resume starts attempt N+1 in the same run and lineage, seeded from the interrupted checkpoint, and reaches a genuine succeeded outcome', async () => {
    const lostDeps: HarnessRuntimeDeps = { ...deps, runTurn: scriptedRunTurnInterruptedAtVerifying() };
    const factory = createReviewHarnessFactory(lostDeps);
    const identity1 = { runId: 'run-resume-1', lineageId: 'lineage-resume-1', attempt: 1 };
    const attempt1 = factory.create(runInput(), noopRunOptions(identity1));
    await expect(attempt1.run()).rejects.toThrow(/simulated extension host restart/);

    // What the "restart" left behind: a real, non-terminal checkpoint from the live turn loop,
    // carrying the accepted candidate and real budget consumption — never hand-built.
    const lostCheckpoint = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    expect(lostCheckpoint).toBeDefined();
    expect(lostCheckpoint.candidates.some((c) => c.state === 'accepted')).toBe(true);
    expect(lostCheckpoint.budget.toolCallsUsed).toBeGreaterThan(0);

    // The manager's own lookup, mirrored here: the resumed attempt's identity comes from the
    // stored checkpoint (`runId`, `lineageId`), never freshly minted — `decideResume`'s
    // `lineageIdentity` guard requires it (`ReviewRunManager.resumeRun`'s own doc comment).
    const identity2 = { runId: lostCheckpoint.runId, lineageId: lostCheckpoint.lineageId, attempt: nextAttemptNumber(lostCheckpoint.attempt) };
    expect(identity2.attempt).toBe(2);

    // A second, independent full pass — the resumed attempt is a brand-new model session (design.md:
    // "the model starts over"), so it goes through planning/investigating/verifying for real again.
    const resumedDeps: HarnessRuntimeDeps = { ...deps, runTurn: scriptedRunTurn() };
    const resumeFactory = createReviewHarnessFactory(resumedDeps);
    const attempt2 = resumeFactory.resume(runInput(), noopRunOptions(identity2));
    const result = await attempt2.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.attempt).toBe(2);
    expect(result.lineageId).toBe(identity1.lineageId);
    // Budget is cumulative across the lineage, not reset per attempt: this attempt's own usage
    // plus whatever attempt 1 already spent before it was lost.
    expect(result.toolCallsUsed).toBeGreaterThan(lostCheckpoint.budget.toolCallsUsed);

    const finalCheckpoint = harnessRunStore.latestCheckpoint(identity2.lineageId as never)!;
    expect(finalCheckpoint.attempt).toBe(2);
    expect(finalCheckpoint.projection.lifecycle).toBe('succeeded');
  });

  it('an incompatible resume — the model changed since the interrupted attempt — rejects with every reason, and never overwrites the stored (still nonterminal) checkpoint', async () => {
    const lostDeps: HarnessRuntimeDeps = { ...deps, runTurn: scriptedRunTurnInterruptedAtVerifying() };
    const factory = createReviewHarnessFactory(lostDeps);
    const identity1 = { runId: 'run-resume-2', lineageId: 'lineage-resume-2', attempt: 1 };
    const attempt1 = factory.create(runInput(), noopRunOptions(identity1));
    await expect(attempt1.run()).rejects.toThrow();

    const lostCheckpoint = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    const identity2 = { runId: lostCheckpoint.runId, lineageId: lostCheckpoint.lineageId, attempt: nextAttemptNumber(lostCheckpoint.attempt) };

    // A different model than the interrupted attempt used — `decideResume`'s `model` dimension.
    const differentModelDeps: HarnessRuntimeDeps = {
      ...deps,
      runTurn: scriptedRunTurn(),
      discoverModel: async (modelId) => ({ id: modelId, label: 'Different model', description: '', vendor: 'test', family: 'other-model', maxInputTokens: undefined }),
    };
    const resumeFactory = createReviewHarnessFactory(differentModelDeps);
    const attempt2 = resumeFactory.resume(runInput(), noopRunOptions(identity2));

    const outcome = await attempt2.run().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ResumeIncompatibleError);
    const reasons = (outcome.error as ResumeIncompatibleError).reasons;
    expect(reasons.some((reason) => reason.code === 'model')).toBe(true);

    // The lineage's own stored checkpoint is untouched by the rejected attempt: still there, still
    // the same nonterminal one — a caller can switch the model back and resume can still succeed.
    const stillThere = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    expect(stillThere.checkpointId).toBe(lostCheckpoint.checkpointId);
    expect(stillThere.attempt).toBe(1);
  });

  // ---- Task 16.8 -----------------------------------------------------------------------

  it('task 16.8: a changed head forces a restart, not a resume — decideResume rejects it, and a genuinely fresh restart (new lineage, attempt 1) still succeeds once the provider agrees on the new head', async () => {
    const lostDeps: HarnessRuntimeDeps = { ...deps, runTurn: scriptedRunTurnInterruptedAtVerifying() };
    const factory = createReviewHarnessFactory(lostDeps);
    const identity1 = { runId: 'run-resume-head', lineageId: 'lineage-resume-head', attempt: 1 };
    const attempt1 = factory.create(runInput(), noopRunOptions(identity1));
    await expect(attempt1.run()).rejects.toThrow(/simulated extension host restart/);

    const lostCheckpoint = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    const identity2 = { runId: lostCheckpoint.runId, lineageId: lostCheckpoint.lineageId, attempt: nextAttemptNumber(lostCheckpoint.attempt) };
    const NEW_HEAD_SHA = 'head-e2e-1-moved';

    // More commits landed on the target between the interruption and the resume attempt — the
    // reviewer's *current* configuration (what `resume` always builds the candidate snapshot from)
    // now names a different head than the lost attempt's own stored snapshot.
    const movedHeadInput = runInput({ target: { kind: 'cr', ref: { repoId: REPO_ID, number: CR_NUMBER }, baseSha: BASE_SHA, headSha: NEW_HEAD_SHA } });
    const resumeFactory = createReviewHarnessFactory({ ...deps, runTurn: scriptedRunTurn() });
    const attempt2 = resumeFactory.resume(movedHeadInput, noopRunOptions(identity2));

    const outcome = await attempt2.run().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(ResumeIncompatibleError);
    expect((outcome.error as ResumeIncompatibleError).reasons.some((reason) => reason.code === 'headRevision')).toBe(true);
    // Restart, never resume: the lost lineage's own stored checkpoint is completely untouched by
    // the rejected attempt — still attempt 1, still nonterminal.
    const stillThere = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    expect(stillThere.checkpointId).toBe(lostCheckpoint.checkpointId);
    expect(stillThere.attempt).toBe(1);

    // The fresh restart itself: a genuinely new lineage, attempt 1, through the ordinary `create`
    // path — never `resume` — against a provider that now agrees the head really did move (the
    // one piece a hand-picked new head alone cannot prove: the *attempt* actually re-verifies the
    // provider's current head at completion, not merely at snapshot construction).
    clearProviders();
    registerFakeProvider(fakeConnection({
      getChangeRequestDetails: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { title: 'A small end-to-end change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } }),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 3, removedLines: 1, byteSize: 120 }] }),
      readDiff: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { path: request.path, patch: '@@ -1,1 +1,1 @@\n-old\n+new\n', positions: [{ path: request.path, side: 'new', line: 1, endLine: 1 }] } }),
      readFile: async (request) => ({ snapshot: request.snapshot, state: 'notFound', reason: 'no such file in this fixture' }),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: NEW_HEAD_SHA }),
    }));
    // `scriptedRunTurn()` hardcodes the *original* `HEAD_SHA` in its own investigating-phase tool
    // requests — unsuitable here, since this attempt's real snapshot (built from `movedHeadInput`)
    // is pinned to `NEW_HEAD_SHA`; a mismatched snapshot in the request would simply be refused.
    // Otherwise identical: read the one file, submit one real, validly cited finding.
    let restartInvestigatingCalls = 0;
    const restartRunTurn = async (_modelId: string, prompt: string) => {
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const match = /candidateId: (\S+)/.exec(prompt);
        return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
      }
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] }] });
      if (phase === 'investigating') {
        restartInvestigatingCalls += 1;
        if (restartInvestigatingCalls === 1) {
          return JSON.stringify({
            messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: NEW_HEAD_SHA }, path: FILE_PATH } }],
          });
        }
        if (restartInvestigatingCalls === 2) {
          const citation = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
          if (!citation) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
          return JSON.stringify({
            messages: [
              {
                kind: 'candidateSubmission',
                candidate: {
                  candidateId: 'cand-restart',
                  memberId: MEMBER_ID,
                  file: FILE_PATH,
                  line: 1,
                  endLine: 1,
                  severity: 'major',
                  category: 'errorHandling',
                  confidence: 90,
                  title: 'Issue found during the restarted investigation',
                  body: 'A real issue found in the changed file, on the new head.',
                  citations: { primary: { sourceId: citation[1], digest: citation[2], path: FILE_PATH, range: { startLine: 1, endLine: 1 } } },
                },
              },
            ],
          });
        }
        return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
      }
      if (phase === 'verifying') return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
    };
    const restartIdentity = { runId: 'run-restart-head', lineageId: 'lineage-restart-head', attempt: 1 };
    const restartFactory = createReviewHarnessFactory({ ...deps, runTurn: restartRunTurn });
    const restartResult = await restartFactory.create(movedHeadInput, noopRunOptions(restartIdentity)).run();

    expect(restartResult.lifecycle).toBe('succeeded');
    expect(restartResult.attempt).toBe(1);
    expect(restartResult.lineageId).toBe(restartIdentity.lineageId);
    expect(restartResult.lineageId).not.toBe(identity1.lineageId);
    // Nothing carried across: this is a brand-new lineage's own attempt 1, not attempt 2 of the
    // interrupted one — the restart's own finding is real, freshly investigated, not replayed.
    expect(restartResult.findings).toHaveLength(1);
  });

  it('task 16.8: a compatible resume carries plan, coverage, and findings forward — the resumed attempt reaches a truthful complete outcome without repeating investigation the interrupted attempt already did, and its activity log never claims a reconnection', async () => {
    const lostDeps: HarnessRuntimeDeps = { ...deps, runTurn: scriptedRunTurnInterruptedAtVerifying() };
    const factory = createReviewHarnessFactory(lostDeps);
    const identity1 = { runId: 'run-carry-1', lineageId: 'lineage-carry-1', attempt: 1 };
    const attempt1 = factory.create(runInput(), noopRunOptions(identity1));
    await expect(attempt1.run()).rejects.toThrow(/simulated extension host restart/);

    const lostCheckpoint = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    // What the interrupted attempt actually carries: a plan, one already-inspected file's
    // coverage, and one already-accepted, validly cited candidate — all real, from the live turn
    // loop, never hand-built.
    expect(lostCheckpoint.plan?.items).toHaveLength(1);
    expect(lostCheckpoint.coverage.flatMap((c) => c.files).some((f) => f.path === FILE_PATH && f.state === 'inspected')).toBe(true);
    expect(lostCheckpoint.candidates.some((c) => c.state === 'accepted')).toBe(true);

    const identity2 = { runId: lostCheckpoint.runId, lineageId: lostCheckpoint.lineageId, attempt: nextAttemptNumber(lostCheckpoint.attempt) };

    // The resumed attempt's own script never issues a single investigating-phase tool call — if
    // coverage genuinely carried forward, the one file is already 'inspected' and there is nothing
    // left to investigate; if the candidate genuinely carried forward, it survives into this
    // attempt's own findings without ever being resubmitted.
    let investigatingCalls = 0;
    const resumedNoWorkRunTurn = async (_modelId: string, prompt: string) => {
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const match = /candidateId: (\S+)/.exec(prompt);
        return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
      }
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      // 'planning' is never expected here: the seeded plan already satisfies `runPlanning`'s own
      // stop condition before the phase loop ever asks the model anything.
      if (phase === 'investigating') {
        investigatingCalls += 1;
        return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Nothing left uninvestigated.' }] });
      }
      if (phase === 'verifying') return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}", prompt starts: ${prompt.slice(0, 120)}`);
    };
    const resumeFactory = createReviewHarnessFactory({ ...deps, runTurn: resumedNoWorkRunTurn });
    const attempt2 = resumeFactory.resume(runInput(), noopRunOptions(identity2));
    const result = await attempt2.run();

    expect(investigatingCalls).toBe(1); // asked once (the loop always asks at least once), given nothing to do
    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    // The plan carried forward (present without this attempt's own planning turn ever running).
    expect(result.plan?.items.map((item) => item.id)).toEqual(['p1']);
    // The finding carried forward: never resubmitted by this attempt's script, yet present.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.item.file).toBe(FILE_PATH);

    // Task 16.8/11.8: the real, production activity log a reviewer would actually see for this
    // resumed attempt never claims a reconnection — extends `harnessResume.test.ts`'s own
    // "no-reconnect wording" check (which only scans the pure `describeResumeStart`/
    // `interruptedLimitation` string functions in isolation) to the genuine end-to-end log a live
    // `HarnessAttempt` produced, `kind` identifiers (e.g. the literal activity kind `resuming`,
    // task 9.6's unrelated retry-wait mechanism) excluded — this checks prose, not enum tags.
    const FORBIDDEN = [/reconnect/i, /reattach/i, /\bresum(e|ed|ing)\b/i, /\bcontinu(e|ed|ing|ation)\b/i, /still connected/i, /same (session|stream|attempt)/i, /picks?\s.*back up/i];
    const prose = JSON.stringify(result.activityLog.events).replace(/"kind":"[a-zA-Z]+"/g, '');
    for (const pattern of FORBIDDEN) expect(prose).not.toMatch(pattern);
  });
});

describe('ReviewRunManager driven by the real harness factory (task 10.2/10.8)', () => {
  it('a triggered review genuinely goes through phase-specific typed turns end to end and settles as a succeeded, complete RunRecord', async () => {
    const factory = createReviewHarnessFactory(deps);
    const globalState = jsonMemoryStore();
    const workspaceState = jsonMemoryStore();
    const manager = new ReviewRunManager({ workspaceState, globalState, runners: factory });

    const record = manager.trigger(runInput(), 1);
    expect(record.lifecycle === 'queued' || record.lifecycle === 'planning').toBe(true);

    const settled = await new Promise<RunRecord>((resolve) => {
      const subscription = manager.subscribe((next) => {
        if (next.key !== record.key) return;
        if (next.lifecycle === 'succeeded' || next.lifecycle === 'failed' || next.lifecycle === 'cancelled') {
          subscription.dispose();
          resolve(next);
        }
      });
    });

    expect(settled.lifecycle).toBe('succeeded');
    expect(settled.completeness).toBe('complete');
    expect(settled.response?.items).toHaveLength(1);
    expect(settled.response?.items[0]?.file).toBe(FILE_PATH);
  });
});

describe('policy and risk-coverage rules reach the harness fresh per attempt (task 17.1/17.2)', () => {
  it('reads deps.policy and deps.riskCoverageRules exactly once per attempt built, never caching a value from an earlier attempt', async () => {
    // Mirrors `extension.ts`'s production wiring: a getter, not a value captured once — a settings
    // panel edit must reach the *next* attempt a factory builds without a window reload
    // (`HarnessRuntimeDeps.policy`'s own doc comment in `harnessRuntime.ts`).
    let policyReads = 0;
    let coverageReads = 0;
    const secondPolicy: HarnessPolicy = { ...DEFAULT_HARNESS_POLICY, maxModelTurnsPerAttempt: 5 };
    const secondCoverage: RiskCoverageRules = { ...DEFAULT_RISK_COVERAGE_RULES, requireInspection: ['high'] };

    function dynamicDeps(): HarnessRuntimeDeps {
      return {
        ...deps,
        // Fresh per attempt: the scripted model turn is stateful (it counts its own calls), so
        // reusing one instance across two attempts would desync it — the same reason the existing
        // resume tests above build a fresh `scriptedRunTurn()` per attempt rather than reusing `deps`.
        runTurn: scriptedRunTurn(),
        get policy() {
          policyReads += 1;
          return policyReads === 1 ? DEFAULT_HARNESS_POLICY : secondPolicy;
        },
        get riskCoverageRules() {
          coverageReads += 1;
          return coverageReads === 1 ? DEFAULT_RISK_COVERAGE_RULES : secondCoverage;
        },
      };
    }

    const factory = createReviewHarnessFactory(dynamicDeps());
    const attempt1 = factory.create(runInput(), noopRunOptions({ runId: 'run-policy-1', lineageId: 'lineage-policy-1', attempt: 1 }));
    await attempt1.run();
    expect(policyReads).toBe(1);
    expect(coverageReads).toBe(1);

    // A second attempt, built by a factory over deps whose getters return the second (changed)
    // value — the settings-panel-edit-then-run-again scenario.
    const secondFactory = createReviewHarnessFactory(dynamicDeps());
    const attempt2 = secondFactory.create(runInput(), noopRunOptions({ runId: 'run-policy-2', lineageId: 'lineage-policy-2', attempt: 1 }));
    await attempt2.run();
    expect(policyReads).toBe(2);
    expect(coverageReads).toBe(2);
  });
});

// ---- Source selection, recorded and used (tasks 9.1-9.4, 9.10) ------------------------

/**
 * `add-local-git-investigation` task group 9, through the real factory: the
 * source is selected once per member while the snapshot is built, recorded on
 * it, and actually used for the five pinned operations.
 *
 * The object cache is a stub here for every test but one — acquisition has its
 * own suite (`src/localgit/objectAcquisition.test.ts`) and a fetch needs a
 * remote. The exception is deliberate and is the test that matters most: a real
 * bare store holding two real commits, handed to the real local source, over a
 * connection that implements none of the five operations. Nothing but the local
 * source could produce that run's inventory.
 */
describe('selecting and recording an investigation source (tasks 9.1-9.4)', () => {
  function fakeLease(): CacheLease & { released: number; refreshed: number } {
    const lease = {
      path: '/cache/leases/attempt.json',
      released: 0,
      refreshed: 0,
      refresh(): void {
        lease.refreshed += 1;
      },
      release(): void {
        lease.released += 1;
      },
    };
    return lease;
  }

  function fakeObjectCache(outcome: AcquisitionOutcome): ObjectCache {
    return {
      root: '/cache',
      policy: normalizeLocalGitPolicy({}),
      acquire: async () => outcome,
      evict: async () => ({ deleted: [], remainingBytes: 0 }) as never,
    };
  }

  const DESCRIPTOR: ObjectSourceResult = { state: 'available', descriptor: { fetchUrl: 'https://example.test/repo.git', refHint: 'refs/pull/101/head' } };

  it('records the source the host supplied, alongside the provider capability signature it already recorded', async () => {
    const identity = { runId: 'run-source-supplied', lineageId: 'lineage-source-supplied', attempt: 1 };
    await createReviewHarnessFactory(deps).create(runInput(), noopRunOptions(identity)).run();

    const stored = harnessRunStore.readSnapshot(identity.lineageId as never, 1 as never)!;
    const member = stored.members[0]!;
    // `sample`, never `provider`: nothing derives a source from a connection any
    // more, and this suite is the host supplying one.
    expect(member.investigationSource).toEqual({
      kind: 'sample',
      contractVersion: INVESTIGATION_CONTRACT_VERSION,
      capabilitySignature: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    // The provider still serves details, the head check and posting, so its own
    // signature stays exactly where it was (task 9.4).
    expect(typeof member.providerCapabilitySignature).toBe('string');
  });

  /**
   * Task 9.3 and design D5's third branch, under the rule that removed the
   * second branch. There is no object store on this host and no supplied
   * source, so nothing can read the change — and there is no forge to ask
   * instead. The attempt ends before bootstrap, with completeness `none` and a
   * reason naming what was unavailable. Never a clean review of nothing, and
   * never a degraded one.
   */
  it('ends the attempt before bootstrap, with completeness none, when no source can serve the member', async () => {
    let modelTurns = 0;
    const identity = { runId: 'run-source-none', lineageId: 'lineage-source-none', attempt: 1 };
    const result = await createReviewHarnessFactory({
      ...deps,
      investigationSource: () => undefined,
      objectCache: undefined,
      runTurn: async () => {
        modelTurns += 1;
        return '{}';
      },
    })
      .create(runInput(), noopRunOptions(identity))
      .run();

    expect(result.lifecycle).toBe('failed');
    expect(result.outcome.completeness).toBe('none');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.limitations.map((limitation) => limitation.code)).toEqual(['noInvestigationSource']);
    expect(result.outcome.limitations[0]!.message).toContain(MEMBER_ID);
    expect(result.outcome.limitations[0]!.message).toContain('no other source');
    // Not a clean review of nothing: no model was ever asked anything, and the
    // attempt still landed terminal in the store rather than looking stalled.
    expect(modelTurns).toBe(0);
    expect(harnessRunStore.latestCheckpoint(identity.lineageId as never)?.projection.lifecycle).toBe('failed');
  });

  /**
   * Task 10.2. The reviewer sees a run's activity through the checkpoints the
   * attempt reports; nothing exists to report to while selection is still
   * fetching. So the facts acquisition produced are replayed into the attempt's
   * own log as its first events, which puts them in the projection, in every
   * checkpoint and in the diagnostics report.
   *
   * Asserted on the attempt that never starts, deliberately: a run that ends
   * before bootstrap is exactly the one whose reviewer is left wondering what
   * the delay was.
   */
  it('opens the attempt’s own activity log with what acquisition did, even when the attempt never starts', async () => {
    clearProviders();
    registerFakeProvider(
      fakeConnection({
        getChangeRequestDetails: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { title: 'x', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } }),
        listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, contentDeclined: true }] }),
        getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
        getObjectSource: async () => DESCRIPTOR,
      }),
    );

    const identity = { runId: 'run-source-activity', lineageId: 'lineage-source-activity', attempt: 1 };
    const result = await createReviewHarnessFactory({
      ...deps,
      investigationSource: () => undefined,
      objectCache: fakeObjectCache({ state: 'acquired', gitDir: '/cache/repo.git', lease: fakeLease(), baseSha: BASE_SHA, depthReached: 10, fetched: [BASE_SHA], alreadyPresent: [HEAD_SHA], recreated: false }),
      runTurn: async () => '{}',
    })
      .create(runInput(), noopRunOptions(identity))
      .run();

    expect(result.outcome.completeness).toBe('none');
    const [started, finished] = result.activityLog.events;
    expect(started).toMatchObject({ kind: 'actionStarted', action: 'Obtaining the pinned revisions for local review', target: MEMBER_ID, sequence: 1, phase: 'bootstrap' });
    expect(finished).toMatchObject({ kind: 'toolCompleted', tool: 'acquireObjects', memberId: MEMBER_ID, sequence: 2 });
    expect(finished).toMatchObject({ summary: expect.stringContaining('Fetched 1 pinned revision, 1 already held.') });
    // And it survives into what a reviewer actually opens after the fact.
    const checkpoint = harnessRunStore.latestCheckpoint(identity.lineageId as never)!;
    expect(checkpoint.activity.some((event) => event.kind === 'toolCompleted' && event.tool === 'acquireObjects')).toBe(true);
  });

  it('releases the object-store lease when the attempt ends before bootstrap', async () => {
    clearProviders();
    const lease = fakeLease();
    registerFakeProvider(
      fakeConnection({
        getChangeRequestDetails: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { title: 'x', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } }),
        listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, contentDeclined: true }] }),
        getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
        getObjectSource: async () => DESCRIPTOR,
      }),
    );

    // The store is there and holds nothing this member needs: a pinned commit
    // the remote would not serve. The provider cannot serve the change either,
    // so the attempt refuses — and the lease that acquisition took must not
    // outlive it.
    const identity = { runId: 'run-source-lease', lineageId: 'lineage-source-lease', attempt: 1 };
    const result = await createReviewHarnessFactory({
      ...deps,
      investigationSource: () => undefined,
      objectCache: fakeObjectCache({ state: 'acquired', gitDir: '/cache/repo.git', lease, baseSha: BASE_SHA, depthReached: 10, fetched: [], alreadyPresent: [], recreated: false }),
      runTurn: async () => '{}',
    })
      .create(runInput(), noopRunOptions(identity))
      .run();

    expect(result.outcome.completeness).toBe('none');
    expect(lease.released).toBe(1);
  });
});

describe.skipIf(gitExecutableVersion() === undefined)('a member served by a real local object store (tasks 9.1, 9.2)', () => {
  let repo: LocalGitFixture;
  let store: string;

  beforeAll(() => {
    repo = createTwoCommitRepository();
    const init = runGit(repo, ['init', '--bare', '--quiet', join(repo.root, 'store.git')]);
    expect(init.status, init.stderr).toBe(0);
    // Exactly what acquisition leaves behind: both pinned commits under the ref
    // names design D3 gives them. The transfer itself is `objectAcquisition`'s
    // subject, not this file's.
    const push = runGit(repo, ['push', '--quiet', join(repo.root, 'store.git'), `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`, `${repo.headSha}:refs/codeverdict/${repo.headSha}`]);
    expect(push.status, push.stderr).toBe(0);
    store = join(repo.root, 'store.git');
  });

  afterAll(() => repo?.cleanup());

  it('enumerates the change from the store, through a connection that implements none of the five operations', async () => {
    clearProviders();
    const lease: CacheLease & { released: number; refreshed: number } = {
      path: join(store, 'leases', 'attempt.json'),
      released: 0,
      refreshed: 0,
      refresh(): void {
        lease.refreshed += 1;
      },
      release(): void {
        lease.released += 1;
      },
    };
    // Not one of `listChangedFiles`, `readDiff`, `readFile`, `searchRepository`
    // or `searchDiff` is defined here. Every changed file the run below knows
    // about came out of the object store.
    registerFakeProvider(
      fakeConnection({
        getChangeRequestDetails: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { title: 'A change read locally', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } }),
        getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: repo.headSha }),
        getObjectSource: async () => ({ state: 'available', descriptor: { fetchUrl: 'https://example.test/repo.git' } }),
      }),
    );

    const identity = { runId: 'run-source-local', lineageId: 'lineage-source-local', attempt: 1 };
    const localDeps: HarnessRuntimeDeps = {
      ...deps,
      // The real path: nothing is supplied, so the store is what answers.
      investigationSource: () => undefined,
      objectCache: {
        root: dirname(store),
        policy: normalizeLocalGitPolicy({}),
        acquire: async () => ({ state: 'acquired', gitDir: store, lease, baseSha: repo.baseSha, depthReached: 10, fetched: [repo.baseSha, repo.headSha], alreadyPresent: [], recreated: false }),
        evict: async () => ({ deleted: [], remainingBytes: 0 }) as never,
      },
      runTurn: async (_modelId: string, prompt: string) => {
        if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
        const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
        if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Read the change.' }] }] });
        if (phase === 'investigating') return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Stopping here.' }] });
        return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Done.' }] });
      },
    };

    await createReviewHarnessFactory(localDeps)
      .create(runInput({ target: { kind: 'cr', ref: { repoId: REPO_ID, number: CR_NUMBER }, baseSha: repo.baseSha, headSha: repo.headSha } }), noopRunOptions(identity))
      .run();

    const stored = harnessRunStore.readSnapshot(identity.lineageId as never, 1 as never)!;
    expect(stored.members[0]?.investigationSource?.kind).toBe('localGit');

    const coverage = harnessRunStore.latestCheckpoint(identity.lineageId as never)!.coverage.find((member) => member.memberId === MEMBER_ID)!;
    expect(coverage.manifestComplete).toBe(true);
    // The six changed files the fixture really has, including the rename git's
    // own `-M` detected — a provider that implements no manifest operation at
    // all cannot have produced any of this.
    expect(coverage.totalFiles).toBe(6);
    expect(coverage.files.map((file) => file.path)).toContain(repo.paths.renamedTo);
    expect(coverage.files.map((file) => file.path)).toContain(repo.paths.binary);
    // Held while the attempt ran, released once it finished.
    expect(lease.released).toBe(1);
    expect(lease.refreshed).toBeGreaterThan(0);
  });
});

/**
 * Task 9.10's resume outcome, and why there is only one of it now.
 *
 * It used to be two, differing in whether anything proved the pinned commits
 * were gone: the platform reporting the pair not found made the stored
 * checkpoint incompatible, and anything else left it alone. The proof came from
 * asking the forge for a manifest at the pinned pair, which is a diff
 * computation and is exactly what this change removed. So nothing is entitled
 * to say a commit is gone, and the ambiguity resolves the safe way every time:
 * the attempt does not start, and the reviewer's stored work is untouched.
 */
describe('a pinned revision that could not be obtained, on a new attempt in an existing lineage', () => {
  async function lineageWithLostAttempt(name: string): Promise<{ readonly lineageId: string; readonly identity2: { runId: string; lineageId: string; attempt: number } }> {
    const factory = createReviewHarnessFactory({ ...deps, runTurn: scriptedRunTurnInterruptedAtVerifying() });
    const identity1 = { runId: `run-${name}`, lineageId: `lineage-${name}`, attempt: 1 };
    await expect(factory.create(runInput(), noopRunOptions(identity1)).run()).rejects.toThrow(/simulated extension host restart/);
    const lost = harnessRunStore.latestCheckpoint(identity1.lineageId as never)!;
    return { lineageId: identity1.lineageId, identity2: { runId: lost.runId, lineageId: lost.lineageId, attempt: nextAttemptNumber(lost.attempt) } };
  }

  it('ends the attempt, leaves the stored checkpoint compatible, and never says the revision is gone', async () => {
    const { lineageId, identity2 } = await lineageWithLostAttempt('revision-unobtainable');
    const before = harnessRunStore.latestCheckpoint(lineageId as never)!;
    const storedSnapshot = harnessRunStore.readSnapshot(lineageId as never, 1 as never)!;

    const outcome = await createReviewHarnessFactory({
      ...deps,
      runTurn: scriptedRunTurn(),
      // Nothing supplied, and a store that cannot obtain the pinned head: the
      // one condition left that ends a resumed attempt before it starts.
      investigationSource: () => undefined,
      objectCache: {
        root: '/cache',
        policy: normalizeLocalGitPolicy({}),
        acquire: async () => ({
          state: 'commitUnobtainable',
          code: 'fetchFailed',
          commit: HEAD_SHA,
          reason: 'That revision could not be obtained from this repository’s object source.',
        }),
        evict: async () => ({ deleted: [], remainingBytes: 0 }) as never,
      },
    })
      .resume(runInput(), noopRunOptions(identity2))
      .run()
      .then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // Not an incompatibility: nothing established that the pinned commits are
    // gone, so nothing may say the stored checkpoint is stale.
    expect(outcome.error).not.toBeInstanceOf(ResumeIncompatibleError);
    expect((outcome.error as Error).message).toContain(MEMBER_ID);
    expect((outcome.error as Error).message).not.toMatch(/gone|not found|no longer exists/i);

    // The three things "the checkpoint stays compatible" actually means: no
    // snapshot for the attempt that did not start, the stored checkpoint
    // untouched, and a compatibility check over it that still says yes.
    expect(harnessRunStore.readSnapshot(lineageId as never, 2 as never)).toBeUndefined();
    const after = harnessRunStore.latestCheckpoint(lineageId as never)!;
    expect(after.checkpointId).toBe(before.checkpointId);
    expect(checkCheckpointIntegrity(storedSnapshot, after)).toEqual([]);
  });
});

/**
 * Which pod gets a source handed to it, through the real runtime and the
 * production wiring shape.
 *
 * A pod on the sample data provider is the one pod whose change exists in no
 * repository: its sample data lives in memory, behind no remote, and its
 * revisions are not object ids at all, so there is nothing for git to read and
 * nothing to fetch. The host hands it a source instead of one being selected,
 * and `extension.ts` makes that decision in exactly one line.
 *
 * **The live failure this group was rewritten for.** That line used to read
 * `demo ? sample : undefined`, and `demo` is the *run's* flag, which
 * `ui/reviewFlow.ts` sets from `agentId === DEMO_AGENT_DESCRIPTOR.id` — the
 * selected agent, not the pod. The demo agent is in `BUILT_IN_AGENTS` and is
 * offered on every pod. So choosing it on a real GitHub or GitLab change
 * request handed the review the built-in sample dataset: the sample registry is
 * keyed by head sha, a real head matched nothing, the manifest answered
 * notFound, every read answered unavailable, and the run could not complete. It
 * failed honestly rather than inventing findings, and it failed on a pod where
 * the demo agent used to work.
 *
 * The test that stood here asserted exactly the wrong thing — it registered a
 * *non*-sample provider, ran a demo attempt, and required the snapshot to
 * record `sample` — so it documented the bug rather than catching it.
 */
describe('the sample source follows the pod, never the agent', () => {
  /** The wiring `extension.ts` installs, restated here so the shape is what is tested. */
  const productionShape = (pod: { readonly providerId: string; readonly demo: boolean }): InvestigationSource | undefined =>
    pod.providerId === SAMPLE_DATA_PROVIDER_ID ? createDemoInvestigationSource() : undefined;

  /** A pod on the provider named, so what the runtime asks the wiring with is the thing under test. */
  function registerPodOn(providerId: string): HarnessRuntimeDeps['podStore'] {
    clearProviders();
    const connection = e2eConnection();
    registeredConnection = connection;
    registerProvider({
      id: providerId,
      displayName: 'Fake',
      capabilities: e2eCapabilities(),
      vocabulary: {} as ScmProvider['vocabulary'],
      host: {} as ScmProvider['host'],
      authModesFor: () => ['none'],
      connect: () => connection,
    } as unknown as ScmProvider);
    return {
      list: () => [{ id: POD_ID, name: 'Pod', providerId, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }],
    } as unknown as HarnessRuntimeDeps['podStore'];
  }

  it('records the sample source for a pod on the sample data provider, running the ordinary agent', async () => {
    const podStore = registerPodOn(SAMPLE_DATA_PROVIDER_ID);
    const identity = { runId: 'run-sample-pod', lineageId: 'lineage-sample-pod', attempt: 1 };
    // The attempt itself is not driven to a verdict here — the sample dataset is
    // keyed by its own revisions and this fixture's are the e2e ones. What is
    // asserted is the snapshot, written before any model work, which is where
    // the selected source is recorded.
    await createReviewHarnessFactory({ ...deps, podStore, investigationSource: productionShape })
      .create(runInput(), noopRunOptions(identity))
      .run()
      .catch(() => undefined);

    // Not a demo *run*: the pod is what decides this.
    expect(harnessRunStore.readSnapshot(identity.lineageId as never, 1 as never)!.members[0]?.investigationSource?.kind).toBe('sample');
  });

  it('supplies a demo-agent run on a connected pod nothing, so it reads from git like every other agent', async () => {
    const podStore = registerPodOn(PROVIDER_ID);
    const identity = { runId: 'run-demo-agent-connected', lineageId: 'lineage-demo-agent-connected', attempt: 1 };
    const result = await createReviewHarnessFactory({ ...deps, podStore, investigationSource: productionShape, objectCache: undefined })
      .createDemo(runInput({ agent: DEMO_AGENT_DESCRIPTOR, modelId: undefined, demo: true }), noopRunOptions(identity))
      .run();

    // The whole fix, as an outcome: this run went looking for an object store
    // and said so when there was none. Before it, the same run was handed the
    // sample dataset and reviewed a change request that is not this one.
    expect(result.outcome.completeness).toBe('none');
    expect(result.outcome.limitations.map((limitation) => limitation.code)).toEqual(['noInvestigationSource']);
    expect(harnessRunStore.readSnapshot(identity.lineageId as never, 1 as never)!.members[0]?.investigationSource).toBeUndefined();
  });

  it('supplies a connected pod nothing, so it reads from git or refuses', async () => {
    const podStore = registerPodOn(PROVIDER_ID);
    const identity = { runId: 'run-connected-source', lineageId: 'lineage-connected-source', attempt: 1 };
    const result = await createReviewHarnessFactory({ ...deps, podStore, investigationSource: productionShape, objectCache: undefined })
      .create(runInput(), noopRunOptions(identity))
      .run();

    // No object store on this host and nothing supplied: the honest refusal,
    // never sample data standing in for a real repository.
    expect(result.outcome.completeness).toBe('none');
    expect(result.outcome.limitations.map((limitation) => limitation.code)).toEqual(['noInvestigationSource']);
    expect(harnessRunStore.readSnapshot(identity.lineageId as never, 1 as never)!.members[0]?.investigationSource).toBeUndefined();
  });

  /**
   * And the shape restated above really is the one production installs. Two
   * copies of a one-line decision is how the wrong one survives a fix, so this
   * reads the line out of `extension.ts` rather than trusting the copy.
   */
  it('is the shape extension.ts installs, keyed on the pod’s provider and not on the run’s demo flag', async () => {
    const { readFileSync } = await import('node:fs');
    const extension = readFileSync('src/extension.ts', 'utf8');
    const start = extension.indexOf('investigationSource:');
    expect(start).toBeGreaterThan(0);
    const line = extension.slice(start, extension.indexOf('\n', start));
    expect(line).toContain('providerId === SAMPLE_DATA_PROVIDER_ID');
    expect(line).not.toContain('demo ?');
  });
});
