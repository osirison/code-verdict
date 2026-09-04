/**
 * Task 16.4 of `add-agentic-review-harness`: persistence inspection tests
 * proving no raw prompt, model fragment, secret, hidden reasoning, full tool
 * argument, or full tool-output blob enters activity, trace, checkpoints,
 * retained details, or workspace storage.
 *
 * This generalizes `harnessCheckpoint.test.ts`'s own "the marker test" (task
 * 11.2) across every real sink, driven by a genuine end-to-end run rather
 * than a hand-built `CheckpointBuildInput`:
 *
 * - Plants a secret in a genuine provider-reported `unavailable` reason
 *   (flows through the real dispatcher and `appendActivityEvent`'s
 *   sanitizer, not a hand-built activity fact).
 * - Plants "hidden reasoning" as brace-free prose the scripted model prepends
 *   before its real JSON reply — exactly what `harnessProtocol.ts`'s
 *   `extractJsonValue` is documented to tolerate and discard (it slices the
 *   first `{` to the last `}`), so this is the real production path, not a
 *   contrived one.
 * - Plants a padded, argument-shaped blob in a contradiction-check reason
 *   the real `createSynthesisVerification()` collaborator records — the
 *   same field `harnessCheckpoint.test.ts`'s own marker test uses, but here
 *   the reason genuinely originates from a scripted model's reply to a real
 *   contradiction-check turn, not a hand-built `ContradictedFindingRecord`.
 * - Plants a "full tool-output blob" marker in a file that is read but never
 *   cited by any finding, and the deliberate exception's own marker in a
 *   file that *is* cited by a surviving finding — proving the split is real.
 * - Proves no raw prompt ever reaches a persisted sink by asserting a large
 *   fixed substring of the real protocol contract text (`harnessModelSeam.ts`'s
 *   `PROTOCOL_CONTRACT_TEXT`, present in every real rendered prompt) never
 *   appears anywhere persisted.
 *
 * Sinks scanned: the sanitized activity log (`RunRecord.checkpoint.activityLog`,
 * the same sanitized log `HarnessAttemptResult.activityLog` carries), the
 * harness run store's own backing `KeyValueStore` (snapshots + checkpoints —
 * `harnessRunStore.ts`'s persisted, filtered `PersistedCheckpoint`, never the
 * live unfiltered `CheckpointInfo`), the manager's retained-review write
 * (`workspaceState`'s `draftKeyFor`/`partialDraftKeyFor` keys), and
 * `globalState`. `AgentTrace` (the diagnostic-trace sink) already has its
 * own dedicated task 15.6 marker test (`agentTrace.test.ts`) proving the
 * same property for that exact sink; the live runtime path exercised here
 * (`createReviewHarnessFactory`) never itself touches `AgentTrace` — that
 * lives inside `lmAgent.ts`'s `runHarnessModelTurn`, which this file's
 * injected `runTurn` closure stands in for (matching every other harness
 * test's `vscode`-free scaffolding) — so duplicating that test here would
 * not exercise any additional code.
 *
 * Deliberately NOT scanned: the manager's live, never-persisted in-memory
 * `RunRecord.checkpoint.evidenceSources` (the raw, unfiltered evidence
 * ledger `harnessAttempt.ts`'s `reportCheckpoint` hands to `onCheckpoint`
 * every time). That field legitimately holds full exact content for every
 * source, cited or not, while the run is live — it exists so the checkpoint
 * *builder* can decide what to keep; it is never itself written to a
 * `KeyValueStore` (confirmed by reading every `workspaceState.update`/
 * `globalState.update` call site in `reviewRunManager.ts`: each passes a
 * value built by `retainedFromRun`, never the raw record). Scanning it here
 * would produce a false "leak" for the uncited marker with no real defect
 * behind it.
 *
 * Fixture scaffolding copied from `harnessRuntime.test.ts`/
 * `reviewRunManagerHarnessIntegration.test.ts` (private to those files); no
 * fixture-provider import; `DiffPage.positions` supplied non-empty
 * throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy } from '../domain/harnessPolicy';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { draftKeyFor, partialDraftKeyFor } from './retainedReview';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { ReviewRunManager, type CrRunTarget, type RunInput, type RunRecord } from './reviewRunManager';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';
import type { ChangeRequestDetailResult, DiffPageResult } from '../platform/types';

// ---- Fixture scaffolding, copied from harnessRuntime.test.ts ----------------------------

const REPO_ID = 'repo-persist';
const CR_NUMBER = '1';
const BASE_SHA = 'base-persist-1';
const HEAD_SHA = 'head-persist-1';
const PROVIDER_ID = 'fake-persist-provider';
const POD_ID = 'pod-persist-1';
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;

const HIGH_FILE = 'src/auth/login.ts'; // cited by a surviving finding
const UNCITED_FILE = 'src/uncited.ts'; // read, never cited
const SECRET_FAIL_FILE = 'src/secretfail.ts'; // a genuine provider-reported unavailable reason
const CONTRADICTED_FILE = 'src/contradicted.ts'; // cited by a finding the contradiction pass removes

// ---- The planted markers -----------------------------------------------------------------

const SECRET_MARKER = 'MARKER_SECRET_16_4_9f3e7a2c';
const HIDDEN_REASONING_MARKER = 'MARKER_HIDDEN_REASONING_16_4_7f3a2b1c';
const ARGUMENT_MARKER = 'MARKER_FULL_ARGUMENT_BLOB_16_4_4d2e';
const UNCITED_MARKER = 'MARKER_UNCITED_EVIDENCE_16_4_ab12cd';
const CITED_MARKER = 'MARKER_CITED_EVIDENCE_16_4_should_survive_77aa';
/** A ~140-char literal excerpt of `harnessModelSeam.ts`'s own `PROTOCOL_CONTRACT_TEXT` — present
 * verbatim in every real rendered prompt this run produces. If a raw prompt ever leaked into a
 * persisted sink, this exact substring would necessarily come with it. */
const PROMPT_BOILERPLATE_SNIPPET =
  'Reply with exactly one JSON object and nothing else: no prose before or\nafter it, no markdown code fence.';

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

function persistCapabilities(): ProviderCapabilities {
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
  return { list: () => [{ id: POD_ID, name: 'Persist pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

function registerFakeProvider(connection: Connection): void {
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Persist',
    capabilities: persistCapabilities(),
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

/** Every key's serialized value, concatenated into one haystack — "scan everything written". */
function storeHaystack(store: KeyValueStore): string {
  return (store.keys?.() ?? []).map((key) => JSON.stringify(store.get(key))).join('\n');
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

function detailResult(): ChangeRequestDetailResult {
  return {
    snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA },
    state: 'complete',
    value: { title: 'A review with something for every sink', body: 'Plants markers across every kind of content.', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
  };
}

function diffPage(path: string, patch: string): DiffPageResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: { path, patch, positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

function extractSourceIdDigest(prompt: string): { sourceId: string; digest: string } {
  const match = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
  if (!match) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
  return { sourceId: match[1]!, digest: match[2]! };
}

function candidateMessage(candidateId: string, file: string, ref: { sourceId: string; digest: string }, title: string) {
  return {
    kind: 'candidateSubmission',
    candidate: {
      candidateId,
      memberId: MEMBER_ID,
      file,
      line: 1,
      endLine: 1,
      severity: 'major',
      category: 'security',
      confidence: 85,
      title,
      body: `A real finding for ${file}.`,
      citations: { primary: { sourceId: ref.sourceId, digest: ref.digest, path: file, range: { startLine: 1, endLine: 1 } } },
    },
  };
}

describe('16.4: nothing prohibited is persisted anywhere — every real sink, one genuine run', () => {
  it('scans the sanitized activity, the harness run store, and the manager\'s retained-review write for six planted markers; only the cited-evidence marker survives', async () => {
    const connection = fakeConnection({
      getChangeRequestDetails: async () => detailResult(),
      listChangedFiles: async (request) => ({
        snapshot: request.snapshot,
        state: 'complete',
        value: [HIGH_FILE, UNCITED_FILE, SECRET_FAIL_FILE, CONTRADICTED_FILE].map((path) => ({ path, kind: 'modified' as const, binary: false, addedLines: 1, removedLines: 1, byteSize: 10 })),
      }),
      readDiff: async (request) => {
        if (request.path === HIGH_FILE) return diffPage(HIGH_FILE, `@@ -1,1 +1,1 @@\n-old\n+new // ${CITED_MARKER}\n`);
        if (request.path === UNCITED_FILE) return diffPage(UNCITED_FILE, `@@ -1,1 +1,1 @@\n-old\n+new // ${UNCITED_MARKER}\n`);
        if (request.path === CONTRADICTED_FILE) return diffPage(CONTRADICTED_FILE, '@@ -1,1 +1,1 @@\n-old\n+new\n');
        if (request.path === SECRET_FAIL_FILE) {
          // A genuine provider-reported unavailable reason — never thrown, so this is not the
          // retry/backoff (deferred) path at all, matching every other provider-limit test's
          // technique in this suite.
          return { snapshot: request.snapshot, state: 'unavailable', reason: `Bearer sk-live-${SECRET_MARKER}1234567890 was exposed in a log line` };
        }
        throw new Error(`test connection: unexpected readDiff path "${request.path}"`);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    let investigatingCalls = 0;
    let highRef: { sourceId: string; digest: string } | undefined;
    let contradictedRef: { sourceId: string; digest: string } | undefined;
    const runTurn = async (_modelId: string, prompt: string) => {
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const match = /candidateId: (\S+)/.exec(prompt);
        const candidateId = match?.[1] ?? 'unknown';
        // The contradicted candidate's own contradiction-check reply carries the padded,
        // argument-shaped blob — a real model reply, not a hand-built `ContradictedFindingRecord`.
        if (candidateId === 'cand-contradicted') {
          const blob = JSON.stringify({ tool: 'submitCandidateFinding', arguments: { huge: 'x'.repeat(300) } });
          return JSON.stringify({ candidateId, contradicted: true, reason: `${blob}${ARGUMENT_MARKER}` });
        }
        return JSON.stringify({ candidateId, contradicted: false });
      }
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate every file.' }] }] });
      if (phase === 'investigating') {
        investigatingCalls += 1;
        if (investigatingCalls === 1) {
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: HIGH_FILE } }] });
        }
        if (investigatingCalls === 2) {
          highRef = extractSourceIdDigest(prompt);
          return JSON.stringify({ messages: [candidateMessage('cand-high', HIGH_FILE, highRef, 'A real issue in the auth path')] });
        }
        if (investigatingCalls === 3) {
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: UNCITED_FILE } }] });
        }
        if (investigatingCalls === 4) {
          // Read, considered, and never cited — the model finds nothing worth reporting here.
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: SECRET_FAIL_FILE } }] });
        }
        if (investigatingCalls === 5) {
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: CONTRADICTED_FILE } }] });
        }
        if (investigatingCalls === 6) {
          contradictedRef = extractSourceIdDigest(prompt);
          return JSON.stringify({ messages: [candidateMessage('cand-contradicted', CONTRADICTED_FILE, contradictedRef, 'A finding that will be contradicted')] });
        }
        return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Investigation is complete.' }] });
      }
      if (phase === 'verifying') {
        // The hidden-reasoning marker: brace-free prose the model prepends before its real JSON
        // reply — `extractJsonValue` (`harnessProtocol.ts`) slices from the JSON's own first "{" to
        // the last "}", discarding everything before it, exactly like a real model's aside would be.
        const reasoning = `Let me think this through out loud before answering. ${HIDDEN_REASONING_MARKER} Now here is my reply: `;
        return `${reasoning}${JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'As much as could be covered is covered.' }] })}`;
      }
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
    };

    const harnessStore = jsonMemoryStore();
    const workspaceState = jsonMemoryStore();
    const globalState = jsonMemoryStore();
    const harnessRunStore = createHarnessRunStore(harnessStore, { now: () => Date.parse('2026-09-04T00:00:00.000Z') });
    const deps: HarnessRuntimeDeps = {
      podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
      secrets: fakeSecrets,
      discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
      countTokens: async () => undefined,
      runTurn,
      revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
      harnessRunStore,
      policy: normalizeHarnessPolicy({ maxElapsedMsPerAttempt: 10_000_000, maxModelTurnsPerAttempt: 30, maxToolRequestsPerAttempt: 30, checkpointCadenceToolCalls: 2 }),
    };
    const factory = createReviewHarnessFactory(deps);
    const manager = new ReviewRunManager({ workspaceState, globalState, runners: factory });

    const record = manager.trigger(runInput(), 1);
    const settled = await new Promise<RunRecord>((resolve) => {
      const subscription = manager.subscribe((next) => {
        if (next.key !== record.key) return;
        if (next.lifecycle === 'succeeded' || next.lifecycle === 'failed' || next.lifecycle === 'cancelled') {
          subscription.dispose();
          resolve(next);
        }
      });
    });

    // The run genuinely produced real work: one finding survived (HIGH), one was genuinely
    // contradicted and removed (CONTRADICTED_FILE) — proven by the finding count, not assumed.
    // `SECRET_FAIL_FILE`'s genuinely unavailable diff makes this run truthfully partial, not
    // complete (`unavailableOversizedPatch` blocks the gate) — so `RunRecord.response` (set only
    // for a `succeeded`, i.e. complete, lifecycle) stays undefined; the surviving finding lives in
    // the partial retained record the manager writes instead (checked directly, below).
    expect(settled.lifecycle).toBe('failed');
    expect(settled.completeness).toBe('partial');
    expect(highRef).toBeDefined();
    expect(contradictedRef).toBeDefined();
    expect(highRef?.sourceId).not.toBe(contradictedRef?.sourceId);

    // ---- Build the haystacks: every real sink this task names -----------------------------
    const sanitizedActivityHaystack = JSON.stringify(settled.checkpoint?.activityLog.events ?? []);
    const harnessStoreHaystack = storeHaystack(harnessStore); // snapshots + real PersistedCheckpoints
    const workspaceHaystack = storeHaystack(workspaceState); // retained review + partial review
    const globalHaystack = storeHaystack(globalState);
    const everySink = [sanitizedActivityHaystack, harnessStoreHaystack, workspaceHaystack, globalHaystack].join('\n');

    // ---- The five prohibited markers: absent from every sink ------------------------------
    expect(everySink).not.toContain('sk-live-');
    expect(everySink).not.toContain(SECRET_MARKER);
    expect(everySink).not.toContain(HIDDEN_REASONING_MARKER);
    expect(everySink).not.toContain(ARGUMENT_MARKER);
    expect(everySink).not.toContain(UNCITED_MARKER);
    expect(everySink).not.toContain(PROMPT_BOILERPLATE_SNIPPET);

    // ---- The one deliberate exception: cited evidence survives, byte-identical -------------
    expect(harnessStoreHaystack).toContain(CITED_MARKER);

    // ---- Sanity: the sinks actually contain real content (never a trivially-passing empty scan) ---
    expect(sanitizedActivityHaystack.length).toBeGreaterThan(100);
    expect(harnessStoreHaystack.length).toBeGreaterThan(100);
    expect(workspaceHaystack).toContain(HIGH_FILE); // the retained review really does name the finding's file

    // The retained (here: partial) review really landed under the exact key a panel reads back
    // from, with the one surviving finding and nothing for the contradicted one.
    const target = { repoId: REPO_ID, number: CR_NUMBER };
    const retainedKey = settled.completeness === 'complete' ? draftKeyFor(target) : partialDraftKeyFor(target);
    const retained = workspaceState.get<{ review: { items: readonly { file: string }[] } }>(retainedKey);
    expect(retained).toBeDefined();
    expect(retained?.review.items).toHaveLength(1);
    expect(retained?.review.items[0]?.file).toBe(HIGH_FILE);
  });
});
