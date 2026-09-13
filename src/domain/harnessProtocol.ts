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
  IssueDetailRequest,
  PinnedRevision,
  RepositorySearchRequest,
  Unpinned,
} from '../platform/types';
import { isPlanItemState, PLAN_ITEM_STATES, isRunPhase, type Plan, type PlanItemState, type RunPhase } from './harnessActivity';
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

/**
 * Every request is `Unpinned` (`../platform/types`): the model names the member and what it wants
 * read, and the host adds that member's repository and base/head pair back on before the provider
 * call. See `Unpinned`'s own comment for the live failure that removed the transcription.
 */
export type ParsedToolCall =
  | { readonly tool: 'listChangedFiles'; readonly memberId: string; readonly request: Unpinned<ChangedFileManifestRequest> }
  | { readonly tool: 'readDiff'; readonly memberId: string; readonly request: Unpinned<DiffPageRequest> }
  | { readonly tool: 'readFile'; readonly memberId: string; readonly request: Unpinned<FileRangeRequest> }
  | { readonly tool: 'searchRepository'; readonly memberId: string; readonly request: Unpinned<RepositorySearchRequest> }
  | { readonly tool: 'searchDiff'; readonly memberId: string; readonly request: Unpinned<DiffSearchRequest> }
  | { readonly tool: 'resolvePolicy'; readonly memberId: string; readonly changedPath: string }
  | { readonly tool: 'getChangeRequestDetails'; readonly memberId: string; readonly request: Unpinned<ChangeRequestDetailRequest> }
  | { readonly tool: 'getIssueDetails'; readonly memberId: string; readonly request: Unpinned<IssueDetailRequest> };

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

/** Nesting bound applied to each raw message value before any field is extracted from it. Legitimate shapes nest at most ~4 deep (candidate -> citations -> primary -> range); 6 leaves headroom without allowing a depth bomb. */
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

/**
 * An identifier is a value the host looks up, compares, or quotes back to the model: a member id, a
 * plan item id, a linked-issue repository id, a change-request or issue number. It is not free
 * text, and it has to survive `sanitizePublicText` unchanged, because every host message that
 * carries it back to the model is rendered through that function.
 *
 * **The live failure this closes.** A run lost 24 tool calls to a snapshot-pin refusal whose
 * corrective half was byte-identical to the half quoting the request, so the message named no
 * difference the model could act on. `../app/harnessToolDispatcher.ts` fixed that by naming the
 * mismatched field and printing both values. An adversarial check then rebuilt the same
 * identical-looking message through this door instead, sending `repoId` as the correct repository
 * id with a BEL appended and both SHAs correct. The comparison saw a difference and refused — and
 * the refusal rendered as "Use repoId osirison/code-verdict, ... This request sent repoId
 * osirison/code-verdict.", because the sanitizer deletes control characters on the way out. A
 * trailing space does the same by way of its trim. `boundedString` above let the value through
 * because it checks type and length and nothing else.
 *
 * That particular door is now bricked up from the other side: a request no longer carries a
 * repository or commit id at all (`Unpinned`, `../platform/types`), so there is no pin comparison
 * left to defeat. The guard stays, and is still load-bearing, for every identifier that remains —
 * `memberId` above all, which the dispatcher quotes back verbatim in `Member <id> is not part of
 * this run.`
 *
 * **Rejected, not trimmed.** Trimming a stray trailing space looks kind and is not: a trimmed
 * `memberId` would then *match* a member the model never actually named, so the host would answer
 * a request whose bytes the model never sent, with nothing anywhere saying so — the same quiet
 * mismatch this guard exists to remove, moved inside the host. Nothing at this boundary knows what
 * the value was meant to be either; the member list lives in the dispatcher. Refusing states an
 * observation the model can act on, and it costs one message rather than a phase.
 *
 * **No stricter test for an id.** Identifiers here are provider-minted and take whatever shape the
 * forge uses — `../providers/fixture/harnessFixtures.ts` and `../app/migrationFixtures.ts` both
 * carry short, non-hex fixture ids, and that is the provider the harness's tests and its demo run
 * on. Length stays the only size rule.
 *
 * **What is deliberately not guarded.** `path`, `changedPath` and `pathScope`: what makes a path
 * usable is `normalizeEvidencePath`'s job at dispatch, and a second, differently-worded opinion
 * here would split one rule across two modules. `query`: model-authored text matched against
 * source, never quoted back as a correction. `cursor`: host-issued and provenance-checked, so a
 * mutated one already fails `forgedCursor` with its own message. And free text — plan item
 * descriptions, rationales, checkpoint reasons, candidate titles and bodies — keeps every
 * character a person would write, em dash and newline included; sanitizing it for display is what
 * the sanitizer is for.
 *
 * One remainder, knowingly left: a run of ordinary interior spaces still collapses to one on
 * display. Rejecting interior whitespace would reject `"id": "inspect auth flow"`, a plan item id
 * a model legitimately writes, and no identifier the host itself mints contains one.
 */
function isEchoableIdentifier(value: string): boolean {
  if (value.trim() !== value) return false;
  // Deliberately no regex control-char class here, for the reason `shortEcho` below records: that
  // escape sequence has round-tripped through tooling as raw control bytes, which makes git treat
  // the file as binary. Filtering by code point avoids having to write one.
  return Array.from(value).every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code >= 0x20 && code !== 0x7f;
  });
}

/** The one wording for this rejection. The legacy parsers and the spec table both call it, because `harnessProtocolSpecParity.test.ts` compares their failure text byte for byte. */
function unprintableIdentifier(path: string): string {
  return `${path} contains a control character or leading/trailing whitespace.`;
}

type IdentifierResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly unprintable: boolean };

/** `unprintable` separates "present, but carries something the host could not echo" from every older cause — absent, wrong type, over-length — so each of those keeps the message it already had. */
function identifierText(value: unknown, maxLen: number = MAX_PROTOCOL_STRING_LENGTH): IdentifierResult {
  const parsed = boundedString(value, maxLen);
  if (parsed === undefined) return { ok: false, unprintable: false };
  return isEchoableIdentifier(parsed) ? { ok: true, value: parsed } : { ok: false, unprintable: true };
}

/**
 * A change-request or issue number, which this protocol carries as a string but which every model
 * reasonably writes as a JSON number — the identifier is spelled `#388` everywhere in the prompt,
 * and nothing in the reply format says otherwise.
 *
 * A live review lost three of its eight turns, about 64 seconds of 175, to
 * `getChangeRequestDetails.request.number is required` after replying `"number": 388`, then
 * `"number": 388` again, then a third time with the section dropped — each rejection costing a
 * whole round trip before the repair budget ran out. That is the same defect the pagination cursor
 * had: strictness about a type the host itself never made unambiguous.
 *
 * Coercing is safe *here* and nowhere else. A number is an identifier whose whole content is its
 * digits, so `388` and `"388"` cannot mean two different things. A cursor is the opposite — opaque,
 * provenance-checked — and keeps its strict string parse.
 */
function boundedIdentifier(value: unknown, maxLen: number): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return boundedString(value, maxLen);
}

/** `boundedIdentifier` with the identifier guard applied; a coerced number can never fail it, which is what makes the coercion above safe to keep. */
function identifierTextOrNumber(value: unknown, maxLen: number): IdentifierResult {
  const parsed = boundedIdentifier(value, maxLen);
  if (parsed === undefined) return { ok: false, unprintable: false };
  return isEchoableIdentifier(parsed) ? { ok: true, value: parsed } : { ok: false, unprintable: true };
}

type OptionalStringResult = { readonly ok: true; readonly value: string | undefined } | { readonly ok: false };

/**
 * "This optional field was not supplied", in every spelling a model actually uses.
 *
 * JSON has no `undefined`, so a model that decides not to send an optional value writes `null` —
 * and a model asked to omit a string often writes `""` instead. Both used to be hard failures on
 * every optional field in this protocol: `cursor`, `section`, `pathScope`, `memberId`, `itemId`,
 * `suggestion` and their neighbours. Each rejection discarded the whole turn, and several reported
 * the field as *required* when it had plainly been supplied, so the model could not tell what to
 * change and burned the phase's repair budget guessing.
 *
 * Required fields are unaffected: `null` and `""` still fail there, which is the honest answer,
 * and their messages now say "is required" only when the field really is absent.
 */
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function boundedOptionalString(value: unknown, maxLen: number = MAX_PROTOCOL_STRING_LENGTH): OptionalStringResult {
  if (isAbsent(value)) return { ok: true, value: undefined };
  const parsed = boundedString(value, maxLen);
  return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
}

type OptionalIdentifierResult = { readonly ok: true; readonly value: string | undefined } | { readonly ok: false; readonly unprintable: boolean };

function optionalIdentifierText(value: unknown, maxLen: number = MAX_PROTOCOL_STRING_LENGTH): OptionalIdentifierResult {
  if (isAbsent(value)) return { ok: true, value: undefined };
  const parsed = identifierText(value, maxLen);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false, unprintable: parsed.unprintable };
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

const PINNED_REVISIONS: ReadonlySet<string> = new Set(['base', 'head']);
/** `old`/`new` is what this codebase's own `DiffPosition.side` calls the same two revisions
 * (`src/platform/types.ts`), so a model that has just read a diff position and reuses its
 * vocabulary was being rejected for agreeing with us. Case is folded for the same reason a model
 * writes `HEAD`: it is the same value, spelled the way git spells it. */
const REVISION_ALIASES: ReadonlyMap<string, PinnedRevision> = new Map([['old', 'base'], ['new', 'head']]);

function parsePinnedRevision(value: unknown): PinnedRevision | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (PINNED_REVISIONS.has(normalized)) return normalized as PinnedRevision;
  return REVISION_ALIASES.get(normalized);
}

const DETAIL_SECTIONS: ReadonlySet<string> = new Set(['metadata', 'commits', 'discussion', 'labels', 'checkSummaries', 'relationships']);

type OptionalDetailSectionResult = { readonly ok: true; readonly value: DetailSection | undefined } | { readonly ok: false };

function parseOptionalDetailSection(value: unknown): OptionalDetailSectionResult {
  if (isAbsent(value)) return { ok: true, value: undefined };
  return typeof value === 'string' && DETAIL_SECTIONS.has(value) ? { ok: true, value: value as DetailSection } : { ok: false };
}

/** Legal values, in the message, in the order the prompt lists them. A failure that names only the
 * field leaves a model to guess, and the guess costs a whole round trip; the prompt itself taught
 * two wrong section names for months, and nothing in the rejection could correct it. */
export const DETAIL_SECTION_MEMBERS: readonly string[] = Object.freeze([...DETAIL_SECTIONS]);

function listMembers(members: readonly string[]): string {
  return members.map((member) => `"${member}"`).join(', ');
}

function parseOptionalCursor(value: unknown): OptionalStringResult {
  return boundedOptionalString(value as unknown, MAX_PROTOCOL_STRING_LENGTH) as OptionalStringResult;
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

// ---- The one definition of a tool request ------------------------------------------
//
// Each tool's request shape is declared ONCE, here, in the module that parses it. The parser
// below is driven by these specs; `harnessTurnSchema.ts` derives the schema's tool section from
// them; and `harnessModelSeam.ts` renders the prompt's shape lines from them.
//
// Before this there were three hand-written descriptions of the same eight shapes — one per
// consumer — and they drifted. The prompt told the model a detail section could be `"title"`,
// which the parser had never accepted; the repair note advertised a plan-item shape the prompt did
// not show. A model following our own instructions exactly was rejected, and the rejection named
// no legal value, so it could not learn the real one. Keeping the three in step by hand is what
// failed; deriving them from one definition is what replaces it.
//
// Every failure message a spec produces is byte-identical to the hand-written parser it replaced —
// `harnessProtocolSpecParity.test.ts` asserts that across a generated corpus, because those strings
// are what a model reads to correct itself.

/**
 * How one field is read, and how it is described to a model.
 *
 * `requiredShortString` and `requiredIdentifier` are the identifier-carrying kinds: their values
 * go through `identifierText`/`identifierTextOrNumber` and are rejected when they carry something
 * the host could not echo back (see `isEchoableIdentifier`). `requiredString`, `optionalString`
 * and `cursor` are not — they carry paths, search queries and host-issued cursors, which are
 * checked elsewhere or not identifiers at all.
 *
 * There is deliberately no kind for a repository or commit id. A request names the member it is
 * for and nothing else about which revision to read; the host supplies the member's own pin (see
 * `Unpinned` in `../platform/types`).
 */
export type ToolFieldKind =
  | 'requiredString'
  | 'requiredShortString'
  | 'requiredIdentifier'
  | 'optionalString'
  | 'cursor'
  | 'pinnedRevision'
  | 'detailSection'
  | 'positiveInt';

export interface ToolFieldSpec {
  readonly name: string;
  readonly kind: ToolFieldKind;
  /** Overrides the kind's default message. Used where the original parser worded one differently. */
  readonly failure?: string;
  /** Reported together with `name` in a single message, as `getIssueDetails` has always done. */
  readonly groupedWith?: string;
}

export interface ToolRequestSpec {
  /** `request` puts the fields in a nested `request` object; `message` puts them on the message itself. */
  readonly location: 'request' | 'message';
  readonly fields: readonly ToolFieldSpec[];
  /** Checked after every field parses. The only one today is readFile's line ordering. */
  readonly crossCheck?: (values: Record<string, unknown>) => string | undefined;
  /** Non-normative prose for the prompt — what calling the tool gets you. */
  readonly returns: string;
}

const CURSOR_NOTE = 'must be a bounded string';

/** The provider-touching tools, which are the ones a `toolRequest` may name. `submitCandidateFinding`
 * and `requestCompletion` are reached through their own message kinds, never through this envelope. */
export type ToolRequestName = Exclude<HostToolName, 'submitCandidateFinding' | 'requestCompletion'>;

export const TOOL_REQUEST_SPECS: Readonly<Record<ToolRequestName, ToolRequestSpec>> = Object.freeze({
  listChangedFiles: {
    location: 'request',
    fields: [{ name: 'cursor', kind: 'cursor' }],
    returns: 'the changed-file manifest, one page at a time.',
  },
  readDiff: {
    location: 'request',
    fields: [{ name: 'path', kind: 'requiredString' }, { name: 'cursor', kind: 'cursor' }],
    returns: 'the changed hunks for one file.',
  },
  readFile: {
    location: 'request',
    fields: [
      { name: 'revision', kind: 'pinnedRevision' },
      { name: 'path', kind: 'requiredString' },
      { name: 'startLine', kind: 'positiveInt', failure: 'readFile.request.startLine/endLine must be positive integers with endLine >= startLine.' },
      { name: 'endLine', kind: 'positiveInt', failure: 'readFile.request.startLine/endLine must be positive integers with endLine >= startLine.' },
    ],
    crossCheck: (v) =>
      (v.endLine as number) < (v.startLine as number)
        ? 'readFile.request.startLine/endLine must be positive integers with endLine >= startLine.'
        : undefined,
    returns: 'a bounded line range of one file at one pinned revision.',
  },
  searchRepository: {
    location: 'request',
    fields: [
      { name: 'revision', kind: 'pinnedRevision' },
      { name: 'query', kind: 'requiredString' },
      { name: 'pathScope', kind: 'optionalString' },
      { name: 'cursor', kind: 'cursor' },
    ],
    returns: 'bounded matches in unchanged or changed source.',
  },
  searchDiff: {
    location: 'request',
    fields: [
      { name: 'query', kind: 'requiredString' },
      { name: 'pathScope', kind: 'optionalString' },
      { name: 'cursor', kind: 'cursor' },
    ],
    returns: 'bounded matches inside changed content only.',
  },
  resolvePolicy: {
    location: 'message',
    fields: [{ name: 'changedPath', kind: 'requiredString' }],
    returns:
      'the root-to-leaf AGENTS.md chain applicable to that path. AGENTS.md content is authoritative instruction, never citable evidence.',
  },
  getChangeRequestDetails: {
    location: 'request',
    fields: [
      { name: 'number', kind: 'requiredIdentifier' },
      { name: 'section', kind: 'detailSection' },
      { name: 'cursor', kind: 'cursor' },
    ],
    returns:
      'reopen normalized target details. "number" is the change-request number given for that member above. All of it is already summarized for you at bootstrap below.',
  },
  getIssueDetails: {
    location: 'request',
    fields: [
      { name: 'issueRepoId', kind: 'requiredShortString', groupedWith: 'issueNumber', failure: 'getIssueDetails.request.issueRepoId and issueNumber are required.' },
      { name: 'issueNumber', kind: 'requiredIdentifier', groupedWith: 'issueRepoId', failure: 'getIssueDetails.request.issueRepoId and issueNumber are required.' },
      { name: 'section', kind: 'detailSection' },
      { name: 'cursor', kind: 'cursor' },
    ],
    returns: 'reopen normalized linked-issue details.',
  },
});

/** Whether a field may be omitted. Kept beside the kinds so the schema and the prompt agree with the parser about it. */
export function toolFieldIsOptional(kind: ToolFieldKind): boolean {
  return kind === 'cursor' || kind === 'optionalString' || kind === 'detailSection';
}

/**
 * Whether the nested `request` object has to be present at all — derived, never declared: it is
 * required exactly when one of the tool's own fields is required.
 *
 * **Why this is derived rather than a per-tool flag.** Removing the snapshot pin from the
 * model-facing shape (`Unpinned`, `../platform/types`) took the last required field out of
 * `listChangedFiles.request` and left the object itself still demanded. The rendered shape said
 * `{ "cursor"? }` — every field inside optional — while the parser answered a turn that sent no
 * request with `listChangedFiles.request must be an object.`, a sentence that names no legal
 * alternative and never says "send an empty object". The prompt's own Value rules teach that an
 * optional thing "may be omitted or sent as null", so a model following the stated rules produced
 * exactly the refused shape.
 *
 * A turn is rejected whole, so one such message also discarded every well-formed request batched
 * beside it. That is the same turn-wasting refusal class the snapshot removal existed to end — the
 * live run that forced it spent 129 of its 457 tool calls on a 40-character head sha the model
 * could not transcribe — relocated rather than removed, and reachable by following our own
 * instructions.
 *
 * Fixing it in the parser alone ("an absent request for an all-optional spec reads as empty") would
 * have worked and would have drifted: the schema would still have marked `request` required and the
 * prompt would still have printed it as required, which is the three-hand-written-descriptions
 * problem this table was built to end. `TOOL_REQUEST_SPECS` is the one definition, so the fact is
 * computed from it once and read by all three — `parseToolCallFromSpec` below,
 * `harnessTurnSchema.ts`'s `oneOf` branch, and `harnessModelSeam.ts`'s shape line. Nothing names
 * `listChangedFiles`; whichever tools qualify, all three agree by construction.
 *
 * `location: 'message'` tools are false here for a different reason: `resolvePolicy` has no request
 * object to make optional, its `changedPath` sitting on the message itself.
 */
export function toolRequestObjectIsRequired(spec: ToolRequestSpec): boolean {
  return spec.location === 'request' && spec.fields.some((field) => !toolFieldIsOptional(field.kind));
}

/** Reads one field per its kind. `absent` distinguishes "legitimately not supplied" from a value; `failure` carries a message only where the kind's single default sentence cannot say what happened — an unprintable identifier. */
type FieldRead =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: true; readonly absent: true }
  | { readonly ok: false; readonly failure?: string };

function readToolField(kind: ToolFieldKind, raw: unknown, path: string): FieldRead {
  switch (kind) {
    case 'requiredString': {
      const value = boundedString(raw);
      return value === undefined ? { ok: false } : { ok: true, value };
    }
    case 'requiredShortString': {
      const parsed = identifierText(raw, MAX_ID_LENGTH);
      if (parsed.ok) return { ok: true, value: parsed.value };
      return parsed.unprintable ? { ok: false, failure: unprintableIdentifier(path) } : { ok: false };
    }
    case 'requiredIdentifier': {
      const parsed = identifierTextOrNumber(raw, MAX_ID_LENGTH);
      if (parsed.ok) return { ok: true, value: parsed.value };
      return parsed.unprintable ? { ok: false, failure: unprintableIdentifier(path) } : { ok: false };
    }
    case 'optionalString':
    case 'cursor': {
      const parsed = boundedOptionalString(raw);
      if (!parsed.ok) return { ok: false };
      return parsed.value === undefined ? { ok: true, absent: true } : { ok: true, value: parsed.value };
    }
    case 'pinnedRevision': {
      const value = parsePinnedRevision(raw);
      return value === undefined ? { ok: false } : { ok: true, value };
    }
    case 'detailSection': {
      const parsed = parseOptionalDetailSection(raw);
      if (!parsed.ok) return { ok: false };
      return parsed.value === undefined ? { ok: true, absent: true } : { ok: true, value: parsed.value };
    }
    case 'positiveInt': {
      const value = positiveInt(raw);
      return value === undefined ? { ok: false } : { ok: true, value };
    }
  }
}

function toolFieldPath(tool: ToolRequestName, spec: ToolRequestSpec, field: ToolFieldSpec): string {
  return spec.location === 'request' ? `${tool}.request.${field.name}` : `${tool}.${field.name}`;
}

/** The failure text for a field, preserving each original parser's wording exactly. */
function toolFieldFailure(tool: ToolRequestName, spec: ToolRequestSpec, field: ToolFieldSpec): string {
  if (field.failure !== undefined) return field.failure;
  const path = toolFieldPath(tool, spec, field);
  switch (field.kind) {
    case 'cursor':
    case 'optionalString':
      return `${path} ${CURSOR_NOTE}.`;
    case 'pinnedRevision':
      return `${path} must be "base" or "head".`;
    case 'detailSection':
      return `${path} must be one of ${listMembers(DETAIL_SECTION_MEMBERS)}.`;
    default:
      return `${path} is required.`;
  }
}

/**
 * The one tool-request parser, driven by the specs above. Field order is the spec's order, which is
 * the order the hand-written parsers checked in — so which complaint a model gets for a request
 * with two problems is unchanged.
 */
function parseToolCallFromSpec(tool: ToolRequestName, memberId: string, rawMessage: Record<string, unknown>): ToolCallParseResult {
  const spec = TOOL_REQUEST_SPECS[tool];
  let source: Record<string, unknown>;
  if (spec.location === 'request') {
    const raw = rawMessage.request;
    // A request with nothing required in it is itself not required — see
    // `toolRequestObjectIsRequired`. `isAbsent` is the same "not supplied" the optional *fields*
    // already use, so omitted, `null` and `""` mean here exactly what the prompt says they mean
    // there, rather than a fourth rule the model would have to be taught separately. A request
    // that is present but is not an object is still a real mistake and still says so.
    if (isAbsent(raw) && !toolRequestObjectIsRequired(spec)) {
      source = {};
    } else if (!isRecord(raw)) {
      return toolFail(reason('schema', `${tool}.request must be an object.`));
    } else {
      source = raw;
    }
  } else {
    source = rawMessage;
  }
  const values: Record<string, unknown> = {};
  for (const field of spec.fields) {
    const read = readToolField(field.kind, source[field.name], toolFieldPath(tool, spec, field));
    // A field-specific failure wins over the kind's default sentence, which cannot tell "absent"
    // from "present but unprintable".
    if (!read.ok) return toolFail(reason('schema', read.failure ?? toolFieldFailure(tool, spec, field)));
    if (!('absent' in read)) values[field.name] = read.value;
  }
  const crossCheckFailure = spec.crossCheck?.(values);
  if (crossCheckFailure !== undefined) return toolFail(reason('schema', crossCheckFailure));
  if (tool === 'resolvePolicy') {
    return { ok: true, call: { tool, memberId, changedPath: values.changedPath as string } };
  }
  // The spec guarantees every field this tool's request type requires has been read and typed by
  // its kind; TypeScript cannot follow that through the table, so the assertion is where the
  // guarantee is stated. `harnessProtocolSpecParity.test.ts` is what actually holds it, by
  // comparing every parsed call against the hand-written parser this replaced.
  return { ok: true, call: { tool, memberId, request: values } as unknown as ParsedToolCall };
}

function parseListChangedFiles(memberId: string, raw: unknown): ToolCallParseResult {
  // `cursor` is the only field and it is optional, so there is nothing left for the request object
  // to carry and no reason to demand it: omitted, `null` and `""` all read as an empty request.
  // Written out here, derived from the field kinds there — `toolRequestObjectIsRequired` — which is
  // the comparison this parser is kept alive to make.
  const source = isAbsent(raw) ? {} : raw;
  if (!isRecord(source)) return toolFail(reason('schema', 'listChangedFiles.request must be an object.'));
  const cursor = parseOptionalCursor(source.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'listChangedFiles.request.cursor must be a bounded string.'));
  const request: Unpinned<ChangedFileManifestRequest> = { ...(cursor.value !== undefined ? { cursor: cursor.value } : {}) };
  return { ok: true, call: { tool: 'listChangedFiles', memberId, request } };
}

function parseReadDiff(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'readDiff.request must be an object.'));
  const path = boundedString(raw.path);
  if (path === undefined) return toolFail(reason('schema', 'readDiff.request.path is required.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'readDiff.request.cursor must be a bounded string.'));
  const request: Unpinned<DiffPageRequest> = { path, ...(cursor.value !== undefined ? { cursor: cursor.value } : {}) };
  return { ok: true, call: { tool: 'readDiff', memberId, request } };
}

function parseReadFile(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'readFile.request must be an object.'));
  const revision = parsePinnedRevision(raw.revision);
  if (revision === undefined) return toolFail(reason('schema', 'readFile.request.revision must be "base" or "head".'));
  const path = boundedString(raw.path);
  if (path === undefined) return toolFail(reason('schema', 'readFile.request.path is required.'));
  const startLine = positiveInt(raw.startLine);
  const endLine = positiveInt(raw.endLine);
  if (startLine === undefined || endLine === undefined || endLine < startLine) {
    return toolFail(reason('schema', 'readFile.request.startLine/endLine must be positive integers with endLine >= startLine.'));
  }
  const request: Unpinned<FileRangeRequest> = { revision, path, startLine, endLine };
  return { ok: true, call: { tool: 'readFile', memberId, request } };
}

function parseSearchRepository(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'searchRepository.request must be an object.'));
  const revision = parsePinnedRevision(raw.revision);
  if (revision === undefined) return toolFail(reason('schema', 'searchRepository.request.revision must be "base" or "head".'));
  const query = boundedString(raw.query);
  if (query === undefined) return toolFail(reason('schema', 'searchRepository.request.query is required.'));
  const pathScope = boundedOptionalString(raw.pathScope);
  if (!pathScope.ok) return toolFail(reason('schema', 'searchRepository.request.pathScope must be a bounded string.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'searchRepository.request.cursor must be a bounded string.'));
  const request: Unpinned<RepositorySearchRequest> = {
    revision,
    query,
    ...(pathScope.value !== undefined ? { pathScope: pathScope.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'searchRepository', memberId, request } };
}

function parseSearchDiff(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'searchDiff.request must be an object.'));
  const query = boundedString(raw.query);
  if (query === undefined) return toolFail(reason('schema', 'searchDiff.request.query is required.'));
  const pathScope = boundedOptionalString(raw.pathScope);
  if (!pathScope.ok) return toolFail(reason('schema', 'searchDiff.request.pathScope must be a bounded string.'));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'searchDiff.request.cursor must be a bounded string.'));
  const request: Unpinned<DiffSearchRequest> = {
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
  const number = identifierTextOrNumber(raw.number, MAX_ID_LENGTH);
  if (!number.ok) {
    return toolFail(reason('schema', number.unprintable ? unprintableIdentifier('getChangeRequestDetails.request.number') : 'getChangeRequestDetails.request.number is required.'));
  }
  const section = parseOptionalDetailSection(raw.section);
  if (!section.ok) return toolFail(reason('schema', `getChangeRequestDetails.request.section must be one of ${listMembers(DETAIL_SECTION_MEMBERS)}.`));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'getChangeRequestDetails.request.cursor must be a bounded string.'));
  const request: Unpinned<ChangeRequestDetailRequest> = {
    number: number.value,
    ...(section.value !== undefined ? { section: section.value } : {}),
    ...(cursor.value !== undefined ? { cursor: cursor.value } : {}),
  };
  return { ok: true, call: { tool: 'getChangeRequestDetails', memberId, request } };
}

function parseGetIssueDetails(memberId: string, raw: unknown): ToolCallParseResult {
  if (!isRecord(raw)) return toolFail(reason('schema', 'getIssueDetails.request must be an object.'));
  // Field by field in the spec's order rather than both-then-check: the grouped "are required"
  // sentence still answers every older cause, but an unprintable value has to name its own field,
  // and which of two complaints a model receives is part of the contract.
  const grouped = 'getIssueDetails.request.issueRepoId and issueNumber are required.';
  const issueRepoId = identifierText(raw.issueRepoId, MAX_ID_LENGTH);
  if (!issueRepoId.ok) return toolFail(reason('schema', issueRepoId.unprintable ? unprintableIdentifier('getIssueDetails.request.issueRepoId') : grouped));
  const issueNumber = identifierTextOrNumber(raw.issueNumber, MAX_ID_LENGTH);
  if (!issueNumber.ok) return toolFail(reason('schema', issueNumber.unprintable ? unprintableIdentifier('getIssueDetails.request.issueNumber') : grouped));
  const section = parseOptionalDetailSection(raw.section);
  if (!section.ok) return toolFail(reason('schema', `getIssueDetails.request.section must be one of ${listMembers(DETAIL_SECTION_MEMBERS)}.`));
  const cursor = parseOptionalCursor(raw.cursor);
  if (!cursor.ok) return toolFail(reason('schema', 'getIssueDetails.request.cursor must be a bounded string.'));
  const request: Unpinned<IssueDetailRequest> = {
    issueRepoId: issueRepoId.value,
    issueNumber: issueNumber.value,
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
    return toolFail(reason('unknownTool', `"${shortEcho(toolName)}" is not a recognized host tool name; this turn's catalog lists the ones you may call.`));
  }
  const memberId = identifierText(raw.memberId, MAX_ID_LENGTH);
  // The dispatcher answers an id it does not know with `Member <id> is not part of this run.`,
  // rendered through the same sanitizer as the pin refusal — so an id carrying a control character
  // would be quoted back looking exactly like the one the model sent, naming no difference at all.
  if (!memberId.ok) return toolFail(reason('schema', memberId.unprintable ? unprintableIdentifier('toolRequest.memberId') : 'toolRequest.memberId is required.'));
  return parseToolCallFromSpec(toolName as ToolRequestName, memberId.value, raw);
}

/**
 * The hand-written per-tool parsers this replaced, kept only so
 * `harnessProtocolSpecParity.test.ts` can prove the spec-driven parser answers identically —
 * same verdict, same parsed call, same failure text — across a generated corpus. Nothing else
 * calls it; delete both together when the spec table has earned enough time in service.
 *
 * A change to a request *shape* has to land here and in `TOOL_REQUEST_SPECS` in the same edit, or
 * parity fails — which is the point, not a burden: parity proves the table answers as these do,
 * and it can only do that while both describe the same eight shapes. Removing the `snapshot` field
 * (see `Unpinned`, `../platform/types`) was such a change and was made in both.
 */
export function parseToolCallLegacy(toolName: ToolRequestName, memberId: string, raw: Record<string, unknown>): ToolCallParseResult {
  switch (toolName) {
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
  }
}

/** Spec-driven, for the parity test to compare against. */
export function parseToolCallFromSpecForParity(toolName: ToolRequestName, memberId: string, raw: Record<string, unknown>): ToolCallParseResult {
  return parseToolCallFromSpec(toolName, memberId, raw);
}

// ---- Per-kind message parsing ---------------------------------------------------------

type MessageParseResult = { readonly ok: true; readonly message: ProtocolMessage } | { readonly ok: false; readonly reasons: readonly ProtocolFailureReason[] };

function msgFail(...reasons: readonly ProtocolFailureReason[]): MessageParseResult {
  return { ok: false, reasons };
}

type PlanItemInputsResult =
  | { readonly ok: true; readonly items: PlanItemInput[] }
  /** Which item, and which of its two identifier fields, carried something unprintable. Absent for every other cause, which keeps the whole-array sentence. */
  | { readonly ok: false; readonly unprintable?: { readonly index: number; readonly field: 'id' | 'memberId' } };

/** Field-by-field, never `{...raw}` — an unrecognized extra field on `raw` is silently ignored, never copied through. */
function parsePlanItemInputs(rawItems: unknown): PlanItemInputsResult {
  if (!Array.isArray(rawItems) || rawItems.length === 0) return { ok: false };
  const items: PlanItemInput[] = [];
  for (const [index, rawItem] of rawItems.entries()) {
    if (!isRecord(rawItem)) return { ok: false };
    // A plan item id is an identifier the host quotes back: `planItemStateChanged` names an
    // unknown one with `"<id>" does not name a known plan item.` through `shortEcho`, which strips
    // control characters — so an id carrying one would be reported back looking identical to the
    // id the plan is displaying, and neither the model nor a reader could see the difference.
    const id = identifierText(rawItem.id, MAX_ID_LENGTH);
    if (!id.ok && id.unprintable) return { ok: false, unprintable: { index, field: 'id' } };
    const description = typeof rawItem.description === 'string' ? rawItem.description : undefined;
    if (!id.ok || description === undefined) return { ok: false };
    let state: PlanItemState | undefined;
    if (rawItem.state !== undefined) {
      if (!isPlanItemState(rawItem.state)) return { ok: false };
      state = rawItem.state;
    }
    // Absent memberId means shared cross-member work (task 13.3); present-but-malformed fails closed.
    const memberId = optionalIdentifierText(rawItem.memberId, MAX_ID_LENGTH);
    if (!memberId.ok) return memberId.unprintable ? { ok: false, unprintable: { index, field: 'memberId' } } : { ok: false };
    items.push({
      id: id.value,
      description,
      ...(state !== undefined ? { state } : {}),
      ...(memberId.value !== undefined ? { memberId: memberId.value } : {}),
    });
  }
  return { ok: true, items };
}

/** The whole-array sentence for every cause it always covered; a named item and field when one carries something the host could not echo. */
function planItemsFailure(kind: 'planCreated' | 'planRevised', result: Extract<PlanItemInputsResult, { ok: false }>): string {
  return result.unprintable === undefined
    ? `${kind}.items must be a non-empty array of {id, description, state?}.`
    : unprintableIdentifier(`${kind}.items[${result.unprintable.index}].${result.unprintable.field}`);
}

function parsePlanCreated(raw: unknown, previousPlan: Plan | undefined): MessageParseResult {
  if (previousPlan !== undefined) {
    return msgFail(reason('planAlreadyExists', 'A plan already exists for this lineage; send planRevised, not planCreated.'));
  }
  if (!isRecord(raw)) return msgFail(reason('schema', 'planCreated must be an object.'));
  const parsedItems = parsePlanItemInputs(raw.items);
  if (!parsedItems.ok) return msgFail(reason('schema', planItemsFailure('planCreated', parsedItems)));
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
  if (!parsedItems.ok) return msgFail(reason('schema', planItemsFailure('planRevised', parsedItems)));
  const rationale = typeof raw.rationale === 'string' ? raw.rationale : undefined;
  if (rationale === undefined) return msgFail(reason('schema', 'planRevised.rationale is required.'));
  const plan = revisePlan(previousPlan, parsedItems.items, rationale);
  if (!plan) return msgFail(reason('schema', 'planRevised did not produce a valid revision (a prior item id vanished, or rationale/description was unsanitizable).'));
  return { ok: true, message: { kind: 'planRevised', plan } };
}

function parsePlanItemStateChanged(raw: unknown, effectivePlan: Plan | undefined): MessageParseResult {
  if (!isRecord(raw)) return msgFail(reason('schema', 'planItemStateChanged must be an object.'));
  const itemId = identifierText(raw.itemId, MAX_ID_LENGTH);
  if (!itemId.ok) return msgFail(reason('schema', itemId.unprintable ? unprintableIdentifier('planItemStateChanged.itemId') : 'planItemStateChanged.itemId is required.'));
  if (!isPlanItemState(raw.state)) return msgFail(reason('schema', `planItemStateChanged.state must be one of ${listMembers(PLAN_ITEM_STATES)}.`));
  if (effectivePlan === undefined) {
    return msgFail(reason('noPlan', 'No plan exists yet to transition an item in.'));
  }
  if (!effectivePlan.items.some((item) => item.id === itemId.value)) {
    return msgFail(reason('unknownItemId', `"${shortEcho(itemId.value)}" does not name a known plan item.`));
  }
  return { ok: true, message: { kind: 'planItemStateChanged', itemId: itemId.value, state: raw.state } };
}

function parsePublicRationale(raw: unknown): MessageParseResult {
  if (!isRecord(raw)) return msgFail(reason('schema', 'publicRationale must be an object.'));
  const rationale = sanitizePublicText(raw.rationale);
  if (rationale === undefined) return msgFail(reason('schema', 'publicRationale.rationale is required.'));
  const itemId = optionalIdentifierText(raw.itemId, MAX_ID_LENGTH);
  if (!itemId.ok) return msgFail(reason('schema', itemId.unprintable ? unprintableIdentifier('publicRationale.itemId') : 'publicRationale.itemId must be a bounded string.'));
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
  const memberId = optionalIdentifierText(record.memberId, MAX_ID_LENGTH);
  if (!memberId.ok) return msgFail(reason('schema', memberId.unprintable ? unprintableIdentifier('completionRequest.memberId') : 'completionRequest.memberId must be a bounded string.'));
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

/**
 * The rules `validateBatchCompatibility` enforces, stated in prose for the prompt.
 *
 * These used to be written out by hand in `../app/harnessModelSeam.ts`, and that copy was missing
 * the one rule that mattered most: the per-turn tool cap. A live review of a 26-file change threw
 * away 7 of its 36 model calls to `tooManyToolRequests` — the model asked for 10, 13, 13, 14, 15,
 * 16 and finally all 26 reads at once, and each time the whole turn was discarded. It learned the
 * number only from the rejection, and the next turn's prompt is rebuilt without that repair text,
 * so the lesson never survived to the turn that needed it.
 *
 * Rendering the rules from the module that enforces them is what stops a rule from being enforced
 * and never stated. `../app/harnessModelSeam.contract.test.ts` renders this with a non-default
 * policy and asserts the printed cap follows it, so the number can never be a literal again.
 */
export function describeBatchRules(policy: HarnessPolicy): string {
  const cap = policy.maxToolRequestsPerTurn;
  return [
    'At most one of planCreated/planRevised, one publicRationale, one',
    'checkpointSuggestion, and one completionRequest may appear in a turn.',
    'completionRequest and checkpointSuggestion may not be batched with anything',
    'else. Multiple candidateSubmission messages may share a turn.',
    `Up to ${cap} toolRequest messages may share a turn. A turn carrying more is`,
    'rejected whole and none of its requests run, so when more files remain than',
    `that, send ${cap} and continue in the next turn.`,
  ].join('\n');
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
const FENCE_MARKER = '```';

/**
 * Removes a markdown code fence, but ONLY when the reply is one fenced block and nothing else.
 *
 * The pattern above is anchored at both ends with no `m` flag, so on a reply that opens with a
 * fence and closes with a fence it matches from the FIRST opening fence to the LAST closing one
 * and captures everything between them — interior fence markers, prose, second and third blocks
 * and all. Position 0 of that capture is the first fenced block's content, not the model's whole
 * payload, and that quietly reintroduced the exact defect `extractJsonValue` gave up its search
 * to remove: the single candidate position stopped being the model's turn.
 *
 * Measured against a reply carrying a fenced worked EXAMPLE (one `publicRationale`) and, after
 * some prose, the real fenced turn (two `toolRequest`s):
 *
 *   | reply                                                    | before this guard            |
 *   | fenced example, prose, fenced real turn                  | ok — the EXAMPLE ran         |
 *   | the same, with one word of prose before the first fence  | noJson                       |
 *   | the same, with no final closing fence                    | noJson                       |
 *   | fenced example, prose, fenced example 2, prose, real turn| ok — the FIRST example ran   |
 *   | fenced example, prose, fenced TRUNCATED real turn        | ok — the example ran and the |
 *   |                                                          | truncation was never reported|
 *
 * Three of those five are silent wrong answers, and leading with a fenced example is an ordinary
 * way for a review model to write the mistake — it is round 1's break case again, reached through
 * the fence pass instead of through a search. The other two rows show how narrow the accident
 * was: the reply had to open with a fence AND close with one to be mangled at all.
 *
 * The test for "one fenced block" is a literal three-backtick run anywhere in the captured
 * content. Content carrying a fence marker did not come from a single fenced block, so the fence
 * is left in place and the reply fails loudly as `noJson` — the text now starts with a backtick,
 * which is not a JSON opener. That restores the invariant the whole design rests on: after
 * stripping, position 0 is the model's whole payload.
 *
 * The residual, named rather than implied: a genuine single fenced turn whose own string values
 * quote a three-backtick run — a model writing "the block ```js … ``` is gone" inside a rationale
 * — is no longer stripped, and costs one repair. Distinguishing that from a second fenced block
 * means reading the content to decide which markers are "really" fences, which is the search this
 * module abandoned after three rounds of silent wrong answers. A loud repair on a rare reply is
 * the trade this file makes every time. What the residual does not touch: single backticks, which
 * are how a model ordinarily quotes an identifier, are unaffected — the test is for a run of
 * three — and a single fenced turn with no fence marker inside it still parses with zero repairs.
 */
function stripCodeFence(text: string): string {
  const match = CODE_FENCE_PATTERN.exec(text);
  if (!match) return text;
  const content = match[1] ?? '';
  return content.includes(FENCE_MARKER) ? text : content;
}

/**
 * Index of the character that closes the JSON value opening at `start`, or `undefined` if the
 * value never closes.
 *
 * This replaced a `lastIndexOf('}')`/`lastIndexOf(']')` heuristic, which chose the *last* closer
 * anywhere in the text. That is the right answer for the case it was written for — prose wrapped
 * around JSON — and the wrong answer for a tail of junk after it. A live review of a 207-file
 * change lost five whole turns to the difference: the model emitted a complete, valid
 * `{"messages":[ ... ]}` and then appended a spurious `]}`, observed verbatim three times in one
 * run on objects of 2229, 2434 and 2296 bytes. `lastIndexOf('}')` selected the junk brace, so the
 * salvage sliced the entire string including the junk and re-parsed the text that had just failed.
 * Every message in those turns was well-formed and all of them were thrown away.
 *
 * Walking forward from the opener and stopping where depth returns to zero answers both cases,
 * because a complete value's end is a property of the value rather than of whatever follows it.
 * The scan tracks string literals and their backslash escapes, so a `}`, `]` or `"` inside a
 * string never moves the depth — this is not hypothetical for us: tool requests carry `path`
 * values and change-request bodies carry arbitrary prose.
 *
 * Openers and closers are counted without checking that each closer matches its own opener
 * (`{"a":1]` "closes" at the bracket). Verifying the pairing here would duplicate the JSON grammar;
 * `JSON.parse` rejects the slice a moment later and `extractJsonValue` fails the turn as
 * `noJson`, which is what a mismatched slice deserves anyway.
 *
 * Cost is one forward pass with no backtracking: the index only increases, so the scan is O(n) in
 * the text it is given, and `parseModelTurn` has already refused anything over `MAX_TURN_RAW_BYTES`
 * before this runs (a string's UTF-16 length never exceeds its UTF-8 byte length, so that guard
 * bounds the character count too). No separate cap is imposed here, deliberately: a second bound
 * could only ever fire on input the byte guard already rejected, and firing it would report an
 * oversized turn as an unterminated one.
 */
function findValueEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth <= 0) return index;
    }
  }
  return undefined;
}

type JsonExtraction =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly code: 'noJson' | 'unterminatedJson' };

/**
 * Extracts the one JSON value that is this turn's message batch. The turn must BEGIN at the first
 * character of the reply — after trimming, and again after stripping a markdown code fence — and
 * where a fence was stripped it must END at the last character too. Nothing here scans forward
 * looking for an opener.
 *
 * This is the fourth rule to stand in this position and the first that removes a capability rather
 * than refining one. The three before it all searched the text for a JSON value inside arbitrary
 * prose, and every one of them had a class of reply where it handed over the wrong messages and
 * reported success:
 *
 *  1. First complete balanced value wins. A model writing "the shape is {example} — here is my
 *     turn: {real}" had the example run and both real tool requests dropped, reported `ok: true`.
 *  2. Last object-form envelope wins, bare arrays as a second tier. That reversed the pair above
 *     and broke four more arrangements, all silent: an example followed by a real turn that was
 *     CUT OFF ran the example and never mentioned the truncation; an envelope quoted after the
 *     turn ("the turn you rejected earlier was …") overruled the turn; an object-form example beat
 *     a bare-array real turn in either order; and prose carrying one unbalanced `{` swallowed a
 *     complete turn and reported it as never closing, which was not a poor diagnosis but a false
 *     one.
 *  3. Count turn-shaped values, accept exactly one, fail loudly on two. Broke on string parity: a
 *     stray opener in prose with an ODD number of quote characters flips the scan's in-string
 *     state across the real turn, so the turn's own braces read as string contents and a `}` inside
 *     one of its string values closes the span. The slice fails to parse, the real turn is never
 *     seen, and an earlier example is handed over as the only turn. A fuzz over 5000 realistic
 *     review replies measured 68 silent wrong answers (1.4%) where the rule before this whole
 *     family failed loudly on all 5000.
 *
 * The lesson is settled: scanning for a JSON value inside arbitrary prose cannot be made safe.
 * Every rule that searches past the start of the text has inputs where it substitutes one value
 * for another and reports success, and a review model's ordinary output — quoted code fragments,
 * unbalanced braces, brackets in citations, quotes around snippets — is exactly that input. So
 * there is one candidate position and it is character 0. One position means no choice, and no
 * choice means nothing to get wrong: the property is structural, not a better heuristic.
 *
 * What this keeps:
 *
 *  - The live failure this path exists for. A model emitted a complete, valid `{"messages":[…]}`
 *    and appended a spurious `]}` — observed verbatim three times in one review of a 207-file
 *    change, on objects of 2229, 2434 and 2296 bytes, losing five whole turns. The value starts at
 *    character 0, `findValueEnd` ends it where the value ends, and the tail is ignored: zero
 *    repairs. This is the load-bearing case.
 *  - Fenced turns whose fenced content is the whole turn and nothing else — one fenced block, per
 *    `stripCodeFence`, and that block parsing WHOLE, per the tail rule below. A reply carrying
 *    several fenced blocks is not stripped at all and fails loudly, because the fence pattern's
 *    own match spans from the first opening fence to the last closing one, which would put a
 *    worked example at position 0 and hand the example over as the turn.
 *  - `unterminatedJson` kept distinct from `noJson`, because a model that was cut off has to
 *    resend its turn and a model that wrote prose has to stop writing prose.
 *
 * What it gives up, deliberately: a turn wrapped in prose. That costs one repair now instead of
 * being salvaged. The salvage was never reliable anyway — the original `lastIndexOf` version only
 * worked when no brace appeared anywhere in the surrounding prose — and three rounds have shown
 * that making it reliable is not possible without silently answering a question the model never
 * asked.
 *
 * The one residual, named here because the retreat does not remove it. Stated exactly, because an
 * earlier and narrower wording of it measured false: where no fence was stripped, the trimmed
 * reply begins with a complete JSON value that reads as an envelope, and EVERYTHING after it is
 * discarded, whatever it is. So a worked example at character 0 runs and the real turn following
 * it is lost. Three consequences the narrow wording missed, all the same mechanism and none of
 * them able to select a different value: `.trim()` runs first, so any whitespace — including
 * U+FEFF, U+00A0 and U+2028 — may precede the example; the discarded tail may itself contain a
 * fenced real turn; and the value at character 0 may be a bare array as readily as an object.
 * Trimming cannot widen the danger, since it never changes which character comes first: 30,000
 * differential samples padded at both ends changed no answer. The invisibles that are not
 * whitespace (U+200B, U+2060, NEL, NUL) are not trimmed and fail loudly.
 *
 * Telling a junk tail (`]}`) from a second envelope means reading the tail, which is the search
 * this rule exists to remove, so the two cannot both be had; the live bug is what demanded the
 * tail be tolerated where no fence delimits it. Every other arrangement of that mistake is loud:
 * any prose at all before the first value fails as `noJson`; the fenced form where the example and
 * the real turn sit in separate code blocks fails, because nothing is stripped (`stripCodeFence`);
 * and the fenced form where both sit in ONE block fails on the whole-parse rule below.
 *
 * The failure recorded by the LAST pass is the one returned. That cannot lose a truthful
 * diagnosis: a fence-stripped pass only reaches `unterminatedJson` from a text the first pass
 * rejected for not starting with an opener, and a first pass that reached `unterminatedJson` gets
 * a byte-identical second pass, because a text starting with `{` or `[` cannot match the
 * code-fence pattern. A reply `stripCodeFence` declines to strip also yields a byte-identical
 * second pass — tail tolerance included, because the tail is refused only where a fence was
 * actually stripped — which costs one wasted `JSON.parse` of a string beginning with a backtick
 * and cannot change the recorded diagnosis.
 */
function extractJsonValue(rawText: string): JsonExtraction {
  const trimmed = rawText.trim();
  const unfenced = stripCodeFence(trimmed).trim();
  let recorded: JsonExtraction = { ok: false, code: 'noJson' };
  // Each candidate position is paired with whether a value there may be followed by anything else.
  // `unfenced === trimmed` is exactly "no fence was stripped": stripping removes at least the two
  // fence markers, so a stripped text can never equal the text it came from. That keeps the second
  // pass byte-identical in behaviour whenever nothing was stripped, tail tolerance and all.
  for (const [text, tailTolerated] of [[trimmed, true], [unfenced, unfenced === trimmed]] as const) {
    if (text.length === 0) continue;
    const whole = tryParseJson(text);
    if (whole !== undefined) return { ok: true, value: whole };
    const opener = text[0];
    if (opener !== '{' && opener !== '[') {
      recorded = { ok: false, code: 'noJson' };
      continue;
    }
    const end = findValueEnd(text, 0);
    if (end === undefined) {
      recorded = { ok: false, code: 'unterminatedJson' };
      continue;
    }
    // A value that closes but does not parse is a mistake inside the turn the model meant to send,
    // not evidence that some other value elsewhere in the text was the real one. Nothing is looked
    // for past it.
    //
    // A value that closes and DOES parse is the turn — but only where no fence delimited it. A
    // fence delimits the payload exactly, and the model drew that boundary itself: everything it
    // put inside the block is what it is claiming as its turn. So a complete value followed by
    // anything else IN THERE means it put two things in one block, and there is no honest way to
    // pick between them. Taking the first was measured on this parser:
    //
    //   ```json
    //   {"messages":[{"kind":"publicRationale","rationale":"illustration only"}]}
    //   {"messages":[{"kind":"toolRequest","tool":"readDiff",…,"path":"src/one.ts"}]}
    //   ```
    //
    // reported `ok: true` with one `publicRationale` and the real tool request silently dropped,
    // and the same reply with the second value CUT OFF reported success and never mentioned the
    // truncation. That is the multi-block guard's own defect reached through a single block, and it
    // predates that guard. Outside a fence there is no boundary the model drew, which is why a tail
    // is tolerated there — that is the live `]}` reply, which still parses with zero repairs.
    //
    // The cost, taken deliberately: a fenced turn carrying a stray `]}` INSIDE the fence used to
    // parse and now costs one repair. Both sides of the trade are speculative — the `]}` has only
    // ever been observed unfenced, and a model putting two envelopes in one block has only ever
    // been observed as prose-and-example arrangements elsewhere — so it is decided on severity: a
    // cheap loud failure beats a silent substitution of one turn for another.
    //
    // `findValueEnd` above still runs when the tail is refused, for the diagnosis alone. A fenced
    // value that never closes stays `unterminatedJson` — resend the turn — rather than collapsing
    // into "the reply did not begin with JSON", which would be a false thing to tell that model.
    const value = tailTolerated ? tryParseJson(text.slice(0, end + 1)) : undefined;
    if (value !== undefined) return { ok: true, value };
    recorded = { ok: false, code: 'noJson' };
  }
  return recorded;
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

/**
 * Reads a value as a message batch: `{ "messages": [ ... ] }`, or a bare `[ ... ]`. The object
 * form is the one the prompt's "Reply format" section teaches; the bare array is leniency
 * inherited from the legacy `runPrompt` extraction, kept because a model that sends one is still
 * sending a batch this parser can act on.
 */
function rawMessageEntries(value: unknown): readonly unknown[] | undefined {
  if (isRecord(value) && Array.isArray(value.messages)) return value.messages;
  if (Array.isArray(value)) return value;
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
  if (!isProtocolMessageKind(kind)) return { ok: false, reasons: [reason('unknownKind', `"${shortEcho(kind)}" is not a recognized message kind; use one of ${listMembers(PROTOCOL_MESSAGE_KINDS)}.`)] };
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
  // Named distinctly from the generic `noJson` below (never lumped in with it): a model that sent
  // prose without JSON and a model that sent literally nothing are different failures, and a
  // reviewer debugging "why did this run fail" needs to see which one happened, all the way through
  // whatever bounded repair attempts follow (`../app/harnessTurn.ts`) and into the attempt's own
  // recorded limitation if repairs exhaust (`../app/harnessAttempt.ts`'s `runPhaseLoop`).
  if (rawByteLength === 0) {
    return failure('parse', [reason('emptyResponse', 'The model returned an empty response (0 bytes) instead of a protocol turn.')], emptyMeta);
  }
  if (rawByteLength > MAX_TURN_RAW_BYTES) {
    return failure('parse', [reason('turnTooLarge', `The turn exceeds ${MAX_TURN_RAW_BYTES} bytes.`)], emptyMeta);
  }

  // Each way the extraction can fail gets its own code, for the same reason `emptyResponse` above
  // has one: "the reply did not begin with JSON" and "the JSON here stops in the middle" are two
  // different things to tell a model and they have different fixes — put the object first, or
  // resend the turn whole. Each message states what was observed and stops there: the unterminated
  // wording does not assert the response was truncated, because a reply that opens a value in
  // quoted code and never closes it reaches that path too.
  const extraction = extractJsonValue(rawText);
  if (!extraction.ok) {
    const extractionReason = extraction.code === 'unterminatedJson'
      ? reason('unterminatedJson', 'The turn\'s JSON never closes — it opens a value and reaches the end of the turn still inside it, so the turn it was sending could not be read.')
      : reason('noJson', 'The turn did not begin with a valid JSON object or array.');
    return failure('parse', [extractionReason], emptyMeta);
  }

  const rawEntries = rawMessageEntries(extraction.value);
  if (rawEntries === undefined) {
    // Names the one shape the prompt's "Reply format" section states, not the two shapes
    // `rawMessageEntries` happens to accept. The parser keeps its leniency about a bare array; the
    // text a model reads to correct itself should not advertise a second form the prompt never
    // showed it and then leave it to choose between them.
    return failure('parse', [reason('invalidEnvelope', 'The turn must be one JSON object with a "messages" array: { "messages": [ ... ] }.')], emptyMeta);
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
  // A turn rejected only for batching too many messages of one kind parsed perfectly well; telling
  // it that the turn "could not be parsed" sends it looking for a syntax error it never made.
  const batchOnly = failureKind === 'parse' && reasons.length > 0 && reasons.every((r) => r.code === 'batchIncompatible');
  // Same principle one step further along: a turn that stopped mid-value is not a turn with a
  // mistake in it, and "could not be parsed" sends the model hunting for a malformed field instead
  // of resending the whole thing.
  const unterminatedOnly = failureKind === 'parse' && reasons.length > 0 && reasons.every((r) => r.code === 'unterminatedJson');
  // And once more, for what the retreat in `extractJsonValue` made the common failure: a reply
  // that put prose before its JSON usually has nothing malformed in it, and "could not be parsed"
  // sends the model hunting for a bad field instead of moving the object to the front. The wording
  // also has to hold for the other reply this code covers — one that starts with an opener and is
  // not valid JSON — so it says the reply did not begin with a VALID object rather than asserting
  // prose that may not be there.
  const noJsonOnly = failureKind === 'parse' && reasons.length > 0 && reasons.every((r) => r.code === 'noJson');
  const opener = failureKind === 'contract'
    ? 'Your last turn included a message not permitted in the current phase.'
    : batchOnly
      ? 'Your last turn was valid but combined more messages than one turn allows.'
      : unterminatedOnly
        ? 'Your last turn stopped before its JSON closed, so none of it could be read.'
        : noJsonOnly
          ? 'Your last turn did not begin with a valid JSON object. Begin the reply with the JSON object itself: no prose, heading, or code fence before it.'
          : 'Your last turn could not be parsed as a valid protocol turn.';
  const cleanedReasons = reasons
    .slice(0, MAX_REPAIR_REASONS)
    // Each reason already ends in a full stop; the join below adds its own, and `..` reads as a
    // typo in the one text whose whole job is to be followed precisely.
    .map((r) => sanitizePublicText(`${r.code}: ${r.message}`.replace(/\.\s*$/, '')))
    .filter((text): text is string => text !== undefined);
  const dropped = reasons.length - MAX_REPAIR_REASONS;
  const droppedNote = dropped > 0 ? ` (${dropped} further problem${dropped === 1 ? '' : 's'} not listed)` : '';
  // The old closer offered two envelope shapes (an array of messages, or an object with a
  // "messages" array) where the prompt's own "Reply format" section states exactly one, so the
  // one text a model reads when it is already confused disagreed with the text that taught it the
  // format. The shape here is copied from that section (`../app/harnessModelSeam.ts`) verbatim.
  const closer = ' Resend the whole turn as exactly one JSON object of the form { "messages": [ ... ] } and nothing else. Do not repeat the previous invalid content.';
  // The closer is the only actionable sentence here, so it is appended AFTER the body is cut to
  // fit rather than being part of what gets cut. Twelve problems used to push the composite to
  // exactly the cap and truncate the instruction away entirely, leaving a repair note that
  // described the failure and never said what to do about it.
  const room = MAX_REPAIR_INSTRUCTION_LENGTH - opener.length - closer.length;
  let body = cleanedReasons.length > 0 ? ` Problems: ${cleanedReasons.join(' | ')}.${droppedNote}` : '';
  if (body.length > room) body = room > 1 ? `${body.slice(0, Math.max(0, room - 1))}…` : '';
  return `${opener}${body}${closer}`;
}
