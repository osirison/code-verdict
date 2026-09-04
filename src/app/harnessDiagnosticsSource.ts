/**
 * Resolves what "Verdict: Show run diagnostics" reports once no review panel is open to hand it a
 * live `RunRecord` — the fallback the command needs after a run has actually ended, which is
 * exactly when the panel's own in-memory copy is gone (`ui/reviewFlow.ts`'s `activeRunRecord`
 * clears on success, on cancellation, and on a dismissed failure; there is none at all once the
 * panel is closed or the window reloads).
 *
 * Reads `HarnessRunStore` alone, never `reviewRuns.ts`'s `ReviewRunStore`: an ordinary terminal
 * outcome (`ReviewRunManager.completeAttempt`) records only `repoId`/`crNumber`/outcome there,
 * never `lineageId` — only the activation sweep's `interrupted` entries carry one, and a
 * zero-finding failure (this module's own motivating case) writes no `ReviewRunStore` entry at
 * all. `HarnessRunStore.listLineages` is therefore the only durable way left to find a target's
 * most recent attempt once nothing live remembers which lineage it was — this module never adds a
 * second recording path to fix that forward; the failed run the reviewer needs to diagnose is
 * already on disk today, reachable only by reading every lineage back.
 *
 * `harnessAttempt.ts`'s own `runPersisting`/`finalizeBootstrapFailure` guarantee a terminal
 * checkpoint lands for every attempt, successful or not (see that module's own file header on the
 * bug task 14.6 fixed to make this true) — so even the exact scenario `harnessDiagnostics.ts` exists
 * to answer ("no findings, `insufficientRiskCoverage`, nothing in the debug console") always leaves
 * a terminal `PersistedCheckpoint` and a `TerminalAttemptMarker` behind to read back.
 *
 * What is NOT recoverable from disk, and never fabricated here: `completionEvaluation` (only the
 * ultimate lifecycle/completeness is persisted, never the clause-by-clause verdict) and `failure`
 * (the `RunFailure` a run screen shows). Both stay `undefined` on a resolved candidate;
 * `renderAttemptDiagnosticsText`'s "(no completion evaluation is available for this attempt)" is
 * worded to stay true whether that is because validation never ran or because it ran and simply was
 * not persisted.
 */
import type { Limitation } from '../domain/harnessActivity';
import type { ResultCompleteness, RunLifecycle } from '../domain/harnessLifecycle';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { PersistedCheckpoint } from './harnessCheckpoint';
import type { DiagnosticsCheckpointSource, DiagnosticsSourceRecord } from './harnessDiagnostics';
import type { PersistedLineageRecord } from './harnessRunStore';

/** One candidate attempt the reviewer could ask to see, already reduced to what the report builder needs. */
export interface DiagnosticsCandidate {
  /**
   * Groups lineages that belong to the same target, so only the newest one per target survives.
   * A caller should build this with the exact same format `ReviewRunManager.runKeyFor` uses
   * (`crKey`/`runKeyForChangeset`, `retainedReview.ts`) — then `runManager.get(targetKey)` can be
   * cross-checked directly for a live record this resolver cannot see, without reconstructing a
   * full `RunTarget` from a `ReviewRunSnapshot` just to key a lookup.
   */
  readonly targetKey: string;
  readonly refLabel: string;
  readonly lineageId: string;
  readonly attempt: number;
  readonly lifecycle: RunLifecycle;
  readonly completeness: ResultCompleteness;
  readonly occurredAt: string;
  readonly record: DiagnosticsSourceRecord;
}

/**
 * What a caller must supply to scope discovery to one pod and label a target the way its own
 * screens already do (`vocabulary.formatCrRef`, `runKeyForCr`/`runKeyForChangeset`) — never
 * invented here, since `src/app` stays free of `vscode` and the provider registry.
 * `undefined` means "not this pod's target", filtering the lineage out entirely.
 */
export type IdentifyDiagnosticsTarget = (snapshot: ReviewRunSnapshot) => { targetKey: string; refLabel: string } | undefined;

/** The persisted terminal fact for this checkpoint's own attempt, if this is the checkpoint that recorded it — never re-derived, only read back. */
function limitationsFromTerminalCheckpoint(checkpoint: PersistedCheckpoint | undefined): readonly Limitation[] {
  if (!checkpoint) return [];
  for (let i = checkpoint.activity.length - 1; i >= 0; i -= 1) {
    const event = checkpoint.activity[i];
    if (event?.kind === 'terminalResult') return event.limitations;
  }
  return [];
}

/**
 * Never reads `RetainedEvidenceRecord.exactContent` — this module's own hard constraint, matching
 * `harnessDiagnostics.ts`'s own header ("never a full tool payload"). `byteLength` is left unknown
 * rather than derived from that field's length: a persisted evidence record never retained a byte
 * count for most sources, and guessing one from content that happens to still be attached for the
 * few citations that keep it would be a second, inconsistent implementation of "how big was this
 * fetch".
 */
export function diagnosticsCheckpointFromPersisted(checkpoint: PersistedCheckpoint): DiagnosticsCheckpointSource {
  return {
    activityLog: { events: checkpoint.activity },
    coverage: checkpoint.coverage,
    budget: checkpoint.budget,
    unresolved: checkpoint.unresolved,
    evidenceSources: checkpoint.evidence.map((source, index) => ({
      // The ledger's own append order, preserved through `buildCheckpoint`'s 1:1 mapping and never
      // reshuffled by eviction (11.4 drops whole checkpoints, never reorders one) — recomputing this
      // from array position is the same fact a stored `sequence` would have named, not a guess.
      sequence: index + 1,
      memberId: source.memberId,
      origin: source.origin,
      path: source.path,
    })),
  };
}

/**
 * The single attempt one lineage's own persisted record resolves to: its highest-numbered snapshot
 * names the target (identity does not change within a lineage); the terminal marker for that same
 * attempt, if any, names how it ended; the last checkpoint for that attempt, if any, carries the
 * coverage/budget/evidence/tool-call detail the report actually shows.
 *
 * `undefined` when `identify` says this lineage's target is not the pod being asked about, or when
 * the lineage has a snapshot but genuinely nothing else was ever written for it (a crash before the
 * very first checkpoint) — there is nothing to diagnose either way, never a fabricated placeholder.
 */
function candidateFromLineage(lineage: PersistedLineageRecord, identify: IdentifyDiagnosticsTarget): DiagnosticsCandidate | undefined {
  const attemptNumbers = Object.keys(lineage.snapshots).map(Number);
  if (attemptNumbers.length === 0) return undefined;
  const maxAttempt = Math.max(...attemptNumbers);
  const snapshot = lineage.snapshots[String(maxAttempt)];
  if (!snapshot) return undefined;
  const identity = identify(snapshot);
  if (!identity) return undefined;

  const terminal = lineage.terminalAttempts.find((marker) => marker.attempt === maxAttempt);
  const checkpointsForAttempt = lineage.checkpoints.filter((checkpoint) => checkpoint.attempt === maxAttempt);
  const lastCheckpoint = checkpointsForAttempt[checkpointsForAttempt.length - 1];
  if (!terminal && !lastCheckpoint) return undefined;

  const lifecycle = terminal?.lifecycle ?? lastCheckpoint?.projection.lifecycle;
  const completeness = terminal?.completeness ?? lastCheckpoint?.projection.completeness;
  const occurredAt = terminal?.occurredAt ?? lastCheckpoint?.occurredAt;
  // Structurally unreachable given the guard above (one of `terminal`/`lastCheckpoint` is always
  // present there), but this stays an honest early return rather than a non-null assertion.
  if (!lifecycle || !completeness || !occurredAt) return undefined;

  return {
    targetKey: identity.targetKey,
    refLabel: identity.refLabel,
    lineageId: lineage.lineageId,
    attempt: maxAttempt,
    lifecycle,
    completeness,
    occurredAt,
    record: {
      runId: lineage.runId,
      lineageId: lineage.lineageId,
      attempt: maxAttempt,
      lifecycle,
      completeness,
      checkpoint: lastCheckpoint ? diagnosticsCheckpointFromPersisted(lastCheckpoint) : undefined,
      completionEvaluation: undefined,
      // Only meaningful when `lastCheckpoint` is actually the checkpoint that recorded `terminal` —
      // true whenever `terminal` is present, since retention only ever evicts a lineage's *oldest*
      // checkpoints (11.4) and this attempt's terminal checkpoint is always its newest.
      limitations: terminal ? limitationsFromTerminalCheckpoint(lastCheckpoint) : [],
      failure: undefined,
    },
  };
}

/**
 * Every pod target's most recent attempt, newest first — one entry per target
 * (`reviewRuns.ts`'s own "latest run per change request wins" rule, applied here across lineages
 * instead of across `ReviewRunStore` entries, since one target can have accumulated several fresh
 * `trigger()` lineages over time — a resumed lineage is the only kind that reuses one — and only the
 * newest is worth surfacing).
 */
export function findRecentDiagnosticsCandidates(
  lineages: readonly PersistedLineageRecord[],
  identify: IdentifyDiagnosticsTarget,
): readonly DiagnosticsCandidate[] {
  const byTarget = new Map<string, DiagnosticsCandidate>();
  for (const lineage of lineages) {
    const candidate = candidateFromLineage(lineage, identify);
    if (!candidate) continue;
    const existing = byTarget.get(candidate.targetKey);
    if (!existing || existing.occurredAt < candidate.occurredAt) byTarget.set(candidate.targetKey, candidate);
  }
  return [...byTarget.values()].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}
