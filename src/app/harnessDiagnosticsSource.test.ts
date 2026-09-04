import { describe, expect, it } from 'vitest';
import { appendActivityEvent, createActivityLog } from './harnessActivityLog';
import { buildCheckpoint, type CheckpointBuildInput } from './harnessCheckpoint';
import { diagnosticsCheckpointFromPersisted, findRecentDiagnosticsCandidates, type IdentifyDiagnosticsTarget } from './harnessDiagnosticsSource';
import { buildAttemptDiagnosticsReport, renderAttemptDiagnosticsText } from './harnessDiagnostics';
import { createHarnessRunStore } from './harnessRunStore';
import type { LedgerEvidenceSource } from './harnessEvidenceLedger';
import type { KeyValueStore } from './storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from '../domain/harnessTools';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

// House style of `harnessRunStore.test.ts`'s own `jsonMemoryStore`: a real JSON round-trip, so
// nothing here can accidentally pass by holding a live object reference instead of a persisted one.
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

const GENEROUS_RETENTION = {
  retainedCheckpointsPerLineage: 100,
  maxCheckpointBytesPerLineage: 10 * 1024 * 1024,
  terminalAttemptHistoryCount: 100,
  terminalAttemptHistoryMaxAgeDays: 3650,
};

const ZERO_BUDGET: BudgetConsumption = { modelTurnsUsed: 2, toolCallsUsed: 4, evidenceBytesUsed: 64, elapsedMs: 500, highRiskReserveUsed: 1, verificationReserveUsed: 0 };
const ZERO_COVERAGE: readonly MemberCoverage[] = [
  { memberId: 'm1', manifestComplete: true, totalFiles: 2, files: [{ path: 'src/other.ts', memberId: 'm1', state: 'classified', risk: 'high' }] },
];

function testSnapshot(overrides: Partial<ReviewRunSnapshot> = {}): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: overrides.lineageId ? `run-${overrides.lineageId}` : 'run-1',
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

function evidenceSource(overrides: Partial<LedgerEvidenceSource> = {}): LedgerEvidenceSource {
  return {
    sourceId: 'src-1',
    digest: 'digest-1',
    kind: 'diff',
    repositoryId: 'repo-1',
    baseSha: 'base1',
    headSha: 'head1',
    completeness: 'complete',
    citable: true,
    // Present only because the type requires it; asserted below to never reach the report.
    exactContent: 'RAW CONTENT THAT MUST NEVER REACH A PERSISTED-STORE DIAGNOSTICS REPORT',
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    memberId: 'm1',
    origin: 'diffPage',
    trust: 'untrusted',
    sequence: 1,
    locations: [],
    byteLength: 999,
    path: 'src/other.ts',
    ...overrides,
  };
}

function checkpointInput(overrides: Partial<CheckpointBuildInput> = {}): CheckpointBuildInput {
  return {
    checkpointId: 'ckpt-1',
    runId: 'run-1',
    lineageId: 'lineage-1',
    attempt: 1,
    phase: 'persisting',
    reason: 'phaseBoundary',
    occurredAt: '2026-01-01T00:01:00.000Z',
    elapsedMs: 60_000,
    snapshotDigest: 'snap-digest-1',
    activityEvents: [],
    evidenceSources: [],
    candidates: [],
    contradicted: [],
    budget: ZERO_BUDGET,
    coverage: ZERO_COVERAGE,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 1 },
    ...overrides,
  };
}

/** A terminal, failed attempt's activity log — the exact "no findings, insufficientRiskCoverage" scenario `harnessDiagnostics.ts`'s own header names. */
function failedActivityEvents(lineageId: string, attempt: number) {
  let log = createActivityLog(`run-${lineageId}`, lineageId, attempt);
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Investigating changed files.' }, { occurredAt: '2026-01-01T00:00:30.000Z', phase: 'investigating', elapsedMs: 30_000 });
  log = appendActivityEvent(
    log,
    { kind: 'terminalResult', lifecycle: 'failed', completeness: 'none', limitations: [{ code: 'insufficientRiskCoverage', message: 'A high-risk file was classified but never inspected.' }] },
    { occurredAt: '2026-01-01T00:01:00.000Z', phase: 'persisting', elapsedMs: 60_000 },
  );
  return log.events;
}

/**
 * Identifies every snapshot as belonging to the one pod under test — the fixture stand-in for
 * `extension.ts`'s real repo/provider match. Builds `targetKey` with the exact same helpers
 * `ReviewRunManager`'s own `runKeyFor` uses (`crKey`/`runKeyForChangeset`'s literal format), so a
 * real caller can cross-check `runManager.get(candidate.targetKey)` directly.
 */
const identifyAll: IdentifyDiagnosticsTarget = (snapshot) => ({
  targetKey: snapshot.targetKind === 'cr' ? `${snapshot.members[0]!.ref.repoId}!${snapshot.members[0]!.ref.number}` : `changeset:${snapshot.changesetId ?? 'changeset'}`,
  refLabel: snapshot.targetKind === 'cr' ? `!${snapshot.members[0]!.ref.number}` : (snapshot.changesetId ?? 'changeset'),
});

async function writeFailedLineage(store: KeyValueStore, lineageId: string, occurredAt: string, options: { withEvidence?: boolean } = {}) {
  const runStore = createHarnessRunStore(store, { now: () => Date.parse(occurredAt) });
  await runStore.writeSnapshot(testSnapshot({ lineageId, runId: `run-${lineageId}` }));
  const built = buildCheckpoint(
    checkpointInput({
      runId: `run-${lineageId}`,
      lineageId,
      occurredAt,
      activityEvents: failedActivityEvents(lineageId, 1),
      evidenceSources: options.withEvidence ? [evidenceSource({ runId: `run-${lineageId}`, lineageId })] : [],
    }),
    DEFAULT_HARNESS_POLICY,
  );
  await runStore.writeCheckpoint(built, GENEROUS_RETENTION);
  return runStore;
}

describe('findRecentDiagnosticsCandidates', () => {
  it('resolves a settled attempt with no live record anywhere, carrying real coverage/budget/limitations from the persisted checkpoint', async () => {
    const store = jsonMemoryStore();
    const runStore = await writeFailedLineage(store, 'lineage-1', '2026-01-01T00:01:00.000Z', { withEvidence: true });

    const candidates = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.lifecycle).toBe('failed');
    expect(candidate.completeness).toBe('none');
    expect(candidate.refLabel).toBe('!42');
    expect(candidate.record.limitations).toEqual([{ code: 'insufficientRiskCoverage', message: 'A high-risk file was classified but never inspected.' }]);

    const report = buildAttemptDiagnosticsReport(candidate.record, () => 'now');
    expect(report.coverage[0]?.files[0]?.path).toBe('src/other.ts');
    expect(report.budget).toEqual(ZERO_BUDGET);
    expect(report.unresolved).toEqual({ unresolvedFetches: 0, unresolvedCandidates: 1 });

    const text = renderAttemptDiagnosticsText(report);
    expect(text).toContain('lifecycle=failed completeness=none');
    expect(text).toContain('Coverage:');
    expect(text).toContain('src/other.ts');
    expect(text).toContain('Limitations:');
    expect(text).toContain('insufficientRiskCoverage');
  });

  it('never carries the fetched evidence content, and reports its byte count as unknown rather than fabricating zero', async () => {
    const store = jsonMemoryStore();
    const runStore = await writeFailedLineage(store, 'lineage-1', '2026-01-01T00:01:00.000Z', { withEvidence: true });
    const candidate = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll)[0]!;

    const report = buildAttemptDiagnosticsReport(candidate.record, () => 'now');
    expect(JSON.stringify(report)).not.toContain('RAW CONTENT THAT MUST NEVER REACH A PERSISTED-STORE DIAGNOSTICS REPORT');
    expect(report.evidenceFetched).toEqual([{ sequence: 1, memberId: 'm1', origin: 'diffPage', path: 'src/other.ts', byteLength: undefined }]);

    const text = renderAttemptDiagnosticsText(report);
    expect(text).toContain('bytes=unknown');
    expect(text).not.toContain('RAW CONTENT THAT MUST NEVER REACH A PERSISTED-STORE DIAGNOSTICS REPORT');
  });

  it('filters out a lineage whose target the caller does not recognize as this pod\'s own', async () => {
    const store = jsonMemoryStore();
    const runStore = await writeFailedLineage(store, 'lineage-1', '2026-01-01T00:01:00.000Z');
    const identifyNone: IdentifyDiagnosticsTarget = () => undefined;

    expect(findRecentDiagnosticsCandidates(runStore.listLineages(), identifyNone)).toEqual([]);
  });

  it('says there is nothing to diagnose for a lineage that has a snapshot but no checkpoint and no terminal marker', async () => {
    const store = jsonMemoryStore();
    const runStore = createHarnessRunStore(store, { now: () => 0 });
    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-1', runId: 'run-1' }));

    expect(findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll)).toEqual([]);
  });

  it('falls back to the last checkpoint\'s own projection when no terminal marker was ever written (e.g. a lost, interrupted attempt)', async () => {
    const store = jsonMemoryStore();
    const runStore = createHarnessRunStore(store, { now: () => 0 });
    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-1', runId: 'run-1' }));
    let log = createActivityLog('run-1', 'lineage-1', 1);
    log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Investigating changed files.' }, { occurredAt: '2026-01-01T00:00:30.000Z', phase: 'investigating', elapsedMs: 30_000 });
    const built = buildCheckpoint(checkpointInput({ activityEvents: log.events, occurredAt: '2026-01-01T00:00:30.000Z' }), DEFAULT_HARNESS_POLICY);
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    const candidates = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll);
    expect(candidates).toHaveLength(1);
    // Never terminal — the last known non-terminal phase, honestly reported as such.
    expect(candidates[0]?.lifecycle).toBe('investigating');
  });

  it('keeps only the newest lineage per target, mirroring reviewRuns.ts\'s own "latest run per target wins"', async () => {
    const store = jsonMemoryStore();
    await writeFailedLineage(store, 'lineage-old', '2026-01-01T00:00:00.000Z');
    const runStore = await writeFailedLineage(store, 'lineage-new', '2026-01-02T00:00:00.000Z');

    const candidates = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.lineageId).toBe('lineage-new');
  });

  it('sorts distinct targets newest first, and only prompts a picker (a caller\'s job) when more than one exists', async () => {
    const store = jsonMemoryStore();
    await writeFailedLineage(store, 'lineage-1', '2026-01-01T00:00:00.000Z');
    const runStore = createHarnessRunStore(store, { now: () => Date.parse('2026-01-02T00:00:00.000Z') });
    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-2', runId: 'run-lineage-2', members: [{ ...testSnapshot().members[0]!, ref: { repoId: 'repo-1', number: '99' } }] }));
    const built = buildCheckpoint(
      checkpointInput({ runId: 'run-lineage-2', lineageId: 'lineage-2', occurredAt: '2026-01-02T00:00:00.000Z', activityEvents: failedActivityEvents('lineage-2', 1) }),
      DEFAULT_HARNESS_POLICY,
    );
    await runStore.writeCheckpoint(built, GENEROUS_RETENTION);

    const candidates = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll);
    expect(candidates.map((c) => c.lineageId)).toEqual(['lineage-2', 'lineage-1']);
  });
});

describe('diagnosticsCheckpointFromPersisted', () => {
  it('never reads exactContent, even directly', async () => {
    const store = jsonMemoryStore();
    const runStore = await writeFailedLineage(store, 'lineage-1', '2026-01-01T00:01:00.000Z', { withEvidence: true });
    const checkpoint = runStore.latestCheckpoint('lineage-1');
    expect(checkpoint).toBeDefined();
    const adapted = diagnosticsCheckpointFromPersisted(checkpoint!);
    expect(JSON.stringify(adapted)).not.toContain('RAW CONTENT THAT MUST NEVER REACH A PERSISTED-STORE DIAGNOSTICS REPORT');
  });
});
