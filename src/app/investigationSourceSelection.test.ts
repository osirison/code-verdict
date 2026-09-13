/**
 * Source selection — tasks 9.1 and 9.2 of `add-local-git-investigation`, design
 * D5, under the rule that replaced D5's fallback ladder.
 *
 * **What these tests stopped asserting, and why the scenarios stayed.** Every
 * "falls back to the provider when …" case below used to end with the provider
 * serving the review: no git on the machine, no descriptor from the connection,
 * no object cache on the host, a fetch the remote refused. All four still
 * happen; none of them has a fallback any more, because the rule is that a
 * change is read from a local clone or it is not read. So the scenarios are
 * kept and their outcomes rewritten: the member is unservable, the reason names
 * what could not be obtained, and the stored checkpoint is left alone. Deleting
 * them would have thrown away the coverage of the conditions themselves.
 *
 * Three things also went entirely, and each because the question went with it:
 * the provider serviceability check, `pairEvidence`, and the
 * refused-versus-gone disambiguation. All three existed to choose *which*
 * fallback to take, and all three were answered by asking a forge for a
 * manifest at the pinned pair — a diff computation, which is exactly what the
 * rule forbids. Nothing left is entitled to say a commit is gone, so nothing
 * says it.
 *
 * Everything below drives `selectInvestigationSource` with stubs for the two
 * things it reaches out to: the git probe and the object cache. Both spawn
 * processes, and neither is what these tests are about — what is, is the
 * decision: is there a source, what commit is the diff against, and what is the
 * attempt told when there is nothing to read from. The real acquisition path
 * has its own suite (`src/localgit/objectAcquisition.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import {
  PREFERRED_SOURCE_LIMITATION_CODE,
  refusingInvestigationSource,
  selectInvestigationSource,
  type InvestigationSourceSelectionRequest,
} from './investigationSourceSelection';
import {
  INVESTIGATION_CONTRACT_VERSION,
  type InvestigationSource,
  type InvestigationSourceCapabilities,
  type ObjectSourceResult,
} from '../platform/types';
import type { Connection } from '../platform/provider';
import type { AcquisitionOutcome, ObjectCache } from '../localgit/objectAcquisition';
import type { CacheLease } from '../localgit/objectCache';
import { normalizeLocalGitPolicy } from '../localgit/localGitPolicy';

const REPO_ID = 'acme/widgets';
/** What `git merge-base` computed, which is what selection hands back for the snapshot to pin. */
const MERGE_BASE_SHA = '1111111111111111111111111111111111111111';
const HEAD_SHA = '2222222222222222222222222222222222222222';
const MEMBER_ID = `${REPO_ID}!7`;

const SUPPORTED = { supported: true, pageBound: { maxPageSize: 100 } } as const;

function localCapabilities(): InvestigationSourceCapabilities {
  return {
    manifests: SUPPORTED,
    diffReads: SUPPORTED,
    fileReads: SUPPORTED,
    repositorySearch: SUPPORTED,
    diffSearch: SUPPORTED,
    pagination: { maxPageSize: 100 },
  };
}

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

function descriptorAvailable(): ObjectSourceResult {
  return {
    state: 'available',
    descriptor: {
      fetchUrl: 'https://example.test/acme/widgets.git',
      authorizationHeaderValue: 'Bearer secret-value',
      refHint: 'refs/pull/7/head',
      mergeTargetRef: 'refs/heads/main',
    },
  };
}

function fakeLease(): CacheLease & { released: number; refreshed: number } {
  const lease = {
    path: '/cache/acme/leases/attempt.json',
    released: 0,
    refreshed: 0,
    refresh(): void {
      lease.refreshed += 1;
    },
    release(): void {
      lease.released += 1;
    },
  };
  return lease;
}

function fakeCache(outcome: AcquisitionOutcome): ObjectCache & { calls: number } {
  const cache = {
    root: '/cache',
    policy: normalizeLocalGitPolicy({}),
    calls: 0,
    async acquire(): Promise<AcquisitionOutcome> {
      cache.calls += 1;
      return outcome;
    },
    async evict() {
      return { deleted: [], remainingBytes: 0 } as never;
    },
  };
  return cache;
}

function acquired(lease: CacheLease, overrides: Partial<Extract<AcquisitionOutcome, { state: 'acquired' }>> = {}): AcquisitionOutcome {
  return {
    state: 'acquired',
    gitDir: '/cache/acme/repository.git',
    lease,
    baseSha: MERGE_BASE_SHA,
    depthReached: 10,
    fetched: [HEAD_SHA, MERGE_BASE_SHA],
    alreadyPresent: [],
    recreated: false,
    ...overrides,
  };
}

function localSource(): InvestigationSource {
  return {
    capabilities: localCapabilities(),
    listChangedFiles: async (request) => ({ snapshot: request.snapshot, state: 'complete', value: [] }),
    readDiff: async (request) => ({ snapshot: request.snapshot, state: 'unavailable', reason: 'not part of this test' }),
    readFile: async (request) => ({ snapshot: request.snapshot, state: 'unavailable', reason: 'not part of this test' }),
    searchRepository: async (request) => ({ snapshot: request.snapshot, state: 'unavailable', reason: 'not part of this test' }),
    searchDiff: async (request) => ({ snapshot: request.snapshot, state: 'unavailable', reason: 'not part of this test' }),
  };
}

function request(overrides: Partial<InvestigationSourceSelectionRequest> = {}): InvestigationSourceSelectionRequest {
  return {
    member: {
      memberId: MEMBER_ID,
      providerId: 'github',
      instanceUrl: 'https://github.test',
      ref: { repoId: REPO_ID, number: '7' },
      headSha: HEAD_SHA,
    },
    connection: fakeConnection({ getObjectSource: async () => descriptorAvailable() }),
    attemptId: 'run-1:1',
    objectCache: fakeCache(acquired(fakeLease())),
    probeGit: async () => ({ state: 'supported', version: { major: 2, minor: 45, patch: 0, raw: '2.45.0' } }),
    createSource: () => localSource(),
    ...overrides,
  };
}

describe('selecting an investigation source (task 9.1)', () => {
  it('uses a local object store, and reports the commit git computed the diff to be against', async () => {
    const selection = await selectInvestigationSource(request());

    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.record.kind).toBe('localGit');
    expect(selection.record.contractVersion).toBe(INVESTIGATION_CONTRACT_VERSION);
    // Not a value any platform reported: the caller pins the snapshot to this.
    expect(selection.baseSha).toBe(MERGE_BASE_SHA);
    expect(selection.source).toBeDefined();
    expect(selection.lease).toBeDefined();
  });

  it('obtains the objects inside selection, not at the first tool call (task 9.2)', async () => {
    const cache = fakeCache(acquired(fakeLease()));
    const selection = await selectInvestigationSource(request({ objectCache: cache }));

    expect(cache.calls).toBe(1);
    expect(selection.outcome).toBe('selected');
  });

  it('asks the connection for the head, and never for what the head is against', async () => {
    // The one revision a platform still supplies is where the change request's
    // head points. What it is against is a computation, and acquisition does
    // it — the descriptor names a branch, never a commit.
    let askedFor: unknown;
    const connection = fakeConnection({
      getObjectSource: async (ref) => {
        askedFor = ref;
        return descriptorAvailable();
      },
    });
    await selectInvestigationSource(request({ connection }));
    expect(askedFor).toEqual({ repoId: REPO_ID, number: '7' });
  });

  it('signs the capability set the attempt actually has, after the host narrowed it', async () => {
    const narrowed = { ...localCapabilities(), fileReads: { supported: false as const }, repositorySearch: { supported: false as const } };
    const selection = await selectInvestigationSource(
      request({ narrowCapabilities: () => narrowed }),
    );

    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.capabilities).toEqual(narrowed);

    const unnarrowed = await selectInvestigationSource(request());
    expect(unnarrowed.outcome).toBe('selected');
    if (unnarrowed.outcome !== 'selected') return;
    expect(selection.record.capabilitySignature).not.toBe(unnarrowed.record.capabilitySignature);
  });

  it('records a rebuilt store as a limitation and still uses it', async () => {
    const selection = await selectInvestigationSource(
      request({ objectCache: fakeCache(acquired(fakeLease(), { recreated: true })) }),
    );

    expect(selection.outcome).toBe('selected');
    expect(selection.limitations.map((limitation) => limitation.code)).toEqual([PREFERRED_SOURCE_LIMITATION_CODE]);
    expect(selection.limitations[0]?.message).toContain('rebuilt');
  });
});

/**
 * The four conditions that used to hand the review to the forge.
 *
 * Each one is still a condition a real machine produces. What changed is the
 * answer: the attempt does not start, the reason names what could not be
 * obtained, and nothing claims anything about whether the revisions exist.
 */
describe('nothing to read the change from', () => {
  async function expectUnservable(overrides: Partial<InvestigationSourceSelectionRequest>, contains: string): Promise<void> {
    const selection = await selectInvestigationSource(request(overrides));
    expect(selection.outcome).toBe('unservable');
    if (selection.outcome !== 'unservable') return;
    expect(selection.reason).toContain(contains);
    // Said once, in every refusal: there is no second place to look.
    expect(selection.reason).toContain('no other source');
  }

  it('refuses when this host keeps no object store, and never asks for a descriptor', async () => {
    let asked = false;
    const connection = fakeConnection({
      getObjectSource: async () => {
        asked = true;
        return descriptorAvailable();
      },
    });
    await expectUnservable({ objectCache: undefined, connection }, 'keeps no local object store');
    expect(asked).toBe(false);
  });

  it('refuses when the machine has no usable git, and says so', async () => {
    await expectUnservable(
      { probeGit: async () => ({ state: 'unsupported', reason: 'No git executable was found on this machine.' }) },
      'No git executable',
    );
  });

  it('refuses when the connection cannot say where objects come from', async () => {
    await expectUnservable({ connection: fakeConnection({}) }, 'does not say where this repository’s objects can be obtained');
  });

  it('refuses with the descriptor’s own reason when there is no object source', async () => {
    await expectUnservable(
      { connection: fakeConnection({ getObjectSource: async () => ({ state: 'unavailable', reason: 'This repository is archived and serves no clone location.' }) }) },
      'archived',
    );
  });

  it('refuses when the cache itself cannot be used', async () => {
    await expectUnservable(
      { objectCache: fakeCache({ state: 'unavailable', code: 'cacheUnwritable', reason: 'The object cache location could not be created or written to.' }) },
      'could not be created or written to',
    );
  });

  it('refuses when the branch the change targets could not be obtained, so no merge base could be computed', async () => {
    await expectUnservable(
      {
        objectCache: fakeCache({
          state: 'commitUnobtainable',
          code: 'targetRefUnfetchable',
          commit: HEAD_SHA,
          reason: 'The branch this change request is to be merged into could not be obtained.',
        }),
      },
      'to be merged into could not be obtained',
    );
  });

  it('refuses when the connection names no branch for the change to be merged into', async () => {
    await expectUnservable(
      {
        objectCache: fakeCache({
          state: 'commitUnobtainable',
          code: 'noMergeTarget',
          commit: HEAD_SHA,
          reason: 'This connection does not say which branch this change request is to be merged into.',
        }),
      },
      'does not say which branch',
    );
  });

  it('records a limitation for every refusal, so the run reports what it could not do', async () => {
    const selection = await selectInvestigationSource(
      request({ probeGit: async () => ({ state: 'unsupported', reason: 'git is too old.' }) }),
    );
    expect(selection.limitations.map((limitation) => limitation.code)).toEqual([PREFERRED_SOURCE_LIMITATION_CODE]);
    expect(selection.limitations[0]?.message).toContain(MEMBER_ID);
  });
});

/**
 * The row design D8 gave to a fetch that failed, now that nothing can tell a
 * refusal from an absence.
 *
 * The forge used to be asked for a manifest at the pinned pair to separate the
 * two. That request is a diff computation, so it is gone, and with it the only
 * evidence that could have made a stored checkpoint incompatible. Ambiguity
 * resolves toward refusing *and* toward keeping the reviewer's work: the
 * attempt does not start, and nothing declares the revision gone.
 */
describe('a pinned commit that could not be fetched', () => {
  const refusals: readonly { code: 'fetchFailed' | 'wrongObject' | 'hintMismatch'; reason: string }[] = [
    { code: 'fetchFailed', reason: 'That revision could not be obtained from this repository’s object source.' },
    { code: 'wrongObject', reason: 'The object source answered with something other than the revision this review is pinned to.' },
    { code: 'hintMismatch', reason: 'The object source’s alternate reference resolved to a different revision.' },
  ];

  for (const refusal of refusals) {
    it(`refuses on ${refusal.code} without saying the revision is gone`, async () => {
      const selection = await selectInvestigationSource(
        request({ objectCache: fakeCache({ state: 'commitUnobtainable', code: refusal.code, commit: HEAD_SHA, reason: refusal.reason }) }),
      );

      expect(selection.outcome).toBe('unservable');
      if (selection.outcome !== 'unservable') return;
      expect(selection.reason).toContain(refusal.reason);
      // The words that would make a checkpoint incompatible, and that nothing
      // is now entitled to say.
      expect(selection.reason).not.toMatch(/gone|not found|no longer exists/i);
    });
  }
});

describe('a source the host supplies rather than one acquisition builds', () => {
  const supplied = { source: localSource(), baseSha: 'sample-base-1' };

  it('is used as given, and recorded as the sample source rather than as git', async () => {
    const selection = await selectInvestigationSource(request({ suppliedSource: supplied }));

    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.record.kind).toBe('sample');
    expect(selection.source).toBe(supplied.source);
    // Whatever the sample data says its base is — there is no repository to
    // compute one in.
    expect(selection.baseSha).toBe('sample-base-1');
    // Nothing is leased, because nothing is held against eviction.
    expect(selection.lease).toBeUndefined();
  });

  it('skips the git probe, the descriptor and the fetch entirely', async () => {
    let probed = false;
    let askedForDescriptor = false;
    const cache = fakeCache(acquired(fakeLease()));
    await selectInvestigationSource(
      request({
        suppliedSource: supplied,
        objectCache: cache,
        probeGit: async () => {
          probed = true;
          return { state: 'supported', version: { major: 2, minor: 45, patch: 0, raw: '2.45.0' } };
        },
        connection: fakeConnection({
          getObjectSource: async () => {
            askedForDescriptor = true;
            return descriptorAvailable();
          },
        }),
      }),
    );

    expect(probed).toBe(false);
    expect(askedForDescriptor).toBe(false);
    expect(cache.calls).toBe(0);
  });

  it('is narrowed by the host policy exactly as a git source is', async () => {
    const narrowed = { ...localCapabilities(), fileReads: { supported: false as const } };
    const selection = await selectInvestigationSource(
      request({ suppliedSource: supplied, narrowCapabilities: () => narrowed }),
    );
    expect(selection.outcome).toBe('selected');
    if (selection.outcome !== 'selected') return;
    expect(selection.capabilities).toEqual(narrowed);
  });
});

describe('the source a member that nothing could read is given', () => {
  it('refuses every operation in the words of the refusal, and declares nothing supported', async () => {
    const source = refusingInvestigationSource('No git executable was found on this machine.');
    const snapshot = { repoId: REPO_ID, baseSha: MERGE_BASE_SHA, headSha: HEAD_SHA };

    for (const [name, result] of [
      ['listChangedFiles', await source.listChangedFiles({ snapshot })],
      ['readDiff', await source.readDiff({ snapshot, path: 'a.ts' })],
      ['readFile', await source.readFile({ snapshot, revision: 'head', path: 'a.ts', startLine: 1, endLine: 1 })],
      ['searchRepository', await source.searchRepository({ snapshot, revision: 'head', query: 'x' })],
      ['searchDiff', await source.searchDiff({ snapshot, query: 'x' })],
    ] as const) {
      expect(result.state, name).toBe('unavailable');
      expect(result.snapshot, name).toEqual(snapshot);
      expect(result.state === 'unavailable' ? result.reason : '', name).toContain('No git executable');
    }

    for (const declaration of Object.values(source.capabilities)) {
      if ('supported' in declaration) expect(declaration.supported).toBe(false);
    }
  });
});

describe('acquisition is reported as run activity (task 10.2)', () => {
  it('reports what was being done, what it cost, and how deep it had to go', async () => {
    let clock = 1_000;
    const selection = await selectInvestigationSource(
      request({
        now: () => {
          clock += 250;
          return clock;
        },
      }),
    );

    expect(selection.activity).toHaveLength(2);
    expect(selection.activity[0]).toMatchObject({ kind: 'actionStarted', target: MEMBER_ID });
    expect(selection.activity[1]).toMatchObject({ kind: 'toolCompleted', tool: 'acquireObjects', memberId: MEMBER_ID, durationMs: 250 });
    const summary = selection.activity[1]?.kind === 'toolCompleted' ? selection.activity[1].summary : '';
    expect(summary).toContain('Fetched 2 pinned revisions');
    // The number a reviewer watching a long pause is actually asking about.
    expect(summary).toContain('within 10 commits of history');
  });

  it('says plainly when nothing had to be fetched, which is every review after the first', async () => {
    const selection = await selectInvestigationSource(
      request({ objectCache: fakeCache(acquired(fakeLease(), { fetched: [], alreadyPresent: [HEAD_SHA, MERGE_BASE_SHA] })) }),
    );
    const summary = selection.activity[1]?.kind === 'toolCompleted' ? selection.activity[1].summary : '';
    expect(summary).toContain('already held');
  });

  it('reports a failed acquisition as a failure, with the reason the reviewer will also see as a limitation', async () => {
    const reason = 'That revision could not be obtained from this repository’s object source.';
    const selection = await selectInvestigationSource(
      request({ objectCache: fakeCache({ state: 'commitUnobtainable', code: 'fetchFailed', commit: HEAD_SHA, reason }) }),
    );

    expect(selection.activity[1]).toMatchObject({ kind: 'toolFailed', tool: 'acquireObjects', reason });
    expect(selection.limitations.some((limitation) => limitation.message.includes(reason))).toBe(true);
  });

  it('reports nothing at all when no acquisition was attempted', async () => {
    const selection = await selectInvestigationSource(
      request({ probeGit: async () => ({ state: 'unsupported', reason: 'No git executable was found on this machine.' }) }),
    );
    expect(selection.activity).toEqual([]);
  });
});
