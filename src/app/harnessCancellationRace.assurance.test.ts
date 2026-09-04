/**
 * Task 16.5 of `add-agentic-review-harness`: lifecycle race tests proving
 * cancellation is observed correctly no matter which stage of an attempt it
 * lands in — a model-streaming turn, a provider read, a retry backoff wait,
 * a checkpoint write, or the final persistence write — plus the two hostile
 * cases design.md D12/D13 and `harnessToolDispatcher.ts`'s own doc comments
 * call out explicitly: a provider that never notices cancellation at all,
 * and a response that only arrives after the run has already settled.
 *
 * `harnessAttempt.test.ts` already has one cancellation test ("cancellation
 * mid-investigation ends the attempt promptly..."), and
 * `reviewRunManager.test.ts` already has the manager-level "an attempt that
 * ignores cancellation and never reports back settles as cancelled... once
 * the bounded timeout elapses" test — but that one drives `controllableAttempts()`,
 * a hand-rolled fake `ReviewHarnessFactory` that never goes through
 * `harnessAttempt.ts`/`harnessToolDispatcher.ts` at all. This file's job is
 * the gaps those two leave: model-turn-level and retry-wait-level races
 * inside `createHarnessAttempt` itself, checkpoint/persistence write races,
 * ledger/coverage non-pollution from a discarded late read, and — in the
 * closing test — the hostile pair proved through the *real* dispatcher and
 * a *real* `ReviewRunManager`'s bounded cancel grace, not a fake standing in
 * for both.
 *
 * No timers, no real waiting: every race is forced by making the fake
 * `Connection`/`sleep`/`onCheckpoint`/`onPersist` synchronously call
 * `cancellation.cancel()` (or, for the manager-level test, `runs.cancel()`)
 * at the exact moment the property under test needs it to land — landing
 * strictly *during* an in-flight `await`, never before or after it, which is
 * the only way to force the race rather than merely assert on an
 * already-settled state.
 *
 * Fixture scaffolding for the `createHarnessAttempt`-level tests is copied
 * from `harnessAttempt.test.ts` (private to that file); the manager-level
 * closing test copies `reviewRunManagerHarnessIntegration.test.ts`'s
 * `realHarnessFactory` idiom, and reuses `reviewRunManager.test.ts`'s own
 * `controllableAttempts()`... no — this file drives a *real* attempt end to
 * end, so it does not import that helper; it builds its own real
 * `ReviewHarnessFactory` the same way `realHarnessFactory` there does. Both
 * copies are "the fixture literals that describe one scripted scenario", not
 * a reimplementation of anything under test (the same idiom that file's own
 * header already documents as acceptable under "reuse, don't reinvent").
 * No fixture-provider import; `DiffPage.positions` supplied non-empty
 * throughout.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHarnessAttempt,
  type CheckpointInfo,
  type HarnessAttemptMemberInput,
  type HarnessAttemptOptions,
  type HarnessModelSeam,
  type SynthesisVerificationRunner,
} from './harnessAttempt';
import type { AgentCancellationToken } from './lmAgent';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { ReviewRunManager, type HarnessAttemptRunOptions, type ReviewHarnessFactory, type RunInput } from './reviewRunManager';
import { draftKeyFor, partialDraftKeyFor } from './retainedReview';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { KeyValueStore } from './storage';
import { HARNESS_POLICY_VERSION, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { RunPhase } from '../domain/harnessActivity';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import { ScmError } from '../platform/errors';
import type { Connection, InvestigationOperationCapability, ProviderCapabilities } from '../platform/provider';
import type { ChangedFileEntry, ChangedFileManifestResult, ChangeRequestDetailResult, CurrentHeadResult, DiffPageResult } from '../platform/types';
import type { HostToolResult } from './harnessToolDispatcher';

// ---- Fixtures, copied from harnessAttempt.test.ts (private to that file) ------------------

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

type ScriptCall = { readonly repairInstruction: string | undefined; readonly toolResults: readonly HostToolResult[] };
type ScriptEntry = string | ((call: ScriptCall) => string);

function scriptedModelSeam(script: Partial<Record<RunPhase, readonly ScriptEntry[]>>, modelId = 'test-model'): HarnessModelSeam {
  const counters: Partial<Record<RunPhase, number>> = {};
  return {
    modelId,
    async askModel({ phase, repairInstruction, toolResults }) {
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

/** Passes every verification clause without asking the model — the collaborator's own concern (task 10.6) is not this file's job to implement. */
const passthroughVerification: SynthesisVerificationRunner = async (input) =>
  Object.freeze({ findings: input.findings, contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true });

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

// ---- 1. Model-streaming cancel ------------------------------------------------------------

describe('16.5: cancellation during a model-streaming turn', () => {
  it('a candidate submission that only arrives after cancel was requested mid-ask is discarded whole — an already-validated finding from an earlier turn still survives as a partial', async () => {
    const cancellation = fakeCancellationToken();
    const connection = reviewConnection({ files: ['file1.ts', 'file2.ts'] });
    // Turn 2 both submits a real, valid candidate for file1 (from turn 1's read) *and* requests a
    // second, equally real read of file2 — so turn 3's late candidate below can cite genuine,
    // already-registered evidence, never a forged citation. A forged citation would be rejected by
    // candidate validation regardless of cancellation, which would make this test pass for the
    // wrong reason; only a real, validly-citable late candidate actually isolates "was this
    // discarded because of the cancellation race, or because it was bogus anyway".
    const investigatingTurn2: ScriptEntry = (call) => {
      const ref = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-real', 'file1.ts', ref), readDiffMessage('file2.ts'));
    };
    // Turn 3: the "stream" resolves with an actionable, validly-cited candidate submission, but
    // only after cancellation was signalled synchronously from inside this very askModel call —
    // simulating a model response that streamed in after the reviewer already cancelled.
    const investigatingTurn3: ScriptEntry = (call) => {
      const file2Result = call.toolResults.find((r) => r.state === 'complete' && r.content.tool === 'readDiff');
      const ref = sourceRefFrom(file2Result as HostToolResult);
      cancellation.cancel();
      return messages(candidateSubmissionMessage('cand-late', 'file2.ts', ref));
    };
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), investigatingTurn2, investigatingTurn3, STOP_TURN],
      verifying: [COMPLETION_TURN, STOP_TURN],
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
    // The earlier, genuinely validated candidate survived as a partial — D11's "cancellation
    // preserves already-validated findings" is not regressed by this race.
    expect(result.outcome.kind).toBe('partialFindings');
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.candidateId).toBe('cand-real');
    // The late candidate — a real, validly-citable finding for file2 — never entered the result
    // even though its citation was genuine and would otherwise have validated cleanly: the turn
    // producing it was discarded as `cancelled` before its message was ever parsed or dispatched.
    expect(result.findings.some((f) => f.candidateId === 'cand-late')).toBe(false);
  });
});

// ---- 2. Retry-wait cancel ------------------------------------------------------------------

describe('16.5: cancellation during a retry backoff wait', () => {
  it('cancellation observed while a transient-failure backoff wait is pending stops the retry loop before the provider is asked a second time', async () => {
    const cancellation = fakeCancellationToken();
    let readDiffCalls = 0;
    const connection = reviewConnection({
      files: ['file1.ts'],
      readDiff: async (request) => {
        readDiffCalls += 1;
        if (readDiffCalls === 1) throw new ScmError('network', 'transient network blip');
        return diffPageResult(request.path);
      },
    });
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      investigating: [messages(readDiffMessage('file1.ts')), STOP_TURN],
      verifying: [STOP_TURN],
    });
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
      retry: {
        // A short, jittered backoff (policy defaults) is deterministic here because `random`
        // always returns 0 — no real timer is ever started; `sleep` is called once, synchronously
        // signals cancellation (as a real cancel request racing a pending backoff timer would),
        // and resolves on a microtask, exactly like `cancellableWait`'s own race expects.
        sleep: async () => {
          cancellation.cancel();
        },
        random: () => 0,
      },
    });

    const result = await attempt.run();

    expect(result.cancelled).toBe(true);
    expect(result.lifecycle).toBe('cancelled');
    // The one and only property this test exists to pin: cancellation observed mid-wait must stop
    // the retry loop before it asks the provider again — never a second live call riding out the
    // wait it was supposed to be racing.
    expect(readDiffCalls).toBe(1);
  });
});

// ---- 3. Checkpoint-write cancel ------------------------------------------------------------

describe('16.5: cancellation during a checkpoint write', () => {
  it('cancellation signalled while a checkpoint write is still pending does not corrupt the write, and the attempt still ends cancelled promptly once the write settles', async () => {
    const cancellation = fakeCancellationToken();
    const connection = reviewConnection({ files: ['file1.ts'] });
    const seam = scriptedModelSeam({
      planning: [PLAN_TURN],
      // Never reached: the phase loop's own `isCancelled()` gate fires before any ask, because the
      // checkpoint write that precedes it is where cancellation lands. Scripted anyway as a safety
      // net so a mis-wired test fails on a wrong assertion, not an opaque "never scripted" throw.
      investigating: [STOP_TURN],
      verifying: [STOP_TURN],
    });
    const checkpoints: CheckpointInfo[] = [];
    let resolveInvestigatingCheckpoint: (() => void) | undefined;
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
      onCheckpoint: (info) => {
        checkpoints.push(info);
        if (info.phase === 'investigating' && info.reason === 'phaseBoundary') {
          return new Promise<void>((resolve) => {
            resolveInvestigatingCheckpoint = resolve;
          });
        }
      },
    });

    const runPromise = attempt.run();
    await vi.waitFor(() => expect(resolveInvestigatingCheckpoint).toBeDefined());
    // Cancellation arrives strictly while the checkpoint write is still in flight.
    cancellation.cancel();
    resolveInvestigatingCheckpoint?.();
    const result = await runPromise;

    // The write itself was not corrupted by the cancellation racing it: exactly one investigating
    // phase-boundary checkpoint was reported, correctly tagged.
    const investigatingCheckpoints = checkpoints.filter((c) => c.phase === 'investigating' && c.reason === 'phaseBoundary');
    expect(investigatingCheckpoints).toHaveLength(1);
    // And once that write settled, the attempt proceeded straight to a cancelled terminus — no
    // investigating turn was asked (the phase loop's own gate caught it first), and verifying never
    // ran at all.
    expect(result.lifecycle).toBe('cancelled');
    expect(result.cancelled).toBe(true);
    expect(result.activityLog.events.some((e) => e.kind === 'actionStarted' && e.action.includes('Synthesizing'))).toBe(false);
  });
});

// ---- 4. Final-persistence cancel ------------------------------------------------------------

describe('16.5: cancellation during the final persistence write', () => {
  it('cancellation signalled while the terminal onPersist write is still pending does not retroactively change an outcome already decided before the write began', async () => {
    const cancellation = fakeCancellationToken();
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
    let resolvePersist: (() => void) | undefined;
    let cancelledAtPersistStart: boolean | undefined;
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
      onPersist: () => {
        cancelledAtPersistStart = cancellation.token.isCancellationRequested;
        return new Promise<void>((resolve) => {
          resolvePersist = resolve;
        });
      },
    });

    const runPromise = attempt.run();
    await vi.waitFor(() => expect(resolvePersist).toBeDefined());
    expect(cancelledAtPersistStart).toBe(false);
    // Cancellation arrives strictly while the persistence write is in flight — after the outcome
    // was already computed and handed to `onPersist`.
    cancellation.cancel();
    resolvePersist?.();
    const result = await runPromise;

    // The already-decided, genuinely complete outcome is what shipped — a cancel that only landed
    // during the write must never retroactively flip a `succeeded` result to `cancelled`.
    expect(result.lifecycle).toBe('succeeded');
    expect(result.cancelled).toBe(false);
    expect(result.outcome.completeness).toBe('complete');
    expect(result.findings).toHaveLength(1);
  });
});

// ---- 5. Provider-read cancel: ledger and coverage stay clean of a discarded late read --------

describe('16.5: a provider read that resolves after cancellation never enters the evidence ledger or counts as coverage', () => {
  it('a readDiff response that arrives after cancellation was requested is excluded from the reported checkpoint’s evidence sources and leaves the file uninspected', async () => {
    const cancellation = fakeCancellationToken();
    const connection = reviewConnection({
      files: ['file1.ts'],
      readDiff: async (request) => {
        // Cancel right as this call starts, then resolve on a later microtask — a late response
        // racing a cancellation that landed just before it.
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
    const checkpoints: CheckpointInfo[] = [];
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: seam,
      policy: testPolicy(),
      cancellation: cancellation.token,
      onCheckpoint: (info) => {
        checkpoints.push(info);
      },
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('cancelled');
    // The final (persisting) checkpoint is the authoritative last word on ledger/coverage state.
    const finalCheckpoint = checkpoints[checkpoints.length - 1];
    expect(finalCheckpoint).toBeDefined();
    // Bootstrap legitimately registered the change-request detail as evidence before the cancelled
    // readDiff was ever dispatched — that entry is correct and expected. What must never appear is
    // any evidence source whose location cites `file1.ts`: that would be the discarded late read
    // leaking into the ledger.
    expect(finalCheckpoint?.evidenceSources.some((source) => source.locations.some((loc) => loc.path === 'file1.ts'))).toBe(false);
    const fileRecord = finalCheckpoint?.coverage.find((c) => c.memberId === 'm1')?.files.find((f) => f.path === 'file1.ts');
    expect(fileRecord?.state).not.toBe('inspected');
    expect(finalCheckpoint?.unresolved.unresolvedFetches).toBe(0);
  });
});

// ---- 6. Hostile pair, real end to end: a provider that ignores cancellation, then answers late ----

/** `readDiff` never resolves or rejects on its own — the deferred is only settled by the test, standing in for a provider transport that genuinely never notices a cancellation request. */
function hostileConnection(files: readonly string[]): { connection: Connection; readDiffStarted: () => boolean; resolveReadDiff: (path: string) => void } {
  let started = false;
  let resolveFn: (() => void) | undefined;
  const connection = fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult(),
    listChangedFiles: async () => manifestResult(files),
    readDiff: (request) => {
      started = true;
      return new Promise<DiffPageResult>((resolve) => {
        resolveFn = () => resolve(diffPageResult(request.path));
      });
    },
    getCurrentHead: async () => currentHeadResult(),
  });
  return {
    connection,
    readDiffStarted: () => started,
    resolveReadDiff: () => resolveFn?.(),
  };
}

function realHarnessFactory(connection: Connection, onCheckpointCapture: (info: CheckpointInfo) => void): ReviewHarnessFactory {
  const build = (_input: RunInput, options: HarnessAttemptRunOptions) =>
    createHarnessAttempt({
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: scriptedModelSeam({
        planning: [PLAN_TURN],
        investigating: [messages(readDiffMessage('src/a.ts')), STOP_TURN],
        verifying: [STOP_TURN],
      }),
      policy: testPolicy(),
      clock: makeClock(),
      now: () => new Date(2026, 0, 1).toISOString(),
      cancellation: options.cancellation,
      onCheckpoint: (info) => {
        onCheckpointCapture(info);
        return options.onCheckpoint?.(info);
      },
    });
  return { create: build, createDemo: build, resume: build };
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, update: async (key, value) => { map.set(key, value); } };
}

function crInput(refLabel: string): RunInput {
  return {
    target: { kind: 'cr', ref: { repoId: 'repo-1', number: '42' }, baseSha: 'base1', headSha: 'head1' },
    refLabel,
    podId: 'pod-a',
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: 'Default review',
    modelId: 'test-model',
    effort: 'none',
    timeouts: { inactivityMs: 90_000, ceilingMs: 600_000 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    demo: false,
  };
}

describe('16.5: hostile pair, proved end to end through a real attempt and a real ReviewRunManager', () => {
  it('a provider that never notices cancellation still settles the run, bounded by the manager’s cancel grace — and the same provider finally answering late does not resurrect or corrupt anything', async () => {
    const { connection, readDiffStarted, resolveReadDiff } = hostileConnection(['src/a.ts']);
    const checkpoints: CheckpointInfo[] = [];
    let expireGrace: (() => void) | undefined;
    const workspaceState = memoryStore();
    const runs = new ReviewRunManager({
      workspaceState,
      globalState: memoryStore(),
      runners: realHarnessFactory(connection, (info) => checkpoints.push(info)),
      cancelGrace: () => new Promise<void>((resolve) => { expireGrace = resolve; }),
    });

    const record = runs.trigger(crInput('!42'), 3);
    // Wait for the hostile readDiff call to genuinely be in flight before cancelling — the
    // cancellation must land *during* the hung provider call, not before it.
    await vi.waitFor(() => expect(readDiffStarted()).toBe(true));

    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    // Only the checkpoints from *before* the hang exist so far (bootstrap, planning, and the
    // investigating phase-boundary one — all fired before the phase loop ever asked the model for
    // the turn that dispatched the hung read) — none of them show `src/a.ts` as read.
    expect(checkpoints.length).toBeGreaterThan(0);
    expect(checkpoints.every((c) => c.evidenceSources.every((source) => source.locations.every((loc) => loc.path !== 'src/a.ts')))).toBe(true);
    const preHangCheckpointCount = checkpoints.length;

    // Nothing cooperative is coming from this provider; only the bounded grace timeout moves the
    // record on, exactly as `reviewRunManager.test.ts`'s own hand-rolled-fake version of this
    // property already proves for a fake attempt — this is the same guarantee, now proved for a
    // real attempt whose dispatcher is genuinely stuck awaiting a provider call.
    expireGrace?.();
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());
    expect(workspaceState.get(draftKeyFor({ repoId: 'repo-1', number: '42' }))).toBeUndefined();
    expect(workspaceState.get(partialDraftKeyFor({ repoId: 'repo-1', number: '42' }))).toBeUndefined();

    // The provider finally answers, long after the manager already gave up on it. The real
    // dispatcher's own post-await cancellation guard (`cancelledBeforeRegistration`,
    // `harnessToolDispatcher.ts`) discards it before it ever reaches the ledger, and the real
    // attempt then runs to its own `cancelled` terminus — but the manager's settlement already
    // happened, and task 12.4's late-result guard means none of that resurrects or overwrites the
    // record, or produces a second write to storage.
    resolveReadDiff('src/a.ts');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs.get(record.key)).toBeUndefined();
    expect(workspaceState.get(draftKeyFor({ repoId: 'repo-1', number: '42' }))).toBeUndefined();
    expect(workspaceState.get(partialDraftKeyFor({ repoId: 'repo-1', number: '42' }))).toBeUndefined();
    // The late-arriving read never entered any checkpoint's evidence sources either — whatever the
    // now-unblocked attempt reports on its own way to its (unobserved-by-anyone) cancelled
    // terminus, none of it ever shows the discarded content as registered evidence, and no *new*
    // checkpoint materialized a `src/a.ts` source that wasn't already excluded above.
    expect(checkpoints.length).toBeGreaterThanOrEqual(preHangCheckpointCount);
    expect(checkpoints.every((c) => c.evidenceSources.every((source) => source.locations.every((loc) => loc.path !== 'src/a.ts')))).toBe(true);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
