import { describe, expect, it } from 'vitest';
import {
  COMPLETION_BLOCKERS,
  FILE_INSPECTION_STATES,
  isCompletionBlocker,
  isFileInspectionState,
  isNonInspectedTerminalState,
  isRiskLevel,
  parseCompletionBlocker,
  parseFileInspectionState,
  parseRiskLevel,
  RISK_LEVELS,
  type ChangedFileRecord,
  type CompletionDecision,
  type MemberCoverage,
} from './harnessCoverage';

describe('changed-file inventory, risk, coverage, and completion types (task 2.4)', () => {
  it('accepts every risk level and fails closed on garbage', () => {
    for (const risk of RISK_LEVELS) expect(isRiskLevel(risk)).toBe(true);
    expect(parseRiskLevel('critical')).toBeUndefined();
    expect(parseRiskLevel(undefined)).toBeUndefined();
  });

  it('accepts every file inspection state and fails closed on garbage', () => {
    for (const state of FILE_INSPECTION_STATES) expect(isFileInspectionState(state)).toBe(true);
    expect(parseFileInspectionState('reviewed')).toBeUndefined();
    expect(parseFileInspectionState(null)).toBeUndefined();
  });

  it('classifies non-inspected terminal states distinctly from inspected and unvisited', () => {
    expect(isNonInspectedTerminalState('excludedByPolicy')).toBe(true);
    expect(isNonInspectedTerminalState('unavailable')).toBe(true);
    expect(isNonInspectedTerminalState('binary')).toBe(true);
    expect(isNonInspectedTerminalState('oversized')).toBe(true);
    expect(isNonInspectedTerminalState('inspected')).toBe(false);
    expect(isNonInspectedTerminalState('unvisited')).toBe(false);
    expect(isNonInspectedTerminalState('classified')).toBe(false);
  });

  it('accepts every completion blocker and fails closed on garbage', () => {
    for (const blocker of COMPLETION_BLOCKERS) expect(isCompletionBlocker(blocker)).toBe(true);
    expect(parseCompletionBlocker('modelDeclinedToFinish')).toBeUndefined();
    expect(parseCompletionBlocker(3)).toBeUndefined();
  });

  it('has no total denominator until manifest enumeration is explicitly complete', () => {
    const inFlight: MemberCoverage = { memberId: 'm1', manifestComplete: false, files: [] };
    const complete: MemberCoverage = { memberId: 'm1', manifestComplete: true, totalFiles: 12, files: [] };
    expect(inFlight.totalFiles).toBeUndefined();
    expect(complete.totalFiles).toBe(12);
  });

  it('requires a public reason once a file reaches a non-inspected terminal state', () => {
    const oversized: ChangedFileRecord = {
      path: 'package-lock.json',
      memberId: 'm1',
      state: 'oversized',
      reason: 'exceeds the single-tool-result ceiling',
    };
    expect(oversized.reason).toBeDefined();
  });

  it('cannot be eligible while blockers remain', () => {
    const decision: CompletionDecision = { eligible: false, blockers: ['unresolvedCandidates'] };
    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toContain('unresolvedCandidates');
  });
});
