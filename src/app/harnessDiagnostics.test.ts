import { describe, expect, it } from 'vitest';
import { buildAttemptDiagnosticsReport, renderAttemptDiagnosticsText, type DiagnosticsSourceRecord } from './harnessDiagnostics';
import { appendActivityEvent, createActivityLog, type ActivityLog } from './harnessActivityLog';
import type { CheckpointInfo } from './harnessAttempt';
import { COMPLETION_CLAUSES, type CompletionEvaluation } from './harnessCompletion';
import type { LedgerEvidenceSource } from './harnessEvidenceLedger';

const RUN_ID = 'run-1';
const LINEAGE_ID = 'lineage-1';
const ATTEMPT = 1;

function activityLogWithEvents(): ActivityLog {
  let log = createActivityLog(RUN_ID, LINEAGE_ID, ATTEMPT);
  const at = (offsetMs: number) => ({ occurredAt: new Date(2026, 8, 3, 0, 0, 0, offsetMs).toISOString(), elapsedMs: offsetMs });
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Assembling bootstrap and the changed-file inventory.' }, { ...at(0), phase: 'bootstrap' });
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Planning the review.' }, { ...at(10), phase: 'planning' });
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Investigating changed files.' }, { ...at(20), phase: 'investigating' });
  log = appendActivityEvent(log, { kind: 'toolCompleted', tool: 'readDiff', target: 'src/auth/token.ts', summary: '1 unit(s) returned.' }, { ...at(30), phase: 'investigating' });
  log = appendActivityEvent(log, { kind: 'toolFailed', tool: 'readDiff', target: 'src/big.bin', reason: 'The content is binary.' }, { ...at(40), phase: 'investigating' });
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Synthesizing and verifying findings.' }, { ...at(50), phase: 'verifying' });
  log = appendActivityEvent(
    log,
    { kind: 'terminalResult', lifecycle: 'failed', completeness: 'none', limitations: [{ code: 'insufficientRiskCoverage', message: 'Files at a risk level that requires inspection were not inspected.' }] },
    { ...at(60), phase: 'persisting' },
  );
  return log;
}

function evidenceSource(overrides: Partial<LedgerEvidenceSource> = {}): LedgerEvidenceSource {
  return {
    sourceId: 'src-1',
    digest: 'digest-1',
    kind: 'diff',
    repositoryId: 'repo-1',
    baseSha: 'base',
    headSha: 'head',
    completeness: 'complete',
    citable: true,
    // Present only because the type requires it — `buildAttemptDiagnosticsReport` must never read
    // this field (the "never a full tool payload" constraint); a test asserting exactly that
    // appears below.
    exactContent: 'RAW CONTENT THAT MUST NEVER REACH THE DIAGNOSTICS REPORT',
    runId: RUN_ID,
    lineageId: LINEAGE_ID,
    attempt: ATTEMPT,
    memberId: 'm1',
    origin: 'diffPage',
    trust: 'untrusted',
    sequence: 1,
    locations: [],
    byteLength: 512,
    path: 'src/auth/token.ts',
    ...overrides,
  };
}

function baseCheckpoint(overrides: Partial<CheckpointInfo> = {}): CheckpointInfo {
  return {
    checkpointId: 'ckpt-1',
    runId: RUN_ID,
    lineageId: LINEAGE_ID,
    attempt: ATTEMPT,
    phase: 'persisting',
    reason: 'phaseBoundary',
    occurredAt: '2026-09-03T00:00:00.060Z',
    elapsedMs: 60,
    activityLog: activityLogWithEvents(),
    evidenceSources: [evidenceSource()],
    candidates: [],
    contradicted: [],
    budget: { modelTurnsUsed: 3, toolCallsUsed: 5, evidenceBytesUsed: 512, elapsedMs: 60, highRiskReserveUsed: 1, verificationReserveUsed: 0 },
    coverage: [
      {
        memberId: 'm1',
        manifestComplete: true,
        totalFiles: 2,
        files: [
          { path: 'src/auth/token.ts', memberId: 'm1', state: 'inspected', risk: 'high' },
          { path: 'src/other.ts', memberId: 'm1', state: 'classified', risk: 'high' },
        ],
      },
    ],
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    ...overrides,
  };
}

function failingEvaluation(): CompletionEvaluation {
  const clauses = Object.fromEntries(COMPLETION_CLAUSES.map((clause) => [clause, clause !== 'configuredRiskCoverageSatisfied'])) as CompletionEvaluation['clauses'];
  return {
    eligible: false,
    blockers: ['insufficientRiskCoverage'],
    clauses,
    details: [
      { blocker: 'insufficientRiskCoverage', clause: 'configuredRiskCoverageSatisfied', memberId: 'm1', path: 'src/other.ts', message: 'src/other.ts (high risk) was classified but never inspected.', repairable: true },
    ],
    repairable: true,
  };
}

function record(overrides: Partial<DiagnosticsSourceRecord> = {}): DiagnosticsSourceRecord {
  return {
    runId: RUN_ID,
    lineageId: LINEAGE_ID,
    attempt: ATTEMPT,
    lifecycle: 'failed',
    completeness: 'none',
    checkpoint: baseCheckpoint(),
    completionEvaluation: failingEvaluation(),
    limitations: [{ code: 'insufficientRiskCoverage', message: 'Files at a risk level that requires inspection were not inspected.' }],
    failure: { message: 'Files at a risk level that requires inspection were not inspected.', requestId: '------', code: 'insufficientRiskCoverage' },
    ...overrides,
  };
}

describe('buildAttemptDiagnosticsReport', () => {
  it('carries identity, lifecycle, and completeness straight from the record', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => '2026-09-03T00:01:00.000Z');
    expect(report.generatedAt).toBe('2026-09-03T00:01:00.000Z');
    expect(report.runId).toBe(RUN_ID);
    expect(report.lineageId).toBe(LINEAGE_ID);
    expect(report.attempt).toBe(ATTEMPT);
    expect(report.lifecycle).toBe('failed');
    expect(report.completeness).toBe('none');
  });

  it('lists every phase transition, in order, from the activity log alone', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.phaseTransitions.map((t) => t.phase)).toEqual(['bootstrap', 'planning', 'investigating', 'verifying', 'persisting']);
  });

  it('reports every completion clause pass/fail, reusing evaluateCompletion\'s own verdict without recomputing it', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.completionClauses).toBeDefined();
    expect(report.completionClauses!.find((c) => c.clause === 'configuredRiskCoverageSatisfied')?.passed).toBe(false);
    expect(report.completionClauses!.filter((c) => c.clause !== 'configuredRiskCoverageSatisfied').every((c) => c.passed)).toBe(true);
    expect(report.completionClauses).toHaveLength(COMPLETION_CLAUSES.length);
  });

  it('names the specific blocked file, not just that some file is blocked', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.blockerDetails).toHaveLength(1);
    expect(report.blockerDetails[0]?.path).toBe('src/other.ts');
  });

  it('reports per-file coverage state and risk for every member', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.coverage).toHaveLength(1);
    expect(report.coverage[0]?.files.map((f) => ({ path: f.path, state: f.state }))).toEqual([
      { path: 'src/auth/token.ts', state: 'inspected' },
      { path: 'src/other.ts', state: 'classified' },
    ]);
  });

  it('reports budget consumption and which reserves were drawn on', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.budget).toEqual({ modelTurnsUsed: 3, toolCallsUsed: 5, evidenceBytesUsed: 512, elapsedMs: 60, highRiskReserveUsed: 1, verificationReserveUsed: 0 });
  });

  it('lists every tool call with its result state and sanitized failure reason, and every evidence fetch with its byte count — never the content itself', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    expect(report.toolCalls.map((c) => ({ tool: c.tool, target: c.target, outcome: c.outcome }))).toEqual([
      { tool: 'readDiff', target: 'src/auth/token.ts', outcome: 'completed' },
      { tool: 'readDiff', target: 'src/big.bin', outcome: 'failed' },
    ]);
    expect(report.toolCalls.find((c) => c.outcome === 'failed')?.detail).toBe('The content is binary.');
    expect(report.evidenceFetched).toEqual([{ sequence: 1, memberId: 'm1', origin: 'diffPage', path: 'src/auth/token.ts', byteLength: 512 }]);
  });

  it('has no completion clauses and no budget when the attempt never reached a checkpoint (a bootstrap failure)', () => {
    const report = buildAttemptDiagnosticsReport(record({ checkpoint: undefined, completionEvaluation: undefined }), () => 'now');
    expect(report.completionClauses).toBeUndefined();
    expect(report.budget).toBeUndefined();
    expect(report.phaseTransitions).toEqual([]);
    expect(report.coverage).toEqual([]);
    expect(report.toolCalls).toEqual([]);
    expect(report.evidenceFetched).toEqual([]);
    // The generic limitation still carries through even with no checkpoint.
    expect(report.limitations).toHaveLength(1);
  });
});

describe('renderAttemptDiagnosticsText', () => {
  it('renders every required section, naming the specific file behind the generic failure', () => {
    const text = renderAttemptDiagnosticsText(buildAttemptDiagnosticsReport(record(), () => '2026-09-03T00:01:00.000Z'));
    expect(text).toContain('run=run-1 lineage=lineage-1 attempt=1');
    expect(text).toContain('lifecycle=failed completeness=none');
    expect(text).toContain('Phase transitions:');
    expect(text).toContain('investigating');
    expect(text).toContain('Coverage:');
    expect(text).toContain('src/other.ts');
    expect(text).toContain('Completion clauses:');
    expect(text).toContain('FAIL  configuredRiskCoverageSatisfied');
    expect(text).toContain('Blocker details:');
    expect(text).toContain('src/other.ts (high risk) was classified but never inspected.');
    expect(text).toContain('Budget consumption:');
    expect(text).toContain('high-risk reserve drawn: 1');
    expect(text).toContain('Tool call log:');
    expect(text).toContain('The content is binary.');
    expect(text).toContain('Evidence fetched');
    expect(text).toContain('bytes=512');
  });

  it('never carries the full fetched content of an evidence source — only its byte count', () => {
    const report = buildAttemptDiagnosticsReport(record(), () => 'now');
    const text = renderAttemptDiagnosticsText(report);
    expect(JSON.stringify(report)).not.toContain('RAW CONTENT THAT MUST NEVER REACH THE DIAGNOSTICS REPORT');
    expect(text).not.toContain('RAW CONTENT THAT MUST NEVER REACH THE DIAGNOSTICS REPORT');
  });

  it('never carries raw model text, prompts, or hidden reasoning — only bounded, deterministic host-produced fields exist on the report at all', () => {
    const text = renderAttemptDiagnosticsText(buildAttemptDiagnosticsReport(record(), () => 'now'));
    // The report has no field capable of carrying a prompt or model reply (verified structurally
    // by this module's own types), so this asserts the rendered text stays within what those
    // fields can produce: no field named after a prompt/response/reasoning concept.
    expect(text.toLowerCase()).not.toContain('prompt');
    expect(text.toLowerCase()).not.toContain('rationale');
  });

  it('says plainly when there is nothing to report in a section, rather than an empty block', () => {
    const text = renderAttemptDiagnosticsText(buildAttemptDiagnosticsReport(record({ checkpoint: undefined, completionEvaluation: undefined, limitations: [] }), () => 'now'));
    expect(text).toContain('(no completion evaluation was recorded');
    expect(text).toContain('(no budget snapshot was recorded');
  });
});
