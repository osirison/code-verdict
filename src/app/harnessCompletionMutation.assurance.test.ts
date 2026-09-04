/**
 * Task 16.7 of `add-agentic-review-harness`: completion mutation tests that
 * independently remove each required predicate (`COMPLETION_CLAUSES`,
 * `./harnessCompletion.ts`) and prove complete/clean status is rejected.
 *
 * `harnessCompletion.test.ts` already proves, exhaustively and at the pure
 * `evaluateCompletion` level, that every clause independently gates
 * eligibility given a hand-built `CompletionEvaluationInput`. This file's job
 * is the missing half those tests cannot reach: whether the *real*
 * orchestrator (`harnessAttempt.ts`) actually *feeds* `evaluateCompletion`
 * facts that can independently fail each clause, given genuine provider
 * responses, model turns, and (for the three verification-pass clauses and
 * the citation clause) the real `SynthesisVerificationRunner` seam task 10.6
 * defines. One test per clause, each breaking only that clause while every
 * other clause is engineered to hold, asserting `evaluation`/`outcome`
 * carries exactly the one expected blocker.
 *
 * Two fixture idioms are reused verbatim from prior passes, never
 * reinvented:
 * - The fake `Connection` / real-`createReviewHarnessFactory` idiom from
 *   `harnessProviderLimits.assurance.test.ts` and `harnessRuntime.test.ts`,
 *   for clauses a real provider response and model turn can independently
 *   defeat (headUnchanged, inventoryCompleteForEveryMember,
 *   everyFileClassified, configuredRiskCoverageSatisfied,
 *   noUnresolvedCandidates).
 * - The `createHarnessAttempt` / scripted-`HarnessModelSeam` idiom from
 *   `harnessAttempt.test.ts`, for clauses that live behind the injected
 *   `SynthesisVerificationRunner` collaborator seam (task 10.6):
 *   everyRetainedCitationValid, contradictionPassComplete,
 *   deduplicationComplete, finalVerificationComplete. Controlling that
 *   collaborator directly is not "hand-simulating the inventory" — it is the
 *   documented seam `harnessAttempt.ts` itself defines and injects; the real
 *   orchestrator code between the seam and the gate
 *   (`runSynthesisVerification`/`currentCompletionEvaluation`) is exactly
 *   what is under test.
 *
 * **Headline finding of this pass (the `passesStale` gap).** A candidate
 * submitted during `verifying`, *after* synthesis/verification already ran
 * once on this attempt, sets `passesStale = true` (`harnessAttempt.ts`) so a
 * later `completionRequest` reruns synthesis before granting. But if the
 * model never sends a `completionRequest` — it simply stops (a
 * `publicRationale`, or no more actionable work) — nothing rechecks
 * `passesStale` before `runCompleting()` reads `latestPasses`/
 * `survivingFindings`. Those are the *first* run's stale snapshot: the gate
 * evaluates clean (every clause still reports satisfied) and the newly
 * accepted, properly cited candidate is silently absent from
 * `result.findings` — a genuinely accepted finding is dropped and the run
 * can report `completeClean` when it should not even be `complete`. This is
 * exactly the class of defect 16.7 exists to catch: not a clause that never
 * blocks, but the gate being fed a stale-but-"passing" snapshot. Reproduced
 * below, then fixed in `harnessAttempt.ts`'s `runVerifying` (an unconditional
 * reconciliation pass after the turn loop ends, whenever verification went
 * stale and the attempt was not cancelled) — the fix is exercised by the same
 * test, which fails against the pre-fix code and passes against the fix.
 *
 * **Two clauses reported, not "fixed": genuinely vacuous under today's real
 * orchestrator, by documented design, not by a routing bug (contrast with
 * the reserve defect `harnessLargeReview.assurance.test.ts` found and
 * fixed).**
 * - `noUnresolvedFetches`: `harnessAttempt.ts`'s own header documents that
 *   every tool dispatch is awaited to a definite result before the turn loop
 *   continues — there is no pending/queued fetch state to ever report
 *   nonzero. `evaluateCompletion` still refuses complete/clean whenever it is
 *   fed a nonzero count (proven at the pure level in `harnessCompletion.test.ts`);
 *   the real orchestrator today simply never produces one. Pinned below by
 *   asserting the real orchestrator always reports `unresolvedFetches: 0`
 *   through a completed attempt's checkpoint.
 * - `everyRetainedCitationValid`'s `revalidated` sub-condition: `runSynthesisVerification`
 *   sets `latestCitations.revalidated = true` unconditionally, from the
 *   host's own `revalidateFindings` call, independent of the injected
 *   collaborator's output, the instant synthesis runs at all — and synthesis
 *   always runs once `verifying` is reached in a non-cancelled attempt. So
 *   `revalidated: false` cannot occur outside cancellation (already covered
 *   by 16.5's cancellation tests). The clause's *other* half —
 *   `invalidatedCount > 0` — is genuinely reachable, and is the one this
 *   file's `everyRetainedCitationValid` test exercises.
 *
 * No fixture-provider import; `DiffPage.positions` supplied non-empty
 * throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import {
  createHarnessAttempt,
  type HarnessAttemptMemberInput,
  type HarnessAttemptOptions,
  type HarnessModelSeam,
  type SynthesisVerificationRunner,
} from './harnessAttempt';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { CONTRADICTION_CHECK_MARKER, createSynthesisVerification } from './harnessSynthesisVerification';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { CrRunTarget, RunInput } from './reviewRunManager';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';
import type { ChangedFileEntry, ChangeRequestDetailResult, DiffPageResult, NormalizedDetail } from '../platform/types';

// ---- Fixture idiom 1: fake Connection + createReviewHarnessFactory, copied from
// harnessProviderLimits.assurance.test.ts / harnessRuntime.test.ts ------------------------

const REPO_ID = 'repo-mut';
const CR_NUMBER = '1';
const BASE_SHA = 'base-mut-1';
const HEAD_SHA = 'head-mut-1';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;
const PROVIDER_ID = 'fake-mut-provider';
const POD_ID = 'pod-mut-1';
const HIGH_FILE = 'src/auth/login.ts'; // matches DEFAULT_RISK_FLOOR_RULES' 'path.auth' rule -> risk 'high'
const LOW_FILE = 'src/util.ts';

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

function mutCapabilities(): ProviderCapabilities {
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
  return { list: () => [{ id: POD_ID, name: 'Mutation pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

function registerFakeProvider(connection: Connection): void {
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Mutation',
    capabilities: mutCapabilities(),
    vocabulary: {} as ScmProvider['vocabulary'],
    host: {} as ScmProvider['host'],
    authModesFor: () => ['none'],
    connect: () => connection,
  } as unknown as ScmProvider;
  registerProvider(provider);
}

const fakeSecrets = { get: async () => undefined, store: async () => {}, delete: async () => {} };

afterEach(() => clearProviders());

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
  const target: CrRunTarget = { kind: 'cr', ref: { repoId: REPO_ID, number: CR_NUMBER }, baseSha: BASE_SHA, headSha: HEAD_SHA };
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

function benignDetail(): NormalizedDetail {
  return { title: 'A small change', body: 'Fixes a bug.', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
}

function detailResult(): ChangeRequestDetailResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: benignDetail() };
}

function diffPage(path: string): DiffPageResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: { path, patch: '@@ -1,1 +1,1 @@\n-old\n+new\n', positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

function baseDeps(): HarnessRuntimeDeps {
  return {
    podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
    secrets: fakeSecrets,
    discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
    countTokens: async () => undefined,
    runTurn: async () => {
      throw new Error('runTurn not overridden for this test');
    },
    revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
    harnessRunStore: createHarnessRunStore(jsonMemoryStore(), { now: () => Date.parse('2026-09-04T00:00:00.000Z') }),
  };
}

function extractSourceIdDigest(prompt: string): { sourceId: string; digest: string } {
  const match = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
  if (!match) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
  return { sourceId: match[1]!, digest: match[2]! };
}

function stopMessages() {
  return { messages: [{ kind: 'publicRationale', rationale: 'Stopping — no further work is possible.' }] };
}

function completionRequestTurn() {
  return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
}

function contradictionAnswer(prompt: string): string {
  const match = /candidateId: (\S+)/.exec(prompt);
  return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
}

/**
 * One low-risk file, read and clean — every clause but the one under test
 * passes. `verifying` asks for completion exactly once, then stops: a
 * completion request the gate cannot grant (a non-repairable blocker, e.g.
 * `headChanged`) must not be retried forever — a real model would not, and a
 * script that did would only burn `maxModelTurnsPerAttempt` and surface an
 * unrelated `ordinaryBudgetExhausted` warning that has nothing to do with
 * the clause under test.
 */
function cleanRunTurn(onInvestigate: (call: number, prompt: string) => unknown): (modelId: string, prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  let verifyingCalls = 0;
  return async (_modelId: string, prompt: string) => {
    if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return contradictionAnswer(prompt);
    const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
    if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] }] });
    if (phase === 'investigating') {
      investigatingCalls += 1;
      return JSON.stringify(onInvestigate(investigatingCalls, prompt));
    }
    if (phase === 'verifying') {
      verifyingCalls += 1;
      return verifyingCalls === 1 ? completionRequestTurn() : JSON.stringify(stopMessages());
    }
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
  };
}

/**
 * The isolation assertion every clause test shares: `outcome.blockerDetails`
 * (task 13.4, `evaluateCompletion`'s own `details`) names, per entry, exactly
 * which `CompletionClause` it failed — a far more precise "only this clause"
 * check than comparing `outcome.limitations` wholesale, which may
 * legitimately also carry an incidental non-clause limitation from whatever
 * mechanism a given test used to defeat its one clause (e.g. `noPlan` when
 * planning itself is made to fail, or a budget-warning code). Every clause
 * this file exercises pushes at least one detail (`harnessCompletion.ts`'s
 * `fail` always does), so `blockerDetails` is never empty here.
 */
function expectOnlyClauseFailed(result: { outcome: { completeness: string; clean: boolean; blockerDetails?: readonly { clause?: string }[] } }, clause: string): void {
  expect(result.outcome.completeness).not.toBe('complete');
  expect(result.outcome.clean).toBe(false);
  expect(result.outcome.blockerDetails?.length ?? 0).toBeGreaterThan(0);
  expect(result.outcome.blockerDetails?.every((detail) => detail.clause === clause)).toBe(true);
}

// ---- 1. headUnchanged -----------------------------------------------------------------

describe('16.7: headUnchanged is load-bearing — a real moved head blocks completion, alone', () => {
  it('a genuine post-snapshot head move is the only reported blocker', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: LOW_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }] }),
      readDiff: async (request) => diffPage(request.path),
      // Head genuinely moved since the snapshot was taken — a real provider fact, not simulated.
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: 'a-different-head-sha' }),
    });
    registerFakeProvider(connection);

    const runTurn = cleanRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: LOW_FILE } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-head', lineageId: 'lineage-mut-head', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expectOnlyClauseFailed(result, 'headUnchanged');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['headChanged']);
  });
});

// ---- 2. inventoryCompleteForEveryMember ------------------------------------------------

describe('16.7: inventoryCompleteForEveryMember is load-bearing — a real truncated manifest blocks completion, alone', () => {
  it('a truncated manifest is the only reported blocker (plus its own providerLimit pairing)', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({
        snapshot: request.snapshot,
        state: 'truncated',
        value: [{ path: LOW_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }],
        knownRemainingUnits: 500,
      }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = cleanRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: LOW_FILE } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-inventory', lineageId: 'lineage-mut-inventory', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expectOnlyClauseFailed(result, 'inventoryCompleteForEveryMember');
    expect(result.outcome.limitations.map((l) => l.code).sort()).toEqual(['incompleteInventory', 'providerLimit']);
  });
});

// ---- 3. everyFileClassified -------------------------------------------------------------

describe('16.7: everyFileClassified is load-bearing — a file that never gets classified blocks completion, alone', () => {
  it('planning that never produces a plan skips investigating entirely, leaving the one known file unvisited', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: LOW_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    // Planning always returns unparseable text — a real, if pathological, model behaviour
    // (`harnessProtocol.ts`'s own fail-closed parser), never a hand-built plan. Once the phase's
    // repair allowance (`protocolRepairsPerPhase`, default 2) is exhausted, `run()`'s own gate
    // (`plan !== undefined`) skips `runInvestigating()` entirely — so `classifyAllUnvisited()`
    // (the one place any file ever leaves 'unvisited') never runs, and the file bootstrap already
    // fully enumerated stays unclassified. `configuredRiskCoverageSatisfied` is untouched: the
    // switch in `evaluateCompletion` only judges risk coverage for a *classified* file.
    let verifyingCalls = 0;
    const runTurn = async (_modelId: string, prompt: string) => {
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      if (phase === 'planning') return 'this is not JSON at all, and never will be';
      if (phase === 'verifying') {
        verifyingCalls += 1;
        return verifyingCalls === 1 ? completionRequestTurn() : JSON.stringify(stopMessages());
      }
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}" (investigating should have been skipped)`);
    };
    const deps: HarnessRuntimeDeps = { ...baseDeps(), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-classified', lineageId: 'lineage-mut-classified', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expectOnlyClauseFailed(result, 'everyFileClassified');
    expect(result.outcome.limitations.map((l) => l.code)).toContain('unclassifiedFiles');
    // configuredRiskCoverageSatisfied genuinely holds too — nothing 'classified' was ever left uninspected.
    expect(result.outcome.limitations.map((l) => l.code)).not.toContain('insufficientRiskCoverage');
  });
});

// ---- 4. configuredRiskCoverageSatisfied --------------------------------------------------

describe('16.7: configuredRiskCoverageSatisfied is load-bearing — a classified-but-uninspected high-risk file blocks completion, alone', () => {
  it('a high-risk file the model never reads is the only reported blocker', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: HIGH_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    // The model never issues a single tool call: `classifyAllUnvisited()` still classifies the
    // file (host floor, unconditional — 'path.auth' -> 'high'), so it is genuinely 'classified',
    // just never inspected. `everyFileClassified` genuinely holds.
    const runTurn = cleanRunTurn(() => stopMessages());
    const deps: HarnessRuntimeDeps = { ...baseDeps(), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-coverage', lineageId: 'lineage-mut-coverage', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expectOnlyClauseFailed(result, 'configuredRiskCoverageSatisfied');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['insufficientRiskCoverage']);
  });
});

// ---- 5. noUnresolvedFetches: reported, not fixed (see file header) ----------------------

describe('16.7: noUnresolvedFetches — genuinely vacuous under the real orchestrator today, by design, not by bug', () => {
  it('a real completed attempt always reports zero unresolved fetches — pinning the documented invariant `harnessAttempt.ts` states', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: LOW_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = cleanRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: LOW_FILE } }] } : stopMessages()));
    let lastUnresolvedFetches: number | undefined;
    const deps: HarnessRuntimeDeps = {
      ...baseDeps(),
      runTurn,
    };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-fetches', lineageId: 'lineage-mut-fetches', attempt: 1 };
    const options = { ...noopRunOptions(identity), onCheckpoint: (info: { unresolved: { unresolvedFetches: number } }) => { lastUnresolvedFetches = info.unresolved.unresolvedFetches; } };
    const result = await factory.create(runInput(), options).run();

    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.clean).toBe(true);
    // Every checkpoint this real attempt ever reported — including the terminal one — carried
    // exactly 0: there is no code path in `harnessAttempt.ts` today that ever reports otherwise.
    expect(lastUnresolvedFetches).toBe(0);
  });
});

// ---- 6. noUnresolvedCandidates -----------------------------------------------------------

describe('16.7: noUnresolvedCandidates is load-bearing — a repairable candidate nobody ever repairs blocks completion, alone', () => {
  it('a citation missing its location is left unresolved, and is the only reported blocker', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: LOW_FILE, kind: 'modified', binary: false, addedLines: 1, removedLines: 1 }] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    // `resolveCitation` (`harnessCitations.ts`) classifies a citation naming a real, citable
    // source but omitting `path` as `pathMissing`, `repairable: true` — a genuine, real
    // validation outcome, not a hand-built `TrackedCandidate`. The model never resubmits it, so
    // the candidate tracker leaves it 'unresolved' (`nextRepairs (0) <= maxRepairs`) forever.
    const runTurn = cleanRunTurn((call, prompt) => {
      if (call === 1) return { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: LOW_FILE } }] };
      if (call === 2) {
        const ref = extractSourceIdDigest(prompt);
        return {
          messages: [
            {
              kind: 'candidateSubmission',
              candidate: {
                candidateId: 'cand-repairable',
                memberId: MEMBER_ID,
                file: LOW_FILE,
                line: 1,
                endLine: 1,
                severity: 'major',
                category: 'errorHandling',
                confidence: 80,
                title: 'A candidate whose citation is missing its location',
                body: 'Deliberately incomplete for this mutation test.',
                // No `path`/`range`: a real, citable sourceId+digest with the location omitted.
                citations: { primary: { sourceId: ref.sourceId, digest: ref.digest } },
              },
            },
          ],
        };
      }
      return stopMessages();
    });
    const deps: HarnessRuntimeDeps = { ...baseDeps(), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-mut-unresolved-candidate', lineageId: 'lineage-mut-unresolved-candidate', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expectOnlyClauseFailed(result, 'noUnresolvedCandidates');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['unresolvedCandidates']);
    // The unresolved candidate never became a finding: it correctly never counts as coverage.
    expect(result.findings).toHaveLength(0);
  });
});

// ---- Fixture idiom 2: createHarnessAttempt + scripted HarnessModelSeam, copied from
// harnessAttempt.test.ts — needed for the clauses that live behind the injected
// SynthesisVerificationRunner collaborator seam (task 10.6), which
// createReviewHarnessFactory's production wiring does not let a caller override. -------

const SNAPSHOT_REF = { repoId: 'repo-mut2', baseSha: 'base-mut2-1', headSha: 'head-mut2-1' };
const MEMBER2_ID = 'm1';

function changeRequestDetailResult2(): ChangeRequestDetailResult {
  return { snapshot: SNAPSHOT_REF, state: 'complete', value: { title: 'Mutation test change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } };
}

function manifestResult2(files: readonly string[]): { snapshot: typeof SNAPSHOT_REF; state: 'complete'; value: ChangedFileEntry[] } {
  return { snapshot: SNAPSHOT_REF, state: 'complete', value: files.map((path) => ({ path, kind: 'modified', binary: false, addedLines: 5, removedLines: 1, byteSize: 100 })) };
}

function diffPageResult2(path: string): DiffPageResult {
  return { snapshot: SNAPSHOT_REF, state: 'complete', value: { path, patch: '@@ -1,1 +1,1 @@\n-old\n+new\n', positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

function reviewConnection2(files: readonly string[]): Connection {
  return fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult2(),
    listChangedFiles: async () => manifestResult2(files),
    readDiff: async (request) => diffPageResult2(request.path),
    getCurrentHead: async () => ({ repoId: SNAPSHOT_REF.repoId, state: 'resolved', headSha: SNAPSHOT_REF.headSha }),
  });
}

const PAGE_BOUND = { supported: true, pageBound: { maxPageSize: 100 } };

function fullCapabilities2(): ProviderCapabilities {
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
      pagination: { maxPageSize: 100 },
    },
  };
}

function testSnapshot2(): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: 'run-mut2-1',
    lineageId: 'lineage-mut2-1',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: MEMBER2_ID,
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
  };
}

function member2(connection: Connection): HarnessAttemptMemberInput {
  return { memberId: MEMBER2_ID, connection, capabilities: fullCapabilities2() };
}

type ScriptEntry2 = string | ((toolResults: readonly { sourceId?: string; digest?: string; state: string }[]) => string);

function scriptedModelSeam2(script: Partial<Record<'planning' | 'investigating' | 'verifying', readonly ScriptEntry2[]>>): HarnessModelSeam {
  const counters: Partial<Record<string, number>> = {};
  return {
    modelId: 'test-model',
    async askModel({ phase, repairInstruction, toolResults }) {
      // The real synthesis/verification collaborator (`createSynthesisVerification`) issues its own
      // contradiction-check calls with `phase: 'verifying'` too, via the *same* seam (task 10.4: one
      // model, many phases) — distinguished only by `repairInstruction` carrying the marker, never a
      // phase of its own. These must not consume the ordinary `verifying` script's turn counter.
      if (repairInstruction?.startsWith(CONTRADICTION_CHECK_MARKER)) return contradictionAnswer(repairInstruction);
      if (phase === 'verifying' || phase === 'investigating' || phase === 'planning') {
        const list = script[phase];
        if (!list || list.length === 0) throw new Error(`scriptedModelSeam2: phase "${phase}" was never scripted.`);
        const index = counters[phase] ?? 0;
        counters[phase] = index + 1;
        const entry = list[Math.min(index, list.length - 1)] as ScriptEntry2;
        return typeof entry === 'function' ? entry(toolResults as never) : entry;
      }
      throw new Error(`scriptedModelSeam2: unexpected phase "${phase}"`);
    },
  };
}

function messages2(...entries: readonly unknown[]): string {
  return JSON.stringify({ messages: entries });
}

const PLAN_TURN2 = messages2({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] });

function readDiffMessage2(path: string): unknown {
  return { kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER2_ID, request: { snapshot: SNAPSHOT_REF, path } };
}

function stopMessage2(): unknown {
  return { kind: 'publicRationale', rationale: 'No further work is needed right now.' };
}

const STOP_TURN2 = messages2(stopMessage2());
const COMPLETION_TURN2 = messages2({ kind: 'completionRequest', rationale: 'Coverage looks complete.' });

function sourceRefFrom2(result: { sourceId?: string; digest?: string; state: string }): { sourceId: string; digest: string } {
  if (result.sourceId === undefined || result.digest === undefined) throw new Error('Tool result carries no sourceId/digest.');
  return { sourceId: result.sourceId, digest: result.digest };
}

function candidateSubmissionMessage2(candidateId: string, path: string, ref: { sourceId: string; digest: string }): unknown {
  return {
    kind: 'candidateSubmission',
    candidate: {
      candidateId,
      memberId: MEMBER2_ID,
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

function attemptClock(): () => number {
  let value = 0;
  return () => {
    value += 1;
    return value;
  };
}

function attemptOptions2(overrides: Partial<HarnessAttemptOptions> = {}): Omit<HarnessAttemptOptions, 'snapshot' | 'members' | 'modelSeam'> {
  return { clock: attemptClock(), now: () => new Date(2026, 0, 1).toISOString(), ...overrides };
}

// ---- 7. everyRetainedCitationValid --------------------------------------------------------

describe('16.7: everyRetainedCitationValid is load-bearing — a citation the host re-resolution rejects blocks completion, alone', () => {
  it('a finding whose primary digest no longer matches the ledger is invalidated by the real host revalidation path, and excluded from the result', async () => {
    const connection = reviewConnection2([LOW_FILE]);
    // The collaborator seam (task 10.6) is the one place a caller can control what synthesis
    // returns; the *host*'s own re-resolution (`runSynthesisVerification` -> `revalidateFindings`,
    // `harnessAttempt.ts`) is what is under test here — not a second, hand-built implementation of
    // citation checking. Tampering the digest on the collaborator's *output* is the real, minimal
    // way to make a finding that was genuinely accepted (real citation, real evidence) fail real
    // re-resolution, exactly as a stale/rotated source would.
    const tamperCitation: SynthesisVerificationRunner = async (input) =>
      Object.freeze({
        findings: input.findings.map((finding) => ({ ...finding, evidence: { ...finding.evidence, primary: { ...finding.evidence.primary, digest: 'f'.repeat(64) } } })),
        contradictionPassComplete: true,
        deduplicationComplete: true,
        finalVerificationComplete: true,
      });

    const seam = scriptedModelSeam2({
      planning: [PLAN_TURN2],
      investigating: [
        messages2(readDiffMessage2(LOW_FILE)),
        (toolResults) => messages2(candidateSubmissionMessage2('cand-1', LOW_FILE, sourceRefFrom2(toolResults[0]!))),
        STOP_TURN2,
      ],
      verifying: [COMPLETION_TURN2, STOP_TURN2],
    });
    const attempt = createHarnessAttempt({
      ...attemptOptions2({ synthesisVerification: tamperCitation }),
      snapshot: testSnapshot2(),
      members: [member2(connection)],
      modelSeam: seam,
    });

    const result = await attempt.run();

    expectOnlyClauseFailed(result, 'everyRetainedCitationValid');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['invalidCitations']);
    // The invalidated finding never counts as coverage: dropped, not silently kept.
    expect(result.findings).toHaveLength(0);
  });
});

// ---- 8.-10. the three verification-pass clauses, isolated independently via the seam -----

describe('16.7: contradictionPassComplete, deduplicationComplete, and finalVerificationComplete are each independently load-bearing', () => {
  it('contradictionPassComplete alone blocks completion when the collaborator reports it incomplete', async () => {
    const connection = reviewConnection2([LOW_FILE]);
    const collaborator: SynthesisVerificationRunner = async (input) =>
      Object.freeze({ findings: input.findings, contradictionPassComplete: false, deduplicationComplete: true, finalVerificationComplete: true });
    // The file is genuinely read (inspected) during investigating, so `everyFileClassified` and
    // `configuredRiskCoverageSatisfied` both genuinely hold — DEFAULT_RISK_COVERAGE_RULES requires
    // inspection at every risk level, including 'low'.
    const seam = scriptedModelSeam2({ planning: [PLAN_TURN2], investigating: [messages2(readDiffMessage2(LOW_FILE)), STOP_TURN2], verifying: [COMPLETION_TURN2, STOP_TURN2] });
    const attempt = createHarnessAttempt({ ...attemptOptions2({ synthesisVerification: collaborator }), snapshot: testSnapshot2(), members: [member2(connection)], modelSeam: seam });

    const result = await attempt.run();

    expectOnlyClauseFailed(result, 'contradictionPassComplete');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['contradictionPending']);
  });

  it('deduplicationComplete alone blocks completion when the collaborator reports it incomplete', async () => {
    const connection = reviewConnection2([LOW_FILE]);
    const collaborator: SynthesisVerificationRunner = async (input) =>
      Object.freeze({ findings: input.findings, contradictionPassComplete: true, deduplicationComplete: false, finalVerificationComplete: true });
    // The file is genuinely read (inspected) during investigating, so `everyFileClassified` and
    // `configuredRiskCoverageSatisfied` both genuinely hold — DEFAULT_RISK_COVERAGE_RULES requires
    // inspection at every risk level, including 'low'.
    const seam = scriptedModelSeam2({ planning: [PLAN_TURN2], investigating: [messages2(readDiffMessage2(LOW_FILE)), STOP_TURN2], verifying: [COMPLETION_TURN2, STOP_TURN2] });
    const attempt = createHarnessAttempt({ ...attemptOptions2({ synthesisVerification: collaborator }), snapshot: testSnapshot2(), members: [member2(connection)], modelSeam: seam });

    const result = await attempt.run();

    expectOnlyClauseFailed(result, 'deduplicationComplete');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['deduplicationPending']);
  });

  it('finalVerificationComplete alone blocks completion when the collaborator reports it incomplete', async () => {
    const connection = reviewConnection2([LOW_FILE]);
    const collaborator: SynthesisVerificationRunner = async (input) =>
      Object.freeze({ findings: input.findings, contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: false });
    // The file is genuinely read (inspected) during investigating, so `everyFileClassified` and
    // `configuredRiskCoverageSatisfied` both genuinely hold — DEFAULT_RISK_COVERAGE_RULES requires
    // inspection at every risk level, including 'low'.
    const seam = scriptedModelSeam2({ planning: [PLAN_TURN2], investigating: [messages2(readDiffMessage2(LOW_FILE)), STOP_TURN2], verifying: [COMPLETION_TURN2, STOP_TURN2] });
    const attempt = createHarnessAttempt({ ...attemptOptions2({ synthesisVerification: collaborator }), snapshot: testSnapshot2(), members: [member2(connection)], modelSeam: seam });

    const result = await attempt.run();

    expectOnlyClauseFailed(result, 'finalVerificationComplete');
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(['verificationPending']);
  });

  // NB: the *real* collaborator this attempt uses in production (`createSynthesisVerification()`,
  // `harnessSynthesisVerification.ts`) does not exercise these three clauses independently of one
  // another the way the mutation tests above deliberately do — reported, not fixed, alongside the
  // two vacuous clauses in this file's own header: `finalVerificationComplete` is always exactly
  // `contradictionPassComplete` in that implementation (both come from the same
  // `ContradictionCheckResult.complete`), and `deduplicationComplete` is `false` only when
  // `verifying` is cancelled before synthesis starts — the same moment the other two also go
  // false. So today only two independent states are reachable in production: "all three true" and
  // "all three false via cancellation". `evaluateCompletion` still gates on all three
  // independently (this file's tests above prove the *wiring* honours whatever the collaborator
  // reports); the collaborator simply never reports a state that would separate them. Not a defect
  // this task's scope covers fixing — a future collaborator implementation with genuinely
  // independent staged failure (partial dedup progress, say) would be caught correctly by the gate
  // as it stands.
});

// ---- Headline finding: a late-verifying candidate submission the model never asks completion
// for is silently dropped, and the gate can report completeClean over it (see file header) -----

describe('16.7 headline finding: a candidate accepted after verifying already ran once, with no follow-up completionRequest, must not be silently dropped from the result', () => {
  it('the real synthesis/verification collaborator reconciles the late candidate before the gate is evaluated, and the finding survives', async () => {
    const connection = reviewConnection2([LOW_FILE]);
    let firstReadRef: { sourceId: string; digest: string } | undefined;

    const seam = scriptedModelSeam2({
      planning: [PLAN_TURN2],
      // investigating: read the file, then stop — zero candidates submitted here, so the first
      // synthesis/verification pass (at the top of `runVerifying`) runs over an empty finding set
      // and trivially reports every pass complete.
      investigating: [
        messages2(readDiffMessage2(LOW_FILE)),
        (toolResults) => {
          firstReadRef = sourceRefFrom2(toolResults[0]!);
          return STOP_TURN2;
        },
      ],
      // verifying: the FIRST turn submits a real, validly cited candidate — after synthesis already
      // ran once (`verificationRan === true`), which is exactly what sets `passesStale = true`
      // (`harnessAttempt.ts`). The SECOND turn stops outright — a `publicRationale`, never a
      // `completionRequest` — the crux of the bug: nothing but a `completionRequest` used to
      // recheck `passesStale` before `runCompleting()` reads `latestPasses`/`survivingFindings`.
      verifying: [() => messages2(candidateSubmissionMessage2('cand-late', LOW_FILE, firstReadRef!)), STOP_TURN2],
    });
    const attempt = createHarnessAttempt({
      ...attemptOptions2({ synthesisVerification: createSynthesisVerification() }),
      snapshot: testSnapshot2(),
      members: [member2(connection)],
      modelSeam: seam,
    });

    const result = await attempt.run();

    // The late candidate was genuinely accepted (real citation, real evidence) — never silently
    // dropped, and the truthful outcome is complete WITH the finding, never a fabricated clean.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.candidateId).toBe('cand-late');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.kind).toBe('completeFindings');
    expect(result.outcome.clean).toBe(false);
  });
});
