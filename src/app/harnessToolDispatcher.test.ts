import { describe, expect, it } from 'vitest';
import { fakeInvestigationSource } from '../testing/investigationDouble';
import type { AgentsPolicyResolver } from './harnessAgentsPolicy';
import { sha256Hex } from './contentDigest';
import { createBudgetTracker } from './harnessBudgets';
import { createCandidateTracker } from './harnessCandidateValidation';
import { evaluateCompletion as evaluateCompletionGate, type CompletionEvaluation, type CompletionEvaluationInput } from './harnessCompletion';
import { createEvidenceLedger, type EvidenceLedger } from './harnessEvidenceLedger';
import { createChangedFileInventory } from './harnessInventory';
import {
  createHostToolDispatcher,
  type DispatcherMember,
  type HostToolDispatcherOptions,
  type HostToolRequest,
  type HostToolResult,
} from './harnessToolDispatcher';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { parseModelTurn } from '../domain/harnessProtocol';
import { normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import type { Connection, InvestigationOperationCapability, MemberCapabilities } from '../platform/provider';
import type { InvestigationOperations } from '../platform/types';
import type {
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequestDetailResult,
  DiffPage,
  DiffPageResult,
  DiffSearchResult,
  FileRangeResult,
  IssueDetailResult,
  NormalizedDetail,
  RepositorySearchResult,
} from '../platform/types';

// ---- Fixtures -----------------------------------------------------------------

const SNAPSHOT = { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' };

const TEST_POLICY: HarnessPolicy = normalizeHarnessPolicy({
  maxToolResultBytes: 10_000,
  maxEvidenceBytesPerAttempt: 1_000_000,
  // Must stay >= the fake capabilities' declared pageBound.maxPageSize (50) below, or every
  // paginated-capability tool trips the outOfBounds provider-capability-sanity check before the
  // provider is even called.
  diffOrFileReadPageLines: 400,
  searchResultPageMatches: 50,
  manifestPageSize: 100,
  maxToolRequestsPerAttempt: 1_000,
  maxToolRequestsPerTurn: 50,
  maxModelTurnsPerAttempt: 100,
  maxElapsedMsPerAttempt: 10_000_000,
});

function notImplemented(): never {
  throw new Error('not implemented in this fake Connection');
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

const FULLY_SUPPORTED: InvestigationOperationCapability = { supported: true, pageBound: { maxPageSize: 50 } };

function fullCapabilities(overrides: Partial<MemberCapabilities['reviewInvestigation']> = {}): MemberCapabilities {
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
    detailRetrieval: { changeRequestDetails: FULLY_SUPPORTED, issueDetails: FULLY_SUPPORTED, pagination: { maxPageSize: 50 } },
    reviewInvestigation: {
      manifests: FULLY_SUPPORTED,
      diffReads: FULLY_SUPPORTED,
      fileReads: FULLY_SUPPORTED,
      repositorySearch: FULLY_SUPPORTED,
      diffSearch: FULLY_SUPPORTED,
      changeRequestDetails: FULLY_SUPPORTED,
      issueDetails: FULLY_SUPPORTED,
      pagination: { maxPageSize: 50 },
      ...overrides,
    },
  };
}

function makeMember(connection: Connection & Partial<InvestigationOperations>, capabilities: MemberCapabilities = fullCapabilities()): DispatcherMember {
  return { memberId: 'm1', repositoryId: SNAPSHOT.repoId, baseSha: SNAPSHOT.baseSha, headSha: SNAPSHOT.headSha, changeRequestNumber: '42', connection, capabilities, investigationSource: fakeInvestigationSource(connection) };
}

const NEVER_GRANTED_EVALUATION: CompletionEvaluation = evaluateCompletionGate({
  heads: [],
  inventory: createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]),
  unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
  citations: { revalidated: false, invalidatedCount: 0 },
  passes: { contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false },
});

function stubAgentsPolicyResolver(): AgentsPolicyResolver {
  return { resolveChain: notImplemented };
}

interface DispatcherHarness {
  ledger: EvidenceLedger;
  dispatcher: ReturnType<typeof createHostToolDispatcher>;
  budget: ReturnType<typeof createBudgetTracker>;
}

function setup(member: DispatcherMember, overrides: Partial<HostToolDispatcherOptions> = {}): DispatcherHarness {
  const ledger = createEvidenceLedger(
    { runId: 'r1', lineageId: 'l1', attempt: 1 },
    [{ memberId: member.memberId, repositoryId: member.repositoryId, baseSha: member.baseSha, headSha: member.headSha, changeRequestNumber: member.changeRequestNumber }],
    { policy: TEST_POLICY },
  );
  const budget = createBudgetTracker(TEST_POLICY);
  const candidateTracker = createCandidateTracker();
  const dispatcher = createHostToolDispatcher({
    members: [member],
    ledger,
    budget,
    candidateTracker,
    criteria: DEFAULT_CRITERIA,
    agentsPolicyResolver: stubAgentsPolicyResolver(),
    evaluateCompletion: () => NEVER_GRANTED_EVALUATION,
    policy: TEST_POLICY,
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return { ledger, dispatcher, budget };
}

let requestCounter = 0;
function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function readDiffRequest(overrides: Partial<Extract<HostToolRequest, { tool: 'readDiff' }>> = {}): Extract<HostToolRequest, { tool: 'readDiff' }> {
  return {
    tool: 'readDiff',
    requestId: nextRequestId(),
    memberId: 'm1',
    elapsedMs: 0,
    request: { path: 'src/foo.ts' },
    ...overrides,
  };
}

const DIFF_PAGE: DiffPage = {
  path: 'src/foo.ts',
  patch: '@@ -1,2 +1,2 @@\n-old line\n+new line\n',
  positions: [{ path: 'src/foo.ts', side: 'new', line: 1, endLine: 1 }],
};

function diffConnection(result: DiffPageResult): Connection & Partial<InvestigationOperations> {
  return fakeConnection({ readDiff: async () => result });
}

// ---- Tests ----------------------------------------------------------------------

describe('validation order (task 9.2)', () => {
  it('refuses an unknown tool', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const request = { tool: 'deleteRepository', requestId: 'x', memberId: 'm1', elapsedMs: 0 } as unknown as HostToolRequest;
    const result = await dispatcher.dispatch('investigating', request);
    expect(result).toMatchObject({ state: 'refused', code: 'unknownTool' });
  });

  it('refuses a tool outside its allowed phase', async () => {
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') })));
    const result = await dispatcher.dispatch('bootstrap', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'phaseNotAllowed' });
  });

  it('refuses an unknown member', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'ghost' }));
    expect(result).toMatchObject({ state: 'refused', code: 'unknownMember' });
  });

  it('refuses requestCompletion with no memberId as an ordinary omission, but accepts it as a documented exception when a memberId is absent by design', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    // requestCompletion has no required member (D11 is a whole-attempt gate); this must not fail as unknownMember.
    const result = await dispatcher.dispatch('completing', { tool: 'requestCompletion', requestId: nextRequestId(), elapsedMs: 0 });
    expect(result).not.toMatchObject({ state: 'refused', code: 'unknownMember' });
  });

  it('refuses an unusable path', async () => {
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { path: '../../etc/passwd' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'invalidPath' });
  });

  /**
   * Who supplies the revision pin, and why it is no longer the model's to supply.
   *
   * Every revision-pinned request used to carry a `snapshot` object the model filled in — repoId,
   * baseSha, headSha — and this dispatcher compared the three against the member and refused any
   * difference as `revisionMismatch`. The tests that lived here asserted the refusal message: that
   * the corrective pin survived `sanitizeErrorReason`'s 240-char bound uncut, that the field that
   * actually differed was named, that no corrective half was byte-identical to the echoed half.
   * Each of those was a real fix for a real run, and each made the message better while leaving
   * the transcription in place.
   *
   * The transcription is gone (see `snapshotOf` in `harnessToolDispatcher.ts` for the run that
   * ended it — 87 of 319 tool results refused, 27%, every one a mis-copied head sha). What has to
   * be proven now is not what a refusal says but that the pin is right without anyone copying it:
   * the model names a member and a path, and the provider is called with that member's own two
   * commits.
   */
  describe('the host supplies the revision pin (no request names a revision)', () => {
    const BASE_SHA = '1d801edd2f2e858c9bd8b03dbde2ebfb7a63e36a';
    const HEAD_SHA = '1d801edd2f2e858c9bd8b03dbde5a09c48eccdae';
    const REPO_ID = 'osirison/code-verdict';

    /** Records what each operation was actually asked for, then answers `unavailable` — this asserts the request, never the content. */
    function recordingMember(seen: { snapshot?: unknown; tool?: string }[]): DispatcherMember {
      const record = <T>(tool: string) => async (request: { snapshot: unknown }) => {
        seen.push({ tool, snapshot: request.snapshot });
        return { snapshot: request.snapshot, state: 'unavailable', reason: 'recorded' } as T;
      };
      const operations = {
        listChangedFiles: record<ChangedFileManifestResult>('listChangedFiles'),
        readDiff: record<DiffPageResult>('readDiff'),
        readFile: record<FileRangeResult>('readFile'),
        searchRepository: record<RepositorySearchResult>('searchRepository'),
        searchDiff: record<DiffSearchResult>('searchDiff'),
      };
      const connection = fakeConnection({
        getChangeRequestDetails: record<ChangeRequestDetailResult>('getChangeRequestDetails'),
        getIssueDetails: record<IssueDetailResult>('getIssueDetails'),
      });
      return {
        memberId: 'osirison/code-verdict!68',
        repositoryId: REPO_ID,
        baseSha: BASE_SHA,
        headSha: HEAD_SHA,
        changeRequestNumber: '68',
        connection,
        capabilities: fullCapabilities(),
        investigationSource: fakeInvestigationSource(operations),
      };
    }

    it("pins every revision-pinned tool to the named member's own repository and commits", async () => {
      const seen: { snapshot?: unknown; tool?: string }[] = [];
      const member = recordingMember(seen);
      const { dispatcher } = setup(member);
      const common = { requestId: '', elapsedMs: 0, memberId: member.memberId };
      const requests: HostToolRequest[] = [
        { ...common, requestId: nextRequestId(), tool: 'listChangedFiles', request: {} },
        { ...common, requestId: nextRequestId(), tool: 'readDiff', request: { path: 'src/foo.ts' } },
        { ...common, requestId: nextRequestId(), tool: 'readFile', request: { revision: 'head', path: 'src/foo.ts', startLine: 1, endLine: 5 } },
        { ...common, requestId: nextRequestId(), tool: 'searchRepository', request: { revision: 'base', query: 'token' } },
        { ...common, requestId: nextRequestId(), tool: 'searchDiff', request: { query: 'token' } },
        { ...common, requestId: nextRequestId(), tool: 'getChangeRequestDetails', request: { number: '68' } },
        { ...common, requestId: nextRequestId(), tool: 'getIssueDetails', request: { issueRepoId: REPO_ID, issueNumber: '7' } },
      ];
      for (const request of requests) await dispatcher.dispatch('investigating', request);

      expect(seen.map((call) => call.tool)).toEqual([
        'listChangedFiles',
        'readDiff',
        'readFile',
        'searchRepository',
        'searchDiff',
        'getChangeRequestDetails',
        'getIssueDetails',
      ]);
      for (const call of seen) {
        expect(call.snapshot, `${String(call.tool)} was not pinned to the member`).toEqual({ repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA });
      }
    });

    /**
     * The live corruptions, verbatim, as the regression case.
     *
     * One run mis-copied the head sha `1d801edd2f2e858c9bd8b03dbde5a09c48eccdae` two different
     * ways: two characters dropped at position 24, and — the one that is not a typo — the head
     * sha's own prefix spliced onto the BASE sha's tail, two identifiers merged into one. Both
     * refused as `revisionMismatch`; together with their siblings they cost 87 of the run's 319
     * tool results.
     *
     * The cast is the point of the test. `Unpinned` means no caller can write this field, so the
     * only way to send one is to defeat the type — and even then the dispatcher reads the member,
     * not the request. A value that cannot be read cannot be mis-transcribed.
     */
    it('cannot be steered to the wrong commits by a stray snapshot on the request', async () => {
      const droppedTwoChars = '1d801edd2f2e858c9bd8b03d' + 'e5a09c48eccdae';
      const splicedOntoBaseTail = '1d801edd2f2e858c9bd8b03dbde2ebfb7a63e36';
      for (const corruption of [droppedTwoChars, splicedOntoBaseTail]) {
        const seen: { snapshot?: unknown; tool?: string }[] = [];
        const member = recordingMember(seen);
        const { dispatcher } = setup(member);
        const request = {
          tool: 'readDiff',
          requestId: nextRequestId(),
          memberId: member.memberId,
          elapsedMs: 0,
          request: { path: 'src/foo.ts', snapshot: { repoId: REPO_ID, baseSha: BASE_SHA, headSha: corruption } },
        } as unknown as HostToolRequest;
        const result = await dispatcher.dispatch('investigating', request);

        expect(result.state).not.toBe('refused'); // before the fix this was `revisionMismatch`
        expect(seen).toHaveLength(1);
        expect(seen[0]?.snapshot).toEqual({ repoId: REPO_ID, baseSha: BASE_SHA, headSha: HEAD_SHA });
      }
    });
  });

  it('refuses a malformed pinned revision', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readFile: async () => ({ ...SNAPSHOT_RESULT('complete'), value: { revision: 'base', path: 'f.ts', startLine: 1, endLine: 1, text: 'x' } }) as FileRangeResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'readFile',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'sideways' as never, path: 'f.ts', startLine: 1, endLine: 1 },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'revisionMismatch' });
  });

  it('refuses a cursor this dispatcher never issued (forgedCursor)', async () => {
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { path: 'src/foo.ts', cursor: 'not-a-real-cursor' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });

  it('refuses an out-of-bounds line range on readFile', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readFile: async () => ({ ...SNAPSHOT_RESULT('complete'), value: { revision: 'base', path: 'f.ts', startLine: 1, endLine: 1, text: 'x' } }) as FileRangeResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'readFile',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'base', path: 'f.ts', startLine: 5, endLine: 2 },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'outOfBounds' });
  });

  it('refuses an out-of-bounds (empty) search query', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ searchRepository: async () => ({ ...SNAPSHOT_RESULT('complete'), value: [] }) as RepositorySearchResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'searchRepository',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'head', query: '' },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'outOfBounds' });
  });

  it('refuses when the provider capability is declared unsupported', async () => {
    const capabilities = fullCapabilities({ diffReads: { supported: false } });
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') }), capabilities));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'capabilityUnavailable' });
  });

  it('refuses when the underlying method is undefined, even if the capability is declared supported', async () => {
    // Asked of a *detail* read: the five pinned operations are required members
    // of an `InvestigationSource`, so a member holding one cannot be missing
    // one. A `Connection` may define neither detail operation, and that is the
    // gap this check exists for.
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const result = await dispatcher.dispatch('bootstrap', {
      requestId: 'detail-absent',
      elapsedMs: 0,
      tool: 'getChangeRequestDetails',
      memberId: 'm1',
      request: { number: '42' },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'capabilityUnavailable' });
  });

  it('refuses when the budget cannot grant the request', async () => {
    const budget = createBudgetTracker({ ...TEST_POLICY, maxToolRequestsPerAttempt: 0 });
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') })), { budget });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'budgetRefused' });
  });

  it('refuses when the attempt was already cancelled', async () => {
    const { dispatcher } = setup(makeMember(diffConnection({ ...SNAPSHOT_RESULT('complete') })), {
      cancellation: { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) },
    });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
  });

  it('checks unknownTool before phaseNotAllowed, and phaseNotAllowed before unknownMember (documented order)', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    // Both an unknown tool AND an unknown member are wrong; unknownTool must win.
    const unknownToolAndMember = { tool: 'deleteRepository', requestId: 'x', memberId: 'ghost', elapsedMs: 0 } as unknown as HostToolRequest;
    expect(await dispatcher.dispatch('investigating', unknownToolAndMember)).toMatchObject({ code: 'unknownTool' });
    // A wrong phase AND an unknown member are both wrong; phaseNotAllowed must win.
    const wrongPhaseAndMember = readDiffRequest({ memberId: 'ghost' });
    expect(await dispatcher.dispatch('bootstrap', wrongPhaseAndMember)).toMatchObject({ code: 'phaseNotAllowed' });
  });

  it('checks forgedCursor before outOfBounds (middle of the documented order)', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ searchRepository: async () => ({ snapshot: SNAPSHOT, state: 'complete', value: [] }) as RepositorySearchResult })));
    // Both a forged cursor AND an empty (out-of-bounds) query are wrong; forgedCursor must win.
    const result = await dispatcher.dispatch('investigating', {
      tool: 'searchRepository',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'head', query: '', cursor: 'not-a-real-cursor' },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });
});

function SNAPSHOT_RESULT(state: 'complete'): { snapshot: typeof SNAPSHOT; state: 'complete'; value: DiffPage } {
  return { snapshot: SNAPSHOT, state, value: DIFF_PAGE };
}

describe('byte-identity invariant: envelope content/digest equal the ledger record (D8)', () => {
  it('readDiff echoes the exact sourceId/digest/content the ledger registered', async () => {
    const { dispatcher, ledger } = setup(makeMember(diffConnection({ snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result.state).toBe('complete');
    if (result.state !== 'complete') return;
    expect(result.content).toEqual({ tool: 'readDiff', patch: DIFF_PAGE.patch });
    const [source] = ledger.sources();
    expect(source).toBeDefined();
    expect(result.sourceId).toBe(source!.sourceId);
    expect(result.digest).toBe(source!.digest);
    expect(source!.digest).toBe(sha256Hex(DIFF_PAGE.patch));
    expect(result.toolContractVersion).toBe(HARNESS_TOOL_CONTRACT_VERSION);
  });

  it('readFile echoes the exact ledger record', async () => {
    const fileResult: FileRangeResult = { snapshot: SNAPSHOT, state: 'complete', value: { revision: 'base', path: 'src/bar.ts', startLine: 1, endLine: 2, text: 'line one\nline two' } };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ readFile: async () => fileResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'readFile',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'base', path: 'src/bar.ts', startLine: 1, endLine: 2 },
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete') return;
    const [source] = ledger.sources();
    expect(result.content).toEqual({ tool: 'readFile', text: source!.exactContent });
    expect(result.sourceId).toBe(source!.sourceId);
    expect(result.digest).toBe(source!.digest);
  });

  it('a paginated result issues a cursor the very next call accepts, and a mutated cursor is refused', async () => {
    const pageOne: DiffPageResult = { snapshot: SNAPSHOT, state: 'paginated', value: DIFF_PAGE, cursor: 'cursor-page-2' };
    const pageTwo: DiffPageResult = { snapshot: SNAPSHOT, state: 'complete', value: { ...DIFF_PAGE, patch: 'second page' } };
    let call = 0;
    const connection = fakeConnection({
      readDiff: async () => {
        call += 1;
        return call === 1 ? pageOne : pageTwo;
      },
    });
    const { dispatcher } = setup(makeMember(connection));
    const first = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(first).toMatchObject({ state: 'paginated', cursor: 'cursor-page-2' });

    const second = await dispatcher.dispatch(
      'investigating',
      readDiffRequest({ request: { path: 'src/foo.ts', cursor: 'cursor-page-2' } }),
    );
    expect(second).toMatchObject({ state: 'complete' });

    const mutated = await dispatcher.dispatch(
      'investigating',
      readDiffRequest({ request: { path: 'src/foo.ts', cursor: 'cursor-page-2-mutated' } }),
    );
    expect(mutated).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });

  it('refuses the same cursor replayed against a different scope (different path)', async () => {
    const pageOne: DiffPageResult = { snapshot: SNAPSHOT, state: 'paginated', value: DIFF_PAGE, cursor: 'shared-cursor-value' };
    const connection = fakeConnection({ readDiff: async () => pageOne });
    const { dispatcher } = setup(makeMember(connection));
    await dispatcher.dispatch('investigating', readDiffRequest());
    const wrongScope = await dispatcher.dispatch(
      'investigating',
      readDiffRequest({ request: { path: 'src/other.ts', cursor: 'shared-cursor-value' } }),
    );
    expect(wrongScope).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });
});

describe('registration refusal surfaces as an explicit refusal, never a silent empty success (D8)', () => {
  it('a payload that exceeds maxToolResultBytes is refused, not silently truncated', async () => {
    const hugePatch = 'x'.repeat(TEST_POLICY.maxToolResultBytes + 1);
    const hugeResult: DiffPageResult = { snapshot: SNAPSHOT, state: 'complete', value: { ...DIFF_PAGE, patch: hugePatch } };
    const { dispatcher, ledger } = setup(makeMember(diffConnection(hugeResult)));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'registrationRefused', registrationCode: 'exceedsResultBound' });
    expect(ledger.size).toBe(0);
  });
});

describe('non-content provider states pass through untouched by the ledger', () => {
  it('unavailable does not register and carries a sanitized reason', async () => {
    const { dispatcher, ledger } = setup(makeMember(diffConnection({ snapshot: SNAPSHOT, state: 'unavailable', reason: 'rate limited' })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'unavailable' });
    expect(ledger.size).toBe(0);
  });

  it('notFound does not register', async () => {
    const { dispatcher, ledger } = setup(makeMember(diffConnection({ snapshot: SNAPSHOT, state: 'notFound', reason: 'no such path' })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'notFound' });
    expect(ledger.size).toBe(0);
  });

  /**
   * The guard for the one hazard the compiler cannot see. Every handler switch
   * in this dispatcher ends in a `default` arm that narrows to `unknown` and
   * reads `result.reason` — which typechecks for any state carrying an
   * optional `reason`, `contentDeclined` included. A handler that simply
   * forgot the new case would compile, ship, and quietly relabel "the source
   * did not serve this file" as "something unknown happened", which
   * `harnessAttempt.ts` reads as nothing to record. Seven handlers, so the
   * assertion is over every operation rather than the one it was written for.
   */
  it('passes a declined provider state through as declined, from every operation, and never as unknown', async () => {
    const declined = { snapshot: SNAPSHOT, state: 'contentDeclined', reason: 'the platform did not serve this' } as const;
    const connection = fakeConnection({
      listChangedFiles: async () => declined,
      readDiff: async () => declined,
      readFile: async () => declined,
      searchRepository: async () => declined,
      searchDiff: async () => declined,
      getChangeRequestDetails: async () => declined,
      getIssueDetails: async () => declined,
    });
    const { dispatcher, ledger } = setup(makeMember(connection));
    const base = { requestId: '', memberId: 'm1', elapsedMs: 0 };
    const requests: HostToolRequest[] = [
      { ...base, requestId: nextRequestId(), tool: 'listChangedFiles', request: {} },
      readDiffRequest(),
      { ...base, requestId: nextRequestId(), tool: 'readFile', request: { revision: 'head', path: 'src/foo.ts', startLine: 1, endLine: 5 } },
      { ...base, requestId: nextRequestId(), tool: 'searchRepository', request: { revision: 'head', query: 'token' } },
      { ...base, requestId: nextRequestId(), tool: 'searchDiff', request: { query: 'token' } },
      { ...base, requestId: nextRequestId(), tool: 'getChangeRequestDetails', request: { number: '42' } },
      { ...base, requestId: nextRequestId(), tool: 'getIssueDetails', request: { issueRepoId: SNAPSHOT.repoId, issueNumber: '7' } },
    ];
    for (const request of requests) {
      const result = await dispatcher.dispatch('investigating', request);
      expect(result, `${request.tool} must carry the declined state through`).toMatchObject({ state: 'contentDeclined', reason: 'the platform did not serve this' });
    }
    expect(ledger.size).toBe(0);
  });
});

describe('listChangedFiles feeds an injected inventory callback, not the ledger (task 9.4)', () => {
  it('is never registered as citable evidence, and reaches the injected callback', async () => {
    const manifestResult: ChangedFileManifestResult = { snapshot: SNAPSHOT, state: 'complete', value: [{ path: 'src/foo.ts', kind: 'modified', binary: false }] };
    const seen: Array<{ memberId: string; result: ChangedFileManifestResult }> = [];
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ listChangedFiles: async () => manifestResult })), {
      onManifestPage: (memberId, result) => seen.push({ memberId, result }),
    });
    const result = await dispatcher.dispatch('bootstrap', { tool: 'listChangedFiles', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: {} });
    expect(result).toMatchObject({ state: 'complete', content: { tool: 'listChangedFiles', entries: manifestResult.value } });
    expect((result as Extract<HostToolResult, { state: 'complete' }>).sourceId).toBeUndefined();
    expect(ledger.size).toBe(0);
    expect(seen).toEqual([{ memberId: 'm1', result: manifestResult }]);
  });
});

/**
 * Which spelling the model used for an absent request must not change what the provider is asked
 * for.
 *
 * `listChangedFiles` is the only tool whose request has no required field, and it only became one
 * when the snapshot pin left the model-facing shape (`Unpinned`, `../platform/types`). The parser
 * now takes the object omitted, null, `""` or `{}` — see `harnessProtocol.ts`'s
 * `toolRequestObjectIsRequired` and the block comment on it — so the thing worth asserting here is
 * not that four turns parse, which `harnessProtocol.test.ts` already covers, but that all four
 * arrive at the provider as one identical, fully pinned call. Parsing four spellings into four
 * slightly different requests would have moved the defect rather than removed it.
 */
describe('listChangedFiles: every spelling of an absent request reaches the provider identically', () => {
  it('asks the provider for the same pinned manifest whether "request" was omitted, null, empty or {}', async () => {
    const manifestResult: ChangedFileManifestResult = { snapshot: SNAPSHOT, state: 'complete', value: [] };
    const seen: ChangedFileManifestRequest[] = [];
    const { dispatcher } = setup(
      makeMember(fakeConnection({
        listChangedFiles: async (request) => {
          seen.push(request);
          return manifestResult;
        },
      })),
    );
    const spellings = [
      { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1' },
      { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: null },
      { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: '' },
      { kind: 'toolRequest', tool: 'listChangedFiles', memberId: 'm1', request: {} },
    ];
    for (const raw of spellings) {
      // Through the real parser, not a hand-built HostToolRequest: the parser is the half that
      // used to refuse three of these four, so a test that skipped it would prove nothing.
      const outcome = parseModelTurn(JSON.stringify({ messages: [raw] }), { phase: 'investigating' });
      expect(outcome.ok, `${JSON.stringify(raw)} should parse: ${JSON.stringify(outcome)}`).toBe(true);
      if (!outcome.ok) continue;
      const [message] = outcome.messages;
      if (message?.kind !== 'toolRequest') throw new Error('expected a toolRequest message');
      const result = await dispatcher.dispatch('investigating', { ...message.call, requestId: nextRequestId(), elapsedMs: 0 } as HostToolRequest);
      expect(result, `${JSON.stringify(raw)} must reach the provider`).toMatchObject({ state: 'complete', content: { tool: 'listChangedFiles', entries: [] } });
    }
    expect(seen, 'every spelling must have reached the provider').toHaveLength(spellings.length);
    // Identical, and pinned by the host from the member the request named — which is the whole
    // reason the model no longer carries a snapshot of its own.
    for (const request of seen) expect(request).toEqual({ snapshot: SNAPSHOT });
  });
});

describe('resolvePolicy (task 9.4)', () => {
  it('registers each present level and echoes the ledger sourceId/digest, not the resolver internal id', async () => {
    const content = 'Never log secrets.';
    const digest = sha256Hex(content);
    const resolver: AgentsPolicyResolver = {
      resolveChain: async (member, changedPath) => ({
        memberId: member.memberId,
        baseSha: member.baseSha,
        path: changedPath,
        levels: [{ directory: '', state: 'present', sourceId: 'agents-policy:base1:.', digest, content, citable: false }],
      }),
    };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ readFile: notImplemented })), { agentsPolicyResolver: resolver });
    const result = await dispatcher.dispatch('investigating', { tool: 'resolvePolicy', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, changedPath: 'src/foo.ts' });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'resolvePolicy') throw new Error('expected resolvePolicy content');
    const [source] = ledger.sources();
    expect(result.content.levels).toEqual([{ directory: '', state: 'present', sourceId: source!.sourceId, digest: source!.digest }]);
    expect(source!.sourceId).not.toBe('agents-policy:base1:.');
    expect(source!.citable).toBe(false);
  });

  it('does not register an absent level, and reports it truthfully', async () => {
    const resolver: AgentsPolicyResolver = {
      resolveChain: async (member, changedPath) => ({ memberId: member.memberId, baseSha: member.baseSha, path: changedPath, levels: [{ directory: '', state: 'absent' }] }),
    };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ readFile: notImplemented })), { agentsPolicyResolver: resolver });
    const result = await dispatcher.dispatch('investigating', { tool: 'resolvePolicy', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, changedPath: 'src/foo.ts' });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'resolvePolicy') throw new Error('expected resolvePolicy content');
    expect(result.content.levels).toEqual([{ directory: '', state: 'absent' }]);
    expect(ledger.size).toBe(0);
  });
});

describe('submitCandidateFinding (task 9.4)', () => {
  async function submittedFinding(overrides: Record<string, unknown> = {}) {
    const { dispatcher, ledger } = setup(makeMember(diffConnection({ snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE })));
    const diffResult = await dispatcher.dispatch('investigating', readDiffRequest());
    if (diffResult.state !== 'complete') throw new Error('expected the seed readDiff call to succeed');
    const candidate = {
      candidateId: 'c1',
      memberId: 'm1',
      file: 'src/foo.ts',
      line: 1,
      endLine: 1,
      severity: 'major',
      category: 'security',
      confidence: 90,
      title: 'Possible issue',
      body: 'Explanation.',
      citations: { primary: { sourceId: diffResult.sourceId, digest: diffResult.digest, path: 'src/foo.ts', range: { startLine: 1, endLine: 1 } } },
      ...overrides,
    };
    const result = await dispatcher.dispatch('investigating', { tool: 'submitCandidateFinding', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, candidate });
    return { result, ledger };
  }

  it('round-trips an accepted candidate', async () => {
    const { result } = await submittedFinding();
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'submitCandidateFinding') throw new Error('expected submitCandidateFinding content');
    expect(result.content.outcome.state).toBe('accepted');
    expect(result.content.candidateId).toBe('c1');
  });

  it('round-trips a rejected candidate (citation naming a location outside the returned evidence)', async () => {
    const { result } = await submittedFinding({ line: 999, endLine: 999 });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'submitCandidateFinding') throw new Error('expected submitCandidateFinding content');
    expect(result.content.outcome.state).toBe('rejected');
  });

  it('round-trips a repairable candidate (citation missing its range)', async () => {
    const { dispatcher } = setup(makeMember(diffConnection({ snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE })));
    const diffResult = await dispatcher.dispatch('investigating', readDiffRequest());
    if (diffResult.state !== 'complete') throw new Error('expected the seed readDiff call to succeed');
    const candidate = {
      candidateId: 'c2',
      memberId: 'm1',
      file: 'src/foo.ts',
      line: 1,
      endLine: 1,
      severity: 'major',
      category: 'security',
      confidence: 90,
      title: 'Possible issue',
      body: 'Explanation.',
      citations: { primary: { sourceId: diffResult.sourceId, digest: diffResult.digest, path: 'src/foo.ts' } },
    };
    const result = await dispatcher.dispatch('investigating', { tool: 'submitCandidateFinding', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, candidate });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'submitCandidateFinding') throw new Error('expected submitCandidateFinding content');
    expect(result.content.outcome.state).toBe('repairable');
  });

  it('never calls Connection for a host action', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const candidate = { candidateId: 'c3', memberId: 'm1', file: 'x', line: 1, severity: 'major', category: 'security', confidence: 90, title: 't', body: 'b', citations: { primary: { sourceId: 'ev_00000000000000000000000000000000', digest: 'x'.repeat(64) } } };
    // No Connection method is configured on this fake at all; if the dispatcher touched Connection this would throw and the test would fail with an unhandled rejection instead of returning `rejected`.
    const result = await dispatcher.dispatch('investigating', { tool: 'submitCandidateFinding', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, candidate });
    expect(result.state).toBe('complete');
  });
});

describe('requestCompletion (task 9.4)', () => {
  function grantedInput(): CompletionEvaluationInput {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [] });
    return {
      heads: [{ memberId: 'm1', snapshotHeadSha: SNAPSHOT.headSha, currentHead: { repoId: SNAPSHOT.repoId, state: 'resolved', headSha: SNAPSHOT.headSha } }],
      inventory,
      unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
      citations: { revalidated: true, invalidatedCount: 0 },
      passes: { contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true },
    };
  }

  it('returns granted when every completion clause passes', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})), { evaluateCompletion: () => evaluateCompletionGate(grantedInput()) });
    const result = await dispatcher.dispatch('completing', { tool: 'requestCompletion', requestId: nextRequestId(), elapsedMs: 0 });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'requestCompletion') throw new Error('expected requestCompletion content');
    expect(result.content.response).toEqual({ granted: true });
  });

  it('returns not-granted with bounded missing conditions when a clause fails but budget remains to repair it', async () => {
    const input = grantedInput();
    const notYetVerified: CompletionEvaluationInput = { ...input, passes: { ...input.passes, finalVerificationComplete: false } };
    const { dispatcher } = setup(makeMember(fakeConnection({})), { evaluateCompletion: () => evaluateCompletionGate(notYetVerified) });
    const result = await dispatcher.dispatch('completing', { tool: 'requestCompletion', requestId: nextRequestId(), elapsedMs: 0 });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'requestCompletion') throw new Error('expected requestCompletion content');
    expect(result.content.response.granted).toBe(false);
    if (result.content.response.granted) return;
    expect(result.content.response.repairable).toBe(true);
    expect(result.content.response.blockers).toContain('verificationPending');
    expect(result.content.response.missingConditions.length).toBeGreaterThan(0);
  });

  it('never calls Connection for a host action', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const result = await dispatcher.dispatch('completing', { tool: 'requestCompletion', requestId: nextRequestId(), elapsedMs: 0 });
    expect(result.state).toBe('complete');
  });
});

describe('cancellation (seam for tasks 9.5-9.7)', () => {
  it('discards a result that resolves after cancellation, and never registers it', async () => {
    let requestSeen = false;
    const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const connection = fakeConnection({
      readDiff: async () => {
        requestSeen = true;
        cancellation.isCancellationRequested = true; // cancelled while "in flight"
        return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult;
      },
    });
    const { dispatcher, ledger } = setup(makeMember(connection), { cancellation });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(requestSeen).toBe(true);
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
    expect(ledger.size).toBe(0);
  });
});

describe('search and detail tools echo the exact ledger content (D8)', () => {
  it('searchRepository', async () => {
    const searchResult: RepositorySearchResult = { snapshot: SNAPSHOT, state: 'complete', value: [{ path: 'src/foo.ts', line: 3, excerpt: 'const x = 1;' }] };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ searchRepository: async () => searchResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'searchRepository',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'head', query: 'const x' },
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'searchRepository') throw new Error('expected searchRepository content');
    const [source] = ledger.sources();
    expect(result.content.matchesJson).toBe(source!.exactContent);
    expect(result.digest).toBe(source!.digest);
  });

  it('searchDiff', async () => {
    const searchResult: DiffSearchResult = { snapshot: SNAPSHOT, state: 'complete', value: [{ position: { path: 'src/foo.ts', side: 'new', line: 1 }, excerpt: 'new line' }] };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ searchDiff: async () => searchResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'searchDiff',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { query: 'new line' },
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'searchDiff') throw new Error('expected searchDiff content');
    const [source] = ledger.sources();
    expect(result.content.matchesJson).toBe(source!.exactContent);
  });

  it('getChangeRequestDetails', async () => {
    const detail: NormalizedDetail = { title: 'T', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
    const detailResult: ChangeRequestDetailResult = { snapshot: SNAPSHOT, state: 'complete', value: detail };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ getChangeRequestDetails: async () => detailResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'getChangeRequestDetails',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { number: '42' },
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'getChangeRequestDetails') throw new Error('expected getChangeRequestDetails content');
    const [source] = ledger.sources();
    expect(result.content.detailJson).toBe(source!.exactContent);
  });

  it('getIssueDetails', async () => {
    const detail: NormalizedDetail = { title: 'Issue', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
    const detailResult: IssueDetailResult = { snapshot: SNAPSHOT, state: 'complete', value: detail };
    const { dispatcher, ledger } = setup(makeMember(fakeConnection({ getIssueDetails: async () => detailResult })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'getIssueDetails',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { issueRepoId: 'repo-1', issueNumber: '7' },
    });
    expect(result.state).toBe('complete');
    if (result.state !== 'complete' || result.content.tool !== 'getIssueDetails') throw new Error('expected getIssueDetails content');
    const [source] = ledger.sources();
    expect(result.content.detailJson).toBe(source!.exactContent);
  });
});

// ---- Cross-member confusion (task 13.2) ----------------------------------------
//
// Every test above builds a single-member dispatcher through `setup()`. That proves
// each operation carries an explicit `memberId` and is refused when that member does
// not exist, but it cannot prove the *cross-member* confusion case D15 and task 13.2
// actually care about: a request that names a real member of a real multi-member
// changeset, while its revision or continuation actually belongs to a *different* real
// member. `harnessEvidenceLedger.test.ts` already proves this at the ledger layer
// ("cross-member aliasing"); this proves it holds at the dispatcher's own pre-ledger
// `validate()` step too, and that a cursor minted for one member cannot be replayed by
// another.

const SNAPSHOT_2 = { repoId: 'repo-2', baseSha: 'base2', headSha: 'head2' };

function twoMemberSetup(
  connections: { m1: Connection & Partial<InvestigationOperations>; m2: Connection & Partial<InvestigationOperations> },
  overrides: Partial<HostToolDispatcherOptions> = {},
): DispatcherHarness {
  const m1: DispatcherMember = { memberId: 'm1', repositoryId: SNAPSHOT.repoId, baseSha: SNAPSHOT.baseSha, headSha: SNAPSHOT.headSha, changeRequestNumber: '42', connection: connections.m1, capabilities: fullCapabilities(), investigationSource: fakeInvestigationSource(connections.m1) };
  const m2: DispatcherMember = { memberId: 'm2', repositoryId: SNAPSHOT_2.repoId, baseSha: SNAPSHOT_2.baseSha, headSha: SNAPSHOT_2.headSha, changeRequestNumber: '77', connection: connections.m2, capabilities: fullCapabilities(), investigationSource: fakeInvestigationSource(connections.m2) };
  const ledger = createEvidenceLedger(
    { runId: 'r1', lineageId: 'l1', attempt: 1 },
    [
      { memberId: m1.memberId, repositoryId: m1.repositoryId, baseSha: m1.baseSha, headSha: m1.headSha, changeRequestNumber: m1.changeRequestNumber },
      { memberId: m2.memberId, repositoryId: m2.repositoryId, baseSha: m2.baseSha, headSha: m2.headSha, changeRequestNumber: m2.changeRequestNumber },
    ],
    { policy: TEST_POLICY },
  );
  const budget = createBudgetTracker(TEST_POLICY, { members: ['m1', 'm2'] });
  const candidateTracker = createCandidateTracker();
  const dispatcher = createHostToolDispatcher({
    members: [m1, m2],
    ledger,
    budget,
    candidateTracker,
    criteria: DEFAULT_CRITERIA,
    agentsPolicyResolver: stubAgentsPolicyResolver(),
    evaluateCompletion: () => NEVER_GRANTED_EVALUATION,
    policy: TEST_POLICY,
    now: () => '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
  return { ledger, dispatcher, budget };
}

describe('cross-member confusion in a real multi-member changeset (task 13.2)', () => {
  /**
   * This used to send a request naming m2 while pinning it to m1's snapshot, and assert
   * `revisionMismatch`. The request has no pin to get wrong any more: the one identifier it
   * carries is `memberId`, and `snapshotOf` reads the revisions off whichever member that names.
   * So the cross-member property is now about which member's commits a named member's request is
   * answered at, and it is asserted directly against the source.
   */
  it('answers a request at the commits of the member it names, never the other member\'s', async () => {
    const seen: unknown[] = [];
    const record = async (request: { snapshot: unknown; path: string }): Promise<DiffPageResult> => {
      seen.push(request.snapshot);
      return { snapshot: request.snapshot, state: 'unavailable', reason: 'recorded' } as DiffPageResult;
    };
    const { dispatcher } = twoMemberSetup(
      { m1: fakeConnection({ readDiff: record }), m2: fakeConnection({ readDiff: record }) },
    );
    await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'm2', request: { path: 'src/foo.ts' } }));
    await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'm1', request: { path: 'src/foo.ts' } }));
    // Same tool, same path, different member: the only thing that decides the revisions is which
    // member was named.
    expect(seen).toEqual([SNAPSHOT_2, SNAPSHOT]);
  });

  it('refuses an id naming neither real member as unknownMember, not revisionMismatch', async () => {
    const { dispatcher } = twoMemberSetup({ m1: fakeConnection({}), m2: fakeConnection({}) });
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'm3', request: { path: 'src/foo.ts' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'unknownMember' });
  });

  it('dispatches each member\'s own request against its own connection and revision, never the other member\'s', async () => {
    const { dispatcher, ledger } = twoMemberSetup({
      m1: diffConnection({ snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE }),
      m2: diffConnection({ snapshot: SNAPSHOT_2, state: 'complete', value: { ...DIFF_PAGE, path: 'src/bar.ts' } }),
    });
    const r1 = await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'm1', request: { path: 'src/foo.ts' } }));
    const r2 = await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'm2', request: { path: 'src/bar.ts' } }));
    expect(r1.state).toBe('complete');
    expect(r2.state).toBe('complete');
    expect(ledger.sources().map((source) => ({ memberId: source.memberId, repositoryId: source.repositoryId }))).toEqual([
      { memberId: 'm1', repositoryId: 'repo-1' },
      { memberId: 'm2', repositoryId: 'repo-2' },
    ]);
  });

  it('refuses a cursor minted for one member when replayed by another member as forgedCursor', async () => {
    const paginatedResult: RepositorySearchResult = { snapshot: SNAPSHOT, state: 'paginated', value: [{ path: 'src/foo.ts', line: 1, excerpt: 'x' }], cursor: 'cursor-1' };
    const { dispatcher } = twoMemberSetup({
      m1: fakeConnection({ searchRepository: async () => paginatedResult }),
      m2: fakeConnection({ searchRepository: async () => paginatedResult }),
    });
    const first = await dispatcher.dispatch('investigating', {
      tool: 'searchRepository',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { revision: 'head', query: 'x' },
    });
    expect(first).toMatchObject({ state: 'paginated', cursor: 'cursor-1' });
    // Same tool, same query, but a different member than the cursor was issued to.
    const replayedByOtherMember = await dispatcher.dispatch('investigating', {
      tool: 'searchRepository',
      requestId: nextRequestId(),
      memberId: 'm2',
      elapsedMs: 0,
      request: { revision: 'head', query: 'x', cursor: 'cursor-1' },
    });
    expect(replayedByOtherMember).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });
});

// ---- The selected investigation source answers the five (task 9.1) --------------------

/**
 * `add-local-git-investigation` task 9.1: the source is selected once, before
 * the attempt starts, and the five revision-pinned operations go to it. The
 * three forge-only ones — change-request details, issue details, the head check
 * — stay with the connection, because no object store can answer a question
 * about a change request.
 *
 * The connection below implements *none* of the five, which is not a contrived
 * shape: GitHub's provider defines no `searchRepository` at all, because
 * `/search/code` indexes a repository's default branch and takes no ref. If any
 * of these five reached the connection, it would answer "this connection
 * cannot …" and the local source's answer would be lost.
 */
describe('a member whose investigation source is not its connection', () => {
  const SOURCE_ANSWER = 'answered by the selected source';

  function sourceMember(): DispatcherMember {
    return {
      ...makeMember(
        fakeConnection({
          getChangeRequestDetails: async (request) => ({
            snapshot: request.snapshot,
            state: 'complete',
            value: { title: 'from the connection', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] } as NormalizedDetail,
          }),
        }),
      ),
      investigationSource: {
        capabilities: fullCapabilities().reviewInvestigation!,
        listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: 'src/local-only.ts', kind: 'modified', binary: false, addedLines: 1, removedLines: 0 }] }),
        readDiff: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { path: request.path, patch: `@@ -1 +1 @@\n+${SOURCE_ANSWER}\n`, positions: [{ path: request.path, side: 'new', line: 1, endLine: 1 }] } }),
        readFile: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: { path: request.path, revision: request.revision, startLine: 1, endLine: 1, text: SOURCE_ANSWER } }),
        searchRepository: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ path: 'src/local-only.ts', line: 1, excerpt: SOURCE_ANSWER }] }),
        searchDiff: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [{ position: { path: 'src/local-only.ts', side: 'new', line: 1, endLine: 1 }, excerpt: SOURCE_ANSWER }] }),
      },
    };
  }

  it('serves every one of the five from the source, and the forge-only operations from the connection', async () => {
    const { dispatcher } = setup(sourceMember());

    const manifest = await dispatcher.dispatch('investigating', { tool: 'listChangedFiles', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: {} });
    expect(manifest.state).toBe('complete');
    expect(JSON.stringify(manifest)).toContain('src/local-only.ts');

    const diff = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(diff.state).toBe('complete');
    expect(JSON.stringify(diff)).toContain(SOURCE_ANSWER);

    const file = await dispatcher.dispatch('investigating', { tool: 'readFile', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: { path: 'src/local-only.ts', revision: 'head', startLine: 1, endLine: 1 } });
    expect(file.state).toBe('complete');
    expect(JSON.stringify(file)).toContain(SOURCE_ANSWER);

    const repoSearch = await dispatcher.dispatch('investigating', { tool: 'searchRepository', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: { query: 'answered', revision: 'head' } });
    expect(repoSearch.state).toBe('complete');
    expect(JSON.stringify(repoSearch)).toContain(SOURCE_ANSWER);

    const diffSearch = await dispatcher.dispatch('investigating', { tool: 'searchDiff', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: { query: 'answered' } });
    expect(diffSearch.state).toBe('complete');
    expect(JSON.stringify(diffSearch)).toContain(SOURCE_ANSWER);

    // And the question only a forge can answer still goes to the forge.
    const details = await dispatcher.dispatch('investigating', { tool: 'getChangeRequestDetails', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: { number: '42', section: 'metadata' } });
    expect(JSON.stringify(details)).toContain('from the connection');
  });

  it('answers unavailable, in the source’s own words, for an operation the source does not implement', async () => {
    // What replaced the old "neither a source nor the connection can answer"
    // case. A member always has a source now, and an `InvestigationSource`
    // always has all five operations, so the gap is no longer structural: a
    // source that cannot answer one says so, pinned to the request, rather than
    // being absent and refused before dispatch.
    const { dispatcher } = setup(makeMember(fakeConnection({})));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'unavailable' });
  });
});
