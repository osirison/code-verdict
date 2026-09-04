/**
 * A metadata-only diagnostic view of one harness attempt — the record the reviewer needs to debug
 * a run that failed with no obvious reason (the real complaint this module exists to answer: "no
 * findings, `insufficientRiskCoverage`, and nothing useful in the debug console"). House style of
 * `apiTrace.ts`'s `codeVerdict.showApiTrace`: an output-channel view plus a JSON export, built
 * entirely from state other modules already computed and already sanitized — never a second
 * implementation of any of it.
 *
 * **What this is not.** It carries no prompt, no raw model reply, no hidden reasoning, no secret,
 * and no full tool payload — a view of what the harness *did*, never a transcript of what it *said*
 * or was *told*. Concretely:
 * - `RunRecord.checkpoint.activityLog` (`harnessAttempt.ts`'s `CheckpointInfo`, `harnessActivityLog.ts`)
 *   is already `appendActivityEvent`'s own sanitized, bounded text — every phase transition and
 *   tool-call summary/failure-reason this report reads comes from there, untouched.
 * - `checkpoint.evidenceSources` (`harnessEvidenceLedger.ts`'s `LedgerEvidenceSource`) carries only
 *   identity, member, origin, and byte length — this module never reads `exactContent`.
 * - `RunRecord.completionEvaluation` is `evaluateCompletion`'s own deterministic host verdict
 *   (`harnessCompletion.ts`) — no model text reaches it, and this module recomputes none of it.
 *
 * Everything here is read, never re-derived: no second completion predicate, no second coverage
 * count, no second budget accounting.
 */
import type { ActivityEvent, Limitation } from '../domain/harnessActivity';
import type { BudgetConsumption, MemberCoverage, UnresolvedWork } from '../domain/harnessCoverage';
import type { ResultCompleteness, RunLifecycle } from '../domain/harnessLifecycle';
import { COMPLETION_CLAUSES, type CompletionBlockerDetail, type CompletionClause, type CompletionEvaluation } from './harnessCompletion';
import type { RunRecord } from './reviewRunManager';

/**
 * Only the fields this module actually reads off a `RunRecord` — narrowed the same way
 * `harnessRunStore.ts`'s own `RetentionPolicy` narrows `HarnessPolicy`, so a test can build one
 * without a full `RunRecord` fixture, and this module's own dependency on the manager stays
 * exactly as wide as what it uses.
 */
export type DiagnosticsSourceRecord = Pick<
  RunRecord,
  'runId' | 'lineageId' | 'attempt' | 'lifecycle' | 'completeness' | 'checkpoint' | 'completionEvaluation' | 'limitations' | 'failure'
>;

export interface DiagnosticsPhaseTransition {
  readonly phase: string;
  readonly occurredAt: string;
}

export interface DiagnosticsToolCall {
  /** The activity log's own monotonic sequence number — never recomputed. */
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: string;
  readonly tool: string;
  readonly target?: string;
  readonly outcome: 'completed' | 'failed';
  /** `toolCompleted`'s own sanitized summary, or `toolFailed`'s own sanitized reason — verbatim. */
  readonly detail: string;
}

export interface DiagnosticsEvidenceEntry {
  /** The ledger's own append-order sequence for this source — never recomputed. */
  readonly sequence: number;
  readonly memberId: string;
  readonly origin: string;
  readonly path?: string;
  readonly byteLength: number;
}

export interface DiagnosticsClause {
  readonly clause: CompletionClause;
  readonly passed: boolean;
}

export interface AttemptDiagnosticsReport {
  readonly generatedAt: string;
  readonly runId: string;
  readonly lineageId: string;
  readonly attempt: number;
  readonly lifecycle: RunLifecycle;
  readonly completeness: ResultCompleteness;
  readonly phaseTransitions: readonly DiagnosticsPhaseTransition[];
  readonly coverage: readonly MemberCoverage[];
  /** Absent only when no `evaluateCompletion` verdict was ever recorded for this attempt (a bootstrap failure ended it first). */
  readonly completionClauses?: readonly DiagnosticsClause[];
  readonly blockerDetails: readonly CompletionBlockerDetail[];
  readonly limitations: readonly Limitation[];
  /** Absent before the attempt's first checkpoint. */
  readonly budget?: BudgetConsumption;
  readonly unresolved?: UnresolvedWork;
  readonly evidenceFetched: readonly DiagnosticsEvidenceEntry[];
  readonly toolCalls: readonly DiagnosticsToolCall[];
}

function phaseTransitionsFrom(events: readonly ActivityEvent[]): readonly DiagnosticsPhaseTransition[] {
  const out: DiagnosticsPhaseTransition[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (!last || last.phase !== event.phase) out.push({ phase: event.phase, occurredAt: event.occurredAt });
  }
  return out;
}

function toolCallsFrom(events: readonly ActivityEvent[]): readonly DiagnosticsToolCall[] {
  const out: DiagnosticsToolCall[] = [];
  for (const event of events) {
    if (event.kind === 'toolCompleted') {
      out.push({ sequence: event.sequence, occurredAt: event.occurredAt, phase: event.phase, tool: event.tool, target: event.target, outcome: 'completed', detail: event.summary });
    } else if (event.kind === 'toolFailed') {
      out.push({ sequence: event.sequence, occurredAt: event.occurredAt, phase: event.phase, tool: event.tool, target: event.target, outcome: 'failed', detail: event.reason });
    }
  }
  return out;
}

function clausesFrom(evaluation: CompletionEvaluation | undefined): readonly DiagnosticsClause[] | undefined {
  if (!evaluation) return undefined;
  return COMPLETION_CLAUSES.map((clause) => ({ clause, passed: evaluation.clauses[clause] }));
}

/** Builds the report from a live `RunRecord` — never from a re-fetch, never from re-running any evaluator. */
export function buildAttemptDiagnosticsReport(record: DiagnosticsSourceRecord, now: () => string): AttemptDiagnosticsReport {
  const checkpoint = record.checkpoint;
  const events = checkpoint?.activityLog.events ?? [];
  return {
    generatedAt: now(),
    runId: record.runId,
    lineageId: record.lineageId,
    attempt: record.attempt,
    lifecycle: record.lifecycle,
    completeness: record.completeness,
    phaseTransitions: phaseTransitionsFrom(events),
    coverage: checkpoint?.coverage ?? [],
    completionClauses: clausesFrom(record.completionEvaluation),
    blockerDetails: record.completionEvaluation?.details ?? record.failure?.blockerDetails ?? [],
    limitations: record.limitations,
    budget: checkpoint?.budget,
    unresolved: checkpoint?.unresolved,
    evidenceFetched: (checkpoint?.evidenceSources ?? []).map((source) => ({
      sequence: source.sequence,
      memberId: source.memberId,
      origin: source.origin,
      path: source.path,
      byteLength: source.byteLength,
    })),
    toolCalls: toolCallsFrom(events),
  };
}

function section(lines: string[], title: string, body: readonly string[]): void {
  lines.push(`${title}:`);
  if (body.length === 0) lines.push('  (none)');
  else for (const line of body) lines.push(`  ${line}`);
  lines.push('');
}

/** The output-channel rendering — plain lines, house style of `apiTrace.ts`. */
export function renderAttemptDiagnosticsText(report: AttemptDiagnosticsReport): string {
  const lines: string[] = [];
  lines.push(`Verdict run diagnostics — generated ${report.generatedAt}`);
  lines.push(`run=${report.runId} lineage=${report.lineageId} attempt=${report.attempt}`);
  lines.push(`lifecycle=${report.lifecycle} completeness=${report.completeness}`);
  lines.push('');

  section(lines, 'Phase transitions', report.phaseTransitions.map((t) => `${t.occurredAt}  ${t.phase}`));

  const coverageLines: string[] = [];
  for (const member of report.coverage) {
    coverageLines.push(`member ${member.memberId} — manifest ${member.manifestComplete ? 'complete' : 'incomplete'}${member.totalFiles !== undefined ? ` (${member.totalFiles} known)` : ''}`);
    for (const file of member.files) {
      const risk = file.risk ? ` risk=${file.risk}` : '';
      const reason = file.reason ? ` — ${file.reason}` : '';
      coverageLines.push(`  ${file.path}  state=${file.state}${risk}${reason}`);
    }
  }
  section(lines, 'Coverage', coverageLines);

  if (report.completionClauses) {
    section(lines, 'Completion clauses', report.completionClauses.map((c) => `${c.passed ? 'PASS' : 'FAIL'}  ${c.clause}`));
  } else {
    section(lines, 'Completion clauses', ['(no completion evaluation was recorded — the attempt ended before host validation ran)']);
  }

  section(
    lines,
    'Blocker details',
    report.blockerDetails.map((d) => `[${d.blocker}${d.path ? ` ${d.path}` : ''}${d.memberId ? ` member=${d.memberId}` : ''}] ${d.message}${d.repairable ? '' : ' (not repairable)'}`),
  );

  section(lines, 'Limitations', report.limitations.map((l) => `${l.code}: ${l.message}`));

  if (report.budget) {
    section(lines, 'Budget consumption', [
      `model turns used: ${report.budget.modelTurnsUsed}`,
      `tool calls used: ${report.budget.toolCallsUsed}`,
      `evidence bytes used: ${report.budget.evidenceBytesUsed}`,
      `elapsed ms: ${report.budget.elapsedMs}`,
      `high-risk reserve drawn: ${report.budget.highRiskReserveUsed}`,
      `verification reserve drawn: ${report.budget.verificationReserveUsed}`,
    ]);
  } else {
    section(lines, 'Budget consumption', ['(no budget snapshot was recorded for this attempt)']);
  }

  if (report.unresolved) {
    section(lines, 'Unresolved work', [
      `unresolved fetches: ${report.unresolved.unresolvedFetches}`,
      `unresolved candidates: ${report.unresolved.unresolvedCandidates}`,
    ]);
  }

  section(
    lines,
    'Evidence fetched (citable sources only — byte counts, never content)',
    report.evidenceFetched.map((ev) => `[#${ev.sequence}] member=${ev.memberId} origin=${ev.origin}${ev.path ? ` path=${ev.path}` : ''} bytes=${ev.byteLength}`),
  );

  section(
    lines,
    'Tool call log',
    report.toolCalls.map((call) => `[#${call.sequence}] ${call.occurredAt} phase=${call.phase} tool=${call.tool}${call.target ? ` target=${call.target}` : ''} outcome=${call.outcome} — ${call.detail}`),
  );

  return lines.join('\n').trimEnd();
}
