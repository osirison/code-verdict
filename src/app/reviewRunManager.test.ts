import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENT_DESCRIPTOR, DEMO_AGENT_DESCRIPTOR } from './agents';
import { ReviewRunStore, type ReviewRun } from './reviewRuns';
import { crKey } from './postedReviews';
import { partialDraftKeyFor, readRetained, runKeyForCr, type SessionDraft } from './retainedReview';
import {
  InFlightRunStore,
  ReviewRunManager,
  deriveRunControls,
  isLegalRunTransition,
  legacyStatusFor,
  sweepInterruptedRuns,
  type HarnessAttemptRunOptions,
  type ReviewHarnessFactory,
  type RunControls,
  type RunInput,
  type RunRecord,
  type RunStatus,
} from './reviewRunManager';
import type { CheckpointInfo, HarnessAttemptResult } from './harnessAttempt';
import type { CompletionBlockerDetail } from './harnessCompletion';
import { appendActivityEvent, createActivityLog } from './harnessActivityLog';
import { buildCheckpoint, computeSnapshotDigest, INITIAL_RETRY_STATE, type CheckpointBuildInput, type PersistedCheckpoint } from './harnessCheckpoint';
import { createHarnessRunStore, type HarnessRunStore } from './harnessRunStore';
import { resumeBudgetModeFor } from './harnessResume';
import type { CitedEvidenceRef, TrackedCandidate, ValidatedFinding } from './harnessCandidateValidation';
import type { LedgerEvidenceSource } from './harnessEvidenceLedger';
import { sha256Hex } from './contentDigest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { RUN_LIFECYCLES, type RunLifecycle } from '../domain/harnessLifecycle';
import type { Limitation, RunPhase } from '../domain/harnessActivity';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { AgentRunTimeouts } from './lmAgent';
import type { AgentReviewResponse } from '../domain/agentResponse';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';

function memoryStore(): KeyValueStore & { snapshot(): Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    // Synchronous write, then a resolved promise — the contract `storage.ts`
    // states and every real `Memento` satisfies.
    update: async (key, value) => {
      map.set(key, value);
    },
    // Real `vscode.Memento` carries this (production wires `context.globalState` in directly —
    // see `extension.ts`); `sweepInterruptedRuns`'s markerless branch (`harnessRunStore.listLineages`)
    // depends on it to scan every stored lineage rather than only ones a leftover marker names.
    // Without it here, `store.keys?.()`'s own optional-call fallback silently returns `[]` and that
    // branch never finds anything — every test exercising it needs this, not only the ones that
    // already happen to pass an explicit marker.
    keys: () => [...map.keys()],
    snapshot: () => map,
  };
}

/**
 * The shipped defaults, written out rather than imported: `lmAgent.ts` reaches
 * for `vscode` at module load, and the manager under test deliberately does
 * not — importing a value from there would drag the editor into a test that
 * has no need of it.
 */
const TIMEOUTS: AgentRunTimeouts = { firstOutputMs: 300_000, inactivityMs: 90_000, ceilingMs: 600_000 };

/** Task 15.8: `RunInput` carries only the revision identity, never the whole diff. */
const BASE_SHA = 'base-1';
const HEAD_SHA = 'head-1';

function response(itemCount: number, headSha = 'head-1'): AgentReviewResponse {
  return {
    schemaVersion: '1',
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    agentLabel: 'Default review',
    headSha,
    items: Array.from({ length: itemCount }, (_, index) => ({
      id: `i${index}`,
      file: 'src/a.ts',
      anchored: true,
      line: 1,
      severity: 'major' as const,
      category: 'security' as const,
      confidence: 90,
      title: `Finding ${index}`,
      body: 'Body',
      code: 'const a = 1;',
    })),
    candidates: [],
  };
}

function crInput(number: string, over: Partial<RunInput> = {}): RunInput {
  return {
    target: { kind: 'cr', ref: { repoId: 'repo-1', number }, baseSha: BASE_SHA, headSha: HEAD_SHA },
    refLabel: `!${number}`,
    podId: 'pod-a',
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: 'Default review',
    modelId: 'lm:acme/turbo',
    effort: 'none',
    timeouts: TIMEOUTS,
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    demo: false,
    ...over,
  };
}

// ---- Task 12.1: a real `ReviewHarnessFactory`, driven directly ---------------------

/** A minimal, all-zero `BudgetConsumption` — no test below reads it back. */
const ZERO_BUDGET: BudgetConsumption = {
  modelTurnsUsed: 0,
  toolCallsUsed: 0,
  evidenceBytesUsed: 0,
  elapsedMs: 0,
  highRiskReserveUsed: 0,
  verificationReserveUsed: 0,
};

/** An activity log whose one event is tagged `phase` — enough for `reduceActivity` (inside `applyCheckpoint`) to derive the matching `RunLifecycle`. */
function activityLogAt(phase: RunPhase, runId: string): CheckpointInfo['activityLog'] {
  const log = createActivityLog(runId, runId, 1);
  return appendActivityEvent(
    log,
    { kind: 'actionStarted', action: `Entering ${phase}` },
    { occurredAt: new Date().toISOString(), phase, elapsedMs: 0 },
  );
}

/** A `CheckpointInfo` reporting phase `phase` for `refLabel` — what a real attempt's `onCheckpoint` hands the manager. */
function checkpointAt(phase: RunPhase, refLabel: string): CheckpointInfo {
  return {
    checkpointId: `ckpt-${refLabel}-${phase}`,
    runId: refLabel,
    lineageId: refLabel,
    attempt: 1,
    phase,
    reason: 'phaseBoundary',
    occurredAt: new Date().toISOString(),
    elapsedMs: 0,
    activityLog: activityLogAt(phase, refLabel),
    evidenceSources: [],
    candidates: [],
    contradicted: [],
    budget: ZERO_BUDGET,
    coverage: [],
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
  };
}

/** A terminal `HarnessAttemptResult` built from the same `response(...)` shape every other test already uses — `.item` is the only `ValidatedFinding` field `completeAttempt` ever reads (`reviewRunManager.ts`'s own note). */
function succeededResult(itemCount: number, refLabel = 'run'): HarnessAttemptResult {
  const items = response(itemCount).items;
  return {
    runId: refLabel,
    lineageId: refLabel,
    attempt: 1,
    lifecycle: 'succeeded',
    outcome: {
      kind: itemCount > 0 ? 'completeFindings' : 'completeClean',
      completeness: 'complete',
      findingCount: itemCount,
      limitations: [],
      replacesRetainedReview: true,
      clean: itemCount === 0,
    },
    findings: items.map((item) => ({ item }) as unknown as ValidatedFinding),
    activityLog: createActivityLog(refLabel, refLabel, 1),
    cancelled: false,
    small: true,
    turnsUsed: 1,
    toolCallsUsed: 1,
    contradicted: [],
  };
}

/** `itemCount > 0` produces a `partial` outcome with real findings (D11: "the run persists a partial result plus... limitation report") rather than a plain `none`-completeness failure. `blockerDetails` mirrors `CompletionOutcome.blockerDetails` (task: "say which files, not just that some files") — absent by default, matching every existing caller that never set it. */
function failedResult(message: string, refLabel = 'run', itemCount = 0, blockerDetails?: readonly CompletionBlockerDetail[], extraLimitations?: readonly Limitation[]): HarnessAttemptResult {
  const items = response(itemCount).items;
  return {
    runId: refLabel,
    lineageId: refLabel,
    attempt: 1,
    lifecycle: 'failed',
    outcome: {
      kind: itemCount > 0 ? 'partialFindings' : 'failed',
      completeness: itemCount > 0 ? 'partial' : 'none',
      findingCount: itemCount,
      limitations: [{ code: 'harness.test', message }, ...(extraLimitations ?? [])],
      replacesRetainedReview: false,
      clean: false,
      ...(blockerDetails ? { blockerDetails } : {}),
    },
    findings: items.map((item) => ({ item }) as unknown as ValidatedFinding),
    activityLog: createActivityLog(refLabel, refLabel, 1),
    cancelled: false,
    small: true,
    turnsUsed: 1,
    toolCallsUsed: 1,
    contradicted: [],
  };
}

/** The cancelled counterpart to `failedResult` — `itemCount > 0` produces the same `partial` outcome shape D11 describes for "cancellation follows a validated partial result". */
function cancelledResult(refLabel = 'run', itemCount = 0): HarnessAttemptResult {
  const items = response(itemCount).items;
  return {
    runId: refLabel,
    lineageId: refLabel,
    attempt: 1,
    lifecycle: 'cancelled',
    outcome: {
      kind: itemCount > 0 ? 'partialFindings' : 'failed',
      completeness: itemCount > 0 ? 'partial' : 'none',
      findingCount: itemCount,
      limitations: itemCount > 0 ? [{ code: 'cancelled', message: 'The reviewer cancelled the run before completion.' }] : [],
      replacesRetainedReview: false,
      clean: false,
    },
    findings: items.map((item) => ({ item }) as unknown as ValidatedFinding),
    activityLog: createActivityLog(refLabel, refLabel, 1),
    cancelled: true,
    small: true,
    turnsUsed: 1,
    toolCallsUsed: 1,
    contradicted: [],
  };
}

/**
 * A minimal, valid `ReviewRunSnapshot` for `runId`/`lineageId` — the same literal shape the Fix 2/Fix 3
 * incident tests below (and the pre-existing crash-catch test) all need to seed `harnessRunStore`
 * with before writing a checkpoint against it, factored out to avoid triplicating it.
 */
function fixtureHarnessSnapshot(runId: string, lineageId: string): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId,
    lineageId,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: 'm1',
        providerId: 'fixture',
        instanceUrl: 'https://example.test',
        ref: { repoId: 'repo-1', number: '2841' },
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
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
    effort: 'none',
    effortInstructionDigest: 'digest-effort',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'digest-extra',
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
  };
}

/** Shared by `controllableRunners`/`unresponsiveRunner`: the same items-in, `HarnessAttemptResult`-out conversion the deleted pre-harness `{lm, demo}` adapter (`reviewRunManager.ts`, removed task 15.8) used, kept here purely as a test fixture — never a shipped bypass. */
function resultFromResponse(refLabel: string, response: AgentReviewResponse): HarnessAttemptResult {
  return { ...succeededResult(response.items.length, refLabel), findings: response.items.map((item) => ({ item }) as unknown as ValidatedFinding) };
}

/**
 * A `ReviewHarnessFactory` whose every attempt is driven entirely by the
 * test, one deferred `AgentReviewResponse` per target — `pending.get(key)!
 * .resolve(response)` concludes `.run()` with the equivalent
 * `HarnessAttemptResult` (`resultFromResponse`), and `.reject(error)`
 * rejects `.run()` with that error unchanged, for the genuine-crash path
 * `executeAttempt`'s `catch` still covers. Tests that need the checkpoint/
 * waiting/resuming hooks use `controllableAttempts` below instead, which
 * drives a real `ReviewHarnessFactory` directly with a `HarnessAttemptResult`
 * already in hand.
 */
function controllableRunners(): {
  started: string[];
  cancelled: string[];
  pending: Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>;
  warningsOf: Map<string, HarnessAttemptRunOptions['onAttachmentWarnings']>;
  runners: ReviewHarnessFactory;
} {
  const pending = new Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>();
  const started: string[] = [];
  const cancelled: string[] = [];
  const warningsOf = new Map<string, HarnessAttemptRunOptions['onAttachmentWarnings']>();
  function build(input: RunInput, options: HarnessAttemptRunOptions) {
    const key = input.refLabel;
    started.push(key);
    warningsOf.set(key, options.onAttachmentWarnings);
    return {
      run: () =>
        new Promise<HarnessAttemptResult>((resolve, reject) => {
          pending.set(key, { resolve: (r) => resolve(resultFromResponse(key, r)), reject });
          options.cancellation.onCancellationRequested(() => {
            cancelled.push(key);
            // What a real transport does when its token trips.
            reject(Object.assign(new Error('run cancelled'), { cancelled: true, requestId: 'abc123' }));
          });
        }),
    };
  }
  const runners: ReviewHarnessFactory = { create: build, createDemo: build, resume: build };
  return { started, cancelled, pending, warningsOf, runners };
}

/** Drop-in replacement for the old `{lm, demo}` fixture shape at a call site that only ever needed an immediate, uncontrolled resolution — `demoItemCount` for a `RunInput.demo` run, defaulting to the same count as the model-backed path. */
function instantRunners(itemCount: number, demoItemCount = itemCount): ReviewHarnessFactory {
  function build(input: RunInput) {
    return { run: () => Promise.resolve(succeededResult(input.demo ? demoItemCount : itemCount, input.refLabel)) };
  }
  return { create: build, createDemo: build, resume: build };
}

/**
 * A `ReviewHarnessFactory` whose every attempt is driven entirely by the
 * test: `pending.get(key)!.resolve(...)`/`.reject(...)` conclude `.run()`
 * directly with a `HarnessAttemptResult` (or a thrown error, for the
 * genuine-crash path `executeAttempt`'s `catch` still covers), and
 * `optionsOf.get(key)!.onCheckpoint`/`.onEnterWaiting`/`.onResuming` invoke
 * the exact hooks `HarnessAttemptRunOptions` exposes — task 12.1's real
 * integration point.
 */
function controllableAttempts(): {
  started: string[];
  cancelled: string[];
  pending: Map<string, { resolve(result: HarnessAttemptResult): void; reject(error: unknown): void }>;
  optionsOf: Map<string, HarnessAttemptRunOptions>;
  runners: ReviewHarnessFactory;
} {
  const pending = new Map<string, { resolve(result: HarnessAttemptResult): void; reject(error: unknown): void }>();
  const optionsOf = new Map<string, HarnessAttemptRunOptions>();
  const started: string[] = [];
  const cancelled: string[] = [];
  function build(input: RunInput, options: HarnessAttemptRunOptions) {
    started.push(input.refLabel);
    optionsOf.set(input.refLabel, options);
    options.cancellation.onCancellationRequested(() => cancelled.push(input.refLabel));
    return {
      run: () =>
        new Promise<HarnessAttemptResult>((resolve, reject) => {
          pending.set(input.refLabel, { resolve, reject });
        }),
    };
  }
  const runners: ReviewHarnessFactory = { create: build, createDemo: build, resume: build };
  return { started, cancelled, pending, optionsOf, runners };
}

/**
 * A `globalState` wrapper whose `update` throws exactly once — consumed by the first write whose key
 * starts with `codeVerdict.harness.lineage.` after `arm()` is called — then reverts to delegating
 * normally. Lets a test make one specific `harnessRunStore.writeCheckpoint` call fail (the finding-1
 * retry test) without disturbing any other write, including a *later* checkpoint write to the same
 * lineage (the finding-2 same-lineage leftover-close test, which needs attempt 1's write to fail but
 * attempt 2's admission-time close of it to still succeed).
 */
function throwOnceForNextLineageWrite(base: ReturnType<typeof memoryStore>): { store: ReturnType<typeof memoryStore>; arm(): void } {
  let armed = false;
  const store: ReturnType<typeof memoryStore> = {
    get: base.get,
    keys: base.keys,
    snapshot: base.snapshot,
    update: async (key, value) => {
      if (armed && key.startsWith('codeVerdict.harness.lineage.')) {
        armed = false;
        throw new Error('simulated harnessRunStore write failure');
      }
      await base.update(key, value);
    },
  };
  return { store, arm: () => { armed = true; } };
}

function manager(
  over: Partial<ConstructorParameters<typeof ReviewRunManager>[0]> = {},
): {
  runs: ReviewRunManager;
  workspaceState: ReturnType<typeof memoryStore>;
  globalState: ReturnType<typeof memoryStore>;
  changes: RunRecord[];
} {
  const workspaceState = memoryStore();
  const globalState = memoryStore();
  const changes: RunRecord[] = [];
  const runs = new ReviewRunManager({
    workspaceState,
    globalState,
    runners: instantRunners(1),
    onChange: (record) => changes.push(record),
    // Never resolves by default: a test that does not care about the cancel
    // grace timeout must never have it race ahead of a live attempt's own
    // cancelled result. Only the dedicated timeout test below overrides this
    // with something that actually settles.
    cancelGrace: () => new Promise<void>(() => {}),
    ...over,
  });
  return { runs, workspaceState, globalState, changes };
}

describe('a run completes with nobody watching', () => {
  it('writes the retained review and records the run for a finish no screen saw', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: instantRunners(2, 0),
    });

    runs.trigger(crInput('2841'), 3);
    // No subscriber, no panel, nothing rendering — the point of the change.
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());

    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    expect(retained?.outcome).toBe('findings');
    expect(retained?.draft.review.items).toHaveLength(2);
    expect(retained?.agentLabel).toBe('Default review');
    expect(retained?.ranAt).toBeDefined();

    const recorded = new ReviewRunStore(globalState).list();
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ repoId: 'repo-1', crNumber: '2841', outcome: 'findings', findingCount: 2 });
  });

  // succeeded-settle-before-history-write: the durable `ReviewRunStore` row (what the dashboard/run
  // history reads) must land BEFORE `settle()` clears the `InFlightRunStore` marker — a process death
  // in between the two used to leave the marker gone (nothing left for a future sweep to backfill
  // from) with the history row never having landed, permanently hiding a genuinely succeeded run from
  // run history. Observed here as write ORDER on the underlying store, not merely "both eventually
  // land" — the two are independent async writes and only their order makes the invariant true.
  it('the ReviewRunStore write lands before the InFlightRunStore marker is cleared, so a death in between leaves the marker for the next sweep to find rather than a lost history row', async () => {
    const globalState = memoryStore();
    const writes: string[] = [];
    const instrumented: KeyValueStore = {
      get: globalState.get,
      keys: globalState.keys,
      update: async (key, value) => {
        if (key === 'codeVerdict.reviewRuns') writes.push('reviewRuns');
        if (key === 'codeVerdict.inFlightRuns') writes.push('inFlightRuns');
        await globalState.update(key, value);
      },
    };
    const runs = new ReviewRunManager({
      workspaceState: memoryStore(),
      globalState: instrumented,
      runners: instantRunners(2, 0),
      cancelGrace: () => new Promise<void>(() => {}),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(writes).toContain('inFlightRuns'));

    const reviewRunsIndex = writes.indexOf('reviewRuns');
    const inFlightClearIndex = writes.lastIndexOf('inFlightRuns');
    // Two `inFlightRuns` writes happen in total (the `add` at admission, the `remove` at settle) —
    // this asserts against the LAST one, the marker-clearing write, which is the one that matters:
    // once it lands, nothing will ever revisit this lineage again.
    expect(reviewRunsIndex).toBeGreaterThanOrEqual(0);
    expect(reviewRunsIndex).toBeLessThan(inFlightClearIndex);
  });

  it('writes a clean run as a record rather than as a deletion', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: instantRunners(0),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());

    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    // A clean run is a result, not the absence of one: it keeps the head it
    // read and the agent that read it, so the screen can be re-opened.
    expect(retained?.outcome).toBe('clean');
    expect(retained?.draft.review.items).toEqual([]);
    expect(retained?.draft.review.headSha).toBe('head-1');
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ outcome: 'clean', findingCount: 0 });
  });

  it('announces the finished review with the pod it belonged to', async () => {
    const ready: unknown[] = [];
    const { runs } = manager({
      runners: instantRunners(3, 0),
      onReviewReady: (info) => ready.push(info),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(ready).toHaveLength(1));

    expect(ready[0]).toEqual({
      ref: { repoId: 'repo-1', number: '2841' },
      refLabel: '!2841',
      itemCount: 3,
      completeness: 'complete',
      // The notification's open action resolves a ref against the *active*
      // pod, so a run that finished after a switch has to be able to say it is
      // not about this one.
      podId: 'pod-a',
    });
  });

  it('writes the retained review before telling anyone the run succeeded', async () => {
    // A panel watching its own run reacts to `succeeded` by reading the record
    // back off the store. Notified first, it would read the PREVIOUS run's
    // review — or an empty screen — and nothing would repaint when the write
    // landed a microtask later.
    const workspaceState = memoryStore();
    const seenAtNotify: Array<SessionDraft | undefined> = [];
    const { runs } = manager({
      workspaceState,
      runners: instantRunners(2, 0),
      onChange: (record) => {
        if (record.status === 'succeeded') {
          seenAtNotify.push(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
        }
      },
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(seenAtNotify).toHaveLength(1));
    expect(seenAtNotify[0]?.review.items).toHaveLength(2);
  });

  it('records the run before telling anything to repaint', async () => {
    // The callback fans out to views that read this very store; firing it
    // first repaints them onto the previous run.
    const seen: number[] = [];
    const globalState = memoryStore();
    const { runs } = manager({
      globalState,
      runners: instantRunners(1, 0),
      onRunRecorded: () => seen.push(new ReviewRunStore(globalState).list().length),
    });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toBe(1);
  });
});

describe('one run per target, several targets at once', () => {
  it('refuses a second run on a target already running, and leaves the first alone', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const first = runs.trigger(crInput('2841'), 3);
    const second = runs.trigger(crInput('2841'), 3);

    // Not a second request, and not a replacement of the first.
    expect(started).toEqual(['!2841']);
    expect(second.key).toBe(first.key);
    expect(second.status).toBe('running');
    expect(pending.size).toBe(1);
  });

  it('returns the identical queued record when the same target is triggered again before it starts', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    // Fill the only slot with a different target so the next trigger for '2841' queues.
    runs.trigger(crInput('other'), 1);
    const queued = runs.trigger(crInput('2841'), 1);
    expect(queued.status).toBe('queued');

    const second = runs.trigger(crInput('2841'), 1);
    expect(second).toBe(queued);

    pending.get('!other')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!other', '!2841']));
    // The repeated trigger did not queue a second dispatch for the same target.
    expect(started.filter((label) => label === '!2841')).toHaveLength(1);
  });

  it('runs two different change requests at the same time', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    runs.trigger(crInput('2842'), 3);
    expect(started).toEqual(['!2841', '!2842']);

    // They finish in the opposite order to make sure nothing is positional.
    pending.get('!2842')!.resolve(response(1));
    pending.get('!2841')!.resolve(response(2));

    await vi.waitFor(() => {
      expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined();
      expect(workspaceState.get('codeVerdict.draft.repo-1!2842')).toBeDefined();
    });
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(2);
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2842'))?.draft.review.items).toHaveLength(1);
  });

  it('allows a new run once the previous one on that target has finished', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(0));
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));

    runs.trigger(crInput('2841'), 3);
    expect(started).toEqual(['!2841', '!2841']);
  });
});

describe('the concurrency cap and its queue', () => {
  it('queues past the limit and starts in trigger order as slots free', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 2);
    runs.trigger(crInput('2'), 2);
    const third = runs.trigger(crInput('3'), 2);
    const fourth = runs.trigger(crInput('4'), 2);

    expect(started).toEqual(['!1', '!2']);
    // Accepted and held, not rejected and not failed.
    expect(third.status).toBe('queued');
    expect(fourth.status).toBe('queued');

    pending.get('!1')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2', '!3']));
    pending.get('!2')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2', '!3', '!4']));
  });

  it('never queues when the limit is removed', () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    for (const number of ['1', '2', '3', '4', '5', '6']) runs.trigger(crInput(number), 0);

    expect(started).toHaveLength(6);
    expect(runs.active().every((record) => record.status === 'running')).toBe(true);
  });

  it('frees the slot when a run fails, so the queue is not stuck behind it', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    runs.trigger(crInput('2'), 1);
    expect(started).toEqual(['!1']);

    pending.get('!1')!.reject(Object.assign(new Error('model exploded'), { requestId: 'req-1' }));
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));
  });
});

describe('cancellation', () => {
  it('cancels the request, frees the slot at once, and starts the queued run', async () => {
    const { started, cancelled, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    const queued = runs.trigger(crInput('2'), 1);
    expect(queued.status).toBe('queued');

    runs.cancel(runs.active()[0]!.key);

    // The request is stopped, not merely stopped being listened to.
    expect(cancelled).toEqual(['!1']);
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));
    expect(pending.size).toBe(2);
  });

  it('drops a queued run without ever making a request, and advances the ones behind it', async () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 1);
    const second = runs.trigger(crInput('2'), 1);
    runs.trigger(crInput('3'), 1);

    runs.cancel(second.key);
    expect(started).toEqual(['!1']);

    // Its place in the queue is gone, and the one behind it moves up.
    runs.cancel(runs.active().find((record) => record.status === 'running')!.key);
    await vi.waitFor(() => expect(started).toEqual(['!1', '!3']));
  });

  it('leaves an earlier retained review exactly as it was', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    const before = workspaceState.get('codeVerdict.draft.repo-1!2841');

    // A re-run, cancelled halfway.
    runs.trigger(crInput('2841'), 3);
    runs.cancel(runs.active()[0]!.key);
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(before);
  });

  it('leaves an earlier retained review alone when a re-run fails', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    const before = workspaceState.get('codeVerdict.draft.repo-1!2841');

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(Object.assign(new Error('timed out'), { timedOut: true, requestId: 'r' }));
    await vi.waitFor(() => expect(runs.get(runs.get('repo-1!2841')?.key ?? 'repo-1!2841')?.status).toBe('failed'));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(before);
  });

  it('cancels a pod\'s runs when that pod is deleted, and only that pod\'s', async () => {
    const { cancelled, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('1'), 0);
    runs.trigger(crInput('2', { podId: 'pod-b', refLabel: '!2' }), 0);

    runs.cancelForPod('pod-a');

    // The token fires at once; '!1' itself only reaches `cancelling` here — it
    // settles once its own cancelled result reports back (this legacy runner
    // auto-rejects on the token, but only the `executeAttempt` catch that
    // rejection resolves into is what actually moves the record on).
    expect(cancelled).toEqual(['!1']);
    await vi.waitFor(() => expect(runs.active().map((r) => r.input.podId)).toEqual(['pod-b']));
  });
});

describe('reviewer-initiated cancellation keeps validated findings (D11\'s cancellation MAY, resolved)', () => {
  const PARTIAL_KEY = partialDraftKeyFor({ repoId: 'repo-1', number: '2841' });

  it('cancelling a run with already-validated findings keeps them as a partial, explicitly marked incomplete, persisted before the notification fires', async () => {
    const { pending, runners } = controllableAttempts();
    const seenAtNotify: unknown[] = [];
    const { runs, workspaceState } = manager({
      runners,
      onChange: (record) => {
        if (record.status === 'cancelled') seenAtNotify.push(workspaceState.get(PARTIAL_KEY));
      },
    });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    // The reviewer's cancel does not itself settle the record — it moves to
    // `cancelling` and waits for the dispatched attempt's own answer.
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    // The attempt reports back with whatever it had already validated before
    // the cancellation reached it.
    pending.get('!2841')!.resolve(cancelledResult('!2841', 2));
    await vi.waitFor(() => expect(seenAtNotify).toHaveLength(1));

    // Write-before-notify: the durable partial was already there the moment
    // a listener reacted to the cancelled notification — the same discipline
    // the failed path's own durable write already keeps.
    expect(seenAtNotify[0]).toBeDefined();
    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    expect(partial?.completeness).toBe('partial');
    expect(partial?.draft.review.items).toHaveLength(2);
    // Never the target's retained review — a cancelled run never replaces a
    // complete one, partial or not (D11).
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });

  it('cancelling a run with no findings yet settles as cancelled with no partial written', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    pending.get('!2841')!.resolve(cancelledResult('!2841', 0));
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    expect(workspaceState.get(PARTIAL_KEY)).toBeUndefined();
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });

  it('an attempt that ignores cancellation and never reports back settles as cancelled with no findings once the bounded timeout elapses, rather than staying in cancelling forever', async () => {
    const { pending, runners } = controllableAttempts();
    let expireGrace: (() => void) | undefined;
    const { runs, workspaceState } = manager({
      runners,
      cancelGrace: () => new Promise<void>((resolve) => { expireGrace = resolve; }),
    });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    // This fixture's attempt never resolves or rejects at all — nothing
    // cooperative is coming. Only the bounded grace timeout moves the record
    // on; firing it here stands in for real time actually elapsing.
    expireGrace?.();
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    expect(workspaceState.get(PARTIAL_KEY)).toBeUndefined();
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();

    // A late report, arriving after the grace timeout already gave up, must
    // not resurrect or overwrite the record either — the same late-result
    // guard (task 12.4) that protects every other terminal settlement.
    pending.get('!2841')!.resolve(cancelledResult('!2841', 2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs.get(record.key)).toBeUndefined();
    expect(workspaceState.get(PARTIAL_KEY)).toBeUndefined();
  });

  // `cancelling`'s only legal edge is to `cancelled` (`buildLegalRunTransitions`).
  // The three tests below prove every other shape a dispatched attempt can still
  // report — a plain crash, a `failed` result, or a `succeeded` one, each from an
  // attempt that never actually noticed the cancellation token — is reclassified
  // as a cancellation rather than settling illegally (silently stranding the
  // record in `cancelling` until `armCancelGrace`'s fallback) or, worse for the
  // `succeeded` case, reporting a run the reviewer stopped as done.

  it('a plain crash arriving after the reviewer cancelled settles promptly as cancelled, without waiting on the grace timeout', async () => {
    const { pending, runners } = controllableAttempts();
    // The default `cancelGrace` never resolves — settling promptly here
    // proves this path does not depend on it at all.
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    pending.get('!2841')!.reject(new Error('boom'));
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
    expect(workspaceState.get(PARTIAL_KEY)).toBeUndefined();
  });

  it('a failed result with validated findings, arriving after the reviewer cancelled, still keeps them as a partial rather than stranding the record', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    expect(partial?.completeness).toBe('partial');
    expect(partial?.draft.review.items).toHaveLength(2);
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });

  it('a succeeded result from an attempt that ignored cancellation is never reported as success — it settles cancelled, keeping findings only as a partial', async () => {
    const { pending, runners } = controllableAttempts();
    const ready: unknown[] = [];
    const { runs, globalState, workspaceState } = manager({
      runners,
      onReviewReady: (info) => ready.push(info),
    });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');

    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    // No "review ready" notification, and no retained review written — the
    // reviewer cancelled this run; it must not silently report as done.
    expect(ready).toHaveLength(0);
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
    // What the model validated before the manager stopped listening for a
    // success is still kept — as a partial, exactly like any other cancellation.
    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    expect(partial?.completeness).toBe('partial');
    expect(partial?.draft.review.items).toHaveLength(2);
    // Run history records this as a partial outcome too, never as a clean
    // success — the succeeded branch's own 'findings'/'clean' write never runs.
    expect(new ReviewRunStore(globalState).list()).toEqual([
      expect.objectContaining({ outcome: 'partial', findingCount: 2 }),
    ]);
  });

  // cancel-vs-succeed-completeAttempt-race: unlike the test above (cancel lands BEFORE the succeeded
  // result even arrives, so `completeAttempt`'s own entry-time reclassification already catches it),
  // this cancels DURING `completeAttempt`'s own retained-review write — the exact window the blocker
  // finding traced (`verifyOrRecoverTerminalWrite`, or either `workspaceState.update`) — which a
  // single entry-time check cannot see because `cancelling` is not a terminal lifecycle.
  it('cancel() landing during the retained-review write settles the record as cancelled, never a false "review ready"/"findings" broadcast', async () => {
    const { pending, runners } = controllableAttempts();
    const ready: unknown[] = [];
    const globalState = memoryStore();
    const baseWorkspace = memoryStore();
    const recordKey = 'codeVerdict.draft.repo-1!2841';
    let releaseWrite: (() => void) | undefined;
    const workspaceState: KeyValueStore = {
      get: baseWorkspace.get,
      update: async (key, value) => {
        if (key === recordKey) {
          // Blocks exactly the retained-review write `completeAttempt` makes before `settle()` —
          // the reviewer's cancel is issued while this is still pending, below.
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        await baseWorkspace.update(key, value);
      },
    };
    const runs = new ReviewRunManager({
      workspaceState,
      globalState,
      runners,
      onReviewReady: (info) => ready.push(info),
      cancelGrace: () => new Promise<void>(() => {}),
    });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    // The record is still mid-flight (not yet 'cancelling') at this exact instant — this is the race
    // window a single entry-time check misses.
    expect(runs.get(record.key)?.lifecycle).not.toBe('cancelling');
    runs.cancel(record.key);
    releaseWrite!();

    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    // No false "review ready" toast, and the dashboard row must never claim 'findings' for a run the
    // reviewer stopped.
    expect(ready).toHaveLength(0);
    const rows = new ReviewRunStore(globalState).list();
    const row = rows.find((r) => r.repoId === 'repo-1' && r.crNumber === '2841');
    expect(row?.outcome).not.toBe('findings');
    expect(row).toMatchObject({ outcome: 'partial', findingCount: 2 });
  });

  // Second window of the same race, one step later: cancel() lands during the `runs.record` write
  // itself (checkpoint C, after the retained-review/partial-clear writes above have already landed),
  // and the underlying result has zero findings. The correction this method makes for that window
  // must not be gated on `partial` existing — the earlier branch's `if (settled && partial)` form is
  // right for a row that was never written, but here `runs.record` already landed a 'clean' row a
  // moment before the reclassify caught the cancel, so silence would leave a cancelled run reporting
  // itself clean in history.
  it('cancel() landing during the run-history write corrects a just-written "clean" row to partial, even with zero findings', async () => {
    const { pending, runners } = controllableAttempts();
    const ready: unknown[] = [];
    const globalState = memoryStore();
    let releaseWrite: (() => void) | undefined;
    const runsHistoryKey = 'codeVerdict.reviewRuns';
    let sawFirstRecordWrite = false;
    const delayedGlobalState: KeyValueStore = {
      get: globalState.get,
      update: async (key, value) => {
        if (key === runsHistoryKey && !sawFirstRecordWrite) {
          sawFirstRecordWrite = true;
          // Blocks exactly the `runs.record` write `completeAttempt` makes before its second
          // reclassify check — the reviewer's cancel is issued while this is still pending, below.
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        await globalState.update(key, value);
      },
    };
    const runs = new ReviewRunManager({
      workspaceState: memoryStore(),
      globalState: delayedGlobalState,
      runners,
      onReviewReady: (info) => ready.push(info),
      cancelGrace: () => new Promise<void>(() => {}),
    });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(0, '!2841'));
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());
    expect(runs.get(record.key)?.lifecycle).not.toBe('cancelling');
    runs.cancel(record.key);
    releaseWrite!();

    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    expect(ready).toHaveLength(0);
    const rows = new ReviewRunStore(globalState).list();
    const row = rows.find((r) => r.repoId === 'repo-1' && r.crNumber === '2841');
    // Never the 'clean' row the succeeded path wrote a moment earlier — a cancelled run, corrected.
    expect(row?.outcome).not.toBe('clean');
    expect(row).toMatchObject({ outcome: 'partial', findingCount: 0 });
  });
});

describe('a later success replaces the retained review', () => {
  it('overwrites the retained review written by an earlier successful run on the same target', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(2));
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(2);

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(response(5));
    await vi.waitFor(() => {
      expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(5);
    });
  });
});

describe('attribution is fixed at trigger', () => {
  it('records against the pod, agent and criteria the run started with', async () => {
    const { pending, runners } = controllableRunners();
    const ready: Array<{ podId: string }> = [];
    const { runs, globalState, workspaceState } = manager({
      runners,
      onReviewReady: (info) => ready.push(info),
    });

    const input = crInput('2841', { agentLabel: 'Security Reviewer', modelId: 'lm:acme/turbo' });
    runs.trigger(input, 3);

    // Everything the old `finishRun` would have re-read on the way out is now
    // changed underneath the run. None of it may reach the result.
    pending.get('!2841')!.resolve(response(1));
    await vi.waitFor(() => expect(ready).toHaveLength(1));

    expect(ready[0]?.podId).toBe('pod-a');
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'repo-1',
      crNumber: '2841',
      agentLabel: 'Security Reviewer',
    });
    const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
    expect(retained?.agentLabel).toBe('Security Reviewer');
    expect(retained?.modelId).toBe('lm:acme/turbo');
  });
});

describe('progress and transitions', () => {
  it('exposes attachment warnings during the run and retains them after completion', async () => {
    const { pending, warningsOf, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });
    const record = runs.trigger(crInput('2841'), 3);

    warningsOf.get('!2841')?.([{
      code: 'attachment-unreadable',
      attachmentId: 'schema',
      label: 'schema.ts',
      path: 'src/schema.ts',
      reason: 'ENOENT',
    }]);

    expect(runs.get(record.key)?.attachmentWarnings).toEqual([
      expect.objectContaining({ code: 'attachment-unreadable', path: 'src/schema.ts' }),
    ]);

    pending.get('!2841')!.resolve(response(1));
    await vi.waitFor(() => {
      const retained = readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'));
      expect(retained?.attachmentWarnings).toEqual([
        expect.objectContaining({ code: 'attachment-unreadable', path: 'src/schema.ts' }),
      ]);
    });
  });

  it('emits a finish at once even when it lands inside the checkpoint-repaint throttle', async () => {
    const { pending, optionsOf, runners } = controllableAttempts();
    let now = 1_000;
    const changes: RunRecord[] = [];
    const { runs } = manager({ runners, now: () => now, onChange: (r) => changes.push(r) });

    runs.trigger(crInput('2841'), 3);
    // A same-phase checkpoint repaints without forcing a notify (D14) —
    // resets the throttle window without itself counting as a transition.
    now += 1_000;
    optionsOf.get('!2841')!.onCheckpoint(checkpointAt('planning', '!2841'));
    const afterRepaint = changes.length;

    // Well inside the 250ms floor: a throttle applied to transitions would
    // swallow this and leave the screen on a spinner after the run was over.
    now += 10;
    pending.get('!2841')!.resolve(succeededResult(1, '!2841'));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(afterRepaint));
    expect(changes.at(-1)?.status).toBe('succeeded');
  });
});

describe('the demo agent runs in the background too', () => {
  it('walks its log and finishes with no screen attached', async () => {
    const { runs, workspaceState } = manager({
      runners: instantRunners(0, 1),
    });

    runs.trigger(crInput('2841', { demo: true, agent: DEMO_AGENT_DESCRIPTOR, modelId: undefined }), 3);

    // The walk used to be driven by the panel's own `render()`, so navigating
    // away mid-walk ended it. It runs here now, like every other run.
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    expect(readRetained(workspaceState.get<SessionDraft>('codeVerdict.draft.repo-1!2841'))?.draft.review.items).toHaveLength(1);
  });

  it('cancelling before the demo participant answers never writes a retained draft', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841', { demo: true }), 3);
    await vi.waitFor(() => expect(pending.get('!2841')).toBeDefined());
    runs.cancel(record.key);
    // The dispatched attempt answers for itself, same as any other run —
    // the manager's own cancel does not settle the record synchronously.
    pending.get('!2841')!.resolve(cancelledResult('!2841', 0));

    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });
});

describe('changeset runs', () => {
  it('records under the changeset identity, where no change-request row can match it', async () => {
    const { runs, workspaceState, globalState } = manager({
      runners: instantRunners(2, 0),
    });

    runs.trigger(
      crInput('ignored', {
        target: { kind: 'changeset', changesetId: 'cs-7', members: [] },
        refLabel: 'Payments rollout',
      }),
      3,
    );

    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.changesetDraft.cs-7')).toBeDefined());
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'changeset',
      crNumber: 'cs-7',
      outcome: 'findings',
    });
  });

  it('runs a changeset and a change request at the same time without colliding', () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    runs.trigger(
      crInput('2841', {
        target: { kind: 'changeset', changesetId: '2841', members: [] },
        refLabel: 'A changeset that shares the number',
      }),
      3,
    );

    // Prefixed keys: a changeset id can never be read as a `repoId!number`.
    expect(started).toHaveLength(2);
    expect(runs.active()).toHaveLength(2);
  });
});

// ---- Task 16.6: the same concurrency/queueing/target-isolation/retained-review guarantees
// proven for individual (cr) targets above, extended to changeset targets, and to a mix of both --

/** The same inline changeset-target shape `describe('changeset runs')` above already builds, factored out once this file needs it repeatedly. */
function changesetInput(changesetId: string, refLabel: string, over: Partial<RunInput> = {}): RunInput {
  return crInput('ignored', { target: { kind: 'changeset', changesetId, members: [] }, refLabel, ...over });
}

describe('task 16.6: global concurrency, one-run-per-target, waiting-slot release, queue fairness, and target isolation hold for changeset runs exactly as for individual reviews', () => {
  it('a shared global slot count and trigger-order queue fairness span both target kinds at once — a changeset does not get its own separate pool', async () => {
    const { started, pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    // Interleaved cr/changeset admission, limit 2: exactly the two earliest-triggered targets run,
    // regardless of kind, and the rest queue in the order they were triggered.
    runs.trigger(crInput('1'), 2);
    runs.trigger(changesetInput('cs-a', 'Changeset A'), 2);
    const third = runs.trigger(crInput('2'), 2);
    const fourth = runs.trigger(changesetInput('cs-b', 'Changeset B'), 2);

    expect(started).toEqual(['!1', 'Changeset A']);
    expect(third.status).toBe('queued');
    expect(fourth.status).toBe('queued');

    // Finishing order does not decide start order — original admission (trigger) order does: '2'
    // was queued before 'Changeset B', so it starts first once a slot frees, however the two
    // running slots happen to finish.
    pending.get('Changeset A')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', 'Changeset A', '!2']));
    pending.get('!1')!.resolve(response(0));
    await vi.waitFor(() => expect(started).toEqual(['!1', 'Changeset A', '!2', 'Changeset B']));
  });

  it('one active run per changeset target: retriggering the same changeset while it runs returns the same record, never a second dispatch', async () => {
    const { started, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const first = runs.trigger(changesetInput('cs-1', 'Changeset one'), 3);
    const retrigger = runs.trigger(changesetInput('cs-1', 'Changeset one'), 3);

    expect(started).toEqual(['Changeset one']);
    expect(retrigger.key).toBe(first.key);
    expect(runs.active()).toHaveLength(1);
  });

  it('a changeset entering waiting releases its slot for the next queued target, exactly like a cr run', async () => {
    const { started, pending, optionsOf, runners } = controllableAttempts();
    const { runs, changes } = manager({ runners });

    const first = runs.trigger(changesetInput('cs-w', 'Waiting changeset'), 1); // limit 1: holds the only slot
    const second = runs.trigger(crInput('2'), 1); // queued behind it
    expect(started).toEqual(['Waiting changeset']);
    expect(second.status).toBe('queued');

    optionsOf.get('Waiting changeset')!.onEnterWaiting!({ reason: 'A transient provider issue requires a longer wait.' });
    expect(runs.get(first.key)?.lifecycle).toBe('waiting');
    await vi.waitFor(() => expect(started).toEqual(['Waiting changeset', '!2']));

    // The waiting changeset still owns its target: a retrigger returns the same waiting record.
    const stillOwned = runs.trigger(changesetInput('cs-w', 'Waiting changeset'), 1);
    expect(stillOwned.key).toBe(first.key);
    expect(stillOwned.lifecycle).toBe('waiting');

    pending.get('!2')!.resolve(succeededResult(0, '!2'));
    // A succeeded record is removed from the live map once settled (`settle`'s own doc comment).
    await vi.waitFor(() => expect(runs.get(second.key)).toBeUndefined());
    expect([...changes].reverse().find((record) => record.key === second.key)?.status).toBe('succeeded');
    // The waiting changeset itself is untouched by '!2' finishing: it still owns its slotless
    // 'waiting' lifecycle until it either resumes or its own attempt settles — neither happened
    // here, so it correctly has not moved.
    expect(runs.get(first.key)?.lifecycle).toBe('waiting');

    // Explicitly resuming (task 12.4/9.6's own mechanism) moves it back to its prior active phase,
    // and its own eventual result settles it normally — exactly as for a cr run.
    optionsOf.get('Waiting changeset')!.onResuming!();
    expect(runs.get(first.key)?.lifecycle).not.toBe('waiting');
    pending.get('Waiting changeset')!.resolve(succeededResult(0, 'Waiting changeset'));
    await vi.waitFor(() => expect(runs.active()).toHaveLength(0));
  });

  it('a changeset run and an individual review proceed independently — cancelling one never touches the other\'s slot, lifecycle, or record', async () => {
    const { started, cancelled, pending, runners } = controllableAttempts();
    const { runs, changes } = manager({ runners });

    const csRecord = runs.trigger(changesetInput('cs-iso', 'Isolated changeset'), 5);
    const crRecord = runs.trigger(crInput('iso'), 5);
    expect(started).toEqual(['Isolated changeset', '!iso']);
    expect(runs.active()).toHaveLength(2);

    runs.cancel(csRecord.key);
    expect(cancelled).toEqual(['Isolated changeset']);
    // The unrelated cr run is completely untouched: still an active, running record, its own slot
    // still held.
    expect(runs.get(crRecord.key)?.status).toBe('running');
    expect(runs.active().some((r) => r.key === crRecord.key)).toBe(true);
    // The cancelled changeset's slot is released at once regardless of its attempt ever answering
    // (task 12.4's own guarantee) — the cr run's slot count is unaffected either way.
    expect(runs.get(csRecord.key)?.lifecycle).toBe('cancelling');

    pending.get('!iso')!.resolve(succeededResult(1, '!iso'));
    await vi.waitFor(() => expect(runs.get(crRecord.key)).toBeUndefined());
    // The cr run's own successful completion is likewise untouched by the changeset's cancellation
    // — a genuine success, not silently reclassified as cancelled or failed. A succeeded record is
    // removed from the live map once settled (`settle`'s own doc comment), so its terminal outcome
    // is read off the last `onChange` notification for its key instead.
    const lastForCr = [...changes].reverse().find((record) => record.key === crRecord.key);
    expect(lastForCr?.status).toBe('succeeded');

    // The changeset's own cancellation is likewise untouched by the cr run's success — still
    // cancelling (this fixture's attempt never itself answers the cancellation token, so it is
    // bounded only by `armCancelGrace`, which `manager()`'s default deliberately never resolves).
    expect(runs.get(csRecord.key)?.lifecycle).toBe('cancelling');
  });

  it('retained-review behaviour is unchanged for a changeset run that had to wait its turn in the queue: it writes under its own changeset key alone, never under any member\'s cr key', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, workspaceState } = manager({ runners });

    // Queue the changeset behind a cr run occupying the only slot. The cr's own review is clean
    // (0 items) and the changeset's is not (2 items) — a mix-up between the two keys would show up
    // as the wrong item count under the wrong key, not merely a missing write.
    runs.trigger(crInput('blocker'), 1);
    const csRecord = runs.trigger(changesetInput('cs-queued', 'Queued changeset'), 1);
    expect(csRecord.status).toBe('queued');

    pending.get('!blocker')!.resolve(response(0));
    await vi.waitFor(() => expect(runs.get(csRecord.key)?.status).toBe('running'));

    pending.get('Queued changeset')!.resolve(response(2));
    // A succeeded record is removed from the live map once settled (`settle`'s own doc comment) —
    // the durable write is what this test cares about anyway.
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.changesetDraft.cs-queued')).toBeDefined());

    // The changeset's own key carries exactly its own 2-item review — never a per-member cr draft
    // key (this fixture's changeset has no members, so a leak would be unambiguous).
    const changesetWritten = workspaceState.get('codeVerdict.changesetDraft.cs-queued') as { review?: { items: readonly unknown[] } } | undefined;
    expect(changesetWritten?.review?.items).toHaveLength(2);
    // The blocking cr run's own key carries exactly its own clean (0-item) review, untouched by
    // the changeset's write — no cross-contamination in either direction.
    const crWritten = workspaceState.get('codeVerdict.draft.repo-1!blocker') as { review?: { items: readonly unknown[] } } | undefined;
    expect(crWritten?.review?.items).toHaveLength(0);
  });
});

describe('stored effort attribution', () => {
  it('records the immutable run effort on the review', async () => {
    const { runs, workspaceState } = manager({
      runners: instantRunners(1, 0),
    });

    runs.trigger(crInput('2841', { effort: 'xhigh' }), 3);

    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    expect((workspaceState.get('codeVerdict.draft.repo-1!2841') as { review: { effort: string } }).review.effort)
      .toBe('xhigh');
  });
});

describe('the in-flight record and the interrupted sweep', () => {
  it('records a run as in flight while it runs and clears it when it finishes', async () => {
    const { pending, runners } = controllableRunners();
    const { runs, globalState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
    expect(new InFlightRunStore(globalState).list()[0]).toMatchObject({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
    });

    pending.get('!2841')!.resolve(response(0));
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(0));
  });

  it('clears the in-flight record when a run is cancelled', async () => {
    const { runners } = controllableRunners();
    const { runs, globalState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
    runs.cancel(record.key);
    await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(0));
  });

  it(
    'a genuine crash whose own best-effort terminal write also fails leaves the in-flight marker in ' +
      'place, so the next activation sweep can still find and truthfully close the lineage — the gap that ' +
      'permanently stranded run_5a1f8b5f150e7050fb742e5bebc080dc/lineage_1ea390cab27a5c6dc58e1cc3ea230cb9',
    async () => {
      const { pending, runners } = controllableAttempts();
      const { runs, globalState } = manager({ runners });

      const record = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));

      // What a real attempt's own machinery already persisted before the crash: a genuine, still
      // nonterminal phase-boundary checkpoint (`investigating`) — the shape `harnessRunStore` is left
      // in when `HarnessAttempt.run()`'s escaping error reaches this test's `.reject(...)` below with
      // its own best-effort terminal write (`finalizeEscapedError`) having also failed to land, silently.
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot: ReviewRunSnapshot = {
        schemaVersion: '1',
        runId: record.runId,
        lineageId: record.lineageId,
        attempt: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        targetKind: 'cr',
        members: [
          {
            memberId: 'm1',
            providerId: 'fixture',
            instanceUrl: 'https://example.test',
            ref: { repoId: 'repo-1', number: '2841' },
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
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
        effort: 'none',
        effortInstructionDigest: 'digest-effort',
        criteria: DEFAULT_CRITERIA,
        extraInstructionsDigest: 'digest-extra',
        toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
        harnessPolicyVersion: HARNESS_POLICY_VERSION,
      };
      await harnessRunStore.writeSnapshot(snapshot);
      let log = createActivityLog(record.runId, record.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'investigating', elapsedMs: 1000 },
      );
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: record.runId,
          lineageId: record.lineageId,
          attempt: 1,
          phase: 'investigating',
          reason: 'phaseBoundary',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 1000,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
        },
        DEFAULT_HARNESS_POLICY,
      );
      expect(built.projection.lifecycle).toBe('investigating'); // sanity: genuinely nonterminal
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);

      // The crash itself.
      pending.get('!2841')!.reject(new Error('boom'));
      await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

      // The old, unconditional `settle()` stripped the marker right here regardless of the store's
      // own state — exactly what stranded tonight's lineage permanently. It survives now.
      expect(new InFlightRunStore(globalState).list()).toHaveLength(1);

      // And the next activation's sweep still finds and truthfully closes it.
      const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });
      expect(swept).toBeGreaterThan(0);
      expect(harnessRunStore.latestCheckpoint(record.lineageId)?.projection.lifecycle).toBe('interrupted');
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
    },
  );

  it(
    "completeAttempt's ordinary failed settle recovers a missing terminal write: verifying finds no " +
      "terminal marker for this attempt, retries by closing this attempt's own last nonterminal " +
      'checkpoint with the truthful failed outcome, and clears the in-flight marker normally once the ' +
      'retry lands',
    async () => {
      const { pending, runners } = controllableAttempts();
      const { runs, globalState } = manager({ runners });

      const record = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));

      // A real attempt's own genuine, still-nonterminal phase-boundary checkpoint — what
      // `harnessRunStore` holds when the store's own terminal write is the one thing missing (Fix 1's
      // own incident shape, or any other cause), never a crash: `run()` genuinely resolves below.
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot = fixtureHarnessSnapshot(record.runId, record.lineageId);
      await harnessRunStore.writeSnapshot(snapshot);
      let log = createActivityLog(record.runId, record.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'investigating', elapsedMs: 1000 },
      );
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: record.runId,
          lineageId: record.lineageId,
          attempt: 1,
          phase: 'investigating',
          reason: 'phaseBoundary',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 1000,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
        },
        DEFAULT_HARNESS_POLICY,
      );
      expect(built.projection.lifecycle).toBe('investigating'); // sanity: genuinely nonterminal
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);

      // The attempt genuinely, cleanly finishes `failed` — `run()` resolves, not rejects — but this
      // test's own `harnessRunStore` (the same one production's `harnessRuntime.ts` would have used)
      // never received the terminal write. A hand-built result, not `failedResult(...)`: that shared
      // fixture's own `'harness.test'` limitation code is a free-text stand-in never meant to satisfy
      // `appendActivityEvent`'s own short-token sanitizer (`/^[A-Za-z][A-Za-z0-9]*$/`) — real
      // production limitations always are one (every code this codebase mints is a plain camelCase
      // token), so this uses one too, to exercise the retry's genuine success path rather than the
      // separate "the fact itself failed sanitization" failure mode.
      pending.get('!2841')!.resolve({
        ...failedResult('Coverage did not reach every high-risk file.', 'irrelevant-result-refLabel', 2),
        outcome: { ...failedResult('x', 'irrelevant-result-refLabel', 2).outcome, limitations: [{ code: 'coverageIncomplete', message: 'Coverage did not reach every high-risk file.' }] },
      });
      await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

      // The recovery landed: a terminal marker now exists for this exact attempt, carrying the
      // RESULT's own truthful outcome — never a fabricated `'interrupted'`.
      const reread = harnessRunStore.readLineage(record.lineageId);
      expect(reread?.terminalAttempts).toEqual([expect.objectContaining({ attempt: 1, lifecycle: 'failed', completeness: 'partial' })]);
      const recovered = harnessRunStore.latestCheckpoint(record.lineageId)!;
      expect(recovered.projection.lifecycle).toBe('failed');
      // The recovered checkpoint keeps the orderly-completion reason `runPersisting` itself would
      // have used — never `'attemptFailed'` (reserved for a crash escaping every phase runner,
      // which this attempt never did: `run()` resolved normally). Mislabeling this would make
      // `resumeBudgetModeFor` treat a genuine budget-exhaustion resume as a crash-resume and
      // silently downgrade its fresh budget to `carryForward`.
      expect(recovered.reason).toBe('phaseBoundary');
      expect(resumeBudgetModeFor(recovered)).toBe('fresh');
      // And the marker cleared normally — no persistence-gap limitation was needed.
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
      expect(runs.get(record.key)?.limitations).not.toContainEqual(expect.objectContaining({ code: 'terminalPersistenceGap' }));
    },
  );

  it(
    "completeAttempt's ordinary settle leaves the in-flight marker when even the retry cannot confirm " +
      'a terminal write (no checkpoint at all exists to recover from), naming the gap as a limitation ' +
      'on the settled record — and the next activation sweep still closes it truthfully',
    async () => {
      const { pending, runners } = controllableAttempts();
      const { runs, globalState } = manager({ runners });

      const record = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));

      // Persistence was engaged for this attempt (a snapshot landed — `readLineage` will find
      // something) but no checkpoint EVER did: the retry has nothing to close from, so a rebuild is
      // genuinely impossible with what `completeAttempt` has in hand.
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      await harnessRunStore.writeSnapshot(fixtureHarnessSnapshot(record.runId, record.lineageId));

      pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', 'irrelevant-result-refLabel', 2));
      await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

      // No terminal marker exists — the retry could not confirm one — so the marker survives for the
      // sweep, exactly like the crash-catch's own leave-not-clear behavior above.
      expect(new InFlightRunStore(globalState).list()).toHaveLength(1);
      // The gap is named on the settled record, not silently absorbed.
      expect(runs.get(record.key)?.limitations).toContainEqual(expect.objectContaining({ code: 'terminalPersistenceGap' }));

      // The next activation's sweep still runs `closeLeftoverInFlightEntry` for this leftover entry —
      // there is nothing in `harnessRunStore` to find terminal, so it would fall back to a bare
      // `interrupted` row, except `completeAttempt` already wrote a truthful `'partial'` row for this
      // exact run before settling (`recordPartialHistory`, carrying the persistence-gap limitation
      // itself) — `recordIfFresher` correctly refuses to let the sweep's stale-timestamped
      // `interrupted` row clobber it (`reviewRuns.ts`'s own freshness guard): the run genuinely did
      // finish with real content, and `'partial'` is the truthful label, not `'interrupted'`. The
      // sweep's own durable effect here is exactly what it should be — clearing the in-flight marker.
      const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });
      expect(swept).toBeGreaterThan(0);
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
      const rows = new ReviewRunStore(globalState).list();
      expect(rows.find((row) => row.repoId === 'repo-1' && row.crNumber === '2841')).toMatchObject({
        outcome: 'partial',
        limitations: expect.arrayContaining([expect.objectContaining({ code: 'terminalPersistenceGap' })]),
      });
    },
  );

  it(
    "completeAttempt's retry has a genuine checkpoint to close but the store's own write throws (not " +
      'merely fails validation): the throw is caught and folded into the same not-confirmed path, so ' +
      "the run settles with the attempt's own GENUINE result — findings, limitations, dashboard row — " +
      "instead of executeAttempt's generic crash-catch discarding them and settling failed with " +
      'limitations [] and no dashboard row at all',
    async () => {
      const { pending, runners } = controllableAttempts();
      const baseGlobalState = memoryStore();
      const { store: globalState, arm } = throwOnceForNextLineageWrite(baseGlobalState);
      const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

      const record = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));

      // A real attempt's own genuine, still-nonterminal phase-boundary checkpoint — the retry's
      // recovery path has something to close, unlike the "no checkpoint at all" case below.
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot = fixtureHarnessSnapshot(record.runId, record.lineageId);
      await harnessRunStore.writeSnapshot(snapshot);
      let log = createActivityLog(record.runId, record.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'investigating', elapsedMs: 1000 },
      );
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: record.runId,
          lineageId: record.lineageId,
          attempt: 1,
          phase: 'investigating',
          reason: 'phaseBoundary',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 1000,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
        },
        DEFAULT_HARNESS_POLICY,
      );
      expect(built.projection.lifecycle).toBe('investigating'); // sanity: genuinely nonterminal
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY); // this write itself must succeed — armed only below

      // Arm the throw now: the very next lineage-key write — the retry's own `writeCheckpoint` inside
      // `verifyOrRecoverTerminalWrite`, triggered by the resolve below — fails.
      arm();
      pending.get('!2841')!.resolve({
        ...failedResult('Coverage did not reach every high-risk file.', 'irrelevant-result-refLabel', 2),
        outcome: { ...failedResult('x', 'irrelevant-result-refLabel', 2).outcome, limitations: [{ code: 'coverageIncomplete', message: 'Coverage did not reach every high-risk file.' }] },
      });
      await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

      // The genuine result survived the throw: `completeAttempt`'s own normal flow ran to completion
      // — the settled record carries both the attempt's real limitation AND the persistence-gap one,
      // never the crash-catch's empty-limitations shape (`this.settle(current, { lifecycle: 'failed',
      // failure }, ...)` from `executeAttempt`'s `catch`, which never sees `result.outcome.limitations`
      // at all).
      const settled = runs.get(record.key)!;
      expect(settled.limitations).toContainEqual(expect.objectContaining({ code: 'coverageIncomplete' }));
      expect(settled.limitations).toContainEqual(expect.objectContaining({ code: 'terminalPersistenceGap' }));
      // The real `completeness` from `result.outcome` (`'partial'` at 2 findings) — never the
      // crash-catch's own settle, which carries no `completeness` at all and would leave `'none'`.
      expect(settled.completeness).toBe('partial');

      // A dashboard row exists at all — `recordPartialHistory` ran, which the crash-catch path never
      // reaches (it settles directly with no durable write).
      const rows = new ReviewRunStore(baseGlobalState).list();
      const row = rows.find((r) => r.repoId === 'repo-1' && r.crNumber === '2841');
      expect(row).toMatchObject({ outcome: 'partial', findingCount: 2 });
      expect(row?.limitations).toContainEqual(expect.objectContaining({ code: 'coverageIncomplete' }));
      expect(row?.limitations).toContainEqual(expect.objectContaining({ code: 'terminalPersistenceGap' }));

      // Not confirmed in storage, so the marker survives for the next activation sweep — same
      // not-confirmed contract as the "no checkpoint at all" case, reached here via a throw instead.
      expect(new InFlightRunStore(baseGlobalState).list()).toHaveLength(1);
    },
  );

  // F1 / self-closed-crash-never-recorded-to-dashboard: a genuine escape from `HarnessAttempt.run()`
  // (`executeAttempt`'s generic catch, not a resolved `HarnessAttemptResult`) whose own best-effort
  // terminal write (`finalizeEscapedError`, simulated here by writing a terminal checkpoint directly)
  // already landed used to discard every already-validated finding and never write a `ReviewRunStore`
  // row at all — the marker was cleared (the write is confirmed) with nothing else recovered.
  it(
    "a genuine crash (HarnessAttempt.run() rejects) whose best-effort terminal checkpoint already " +
      'carries an accepted finding is recovered into the settled record and a dashboard row, not ' +
      'discarded as a bare failed/none/no-row outcome',
    async () => {
      const { pending, runners } = controllableAttempts();
      const { runs, globalState, workspaceState } = manager({ runners });

      const record = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));

      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot = fixtureHarnessSnapshot(record.runId, record.lineageId);
      await harnessRunStore.writeSnapshot(snapshot);
      const finding: ValidatedFinding = {
        candidateId: 'cand-1',
        memberId: 'm1',
        routing: 'inline',
        item: { id: 'cand-1', file: 'file1.ts', anchored: true, line: 1, severity: 'major', category: 'security', confidence: 80, title: 'A validated finding', body: 'Body.', code: '' },
        provenance: { protocolProvenance: 'harness', citations: [], validatedAt: '2026-01-01T00:00:00.000Z' },
        evidence: { repositoryId: 'repo-1', baseSha: BASE_SHA, headSha: HEAD_SHA, primary: { sourceId: 'ev_a', digest: 'x', origin: 'diffPage', memberId: 'm1', repositoryId: 'repo-1', baseSha: BASE_SHA, headSha: HEAD_SHA, path: 'file1.ts', range: { startLine: 1, endLine: 1 } }, supporting: [] },
      };
      const candidate: TrackedCandidate = { candidateId: 'cand-1', state: 'accepted', repairs: 0, reasons: [], finding };
      let log = createActivityLog(record.runId, record.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'verifying', elapsedMs: 1000 },
      );
      // `finalizeEscapedError`'s own shape: a genuine terminal write, `intendedTerminal` declared,
      // never `'attemptFailed'`'s crash-catch-all reason for a checkpoint like this one — this is
      // `harnessAttempt.ts`'s own doc comment's exact case, simulated at the store level here since
      // this suite drives the manager, not a real `HarnessAttempt`.
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: record.runId,
          lineageId: record.lineageId,
          attempt: 1,
          phase: 'verifying',
          reason: 'attemptFailed',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 1000,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [candidate],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
          intendedTerminal: { lifecycle: 'failed', completeness: 'partial' },
        },
        DEFAULT_HARNESS_POLICY,
      );
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);

      // The genuine crash: `HarnessAttempt.run()` rejects outright, reaching `executeAttempt`'s
      // generic catch — never a resolved `HarnessAttemptResult`.
      pending.get('!2841')!.reject(Object.assign(new Error('unhandled escape'), { requestId: 'req-crash' }));
      await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

      // Recovered onto the settled record — never `completeness: 'none'`/an empty `partialResult`.
      const settled = runs.get(record.key)!;
      expect(settled.completeness).toBe('partial');
      expect(settled.partialResult?.items).toHaveLength(1);
      expect(settled.partialResult?.items[0]?.id).toBe('cand-1');

      // A truthful `ReviewRunStore` row exists — the exact thing the pre-fix crash-catch never wrote,
      // permanently hiding this run from the dashboard/run history.
      const rows = new ReviewRunStore(globalState).list();
      const row = rows.find((r) => r.repoId === 'repo-1' && r.crNumber === '2841');
      expect(row).toMatchObject({ outcome: 'partial', findingCount: 1 });

      // The durable partial record is reachable too — the same key a "Use N partial findings" button
      // reads back, never only the in-memory record.
      const partial = readRetained(workspaceState.get<SessionDraft>(partialDraftKeyFor({ repoId: 'repo-1', number: '2841' })), { partial: true });
      expect(partial?.draft.review.items).toHaveLength(1);

      // The marker itself still clears normally: `finalizeEscapedError`'s own write is confirmed
      // terminal, so there is nothing left for a future sweep to find.
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
    },
  );

  it(
    'a new trigger on the same target starting immediately after does not destroy a predecessor ' +
      "attempt's own still-unswept in-flight marker — InFlightRunStore.add's latest-wins-per-key " +
      'semantics used to overwrite it silently before any sweep could inspect it',
    async () => {
      const { pending, runners } = controllableAttempts();
      const { runs, globalState } = manager({ runners });

      // Attempt 1: genuinely finishes `failed`. Persistence was engaged for its lineage (a snapshot
      // landed) but no checkpoint ever did, so Fix 2's own retry cannot confirm a terminal write and
      // deliberately leaves attempt 1's in-flight marker in place for the sweep — the same shape the
      // previous test constructs deliberately, needed again here as the precondition Fix 3 guards.
      const first = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      await harnessRunStore.writeSnapshot(fixtureHarnessSnapshot(first.runId, first.lineageId));
      pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', 'irrelevant-result-refLabel', 2));
      await vi.waitFor(() => expect(runs.get(first.key)?.status).toBe('failed'));
      expect(new InFlightRunStore(globalState).list()).toEqual([expect.objectContaining({ key: first.key, lineageId: first.lineageId })]);

      // Attempt 2: a completely fresh trigger on the SAME target (repoId!crNumber), minting a
      // brand-new lineage — allowed because attempt 1's in-memory record already reached `failed`,
      // a terminal lifecycle, satisfying `trigger`'s own admission check. Before this fix,
      // `InFlightRunStore.add`'s latest-wins-per-key write below would have silently destroyed
      // attempt 1's own still-unswept marker the moment this second trigger started.
      const second = runs.trigger(crInput('2841'), 3);
      expect(second.lineageId).not.toBe(first.lineageId);
      // Waits for attempt 2's OWN entry specifically, not merely "length 1": `closeLeftoverInFlightEntry`
      // runs (and awaits its own writes) before `InFlightRunStore.add` replaces attempt 1's same-key
      // entry, so the list genuinely does read as length 1 — still attempt 1's own stale entry — for
      // one or more polls in between.
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toEqual([expect.objectContaining({ key: second.key, lineageId: second.lineageId })]));

      // Attempt 1's predecessor marker was run through `closeLeftoverInFlightEntry` — never silently
      // dropped — before attempt 2's own marker took its place under the same key: the row
      // `completeAttempt` already wrote for it (truthful `'partial'`, carrying the persistence-gap
      // limitation) survives `recordIfFresher`'s own freshness guard exactly like the previous test's
      // sweep-driven close does, since a live pre-add close and the activation sweep share this exact
      // machinery.
      const runStore = new ReviewRunStore(globalState);
      const rows = runStore.list();
      expect(rows.find((row) => row.repoId === 'repo-1' && row.crNumber === '2841')).toMatchObject({
        outcome: 'partial',
        limitations: expect.arrayContaining([expect.objectContaining({ code: 'terminalPersistenceGap' })]),
      });
      // And the list now holds only attempt 2's own live marker — attempt 1's was closed and
      // removed, not left to coexist or silently vanish.
      expect(new InFlightRunStore(globalState).list()).toEqual([expect.objectContaining({ key: second.key, lineageId: second.lineageId })]);

      // Attempt 2 itself still resolves normally afterward, unaffected by its predecessor's close.
      pending.get('!2841')!.resolve(succeededResult(1, 'irrelevant-result-refLabel'));
      await vi.waitFor(() => expect(runs.get(second.key)).toBeUndefined()); // succeeded records are deleted
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
    },
  );

  it(
    "start()'s leftover-closing guard also runs when the leftover shares the new record's own " +
      "lineage — resumeRun's own signature (runId/lineageId reused verbatim): attempt 1 leaves an " +
      'unconfirmed marker, the reviewer immediately resumes the same lineage as attempt 2, and ' +
      "attempt 1 is found and closed before InFlightRunStore.add replaces its marker with attempt " +
      "2's, instead of the old same-lineage exclusion silently letting attempt 1's marker (and its " +
      'permanently non-terminal checkpoint) be destroyed',
    async () => {
      const { pending, runners } = controllableAttempts();
      const baseGlobalState = memoryStore();
      const { store: globalState, arm } = throwOnceForNextLineageWrite(baseGlobalState);
      // A monotonic clock, one tick per call: `InFlightRun.startedAt` is the one field that can tell
      // attempt 1's own marker apart from attempt 2's replacement below, since `resumeRun` reuses
      // `runId`/`lineageId` verbatim — the real wall clock could tick the same millisecond twice here.
      let clock = Date.parse('2026-01-01T00:00:00.000Z');
      const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}), now: () => (clock += 1) });

      // Attempt 1: genuinely finishes `failed` with a real nonterminal checkpoint to recover from —
      // but the retry's own write throws (armed below, consumed by that one write), so the terminal
      // write is never confirmed and attempt 1's in-flight marker survives (finding-1's own
      // precondition). A genuine checkpoint, not only a snapshot, is required here so
      // `recordPartialHistory`'s own `checkpointOffer` carries `lineageId` on the stored row — the
      // same field `resumeRun` reads back below to find this lineage at all.
      const first = runs.trigger(crInput('2841'), 3);
      await vi.waitFor(() => expect(new InFlightRunStore(globalState).list()).toHaveLength(1));
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot = fixtureHarnessSnapshot(first.runId, first.lineageId);
      await harnessRunStore.writeSnapshot(snapshot);
      let log = createActivityLog(first.runId, first.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'investigating', elapsedMs: 1000 },
      );
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: first.runId,
          lineageId: first.lineageId,
          attempt: 1,
          phase: 'investigating',
          reason: 'phaseBoundary',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 1000,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
        },
        DEFAULT_HARNESS_POLICY,
      );
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);

      // Arm the throw, and resolve with a sanitizer-safe limitation code — never the shared
      // `failedResult(...)` fixture's own free-text `'harness.test'` stand-in, which
      // `appendActivityEvent`'s short-token sanitizer would drop on its own, making
      // `closeCheckpointAsTerminal` return `undefined` (fact failed validation) before the retry ever
      // reaches the store at all — the OTHER not-confirmed path, not the one this test means to
      // exercise (mirrors the succeeding-retry test's own identical care, above).
      arm();
      pending.get('!2841')!.resolve({
        ...failedResult('Coverage did not reach every high-risk file.', 'irrelevant-result-refLabel', 2),
        outcome: { ...failedResult('x', 'irrelevant-result-refLabel', 2).outcome, limitations: [{ code: 'coverageIncomplete', message: 'Coverage did not reach every high-risk file.' }] },
      });
      await vi.waitFor(() => expect(runs.get(first.key)?.status).toBe('failed'));
      expect(new InFlightRunStore(globalState).list()).toEqual([expect.objectContaining({ key: first.key, lineageId: first.lineageId, runId: first.runId })]);
      // The retry's write never landed — attempt 1's own last checkpoint is still nonterminal.
      expect(harnessRunStore.latestCheckpoint(first.lineageId, 1)?.projection.lifecycle).toBe('investigating');
      const attempt1StartedAt = new InFlightRunStore(baseGlobalState).list()[0]!.startedAt;

      // Attempt 2: `resumeRun`, never a fresh `trigger()` — mints attempt 2 in the SAME lineage,
      // reusing the stored checkpoint's own `runId`/`lineageId` verbatim (both identical to attempt
      // 1's own — the one thing `runId`/`lineageId` equality alone can never distinguish, which is
      // exactly why the old guard used it and got this case wrong). Exactly the shape the old
      // `leftover.lineageId !== record.lineageId` guard would have skipped closing.
      const second = runs.resumeRun(crInput('2841'), 3);
      expect(second).toBeDefined();
      expect(second!.lineageId).toBe(first.lineageId);
      expect(second!.runId).toBe(first.runId);
      expect(second!.attempt).toBe(2);

      // Attempt 1 was found and genuinely closed as `interrupted` — never silently abandoned
      // mid-`investigating` forever, which is what the old exclusion would have left it as.
      await vi.waitFor(() =>
        expect(harnessRunStore.readLineage(first.lineageId)?.terminalAttempts).toContainEqual(expect.objectContaining({ attempt: 1, lifecycle: 'interrupted' })),
      );
      expect(harnessRunStore.latestCheckpoint(first.lineageId, 1)?.projection.lifecycle).toBe('interrupted');

      // The in-flight marker was genuinely replaced (a later `startedAt`), not merely left as attempt
      // 1's own stale entry — `runId`/`lineageId` equality can't tell the two apart, so `startedAt` is
      // the one field that does.
      await vi.waitFor(() => {
        const list = new InFlightRunStore(baseGlobalState).list();
        expect(list).toHaveLength(1);
        expect(list[0]!.startedAt).not.toBe(attempt1StartedAt);
      });
    },
  );

  it(
    "closes a lineage that carries no in-flight marker at all — tonight's own retroactive state " +
      '(`lineage_1ea390cab27a5c6dc58e1cc3ea230cb9`, before this fix, already stripped of its marker by ' +
      "the old unconditional `settle()`) — by scanning `harnessRunStore` directly, never touching " +
      '`ReviewRunStore` (no repoId/crNumber survives without the marker to name a dashboard row)',
    async () => {
      const globalState = memoryStore();
      expect(new InFlightRunStore(globalState).list()).toEqual([]); // no marker: the old sweep found nothing here at all.

      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-01T00:10:00.000Z') });
      const snapshot: ReviewRunSnapshot = {
        schemaVersion: '1',
        runId: 'run_5a1f8b5f150e7050fb742e5bebc080dc',
        lineageId: 'lineage_1ea390cab27a5c6dc58e1cc3ea230cb9',
        attempt: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        targetKind: 'cr',
        members: [
          {
            memberId: 'm1',
            providerId: 'fixture',
            instanceUrl: 'https://example.test',
            ref: { repoId: 'repo-1', number: '2841' },
            baseSha: BASE_SHA,
            headSha: HEAD_SHA,
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
        effort: 'none',
        effortInstructionDigest: 'digest-effort',
        criteria: DEFAULT_CRITERIA,
        extraInstructionsDigest: 'digest-extra',
        toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
        harnessPolicyVersion: HARNESS_POLICY_VERSION,
      };
      await harnessRunStore.writeSnapshot(snapshot);
      let log = createActivityLog(snapshot.runId, snapshot.lineageId, 1);
      log = appendActivityEvent(
        log,
        { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
        { occurredAt: '2026-01-01T00:05:00.000Z', phase: 'completing', elapsedMs: 3661602 },
      );
      const built = buildCheckpoint(
        {
          checkpointId: 'ckpt-1',
          runId: snapshot.runId,
          lineageId: snapshot.lineageId,
          attempt: 1,
          phase: 'completing',
          reason: 'phaseBoundary',
          occurredAt: '2026-01-01T00:05:00.000Z',
          elapsedMs: 3661602,
          snapshotDigest: computeSnapshotDigest(snapshot),
          activityEvents: log.events,
          evidenceSources: [],
          candidates: [],
          contradicted: [],
          budget: ZERO_BUDGET,
          coverage: [],
          unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
          retry: INITIAL_RETRY_STATE,
        },
        DEFAULT_HARNESS_POLICY,
      );
      expect(built.projection.lifecycle).toBe('completing'); // sanity: genuinely nonterminal
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);

      const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

      expect(swept).toBe(1);
      expect(harnessRunStore.latestCheckpoint(snapshot.lineageId)?.projection.lifecycle).toBe('interrupted');
      // No marker ever named a repoId/crNumber for this lineage, so there is nothing honest to add
      // to the dashboard's own row store — closing the persisted lineage truthfully is the whole
      // scope (this function's own header comment on the markerless branch).
      expect(new ReviewRunStore(globalState).list()).toEqual([]);
    },
  );

  it('sweeps a run left behind by a closed window into an interrupted outcome', async () => {
    const globalState = memoryStore();
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
      repoId: 'repo-1',
      crNumber: '2841',
      startedAt: '2026-08-28T09:00:00.000Z',
    });

    const swept = await sweepInterruptedRuns(globalState);

    expect(swept).toBe(1);
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({
      repoId: 'repo-1',
      crNumber: '2841',
      outcome: 'interrupted',
      // Its own start time, not the time of the sweep: the reviewer needs to
      // know when the lost run began.
      ranAt: '2026-08-28T09:00:00.000Z',
    });
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  it('does not clobber a richer row a faster new run already recorded for the same target', async () => {
    const globalState = memoryStore();
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
      repoId: 'repo-1',
      crNumber: '2841',
      startedAt: '2026-08-28T09:00:00.000Z',
    });
    // A new run on the same target started after the crash, completed, and
    // recorded its own richer row before the sweep's loop reached this
    // leftover entry — the race `ReviewRunStore.recordIfFresher` exists for.
    await new ReviewRunStore(globalState).record({
      repoId: 'repo-1',
      crNumber: '2841',
      outcome: 'findings',
      findingCount: 5,
      agentLabel: 'Default review',
      ranAt: '2026-08-28T09:30:00.000Z',
    });

    const swept = await sweepInterruptedRuns(globalState);

    expect(swept).toBe(1);
    expect(new ReviewRunStore(globalState).list()).toEqual([
      { repoId: 'repo-1', crNumber: '2841', outcome: 'findings', findingCount: 5, agentLabel: 'Default review', ranAt: '2026-08-28T09:30:00.000Z' },
    ]);
    // The stale marker is still cleared — the guard protects only the dashboard row.
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  it('sweeps nothing when every run finished cleanly', async () => {
    const globalState = memoryStore();
    expect(await sweepInterruptedRuns(globalState)).toBe(0);
    expect(new ReviewRunStore(globalState).list()).toEqual([]);
  });

  it('does not touch the target\'s retained review', async () => {
    const globalState = memoryStore();
    const workspaceState = memoryStore();
    const existing = { review: { items: [1] } };
    await workspaceState.update('codeVerdict.draft.repo-1!2841', existing);
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!2841',
      podId: 'pod-a',
      refLabel: '!2841',
      repoId: 'repo-1',
      crNumber: '2841',
      startedAt: '2026-08-28T09:00:00.000Z',
    });

    await sweepInterruptedRuns(globalState);

    // An interruption is reported alongside the last completed review, never
    // in place of it.
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(existing);
  });
});

/**
 * A runner that never settles on its own and, unlike `controllableRunners`,
 * does not react to cancellation at all — it models the risk design.md names
 * directly ("cancellation may not stop a provider or model immediately"), so
 * a test can resolve/reject it *after* the manager already considers the
 * record terminal and prove the late arrival is ignored, rather than only
 * exercising the cooperative-cancellation fast path `controllableRunners`
 * already covers above.
 */
function unresponsiveRunner(): {
  pending: Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>;
  runners: ReviewHarnessFactory;
} {
  const pending = new Map<string, { resolve(r: AgentReviewResponse): void; reject(e: unknown): void }>();
  function build(input: RunInput) {
    return {
      run: () =>
        new Promise<HarnessAttemptResult>((resolve, reject) => {
          pending.set(input.refLabel, { resolve: (r) => resolve(resultFromResponse(input.refLabel, r)), reject });
        }),
    };
  }
  const runners: ReviewHarnessFactory = { create: build, createDemo: build, resume: build };
  return { pending, runners };
}

describe('task 12.2: every canonical lifecycle maps to a documented legacy status', () => {
  it('maps all thirteen lifecycles', () => {
    const expected: Record<RunLifecycle, RunStatus> = {
      queued: 'queued',
      planning: 'running',
      investigating: 'running',
      verifying: 'running',
      completing: 'running',
      waiting: 'running',
      paused: 'running',
      resuming: 'running',
      cancelling: 'running',
      cancelled: 'cancelled',
      succeeded: 'succeeded',
      failed: 'failed',
      interrupted: 'failed',
    };
    expect(RUN_LIFECYCLES).toHaveLength(13);
    for (const lifecycle of RUN_LIFECYCLES) {
      expect(legacyStatusFor(lifecycle)).toBe(expected[lifecycle]);
    }
  });
});

describe('task 12.3: the one validated transition path', () => {
  it('accepts the edges the lifecycle diagram and the spec describe', () => {
    expect(isLegalRunTransition('queued', 'planning')).toBe(true);
    expect(isLegalRunTransition('planning', 'investigating')).toBe(true);
    // A forward skip among active phases is legal: this pass's coarse
    // lm/demo seam has no per-phase feedback of its own.
    expect(isLegalRunTransition('investigating', 'completing')).toBe(true);
    expect(isLegalRunTransition('completing', 'succeeded')).toBe(true);
    expect(isLegalRunTransition('investigating', 'waiting')).toBe(true);
    expect(isLegalRunTransition('verifying', 'paused')).toBe(true);
    expect(isLegalRunTransition('waiting', 'resuming')).toBe(true);
    expect(isLegalRunTransition('paused', 'resuming')).toBe(true);
    expect(isLegalRunTransition('resuming', 'verifying')).toBe(true);
    expect(isLegalRunTransition('investigating', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('queued', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('waiting', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('paused', 'cancelling')).toBe(true);
    expect(isLegalRunTransition('cancelling', 'cancelled')).toBe(true);
  });

  it('refuses an illegal transition', () => {
    expect(isLegalRunTransition('queued', 'succeeded')).toBe(false);
    expect(isLegalRunTransition('queued', 'investigating')).toBe(false);
    expect(isLegalRunTransition('completing', 'investigating')).toBe(false); // backward
    expect(isLegalRunTransition('waiting', 'succeeded')).toBe(false);
    expect(isLegalRunTransition('paused', 'failed')).toBe(false);
    expect(isLegalRunTransition('cancelling', 'failed')).toBe(false);
  });

  it('gives every terminal lifecycle zero outgoing edges', () => {
    for (const terminal of ['succeeded', 'failed', 'cancelled', 'interrupted'] as const) {
      for (const to of RUN_LIFECYCLES) {
        expect(isLegalRunTransition(terminal, to)).toBe(false);
      }
    }
  });

  it('refuses to move an already-terminal record through the manager itself', async () => {
    const { pending, runners } = controllableRunners();
    const { runs } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(Object.assign(new Error('boom'), { requestId: 'r1' }));
    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const finishedAt = runs.get(record.key)?.finishedAt;

    // The only other public path that could move it: cancelling an
    // already-failed record is refused, not silently applied.
    runs.cancel(record.key);

    expect(runs.get(record.key)?.status).toBe('failed');
    expect(runs.get(record.key)?.lifecycle).toBe('failed');
    expect(runs.get(record.key)?.finishedAt).toBe(finishedAt);
  });
});

describe('task 12.4/9.6: waiting releases the slot, resuming keeps queue fairness', () => {
  it('releases the slot on entering waiting, lets the next queued run start, and resumes without losing queue position', async () => {
    const { started, pending, optionsOf, runners } = controllableAttempts();
    const { runs } = manager({ runners });

    const first = runs.trigger(crInput('1'), 1); // limit 1: holds the only slot
    const second = runs.trigger(crInput('2'), 1); // queued behind it
    expect(started).toEqual(['!1']);
    expect(second.status).toBe('queued');

    // '1' reports a real checkpoint advancing it to `investigating`, then
    // enters a long backoff wait — the slot is released at once, so '2'
    // starts even though '1' has not finished.
    optionsOf.get('!1')!.onCheckpoint(checkpointAt('investigating', '!1'));
    expect(runs.get(first.key)?.lifecycle).toBe('investigating');
    optionsOf.get('!1')!.onEnterWaiting!({ reason: 'A transient provider issue requires a longer wait.' });
    expect(runs.get(first.key)?.lifecycle).toBe('waiting');
    await vi.waitFor(() => expect(started).toEqual(['!1', '!2']));

    // '1' still owns its target while waiting: a retrigger returns the same
    // waiting record rather than starting a second run.
    const stillOwned = runs.trigger(crInput('1'), 1);
    expect(stillOwned.key).toBe(first.key);
    expect(stillOwned.lifecycle).toBe('waiting');

    // A third target, triggered after '1' resumes, must not cut ahead of it.
    const third = runs.trigger(crInput('3'), 1);
    expect(third.status).toBe('queued');

    optionsOf.get('!1')!.onResuming!();
    expect(runs.get(first.key)?.lifecycle).toBe('resuming');

    // '2' finishes, freeing the slot. '1' (resuming, original admission
    // order) goes before '3' (queued after it) — original admission order,
    // not FIFO by resume time.
    pending.get('!2')!.resolve(succeededResult(0, '!2'));
    await vi.waitFor(() => expect(runs.get(first.key)?.lifecycle).toBe('investigating'));
    // No second dispatch for '1': a resumed attempt's own continuation from
    // checkpoint is task 12.7's job (a *lost* attempt across a restart) —
    // within one still-live process, the original `.run()` call is still the
    // one unresolved promise.
    expect(started).toEqual(['!1', '!2']);
    expect(runs.get(third.key)?.status).toBe('queued');

    pending.get('!1')!.resolve(succeededResult(0, '!1'));
    await vi.waitFor(() => expect(runs.active().some((r) => r.key === third.key && r.status === 'running')).toBe(true));
  });

  it('cancellation from queued, active, waiting and paused each releases the slot at once, without waiting on the attempt', async () => {
    const { started, cancelled, optionsOf, runners } = controllableAttempts();
    const { runs } = manager({ runners });

    // 'w' takes the only slot, then enters `waiting` (releasing it).
    const waitingRun = runs.trigger(crInput('w'), 1);
    optionsOf.get('!w')!.onEnterWaiting!();
    expect(runs.get(waitingRun.key)?.lifecycle).toBe('waiting');

    // 'p' takes the freed slot, then is explicitly paused (releasing it again).
    const pausedRun = runs.trigger(crInput('p'), 1);
    runs.pause(pausedRun.key);
    expect(runs.get(pausedRun.key)?.lifecycle).toBe('paused');

    // 'a' takes the slot and stays active.
    const activeRun = runs.trigger(crInput('a'), 1);
    expect(runs.get(activeRun.key)?.lifecycle).toBe('planning');

    // 'q' finds the slot taken and queues behind it.
    const queuedRun = runs.trigger(crInput('q'), 1);
    expect(queuedRun.status).toBe('queued');

    // Cancel 'q' first, while 'a' still holds the slot — otherwise cancelling
    // 'a' below would free the slot and let 'q' start via the queue pump
    // before this test gets to assert it was never dispatched.
    runs.cancel(queuedRun.key);
    runs.cancel(waitingRun.key);
    runs.cancel(pausedRun.key);
    runs.cancel(activeRun.key);

    // 'q' never reached the transport at all — nothing will ever report back
    // for it, so it settles at once, exactly as before this pass.
    expect(runs.get(queuedRun.key)).toBeUndefined();
    // 'w', 'p' and 'a' each had a live dispatch: cancelling them crosses into
    // `cancelling` and *stays* there — settling as `cancelled` is now the
    // dispatched attempt's own cancelled result to report (through the
    // ordinary `executeAttempt` path), not something this call does
    // synchronously. None of the three ever resolves in this test, so all
    // three are still `cancelling` below; that they got there — and, more to
    // the point, released their slot getting there — is what this test is
    // actually about. See "cancelling a run with already-validated findings
    // keeps them as a partial" below for the attempt actually reporting back.
    expect(runs.get(waitingRun.key)?.lifecycle).toBe('cancelling');
    expect(runs.get(pausedRun.key)?.lifecycle).toBe('cancelling');
    expect(runs.get(activeRun.key)?.lifecycle).toBe('cancelling');
    // Only the three that ever held a live dispatch had a token to stop;
    // the queued run never made a request at all.
    expect(cancelled).toEqual(['!w', '!p', '!a']);
    expect(started).toEqual(['!w', '!p', '!a']);

    // The slot cancelling 'a' released is usable at once — released
    // synchronously by `cancel()` itself, not by 'a' actually finishing.
    runs.trigger(crInput('fresh'), 1);
    expect(started).toContain('!fresh');
  });

  it('does not double-release the slot when a waiting or paused attempt is cancelled', () => {
    // A slot-accounting bug (releasing the running count a second time for a
    // key that already released it on entering waiting/paused) would only
    // show up once *another* run genuinely holds the slot at cancel time —
    // the test above cancels 'w'/'p' after their slot has already gone to a
    // later run, but never checks that cancelling them leaves that run's
    // slot alone. This does, chaining the same relay through both cases:
    // 'w' (waiting, released) -> 'b' (active) -> 'b' (paused, released) ->
    // 'c' (active, was queued) -> 'd' (queued).
    const { started, optionsOf, runners } = controllableAttempts();
    const { runs } = manager({ runners });

    const waitingRun = runs.trigger(crInput('w'), 1); // takes the only slot
    optionsOf.get('!w')!.onEnterWaiting!(); // enters `waiting`, releasing it
    const holder = runs.trigger(crInput('b'), 1); // takes the freed slot
    expect(runs.get(holder.key)?.lifecycle).toBe('planning');
    const queuedBehindHolder = runs.trigger(crInput('c'), 1); // must stay queued
    expect(queuedBehindHolder.status).toBe('queued');

    // Cancelling a `waiting` attempt must not touch the slot 'b' genuinely
    // holds: a double release would drop `running` to 0 and let 'c' start
    // past the limit-1 cap.
    runs.cancel(waitingRun.key);
    expect(started).toEqual(['!w', '!b']);
    expect(runs.get(queuedBehindHolder.key)?.status).toBe('queued');

    // Now pause 'b' itself, releasing its slot the same way. 'c' — already
    // queued — legitimately takes it.
    runs.pause(holder.key);
    expect(runs.get(holder.key)?.lifecycle).toBe('paused');
    expect(runs.get(queuedBehindHolder.key)?.lifecycle).toBe('planning');
    const queuedBehindNextHolder = runs.trigger(crInput('d'), 1); // must stay queued
    expect(queuedBehindNextHolder.status).toBe('queued');

    // Cancelling the now-`paused` 'b' must not touch the slot 'c' holds.
    runs.cancel(holder.key);
    expect(started).toEqual(['!w', '!b', '!c']);
    expect(runs.get(queuedBehindNextHolder.key)?.status).toBe('queued');
  });
});

describe('task 12.4: late model/provider work cannot settle an already-terminal attempt', () => {
  it('a late success arriving after cancellation does not overwrite the cancelled state or write a retained review', async () => {
    const { pending, runners } = unresponsiveRunner();
    let expireGrace: (() => void) | undefined;
    const { runs, workspaceState } = manager({
      runners,
      // This fixture never reacts to the cancellation token at all — nothing
      // will ever settle the record on its own, so the bounded grace timer
      // `cancel()` arms is what has to. Triggered explicitly below, rather
      // than left to the default (never-resolving) stand-in.
      cancelGrace: () => new Promise<void>((resolve) => { expireGrace = resolve; }),
    });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    // Cancelling a dispatched run no longer settles it synchronously — see
    // "cancelling a run with already-validated findings keeps them as a
    // partial" below for the path where the attempt actually answers. This
    // fixture's attempt never will, so the grace timer is what eventually
    // settles it.
    expect(runs.get(record.key)?.lifecycle).toBe('cancelling');
    expireGrace?.();
    await vi.waitFor(() => expect(runs.get(record.key)).toBeUndefined());

    // Arrives late; this fixture, unlike `controllableRunners`, never reacted
    // to the cancellation token at all, and now arrives even later than the
    // grace timer that gave up waiting on it.
    pending.get('!2841')!.resolve(response(3));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
    expect(runs.get(record.key)).toBeUndefined();
  });

  it('a late waiting/resuming/checkpoint signal arriving after failure does not move the failed record', async () => {
    const { pending, optionsOf, runners } = controllableAttempts();
    const { runs } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(new Error('boom'));
    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));

    // Stray hook calls racing the rejection — the same seam that could have
    // reported a checkpoint, `onEnterWaiting`, or `onResuming` after the
    // promise it belonged to already settled the record.
    optionsOf.get('!2841')!.onCheckpoint(checkpointAt('verifying', '!2841'));
    optionsOf.get('!2841')!.onEnterWaiting!();
    optionsOf.get('!2841')!.onResuming!();

    expect(runs.get(record.key)?.status).toBe('failed');
    expect(runs.get(record.key)?.lifecycle).toBe('failed');
  });

  it('a late success resolving after the manager already settled the attempt as failed does not overwrite it', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.reject(new Error('crash'));
    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const finishedAt = runs.get(record.key)?.finishedAt;

    // The same deferred cannot resolve twice, so this proves the guard the
    // other way: `completeAttempt` itself refuses to move an already-failed
    // record even when handed a fresh, well-formed succeeded result. Reached
    // via bracket access since it is private — deliberately, to prove the
    // guard fires independently of which public entry point calls it.
    type CompleteAttempt = (key: string, result: HarnessAttemptResult) => Promise<void>;
    await (runs as unknown as { completeAttempt: CompleteAttempt }).completeAttempt(record.key, succeededResult(2, '!2841'));

    expect(runs.get(record.key)?.status).toBe('failed');
    expect(runs.get(record.key)?.finishedAt).toBe(finishedAt);
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });
});

describe('task 12.2/12.4: one active run per target holds through waiting', () => {
  it('refuses a second trigger for a waiting target while a different target runs independently', async () => {
    const { started, optionsOf, runners } = controllableAttempts();
    const { runs } = manager({ runners });

    const waiting = runs.trigger(crInput('waiter'), 2);
    optionsOf.get('!waiter')!.onEnterWaiting!();
    expect(runs.get(waiting.key)?.lifecycle).toBe('waiting');

    // Retriggering the same target returns the existing waiting record, not
    // a second run.
    const retriggered = runs.trigger(crInput('waiter'), 2);
    expect(retriggered.key).toBe(waiting.key);
    expect(retriggered.lifecycle).toBe('waiting');

    // A different target runs completely independently.
    const other = runs.trigger(crInput('other'), 2);
    expect(started).toEqual(['!waiter', '!other']);
    expect(other.status).toBe('running');
  });
});

describe('task 12.1/12.2: completeness, limitations, and partial result come from the attempt\'s own outcome', () => {
  it('a succeeded result reports the attempt\'s own completeness and limitations, not a manager guess', async () => {
    const { pending, runners } = controllableAttempts();
    const changes: RunRecord[] = [];
    const { runs } = manager({ runners, onChange: (r) => changes.push(r) });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));

    // A succeeded record is deleted from `records` once notified (existing
    // behavior) — the notification itself is where this pass's completeness
    // plumbing has to be checked.
    await vi.waitFor(() => expect(changes.some((r) => r.status === 'succeeded')).toBe(true));
    const succeeded = changes.find((r) => r.status === 'succeeded')!;
    expect(succeeded.completeness).toBe('complete');
    expect(succeeded.limitations).toEqual([]);
  });

  it('a failed result with no findings reports completeness "none" and a message built from the outcome\'s limitations', async () => {
    const { pending, runners } = controllableAttempts();
    const changes: RunRecord[] = [];
    const { runs } = manager({ runners, onChange: (r) => changes.push(r) });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('The changed-file inventory is incomplete.', '!2841'));

    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const failed = runs.get(record.key)!;
    expect(failed.completeness).toBe('none');
    expect(failed.limitations).toEqual([{ code: 'harness.test', message: 'The changed-file inventory is incomplete.' }]);
    expect(failed.failure?.message).toContain('The changed-file inventory is incomplete.');
    expect(failed.partialResult).toBeUndefined();
  });

  it('a failed result\'s blockerDetails reach the settled record\'s failure, naming the specific files behind the generic message (task: say which files)', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs } = manager({ runners });
    const blockerDetails: readonly CompletionBlockerDetail[] = [
      { blocker: 'insufficientRiskCoverage', clause: 'configuredRiskCoverageSatisfied', memberId: 'm1', path: 'src/auth/token.ts', message: 'src/auth/token.ts (high risk) was classified but never inspected.', repairable: true },
    ];

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Files at a risk level that requires inspection were not inspected.', '!2841', 0, blockerDetails));

    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const failed = runs.get(record.key)!;
    // The generic summary line survives unchanged.
    expect(failed.failure?.message).toContain('Files at a risk level that requires inspection were not inspected.');
    // The per-file detail underneath it is the outcome's own, verbatim.
    expect(failed.failure?.blockerDetails).toEqual(blockerDetails);
  });

  it('a failed result with validated findings is retained only as an in-memory partial result, never as the retained review', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    const record = runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));

    await vi.waitFor(() => expect(runs.get(record.key)?.status).toBe('failed'));
    const failed = runs.get(record.key)!;
    expect(failed.completeness).toBe('partial');
    expect(failed.partialResult?.items).toHaveLength(2);
    // Never written as the target's retained review — only a `succeeded`
    // result with `outcome.replacesRetainedReview` ever reaches that path.
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });
});

// ---- Task 12.8: partial results are durable, separately reachable, and explicitly incomplete --

describe('task 12.5/12.6: a partial result is durable, separately reachable, and explicitly incomplete', () => {
  const PARTIAL_KEY = partialDraftKeyFor({ repoId: 'repo-1', number: '2841' });

  it('partial after failure: a failed result with validated findings writes a durable partial record, under its own key, before the run is settled', async () => {
    const { pending, runners } = controllableAttempts();
    const seenAtNotify: unknown[] = [];
    const { runs, workspaceState } = manager({
      runners,
      onChange: (record) => {
        if (record.status === 'failed') seenAtNotify.push(workspaceState.get(PARTIAL_KEY));
      },
    });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));
    await vi.waitFor(() => expect(seenAtNotify).toHaveLength(1));

    // Write-before-notify: the durable partial was already there the moment a
    // listener reacted to the failed notification, same discipline as the
    // succeeded path's own retained-review write.
    expect(seenAtNotify[0]).toBeDefined();
    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    expect(partial?.completeness).toBe('partial');
    expect(partial?.draft.review.items).toHaveLength(2);
    // Never the target's retained review.
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });

  it('partial after cancellation: a cancelled result with validated findings writes a durable partial record the same way', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(cancelledResult('!2841', 3));
    // A cancelled record is deleted from `records` once settled (existing
    // behavior — "nothing left to tell a screen that did not see it"); the
    // durable partial write is what this test actually proves.
    await vi.waitFor(() => expect(workspaceState.get(PARTIAL_KEY)).toBeDefined());

    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    expect(partial?.completeness).toBe('partial');
    expect(partial?.draft.review.items).toHaveLength(3);
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeUndefined();
  });

  it('reading a partial record is never indistinguishable from a complete retained review', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));
    await vi.waitFor(() => expect(workspaceState.get(PARTIAL_KEY)).toBeDefined());

    const partial = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true });
    // A reader that forgets `{ partial: true }` still cannot mistake this for
    // a complete review: the record itself always carries its own explicit
    // completeness, never relying on the caller's read-side default.
    const readAsIfMainKey = readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY));
    expect(partial?.completeness).toBe('partial');
    expect(readAsIfMainKey?.completeness).toBe('partial');
    expect(partial?.completeness).not.toBe('complete');
  });

  it('partial non-replacement: a partial result never replaces an existing complete retained review', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    // First run succeeds and writes the retained review.
    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());
    const before = workspaceState.get('codeVerdict.draft.repo-1!2841');

    // A re-run ends partial.
    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('The changed head could not be re-verified.', '!2841', 1));
    await vi.waitFor(() => expect(workspaceState.get(PARTIAL_KEY)).toBeDefined());

    // The complete retained review is untouched — the partial went to its own key.
    expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toEqual(before);
    expect(readRetained(workspaceState.get<SessionDraft>(PARTIAL_KEY), { partial: true })?.completeness).toBe('partial');
  });

  it('a fresh complete success clears a stale partial from an earlier failed run', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, workspaceState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('The changed head could not be re-verified.', '!2841', 1));
    await vi.waitFor(() => expect(workspaceState.get(PARTIAL_KEY)).toBeDefined());

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));
    await vi.waitFor(() => expect(workspaceState.get('codeVerdict.draft.repo-1!2841')).toBeDefined());

    expect(workspaceState.get(PARTIAL_KEY)).toBeUndefined();
  });

  it('a partial result is recorded in run history under its own outcome, never folded into "findings"', async () => {
    const { pending, runners } = controllableAttempts();
    const { runs, globalState } = manager({ runners });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list()).toHaveLength(1));

    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ repoId: 'repo-1', crNumber: '2841', outcome: 'partial', findingCount: 2 });
    // Task 14.4: the same `HarnessAttemptResult.outcome.limitations` the
    // durable partial record carries — never a second read — so a
    // dashboard row can say *why* this is partial, not only that it is.
    expect(new ReviewRunStore(globalState).list()[0]?.limitations).toEqual([
      { code: 'harness.test', message: 'Coverage did not reach every high-risk file.' },
    ]);
  });
});

// ---- Task 14.7: notifications distinguish failed, cancelled, and succeeded outcomes -----

describe('task 14.7: onRunOutcome notifies the terminal states onReviewReady does not cover', () => {
  it('fires for a failed result, naming the finding count kept as a partial', async () => {
    const { pending, runners } = controllableAttempts();
    const outcomes: unknown[] = [];
    const { runs } = manager({ runners, onRunOutcome: (info) => outcomes.push(info) });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('Coverage did not reach every high-risk file.', '!2841', 2));

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({
      lifecycle: 'failed',
      completeness: 'partial',
      refLabel: '!2841',
      ref: { repoId: 'repo-1', number: '2841' },
      podId: 'pod-a',
      findingCount: 2,
    });
  });

  it('fires for a failed result with nothing validated, naming no finding count', async () => {
    const { pending, runners } = controllableAttempts();
    const outcomes: unknown[] = [];
    const { runs } = manager({ runners, onRunOutcome: (info) => outcomes.push(info) });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(failedResult('The changed-file inventory is incomplete.', '!2841'));

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toMatchObject({ lifecycle: 'failed', completeness: 'none', findingCount: undefined });
  });

  it('fires for a cancelled result, whichever of the settlement paths produced it', async () => {
    const { pending, runners } = controllableAttempts();
    const outcomes: unknown[] = [];
    const { runs } = manager({ runners, onRunOutcome: (info) => outcomes.push(info) });

    const record = runs.trigger(crInput('2841'), 3);
    runs.cancel(record.key);
    pending.get('!2841')!.resolve(cancelledResult('!2841', 2));

    await vi.waitFor(() => expect(outcomes).toHaveLength(1));
    expect(outcomes[0]).toEqual({
      lifecycle: 'cancelled',
      completeness: 'partial',
      refLabel: '!2841',
      ref: { repoId: 'repo-1', number: '2841' },
      podId: 'pod-a',
      findingCount: 2,
    });
  });

  it('fires for a cancellation of a run that never dispatched, with nothing to keep as partial', async () => {
    const { runners } = controllableAttempts();
    const outcomes: unknown[] = [];
    const { runs } = manager({ runners, onRunOutcome: (info) => outcomes.push(info) });
    // Limit 1: the first trigger holds the only slot, so the second is
    // genuinely queued — the same "never reached the transport" branch
    // `cancel()`'s own doc comment describes, settling straight to
    // `cancelled` with no attempt to wait on.
    runs.trigger(crInput('other'), 1);
    const queued = runs.trigger(crInput('2841'), 1);

    runs.cancel(queued.key);

    expect(outcomes).toEqual([
      { lifecycle: 'cancelled', completeness: 'none', refLabel: '!2841', ref: { repoId: 'repo-1', number: '2841' }, podId: 'pod-a', findingCount: undefined },
    ]);
  });

  it('never fires for a succeeded result — onReviewReady already covers it, and this would double-notify', async () => {
    const { pending, runners } = controllableAttempts();
    const outcomes: unknown[] = [];
    const ready: unknown[] = [];
    const { runs } = manager({ runners, onRunOutcome: (info) => outcomes.push(info), onReviewReady: (info) => ready.push(info) });

    runs.trigger(crInput('2841'), 3);
    pending.get('!2841')!.resolve(succeededResult(2, '!2841'));

    await vi.waitFor(() => expect(ready).toHaveLength(1));
    expect(outcomes).toEqual([]);
  });
});

// ---- Task 12.7: the activation sweep consults stored checkpoints ------------------------

describe('task 12.7: the activation sweep consults stored checkpoints for a richer interrupted close', () => {
  const SWEEP_RUN_ID = 'run-sweep-1';
  const SWEEP_LINEAGE_ID = 'lineage-sweep-1';

  function sweepSnapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
    return {
      schemaVersion: '1',
      runId: SWEEP_RUN_ID,
      lineageId: SWEEP_LINEAGE_ID,
      attempt: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      targetKind: 'cr',
      members: [
        {
          memberId: 'm1',
          providerId: 'fixture',
          instanceUrl: 'https://example.test',
          ref: { repoId: 'repo-1', number: '42' },
          baseSha: 'base1',
          headSha: 'head1',
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
      effort: 'none',
      effortInstructionDigest: 'digest-effort',
      criteria: DEFAULT_CRITERIA,
      extraInstructionsDigest: 'digest-extra',
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      harnessPolicyVersion: HARNESS_POLICY_VERSION,
      ...overrides,
    };
  }

  const SWEEP_COVERAGE: readonly MemberCoverage[] = [{ memberId: 'm1', manifestComplete: true, totalFiles: 1, files: [] }];

  function fakeSource(sourceId: string, exactContent: string): LedgerEvidenceSource {
    return {
      sourceId,
      digest: sha256Hex(exactContent),
      kind: 'diff',
      repositoryId: 'repo-1',
      baseSha: 'base1',
      headSha: 'head1',
      completeness: 'complete',
      citable: true,
      producedBy: 'provider',
      exactContent,
      runId: SWEEP_RUN_ID,
      lineageId: SWEEP_LINEAGE_ID,
      attempt: 1,
      memberId: 'm1',
      origin: 'diffPage',
      trust: 'untrusted',
      sequence: 1,
      locations: [],
      byteLength: Buffer.byteLength(exactContent, 'utf8'),
    };
  }

  function citedRef(source: LedgerEvidenceSource): CitedEvidenceRef {
    return { sourceId: source.sourceId, digest: source.digest, origin: source.origin, memberId: source.memberId, repositoryId: source.repositoryId, baseSha: source.baseSha, headSha: source.headSha, path: 'file1.ts', range: { startLine: 1, endLine: 1 } };
  }

  function acceptedCandidate(candidateId: string, primary: LedgerEvidenceSource): TrackedCandidate {
    const finding: ValidatedFinding = {
      candidateId,
      memberId: 'm1',
      routing: 'inline',
      item: { id: candidateId, file: 'file1.ts', anchored: true, line: 1, severity: 'major', category: 'security', confidence: 80, title: 'A finding', body: 'Body.', code: '' },
      provenance: { protocolProvenance: 'harness', citations: [], validatedAt: '2026-01-01T00:00:00.000Z' },
      evidence: { repositoryId: primary.repositoryId, baseSha: primary.baseSha, headSha: primary.headSha, primary: citedRef(primary), supporting: [] },
    };
    return { candidateId, state: 'accepted', repairs: 0, reasons: [], finding };
  }

  /** A genuinely nonterminal checkpoint: one real `investigating`-phase activity event, not an empty log (which would derive lifecycle `queued`). */
  function nonterminalActivityEvents() {
    let log = createActivityLog(SWEEP_RUN_ID, SWEEP_LINEAGE_ID, 1);
    log = appendActivityEvent(
      log,
      { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
      { occurredAt: '2026-01-01T00:00:01.000Z', phase: 'investigating', elapsedMs: 1000 },
    );
    return log.events;
  }

  function sweepCheckpointInput(snapshot: ReviewRunSnapshot, overrides: Partial<CheckpointBuildInput> = {}): CheckpointBuildInput {
    return {
      checkpointId: 'ckpt-sweep-1',
      runId: snapshot.runId,
      lineageId: snapshot.lineageId,
      attempt: snapshot.attempt,
      phase: 'investigating',
      reason: 'phaseBoundary',
      occurredAt: '2026-01-01T00:10:00.000Z',
      elapsedMs: 1000,
      snapshotDigest: computeSnapshotDigest(snapshot),
      activityEvents: nonterminalActivityEvents(),
      evidenceSources: [],
      candidates: [],
      contradicted: [],
      budget: ZERO_BUDGET,
      coverage: SWEEP_COVERAGE,
      unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
      retry: INITIAL_RETRY_STATE,
      ...overrides,
    };
  }

  async function addInFlightEntry(globalState: KeyValueStore): Promise<void> {
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!42',
      podId: 'pod-a',
      refLabel: '!42',
      repoId: 'repo-1',
      crNumber: '42',
      startedAt: '2026-01-01T00:05:00.000Z',
      runId: SWEEP_RUN_ID,
      lineageId: SWEEP_LINEAGE_ID,
    });
  }

  // The completeness critic's confirmed race class: `sweepInterruptedRuns` used to clear the WHOLE
  // `InFlightRunStore` list unconditionally once its own (possibly long, `await`-laden) loop finished
  // — `extension.ts` never awaits the sweep before the UI becomes interactive ("the promise is
  // captured, not fired-and-forgotten"), so a fresh trigger's own marker, written under a different
  // key while the sweep was still mid-loop, was silently wiped by that final `clear()`.
  // `InFlightRunStore.removeMany` fixes this by removing only the keys the sweep actually processed.
  it("a live trigger's marker written while the sweep is still processing an earlier leftover entry survives — the sweep removes only the keys it actually processed, never the whole list", async () => {
    const globalState = memoryStore();
    const snapshot = sweepSnapshot();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot), DEFAULT_HARNESS_POLICY);
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    // Only delays the SWEEP's own write below, never the setup writes just above.
    let sweepStarted = false;
    let releaseWrite: (() => void) | undefined;
    const delayedGlobalState: KeyValueStore = {
      get: globalState.get,
      keys: globalState.keys,
      update: async (key, value) => {
        if (sweepStarted && key.startsWith('codeVerdict.harness.lineage.') && releaseWrite === undefined) {
          // Opens a window, below, for a live trigger's own marker to land on the shared store while
          // this leftover entry's own sweep processing is still in flight.
          await new Promise<void>((resolve) => { releaseWrite = resolve; });
        }
        await globalState.update(key, value);
      },
    };
    const delayedHarnessRunStore = createHarnessRunStore(delayedGlobalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });

    sweepStarted = true;
    const swept = sweepInterruptedRuns(delayedGlobalState, { harnessRunStore: delayedHarnessRunStore });
    await vi.waitFor(() => expect(releaseWrite).toBeDefined());

    // A fresh, unrelated trigger's own marker — standing in for `ReviewRunManager.start()`'s own
    // `InFlightRunStore.add` — lands on the same underlying store while the sweep's loop is still
    // mid-flight.
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!99', podId: 'pod-a', refLabel: '!99', repoId: 'repo-1', crNumber: '99',
      startedAt: '2026-01-02T00:00:01.000Z', runId: 'run-live', lineageId: 'lineage-live', attempt: 1,
    });

    releaseWrite!();
    await swept;

    // The leftover entry the sweep actually processed is gone, but the live marker written mid-sweep
    // survives — never wiped by an unconditional clear of the whole list.
    expect(new InFlightRunStore(globalState).list()).toEqual([expect.objectContaining({ key: 'repo-1!99' })]);
  });

  it('interruption: closes an unattached nonterminal checkpoint as interrupted, and records its validated finding count', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const primary = fakeSource('ev_a00000000000000000000000000000', 'exact diff bytes');
    const candidate = acceptedCandidate('cand-1', primary);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot, { evidenceSources: [primary], candidates: [candidate] }), DEFAULT_HARNESS_POLICY);
    expect(built.projection.lifecycle).toBe('investigating'); // sanity: genuinely nonterminal
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(swept).toBe(1);
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ repoId: 'repo-1', crNumber: '42', outcome: 'interrupted', findingCount: 1 });
    // The lineage's own checkpoint is closed as interrupted too, not only the coarse history row.
    const closed = harnessRunStore.latestCheckpoint(SWEEP_LINEAGE_ID);
    expect(closed?.projection.lifecycle).toBe('interrupted');
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  /**
   * The production incident `IntendedTerminal` exists to close, reached through
   * `closeLeftoverInFlightEntry`'s own truthful branch: a writer's own `intendedTerminal` declares
   * `succeeded`, but `projection.lifecycle` was misclassified non-terminal (the documented
   * late/out-of-order activity-event bug). `isCheckpointTerminal` correctly routes this checkpoint
   * into the "already terminal, record it truthfully" branch rather than closing it as
   * `interrupted` — but that branch must then also read the truthful `succeeded` lifecycle, not the
   * misclassified `projection.lifecycle`, when deciding the row's outcome.
   */
  it('a checkpoint whose intendedTerminal says succeeded but whose projection was misclassified non-terminal is recorded as the truthful succeeded outcome, not fought as interrupted nor misreported by its own stale projection', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const primary = fakeSource('ev_a00000000000000000000000000000', 'exact diff bytes');
    const candidate = acceptedCandidate('cand-1', primary);
    const built = buildCheckpoint(
      sweepCheckpointInput(snapshot, {
        evidenceSources: [primary],
        candidates: [candidate],
        intendedTerminal: { lifecycle: 'succeeded', completeness: 'complete' },
      }),
      DEFAULT_HARNESS_POLICY,
    );
    // Sanity: the projection itself really is misclassified non-terminal — the exact disagreement
    // `isCheckpointTerminal` exists to see past.
    expect(built.projection.lifecycle).toBe('investigating');
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(swept).toBe(1);
    // Never `interrupted`: `isCheckpointTerminal` correctly refuses to re-close an
    // `intendedTerminal`-declared-terminal checkpoint. And never a `succeeded` outcome silently
    // relabeled by the stale `investigating` projection either — the row reflects the truthful
    // `succeeded` lifecycle the writer actually declared.
    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ repoId: 'repo-1', crNumber: '42', outcome: 'findings', findingCount: 1 });
    // The persisted checkpoint itself is untouched — never overwritten as interrupted.
    const stillThere = harnessRunStore.latestCheckpoint(SWEEP_LINEAGE_ID);
    expect(stillThere?.projection.lifecycle).toBe('investigating');
    expect(stillThere?.intendedTerminal).toEqual({ lifecycle: 'succeeded', completeness: 'complete' });
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  it('compatible resume: marks a resumable interrupted run when the stored checkpoint is sound', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot), DEFAULT_HARNESS_POLICY);
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ resumable: true });
  });

  // resume-erasure-unscoped-latestcheckpoint (downgraded to minor by the refuter's narrowed
  // reproduction): `InFlightRun` now carries the marker's own `attempt` number so
  // `closeLeftoverInFlightEntry` can tell "this checkpoint IS this marker's own attempt" apart from
  // "this checkpoint belongs to an earlier attempt this marker's own attempt never got as far as
  // writing one of its own" — without that, the second case silently re-derived and overwrote the
  // first attempt's still-correct `resumable: true` row with a bare `{outcome:'interrupted'}`, purely
  // because the second marker's later `startedAt` outran the first row's `ranAt` under
  // `recordIfFresher`'s freshness rule.
  it('resume-erasure-unscoped-latestcheckpoint: a resumed attempt that dies before its own checkpoint does not erase the prior attempt\'s correct resumable row', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot), DEFAULT_HARNESS_POLICY);
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    // Attempt 1's own leftover marker, correctly scoped.
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!42', podId: 'pod-a', refLabel: '!42', repoId: 'repo-1', crNumber: '42',
      startedAt: '2026-01-01T00:05:00.000Z', runId: SWEEP_RUN_ID, lineageId: SWEEP_LINEAGE_ID, attempt: 1,
    });

    // First activation: attempt 1's genuinely nonterminal checkpoint is closed as interrupted, and
    // its sound stored checkpoint earns a resumable row.
    await sweepInterruptedRuns(globalState, { harnessRunStore });
    const before = new ReviewRunStore(globalState).list()[0];
    expect(before).toMatchObject({ outcome: 'interrupted', resumable: true, lineageId: SWEEP_LINEAGE_ID });

    // The reviewer resumes: attempt 2 mints a fresh marker under the same key/lineage, scoped to
    // attempt 2 — but the extension host stops before attempt 2 ever writes its own first checkpoint,
    // so `harnessRunStore.latestCheckpoint(lineageId)` still returns attempt 1's own, now-terminal one.
    await new InFlightRunStore(globalState).add({
      key: 'repo-1!42', podId: 'pod-a', refLabel: '!42', repoId: 'repo-1', crNumber: '42',
      startedAt: '2026-01-03T00:00:00.000Z', runId: SWEEP_RUN_ID, lineageId: SWEEP_LINEAGE_ID, attempt: 2,
    });

    // The next activation's sweep finds attempt 2's own leftover marker.
    await sweepInterruptedRuns(globalState, { harnessRunStore });

    // The prior, still-correct resumable row must survive untouched — never silently overwritten
    // with attempt 2's later timestamp and a bare `{outcome:'interrupted'}` that drops the offer.
    const after = new ReviewRunStore(globalState).list()[0];
    expect(after).toMatchObject({ outcome: 'interrupted', resumable: true, lineageId: SWEEP_LINEAGE_ID });
    expect(after?.ranAt).toBe(before?.ranAt);
    // And attempt 2's own now-stale marker is still cleared, same as any other swept entry.
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
  });

  it('incompatible restart: marks a non-resumable interrupted run when the stored checkpoint fails integrity', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot), DEFAULT_HARNESS_POLICY);
    // A digest that no longer verifies against the stored snapshot — the checkpoint itself is
    // unsound (`checkCheckpointIntegrity`), independent of any live head/model/policy comparison.
    const corrupted: PersistedCheckpoint = { ...built, snapshotDigest: 'stale-digest' };
    await harnessRunStore.writeCheckpoint(corrupted, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(new ReviewRunStore(globalState).list()[0]).toMatchObject({ resumable: false });
  });

  it('a leftover entry with no lineage data to consult falls back to the crude interrupted behavior unchanged', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    // No snapshot/checkpoint ever written for this lineage — exactly today's
    // production reality (nothing on the live execution path writes one yet).
    await addInFlightEntry(globalState);

    const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(swept).toBe(1);
    const entry = new ReviewRunStore(globalState).list()[0];
    expect(entry).toMatchObject({ repoId: 'repo-1', crNumber: '42', outcome: 'interrupted', findingCount: 0 });
    expect(entry?.resumable).toBeUndefined();
  });

  /** A genuinely terminal checkpoint: `nonterminalActivityEvents()` plus the same `terminalResult`
   * fact `harnessAttempt.ts`'s `runPersisting`/`finalizeEscapedError` append. */
  // `runId`/`lineageId` default to the fixed `SWEEP_*` ids every other fixture in this block uses;
  // a caller seeding a *real*, manager-minted lineage (the budget-exhausted resume feature's own
  // tests below) must pass its actual ids instead — `parseActivityEvent`'s own cross-check
  // (`harnessRunStore.ts`) rejects any event whose embedded identity does not match the checkpoint
  // it is read back under, so a mismatch here would silently make the whole stored lineage record
  // fail to parse on the very next read, not merely produce a wrong value.
  function terminalActivityEvents(lifecycle: 'failed' | 'cancelled', runId: string = SWEEP_RUN_ID, lineageId: string = SWEEP_LINEAGE_ID) {
    let log = createActivityLog(runId, lineageId, 1);
    log = appendActivityEvent(
      log,
      { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
      { occurredAt: '2026-01-01T00:00:01.000Z', phase: 'investigating', elapsedMs: 1000 },
    );
    log = appendActivityEvent(
      log,
      {
        kind: 'terminalResult',
        lifecycle,
        completeness: 'none',
        limitations: [
          lifecycle === 'failed'
            ? { code: 'attemptFailed', message: 'An unhandled error ended this attempt.' }
            : { code: 'cancelled', message: 'The reviewer cancelled the run before completion.' },
        ],
      },
      { occurredAt: '2026-01-01T00:00:02.000Z', phase: 'investigating', elapsedMs: 2000 },
    );
    return log.events;
  }

  it.each(['failed', 'cancelled'] as const)(
    "a leftover entry whose lineage already settled terminal in-process (%s) is never re-recorded as interrupted, but still gets a truthful dashboard row",
    async (lifecycle) => {
      const globalState = memoryStore();
      const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
      const snapshot = sweepSnapshot();
      await harnessRunStore.writeSnapshot(snapshot);
      const built = buildCheckpoint(
        sweepCheckpointInput(snapshot, { reason: 'attemptFailed', activityEvents: terminalActivityEvents(lifecycle) }),
        DEFAULT_HARNESS_POLICY,
      );
      expect(built.projection.lifecycle).toBe(lifecycle); // sanity: genuinely terminal already
      await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
      await addInFlightEntry(globalState);

      const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

      // The leftover in-flight marker is still cleared...
      expect(swept).toBe(1);
      expect(new InFlightRunStore(globalState).list()).toEqual([]);
      // ...the stored checkpoint itself is untouched (still its own real lifecycle, not re-closed
      // as `interrupted`)...
      const untouched = harnessRunStore.latestCheckpoint(SWEEP_LINEAGE_ID);
      expect(untouched?.projection.lifecycle).toBe(lifecycle);
      expect(untouched?.checkpointId).toBe(built.checkpointId);
      // ...but the dashboard is not left silent either: a truthful `'partial'` row, mirroring
      // `ReviewRunManager.completeAttempt`'s own settle-path shape for a failed/cancelled result,
      // replaces the old wrong-but-present `'interrupted'` row this guard used to skip entirely.
      expect(new ReviewRunStore(globalState).list()).toEqual([
        expect.objectContaining({
          repoId: 'repo-1',
          crNumber: '42',
          outcome: 'partial',
          findingCount: 0,
          limitations: built.projection.limitations,
        }),
      ]);
      // Budget-exhausted resume feature: the sweep's own live-terminal branch offers a fresh-budget
      // new attempt for exactly the lifecycle `ReviewRunManager.completeAttempt`'s live path does —
      // `'failed'`, never `'cancelled'` (a reviewer's own stop, not this feature's case).
      const row = new ReviewRunStore(globalState).list()[0]!;
      if (lifecycle === 'failed') {
        expect(row.resumable).toBe(true);
        expect(row.lineageId).toBe(SWEEP_LINEAGE_ID);
        expect(deriveRunControls(undefined, row).canStartFreshAttempt).toBe(true);
      } else {
        expect(row.resumable).toBeUndefined();
        expect(row.lineageId).toBeUndefined();
        expect(deriveRunControls(undefined, row).canStartFreshAttempt).toBe(false);
      }
    },
  );

  it('the sweep\'s own live-terminal-checkpoint branch folds a legacy headChanged limitation into an informational note, resumable true — never a refusal, the run persisted before the headChanged-is-not-a-blocker fix', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    let log = createActivityLog(SWEEP_RUN_ID, SWEEP_LINEAGE_ID, 1);
    log = appendActivityEvent(
      log,
      {
        kind: 'terminalResult',
        lifecycle: 'failed',
        completeness: 'none',
        // The generic blocker-mapped shape `classifyOutcome`'s `blockerLimitation` used to write for
        // the retired `headChanged` blocker — a checkpoint (D13) never retains the richer per-member
        // `CompletionBlockerDetail`. Exercises `headMovedNotes`' legacy-code fallback: a run
        // persisted before the headChanged-is-not-a-blocker fix still carries this exact code.
        limitations: [{ code: 'headChanged', message: 'The target head changed after the snapshot was taken.' }],
      },
      { occurredAt: '2026-01-01T00:00:02.000Z', phase: 'investigating', elapsedMs: 2000 },
    );
    const built = buildCheckpoint(sweepCheckpointInput(snapshot, { reason: 'attemptFailed', activityEvents: log.events }), DEFAULT_HARNESS_POLICY);
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);

    await sweepInterruptedRuns(globalState, { harnessRunStore });

    const row = new ReviewRunStore(globalState).list()[0]!;
    // The checkpoint's own integrity is otherwise sound — only the legacy headChanged limitation
    // is in play, and it no longer degrades the offer.
    expect(row.resumable).toBe(true);
    const headMoved = row.resumeReasons?.find((reason) => reason.code === 'headMovedDuringReview');
    expect(headMoved?.message).toContain('The target head changed after the snapshot was taken.');
    expect(headMoved?.message).toContain('A new attempt from this checkpoint reviews that same pinned revision');
    expect(headMoved?.message.toLowerCase()).not.toMatch(/\b(continue|resume|reconnect)\b/);
    expect(deriveRunControls(undefined, row).canStartFreshAttempt).toBe(true);
  });

  it('a richer row a faster new run already recorded for the target survives the terminal-checkpoint branch too', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(
      sweepCheckpointInput(snapshot, { reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed') }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState); // startedAt: '2026-01-01T00:05:00.000Z'
    // A new run on the same target started after the crash, completed, and recorded its own
    // richer row before the sweep's loop reached this leftover entry.
    await new ReviewRunStore(globalState).record({
      repoId: 'repo-1',
      crNumber: '42',
      outcome: 'findings',
      findingCount: 5,
      agentLabel: 'Default review',
      ranAt: '2026-01-01T00:30:00.000Z',
    });

    const swept = await sweepInterruptedRuns(globalState, { harnessRunStore });

    expect(swept).toBe(1);
    expect(new ReviewRunStore(globalState).list()).toEqual([
      { repoId: 'repo-1', crNumber: '42', outcome: 'findings', findingCount: 5, agentLabel: 'Default review', ranAt: '2026-01-01T00:30:00.000Z' },
    ]);
    // The stale marker is still cleared — the guard protects only the dashboard row, and
    // the stored checkpoint itself is left exactly as the terminal-checkpoint branch made it.
    expect(new InFlightRunStore(globalState).list()).toEqual([]);
    expect(harnessRunStore.latestCheckpoint(SWEEP_LINEAGE_ID)?.checkpointId).toBe(built.checkpointId);
  });

  // ---- Task 14.6: ReviewRunManager.resumeRun's own admission/identity lookup ----------

  /** Tracks which of `create`/`createDemo`/`resume` the manager actually called, resolving instantly either way. */
  function trackedRunners(): { calls: string[]; runners: ReviewHarnessFactory } {
    const calls: string[] = [];
    function build(kind: string) {
      return (input: RunInput) => {
        calls.push(kind);
        return { run: () => Promise.resolve(succeededResult(1, input.refLabel)) };
      };
    }
    return { calls, runners: { create: build('create'), createDemo: build('createDemo'), resume: build('resume') } };
  }

  async function seedResumableLineage(globalState: KeyValueStore, harnessRunStore: HarnessRunStore): Promise<void> {
    const snapshot = sweepSnapshot();
    await harnessRunStore.writeSnapshot(snapshot);
    const built = buildCheckpoint(sweepCheckpointInput(snapshot), DEFAULT_HARNESS_POLICY);
    await harnessRunStore.writeCheckpoint(built, DEFAULT_HARNESS_POLICY);
    await addInFlightEntry(globalState);
    await sweepInterruptedRuns(globalState, { harnessRunStore });
  }

  it('resumeRun mints attempt N+1 in the stored run and lineage, and routes execution through the factory\'s resume, never create', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await seedResumableLineage(globalState, harnessRunStore);
    const { calls, runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    const record = runs.resumeRun(crInput('42'), 1);

    expect(record).toBeDefined();
    expect(record?.runId).toBe(SWEEP_RUN_ID);
    expect(record?.lineageId).toBe(SWEEP_LINEAGE_ID);
    expect(record?.attempt).toBe(2); // one past the stored checkpoint's attempt 1
    await vi.waitFor(() => expect(calls).toEqual(['resume']));
  });

  it('resumeRun returns undefined when nothing was ever recorded for this target — no lineage to resume', () => {
    const globalState = memoryStore();
    const { runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    expect(runs.resumeRun(crInput('42'), 1)).toBeUndefined();
  });

  it('resumeRun refuses — returns the existing record — when a run is already in flight for this target, the same admission rule trigger enforces', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await seedResumableLineage(globalState, harnessRunStore);
    const neverResolves = (): ReviewHarnessFactory => {
      const build = () => ({ run: () => new Promise<never>(() => {}) });
      return { create: build, createDemo: build, resume: build };
    };
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners: neverResolves(), cancelGrace: () => new Promise<void>(() => {}) });

    const first = runs.resumeRun(crInput('42'), 1);
    const second = runs.resumeRun(crInput('42'), 1);

    expect(second).toBe(first);
  });

  it('resumeRun refuses a demo target outright — the demo agent has no checkpoint continuity contract, and offering one would write a demo snapshot into a real lineage with no compatibility check at all', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await seedResumableLineage(globalState, harnessRunStore);
    const { calls, runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    const record = runs.resumeRun(crInput('42', { demo: true }), 1);

    expect(record).toBeUndefined();
    expect(calls).toEqual([]);
  });

  // ---- Task 14.6: ReviewRunManager.controlsFor, the manager's own two stores wired through deriveRunControls ----

  it('controlsFor reads the stored ReviewRun for a cr target and offers resume-from-checkpoint once the sweep has recorded a resumable lineage', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });
    await seedResumableLineage(globalState, harnessRunStore);

    const controls = runs.controlsFor(runKeyForCr({ repoId: 'repo-1', number: '42' }), { repoId: 'repo-1', number: '42' });

    expect(controls.canResumeFromCheckpoint).toBe(true);
    expect(controls.canPause).toBe(false);
  });

  it('controlsFor with no ref (a changeset key) never reaches the stored ReviewRun lookup — no offer, even with a resumable cr lineage stored elsewhere', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });
    await seedResumableLineage(globalState, harnessRunStore);

    const controls = runs.controlsFor('changeset:cs-1', undefined);

    expect(controls).toEqual({ canPause: false, canResume: false, canCancel: false, canResumeFromCheckpoint: false, canStartFreshAttempt: false });
  });

  // ---- Budget-exhausted resume (feature): completeAttempt's own live `failed` settle ---

  it('a live failed settle writes lineageId/resumable to the ReviewRun row BEFORE settle notifies, findings or not, so a repainting panel already sees the offer', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { pending, optionsOf, runners } = controllableAttempts();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    const record = runs.trigger(crInput('42'), 1)!;
    const { lineageId, runId } = optionsOf.get('!42')!.identity;

    // Reproduces what the real harness runtime's own `onCheckpoint` (`harnessRuntime.ts`) would
    // already have written against this exact lineage before `completeAttempt` ever runs — the
    // same fixtures `seedResumableLineage`/the sweep tests above use, keyed to this real minted
    // lineage instead of the fixed `SWEEP_*` ids.
    const snapshot = sweepSnapshot({ runId, lineageId, attempt: 1 });
    await harnessRunStore.writeSnapshot(snapshot);
    const checkpoint = buildCheckpoint(
      sweepCheckpointInput(snapshot, { runId, lineageId, reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed', runId, lineageId) }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(checkpoint, DEFAULT_HARNESS_POLICY);

    let controlsAtFailedNotify: RunControls | undefined;
    runs.subscribe((r) => {
      if (r.key === record.key && r.lifecycle === 'failed') {
        controlsAtFailedNotify = runs.controlsFor(runKeyForCr({ repoId: 'repo-1', number: '42' }), { repoId: 'repo-1', number: '42' });
      }
    });

    pending.get('!42')!.resolve(failedResult('Budget exhausted.', '!42', 2));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    // The row a repainting panel reads at the exact moment of the `failed` transition already
    // carries the offer — not merely "eventually", after some unrelated later repaint.
    expect(controlsAtFailedNotify?.canStartFreshAttempt).toBe(true);
    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row).toEqual(
      expect.objectContaining({ outcome: 'partial', findingCount: 2, resumable: true, lineageId }),
    );
  });

  it('a live failed settle with zero findings still writes lineageId/resumable — the offer is the plan and coverage, not only the findings', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { pending, optionsOf, runners } = controllableAttempts();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    runs.trigger(crInput('42'), 1);
    const { lineageId, runId } = optionsOf.get('!42')!.identity;
    const snapshot = sweepSnapshot({ runId, lineageId, attempt: 1 });
    await harnessRunStore.writeSnapshot(snapshot);
    const checkpoint = buildCheckpoint(
      sweepCheckpointInput(snapshot, { runId, lineageId, reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed', runId, lineageId) }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(checkpoint, DEFAULT_HARNESS_POLICY);

    pending.get('!42')!.resolve(failedResult('Budget exhausted.', '!42', 0));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row).toEqual(expect.objectContaining({ outcome: 'partial', findingCount: 0, resumable: true, lineageId }));
  });

  it('a live cancelled settle never writes resumable/lineageId — a reviewer\'s own stop is not this feature\'s case', async () => {
    const globalState = memoryStore();
    const { pending, runners } = controllableAttempts();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    runs.trigger(crInput('42'), 1);
    pending.get('!42')!.resolve(cancelledResult('!42', 3));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row?.outcome).toBe('partial');
    expect(row?.resumable).toBeUndefined();
    expect(row?.lineageId).toBeUndefined();
    expect(deriveRunControls(undefined, row).canStartFreshAttempt).toBe(false);
  });

  it('a live failed settle whose checkpoint fails integrity records resumable: false with reasons, never an offer', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { pending, optionsOf, runners } = controllableAttempts();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    runs.trigger(crInput('42'), 1);
    const { lineageId, runId } = optionsOf.get('!42')!.identity;
    // A stored snapshot whose model differs from the checkpoint's own digest expectation — the
    // ordinary "the checkpoint no longer matches what it claims" integrity failure.
    const snapshot = sweepSnapshot({ runId, lineageId, attempt: 1 });
    await harnessRunStore.writeSnapshot(snapshot);
    const mismatched = sweepSnapshot({ runId, lineageId, attempt: 1, modelId: 'a-different-model' });
    const checkpoint = buildCheckpoint(
      sweepCheckpointInput(mismatched, { runId, lineageId, reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed', runId, lineageId) }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(checkpoint, DEFAULT_HARNESS_POLICY);

    pending.get('!42')!.resolve(failedResult('Budget exhausted.', '!42', 1));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row?.resumable).toBe(false);
    expect(row?.resumeReasons?.length).toBeGreaterThan(0);
    const controls = deriveRunControls(undefined, row);
    expect(controls.canStartFreshAttempt).toBe(false);
    expect(controls.freshAttemptReasons).toEqual(row?.resumeReasons);
  });

  // ---- A moved-head disclosure never degrades the fresh-attempt offer at settle time ----

  it('a live failed settle whose own outcome discloses a moved head records resumable: true, with an informational note — never a refusal a reviewer would have to work around', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { pending, optionsOf, runners } = controllableAttempts();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    runs.trigger(crInput('42'), 1);
    const { lineageId, runId } = optionsOf.get('!42')!.identity;
    // The stored checkpoint's own integrity is otherwise sound (same snapshot/checkpoint pairing
    // the passing "writes lineageId/resumable" test above uses); the outcome fails for an
    // unrelated reason (the generic `harness.test` limitation `failedResult` always carries) while
    // also disclosing a moved head — neither degrades this offer, since a moved head never blocks
    // completion any more (`harnessCompletion.ts`'s D11 rewrite).
    const snapshot = sweepSnapshot({ runId, lineageId, attempt: 1 });
    await harnessRunStore.writeSnapshot(snapshot);
    const checkpoint = buildCheckpoint(
      sweepCheckpointInput(snapshot, { runId, lineageId, reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed', runId, lineageId) }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(checkpoint, DEFAULT_HARNESS_POLICY);

    pending.get('!42')!.resolve(
      failedResult('Budget exhausted.', '!42', 1, undefined, [
        { code: 'headMovedDuringReview', message: 'Member m1: reviewed at aaaaaaa; the branch moved to bbbbbbb during the review — inline comments will anchor to the reviewed revision.' },
      ]),
    );
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row?.resumable).toBe(true);
    const headMoved = row?.resumeReasons?.find((reason) => reason.code === 'headMovedDuringReview');
    expect(headMoved?.message).toContain('reviewed at aaaaaaa; the branch moved to bbbbbbb');
    expect(headMoved?.message).toContain('A new attempt from this checkpoint reviews that same pinned revision');
    // The reviewer-facing wording ban still applies to this text.
    expect(headMoved?.message.toLowerCase()).not.toMatch(/\b(continue|resume|reconnect)\b/);
    const controls = deriveRunControls(undefined, row);
    expect(controls.canStartFreshAttempt).toBe(true);
    expect(controls.freshAttemptReasons).toEqual(row?.resumeReasons);
  });

  it('resumeRun proceeds on a row whose resumeReasons carry only a moved-head disclosure — resume is no longer doomed by it', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await seedResumableLineage(globalState, harnessRunStore);
    // Overwrite the seeded row's own offer with the informational shape `headMovedNotes`
    // produces — resumable stays true, the note just comes along for the ride.
    const runsStore = new ReviewRunStore(globalState);
    const existing = runsStore.byRef().get(crKey('repo-1', '42'))!;
    await runsStore.record({
      ...existing,
      resumable: true,
      resumeReasons: [{ code: 'headMovedDuringReview', message: 'Member m1: reviewed at aaaaaaa; the branch moved to bbbbbbb during the review — inline comments will anchor to the reviewed revision. A new attempt from this checkpoint reviews that same pinned revision — the branch has moved since.' }],
    });
    const { calls, runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    const record = runs.resumeRun(crInput('42'), 1);

    expect(record).toBeDefined();
    await vi.waitFor(() => expect(calls).toEqual(['resume']));
  });

  it('resumeRun on an ordinary same-head budget-exhausted row (no head-moved disclosure) is untouched', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await seedResumableLineage(globalState, harnessRunStore);
    const { calls, runners } = trackedRunners();
    const runs = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners, cancelGrace: () => new Promise<void>(() => {}) });

    const row = new ReviewRunStore(globalState).byRef().get(crKey('repo-1', '42'));
    expect(row?.resumeReasons?.some((reason) => reason.code === 'headMovedDuringReview') ?? false).toBe(false);

    const record = runs.resumeRun(crInput('42'), 1);

    expect(record).toBeDefined();
    await vi.waitFor(() => expect(calls).toEqual(['resume']));
  });

  it('resumeRun on a budget-exhausted row mints attempt N+1 and routes through the factory\'s resume, exactly as for an interrupted lineage', async () => {
    const globalState = memoryStore();
    const harnessRunStore = createHarnessRunStore(globalState, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    const { pending, optionsOf, runners: firstRunners } = controllableAttempts();
    const first = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners: firstRunners, cancelGrace: () => new Promise<void>(() => {}) });

    first.trigger(crInput('42'), 1);
    const { lineageId, runId } = optionsOf.get('!42')!.identity;
    const snapshot = sweepSnapshot({ runId, lineageId, attempt: 1 });
    await harnessRunStore.writeSnapshot(snapshot);
    const checkpoint = buildCheckpoint(
      sweepCheckpointInput(snapshot, { runId, lineageId, reason: 'attemptFailed', activityEvents: terminalActivityEvents('failed', runId, lineageId) }),
      DEFAULT_HARNESS_POLICY,
    );
    await harnessRunStore.writeCheckpoint(checkpoint, DEFAULT_HARNESS_POLICY);
    pending.get('!42')!.resolve(failedResult('Budget exhausted.', '!42', 1));
    await vi.waitFor(() => expect(new ReviewRunStore(globalState).list().length).toBe(1));

    const { calls, runners: secondRunners } = trackedRunners();
    const second = new ReviewRunManager({ workspaceState: memoryStore(), globalState, runners: secondRunners, cancelGrace: () => new Promise<void>(() => {}) });

    const resumed = second.resumeRun(crInput('42'), 1);

    expect(resumed).toBeDefined();
    expect(resumed?.lineageId).toBe(lineageId);
    expect(resumed?.attempt).toBe(2);
    await vi.waitFor(() => expect(calls).toEqual(['resume']));
  });
});

/**
 * Task 14.6: `deriveRunControls` is the single derivation every screen reads
 * (`reviewFlow.ts`'s `controlsFor` call) — tested directly here as a pure
 * function so the full branch matrix is characterized without standing up a
 * manager or a store for each case. `isLegalRunTransition` itself (not a
 * hand-copied boolean) backs every pause/resume/cancel assertion, so this
 * cannot silently drift from the transition table it is meant to mirror.
 */
describe('deriveRunControls (task 14.6): the one derivation every screen reads', () => {
  function live(lifecycle: RunLifecycle): RunRecord {
    return { lifecycle } as RunRecord;
  }
  function stored(over: Partial<ReviewRun> = {}): ReviewRun {
    return {
      repoId: 'repo-1',
      crNumber: '42',
      outcome: 'interrupted',
      findingCount: 0,
      agentLabel: 'Default review',
      ranAt: '2026-01-01T00:00:00.000Z',
      ...over,
    };
  }

  it('a live non-terminal record wins outright: pause/resume/cancel from its own transition validity, checkpoint offer always false', () => {
    const controls = deriveRunControls(live('investigating'), stored({ resumable: true, lineageId: 'lineage-1' }));
    expect(controls).toEqual({
      canPause: isLegalRunTransition('investigating', 'paused'),
      canResume: isLegalRunTransition('investigating', 'resuming'),
      canCancel: isLegalRunTransition('investigating', 'cancelling'),
      canResumeFromCheckpoint: false,
      canStartFreshAttempt: false,
    });
  });

  it('a live TERMINAL record does not suppress the stored offer — only a non-terminal live record takes the first branch', () => {
    const controls = deriveRunControls(live('succeeded'), stored({ resumable: true, lineageId: 'lineage-1' }));
    expect(controls.canResumeFromCheckpoint).toBe(true);
  });

  it('interrupted, resumable, with a recorded lineage: offers resume-from-checkpoint and carries no reasons', () => {
    const controls = deriveRunControls(undefined, stored({ resumable: true, lineageId: 'lineage-1' }));
    expect(controls.canPause).toBe(false);
    expect(controls.canResume).toBe(false);
    expect(controls.canCancel).toBe(false);
    expect(controls.canResumeFromCheckpoint).toBe(true);
    expect(controls.resumeReasons).toBeUndefined();
  });

  it('interrupted, resumable true but no lineageId on record: no offer — resumeRun would have nothing to look up', () => {
    const controls = deriveRunControls(undefined, stored({ resumable: true, lineageId: undefined }));
    expect(controls.canResumeFromCheckpoint).toBe(false);
  });

  it('interrupted, stored checkpoint integrity failed: every reason is surfaced, and there is no offer', () => {
    const reasons: RunControls['resumeReasons'] = [
      { code: 'snapshotDigest', message: 'The stored snapshot no longer matches its own digest.' },
    ];
    const controls = deriveRunControls(undefined, stored({ resumable: false, lineageId: 'lineage-1', resumeReasons: reasons }));
    expect(controls.canResumeFromCheckpoint).toBe(false);
    expect(controls.resumeReasons).toEqual(reasons);
  });

  it('interrupted, a legacy entry the sweep never checked (resumable absent): neither an offer nor a reason — restart is the only path', () => {
    const controls = deriveRunControls(undefined, stored({ resumable: undefined, resumeReasons: undefined, lineageId: undefined }));
    expect(controls.canResumeFromCheckpoint).toBe(false);
    expect(controls.resumeReasons).toBeUndefined();
  });

  it('no live record and an outcome that was never interrupted (or nothing stored at all): every control is false', () => {
    expect(deriveRunControls(undefined, undefined)).toEqual({ canPause: false, canResume: false, canCancel: false, canResumeFromCheckpoint: false, canStartFreshAttempt: false });
    expect(deriveRunControls(undefined, stored({ outcome: 'clean', resumable: true, lineageId: 'lineage-1' })).canResumeFromCheckpoint).toBe(false);
    expect(deriveRunControls(undefined, stored({ outcome: 'partial', resumable: true, lineageId: 'lineage-1' })).canResumeFromCheckpoint).toBe(false);
  });
});
