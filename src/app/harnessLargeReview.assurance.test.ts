/**
 * Task 16.2 of `add-agentic-review-harness`: a large-review integration test
 * whose manifest and evidence exceed model input limits, proving paginated
 * investigation, reopenable bootstrap, real coverage, reserved verification,
 * and complete or explicit partial outcome.
 *
 * Drives a real `HarnessAttempt` through `createReviewHarnessFactory`
 * (`./harnessRuntime.ts`) against a fake `Connection` and a scripted model
 * that reads the *real* rendered prompt text (mirroring `harnessRuntime.test.ts`'s
 * own `scriptedRunTurn`), with a small policy so a "large" review is fast to
 * test — per the task brief's explicit instruction to shrink policy limits
 * rather than generate genuinely huge inputs.
 *
 * "Exceeds model input limits" is proven two ways here, deliberately kept
 * separate from each other:
 *
 * - The changed-file manifest itself needs more than one bounded page
 *   (`manifestPageSize` shrunk to 2 against 4 files) — proven by asserting
 *   the real dispatcher/connection exchange exactly the expected number of
 *   pages and that the resulting coverage totals are exact.
 * - The change-request detail section is too large to inline (the fake
 *   connection reports it `truncated`, exactly the provider-side reason D4
 *   names, independent of any model token-count check) — proven by asserting
 *   a marker planted in a discussion note's body is absent from the bootstrap
 *   summary shown at `planning` and present once the model reopens the
 *   section through `getChangeRequestDetails` during `investigating`.
 *
 * `harnessCompletion.scenarios.test.ts`'s own "high-risk reserve use" test
 * (task 8.9) already proves `harnessBudgets.ts`/`harnessCompletion.ts` can
 * support the reserve correctly *given* a caller that reserves with purpose
 * `'highRiskCoverage'` — its own `inspectAll` helper does so by hand. This
 * file's reserve test proves the missing half: that the real orchestrator
 * (`harnessAttempt.ts`) actually chooses that purpose for a real dispatch.
 * It did not, before this pass — see `harnessAttempt.ts`'s own
 * `reserveEligibleCoverageRemains`/`choosePurpose`/`purposeForToolCall` doc
 * comments for the real defect this test found and the fix it now proves.
 *
 * Fixture scaffolding copied from `harnessRuntime.test.ts` (private to that
 * file); no fixture-provider import; `DiffPage.positions` supplied
 * non-empty throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy } from '../domain/harnessPolicy';
import { partitionPool, resolveReservePercents } from './harnessBudgets';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { CrRunTarget, RunInput } from './reviewRunManager';
import type { Connection, ProviderCapabilities, ScmProvider } from '../platform/provider';
import type { ChangedFileEntry, ChangedFileManifestRequest, ChangedFileManifestResult, ChangeRequestDetailRequest, ChangeRequestDetailResult, DiffPageResult, NormalizedDetail } from '../platform/types';

// ---- Fixture scaffolding, copied from harnessRuntime.test.ts ----------------------------

const REPO_ID = 'repo-large';
const CR_NUMBER = '1';
const BASE_SHA = 'base-large-1';
const HEAD_SHA = 'head-large-1';
const PROVIDER_ID = 'fake-large-provider';
const POD_ID = 'pod-large-1';

const HIGH_FILE = 'src/auth/login.ts'; // matches DEFAULT_RISK_FLOOR_RULES' 'path.auth' rule -> risk 'high'
const LOW_FILES = ['src/util1.ts', 'src/util2.ts', 'src/util3.ts'];
const ALL_FILES = [HIGH_FILE, ...LOW_FILES];
const MEMBER_ID = `${REPO_ID}!${CR_NUMBER}`;

const DISCUSSION_MARKER = 'UNIQUE_DISCUSSION_BODY_MARKER_16_2';

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

function largeCapabilities(): ProviderCapabilities {
  const supported = { supported: true, pageBound: { maxPageSize: 100 } };
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    reviewInvestigation: {
      manifests: { supported: true, pageBound: { maxPageSize: 2 } },
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
  return { list: () => [{ id: POD_ID, name: 'Large pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

function registerFakeProvider(connection: Connection): void {
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Large',
    capabilities: largeCapabilities(),
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

function manifestEntry(path: string): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 3, removedLines: 1, byteSize: 100 };
}

function diffPage(path: string): DiffPageResult {
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: { path, patch: `@@ -1,1 +1,1 @@\n-old\n+new (${path})\n`, positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

function smallDetail(): NormalizedDetail {
  return { title: 'A large review fixture', body: 'Touches several files.', labels: [], commits: [{ sha: 'c1', message: 'wip', author: 'a' }], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
}

function fullDetailWithMarker(): NormalizedDetail {
  return {
    ...smallDetail(),
    discussion: [
      { id: 'n1', author: { username: 'reviewer1' }, body: 'First pass looks fine.', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'n2', author: { username: 'reviewer2' }, body: `Second thought: ${DISCUSSION_MARKER}`, createdAt: '2026-01-01T00:01:00.000Z' },
      { id: 'n3', author: { username: 'reviewer3' }, body: 'Agreed, ship it once addressed.', createdAt: '2026-01-01T00:02:00.000Z' },
    ],
  };
}

/** A real `getChangeRequestDetails` mock: the bootstrap-time call (no `section`) reports the
 * detail as `truncated` (D4's provider-side reason, no model-token-count involved); a later
 * reopen call naming a `section` gets the same detail back `complete`, with its full discussion —
 * including the marker note bootstrap could never have shown. */
function changeRequestDetailsHandler(): (request: ChangeRequestDetailRequest) => Promise<ChangeRequestDetailResult> {
  return async (request) => {
    const snapshot = { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA };
    if (request.section === undefined) {
      return { snapshot, state: 'truncated', value: smallDetail() };
    }
    return { snapshot, state: 'complete', value: fullDetailWithMarker() };
  };
}

function manifestHandler(): (request: ChangedFileManifestRequest) => Promise<ChangedFileManifestResult> {
  let calls = 0;
  return async (request) => {
    calls += 1;
    if (calls === 1) return { snapshot: request.snapshot, state: 'paginated', value: [manifestEntry(HIGH_FILE), manifestEntry(LOW_FILES[0]!)], cursor: 'manifest-page-2' };
    return { snapshot: request.snapshot, state: 'complete', value: [manifestEntry(LOW_FILES[1]!), manifestEntry(LOW_FILES[2]!)] };
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
  };
}

function extractSourceIdDigest(prompt: string): { sourceId: string; digest: string } {
  const match = /sourceId=(\S+) digest=(\S+)/.exec(prompt);
  if (!match) throw new Error('test model: expected a citable prior tool result in the rendered prompt');
  return { sourceId: match[1]!, digest: match[2]! };
}

describe('16.2: a review whose manifest and bootstrap evidence exceed a single prompt', () => {
  it('pages the manifest to exhaustion, reopens the summarized bootstrap section, reserves and uses the high-risk investigation reserve once ordinary is spent, produces exact (non-estimated) coverage, and reaches a truthful complete outcome', async () => {
    // Budget arithmetic, computed rather than guessed (advisor guidance): `maxToolRequestsPerAttempt`
    // is split by `partitionPool` into ordinary/highRiskReserve/verificationReserve. Bootstrap spends
    // 3 host-initiated ordinary tool calls (1 detail fetch + 2 manifest pages); investigating then
    // spends 1 (reopen) + 3 (the three low-risk readDiff calls, batched in one turn) = 4 more
    // ordinary — exactly exhausting a 7-unit ordinary lane — so both the high-risk file's own
    // readDiff AND its candidateSubmission, issued after that, MUST draw the reserve (2 units) or
    // fail.
    const TOTAL_TOOL_CALLS = 11;
    const HIGH_RISK_RESERVE_PERCENT = 20;
    const VERIFICATION_RESERVE_PERCENT = 20;
    const percents = resolveReservePercents({ highRiskReservePercent: HIGH_RISK_RESERVE_PERCENT, verificationReservePercent: VERIFICATION_RESERVE_PERCENT });
    const partition = partitionPool(TOTAL_TOOL_CALLS, percents);
    expect(partition.ordinary).toBe(7);
    expect(partition.highRiskReserve).toBe(2);
    expect(partition.verificationReserve).toBe(2);

    const policy = normalizeHarnessPolicy({
      manifestPageSize: 2,
      maxToolRequestsPerAttempt: TOTAL_TOOL_CALLS,
      maxToolRequestsPerTurn: 8,
      maxModelTurnsPerAttempt: 30,
      maxEvidenceBytesPerAttempt: 2_000_000,
      maxToolResultBytes: 64 * 1024,
      diffOrFileReadPageLines: 400,
      highRiskReservePercent: HIGH_RISK_RESERVE_PERCENT,
      verificationReservePercent: VERIFICATION_RESERVE_PERCENT,
      maxElapsedMsPerAttempt: 10_000_000,
      checkpointCadenceToolCalls: 3,
    });

    let manifestCalls = 0;
    const sharedManifestHandler = manifestHandler();
    const connection = fakeConnection({
      getChangeRequestDetails: changeRequestDetailsHandler(),
      listChangedFiles: async (request) => {
        manifestCalls += 1;
        return sharedManifestHandler(request);
      },
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    let investigatingCalls = 0;
    let highRiskRef: { sourceId: string; digest: string } | undefined;
    const runTurn = async (_modelId: string, prompt: string) => {
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const match = /candidateId: (\S+)/.exec(prompt);
        return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
      }
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      if (phase === 'planning') {
        // Bootstrap is attached to every phase's prompt, including this first one — the discussion
        // marker must NOT be visible here: only a truthful count survives the truncated section.
        expect(prompt).not.toContain(DISCUSSION_MARKER);
        expect(prompt).toContain('discussion note(s)');
        return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate every changed file.' }] }] });
      }
      if (phase === 'investigating') {
        investigatingCalls += 1;
        if (investigatingCalls === 1) {
          // Reopen the truncated change-request detail section.
          return JSON.stringify({
            messages: [{ kind: 'toolRequest', tool: 'getChangeRequestDetails', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, number: CR_NUMBER, section: 'discussion' } }],
          });
        }
        if (investigatingCalls === 2) {
          // The reopened full detail — including the marker no summary ever showed — is now visible.
          expect(prompt).toContain(DISCUSSION_MARKER);
          // The three low-risk files, batched in one turn (the protocol permits multiple toolRequest
          // messages per turn).
          return JSON.stringify({
            messages: LOW_FILES.map((path) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path } })),
          });
        }
        if (investigatingCalls === 3) {
          // Ordinary is now exactly spent (bootstrap 3 + reopen 1 + three low-risk reads 3 = 7 of 8);
          // this next request — the required high-risk file — must draw the reserve or be refused.
          return JSON.stringify({
            messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: HIGH_FILE } }],
          });
        }
        if (investigatingCalls === 4) {
          highRiskRef = extractSourceIdDigest(prompt);
          return JSON.stringify({
            messages: [
              {
                kind: 'candidateSubmission',
                candidate: {
                  candidateId: 'cand-high',
                  memberId: MEMBER_ID,
                  file: HIGH_FILE,
                  line: 1,
                  endLine: 1,
                  severity: 'major',
                  category: 'security',
                  confidence: 90,
                  title: 'Issue in the auth path',
                  body: 'A real issue found while investigating the high-risk file.',
                  citations: { primary: { sourceId: highRiskRef.sourceId, digest: highRiskRef.digest, path: HIGH_FILE, range: { startLine: 1, endLine: 1 } } },
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

    const harnessRunStore = createHarnessRunStore(jsonMemoryStore(), { now: () => Date.parse('2026-09-04T00:00:00.000Z') });
    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn, policy, harnessRunStore };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-large-1', lineageId: 'lineage-large-1', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    // 1. The manifest paged to exhaustion: exactly the two pages the fake connection defines,
    // never estimated or guessed at.
    expect(manifestCalls).toBe(2);

    // 2. Real, exact coverage — read straight from the persisted checkpoint's own `coverage`
    // field (`MemberCoverage`), never a percentage or a host-side guess.
    const latest = harnessRunStore.latestCheckpoint(identity.lineageId as never)!;
    const memberCoverage = latest.coverage.find((c) => c.memberId === MEMBER_ID)!;
    expect(memberCoverage.manifestComplete).toBe(true);
    expect(memberCoverage.totalFiles).toBe(ALL_FILES.length);
    expect(memberCoverage.files).toHaveLength(ALL_FILES.length);
    for (const path of ALL_FILES) {
      expect(memberCoverage.files.find((f) => f.path === path)?.state).toBe('inspected');
    }

    // 3. The reserve genuinely absorbed the high-risk file's own read: proven by the fact it
    // succeeded at all, given ordinary was computed to be exactly exhausted by that point.
    expect(highRiskRef).toBeDefined();

    // 4. A truthful complete outcome — one validated finding, never fabricated as clean, and
    // real enough to replace the retained review.
    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.kind).toBe('completeFindings');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.replacesRetainedReview).toBe(true);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.item.file).toBe(HIGH_FILE);
  });
});

describe('16.2: budget genuinely runs out before every required file is covered — the run ends explicitly partial, never a clean result it did not earn', () => {
  it('one validated finding survives, but the review reports partial with a named coverage limitation, never complete or clean', async () => {
    const LOW_FILE = 'src/plain.ts';
    const policy = normalizeHarnessPolicy({
      manifestPageSize: 10, // both files fit one page — this test isolates the reserve exhaustion, not pagination
      maxToolRequestsPerAttempt: 5,
      maxToolRequestsPerTurn: 8,
      maxModelTurnsPerAttempt: 20,
      maxEvidenceBytesPerAttempt: 2_000_000,
      maxToolResultBytes: 64 * 1024,
      highRiskReservePercent: 0,
      verificationReservePercent: 20, // 1 unit reserved, so the completionRequest dispatch itself still succeeds
      maxElapsedMsPerAttempt: 10_000_000,
      checkpointCadenceToolCalls: 3,
    });

    const connection = fakeConnection({
      getChangeRequestDetails: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: smallDetail() }),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [manifestEntry(HIGH_FILE), manifestEntry(LOW_FILE)] }),
      readDiff: async (request) => diffPage(request.path),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    let investigatingCalls = 0;
    let highRiskRef: { sourceId: string; digest: string } | undefined;
    const runTurn = async (_modelId: string, prompt: string) => {
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const match = /candidateId: (\S+)/.exec(prompt);
        return JSON.stringify({ candidateId: match?.[1] ?? 'unknown', contradicted: false });
      }
      const phase = /You are in the "(\w+)" phase/.exec(prompt)?.[1];
      if (phase === 'planning') return JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate.' }] }] });
      if (phase === 'investigating') {
        investigatingCalls += 1;
        if (investigatingCalls === 1) {
          // Ordinary: bootstrap(2) + this readDiff(1) = 3 of 4 ordinary.
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: HIGH_FILE } }] });
        }
        if (investigatingCalls === 2) {
          highRiskRef = extractSourceIdDigest(prompt);
          // The candidateSubmission spends the 4th and last ordinary unit.
          return JSON.stringify({
            messages: [
              {
                kind: 'candidateSubmission',
                candidate: {
                  candidateId: 'cand-high-2',
                  memberId: MEMBER_ID,
                  file: HIGH_FILE,
                  line: 1,
                  endLine: 1,
                  severity: 'blocker',
                  category: 'security',
                  confidence: 95,
                  title: 'Issue in the auth path',
                  body: 'A real issue found before the budget ran out.',
                  citations: { primary: { sourceId: highRiskRef.sourceId, digest: highRiskRef.digest, path: HIGH_FILE, range: { startLine: 1, endLine: 1 } } },
                },
              },
            ],
          });
        }
        if (investigatingCalls === 3) {
          // Ordinary is now spent; not reserve-eligible (low risk), so this is refused.
          return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'readDiff', memberId: MEMBER_ID, request: { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, path: LOW_FILE } }] });
        }
        return JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'No more budget for further investigation.' }] });
      }
      if (phase === 'verifying') return JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'As much as could be covered is covered.' }] });
      throw new Error(`test model: unexpected turn — phase "${phase ?? 'unknown'}"`);
    };

    const deps: HarnessRuntimeDeps = { ...baseDeps(connection), runTurn, policy };
    const factory = createReviewHarnessFactory(deps);
    const identity = { runId: 'run-large-partial', lineageId: 'lineage-large-partial', attempt: 1 };
    const result = await factory.create(runInput(), noopRunOptions(identity)).run();

    expect(result.findings).toHaveLength(1);
    expect(result.outcome.completeness).toBe('partial');
    expect(result.outcome.kind).toBe('partialFindings');
    expect(result.outcome.clean).toBe(false);
    expect(result.outcome.replacesRetainedReview).toBe(false);
    expect(result.outcome.limitations.length).toBeGreaterThan(0);
    expect(result.outcome.limitations.map((l) => l.code)).toContain('insufficientRiskCoverage');
  });
});
