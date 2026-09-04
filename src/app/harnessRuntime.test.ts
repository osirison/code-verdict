import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { checkCheckpointIntegrity, nextAttemptNumber, ResumeIncompatibleError } from './harnessResume';
import { computeSnapshotDigest } from './harnessCheckpoint';
import { createHarnessRunStore, type HarnessRunStore } from './harnessRunStore';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import { DEFAULT_RISK_COVERAGE_RULES, type RiskCoverageRules } from './harnessRiskFloors';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import { ReviewRunManager, type CrRunTarget, type RunInput, type RunRecord } from './reviewRunManager';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';

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

function e2eCapabilities(): ProviderCapabilities {
  const supported = { supported: true, pageBound: { maxPageSize: 100 } };
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
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

function registerFakeProvider(connection: Connection): void {
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
    timeouts: { inactivityMs: 0, ceilingMs: 0 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    demo: false,
    ...overrides,
  };
}

function noopRunOptions(identity: { runId: string; lineageId: string; attempt: number }) {
  return {
    identity,
    timeouts: { inactivityMs: 0, ceilingMs: 0 },
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
