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
