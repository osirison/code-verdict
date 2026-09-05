import { describe, expect, it } from 'vitest';
import {
  buildAttemptDiagnosticsReport,
  buildDiagnosticsNotFoundReport,
  renderAttemptDiagnosticsText,
  renderDiagnosticsNotFoundText,
  type DiagnosticsSourceRecord,
} from './harnessDiagnostics';
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

  it('renders identity, lifecycle, and every section heading for a record with no checkpoint at all — the channel must never come out blank', () => {
    const text = renderAttemptDiagnosticsText(
      buildAttemptDiagnosticsReport(record({ checkpoint: undefined, completionEvaluation: undefined, failure: undefined }), () => '2026-09-03T00:01:00.000Z'),
    );
    expect(text).toContain('run=run-1 lineage=lineage-1 attempt=1');
    expect(text).toContain('lifecycle=failed completeness=none');
    expect(text).toContain('Phase transitions:');
    expect(text).toContain('Coverage:');
    expect(text).toContain('Completion clauses:');
    expect(text).toContain('Blocker details:');
    expect(text).toContain('Limitations:');
    expect(text).toContain('Budget consumption:');
    expect(text).toContain('Unresolved work:');
    expect(text).toContain('Evidence fetched');
    expect(text).toContain('Tool call log:');
    expect(text.trim().length).toBeGreaterThan(0);
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
    expect(text).toContain('(no completion evaluation is available');
    expect(text).toContain('(no budget snapshot was recorded');
    expect(text).toContain('(no checkpoint was recorded for this attempt, so unresolved work is unknown)');
  });

  it('writes the Unresolved work heading even with no checkpoint, never dropping the section outright', () => {
    const text = renderAttemptDiagnosticsText(buildAttemptDiagnosticsReport(record({ checkpoint: undefined, completionEvaluation: undefined }), () => 'now'));
    expect(text).toContain('Unresolved work:');
  });
});

describe('buildDiagnosticsNotFoundReport / renderDiagnosticsNotFoundText: the sibling report for every path that used to write nothing at all', () => {
  const zeroDiscovery = { totalLineageKeys: 0, unparsedLineageKeys: 0, parsedLineages: 0, matchedThisPod: 0, rejected: [] };

  it('tells "no pod connected" apart from every other reason, and never claims a match count it cannot know', () => {
    const report = buildDiagnosticsNotFoundReport(
      { reason: { kind: 'noPodConnected' }, openReviewPanels: 0, discovery: { totalLineageKeys: 3, unparsedLineageKeys: 0, parsedLineages: 3, rejected: [] } },
      () => '2026-09-03T00:00:00.000Z',
    );
    const text = renderDiagnosticsNotFoundText(report);
    expect(text).toContain('generated 2026-09-03T00:00:00.000Z');
    expect(text).toContain('No pod is connected');
    expect(text).toContain('no pod connected');
    expect(text).toContain('total on disk: 3');
    expect(text).toContain('matched this pod: unknown — no pod is connected to match against');
    expect(text.trim().length).toBeGreaterThan(0);
  });

  it('says plainly that nothing has ever run when the disk holds no lineage keys at all', () => {
    const report = buildDiagnosticsNotFoundReport(
      { reason: { kind: 'noMatchingRuns' }, pod: { name: 'Acme pod', providerId: 'fixture', instanceUrl: 'https://example.test' }, openReviewPanels: 1, discovery: zeroDiscovery },
      () => 'now',
    );
    const text = renderDiagnosticsNotFoundText(report);
    expect(text).toContain('No run was found for the active pod.');
    expect(text).toContain('connected as "Acme pod" (fixture @ https://example.test)');
    expect(text).toContain('Review panels open:');
    expect(text).toContain('  1');
    expect(text).toContain('total on disk: 0');
    expect(text).toContain('matched this pod: 0');
  });

  it('names every rejected lineage and why, so "runs exist but none matched" is never bare numbers', () => {
    const report = buildDiagnosticsNotFoundReport(
      {
        reason: { kind: 'noMatchingRuns' },
        pod: { name: 'Acme pod', providerId: 'fixture', instanceUrl: 'https://example.test' },
        openReviewPanels: 0,
        discovery: {
          totalLineageKeys: 4,
          unparsedLineageKeys: 1,
          parsedLineages: 3,
          matchedThisPod: 0,
          rejected: [
            { lineageId: 'lineage-a', rejection: { kind: 'notThisPod' } },
            { lineageId: 'lineage-b', rejection: { kind: 'noSnapshots' } },
            { lineageId: 'lineage-c', rejection: { kind: 'incompleteAttempt', targetKey: 'repo-1!42', refLabel: '!42', attempt: 2 } },
          ],
        },
      },
      () => 'now',
    );
    const text = renderDiagnosticsNotFoundText(report);
    expect(text).toContain('failed to parse: 1');
    expect(text).toContain('lineage-a — belongs to a different pod\'s target');
    expect(text).toContain('lineage-b — every attempt has been evicted');
    expect(text).toContain('lineage-c — !42 (attempt 2) crashed before its first checkpoint');
  });

  it('writes a line for a dismissed picker, listing what was offered, rather than returning silently', () => {
    const report = buildDiagnosticsNotFoundReport(
      {
        reason: {
          kind: 'pickerDismissed',
          offered: [
            { targetKey: 'repo-1!42', refLabel: '!42', lineageId: 'lineage-1', attempt: 1, lifecycle: 'failed', completeness: 'none', occurredAt: '2026-09-01T00:00:00.000Z', record: record() },
          ],
        },
        pod: { name: 'Acme pod', providerId: 'fixture', instanceUrl: 'https://example.test' },
        openReviewPanels: 1,
        discovery: { ...zeroDiscovery, totalLineageKeys: 1, parsedLineages: 1, matchedThisPod: 1 },
      },
      () => 'now',
    );
    const text = renderDiagnosticsNotFoundText(report);
    expect(text).toContain('The run picker was dismissed without a choice.');
    expect(text).toContain('Runs offered — none chosen:');
    expect(text).toContain('!42 — failed (none) — ran 2026-09-01T00:00:00.000Z');
  });

  it('never carries raw model text, prompts, or hidden reasoning in the not-found report either', () => {
    const report = buildDiagnosticsNotFoundReport({ reason: { kind: 'noPodConnected' }, openReviewPanels: 0, discovery: zeroDiscovery }, () => 'now');
    const text = renderDiagnosticsNotFoundText(report);
    expect(text.toLowerCase()).not.toContain('prompt');
    expect(text.toLowerCase()).not.toContain('rationale');
  });
});
