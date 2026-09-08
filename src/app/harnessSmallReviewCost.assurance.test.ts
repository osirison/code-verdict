/**
 * Measures where a *small* review's time and bytes actually go, before changing anything, and then
 * proves the fix — the discipline the task brief demands: "the last three bugs in this area were
 * each fixed two or three times because the cause was assumed rather than observed."
 *
 * A real user hit two problems reviewing a small, ordinary pull request: it took 20 minutes, and it
 * fetched files outside the merge request. Three causes were suspected:
 *
 * - **Cause A** — `harnessAgentsPolicy.ts`'s nested `AGENTS.md` walk, speculatively reading every
 *   ancestor directory of every changed path.
 * - **Cause B** — `readFile`/`searchRepository` letting the model wander into unchanged repository
 *   content.
 * - **Cause C** — `renderModelPrompt` (`harnessModelSeam.ts`) rebuilding the whole bootstrap
 *   envelope, tool catalog, and protocol contract on every single model turn.
 *
 * This file drives a real `HarnessAttempt` (`createHarnessAttempt`, via `createReviewHarnessFactory`
 * so the real dispatcher and the real `renderModelPrompt` are both exercised, exactly as a live run
 * would) against a *counting* fake `Connection` that logs every provider call — method, path, and
 * whether that path is outside the changed-file list — and a *counting* `runTurn` that logs every
 * model call's phase, byte size, raw prompt, and whether it is the compact contradiction-check call
 * (`CONTRADICTION_CHECK_MARKER`) rather than a full envelope turn.
 *
 * The fixture is a small, ordinary review: 3 changed TypeScript files in 3 different directories,
 * ~120 diff lines each (~360 total) — "a few hundred diff lines", per the brief. `DEFAULT_HARNESS_POLICY`
 * is used unshrunk throughout: this measures the real defaults a live run actually uses, not a
 * policy tuned to make the numbers convenient.
 *
 * **What the measurement found** (each `describe` block below carries the exact numbers):
 *
 * - Cause A is refuted as an *automatic* cost. Bootstrap resolves only the repository root
 *   (`ancestorDirectories('')` is `['']`) once per member — never a walk of every changed file's
 *   ancestors. `resolvePolicy` is entirely model-optional, and `createAgentsPolicyResolver`'s cache
 *   (already unit-tested in `harnessAgentsPolicy.test.ts` to span two changed paths) keeps even a
 *   model that calls it once per file to a handful of reads — measured directly below through the
 *   real dispatcher, not the resolver in isolation.
 * - Cause B is real but latent, not automatic: a reasonable reviewer that only reads diffs never
 *   triggers it (the baseline scenario below measures exactly one off-merge-request call — the
 *   root policy probe). It is confirmed by a deliberately curious script that tries `readFile` and
 *   unscoped `searchRepository`: before the fix these calls succeed and reach the real provider;
 *   after, `HarnessPolicy.scopeInvestigationToChangedFiles` makes them `capabilityUnavailable`
 *   before the provider is ever called, and the model is told plainly they are not available. That
 *   setting defaults to `false` now — a review reads from a local object store, so an unchanged-file
 *   read costs a local file read and nothing else — so the scenario below turns it on explicitly
 *   rather than inheriting it.
 * - Cause C is confirmed as the dominant *byte* cost: every one of the ~7 model turns a small
 *   review needs carries the whole envelope again. The fix does not — cannot — stop resending it:
 *   see "why the envelope keeps being resent" below. What scoping investigation *does* shrink is
 *   the envelope's own size (a smaller tool catalog, a shorter protocol contract) — measured
 *   directly below.
 *
 * **Why the envelope keeps being resent.** `lmAgent.ts`'s `runHarnessModelTurn` calls
 * `model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)], ...)` — one stateless user
 * message per call, no conversation history, no server-side session. There is no "send once, refer
 * back later" option: a later turn with no envelope would carry none of the authoritative
 * persona/criteria/tool-contract text or the untrusted-content framing that stops repository text
 * from being read as instructions (`harnessModelSeam.ts`'s own header). Trimming that would trade
 * the trust boundary for speed, which the task's own constraints forbid. This file does not attempt
 * it; it measures the byte cost honestly instead.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { fakeInvestigationSource } from '../testing/investigationDouble';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import type { CheckpointInfo } from './harnessAttempt';
import { buildAttemptDiagnosticsReport, renderAttemptDiagnosticsText, type DiagnosticsSourceRecord } from './harnessDiagnostics';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { CrRunTarget, RunInput } from './reviewRunManager';
import type { Connection, ScmProvider, MemberCapabilities } from '../platform/provider';
import type { InvestigationOperations, InvestigationSource } from '../platform/types';
import type {
  ChangedFileEntry,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  DiffPageRequest,
  DiffPageResult,
  NormalizedDetail,
} from '../platform/types';

// ---- Fixture: a small, ordinary review — 3 changed files, 3 different directories --------------

const REPO_ID = 'repo-small-review';
const CR_NUMBER = '1';
const BASE_SHA = 'base-small-1';
const HEAD_SHA = 'head-small-1';
const PROVIDER_ID = 'fake-small-review-provider';
const POD_ID = 'pod-small-review-1';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;
const SNAPSHOT = { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA };

const FILE_A = 'src/services/paymentService.ts';
const FILE_B = 'src/utils/formatDate.ts';
const FILE_C = 'src/api/routes/userRoutes.ts';
const CHANGED_FILES = [FILE_A, FILE_B, FILE_C];
/** Not in `CHANGED_FILES` — only the "wandering" scripts below ever ask for this. */
const UNRELATED_FILE = 'src/legacy/oldReportGenerator.ts';

const DIFF_LINES_PER_FILE = 60; // -> 60 removed + 60 added + 1 hunk header = 121 lines/file, ~363 total ("a few hundred diff lines")

function diffPatch(path: string): string {
  const removed = Array.from({ length: DIFF_LINES_PER_FILE }, (_, i) => `-old line ${i + 1} of ${path}`);
  const added = Array.from({ length: DIFF_LINES_PER_FILE }, (_, i) => `+new line ${i + 1} of ${path}`);
  return [`@@ -1,${DIFF_LINES_PER_FILE} +1,${DIFF_LINES_PER_FILE} @@`, ...removed, ...added].join('\n');
}

function manifestEntry(path: string): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: DIFF_LINES_PER_FILE, removedLines: DIFF_LINES_PER_FILE, byteSize: DIFF_LINES_PER_FILE * 32 };
}

function diffPageResult(path: string): DiffPageResult {
  return {
    snapshot: SNAPSHOT,
    state: 'complete',
    value: { path, patch: diffPatch(path), positions: [{ path, side: 'new', line: 1, endLine: DIFF_LINES_PER_FILE }] },
  };
}

function smallDetail(): NormalizedDetail {
  return {
    title: 'Fix payment retry, date formatting, and add a user route',
    body: 'A small, focused change touching three files in three different directories.',
    labels: [],
    commits: [{ sha: 'c1', message: 'Fix retry/date/route', author: 'a' }],
    discussion: [],
    checkSummaries: [],
    relationships: [],
    unavailableSections: [],
  };
}

// ---- Fake Connection / provider scaffolding, mirroring harnessLargeReview.assurance.test.ts ----

function notImplemented(): never {
  throw new Error('not implemented in this fake connection');
}

function baseFakeConnection(methods: Partial<Connection & InvestigationOperations>): Connection & Partial<InvestigationOperations> {
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

/**
 * Every declared page bound must not exceed `DEFAULT_HARNESS_POLICY`'s own paging limits — this
 * fixture uses the real, unshrunk policy throughout, so a bound above it (`harnessToolDispatcher.ts`'s
 * `pageBoundWithinPolicy`) would refuse every call with `outOfBounds` before scoping ever enters
 * the picture. `manifestPageSize` (100), `diffOrFileReadPageLines` (400), and
 * `searchResultPageMatches` (50) are the three ceilings that matter for this fixture.
 */
function fullCapabilities(): MemberCapabilities {
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
    detailRetrieval: { changeRequestDetails: supported, issueDetails: supported, pagination: { maxPageSize: 50 } },
    reviewInvestigation: {
      manifests: { supported: true, pageBound: { maxPageSize: 100 } },
      diffReads: { supported: true, pageBound: { maxPageSize: 400 } },
      fileReads: { supported: true, pageBound: { maxPageSize: 400 } },
      repositorySearch: { supported: true, pageBound: { maxPageSize: 50 } },
      diffSearch: { supported: true, pageBound: { maxPageSize: 50 } },
      changeRequestDetails: supported,
      issueDetails: supported,
      pagination: { maxPageSize: 50 },
    },
  };
}

function fakePodStore() {
  return { list: () => [{ id: POD_ID, name: 'Small review pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
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
    displayName: 'Fake Small Review',
    capabilities: fullCapabilities(),
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

function runInput(): RunInput {
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
    timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    demo: false,
  };
}

let identitySeq = 0;
function freshIdentity(): { runId: string; lineageId: string; attempt: number } {
  identitySeq += 1;
  return { runId: `run-small-${identitySeq}`, lineageId: `lineage-small-${identitySeq}`, attempt: 1 };
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

function baseDeps(runTurn: HarnessRuntimeDeps['runTurn'], policy: HarnessPolicy): HarnessRuntimeDeps {
  return {
    investigationSource: () => suppliedSource(),
    podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
    secrets: fakeSecrets,
    discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
    countTokens: async () => undefined,
    runTurn,
    revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
    harnessRunStore: createHarnessRunStore(jsonMemoryStore(), { now: () => Date.parse('2026-09-03T00:00:00.000Z') }),
    policy,
  };
}

// ---- The counting fake Connection: logs every provider call, by method, path, and MR membership ---

interface ProviderCallRecord {
  readonly method: string;
  readonly path: string | undefined;
  /** `'n/a'` for a call with no path concept at all (listChangedFiles, getChangeRequestDetails, getCurrentHead, ...). */
  readonly classification: 'in-mr' | 'off-mr' | 'n/a';
}

function classifyCall(method: string, request: unknown, changedFiles: ReadonlySet<string>): ProviderCallRecord {
  const req = request as Record<string, unknown> | undefined;
  switch (method) {
    case 'readFile':
    case 'readDiff': {
      const path = typeof req?.path === 'string' ? req.path : undefined;
      return { method, path, classification: path !== undefined && changedFiles.has(path) ? 'in-mr' : 'off-mr' };
    }
    case 'searchRepository': {
      // No `pathScope` is a whole-repository search — off the merge request by definition.
      const pathScope = typeof req?.pathScope === 'string' ? req.pathScope : undefined;
      return { method, path: pathScope, classification: pathScope !== undefined && changedFiles.has(pathScope) ? 'in-mr' : 'off-mr' };
    }
    case 'searchDiff': {
      // Bounded to the change's own diff content by construction (D6) — unscoped is still in-MR.
      const pathScope = typeof req?.pathScope === 'string' ? req.pathScope : undefined;
      return { method, path: pathScope, classification: pathScope === undefined || changedFiles.has(pathScope) ? 'in-mr' : 'off-mr' };
    }
    default:
      return { method, path: undefined, classification: 'n/a' };
  }
}

/** Wraps every function-valued property of `base` so every call — including the bootstrap-time
 * root `AGENTS.md` read `harnessRuntime.ts` makes before the attempt itself starts — is logged. */
function countingConnection(base: Connection, changedFiles: ReadonlySet<string>, log: ProviderCallRecord[]): Connection {
  const wrapped: Record<string, unknown> = {};
  for (const key of Object.keys(base)) {
    const original = (base as unknown as Record<string, unknown>)[key];
    if (typeof original !== 'function') continue;
    wrapped[key] = async (...args: unknown[]) => {
      log.push(classifyCall(key, args[0], changedFiles));
      return (original as (...a: unknown[]) => unknown).apply(base, args);
    };
  }
  return wrapped as unknown as Connection;
}

// ---- The counting runTurn: logs every model call's phase, byte size, prompt, and kind -----------

interface ModelTurnRecord {
  readonly index: number;
  readonly phase: string | undefined;
  readonly isContradictionCheck: boolean;
  readonly bytes: number;
  readonly prompt: string;
}

function phaseOf(prompt: string): string | undefined {
  return /You are in the "(\w+)" phase/.exec(prompt)?.[1];
}

function countingRunTurn(script: (prompt: string) => Promise<string>, log: ModelTurnRecord[]): HarnessRuntimeDeps['runTurn'] {
  return async (_modelId, prompt) => {
    const isContradictionCheck = prompt.startsWith(CONTRADICTION_CHECK_MARKER);
    log.push({ index: log.length, phase: phaseOf(prompt), isContradictionCheck, bytes: Buffer.byteLength(prompt, 'utf8'), prompt });
    return script(prompt);
  };
}

function extractSourceIdDigest(prompt: string): { sourceId: string; digest: string } {
  const match = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
  if (!match) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
  return { sourceId: match[1]!, digest: match[2]! };
}

// ---- Scripted models ------------------------------------------------------------------------

/** Handles the one call every script shares: the compact contradiction check. `undefined` when
 * `prompt` is not one, so callers can `??` into their own phase handling. */
function contradictionCheckReply(prompt: string): string | undefined {
  if (!prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return undefined;
  const match = /candidateId: (\S+)/.exec(prompt);
  return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
}

function finding(candidateId: string, ref: { sourceId: string; digest: string }): string {
  return JSON.stringify({
    messages: [
      {
        kind: 'candidateSubmission',
        candidate: {
          candidateId,
          memberId: MEMBER_ID,
          file: FILE_C,
          line: 1,
          endLine: 1,
          severity: 'minor',
          category: 'craftsmanship',
          confidence: 80,
          title: 'Missing input validation',
          body: 'A real finding a reasonable reviewer would raise.',
          citations: { primary: { sourceId: ref.sourceId, digest: ref.digest, path: FILE_C, range: { startLine: 1, endLine: 1 } } },
        },
      },
    ],
  });
}

const PLAN_CREATED = JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Read each changed file and review it.' }] }] });
const STOP_INVESTIGATING = JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
const REQUEST_COMPLETION = JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Coverage looks complete.' }] });

function readDiffRequest(path: string): string {
  return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: SNAPSHOT, path } }] });
}

/** The brief's own floor for a competent reviewer: reads each changed file's diff, submits one
 * finding, asks to complete — sequential turns throughout, never batched. */
function reasonableReviewerScript(): (prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  return async (prompt) => {
    const contradiction = contradictionCheckReply(prompt);
    if (contradiction !== undefined) return contradiction;
    const phase = phaseOf(prompt);
    if (phase === 'planning') return PLAN_CREATED;
    if (phase === 'investigating') {
      investigatingCalls += 1;
      if (investigatingCalls <= CHANGED_FILES.length) return readDiffRequest(CHANGED_FILES[investigatingCalls - 1]!);
      if (investigatingCalls === CHANGED_FILES.length + 1) return finding('cand-1', extractSourceIdDigest(prompt));
      return STOP_INVESTIGATING;
    }
    if (phase === 'verifying') return REQUEST_COMPLETION;
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
  };
}

/** Cause B, confirmed: reads each file's diff exactly like a reasonable reviewer, but also tries
 * `readFile` on a file outside the merge request and an unscoped (whole-repository) `searchRepository`
 * before submitting its finding — the behavior the user actually observed. */
function wanderingReviewerScript(): (prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  let citedRef: { sourceId: string; digest: string } | undefined;
  return async (prompt) => {
    const contradiction = contradictionCheckReply(prompt);
    if (contradiction !== undefined) return contradiction;
    const phase = phaseOf(prompt);
    if (phase === 'planning') return PLAN_CREATED;
    if (phase === 'investigating') {
      investigatingCalls += 1;
      if (investigatingCalls <= CHANGED_FILES.length) return readDiffRequest(CHANGED_FILES[investigatingCalls - 1]!);
      if (investigatingCalls === CHANGED_FILES.length + 1) {
        citedRef = extractSourceIdDigest(prompt); // FILE_C's readDiff result
        return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readFile', memberId: MEMBER_ID, request: { snapshot: SNAPSHOT, revision: 'head', path: UNRELATED_FILE, startLine: 1, endLine: 50 } }] });
      }
      if (investigatingCalls === CHANGED_FILES.length + 2) {
        return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'searchRepository', memberId: MEMBER_ID, request: { snapshot: SNAPSHOT, revision: 'head', query: 'TODO' } }] });
      }
      if (investigatingCalls === CHANGED_FILES.length + 3) return finding('cand-wander', citedRef!);
      return STOP_INVESTIGATING;
    }
    if (phase === 'verifying') return REQUEST_COMPLETION;
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
  };
}

/** Cause A, measured: reads each file's diff, then also calls `resolvePolicy` once per changed
 * file — the scenario the brief worried produces "dozens" of AGENTS.md reads. */
function resolvePolicyPerFileScript(): (prompt: string) => Promise<string> {
  let investigatingCalls = 0;
  let citedRef: { sourceId: string; digest: string } | undefined;
  return async (prompt) => {
    const contradiction = contradictionCheckReply(prompt);
    if (contradiction !== undefined) return contradiction;
    const phase = phaseOf(prompt);
    if (phase === 'planning') return PLAN_CREATED;
    if (phase === 'investigating') {
      investigatingCalls += 1;
      if (investigatingCalls <= CHANGED_FILES.length) return readDiffRequest(CHANGED_FILES[investigatingCalls - 1]!);
      if (investigatingCalls === CHANGED_FILES.length + 1) citedRef = extractSourceIdDigest(prompt); // FILE_C's readDiff result
      const resolveIndex = investigatingCalls - (CHANGED_FILES.length + 1);
      if (resolveIndex >= 0 && resolveIndex < CHANGED_FILES.length) {
        return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'resolvePolicy', memberId: MEMBER_ID, changedPath: CHANGED_FILES[resolveIndex] }] });
      }
      if (investigatingCalls === CHANGED_FILES.length * 2 + 1) return finding('cand-policy', citedRef!);
      return STOP_INVESTIGATING;
    }
    if (phase === 'verifying') return REQUEST_COMPLETION;
    throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
  };
}

// ---- Running one scenario end to end and summarizing what it cost ------------------------------

interface ScenarioResult {
  readonly lifecycle: string;
  readonly completeness: string;
  readonly findingCount: number;
  readonly small: boolean;
  readonly providerCalls: readonly ProviderCallRecord[];
  readonly modelTurns: readonly ModelTurnRecord[];
  readonly totalBytesSent: number;
  readonly providerCallsByMethod: Readonly<Record<string, number>>;
  readonly offMrCalls: number;
}

async function runScenario(script: (prompt: string) => Promise<string>, connectionOverrides: Partial<Connection & InvestigationOperations>, policy: HarnessPolicy): Promise<ScenarioResult> {
  // Some `it` blocks below call `runScenario` more than once (before/after comparisons) — clearing
  // here, not only in the module-level `afterEach`, keeps each call's own provider registration
  // independent regardless of how many times this runs within one test.
  clearProviders();
  const providerCalls: ProviderCallRecord[] = [];
  const modelTurns: ModelTurnRecord[] = [];
  const changedFiles = new Set(CHANGED_FILES);

  const rawConnection = baseFakeConnection({
    getChangeRequestDetails: async (request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> => ({ snapshot: request.snapshot, state: 'complete', value: smallDetail() }),
    listChangedFiles: async (request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> => ({ snapshot: request.snapshot, state: 'complete', value: CHANGED_FILES.map(manifestEntry) }),
    readDiff: async (request: DiffPageRequest): Promise<DiffPageResult> => diffPageResult(request.path),
    // The root (and, absent a policy fix, per-directory) AGENTS.md probe always reports absent —
    // this fixture has no policy file — and any other path (the "wandering" scripts' target)
    // reports real content, so a successful off-merge-request read is observable when it happens.
    readFile: async (request) => {
      if (request.path.endsWith('AGENTS.md')) return { snapshot: request.snapshot, state: 'notFound' };
      return { snapshot: request.snapshot, state: 'complete', value: { revision: request.revision, path: request.path, startLine: request.startLine, endLine: request.endLine, text: `// content of ${request.path}, unrelated to this change\n` } };
    },
    searchRepository: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: UNRELATED_FILE, line: 1, excerpt: 'a repository-wide match' }] }),
    getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    ...connectionOverrides,
  });
  const connection = countingConnection(rawConnection, changedFiles, providerCalls);
  registerFakeProvider(connection);

  const deps = baseDeps(countingRunTurn(script, modelTurns), policy);
  const factory = createReviewHarnessFactory(deps);
  const result = await factory.create(runInput(), noopRunOptions(freshIdentity())).run();

  const providerCallsByMethod: Record<string, number> = {};
  let offMrCalls = 0;
  for (const call of providerCalls) {
    providerCallsByMethod[call.method] = (providerCallsByMethod[call.method] ?? 0) + 1;
    if (call.classification === 'off-mr') offMrCalls += 1;
  }
  const totalBytesSent = modelTurns.reduce((sum, turn) => sum + turn.bytes, 0);

  return {
    lifecycle: result.lifecycle,
    completeness: result.outcome.completeness,
    findingCount: result.findings.length,
    small: result.small,
    providerCalls,
    modelTurns,
    totalBytesSent,
    providerCallsByMethod,
    offMrCalls,
  };
}

// Unscoped is the shipped default again, and for a different reason than the
// first time: not "no restriction exists yet", but "every read is a local file
// read, so the metered API call the restriction was protecting does not exist".
const UNSCOPED_POLICY = DEFAULT_HARNESS_POLICY;
// What a reviewer who wants the narrow behaviour opts into.
const SCOPED_POLICY = normalizeHarnessPolicy({ scopeInvestigationToChangedFiles: true });

// ---- Baseline: what a reasonable reviewer actually costs, before any fix ------------------------

/**
 * Measured (asserted below, not assumed): 1 model turn to plan, 5 to investigate (3 reads, 1
 * submission, 1 stop), 1 compact contradiction check, 1 to verify — 8 model calls total, 7 of them
 * carrying the full envelope. Provider calls: 1 change-request detail fetch, 2 manifest pages, 3
 * `readDiff`, 1 `readFile` (the root `AGENTS.md` probe bootstrap always makes) and 2 `getCurrentHead`
 * checks (verifying + completing) — 9 provider calls, of which exactly 1 (`readFile`) is off the
 * merge request, by design (D7: policy is authoritative context, not investigation).
 *
 * The second manifest page is not a second page of files: it is a second
 * *enumeration*, and it arrived with `add-local-git-investigation` task 9.1.
 * Source selection reads the whole manifest once before the attempt starts,
 * because whether this provider can serve this change at all is knowable only
 * from the manifest (design D6) — the measured failure this change exists for is
 * a run that read a third of a change and reported itself complete. One manifest
 * page per member per attempt is what that costs, paid before any model work.
 */
describe('measuring a small review before any fix (reproducing the pre-fix, unrestricted default)', () => {
  it('a reasonable reviewer never leaves the merge request on its own, but the whole envelope is resent on every one of the 7 real turns', async () => {
    const before = await runScenario(reasonableReviewerScript(), {}, UNSCOPED_POLICY);

    // The review actually finished, cleanly, with the one real finding — the measurement is of a
    // review that worked, not one that failed early and looked artificially cheap.
    expect(before.lifecycle).toBe('succeeded');
    expect(before.completeness).toBe('complete');
    expect(before.findingCount).toBe(1);
    expect(before.small).toBe(true);

    // Provider calls by method — exact, since the script and fixture are fully deterministic.
    expect(before.providerCallsByMethod).toEqual({
      getChangeRequestDetails: 1,
      // One: the attempt's own inventory. It was two while source selection ran
      // a serviceability check over the provider's manifest; that check went with
      // the provider investigation path.
      listChangedFiles: 1,
      readDiff: 3,
      readFile: 1, // the root AGENTS.md probe — never per-file, never repeated
      getCurrentHead: 2, // refreshed on entry to verifying, and again on entry to completing (D3)
    });
    expect(before.offMrCalls).toBe(1); // exactly the root AGENTS.md probe

    // Model turns: 1 planning + 5 investigating (3 reads, 1 submission, 1 stop) + 1 compact
    // contradiction check + 1 verifying completionRequest.
    expect(before.modelTurns).toHaveLength(8);
    const fullEnvelopeTurns = before.modelTurns.filter((turn) => !turn.isContradictionCheck);
    const contradictionTurns = before.modelTurns.filter((turn) => turn.isContradictionCheck);
    expect(fullEnvelopeTurns).toHaveLength(7);
    expect(contradictionTurns).toHaveLength(1);

    // Every full-envelope turn actually IS full-sized (proving the resend, not just counting
    // turns): each carries the persona and the whole host-tool catalog fresh; the compact
    // contradiction check (which reuses `askModel`'s `repairInstruction` channel directly, never
    // the envelope — `harnessModelSeam.ts`'s own header) carries neither.
    for (const turn of fullEnvelopeTurns) {
      expect(turn.prompt).toContain('## Persona');
      expect(turn.prompt).toContain('## Host tools');
    }
    for (const turn of contradictionTurns) {
      expect(turn.prompt).not.toContain('## Persona');
      expect(turn.prompt).not.toContain('## Host tools');
    }
    // Still substantial on its own (it carries the finding's full cited evidence) — the point is
    // structural (no envelope), not that it is tiny.
    for (const turn of fullEnvelopeTurns) expect(turn.bytes).toBeGreaterThan(2_000);

    // Recorded for the report, not pinned exactly (prompt wording will legitimately drift) — but
    // bounded, so a regression that makes a small review's envelope balloon still fails this suite.
    expect(before.totalBytesSent).toBeGreaterThan(20_000); // the real cost Cause C predicted
    // Raised from 80,000 deliberately, and only on this pre-fix reproduction path: the protocol
    // contract gained a "Value rules" block (~600 bytes, resent on all 7 turns) stating the types,
    // enums and bounds the shapes alone never carried. Every rule in it was a real rejection, and
    // one rejected turn costs a round trip plus a full re-upload of the evidence prompt — far more
    // than 4 KB. The SHIPPED default still comes in under 80,000, asserted below; this scenario
    // runs unscoped, which is now the shipped default, so this is the number a
    // real small review actually costs.
    expect(before.totalBytesSent).toBeLessThan(94_000); // a small review must never approach six figures of bytes
  });
});

// ---- After the fix: same behavior, fewer bytes --------------------------------------------------

/**
 * The SAME reasonable-reviewer script, against `SCOPED_POLICY` — which is now the
 * opt-in rather than the default. Every provider-call and turn-count number is
 * identical to the baseline above — a reviewer who never tries to wander is not
 * rewarded or punished by the scoping — but the bytes sent are measurably lower,
 * because the catalog and protocol contract shown to the model are smaller (3
 * fewer tools: `readFile`, `searchRepository`, and `resolvePolicy`, which rides
 * on `fileReads`).
 *
 * The two scenarios swapped roles when the default flipped. What each one
 * measures did not change.
 */
describe('after a reviewer scopes investigation to changed files — same behavior, fewer bytes', () => {
  it('provider calls, off-MR calls, and turn count are unchanged; total bytes sent are strictly lower', async () => {
    const before = await runScenario(reasonableReviewerScript(), {}, UNSCOPED_POLICY);
    const after = await runScenario(reasonableReviewerScript(), {}, SCOPED_POLICY);

    expect(after.providerCallsByMethod).toEqual(before.providerCallsByMethod);
    expect(after.offMrCalls).toBe(before.offMrCalls);
    expect(after.modelTurns).toHaveLength(before.modelTurns.length);
    expect(after.findingCount).toBe(1);
    expect(after.lifecycle).toBe('succeeded');

    expect(after.totalBytesSent).toBeLessThan(before.totalBytesSent);

    // Regression guard: committed so a future change that makes a small review expensive again
    // fails this suite. Loose on bytes (prompt wording will legitimately drift), strict on shape.
    //
    // This ceiling moved twice in one day, both times to buy back round trips, and the reasoning
    // is recorded here rather than rediscovered:
    //
    // 80_000 -> 82_000: the contract began stating the per-turn tool cap (~175 bytes/turn).
    //   Measured 79_922 with 78 bytes to spare, which is not the "loose on bytes" this guard was
    //   written to be. A live 26-file review had been throwing away 7 of 36 model calls to
    //   `tooManyToolRequests` because the cap was enforced and never stated.
    // 82_000 -> 87_000: every turn now carries the investigation map (~280 bytes/turn here). The
    //   next run of that same review made 0 over-cap turns and then failed a different way: it
    //   asked for the manifest 24 times and read four files 20-22 times each, spent 234 of its 256
    //   tool calls, and submitted no findings, because the prompt showed it only the previous
    //   turn's results. Bytes per turn are the cheapest thing in this system; a round trip resends
    //   the whole prompt, and that run made 53 of them.
    //
    // What this guard actually protects is unchanged and still strict: turn count, provider calls,
    // and off-MR calls below are exact. Bytes are the loose half deliberately — the regressions
    // worth catching here (unbatched reads, whole-file pages, a ballooning envelope) cost tens of
    // KB, not hundreds of bytes. If a change adds bytes and does not remove turns, this is the
    // wrong place to relax; take it out of the text instead.
    expect(after.modelTurns.length).toBeLessThanOrEqual(8);
    expect(after.offMrCalls).toBeLessThanOrEqual(1);
    expect(after.totalBytesSent).toBeLessThan(87_000);
  });

  /**
   * The per-turn prompt budget must be free here, in both senses.
   *
   * *No prompt is ever near the cap*, which is the guarantee `maxPromptBytesPerTurn` makes and
   * which this scenario — the one real end-to-end review this suite runs — is the natural place to
   * assert over every turn of a whole review, contradiction check included.
   *
   * *And nothing is said about it.* The budget announcement and the map's size column are gated on
   * the budget being able to bind at all; a three-file review whose entire unread diff fits one
   * turn can never be refused anything, so it is told nothing and pays nothing. That gate is what
   * keeps the byte ceilings above (87,000 and 94,000) meaning what they meant before this existed
   * — the section measures 605 bytes, and had it been unconditional it would have spent that on
   * each of seven turns against 380 bytes of headroom (86,620 measured under an 87,000 ceiling).
   */
  it('costs a small review nothing: every prompt is far under the cap, and none of them mentions it', async () => {
    const after = await runScenario(reasonableReviewerScript(), {}, UNSCOPED_POLICY);
    for (const turn of after.modelTurns) {
      expect(turn.bytes, 'a prompt in a small review must not approach the per-turn cap').toBeLessThan(DEFAULT_HARNESS_POLICY.maxPromptBytesPerTurn / 2);
    }
    for (const turn of after.modelTurns) {
      expect(turn.prompt).not.toContain("This turn's size budget");
      expect(turn.prompt).not.toContain('content allowance');
    }
    // The size column rides the same gate, so no map line carries a KB figure either.
    expect(after.modelTurns.every((turn) => !/not read \S+ \+\d+\/-\d+ \d+KB/.test(turn.prompt))).toBe(true);
  });

  /**
   * End to end, on a real run: what the model already did survives into the next prompt.
   *
   * The renderer is unit-tested in `harnessModelSeam.test.ts`; this asserts the wiring, which is
   * the half that was actually missing. Before it, a model that had read a file saw no trace of
   * that in its next prompt — so a live 26-file review re-listed the manifest 24 times, read four
   * files 20-22 times each, burned 234 of 256 tool calls and submitted nothing.
   */
  it('carries what has already been read into every later prompt, not just the previous turn', async () => {
    const after = await runScenario(reasonableReviewerScript(), {}, SCOPED_POLICY);
    const prompts = after.modelTurns.filter((turn) => !turn.isContradictionCheck).map((turn) => turn.prompt);

    const withMap = prompts.filter((prompt) => prompt.includes('## What you have already gathered'));
    expect(withMap.length, 'no prompt carried an investigation map').toBeGreaterThan(0);

    // The last full prompt must show the file this scenario read as read, and name the evidence
    // held for it — the two facts the model was re-fetching the manifest and the diff to recover.
    const last = withMap.at(-1)!;
    expect(last).toMatch(/read {5}\S*\.ts/);
    expect(last).toMatch(/ev_[0-9a-f]+/);
    expect(last).toContain('Do not call listChangedFiles');

    // An index, never the bytes: the map must not reproduce evidence content, or it would grow
    // without bound and invite citation from memory.
    const map = last.slice(last.indexOf('## What you have already gathered'));
    const mapEnd = map.indexOf('## Current phase');
    expect(map.slice(0, mapEnd === -1 ? undefined : mapEnd).length, 'the map is not an index any more').toBeLessThan(4_000);
  });

  it('the rendered prompt withholds readFile/searchRepository/resolvePolicy from the catalog and the request-shape list, and says so plainly', async () => {
    const after = await runScenario(reasonableReviewerScript(), {}, SCOPED_POLICY);
    const planningPrompt = after.modelTurns.find((turn) => turn.phase === 'planning')?.prompt;
    expect(planningPrompt).toBeDefined();
    const prompt = planningPrompt!;

    // The catalog description no longer lists the withheld tools...
    expect(prompt).not.toMatch(/^- readFile \(/m);
    expect(prompt).not.toMatch(/^- searchRepository \(/m);
    expect(prompt).not.toMatch(/^- resolvePolicy \(/m);
    // ...nor does the request-shapes list...
    expect(prompt).not.toContain('- readFile: {');
    expect(prompt).not.toContain('- searchRepository: {');
    expect(prompt).not.toContain('- resolvePolicy: "changedPath"');
    // ...and the model is told plainly, once, so it does not waste a turn asking.
    expect(prompt).toContain('Not available for this review');
    expect(prompt).toMatch(/Not available for this review[^\n]*readFile/);
    expect(prompt).toMatch(/Not available for this review[^\n]*searchRepository/);
    expect(prompt).toMatch(/Not available for this review[^\n]*resolvePolicy/);

    // What stays available is still described in full — scoping narrows the catalog, it does not
    // starve the model of the tools it actually needs.
    expect(prompt).toContain('- readDiff (');
    expect(prompt).toContain('- readDiff: {');
    expect(prompt).toContain('- searchDiff: {');

    const unscoped = await runScenario(reasonableReviewerScript(), {}, UNSCOPED_POLICY);
    const unscopedPrompt = unscoped.modelTurns.find((turn) => turn.phase === 'planning')!.prompt;
    // The unscoped baseline really did advertise all three — confirms the difference is the fix,
    // not a fixture that never had them in the first place.
    expect(unscopedPrompt).toContain('- readFile (');
    expect(unscopedPrompt).toContain('- searchRepository (');
    expect(unscopedPrompt).toContain('- resolvePolicy (');
    expect(unscopedPrompt).not.toContain('Not available for this review');
  });
});

// ---- Cause B, confirmed: repository-wide reads succeed today, refused after the fix -------------

describe('cause B — repository-wide reads (confirmed real, but only when the model actually tries)', () => {
  it('unscoped: a curious model reads a file outside the merge request and searches the whole repository, and both calls really reach the source', async () => {
    const result = await runScenario(wanderingReviewerScript(), {}, UNSCOPED_POLICY);

    expect(result.lifecycle).toBe('succeeded');
    expect(result.completeness).toBe('complete');
    expect(result.findingCount).toBe(1);

    expect(result.providerCallsByMethod).toEqual({
      getChangeRequestDetails: 1,
      listChangedFiles: 1,
      readDiff: 3,
      readFile: 2, // the root AGENTS.md probe, AND the unrelated file the model asked to read
      searchRepository: 1, // the unscoped, whole-repository search
      getCurrentHead: 2,
    });
    // 3 off-merge-request calls now: the root policy probe, the unrelated file, and the unscoped search.
    expect(result.offMrCalls).toBe(3);
    expect(result.providerCalls.some((call) => call.method === 'readFile' && call.path === UNRELATED_FILE && call.classification === 'off-mr')).toBe(true);
    expect(result.providerCalls.some((call) => call.method === 'searchRepository' && call.classification === 'off-mr')).toBe(true);
  });

  it('scoped: the same requests are refused before the source is ever called, and the model is told why', async () => {
    const result = await runScenario(wanderingReviewerScript(), {}, SCOPED_POLICY);

    expect(result.lifecycle).toBe('succeeded');
    expect(result.completeness).toBe('complete');
    expect(result.findingCount).toBe(1); // the refused calls cost turns, never the review's outcome

    // The provider itself is never touched for either withheld tool — not merely "refused with an
    // error", genuinely never dispatched.
    expect(result.providerCallsByMethod.readFile).toBe(1); // only the root AGENTS.md probe
    expect(result.providerCallsByMethod.searchRepository).toBeUndefined();
    expect(result.offMrCalls).toBe(1);

    // The model DOES get told, in its very next prompt, exactly why — a refusal, not silence.
    const readFileRefusal = result.modelTurns.find((turn) => turn.prompt.includes('tool=readFile') && turn.prompt.includes('code=capabilityUnavailable'));
    const searchRefusal = result.modelTurns.find((turn) => turn.prompt.includes('tool=searchRepository') && turn.prompt.includes('code=capabilityUnavailable'));
    expect(readFileRefusal).toBeDefined();
    expect(searchRefusal).toBeDefined();
  });
});

// ---- Cause A, measured: the AGENTS.md walk is bounded, not automatic, and never "dozens" ---------

describe('cause A — the nested AGENTS.md walk (refuted as an automatic cost; bounded even when the model asks per file)', () => {
  it('when the model calls resolvePolicy once per changed file across 3 different directories, the shared ancestors are fetched once — 7 readFile calls total, nowhere near "dozens"', async () => {
    const result = await runScenario(resolvePolicyPerFileScript(), {}, UNSCOPED_POLICY);

    expect(result.lifecycle).toBe('succeeded');
    expect(result.completeness).toBe('complete');
    expect(result.findingCount).toBe(1);

    // 1 bootstrap root probe + the attempt's own resolver resolving, per file:
    //   FILE_A ('', 'src', 'src/services')      -> 3 new directories
    //   FILE_B ('', 'src', 'src/utils')          -> 1 new ('', 'src' already cached from FILE_A)
    //   FILE_C ('', 'src', 'src/api', 'src/api/routes') -> 2 new ('', 'src' already cached)
    // = 1 + 3 + 1 + 2 = 7, not 1 read per ancestor per file with no sharing (which would be 10),
    // and nowhere near "dozens".
    expect(result.providerCallsByMethod.readFile).toBe(7);
    expect(result.providerCallsByMethod.readFile).toBeLessThan(12);

    // Every readFile call this scenario makes is for an AGENTS.md path — resolvePolicy never reads
    // changed-file content itself, only policy files, so all 7 are off the merge request by
    // definition (D7: policy is authoritative context, never investigation of the change).
    const readFileCalls = result.providerCalls.filter((call) => call.method === 'readFile');
    expect(readFileCalls.every((call) => call.classification === 'off-mr')).toBe(true);
    expect(result.offMrCalls).toBe(7);

    // No directory is fetched twice within the attempt's own resolver: 6 distinct directories were
    // asked for across the 3 resolvePolicy calls ('', 'src', 'src/services', 'src/utils', 'src/api',
    // 'src/api/routes'), plus the 1 separate bootstrap-time root read — 7 total, never 7 * anything.
    const distinctDirectoriesImplied = 6;
    expect(result.providerCallsByMethod.readFile).toBe(distinctDirectoriesImplied + 1);
  });

  it('scoping investigation to changed files also refuses resolvePolicy (it rides on fileReads) — the walk never happens at all', async () => {
    const result = await runScenario(resolvePolicyPerFileScript(), {}, SCOPED_POLICY);

    expect(result.lifecycle).toBe('succeeded');
    expect(result.completeness).toBe('complete');
    expect(result.findingCount).toBe(1);

    // Only the bootstrap-time root probe remains — every model-requested resolvePolicy call is
    // refused before it ever reaches `Connection.readFile`.
    expect(result.providerCallsByMethod.readFile).toBe(1);
    expect(result.offMrCalls).toBe(1);

    const refusals = result.modelTurns.filter((turn) => turn.prompt.includes('tool=resolvePolicy') && turn.prompt.includes('code=capabilityUnavailable'));
    expect(refusals.length).toBe(CHANGED_FILES.length);
  });
});

// ---- The timing breakdown, driven end to end through the real attempt (not a unit test on the renderer alone) ----

/**
 * The task this whole file was written to fail on: "20 minutes, and none of the three diagnostic
 * channels says where the time went." This test drives the exact same reasonable-reviewer scenario
 * measured above through a real `HarnessAttempt`/dispatcher/model-seam, but with *known* durations
 * injected at the two real seams (`harnessToolDispatcher.ts`'s `dispatch`, timed via `HarnessRuntimeDeps.now`;
 * `HarnessRuntimeDeps.runTurn`'s own `onTiming` callback, standing in for `lmAgent.ts`'s `streamText`),
 * builds the real `AttemptDiagnosticsReport` from the real captured checkpoint, and asserts the
 * rendered summary's numbers are exactly right — not merely that the renderer prints something
 * plausible given a hand-built fixture (`harnessDiagnostics.test.ts` already covers that in
 * isolation; this is the wiring the brief says the last three fixes in this area never actually
 * proved).
 */
describe('run diagnostics time breakdown — driven end to end with known, injected durations', () => {
  it('a real attempt whose durations are all known produces a summary whose numbers are exactly right', async () => {
    clearProviders();
    let tick = 0;
    const providerCalls: ProviderCallRecord[] = [];
    const changedFiles = new Set(CHANGED_FILES);

    // Every real tool call the dispatcher actually times advances the shared clock by exactly
    // 50ms; the one call bootstrap makes *before* the dispatcher exists at all (the root
    // AGENTS.md probe, per `countingConnection`'s own doc comment above) advances it by a
    // distinct 77ms that no activity event will ever carry — proving the report's "host" bucket
    // is a true residual, not a fabricated zero, for a call this dispatcher never touched.
    const rawConnection = baseFakeConnection({
      getChangeRequestDetails: async (request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> => {
        tick += 50;
        return { snapshot: request.snapshot, state: 'complete', value: smallDetail() };
      },
      listChangedFiles: async (request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> => {
        tick += 50;
        return { snapshot: request.snapshot, state: 'complete', value: CHANGED_FILES.map(manifestEntry) };
      },
      readDiff: async (request: DiffPageRequest): Promise<DiffPageResult> => {
        tick += 50;
        return diffPageResult(request.path);
      },
      readFile: async (request) => {
        if (request.path.endsWith('AGENTS.md')) {
          tick += 77; // untracked: the bootstrap-only probe, never dispatched through the timed seam
          return { snapshot: request.snapshot, state: 'notFound' };
        }
        tick += 50;
        return { snapshot: request.snapshot, state: 'complete', value: { revision: request.revision, path: request.path, startLine: request.startLine, endLine: request.endLine, text: 'unused\n' } };
      },
      getCurrentHead: async () => {
        tick += 50;
        return { repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA };
      },
    });
    const connection = countingConnection(rawConnection, changedFiles, providerCalls);
    registerFakeProvider(connection);

    // Every model turn advances the shared clock by exactly 100ms and reports that same number
    // through `onTiming` — the field `lmAgent.ts`'s real `streamText` reports through, here
    // supplied directly since this fake stands in for it (see this describe block's own header).
    const script = reasonableReviewerScript();
    const timedRunTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt, options) => {
      tick += 100;
      const reply = await script(prompt);
      options?.onTiming?.({ durationMs: 100, promptBytes: Buffer.byteLength(prompt, 'utf8'), replyBytes: Buffer.byteLength(reply, 'utf8'), outcome: 'completed' });
      return reply;
    };

    const deps: HarnessRuntimeDeps = { ...baseDeps(timedRunTurn, DEFAULT_HARNESS_POLICY), now: () => tick };
    const factory = createReviewHarnessFactory(deps);

    let lastCheckpoint: CheckpointInfo | undefined;
    const result = await factory
      .create(runInput(), {
        identity: freshIdentity(),
        timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
        onAttachmentWarnings: () => {},
        cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
        onCheckpoint: (info: CheckpointInfo) => {
          lastCheckpoint = info;
        },
      })
      .run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.completionEvaluation).toBeDefined();
    expect(lastCheckpoint).toBeDefined();
    // Sanity check before trusting the numbers below: this is the exact scenario already measured
    // and pinned above (8 model calls, provider calls including the untracked root probe).
    expect(providerCalls.length).toBeGreaterThan(0);

    const record: DiagnosticsSourceRecord = {
      runId: result.runId,
      lineageId: result.lineageId,
      attempt: result.attempt,
      lifecycle: result.lifecycle,
      completeness: result.outcome.completeness,
      checkpoint: lastCheckpoint,
      completionEvaluation: result.completionEvaluation,
      limitations: result.outcome.limitations,
    };
    const report = buildAttemptDiagnosticsReport(record, () => '2026-09-07T00:00:00.000Z');
    const text = renderAttemptDiagnosticsText(report);

    expect(report.timeSummary).toBeDefined();
    const summary = report.timeSummary!;

    // Exact, not approximate: every one of the 8 model turns (the same count the baseline
    // measurement above pins) reported exactly 100ms.
    expect(report.modelTurns.length).toBe(8);
    expect(summary.modelTurnCount).toBe(8);
    expect(summary.modelWaitMs).toBe(800);

    // Every real tool call that actually reaches the fake connection (readDiff, listChangedFiles,
    // getChangeRequestDetails) advances the shared clock by exactly 50ms; `submitCandidateFinding`/
    // `requestCompletion` are host actions that never call the connection at all (D6: they carry
    // no `connectionMethod`), so they are legitimately 0ms here, not missing data — this is exactly
    // why the assertion below counts connection-touching calls specifically rather than every
    // dispatched tool call.
    const connectionTouchingCalls = report.toolCalls.filter((c) => c.tool !== 'submitCandidateFinding' && c.tool !== 'requestCompletion');
    expect(connectionTouchingCalls.length).toBeGreaterThan(0);
    expect(report.toolCalls.every((c) => c.durationMs !== undefined)).toBe(true); // every dispatch was timed, connection-touching or not
    expect(summary.providerWaitMs).toBe(connectionTouchingCalls.length * 50);

    // `totalElapsedMs` is read from the checkpoint's own top-level `elapsedMs` — a fresh clock
    // read at checkpoint-write time (`harnessAttempt.ts`'s `reportCheckpoint`) — NEVER
    // `budget.elapsedMs`, which only moves when a turn reserves budget (`beginTurn`) and goes
    // stale for however long the attempt keeps working afterward. Proven here, not asserted on
    // faith: this run's last budget reservation was `verifying`'s final turn, but `completing`
    // does one more untracked `getCurrentHead` refresh after that (see the host-time comment
    // below) before the attempt's last checkpoint is written — so `budget.elapsedMs` (1100) is 50ms
    // behind the checkpoint's own `elapsedMs` (1150). Reading the wrong one would not just misname
    // that 50ms as host time instead of "unknown" — it would drop it from the total outright, the
    // exact silent-loss distortion this whole feature exists to prevent.
    expect(summary.totalElapsedMs).toBe(lastCheckpoint!.elapsedMs);
    expect(summary.totalElapsedMs).toBeGreaterThan(report.budget!.elapsedMs); // the checkpoint always runs at or after the last reservation
    expect(summary.totalElapsedMs).toBeGreaterThan(0);

    // Host time is the true residual, never fabricated and never negative: it must account for
    // every millisecond of the attempt's own window not already claimed by the model or provider
    // buckets — real work here is the two untracked `getCurrentHead` refreshes (D3: on entry to
    // verifying and again on entry to completing), 50ms each by this same fake connection, 100ms
    // total. With `totalElapsedMs` correctly sourced from the checkpoint (see above), both land in
    // `hostMs` (100); reading `budget.elapsedMs` instead used to lose the second one from the total
    // entirely rather than merely mis-bucketing it.
    expect(summary.hostMs).toBe(summary.totalElapsedMs - summary.modelWaitMs - summary.providerWaitMs);
    expect(summary.hostMs).toBe(100);
    expect(summary.hostMs).toBeGreaterThanOrEqual(0);
    expect(summary.modelWaitMs + summary.providerWaitMs).toBeLessThanOrEqual(summary.totalElapsedMs); // nothing double-counted past the total

    // The rendered text leads with this — the whole point of the change.
    expect(text.split('\n').slice(0, 10).join('\n')).toContain('Time summary: total');

    // Printed deliberately: proof this is a real attempt's real rendered output, not a hand-built
    // fixture — pasted verbatim into the task's own report.
    console.log(`\n---- E2E run diagnostics report (known injected durations) ----\n${text}\n---- end ----\n`);
  });
});
