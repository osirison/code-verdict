import { describe, expect, it } from 'vitest';
import {
  LEGACY_CHANGESET_DRAFT,
  LEGACY_RETAINED_CLEAN,
  LEGACY_RETAINED_PRE_RESULT_FIELDS,
  LEGACY_RETAINED_SUBMITTED,
  LEGACY_RETAINED_TRIAGE_DRAFT,
  LEGACY_RUN_HISTORY,
} from '../app/migrationFixtures';
import { parseRunLifecycle, parseResultCompleteness } from './harnessLifecycle';
import { parsePlanItemState, parseRunPhase } from './harnessActivity';
import { parseCompletionBlocker, parseFileInspectionState, parseRiskLevel } from './harnessCoverage';
import {
  parseCandidateValidationState,
  parseEvidenceCompleteness,
  parseEvidenceKind,
  parseProtocolProvenance,
} from './harnessEvidence';
import { readLegacyReview, readLegacyRunHistory } from './harnessMigration';

describe('legacy reads never fabricate plan, evidence, or coverage (task 2.7)', () => {
  it.each([
    ['clean run', LEGACY_RETAINED_CLEAN],
    ['unsubmitted triage draft', LEGACY_RETAINED_TRIAGE_DRAFT],
    ['submitted draft', LEGACY_RETAINED_SUBMITTED],
    ['pre-RetainedResult-fields draft', LEGACY_RETAINED_PRE_RESULT_FIELDS],
    ['changeset draft', LEGACY_CHANGESET_DRAFT],
  ])('reads the %s as complete under legacy-one-shot provenance with no other fields', (_label, fixture) => {
    const read = readLegacyReview(fixture.review);
    expect(read.completeness).toBe('complete');
    expect(read.protocolProvenance).toBe('legacy-one-shot');
    expect(read.crNumber).toBe(fixture.review.crNumber);
    // Exactly these four fields — no `plan`, `evidence`, or `coverage` key exists to fabricate.
    expect(Object.keys(read).sort()).toEqual(['completeness', 'crNumber', 'protocolProvenance', 'repoId'].sort());
  });

  it('reads run-history findings and clean outcomes as complete under legacy-one-shot provenance', () => {
    const findings = LEGACY_RUN_HISTORY.find((run) => run.outcome === 'findings')!;
    const clean = LEGACY_RUN_HISTORY.find((run) => run.outcome === 'clean')!;
    expect(readLegacyRunHistory(findings)).toEqual({ completeness: 'complete', protocolProvenance: 'legacy-one-shot' });
    expect(readLegacyRunHistory(clean)).toEqual({ completeness: 'complete', protocolProvenance: 'legacy-one-shot' });
  });

  it('reads a run-history interruption as completeness none with no protocol to attribute', () => {
    const interrupted = LEGACY_RUN_HISTORY.find((run) => run.outcome === 'interrupted')!;
    const read = readLegacyRunHistory(interrupted);
    expect(read.completeness).toBe('none');
    expect(read.protocolProvenance).toBeUndefined();
  });
});

describe('every new persisted enum fails closed together (task 2.7)', () => {
  it('rejects an unknown or malformed value for every new enum in one malformed persisted record', () => {
    const persisted = JSON.parse(
      JSON.stringify({
        lifecycle: 'executing',
        completeness: 'done',
        planItemState: 'in-progress',
        runPhase: 'reasoning',
        riskLevel: 'critical',
        fileInspectionState: 'reviewed',
        completionBlocker: 'modelDeclinedToFinish',
        evidenceKind: 'log',
        evidenceCompleteness: 'unknown',
        candidateValidationState: 'pending',
        protocolProvenance: 'one-shot',
      }),
    ) as Record<string, unknown>;

    expect(parseRunLifecycle(persisted.lifecycle)).toBeUndefined();
    expect(parseResultCompleteness(persisted.completeness)).toBeUndefined();
    expect(parsePlanItemState(persisted.planItemState)).toBeUndefined();
    expect(parseRunPhase(persisted.runPhase)).toBeUndefined();
    expect(parseRiskLevel(persisted.riskLevel)).toBeUndefined();
    expect(parseFileInspectionState(persisted.fileInspectionState)).toBeUndefined();
    expect(parseCompletionBlocker(persisted.completionBlocker)).toBeUndefined();
    expect(parseEvidenceKind(persisted.evidenceKind)).toBeUndefined();
    expect(parseEvidenceCompleteness(persisted.evidenceCompleteness)).toBeUndefined();
    expect(parseCandidateValidationState(persisted.candidateValidationState)).toBeUndefined();
    expect(parseProtocolProvenance(persisted.protocolProvenance)).toBeUndefined();
  });

  it('rejects missing, null, and non-string persisted values the same way as an unknown string', () => {
    for (const bogus of [undefined, null, 42, {}, []]) {
      expect(parseRunLifecycle(bogus)).toBeUndefined();
      expect(parseResultCompleteness(bogus)).toBeUndefined();
      expect(parseProtocolProvenance(bogus)).toBeUndefined();
    }
  });

  it('still accepts every legitimate value in the same mixed persisted record', () => {
    const persisted = JSON.parse(
      JSON.stringify({
        lifecycle: 'investigating',
        completeness: 'partial',
        planItemState: 'active',
        runPhase: 'verifying',
        riskLevel: 'high',
        fileInspectionState: 'oversized',
        completionBlocker: 'unresolvedCandidates',
        evidenceKind: 'attachment',
        evidenceCompleteness: 'truncated',
        candidateValidationState: 'repairable',
        protocolProvenance: 'legacy-one-shot',
      }),
    ) as Record<string, unknown>;

    expect(parseRunLifecycle(persisted.lifecycle)).toBe('investigating');
    expect(parseResultCompleteness(persisted.completeness)).toBe('partial');
    expect(parsePlanItemState(persisted.planItemState)).toBe('active');
    expect(parseRunPhase(persisted.runPhase)).toBe('verifying');
    expect(parseRiskLevel(persisted.riskLevel)).toBe('high');
    expect(parseFileInspectionState(persisted.fileInspectionState)).toBe('oversized');
    expect(parseCompletionBlocker(persisted.completionBlocker)).toBe('unresolvedCandidates');
    expect(parseEvidenceKind(persisted.evidenceKind)).toBe('attachment');
    expect(parseEvidenceCompleteness(persisted.evidenceCompleteness)).toBe('truncated');
    expect(parseCandidateValidationState(persisted.candidateValidationState)).toBe('repairable');
    expect(parseProtocolProvenance(persisted.protocolProvenance)).toBe('legacy-one-shot');
  });
});
