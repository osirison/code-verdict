/**
 * The bounded, typed model protocol (task 10.1 of `add-agentic-review-harness`,
 * design.md D5, spec `agentic-review-harness` "Review work follows explicit
 * phases" and "Budgets and retries degrade truthfully" — the malformed-protocol
 * scenario).
 *
 * `parseModelTurn` is the sole entry point: it takes one model turn's raw
 * text and the current `RunPhase`, and returns either a bounded batch of
 * typed `ProtocolMessage`s or a typed, bounded failure. It never returns a
 * final free-form review — the legacy `parseAgentReviewResponse`
 * (`./agentResponse.ts`) is untouched and still owns that one-shot path
 * until task 15.8 removes it.
 *
 * **Placement.** This file lives under `src/domain/` per the task's suggested
 * layout, but it imports three functions from `src/app/`:
 * `createPlan`/`revisePlan` (`../app/harnessActivityPlan`),
 * `parseCandidateFinding` (`../app/harnessCandidateValidation`), and
 * `sanitizePublicText` (`../app/harnessActivitySanitizer`). `src/domain/agentResponse.ts`
 * — the module this one succeeds — already imports from `../app/modelVisiblePath`
 * and `../app/reviewContext`, so a domain module depending on a handful of
 * pure app-layer functions is established precedent in this codebase, not a
 * new layering violation. Nothing here imports `vscode` or anything under
 * `src/providers/`.
 *
 * **REUSE, DO NOT REINVENT.** Every message kind whose shape already has a
 * host-owned model is parsed through that model, never a parallel one:
 * - `planCreated`/`planRevised` build `PlanItemInput[]` field-by-field from
 *   raw JSON, then call the existing `createPlan`/`revisePlan`
 *   (`../app/harnessActivityPlan`) — the only place stable plan-item ids and
 *   revision-preserves-prior-ids logic live.
 * - `candidateSubmission` hands its raw `candidate` payload straight to the
 *   existing `parseCandidateFinding` (`../app/harnessCandidateValidation`) —
 *   no second candidate schema exists here. Citation *resolution* against
 *   the evidence ledger stays the dispatcher's job (`../app/harnessToolDispatcher`,
 *   already built in section 9); this module only gets as far as a
 *   structurally valid `CandidateFinding`.
 * - `toolRequest` validates its tool name against the existing
 *   `hostToolDefinition`/`isHostToolName` (`./harnessTools`) and shapes its
 *   arguments into the exact request types the dispatcher already declares
 *   in `../platform/types` (`ChangedFileManifestRequest`, `DiffPageRequest`,
 *   ...). This is a *shape* check only — path normalization, revision
 *   matching, cursor provenance, capability, budget, and cancellation stay
 *   the dispatcher's ten-step validation (`../app/harnessToolDispatcher.ts`'s
 *   own header). `submitCandidateFinding` and `requestCompletion` are
 *   deliberately **not** reachable through `toolRequest` — see
 *   `candidateSubmission`/`completionRequest` below.
 * - Every public string field (plan item descriptions, revision rationale,
 *   public rationale messages, checkpoint reasons, completion rationale) is
 *   sanitized through the existing `sanitizePublicText`
 *   (`../app/harnessActivitySanitizer`), reused, never reimplemented.
 *
 * **Why `candidateSubmission` and `completionRequest` are their own message
 * kinds, not `toolRequest{tool:'submitCandidateFinding'|'requestCompletion'}`.**
 * Design.md D5 lists "incremental candidate-finding submissions" and
 * "completion request" as discriminants of the protocol union, separate from
 * "bounded tool requests" — even though section 9's host tool *catalog*
 * (`./harnessTools.ts`) also carries both as `hostAction` tool definitions
 * alongside the eight provider-read tools, because the *dispatcher* legally
 * treats all ten uniformly once a request reaches it. At the *protocol*
 * layer, giving these two host actions their own dedicated message kinds —
 * rather than letting a generic `toolRequest` name them too — is what keeps
 * "reuse, don't reinvent" true: `candidateSubmission` is the single path
 * that reaches `parseCandidateFinding`, and there is exactly one way for a
 * model turn to submit a candidate or request completion, not two competing
 * ones. `toolRequest`'s own `tool` field is therefore typed to the remaining
 * eight read/investigation names only; a turn that names
 * `submitCandidateFinding` or `requestCompletion` inside a `toolRequest`
 * envelope fails to parse with a reason pointing at the correct kind.
 *
 * **D5 correctness rules, and where each is enforced:**
 *
 * 1. *Fail-closed discriminated union.* Every message kind's parser returns
 *    `undefined`/a bounded reason on anything unexpected — unknown `kind`,
 *    missing discriminant, wrong-typed field, oversized field, excess
 *    nesting — never a best-effort coercion. See `withinDepth` (nesting) and
 *    `boundedString`/`positiveInt`/... (typed, length-capped fields) below.
 *    Oversized-field handling has one documented split: fields this module
 *    owns directly (tool-call arguments, checkpoint reasons, completion
 *    rationale, identifiers) are rejected outright when they exceed
 *    `MAX_PROTOCOL_STRING_LENGTH`; fields owned by a reused module (plan item
 *    descriptions/rationale via `sanitizePublicText`'s existing 240-char
 *    truncate-and-continue behavior, `parseCandidateFinding`'s own
 *    truncate-at-4000-chars fields) keep that module's already-approved
 *    behavior rather than growing a second, stricter rule in front of it.
 *    `MAX_TURN_RAW_BYTES` bounds the whole turn before any of that runs, so
 *    a pathological turn is rejected wholesale before a reused module's
 *    truncation path is ever reached.
 * 2. *Bounded batch, defined co-occurrence.* `MAX_PROTOCOL_MESSAGES_PER_TURN`
 *    bounds the whole batch; `HarnessPolicy.maxToolRequestsPerTurn` (reused,
 *    never redefined) bounds `toolRequest` messages specifically, per the
 *    task brief's explicit instruction. `validateBatchCompatibility` defines
 *    which kinds may co-occur.
 * 3. *Raw text cannot leave this module.* No field on `ProtocolMessage`,
 *    `ParsedToolCall`, `TurnParseMeta`, or `TurnParseOutcome` ever holds the
 *    original raw string or a raw JSON subtree copied by reference — every
 *    output field is extracted and reconstructed one primitive at a time
 *    (never `{...raw}` spread), so an unrecognized extra field is silently
 *    ignored rather than carried through. `harnessProtocol.test.ts` asserts
 *    this with a raw payload containing a distinctive marker string.
 * 4. *Phase-specific turn contracts (task 10.2, half of it — the other half,
 *    the repair loop, is `../app/harnessTurn.ts`).* `phaseAllowsKind` first
 *    gates on whether `phase` is one where the model gets a turn at all
 *    (`planning`/`investigating`/`verifying` — `bootstrap`/`completing`/
 *    `persisting` are host-only phases with no model turn, so every message
 *    is a contract violation there, never a parse failure). Only inside
 *    those three phases does it apply either this module's own
 *    `NON_TOOL_ALLOWED_PHASES` table (the five kinds with no existing
 *    catalog entry) or the *reused* `hostToolDefinition(...).allowedPhases`
 *    (for `toolRequest`, keyed by the actual tool name; `candidateSubmission`;
 *    `completionRequest`). `PHASE_ALLOWED_KINDS` is the full six-phase,
 *    eight-kind table derived from both, exported for introspection/tests.
 *    A message that parses (well-formed) but fails this phase check is a
 *    `contract` failure; anything that fails to parse at all is a `parse`
 *    failure — the two carry different `failureKind`s on `TurnParseOutcome`.
 *    A `planCreated` sent when `context.previousPlan` already exists, and a
 *    `planRevised` sent when it does not, are symmetric *state*-precondition
 *    failures (not phase failures) and are both classified `parse`.
 *
 * Bounded repair (D5 rule 5) and "raw text is discarded, only metadata
 * survives" (repair count specifically) are `../app/harnessTurn.ts`'s job,
 * layered on top of this pure function.
 */
import type { CandidateFinding, ValidationReason } from '../app/harnessCandidateValidation';
import { parseCandidateFinding } from '../app/harnessCandidateValidation';
import { createPlan, revisePlan, type PlanItemInput } from '../app/harnessActivityPlan';
import { MAX_PUBLIC_TEXT_LENGTH, sanitizePublicText } from '../app/harnessActivitySanitizer';
import type {
  ChangedFileManifestRequest,
  ChangeRequestDetailRequest,
  DetailSection,
  DiffPageRequest,
  DiffSearchRequest,
  FileRangeRequest,
  InvestigationSnapshotRef,
  IssueDetailRequest,
  PinnedRevision,
  RepositorySearchRequest,
} from '../platform/types';
import { isPlanItemState, isRunPhase, type Plan, type PlanItemState, type RunPhase } from './harnessActivity';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from './harnessPolicy';
import { hostToolDefinition, isHostToolName, type HostToolName } from './harnessTools';

/**
 * Versions this protocol's *message shapes* — independent of
 * `HARNESS_TOOL_CONTRACT_VERSION` (`./harnessTools.ts`), which versions the
 * host tool *catalog* (names/phases/bounds a `toolRequest` validates
 * against). The two can change independently: adding an eleventh host tool
 * bumps `HARNESS_TOOL_CONTRACT_VERSION` without touching how a `planCreated`
 * or `completionRequest` message is shaped, and vice versa.
 */
export const PROTOCOL_VERSION = '1';

// ---- Message kinds ----------------------------------------------------------------

export const PROTOCOL_MESSAGE_KINDS = [
  'planCreated',
  'planRevised',
  'planItemStateChanged',
  'publicRationale',
  'toolRequest',
  'candidateSubmission',
  'checkpointSuggestion',
  'completionRequest',
] as const;

export type ProtocolMessageKind = (typeof PROTOCOL_MESSAGE_KINDS)[number];

export function isProtocolMessageKind(value: unknown): value is ProtocolMessageKind {
  return (PROTOCOL_MESSAGE_KINDS as readonly string[]).includes(value as string);
}

/** The eight read/investigation tools a `toolRequest` may name — `submitCandidateFinding` and `requestCompletion` have their own dedicated kinds below. */
export type ReadHostToolName = Exclude<HostToolName, 'submitCandidateFinding' | 'requestCompletion'>;

export type ParsedToolCall =
  | { readonly tool: 'listChangedFiles'; readonly memberId: string; readonly request: ChangedFileManifestRequest }
  | { readonly tool: 'readDiff'; readonly memberId: string; readonly request: DiffPageRequest }
  | { readonly tool: 'readFile'; readonly memberId: string; readonly request: FileRangeRequest }
  | { readonly tool: 'searchRepository'; readonly memberId: string; readonly request: RepositorySearchRequest }
  | { readonly tool: 'searchDiff'; readonly memberId: string; readonly request: DiffSearchRequest }
  | { readonly tool: 'resolvePolicy'; readonly memberId: string; readonly changedPath: string }
  | { readonly tool: 'getChangeRequestDetails'; readonly memberId: string; readonly request: ChangeRequestDetailRequest }
  | { readonly tool: 'getIssueDetails'; readonly memberId: string; readonly request: IssueDetailRequest };

export interface PlanCreatedMessage {
  readonly kind: 'planCreated';
  readonly plan: Plan;
}

export interface PlanRevisedMessage {
  readonly kind: 'planRevised';
  readonly plan: Plan;
}

export interface PlanItemStateChangedMessage {
  readonly kind: 'planItemStateChanged';
  readonly itemId: string;
  readonly state: PlanItemState;
}

/** D5's "public rationale describes why visible work changed" as its own turn message, distinct from a plan revision's own `rationale` field. */
export interface PublicRationaleMessage {
  readonly kind: 'publicRationale';
  readonly rationale: string;
  readonly itemId?: string;
}

export interface ToolRequestMessage {
  readonly kind: 'toolRequest';
  readonly call: ParsedToolCall;
}

export interface CandidateSubmissionMessage {
  readonly kind: 'candidateSubmission';
  readonly candidate: CandidateFinding;
}

export interface CheckpointSuggestionMessage {
  readonly kind: 'checkpointSuggestion';
  readonly reason?: string;
}

/**
 * Mirrors the dispatcher's actual `RequestCompletionToolRequest`
 * (`../app/harnessToolDispatcher.ts`): `{tool:'requestCompletion', memberId?}`
 * plus common envelope fields. The host completion gate (`../app/harnessCompletion.ts`)
 * is what actually decides completion (D11) — the model's claim is advisory,
 * so `rationale` is public "why I think we're done" text, not an input the
 * gate consumes.
 */
export interface CompletionRequestMessage {
  readonly kind: 'completionRequest';
  readonly memberId?: string;
  readonly rationale?: string;
}

export type ProtocolMessage =
  | PlanCreatedMessage
  | PlanRevisedMessage
  | PlanItemStateChangedMessage
  | PublicRationaleMessage
  | ToolRequestMessage
  | CandidateSubmissionMessage
  | CheckpointSuggestionMessage
  | CompletionRequestMessage;

// ---- Bounds -------------------------------------------------------------------------

/**
 * Bounds the whole raw turn before any JSON parsing or reused-module
 * truncation runs. Not a `HarnessPolicy` field: a model turn is prose+JSON
 * being parsed into a bounded batch of small messages, not evidence
 * (`maxToolResultBytes` bounds a *tool result*, a different thing this
 * module never returns). 64 KiB comfortably fits `MAX_PROTOCOL_MESSAGES_PER_TURN`
 * worth of legitimate messages while still failing closed on a pathological
 * turn.
 */
export const MAX_TURN_RAW_BYTES = 64 * 1024;

/** Nesting bound applied to each raw message value before any field is extracted from it. Legitimate shapes nest at most ~4 deep (message -> request -> snapshot -> field, or candidate -> citations -> primary -> range); 6 leaves headroom without allowing a depth bomb. */
export const MAX_MESSAGE_DEPTH = 6;

/**
 * Total messages allowed in one turn, independent of and larger than
 * `HarnessPolicy.maxToolRequestsPerTurn` (which the brief requires reusing
 * for `toolRequest` specifically). Covers the policy default of 8 tool
 * requests plus generous room for plan-item transitions, candidate
 * submissions, and the handful of singleton kinds (plan shaping, rationale,
 * checkpoint, completion) — a turn needing more than this should split
 * across multiple turns rather than grow this cap.
 */
export const MAX_PROTOCOL_MESSAGES_PER_TURN = 32;

/** Length bound for protocol-owned free-text/identifier fields (tool paths, queries, member/item ids, checkpoint reasons, completion rationale). Generous versus the dispatcher's own tighter, policy-driven bounds (e.g. the 500-char search query cap, `diffOrFileReadPageLines`) — those stay the dispatcher's job; this only fails closed on a pathological field before dispatch is ever reached. */
export const MAX_PROTOCOL_STRING_LENGTH = 2000;

/** Length bound for protocol-owned short identifiers (member id, plan-item id). */
export const MAX_ID_LENGTH = 200;

const MAX_REPAIR_REASONS = 8;

// ---- Small parse helpers ------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail-closed depth check over an already-parsed JSON value; also refuses a circular reference (which JSON.parse output can never contain, but a defensive input might). */
function withinDepth(value: unknown, maxDepth: number, seen: WeakSet<object> = new WeakSet()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (maxDepth <= 0) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.every((child) => withinDepth(child, maxDepth - 1, seen));
}

function boundedString(value: unknown, maxLen: number = MAX_PROTOCOL_STRING_LENGTH): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen ? value : undefined;
}

type OptionalStringResult = { readonly ok: true; readonly value: string | undefined } | { readonly ok: false };

function boundedOptionalString(value: unknown, maxLen: number = MAX_PROTOCOL_STRING_LENGTH): OptionalStringResult {
  if (value === undefined) return { ok: true, value: undefined };
  const parsed = boundedString(value, maxLen);
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

const PINNED_REVISIONS: ReadonlySet<string> = new Set(['base', 'head']);

function parsePinnedRevision(value: unknown): PinnedRevision | undefined {
  return typeof value === 'string' && PINNED_REVISIONS.has(value) ? (value as PinnedRevision) : undefined;
}

const DETAIL_SECTIONS: ReadonlySet<string> = new Set(['metadata', 'commits', 'discussion', 'labels', 'checkSummaries', 'relationships']);

type OptionalDetailSectionResult = { readonly ok: true; readonly value: DetailSection | undefined } | { readonly ok: false };

function parseOptionalDetailSection(value: unknown): OptionalDetailSectionResult {
  if (value === undefined) return { ok: true, value: undefined };
  return typeof value === 'string' && DETAIL_SECTIONS.has(value) ? { ok: true, value: value as DetailSection } : { ok: false };
}

function parseOptionalCursor(value: unknown): OptionalStringResult {
  return boundedOptionalString(value as unknown, MAX_PROTOCOL_STRING_LENGTH) as OptionalStringResult;
}

function parseSnapshotRef(value: unknown): InvestigationSnapshotRef | undefined {
  if (!isRecord(value)) return undefined;
  const repoId = boundedString(value.repoId, MAX_ID_LENGTH);
  const baseSha = boundedString(value.baseSha);
  const headSha = boundedString(value.headSha);
  if (repoId === undefined || baseSha === undefined || headSha === undefined) return undefined;
  return { repoId, baseSha, headSha };
}

/** Truncates and strips control characters before a value is embedded in a bounded reason — never the full raw turn text, but a short, safe echo of one already-extracted field (matching the established pattern in `../app/harnessToolDispatcher.ts`'s own refusal reasons). */
function shortEcho(value: unknown, max = 80): string {
  const text = typeof value === 'string' ? value : (() => {
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return '[unrepresentable value]';
    }
  })();
  // Deliberately no regex control-char class (e.g. a /[\x00-\x1f]/ literal) here: writing that
  // escape sequence as source text has previously round-tripped through tooling as literal raw
  // control bytes instead of the six-character escape, which makes git treat the file as binary.
  // Filtering by code point avoids the escape sequence entirely.
  const cleaned = Array.from(text)
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code >= 0x20 && code !== 0x7f;
    })
    .join('');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

export interface ProtocolFailureReason {
  readonly code: string;
  readonly message: string;
}

function reason(code: string, message: string): ProtocolFailureReason {
  return { code, message };
}

// ---- Tool-call shape parsing (toolRequest) -------------------------------------------

type ToolCallParseResult = { readonly ok: true; readonly call: ParsedToolCall } | { readonly ok: false; readonly reasons: readonly ProtocolFailureReason[] };

function toolFail(...reasons: readonly ProtocolFailureReason[]): ToolCallParseResult {
  return { ok: false, reasons };
}

function parseListChangedFiles(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'listChangedFiles.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'listChangedFiles.request.snapshot is missing or malformed.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'listChangedFiles.request.cursor must be a bounded string.'));
  const request: ChangedFileManifestRequest = { snapshot, ...(cursor.value !== undefined ? { cursor: cursor.value } : {}) };
  return { ok: true, call: { tool: 'listChangedFiles', memberId, request } };
}

function parseReadDiff(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'readDiff.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'readDiff.request.snapshot is missing or malformed.'));
  const path = boundedString(raw.path);
  if (path === undefined) return toolFail(reason('schema', 'readDiff.request.path is required.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'readDiff.request.cursor must be a bounded string.'));
  const request: DiffPageRequest = { snapshot, path, ...(cursor.value !== undefined ? { cursor: cursor.value } : {}) };
  return { ok: true, call: { tool: 'readDiff', memberId, request } };
}

function parseReadFile(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'readFile.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'readFile.request.snapshot is missing or malformed.'));
  const revision = parsePinnedRevision(raw.revision);
  if (revision === undefined) return toolFail(reason('schema', 'readFile.request.revision must be "base" or "head".'));
  const path = boundedString(raw.path);
  if (path === undefined) return toolFail(reason('schema', 'readFile.request.path is required.'));
  const startLine = positiveInt(raw.startLine);
  const endLine = positiveInt(raw.endLine);
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return toolFail(reason('schema', 'readFile.request.startLine/endLine must be positive integers with endLine >= startLine.'));
  }
  const request: FileRangeRequest = { snapshot, revision, path, startLine, endLine };
  return { ok: true, call: { tool: 'readFile', memberId, request } };
}

function parseSearchRepository(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'searchRepository.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'searchRepository.request.snapshot is missing or malformed.'));
  const revision = parsePinnedRevision(raw.revision);
  if (revision === undefined) return toolFail(reason('schema', 'searchRepository.request.revision must be "base" or "head".'));
  const query = boundedString(raw.query);
  if (query === undefined) return toolFail(reason('schema', 'searchRepository.request.query is required.'));
  const pathScope = boundedOptionalString(raw.pathScope);
  if (!pathScope.ok) return toolFail(reason('schema', 'searchRepository.request.pathScope must be a bounded string.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'searchRepository.request.cursor must be a bounded string.'));
  const request: RepositorySearchRequest = {
    snapshot,
    revision,
    query,
    ...(pathScope.value !== undefined ? { pathScope: pathScope.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'searchRepository', memberId, request } };
}

function parseSearchDiff(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'searchDiff.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'searchDiff.request.snapshot is missing or malformed.'));
  const query = boundedString(raw.query);
  if (query === undefined) return toolFail(reason('schema', 'searchDiff.request.query is required.'));
  const pathScope = boundedOptionalString(raw.pathScope);
  if (!pathScope.ok) return toolFail(reason('schema', 'searchDiff.request.pathScope must be a bounded string.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'searchDiff.request.cursor must be a bounded string.'));
  const request: DiffSearchRequest = {
    snapshot,
    query,
    ...(pathScope.value !== undefined ? { pathScope: pathScope.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'searchDiff', memberId, request } };
}

function parseResolvePolicy(memberId: string, rawChangedPath: unknown): ToolCallParseResult {
  const changedPath = boundedString(rawChangedPath);
  if (changedPath === undefined) return toolFail(reason('schema', 'resolvePolicy.changedPath is required.'));
  return { ok: true, call: { tool: 'resolvePolicy', memberId, changedPath } };
}

function parseGetChangeRequestDetails(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'getChangeRequestDetails.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'getChangeRequestDetails.request.snapshot is missing or malformed.'));
  const number = boundedString(raw.number, MAX_ID_LENGTH);
  if (number === undefined) return toolFail(reason('schema', 'getChangeRequestDetails.request.number is required.'));
  const section = parseOptionalDetailSection(raw.section);
  if (!section.ok) return toolFail(reason('schema', 'getChangeRequestDetails.request.section is not a known section.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'getChangeRequestDetails.request.cursor must be a bounded string.'));
  const request: ChangeRequestDetailRequest = {
    snapshot,
    number,
    ...(section.value !== undefined ? { section: section.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'getChangeRequestDetails', memberId, request } };
}

function parseGetIssueDetails(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'getIssueDetails.request must be an object.'));
  const snapshot = parseSnapshotRef(raw.snapshot);
  if (!snapshot) return toolFail(reason('schema', 'getIssueDetails.request.snapshot is missing or malformed.'));
  const issueRepoId = boundedString(raw.issueRepoId, MAX_ID_LENGTH);
  const issueNumber = boundedString(raw.issueNumber, MAX_ID_LENGTH);
  if (issueRepoId === undefined || issueNumber === undefined) {
    return toolFail(reason('schema', 'getIssueDetails.request.issueRepoId and issueNumber are required.'));
  }
  const section = parseOptionalDetailSection(raw.section);
  if (!section.ok) return toolFail(reason('schema', 'getIssueDetails.request.section is not a known section.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'getIssueDetails.request.cursor must be a bounded string.'));
  const request: IssueDetailRequest = {
    snapshot,
    issueRepoId,
    issueNumber,
    ...(section.value !== undefined ? { section: section.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'getIssueDetails', memberId, request } };
}

function parseToolRequest(raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'toolRequest must be an object.'));
  const toolName = raw.tool;
  if (typeof toolName !== 'string') return toolFail(reason('schema', 'toolRequest.tool must be a string.'));
  if (toolName === 'submitCandidateFinding' || toolName === 'requestCompletion') {
    return toolFail(
      reason(
        'wrongKind',
        `${toolName} must be sent as a ${toolName === 'submitCandidateFinding' ? 'candidateSubmission' : 'completionRequest'} message, not toolRequest.`,
      ),
    );
  }
  if (!isHostToolName(toolName) || hostToolDefinition(toolName) === undefined) {
    return toolFail(reason('unknownTool', `"${shortEcho(toolName)}" is not a recognized host tool name.`));
  }
  const memberId = boundedString(raw.memberId, MAX_ID_LENGTH);
  if (memberId === undefined) return toolFail(reason('schema', 'toolRequest.memberId is required.'));
  switch (toolName as ReadHostToolName) {
    case 'listChangedFiles':
      return parseListChangedFiles(memberId, raw.request);
    case 'readDiff':
      return parseReadDiff(memberId, raw.request);
    case 'readFile':
      return parseReadFile(memberId, raw.request);
    case 'searchRepository':
      return parseSearchRepository(memberId, raw.request);
    case 'searchDiff':
      return parseSearchDiff(memberId, raw.request);
    case 'resolvePolicy':
      return parseResolvePolicy(memberId, raw.changedPath);
    case 'getChangeRequestDetails':
      return parseGetChangeRequestDetails(memberId, raw.request);
    case 'getIssueDetails':
      return parseGetIssueDetails(memberId, raw.request);
    default: {
      const exhaustive: never = toolName as never;
      return toolFail(reason('unknownTool', `"${shortEcho(exhaustive)}" is not a recognized host tool name.`));
    }
  }
}

// ---- Per-kind message parsing ---------------------------------------------------------

type MessageParseResult = { readonly ok: true; readonly message: ProtocolMessage } | { readonly ok: false; readonly reasons: readonly ProtocolFailureReason[] };

function msgFail(...reasons: readonly ProtocolFailureReason[]): MessageParseResult {
  return { ok: false, reasons };
}

/** Field-by-field, never `{...raw}` — an unrecognized extra field on `raw` is silently ignored, never copied through. */
function parsePlanItemInputs(rawItems: unknown): { readonly ok: true; readonly items: PlanItemInput[] } | { readonly ok: false } {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false };
  const items: PlanItemInput[] = [];
  for (const rawItem of rawItems) {
    if (!isRecord(rawItem)) return { ok: false };
    const id = boundedString(rawItem.id, MAX_ID_LENGTH);
    const description = typeof rawItem.description === 'string' ? rawItem.description : undefined;
    if (id === undefined || description === undefined) return { ok: false };
    let state: PlanItemState | undefined;
    if (rawItem.state !== undefined) {
      if (!isPlanItemState(rawItem.state)) return { ok: false };
      state = rawItem.state;
    }
    // Absent memberId means shared cross-member work (task 13.3); present-but-malformed fails closed.
    const memberId = boundedOptionalString(rawItem.memberId, MAX_ID_LENGTH);
    if (!memberId.ok) return { ok: false };
    items.push({
      id,
      description,
      ...(state !== undefined ? { state } : {}),
      ...(memberId.value !== undefined ? { memberId: memberId.value } : {}),
    });
  }
  return { ok: true, items };
}

function parsePlanCreated(raw: unknown, previousPlan: Plan | undefined): MessageParseResult {
  if (previousPlan !== undefined) {
    return msgFail(reason('planAlreadyExists', 'A plan already exists for this lineage; send planRevised, not planCreated.'));
  }
  if (!isRecord(raw)) return msgFail(reason('schema', 'planCreated must be an object.'));
  const parsedItems = parsePlanItemInputs(raw.items);
  if (!parsedItems.ok) return msgFail(reason('schema', 'planCreated.items must be a non-empty array of {id, description, state?}.'));
  const plan = createPlan(parsedItems.items);
  if (!plan) return msgFail(reason('schema', 'planCreated.items did not produce a valid plan (duplicate/empty id, or unsanitizable description).'));
  return { ok: true, message: { kind: 'planCreated', plan } };
}

function parsePlanRevised(raw: unknown, previousPlan: Plan | undefined): MessageParseResult {
  if (previousPlan === undefined) {
    return msgFail(reason('noPriorPlan', 'No plan exists yet for this lineage; send planCreated first.'));
  }
  if (!isRecord(raw)) return msgFail(reason('schema', 'planRevised must be an object.'));
  const parsedItems = parsePlanItemInputs(raw.items);
  if (!parsedItems.ok) return msgFail(reason('schema', 'planRevised.items must be a non-empty array of {id, description, state?}.'));
  const rationale = typeof raw.rationale === 'string' ? raw.rationale : undefined;
  if (rationale === undefined) return msgFail(reason('schema', 'planRevised.rationale is required.'));
  const plan = revisePlan(previousPlan, parsedItems.items, rationale);
  if (!plan) return msgFail(reason('schema', 'planRevised did not produce a valid revision (a prior item id vanished, or rationale/description was unsanitizable).'));
  return { ok: true, message: { kind: 'planRevised', plan } };
}

function parsePlanItemStateChanged(raw: unknown, effectivePlan: Plan | undefined): MessageParseResult {
  if (!isRecord(raw)) return msgFail(reason('schema', 'planItemStateChanged must be an object.'));
  const itemId = boundedString(raw.itemId, MAX_ID_LENGTH);
  if (itemId === undefined) return msgFail(reason('schema', 'planItemStateChanged.itemId is required.'));
  if (!isPlanItemState(raw.state)) return msgFail(reason('schema', 'planItemStateChanged.state is not a known plan-item state.'));
  if (effectivePlan === undefined) {
    return msgFail(reason('noPlan', 'No plan exists yet to transition an item in.'));
  }
  if (!effectivePlan.items.some((item) => item.id === itemId)) {
    return msgFail(reason('unknownItemId', `"${shortEcho(itemId)}" does not name a known plan item.`));
  }
  return { ok: true, message: { kind: 'planItemStateChanged', itemId, state: raw.state } };
}

function parsePublicRationale(raw: unknown): MessageParseResult {
  if (!isRecord(raw)) return msgFail(reason('schema', 'publicRationale must be an object.'));
  const rationale = sanitizePublicText(raw.rationale);
  if (rationale === undefined) return msgFail(reason('schema', 'publicRationale.rationale is required.'));
  const itemId = boundedOptionalString(raw.itemId, MAX_ID_LENGTH);
  if (!itemId.ok) return msgFail(reason('schema', 'publicRationale.itemId must be a bounded string.'));
  return { ok: true, message: itemId.value !== undefined ? { kind: 'publicRationale', rationale, itemId: itemId.value } : { kind: 'publicRationale', rationale } };
}

function parseToolRequestMessage(raw: unknown): MessageParseResult {
  const parsed = parseToolRequest(raw);
  if (!parsed.ok) return msgFail(...parsed.reasons);
  return { ok: true, message: { kind: 'toolRequest', call: parsed.call } };
}

function parseCandidateSubmission(raw: unknown): MessageParseResult {
  if (!isRecord(raw)) return msgFail(reason('schema', 'candidateSubmission must be an object.'));
  const parsed = parseCandidateFinding(raw.candidate);
  if ('reasons' in parsed) {
    return msgFail(...parsed.reasons.map((r: ValidationReason) => reason(`candidate.${r.code}`, r.message)));
  }
  return { ok: true, message: { kind: 'candidateSubmission', candidate: parsed.candidate } };
}

/**
 * Rejects outright rather than truncating: `checkpointSuggestion.reason` and
 * `completionRequest.rationale` are fields this module owns directly (see
 * this file's header, D5 rule 1), unlike a plan item's description or a plan
 * revision's rationale, which reuse `createPlan`/`revisePlan`'s own
 * truncate-and-continue call to `sanitizePublicText`. Bounding the *raw*
 * value at `MAX_PUBLIC_TEXT_LENGTH` before sanitizing is what makes that
 * true: without this pre-check, `sanitizePublicText` would silently
 * truncate an oversized value the same as a reused-module field would,
 * rather than failing the message closed.
 */
function parseOwnedShortText(value: unknown): { readonly ok: true; readonly value: string | undefined } | { readonly ok: false } {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > MAX_PUBLIC_TEXT_LENGTH) return { ok: false };
  const sanitized = sanitizePublicText(value);
  return sanitized === undefined ? { ok: false } : { ok: true, value: sanitized };
}

function parseCheckpointSuggestion(raw: unknown): MessageParseResult {
  if (raw !== undefined && !isRecord(raw)) return msgFail(reason('schema', 'checkpointSuggestion must be an object.'));
  const record = isRecord(raw) ? raw : {};
  const reasonText = parseOwnedShortText(record.reason);
  if (!reasonText.ok) return msgFail(reason('schema', `checkpointSuggestion.reason must be usable text of at most ${MAX_PUBLIC_TEXT_LENGTH} characters.`));
  return { ok: true, message: reasonText.value !== undefined ? { kind: 'checkpointSuggestion', reason: reasonText.value } : { kind: 'checkpointSuggestion' } };
}

function parseCompletionRequest(raw: unknown): MessageParseResult {
  if (raw !== undefined && !isRecord(raw)) return msgFail(reason('schema', 'completionRequest must be an object.'));
  const record = isRecord(raw) ? raw : {};
  const memberId = boundedOptionalString(record.memberId, MAX_ID_LENGTH);
  if (!memberId.ok) return msgFail(reason('schema', 'completionRequest.memberId must be a bounded string.'));
  const rationale = parseOwnedShortText(record.rationale);
  if (!rationale.ok) return msgFail(reason('schema', `completionRequest.rationale must be usable text of at most ${MAX_PUBLIC_TEXT_LENGTH} characters.`));
  const message: CompletionRequestMessage = {
    kind: 'completionRequest',
    ...(memberId.value !== undefined ? { memberId: memberId.value } : {}),
    ...(rationale.value !== undefined ? { rationale: rationale.value } : {}),
  };
  return { ok: true, message };
}

// ---- Phase legality (task 10.2) -------------------------------------------------------

/** Only these three phases give the model a turn at all; `bootstrap`/`completing`/`persisting` are host-only phases (bootstrap paging and the completion-gate evaluation are host-initiated dispatch, not a model turn — see this file's header). */
const MODEL_TURN_PHASES: ReadonlySet<RunPhase> = new Set(['planning', 'investigating', 'verifying']);

type NonToolKind = Exclude<ProtocolMessageKind, 'toolRequest' | 'candidateSubmission' | 'completionRequest'>;

/** The five kinds with no existing host-tool-catalog entry to reuse a phase list from. */
const NON_TOOL_ALLOWED_PHASES: Readonly<Record<NonToolKind, ReadonlySet<RunPhase>>> = {
  planCreated: new Set(['planning']),
  planRevised: new Set(['planning', 'investigating', 'verifying']),
  planItemStateChanged: new Set(['planning', 'investigating', 'verifying']),
  publicRationale: new Set(['planning', 'investigating', 'verifying']),
  checkpointSuggestion: new Set(['planning', 'investigating', 'verifying']),
};

/**
 * Whether `kind` is legal in `phase`. For the two dedicated host-action
 * kinds this reuses `hostToolDefinition(...).allowedPhases` from the
 * existing catalog (`./harnessTools.ts`) rather than redeclaring a second
 * phase list; for `toolRequest` the same reuse happens per the actual tool
 * name once it is known (see `phaseAllowsToolRequest` below), since
 * different read tools are legal in different phases.
 */
function phaseAllowsNonToolKind(phase: RunPhase, kind: NonToolKind): boolean {
  return MODEL_TURN_PHASES.has(phase) && NON_TOOL_ALLOWED_PHASES[kind].has(phase);
}

function phaseAllowsToolRequest(phase: RunPhase, toolName: ReadHostToolName): boolean {
  if (!MODEL_TURN_PHASES.has(phase)) return false;
  return hostToolDefinition(toolName)?.allowedPhases.includes(phase) ?? false;
}

function phaseAllowsCandidateSubmission(phase: RunPhase): boolean {
  return MODEL_TURN_PHASES.has(phase) && (hostToolDefinition('submitCandidateFinding')?.allowedPhases.includes(phase) ?? false);
}

function phaseAllowsCompletionRequest(phase: RunPhase): boolean {
  return MODEL_TURN_PHASES.has(phase) && (hostToolDefinition('requestCompletion')?.allowedPhases.includes(phase) ?? false);
}

/** Full six-phase, eight-kind table, derived from the checks above — exported for introspection and tests. `bootstrap`/`completing`/`persisting` rows are empty: no model turn happens in those phases. */
export const PHASE_ALLOWED_KINDS: Readonly<Record<RunPhase, readonly ProtocolMessageKind[]>> = (() => {
  const phases: readonly RunPhase[] = ['bootstrap', 'planning', 'investigating', 'verifying', 'completing', 'persisting'];
  const table = {} as Record<RunPhase, readonly ProtocolMessageKind[]>;
  for (const phase of phases) {
    const kinds: ProtocolMessageKind[] = [];
    for (const kind of Object.keys(NON_TOOL_ALLOWED_PHASES) as NonToolKind[]) {
      if (phaseAllowsNonToolKind(phase, kind)) kinds.push(kind);
    }
    if (MODEL_TURN_PHASES.has(phase)) {
      const anyToolAllowed = ['listChangedFiles', 'readDiff', 'readFile', 'searchRepository', 'searchDiff', 'resolvePolicy', 'getChangeRequestDetails', 'getIssueDetails'] as const;
      if (anyToolAllowed.some((tool) => phaseAllowsToolRequest(phase, tool))) kinds.push('toolRequest');
    }
    if (phaseAllowsCandidateSubmission(phase)) kinds.push('candidateSubmission');
    if (phaseAllowsCompletionRequest(phase)) kinds.push('completionRequest');
    table[phase] = Object.freeze(kinds);
  }
  return Object.freeze(table);
})();

// ---- Batch compatibility (D5 rule 2) ---------------------------------------------------

function validateBatchCompatibility(kinds: readonly ProtocolMessageKind[], policy: HarnessPolicy): ProtocolFailureReason | undefined {
  const count = (kind: ProtocolMessageKind) => kinds.filter((k) => k === kind).length;
  const planShapingCount = count('planCreated') + count('planRevised');
  const rationaleCount = count('publicRationale');
  const checkpointCount = count('checkpointSuggestion');
  const completionCount = count('completionRequest');
  const toolRequestCount = count('toolRequest');
  const candidateCount = count('candidateSubmission');

  if (planShapingCount > 1) return reason('multiplePlanShaping', 'At most one planCreated or planRevised message is allowed per turn.');
  if (rationaleCount > 1) return reason('multipleRationale', 'At most one publicRationale message is allowed per turn.');
  if (checkpointCount > 1) return reason('multipleCheckpoint', 'At most one checkpointSuggestion message is allowed per turn.');
  if (completionCount > 1) return reason('multipleCompletion', 'At most one completionRequest message is allowed per turn.');
  if (toolRequestCount > policy.maxToolRequestsPerTurn) {
    return reason('tooManyToolRequests', `${toolRequestCount} toolRequest messages exceeds the limit of ${policy.maxToolRequestsPerTurn} per turn.`);
  }
  if (completionCount > 0 && (toolRequestCount > 0 || candidateCount > 0 || checkpointCount > 0 || planShapingCount > 0)) {
    return reason(
      'completionRequestNotFocused',
      'A completionRequest may not be batched with tool requests, candidate submissions, a checkpoint suggestion, or a plan change in the same turn.',
    );
  }
  if (checkpointCount > 0 && (toolRequestCount > 0 || planShapingCount > 0)) {
    return reason('checkpointNotFocused', 'A checkpointSuggestion may not be batched with tool requests or a plan change in the same turn.');
  }
  return undefined;
}

// ---- JSON extraction ------------------------------------------------------------------

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

const CODE_FENCE_PATTERN = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/;

function stripCodeFence(text: string): string {
  const match = CODE_FENCE_PATTERN.exec(text);
  return match ? (match[1] ?? '') : text;
}

/** Extracts one JSON value from a model's raw turn text: tries the whole trimmed text, then a markdown code fence, then falls back to the outermost `{...}` or `[...]` substring — whichever the text opens with — matching the legacy `runPrompt` extraction's tolerance for surrounding prose. */
function extractJsonValue(rawText: string): unknown {
  const trimmed = rawText.trim();
  const direct = tryParseJson(trimmed);
  if (direct !== undefined) return direct;
  const fenced = tryParseJson(stripCodeFence(trimmed).trim());
  if (fenced !== undefined) return fenced;
  const braceStart = trimmed.indexOf('{');
  const bracketStart = trimmed.indexOf('[');
  const starts = [braceStart, bracketStart].filter((index) => index >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const isArray = trimmed[start] === '[';
  const end = isArray ? trimmed.lastIndexOf(']') : trimmed.lastIndexOf('}');
  if (end <= start) return undefined;
  return tryParseJson(trimmed.slice(start, end + 1));
}

// ---- Turn-level parsing ------------------------------------------------------------------

export interface TurnParseMeta {
  readonly rawByteLength: number;
  /** How many raw message entries were found in the batch, whether or not the turn ultimately parsed successfully. */
  readonly messageCount: number;
}

export type TurnParseFailureKind = 'parse' | 'contract';

export type TurnParseOutcome =
  | { readonly ok: true; readonly messages: readonly ProtocolMessage[]; readonly meta: TurnParseMeta }
  | { readonly ok: false; readonly failureKind: TurnParseFailureKind; readonly reasons: readonly ProtocolFailureReason[]; readonly meta: TurnParseMeta };

export interface ProtocolParseContext {
  readonly phase: RunPhase;
  /** The plan as of the start of this turn (before any `planCreated`/`planRevised` message in this same batch is applied). `undefined` means no plan exists yet in this lineage. */
  readonly previousPlan?: Plan;
  readonly policy?: HarnessPolicy;
}

function rawMessageEntries(value: unknown): readonly unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
  return undefined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function failure(failureKind: TurnParseFailureKind, reasons: readonly ProtocolFailureReason[], meta: TurnParseMeta): TurnParseOutcome {
  return { ok: false, failureKind, reasons, meta };
}

/** Parses one message's kind-specific shape, without any phase check — phase legality is applied separately so a shape failure and a phase failure never share a `failureKind` (D5 rule 4). */
function parseMessageShape(raw: unknown, effectivePlanForItemChange: Plan | undefined, previousPlanForPlanShaping: Plan | undefined): { readonly kind: ProtocolMessageKind } & MessageParseResult | { readonly ok: false; readonly reasons: readonly ProtocolFailureReason[] } {
  if (!isRecord(raw)) return { ok: false, reasons: [reason('schema', 'Each message must be an object.')] };
  const kind = raw.kind;
  if (kind === undefined) return { ok: false, reasons: [reason('missingKind', 'Message is missing its "kind" discriminant.')] };
  if (!isProtocolMessageKind(kind)) return { ok: false, reasons: [reason('unknownKind', `"${shortEcho(kind)}" is not a recognized message kind.`)] };
  let result: MessageParseResult;
  switch (kind) {
    case 'planCreated':
      result = parsePlanCreated(raw, previousPlanForPlanShaping);
      break;
    case 'planRevised':
      result = parsePlanRevised(raw, previousPlanForPlanShaping);
      break;
    case 'planItemStateChanged':
      result = parsePlanItemStateChanged(raw, effectivePlanForItemChange);
      break;
    case 'publicRationale':
      result = parsePublicRationale(raw);
      break;
    case 'toolRequest':
      result = parseToolRequestMessage(raw);
      break;
    case 'candidateSubmission':
      result = parseCandidateSubmission(raw);
      break;
    case 'checkpointSuggestion':
      result = parseCheckpointSuggestion(raw);
      break;
    case 'completionRequest':
      result = parseCompletionRequest(raw);
      break;
  }
  return { kind, ...result };
}

function isPlanShapingRawKind(raw: unknown): boolean {
  return isRecord(raw) && (raw.kind === 'planCreated' || raw.kind === 'planRevised');
}

function messagePhase(kind: ProtocolMessageKind, message: ProtocolMessage, phase: RunPhase): boolean {
  if (kind === 'toolRequest' && message.kind === 'toolRequest') return phaseAllowsToolRequest(phase, message.call.tool);
  if (kind === 'candidateSubmission') return phaseAllowsCandidateSubmission(phase);
  if (kind === 'completionRequest') return phaseAllowsCompletionRequest(phase);
  return phaseAllowsNonToolKind(phase, kind as NonToolKind);
}

/**
 * Parses one bounded model turn: raw text in, typed messages (or a typed
 * failure) plus per-call metadata out. Pure — no I/O, no cancellation, no
 * knowledge of repair attempts (`../app/harnessTurn.ts` owns the repair
 * loop on top of this).
 */
export function parseModelTurn(rawText: string, context: ProtocolParseContext): TurnParseOutcome {
  const policy = context.policy ?? DEFAULT_HARNESS_POLICY;
  const rawByteLength = byteLength(rawText);
  const emptyMeta: TurnParseMeta = { rawByteLength, messageCount: 0 };

  if (!isRunPhase(context.phase)) return failure('parse', [reason('invalidPhase', 'The current phase is not a recognized run phase.')], emptyMeta);
  if (rawByteLength > MAX_TURN_RAW_BYTES) {
    return failure('parse', [reason('turnTooLarge', `The turn exceeds ${MAX_TURN_RAW_BYTES} bytes.`)], emptyMeta);
  }

  const jsonValue = extractJsonValue(rawText);
  if (jsonValue === undefined) {
    return failure('parse', [reason('noJson', 'The turn did not contain a valid JSON object or array.')], emptyMeta);
  }

  const rawEntries = rawMessageEntries(jsonValue);
  if (rawEntries === undefined) {
    return failure('parse', [reason('invalidEnvelope', 'The turn must be a JSON array of messages or an object with a "messages" array.')], emptyMeta);
  }

  const meta: TurnParseMeta = { rawByteLength, messageCount: rawEntries.length };
  if (rawEntries.length === 0) return failure('parse', [reason('emptyBatch', 'A turn must contain at least one message.')], meta);
  if (rawEntries.length > MAX_PROTOCOL_MESSAGES_PER_TURN) {
    return failure('parse', [reason('batchTooLarge', `${rawEntries.length} messages exceeds the batch limit of ${MAX_PROTOCOL_MESSAGES_PER_TURN} per turn.`)], meta);
  }

  for (const rawEntry of rawEntries) {
    if (!withinDepth(rawEntry, MAX_MESSAGE_DEPTH)) {
      return failure('parse', [reason('excessDepth', `A message is nested deeper than the ${MAX_MESSAGE_DEPTH}-level limit.`)], meta);
    }
  }

  // Two-pass: resolve the effective plan for this turn (a planCreated/planRevised message in
  // this same batch, if present and well-formed) before validating any planItemStateChanged
  // message's itemId against it — a newly-added item id is legal to transition in the same turn.
  const planShapingRaw = rawEntries.find(isPlanShapingRawKind);
  let planShapingResult: ReturnType<typeof parseMessageShape> | undefined;
  let effectivePlan = context.previousPlan;
  if (planShapingRaw !== undefined) {
    planShapingResult = parseMessageShape(planShapingRaw, context.previousPlan, context.previousPlan);
    if (planShapingResult.ok && (planShapingResult.message.kind === 'planCreated' || planShapingResult.message.kind === 'planRevised')) {
      effectivePlan = planShapingResult.message.plan;
    }
  }

  const parseReasons: ProtocolFailureReason[] = [];
  const contractReasons: ProtocolFailureReason[] = [];
  const messages: ProtocolMessage[] = [];
  const parsedKinds: ProtocolMessageKind[] = [];

  for (const rawEntry of rawEntries) {
    const parsed = rawEntry === planShapingRaw && planShapingResult !== undefined ? planShapingResult : parseMessageShape(rawEntry, effectivePlan, context.previousPlan);
    if (!parsed.ok) {
      parseReasons.push(...parsed.reasons);
      continue;
    }
    if (!messagePhase(parsed.kind, parsed.message, context.phase)) {
      contractReasons.push(reason('phaseNotAllowed', `${parsed.kind} is not permitted during the ${context.phase} phase.`));
      continue;
    }
    parsedKinds.push(parsed.kind);
    messages.push(parsed.message);
  }

  if (parseReasons.length > 0) return failure('parse', parseReasons, meta);
  if (contractReasons.length > 0) return failure('contract', contractReasons, meta);

  const compatibilityFailure = validateBatchCompatibility(parsedKinds, policy);
  if (compatibilityFailure) return failure('parse', [compatibilityFailure], meta);

  return { ok: true, messages, meta };
}

// ---- Repair instruction composition (used by ../app/harnessTurn.ts) --------------------

/** Sized generously versus `MAX_PUBLIC_TEXT_LENGTH` (240, `../app/harnessActivitySanitizer.ts`): this text is sent back to the model as part of the next prompt, not stored as public activity, so it is bounded on its own terms rather than reusing that activity-display cap. */
export const MAX_REPAIR_INSTRUCTION_LENGTH = 600;

/**
 * Builds a bounded, sanitized repair instruction naming what was wrong —
 * never the model's raw turn text (D5 rule 5). Each reason is sanitized
 * individually (redacting anything secret-shaped, stripping control
 * characters) before composition, and the composite is capped on its own
 * bound rather than truncated a second time through the 240-char public-text
 * cap, which would cut off the actionable instruction tail.
 */
export function buildRepairInstruction(failureKind: TurnParseFailureKind, reasons: readonly ProtocolFailureReason[]): string {
  const opener = failureKind === 'contract' ? 'Your last turn included a message not permitted in the current phase.' : 'Your last turn could not be parsed as a valid protocol turn.';
  const cleanedReasons = reasons
    .slice(0, MAX_REPAIR_REASONS)
    .map((r) => sanitizePublicText(`${r.code}: ${r.message}`))
    .filter((text): text is string => text !== undefined);
  const body = cleanedReasons.length > 0 ? ` Problems: ${cleanedReasons.join(' | ')}.` : '';
  const closer = ' Resend a corrected turn as JSON: either an array of messages or an object with a "messages" array. Do not repeat the previous invalid content.';
  const composite = `${opener}${body}${closer}`;
  return composite.length > MAX_REPAIR_INSTRUCTION_LENGTH ? `${composite.slice(0, MAX_REPAIR_INSTRUCTION_LENGTH - 1)}…` : composite;
}
