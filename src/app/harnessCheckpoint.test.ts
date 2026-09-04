import { describe, expect, it } from 'vitest';
import {
  appendActivityEvent,
  createActivityLog,
  type ActivityContext,
} from './harnessActivityLog';
import {
  buildCheckpoint,
  INITIAL_RETRY_STATE,
  isRetryState,
  parseRetryState,
  type CheckpointBuildInput,
} from './harnessCheckpoint';
import type { ContradictedFindingRecord } from './harnessAttempt';
import type { CitedEvidenceRef, TrackedCandidate, ValidatedFinding } from './harnessCandidateValidation';
import type { LedgerEvidenceSource } from './harnessEvidenceLedger';
import { sha256Hex } from './contentDigest';
import type { ActivityEvent } from '../domain/harnessActivity';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';

const RUN_ID = 'run-1';
const LINEAGE_ID = 'lineage-1';
const ATTEMPT = 1;

const ZERO_BUDGET: BudgetConsumption = {
  modelTurnsUsed: 3,
  toolCallsUsed: 5,
  evidenceBytesUsed: 128,
  elapsedMs: 4000,
  highRiskReserveUsed: 0,
  verificationReserveUsed: 0,
};

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
    attempt: ATTEMPT,
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
  return {
    sourceId: source.sourceId,
    digest: source.digest,
    origin: source.origin,
    memberId: source.memberId,
    repositoryId: source.repositoryId,
    baseSha: source.baseSha,
    headSha: source.headSha,
    path: 'file1.ts',
    range: { startLine: 1, endLine: 1 },
  };
}

function acceptedCandidate(candidateId: string, primary: LedgerEvidenceSource, supporting: readonly LedgerEvidenceSource[] = []): TrackedCandidate {
  const finding: ValidatedFinding = {
    candidateId,
    memberId: 'm1',
    routing: 'inline',
    item: {
      id: candidateId,
      file: 'file1.ts',
      anchored: true,
      line: 1,
      severity: 'major',
      category: 'security',
      confidence: 80,
      title: 'A real finding',
      body: 'Body text describing the finding.',
      code: '',
    },
    provenance: { protocolProvenance: 'harness', citations: [], validatedAt: '2026-01-01T00:00:00.000Z' },
    evidence: {
      repositoryId: primary.repositoryId,
      baseSha: primary.baseSha,
      headSha: primary.headSha,
      primary: citedRef(primary),
      supporting: supporting.map(citedRef),
    },
  };
  return { candidateId, state: 'accepted', repairs: 0, reasons: [], finding };
}

function baseInput(overrides: Partial<CheckpointBuildInput> = {}): CheckpointBuildInput {
  return {
    checkpointId: 'ckpt-1',
    runId: RUN_ID,
    lineageId: LINEAGE_ID,
    attempt: ATTEMPT,
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

/** Builds one real, sanitized activity event through the actual production pipeline — not a hand-built `ActivityEvent` literal — so a marker test proves the sanitizer boundary, not a re-implementation of it. Always starts a fresh single-event log, so callers building several events for one test must use `realEvents` instead (this gives every one of them `sequence: 1`, which `compactActivity`'s dedupe would collapse). */
function realEvent(fact: Parameters<typeof appendActivityEvent>[1], context?: Partial<ActivityContext>): ActivityEvent {
  return realEvents([fact], context ? [context] : undefined)[0] as ActivityEvent;
}

/** Folds every fact through one shared log (real monotonic sequence numbers, as `HarnessAttempt` itself produces), returning every accepted event. */
function realEvents(facts: readonly Parameters<typeof appendActivityEvent>[1][], contexts?: readonly Partial<ActivityContext>[]): ActivityEvent[] {
  let log = createActivityLog(RUN_ID, LINEAGE_ID, ATTEMPT);
  facts.forEach((fact, index) => {
    const context = contexts?.[index];
    const countBefore = log.events.length;
    log = appendActivityEvent(log, fact, {
      occurredAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`,
      phase: 'investigating',
      elapsedMs: index,
      ...context,
    });
    if (log.events.length === countBefore) throw new Error(`realEvents: fact at index ${index} was rejected by the sanitizer; fix the test fixture.`);
  });
  return [...log.events];
}

describe('buildCheckpoint (11.2): a fully populated checkpoint round-trips every field', () => {
  it('carries phase/reason/continuation metadata, plan, projection, evidence, candidates, budget, coverage, and retry state', () => {
    const primary = fakeSource('ev_primary000000000000000000000', 'diff content for the primary citation');
    const supporting = fakeSource('ev_support0000000000000000000000', 'file content supporting the claim', { kind: 'file', origin: 'fileRange' });
    const uncited = fakeSource('ev_uncited0000000000000000000000', 'a search excerpt nobody cited', { kind: 'searchExcerpt', origin: 'repositorySearch' });
    const candidate = acceptedCandidate('cand-1', primary, [supporting]);

    const log = createActivityLog(RUN_ID, LINEAGE_ID, ATTEMPT);
    const withPlan = appendActivityEvent(
      log,
      { kind: 'planCreated', plan: { revision: 1, items: [{ id: 'p1', description: 'Investigate file1.ts.', state: 'active' }] } },
      { occurredAt: '2026-01-01T00:00:00.000Z', phase: 'planning', elapsedMs: 0 },
    );

    const contradicted: ContradictedFindingRecord[] = [{ candidateId: 'cand-2', reason: 'The model found the cited evidence does not support this claim.' }];

    const input = baseInput({
      activityEvents: withPlan.events,
      evidenceSources: [primary, supporting, uncited],
      candidates: [candidate],
      contradicted,
      retry: { waiting: true, transientAttempts: 2, lastWaitReason: 'A transient provider issue required a wait.' },
    });

    const checkpoint = buildCheckpoint(input, DEFAULT_HARNESS_POLICY);

    expect(checkpoint.checkpointId).toBe('ckpt-1');
    expect(checkpoint.runId).toBe(RUN_ID);
    expect(checkpoint.lineageId).toBe(LINEAGE_ID);
    expect(checkpoint.attempt).toBe(ATTEMPT);
    expect(checkpoint.phase).toBe('investigating');
    expect(checkpoint.reason).toBe('phaseBoundary');
    expect(checkpoint.snapshotDigest).toBe('snap-digest-1');
    expect(checkpoint.plan?.items).toEqual([{ id: 'p1', description: 'Investigate file1.ts.', state: 'active' }]);
    expect(checkpoint.projection.runId).toBe(RUN_ID);
    expect(checkpoint.candidates).toEqual([candidate]);
    expect(checkpoint.contradicted).toEqual(contradicted);
    expect(checkpoint.budget).toEqual(ZERO_BUDGET);
    expect(checkpoint.coverage).toEqual(ZERO_COVERAGE);
    expect(checkpoint.retry).toEqual({ waiting: true, transientAttempts: 2, lastWaitReason: 'A transient provider issue required a wait.' });
    expect(checkpoint.compatible).toBe(true);
    expect(checkpoint.incompatibilityReasons).toEqual([]);
    expect(checkpoint.bytes).toBeGreaterThan(0);

    // Evidence: every source's metadata/digest survives regardless of citation.
    expect(checkpoint.evidence).toHaveLength(3);
    const primaryRecord = checkpoint.evidence.find((e) => e.sourceId === primary.sourceId);
    const supportingRecord = checkpoint.evidence.find((e) => e.sourceId === supporting.sourceId);
    const uncitedRecord = checkpoint.evidence.find((e) => e.sourceId === uncited.sourceId);
    expect(primaryRecord?.digest).toBe(primary.digest);
    expect(supportingRecord?.digest).toBe(supporting.digest);
    expect(uncitedRecord?.digest).toBe(uncited.digest);
  });

  it('derives the plan from the sanitized activity log, never from a raw separately-supplied value — a long description is truncated exactly as the real sanitizer would', () => {
    const overlong = 'x'.repeat(400);
    const event = realEvent({ kind: 'planCreated', plan: { revision: 1, items: [{ id: 'p1', description: overlong, state: 'active' }] } });
    const checkpoint = buildCheckpoint(baseInput({ activityEvents: [event] }), DEFAULT_HARNESS_POLICY);
    expect(checkpoint.plan?.items[0]?.description.length).toBeLessThan(overlong.length);
    expect(checkpoint.plan?.items[0]?.description.endsWith('…')).toBe(true);
  });

  it('defaults retry state to INITIAL_RETRY_STATE when the caller supplies none (no live counter exists yet, per the file header)', () => {
    const checkpoint = buildCheckpoint(baseInput(), DEFAULT_HARNESS_POLICY);
    expect(checkpoint.retry).toEqual(INITIAL_RETRY_STATE);
  });
});

describe('buildCheckpoint (11.2/D8): exact excerpts are retained only for sources a retained citation needs', () => {
  it('keeps exactContent, byte-identical with a matching digest, only for the primary and supporting sources an accepted finding cites', () => {
    const primary = fakeSource('ev_a00000000000000000000000000000', 'exact primary bytes the model saw');
    const supporting = fakeSource('ev_b00000000000000000000000000000', 'exact supporting bytes the model saw', { kind: 'file', origin: 'fileRange' });
    const uncited = fakeSource('ev_c00000000000000000000000000000', 'exact bytes nobody ever cited', { kind: 'searchExcerpt', origin: 'repositorySearch' });
    const candidate = acceptedCandidate('cand-1', primary, [supporting]);

    const checkpoint = buildCheckpoint(
      baseInput({ evidenceSources: [primary, supporting, uncited], candidates: [candidate] }),
      DEFAULT_HARNESS_POLICY,
    );

    const a = checkpoint.evidence.find((e) => e.sourceId === primary.sourceId);
    const b = checkpoint.evidence.find((e) => e.sourceId === supporting.sourceId);
    const c = checkpoint.evidence.find((e) => e.sourceId === uncited.sourceId);

    expect(a?.exactContent).toBe(primary.exactContent);
    expect(sha256Hex(a?.exactContent ?? '')).toBe(a?.digest);
    expect(b?.exactContent).toBe(supporting.exactContent);
    expect(sha256Hex(b?.exactContent ?? '')).toBe(b?.digest);

    // Metadata and digest survive for the uncited source; the exact bytes do not.
    expect(c?.exactContent).toBeUndefined();
    expect(c?.digest).toBe(uncited.digest);
    expect(c?.kind).toBe(uncited.kind);
  });

  it('drops exactContent once a candidate is invalidated back to unresolved — an invalidated finding no longer "retains" a citation', () => {
    const primary = fakeSource('ev_d00000000000000000000000000000', 'bytes for a finding that got invalidated');
    // Mirrors `CandidateTracker.invalidate`'s own output shape: no `finding` key survives invalidation.
    const invalidated: TrackedCandidate = { candidateId: 'cand-1', state: 'unresolved', repairs: 0, reasons: [{ code: 'headChanged', message: 'Member head moved.' }] };

    const checkpoint = buildCheckpoint(
      baseInput({ evidenceSources: [primary], candidates: [invalidated] }),
      DEFAULT_HARNESS_POLICY,
    );

    const record = checkpoint.evidence.find((e) => e.sourceId === primary.sourceId);
    expect(record?.exactContent).toBeUndefined();
  });
});

describe('buildCheckpoint (11.2): the marker test — no secret, prompt fragment, or full output blob survives, and the one deliberate exception is proven, not assumed', () => {
  it('walks the entire serialized checkpoint and finds none of the planted prohibited markers, while the one cited evidence marker does survive', () => {
    // Marker 1: a secret planted in a *real* toolFailed fact, through the production sanitizer.
    const SECRET_MARKER = 'MARKER_SECRET_9f3e7a2c';
    // Marker 2: a simulated raw prompt/hidden-reasoning fragment far past the sanitizer's 240-char
    // bound — proves the *length* bound, not just pattern redaction, keeps the field from ever
    // holding a full prompt.
    const PROMPT_MARKER = 'MARKER_RAW_PROMPT_7f3a2b1c';
    const longReason = `${'System prompt leaking: '.repeat(20)}${PROMPT_MARKER}`;
    // Built through one shared log (not two independent `realEvent` calls) so both events carry
    // real, distinct sequence numbers rather than colliding at `sequence: 1`.
    const bothEvents = realEvents([
      { kind: 'toolFailed', tool: 'readDiff', target: 'file1.ts', reason: `Bearer sk-live-${SECRET_MARKER}1234567890` },
      { kind: 'toolFailed', tool: 'modelTurn', reason: longReason },
    ]);
    const secretEvent = bothEvents[0] as ActivityEvent;
    const promptEvent = bothEvents[1] as ActivityEvent;

    // Marker 3: a collaborator-supplied (never assumed pre-sanitized) contradiction reason
    // simulating a smuggled full-argument-shaped blob. `sanitizePublicText` has no concept of
    // "argument shaped" — the *length* bound is what must catch this, so the blob is padded well
    // past 240 chars with the marker placed at the very end, past the truncation cut.
    const ARGUMENT_MARKER = 'MARKER_FULL_ARGUMENT_BLOB_4d2e';
    const argumentBlob = JSON.stringify({ tool: 'submitCandidateFinding', arguments: { huge: 'x'.repeat(300) } });
    const contradicted: ContradictedFindingRecord[] = [{ candidateId: 'cand-99', reason: `${argumentBlob}${ARGUMENT_MARKER}` }];

    // Marker 4: the exact content of a source nobody cited — must never appear anywhere.
    const UNCITED_MARKER = 'MARKER_UNCITED_EVIDENCE_ab12cd';
    const uncited = fakeSource('ev_x00000000000000000000000000000', `full tool-output text containing ${UNCITED_MARKER}`, { kind: 'searchExcerpt', origin: 'repositorySearch' });

    // The deliberate exception: a source a retained citation *does* need. Its own marker MUST
    // survive, byte-identical — proving the split is real, not that everything is simply omitted.
    const CITED_MARKER = 'MARKER_CITED_EVIDENCE_should_survive_77aa';
    const cited = fakeSource('ev_y00000000000000000000000000000', `exact diff bytes containing ${CITED_MARKER}`);
    const candidate = acceptedCandidate('cand-1', cited);

    const checkpoint = buildCheckpoint(
      baseInput({
        activityEvents: [secretEvent, promptEvent],
        evidenceSources: [uncited, cited],
        candidates: [candidate],
        contradicted,
      }),
      DEFAULT_HARNESS_POLICY,
    );

    const serialized = JSON.stringify(checkpoint);

    expect(serialized).not.toContain('sk-live-');
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain(PROMPT_MARKER);
    expect(serialized).not.toContain(ARGUMENT_MARKER);
    expect(serialized).not.toContain(UNCITED_MARKER);

    // The deliberate exception actually happened — the split is proven, not merely "everything omitted".
    expect(serialized).toContain(CITED_MARKER);
    const citedRecord = checkpoint.evidence.find((e) => e.sourceId === cited.sourceId);
    expect(citedRecord?.exactContent).toBe(cited.exactContent);
    expect(sha256Hex(citedRecord?.exactContent ?? '')).toBe(citedRecord?.digest);

    // The contradiction entry itself survives (a bounded, truncated public reason is legitimate
    // content, unlike a secret) — but the marker planted 300+ characters in, past the sanitizer's
    // 240-character bound, is gone: the length bound is what kept the full blob from surviving,
    // not a content-pattern guess about what "looks like" arguments.
    const survivingEntry = checkpoint.contradicted.find((c) => c.candidateId === 'cand-99');
    expect(survivingEntry).toBeDefined();
    expect(survivingEntry?.reason.length).toBeLessThan(argumentBlob.length + ARGUMENT_MARKER.length);
    expect(survivingEntry?.reason).not.toContain(ARGUMENT_MARKER);
  });

  it('CheckpointBuildInput has no field a provider client, model stream, or cancellation token could be assigned to (documented, and enforced by every call site in this file compiling with no such field)', () => {
    // This test is a marker for the structural claim: every `baseInput(...)` call in this file
    // typechecks with exactly the fields `CheckpointBuildInput` declares. There is no
    // `connection`/`cancellation`/`modelSeam`/`askModel` field to omit or smuggle a value into —
    // `tsc --noEmit` over this file is the actual proof; this assertion just keeps the claim
    // pinned to a runnable test rather than only a comment.
    const checkpoint = buildCheckpoint(baseInput(), DEFAULT_HARNESS_POLICY);
    expect(Object.keys(checkpoint).sort()).toEqual(
      [
        'activity',
        'attempt',
        'budget',
        'bytes',
        'candidates',
        'checkpointId',
        'compatible',
        'contradicted',
        'coverage',
        'elapsedMs',
        'evidence',
        'incompatibilityReasons',
        'lineageId',
        'occurredAt',
        'phase',
        'plan',
        'projection',
        'reason',
        'retry',
        'runId',
        'snapshotDigest',
        'unresolved',
      ].sort(),
    );
  });
});

describe('buildCheckpoint (11.3/11.4): activity that cannot legitimately shrink further is reported, not silently dropped', () => {
  it('marks incompatibilityReasons and compatible=false when protected events alone exceed the per-attempt event bound', () => {
    const events = realEvents(
      Array.from({ length: 5 }, (_, i) => ({ kind: 'coverageChanged' as const, coverage: { classified: i, inspected: i } })),
    );
    const tightPolicy = { maxActivityEventsPerAttempt: 2, maxActivityBytesPerAttempt: 1024 * 1024 };
    const checkpoint = buildCheckpoint(baseInput({ activityEvents: events }), tightPolicy);

    expect(checkpoint.compatible).toBe(false);
    expect(checkpoint.incompatibilityReasons.length).toBeGreaterThan(0);
    // Nothing was actually removed — every protected event is still present, truthfully.
    expect(checkpoint.activity).toHaveLength(5);
  });

  it('stays compatible when routine tool-progress coalescing alone brings activity under both bounds', () => {
    const events = realEvents(
      Array.from({ length: 20 }, () => ({ kind: 'toolCompleted' as const, tool: 'readDiff', target: 'file1.ts', summary: '1 unit(s) returned.' })),
    );
    const tightPolicy = { maxActivityEventsPerAttempt: 3, maxActivityBytesPerAttempt: 1024 * 1024 };
    const checkpoint = buildCheckpoint(baseInput({ activityEvents: events }), tightPolicy);

    expect(checkpoint.compatible).toBe(true);
    expect(checkpoint.activity).toHaveLength(1);
  });
});

describe('RetryState parsing (fail-closed)', () => {
  it('accepts a well-formed value and rejects a malformed one', () => {
    expect(isRetryState({ waiting: false, transientAttempts: 0 })).toBe(true);
    expect(parseRetryState({ waiting: true, transientAttempts: 2, lastWaitReason: 'x' })).toEqual({ waiting: true, transientAttempts: 2, lastWaitReason: 'x' });
    expect(parseRetryState({ waiting: 'yes', transientAttempts: 0 })).toBeUndefined();
    expect(parseRetryState({ waiting: false, transientAttempts: -1 })).toBeUndefined();
    expect(parseRetryState({ waiting: false, transientAttempts: 0, lastWaitReason: 42 })).toBeUndefined();
    expect(parseRetryState(null)).toBeUndefined();
    expect(parseRetryState('bogus')).toBeUndefined();
  });
});
