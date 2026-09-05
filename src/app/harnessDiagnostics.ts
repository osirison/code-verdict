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
// Type-only, so this stays the one-directional dependency `harnessDiagnosticsSource.ts`'s own file
// header already documents the reverse of (it imports this module's `DiagnosticsSourceRecord`) —
// erased entirely at build time, never a runtime cycle. Reused rather than re-declared: the
// not-found report's discovery counts and rejection reasons are exactly what that module already
// computes, and a second copy of `DiagnosticsLineageRejection`'s union here could drift from it.
import type { DiagnosticsCandidate, DiagnosticsDiscoverySummary, DiagnosticsLineageRejection } from './harnessDiagnosticsSource';
import type { RunRecord } from './reviewRunManager';

/**
 * Everything this module reads off one evidence source, whether it comes from a live attempt's
 * `LedgerEvidenceSource` (`CheckpointInfo.evidenceSources`) or is rebuilt from a persisted
 * `RetainedEvidenceRecord` (`harnessDiagnosticsSource.ts`, which has no stored `sequence`/
 * `byteLength` — see that module's own doc comment on why both are recomputed or left unknown
 * there rather than fabricated). `byteLength` is optional for exactly that reason: the live path
 * always has it, the persisted path never does.
 */
export interface DiagnosticsEvidenceSource {
  readonly sequence: number;
  readonly memberId: string;
  readonly origin: string;
  readonly path?: string;
  readonly byteLength?: number;
}

/**
 * The slice of a checkpoint this module actually reads — satisfied structurally by a live
 * `CheckpointInfo` (`harnessAttempt.ts`) as-is, and by a small adapter over a persisted
 * `PersistedCheckpoint` (`harnessDiagnosticsSource.ts`) once a review has ended and no panel
 * holds the live record anymore. Never a second copy of either shape — this is the one seam both
 * feed through.
 */
export interface DiagnosticsCheckpointSource {
  readonly activityLog: { readonly events: readonly ActivityEvent[] };
  readonly coverage: readonly MemberCoverage[];
  readonly budget: BudgetConsumption;
  readonly unresolved: UnresolvedWork;
  readonly evidenceSources: readonly DiagnosticsEvidenceSource[];
}

/**
 * Only the fields this module actually reads off a `RunRecord` — narrowed the same way
 * `harnessRunStore.ts`'s own `RetentionPolicy` narrows `HarnessPolicy`, so a test can build one
 * without a full `RunRecord` fixture, and this module's own dependency on the manager stays
 * exactly as wide as what it uses. `checkpoint` is widened from `RunRecord`'s own
 * `CheckpointInfo | undefined` to `DiagnosticsCheckpointSource | undefined` (a live `CheckpointInfo`
 * satisfies it unchanged) so a caller reconstructing a settled attempt from `HarnessRunStore` alone
 * — no live record anywhere — can still hand this builder something real.
 */
export type DiagnosticsSourceRecord = Omit<
  Pick<RunRecord, 'runId' | 'lineageId' | 'attempt' | 'lifecycle' | 'completeness' | 'checkpoint' | 'completionEvaluation' | 'limitations' | 'failure'>,
  'checkpoint'
> & {
  readonly checkpoint?: DiagnosticsCheckpointSource;
};

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
  /** The ledger's own append-order sequence for this source — never recomputed on the live path; recomputed from array order on the persisted path (see `DiagnosticsEvidenceSource`). */
  readonly sequence: number;
  readonly memberId: string;
  readonly origin: string;
  readonly path?: string;
  /** Absent only when rebuilt from a persisted checkpoint, which never retained a byte count — unknown, never fabricated as zero. */
  readonly byteLength?: number;
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
  /** Absent when no `evaluateCompletion` verdict is available for this attempt — either none was ever recorded (a bootstrap failure ended it first) or one ran but was never persisted (a report rebuilt from `HarnessRunStore` alone, once no live record survives). Never asserts which one happened. */
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

/** Exported so `renderDiagnosticsNotFoundText` below shares the exact same section layout, rather than a second one. */
export function section(lines: string[], title: string, body: readonly string[]): void {
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
    // True whether the attempt genuinely never reached host validation (a bootstrap failure) or it
    // did and the clause-by-clause verdict simply was not persisted (a report rebuilt from
    // `HarnessRunStore` alone, once no live record survives) — never asserts which one happened.
    section(lines, 'Completion clauses', ['(no completion evaluation is available for this attempt)']);
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
  } else {
    // Was missing entirely (no `else`) until this pass — the one section a checkpoint-less record
    // silently dropped instead of naming, which is exactly the "channel came out blank" failure mode
    // this module exists to rule out. Every section heading now always writes.
    section(lines, 'Unresolved work', ['(no checkpoint was recorded for this attempt, so unresolved work is unknown)']);
  }

  section(
    lines,
    'Evidence fetched (citable sources only — byte counts, never content)',
    report.evidenceFetched.map((ev) => `[#${ev.sequence}] member=${ev.memberId} origin=${ev.origin}${ev.path ? ` path=${ev.path}` : ''} bytes=${ev.byteLength ?? 'unknown'}`),
  );

  section(
    lines,
    'Tool call log',
    report.toolCalls.map((call) => `[#${call.sequence}] ${call.occurredAt} phase=${call.phase} tool=${call.tool}${call.target ? ` target=${call.target}` : ''} outcome=${call.outcome} — ${call.detail}`),
  );

  return lines.join('\n').trimEnd();
}

/**
 * Sibling of `AttemptDiagnosticsReport`/`buildAttemptDiagnosticsReport`/`renderAttemptDiagnosticsText`
 * for the other half of `codeVerdict.showRunDiagnostics`: every path that used to resolve nothing —
 * no pod connected, a pod connected but no lineage matched it, the run picker dismissed without a
 * choice. The bug this fixes was never *which* attempt got reported; it was that these three paths
 * wrote nothing at all. Reusing this module's own `section` layout rather than inventing a second
 * rendering style for "nothing was found".
 */
export type DiagnosticsNotFoundReason =
  | { readonly kind: 'noPodConnected' }
  | { readonly kind: 'noMatchingRuns' }
  /** The reviewer saw a picker (more than one candidate existed) and closed it without choosing one. */
  | { readonly kind: 'pickerDismissed'; readonly offered: readonly DiagnosticsCandidate[] }
  /**
   * Resolving a target threw — an unregistered provider, a malformed pod — the one failure mode
   * none of the other three reasons name. `message` is `Error.message` only, never a stack trace
   * and never the thrown value's full shape.
   */
  | { readonly kind: 'resolutionFailed'; readonly message: string };

/** The connected pod's identity, exactly what the reviewer would recognize it by — never a token, never a repo listing. */
export interface DiagnosticsPodIdentity {
  readonly name: string;
  readonly providerId: string;
  readonly instanceUrl: string;
}

export interface DiagnosticsNotFoundInput {
  readonly reason: DiagnosticsNotFoundReason;
  /** `undefined` exactly when `reason.kind === 'noPodConnected'` — there is no pod to name. */
  readonly pod?: DiagnosticsPodIdentity;
  /** How many single-CR or changeset review panels were open when the command ran. */
  readonly openReviewPanels: number;
  readonly discovery: DiagnosticsDiscoverySummary;
}

export interface DiagnosticsNotFoundReport extends DiagnosticsNotFoundInput {
  readonly generatedAt: string;
}

/** Builds the not-found report from inputs the caller already gathered — never a re-fetch, never a guess at a reason not given. */
export function buildDiagnosticsNotFoundReport(input: DiagnosticsNotFoundInput, now: () => string): DiagnosticsNotFoundReport {
  return { ...input, generatedAt: now() };
}

function podLine(pod: DiagnosticsPodIdentity | undefined): string {
  return pod ? `connected as "${pod.name}" (${pod.providerId} @ ${pod.instanceUrl})` : 'no pod connected';
}

function rejectionLine(entry: { readonly lineageId: string; readonly rejection: DiagnosticsLineageRejection }): string {
  const { lineageId, rejection } = entry;
  switch (rejection.kind) {
    case 'noSnapshots':
      return `${lineageId} — every attempt has been evicted from this lineage; nothing is left to diagnose`;
    case 'notThisPod':
      return `${lineageId} — belongs to a different pod's target`;
    case 'incompleteAttempt':
      return `${lineageId} — ${rejection.refLabel} (attempt ${rejection.attempt}) crashed before its first checkpoint`;
  }
}

function headlineFor(reason: DiagnosticsNotFoundReason): string {
  switch (reason.kind) {
    case 'noPodConnected':
      return 'No pod is connected, so there are no runs to report on.';
    case 'noMatchingRuns':
      return 'No run was found for the active pod.';
    case 'pickerDismissed':
      return 'The run picker was dismissed without a choice.';
    case 'resolutionFailed':
      return `Looking up this pod's runs failed: ${reason.message}`;
  }
}

/** The output-channel rendering for a not-found report — house style of `renderAttemptDiagnosticsText`, never a second layout. */
export function renderDiagnosticsNotFoundText(report: DiagnosticsNotFoundReport): string {
  const lines: string[] = [];
  lines.push(`Verdict run diagnostics — generated ${report.generatedAt}`);
  lines.push(headlineFor(report.reason));
  lines.push('');

  section(lines, 'Pod', [podLine(report.pod)]);
  section(lines, 'Review panels open', [String(report.openReviewPanels)]);

  const discovery = report.discovery;
  section(lines, 'Stored lineage records', [
    `total on disk: ${discovery.totalLineageKeys}`,
    `failed to parse: ${discovery.unparsedLineageKeys}`,
    `parsed successfully: ${discovery.parsedLineages}`,
    discovery.matchedThisPod === undefined
      ? 'matched this pod: unknown — no pod is connected to match against'
      : `matched this pod: ${discovery.matchedThisPod}`,
  ]);

  section(lines, 'Rejected records (parsed, but not this run)', discovery.rejected.map(rejectionLine));

  if (report.reason.kind === 'pickerDismissed') {
    section(
      lines,
      'Runs offered — none chosen',
      report.reason.offered.map((candidate) => `${candidate.refLabel} — ${candidate.lifecycle} (${candidate.completeness}) — ran ${candidate.occurredAt}`),
    );
  }

  return lines.join('\n').trimEnd();
}
