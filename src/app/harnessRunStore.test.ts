import { describe, expect, it } from 'vitest';
import { appendActivityEvent, createActivityLog } from './harnessActivityLog';
import type { ContradictedFindingRecord } from './harnessAttempt';
import { buildCheckpoint, type CheckpointBuildInput, type PersistedCheckpoint } from './harnessCheckpoint';
import { createHarnessRunStore, type HarnessRunStore, type RetentionPolicy } from './harnessRunStore';
import type { TrackedCandidate, ValidatedFinding, CitedEvidenceRef } from './harnessCandidateValidation';
import type { LedgerEvidenceSource } from './harnessEvidenceLedger';
import type { KeyValueStore } from './storage';
import { sha256Hex } from './contentDigest';
import {
  LEGACY_CHANGESET_DRAFT,
  LEGACY_RETAINED_CLEAN,
  LEGACY_RETAINED_TRIAGE_DRAFT,
  LEGACY_RUN_HISTORY,
} from './migrationFixtures';
import { draftKeyFor, changesetDraftKeyFor } from './retainedReview';
import { readLegacyReview, readLegacyRunHistory } from '../domain/harnessMigration';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

// ---- Test-only backing store: a real JSON round-trip, unlike a plain Map ------------
// `vscode.Memento` actually persists to disk between sessions; a plain in-memory Map
// would let `undefined` fields and non-JSON values survive a "write" silently, which a
// real workspace store never does. Round-tripping through `JSON.stringify`/`.parse`
// here is what makes this suite's "every field survives" claim mean something.

function jsonMemoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => (map.has(key) ? (JSON.parse(JSON.stringify(map.get(key)))) as T : undefined),
    update: async (key, value) => {
      if (value === undefined) {
        map.delete(key);
        return;
      }
      map.set(key, JSON.parse(JSON.stringify(value)));
    },
    keys: () => [...map.keys()],
  };
}

/** Reaches into the backing store directly — for tests that must plant a malformed/corrupt raw value the store's own write path would never itself produce. */
function seedRaw(store: KeyValueStore, key: string, raw: unknown): void {
  void store.update(key, raw);
}

const RUN_ID = 'run-1';

function testSnapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: RUN_ID,
    lineageId: 'lineage-1',
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: 'm1',
        providerId: 'fixture',
        instanceUrl: 'https://example.test',
        ref: { repoId: 'repo-1', number: '42' },
        baseSha: 'base1',
        headSha: 'head1',
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
    effort: 'none',
    effortInstructionDigest: 'digest-effort',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'digest-extra',
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
    ...overrides,
  };
}

const ZERO_BUDGET: BudgetConsumption = { modelTurnsUsed: 2, toolCallsUsed: 4, evidenceBytesUsed: 64, elapsedMs: 500, highRiskReserveUsed: 0, verificationReserveUsed: 0 };
const ZERO_COVERAGE: readonly MemberCoverage[] = [{ memberId: 'm1', manifestComplete: true, totalFiles: 1, files: [] }];

function fakeSource(sourceId: string, exactContent: string, overrides: Partial<LedgerEvidenceSource> = {}): LedgerEvidenceSource {
  return {
    sourceId,
    digest: sha256Hex(exactContent),
    kind: 'diff',
    repositoryId: 'repo-1',
    baseSha: 'base1',
    headSha: 'head1',
    completeness: 'complete',
    citable: true,
    exactContent,
    runId: RUN_ID,
    lineageId: 'lineage-1',
    attempt: 1,
    memberId: 'm1',
    origin: 'diffPage',
    trust: 'untrusted',
    sequence: 1,
    locations: [],
    byteLength: Buffer.byteLength(exactContent, 'utf8'),
    ...overrides,
  };
}

function citedRef(source: LedgerEvidenceSource): CitedEvidenceRef {
  return { sourceId: source.sourceId, digest: source.digest, origin: source.origin, memberId: source.memberId, repositoryId: source.repositoryId, baseSha: source.baseSha, headSha: source.headSha, path: 'file1.ts', range: { startLine: 1, endLine: 1 } };
}

function acceptedCandidate(candidateId: string, primary: LedgerEvidenceSource): TrackedCandidate {
  const finding: ValidatedFinding = {
    candidateId,
    memberId: 'm1',
    routing: 'inline',
    item: { id: candidateId, file: 'file1.ts', anchored: true, line: 1, severity: 'major', category: 'security', confidence: 80, title: 'A finding', body: 'Body.', code: '' },
    provenance: { protocolProvenance: 'harness', citations: [], validatedAt: '2026-01-01T00:00:00.000Z' },
    evidence: { repositoryId: primary.repositoryId, baseSha: primary.baseSha, headSha: primary.headSha, primary: citedRef(primary), supporting: [] },
  };
  return { candidateId, state: 'accepted', repairs: 0, reasons: [], finding };
}

function checkpointInput(overrides: Partial<CheckpointBuildInput> = {}): CheckpointBuildInput {
  return {
    checkpointId: 'ckpt-1',
    runId: RUN_ID,
    lineageId: 'lineage-1',
    attempt: 1,
    phase: 'investigating',
    reason: 'phaseBoundary',
    occurredAt: '2026-01-01T00:00:00.000Z',
    elapsedMs: 1000,
    snapshotDigest: 'snap-digest-1',
    activityEvents: [],
    evidenceSources: [],
    candidates: [],
    contradicted: [],
    budget: ZERO_BUDGET,
    coverage: ZERO_COVERAGE,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    ...overrides,
  };
}

const GENEROUS_RETENTION: RetentionPolicy = {
  retainedCheckpointsPerLineage: 100,
  maxCheckpointBytesPerLineage: 10 * 1024 * 1024,
  terminalAttemptHistoryCount: 100,
  terminalAttemptHistoryMaxAgeDays: 3650,
};

/** A minimal, syntactically-valid checkpoint with a caller-chosen `bytes` value — used by the bounds tests, which need precise control over accounted size without depending on real serialization arithmetic. */
function fakeCheckpoint(overrides: Partial<PersistedCheckpoint> & { checkpointId: string }): PersistedCheckpoint {
  return {
    runId: RUN_ID,
    lineageId: 'lineage-1',
    attempt: 1,
    phase: 'investigating',
    reason: 'phaseBoundary',
    occurredAt: '2026-01-01T00:00:00.000Z',
    elapsedMs: 0,
    snapshotDigest: 'snap-digest-1',
    projection: { runId: RUN_ID, lineageId: 'lineage-1', attempt: 1, lifecycle: 'investigating', completeness: 'none', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
    activity: [],
    evidence: [],
    candidates: [],
    contradicted: [],
    budget: ZERO_BUDGET,
    coverage: ZERO_COVERAGE,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    retry: { waiting: false, transientAttempts: 0 },
    bytes: 10,
    compatible: true,
    incompatibilityReasons: [],
    ...overrides,
  };
}

describe('HarnessRunStore (11.1): a fully populated checkpoint round-trips, digests included', () => {
  it('writeSnapshot + writeCheckpoint, then every field survives a real JSON round-trip', async () => {
    const backing = jsonMemoryStore();
    const runStore = createHarnessRunStore(backing, { now: () => Date.parse('2026-01-01T00:00:00.000Z') });

    const snapshot = testSnapshot();
    const primary = fakeSource('ev_a00000000000000000000000000000', 'exact primary diff bytes');
    const uncited = fakeSource('ev_b00000000000000000000000000000', 'exact bytes nobody cited', { kind: 'searchExcerpt', origin: 'repositorySearch' });
    const candidate = acceptedCandidate('cand-1', primary);

    // A real activity log, built through the production pipeline (not hand-built literals): a
    // plan, a completed tool call, and a failed one — so the store's own `parseActivityEvent` and
    // `parsePlan` are exercised against genuinely valid data, not only against the malformed cases
    // the fail-closed tests below cover.
    let log = createActivityLog(RUN_ID, 'lineage-1', 1);
    log = appendActivityEvent(
      log,
      { kind: 'planCreated', plan: { revision: 1, items: [{ id: 'p1', description: 'Investigate file1.ts.', state: 'active' }] } },
      { occurredAt: '2026-01-01T00:00:00.000Z', phase: 'planning', elapsedMs: 0 },
    );
    log = appendActivityEvent(
      log,
      { kind: 'toolCompleted', tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' },
      { occurredAt: '2026-01-01T00:00:01.000Z', phase: 'investigating', elapsedMs: 1000 },
    );
    log = appendActivityEvent(
      log,
      { kind: 'toolFailed', tool: 'readDiff', target: 'file2.ts', reason: 'The provider returned unavailable.' },
      { occurredAt: '2026-01-01T00:00:02.000Z', phase: 'investigating', elapsedMs: 2000 },
    );
    const contradicted: ContradictedFindingRecord[] = [{ candidateId: 'cand-2', reason: 'The model found the cited evidence does not support this claim.' }];

    const built = buildCheckpoint(
      checkpointInput({ activityEvents: log.events, evidenceSources: [primary, uncited], candidates: [candidate], contradicted }),
      DEFAULT_HARNESS_POLICY,
    );
    expect(built.plan).toBeDefined(); // sanity: the fixture actually produced a plan to round-trip
    expect(built.activity.length).toBeGreaterThanOrEqual(3);
    expect(built.contradicted).toHaveLength(1);

    await runStore.writeSnapshot(snapshot);
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    expect(runStore.readSnapshot('lineage-1', 1)).toEqual(snapshot);
    const readBack = runStore.latestCheckpoint('lineage-1');
    expect(readBack).toBeDefined();
    expect(readBack?.checkpointId).toBe(built.checkpointId);
    // The rich, previously-untested fields: activity, plan, and the recomputed projection.
    expect(readBack?.activity).toEqual(built.activity);
    expect(readBack?.plan).toEqual(built.plan);
    expect(readBack?.projection).toEqual(built.projection);
    expect(readBack?.candidates).toEqual(built.candidates);
    expect(readBack?.contradicted).toEqual(built.contradicted);
    expect(readBack?.budget).toEqual(built.budget);
    expect(readBack?.coverage).toEqual(built.coverage);
    expect(readBack?.retry).toEqual(built.retry);
    expect(readBack?.bytes).toBe(built.bytes);
    expect(readBack?.compatible).toBe(built.compatible);

    // Digests: the cited source's exact content and digest survive byte-identical; the uncited
    // source keeps only metadata and digest.
    const primaryRecord = readBack?.evidence.find((e) => e.sourceId === primary.sourceId);
    const uncitedRecord = readBack?.evidence.find((e) => e.sourceId === uncited.sourceId);
    expect(primaryRecord?.exactContent).toBe(primary.exactContent);
    expect(primaryRecord?.digest).toBe(primary.digest);
    expect(sha256Hex(primaryRecord?.exactContent ?? '')).toBe(primaryRecord?.digest);
    expect(uncitedRecord?.exactContent).toBeUndefined();
    expect(uncitedRecord?.digest).toBe(uncited.digest);

    expect(runStore.lineageIdsForRun(RUN_ID)).toEqual(['lineage-1']);
    expect(runStore.checkpointsFor('lineage-1', 1)).toHaveLength(1);
    expect(runStore.checkpointsFor('lineage-1')).toHaveLength(1);
  });

  it('a member-scoped plan item\'s memberId survives a real JSON checkpoint round-trip, and a shared item stays without one (task 13.3)', async () => {
    const backing = jsonMemoryStore();
    const runStore = createHarnessRunStore(backing, { now: () => Date.parse('2026-01-01T00:00:00.000Z') });

    let log = createActivityLog(RUN_ID, 'lineage-1', 1);
    log = appendActivityEvent(
      log,
      {
        kind: 'planCreated',
        plan: {
          revision: 1,
          items: [
            { id: 'core-1', description: 'Inspect authorization changes.', state: 'active', memberId: 'core' },
            { id: 'shared-1', description: 'Confirm the billing schema matches core.', state: 'pending' },
          ],
        },
      },
      { occurredAt: '2026-01-01T00:00:00.000Z', phase: 'planning', elapsedMs: 0 },
    );

    const built = buildCheckpoint(checkpointInput({ activityEvents: log.events }), DEFAULT_HARNESS_POLICY);
    await runStore.writeSnapshot(testSnapshot());
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    const readBack = runStore.latestCheckpoint('lineage-1');
    expect(readBack?.plan?.items[0]).toEqual({ id: 'core-1', description: 'Inspect authorization changes.', state: 'active', memberId: 'core' });
    expect(readBack?.plan?.items[1]).not.toHaveProperty('memberId');
  });

  it('writeCheckpoint is idempotent by checkpointId: writing the same checkpoint twice does not duplicate it', async () => {
    const backing = jsonMemoryStore();
    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    const built = buildCheckpoint(checkpointInput(), DEFAULT_HARNESS_POLICY);

    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    expect(runStore.checkpointsFor('lineage-1')).toHaveLength(1);
  });

  it('reading an unknown lineage returns undefined, never fabricated data', () => {
    const runStore = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    expect(runStore.readLineage('never-written')).toBeUndefined();
    expect(runStore.readSnapshot('never-written', 1)).toBeUndefined();
    expect(runStore.checkpointsFor('never-written')).toEqual([]);
    expect(runStore.latestCheckpoint('never-written')).toBeUndefined();
  });
});

describe('HarnessRunStore (11.2): the marker test at the actual persistence boundary', () => {
  it('scans every key the backing store actually holds after writeSnapshot + writeCheckpoint — no planted marker survives outside the one deliberate exception', async () => {
    const backing = jsonMemoryStore();
    const runStore = createHarnessRunStore(backing, { now: () => 0 });

    const SECRET_MARKER = 'MARKER_SECRET_store_9f3e7a2c';
    const PROMPT_MARKER = 'MARKER_RAW_PROMPT_store_7f3a2b1c';
    const UNCITED_MARKER = 'MARKER_UNCITED_EVIDENCE_store_ab12cd';
    const CITED_MARKER = 'MARKER_CITED_EVIDENCE_store_should_survive_77aa';

    let log = createActivityLog(RUN_ID, 'lineage-1', 1);
    log = appendActivityEvent(
      log,
      { kind: 'toolFailed', tool: 'readDiff', target: 'file1.ts', reason: `Bearer sk-live-${SECRET_MARKER}1234567890` },
      { occurredAt: '2026-01-01T00:00:00.000Z', phase: 'investigating', elapsedMs: 0 },
    );
    log = appendActivityEvent(
      log,
      { kind: 'toolFailed', tool: 'modelTurn', reason: `${'System prompt leaking: '.repeat(20)}${PROMPT_MARKER}` },
      { occurredAt: '2026-01-01T00:00:01.000Z', phase: 'investigating', elapsedMs: 1 },
    );

    const uncited = fakeSource('ev_x00000000000000000000000000000', `full tool-output text containing ${UNCITED_MARKER}`, { kind: 'searchExcerpt', origin: 'repositorySearch' });
    const cited = fakeSource('ev_y00000000000000000000000000000', `exact diff bytes containing ${CITED_MARKER}`);
    const candidate = acceptedCandidate('cand-1', cited);

    const built = buildCheckpoint(
      checkpointInput({ activityEvents: log.events, evidenceSources: [uncited, cited], candidates: [candidate] }),
      DEFAULT_HARNESS_POLICY,
    );

    await runStore.writeSnapshot(testSnapshot());
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    // Walk *everything* actually held by the backing store — the lineage record, the run index,
    // and any legacy keys that might coexist — not just the one checkpoint object built above.
    const everything = (backing.keys?.() ?? []).map((key) => backing.get(key)).map((value) => JSON.stringify(value)).join('\n');

    expect(everything).not.toContain('sk-live-');
    expect(everything).not.toContain(SECRET_MARKER);
    expect(everything).not.toContain(PROMPT_MARKER);
    expect(everything).not.toContain(UNCITED_MARKER);
    // The one deliberate exception actually happened at the persistence boundary too.
    expect(everything).toContain(CITED_MARKER);
  });
});

describe('HarnessRunStore (11.4): each HarnessPolicy bound triggers eviction at its limit and not before', () => {
  async function writeN(runStore: HarnessRunStore, n: number, bytesEach: number, policy: RetentionPolicy): Promise<void> {
    for (let i = 1; i <= n; i += 1) {
      await runStore.writeCheckpoint(
        fakeCheckpoint({ checkpointId: `ckpt-${i}`, occurredAt: `2026-01-01T00:00:0${i}.000Z`, elapsedMs: i, bytes: bytesEach }),
        policy,
      );
    }
  }

  it('retainedCheckpointsPerLineage: exactly at the limit nothing is evicted; one past it, the oldest is dropped', async () => {
    const policy: RetentionPolicy = { ...GENEROUS_RETENTION, retainedCheckpointsPerLineage: 2 };
    const atLimit = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    await writeN(atLimit, 2, 10, policy);
    expect(atLimit.checkpointsFor('lineage-1').map((c) => c.checkpointId)).toEqual(['ckpt-1', 'ckpt-2']);

    const overLimit = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    await writeN(overLimit, 3, 10, policy);
    const remaining = overLimit.checkpointsFor('lineage-1').map((c) => c.checkpointId);
    expect(remaining).toEqual(['ckpt-2', 'ckpt-3']); // ckpt-1 (oldest) evicted
  });

  it('maxCheckpointBytesPerLineage: aggregate at the bound survives; one checkpoint past it evicts the oldest whole checkpoint', async () => {
    const policy: RetentionPolicy = { ...GENEROUS_RETENTION, retainedCheckpointsPerLineage: 100, maxCheckpointBytesPerLineage: 900 };
    const atLimit = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    await writeN(atLimit, 3, 300, policy); // 900 total, exactly at the bound
    expect(atLimit.checkpointsFor('lineage-1')).toHaveLength(3);

    const overLimit = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    await writeN(overLimit, 3, 400, policy); // 1200 total; evict oldest (400) -> 800, under 900
    const remaining = overLimit.checkpointsFor('lineage-1').map((c) => c.checkpointId);
    expect(remaining).toEqual(['ckpt-2', 'ckpt-3']);
  });

  it('a single checkpoint that alone exceeds the per-lineage byte bound is marked incompatible rather than stripped or dropped', async () => {
    const policy: RetentionPolicy = { ...GENEROUS_RETENTION, maxCheckpointBytesPerLineage: 500 };
    const runStore = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    await runStore.writeCheckpoint(fakeCheckpoint({ checkpointId: 'ckpt-huge', bytes: 5000 }), policy);

    const stored = runStore.latestCheckpoint('lineage-1');
    expect(stored).toBeDefined();
    // Still there — evicting it entirely would be a silent loss, not a truthful incompatibility.
    expect(stored?.checkpointId).toBe('ckpt-huge');
    expect(stored?.compatible).toBe(false);
    expect(stored?.incompatibilityReasons.length).toBeGreaterThan(0);
  });

  it('terminalAttemptHistoryCount is enforced per target (runId), across every lineage under it: the oldest terminal attempt is dropped once a newer one exceeds the count', async () => {
    const policy: RetentionPolicy = { ...GENEROUS_RETENTION, terminalAttemptHistoryCount: 1 };
    const runStore = createHarnessRunStore(jsonMemoryStore(), { now: () => Date.parse('2026-01-02T00:00:00.000Z') });

    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-a', attempt: 1 }));
    await runStore.writeCheckpoint(
      fakeCheckpoint({
        checkpointId: 'ckpt-a',
        lineageId: 'lineage-a',
        occurredAt: '2026-01-01T00:00:00.000Z',
        projection: { runId: RUN_ID, lineageId: 'lineage-a', attempt: 1, lifecycle: 'succeeded', completeness: 'complete', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
      }),
      policy,
    );

    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-b', attempt: 1 }));
    await runStore.writeCheckpoint(
      fakeCheckpoint({
        checkpointId: 'ckpt-b',
        lineageId: 'lineage-b',
        occurredAt: '2026-01-01T12:00:00.000Z',
        projection: { runId: RUN_ID, lineageId: 'lineage-b', attempt: 1, lifecycle: 'succeeded', completeness: 'complete', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
      }),
      policy,
    );

    // Lineage A's terminal attempt is older than lineage B's, and only 1 terminal attempt is kept
    // per target — A's checkpoint data and snapshot are gone; B's survive.
    expect(runStore.checkpointsFor('lineage-a')).toEqual([]);
    expect(runStore.readSnapshot('lineage-a', 1)).toBeUndefined();
    expect(runStore.checkpointsFor('lineage-b')).toHaveLength(1);
    expect(runStore.readSnapshot('lineage-b', 1)).toBeDefined();
  });

  it('terminalAttemptHistoryMaxAgeDays evicts using the injected clock: an attempt older than the window is dropped even under the count bound', async () => {
    const policy: RetentionPolicy = { ...GENEROUS_RETENTION, terminalAttemptHistoryCount: 10, terminalAttemptHistoryMaxAgeDays: 1 };
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const runStore = createHarnessRunStore(jsonMemoryStore(), { now: () => nowMs });

    await runStore.writeCheckpoint(
      fakeCheckpoint({
        checkpointId: 'ckpt-old',
        occurredAt: new Date(nowMs).toISOString(),
        projection: { runId: RUN_ID, lineageId: 'lineage-1', attempt: 1, lifecycle: 'succeeded', completeness: 'complete', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
      }),
      policy,
    );
    expect(runStore.checkpointsFor('lineage-1')).toHaveLength(1); // not yet stale relative to itself

    // Advance the clock 3 days and record a second, unrelated terminal attempt (a resumed lineage
    // under the same target) — this is what triggers re-evaluation of the age bound.
    nowMs += 3 * 24 * 60 * 60 * 1000;
    await runStore.writeCheckpoint(
      fakeCheckpoint({
        checkpointId: 'ckpt-new',
        lineageId: 'lineage-2',
        attempt: 1,
        occurredAt: new Date(nowMs).toISOString(),
        projection: { runId: RUN_ID, lineageId: 'lineage-2', attempt: 1, lifecycle: 'succeeded', completeness: 'complete', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
      }),
      policy,
    );

    expect(runStore.checkpointsFor('lineage-1')).toEqual([]); // aged out
    expect(runStore.checkpointsFor('lineage-2')).toHaveLength(1); // recent, survives
  });
});

describe('HarnessRunStore (11.1/11.8): truncated, malformed, wrong-typed, and unknown-enum persisted blobs all fail closed on read', () => {
  const validLineage = () => ({
    schemaVersion: '1',
    runId: RUN_ID,
    lineageId: 'lineage-1',
    snapshots: {},
    checkpoints: [
      {
        checkpointId: 'ckpt-1',
        runId: RUN_ID,
        lineageId: 'lineage-1',
        attempt: 1,
        phase: 'investigating',
        reason: 'phaseBoundary',
        occurredAt: '2026-01-01T00:00:00.000Z',
        elapsedMs: 0,
        snapshotDigest: 'digest',
        projection: { runId: RUN_ID, lineageId: 'lineage-1', attempt: 1, lifecycle: 'investigating', completeness: 'none', elapsedMs: 0, progressMode: 'indeterminate', attention: 'none', limitations: [] },
        activity: [],
        evidence: [],
        candidates: [],
        contradicted: [],
        budget: ZERO_BUDGET,
        coverage: [],
        unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
        retry: { waiting: false, transientAttempts: 0 },
        bytes: 10,
        compatible: true,
        incompatibilityReasons: [],
      },
    ],
    terminalAttempts: [],
  });

  it.each([
    // unknown-enum: a recognized-shape field carrying a value outside its own enum.
    ['unknown checkpoint phase', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as { phase: string }).phase = 'reasoning'; }],
    ['unknown checkpoint reason', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as { reason: string }).reason = 'becauseISaidSo'; }],
    ['unknown projection lifecycle', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as { projection: { lifecycle: string } }).projection.lifecycle = 'executing'; }],
    ['unknown projection completeness', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as { projection: { completeness: string } }).projection.completeness = 'done'; }],
    // wrong-typed: a required field present, but as the wrong primitive type.
    ['wrong-typed: checkpointId is a number', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as unknown as Record<string, unknown>).checkpointId = 42; }],
    ['wrong-typed: elapsedMs is a string', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as unknown as Record<string, unknown>).elapsedMs = '1000'; }],
    ['wrong-typed: compatible is a string, not a boolean', (r: ReturnType<typeof validLineage>) => { (r.checkpoints[0] as unknown as Record<string, unknown>).compatible = 'true'; }],
    // truncated: a required field missing entirely, as a byte-cut-short blob would produce.
    ['truncated: checkpoint missing its budget field', (r: ReturnType<typeof validLineage>) => { delete (r.checkpoints[0] as unknown as Record<string, unknown>).budget; }],
    ['truncated: checkpoint missing its retry field', (r: ReturnType<typeof validLineage>) => { delete (r.checkpoints[0] as unknown as Record<string, unknown>).retry; }],
    ['truncated: lineage record missing its terminalAttempts field', (r: ReturnType<typeof validLineage>) => { delete (r as unknown as Record<string, unknown>).terminalAttempts; }],
    // malformed: a field present with a value of the wrong overall shape (not an array where one is required).
    ['malformed: checkpoints is not an array', (r: ReturnType<typeof validLineage>) => { (r as unknown as Record<string, unknown>).checkpoints = 'not-an-array'; }],
  ])('%s makes the whole lineage record fail closed (undefined), not partially trusted', async (_label, corrupt) => {
    const backing = jsonMemoryStore();
    const record = validLineage();
    corrupt(record);
    seedRaw(backing, 'codeVerdict.harness.lineage.lineage-1', record);

    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    expect(runStore.readLineage('lineage-1')).toBeUndefined();
    expect(runStore.checkpointsFor('lineage-1')).toEqual([]);
  });

  it('an unknown evidence kind fails the whole record closed', async () => {
    const backing = jsonMemoryStore();
    const record = validLineage();
    (record.checkpoints[0] as { evidence: unknown[] }).evidence = [{ sourceId: 'ev_x', digest: 'd', kind: 'transcript', origin: 'diffPage', memberId: 'm1', repositoryId: 'repo-1', baseSha: 'b', headSha: 'h', completeness: 'complete', locations: [], fetchedInAttempt: 1 }];
    seedRaw(backing, 'codeVerdict.harness.lineage.lineage-1', record);

    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    expect(runStore.readLineage('lineage-1')).toBeUndefined();
  });

  it('an unknown candidate tracker state fails the whole record closed', async () => {
    const backing = jsonMemoryStore();
    const record = validLineage();
    (record.checkpoints[0] as { candidates: unknown[] }).candidates = [{ candidateId: 'cand-1', state: 'pondering', repairs: 0, reasons: [] }];
    seedRaw(backing, 'codeVerdict.harness.lineage.lineage-1', record);

    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    expect(runStore.readLineage('lineage-1')).toBeUndefined();
  });

  it('an unrecognized activity event kind fails the whole record closed', async () => {
    const backing = jsonMemoryStore();
    const record = validLineage();
    (record.checkpoints[0] as { activity: unknown[] }).activity = [
      { runId: RUN_ID, lineageId: 'lineage-1', attempt: 1, sequence: 1, occurredAt: '2026-01-01T00:00:00.000Z', phase: 'investigating', elapsedMs: 0, kind: 'thoughtStream' },
    ];
    seedRaw(backing, 'codeVerdict.harness.lineage.lineage-1', record);

    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    expect(runStore.readLineage('lineage-1')).toBeUndefined();
  });

  it('a malformed run index (not an array of strings) fails closed to an empty lineage list, not a thrown error', () => {
    const backing = jsonMemoryStore();
    seedRaw(backing, 'codeVerdict.harness.run.run-1', { schemaVersion: '1', runId: 'run-1', lineageIds: [42, null] });
    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    expect(runStore.lineageIdsForRun('run-1')).toEqual([]);
  });
});

describe('HarnessRunStore (11.1): coexists with legacy persisted shapes without touching or fabricating over them', () => {
  it('legacy run-history and retained-draft keys survive untouched alongside harness writes in the same store', async () => {
    const backing = jsonMemoryStore();
    await backing.update('codeVerdict.reviewRuns', LEGACY_RUN_HISTORY);
    const draftKey = draftKeyFor({ repoId: 'repo-1', number: '2841' });
    await backing.update(draftKey, LEGACY_RETAINED_TRIAGE_DRAFT);
    const cleanKey = draftKeyFor({ repoId: 'repo-1', number: '2842' });
    await backing.update(cleanKey, LEGACY_RETAINED_CLEAN);
    const changesetKey = changesetDraftKeyFor('cs-legacy-1');
    await backing.update(changesetKey, LEGACY_CHANGESET_DRAFT);

    const runStore = createHarnessRunStore(backing, { now: () => 0 });
    await runStore.writeSnapshot(testSnapshot());
    await runStore.writeCheckpoint(buildCheckpoint(checkpointInput(), DEFAULT_HARNESS_POLICY), GENEROUS_RETENTION);

    // Legacy keys are byte-identical to what was written — the harness store never reads or
    // rewrites anything outside its own `codeVerdict.harness.*` namespace.
    expect(backing.get('codeVerdict.reviewRuns')).toEqual(LEGACY_RUN_HISTORY);
    expect(backing.get(draftKey)).toEqual(LEGACY_RETAINED_TRIAGE_DRAFT);
    expect(backing.get(cleanKey)).toEqual(LEGACY_RETAINED_CLEAN);
    expect(backing.get(changesetKey)).toEqual(LEGACY_CHANGESET_DRAFT);

    // A target that only has legacy data (no harness lineage was ever written for it) reads as
    // absent, never fabricated as an empty-but-present harness record.
    expect(runStore.readLineage('some-legacy-only-target')).toBeUndefined();

    // The existing legacy-read functions (task 2.7) still read these fixtures the same way,
    // proving co-existence rather than replacement: no plan/evidence/coverage is invented for them.
    const legacyRead = readLegacyReview(LEGACY_RETAINED_TRIAGE_DRAFT.review);
    expect(legacyRead.protocolProvenance).toBe('legacy-one-shot');
    expect(Object.keys(legacyRead).sort()).toEqual(['completeness', 'crNumber', 'protocolProvenance', 'repoId'].sort());
    const findingsRun = LEGACY_RUN_HISTORY.find((run) => run.outcome === 'findings')!;
    expect(readLegacyRunHistory(findingsRun)).toEqual({ completeness: 'complete', protocolProvenance: 'legacy-one-shot' });
  });
});

describe('HarnessRunStore: determinism', () => {
  it('never reads a wall clock itself — two stores given the same injected now() behave identically regardless of real time', async () => {
    const fixedNow = () => 12345;
    const storeA = createHarnessRunStore(jsonMemoryStore(), { now: fixedNow });
    const storeB = createHarnessRunStore(jsonMemoryStore(), { now: fixedNow });
    const built = buildCheckpoint(checkpointInput(), DEFAULT_HARNESS_POLICY);
    await storeA.writeCheckpoint(built, GENEROUS_RETENTION);
    await storeB.writeCheckpoint(built, GENEROUS_RETENTION);
    expect(storeA.latestCheckpoint('lineage-1')).toEqual(storeB.latestCheckpoint('lineage-1'));
  });
});

// Keeps `HarnessPolicy`/`normalizeHarnessPolicy` imports meaningful (a real caller resolves
// `RetentionPolicy` from a full policy, never hand-assembles the four fields as this file's other
// tests do for precise control) — proves the slice type is satisfied by a real normalized policy.
describe('RetentionPolicy is satisfied by a real, normalized HarnessPolicy', () => {
  it('a HarnessPolicy value can be passed directly to writeCheckpoint without adaptation', async () => {
    const policy: HarnessPolicy = normalizeHarnessPolicy({ retainedCheckpointsPerLineage: 2, maxCheckpointBytesPerLineage: 1024 });
    const runStore = createHarnessRunStore(jsonMemoryStore(), { now: () => 0 });
    const built = buildCheckpoint(checkpointInput(), policy);
    await runStore.writeCheckpoint(built, policy);
    expect(runStore.checkpointsFor('lineage-1')).toHaveLength(1);
  });
});
