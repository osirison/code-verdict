/**
 * Changed-file inventory, risk, coverage, budgets, and the completion
 * decision (task 2.4 of `add-agentic-review-harness`, design.md D10/D11/D12).
 * Self-contained: coverage tracked here is the host's internal per-file
 * model, distinct from `RunProjection.coverage` in `harnessActivity.ts`
 * (task 2.3), which is a small display summary derived from it.
 */

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export const FILE_INSPECTION_STATES = [
  'unvisited',
  'classified',
  'inspected',
  'excludedByPolicy',
  'unavailable',
  'binary',
  'oversized',
] as const;

/** `unvisited -> classified -> inspected | excludedByPolicy | unavailable | binary | oversized` (D10). */
export type FileInspectionState = (typeof FILE_INSPECTION_STATES)[number];

const NON_INSPECTED_TERMINAL_STATES = new Set<FileInspectionState>([
  'excludedByPolicy',
  'unavailable',
  'binary',
  'oversized',
]);

/** These terminal states always carry a public `reason`; `inspected` needs none. */
export function isNonInspectedTerminalState(state: FileInspectionState): boolean {
  return NON_INSPECTED_TERMINAL_STATES.has(state);
}

export interface ChangedFileRecord {
  path: string;
  memberId: string;
  state: FileInspectionState;
  risk?: RiskLevel;
  logicalUnit?: string;
  /** Required once `state` reaches a non-inspected terminal value. */
  reason?: string;
  /**
   * The investigation source enumerated this file and would not serve its
   * content (`add-local-git-investigation` task 3.2/3.5). Deliberately not a
   * `FileInspectionState`: the file stays `classified` and still worth reading,
   * while every state past `classified` is irreversible.
   *
   * Carried here, and not only on the richer in-memory record, because a
   * checkpoint that dropped it let a resumed attempt replay the file as merely
   * classified — and a low-risk file that is merely classified does not block
   * completion, so the resumed run could end complete and clean over content
   * nobody was served. Absent reads as false: no record written before the
   * state existed can have been declined.
   */
  contentDeclined?: boolean;
  /**
   * The investigation source was asked for this file's content and came back
   * without establishing anything about it (`InvestigationResult`'s `unknown`):
   * an invocation stopped at a time or output bound, a pinned revision the
   * object store could not resolve, or a diff that failed for a path the
   * manifest had just enumerated. Not a `FileInspectionState`, for the same
   * reason `contentDeclined` is not one: the file is still `classified`, still
   * unread, and still worth asking for again.
   *
   * A separate fact from `contentDeclined` rather than the same one, because
   * the two differ in the one way a reviewer can act on: a source that declined
   * will decline again, while a read that failed may well succeed on the next
   * turn — which is why this blocker is repairable and that one is not
   * (`harnessCompletion.ts`'s `REPAIRABLE_BLOCKERS`).
   *
   * Carried on the persisted record for the reason `contentDeclined` is: a
   * checkpoint that dropped it let a resumed attempt replay the file as merely
   * classified, and a low-risk file that is merely classified does not block
   * completion. Absent reads as false: no record written before the state
   * existed can have recorded a failed read.
   */
  readFailed?: boolean;
}

/** No total denominator until the provider states enumeration is complete (D10). */
export interface MemberCoverage {
  memberId: string;
  manifestComplete: boolean;
  totalFiles?: number;
  files: readonly ChangedFileRecord[];
}

export interface UnresolvedWork {
  unresolvedFetches: number;
  unresolvedCandidates: number;
}

/** Reserves are partitioned at admission (D12); ordinary work cannot consume them. */
export interface BudgetConsumption {
  modelTurnsUsed: number;
  toolCallsUsed: number;
  evidenceBytesUsed: number;
  elapsedMs: number;
  highRiskReserveUsed: number;
  verificationReserveUsed: number;
}

export const COMPLETION_BLOCKERS = [
  'headChanged',
  'incompleteInventory',
  'unclassifiedFiles',
  'insufficientRiskCoverage',
  'unresolvedFetches',
  'unresolvedCandidates',
  'invalidCitations',
  'contradictionPending',
  'deduplicationPending',
  'verificationPending',
  'budgetExhausted',
  'timeout',
  'providerLimit',
  'unavailableOversizedPatch',
  /**
   * A changed file whose content the investigation source enumerated and then
   * would not serve (`InvestigationResult`'s `contentDeclined`). Its own
   * blocker rather than `unavailableOversizedPatch` or `providerLimit`,
   * because it is the one condition where the file is known to be readable
   * and simply was not read: the run is incomplete, and the reason a reviewer
   * needs is that the source withheld it, not that the file is unreadable.
   */
  'declinedContent',
  /**
   * A changed file the investigation source was asked for and answered with
   * nothing it had established (`InvestigationResult`'s `unknown`). Its own
   * blocker rather than `unavailableOversizedPatch`, which claims the content
   * could not be obtained, or `declinedContent`, which claims the source
   * refused: what happened here is that the read did not resolve, and the very
   * next attempt at it may return the diff.
   */
  'readFailed',
] as const;

/** One member per AND-clause of the completion predicate in D11, plus the risks it names. */
export type CompletionBlocker = (typeof COMPLETION_BLOCKERS)[number];

export interface CompletionDecision {
  eligible: boolean;
  blockers: readonly CompletionBlocker[];
}

export function isRiskLevel(value: unknown): value is RiskLevel {
  return (RISK_LEVELS as readonly unknown[]).includes(value);
}

export function parseRiskLevel(value: unknown): RiskLevel | undefined {
  return isRiskLevel(value) ? value : undefined;
}

export function isFileInspectionState(value: unknown): value is FileInspectionState {
  return (FILE_INSPECTION_STATES as readonly unknown[]).includes(value);
}

export function parseFileInspectionState(value: unknown): FileInspectionState | undefined {
  return isFileInspectionState(value) ? value : undefined;
}

export function isCompletionBlocker(value: unknown): value is CompletionBlocker {
  return (COMPLETION_BLOCKERS as readonly unknown[]).includes(value);
}

export function parseCompletionBlocker(value: unknown): CompletionBlocker | undefined {
  return isCompletionBlocker(value) ? value : undefined;
}
