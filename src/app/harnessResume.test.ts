import { describe, expect, it } from 'vitest';
import { canonicalStringify, sha256Hex } from './contentDigest';
import { computeSnapshotDigest, INITIAL_RETRY_STATE, type PersistedCheckpoint } from './harnessCheckpoint';
import { createEvidenceLedger, toRetainedEvidenceRecord, type LedgerEvidenceSource, type EvidenceLedgerMember } from './harnessEvidenceLedger';
import { appendActivityEvent, createActivityLog } from './harnessActivityLog';
import { createHarnessRunStore } from './harnessRunStore';
import type { TrackedCandidate, ValidatedFinding, CitedEvidenceRef } from './harnessCandidateValidation';
import {
  buildResumePayload,
  checkCheckpointIntegrity,
  checkSnapshotCompatibility,
  closeAttemptAsInterrupted,
  computeInterruptedCompleteness,
  decideResume,
  describeResumeStart,
  evaluateResumeCompatibility,
  importRetainedEvidence,
  interruptedLimitation,
  nextAttemptNumber,
  ResumeIncompatibleError,
  type ResumeIncompatibilityCode,
} from './harnessResume';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

// ---- Fixtures -------------------------------------------------------------------------

const RUN_ID = 'run-1';
const LINEAGE_ID = 'lineage-1';

function testSnapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: RUN_ID,
    lineageId: LINEAGE_ID,
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
        context: {
          autoContextEnabled: true,
          titleIncluded: true,
          descriptionIncluded: true,
          linkedItemIdsIncluded: ['10', '11'],
          attachments: [{ attachmentId: 'att-1', label: 'schema.ts', contentDigest: 'digest-att-1' }],
        },
      },
    ],
    agentId: 'built-in',
    agentInstructions: 'Review the change carefully.',
    agentInstructionsDigest: 'digest-instructions',
    personaLabel: 'Built-in reviewer',
    modelId: 'test-model',
    modelCapability: { vendor: 'acme', family: 'turbo', maxInputTokens: 100_000 },
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
    lineageId: LINEAGE_ID,
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

function testCheckpoint(snapshot: ReviewRunSnapshot, overrides: Partial<PersistedCheckpoint> = {}): PersistedCheckpoint {
  const base: Omit<PersistedCheckpoint, 'bytes'> = {
    checkpointId: 'ckpt-1',
    runId: snapshot.runId,
    lineageId: snapshot.lineageId,
    attempt: snapshot.attempt,
    phase: 'investigating',
    reason: 'phaseBoundary',
    occurredAt: '2026-01-01T00:10:00.000Z',
    elapsedMs: 1000,
    snapshotDigest: computeSnapshotDigest(snapshot),
    projection: {
      runId: snapshot.runId,
      lineageId: snapshot.lineageId,
      attempt: snapshot.attempt,
      lifecycle: 'investigating',
      completeness: 'none',
      elapsedMs: 1000,
      progressMode: 'indeterminate',
      attention: 'none',
      limitations: [],
    },
    activity: [],
    evidence: [],
    candidates: [],
    contradicted: [],
    budget: ZERO_BUDGET,
    coverage: ZERO_COVERAGE,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    retry: INITIAL_RETRY_STATE,
    compatible: true,
    incompatibilityReasons: [],
  };
  const merged = { ...base, ...overrides };
  return { ...merged, bytes: 10 };
}

// ---- checkCheckpointIntegrity -----------------------------------------------------------

describe('checkCheckpointIntegrity (11.5: versions, digests)', () => {
  it('a checkpoint whose lineage/attempt/digest match the snapshot has no reasons', () => {
    const snapshot = testSnapshot();
    const checkpoint = testCheckpoint(snapshot);
    expect(checkCheckpointIntegrity(snapshot, checkpoint)).toEqual([]);
  });

  it('a checkpoint whose snapshot digest no longer verifies is reported', () => {
    const snapshot = testSnapshot();
    const checkpoint = testCheckpoint(snapshot, { snapshotDigest: 'stale-digest' });
    const reasons = checkCheckpointIntegrity(snapshot, checkpoint);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]?.code).toBe('checkpointIntegrity');
    expect(reasons[0]?.message).toMatch(/digest/i);
  });

  it('a checkpoint pinned to a different lineage or attempt than the snapshot is reported', () => {
    const snapshot = testSnapshot();
    const checkpoint = testCheckpoint(snapshot, { attempt: 2, snapshotDigest: computeSnapshotDigest(snapshot) });
    const reasons = checkCheckpointIntegrity(snapshot, checkpoint);
    expect(reasons.some((r) => r.code === 'checkpointIntegrity')).toBe(true);
  });

  it('a checkpoint the store already marked incompatible (11.4 retention) folds its own reasons in, verbatim', () => {
    const snapshot = testSnapshot();
    const checkpoint = testCheckpoint(snapshot, { compatible: false, incompatibilityReasons: ['This checkpoint alone is 999999 bytes, exceeding the per-lineage bound.'] });
    const reasons = checkCheckpointIntegrity(snapshot, checkpoint);
    expect(reasons.some((r) => r.code === 'checkpointIntegrity' && r.message.includes('exceeding the per-lineage bound'))).toBe(true);
  });
});

// ---- checkSnapshotCompatibility: every dimension separately (11.5) ------------------

describe('checkSnapshotCompatibility (11.5): each incompatibility dimension separately', () => {
  const stored = testSnapshot();

  it.each<[string, ResumeIncompatibilityCode, (s: ReviewRunSnapshot) => ReviewRunSnapshot]>([
    ['schema version changed', 'schemaVersion', (s) => ({ ...s, schemaVersion: '2' })],
    ['tool contract version changed', 'toolContractVersion', (s) => ({ ...s, toolContractVersion: 'v2' })],
    ['harness policy version changed', 'harnessPolicyVersion', (s) => ({ ...s, harnessPolicyVersion: '2' })],
    ['provider id changed', 'repositoryIdentity', (s) => ({ ...s, members: [{ ...s.members[0]!, providerId: 'other-provider' }] })],
    ['repository id changed', 'repositoryIdentity', (s) => ({ ...s, members: [{ ...s.members[0]!, ref: { ...s.members[0]!.ref, repoId: 'repo-2' } }] })],
    ['base SHA changed', 'headRevision', (s) => ({ ...s, members: [{ ...s.members[0]!, baseSha: 'base2' }] })],
    ['head SHA changed', 'headRevision', (s) => ({ ...s, members: [{ ...s.members[0]!, headSha: 'head2' }] })],
    ['agent id changed', 'agentInstructions', (s) => ({ ...s, agentId: 'other-agent' })],
    ['agentInstructionsDigest changed', 'agentInstructions', (s) => ({ ...s, agentInstructionsDigest: 'digest-2' })],
    ['persona changed', 'persona', (s) => ({ ...s, personaLabel: 'Other persona' })],
    ['model id changed', 'model', (s) => ({ ...s, modelId: 'other-model' })],
    ['model capability changed', 'model', (s) => ({ ...s, modelCapability: { vendor: 'acme', family: 'other', maxInputTokens: 1 } })],
    ['effort changed', 'effort', (s) => ({ ...s, effort: 'low' })],
    ['effortInstructionDigest changed', 'effort', (s) => ({ ...s, effortInstructionDigest: 'digest-2' })],
    ['criteria changed', 'criteria', (s) => ({ ...s, criteria: { ...s.criteria, severityFloor: 'blocker' } })],
    ['extraInstructionsDigest changed', 'extraInstructions', (s) => ({ ...s, extraInstructionsDigest: 'digest-2' })],
    ['context selection changed', 'contextSelections', (s) => ({ ...s, members: [{ ...s.members[0]!, context: { ...s.members[0]!.context, titleIncluded: false } }] })],
    ['attachment content digest changed', 'attachmentDigests', (s) => ({ ...s, members: [{ ...s.members[0]!, context: { ...s.members[0]!.context, attachments: [{ attachmentId: 'att-1', label: 'schema.ts', contentDigest: 'digest-changed' }] } }] })],
    ['providerCapabilitySignature changed', 'providerCapabilitySignature', (s) => ({ ...s, members: [{ ...s.members[0]!, providerCapabilitySignature: 'sig-2' }] })],
    ['lineageId changed', 'lineageIdentity', (s) => ({ ...s, lineageId: 'lineage-other' })],
    ['runId changed', 'lineageIdentity', (s) => ({ ...s, runId: 'run-other' })],
  ])('%s -> code %s, and only that code', (_label, expectedCode, mutate) => {
    const candidate = mutate(testSnapshot());
    const reasons = checkSnapshotCompatibility(stored, candidate);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.every((r) => r.code === expectedCode)).toBe(true);
  });

  it('two members, both heads changed, produce two separate headRevision reasons', () => {
    const twoMemberStored = testSnapshot({
      members: [
        { ...testSnapshot().members[0]!, memberId: 'm1' },
        { ...testSnapshot().members[0]!, memberId: 'm2', ref: { repoId: 'repo-2', number: '7' } },
      ],
    });
    const twoMemberCandidate = testSnapshot({
      members: [
        { ...testSnapshot().members[0]!, memberId: 'm1', headSha: 'head-changed-1' },
        { ...testSnapshot().members[0]!, memberId: 'm2', ref: { repoId: 'repo-2', number: '7' }, headSha: 'head-changed-2' },
      ],
    });
    const reasons = checkSnapshotCompatibility(twoMemberStored, twoMemberCandidate);
    const headReasons = reasons.filter((r) => r.code === 'headRevision');
    expect(headReasons).toHaveLength(2);
    expect(headReasons.some((r) => r.message.includes('m1'))).toBe(true);
    expect(headReasons.some((r) => r.message.includes('m2'))).toBe(true);
  });

  it('member set changed (added/removed) is reported as repositoryIdentity, not a per-member dimension', () => {
    const candidate = testSnapshot({ members: [testSnapshot().members[0]!, { ...testSnapshot().members[0]!, memberId: 'm2' }] });
    const reasons = checkSnapshotCompatibility(stored, candidate);
    expect(reasons.some((r) => r.code === 'repositoryIdentity')).toBe(true);
  });

  it('target kind or changeset identity changing is reported as repositoryIdentity', () => {
    const candidate = testSnapshot({ targetKind: 'changeset', changesetId: 'cs-1' });
    const reasons = checkSnapshotCompatibility(stored, candidate);
    expect(reasons.some((r) => r.code === 'repositoryIdentity')).toBe(true);
  });

  it('multiple dimensions changed at once: every failing dimension is reported, not just the first (11.7)', () => {
    const candidate = testSnapshot({
      toolContractVersion: 'v2',
      effort: 'low',
      personaLabel: 'Other persona',
      members: [{ ...testSnapshot().members[0]!, headSha: 'head-changed' }],
    });
    const reasons = checkSnapshotCompatibility(stored, candidate);
    const codes = new Set(reasons.map((r) => r.code));
    expect(codes.has('toolContractVersion')).toBe(true);
    expect(codes.has('effort')).toBe(true);
    expect(codes.has('persona')).toBe(true);
    expect(codes.has('headRevision')).toBe(true);
    expect(codes.size).toBeGreaterThanOrEqual(4);
  });

  it('an identical candidate snapshot (only attempt/createdAt differ) has no reasons at all', () => {
    const candidate = testSnapshot({ attempt: 2, createdAt: '2026-01-02T00:00:00.000Z' });
    expect(checkSnapshotCompatibility(stored, candidate)).toEqual([]);
  });
});

// ---- evaluateResumeCompatibility / decideResume: compatible resume (11.6) ------------

describe('evaluateResumeCompatibility / decideResume (11.6): compatible resume', () => {
  it('an unchanged world and an intact checkpoint resume compatibly, as a new attempt in the same lineage', () => {
    const stored = testSnapshot();
    const checkpoint = testCheckpoint(stored);
    const candidate = testSnapshot({ attempt: 2, createdAt: '2026-01-02T00:00:00.000Z' });
    const result = evaluateResumeCompatibility({ storedSnapshot: stored, checkpoint, candidateSnapshot: candidate });
    expect(result).toEqual({ compatible: true, reasons: [] });

    const decision = decideResume({ storedSnapshot: stored, checkpoint, candidateSnapshot: candidate });
    expect(decision.kind).toBe('compatible');
    if (decision.kind === 'compatible') {
      expect(decision.payload.priorAttempt).toBe(1);
      expect(decision.payload.newAttempt).toBe(2);
    }
  });

  it('nextAttemptNumber always increments within the same lineage', () => {
    expect(nextAttemptNumber(1)).toBe(2);
    expect(nextAttemptNumber(7)).toBe(8);
  });
});

// ---- Reject incompatible resume with all reasons and offer a fresh restart (11.7) ---

describe('decideResume (11.7): reject incompatible resume with all reasons', () => {
  it('an incompatible resume reports every reason, never just the first', () => {
    const stored = testSnapshot();
    const checkpoint = testCheckpoint(stored);
    const candidate = testSnapshot({ toolContractVersion: 'v2', effort: 'low', attempt: 2 });
    const decision = decideResume({ storedSnapshot: stored, checkpoint, candidateSnapshot: candidate });
    expect(decision.kind).toBe('incompatible');
    if (decision.kind === 'incompatible') {
      const codes = new Set(decision.reasons.map((r) => r.code));
      expect(codes.has('toolContractVersion')).toBe(true);
      expect(codes.has('effort')).toBe(true);
    }
  });

  it('checkpoint-integrity reasons and snapshot-compatibility reasons both concatenate into one list — neither half stops at its own first failure or hides the other', () => {
    const stored = testSnapshot();
    const checkpoint = testCheckpoint(stored, { snapshotDigest: 'stale-digest' }); // checkpoint integrity fails
    const candidate = testSnapshot({ effort: 'low', attempt: 2 }); // snapshot compatibility also fails
    const decision = decideResume({ storedSnapshot: stored, checkpoint, candidateSnapshot: candidate });
    expect(decision.kind).toBe('incompatible');
    if (decision.kind === 'incompatible') {
      const codes = new Set(decision.reasons.map((r) => r.code));
      expect(codes.has('checkpointIntegrity')).toBe(true);
      expect(codes.has('effort')).toBe(true);
    }
  });
});

// ---- Restart: a fresh restart never mixes revisions, attempts, or evidence (11.7) ---

describe('restart (11.7): a fresh restart never mixes revisions, attempts, or evidence', () => {
  it('a new lineage created for a fresh restart starts empty; the old lineage remains intact under its own key', async () => {
    const map = new Map<string, unknown>();
    const backing = {
      get: <T,>(key: string) => (map.has(key) ? (JSON.parse(JSON.stringify(map.get(key))) as T) : undefined),
      update: async (key: string, value: unknown) => {
        map.set(key, JSON.parse(JSON.stringify(value)));
      },
    };
    const store = createHarnessRunStore(backing, { now: () => 0 });

    const oldSnapshot = testSnapshot();
    await store.writeSnapshot(oldSnapshot);
    await store.writeCheckpoint(testCheckpoint(oldSnapshot), {
      retainedCheckpointsPerLineage: 10,
      maxCheckpointBytesPerLineage: 1_000_000,
      terminalAttemptHistoryCount: 10,
      terminalAttemptHistoryMaxAgeDays: 3650,
    });

    // A fresh restart: a brand new lineageId, attempt 1 — nothing here reuses `oldSnapshot`'s
    // lineage, evidence, candidates, or coverage. Structurally, `readLineage` for the new lineage
    // has nothing until this fresh snapshot is written to it.
    const freshLineageId = 'lineage-fresh-1';
    expect(store.readLineage(freshLineageId)).toBeUndefined();
    const freshSnapshot = testSnapshot({ lineageId: freshLineageId, attempt: 1 });
    await store.writeSnapshot(freshSnapshot);

    const freshRecord = store.readLineage(freshLineageId);
    expect(freshRecord?.checkpoints).toEqual([]);
    expect(Object.keys(freshRecord?.snapshots ?? {})).toEqual(['1']);

    // The old lineage's checkpoint/evidence are untouched by the fresh restart.
    const oldRecord = store.readLineage(LINEAGE_ID);
    expect(oldRecord?.checkpoints).toHaveLength(1);
  });
});

// ---- Interrupting the lost attempt (11.6, D13) ---------------------------------------

describe('closeAttemptAsInterrupted / computeInterruptedCompleteness (11.6, restart)', () => {
  it('computes partial when a validated finding survives, none otherwise', () => {
    const source = fakeSource('ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'exact diff bytes');
    expect(computeInterruptedCompleteness([acceptedCandidate('c1', source)])).toBe('partial');
    expect(computeInterruptedCompleteness([{ candidateId: 'c2', state: 'unresolved', repairs: 0, reasons: [] }])).toBe('none');
    expect(computeInterruptedCompleteness([])).toBe('none');
  });

  it('closes a nonterminal checkpoint as interrupted, appending exactly one terminalResult event with the right completeness and phase', () => {
    const snapshot = testSnapshot();
    const source = fakeSource('ev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'exact diff bytes');
    const checkpoint = testCheckpoint(snapshot, { phase: 'verifying', candidates: [acceptedCandidate('c1', source)] });
    const closed = closeAttemptAsInterrupted(checkpoint, { checkpointId: 'ckpt-interrupt-1', occurredAt: '2026-01-01T00:20:00.000Z' }, DEFAULT_HARNESS_POLICY);
    expect(closed).toBeDefined();
    const last = closed!.activity[closed!.activity.length - 1]!;
    expect(last.kind).toBe('terminalResult');
    if (last.kind === 'terminalResult') {
      expect(last.lifecycle).toBe('interrupted');
      expect(last.completeness).toBe('partial');
      expect(last.phase).toBe('verifying');
    }
    expect(closed!.projection.lifecycle).toBe('interrupted');
    expect(closed!.reason).toBe('attemptInterrupted');
    // Everything else the checkpoint already carried survives untouched.
    expect(closed!.candidates).toEqual(checkpoint.candidates);
    expect(closed!.budget).toEqual(checkpoint.budget);
    expect(closed!.coverage).toEqual(checkpoint.coverage);
  });

  it('a completed run leaves no interrupted marker: an already-terminal checkpoint is left alone', () => {
    const snapshot = testSnapshot();
    const terminalCheckpoint = testCheckpoint(snapshot, {
      projection: { runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 1, lifecycle: 'succeeded', completeness: 'complete', elapsedMs: 1000, progressMode: 'determinate', attention: 'none', limitations: [] },
    });
    expect(closeAttemptAsInterrupted(terminalCheckpoint, { checkpointId: 'ckpt-x', occurredAt: '2026-01-01T00:20:00.000Z' }, DEFAULT_HARNESS_POLICY)).toBeUndefined();
  });

  it('clamps a backwards-moving clock up to the checkpoint\'s own last event time rather than dropping the interruption event', () => {
    const snapshot = testSnapshot();
    let log = createActivityLog(RUN_ID, LINEAGE_ID, 1);
    log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Investigating changed files.' }, { occurredAt: '2026-01-01T00:30:00.000Z', phase: 'investigating', elapsedMs: 2000 });
    const checkpoint = testCheckpoint(snapshot, { activity: log.events, elapsedMs: 2000, occurredAt: '2026-01-01T00:30:00.000Z' });

    // A caller-supplied `now()` earlier than the checkpoint's own last event — a real clock should
    // never do this, but the transform must not silently drop the interruption event if it does.
    const closed = closeAttemptAsInterrupted(checkpoint, { checkpointId: 'ckpt-clamped', occurredAt: '2026-01-01T00:00:00.000Z' }, DEFAULT_HARNESS_POLICY);
    expect(closed).toBeDefined();
    expect(closed!.activity).toHaveLength(2);
    expect(Date.parse(closed!.occurredAt)).toBeGreaterThanOrEqual(Date.parse('2026-01-01T00:30:00.000Z'));
  });

  it('an interrupted checkpoint round-trips through the real store: it reads back with reason "attemptInterrupted", a terminal-attempt marker is recorded, and closing it again is a no-op (the spec\'s "a later restart does not report that attempt as newly interrupted")', async () => {
    const map = new Map<string, unknown>();
    const backing = {
      get: <T,>(key: string) => (map.has(key) ? (JSON.parse(JSON.stringify(map.get(key))) as T) : undefined),
      update: async (key: string, value: unknown) => {
        map.set(key, JSON.parse(JSON.stringify(value)));
      },
    };
    const store = createHarnessRunStore(backing, { now: () => 0 });
    const retention = { retainedCheckpointsPerLineage: 10, maxCheckpointBytesPerLineage: 1_000_000, terminalAttemptHistoryCount: 10, terminalAttemptHistoryMaxAgeDays: 3650 };

    const snapshot = testSnapshot();
    await store.writeSnapshot(snapshot);
    await store.writeCheckpoint(testCheckpoint(snapshot, { phase: 'investigating' }), retention);

    const latest = store.latestCheckpoint(LINEAGE_ID, 1)!;
    const closed = closeAttemptAsInterrupted(latest, { checkpointId: 'ckpt-interrupt-real', occurredAt: '2026-01-01T00:20:00.000Z' }, DEFAULT_HARNESS_POLICY)!;
    expect(closed).toBeDefined();
    await store.writeCheckpoint(closed, retention);

    // Read back through the real fail-closed parser (`harnessRunStore.ts`) — proves the new
    // `'attemptInterrupted'` reason value actually parses, not just that this module produced it.
    const record = store.readLineage(LINEAGE_ID)!;
    expect(record).toBeDefined();
    const reread = store.latestCheckpoint(LINEAGE_ID, 1)!;
    expect(reread.reason).toBe('attemptInterrupted');
    expect(reread.projection.lifecycle).toBe('interrupted');
    expect(record.terminalAttempts).toContainEqual(expect.objectContaining({ attempt: 1, lifecycle: 'interrupted' }));

    // A later restart's sweep finds this attempt already terminal and does not re-interrupt it.
    expect(closeAttemptAsInterrupted(reread, { checkpointId: 'ckpt-interrupt-again', occurredAt: '2026-01-01T00:30:00.000Z' }, DEFAULT_HARNESS_POLICY)).toBeUndefined();
  });
});

// ---- No-reconnect wording (11.8) -------------------------------------------------------

describe('no-reconnect wording (11.8, D13 "the rule that matters most")', () => {
  // Every phrase that would imply the run reattached to, reconnected to, or continued its lost
  // model/tool session — a resumed run is always a brand new attempt number, never a continuation.
  const FORBIDDEN = [/reconnect/i, /reattach/i, /\bresum(e|ed|ing)\b/i, /\bcontinu(e|ed|ing|ation)\b/i, /still connected/i, /same (session|stream|attempt)/i, /picks?\s.*back up/i];

  function assertClean(text: string): void {
    for (const pattern of FORBIDDEN) expect(text).not.toMatch(pattern);
  }

  it('describeResumeStart names a new attempt from a checkpoint, never a reconnection', () => {
    const text = describeResumeStart(1, 2, 'investigating');
    assertClean(text);
    expect(text).toMatch(/attempt 2/i);
    expect(text).toMatch(/checkpoint/i);
    expect(text).toMatch(/interrupted/i);
  });

  it('interruptedLimitation states the attempt is closed, never that it can be reconnected to', () => {
    const limitation = interruptedLimitation(1, 'investigating');
    assertClean(limitation.message);
    expect(limitation.message).toMatch(/interrupt/i);
  });

  it('the wording survives appendActivityEvent\'s own sanitizer unchanged (post-sanitizer assertion)', () => {
    let log = createActivityLog(RUN_ID, LINEAGE_ID, 2);
    log = appendActivityEvent(log, { kind: 'actionStarted', action: describeResumeStart(1, 2, 'investigating') }, { occurredAt: '2026-01-01T00:00:00.000Z', phase: 'bootstrap', elapsedMs: 0 });
    const stored = log.events[0];
    expect(stored?.kind).toBe('actionStarted');
    if (stored?.kind === 'actionStarted') assertClean(stored.action);

    const snapshot = testSnapshot();
    const checkpoint = testCheckpoint(snapshot);
    const closed = closeAttemptAsInterrupted(checkpoint, { checkpointId: 'ckpt-word', occurredAt: '2026-01-01T00:20:00.000Z' }, DEFAULT_HARNESS_POLICY)!;
    const terminal = closed.activity[closed.activity.length - 1]!;
    if (terminal.kind === 'terminalResult') {
      for (const limitation of terminal.limitations) assertClean(limitation.message);
    }
  });

  // Task 14.6: `ReviewRunManager.executeAttempt` surfaces every one of
  // `checkSnapshotCompatibility`'s reason messages verbatim as
  // `RunRecord.limitations` and as `RunFailure.message` (via
  // `ResumeIncompatibleError`) — the first time these strings are shown to a
  // reviewer rather than only compared by code. Every dimension's message
  // must stay clean, not just the ones the tests above already happen to
  // cover.
  it('every checkSnapshotCompatibility reason, across every incompatibility dimension at once, stays clean — these are now shown to the reviewer verbatim (task 14.6)', () => {
    const stored = testSnapshot();
    const candidate = testSnapshot({
      schemaVersion: '2',
      toolContractVersion: 'v2',
      harnessPolicyVersion: '2',
      agentId: 'other-agent',
      personaLabel: 'Other persona',
      modelId: 'other-model',
      effort: 'low',
      criteria: { ...stored.criteria, severityFloor: 'blocker' },
      members: [{ ...stored.members[0]!, headSha: 'head-changed', providerCapabilitySignature: 'sig-2' }],
    });
    const reasons = checkSnapshotCompatibility(stored, candidate);
    expect(reasons.length).toBeGreaterThan(5); // sanity: this candidate really did trip many dimensions
    for (const reason of reasons) assertClean(reason.message);
  });

  it('the lineageIdentity reason (D2\'s "the rule that matters most") stays clean too — a wrong-lineage candidate is exactly the case this dimension exists to catch', () => {
    const stored = testSnapshot();
    const reasons = checkSnapshotCompatibility(stored, testSnapshot({ lineageId: 'lineage-other' }));
    expect(reasons.some((r) => r.code === 'lineageIdentity')).toBe(true);
    for (const r of reasons) assertClean(r.message);
  });

  it('every checkCheckpointIntegrity reason stays clean too — task 14.6 renders these verbatim in the picker screen\'s banner (ReviewRun.resumeReasons -> limitationsList), the first time they are shown to a reviewer rather than only compared by code', () => {
    const snapshot = testSnapshot();
    const corrupted = testCheckpoint(snapshot, {
      lineageId: 'lineage-other',
      attempt: 99,
      snapshotDigest: 'not-the-real-digest',
      compatible: false,
      incompatibilityReasons: [],
    });
    const reasons = checkCheckpointIntegrity(snapshot, corrupted);
    // Sanity: this really did trip the lineage/attempt mismatch, the digest
    // mismatch, and the empty-incompatibilityReasons fallback all at once.
    expect(reasons.length).toBeGreaterThanOrEqual(3);
    for (const r of reasons) assertClean(r.message);
  });

  it('ResumeIncompatibleError joins those reasons into its own message without introducing forbidden wording', () => {
    const reasons = checkSnapshotCompatibility(testSnapshot(), testSnapshot({ modelId: 'other-model' }));
    expect(reasons.length).toBeGreaterThan(0);
    const error = new ResumeIncompatibleError(reasons);
    assertClean(error.message);
    expect(error.name).toBe('ResumeIncompatibleError');
  });

  it('ResumeIncompatibleError\'s own fallback message (no reasons at all) is clean too — unreachable from any real throw site today, but it is exactly the string a future zero-reason caller would see', () => {
    const error = new ResumeIncompatibleError([]);
    assertClean(error.message);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

// ---- No prohibited content persists through the resume path (11.8) ------------------

describe('no-prohibited-content persistence (11.8)', () => {
  it('a secret-shaped marker in agent instructions or extra instructions never appears in a compatibility reason', () => {
    const marker = 'token=sk-marker-should-never-leak-1234567890';
    const stored = testSnapshot({ agentInstructionsDigest: 'digest-a' });
    const candidate = testSnapshot({ agentInstructionsDigest: 'digest-b', agentInstructions: `Review carefully. ${marker}` });
    const reasons = checkSnapshotCompatibility(stored, candidate);
    for (const r of reasons) {
      expect(r.message).not.toContain(marker);
      expect(r.message).not.toContain('sk-marker');
    }
  });

  it('a secret-shaped marker planted in a checkpoint\'s existing activity does not get duplicated or newly exposed by closing it as interrupted', () => {
    const marker = 'Bearer sk-marker-in-activity-abcdefgh12345678';
    const snapshot = testSnapshot();
    let log = createActivityLog(RUN_ID, LINEAGE_ID, 1);
    // Goes through the real sanitizer on the way in, exactly as production code would — this
    // proves the *transform* (closeAttemptAsInterrupted) introduces nothing new, not that the
    // sanitizer itself works (that is `harnessActivitySanitizer.test.ts`'s job).
    log = appendActivityEvent(log, { kind: 'toolFailed', tool: 'readFile', reason: `Unavailable. ${marker}` }, { occurredAt: '2026-01-01T00:15:00.000Z', phase: 'investigating', elapsedMs: 500 });
    const checkpoint = testCheckpoint(snapshot, { activity: log.events, elapsedMs: 500, occurredAt: '2026-01-01T00:15:00.000Z' });
    const closed = closeAttemptAsInterrupted(checkpoint, { checkpointId: 'ckpt-marker', occurredAt: '2026-01-01T00:20:00.000Z' }, DEFAULT_HARNESS_POLICY)!;
    const serialized = JSON.stringify(closed);
    expect(serialized).not.toContain('sk-marker-in-activity');
    expect(serialized).toContain('REDACTED'); // the sanitizer's own redaction marker survives, proving the field was scrubbed, not dropped
  });
});

// ---- Evidence reuse: refetch rather than claim stale evidence is model-visible (11.6) --

describe('importRetainedEvidence (11.6): refetch rather than claim unavailable evidence remains visible', () => {
  const MEMBER: EvidenceLedgerMember = { memberId: 'm1', repositoryId: 'repo-1', baseSha: 'base1', headSha: 'head1' };

  it('a retained source whose exact content and digest still match is reused, and reused sources land in the new ledger', () => {
    const priorLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 1 }, [MEMBER]);
    const registered = priorLedger.registerDiffPage('m1', { state: 'complete', snapshot: { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' }, value: { path: 'a.ts', patch: 'diff bytes', positions: [] } });
    if (!registered.ok) throw new Error('setup failed');
    const retained = toRetainedEvidenceRecord(registered.source, { includeExactContent: true });

    const newLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 2 }, [MEMBER]);
    const outcomes = importRetainedEvidence(newLedger, [retained], []);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]?.outcome.kind).toBe('reused');
    expect(newLedger.get(retained.sourceId)).toBeDefined();
  });

  it('a retained source with no exact content must be refetched, never claimed as still model-visible', () => {
    const priorLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 1 }, [MEMBER]);
    const registered = priorLedger.registerDiffPage('m1', { state: 'complete', snapshot: { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' }, value: { path: 'a.ts', patch: 'diff bytes', positions: [] } });
    if (!registered.ok) throw new Error('setup failed');
    const digestOnly = toRetainedEvidenceRecord(registered.source, { includeExactContent: false });

    const newLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 2 }, [MEMBER]);
    const candidate = acceptedCandidate('c1', registered.source);
    const outcomes = importRetainedEvidence(newLedger, [digestOnly], [candidate]);
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0]!;
    expect(outcome.outcome.kind).toBe('refetchRequired');
    expect(outcome.requiredByCitation).toBe(true); // c1 cites exactly this source
    if (outcome.outcome.kind === 'refetchRequired') {
      expect(outcome.outcome.code).toBe('exactContentUnavailable');
      expect(outcome.outcome.reason.message).not.toContain('diff bytes'); // never claims the content
    }
    expect(newLedger.get(digestOnly.sourceId)).toBeUndefined(); // never silently registered as visible
  });

  it('a refused source no candidate cites is reported as not required by citation', () => {
    const priorLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 1 }, [MEMBER]);
    const registered = priorLedger.registerDiffPage('m1', { state: 'complete', snapshot: { repoId: 'repo-1', baseSha: 'base1', headSha: 'head1' }, value: { path: 'a.ts', patch: 'diff bytes', positions: [] } });
    if (!registered.ok) throw new Error('setup failed');
    const digestOnly = toRetainedEvidenceRecord(registered.source, { includeExactContent: false });
    const newLedger = createEvidenceLedger({ runId: RUN_ID, lineageId: LINEAGE_ID, attempt: 2 }, [MEMBER]);
    const outcomes = importRetainedEvidence(newLedger, [digestOnly], []); // no candidates cite it
    expect(outcomes[0]?.requiredByCitation).toBe(false);
  });
});

// ---- Preserving plan/coverage/candidates/budget across a compatible resume (11.6) ----

describe('buildResumePayload (11.6): preserve plan, coverage, findings, and budget consumed so far', () => {
  it('carries the checkpoint\'s plan, coverage, candidates, budget, and retry state through unchanged', () => {
    const snapshot = testSnapshot();
    const source = fakeSource('ev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'exact diff bytes');
    const plan = { revision: 2, items: [{ id: 'p1', description: 'Inspect auth changes', state: 'active' as const }] };
    const checkpoint = testCheckpoint(snapshot, { plan, candidates: [acceptedCandidate('c1', source)] });
    const payload = buildResumePayload(checkpoint);
    expect(payload.priorAttempt).toBe(1);
    expect(payload.newAttempt).toBe(2);
    expect(payload.plan).toEqual(plan);
    expect(payload.coverage).toEqual(checkpoint.coverage);
    expect(payload.candidates).toEqual(checkpoint.candidates);
    expect(payload.budget).toEqual(checkpoint.budget);
    expect(payload.retry).toEqual(checkpoint.retry);
    expect(payload.retainedEvidence).toEqual(checkpoint.evidence);
  });
});

// ---- canonicalStringify/sha256Hex sanity (used throughout this module) ---------------

describe('computeSnapshotDigest round-trip', () => {
  it('the same snapshot always digests the same way, and any field change digests differently', () => {
    const snapshot = testSnapshot();
    expect(computeSnapshotDigest(snapshot)).toBe(sha256Hex(canonicalStringify(snapshot)));
    expect(computeSnapshotDigest({ ...snapshot, personaLabel: 'Different' })).not.toBe(computeSnapshotDigest(snapshot));
  });
});
