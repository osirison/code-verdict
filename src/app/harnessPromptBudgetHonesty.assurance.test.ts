/**
 * The per-turn prompt budget's *honesty* guarantee, driven end to end through the real runtime.
 *
 * `harnessPromptBudget.assurance.test.ts` next door proves the ceiling holds. This file proves the
 * thing the ceiling was quietly being held *with*, and must not be.
 *
 * **The live failure.** The admission test in `harnessAttempt.ts` compared an estimated result
 * size — for a whole-file `readDiff`, the manifest's own `byteSize` — against the room left in the
 * turn. What a result really costs the prompt is larger: its rendered envelope
 * (`[result N] tool=readDiff … sourceId= digest= (CITABLE)`), the investigation-map line flipping
 * from `not read` to `read` and gaining the held source id, and whatever else the same turn
 * appends after the decision. Driven through the real runtime on a two-file review at a
 * 120,000-byte cap, sweeping the second read's size, the gap measured 455 bytes:
 *
 *     50,000            served, assembled exactly 120,000
 *     50,001 - 50,45x   FETCHED, THEN DROPPED, assembled 120,001-120,45x
 *     50,46x +          deferred cleanly, nothing fetched
 *
 * A dropped result is a provider call made and evidence bytes charged for content the model is
 * never shown. That is the small half. The large half is that the file was *already marked
 * inspected* by the time the renderer dropped it: coverage claimed a file was read when the model
 * never saw a byte of it, and the completion gate counted it as satisfied. That is precisely the
 * failure this whole body of work exists to remove — the original defect was a forge declining to
 * render a diff, the host calling the file binary, and the gate counting it as done. The same lie,
 * through a new door: our own renderer drops the content and the inventory records an inspection
 * anyway.
 *
 * So the guarantee asserted here is in two parts, in priority order:
 *
 * 1. **A dropped result never counts as inspected.** Whatever the estimate does, if the renderer
 *    removes a result from the assembled prompt the file stays unread, its evidence stops being
 *    citable, and the review reports itself incomplete about it. The backstop is exercised with a
 *    provider that under-reports a file's size in its manifest — a size the host cannot predict
 *    from anything it holds, which is the one shape no accounting fix can close.
 * 2. **The accounting is tight enough that the drop stops happening.** The sweep window above
 *    either serves or defers and never fetches-then-drops; eight candidate submissions sharing a
 *    turn with a read do not push it over; and twenty-four seeded reviews over a realistic file
 *    size distribution raise zero overruns while still reading every changed file.
 *
 * The last clause matters as much as the first: a budget held by never serving content would pass
 * every assertion above and be useless, so every scenario here also asserts the review actually
 * read what it was given.
 *
 * Fixture scaffolding follows `harnessPromptBudget.assurance.test.ts`, which took it from
 * `harnessLargeReview.assurance.test.ts`; no fixture-provider import, `DiffPage.positions`
 * non-empty throughout.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { fakeInvestigationSource } from '../testing/investigationDouble';
import { createEvidenceLedger, type EvidenceLedgerMember } from './harnessEvidenceLedger';
import { resolveCitation } from './harnessCitations';
import { createChangedFileInventory } from './harnessInventory';
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

const REPO_ID = 'repo-honesty';
const CR_NUMBER = '11';
const BASE_SHA = 'base-honesty-1';
const HEAD_SHA = 'head-honesty-1';
const PROVIDER_ID = 'fake-honesty-provider';
const POD_ID = 'pod-honesty-1';

/** The same cap the neighbouring budget assurance uses, so the two files' measurements compare directly. */
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

function honestyCapabilities(): MemberCapabilities {
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
  return { list: () => [{ id: POD_ID, name: 'Honesty pod', providerId: PROVIDER_ID, instanceUrl: 'https://example.test', sources: [], authMode: 'none' as const }] };
}

let registeredConnection: (Connection & Partial<InvestigationOperations>) | undefined;

function suppliedSource(): InvestigationSource | undefined {
  return registeredConnection ? fakeInvestigationSource(registeredConnection) : undefined;
}

function registerFakeProvider(connection: Connection & Partial<InvestigationOperations>): void {
  registeredConnection = connection;
  const provider: ScmProvider = {
    id: PROVIDER_ID,
    displayName: 'Fake Honesty',
    capabilities: honestyCapabilities(),
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

function runOptions(runId: string) {
  return {
    identity: { runId, lineageId: `lin-${runId}`, attempt: 1 },
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
  return { title: 'A change whose diffs do not fit one prompt', body: 'Modules with diffs of assorted sizes.', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
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

/** Every path the map still lists as unread and still readable, in map order — a terminal note means a file no model would ask for again. */
function unreadPaths(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => line.startsWith('  not read ') && !line.includes(' ('))
    .map((line) => line.slice('  not read '.length).split(' ')[0]!)
    .filter((path) => path.startsWith('src/'));
}

/** The map's own word for a file it considers read — the coverage claim, as the model is told it. */
function mapSaysRead(prompt: string, path: string): boolean {
  return prompt.split('\n').some((line) => line.startsWith('  read     ') && line.slice('  read     '.length).split(' ')[0] === path);
}

function readDiffMessages(paths: readonly string[]): string {
  return JSON.stringify({
    messages: paths.map((path) => ({ kind: 'toolRequest', tool: 'readDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { path } })),
  });
}

const PLAN = JSON.stringify({ messages: [{ kind: 'planCreated', items: [{ id: 'p1', description: 'Read every changed module.' }] }] });
const FINISH = JSON.stringify({ messages: [{ kind: 'completionRequest', rationale: 'Every module read; nothing above the floor.' }] });
const RATIONALE = JSON.stringify({ messages: [{ kind: 'publicRationale', rationale: 'Nothing further to read.' }] });

function policyFor(overrides: Record<string, number> = {}) {
  return normalizeHarnessPolicy({
    maxPromptBytesPerTurn: CEILING,
    maxToolRequestsPerTurn: 8,
    maxToolRequestsPerAttempt: 400,
    maxModelTurnsPerAttempt: 60,
    maxEvidenceBytesPerAttempt: 16 * 1024 * 1024,
    maxToolResultBytes: 1024 * 1024,
    maxElapsedMsPerAttempt: 10_000_000,
    ...overrides,
  });
}

// ---- 1. A dropped result must never count as inspected ---------------------------------

describe('a tool result the renderer had to drop', () => {
  /**
   * The one shape no admission arithmetic can close, so the one that proves the backstop rather
   * than the estimate: a provider whose manifest under-reports a file's size. The host admits the
   * read on the manifest's own 1,000 bytes, the provider answers with 130,000, and the assembled
   * prompt goes over the cap with nothing the host could have predicted.
   *
   * Before the fix the run marked the file inspected anyway and — with every other file read —
   * reported itself complete over a file whose diff the model never saw.
   */
  it('leaves its file uninspected, its evidence uncitable, and the review incomplete', async () => {
    const LIAR = 'src/under-reported.ts';
    const ORDINARY = ['src/one.ts', 'src/two.ts'];
    const LIAR_MANIFEST_BYTES = 1_000;
    const LIAR_REAL_BYTES = 130_000;

    const diffCallsByPath = new Map<string, number>();
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({
        snapshot: request.snapshot,
        state: 'complete',
        value: [manifestEntry(LIAR, LIAR_MANIFEST_BYTES), ...ORDINARY.map((path) => manifestEntry(path, 4_000))],
      }),
      readDiff: async (request) => {
        diffCallsByPath.set(request.path, (diffCallsByPath.get(request.path) ?? 0) + 1);
        return diffPage(request.path, request.path === LIAR ? LIAR_REAL_BYTES : 4_000);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    const prompts: string[] = [];
    let sawLiarContent = false;
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
      if (prompt.includes('"planning" phase')) return PLAN;
      // The diff's own first line, not the map's claim about it: this string only ever reaches a
      // prompt when the liar's patch really was rendered into it.
      if (prompt.includes(`+new (${LIAR})`)) sawLiarContent = true;
      const outstanding = unreadPaths(prompt);
      // One at a time, so the liar is a turn's only result and the drop is unambiguous.
      if (outstanding.length > 0) return readDiffMessages(outstanding.slice(0, 1));
      return prompt.includes('"verifying" phase') ? FINISH : RATIONALE;
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy: policyFor() });
    const result = await factory.create(runInput(), runOptions('run-drop-1')).run();

    // The drop really happened — otherwise everything below is vacuous.
    expect(result.outcome.limitations.map((limitation) => limitation.code), 'the fixture must actually force a drop').toContain('promptBudgetOverrun');
    expect(diffCallsByPath.get(LIAR), 'and the liar must really have been fetched').toBeGreaterThanOrEqual(1);
    expect(sawLiarContent, 'the dropped content must never reach a prompt').toBe(false);

    // 1. Coverage, asserted directly: the file the model never saw is not inspected, in every
    //    prompt the model was given after the drop, and in the run's own completeness.
    const afterDrop = prompts.filter((prompt) => !prompt.startsWith(CONTRADICTION_CHECK_MARKER)).slice(-1)[0]!;
    expect(mapSaysRead(afterDrop, LIAR), 'the map must not call a file read whose diff was dropped').toBe(false);
    expect(result.outcome.completeness, 'a review with an unread changed file is not complete').not.toBe('complete');
    expect(result.completionEvaluation?.details.map((entry) => entry.message).join(' ')).toContain(LIAR);

    // 2. The ordinary files were still read — the budget did not buy honesty by serving nothing.
    for (const path of ORDINARY) expect(diffCallsByPath.get(path), path).toBeGreaterThanOrEqual(1);

    // 3. The evidence stops being advertised, from the next prompt on.
    //
    //    Exactly one prompt still names a source id for the dropped read, and it is the prompt the
    //    drop was decided inside: the map is rendered in the same assembly that discovers the
    //    ceiling cannot be held, so the revocation lands a moment too late for that one page. It
    //    is also the prompt carrying the renderer's own "results were withheld" line. The model
    //    can still read that source id and try to cite it, which is precisely why the ledger entry
    //    is revoked and not merely hidden — a citation to it is refused (asserted directly in
    //    `a citation to evidence the model never saw` below).
    const promptsNamingSource = prompts.filter((prompt) => prompt.split('\n').some((line) => line.includes(LIAR) && line.includes('ev_')));
    expect(promptsNamingSource.length, 'only the assembly that decided the drop may still name the source').toBe(1);
    expect(promptsNamingSource[0]).toContain('not shown');

    // 4. The cap held throughout, which is the guarantee the drop exists to protect.
    for (const prompt of prompts) expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(CEILING);
  });
});

// ---- 2. The measured sweep -------------------------------------------------------------

describe('the window where a result used to be fetched and then dropped', () => {
  /**
   * The sweep in this file's header, driven. `A_BYTES` fills the turn so that the second read
   * lands within a few hundred bytes of the cap; the sweep steps the second read across the
   * measured window (50,001-50,45x before the fix) and either side of it.
   *
   * The assertion is the invariant rather than the boundary, because the boundary legitimately
   * moves: once a read is charged its true cost, the largest servable second read is smaller than
   * it was. What may never happen at any size is the middle outcome — a fetch whose bytes the
   * model is never shown.
   */
  const A = 'src/first.ts';
  const B = 'src/second.ts';
  const A_BYTES = 59_714;

  async function drive(bBytes: number): Promise<{ fetchesOfB: number; servedB: boolean; deferredB: boolean; overran: boolean; maxSent: number }> {
    const calls = new Map<string, number>();
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [manifestEntry(A, A_BYTES), manifestEntry(B, bBytes)] }),
      readDiff: async (request) => {
        calls.set(request.path, (calls.get(request.path) ?? 0) + 1);
        return diffPage(request.path, request.path === A ? A_BYTES : bBytes);
      },
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    let askedBoth = false;
    let maxSent = 0;
    let servedB = false;
    let deferredB = false;
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      maxSent = Math.max(maxSent, Buffer.byteLength(prompt, 'utf8'));
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
      if (prompt.includes('"planning" phase')) return PLAN;
      // "Served" means the model actually read B's content in a prompt, not that the host fetched it.
      if (prompt.includes(`+new (${B})`)) servedB = true;
      if (prompt.includes('code=promptBudgetDeferred')) deferredB = true;
      const outstanding = unreadPaths(prompt);
      if (!askedBoth && outstanding.length > 0) {
        askedBoth = true;
        return readDiffMessages([A, B]);
      }
      if (outstanding.length > 0) return readDiffMessages(outstanding.slice(0, 1));
      return prompt.includes('"verifying" phase') ? FINISH : RATIONALE;
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy: policyFor({ maxModelTurnsPerAttempt: 20, maxToolRequestsPerAttempt: 40 }) });
    const result = await factory.create(runInput(), runOptions(`run-sweep-${bBytes}`)).run();
    clearProviders();
    return {
      fetchesOfB: calls.get(B) ?? 0,
      servedB,
      deferredB,
      overran: result.outcome.limitations.some((limitation) => limitation.code === 'promptBudgetOverrun'),
      maxSent,
    };
  }

  it('either serves the read or defers it, and never fetches one it then drops', async () => {
    const sizes = [49_000, 49_681, 49_682, 49_900, 50_000, 50_001, 50_100, 50_200, 50_300, 50_400, 50_450, 50_460, 50_600, 51_000];
    const outcomes: { size: number; fetchesOfB: number; servedB: boolean; deferredB: boolean; overran: boolean; maxSent: number }[] = [];
    for (const size of sizes) outcomes.push({ size, ...(await drive(size)) });

    for (const outcome of outcomes) {
      // Exactly one fetch, and the model saw it. A fetch the model was not shown leaves either a
      // second fetch (the file went back to unread and was asked for again) or none at all — both
      // of which this pair refuses at every size in the window.
      expect(outcome.fetchesOfB, `B=${outcome.size} was fetched ${outcome.fetchesOfB} time(s)`).toBe(1);
      expect(outcome.servedB, `B=${outcome.size} was fetched and then not shown to the model`).toBe(true);
      expect(outcome.overran, `B=${outcome.size} raised promptBudgetOverrun`).toBe(false);
      expect(outcome.maxSent, `B=${outcome.size} sent ${outcome.maxSent} bytes`).toBeLessThanOrEqual(CEILING);
    }
    // And the sweep must really cross the boundary, or it proves nothing: some size shares the
    // turn with the first read, some size is deferred to a turn of its own.
    expect(outcomes.some((outcome) => !outcome.deferredB), 'no size ever shared the turn — the fixture never fits').toBe(true);
    expect(outcomes.some((outcome) => outcome.deferredB), 'no size was ever deferred — the fixture never binds').toBe(true);
  }, 300_000);
});

// ---- 3. Submissions sharing a turn with a read -----------------------------------------

describe('a turn that submits eight findings alongside a read', () => {
  /**
   * Candidate submissions used to bypass the budget completely: `dispatchAndTrack` with no
   * admission check and no re-measure, so eight of them sharing a turn with a read widened the
   * accounting gap — the read was admitted against room that eight submission results and eight
   * map lines were about to take. Measured on this fixture, each refused submission costs the
   * assembled prompt 551 bytes, and the turn came out at 121,370 bytes against a 120,000-byte cap
   * with five results dropped at render.
   *
   * The submissions here are deliberately the expensive kind: each cites evidence that is not in
   * the ledger, so validation refuses it and the map carries a reason line for every one of them
   * from that turn on — the worst case the reserve has to cover.
   */
  it('holds the cap without dropping the read', async () => {
    // The first file is sized to fill the turn to within ~1 KB of the cap on its own, which is
    // exactly the room eight submission results and eight map lines take. Anything smaller would
    // pass whatever the accounting did.
    const FILES = ['src/alpha.ts', 'src/beta.ts', 'src/gamma.ts'];
    const sizeOf = (path: string): number => (path === FILES[0] ? 107_000 : 4_000);
    const connection = fakeConnection({
      getChangeRequestDetails: detailsHandler(),
      listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: FILES.map((path) => manifestEntry(path, sizeOf(path))) }),
      readDiff: async (request) => diffPage(request.path, sizeOf(request.path)),
      getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
    });
    registerFakeProvider(connection);

    let submittedTurn = false;
    const prompts: string[] = [];
    const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
      if (prompt.includes('"planning" phase')) return PLAN;
      const outstanding = unreadPaths(prompt);
      if (outstanding.length > 0 && !submittedTurn) {
        submittedTurn = true;
        // The read first, then the eight submissions — the order that leaves the read admitted
        // against room the submissions are about to consume.
        return JSON.stringify({
          messages: [
            { kind: 'toolRequest', tool: 'readDiff', memberId: `${REPO_ID}!${CR_NUMBER}`, request: { path: outstanding[0]! } },
            ...Array.from({ length: 8 }, (_, index) => ({
              kind: 'candidateSubmission',
              candidate: {
                candidateId: `cand-share-${index}`,
                memberId: `${REPO_ID}!${CR_NUMBER}`,
                file: FILES[0]!,
                line: 1,
                endLine: 1,
                severity: 'major',
                category: 'security',
                confidence: 90,
                title: `A finding submitted in the same turn as a read (${index})`,
                body: 'Submitted alongside a read so the turn carries both.',
                citations: { primary: { sourceId: `ev_${'0'.repeat(31)}${index}`, digest: 'a'.repeat(64), path: FILES[0]!, range: { startLine: 1, endLine: 1 } } },
              },
            })),
          ],
        });
      }
      if (outstanding.length > 0) return readDiffMessages(outstanding.slice(0, 1));
      return prompt.includes('"verifying" phase') ? FINISH : RATIONALE;
    };

    const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy: policyFor({ maxToolRequestsPerTurn: 12 }) });
    const result = await factory.create(runInput(), runOptions('run-submissions-1')).run();

    expect(prompts.some((prompt) => prompt.includes('cand-share-0')), 'the submissions must really have been dispatched').toBe(true);
    expect(result.outcome.limitations.map((limitation) => limitation.code)).not.toContain('promptBudgetOverrun');
    for (const prompt of prompts) expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(CEILING);
    // And the review still read everything it was given.
    expect(result.outcome.completeness).toBe('complete');
  }, 120_000);
});

// ---- 4. Seeded reviews over a realistic size distribution -------------------------------

/**
 * A lognormal draw fitted to the file-size distribution this source documents: median 9 KB, mean
 * 17.5 KB, p90 45 KB. `mu = ln(9,216)` sets the median; `sigma = 1.153` sets the mean/median ratio
 * at 1.94, which puts p90 at ~40 KB. Clamped to [400, 100,000] so no single file is terminal at
 * the 192 KB cap — a review that refuses a file terminally would pass an overrun assertion by
 * never serving the file, and that is the outcome these runs exist to rule out.
 */
function seededSizes(seed: number, count: number): number[] {
  let state = seed >>> 0;
  const next = (): number => {
    // A plain 32-bit LCG (Numerical Recipes constants): reproducible across machines and runs,
    // which is what "seeded" has to mean for a measured overrun rate to be re-checkable.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 8) / 0x0100_0000;
  };
  const sizes: number[] = [];
  for (let index = 0; index < count; index += 1) {
    const u1 = Math.max(next(), Number.EPSILON);
    const u2 = next();
    const normal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    sizes.push(Math.min(100_000, Math.max(400, Math.round(Math.exp(Math.log(9_216) + 1.153 * normal)))));
  }
  return sizes;
}

describe('twenty-four seeded reviews over a realistic file size distribution', () => {
  it('raise no prompt budget overrun, and still read every changed file', async () => {
    const SHIPPED_CEILING = 192 * 1024;
    const FILE_COUNT = 30;
    const runs: { seed: number; overran: boolean; maxSent: number; unread: number }[] = [];

    for (let seed = 1; seed <= 24; seed += 1) {
      const sizes = seededSizes(seed, FILE_COUNT);
      const paths = sizes.map((_, index) => `src/seeded/module${index}.ts`);
      const byPath = new Map(paths.map((path, index) => [path, sizes[index]!] as const));
      const fetched = new Set<string>();
      const connection = fakeConnection({
        getChangeRequestDetails: detailsHandler(),
        listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: paths.map((path) => manifestEntry(path, byPath.get(path)!)) }),
        readDiff: async (request) => {
          fetched.add(request.path);
          return diffPage(request.path, byPath.get(request.path) ?? 1_000);
        },
        getCurrentHead: async () => ({ repoId: REPO_ID, state: 'resolved', headSha: HEAD_SHA }),
      });
      registerFakeProvider(connection);

      let maxSent = 0;
      const runTurn: HarnessRuntimeDeps['runTurn'] = async (_modelId, prompt) => {
        maxSent = Math.max(maxSent, Buffer.byteLength(prompt, 'utf8'));
        if (prompt.startsWith(CONTRADICTION_CHECK_MARKER)) return JSON.stringify({ candidateId: 'none', contradicted: false });
        if (prompt.includes('"planning" phase')) return PLAN;
        const outstanding = unreadPaths(prompt);
        if (outstanding.length > 0) return readDiffMessages(outstanding.slice(0, 8));
        return prompt.includes('"verifying" phase') ? FINISH : RATIONALE;
      };

      const policy = policyFor({ maxPromptBytesPerTurn: SHIPPED_CEILING, maxModelTurnsPerAttempt: 80, maxToolRequestsPerAttempt: 400 });
      const factory = createReviewHarnessFactory({ ...baseDeps(runTurn), policy });
      const result = await factory.create(runInput(), runOptions(`run-seed-${seed}`)).run();
      clearProviders();

      runs.push({
        seed,
        overran: result.outcome.limitations.some((limitation) => limitation.code === 'promptBudgetOverrun'),
        maxSent,
        unread: FILE_COUNT - fetched.size,
      });
      expect(maxSent, `seed ${seed} sent ${maxSent} bytes`).toBeLessThanOrEqual(SHIPPED_CEILING);
    }

    const overran = runs.filter((run) => run.overran);
    // Named seeds, not a count: a failure here should say which distribution reproduced it.
    expect(overran.map((run) => run.seed), 'seeded reviews must raise no prompt budget overrun').toEqual([]);
    // The measured maximum across all twenty-four was 195,279 bytes of 196,608 — within 1,329
    // bytes of the cap, which is what makes the zero above mean something. Asserted as a band
    // rather than an exact figure so a framing change is a review, not a red build.
    const maximum = Math.max(...runs.map((run) => run.maxSent));
    expect(maximum, `maximum prompt sent across 24 seeded reviews: ${maximum}`).toBeLessThanOrEqual(SHIPPED_CEILING);
    expect(maximum, 'and the prompts must really approach the cap, or zero overruns proves nothing').toBeGreaterThan(SHIPPED_CEILING * 0.9);
    // The guard against a budget that "passes" by never serving anything: every changed file of
    // every seeded review was actually read.
    for (const run of runs) expect(run.unread, `seed ${run.seed} left ${run.unread} file(s) unread`).toBe(0);
  }, 600_000);
});

// ---- 5. What revocation means, at the two seams that decide it --------------------------

describe('a citation to evidence the model never saw', () => {
  const LEDGER_MEMBER: EvidenceLedgerMember = { memberId: 'm1', repositoryId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
  const PATCH = '@@ -1,2 +1,3 @@\n line one\n+added line two\n line three';

  it('is refused, and told what actually happened rather than that its own diff is "intent" evidence', () => {
    const ledger = createEvidenceLedger({ runId: 'run-1', lineageId: 'lin-1', attempt: 1 }, [LEDGER_MEMBER]);
    const registration = ledger.registerDiffPage('m1', {
      state: 'complete',
      snapshot: { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' },
      value: { path: 'src/auth/token.ts', patch: PATCH, positions: [{ path: 'src/auth/token.ts', side: 'new', line: 2 }] },
    });
    if (!registration.ok) throw new Error(`registration refused: ${registration.code}`);
    const citation = { sourceId: registration.source.sourceId, digest: registration.source.digest, path: 'src/auth/token.ts', range: { startLine: 2, endLine: 2 } };

    // Citable while the model was shown it.
    expect(resolveCitation(ledger, citation).ok).toBe(true);

    // The renderer dropped the result. The fetch happened, so the record stays — with its bytes
    // still charged and its place in append order intact — but nothing may be built on it.
    expect(ledger.revoke(registration.source.sourceId)).toBe(true);
    const refused = resolveCitation(ledger, citation);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.code).toBe('nonCitable');
    expect(refused.ok === false && refused.message).toContain('never shown to you');
    expect(refused.ok === false && refused.message).toContain('request that content again');

    // The record itself: revoked, not deleted, and still counted as fetched.
    expect(ledger.get(registration.source.sourceId)?.revoked).toBe(true);
    expect(ledger.get(registration.source.sourceId)?.citable).toBe(false);
    expect(ledger.size).toBe(1);
    expect(ledger.bytesUsed).toBe(Buffer.byteLength(PATCH, 'utf8'));

    // Idempotent, and honest about a source it does not hold.
    expect(ledger.revoke(registration.source.sourceId)).toBe(true);
    expect(ledger.revoke(`ev_${'0'.repeat(32)}`)).toBe(false);
  });
});

describe('the one backwards edge in the file inventory', () => {
  it('returns an inspected file to classified and leaves every terminal state alone', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' } }]);
    inventory.acceptManifestPage('m1', {
      state: 'complete',
      snapshot: { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' },
      value: [
        { path: 'src/read.ts', kind: 'modified', binary: false, addedLines: 3, removedLines: 1, byteSize: 900 },
        { path: 'src/huge.ts', kind: 'modified', binary: false, addedLines: 9, removedLines: 0, byteSize: 900_000 },
      ],
    });
    inventory.classify('m1', 'src/read.ts', { risk: 'medium' });
    inventory.classify('m1', 'src/huge.ts', { risk: 'medium' });
    inventory.markInspected('m1', 'src/read.ts');
    inventory.markTerminal('m1', 'src/huge.ts', 'oversized', 'Larger than any turn can carry.');

    expect(inventory.file('m1', 'src/read.ts')?.state).toBe('inspected');
    const revoked = inventory.revokeInspection('m1', 'src/read.ts');
    expect(revoked.ok && revoked.changed).toBe(true);
    // Back to classified, with the classification kept: risk was established from the manifest and
    // has nothing to do with whether a diff reached a model.
    expect(inventory.file('m1', 'src/read.ts')?.state).toBe('classified');
    expect(inventory.file('m1', 'src/read.ts')?.risk).toBe('medium');
    expect(inventory.counts('m1').inspected).toBe(0);

    // Idempotent on a file that is not inspected, and no way back out of a terminal state.
    const again = inventory.revokeInspection('m1', 'src/read.ts');
    expect(again.ok && again.changed).toBe(false);
    const terminal = inventory.revokeInspection('m1', 'src/huge.ts');
    expect(terminal.ok && terminal.changed).toBe(false);
    expect(inventory.file('m1', 'src/huge.ts')?.state).toBe('oversized');
  });
});
