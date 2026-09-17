import { describe, expect, it } from 'vitest';
import { appendActivityEvent, createActivityLog } from './harnessActivityLog';
import { buildCheckpoint, type CheckpointBuildInput } from './harnessCheckpoint';
import {
  diagnosticsCheckpointFromPersisted,
  findRecentDiagnosticsCandidates,
  mergeLiveDiagnosticsCandidates,
  selectDiagnosticsCandidate,
  summarizeDiagnosticsDiscovery,
  type DiagnosticsCandidate,
  type IdentifyDiagnosticsTarget,
} from './harnessDiagnosticsSource';
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
    producedBy: 'provider',
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
    expect(report.evidenceFetched).toEqual([
      { sequence: 1, memberId: 'm1', origin: 'diffPage', producedBy: 'provider', path: 'src/other.ts', byteLength: undefined },
    ]);

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

  it('breaks a same-`occurredAt` tie between two lineages for one target by write order, keeping the later-written (newer) lineage rather than whichever store.keys() walks to first', async () => {
    const store = jsonMemoryStore();
    // `writeFailedLineage(store, 'lineage-old', ...)` runs to completion — its `store.update` included
    // — before the `lineage-new` call starts, so `lineage-old`'s key claims the earlier position in
    // the underlying `Map` and `lineage-new`'s claims the later one; `keys()` never moves an existing
    // key on a later write, only a brand-new one gets appended. Both checkpoints share TIED_AT exactly,
    // so `findRecentDiagnosticsCandidates`'s dedup cannot break the tie by comparing timestamps — only
    // write order can, and the older lineage is what a strict `<` used to keep.
    const TIED_AT = '2026-01-05T00:00:00.000Z';
    await writeFailedLineage(store, 'lineage-old', TIED_AT);
    const runStore = await writeFailedLineage(store, 'lineage-new', TIED_AT);

    const candidates = findRecentDiagnosticsCandidates(runStore.listLineages(), identifyAll);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.lineageId).toBe('lineage-new');

    // The user-visible half: `showRunDiagnostics` auto-reports `selectDiagnosticsCandidate`'s `chosen`
    // without asking first, so a tie resolved the wrong way here means the reviewer is shown the wrong
    // run's diagnostics with no indication anything was chosen at all.
    const selection = selectDiagnosticsCandidate(candidates, new Set());
    expect(selection?.chosen.lineageId).toBe('lineage-new');
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

describe('summarizeDiagnosticsDiscovery: the not-found report\'s counts, so "no review has ever run" reads differently from "runs exist but none matched" and from "the stored data would not parse"', () => {
  it('is all zeroes when nothing has ever run', () => {
    const summary = summarizeDiagnosticsDiscovery(0, [], identifyAll);
    expect(summary).toEqual({ totalLineageKeys: 0, unparsedLineageKeys: 0, parsedLineages: 0, matchedThisPod: 0, rejected: [] });
  });

  it('leaves matchedThisPod undefined, never a fabricated zero, when no pod was given to match against', () => {
    const summary = summarizeDiagnosticsDiscovery(2, [], undefined);
    expect(summary.matchedThisPod).toBeUndefined();
    expect(summary.totalLineageKeys).toBe(2);
    expect(summary.parsedLineages).toBe(0);
  });

  it('classifies every rejection reason, and counts a key that failed to parse separately from one that parsed but did not match', async () => {
    const store = jsonMemoryStore();
    const runStore = await writeFailedLineage(store, 'lineage-matched', '2026-01-01T00:00:00.000Z');

    // Belongs to a different pod's repo entirely.
    await runStore.writeSnapshot(testSnapshot({
      lineageId: 'lineage-other-pod',
      runId: 'run-lineage-other-pod',
      members: [{ ...testSnapshot().members[0]!, ref: { repoId: 'repo-other', number: '7' } }],
    }));
    const otherBuilt = buildCheckpoint(
      checkpointInput({ runId: 'run-lineage-other-pod', lineageId: 'lineage-other-pod', occurredAt: '2026-01-01T00:00:00.000Z', activityEvents: failedActivityEvents('lineage-other-pod', 1) }),
      DEFAULT_HARNESS_POLICY,
    );
    await runStore.writeCheckpoint(otherBuilt, GENEROUS_RETENTION);

    // Crashed before its first checkpoint — a snapshot with nothing else ever written.
    await runStore.writeSnapshot(testSnapshot({ lineageId: 'lineage-incomplete', runId: 'run-incomplete' }));

    // Every attempt evicted (task 11.4): the key survives on disk as an empty shell.
    await store.update('codeVerdict.harness.lineage.lineage-empty', {
      schemaVersion: '1', runId: 'run-empty', lineageId: 'lineage-empty', snapshots: {}, checkpoints: [], terminalAttempts: [],
    });

    // Shaped wrong entirely — dropped by every parser's guard.
    await store.update('codeVerdict.harness.lineage.lineage-corrupt', { schemaVersion: '1', runId: 'x' });

    const identifyRepo1: IdentifyDiagnosticsTarget = (snapshot) =>
      (snapshot.members[0]!.ref.repoId === 'repo-1' ? identifyAll(snapshot) : undefined);

    const lineages = runStore.listLineages();
    const summary = summarizeDiagnosticsDiscovery(runStore.lineageKeyCount(), lineages, identifyRepo1);

    expect(summary.totalLineageKeys).toBe(5);
    expect(summary.parsedLineages).toBe(4);
    expect(summary.unparsedLineageKeys).toBe(1);
    expect(summary.matchedThisPod).toBe(1);

    const reasons = Object.fromEntries(summary.rejected.map((r) => [r.lineageId, r.rejection.kind]));
    expect(reasons['lineage-other-pod']).toBe('notThisPod');
    expect(reasons['lineage-incomplete']).toBe('incompleteAttempt');
    expect(reasons['lineage-empty']).toBe('noSnapshots');
    expect(summary.rejected).toHaveLength(3);

    const incomplete = summary.rejected.find((r) => r.lineageId === 'lineage-incomplete');
    expect(incomplete?.rejection).toMatchObject({ kind: 'incompleteAttempt', targetKey: 'repo-1!42', refLabel: '!42', attempt: 1 });
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

/** A minimal `DiagnosticsCandidate` — these two functions never read `record`, so a stub stands in for the real, larger shape `evaluateLineage` builds. */
function candidate(overrides: Partial<DiagnosticsCandidate> & { targetKey: string }): DiagnosticsCandidate {
  return {
    refLabel: `!${overrides.targetKey}`,
    lineageId: `lineage-${overrides.targetKey}`,
    attempt: 1,
    lifecycle: 'failed',
    completeness: 'none',
    occurredAt: '2026-01-01T00:00:00.000Z',
    record: {} as DiagnosticsCandidate['record'],
    ...overrides,
  };
}

describe('mergeLiveDiagnosticsCandidates', () => {
  it('keeps a disk candidate whose target no live record names', () => {
    const disk = [candidate({ targetKey: 'cr-1', occurredAt: '2026-01-01T00:00:00.000Z' })];
    expect(mergeLiveDiagnosticsCandidates(disk, [])).toEqual(disk);
  });

  it('prefers the live record for a target both name, even when the disk one is nominally "newer"', () => {
    const disk = [candidate({ targetKey: 'cr-1', occurredAt: '2026-01-02T00:00:00.000Z', lifecycle: 'failed' })];
    const live = [candidate({ targetKey: 'cr-1', occurredAt: '2026-01-01T00:00:00.000Z', lifecycle: 'investigating' })];
    const merged = mergeLiveDiagnosticsCandidates(disk, live);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.lifecycle).toBe('investigating');
  });

  it('includes a live target the disk list has never heard of — a run in its first moments, before its own first checkpoint', () => {
    const live = [candidate({ targetKey: 'cr-2', lifecycle: 'queued' })];
    const merged = mergeLiveDiagnosticsCandidates([], live);
    expect(merged).toEqual(live);
  });

  it('sorts the merged list newest first', () => {
    const disk = [candidate({ targetKey: 'cr-old', occurredAt: '2026-01-01T00:00:00.000Z' })];
    const live = [candidate({ targetKey: 'cr-new', occurredAt: '2026-01-03T00:00:00.000Z' })];
    expect(mergeLiveDiagnosticsCandidates(disk, live).map((c) => c.targetKey)).toEqual(['cr-new', 'cr-old']);
  });
});

describe('selectDiagnosticsCandidate: the picker-gate fix — no candidate here may require an answer before the caller\'s first write', () => {
  it('is undefined for an empty candidate list, never a fabricated selection', () => {
    expect(selectDiagnosticsCandidate([], new Set())).toBeUndefined();
  });

  it('chooses the one candidate outright when there is only one, live or not', () => {
    const candidates = [candidate({ targetKey: 'cr-1' })];
    const selection = selectDiagnosticsCandidate(candidates, new Set());
    expect(selection?.chosen.targetKey).toBe('cr-1');
    expect(selection?.others).toEqual([]);
  });

  it('chooses the run live for this pod outright when it is the only one live, even when a stale candidate is nominally newer', () => {
    const candidates = [
      candidate({ targetKey: 'cr-stale-newer', occurredAt: '2026-01-05T00:00:00.000Z' }),
      candidate({ targetKey: 'cr-live', occurredAt: '2026-01-01T00:00:00.000Z' }),
    ];
    const selection = selectDiagnosticsCandidate(candidates, new Set(['cr-live']));
    expect(selection?.chosen.targetKey).toBe('cr-live');
    expect(selection?.others.map((c) => c.targetKey)).toEqual(['cr-stale-newer']);
  });

  it('falls back to the newest candidate when more than one is live at once — never asks which', () => {
    const candidates = [
      candidate({ targetKey: 'cr-a', occurredAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ targetKey: 'cr-b', occurredAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const selection = selectDiagnosticsCandidate(candidates, new Set(['cr-a', 'cr-b']));
    expect(selection?.chosen.targetKey).toBe('cr-b');
  });

  it('falls back to the newest candidate when nothing is live', () => {
    const candidates = [
      candidate({ targetKey: 'cr-a', occurredAt: '2026-01-01T00:00:00.000Z' }),
      candidate({ targetKey: 'cr-b', occurredAt: '2026-01-02T00:00:00.000Z' }),
    ];
    const selection = selectDiagnosticsCandidate(candidates, new Set());
    expect(selection?.chosen.targetKey).toBe('cr-b');
    expect(selection?.others.map((c) => c.targetKey)).toEqual(['cr-a']);
  });
});
