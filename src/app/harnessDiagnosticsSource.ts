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
import { evidenceProducerOf } from './harnessEvidenceLedger';
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
    elapsedMs: checkpoint.elapsedMs,
    evidenceSources: checkpoint.evidence.map((source, index) => ({
      // The ledger's own append order, preserved through `buildCheckpoint`'s 1:1 mapping and never
      // reshuffled by eviction (11.4 drops whole checkpoints, never reorders one) — recomputing this
      // from array position is the same fact a stored `sequence` would have named, not a guess.
      sequence: index + 1,
      memberId: source.memberId,
      origin: source.origin,
      // A record stored before task 10.1 names no producer, and absence there
      // is the provider — the only source that existed when it was written.
      producedBy: evidenceProducerOf(source),
      path: source.path,
    })),
  };
}

/**
 * Why one lineage did not become a candidate — the detail
 * `codeVerdict.showRunDiagnostics`'s not-found report needs to tell "no review has ever run" apart
 * from "runs exist but none matched this pod" apart from "runs exist for this pod but never got far
 * enough to diagnose". Never includes a prompt, a model reply, or file content — only the identity
 * `evaluateLineage` already had in hand (a target key/ref label built the same way a resolved
 * candidate's are, `runKeyForCr`/`runKeyForChangeset`).
 */
export type DiagnosticsLineageRejection =
  | { readonly kind: 'noSnapshots' }
  | { readonly kind: 'notThisPod' }
  | { readonly kind: 'incompleteAttempt'; readonly targetKey: string; readonly refLabel: string; readonly attempt: number };

/** Either the one candidate a lineage resolves to, or why it does not — the same decision `candidateFromLineage` used to make silently. */
export type DiagnosticsLineageEvaluation =
  | { readonly kind: 'candidate'; readonly candidate: DiagnosticsCandidate }
  | { readonly kind: 'rejected'; readonly rejection: DiagnosticsLineageRejection };

/**
 * The single attempt one lineage's own persisted record resolves to: its highest-numbered snapshot
 * names the target (identity does not change within a lineage); the terminal marker for that same
 * attempt, if any, names how it ended; the last checkpoint for that attempt, if any, carries the
 * coverage/budget/evidence/tool-call detail the report actually shows.
 *
 * Rejected — never a fabricated placeholder — when `identify` says this lineage's target is not the
 * pod being asked about, when the lineage's every attempt has been evicted (11.4 strips a lineage's
 * snapshots to `{}` rather than deleting its key), or when the lineage has a snapshot but genuinely
 * nothing else was ever written for it (a crash before the very first checkpoint). Each rejection
 * names which, for `summarizeDiagnosticsDiscovery` below.
 */
function evaluateLineage(lineage: PersistedLineageRecord, identify: IdentifyDiagnosticsTarget): DiagnosticsLineageEvaluation {
  const attemptNumbers = Object.keys(lineage.snapshots).map(Number);
  if (attemptNumbers.length === 0) return { kind: 'rejected', rejection: { kind: 'noSnapshots' } };
  const maxAttempt = Math.max(...attemptNumbers);
  const snapshot = lineage.snapshots[String(maxAttempt)];
  if (!snapshot) return { kind: 'rejected', rejection: { kind: 'noSnapshots' } };
  const identity = identify(snapshot);
  if (!identity) return { kind: 'rejected', rejection: { kind: 'notThisPod' } };

  const terminal = lineage.terminalAttempts.find((marker) => marker.attempt === maxAttempt);
  const checkpointsForAttempt = lineage.checkpoints.filter((checkpoint) => checkpoint.attempt === maxAttempt);
  const lastCheckpoint = checkpointsForAttempt[checkpointsForAttempt.length - 1];
  if (!terminal && !lastCheckpoint) {
    return { kind: 'rejected', rejection: { kind: 'incompleteAttempt', targetKey: identity.targetKey, refLabel: identity.refLabel, attempt: maxAttempt } };
  }

  const lifecycle = terminal?.lifecycle ?? lastCheckpoint?.projection.lifecycle;
  const completeness = terminal?.completeness ?? lastCheckpoint?.projection.completeness;
  const occurredAt = terminal?.occurredAt ?? lastCheckpoint?.occurredAt;
  // Structurally unreachable given the guard above (one of `terminal`/`lastCheckpoint` is always
  // present there), but this stays an honest rejection rather than a non-null assertion.
  if (!lifecycle || !completeness || !occurredAt) {
    return { kind: 'rejected', rejection: { kind: 'incompleteAttempt', targetKey: identity.targetKey, refLabel: identity.refLabel, attempt: maxAttempt } };
  }

  return {
    kind: 'candidate',
    candidate: {
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
    },
  };
}

function candidateFromLineage(lineage: PersistedLineageRecord, identify: IdentifyDiagnosticsTarget): DiagnosticsCandidate | undefined {
  const evaluation = evaluateLineage(lineage, identify);
  return evaluation.kind === 'candidate' ? evaluation.candidate : undefined;
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
    // `<=`, not `<`: `lineages` is `listLineages()`'s walk of `store.keys()` (`KeyValueStore`'s own
    // contract — `vscode.Memento` in production, a `Map` in tests — neither ever re-inserts a key it
    // already holds), so a lineage's key sits at whatever position its *first* write claimed — two
    // lineages for one target are always encountered oldest first. A strict `<`
    // lets a tied `occurredAt` fall through unreplaced, keeping whichever candidate got here first —
    // the older lineage, every time — which is the opposite of what this function promises ("newest
    // ... one entry per target") and what `selectDiagnosticsCandidate` relies on to auto-report the
    // right run. Same rule as `byOccurredAt` in `harnessRunStore.ts`: order among same-timestamp
    // records follows write order, so the later-encountered (newer) candidate must win a tie, not
    // lose it.
    if (!existing || existing.occurredAt <= candidate.occurredAt) byTarget.set(candidate.targetKey, candidate);
  }
  return [...byTarget.values()].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

/**
 * Merges a pod's live (running/queued) records into `findRecentDiagnosticsCandidates`'s
 * disk-derived list, live taking precedence over disk for any target both name — a live record is
 * always fresher than whatever was last persisted to a checkpoint, and a run in its first moments
 * (before its own first checkpoint) has no disk candidate to find at all yet
 * (`evaluateLineage`'s own `incompleteAttempt` rejection, which the disk list alone cannot see past).
 * Never invents a target neither list already named.
 */
export function mergeLiveDiagnosticsCandidates(
  diskCandidates: readonly DiagnosticsCandidate[],
  liveCandidates: readonly DiagnosticsCandidate[],
): readonly DiagnosticsCandidate[] {
  const byTarget = new Map<string, DiagnosticsCandidate>();
  for (const candidate of diskCandidates) byTarget.set(candidate.targetKey, candidate);
  for (const candidate of liveCandidates) byTarget.set(candidate.targetKey, candidate);
  return [...byTarget.values()].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0));
}

/** What `selectDiagnosticsCandidate` decided, and what is left to offer afterward. */
export interface DiagnosticsSelection {
  readonly chosen: DiagnosticsCandidate;
  /** Every candidate not chosen — never a gate on the first report, only what a follow-up "pick a different run" offer shows afterward. */
  readonly others: readonly DiagnosticsCandidate[];
}

/**
 * Which candidate `codeVerdict.showRunDiagnostics` reports on immediately, without asking first.
 *
 * This closes the defect a headless investigation traced the command's silent no-op to: the old
 * handler always blocked its very first write on an interactive `showQuickPick` the moment more
 * than one candidate existed, and a picker the reviewer does not immediately answer — attention is
 * naturally on the very run it is asking about, and VS Code's own quick pick does not dismiss just
 * because focus moves to another part of the same window — leaves that write permanently pending.
 * From the reviewer's seat that is indistinguishable from "the command does nothing": no channel
 * text, no disk file, no notification, ever, for as long as the picker sits unanswered. Evidence for
 * exactly this on a real run: the dedicated output channel's own VS Code capture stayed a 0-byte
 * file for the whole session while sibling channels grew, and neither the on-disk report archive nor
 * the agent-trace file ever gained a single entry — the command was invoked, and its first write
 * never landed.
 *
 * A run live for this pod right now is reported on unasked whenever it is the only one live — the
 * reviewer watching it is never blocked on choosing the one thing already in front of them.
 * Otherwise the most recently occurred candidate is reported on. `others` is everything not chosen,
 * offered afterward rather than gating the first write.
 */
export function selectDiagnosticsCandidate(
  candidates: readonly DiagnosticsCandidate[],
  liveTargetKeys: ReadonlySet<string>,
): DiagnosticsSelection | undefined {
  if (candidates.length === 0) return undefined;
  const live = candidates.filter((candidate) => liveTargetKeys.has(candidate.targetKey));
  // Newest by `occurredAt`, computed here rather than assumed from input order — a caller's own
  // sort (`mergeLiveDiagnosticsCandidates`, `findRecentDiagnosticsCandidates`) is what every real
  // caller already hands this, but a selection function silently trusting that would make "which
  // one is newest" two, potentially diverging answers instead of one.
  const newest = candidates.reduce((a, b) => (b.occurredAt > a.occurredAt ? b : a));
  const chosen = live.length === 1 ? live[0]! : newest;
  return { chosen, others: candidates.filter((candidate) => candidate !== chosen) };
}

/**
 * The full picture `codeVerdict.showRunDiagnostics`'s not-found report needs when
 * `findRecentDiagnosticsCandidates` comes back empty — counts and identities, never content, and
 * always computed (never skipped because a caller "already knows" the answer is zero), so the
 * report a reviewer reads can distinguish:
 * - "no review has ever run" (`totalLineageKeys` is 0),
 * - "the stored data would not parse" (`unparsedLineageKeys` is above 0), and
 * - "runs exist but none matched this pod" (`parsedLineages` is above 0 but `matchedThisPod` is 0
 *   or every parsed lineage's rejection is `notThisPod`)
 * — three failure modes this module's own header says a silent `undefined` used to collapse into
 * one indistinguishable "nothing".
 */
export interface DiagnosticsDiscoverySummary {
  /** Every `codeVerdict.harness.lineage.*` key on disk, parseable or not — `HarnessRunStore.lineageKeyCount()`. */
  readonly totalLineageKeys: number;
  /** `totalLineageKeys` minus `parsedLineages` — a key present on disk whose value failed every parser's guard. */
  readonly unparsedLineageKeys: number;
  /** Lineages that parsed, regardless of which pod (or no pod) they belong to. */
  readonly parsedLineages: number;
  /**
   * How many parsed lineages `identify` recognized as this pod's own — `undefined`, never a
   * fabricated `0`, when no pod was given to match against (`identify` omitted): with nothing to
   * compare a lineage's target to, "matched" is not a question this function can answer.
   */
  readonly matchedThisPod?: number;
  /** Every parsed lineage that did not become a candidate, and why — bounded by how many lineages exist on disk, the same bound `listLineages` itself already has. */
  readonly rejected: readonly { readonly lineageId: string; readonly rejection: DiagnosticsLineageRejection }[];
}

export function summarizeDiagnosticsDiscovery(
  totalLineageKeys: number,
  lineages: readonly PersistedLineageRecord[],
  identify?: IdentifyDiagnosticsTarget,
): DiagnosticsDiscoverySummary {
  const unparsedLineageKeys = totalLineageKeys - lineages.length;
  if (!identify) {
    return { totalLineageKeys, unparsedLineageKeys, parsedLineages: lineages.length, rejected: [] };
  }
  let matchedThisPod = 0;
  const rejected: Array<{ lineageId: string; rejection: DiagnosticsLineageRejection }> = [];
  for (const lineage of lineages) {
    const evaluation = evaluateLineage(lineage, identify);
    if (evaluation.kind === 'candidate') matchedThisPod += 1;
    else rejected.push({ lineageId: lineage.lineageId, rejection: evaluation.rejection });
  }
  return { totalLineageKeys, unparsedLineageKeys, parsedLineages: lineages.length, matchedThisPod, rejected };
}
