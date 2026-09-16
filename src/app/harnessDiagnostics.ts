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
  /**
   * Which source produced this payload — `EvidenceProducer`
   * (`harnessEvidenceLedger.ts`, `add-local-git-investigation` task 10.1),
   * widened to `string` here for the same reason `origin` is: this module
   * renders what it is handed and never re-derives it.
   */
  readonly producedBy?: string;
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
  /**
   * The checkpoint's own fresh clock read at write time (`harnessAttempt.ts`'s `reportCheckpoint`:
   * `elapsedMs: clock()`) — NOT `budget.elapsedMs`, which is only updated when a turn reserves
   * budget (`beginTurn`) and can go stale by however long the phase spent afterward (a completing-
   * phase head refresh, a final checkpoint write) before the attempt actually ends. Both a live
   * `CheckpointInfo` and a persisted `PersistedCheckpoint` already carry this field structurally;
   * `timeSummaryFrom`'s `totalElapsedMs` reads it from here, never from `budget`, so "where did the
   * time go" totals the same wall clock the checkpoint itself was stamped with.
   */
  readonly elapsedMs: number;
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
  readonly memberId?: string;
  /** Wall time `harnessToolDispatcher.ts`'s `dispatch` actually spent on this one call — absent only for an attempt persisted before this field existed. */
  readonly durationMs?: number;
  /** Bytes returned — evidence bytes for a citable read, the provider's own reported size for a binary/oversized result; absent when this dispatcher never counts bytes for this tool at all (a manifest page, a refusal, a policy echo). */
  readonly bytes?: number;
  /** The provider/tool result's own state (`'complete'`, `'refused'`, `'binary'`, ...) — richer than `outcome` alone. */
  readonly resultState?: string;
  /** This one call's own transient-retry backoff time/count, surfaced from `harnessRetry.ts`'s already-computed delays; absent when the call needed no retry. */
  readonly retryWaitMs?: number;
  readonly retryCount?: number;
}

/**
 * One raw model round trip — the `tool: 'modelTurn'` convention `toolCompleted`/`toolFailed`
 * already used for a turn's own outcome, split out into its own section (rather than left mixed
 * into `toolCalls`) because a model turn and a real host tool call answer different questions: one
 * is time spent waiting on the model, the other is time spent waiting on the provider.
 * `toolCallsRequested` is never a stored field — it is the count of real tool-call facts between
 * this turn and the next one in the same activity log, derived here rather than persisted, so it
 * can never drift from what the log actually shows happened after this turn.
 */
export interface DiagnosticsModelTurn {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly phase: string;
  readonly outcome: 'completed' | 'failed';
  readonly durationMs?: number;
  readonly promptBytes?: number;
  readonly replyBytes?: number;
  readonly toolCallsRequested: number;
  /** Present only when `outcome === 'failed'` — the turn's own `toolFailed` reason, verbatim. */
  readonly detail?: string;
}

/** One entry in the summary's "slowest operations" list — a model turn or a real tool call, whichever this is. */
export interface DiagnosticsSlowOperation {
  readonly label: string;
  readonly phase: string;
  readonly occurredAt: string;
  readonly durationMs: number;
}

/**
 * The answer to "where did the time go" — computed once, here, from the same activity log every
 * other section already reads; never a second measurement. `totalElapsedMs` is the checkpoint's
 * own fresh clock read at write time (`DiagnosticsCheckpointSource.elapsedMs` — see that field's
 * own comment for why this is not `budget.elapsedMs`), so it is absent along with `budget`
 * whenever no checkpoint exists yet to read it from.
 *
 * `modelWaitMs`/`providerWaitMs` are a direct sum of every timed `modelTurn`/real-tool-call fact's
 * own `durationMs`; `hostMs` is never separately captured — it is `totalElapsedMs` minus both sums
 * (floored at 0), i.e. every millisecond of the attempt's own elapsed time not already accounted
 * for as waiting on the model or the provider: bootstrap arithmetic, evidence/coverage bookkeeping,
 * checkpoint writes, everything this module has no dedicated timer for and does not need one to
 * report honestly. `retryWaitMs`/`retryCount` are a subset of `providerWaitMs` (backoff waits
 * happen inside a timed dispatch call), broken out because a reviewer asking "why is the provider
 * bucket so large" needs to see how much of it was the provider's own retryable throttling rather
 * than genuine request latency.
 */
export interface DiagnosticsTimeSummary {
  readonly totalElapsedMs: number;
  readonly modelWaitMs: number;
  readonly providerWaitMs: number;
  readonly hostMs: number;
  readonly retryWaitMs: number;
  readonly retryCount: number;
  readonly modelTurnCount: number;
  /** Longest first, model turns and real tool calls together — capped at a small, readable count. */
  readonly slowestOperations: readonly DiagnosticsSlowOperation[];
}

export interface DiagnosticsEvidenceEntry {
  /** The ledger's own append-order sequence for this source — never recomputed on the live path; recomputed from array order on the persisted path (see `DiagnosticsEvidenceSource`). */
  readonly sequence: number;
  readonly memberId: string;
  readonly origin: string;
  /** The source that produced it (task 10.1); absent only when the checkpoint this was read from predates the field. */
  readonly producedBy?: string;
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
  readonly modelTurns: readonly DiagnosticsModelTurn[];
  /** Absent exactly when `budget` is (no checkpoint yet) — there is no `totalElapsedMs` to build it from. */
  readonly timeSummary?: DiagnosticsTimeSummary;
}

function phaseTransitionsFrom(events: readonly ActivityEvent[]): readonly DiagnosticsPhaseTransition[] {
  const out: DiagnosticsPhaseTransition[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (!last || last.phase !== event.phase) out.push({ phase: event.phase, occurredAt: event.occurredAt });
  }
  return out;
}

/** Narrows to a `toolCompleted`/`toolFailed` `ActivityEvent` — the one shape both `toolCallsFrom`, `modelTurnsFrom`, and `timeSummaryFrom` read timing/size metadata off. */
function isCallLike(event: ActivityEvent): event is Extract<ActivityEvent, { kind: 'toolCompleted' | 'toolFailed' }> {
  return event.kind === 'toolCompleted' || event.kind === 'toolFailed';
}

/** Every real host tool call — `tool: 'modelTurn'` facts are a model turn, not a tool call, and belong to `modelTurnsFrom` instead. */
function toolCallsFrom(events: readonly ActivityEvent[]): readonly DiagnosticsToolCall[] {
  const out: DiagnosticsToolCall[] = [];
  for (const event of events) {
    if (!isCallLike(event) || event.tool === 'modelTurn') continue;
    const base = {
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      phase: event.phase,
      tool: event.tool,
      target: event.target,
      memberId: event.memberId,
      durationMs: event.durationMs,
      bytes: event.bytesReceived,
      resultState: event.resultState,
      retryWaitMs: event.retryWaitMs,
      retryCount: event.retryCount,
    };
    if (event.kind === 'toolCompleted') out.push({ ...base, outcome: 'completed', detail: event.summary });
    else out.push({ ...base, outcome: 'failed', detail: event.reason });
  }
  return out;
}

/**
 * Every raw model round trip, in log order. `toolCallsRequested` is derived, not stored: the
 * count of real tool-call facts (`isCallLike` minus `tool === 'modelTurn'`) between this turn's
 * own sequence and the next `modelTurn` fact's — see `DiagnosticsModelTurn`'s own comment.
 */
function modelTurnsFrom(events: readonly ActivityEvent[]): readonly DiagnosticsModelTurn[] {
  const out: DiagnosticsModelTurn[] = [];
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i] as ActivityEvent;
    if (!isCallLike(event) || event.tool !== 'modelTurn') continue;
    let toolCallsRequested = 0;
    for (let j = i + 1; j < events.length; j += 1) {
      const next = events[j] as ActivityEvent;
      if (!isCallLike(next)) continue;
      if (next.tool === 'modelTurn') break;
      toolCallsRequested += 1;
    }
    out.push({
      sequence: event.sequence,
      occurredAt: event.occurredAt,
      phase: event.phase,
      outcome: event.kind === 'toolCompleted' ? 'completed' : 'failed',
      durationMs: event.durationMs,
      promptBytes: event.bytesSent,
      replyBytes: event.bytesReceived,
      toolCallsRequested,
      detail: event.kind === 'toolFailed' ? event.reason : undefined,
    });
  }
  return out;
}

const MAX_SLOWEST_OPERATIONS = 5;

function timeSummaryFrom(events: readonly ActivityEvent[], totalElapsedMs: number | undefined): DiagnosticsTimeSummary | undefined {
  if (totalElapsedMs === undefined) return undefined;
  let modelWaitMs = 0;
  let providerWaitMs = 0;
  let retryWaitMs = 0;
  let retryCount = 0;
  let modelTurnCount = 0;
  const operations: DiagnosticsSlowOperation[] = [];
  for (const event of events) {
    if (!isCallLike(event)) continue;
    // `?? 0` only for the *sums* below (an unknown duration contributes nothing, the standard
    // convention for an aggregate) — never for the slowest-operations list, which must never show
    // a fabricated "0ms" for a call this attempt was persisted before duration was ever recorded
    // for at all.
    const durationMs = event.durationMs ?? 0;
    if (event.tool === 'modelTurn') {
      modelTurnCount += 1;
      modelWaitMs += durationMs;
      if (event.durationMs !== undefined) operations.push({ label: 'modelTurn', phase: event.phase, occurredAt: event.occurredAt, durationMs: event.durationMs });
    } else {
      providerWaitMs += durationMs;
      retryWaitMs += event.retryWaitMs ?? 0;
      retryCount += event.retryCount ?? 0;
      if (event.durationMs !== undefined) {
        operations.push({ label: event.target ? `${event.tool} ${event.target}` : event.tool, phase: event.phase, occurredAt: event.occurredAt, durationMs: event.durationMs });
      }
    }
  }
  const hostMs = Math.max(0, totalElapsedMs - modelWaitMs - providerWaitMs);
  const slowestOperations = [...operations].sort((a, b) => b.durationMs - a.durationMs).slice(0, MAX_SLOWEST_OPERATIONS);
  return { totalElapsedMs, modelWaitMs, providerWaitMs, hostMs, retryWaitMs, retryCount, modelTurnCount, slowestOperations };
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
      producedBy: source.producedBy,
      path: source.path,
      byteLength: source.byteLength,
    })),
    toolCalls: toolCallsFrom(events),
    modelTurns: modelTurnsFrom(events),
    timeSummary: timeSummaryFrom(events, checkpoint?.elapsedMs),
  };
}

/** Exported so `renderDiagnosticsNotFoundText` below shares the exact same section layout, rather than a second one. */
export function section(lines: string[], title: string, body: readonly string[]): void {
  lines.push(`${title}:`);
  if (body.length === 0) lines.push('  (none)');
  else for (const line of body) lines.push(`  ${line}`);
  lines.push('');
}

/** `12345ms` for anything under a second, `3m40s`/`45s` otherwise — human-readable without losing the raw count everywhere else in this report already shows it in plain milliseconds. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${seconds}s` : `${seconds}s`;
}

function percentOf(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

/**
 * The answer to "where did the time go", first — before any other section, so a reviewer opening
 * this after a slow review sees the cause without reading anything else. One combined line for the
 * total/split/turn-count (never split across several lines the way `section` above would, which
 * would push "the slowest few operations" past the first ten lines this is required to fit in),
 * then the slowest operations themselves.
 */
function timeSummaryLines(summary: DiagnosticsTimeSummary): string[] {
  const { totalElapsedMs, modelWaitMs, providerWaitMs, hostMs, retryWaitMs, retryCount, modelTurnCount } = summary;
  const retryNote = retryCount > 0 ? `, of which retry backoff ${formatDuration(retryWaitMs)} across ${retryCount} wait(s)` : '';
  const lines = [
    `Time summary: total ${formatDuration(totalElapsedMs)} (${totalElapsedMs}ms) — ` +
      `model ${formatDuration(modelWaitMs)} (${percentOf(modelWaitMs, totalElapsedMs)}), ` +
      `provider ${formatDuration(providerWaitMs)} (${percentOf(providerWaitMs, totalElapsedMs)}${retryNote}), ` +
      `host ${formatDuration(hostMs)} (${percentOf(hostMs, totalElapsedMs)}) — ${modelTurnCount} model turn(s)`,
  ];
  if (summary.slowestOperations.length > 0) {
    lines.push('Slowest operations:');
    summary.slowestOperations.forEach((op, index) => {
      lines.push(`  ${index + 1}. [${formatDuration(op.durationMs)}] ${op.label} — ${op.phase}`);
    });
  }
  lines.push('');
  return lines;
}

/** The output-channel rendering — plain lines, house style of `apiTrace.ts`. */
export function renderAttemptDiagnosticsText(report: AttemptDiagnosticsReport): string {
  const lines: string[] = [];
  lines.push(`Verdict run diagnostics — generated ${report.generatedAt}`);
  lines.push(`run=${report.runId} lineage=${report.lineageId} attempt=${report.attempt}`);
  lines.push(`lifecycle=${report.lifecycle} completeness=${report.completeness}`);
  lines.push('');

  if (report.timeSummary) {
    lines.push(...timeSummaryLines(report.timeSummary));
  } else {
    // True before the attempt's first checkpoint (same condition `budget` itself is absent for) —
    // named rather than left to look like the summary was simply forgotten.
    lines.push('Time summary: (no checkpoint was recorded for this attempt, so timing is unknown)');
    lines.push('');
  }

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
      // Not the same number as the time summary's "total" line above: this is `budget.elapsedMs`,
      // frozen at the last turn that reserved budget, not the checkpoint's own fresher clock read
      // (`DiagnosticsTimeSummary.totalElapsedMs`) — labelled to say so, rather than reading like an
      // unexplained second total.
      `elapsed ms at last budget reservation: ${report.budget.elapsedMs}`,
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
    report.evidenceFetched.map(
      (ev) =>
        `[#${ev.sequence}] member=${ev.memberId} origin=${ev.origin} source=${ev.producedBy ?? 'unrecorded'}${ev.path ? ` path=${ev.path}` : ''} bytes=${ev.byteLength ?? 'unknown'}`,
    ),
  );

  section(
    lines,
    'Model turns',
    report.modelTurns.map((turn) => {
      const timing = turn.durationMs !== undefined ? ` duration=${turn.durationMs}ms sent=${turn.promptBytes ?? 'unknown'}B received=${turn.replyBytes ?? 'unknown'}B` : '';
      const detail = turn.detail ? ` — ${turn.detail}` : '';
      return `[#${turn.sequence}] ${turn.occurredAt} phase=${turn.phase} outcome=${turn.outcome}${timing} toolCallsRequested=${turn.toolCallsRequested}${detail}`;
    }),
  );

  section(
    lines,
    'Tool call log',
    report.toolCalls.map((call) => {
      const member = call.memberId ? ` member=${call.memberId}` : '';
      const timing = call.durationMs !== undefined ? ` duration=${call.durationMs}ms` : '';
      const bytes = call.bytes !== undefined ? ` bytes=${call.bytes}` : '';
      const retry = call.retryCount ? ` retryWaits=${call.retryCount} (${call.retryWaitMs}ms)` : '';
      const state = call.resultState ? ` state=${call.resultState}` : '';
      return `[#${call.sequence}] ${call.occurredAt} phase=${call.phase} tool=${call.tool}${member}${call.target ? ` target=${call.target}` : ''}${state}${timing}${bytes}${retry} outcome=${call.outcome} — ${call.detail}`;
    }),
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
