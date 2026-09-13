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
  /**
   * Ceiling on the **assembled prompt** for one model turn, in UTF-8 bytes — the
   * whole string a model is handed, framing and tool results together.
   *
   * Prompt size used to be unbounded. Across one measured 40-call review it swung between 55 KB
   * and 426 KB, growing 21 times and shrinking 18: the prompt is rebuilt every turn, not
   * accumulated, so its size is entirely decided by how much content the previous turn's tool
   * calls returned. That killed two runs on a local model — 287 KB produced no output at all in
   * 300 seconds, while the same model answered 57-150 KB prompts in 90-280 seconds. Copilot
   * absorbed 262 KB in 48 seconds, so the failure is not universal; the unbounded growth is.
   *
   * **This number is not what the model is told it may request.** The smallest prompt in that same
   * review was 55 KB with zero bytes of tool results in it: the change-request description,
   * discussion, persona, tool catalog, protocol contract, investigation map and phase framing are
   * all ours and all mandatory. What the model may ask for is the *content allowance* — this
   * ceiling minus everything else already composed for that turn — computed at assembly from the
   * real bytes, never from a hard-coded margin, because bootstrap differs per change request and
   * the map grows as files are read (`../app/harnessModelSeam.ts`'s `renderModelPrompt`, and
   * `./harnessPromptBudget.ts` for the arithmetic and the words).
   *
   * The default, 192 KB, and why it is not smaller: the two constraints genuinely conflict. The
   * measurements alone say "survivable on a local model" is 150 KB, while one full turn of the
   * measured shape — eight files averaging 15 KB — needs 120 KB of content on top of a 55 KB
   * floor, so 176 KB at least. 192 KB satisfies the second and sits a third below the 287 KB that
   * produced nothing; it is comfortable for Copilot, which had already answered far more. A
   * reviewer driving a small local model should lower it to about 128 KB and accept more turns.
   */
  maxPromptBytesPerTurn: number;
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
  /**
   * Whether a review's own investigation stays inside the merge/pull request it was started for.
   *
   * True withholds the `fileReads`/`repositorySearch` capabilities before a member's capabilities
   * ever reach the dispatcher or the bootstrap tool catalog, so `readFile`/`searchRepository` (and
   * `resolvePolicy`, which rides on `fileReads` — `harnessAgentsPolicy.ts`'s own doc comment) are
   * refused exactly like a real capability gap already is (`harnessToolDispatcher.ts`'s
   * `capabilityUnavailable`), and are never advertised in the model-facing catalog or protocol
   * contract (`harnessModelSeam.ts`) — no second gate. `readDiff`/`searchDiff` stay available
   * either way: both are bounded to the change's own diff content by construction, never
   * repository-wide.
   *
   * **Defaults `false`, and it used to default `true`.** The default was written when every
   * unchanged file a model asked for was a metered, rate-limited API call to a forge, and
   * `resolvePolicy` was a chain of them per changed path — so a review that wandered outside its
   * change spent real money and real rate limit on it. That cost is gone. A review reads from a
   * bare object store this extension fetched, and the two shallow fetches that store already holds
   * contain every file in the repository at those commits: shallow is shallow in *history*, not in
   * content. Measured on this product's own 207-file change — 465 files present in the store,
   * `git show <sha>:src/ui/theme.ts` returning 753 lines for a file the change never touched, and
   * `git grep <sha>` matching in files the change never touched. Reading one of them is a local
   * file read.
   *
   * So the cost that justified scoping does not exist, while the benefit does: a reviewer asking
   * for the caller of a changed function is no longer told no, and no longer spends turns asking
   * for it a second way. The setting stays for a reviewer who wants the narrow behaviour anyway —
   * a smaller prompt, a model kept on the change — and setting it `true` gets exactly what the old
   * default gave.
   *
   * It is a plain boolean again. In between it was briefly a tri-state whose absent value meant
   * "ask whichever source is serving this member", because a forge and a local store had different
   * costs for the same read. There is one kind of source now, so there is one answer.
   */
  scopeInvestigationToChangedFiles: boolean;
}

/** Versions the *shape and defaults* of `HarnessPolicy` itself — snapshotted onto every run (task 6.1, design.md D3). */
export const HARNESS_POLICY_VERSION = '1';

export const DEFAULT_HARNESS_POLICY: Readonly<HarnessPolicy> = {
  globalConcurrency: 3,
  maxElapsedMsPerAttempt: 30 * 60 * 1000,
  maxModelTurnsPerAttempt: 64,
  maxToolRequestsPerAttempt: 256,
  maxToolRequestsPerTurn: 8,
  // Tracks `diffOrFileReadPageBytes` above: the largest page a provider may return has to be a
  // result the budget will accept, or every large read becomes an unactionable refusal.
  maxToolResultBytes: 256 * 1024,
  maxPromptBytesPerTurn: 192 * 1024,
  maxEvidenceBytesPerAttempt: 8 * 1024 * 1024,
  manifestPageSize: 100,
  // A whole ordinary file in one call, rather than a fixed slice of it. The 400-line page these
  // two replaced meant a 2,025-line lock-file diff arrived as eleven sequential model round trips
  // — measured at ~17.5s each, so eleven pages was over three minutes of a four-minute review, for
  // one generated file. Bytes are the real ceiling and stay authoritative: a page ends at
  // whichever bound is reached first, so a pathological file still pages instead of producing a
  // result the budget would refuse.
  diffOrFileReadPageLines: 20_000,
  diffOrFileReadPageBytes: 256 * 1024,
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
  scopeInvestigationToChangedFiles: false,
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
    maxPromptBytesPerTurn: positiveInteger(value.maxPromptBytesPerTurn, DEFAULT_HARNESS_POLICY.maxPromptBytesPerTurn),
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
    scopeInvestigationToChangedFiles: configuredBoolean(
      value.scopeInvestigationToChangedFiles,
      DEFAULT_HARNESS_POLICY.scopeInvestigationToChangedFiles,
    ),
  };
}
