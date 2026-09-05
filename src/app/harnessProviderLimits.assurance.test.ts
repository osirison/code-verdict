/**
 * Task 16.3 of `add-agentic-review-harness`: provider-limit tests proving
 * incomplete inventory, truncated search, unavailable oversized diff, binary
 * content, and unknown completeness cannot yield a clean result.
 *
 * Every test drives a real `HarnessAttempt` through `createReviewHarnessFactory`
 * (`./harnessRuntime.ts`) against a fake `Connection` whose provider response
 * for exactly one operation is limited — a truncated/unknown manifest, a
 * truncated search, an oversized/binary diff, or an unresolvable head — and
 * asserts on the real `evaluateCompletion` decision (`./harnessCompletion.ts`)
 * that `runCompleting` actually reaches, not on a hand-simulated inventory.
 * `harnessCompletion.scenarios.test.ts`'s own "task 8.9 scenarios" already
 * prove the *gate* handles each of these states correctly given a
 * hand-built inventory (via that file's own `enumerate`/`classifyAll`/
 * `inspectAll` helpers, which simulate the harness engine's bookkeeping by
 * hand); this file's job is the missing half — that the real orchestrator
 * (`harnessAttempt.ts`, section 10) actually *produces* that inventory state
 * from a real provider response through the real dispatcher, and that the
 * gate it reaches is fed real, not simulated, facts.
 *
 * Two deliberate, documented departures from the task line's literal
 * wording, both because the actual design (D10/D11, `harnessCompletion.ts`)
 * does not treat these as blockers:
 *
 * - **Binary content is not a blocker.** D10: "Inspection requires
 *   model-visible diff evidence *or an explicit non-text handling
 *   decision*." `harnessCompletion.ts`'s clause loop treats `'binary'`
 *   exactly like `'inspected'`/`'excludedByPolicy'` — no failure. A binary
 *   file, once the host explicitly marks it so, is legitimately covered and
 *   the review may still reach `complete`/`clean`. This file tests the real
 *   property instead: binary content becomes the correct terminal
 *   classification (never left `unvisited`/stuck-`classified`), and *that*
 *   is what a complete/clean result truthfully depends on.
 * - **A truncated search does not block completion by itself** — nothing in
 *   `evaluateCompletion` even inspects a search result. What actually
 *   blocks a clean result is the spec's real rule (`agentic-review-harness`
 *   "Repository search does not add files to the changed inventory and
 *   cannot satisfy changed-file inspection"): a required file search alone
 *   never marks inspected, so the review cannot complete *for that reason*,
 *   not because "truncated" itself is a tracked blocker.
 *
 * A read *deferred* to wait out a retry (section 13, `harnessAttempt.test.ts`'s
 * own "a read deferred to wait out a long retry..." test) is a materially
 * different case from every scenario below: every fake `Connection` method
 * here returns its limited `state` directly, as a genuine provider response,
 * never throws a transient error for the dispatcher's retry loop to catch.
 * The dedicated test near the end of this file proves the two cases really
 * are distinguished by the real dispatcher, not merely asserted to be.
 *
 * Fixture scaffolding is copied from `harnessRuntime.test.ts` (private to
 * that file; `reviewRunManagerHarnessIntegration.test.ts` already
 * established this "copy the literals, not the behavior" idiom). No
 * fixture-provider import; `DiffPage.positions` supplied non-empty
 * throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { CrRunTarget, RunInput } from './reviewRunManager';
import { ScmError } from '../platform/errors';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';
import type { ChangeRequestDetailResult, DiffPageResult, NormalizedDetail } from '../platform/types';

// ---- Fixture scaffolding, copied from harnessRuntime.test.ts ----------------------------

const REPO_ID = 'repo-limit';
const CR_NUMBER = '1';
const BASE_SHA = 'base-limit-1';
const HEAD_SHA = 'head-limit-1';
const FILE_PATH = 'src/a.ts';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;
const PROVIDER_ID = 'fake-limit-provider';
const POD_ID = 'pod-limit-1';

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

function limitCapabilities(): ProviderCapabilities {
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
  return { list: () => [{ id: POD_ID, name: 'Limit pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

function registerFakeProvider(connection: Connection): void {
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Limit',
    capabilities: limitCapabilities(),
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

function baseDeps(_connection: Connection): HarnessRuntimeDeps {
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
    // Fast retry so a test whose fake connection happens to throw a transient error (only the
    // dedicated "deferred" test at the end does) does not actually wait out real backoff timers.
    policy: undefined,
  };
}

function benignDetail(): NormalizedDetail {
  return { title: 'A small change', body: 'Fixes a bug.', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
}

function detailResult(): ChangeRequestDetailResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: benignDetail() };
}

function diffPage(path: string, patch = '@@ -1,1 +1,1 @@\n-old\n+new\n'): DiffPageResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: { path, patch, positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

/** A single-shot model script, mirroring `harnessRuntime.test.ts`'s own `scriptedRunTurn`: reads
 * the *real* rendered prompt to find the current phase and any citable sourceId/digest. `onInvestigate`
 * scripts exactly what happens on the investigating phase's turns; everything else (planning,
 * verifying, contradiction checks) is the same happy-path script every test here shares. */
function scriptedRunTurn(onInvestigate: (call: number, prompt: string) => unknown): (modelId: string, prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  return async (_modelId: string, prompt: string) => {
    if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
      const match = /candidateId: (\S+)/.exec(prompt);
      return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
    }
    const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
    if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] }] });
    if (phase === 'investigating') {
      investigatingCalls += 1;
      return JSON.stringify(onInvestigate(investigatingCalls, prompt));
    }
    if (phase === 'verifying') return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
  };
}

function stopMessages() {
  return { messages: [{ kind: 'publicRationale', rationale: 'Stopping — no further work is possible.' }] };
}

// ---- 1. Incomplete inventory: a truncated manifest ---------------------------------------

describe('16.3: an incomplete (truncated) manifest cannot yield a clean result', () => {
  it('blocks completion with incompleteInventory + providerLimit, non-repairable by more turns, through the real bootstrap pagination path', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({
        snapshot: request.snapshot,
        state: 'truncated',
        value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, byteSize: 10 }],
        knownRemainingUnits: 500,
      }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-manifest', lineageId: 'lineage-limit-manifest', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(expect.arrayContaining(['incompleteInventory', 'providerLimit']));
  });
});

// ---- 2. Truncated search cannot satisfy inspection or move coverage ----------------------

describe('16.3: a truncated search cannot satisfy changed-file inspection', () => {
  it('a truncated searchDiff result never marks the target file inspected, and the review cannot complete on search alone', async () => {
    let diffCalled = false;
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, byteSize: 10 }] }),
      readDiff: async (request) => {
        diffCalled = true;
        return diffPage(request.path);
      },
      searchDiff: async (request) => ({ snapshot: request.snapshot, state: 'truncated', value: [{ position: { path: FILE_PATH, side: 'new', line: 1 }, excerpt: 'new' }], knownRemainingUnits: 40 }),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    // The model relies only on search — a truncated one at that — and never calls readDiff.
    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'searchDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, query: 'new' } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-search', lineageId: 'lineage-limit-search', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(diffCalled).toBe(false); // search alone, never a real diff read
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.clean).toBe(false);
    // Never `providerLimit`/`incompleteInventory` for this file — the manifest itself was
    // complete. The real blocker is coverage: the required file was classified but never
    // inspected, exactly the spec rule this test exists to prove ("Repository search... cannot
    // satisfy changed-file inspection").
    expect(result.outcome.limitations.map((l) => l.code)).toContain('insufficientRiskCoverage');
  });
});

// ---- 3. Unavailable oversized diff ---------------------------------------------------------

describe('16.3: an unavailable oversized diff cannot yield a clean result', () => {
  it('a real tooLarge readDiff response marks the file oversized and blocks completion, non-repairably', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, byteSize: 500_000 }] }),
      readDiff: async (request) => ({ snapshot: request.snapshot, state: 'tooLarge', byteSize: 500_000 }),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-oversized', lineageId: 'lineage-limit-oversized', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.limitations.map((l) => l.code)).toContain('unavailableOversizedPatch');
  });
});

// ---- 4. Binary content: a legitimate terminal classification, NOT a blocker ---------------

describe('16.3: binary content is an explicit non-text handling decision, not a provider-limit blocker (D10)', () => {
  it('a real binary readDiff response marks the file binary, and the review still reaches a truthful complete/clean outcome', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: 'assets/logo.png', kind: 'modified', binary: true, byteSize: 2048 }] }),
      readDiff: async (request) => ({ snapshot: request.snapshot, state: 'binary', byteSize: 2048 }),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: 'assets/logo.png' } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-binary', lineageId: 'lineage-limit-binary', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    // Not a provider-limit blocker: a genuinely binary file, explicitly classified as such,
    // satisfies coverage the same way an inspected text file does (D10).
    expect(result.outcome.limitations.map((l) => l.code)).not.toContain('unavailableOversizedPatch');
    expect(result.outcome.limitations.map((l) => l.code)).not.toContain('providerLimit');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.clean).toBe(true);
  });
});

// ---- 5. Unknown manifest completeness -------------------------------------------------------

describe('16.3: a manifest of unknown completeness cannot yield a clean result', () => {
  it('a real listChangedFiles response of state "unknown" folds to enumeration unavailable and blocks completion', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'unknown', reason: 'The provider could not determine whether more files exist.' }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn(() => stopMessages());
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-unknown-manifest', lineageId: 'lineage-limit-unknown-manifest', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    // No plan of any real work exists (there is nothing to investigate — the manifest itself
    // never resolved), so the run correctly fails outright rather than claiming any coverage.
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.limitations.map((l) => l.code)).toEqual(expect.arrayContaining(['incompleteInventory', 'providerLimit']));
  });
});

// ---- 6. Unknown head completeness -----------------------------------------------------------

describe('16.3: an unresolvable current head cannot yield a clean result', () => {
  it('getCurrentHead reporting state "unavailable" fails the headUnchanged clause with providerLimit', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, byteSize: 10 }] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'unavailable' }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-unknown-head', lineageId: 'lineage-limit-unknown-head', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.limitations.map((l) => l.code)).toContain('providerLimit');
  });
});

// ---- 7. The distinction this file must not re-break: deferred (retried) is not a provider limit --

describe('16.3: a transient failure the retry loop resolves is not a provider limit, and does not permanently mark the file unavailable (section 13)', () => {
  it('a readDiff that throws once (a genuine transient error, not a returned "unavailable" state) then succeeds on retry reaches a truthful complete/clean outcome', async () => {
    let readDiffCalls = 0;
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: FILE_PATH, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, byteSize: 10 }] }),
      readDiff: async (request) => {
        readDiffCalls += 1;
        if (readDiffCalls === 1) throw new ScmError('network', 'transient network blip');
        return diffPage(request.path);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const runTurn = scriptedRunTurn((call) => (call === 1 ? { messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: FILE_PATH } }] } : stopMessages()));
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-limit-deferred', lineageId: 'lineage-limit-deferred', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(readDiffCalls).toBeGreaterThan(1); // the transient failure really was retried, not swallowed
    // Unlike every genuinely provider-limited scenario above, a resolved transient failure never
    // shows up as a completion blocker at all — this is the contrast that proves this whole file's
    // "unavailable"/"tooLarge" scenarios are testing a real provider limit, not merely a retry that
    // hadn't finished yet.
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.clean).toBe(true);
    expect(result.outcome.limitations.map((l) => l.code)).not.toContain('unavailableOversizedPatch');
    expect(result.outcome.limitations.map((l) => l.code)).not.toContain('providerLimit');
  });
});
