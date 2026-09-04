/**
 * `HarnessRunStore`: bounded workspace-storage persistence for a lineage's
 * snapshot, checkpoints, and terminal-attempt history (task 11.1 of
 * `add-agentic-review-harness`, design.md D13, spec `review-run-activity`/
 * `review-evidence-ledger`). Task 11.4's bounds live here too — eviction
 * ordering only this module can see (which whole checkpoints to drop, which
 * attempts have aged out of terminal history) is exactly the "per-lineage"/
 * "per-target" half of D13 that a single checkpoint cannot decide about
 * itself (`harnessCheckpoint.ts`'s `buildCheckpoint` only knows about its own
 * activity bounds).
 *
 * House style, matching `reviewRuns.ts`/`retainedReview.ts`: a factory over
 * `KeyValueStore`, namespaced keys, latest-wins whole-value reads/writes, no
 * locks (the same "no `await` between a synchronous read and write" guarantee
 * `storage.ts` documents). Every write goes through `buildCheckpoint`
 * (`harnessCheckpoint.ts`) before it reaches here — this module never
 * constructs a `PersistedCheckpoint` itself, only stores and evicts ones it
 * is handed.
 *
 * **Key layout:**
 * - `codeVerdict.harness.lineage.<lineageId>` — one `PersistedLineageRecord`:
 *   every attempt's snapshot, the lineage's whole checkpoint history (flat,
 *   ordered, spanning every attempt — "retained checkpoints per lineage" is
 *   a lineage-wide bound, not a per-attempt one), and one terminal-attempt
 *   marker per attempt that has finished.
 * - `codeVerdict.harness.run.<runId>` — `{ runId, lineageIds }`, the index
 *   task 11.7's restart and this task's own "terminal attempt history *per
 *   target*" bound need: a target's terminal attempts span every lineage a
 *   restart has ever created under it, not just the newest one.
 *
 * **Reads fail closed.** `KeyValueStore.get<T>` is an unchecked cast, not a
 * validator — every read here re-parses the raw JSON with this module's own
 * guards, reusing every existing `parseX`/`isX` helper the domain and app
 * layers already export (`parseRunLifecycle`, `parseResultCompleteness`,
 * `parseRunPhase`, `parsePlanItemState`, `parseEvidenceKind`,
 * `parseEvidenceCompleteness`, `parseRiskLevel`, `parseFileInspectionState`,
 * `parseProtocolProvenance`, `parseCheckpointReason`, `isTerminalLifecycle`)
 * rather than casting. A record that fails to parse — an unknown lifecycle,
 * a malformed evidence kind, anything shaped wrong — is dropped as a whole
 * (`undefined`), never partially trusted or fabricated.
 *
 * **What this pass deliberately does not build** (11.5-11.8, a later pass):
 * digest/head/model/policy resume-compatibility checks, resuming a new
 * attempt from a compatible checkpoint, and rejecting an incompatible resume
 * with reasons. `PersistedCheckpoint.compatible`/`.incompatibilityReasons`
 * already exist for that later pass to read; this module only ever sets them
 * false for the bound-driven reason it can see itself (a checkpoint that,
 * even alone, cannot fit the per-lineage byte bound) and never clears a
 * `false` a caller already set.
 */
import {
  buildCheckpoint,
  isRetryState,
  type CheckpointBuildInput,
  type PersistedCheckpoint,
} from './harnessCheckpoint';
import { reduceActivity } from './harnessActivityProjection';
import type { ContradictedFindingRecord } from './harnessAttempt';
import { parseCheckpointReason } from './harnessAttempt';
import type { CitedEvidenceRef, FindingRouting, TrackedCandidate, TrackedCandidateState, ValidatedFinding, ValidationReason } from './harnessCandidateValidation';
import type { EvidenceLocation, EvidenceOrigin, EvidenceTruncation, RetainedEvidenceRecord } from './harnessEvidenceLedger';
import { EVIDENCE_ORIGINS } from './harnessEvidenceLedger';
import type { KeyValueStore } from './storage';
import {
  ALL_CATEGORIES,
  type Category,
  type ReviewItem,
  type Severity,
} from '../domain/types';
import { SEVERITY_ORDER } from '../domain/criteria';
import type {
  ActivityEvent,
  AttentionState,
  CoverageProgress,
  Limitation,
  Plan,
  PlanItem,
  ProgressMode,
  ResultSummary,
  RunPhase,
  RunProjection,
} from '../domain/harnessActivity';
import { isRunPhase, parsePlanItemState, parseRunPhase } from '../domain/harnessActivity';
import {
  parseEvidenceCompleteness,
  parseEvidenceKind,
  parseProtocolProvenance,
  type EvidenceRange,
  type SourceCitation,
  type ValidatedFindingProvenance,
} from '../domain/harnessEvidence';
import {
  isRiskLevel,
  parseFileInspectionState,
  type BudgetConsumption,
  type ChangedFileRecord,
  type MemberCoverage,
  type RiskLevel,
  type UnresolvedWork,
} from '../domain/harnessCoverage';
import {
  isTerminalLifecycle,
  parseResultCompleteness,
  parseRunLifecycle,
  type AttemptNumber,
  type LineageId,
  type ResultCompleteness,
  type RunId,
  type RunLifecycle,
} from '../domain/harnessLifecycle';
import type { HarnessPolicy } from '../domain/harnessPolicy';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

// ---- Keys ------------------------------------------------------------------------

const LINEAGE_KEY_PREFIX = 'codeVerdict.harness.lineage.';
const RUN_INDEX_KEY_PREFIX = 'codeVerdict.harness.run.';

function lineageKey(lineageId: LineageId): string {
  return `${LINEAGE_KEY_PREFIX}${lineageId}`;
}

function runIndexKey(runId: RunId): string {
  return `${RUN_INDEX_KEY_PREFIX}${runId}`;
}

// ---- Persisted shapes --------------------------------------------------------------

export interface TerminalAttemptMarker {
  readonly attempt: AttemptNumber;
  readonly lifecycle: RunLifecycle;
  readonly completeness: ResultCompleteness;
  readonly occurredAt: string;
}

export interface PersistedLineageRecord {
  readonly schemaVersion: '1';
  readonly runId: RunId;
  readonly lineageId: LineageId;
  /** Keyed by attempt number (as a string — JSON object keys are always strings). */
  readonly snapshots: Readonly<Record<string, ReviewRunSnapshot>>;
  /** Flat, ordered oldest -> newest, spanning every attempt in this lineage. */
  readonly checkpoints: readonly PersistedCheckpoint[];
  readonly terminalAttempts: readonly TerminalAttemptMarker[];
}

interface PersistedRunIndex {
  readonly schemaVersion: '1';
  readonly runId: RunId;
  readonly lineageIds: readonly LineageId[];
}

const SCHEMA_VERSION = '1';

function emptyLineageRecord(runId: RunId, lineageId: LineageId): PersistedLineageRecord {
  return { schemaVersion: SCHEMA_VERSION, runId, lineageId, snapshots: {}, checkpoints: [], terminalAttempts: [] };
}

// ---- Fail-closed parsing -------------------------------------------------------------
// Every function below returns `undefined` on any unrecognized shape, unknown enum
// value, or wrong primitive type — never a best-effort guess, never a cast.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseArray<T>(raw: unknown, parseItem: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: T[] = [];
  for (const item of raw) {
    const parsed = parseItem(item);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
}

function parseLimitation(raw: unknown): Limitation | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.code !== 'string' || typeof raw.message !== 'string') return undefined;
  return { code: raw.code, message: raw.message };
}

function parseLimitations(raw: unknown): readonly Limitation[] | undefined {
  return parseArray(raw, parseLimitation);
}

function parsePlanItem(raw: unknown): PlanItem | undefined {
  if (!isRecord(raw)) return undefined;
  const state = parsePlanItemState(raw.state);
  if (typeof raw.id !== 'string' || typeof raw.description !== 'string' || !state) return undefined;
  if (raw.memberId !== undefined && typeof raw.memberId !== 'string') return undefined;
  return { id: raw.id, description: raw.description, state, ...(raw.memberId !== undefined ? { memberId: raw.memberId } : {}) };
}

/** Reused by `parseActivityEvent`'s `planCreated`/`planRevised` branches — the only place a `Plan` is ever persisted. */
export function parsePlan(raw: unknown): Plan | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.revision !== 'number') return undefined;
  const items = parseArray(raw.items, parsePlanItem);
  if (!items) return undefined;
  if (raw.rationale !== undefined && typeof raw.rationale !== 'string') return undefined;
  return raw.rationale === undefined ? { revision: raw.revision, items } : { revision: raw.revision, items, rationale: raw.rationale };
}

function parseCoverageProgress(raw: unknown): CoverageProgress | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.classified !== 'number' || typeof raw.inspected !== 'number') return undefined;
  if (raw.total !== undefined && typeof raw.total !== 'number') return undefined;
  if (raw.requiredInspected !== undefined && typeof raw.requiredInspected !== 'number') return undefined;
  return {
    classified: raw.classified,
    inspected: raw.inspected,
    ...(raw.total !== undefined ? { total: raw.total as number } : {}),
    ...(raw.requiredInspected !== undefined ? { requiredInspected: raw.requiredInspected as number } : {}),
  };
}

/** Every `ActivityEvent` union member, validated by discriminant. Reused for a checkpoint's `activity` array. */
export function parseActivityEvent(raw: unknown, expected: { runId: RunId; lineageId: LineageId; attempt: AttemptNumber }): ActivityEvent | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.runId !== expected.runId || raw.lineageId !== expected.lineageId || raw.attempt !== expected.attempt) return undefined;
  if (typeof raw.sequence !== 'number') return undefined;
  if (typeof raw.occurredAt !== 'string' || Number.isNaN(Date.parse(raw.occurredAt))) return undefined;
  const phase = parseRunPhase(raw.phase);
  if (!phase) return undefined;
  if (typeof raw.elapsedMs !== 'number' || raw.elapsedMs < 0) return undefined;
  const base = { runId: expected.runId, lineageId: expected.lineageId, attempt: expected.attempt, sequence: raw.sequence, occurredAt: raw.occurredAt, phase, elapsedMs: raw.elapsedMs };
  const optionalString = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';

  switch (raw.kind) {
    case 'planCreated':
    case 'planRevised': {
      const plan = parsePlan(raw.plan);
      return plan ? { ...base, kind: raw.kind, plan } : undefined;
    }
    case 'planItemStateChanged': {
      const state = parsePlanItemState(raw.state);
      return typeof raw.itemId === 'string' && state ? { ...base, kind: raw.kind, itemId: raw.itemId, state } : undefined;
    }
    case 'actionStarted': {
      if (typeof raw.action !== 'string' || !optionalString(raw.target)) return undefined;
      return { ...base, kind: raw.kind, action: raw.action, target: raw.target };
    }
    case 'toolCompleted': {
      if (typeof raw.tool !== 'string' || typeof raw.summary !== 'string' || !optionalString(raw.target)) return undefined;
      return { ...base, kind: raw.kind, tool: raw.tool, summary: raw.summary, target: raw.target };
    }
    case 'toolFailed': {
      if (typeof raw.tool !== 'string' || typeof raw.reason !== 'string' || !optionalString(raw.target)) return undefined;
      return { ...base, kind: raw.kind, tool: raw.tool, reason: raw.reason, target: raw.target };
    }
    case 'coverageChanged': {
      const coverage = parseCoverageProgress(raw.coverage);
      return coverage ? { ...base, kind: raw.kind, coverage } : undefined;
    }
    case 'checkpoint':
      return typeof raw.checkpointId === 'string' ? { ...base, kind: raw.kind, checkpointId: raw.checkpointId } : undefined;
    case 'waiting':
    case 'paused':
      return typeof raw.reason === 'string' ? { ...base, kind: raw.kind, reason: raw.reason } : undefined;
    case 'resuming':
    case 'cancelling':
    case 'cancelled':
      return { ...base, kind: raw.kind };
    case 'partialResult': {
      const limitations = parseLimitations(raw.limitations);
      return limitations ? { ...base, kind: raw.kind, limitations } : undefined;
    }
    case 'terminalResult': {
      const lifecycle = parseRunLifecycle(raw.lifecycle);
      const completeness = parseResultCompleteness(raw.completeness);
      const limitations = parseLimitations(raw.limitations);
      return lifecycle && completeness && limitations ? { ...base, kind: raw.kind, lifecycle, completeness, limitations } : undefined;
    }
    default:
      return undefined;
  }
}

function parseProgressMode(value: unknown): ProgressMode | undefined {
  return value === 'determinate' || value === 'indeterminate' ? value : undefined;
}

function parseAttentionState(value: unknown): AttentionState | undefined {
  return value === 'none' || value === 'attentionRequired' ? value : undefined;
}

function parseResultSummary(raw: unknown): ResultSummary | undefined {
  if (!isRecord(raw)) return undefined;
  const completeness = parseResultCompleteness(raw.completeness);
  const limitations = parseLimitations(raw.limitations);
  if (!completeness || !limitations) return undefined;
  if (raw.findingCount !== undefined && typeof raw.findingCount !== 'number') return undefined;
  return { completeness, limitations, ...(raw.findingCount !== undefined ? { findingCount: raw.findingCount as number } : {}) };
}

/** Recomputed on read in practice (`checkpointFromRecord` below calls `reduceActivity` instead of trusting this), but still validated so a corrupt cached copy cannot silently pass as this checkpoint's projection. */
export function parseRunProjection(raw: unknown): RunProjection | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.runId !== 'string' || typeof raw.lineageId !== 'string' || typeof raw.attempt !== 'number') return undefined;
  const lifecycle = parseRunLifecycle(raw.lifecycle);
  const completeness = parseResultCompleteness(raw.completeness);
  if (!lifecycle || !completeness) return undefined;
  if (raw.phase !== undefined && !isRunPhase(raw.phase)) return undefined;
  if (raw.currentAction !== undefined && typeof raw.currentAction !== 'string') return undefined;
  if (raw.currentTarget !== undefined && typeof raw.currentTarget !== 'string') return undefined;
  if (typeof raw.elapsedMs !== 'number') return undefined;
  const progressMode = parseProgressMode(raw.progressMode);
  if (!progressMode) return undefined;
  let progressUnits: { completed: number; total?: number } | undefined;
  if (raw.progressUnits !== undefined) {
    if (!isRecord(raw.progressUnits) || typeof raw.progressUnits.completed !== 'number') return undefined;
    if (raw.progressUnits.total !== undefined && typeof raw.progressUnits.total !== 'number') return undefined;
    progressUnits = { completed: raw.progressUnits.completed, ...(raw.progressUnits.total !== undefined ? { total: raw.progressUnits.total as number } : {}) };
  }
  let coverage: CoverageProgress | undefined;
  if (raw.coverage !== undefined) {
    coverage = parseCoverageProgress(raw.coverage);
    if (!coverage) return undefined;
  }
  if (raw.activePlanItemId !== undefined && typeof raw.activePlanItemId !== 'string') return undefined;
  const attention = parseAttentionState(raw.attention);
  if (!attention) return undefined;
  if (raw.latestCheckpointId !== undefined && typeof raw.latestCheckpointId !== 'string') return undefined;
  const limitations = parseLimitations(raw.limitations);
  if (!limitations) return undefined;
  let result: ResultSummary | undefined;
  if (raw.result !== undefined) {
    result = parseResultSummary(raw.result);
    if (!result) return undefined;
  }
  return {
    runId: raw.runId,
    lineageId: raw.lineageId,
    attempt: raw.attempt,
    lifecycle,
    completeness,
    elapsedMs: raw.elapsedMs,
    progressMode,
    attention,
    limitations,
    ...(raw.phase !== undefined ? { phase: raw.phase as RunPhase } : {}),
    ...(raw.currentAction !== undefined ? { currentAction: raw.currentAction as string } : {}),
    ...(raw.currentTarget !== undefined ? { currentTarget: raw.currentTarget as string } : {}),
    ...(progressUnits !== undefined ? { progressUnits } : {}),
    ...(coverage !== undefined ? { coverage } : {}),
    ...(raw.activePlanItemId !== undefined ? { activePlanItemId: raw.activePlanItemId as string } : {}),
    ...(raw.latestCheckpointId !== undefined ? { latestCheckpointId: raw.latestCheckpointId as string } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

function isKnownEvidenceOrigin(value: unknown): value is EvidenceOrigin {
  return (EVIDENCE_ORIGINS as readonly unknown[]).includes(value);
}

function parseEvidenceRange(raw: unknown): EvidenceRange | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.startLine !== 'number' || typeof raw.endLine !== 'number') return undefined;
  if (raw.startLine < 1 || raw.endLine < raw.startLine) return undefined;
  return { startLine: raw.startLine, endLine: raw.endLine };
}

function parseEvidenceLocation(raw: unknown): EvidenceLocation | undefined {
  if (!isRecord(raw)) return undefined;
  const range = parseEvidenceRange(raw.range);
  if (typeof raw.path !== 'string' || !range) return undefined;
  if (raw.side !== undefined && raw.side !== 'old' && raw.side !== 'new') return undefined;
  return { path: raw.path, range, ...(raw.side !== undefined ? { side: raw.side } : {}) };
}

function parseEvidenceTruncation(raw: unknown): EvidenceTruncation | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.hasContinuation !== 'boolean') return undefined;
  if (raw.knownRemainingUnits !== undefined && typeof raw.knownRemainingUnits !== 'number') return undefined;
  return { hasContinuation: raw.hasContinuation, ...(raw.knownRemainingUnits !== undefined ? { knownRemainingUnits: raw.knownRemainingUnits as number } : {}) };
}

function parseRetainedEvidenceRecord(raw: unknown): RetainedEvidenceRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const kind = parseEvidenceKind(raw.kind);
  const completeness = parseEvidenceCompleteness(raw.completeness);
  if (!kind || !completeness) return undefined;
  if (!isKnownEvidenceOrigin(raw.origin)) return undefined;
  if (typeof raw.sourceId !== 'string' || typeof raw.digest !== 'string') return undefined;
  if (typeof raw.memberId !== 'string' || typeof raw.repositoryId !== 'string') return undefined;
  if (typeof raw.baseSha !== 'string' || typeof raw.headSha !== 'string') return undefined;
  if (raw.revision !== undefined && raw.revision !== 'base' && raw.revision !== 'head') return undefined;
  if (raw.path !== undefined && typeof raw.path !== 'string') return undefined;
  let range: EvidenceRange | undefined;
  if (raw.range !== undefined) {
    range = parseEvidenceRange(raw.range);
    if (!range) return undefined;
  }
  const locations = parseArray(raw.locations, parseEvidenceLocation);
  if (!locations) return undefined;
  let truncation: EvidenceTruncation | undefined;
  if (raw.truncation !== undefined) {
    truncation = parseEvidenceTruncation(raw.truncation);
    if (!truncation) return undefined;
  }
  if (raw.snapshotContentDigest !== undefined && typeof raw.snapshotContentDigest !== 'string') return undefined;
  if (typeof raw.fetchedInAttempt !== 'number') return undefined;
  if (raw.exactContent !== undefined && typeof raw.exactContent !== 'string') return undefined;
  return {
    sourceId: raw.sourceId,
    digest: raw.digest,
    kind,
    origin: raw.origin,
    memberId: raw.memberId,
    repositoryId: raw.repositoryId,
    baseSha: raw.baseSha,
    headSha: raw.headSha,
    completeness,
    locations,
    fetchedInAttempt: raw.fetchedInAttempt,
    ...(raw.revision !== undefined ? { revision: raw.revision as 'base' | 'head' } : {}),
    ...(raw.path !== undefined ? { path: raw.path as string } : {}),
    ...(range !== undefined ? { range } : {}),
    ...(truncation !== undefined ? { truncation } : {}),
    ...(raw.snapshotContentDigest !== undefined ? { snapshotContentDigest: raw.snapshotContentDigest as string } : {}),
    ...(raw.exactContent !== undefined ? { exactContent: raw.exactContent as string } : {}),
  };
}

const TRACKED_CANDIDATE_STATES: readonly TrackedCandidateState[] = ['accepted', 'unresolved', 'rejected'];

function isTrackedCandidateState(value: unknown): value is TrackedCandidateState {
  return (TRACKED_CANDIDATE_STATES as readonly unknown[]).includes(value);
}

function isKnownSeverity(value: unknown): value is Severity {
  return (SEVERITY_ORDER as readonly unknown[]).includes(value);
}

function isKnownCategory(value: unknown): value is Category {
  return (ALL_CATEGORIES as readonly unknown[]).includes(value);
}

function parseValidationReason(raw: unknown): ValidationReason | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.code !== 'string' || typeof raw.message !== 'string') return undefined;
  return { code: raw.code, message: raw.message };
}

function parseReviewItemSpan(raw: unknown): { repoId: string; location: string; role: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.repoId !== 'string' || typeof raw.location !== 'string' || typeof raw.role !== 'string') return undefined;
  return { repoId: raw.repoId, location: raw.location, role: raw.role };
}

function parseReviewItem(raw: unknown): ReviewItem | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.id !== 'string' || typeof raw.file !== 'string' || typeof raw.anchored !== 'boolean') return undefined;
  if (typeof raw.line !== 'number') return undefined;
  if (raw.endLine !== undefined && typeof raw.endLine !== 'number') return undefined;
  if (!isKnownSeverity(raw.severity) || !isKnownCategory(raw.category)) return undefined;
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 100) return undefined;
  if (typeof raw.title !== 'string' || typeof raw.body !== 'string' || typeof raw.code !== 'string') return undefined;
  if (raw.rule !== undefined && typeof raw.rule !== 'string') return undefined;
  if (raw.reference !== undefined && typeof raw.reference !== 'string') return undefined;
  if (raw.repoId !== undefined && typeof raw.repoId !== 'string') return undefined;
  if (raw.crNumber !== undefined && typeof raw.crNumber !== 'string') return undefined;
  if (raw.cross !== undefined && typeof raw.cross !== 'boolean') return undefined;
  if (raw.suggestion !== undefined) {
    if (!isRecord(raw.suggestion) || typeof raw.suggestion.old !== 'string' || typeof raw.suggestion.new !== 'string') return undefined;
  }
  let spans: Array<{ repoId: string; location: string; role: string }> | undefined;
  if (raw.spans !== undefined) {
    spans = parseArray(raw.spans, parseReviewItemSpan);
    if (!spans) return undefined;
  }
  return {
    id: raw.id,
    file: raw.file,
    anchored: raw.anchored,
    line: raw.line,
    severity: raw.severity,
    category: raw.category,
    confidence: raw.confidence,
    title: raw.title,
    body: raw.body,
    code: raw.code,
    ...(raw.endLine !== undefined ? { endLine: raw.endLine as number } : {}),
    ...(raw.rule !== undefined ? { rule: raw.rule as string } : {}),
    ...(raw.reference !== undefined ? { reference: raw.reference as string } : {}),
    ...(raw.repoId !== undefined ? { repoId: raw.repoId as string } : {}),
    ...(raw.crNumber !== undefined ? { crNumber: raw.crNumber as string } : {}),
    ...(raw.cross !== undefined ? { cross: raw.cross as boolean } : {}),
    ...(raw.suggestion !== undefined ? { suggestion: raw.suggestion as { old: string; new: string } } : {}),
    ...(spans !== undefined ? { spans } : {}),
  };
}

function parseSourceCitation(raw: unknown): SourceCitation | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.sourceId !== 'string' || typeof raw.digest !== 'string') return undefined;
  if (raw.path !== undefined && typeof raw.path !== 'string') return undefined;
  let range: EvidenceRange | undefined;
  if (raw.range !== undefined) {
    range = parseEvidenceRange(raw.range);
    if (!range) return undefined;
  }
  return { sourceId: raw.sourceId, digest: raw.digest, ...(raw.path !== undefined ? { path: raw.path as string } : {}), ...(range !== undefined ? { range } : {}) };
}

function parseValidatedFindingProvenance(raw: unknown): ValidatedFindingProvenance | undefined {
  if (!isRecord(raw)) return undefined;
  const protocolProvenance = parseProtocolProvenance(raw.protocolProvenance);
  const citations = parseArray(raw.citations, parseSourceCitation);
  if (!protocolProvenance || !citations) return undefined;
  if (typeof raw.validatedAt !== 'string') return undefined;
  return { protocolProvenance, citations, validatedAt: raw.validatedAt };
}

function parseCitedEvidenceRef(raw: unknown): CitedEvidenceRef | undefined {
  if (!isRecord(raw)) return undefined;
  if (!isKnownEvidenceOrigin(raw.origin)) return undefined;
  const range = parseEvidenceRange(raw.range);
  if (!range) return undefined;
  if (typeof raw.sourceId !== 'string' || typeof raw.digest !== 'string') return undefined;
  if (typeof raw.memberId !== 'string' || typeof raw.repositoryId !== 'string') return undefined;
  if (typeof raw.baseSha !== 'string' || typeof raw.headSha !== 'string' || typeof raw.path !== 'string') return undefined;
  return { sourceId: raw.sourceId, digest: raw.digest, origin: raw.origin, memberId: raw.memberId, repositoryId: raw.repositoryId, baseSha: raw.baseSha, headSha: raw.headSha, path: raw.path, range };
}

function parseValidatedFinding(raw: unknown): ValidatedFinding | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.candidateId !== 'string' || typeof raw.memberId !== 'string') return undefined;
  if (raw.routing !== 'inline' && raw.routing !== 'summary') return undefined;
  const item = parseReviewItem(raw.item);
  const provenance = parseValidatedFindingProvenance(raw.provenance);
  if (!item || !provenance) return undefined;
  if (!isRecord(raw.evidence)) return undefined;
  const evidence = raw.evidence;
  if (typeof evidence.repositoryId !== 'string' || typeof evidence.baseSha !== 'string' || typeof evidence.headSha !== 'string') return undefined;
  const primary = parseCitedEvidenceRef(evidence.primary);
  const supporting = parseArray(evidence.supporting, parseCitedEvidenceRef);
  if (!primary || !supporting) return undefined;
  return {
    candidateId: raw.candidateId,
    memberId: raw.memberId,
    routing: raw.routing as FindingRouting,
    item,
    provenance,
    evidence: { repositoryId: evidence.repositoryId, baseSha: evidence.baseSha, headSha: evidence.headSha, primary, supporting },
  };
}

function parseTrackedCandidate(raw: unknown): TrackedCandidate | undefined {
  if (!isRecord(raw)) return undefined;
  const state = isTrackedCandidateState(raw.state) ? raw.state : undefined;
  if (typeof raw.candidateId !== 'string' || !state) return undefined;
  if (typeof raw.repairs !== 'number' || raw.repairs < 0) return undefined;
  const reasons = parseArray(raw.reasons, parseValidationReason);
  if (!reasons) return undefined;
  if (raw.finding === undefined) return { candidateId: raw.candidateId, state, repairs: raw.repairs, reasons };
  const finding = parseValidatedFinding(raw.finding);
  if (!finding) return undefined;
  return { candidateId: raw.candidateId, state, repairs: raw.repairs, reasons, finding };
}

function parseContradictedFindingRecord(raw: unknown): ContradictedFindingRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.candidateId !== 'string' || typeof raw.reason !== 'string') return undefined;
  return { candidateId: raw.candidateId, reason: raw.reason };
}

function parseBudgetConsumption(raw: unknown): BudgetConsumption | undefined {
  if (!isRecord(raw)) return undefined;
  const fields = ['modelTurnsUsed', 'toolCallsUsed', 'evidenceBytesUsed', 'elapsedMs', 'highRiskReserveUsed', 'verificationReserveUsed'] as const;
  for (const field of fields) {
    if (typeof raw[field] !== 'number' || raw[field] < 0) return undefined;
  }
  return {
    modelTurnsUsed: raw.modelTurnsUsed as number,
    toolCallsUsed: raw.toolCallsUsed as number,
    evidenceBytesUsed: raw.evidenceBytesUsed as number,
    elapsedMs: raw.elapsedMs as number,
    highRiskReserveUsed: raw.highRiskReserveUsed as number,
    verificationReserveUsed: raw.verificationReserveUsed as number,
  };
}

function parseChangedFileRecord(raw: unknown): ChangedFileRecord | undefined {
  if (!isRecord(raw)) return undefined;
  const state = parseFileInspectionState(raw.state);
  if (typeof raw.path !== 'string' || typeof raw.memberId !== 'string' || !state) return undefined;
  if (raw.risk !== undefined && !isRiskLevel(raw.risk)) return undefined;
  if (raw.logicalUnit !== undefined && typeof raw.logicalUnit !== 'string') return undefined;
  if (raw.reason !== undefined && typeof raw.reason !== 'string') return undefined;
  return {
    path: raw.path,
    memberId: raw.memberId,
    state,
    ...(raw.risk !== undefined ? { risk: raw.risk as RiskLevel } : {}),
    ...(raw.logicalUnit !== undefined ? { logicalUnit: raw.logicalUnit as string } : {}),
    ...(raw.reason !== undefined ? { reason: raw.reason as string } : {}),
  };
}

function parseMemberCoverage(raw: unknown): MemberCoverage | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.memberId !== 'string' || typeof raw.manifestComplete !== 'boolean') return undefined;
  if (raw.totalFiles !== undefined && typeof raw.totalFiles !== 'number') return undefined;
  const files = parseArray(raw.files, parseChangedFileRecord);
  if (!files) return undefined;
  return { memberId: raw.memberId, manifestComplete: raw.manifestComplete, files, ...(raw.totalFiles !== undefined ? { totalFiles: raw.totalFiles as number } : {}) };
}

function parseUnresolvedWork(raw: unknown): UnresolvedWork | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.unresolvedFetches !== 'number' || typeof raw.unresolvedCandidates !== 'number') return undefined;
  return { unresolvedFetches: raw.unresolvedFetches, unresolvedCandidates: raw.unresolvedCandidates };
}

/** Reused by `harnessCheckpoint.test.ts`-style callers and this module's own round-trip test. */
export function parsePersistedCheckpoint(raw: unknown): PersistedCheckpoint | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.checkpointId !== 'string' || typeof raw.runId !== 'string' || typeof raw.lineageId !== 'string') return undefined;
  if (typeof raw.attempt !== 'number') return undefined;
  const phase = parseRunPhase(raw.phase);
  const reason = parseCheckpointReason(raw.reason);
  if (!phase || !reason) return undefined;
  if (typeof raw.occurredAt !== 'string' || Number.isNaN(Date.parse(raw.occurredAt))) return undefined;
  if (typeof raw.elapsedMs !== 'number' || typeof raw.snapshotDigest !== 'string') return undefined;

  const identity = { runId: raw.runId as RunId, lineageId: raw.lineageId as LineageId, attempt: raw.attempt };
  let plan: Plan | undefined;
  if (raw.plan !== undefined) {
    plan = parsePlan(raw.plan);
    if (!plan) return undefined;
  }
  const projection = parseRunProjection(raw.projection);
  const activity = parseArray(raw.activity, (item) => parseActivityEvent(item, identity));
  const evidence = parseArray(raw.evidence, parseRetainedEvidenceRecord);
  const candidates = parseArray(raw.candidates, parseTrackedCandidate);
  const contradicted = parseArray(raw.contradicted, parseContradictedFindingRecord);
  const budget = parseBudgetConsumption(raw.budget);
  const coverage = parseArray(raw.coverage, parseMemberCoverage);
  const unresolved = parseUnresolvedWork(raw.unresolved);
  if (!projection || !activity || !evidence || !candidates || !contradicted || !budget || !coverage || !unresolved) return undefined;
  if (!isRecord(raw.retry) || !isRetryState(raw.retry)) return undefined;
  if (typeof raw.bytes !== 'number' || typeof raw.compatible !== 'boolean') return undefined;
  const incompatibilityReasons = parseArray(raw.incompatibilityReasons, (item) => (typeof item === 'string' ? item : undefined));
  if (!incompatibilityReasons) return undefined;

  return {
    checkpointId: raw.checkpointId,
    runId: identity.runId,
    lineageId: identity.lineageId,
    attempt: identity.attempt,
    phase,
    reason,
    occurredAt: raw.occurredAt,
    elapsedMs: raw.elapsedMs,
    snapshotDigest: raw.snapshotDigest,
    plan,
    // Recomputed from the just-validated activity rather than trusting the persisted copy: the
    // projection is a pure function of activity (`reduceActivity`), so this is strictly more
    // trustworthy than re-parsing a second, independently-corruptible cached blob of the same
    // information — and it is the one place this module deliberately does not use its own
    // `parseRunProjection` (still exported and tested, for a caller that has activity from
    // elsewhere and only a projection blob to check).
    projection: reduceActivityForRead(identity, activity),
    activity,
    evidence,
    candidates,
    contradicted,
    budget,
    coverage,
    unresolved,
    retry: raw.retry,
    bytes: raw.bytes,
    compatible: raw.compatible,
    incompatibilityReasons,
  };
}

function reduceActivityForRead(identity: { runId: RunId; lineageId: LineageId; attempt: AttemptNumber }, events: readonly ActivityEvent[]): RunProjection {
  return reduceActivity({ runId: identity.runId, lineageId: identity.lineageId, attempt: identity.attempt, events });
}

function parseTerminalAttemptMarker(raw: unknown): TerminalAttemptMarker | undefined {
  if (!isRecord(raw)) return undefined;
  const lifecycle = parseRunLifecycle(raw.lifecycle);
  const completeness = parseResultCompleteness(raw.completeness);
  if (typeof raw.attempt !== 'number' || !lifecycle || !completeness) return undefined;
  if (typeof raw.occurredAt !== 'string' || Number.isNaN(Date.parse(raw.occurredAt))) return undefined;
  return { attempt: raw.attempt, lifecycle, completeness, occurredAt: raw.occurredAt };
}

function parsePersistedLineageRecord(raw: unknown): PersistedLineageRecord | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== SCHEMA_VERSION) return undefined;
  if (typeof raw.runId !== 'string' || typeof raw.lineageId !== 'string') return undefined;
  if (!isRecord(raw.snapshots)) return undefined;
  const snapshots: Record<string, ReviewRunSnapshot> = {};
  for (const [attemptKey, value] of Object.entries(raw.snapshots)) {
    // `ReviewRunSnapshot` (task 2.2) already has its own established shape without a bespoke
    // parser in this change; a coarse structural check (object with the identity fields this
    // module itself relies on) is enough to fail closed on a wildly wrong value without
    // duplicating that type's full validation here.
    if (!isRecord(value) || typeof value.runId !== 'string' || typeof value.lineageId !== 'string' || typeof value.attempt !== 'number') return undefined;
    snapshots[attemptKey] = value as unknown as ReviewRunSnapshot;
  }
  const checkpoints = parseArray(raw.checkpoints, parsePersistedCheckpoint);
  const terminalAttempts = parseArray(raw.terminalAttempts, parseTerminalAttemptMarker);
  if (!checkpoints || !terminalAttempts) return undefined;
  return { schemaVersion: SCHEMA_VERSION, runId: raw.runId, lineageId: raw.lineageId, snapshots, checkpoints, terminalAttempts };
}

function parsePersistedRunIndex(raw: unknown): PersistedRunIndex | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== SCHEMA_VERSION || typeof raw.runId !== 'string') return undefined;
  const lineageIds = parseArray(raw.lineageIds, (item) => (typeof item === 'string' ? item : undefined));
  if (!lineageIds) return undefined;
  return { schemaVersion: SCHEMA_VERSION, runId: raw.runId, lineageIds };
}

// ---- The store -----------------------------------------------------------------------

export interface HarnessRunStoreOptions {
  /** Epoch milliseconds — injected, never read from `Date.now()` inline (age-based retention, D13/11.4). */
  readonly now: () => number;
}

/** The four 11.4 bounds this store enforces, as one slice — every write call names them explicitly rather than the store defaulting or caching a policy from construction time, since a policy is versioned per run/snapshot (D3), not per store instance. */
export type RetentionPolicy = Pick<
  HarnessPolicy,
  'retainedCheckpointsPerLineage' | 'maxCheckpointBytesPerLineage' | 'terminalAttemptHistoryCount' | 'terminalAttemptHistoryMaxAgeDays'
>;

export interface HarnessRunStore {
  /** Persists (or updates) one attempt's immutable snapshot and registers its lineage under the run index. */
  writeSnapshot(snapshot: ReviewRunSnapshot): Promise<void>;
  /**
   * Appends one checkpoint, then enforces every 11.4 bound in order: routine
   * coalescing already happened in `buildCheckpoint`; here, whole older
   * checkpoints are evicted first for the count bound
   * (`retainedCheckpointsPerLineage`), then again for the aggregate byte
   * bound (`maxCheckpointBytesPerLineage`); only if the single newest
   * checkpoint still cannot fit is it marked incompatible. If this
   * checkpoint's own projection is terminal, the attempt's terminal marker is
   * recorded and the run-wide terminal-attempt-history bound
   * (`terminalAttemptHistoryCount`/`terminalAttemptHistoryMaxAgeDays`) is
   * re-applied across every lineage under the same run.
   */
  writeCheckpoint(checkpoint: PersistedCheckpoint, policy: RetentionPolicy): Promise<void>;
  /** Convenience: builds through `buildCheckpoint` then calls `writeCheckpoint` — the one funnel every real caller should use. */
  buildAndWriteCheckpoint(input: CheckpointBuildInput, policy: HarnessPolicy): Promise<PersistedCheckpoint>;
  readSnapshot(lineageId: LineageId, attempt: AttemptNumber): ReviewRunSnapshot | undefined;
  readLineage(lineageId: LineageId): PersistedLineageRecord | undefined;
  /** Every checkpoint in the lineage, oldest to newest; scoped to one attempt when given. */
  checkpointsFor(lineageId: LineageId, attempt?: AttemptNumber): readonly PersistedCheckpoint[];
  latestCheckpoint(lineageId: LineageId, attempt?: AttemptNumber): PersistedCheckpoint | undefined;
  lineageIdsForRun(runId: RunId): readonly LineageId[];
}

function readLineageRaw(store: KeyValueStore, lineageId: LineageId): PersistedLineageRecord | undefined {
  const raw = store.get<unknown>(lineageKey(lineageId));
  if (raw === undefined) return undefined;
  return parsePersistedLineageRecord(raw);
}

function readRunIndexRaw(store: KeyValueStore, runId: RunId): PersistedRunIndex | undefined {
  const raw = store.get<unknown>(runIndexKey(runId));
  if (raw === undefined) return undefined;
  return parsePersistedRunIndex(raw);
}

async function registerLineageInRunIndex(store: KeyValueStore, runId: RunId, lineageId: LineageId): Promise<void> {
  const existing = readRunIndexRaw(store, runId);
  const lineageIds = existing?.lineageIds ?? [];
  if (lineageIds.includes(lineageId)) return;
  const index: PersistedRunIndex = { schemaVersion: SCHEMA_VERSION, runId, lineageIds: [...lineageIds, lineageId] };
  await store.update(runIndexKey(runId), index);
}

/** Orders by `occurredAt`, then `checkpointId` as a deterministic tiebreaker (two checkpoints can share a timestamp). */
function byOccurredAt(a: PersistedCheckpoint, b: PersistedCheckpoint): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.checkpointId < b.checkpointId ? -1 : a.checkpointId > b.checkpointId ? 1 : 0;
}

/** Task 11.4's per-lineage bounds: count first, then aggregate bytes — both by evicting whole older checkpoints; only the single newest may end up marked incompatible, never stripped. */
function enforceLineageRetention(
  checkpoints: readonly PersistedCheckpoint[],
  policy: Pick<HarnessPolicy, 'retainedCheckpointsPerLineage' | 'maxCheckpointBytesPerLineage'>,
): readonly PersistedCheckpoint[] {
  let ordered = [...checkpoints].sort(byOccurredAt);
  if (ordered.length > policy.retainedCheckpointsPerLineage) {
    ordered = ordered.slice(ordered.length - policy.retainedCheckpointsPerLineage);
  }
  let totalBytes = ordered.reduce((sum, checkpoint) => sum + checkpoint.bytes, 0);
  while (totalBytes > policy.maxCheckpointBytesPerLineage && ordered.length > 1) {
    const evicted = ordered[0] as PersistedCheckpoint;
    ordered = ordered.slice(1);
    totalBytes -= evicted.bytes;
  }
  if (ordered.length === 1) {
    const only = ordered[0] as PersistedCheckpoint;
    if (only.bytes > policy.maxCheckpointBytesPerLineage && only.compatible) {
      ordered = [
        {
          ...only,
          compatible: false,
          incompatibilityReasons: [
            ...only.incompatibilityReasons,
            `This checkpoint alone is ${only.bytes} bytes, exceeding the ${policy.maxCheckpointBytesPerLineage}-byte per-lineage checkpoint bound; nothing further can be evicted without dropping protected content or cited evidence.`,
          ],
        },
      ];
    }
  }
  return ordered;
}

/**
 * Task 11.4's "terminal attempt history per target": across every lineage
 * the run index knows about, keep the newest `terminalAttemptHistoryCount`
 * terminal attempts and drop any older than `terminalAttemptHistoryMaxAgeDays`,
 * whichever removes an attempt first — dropping both its checkpoints and its
 * snapshot, never just its marker.
 *
 * The eviction *decision* (which attempts are too old/too many) is made from
 * one synchronous snapshot of every lineage's markers, taken up front. The
 * *write* for each affected lineage re-reads that one lineage synchronously
 * again, immediately before its own `store.update` — `storage.ts`'s
 * read-modify-write guarantee ("no `await` between a synchronous read and
 * the write it informed") holds per lineage even though this function
 * updates several lineages in the same call, because no lineage's read and
 * its own write ever have another lineage's `await` between them.
 */
async function enforceTerminalAttemptHistory(
  store: KeyValueStore,
  runId: RunId,
  policy: Pick<HarnessPolicy, 'terminalAttemptHistoryCount' | 'terminalAttemptHistoryMaxAgeDays'>,
  nowMs: number,
): Promise<void> {
  const index = readRunIndexRaw(store, runId);
  if (!index) return;
  const markers: Array<{ lineageId: LineageId; attempt: AttemptNumber; occurredAt: string }> = [];
  for (const lineageId of index.lineageIds) {
    const record = readLineageRaw(store, lineageId);
    if (!record) continue;
    for (const marker of record.terminalAttempts) markers.push({ lineageId, attempt: marker.attempt, occurredAt: marker.occurredAt });
  }
  if (markers.length === 0) return;
  markers.sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0)); // newest first
  const ageCutoffMs = nowMs - policy.terminalAttemptHistoryMaxAgeDays * 24 * 60 * 60 * 1000;
  const toEvict = markers.filter((marker, index2) => index2 >= policy.terminalAttemptHistoryCount || Date.parse(marker.occurredAt) < ageCutoffMs);
  if (toEvict.length === 0) return;

  const evictByLineage = new Map<LineageId, Set<AttemptNumber>>();
  for (const marker of toEvict) {
    const set = evictByLineage.get(marker.lineageId) ?? new Set<AttemptNumber>();
    set.add(marker.attempt);
    evictByLineage.set(marker.lineageId, set);
  }
  for (const [lineageId, attempts] of evictByLineage) {
    // Re-read fresh, synchronously, right before this lineage's own write — never reused from the
    // decision pass above, which may be stale by the time an earlier lineage's write in this same
    // loop has resolved.
    const record = readLineageRaw(store, lineageId);
    if (!record) continue;
    const nextSnapshots = { ...record.snapshots };
    for (const attempt of attempts) delete nextSnapshots[String(attempt)];
    const next: PersistedLineageRecord = {
      ...record,
      snapshots: nextSnapshots,
      checkpoints: record.checkpoints.filter((checkpoint) => !attempts.has(checkpoint.attempt)),
      terminalAttempts: record.terminalAttempts.filter((marker) => !attempts.has(marker.attempt)),
    };
    await store.update(lineageKey(lineageId), next);
  }
}

/**
 * Closures, not an object-literal `this`: a caller that destructures
 * `{ writeCheckpoint }` off the returned store (a common pattern for
 * injecting one method as a collaborator, e.g. into `HarnessAttemptOptions`)
 * must not silently lose its binding, which a `this`-based method would.
 */
export function createHarnessRunStore(store: KeyValueStore, options: HarnessRunStoreOptions): HarnessRunStore {
  async function writeSnapshot(snapshot: ReviewRunSnapshot): Promise<void> {
    const lineageId = snapshot.lineageId as LineageId;
    const runId = snapshot.runId as RunId;
    const existing = readLineageRaw(store, lineageId) ?? emptyLineageRecord(runId, lineageId);
    const next: PersistedLineageRecord = { ...existing, snapshots: { ...existing.snapshots, [String(snapshot.attempt)]: snapshot } };
    await store.update(lineageKey(lineageId), next);
    await registerLineageInRunIndex(store, runId, lineageId);
  }

  function checkpointsFor(lineageId: LineageId, attempt?: AttemptNumber): readonly PersistedCheckpoint[] {
    const record = readLineageRaw(store, lineageId);
    if (!record) return [];
    return attempt === undefined ? record.checkpoints : record.checkpoints.filter((checkpoint) => checkpoint.attempt === attempt);
  }

  function latestCheckpoint(lineageId: LineageId, attempt?: AttemptNumber): PersistedCheckpoint | undefined {
    const scoped = checkpointsFor(lineageId, attempt);
    return scoped.length > 0 ? scoped[scoped.length - 1] : undefined;
  }

  async function writeCheckpoint(checkpoint: PersistedCheckpoint, policy: RetentionPolicy): Promise<void> {
    const lineageId = checkpoint.lineageId as LineageId;
    const runId = checkpoint.runId as RunId;
    const existing = readLineageRaw(store, lineageId) ?? emptyLineageRecord(runId, lineageId);
    // Idempotent by checkpointId: a redelivered write replaces rather than duplicates.
    const withoutDuplicate = existing.checkpoints.filter((prior) => prior.checkpointId !== checkpoint.checkpointId);
    const appended = enforceLineageRetention([...withoutDuplicate, checkpoint], policy);

    let terminalAttempts = existing.terminalAttempts;
    if (isTerminalLifecycle(checkpoint.projection.lifecycle)) {
      const marker: TerminalAttemptMarker = {
        attempt: checkpoint.attempt,
        lifecycle: checkpoint.projection.lifecycle,
        completeness: checkpoint.projection.completeness,
        occurredAt: checkpoint.occurredAt,
      };
      terminalAttempts = [...terminalAttempts.filter((existingMarker) => existingMarker.attempt !== marker.attempt), marker];
    }

    const next: PersistedLineageRecord = { ...existing, checkpoints: appended, terminalAttempts };
    await store.update(lineageKey(lineageId), next);
    await registerLineageInRunIndex(store, runId, lineageId);

    if (isTerminalLifecycle(checkpoint.projection.lifecycle)) {
      await enforceTerminalAttemptHistory(store, runId, policy, options.now());
    }
  }

  async function buildAndWriteCheckpoint(input: CheckpointBuildInput, policy: HarnessPolicy): Promise<PersistedCheckpoint> {
    const built = buildCheckpoint(input, policy);
    await writeCheckpoint(built, policy);
    // Returns the *stored* checkpoint, not `built`: retention (11.4) may have marked it
    // incompatible (the single-checkpoint-alone-too-big case) after `writeCheckpoint` ran, and a
    // caller reading the return value should see exactly what a subsequent read would.
    return latestCheckpoint(built.lineageId as LineageId, built.attempt) ?? built;
  }

  return {
    writeSnapshot,
    writeCheckpoint,
    buildAndWriteCheckpoint,
    readSnapshot: (lineageId, attempt) => readLineageRaw(store, lineageId)?.snapshots[String(attempt)],
    readLineage: (lineageId) => readLineageRaw(store, lineageId),
    checkpointsFor,
    latestCheckpoint,
    lineageIdsForRun: (runId) => readRunIndexRaw(store, runId)?.lineageIds ?? [],
  };
}
