/**
 * The per-turn prompt budget, end to end, through the real runtime.
 *
 * **What was wrong.** Prompt size was unbounded. Measured across one 40-call review of this
 * product's own 207-file change, the assembled prompt swung between 55 KB and 426 KB — it is
 * rebuilt every turn rather than accumulated, so its size is decided entirely by how much content
 * the previous turn's tool calls returned. Two runs on a local model died of it: 287 KB produced
 * no output at all inside a 300-second first-output window, while the same model answered
 * 57-150 KB prompts in 90-280 seconds.
 *
 * **What this file proves, on a real `HarnessAttempt` driven by `createReviewHarnessFactory`
 * against a scripted model that reads the real rendered prompt text:**
 *
 * - A turn that asks for more content than the turn has room for is served in the model's own
 *   request order until the next result would breach the ceiling, and then stopped — with the
 *   unserved requests named back to the model, costing nothing, and served on a later turn.
 * - No assembled prompt in a whole review exceeds the setting, in any phase, including the
 *   contradiction-check turn that carries no bootstrap envelope at all.
 * - The renderer's emergency drop never fires. That is the point of asserting it: the ceiling
 *   could be held by dropping results at assembly, but dropping means paying for evidence the
 *   model never sees, so a healthy review must hold it by *not dispatching* instead.
 * - A file whose diff alone is larger than the whole allowance is refused terminally, once, with
 *   its size and the cap in the refusal — never dispatched, and never re-asked in a loop.
 * - Over a thirty-file review that also searches, the *maximum* prompt of every turn and every
 *   phase is at or under the cap, and not one result is dropped. That case is the one the first
 *   two missed: a search has no size anyone can know before it is dispatched, and the host used to
 *   serve it whenever a single byte of the turn was left. Measured here at 114,112 bytes against a
 *   120,000-byte cap across 12 turns; before the fix the same fixture assembled 157,157 bytes and
 *   dropped a paid-for 45 KB search at render.
 *
 * Fixture scaffolding follows `harnessLargeReview.assurance.test.ts`, which took it from
 * `harnessRuntime.test.ts`; no fixture-provider import, `DiffPage.positions` non-empty throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fakeInvestigationSource } from '../testing/investigationDouble';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy } from '../domain/harnessPolicy';
import { BUILTIN_AGENT_DESCRIPTOR } from './agents';
import { createHarnessRunStore } from './harnessRunStore';
import { createReviewHarnessFactory, type HarnessRuntimeDeps } from './harnessRuntime';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import { clearProviders, registerProvider } from '../platform/registry';
import type { KeyValueStore } from './storage';
import { DEFAULT_CONTEXT_BUDGETS } from './reviewContext';
import type { CrRunTarget, RunInput } from './reviewRunManager';
import type { Connection, ScmProvider, MemberCapabilities } from '../platform/provider';
import type { InvestigationOperations, InvestigationSource } from '../platform/types';
import type { ChangedFileEntry, ChangeRequestDetailRequest, ChangeRequestDetailResult, DiffPageResult, NormalizedDetail } from '../platform/types';

const REPO_ID = 'repo-budget';
const CR_NUMBER = '9';
const BASE_SHA = 'base-budget-1';
const HEAD_SHA = 'head-budget-1';
const PROVIDER_ID = 'fake-budget-provider';
const POD_ID = 'pod-budget-1';

/** Twelve ordinary source files, so every one of them must actually be read before the review may complete. */
const FILE_COUNT = 12;
const FILE_BYTES = 20_000;
const FILES = Array.from({ length: FILE_COUNT }, (_, index) => `src/module${index}.ts`);

/** Comfortably above the framing this fixture produces and far below twelve files of content, so the budget has to bind. */
const CEILING = 120_000;

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

function budgetCapabilities(): MemberCapabilities {
  const supported = { supported: true, pageBound: { maxPageSize: 100 } };
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    detailRetrieval: { changeRequestDetails: supported, issueDetails: supported, pagination: { maxPageSize: 100 } },
    reviewInvestigation: {
      manifests: { supported: true, pageBound: { maxPageSize: 100 } },
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
  return { list: () => [{ id: POD_ID, name: 'Budget pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

let registeredConnection: (Connection & Partial<InvestigationOperations>) | undefined;

function suppliedSource(): InvestigationSource | undefined {
  return registeredConnection ? fakeInvestigationSource(registeredConnection) : undefined;
}

function registerFakeProvider(connection: Connection & Partial<InvestigationOperations>): void {
  registeredConnection = connection;
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Budget',
    capabilities: budgetCapabilities(),
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

function runOptions() {
  return {
    identity: { runId: 'run-budget-1', lineageId: 'lin-budget-1', attempt: 1 },
    timeouts: { firstOutputMs: 0, inactivityMs: 0, ceilingMs: 0 },
    onProgress: () => {},
    onAttachmentWarnings: () => {},
    cancellation: { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) },
    onCheckpoint: () => {},
  };
}

function manifestEntry(path: string, byteSize: number): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 400, removedLines: 12, byteSize };
}

/** A patch of exactly `bytes` UTF-8 bytes, so "this read costs 20 KB" is a fact, not an approximation. */
function diffPage(path: string, bytes: number): DiffPageResult {
  const head = `@@ -1,1 +1,1 @@\n-old\n+new (${path})\n`;
  const patch = head + 'x'.repeat(Math.max(0, bytes - Buffer.byteLength(head, 'utf8')));
  return { snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: { path, patch, positions: [{ path, side: 'new', line: 1, endLine: 1 }] } };
}

function detail(): NormalizedDetail {
  return { title: 'A change whose diffs do not fit one prompt', body: 'Twelve modules, twenty kilobytes of diff each.', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
}

function detailsHandler(): (request: ChangeRequestDetailRequest) => Promise<ChangeRequestDetailResult> {
  return async () => ({ snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA }, state: 'complete', value: detail() });
}

function baseDeps(runTurn: HarnessRuntimeDeps['runTurn']): HarnessRuntimeDeps {
  return {
    investigationSource: () => suppliedSource(),
    podStore: fakePodStore() as unknown as HarnessRuntimeDeps['podStore'],
    secrets: fakeSecrets,
    discoverModel: async (modelId: string) => ({ id: modelId, label: 'Test model', description: '', vendor: 'test', family: 'test-model', maxInputTokens: undefined }),
    countTokens: async () => undefined,
    runTurn,
    revalidateAttachments: async (attachments) => ({ attachments: [...attachments], warnings: [] }),
    harnessRunStore: createHarnessRunStore(jsonMemoryStore(), { now: () => Date.parse('2026-09-11T00:00:00.000Z') }),
  };
}

/**
 * Every path the prompt's investigation map still lists as unread *and still readable*, in map
 * order. A line carrying a parenthesised note — `(oversized)`, `(binary)` — names a file in a
 * terminal state, which a model reading its own map would not ask for again either.
 */
function unreadPaths(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('  not read ') && !line.includes(' ('))
    .map((line) => line.slice('  not read '.length).split(' ')[0]!)
    .filter((path) => path.startsWith('src/'));
}

function toolRequests(paths: readonly string[]): string {
  return JSON.stringify({
    messages: paths.map((path) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { path } })),
  });
}

const PLAN = JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Read every changed module.' }] }] });
const FINISH = JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Every module read; nothing above the floor.' }] });
const RATIONALE = JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Nothing further to read.' }] });

interface RecordedTurn {
  readonly prompt: string;
  readonly bytes: number;
  readonly isContradictionCheck: boolean;
}

describe('the per-turn prompt budget, on a review whose diffs do not fit one prompt', () => {
  it('serves what fits, names what it deferred, never exceeds the cap, and still reads every file', async () => {
    const policy = normalizeHarnessPolicy({
      maxPromptBytesPerTurn: CEILING,
      maxToolRequestsPerTurn: 8,
      maxToolRequestsPerAttempt: 120,
      maxModelTurnsPerAttempt: 40,
      maxEvidenceBytesPerAttempt: 8 * 1024 * 1024,
      maxElapsedMsPerAttempt: 10_000_000,
    });

    const diffCallsByPath = new Map<string, number>();
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: FILES.map((path) => manifestEntry(path, FILE_BYTES)) }),
      readDiff: async (request) => {
        diffCallsByPath.set(request.path, (diffCallsByPath.get(request.path) ?? 0) + 1);
        return diffPage(request.path, FILE_BYTES);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const turns: RecordedTurn[] = [];
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      turns.push({ prompt, bytes: Buffer.byteLength(prompt, 'utf8'), isContradictionCheck: prompt.startsWith(CONTRADICTION_CHECK_MARKER) });
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
      if (prompt.includes('"planning" phase')) return PLAN;
      // The whole script: ask for everything the map still calls unread, eight at a time — the
      // per-turn cap — and let the host decide how many of those eight this turn has room for.
      const outstanding = unreadPaths(prompt);
      if (outstanding.length === 0) return FINISH;
      return toolRequests(outstanding.slice(0, 8));
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy });
    const result = await factory.create(runInput(), runOptions()).run();

    // 1. The guarantee, over every prompt of the whole review, in every phase.
    expect(turns.length).toBeGreaterThan(3);
    for (const turn of turns) expect(turn.bytes, `a ${turn.isContradictionCheck ? 'contradiction' : 'phase'} prompt of ${turn.bytes} bytes`).toBeLessThanOrEqual(CEILING);
    expect(turns.some((turn) => turn.isContradictionCheck === false && turn.bytes > CEILING / 2), 'the prompts must actually get large, or this proves nothing').toBe(true);

    // 2. The model was told what was not served, in the shape it can act on: one result per
    //    request it made, carrying the size, the room left, and the fact that nothing was spent.
    const deferring = turns.filter((turn) => turn.prompt.includes('code=promptBudgetDeferred'));
    expect(deferring.length, 'a turn asking for eight 20 KB diffs against a 120 KB cap must be part-served').toBeGreaterThan(0);
    expect(deferring[0]!.prompt).toContain('Not served this turn');
    expect(deferring[0]!.prompt).toContain('request it again next turn');

    // 3. A deferral costs nothing: a file that was deferred and later read was fetched exactly
    //    once from the provider, never once per attempt to read it.
    for (const path of FILES) expect(diffCallsByPath.get(path), path).toBe(1);

    // 4. And the deferred work really was done — every file read, the review complete.
    expect(diffCallsByPath.size).toBe(FILE_COUNT);
    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.completeness).toBe('complete');

    // 5. The ceiling was held by not dispatching, not by dropping already-paid-for results at
    //    assembly. The emergency drop exists; a healthy review must never reach it.
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetOverrun');
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetNoRoom');
  });

  it('refuses a file whose diff alone exceeds the whole allowance — once, terminally, without ever fetching it', async () => {
    const policy = normalizeHarnessPolicy({
      maxPromptBytesPerTurn: CEILING,
      maxToolRequestsPerTurn: 8,
      maxToolRequestsPerAttempt: 120,
      maxModelTurnsPerAttempt: 40,
      maxEvidenceBytesPerAttempt: 8 * 1024 * 1024,
      maxToolResultBytes: 1024 * 1024,
      maxElapsedMsPerAttempt: 10_000_000,
    });

    // One generated file larger than any turn's content allowance, beside two ordinary ones.
    const HUGE = 'src/generated/schema.ts';
    const HUGE_BYTES = 400_000;
    const ORDINARY = ['src/one.ts', 'src/two.ts'];

    const diffCallsByPath = new Map<string, number>();
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({
        snapshot: request.snapshot,
        state: 'complete',
        value: [manifestEntry(HUGE, HUGE_BYTES), ...ORDINARY.map((path) => manifestEntry(path, 4_000))],
      }),
      readDiff: async (request) => {
        diffCallsByPath.set(request.path, (diffCallsByPath.get(request.path) ?? 0) + 1);
        return diffPage(request.path, request.path === HUGE ? HUGE_BYTES : 4_000);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    // Deliberately stubborn: this model asks for the oversized file on every investigating turn it
    // is given, which is exactly the behaviour a budget that merely deferred would ping-pong with.
    let hugeAsks = 0;
    let askedToFinish = false;
    const turns: RecordedTurn[] = [];
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      turns.push({ prompt, bytes: Buffer.byteLength(prompt, 'utf8'), isContradictionCheck: prompt.startsWith(CONTRADICTION_CHECK_MARKER) });
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
      if (prompt.includes('"planning" phase')) return PLAN;
      const outstanding = unreadPaths(prompt);
      if (outstanding.length > 0) return toolRequests(outstanding.slice(0, 8));
      if (hugeAsks < 3) {
        hugeAsks += 1;
        return toolRequests([HUGE]);
      }
      // `completionRequest` is not legal in `investigating`, so the honest way out of that phase
      // is a bare rationale — which is also the stall signal the loop is built to end on.
      return prompt.includes('"verifying" phase') && !askedToFinish ? ((askedToFinish = true), FINISH) : RATIONALE;
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy });
    const result = await factory.create(runInput(), runOptions()).run();

    for (const turn of turns) expect(turn.bytes).toBeLessThanOrEqual(CEILING);

    // Never fetched — not on the first ask, and not on the three deliberate re-asks after it.
    expect(hugeAsks).toBe(3);
    expect(diffCallsByPath.get(HUGE)).toBeUndefined();
    for (const path of ORDINARY) expect(diffCallsByPath.get(path)).toBe(1);

    // Told as what it is, with both numbers and the fact that no turn can carry it — the refusal a
    // model can act on, rather than one it can only obey.
    const refusal = turns.find((turn) => turn.prompt.includes('state=tooLarge'));
    expect(refusal, 'the model must be told why the file was not served').toBeDefined();
    expect(refusal!.prompt).toContain('No turn of this attempt can carry it');
    expect(refusal!.prompt).toContain('400,000');

    // And the loop is closed by the mechanism that already closes it: the refusal is terminal in
    // the inventory, so the map from then on marks the file oversized rather than merely unread,
    // and a model reading its own map has been told not to ask again.
    const afterRefusal = turns.filter((turn) => turn.prompt.includes(`${HUGE} +400/-12 (oversized)`)).at(-1);
    expect(afterRefusal, 'the investigation map must mark the file terminal, not merely unread').toBeDefined();

    // The host converges on its own too, without relying on the model reading that note: a
    // repeated terminal refusal adds no coverage and no evidence, which is the run-in-place signal
    // the phase loop already bounds. Three stubborn re-asks, and the review still ends.
    expect(turns.length, 'a terminal refusal the model keeps re-asking must not spin the review').toBeLessThan(20);

    // And the review reports what it could not read instead of calling itself complete: the file
    // is named, with the budget arithmetic that refused it, in the completion gate's own blocker.
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.limitations.map((limitation) => limitation.code)).toContain('unavailableOversizedPatch');
    expect(result.completionEvaluation?.details.map((detail) => detail.message).join(' ')).toContain(HUGE);

    // Throughout, the cap was never breached and no result was ever dropped at assembly.
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetOverrun');
  });
});

describe('the per-turn prompt budget, when a turn mixes predictable reads with unpredictable searches', () => {
  it('holds the maximum assembled prompt across every turn and every phase at or under the cap, and drops nothing it already paid for', async () => {
    const policy = normalizeHarnessPolicy({
      maxPromptBytesPerTurn: CEILING,
      maxToolRequestsPerTurn: 8,
      maxToolRequestsPerAttempt: 400,
      maxModelTurnsPerAttempt: 80,
      maxEvidenceBytesPerAttempt: 8 * 1024 * 1024,
      maxElapsedMsPerAttempt: 10_000_000,
      searchResultPageBytes: 64 * 1024,
    });

    // Thirty files rather than twelve, so this is a long review — the assertion below is about the
    // maximum over every turn, and a maximum taken over four turns is a sample with a grand name.
    const MANY = Array.from({ length: 30 }, (_, index) => `src/wide${index}.ts`);
    const SEARCH_BYTES = 45_000;
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: MANY.map((path) => manifestEntry(path, FILE_BYTES)) }),
      readDiff: async (request) => diffPage(request.path, FILE_BYTES),
      searchDiff: async (request) => ({
        snapshot: request.snapshot,
        state: 'complete',
        value: [{ position: { path: MANY[0]!, side: 'new' as const, line: 1, endLine: 1 }, excerpt: 's'.repeat(SEARCH_BYTES) }],
      }),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const turns: RecordedTurn[] = [];
    let cited: { sourceId: string; digest: string } | undefined;
    let submitted = false;
    let searchServed = false;
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      turns.push({ prompt, bytes: Buffer.byteLength(prompt, 'utf8'), isContradictionCheck: prompt.startsWith(CONTRADICTION_CHECK_MARKER) });
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) {
        const id = /candidateId: (\S+)/.exec(prompt)?.[1] ?? 'none';
        return JSON.stringify({ candidateId: id, contradicted: false });
      }
      if (prompt.includes('"planning" phase')) return PLAN;
      if (/tool=searchDiff .*state=complete/.test(prompt)) searchServed = true;
      const citable = /sourceId=(\S+) digest=(\S+) \(CITABLE\)/.exec(prompt);
      if (citable && cited === undefined) cited = { sourceId: citable[1]!, digest: citable[2]! };
      const outstanding = unreadPaths(prompt);
      // Reads first, then a search whose size nothing knew in advance — the exact order that used
      // to fill the turn with predictable content and then overshoot on the unpredictable one.
      if (outstanding.length > 0) {
        return JSON.stringify({
          messages: [
            ...outstanding.slice(0, 7).map((path) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { path } })),
            { kind: 'toolRequest', tool: 'searchDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { query: 'TODO' } },
          ],
        });
      }
      // Once every file is read the turn is empty, so the search that kept being deferred behind
      // five 20 KB diffs is asked for on its own and served — the other half of the reservation
      // rule, and the proof that a deferral is a delay rather than a refusal.
      if (!searchServed) {
        return JSON.stringify({ messages: [{ kind: 'toolRequest', tool: 'searchDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { query: 'TODO' } }] });
      }
      if (cited && !submitted) {
        submitted = true;
        return JSON.stringify({
          messages: [
            {
              kind: 'candidateSubmission',
              candidate: {
                candidateId: 'cand-budget-1',
                memberId: `${REPO_ID}!${CR_NUMBER}`,
                file: MANY[0]!,
                line: 1,
                endLine: 1,
                severity: 'major',
                category: 'security',
                confidence: 90,
                title: 'A defect worth verifying',
                body: 'Found while reading the diff of the first module.',
                citations: { primary: { sourceId: cited.sourceId, digest: cited.digest, path: MANY[0]!, range: { startLine: 1, endLine: 1 } } },
              },
            },
          ],
        });
      }
      return prompt.includes('"verifying" phase') ? FINISH : RATIONALE;
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy });
    const result = await factory.create(runInput(), runOptions()).run();

    // 1. The maximum, over every turn of every phase — not the average, and not a sample.
    const maximum = Math.max(...turns.map((turn) => turn.bytes));
    expect(turns.length, 'this must be a long review, not a sample').toBeGreaterThan(5);
    expect(maximum, `maximum assembled prompt over ${turns.length} turns`).toBeLessThanOrEqual(CEILING);
    expect(maximum, 'and the prompts must actually approach the cap, or this proves nothing').toBeGreaterThan(CEILING / 2);
    expect(turns.some((turn) => turn.isContradictionCheck), 'the contradiction pass must actually run, or its prompts are untested').toBe(true);

    // 2. The search was deferred while the turn was full and served once it was not: a reservation
    //    delays an unpredictable request, it does not refuse it.
    expect(turns.some((turn) => turn.prompt.includes('code=promptBudgetDeferred') && turn.prompt.includes('may return up to')), 'the search must be deferred on a full turn, with its bound named as a bound').toBe(true);
    expect(searchServed, 'and served on an empty one').toBe(true);

    // 3. Zero overruns. The ceiling was held by not fetching, never by fetching and then dropping:
    //    a dropped result is a provider call made, evidence bytes charged, and nothing shown.
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetOverrun');
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetNoRoom');
  });
});
