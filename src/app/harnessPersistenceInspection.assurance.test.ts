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
 * - Plants "hidden reasoning" in the TAIL of a well-formed `publicRationale`
 *   the scripted model sends in the verifying phase: a message kind legal in
 *   that phase, batched with the `completionRequest` that ends it (a legal
 *   batch — the focus rule only bars pairing a completion with tool requests,
 *   candidates, a checkpoint or a plan change). So the turn is ACCEPTED and
 *   the rationale genuinely travels the production path into the sanitized
 *   activity log. The marker sits past `MAX_PUBLIC_TEXT_LENGTH`
 *   (`harnessActivitySanitizer.ts`), the bound that cuts a public field down
 *   before `appendActivityEvent` will store it — "a legitimate field can
 *   still be made to carry a fragment of raw output", which is exactly what a
 *   model padding its private reasoning onto the end of its public narrative
 *   does. The rationale's own first sentence (`PUBLIC_RATIONALE_LEAD`) is
 *   asserted PRESENT in that log, so the marker's absence is that bound doing
 *   work rather than a message that never arrived.
 *
 *   This replaces an earlier planting — brace-free prose prepended before the
 *   JSON reply, documented here as something `extractJsonValue` "tolerates
 *   and discards" — that stopped testing anything when that function was
 *   rewritten to require the turn to begin at the reply's first character.
 *   Prose before the turn is now a loud `noJson` failure, so the marker never
 *   reached the accepted path at all and its absence from every sink was
 *   guaranteed by the reply being thrown away. Every assertion still passed;
 *   none of them still meant what this comment claimed.
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
import { fakeInvestigationSource } from '../testing/investigationDouble';
import { withDecodedForms } from '../testing/secretScan';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy } from '../domain/harnessPolicy';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { draftKeyFor, partialDraftKeyFor } from './retainedReview';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { ReviewRunManager, type CrRunTarget, type RunInput, type RunRecord } from './reviewRunManager';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { MAX_PUBLIC_TEXT_LENGTH } from './harnessActivitySanitizer';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { Connection, ScmProvider, MemberCapabilities } from '../platform/provider';
import type { InvestigationOperations, InvestigationSource } from '../platform/types';
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
/** The same prohibition in the shape that actually defeated the redactor: a credential written as a
 * quoted JSON field. The keyed pattern wanted the key name followed by `:` or `=`, a JSON key has a
 * closing quote in between, and so this form travelled every sink in plain text until the
 * structural layer landed. Planted beside the `Bearer` form because a run carries both. */
const JSON_SECRET_MARKER = 'MARKER_JSON_SECRET_16_4_b71d';
/** And the same prohibition once encoded, which is what makes the decoding scan below worth
 * running: a scan that only ever searches the raw marker proves nothing about a credential that
 * reached a sink base64'd. */
const ENCODED_SECRET_MARKER = 'MARKER_ENCODED_SECRET_16_4_c93f';
/**
 * The provider-reported unavailable reason, carrying all three shapes at once — a scheme-word
 * header, a quoted JSON field, and a base64 credential. Named rather than inlined so its length
 * can be asserted: every marker here must be inside `MAX_PUBLIC_TEXT_LENGTH`, or the sanitizer's
 * 240-character bound would remove the tail of this string and the scan below would pass for a
 * reason that has nothing to do with redaction.
 */
const SECRET_FAIL_REASON = [
  `Bearer sk-live-${SECRET_MARKER}1234567890 was exposed in a log line`,
  `body {"apiKey":"${JSON_SECRET_MARKER}"}`,
  `Authorization: Basic ${Buffer.from(`oauth2:${ENCODED_SECRET_MARKER}`, 'utf8').toString('base64')}`,
].join('; ');
const HIDDEN_REASONING_MARKER = 'MARKER_HIDDEN_REASONING_16_4_7f3a2b1c';
/** The first sentence of the same `publicRationale` that carries the hidden-reasoning marker in its
 * tail. Short, legitimate, public narrative: it MUST reach a sink. Without this the marker scan
 * would pass just as well on a rationale that never flowed anywhere at all. */
const PUBLIC_RATIONALE_LEAD = 'Coverage is as complete as the available diffs allow.';
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

function persistCapabilities(): MemberCapabilities {
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
  return { list: () => [{ id: POD_ID, name: 'Persist pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
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
    timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
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
          return { snapshot: request.snapshot, state: 'unavailable', reason: SECRET_FAIL_REASON };
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
        // The hidden-reasoning marker rides an ACCEPTED turn: a `publicRationale` that is legal in
        // this phase, well-formed, and genuinely appended to the activity log, whose text runs past
        // the public-text bound with the model's private reasoning trailing off the end of it. Both
        // messages parse (`publicRationale` + `completionRequest` is a legal batch — the
        // focus rule only bars batching a completion with tool requests, candidates, a checkpoint
        // or a plan change), so this is a successful turn carrying the marker into the sinks, not a
        // rejected reply whose content never entered the accepted path. See this file's header.
        const rationale = `${PUBLIC_RATIONALE_LEAD} ${'Continuing to reason about the remaining files. '.repeat(12)}${HIDDEN_REASONING_MARKER}`;
        return JSON.stringify({
          messages: [
            { kind: 'publicRationale', rationale },
            { kind: 'completionRequest', rationale: 'As much as could be covered is covered.' },
          ],
        });
      }
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
    };

    const harnessStore = jsonMemoryStore();
    const workspaceState = jsonMemoryStore();
    const globalState = jsonMemoryStore();
    const harnessRunStore = createHarnessRunStore(harnessStore, { now: () => Date.parse('2026-09-04T00:00:00.000Z') });
    const deps: HarnessRuntimeDeps = {
      investigationSource: () => suppliedSource(),
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
    //
    // The route to that ending: the verifying turn is accepted every time and its
    // `completionRequest` is refused every time, because the blocked gate is what a partial run
    // means, so the phase repeats until the attempt's model-turn and tool-call budgets run out.
    // The terminal fact carries `ordinaryBudgetExhausted` for both alongside
    // `unavailableOversizedPatch`. (Before the planting was reworked these same two assertions held
    // for a different reason: the verifying reply failed to parse at all, so the run reached the
    // same ending without the model's completion ever being asked for. That is precisely why they
    // are not, on their own, evidence that anything was carried anywhere.)
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

    // Every marker planted in the unavailable reason has to have been INSIDE the sanitizer's
    // 240-character bound, or its absence below would only mean the tail of that string was
    // truncated — a pass that proves nothing about redaction. Asserted, not eyeballed.
    expect(SECRET_FAIL_REASON.length).toBeLessThanOrEqual(MAX_PUBLIC_TEXT_LENGTH);

    // A raw-substring scan proves less than it looks like it does: a credential that reached a sink
    // base64'd, or JSON-escaped on its way into a stored string, is present and invisible to
    // `toContain`. So the markers are searched again over a haystack that has been decoded first.
    // The self-check on the line below keeps the decoder itself honest — without it, a decoder
    // that silently returned its input would make every assertion that uses it vacuous.
    const everySinkDecoded = withDecodedForms(everySink);
    expect(withDecodedForms(`x ${Buffer.from(`oauth2:${ENCODED_SECRET_MARKER}`, 'utf8').toString('base64')} y`))
      .toContain(ENCODED_SECRET_MARKER);

    // ---- The prohibited markers: absent from every sink, raw and decoded -------------------
    for (const haystack of [everySink, everySinkDecoded]) {
      expect(haystack).not.toContain('sk-live-');
      expect(haystack).not.toContain(SECRET_MARKER);
      expect(haystack).not.toContain(JSON_SECRET_MARKER);
      expect(haystack).not.toContain(ENCODED_SECRET_MARKER);
      expect(haystack).not.toContain(HIDDEN_REASONING_MARKER);
      expect(haystack).not.toContain(ARGUMENT_MARKER);
      expect(haystack).not.toContain(UNCITED_MARKER);
      expect(haystack).not.toContain(PROMPT_BOILERPLATE_SNIPPET);
    }

    // ---- The one deliberate exception: cited evidence survives, byte-identical -------------
    expect(harnessStoreHaystack).toContain(CITED_MARKER);

    // ---- Sanity: the sinks actually contain real content (never a trivially-passing empty scan) ---
    // The hidden-reasoning marker's own non-vacuity check, and the one that makes that scan mean
    // something: the rationale carrying it in its tail really did travel a successful turn into the
    // sanitized activity log, so the marker's absence is the bound doing work rather than a message
    // that never arrived. Without this line the scan would pass just as well on a rejected reply.
    expect(sanitizedActivityHaystack).toContain(PUBLIC_RATIONALE_LEAD);
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
