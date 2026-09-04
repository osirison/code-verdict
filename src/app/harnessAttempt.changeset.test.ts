/**
 * End-to-end multi-member changeset tests for `createHarnessAttempt` (task
 * 13.6 of `add-agentic-review-harness`). Every module `harnessAttempt.ts`
 * wires together (budgets, inventory, completion, candidate validation) is
 * already exercised with real multi-member fixtures in its own test file —
 * `harnessBudgets.test.ts` ("changeset per-member minimums", task 8.6) and
 * `harnessCompletion.test.ts` ("evaluates head and inventory per member of a
 * changeset") in particular. What no test proved before this file is that
 * those per-member guarantees actually survive the *whole* orchestrator —
 * dispatcher, budget, inventory, and completion gate wired together exactly
 * as `harnessAttempt.ts` wires them, not re-assembled by a test.
 *
 * Fixtures below deliberately mirror `harnessAttempt.test.ts`'s single-member
 * fixtures (same helper names/shapes), generalized to take a `RepoFixture`
 * per member so two independent repositories/revisions are always in play.
 *
 * "Member attachment routing" (the seventh 13.6 item) is now covered below,
 * in the final describe block (task 15.2 closed the gap this note used to
 * describe: `harnessAttempt.ts` now renders each member's explicit
 * attachments — `renderAttachmentsForModel`, `reviewContext.ts` — into that
 * member's bootstrap section and registers the same budgeted bytes with
 * `ledger.registerAttachment` once the envelope is confirmed to fit the
 * model). The citation-level routing/ownership rules themselves were already
 * proven at the module level in `harnessCandidateValidation.test.ts`
 * ("rejects a candidate declaring another member as primary target when it
 * cites this member's attachment"); what task 15.2/15.3's own tests below add
 * is proof that a *real* multi-member `HarnessAttempt.run()` — dispatcher,
 * bootstrap, evidence ledger, and candidate validation wired together, not
 * re-assembled by a test — reaches the same outcome.
 */
import { describe, expect, it } from 'vitest';
import { createHarnessAttempt, type HarnessAttemptMemberInput, type HarnessAttemptOptions, type HarnessModelSeam } from './harnessAttempt';
import { sha256Hex } from './contentDigest';
import type { Attachment } from './reviewContext';
import { normalizeHarnessPolicy, HARNESS_POLICY_VERSION, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { RunPhase } from '../domain/harnessActivity';
import type { ReviewRunMemberSnapshot, ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import { ScmError } from '../platform/errors';
import type { Connection, ProviderCapabilities } from '../platform/provider';
import type {
  ChangedFileEntry,
  ChangedFileManifestResult,
  ChangeRequestDetailResult,
  CurrentHeadResult,
  DiffPageResult,
  FileRangeResult,
  NormalizedDetail,
} from '../platform/types';
import type { HostToolResult } from './harnessToolDispatcher';

// ---- Repository fixtures: two independent members, two independent repos --------------

interface RepoFixture {
  readonly repoId: string;
  readonly baseSha: string;
  readonly headSha: string;
}

const CORE: RepoFixture = { repoId: 'repo-core', baseSha: 'base-core', headSha: 'head-core' };
const BILLING: RepoFixture = { repoId: 'repo-billing', baseSha: 'base-billing', headSha: 'head-billing' };

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

function fullCapabilities(): ProviderCapabilities {
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
    reviewInvestigation: {
      manifests: { supported: true, pageBound: { maxPageSize: 100 } },
      diffReads: { supported: true, pageBound: { maxPageSize: 100 } },
      fileReads: { supported: true, pageBound: { maxPageSize: 100 } },
      repositorySearch: { supported: true, pageBound: { maxPageSize: 100 } },
      diffSearch: { supported: true, pageBound: { maxPageSize: 100 } },
      changeRequestDetails: { supported: true, pageBound: { maxPageSize: 100 } },
      issueDetails: { supported: true, pageBound: { maxPageSize: 100 } },
      pagination: { maxPageSize: 100 },
    },
  };
}

function testPolicy(overrides: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return normalizeHarnessPolicy({
    maxElapsedMsPerAttempt: 10_000_000,
    maxModelTurnsPerAttempt: 50,
    maxToolRequestsPerAttempt: 200,
    maxToolRequestsPerTurn: 50,
    maxToolResultBytes: 1_000_000,
    maxEvidenceBytesPerAttempt: 10_000_000,
    manifestPageSize: 1000,
    diffOrFileReadPageLines: 1000,
    protocolRepairsPerPhase: 2,
    checkpointCadenceToolCalls: 1000,
    highRiskReservePercent: 0,
    verificationReservePercent: 0,
    changesetMemberMinimumTurns: 1,
    changesetMemberMinimumToolCalls: 4,
    changesetMemberMinimumEvidenceBytes: 1,
    ...overrides,
  });
}

function changeRequestDetailResult(repo: RepoFixture, detailOverrides: Partial<NormalizedDetail> = {}): ChangeRequestDetailResult {
  return {
    snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha },
    state: 'complete',
    value: { title: 'Test change', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [], ...detailOverrides },
  };
}

function manifestResult(repo: RepoFixture, files: readonly string[]): ChangedFileManifestResult {
  const value: ChangedFileEntry[] = files.map((path) => ({ path, kind: 'modified', binary: false, addedLines: 5, removedLines: 1, byteSize: 100 }));
  return { snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha }, state: 'complete', value };
}

function diffPageResult(repo: RepoFixture, path: string): DiffPageResult {
  return {
    snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha },
    state: 'complete',
    value: { path, patch: `@@ -1,1 +1,1 @@\n-old\n+new\n`, positions: [{ path, side: 'new', line: 1, endLine: 1 }] },
  };
}

function fileRangeResult(repo: RepoFixture, path: string, text = 'unchanged supporting content'): FileRangeResult {
  return {
    snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha },
    state: 'complete',
    value: { revision: 'head', path, startLine: 1, endLine: 2, text },
  };
}

function currentHeadResult(repo: RepoFixture, headSha: string = repo.headSha): CurrentHeadResult {
  return { repoId: repo.repoId, state: 'resolved', headSha };
}

interface FakeConnectionOptions {
  readonly repo: RepoFixture;
  readonly files: readonly string[];
  readonly getCurrentHead?: Connection['getCurrentHead'];
  readonly readDiff?: Connection['readDiff'];
  readonly readFile?: Connection['readFile'];
  readonly listChangedFiles?: Connection['listChangedFiles'];
  readonly getChangeRequestDetails?: Connection['getChangeRequestDetails'];
}

function reviewConnection(options: FakeConnectionOptions): Connection {
  return fakeConnection({
    getChangeRequestDetails: options.getChangeRequestDetails ?? (async () => changeRequestDetailResult(options.repo)),
    listChangedFiles: options.listChangedFiles ?? (async () => manifestResult(options.repo, options.files)),
    readDiff: options.readDiff ?? (async (request) => diffPageResult(options.repo, request.path)),
    readFile: options.readFile ?? (async (request) => fileRangeResult(options.repo, request.path)),
    getCurrentHead: options.getCurrentHead ?? (async () => currentHeadResult(options.repo)),
  });
}

interface MemberSnapshotOverrides {
  readonly rootAgentsPolicy?: ReviewRunMemberSnapshot['rootAgentsPolicy'];
  readonly attachments?: readonly { attachmentId: string; label: string; contentDigest: string }[];
}

function memberSnapshot(memberId: string, repo: RepoFixture, overrides: MemberSnapshotOverrides = {}): ReviewRunMemberSnapshot {
  return {
    memberId,
    providerId: 'fixture',
    instanceUrl: 'https://example.test',
    ref: { repoId: repo.repoId, number: memberId },
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    providerCapabilitySignature: 'sig-1',
    rootAgentsPolicy: overrides.rootAgentsPolicy ?? { present: false },
    context: { autoContextEnabled: false, titleIncluded: false, descriptionIncluded: false, linkedItemIdsIncluded: [], attachments: overrides.attachments ?? [] },
  };
}

function changesetSnapshot(members: readonly ReviewRunMemberSnapshot[]): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'changeset',
    changesetId: 'changeset-1',
    members,
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

function memberInput(memberId: string, connection: Connection, attachments?: readonly Attachment[]): HarnessAttemptMemberInput {
  return { memberId, connection, capabilities: fullCapabilities(), attachments };
}

// ---- Scripted model seam (mirrors harnessAttempt.test.ts's own helper) ----------------

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

function readDiffMessage(memberId: string, repo: RepoFixture, path: string): unknown {
  return { kind: 'toolRequest', tool: 'readDiff', memberId, request: { snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha }, path } };
}

function readFileMessage(memberId: string, repo: RepoFixture, path: string, startLine: number, endLine: number): unknown {
  return {
    kind: 'toolRequest',
    tool: 'readFile',
    memberId,
    request: { snapshot: { repoId: repo.repoId, baseSha: repo.baseSha, headSha: repo.headSha }, revision: 'head', path, startLine, endLine },
  };
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

function candidateSubmissionMessage(candidateId: string, memberId: string, path: string, ref: { sourceId: string; digest: string }, supporting?: { sourceId: string; digest: string; path: string; range: { startLine: number; endLine: number } }): unknown {
  return {
    kind: 'candidateSubmission',
    candidate: {
      candidateId,
      memberId,
      file: path,
      line: 1,
      endLine: 1,
      severity: 'major',
      category: 'errorHandling',
      confidence: 80,
      title: `Issue in ${path}`,
      body: 'A real issue found during investigation.',
      citations: {
        primary: { sourceId: ref.sourceId, digest: ref.digest, path, range: { startLine: 1, endLine: 1 } },
        ...(supporting ? { supporting: [supporting] } : {}),
      },
    },
  };
}

const passthroughVerification: HarnessAttemptOptions['synthesisVerification'] = async (input) =>
  Object.freeze({ findings: input.findings, contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true });

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

function toolFailedEvents(activityLog: { events: readonly { kind: string; tool?: string; target?: string; reason?: string }[] }, tool: string, target: string) {
  return activityLog.events.filter((event) => event.kind === 'toolFailed' && event.tool === tool && event.target === target);
}

// ---- Tests ------------------------------------------------------------------------------

describe('HarnessAttempt.run over a real multi-member changeset (task 13.6)', () => {
  it('a dominant large member never touches the small member\'s guaranteed minimum, and the small member\'s finding survives even though the large member ends up incomplete', async () => {
    // changesetMemberMinimumToolCalls: 4 -> each member's private lane covers bootstrap's 2 calls
    // (getChangeRequestDetails + listChangedFiles) plus exactly 2 more of that member's own tool
    // calls, before touching the shared pool at all.
    const policy = testPolicy({ maxToolRequestsPerAttempt: 11, changesetMemberMinimumToolCalls: 4 }); // private 4*2=8 + shared 3
    const coreFiles = ['src/core/a.ts', 'src/core/b.ts', 'src/core/c.ts', 'src/core/d.ts', 'src/core/e.ts', 'src/core/f.ts'];
    const coreConnection = reviewConnection({ repo: CORE, files: coreFiles });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });

    const investigatingTurn2: ScriptEntry = (call) => {
      const coreRef = sourceRefFrom(call.toolResults[0] as HostToolResult); // core's first successful read (a.ts)
      const billingRef = sourceRefFrom(call.toolResults[5] as HostToolResult); // billing's own read
      return messages(
        readDiffMessage('core', CORE, 'src/core/f.ts'), // core's 6th read: nothing left, refused
        candidateSubmissionMessage('cand-core-1', 'core', 'src/core/a.ts', coreRef), // core's own submission: also nothing left, refused
        candidateSubmissionMessage('cand-billing-1', 'billing', 'src/billing/webhook.ts', billingRef), // billing's own private lane: untouched, succeeds
      );
    };
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'core-1', description: 'Investigate core.', memberId: 'core' }, { id: 'billing-1', description: 'Investigate billing.', memberId: 'billing' }] })],
      investigating: [
        messages(
          readDiffMessage('core', CORE, 'src/core/a.ts'),
          readDiffMessage('core', CORE, 'src/core/b.ts'),
          readDiffMessage('core', CORE, 'src/core/c.ts'),
          readDiffMessage('core', CORE, 'src/core/d.ts'),
          readDiffMessage('core', CORE, 'src/core/e.ts'),
          readDiffMessage('billing', BILLING, 'src/billing/webhook.ts'),
        ),
        investigatingTurn2,
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN, STOP_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    // Billing was never starved: its finding survives, and its own submission was never refused.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.memberId).toBe('billing');
    expect(toolFailedEvents(result.activityLog, 'submitCandidateFinding', 'billing')).toHaveLength(0);

    // Core's own greed exhausted its own allotment (private + shared) — its 6th read and its own
    // submission were both refused, visibly, not silently dropped.
    expect(toolFailedEvents(result.activityLog, 'readDiff', 'src/core/f.ts').length).toBeGreaterThan(0);
    expect(toolFailedEvents(result.activityLog, 'submitCandidateFinding', 'core').length).toBeGreaterThan(0);

    // The changeset cannot be complete or clean while core is incomplete, and the blocker names
    // core specifically — never billing, whose own coverage and submission both succeeded.
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.kind).toBe('partialFindings');
    const blockerDetails = result.outcome.blockerDetails ?? [];
    expect(blockerDetails.some((d) => d.memberId === 'core' && d.blocker === 'insufficientRiskCoverage')).toBe(true);
    expect(blockerDetails.every((d) => d.memberId !== 'billing')).toBe(true);
  });

  it('a member whose reads are persistently rate-limited does not block the other member\'s investigation or finding', async () => {
    const policy = testPolicy({ transientRetriesPerOperation: 1 });
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({
      repo: BILLING,
      files: ['src/billing/webhook.ts'],
      readDiff: async () => {
        throw new ScmError('rateLimited', 'Too many requests', { retryAfterSeconds: 30 });
      },
    });

    const investigatingTurn2: ScriptEntry = (call) => {
      const coreRef = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-core-1', 'core', 'src/core/main.ts', coreRef));
    };
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed files.' }] })],
      investigating: [
        messages(readDiffMessage('core', CORE, 'src/core/main.ts'), readDiffMessage('billing', BILLING, 'src/billing/webhook.ts')),
        investigatingTurn2,
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN, STOP_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
      retry: { sleep: async () => {} },
    });

    const result = await attempt.run();

    // Core's investigation and finding are unaffected by billing's persistent rate limiting.
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.memberId).toBe('core');
    expect(toolFailedEvents(result.activityLog, 'submitCandidateFinding', 'core')).toHaveLength(0);

    // Billing's read failed every attempt and is named as the reason the changeset is incomplete.
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.kind).toBe('partialFindings');
    const blockerDetails = result.outcome.blockerDetails ?? [];
    expect(blockerDetails.some((d) => d.memberId === 'billing' && d.blocker === 'unavailableOversizedPatch')).toBe(true);
    expect(blockerDetails.every((d) => d.memberId !== 'core')).toBe(true);
  });

  it('a member whose changed-file manifest is unavailable leaves the changeset incomplete without blocking the other member\'s finding', async () => {
    const policy = testPolicy();
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({
      repo: BILLING,
      files: [],
      listChangedFiles: async () => ({ snapshot: { repoId: BILLING.repoId, baseSha: BILLING.baseSha, headSha: BILLING.headSha }, state: 'unavailable', reason: 'Provider rate limit on manifest listing.' }),
    });

    const investigatingTurn2: ScriptEntry = (call) => {
      const coreRef = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(candidateSubmissionMessage('cand-core-1', 'core', 'src/core/main.ts', coreRef));
    };
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed files.' }] })],
      investigating: [messages(readDiffMessage('core', CORE, 'src/core/main.ts')), investigatingTurn2, STOP_TURN],
      verifying: [COMPLETION_TURN, STOP_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.memberId).toBe('core');
    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.kind).toBe('partialFindings');
    const blockerDetails = result.outcome.blockerDetails ?? [];
    expect(blockerDetails.some((d) => d.memberId === 'billing' && d.blocker === 'incompleteInventory' && d.repairable === false)).toBe(true);
    expect(blockerDetails.some((d) => d.memberId === 'billing' && d.blocker === 'providerLimit')).toBe(true);
    expect(blockerDetails.every((d) => d.memberId !== 'core')).toBe(true);
  });

  it('a finding whose primary evidence is a core member\'s changed line and whose supporting evidence is unchanged billing code completes cleanly with both revisions bound to their own member (cross-member API/schema evidence)', async () => {
    const policy = testPolicy();
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/api.ts'] });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/handler.ts'] });

    // `lastTurnResults` only ever carries the immediately preceding turn's results, so core's diff
    // ref (from turn 1) is captured here in turn 2 rather than re-derived from turn 3's results.
    let coreRef: { sourceId: string; digest: string } | undefined;
    const investigatingTurn2: ScriptEntry = (call) => {
      coreRef = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(readFileMessage('billing', BILLING, 'src/billing/schema.ts', 1, 2));
    };
    const investigatingTurn3: ScriptEntry = (call) => {
      if (!coreRef) throw new Error('coreRef was not captured in turn 2');
      const supportingSource = sourceRefFrom(call.toolResults[0] as HostToolResult);
      return messages(
        candidateSubmissionMessage('cand-cross-1', 'core', 'src/core/api.ts', coreRef, {
          sourceId: supportingSource.sourceId,
          digest: supportingSource.digest,
          path: 'src/billing/schema.ts',
          range: { startLine: 1, endLine: 2 },
        }),
      );
    };
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'cross-1', description: 'Confirm the billing schema consumer matches the core API change.' }] })],
      investigating: [
        messages(readDiffMessage('core', CORE, 'src/core/api.ts'), readDiffMessage('billing', BILLING, 'src/billing/handler.ts')),
        investigatingTurn2,
        investigatingTurn3,
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    expect(result.outcome.completeness).toBe('complete');
    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.memberId).toBe('core');
    expect(finding.evidence.primary).toMatchObject({ memberId: 'core', repositoryId: 'repo-core', origin: 'diffPage' });
    expect(finding.evidence.supporting).toEqual([
      expect.objectContaining({ memberId: 'billing', repositoryId: 'repo-billing', baseSha: 'base-billing', headSha: 'head-billing', path: 'src/billing/schema.ts' }),
    ]);
    // The pre-existing changeset UI's cross-member marker (`collectCrossFindings`) recognizes this shape.
    expect(finding.item.cross).toBe(true);
    expect(finding.item.spans?.map((span) => span.repoId)).toEqual(['repo-core', 'repo-billing']);
  });

  it('one member\'s head moving mid-review blocks completion and names only that member, while the other member\'s unchanged head and finding are unaffected (mixed head changes)', async () => {
    const policy = testPolicy();
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    // billing's head moves between snapshot capture and the pre-completion check.
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'], getCurrentHead: async () => currentHeadResult(BILLING, 'head-billing-moved') });

    const investigatingTurn2: ScriptEntry = (call) => {
      const coreRef = sourceRefFrom(call.toolResults[0] as HostToolResult);
      const billingRef = sourceRefFrom(call.toolResults[1] as HostToolResult);
      return messages(
        candidateSubmissionMessage('cand-core-1', 'core', 'src/core/main.ts', coreRef),
        candidateSubmissionMessage('cand-billing-1', 'billing', 'src/billing/webhook.ts', billingRef),
      );
    };
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate the changed files.' }] })],
      investigating: [messages(readDiffMessage('core', CORE, 'src/core/main.ts'), readDiffMessage('billing', BILLING, 'src/billing/webhook.ts')), investigatingTurn2, STOP_TURN],
      verifying: [COMPLETION_TURN, STOP_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    // Both findings were validated before the head check ran; neither is silently dropped.
    expect(result.findings).toHaveLength(2);
    expect(result.findings.map((f) => f.memberId).sort()).toEqual(['billing', 'core']);

    expect(result.outcome.completeness).not.toBe('complete');
    expect(result.outcome.kind).toBe('partialFindings');
    const blockerDetails = result.outcome.blockerDetails ?? [];
    expect(blockerDetails.some((d) => d.memberId === 'billing' && d.blocker === 'headChanged')).toBe(true);
    expect(blockerDetails.every((d) => d.memberId !== 'core')).toBe(true);
  });

  it('a fully investigated, fully clean two-member changeset reaches complete clean with both members exhausted and both heads confirmed unchanged', async () => {
    const policy = testPolicy();
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });

    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'core-1', description: 'Investigate core.', memberId: 'core' }, { id: 'billing-1', description: 'Investigate billing.', memberId: 'billing' }] })],
      investigating: [messages(readDiffMessage('core', CORE, 'src/core/main.ts'), readDiffMessage('billing', BILLING, 'src/billing/webhook.ts')), STOP_TURN],
      verifying: [COMPLETION_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy,
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('succeeded');
    expect(result.outcome.kind).toBe('completeClean');
    expect(result.outcome.completeness).toBe('complete');
    expect(result.outcome.clean).toBe(true);
    expect(result.findings).toHaveLength(0);
    expect(result.plan?.items.map((item) => item.memberId)).toEqual(['core', 'billing']);
  });
});

// ---- 15.1/15.2/15.3: member ownership over a real multi-member changeset --------------

function outcomeFor(results: readonly HostToolResult[], candidateId: string): { state: string; reasons: readonly string[] } | undefined {
  for (const result of results) {
    if (result.state === 'complete' && result.content.tool === 'submitCandidateFinding' && result.content.candidateId === candidateId) {
      return result.content.outcome;
    }
  }
  return undefined;
}

describe('HarnessAttempt.run over a real multi-member changeset (tasks 15.1-15.3: attachment citability, member ownership, routing)', () => {
  it('an attachment owned by member core cannot be cited as primary by a candidate declaring member billing', async () => {
    const coreAttachmentContent = 'export const coreOnly = true;';
    const coreAttachment: Attachment = {
      id: 'att-core',
      kind: 'file',
      label: 'core/secret.ts',
      path: 'core/secret.ts',
      content: coreAttachmentContent,
      truncated: false,
      evidence: [{ path: 'core/secret.ts', range: { startLine: 1, endLine: 1 }, contentStart: 0, contentEnd: coreAttachmentContent.length }],
    };
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });

    let coreAttachmentRef: { sourceId: string; digest: string } | undefined;
    let submissionResults: readonly HostToolResult[] = [];
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate.' }] })],
      investigating: [
        () => {
          if (!coreAttachmentRef) throw new Error('core attachment was not registered by the time investigating started');
          return messages(candidateSubmissionMessage('cand-cross-attach', 'billing', 'core/secret.ts', coreAttachmentRef));
        },
        (call) => {
          // Captures the candidate submission's own outcome (from the turn just above), then reads
          // both members' one real changed file so coverage is genuinely complete before the model
          // stops next turn — this test is about member-scoped attachment citation, not coverage,
          // and a file left uninspected would otherwise have the host ask the model to keep going
          // (the fix this change makes) instead of letting the phase end on the next bare-rationale
          // turn.
          submissionResults = call.toolResults;
          return messages(readDiffMessage('core', CORE, 'src/core/main.ts'), readDiffMessage('billing', BILLING, 'src/billing/webhook.ts'));
        },
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([
        memberSnapshot('core', CORE, { attachments: [{ attachmentId: 'att-core', label: 'core/secret.ts', contentDigest: sha256Hex(coreAttachmentContent) }] }),
        memberSnapshot('billing', BILLING),
      ]),
      members: [memberInput('core', coreConnection, [coreAttachment]), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy: testPolicy(),
      onCheckpoint: (info) => {
        const found = info.evidenceSources.find((source) => source.origin === 'attachment' && source.memberId === 'core');
        if (found) coreAttachmentRef = { sourceId: found.sourceId, digest: found.digest };
      },
    });

    const result = await attempt.run();

    expect(coreAttachmentRef).toBeDefined();
    expect(result.findings).toHaveLength(0);
    const outcome = outcomeFor(submissionResults, 'cand-cross-attach');
    expect(outcome?.state).toBe('rejected');
    expect(outcome?.reasons.some((reason) => reason.includes('memberMismatch'))).toBe(true);
  });

  it('a candidate cannot cite the auto-derived title/body reached through bootstrap\'s change-request details (marker test — intent is never citable)', async () => {
    const MARKER = 'MARKER-42f19c-do-not-cite';
    const coreConnection = reviewConnection({
      repo: CORE,
      files: ['src/core/main.ts'],
      getChangeRequestDetails: async () => changeRequestDetailResult(CORE, { title: `Fix bug ${MARKER}`, body: `See ${MARKER} for details.` }),
    });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });

    let detailRef: { sourceId: string; digest: string } | undefined;
    let detailExactContent: string | undefined;
    let submissionResults: readonly HostToolResult[] = [];
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate.' }] })],
      investigating: [
        () => {
          if (!detailRef) throw new Error('change-request detail was not registered by the time investigating started');
          return messages(candidateSubmissionMessage('cand-marker', 'core', 'src/core/main.ts', detailRef));
        },
        (call) => {
          // Captures the candidate submission's own outcome (from the turn just above), then reads
          // both members' one real changed file so coverage is genuinely complete before the model
          // stops next turn — this test is about intent never being citable, not coverage, and a
          // file left uninspected would otherwise have the host ask the model to keep going (the
          // fix this change makes) instead of letting the phase end on the next bare-rationale turn.
          submissionResults = call.toolResults;
          return messages(readDiffMessage('core', CORE, 'src/core/main.ts'), readDiffMessage('billing', BILLING, 'src/billing/webhook.ts'));
        },
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([memberSnapshot('core', CORE), memberSnapshot('billing', BILLING)]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection)],
      modelSeam: seam,
      policy: testPolicy(),
      onCheckpoint: (info) => {
        const found = info.evidenceSources.find((source) => source.origin === 'changeRequestDetail' && source.memberId === 'core');
        if (found) {
          detailRef = { sourceId: found.sourceId, digest: found.digest };
          detailExactContent = found.exactContent;
        }
      },
    });

    const result = await attempt.run();

    // Proves the marker itself reached the ledger — not merely that *some* change-request-detail
    // source did, which would pass even if the `getChangeRequestDetails` override above were
    // silently ignored and the default (marker-free) detail registered instead.
    expect(detailExactContent).toContain(MARKER);
    expect(result.findings).toHaveLength(0);
    const outcome = outcomeFor(submissionResults, 'cand-marker');
    expect(outcome?.state).toBe('rejected');
    expect(outcome?.reasons.some((reason) => reason.includes('nonCitable'))).toBe(true);
  });

  it('member-scoped attachment routing survives the full attempt: a path changed in core does not make the same-named billing attachment inline (13.5/15.3)', async () => {
    const sharedPath = 'shared/util.ts';
    const billingAttachmentContent = 'export function util() {}\n';
    const billingAttachment: Attachment = {
      id: 'att-billing-util',
      kind: 'file',
      label: sharedPath,
      path: sharedPath,
      content: billingAttachmentContent,
      truncated: false,
      evidence: [{ path: sharedPath, range: { startLine: 1, endLine: 1 }, contentStart: 0, contentEnd: billingAttachmentContent.length }],
    };
    const coreConnection = reviewConnection({ repo: CORE, files: [sharedPath] }); // core changed this path
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] }); // billing did not

    let billingAttachmentRef: { sourceId: string; digest: string } | undefined;
    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate.' }] })],
      investigating: [
        () => {
          if (!billingAttachmentRef) throw new Error('billing attachment was not registered by the time investigating started');
          return messages(candidateSubmissionMessage('cand-scoped', 'billing', sharedPath, billingAttachmentRef));
        },
        STOP_TURN,
      ],
      verifying: [COMPLETION_TURN],
    });

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: changesetSnapshot([
        memberSnapshot('core', CORE),
        memberSnapshot('billing', BILLING, { attachments: [{ attachmentId: 'att-billing-util', label: sharedPath, contentDigest: sha256Hex(billingAttachmentContent) }] }),
      ]),
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection, [billingAttachment])],
      modelSeam: seam,
      policy: testPolicy(),
      onCheckpoint: (info) => {
        const found = info.evidenceSources.find((source) => source.origin === 'attachment' && source.memberId === 'billing');
        if (found) billingAttachmentRef = { sourceId: found.sourceId, digest: found.digest };
      },
    });

    const result = await attempt.run();

    expect(result.findings).toHaveLength(1);
    // billing never changed 'shared/util.ts' itself — core changing it must not leak into billing's routing decision.
    expect(result.findings[0]!.routing).toBe('summary');
  });

  it('the bootstrap envelope sent to the fit check carries each member\'s own root-policy identity and its attachment content (15.1 member ownership)', async () => {
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });
    const attachmentContent = 'export const marker = "attachment-envelope-marker";';
    const billingAttachment: Attachment = {
      id: 'att-billing-1',
      kind: 'file',
      label: 'billing/marker.ts',
      path: 'billing/marker.ts',
      content: attachmentContent,
      truncated: false,
      evidence: [{ path: 'billing/marker.ts', range: { startLine: 1, endLine: 1 }, contentStart: 0, contentEnd: attachmentContent.length }],
    };

    const seam = scriptedModelSeam({
      planning: [messages({ kind: 'planCreated', items: [{ id: 'p1', description: 'Investigate.' }] })],
      investigating: [STOP_TURN],
      verifying: [COMPLETION_TURN],
    });

    const seenTexts: string[] = [];
    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: {
        ...changesetSnapshot([
          memberSnapshot('core', CORE, { rootAgentsPolicy: { present: true, sourceId: 'agents-policy:base-core:.', digest: 'core-policy-digest' } }),
          memberSnapshot('billing', BILLING, {
            rootAgentsPolicy: { present: false },
            attachments: [{ attachmentId: 'att-billing-1', label: 'billing/marker.ts', contentDigest: sha256Hex(attachmentContent) }],
          }),
        ]),
        modelCapability: { vendor: 'test', family: 'test', maxInputTokens: 1_000_000 },
      },
      members: [memberInput('core', coreConnection), memberInput('billing', billingConnection, [billingAttachment])],
      modelSeam: seam,
      policy: testPolicy(),
      countTokens: async (text) => {
        seenTexts.push(text);
        return 10;
      },
    });

    await attempt.run();

    expect(seenTexts.length).toBeGreaterThan(0);
    const rendered = seenTexts[0]!;
    // Each member's own root AGENTS.md identity is present — never collapsed to one member's.
    expect(rendered).toContain('core-policy-digest');
    // The billing attachment's actual bytes are part of the same envelope the fit check counted.
    expect(rendered).toContain('attachment-envelope-marker');
  });

  it('an overflowing bootstrap never asks the model anything, so an attachment it never returned cannot become citable', async () => {
    const coreConnection = reviewConnection({ repo: CORE, files: ['src/core/main.ts'] });
    const billingConnection = reviewConnection({ repo: BILLING, files: ['src/billing/webhook.ts'] });
    const attachmentContent = 'export const overflowMarker = true;';
    const coreAttachment: Attachment = {
      id: 'att-core-of',
      kind: 'file',
      label: 'core/of.ts',
      path: 'core/of.ts',
      content: attachmentContent,
      truncated: false,
      evidence: [{ path: 'core/of.ts', range: { startLine: 1, endLine: 1 }, contentStart: 0, contentEnd: attachmentContent.length }],
    };

    const attempt = createHarnessAttempt({
      ...baseOptions(),
      snapshot: {
        ...changesetSnapshot([
          memberSnapshot('core', CORE, { attachments: [{ attachmentId: 'att-core-of', label: 'core/of.ts', contentDigest: sha256Hex(attachmentContent) }] }),
          memberSnapshot('billing', BILLING),
        ]),
        modelCapability: { vendor: 'test', family: 'test', maxInputTokens: 1 },
      },
      members: [memberInput('core', coreConnection, [coreAttachment]), memberInput('billing', billingConnection)],
      // No phase is scripted: if the model were ever asked anything (including to plan), this
      // throws — the run must never get that far once bootstrap has already failed to fit.
      modelSeam: scriptedModelSeam({}),
      policy: testPolicy(),
      countTokens: async () => 1_000_000, // over the 1-token limit at every shrink tier
    });

    const result = await attempt.run();

    expect(result.lifecycle).toBe('failed');
    expect(result.outcome.completeness).toBe('none');
    expect(result.outcome.limitations.some((limitation) => limitation.code === 'bootstrapOverflow')).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});
