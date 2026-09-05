/**
 * `HarnessPolicy`: the design's injectable initial limits, reserve
 * percentages, retries, protocol repairs, checkpoint cadence, and retention
 * bounds (task 2.6 of `add-agentic-review-harness`, design.md
 * "Configurable Initial Defaults"). Values here are configuration, not fixed
 * product semantics — provider limits and tests may override them.
 *
 * Pure and `vscode`-free, like the rest of `src/domain`: a settings reader
 * in a higher layer collects raw configuration and calls
 * `normalizeHarnessPolicy`, the same division of labor `contextOptions.ts`
 * uses for `ContextBudgets`.
 */

export interface HarnessPolicy {
  /** 0 means unlimited, matching `agentRunConcurrency`'s existing convention. */
  globalConcurrency: number;
  maxElapsedMsPerAttempt: number;
  maxModelTurnsPerAttempt: number;
  maxToolRequestsPerAttempt: number;
  maxToolRequestsPerTurn: number;
  maxToolResultBytes: number;
  maxEvidenceBytesPerAttempt: number;
  manifestPageSize: number;
  diffOrFileReadPageLines: number;
  diffOrFileReadPageBytes: number;
  searchResultPageMatches: number;
  searchResultPageBytes: number;
  transientRetriesPerOperation: number;
  protocolRepairsPerPhase: number;
  backoffInitialMs: number;
  backoffMaxMs: number;
  backoffJitter: boolean;
  /** Percent (0-100) of model turns, tool calls, and evidence bytes reserved for unvisited/high-risk files. */
  highRiskReservePercent: number;
  /** Percent (0-100) of the same three pools reserved for final verification. */
  verificationReservePercent: number;
  changesetMemberMinimumTurns: number;
  changesetMemberMinimumToolCalls: number;
  changesetMemberMinimumEvidenceBytes: number;
  /** Additional to the automatic checkpoint at every phase boundary. */
  checkpointCadenceToolCalls: number;
  retainedCheckpointsPerLineage: number;
  maxActivityEventsPerAttempt: number;
  maxActivityBytesPerAttempt: number;
  maxCheckpointBytesPerLineage: number;
  terminalAttemptHistoryCount: number;
  terminalAttemptHistoryMaxAgeDays: number;
}

/** Versions the *shape and defaults* of `HarnessPolicy` itself — snapshotted onto every run (task 6.1, design.md D3). */
export const HARNESS_POLICY_VERSION = '1';

export const DEFAULT_HARNESS_POLICY: Readonly<HarnessPolicy> = {
  globalConcurrency: 3,
  maxElapsedMsPerAttempt: 30 * 60 * 1000,
  maxModelTurnsPerAttempt: 64,
  maxToolRequestsPerAttempt: 256,
  maxToolRequestsPerTurn: 8,
  maxToolResultBytes: 64 * 1024,
  maxEvidenceBytesPerAttempt: 8 * 1024 * 1024,
  manifestPageSize: 100,
  diffOrFileReadPageLines: 400,
  diffOrFileReadPageBytes: 64 * 1024,
  searchResultPageMatches: 50,
  searchResultPageBytes: 64 * 1024,
  transientRetriesPerOperation: 3,
  protocolRepairsPerPhase: 2,
  backoffInitialMs: 1000,
  backoffMaxMs: 30 * 1000,
  backoffJitter: true,
  highRiskReservePercent: 20,
  verificationReservePercent: 15,
  changesetMemberMinimumTurns: 1,
  changesetMemberMinimumToolCalls: 4,
  changesetMemberMinimumEvidenceBytes: 128 * 1024,
  checkpointCadenceToolCalls: 10,
  retainedCheckpointsPerLineage: 3,
  maxActivityEventsPerAttempt: 1000,
  maxActivityBytesPerAttempt: 1024 * 1024,
  maxCheckpointBytesPerLineage: 8 * 1024 * 1024,
  terminalAttemptHistoryCount: 5,
  terminalAttemptHistoryMaxAgeDays: 30,
};

function nonNegativeInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function percentage(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : fallback;
}

function configuredBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** Per-field fallback: one unusable value falls back to its own default, not the whole policy. */
export function normalizeHarnessPolicy(value: Partial<Record<keyof HarnessPolicy, unknown>> = {}): HarnessPolicy {
  return {
    globalConcurrency: nonNegativeInteger(value.globalConcurrency, DEFAULT_HARNESS_POLICY.globalConcurrency),
    maxElapsedMsPerAttempt: positiveInteger(value.maxElapsedMsPerAttempt, DEFAULT_HARNESS_POLICY.maxElapsedMsPerAttempt),
    maxModelTurnsPerAttempt: positiveInteger(value.maxModelTurnsPerAttempt, DEFAULT_HARNESS_POLICY.maxModelTurnsPerAttempt),
    maxToolRequestsPerAttempt: positiveInteger(
      value.maxToolRequestsPerAttempt,
      DEFAULT_HARNESS_POLICY.maxToolRequestsPerAttempt,
    ),
    maxToolRequestsPerTurn: positiveInteger(value.maxToolRequestsPerTurn, DEFAULT_HARNESS_POLICY.maxToolRequestsPerTurn),
    maxToolResultBytes: positiveInteger(value.maxToolResultBytes, DEFAULT_HARNESS_POLICY.maxToolResultBytes),
    maxEvidenceBytesPerAttempt: positiveInteger(
      value.maxEvidenceBytesPerAttempt,
      DEFAULT_HARNESS_POLICY.maxEvidenceBytesPerAttempt,
    ),
    manifestPageSize: positiveInteger(value.manifestPageSize, DEFAULT_HARNESS_POLICY.manifestPageSize),
    diffOrFileReadPageLines: positiveInteger(
      value.diffOrFileReadPageLines,
      DEFAULT_HARNESS_POLICY.diffOrFileReadPageLines,
    ),
    diffOrFileReadPageBytes: positiveInteger(
      value.diffOrFileReadPageBytes,
      DEFAULT_HARNESS_POLICY.diffOrFileReadPageBytes,
    ),
    searchResultPageMatches: positiveInteger(
      value.searchResultPageMatches,
      DEFAULT_HARNESS_POLICY.searchResultPageMatches,
    ),
    searchResultPageBytes: positiveInteger(value.searchResultPageBytes, DEFAULT_HARNESS_POLICY.searchResultPageBytes),
    transientRetriesPerOperation: nonNegativeInteger(
      value.transientRetriesPerOperation,
      DEFAULT_HARNESS_POLICY.transientRetriesPerOperation,
    ),
    protocolRepairsPerPhase: nonNegativeInteger(
      value.protocolRepairsPerPhase,
      DEFAULT_HARNESS_POLICY.protocolRepairsPerPhase,
    ),
    backoffInitialMs: positiveInteger(value.backoffInitialMs, DEFAULT_HARNESS_POLICY.backoffInitialMs),
    backoffMaxMs: positiveInteger(value.backoffMaxMs, DEFAULT_HARNESS_POLICY.backoffMaxMs),
    backoffJitter: configuredBoolean(value.backoffJitter, DEFAULT_HARNESS_POLICY.backoffJitter),
    highRiskReservePercent: percentage(value.highRiskReservePercent, DEFAULT_HARNESS_POLICY.highRiskReservePercent),
    verificationReservePercent: percentage(
      value.verificationReservePercent,
      DEFAULT_HARNESS_POLICY.verificationReservePercent,
    ),
    changesetMemberMinimumTurns: positiveInteger(
      value.changesetMemberMinimumTurns,
      DEFAULT_HARNESS_POLICY.changesetMemberMinimumTurns,
    ),
    changesetMemberMinimumToolCalls: positiveInteger(
      value.changesetMemberMinimumToolCalls,
      DEFAULT_HARNESS_POLICY.changesetMemberMinimumToolCalls,
    ),
    changesetMemberMinimumEvidenceBytes: positiveInteger(
      value.changesetMemberMinimumEvidenceBytes,
      DEFAULT_HARNESS_POLICY.changesetMemberMinimumEvidenceBytes,
    ),
    checkpointCadenceToolCalls: positiveInteger(
      value.checkpointCadenceToolCalls,
      DEFAULT_HARNESS_POLICY.checkpointCadenceToolCalls,
    ),
    retainedCheckpointsPerLineage: positiveInteger(
      value.retainedCheckpointsPerLineage,
      DEFAULT_HARNESS_POLICY.retainedCheckpointsPerLineage,
    ),
    maxActivityEventsPerAttempt: positiveInteger(
      value.maxActivityEventsPerAttempt,
      DEFAULT_HARNESS_POLICY.maxActivityEventsPerAttempt,
    ),
    maxActivityBytesPerAttempt: positiveInteger(
      value.maxActivityBytesPerAttempt,
      DEFAULT_HARNESS_POLICY.maxActivityBytesPerAttempt,
    ),
    maxCheckpointBytesPerLineage: positiveInteger(
      value.maxCheckpointBytesPerLineage,
      DEFAULT_HARNESS_POLICY.maxCheckpointBytesPerLineage,
    ),
    terminalAttemptHistoryCount: positiveInteger(
      value.terminalAttemptHistoryCount,
      DEFAULT_HARNESS_POLICY.terminalAttemptHistoryCount,
    ),
    terminalAttemptHistoryMaxAgeDays: positiveInteger(
      value.terminalAttemptHistoryMaxAgeDays,
      DEFAULT_HARNESS_POLICY.terminalAttemptHistoryMaxAgeDays,
    ),
  };
}
