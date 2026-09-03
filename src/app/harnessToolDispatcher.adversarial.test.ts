/**
 * Task 9.8 adversarial suite for the host tool dispatcher and its retry
 * policy: path traversal, forged cursor, unauthorized member, stale
 * revision, unavailable capability, page bounds, retry exhaustion,
 * `Retry-After`, cancellation during dispatch/backoff, and late completion.
 *
 * Uses an in-test fake `Connection` throughout — never the fixture
 * provider (`../providers/fixture/fixtureProvider.ts`), matching every
 * other harness unit-test file. `DiffPage.positions` is supplied
 * non-empty here even though these tests are not citation-shaped,
 * because the fixture provider's own `positions` are empty arrays and a
 * reader copying this file for a citation test should not inherit that gap.
 */
import { describe, expect, it } from 'vitest';
import { createBudgetTracker } from './harnessBudgets';
import { createCandidateTracker } from './harnessCandidateValidation';
import type { CompletionEvaluation } from './harnessCompletion';
import { evaluateCompletion as evaluateCompletionGate } from './harnessCompletion';
import { createEvidenceLedger } from './harnessEvidenceLedger';
import { createChangedFileInventory } from './harnessInventory';
import type { AgentsPolicyResolver } from './harnessAgentsPolicy';
import {
  createHostToolDispatcher,
  type DispatcherMember,
  type HostToolDispatcherOptions,
  type HostToolRequest,
  type PreIssuedCursor,
} from './harnessToolDispatcher';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { ScmError } from '../platform/errors';
import type { AgentCancellationToken } from './lmAgent';
import type {
  ChangedFileManifestResult,
  ChangeRequestDetailResult,
  DiffPage,
  DiffPageResult,
  NormalizedDetail,
} from '../platform/types';
import type { Connection, InvestigationOperationCapability, ProviderCapabilities } from '../platform/provider';

// ---- Shared fixtures ------------------------------------------------------------

const SNAPSHOT = { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' };

const TEST_POLICY: HarnessPolicy = normalizeHarnessPolicy({
  maxToolResultBytes: 10_000,
  maxEvidenceBytesPerAttempt: 1_000_000,
  diffOrFileReadPageLines: 400,
  searchResultPageMatches: 50,
  manifestPageSize: 100,
  maxToolRequestsPerAttempt: 1_000,
  maxToolRequestsPerTurn: 50,
  maxModelTurnsPerAttempt: 100,
  maxElapsedMsPerAttempt: 10_000_000,
  transientRetriesPerOperation: 3,
  backoffInitialMs: 1_000,
  backoffMaxMs: 30_000,
  backoffJitter: true,
});

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

const FULLY_SUPPORTED: InvestigationOperationCapability = { supported: true, pageBound: { maxPageSize: 50 } };

function fullCapabilities(overrides: Partial<ProviderCapabilities['reviewInvestigation']> = {}): ProviderCapabilities {
  return {
    suggestions: false,
    approvals: false,
    requestChanges: false,
    threadResolution: false,
    groupHierarchy: false,
    batchedReview: false,
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

function makeMember(connection: Connection, capabilities: ProviderCapabilities = fullCapabilities()): DispatcherMember {
  return { memberId: 'm1', repositoryId: SNAPSHOT.repoId, baseSha: SNAPSHOT.baseSha, headSha: SNAPSHOT.headSha, changeRequestNumber: '42', connection, capabilities };
}

function stubAgentsPolicyResolver(): AgentsPolicyResolver {
  return { resolveChain: notImplemented };
}

const NEVER_GRANTED_EVALUATION: CompletionEvaluation = evaluateCompletionGate({
  heads: [],
  inventory: createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]),
  unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
  citations: { revalidated: false, invalidatedCount: 0 },
  passes: { contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false },
});

function setup(member: DispatcherMember, overrides: Partial<HostToolDispatcherOptions> = {}) {
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

const DIFF_PAGE: DiffPage = {
  path: 'src/foo.ts',
  patch: '@@ -1,2 +1,2 @@\n-old line\n+new line\n',
  positions: [{ path: 'src/foo.ts', side: 'new', line: 1, endLine: 1 }],
};

function readDiffRequest(overrides: Partial<Extract<HostToolRequest, { tool: 'readDiff' }>> = {}): Extract<HostToolRequest, { tool: 'readDiff' }> {
  return {
    tool: 'readDiff',
    requestId: nextRequestId(),
    memberId: 'm1',
    elapsedMs: 0,
    request: { snapshot: SNAPSHOT, path: 'src/foo.ts' },
    ...overrides,
  };
}

/** A cancellation token whose listener actually fires — see `harnessRetry.test.ts`'s file-local helper of the same shape for why the flag-only fakes elsewhere cannot be raced against mid-backoff. */
function manualCancellationToken(): AgentCancellationToken & { cancel(): void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() {
      return requested;
    },
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (requested) return;
      requested = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

// ---- 1. Path traversal -----------------------------------------------------------

describe('path traversal (task 9.8 item 1)', () => {
  it('refuses a literal ../ traversal', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: '../../etc/passwd' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'invalidPath' });
  });

  it('a NUL byte anywhere in the path is refused', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: 'src/foo' + String.fromCharCode(0) + '.ts' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'invalidPath' });
  });

  it('a percent-encoded traversal or separator (%2e%2e, %2f, %5c) is refused', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const encoded = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: '..%2f..%2fetc%2fpasswd' } }));
    expect(encoded).toMatchObject({ state: 'refused', code: 'invalidPath' });
    const encodedDots = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: '%2e%2e/%2e%2e/etc/passwd' } }));
    expect(encodedDots).toMatchObject({ state: 'refused', code: 'invalidPath' });
  });

  it('an absolute (leading-slash) path is normalized to repository-relative and never reaches the provider unscoped — it is not itself invalidPath', async () => {
    // Deviation from a literal "refused" reading of this sub-case, recorded in the handover
    // report: `normalizeEvidencePath('/etc/passwd')` already strips the leading slash and treats
    // the remainder as repo-relative (`harnessEvidenceLedger.test.ts` pins this), so refusing it
    // outright would break that existing, currently-green test. What this test proves instead is
    // the actual security property: the provider only ever sees the de-absolutized, still-`..`-free
    // path, so an absolute-looking request cannot read outside the repository tree.
    let seenPath: string | undefined;
    const connection = fakeConnection({
      readDiff: async (request) => {
        seenPath = (request as { path: string }).path;
        return { snapshot: SNAPSHOT, state: 'notFound', reason: 'no such path' } as DiffPageResult;
      },
    });
    const { dispatcher } = setup(makeMember(connection));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: '/etc/passwd' } }));
    expect(seenPath).toBe('etc/passwd');
    expect(result).toMatchObject({ state: 'notFound' });
  });
});

// ---- 2. Forged / mutated / replayed-scope cursor ----------------------------------

describe('cursor provenance (task 9.8 item 2)', () => {
  it('refuses a cursor this dispatcher never issued (forged)', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: 'src/foo.ts', cursor: 'never-issued' } }));
    expect(result).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });

  it('refuses a mutated cursor (one character changed from an issued value)', async () => {
    const pageOne: DiffPageResult = { snapshot: SNAPSHOT, state: 'paginated', value: DIFF_PAGE, cursor: 'issued-cursor-1' };
    const connection = fakeConnection({ readDiff: async () => pageOne });
    const { dispatcher } = setup(makeMember(connection));
    const first = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(first).toMatchObject({ state: 'paginated', cursor: 'issued-cursor-1' });
    const mutated = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: 'src/foo.ts', cursor: 'issued-cursor-1-x' } }));
    expect(mutated).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });

  it('refuses the same cursor value replayed against a different scope (a different path)', async () => {
    const pageOne: DiffPageResult = { snapshot: SNAPSHOT, state: 'paginated', value: DIFF_PAGE, cursor: 'shared-value' };
    const connection = fakeConnection({ readDiff: async () => pageOne });
    const { dispatcher } = setup(makeMember(connection));
    await dispatcher.dispatch('investigating', readDiffRequest());
    const wrongScope = await dispatcher.dispatch('investigating', readDiffRequest({ request: { snapshot: SNAPSHOT, path: 'src/other.ts', cursor: 'shared-value' } }));
    expect(wrongScope).toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });

  it('a bootstrap-pre-issued cursor is accepted by a fresh dispatcher instance on the matching reopen call (task 9.6 handover gap 1)', async () => {
    const detail: NormalizedDetail = { title: 'T', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] };
    const detailResult: ChangeRequestDetailResult = { snapshot: SNAPSHOT, state: 'complete', value: detail };
    const connection = fakeConnection({ getChangeRequestDetails: async () => detailResult });
    const preIssued: PreIssuedCursor[] = [{ tool: 'getChangeRequestDetails', memberId: 'm1', section: 'discussion', cursor: 'bootstrap-cursor-1' }];
    const { dispatcher } = setup(makeMember(connection), { preIssuedCursors: preIssued });
    const result = await dispatcher.dispatch('investigating', {
      tool: 'getChangeRequestDetails',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { snapshot: SNAPSHOT, number: '42', section: 'discussion', cursor: 'bootstrap-cursor-1' },
    });
    expect(result).not.toMatchObject({ state: 'refused', code: 'forgedCursor' });
  });
});

// ---- 3. Unauthorized member --------------------------------------------------------

describe('unauthorized member (task 9.8 item 3)', () => {
  it('refuses a memberId that is not part of this run snapshot', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const result = await dispatcher.dispatch('investigating', readDiffRequest({ memberId: 'not-a-real-member' }));
    expect(result).toMatchObject({ state: 'refused', code: 'unknownMember' });
  });
});

// ---- 4. Stale revision --------------------------------------------------------------

describe('stale revision (task 9.8 item 4)', () => {
  it('refuses a request pinned to a base/head pair that does not match the member snapshot', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented })));
    const result = await dispatcher.dispatch(
      'investigating',
      readDiffRequest({ request: { snapshot: { ...SNAPSHOT, headSha: 'a-different-head' }, path: 'src/foo.ts' } }),
    );
    expect(result).toMatchObject({ state: 'refused', code: 'revisionMismatch' });
  });
});

// ---- 5. Unavailable capability --------------------------------------------------------

describe('unavailable capability (task 9.8 item 5)', () => {
  it('refuses when the provider declares the capability unsupported', async () => {
    const capabilities = fullCapabilities({ diffReads: { supported: false } });
    const { dispatcher } = setup(makeMember(fakeConnection({ readDiff: notImplemented }), capabilities));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'capabilityUnavailable' });
  });

  it('refuses when the Connection method itself is absent, even though the capability is declared supported', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({}))); // fullCapabilities() default declares diffReads supported; no readDiff method exists
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'capabilityUnavailable' });
  });
});

// ---- 6. Page bounds ----------------------------------------------------------------

describe('page bounds (task 9.8 item 6)', () => {
  it('refuses when the providers declared pageBound.maxPageSize exceeds the policy page-size field', async () => {
    const oversizedBound: InvestigationOperationCapability = { supported: true, pageBound: { maxPageSize: TEST_POLICY.diffOrFileReadPageLines + 1 } };
    const capabilities = fullCapabilities({ diffReads: oversizedBound });
    let called = false;
    const connection = fakeConnection({ readDiff: async () => { called = true; return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult; } });
    const { dispatcher } = setup(makeMember(connection, capabilities));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'outOfBounds' });
    expect(called).toBe(false); // refused before the provider is ever called
  });

  it('refuses a readFile line range wider than the policy page-size field', async () => {
    const { dispatcher } = setup(makeMember(fakeConnection({ readFile: notImplemented })));
    const result = await dispatcher.dispatch('investigating', {
      tool: 'readFile',
      requestId: nextRequestId(),
      memberId: 'm1',
      elapsedMs: 0,
      request: { snapshot: SNAPSHOT, revision: 'base', path: 'src/foo.ts', startLine: 1, endLine: TEST_POLICY.diffOrFileReadPageLines + 50 },
    });
    expect(result).toMatchObject({ state: 'refused', code: 'outOfBounds' });
  });
});

// ---- 7/8/9(backoff)/10(readDiff): retry, Retry-After, and cancellation -----------------

describe('retry exhaustion (task 9.8 item 7)', () => {
  it('after 1 + transientRetriesPerOperation attempts, yields a truthful unavailable failure, never an empty success', async () => {
    let calls = 0;
    const connection = fakeConnection({
      readDiff: async () => {
        calls += 1;
        throw new ScmError('network', 'connection reset');
      },
    });
    const sleeps: number[] = [];
    const { dispatcher } = setup(makeMember(connection), { retry: { sleep: async (ms) => { sleeps.push(ms); } } });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(calls).toBe(1 + TEST_POLICY.transientRetriesPerOperation);
    expect(sleeps).toHaveLength(TEST_POLICY.transientRetriesPerOperation);
    expect(result.state).toBe('unavailable');
    if (result.state !== 'unavailable') return;
    expect(result.reason.length).toBeGreaterThan(0);
  });

  it('never retries a non-retryable error kind (e.g. notFound-shaped ScmError), failing after exactly one attempt', async () => {
    let calls = 0;
    const connection = fakeConnection({
      readDiff: async () => {
        calls += 1;
        throw new ScmError('notFound', 'no such ref');
      },
    });
    const { dispatcher } = setup(makeMember(connection));
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(calls).toBe(1);
    expect(result.state).toBe('unavailable');
  });
});

describe('Retry-After honoured over computed backoff (task 9.8 item 8)', () => {
  it('sleeps for exactly retryAfterSeconds * 1000, not a computed exponential delay, then succeeds', async () => {
    let calls = 0;
    const connection = fakeConnection({
      readDiff: async () => {
        calls += 1;
        if (calls === 1) throw new ScmError('rateLimited', 'slow down', { retryAfterSeconds: 4 });
        return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult;
      },
    });
    const sleeps: number[] = [];
    const { dispatcher } = setup(makeMember(connection), { retry: { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 } });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(sleeps).toEqual([4000]);
    expect(result.state).toBe('complete');
    expect(calls).toBe(2);
  });
});

describe('cancellation during dispatch and during backoff, both stop promptly (task 9.8 item 9)', () => {
  it('cancellation observed while a provider call is in flight refuses promptly with code cancelled', async () => {
    let requestSeen = false;
    const cancellation = manualCancellationToken();
    const connection = fakeConnection({
      readDiff: async () => {
        requestSeen = true;
        cancellation.cancel();
        return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult;
      },
    });
    const { dispatcher, ledger } = setup(makeMember(connection), { cancellation });
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(requestSeen).toBe(true);
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
    expect(ledger.size).toBe(0);
  });

  it('cancellation fired mid-backoff-wait stops the wait immediately, without exhausting all retries or ever succeeding', async () => {
    const cancellation = manualCancellationToken();
    let calls = 0;
    let releaseHangingSleep: () => void = () => {};
    const hangingSleep = () => new Promise<void>((resolve) => { releaseHangingSleep = resolve; });
    const connection = fakeConnection({
      readDiff: async () => {
        calls += 1;
        throw new ScmError('network', 'still failing');
      },
    });
    const { dispatcher } = setup(makeMember(connection), { cancellation, retry: { sleep: hangingSleep } });
    const resultPromise = dispatcher.dispatch('investigating', readDiffRequest());
    // Let the retry loop reach its backoff wait (first attempt fails synchronously-ish, then it sleeps).
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    cancellation.cancel();
    const result = await resultPromise;
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
    expect(calls).toBe(1); // only the first attempt ran; the backoff wait for a second was interrupted
    void releaseHangingSleep;
  });
});

describe('late completion is ignored (task 9.8 item 10)', () => {
  it('a readDiff provider promise resolving after cancellation is never registered: the ledger does not grow', async () => {
    const cancellation = manualCancellationToken();
    const connection = fakeConnection({
      readDiff: async () => {
        cancellation.cancel(); // cancellation lands while this "provider call" is still in flight
        return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult;
      },
    });
    const { dispatcher, ledger } = setup(makeMember(connection), { cancellation });
    const before = ledger.size;
    const result = await dispatcher.dispatch('investigating', readDiffRequest());
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
    expect(ledger.size).toBe(before);
  });

  it('a listChangedFiles provider promise resolving after cancellation never reaches onManifestPage: no coverage is recorded', async () => {
    const cancellation = manualCancellationToken();
    const manifestResult: ChangedFileManifestResult = { snapshot: SNAPSHOT, state: 'complete', value: [{ path: 'src/foo.ts', kind: 'modified', binary: false }] };
    const connection = fakeConnection({
      listChangedFiles: async () => {
        cancellation.cancel();
        return manifestResult;
      },
    });
    const seen: unknown[] = [];
    const { dispatcher } = setup(makeMember(connection), { cancellation, onManifestPage: (memberId, result) => seen.push({ memberId, result }) });
    const result = await dispatcher.dispatch('bootstrap', { tool: 'listChangedFiles', requestId: nextRequestId(), memberId: 'm1', elapsedMs: 0, request: { snapshot: SNAPSHOT } });
    expect(result).toMatchObject({ state: 'refused', code: 'cancelled' });
    expect(seen).toEqual([]); // Gap 1 (task 9.6 handover): the manifest guard must fire before onManifestPage, not only in dispatch()'s own post-await check
  });
});

// ---- Bonus coverage beyond the numbered 9.8 list: the resumedAfterWait/onResuming seam ----

describe('resumedAfterWait fires onResuming exactly once, before the retried attempt (bonus, task 9.6 seam)', () => {
  it('propagates through dispatch()\'s third argument into the retry engine', async () => {
    let calls = 0;
    const connection = fakeConnection({ readDiff: async () => { calls += 1; return { snapshot: SNAPSHOT, state: 'complete', value: DIFF_PAGE } as DiffPageResult; } });
    const resumingCalls: unknown[] = [];
    const { dispatcher } = setup(makeMember(connection), { retry: { onResuming: (info) => resumingCalls.push(info) } });
    const result = await dispatcher.dispatch('investigating', readDiffRequest(), { resumedAfterWait: true });
    expect(result.state).toBe('complete');
    expect(resumingCalls).toHaveLength(1);
    expect(resumingCalls[0]).toMatchObject({ tool: 'readDiff' });

    resumingCalls.length = 0;
    await dispatcher.dispatch('investigating', readDiffRequest());
    expect(resumingCalls).toEqual([]);
    expect(calls).toBe(2);
  });
});
