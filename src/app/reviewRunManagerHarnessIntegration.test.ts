/**
 * Task 12.1/9.6: a genuine end-to-end proof that `ReviewRunManager` drives a
 * *real* `createHarnessAttempt` (`harnessAttempt.ts`), not only the hand-
 * rolled fake attempts `reviewRunManager.test.ts` builds directly. This is
 * deliberately a separate file: the fixtures below (a fake `Connection`, a
 * scripted `HarnessModelSeam`, a real `ReviewRunSnapshot`) mirror
 * `harnessAttempt.test.ts`'s own — copied rather than imported, since that
 * file's helpers are private to it, and this is exactly the kind of small,
 * self-contained test-fixture duplication that is fine even under "reuse,
 * don't reinvent" (the *behavior* under test is never reimplemented, only
 * the fixture literals that describe one scripted scenario).
 *
 * **What this proves.** `optionsOf.get(key).onEnterWaiting`, wired by a real
 * `ReviewHarnessFactory.create` straight into `createHarnessAttempt`'s own
 * `retry.onEnterWaiting`, genuinely fires when `harnessRetry.ts` classifies
 * a computed backoff as long (`longDelayThresholdMs: 0` forces the very
 * first retryable failure to classify that way) — and when it does, the
 * *manager* (not a test calling a hook directly) transitions the record to
 * `waiting` and releases its concurrency slot, exactly as
 * `reviewRunManager.test.ts`'s hand-rolled-fake tests already assert
 * happens when the hook fires.
 *
 * **What this file does not prove, and why.** `onResuming`'s *automatic*
 * production trigger — the model reissuing an operation that previously
 * entered `waiting`, now marked `DispatchControl.resumedAfterWait: true` by
 * `harnessAttempt.ts`'s `dispatchAndTrack` — was a real gap when this file
 * was first written (task 12.1): nothing in `harnessAttempt.ts` constructed
 * one, so this fixture's scripted model (a single `READ_DIFF_TURN` per
 * phase) never needed to reissue the failed call for the test to make its
 * point. A later pass closed that gap and proved it end to end in
 * `harnessAttempt.test.ts`'s own "9.6" test (a real `HarnessAttempt.run()`
 * through a forced wait-then-resume, asserting `onResuming` fires with a
 * fresh `requestId`) — this file was not the place for that proof, since its
 * job is the *manager's* side of the chain (slot release on waiting, FIFO
 * re-entry on resuming, target ownership), not `harnessAttempt.ts`'s own
 * dispatch bookkeeping. This file's own scripted scenario below still never
 * exercises `onResuming` automatically for that reason; the second test
 * below still exercises it only via the reviewer-initiated `resume()` path.
 */
import { describe, expect, it, vi } from 'vitest';
import { createHarnessAttempt, type HarnessAttemptMemberInput, type HarnessModelSeam } from './harnessAttempt';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import {
  ReviewRunManager,
  type HarnessAttemptRunOptions,
  type ReviewHarnessFactory,
  type RunInput,
  type RunRecord,
} from './reviewRunManager';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { KeyValueStore } from './storage';
import { normalizeHarnessPolicy, HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { RunPhase } from '../domain/harnessActivity';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import { ScmError } from '../platform/errors';
import type { Connection, InvestigationOperationCapability, ProviderCapabilities } from '../platform/provider';
import type { ChangedFileEntry, ChangedFileManifestResult, ChangeRequestDetailResult, DiffPageResult } from '../platform/types';

// ---- Fixtures, mirroring harnessAttempt.test.ts's own (see file header) -------------

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

/** `readDiff` rejects with a retryable, transient `ScmError` on its first call — exactly the condition `harnessRetry.ts`'s backoff/wait classification exists for — and succeeds afterward. */
function flakyThenOkConnection(files: readonly string[]): Connection {
  let readDiffCalls = 0;
  return fakeConnection({
    getChangeRequestDetails: async () => changeRequestDetailResult(),
    listChangedFiles: async () => manifestResult(files),
    readDiff: async (request) => {
      readDiffCalls += 1;
      if (readDiffCalls === 1) throw new ScmError('network', 'transient network blip');
      return diffPageResult(request.path);
    },
    getCurrentHead: async () => ({ repoId: SNAPSHOT_REF.repoId, state: 'resolved', headSha: SNAPSHOT_REF.headSha }),
  });
}

function testSnapshot(): ReviewRunSnapshot {
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
  };
}

function member(connection: Connection): HarnessAttemptMemberInput {
  return { memberId: 'm1', connection, capabilities: fullCapabilities() };
}

type ScriptCall = { readonly repairInstruction: string | undefined };
function scriptedModelSeam(script: Partial<Record<RunPhase, readonly string[]>>): HarnessModelSeam {
  const counters: Partial<Record<RunPhase, number>> = {};
  return {
    modelId: 'test-model',
    async askModel({ phase }: { phase: RunPhase } & ScriptCall) {
      const list = script[phase];
      if (!list || list.length === 0) throw new Error(`scriptedModelSeam: phase "${phase}" was never scripted.`);
      const index = counters[phase] ?? 0;
      counters[phase] = index + 1;
      return list[Math.min(index, list.length - 1)]!;
    },
  };
}

function messages(...entries: readonly unknown[]): string {
  return JSON.stringify({ messages: entries });
}

const PLAN_TURN = messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed file.' }] });
const READ_DIFF_TURN = messages({ kind: 'toolRequest', tool: 'readDiff', memberId: 'm1', request: { snapshot: SNAPSHOT_REF, path: 'src/a.ts' } });
const STOP_TURN = messages({ kind: 'publicRationale', rationale: 'No further work is needed right now.' });

let clockValue = 0;
function makeClock(): () => number {
  clockValue = 0;
  return () => {
    clockValue += 1;
    return clockValue;
  };
}

/**
 * A real `ReviewHarnessFactory` (task 12.1): `create` builds an actual
 * `createHarnessAttempt`, wiring the manager's `HarnessAttemptRunOptions`
 * straight into the attempt's own `onCheckpoint`/`retry.onEnterWaiting`/
 * `retry.onResuming` — the production shape task 15.7 will eventually
 * construct against real providers, exercised here against a fake
 * `Connection` instead.
 */
function realHarnessFactory(connection: Connection): ReviewHarnessFactory {
  const build = (_input: RunInput, options: HarnessAttemptRunOptions) =>
    createHarnessAttempt({
      snapshot: testSnapshot(),
      members: [member(connection)],
      modelSeam: scriptedModelSeam({
        planning: [PLAN_TURN],
        investigating: [READ_DIFF_TURN, STOP_TURN],
        verifying: [STOP_TURN],
      }),
      policy: normalizeHarnessPolicy({
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
      }),
      clock: makeClock(),
      now: () => new Date(2026, 0, 1).toISOString(),
      cancellation: options.cancellation,
      onCheckpoint: options.onCheckpoint,
      retry: {
        onEnterWaiting: (info) => options.onEnterWaiting?.({ reason: `Provider retry: ${info.tool}` }),
        onResuming: () => options.onResuming?.(),
        // Forces the very first retryable failure's computed backoff to
        // classify as "long" (harnessRetry.ts's own D12 rule), so this test
        // does not depend on real timers or an exact `Retry-After` value.
        longDelayThresholdMs: 0,
      },
    });
  return { create: build, createDemo: build };
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, update: async (key, value) => { map.set(key, value); } };
}

function crInput(refLabel: string): RunInput {
  return {
    target: {
      kind: 'cr',
      ref: { repoId: 'repo-1', number: '42' },
      diff: { ref: { repoId: 'repo-1', number: '42' }, baseSha: 'base1', headSha: 'head1', files: [], anchorRefs: {} },
    },
    refLabel,
    podId: 'pod-a',
    criteria: DEFAULT_CRITERIA,
    agent: BUILTIN_AGENT_DESCRIPTOR,
    agentLabel: 'Default review',
    modelId: 'test-model',
    effort: 'none',
    timeouts: { inactivityMs: 90_000, ceilingMs: 600_000 },
    contextBudgets: DEFAULT_CONTEXT_BUDGETS,
    steps: [],
    demo: false,
  };
}

describe('task 12.1/9.6: a real HarnessAttempt drives waiting and slot release through the manager', () => {
  it('a real retryable provider failure genuinely fires onEnterWaiting, and the manager releases the slot for it', async () => {
    const runs = new ReviewRunManager({
      workspaceState: memoryStore(),
      globalState: memoryStore(),
      runners: realHarnessFactory(flakyThenOkConnection(['src/a.ts'])),
    });

    // With this pass's fix (below) making a `waiting` result settle on its
    // own, the whole run can complete in well under one `vi.waitFor` polling
    // interval — so the moment to trigger `!second` and prove the slot was
    // released has to be caught synchronously, inside the very notification
    // that reports `waiting`, rather than by polling `runs.get(...)`
    // afterward and risking the run having already moved past it.
    const lifecyclesOfFirst: string[] = [];
    let second: RunRecord | undefined;
    const subscription = runs.subscribe((record) => {
      if (record.input.refLabel !== '!first') return;
      lifecyclesOfFirst.push(record.lifecycle);
      if (record.lifecycle === 'waiting' && !second) second = runs.trigger(crInput('!second'), 1);
    });

    const first = runs.trigger(crInput('!first'), 1); // limit 1: holds the only slot
    expect(first.status).toBe('running');

    await vi.waitFor(() => expect(runs.active().some((r) => r.key === first.key)).toBe(false), { timeout: 4000 });
    subscription.dispose();

    // The real attempt's first `readDiff` request failed once and was
    // classified as a long wait — genuinely reported through `onEnterWaiting`
    // — releasing the slot at once for the independently triggered `!second`
    // to start, even though `!first`'s own `.run()` promise had not resolved.
    expect(lifecyclesOfFirst).toContain('waiting');
    expect(second?.status).toBe('running');

    // The underlying attempt keeps running regardless of the manager's own
    // `waiting` bookkeeping — the real harness engine's "wait" classification
    // (`harnessToolDispatcher.ts`) reports one tool call unavailable and lets
    // the attempt's own turn loop carry on; it never actually suspends the
    // live `.run()` call. That call is still the one authoritative result,
    // and `settle` (this pass's fix, discovered by this very test) performs
    // the "resuming -> prior active phase" hop itself when the result
    // finally arrives, without requiring an external `resume()` first — see
    // `settle`'s own doc comment on why. This is what makes it possible for
    // the run to conclude naturally at all: this fixture's scripted model
    // never reissues the failed `readDiff` call (`investigating` is scripted
    // as exactly one `READ_DIFF_TURN` followed by `STOP_TURN`), so
    // `onResuming` never fires automatically for *this* scenario even with
    // task 9.6's production trigger now wired in `harnessAttempt.ts` (see
    // this file's own header) — without `settle`'s implicit resume, a real
    // `waiting` attempt whose model never asks again would settle its own
    // work and then sit stuck, unable to report it.
    await vi.waitFor(() => expect(runs.active().some((r) => r.key === first.key)).toBe(false), { timeout: 4000 });
    // This minimal script never satisfies the real completion gate (no
    // synthesis/verification collaborator is injected), so the attempt
    // truthfully concludes `failed` rather than a fabricated success — this
    // test's claim is about `waiting`/slot-release/settlement, not about
    // engineering a clean pass through the whole completion gate.
    expect(runs.get(first.key)?.status).toBe('failed');
  });

  it('the reviewer-initiated resume path also works on a still-live waiting attempt (task 14.6\'s future UI control, closed manager-side now)', async () => {
    const runs = new ReviewRunManager({
      workspaceState: memoryStore(),
      globalState: memoryStore(),
      runners: realHarnessFactory(flakyThenOkConnection(['src/a.ts'])),
    });

    // Same reasoning as the test above: catch `waiting` synchronously, from
    // inside the notification that reports it, and call the reviewer-
    // initiated `resume()` immediately — polling afterward risks the run
    // already having settled on its own by the first check.
    let resumedLifecycle: string | undefined;
    const subscription = runs.subscribe((r) => {
      if (r.input.refLabel !== '!only' || r.lifecycle !== 'waiting' || resumedLifecycle) return;
      runs.resume(r.key);
      resumedLifecycle = runs.get(r.key)?.lifecycle;
    });

    const record = runs.trigger(crInput('!only'), 1);
    await vi.waitFor(() => expect(runs.active().some((r) => r.key === record.key)).toBe(false), { timeout: 4000 });
    subscription.dispose();

    // Explicitly resuming before the real result arrives did not break
    // anything: the record returned to its prior active phase, and the
    // eventual real result still settled it normally afterward.
    expect(resumedLifecycle).toBe('investigating');
  });
});
