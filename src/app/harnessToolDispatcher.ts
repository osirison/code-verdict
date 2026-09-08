/**
 * Host tool request validation, dispatch, and bounded result envelopes
 * (tasks 9.2-9.4 of `add-agentic-review-harness`, design.md D6/D7/D8/D9/D11/
 * D12, spec `agentic-review-harness` "The model plans and investigates
 * through bounded host tools").
 *
 * This module wires the section-9 host tool catalog (`../domain/harnessTools`)
 * to the provider-neutral `Connection` operations (`../platform/provider`)
 * and to the host-owned mechanisms every other harness module already
 * implements: the evidence ledger (`./harnessEvidenceLedger`), the budget
 * tracker (`./harnessBudgets`), candidate validation (`./harnessCandidateValidation`),
 * the completion gate (`./harnessCompletion`), `AGENTS.md` policy resolution
 * (`./harnessAgentsPolicy`), and public-text sanitization
 * (`./harnessActivitySanitizer`). It introduces no parallel abstraction for
 * any of those — see each import below.
 *
 * **Byte-identity invariant (design.md D8, the most important correctness
 * rule in this module):** only the exact bytes returned to the model are
 * citable, and citation validation checks the ledger's digest. Every
 * evidence-bearing handler therefore *registers into the ledger first*, and
 * builds its result envelope from the `LedgerEvidenceSource` the ledger
 * handed back — never from the original provider payload reshaped
 * independently. If registration itself is refused (`RegistrationOutcome.ok
 * === false`), the tool result is the explicit `refused` state with code
 * `registrationRefused`, never a silent empty success.
 *
 * **Validation order (task 9.2)**, fixed and applied before any dispatch:
 * `unknownTool -> phaseNotAllowed -> unknownMember -> invalidPath ->
 * revisionMismatch -> forgedCursor -> outOfBounds -> capabilityUnavailable ->
 * budgetRefused -> cancelled`. Every step returns a typed `refused` result;
 * nothing in this module throws for a validation failure.
 *
 * **Who supplies the revision pin.** The host, always. A request names a
 * member and a path; `snapshotOf` builds that member's `{repoId, baseSha,
 * headSha}` and every pinned handler passes it to the provider. No caller —
 * model or host — can name a repository or a commit, so the `revisionMismatch`
 * step no longer compares a copy of the pin against the member's; see
 * `snapshotOf` for the three live incidents that removed the copy, and
 * `validate` for the one thing `revisionMismatch` still answers.
 *
 * **Cursor provenance** is host state with no prior module (D6's tools are
 * the first thing that hands the model an opaque continuation token). The
 * dispatcher remembers every cursor value it has issued, keyed by the tool,
 * the member, and a digest of the request fields that produced it (path,
 * query, section, ...). A cursor the dispatcher never issued, or replayed
 * against a different tool/member/scope, is refused as `forgedCursor`.
 * Cursors are opaque throughout — this module never parses one, matching
 * `InvestigationCursor`'s own contract.
 *
 * **`listChangedFiles` is inventory, not citable evidence** (task 9.4): its
 * result is never registered into the ledger. It is instead handed to an
 * injected `onManifestPage` callback so the (separately implemented)
 * inventory/coverage layer can accumulate it; the model still sees the raw
 * manifest entries in the tool result, just without a `sourceId`/`digest`.
 *
 * **Seams left for tasks 9.5-9.8** (not implemented here): `executeProviderCall`
 * lets a later retry/backoff engine wrap every provider call without
 * changing this dispatcher; `onToolDispatched` lets a later
 * activity/checkpoint layer observe every dispatch without this module
 * depending on `harnessActivityLog`; and the `AgentCancellationToken` check
 * both before reserving budget and immediately after the provider call
 * returns makes a late result (one that resolves after cancellation)
 * structurally ignorable — it is never registered or returned as content.
 */
import { canonicalStringify, sha256Hex } from './contentDigest';
import type { AgentCancellationToken } from './lmAgent';
import type { AgentsPolicyChain, AgentsPolicyLevel, AgentsPolicyResolver } from './harnessAgentsPolicy';
import { sanitizeErrorReason } from './harnessActivitySanitizer';
import type { BudgetTracker, ReservationPurpose } from './harnessBudgets';
import {
  validateCandidate,
  type CandidateTracker,
  type CandidateValidationContext,
  type CandidateValidationOutcome,
} from './harnessCandidateValidation';
import type { CompletionEvaluation, CompletionRequestResponse } from './harnessCompletion';
import { respondToCompletionRequest } from './harnessCompletion';
import {
  normalizeEvidencePath,
  type EvidenceLedger,
  type EvidenceLedgerMember,
  type LedgerEvidenceSource,
  type RegistrationRefusal,
} from './harnessEvidenceLedger';
import type { RunPhase } from '../domain/harnessActivity';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import {
  HARNESS_TOOL_CONTRACT_VERSION,
  hostToolDefinition,
  type HostToolDefinition,
  type HostToolName,
  type ToolPageSizePolicyField,
} from '../domain/harnessTools';
import { retryBackoffPolicyFrom, runWithRetry, wireCancellationLifecycle, type RetryHooks } from './harnessRetry';
import type { Connection, InvestigationOperationCapability, MemberCapabilities, ReviewInvestigationCapabilities } from '../platform/provider';
import type {
  ChangedFileEntry,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequestDetailRequest,
  DetailSection,
  DiffPageRequest,
  DiffSearchRequest,
  FileRangeRequest,
  InvestigationCursor,
  InvestigationSnapshotRef,
  InvestigationSource,
  IssueDetailRequest,
  PinnedRevision,
  RepositorySearchRequest,
  Unpinned,
} from '../platform/types';
import { INVESTIGATION_OPERATION_NAMES } from '../platform/types';

// ---- Members ----------------------------------------------------------------

/** An `EvidenceLedgerMember` plus what the dispatcher additionally needs to reach that member's provider (D15: a changeset can span providers/instances). */
export interface DispatcherMember extends EvidenceLedgerMember {
  readonly connection: Connection;
  readonly capabilities: MemberCapabilities;
  /**
   * What answers this member's five revision-pinned operations
   * (`add-local-git-investigation` task 9.1: the source is selected once,
   * before the attempt starts, and cannot change during it).
   *
   * **Required, and it used to be optional.** Absent used to mean "the
   * connection is the source", which was the ordinary provider case; that
   * fallback is precisely the second route around the object store the
   * reviewer's rule forbids, and a member with no source now has no attempt to
   * dispatch for at all — selection refuses before this type is ever
   * constructed.
   *
   * The three forge-only operations — change-request details, issue details,
   * the head check — always go to the connection: no object store can answer a
   * question about a change request.
   */
  readonly investigationSource: InvestigationSource;
}

/**
 * Who answers one pinned operation for this member. One function, used by all
 * five handlers, so a member can never be read half from one source and half
 * from another — design D5's rule that evidence within an attempt comes from
 * exactly one view of the change.
 */
function investigationSourceFor(member: DispatcherMember): InvestigationSource {
  return member.investigationSource;
}

/**
 * The five tools whose names *are* the five pinned operations, so the one place
 * that decides "connection or source" reads the contract's own list rather than
 * a second copy of it.
 *
 * `resolvePolicy` is not one of the five, but it reaches the same place:
 * `dispatchTargetFor` routes it to the source too, because the `AGENTS.md` walk
 * it dispatches to runs `readFile` against the member's investigation source
 * (`harnessAttempt.ts`'s policy resolver). `AGENTS.md` is a file in the
 * repository at the base revision, so git answers it like every other file
 * read; before this change it was fetched from the forge, one API call per
 * directory per changed path.
 */
const INVESTIGATION_TOOL_NAMES: ReadonlySet<string> = new Set<string>(INVESTIGATION_OPERATION_NAMES);

/**
 * Whose method a tool's dispatch will actually call — the same answer the
 * handlers reach through `investigationSourceFor`, asked before dispatch so an
 * operation is not reported unavailable because the *connection* does not
 * implement it while the selected source does. That case is real: the local
 * source answers `searchRepository` at a pinned commit, and GitHub's connection
 * defines no `searchRepository` at all.
 */
function dispatchTargetFor(definition: HostToolDefinition, member: DispatcherMember): Partial<Connection> | InvestigationSource {
  const fromSource = INVESTIGATION_TOOL_NAMES.has(definition.name) || definition.name === 'resolvePolicy';
  return fromSource ? investigationSourceFor(member) : member.connection;
}

// ---- Requests -----------------------------------------------------------------

interface ToolRequestCommon {
  /** Idempotency key, forwarded to `BudgetTracker.reserve` (D12: read tools and `submitCandidateFinding` are idempotent by request identifier). */
  readonly requestId: string;
  readonly elapsedMs: number;
  /** Which budget lane this call draws from; defaults to `'exploration'`. The dispatcher has no basis to infer `highRiskCoverage`/`verification` itself — that is a caller (planning/coverage layer) decision. */
  readonly purpose?: ReservationPurpose;
  /** Host-initiated dispatch skips the per-turn tool cap (D12); every model-issued call defaults to `false`. */
  readonly hostInitiated?: boolean;
}

/**
 * Every request below is `Unpinned` (`../platform/types`): a caller names the member and what it
 * wants read, never which repository or which two commits to read it at. `snapshotOf` supplies
 * those from the member itself, at each handler's single provider call — see the file header's
 * "Who supplies the revision pin".
 */
export type ListChangedFilesToolRequest = ToolRequestCommon & { readonly tool: 'listChangedFiles'; readonly memberId: string; readonly request: Unpinned<ChangedFileManifestRequest> };
export type ReadDiffToolRequest = ToolRequestCommon & { readonly tool: 'readDiff'; readonly memberId: string; readonly request: Unpinned<DiffPageRequest> };
export type ReadFileToolRequest = ToolRequestCommon & { readonly tool: 'readFile'; readonly memberId: string; readonly request: Unpinned<FileRangeRequest> };
export type SearchRepositoryToolRequest = ToolRequestCommon & { readonly tool: 'searchRepository'; readonly memberId: string; readonly request: Unpinned<RepositorySearchRequest> };
export type SearchDiffToolRequest = ToolRequestCommon & { readonly tool: 'searchDiff'; readonly memberId: string; readonly request: Unpinned<DiffSearchRequest> };
export type ResolvePolicyToolRequest = ToolRequestCommon & { readonly tool: 'resolvePolicy'; readonly memberId: string; readonly changedPath: string };
export type GetChangeRequestDetailsToolRequest = ToolRequestCommon & { readonly tool: 'getChangeRequestDetails'; readonly memberId: string; readonly request: Unpinned<ChangeRequestDetailRequest> };
export type GetIssueDetailsToolRequest = ToolRequestCommon & { readonly tool: 'getIssueDetails'; readonly memberId: string; readonly request: Unpinned<IssueDetailRequest> };
export type SubmitCandidateFindingToolRequest = ToolRequestCommon & { readonly tool: 'submitCandidateFinding'; readonly memberId: string; readonly candidate: unknown };
/** No required member: D11 completion is a whole-attempt gate, not scoped to one changeset member. */
export type RequestCompletionToolRequest = ToolRequestCommon & { readonly tool: 'requestCompletion'; readonly memberId?: string };

export type HostToolRequest =
  | ListChangedFilesToolRequest
  | ReadDiffToolRequest
  | ReadFileToolRequest
  | SearchRepositoryToolRequest
  | SearchDiffToolRequest
  | ResolvePolicyToolRequest
  | GetChangeRequestDetailsToolRequest
  | GetIssueDetailsToolRequest
  | SubmitCandidateFindingToolRequest
  | RequestCompletionToolRequest;

// ---- Result envelopes (task 9.3) -----------------------------------------------

export interface ResolvePolicyLevelEcho {
  readonly directory: string;
  readonly state: AgentsPolicyLevel['state'];
  /** Present only for `state: 'present'`, and only the ledger's own identifiers — never the resolver's internal `agents-policy:...` id (D8: only a ledger-minted id is ever citable/lookupable). */
  readonly sourceId?: string;
  readonly digest?: string;
  readonly reason?: string;
}

export type HostToolContent =
  | { readonly tool: 'listChangedFiles'; readonly entries: readonly ChangedFileEntry[] }
  | { readonly tool: 'readDiff'; readonly patch: string }
  | { readonly tool: 'readFile'; readonly text: string }
  | { readonly tool: 'searchRepository'; readonly matchesJson: string }
  | { readonly tool: 'searchDiff'; readonly matchesJson: string }
  | { readonly tool: 'resolvePolicy'; readonly levels: readonly ResolvePolicyLevelEcho[] }
  | { readonly tool: 'getChangeRequestDetails'; readonly detailJson: string }
  | { readonly tool: 'getIssueDetails'; readonly detailJson: string }
  | { readonly tool: 'submitCandidateFinding'; readonly candidateId: string; readonly outcome: { readonly state: CandidateValidationOutcome['state']; readonly reasons: readonly string[] } }
  | { readonly tool: 'requestCompletion'; readonly response: CompletionRequestResponse };

/** The ten 9.2 validation refusals, plus `registrationRefused` for a post-fetch ledger registration refusal (D8's "explicit refusal, never a silent empty success"). */
export type ToolRefusalCode =
  | 'unknownTool'
  | 'phaseNotAllowed'
  | 'unknownMember'
  | 'invalidPath'
  | 'revisionMismatch'
  | 'forgedCursor'
  | 'outOfBounds'
  | 'capabilityUnavailable'
  | 'budgetRefused'
  /**
   * The per-turn prompt budget declined to serve this request *this turn*
   * (`HarnessPolicy.maxPromptBytesPerTurn`; `harnessAttempt.ts`'s `serveWithinPromptBudget`).
   *
   * Deliberately not `budgetRefused`, which this dispatcher mints when an attempt-level pool is
   * exhausted and means "there is none of this left". This one means the opposite: nothing was
   * spent, the request is intact, and asking again next turn is the correct response. A model
   * cannot act on the difference unless the code says it.
   *
   * Never produced by `dispatch` — the request it names was never dispatched, which is the whole
   * point of it. It appears only on results the attempt synthesizes for requests it declined
   * before any provider call.
   */
  | 'promptBudgetDeferred'
  | 'cancelled'
  | 'registrationRefused';

interface HostToolResultBase {
  readonly toolContractVersion: string;
  readonly requestId: string;
  readonly tool: HostToolName;
  readonly memberId?: string;
  /**
   * Diagnostics-only timing/retry metadata `dispatch` attaches to every result just before
   * returning it (never rendered to the model — `harnessModelSeam.ts`'s `renderToolResult` picks
   * fields explicitly and never reads these). `durationMs` is the whole `dispatch` call, validation
   * through the provider call/retries to the final `budget.reconcile` — the wall time a caller
   * actually waited for this tool call. `bytes` is the same byte count already computed for budget
   * accounting (`reserveEvidenceBytes`/the handler's own `evidenceBytes`, or a binary/oversized
   * result's own reported `byteSize` when no evidence was registered) — never a second count.
   * `retryWaitMs`/`retryCount` are this one call's own transient-retry backoff time and attempt
   * count, surfaced from `../app/harnessRetry.ts`'s own already-computed delays via `onRetryWait`.
   */
  readonly durationMs?: number;
  readonly bytes?: number;
  readonly retryWaitMs?: number;
  readonly retryCount?: number;
}

interface HostToolResultContentBase extends HostToolResultBase {
  /** Real count of whatever the content array/object actually holds — never estimated. */
  readonly unitsReturned: number;
  /** Present only for the single-source evidence-bearing tools (not `listChangedFiles`, `resolvePolicy`, or the two host actions); always echoed from the returned `LedgerEvidenceSource`, never recomputed. */
  readonly sourceId?: string;
  readonly digest?: string;
  readonly content: HostToolContent;
}

/**
 * Mirrors `InvestigationResult`'s discipline (task 3.4): states that carry no
 * content have no `content` field to populate, so an unavailable/binary/
 * truncated-away range can never be mistaken for an empty successful payload.
 */
export type HostToolResult =
  | (HostToolResultContentBase & { readonly state: 'complete' })
  | (HostToolResultContentBase & { readonly state: 'paginated'; readonly cursor: InvestigationCursor })
  | (HostToolResultContentBase & { readonly state: 'truncated'; readonly unitsKnownRemaining?: number })
  | (HostToolResultBase & {
      readonly state: 'unavailable';
      readonly reason: string;
      /**
       * Set only when this dispatch stopped to wait out a long retry delay (9.6),
       * not because the provider cannot supply the content. The distinction is
       * load-bearing: `harnessInventory`'s terminal states are immutable, so a
       * caller that marked a deferred read terminally `unavailable` would make the
       * file permanently uninspectable and the run permanently unable to reach
       * complete, even after the very next retry of the same read succeeds.
       */
      readonly deferred?: true;
    })
  | (HostToolResultBase & { readonly state: 'binary'; readonly byteSize?: number })
  /** `reason` is present only when the host itself judged the content too large to carry — a provider's own `tooLarge` carries the size and nothing else, because the provider gave no reason to pass on. */
  | (HostToolResultBase & { readonly state: 'tooLarge'; readonly byteSize?: number; readonly reason?: string })
  | (HostToolResultBase & { readonly state: 'notFound'; readonly reason: string })
  /**
   * The source enumerated this content and would not serve it — non-terminal,
   * and distinct from every neighbour in this union (task 3.5). `unavailable`
   * would be closed terminally by `updateInventoryFromResult`; `binary` and
   * `tooLarge` claim a determination the source never made; `unknown` throws
   * away the one thing that IS known. It has to be its own state or the
   * inventory cannot tell "nobody served this" from "nobody can read this".
   */
  | (HostToolResultBase & { readonly state: 'contentDeclined'; readonly reason: string })
  | (HostToolResultBase & { readonly state: 'unknown'; readonly reason: string })
  | (HostToolResultBase & { readonly state: 'refused'; readonly code: ToolRefusalCode; readonly reason: string; readonly registrationCode?: RegistrationRefusal });

// ---- Dispatcher options (tasks 9.4/9.5-seam) -----------------------------------

export type ProviderCallExecutor = <T>(fn: () => Promise<T>) => Promise<T>;

export interface ToolDispatchEvent {
  readonly tool: HostToolName;
  readonly memberId?: string;
  readonly requestId: string;
  readonly result: HostToolResult;
}

/** A cursor minted outside this dispatcher — bootstrap's own initial `getChangeRequestDetails`/`getIssueDetails` fetch, before this dispatcher existed (task 9.6 handover note 1). Pre-registers it so a later reopen call in `investigating`/`verifying` is not refused as `forgedCursor`. */
export type PreIssuedCursor =
  | { readonly tool: 'getChangeRequestDetails'; readonly memberId: string; readonly section?: DetailSection; readonly cursor: InvestigationCursor }
  | { readonly tool: 'getIssueDetails'; readonly memberId: string; readonly issueRepoId: string; readonly issueNumber: string; readonly section?: DetailSection; readonly cursor: InvestigationCursor };

/** Enriches `../app/harnessRetry.ts`'s bare `{attempt, delayMs}` hook payloads with which tool call they belong to. */
export interface DispatcherRetryWaitInfo {
  readonly tool: HostToolName;
  readonly requestId: string;
  readonly memberId?: string;
  readonly attempt: number;
  readonly delayMs: number;
}

export interface DispatcherRetryResumingInfo {
  readonly tool: HostToolName;
  readonly requestId: string;
  readonly memberId?: string;
}

/**
 * 9.5/9.6 retry configuration and hooks, injected as one bag matching
 * `BudgetTrackerOptions`' determinism pattern. See `../app/harnessRetry.ts`'s
 * file header for what `onCheckpointDue`/`onEnterWaiting`/`onResuming` do and
 * do not do at this policy level.
 */
export interface HostToolRetryOptions {
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly longDelayThresholdMs?: number;
  readonly onCheckpointDue?: (info: DispatcherRetryWaitInfo) => void;
  readonly onEnterWaiting?: (info: DispatcherRetryWaitInfo) => void;
  readonly onResuming?: (info: DispatcherRetryResumingInfo) => void;
}

/** 9.7: activity hooks for the attempt-wide cancellation sequence — see `wireCancellationLifecycle` in `./harnessRetry`. */
export interface HostToolCancellationHooks {
  readonly onCancelling?: () => void;
  readonly onCancelled?: () => void;
  readonly onReleaseRetainedState?: () => void;
}

export interface HostToolDispatcherOptions {
  readonly members: readonly DispatcherMember[];
  readonly ledger: EvidenceLedger;
  readonly budget: BudgetTracker;
  readonly candidateTracker: CandidateTracker;
  /** Same shape `CandidateValidationContext` needs beyond `ledger`/`now` — supplied once, reused for every `submitCandidateFinding` call. */
  readonly criteria: CandidateValidationContext['criteria'];
  readonly changedPathsByMember?: CandidateValidationContext['changedPathsByMember'];
  /** `resolvePolicy`'s injected resolver (task 9.4); production wiring is `createAgentsPolicyResolver` from `./harnessAgentsPolicy`. */
  readonly agentsPolicyResolver: AgentsPolicyResolver;
  /** `requestCompletion`'s injected completion evaluator (task 9.4): the caller owns inventory/coverage/verification state and returns a fresh `CompletionEvaluation` for the current attempt. */
  readonly evaluateCompletion: (request: RequestCompletionToolRequest) => CompletionEvaluation;
  /** `listChangedFiles` is inventory, not citable evidence (task 9.4): its raw result is hand off here instead of the ledger. */
  readonly onManifestPage?: (memberId: string, result: ChangedFileManifestResult) => void;
  readonly policy?: HarnessPolicy;
  readonly cancellation?: AgentCancellationToken;
  readonly now?: () => string;
  /** Injected duration clock for `dispatch`'s own timing (never a bare `Date.now()` read inline, matching every other module's clock pattern). Defaults to `Date.now`. Distinct from `now` above (an ISO-timestamp clock for evidence/ledger identity) — this one only ever measures an interval, never a wall-clock reading a caller could observe. */
  readonly clock?: () => number;
  /** Seam for 9.5-9.7: wraps every provider call, underneath the 9.5 retry/backoff loop; defaults to calling it directly. */
  readonly executeProviderCall?: ProviderCallExecutor;
  /** Seam for 9.5-9.8: observes every completed dispatch (refusals included). */
  readonly onToolDispatched?: (event: ToolDispatchEvent) => void;
  /** 9.5/9.6: bounded transient retry, backoff, and the waiting/resuming hooks. */
  readonly retry?: HostToolRetryOptions;
  /** 9.7: when `cancellation` is also given, wires `wireCancellationLifecycle` once at construction so `budget.cancel()` fires for *every* budget consumer, not only dispatcher-mediated calls. */
  readonly cancellationLifecycle?: HostToolCancellationHooks;
  /** Task 9.6 handover note 1: cursors minted before this dispatcher existed (bootstrap's own initial detail fetch). */
  readonly preIssuedCursors?: readonly PreIssuedCursor[];
}

export interface DispatchControl {
  /**
   * Set by a caller re-issuing the same logical tool call after an earlier
   * long-delay `wait` (9.6) — fires `retry.onResuming` once before this
   * attempt.
   *
   * The resumed call MUST use a fresh `requestId`, never the original
   * request's. `BudgetTracker.reserve`/`reconcile` are idempotent by
   * `requestId` (D12): the first (waited) dispatch already reconciled that
   * id to `{toolCalls: 1, evidenceBytes: 0}`, so replaying it would grant
   * the identical zero-evidence reservation for free, the handler would
   * still register the real evidence into the ledger, and the second
   * `reconcile` call would return `alreadyReconciled` (silently ignored by
   * `dispatch`) instead of charging it — evidence would enter the ledger
   * uncounted against budget. A fresh `requestId` reserves and reconciles
   * cleanly; only the *tool call's own idempotence* (its D12
   * request-identifier replay, e.g. re-reading the same diff page) should
   * ever reuse an id, never the retry/resume envelope around it.
   */
  readonly resumedAfterWait?: boolean;
}

export interface HostToolDispatcher {
  dispatch(phase: RunPhase, request: HostToolRequest, control?: DispatchControl): Promise<HostToolResult>;
}

// ---- Small helpers --------------------------------------------------------------

const PINNED_REVISIONS: ReadonlySet<string> = new Set(['base', 'head']);

function isPinnedRevision(value: unknown): value is PinnedRevision {
  return typeof value === 'string' && PINNED_REVISIONS.has(value);
}

function sanitizedReason(raw: unknown, fallback = 'The request could not be completed.'): string {
  return sanitizeErrorReason(raw, fallback);
}

/** A dispatcher-owned bound: `HarnessPolicy` has no dedicated field for free-text search query length. */
const MAX_SEARCH_QUERY_LENGTH = 500;

/**
 * The revision pin for one member, built from the member's own record — the single place a
 * repository id and a base/head pair enter a provider request. Called by every pinned handler
 * immediately before its provider call, never cached and never taken from the caller: a
 * `DispatcherMember` is constructed once, before the attempt starts, from the immutable run
 * snapshot, so this answers the same three values for the whole attempt by construction rather
 * than by checking.
 *
 * **What this replaced, and why.** Every revision-pinned request used to carry a `snapshot` object
 * the *model* filled in, and this module compared it field by field against the member, refusing
 * any mismatch as `revisionMismatch`. It was refusing transcription errors, not wrong revisions.
 * Three incidents, all the same defect:
 *
 * 1. A live run hallucinated the tail of a `headSha` and resent the same wrong value on three
 *    separate turns. The refusal meant to correct it led with the request's own wrong pin, ran
 *    ~250 chars with two 40-char SHAs a side, and `sanitizeErrorReason`'s 240-char bound cut the
 *    corrective `headSha` off mid-SHA — so the one message that carried the right answer never
 *    reached the model intact. Fixed by leading with the correction.
 * 2. The next run set `repoId` to the MEMBER id (`osirison/code-verdict!66`) on 24 of its 176
 *    snapshots, both SHAs correct. The refusal printed only `<baseSha>..<headSha>` as the
 *    correction, with no `repoId` in it at all, so both halves rendered byte-identical and named
 *    no difference to act on: refusals grew 8 -> 16 -> 24 across the run, three whole turns
 *    thrown away. Fixed by building both halves from the one field list and naming every field.
 * 3. The run that removed the field: 87 of 319 tool results refused, 27%, every one
 *    `revisionMismatch` and every one a mis-copied head sha. Two distinct corruptions —
 *    `1d801edd2f2e858c9bd8b03dbde5a09c48eccdae` sent with two characters dropped at position 24,
 *    and the head sha's prefix spliced onto the BASE sha's tail. The second is not a typo; it is
 *    two identifiers merged into one.
 *
 * Both earlier fixes made the refusal message better and left the transcription in place. Asking
 * for the transcription was the defect. The host had to hold the authoritative values already —
 * that is what it compared the copy against — so it supplies them instead, and a request carries
 * no repository or commit id at all (`Unpinned`, `../platform/types`). The pin itself is not
 * weakened: every request is still answered against exactly this member's two commits, and
 * `harnessInventory.ts` still refuses a provider *result* pinned to a different snapshot, which is
 * a check on the source's answer rather than on a copy the model typed.
 */
function snapshotOf(member: DispatcherMember): InvestigationSnapshotRef {
  return { repoId: member.repositoryId, baseSha: member.baseSha, headSha: member.headSha };
}

/** The request fields that make a cursor scope-specific — never the cursor value itself. */
function cursorScopeFields(request: HostToolRequest): Record<string, unknown> {
  switch (request.tool) {
    case 'listChangedFiles':
      return {};
    case 'readDiff':
      return { path: request.request.path };
    case 'searchRepository':
      return { revision: request.request.revision, query: request.request.query, pathScope: request.request.pathScope };
    case 'searchDiff':
      return { query: request.request.query, pathScope: request.request.pathScope };
    case 'getChangeRequestDetails':
      return { section: request.request.section };
    case 'getIssueDetails':
      return { issueRepoId: request.request.issueRepoId, issueNumber: request.request.issueNumber, section: request.request.section };
    default:
      return {};
  }
}

function cursorFieldOf(request: HostToolRequest): InvestigationCursor | undefined {
  switch (request.tool) {
    case 'listChangedFiles':
    case 'readDiff':
    case 'searchRepository':
    case 'searchDiff':
    case 'getChangeRequestDetails':
    case 'getIssueDetails':
      return request.request.cursor;
    default:
      return undefined;
  }
}

function cursorScopeKey(request: HostToolRequest): string {
  return sha256Hex(canonicalStringify({ tool: request.tool, memberId: request.memberId, ...cursorScopeFields(request) }));
}

/** Host state with no prior module (see file header): remembers exactly which cursor values this dispatcher has issued, and to what exact scope. */
function createCursorRegistry() {
  const issued = new Map<string, { readonly scopeKey: string }>();
  return {
    issue(scopeKey: string, cursor: InvestigationCursor): void {
      issued.set(cursor, { scopeKey });
    },
    accepts(scopeKey: string, cursor: InvestigationCursor): boolean {
      return issued.get(cursor)?.scopeKey === scopeKey;
    },
  };
}

function pinnedRevisionOf(request: HostToolRequest): PinnedRevision | undefined {
  if (request.tool === 'readFile' || request.tool === 'searchRepository') return request.request.revision;
  return undefined;
}

/** Every path-bearing field this request carries, for the `invalidPath` check; optional path-scope fields are skipped when absent. */
function pathFieldsOf(request: HostToolRequest): readonly string[] {
  switch (request.tool) {
    case 'readDiff':
      return [request.request.path];
    case 'readFile':
      return [request.request.path];
    case 'searchRepository':
      return request.request.pathScope !== undefined ? [request.request.pathScope] : [];
    case 'searchDiff':
      return request.request.pathScope !== undefined ? [request.request.pathScope] : [];
    case 'resolvePolicy':
      return [request.changedPath];
    default:
      return [];
  }
}

/**
 * Provider-declared page bound (its own per-operation override, falling back to the shared default)
 * vs the policy field that must not be exceeded. `undefined` when nothing is declared —
 * `capabilityUnavailable` catches that gap next, not this check.
 *
 * Exported so a provider's *declaration* can be checked against the real default policy without a
 * dispatch (`../providers/providerPageBounds.test.ts`). A declaration that fails this predicate makes
 * every call to that tool an `outOfBounds` refusal for the whole life of the product, which is
 * exactly how diff search shipped dead on both providers: they declared no per-operation bound, so
 * the fallback (`pagination.maxPageSize`, a manifest *file* count of 100) was compared against
 * `searchResultPageMatches` (a *match* count of 50) — two different units, and 100 > 50 refuses
 * forever. Nothing caught it because the harness fixtures declared correct bounds of their own.
 */
export function pageBoundWithinPolicy(
  capabilities: MemberCapabilities,
  capabilityKey: keyof ReviewInvestigationCapabilities,
  policy: HarnessPolicy,
  field: ToolPageSizePolicyField,
): boolean {
  const investigation = capabilities.reviewInvestigation;
  if (!investigation) return true;
  const operation = investigation[capabilityKey] as InvestigationOperationCapability | undefined;
  const maxPageSize = operation?.pageBound?.maxPageSize ?? investigation.pagination?.maxPageSize;
  if (maxPageSize === undefined) return true;
  return maxPageSize <= policy[field];
}

/**
 * Whether a capability *declaration* alone (no live `Connection` involved) permits `definition` —
 * the same test `capabilityUnavailable` below uses to refuse a dispatch, exported so a caller that
 * has capabilities but no live member (`harnessAttempt.ts`'s bootstrap tool-catalog filter, task
 * "keep the review on the merge request") can ask the identical question when deciding what to
 * *advertise* to the model, rather than inventing a second capability check that could drift from
 * this one. `harnessRuntime.ts`'s `effectiveCapabilities` is what actually turns a reviewer's
 * "scope this review to its changed files" setting into `fileReads`/`repositorySearch` reporting
 * `supported: false` here — this function itself knows nothing about that setting, only about
 * capability declarations, exactly like every other capability check in this file.
 */
export function toolCapabilityAvailable(definition: HostToolDefinition, capabilities: MemberCapabilities): boolean {
  const investigation = capabilities.reviewInvestigation;
  if (definition.capability !== undefined) {
    const operation = investigation?.[definition.capability] as InvestigationOperationCapability | undefined;
    if (!operation || operation.supported === false) return false;
  }
  // `resolvePolicy` declares no `capability` of its own (design.md D7): it rides on `fileReads`,
  // since it resolves through repeated `Connection.readFile` calls, not a dedicated operation.
  if (definition.name === 'resolvePolicy') {
    const fileReads = investigation?.fileReads;
    if (!fileReads || fileReads.supported === false) return false;
  }
  return true;
}

function capabilityUnavailable(definition: HostToolDefinition, member: DispatcherMember): boolean {
  if (definition.connectionMethod !== undefined) {
    const target = dispatchTargetFor(definition, member) as Record<string, unknown>;
    if (target[definition.connectionMethod] === undefined) return true;
  }
  return !toolCapabilityAvailable(definition, member.capabilities);
}

function reserveEvidenceBytes(definition: HostToolDefinition, policy: HarnessPolicy): number | undefined {
  if (definition.kind === 'hostAction' || definition.name === 'listChangedFiles') return undefined;
  return policy.maxToolResultBytes;
}

/**
 * Thrown by the retry-wrapped `execute` (9.6) when the delay before the next
 * attempt classified as long: the caller (`dispatch`'s catch) turns this
 * into a truthful `unavailable` result instead of the generic
 * `sanitizeErrorReason(error, ...)` path, since this is not a provider
 * failure — the underlying call may well have succeeded eventually, but
 * this dispatch is not going to hold the caller's resources to find out.
 */
class RetryWaitSignal extends Error {
  constructor(
    readonly delayMs: number,
    readonly attempts: number,
  ) {
    super('A long retry delay was classified for waiting; see harnessRetry.ts D12/9.6.');
    this.name = 'RetryWaitSignal';
  }
}

/** Thrown by the retry-wrapped `execute` when cancellation is observed before or during a backoff wait (9.7); `dispatch`'s own post-await cancellation check (unconditional, regardless of what `dispatchToHandler` threw or returned) is what actually produces the `cancelled` refusal. */
class RetryCancelledSignal extends Error {
  constructor() {
    super('Cancelled during retry backoff.');
    this.name = 'RetryCancelledSignal';
  }
}

// ---- Dispatcher factory ---------------------------------------------------------

export function createHostToolDispatcher(options: HostToolDispatcherOptions): HostToolDispatcher {
  const policy = options.policy ?? DEFAULT_HARNESS_POLICY;
  const membersById = new Map(options.members.map((member) => [member.memberId, member] as const));
  const cursorRegistry = createCursorRegistry();
  const resolvedPolicyLevels = new Map<string, LedgerEvidenceSource>();
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock ?? Date.now;
  const rawExecute: ProviderCallExecutor = options.executeProviderCall ?? (<T>(fn: () => Promise<T>) => fn());
  const retryOptions = options.retry ?? {};
  const retryBackoffPolicy = retryBackoffPolicyFrom(policy);

  // Task 9.6 handover note 1: pre-register cursors minted before this dispatcher existed.
  for (const entry of options.preIssuedCursors ?? []) {
    const syntheticRequest =
      entry.tool === 'getChangeRequestDetails'
        ? ({ tool: entry.tool, memberId: entry.memberId, request: { section: entry.section } } as unknown as HostToolRequest)
        : ({ tool: entry.tool, memberId: entry.memberId, request: { issueRepoId: entry.issueRepoId, issueNumber: entry.issueNumber, section: entry.section } } as unknown as HostToolRequest);
    cursorRegistry.issue(cursorScopeKey(syntheticRequest), entry.cursor);
  }

  // 9.7: wiring this once per attempt (not per dispatch call) is what makes "stop new
  // reservations synchronously" hold for every budget consumer, not only dispatcher-mediated
  // tool calls — see harnessRetry.ts's file header.
  if (options.cancellation) {
    wireCancellationLifecycle(options.cancellation, options.budget, options.cancellationLifecycle ?? {});
  }

  /**
   * 9.5/9.6: retries the provider call underneath `rawExecute`, using `definition.idempotent` —
   * never assumed — to gate retry eligibility. `retryStats` is a fresh accumulator `dispatch`
   * creates once per dispatch call (never shared across calls — this factory itself is reused for
   * the whole attempt): `onRetryWait` fires once per *inline* backoff wait `../app/harnessRetry.ts`
   * actually takes, with the delay it already computed (never recomputed here), so `dispatch` can
   * report this one call's own retry time without a second timer.
   */
  async function executeWithRetry<T>(request: HostToolRequest, idempotent: boolean, resumedFromWait: boolean, fn: () => Promise<T>, retryStats: { retryWaitMs: number; retryCount: number }): Promise<T> {
    const hooks: RetryHooks = {
      onCheckpointDue: (info) => retryOptions.onCheckpointDue?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId, ...info }),
      onEnterWaiting: (info) => retryOptions.onEnterWaiting?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId, ...info }),
      onResuming: () => retryOptions.onResuming?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId }),
      onRetryWait: (info) => {
        retryStats.retryWaitMs += info.delayMs;
        retryStats.retryCount += 1;
      },
    };
    const outcome = await runWithRetry(() => rawExecute(fn), {
      idempotent,
      policy: retryBackoffPolicy,
      elapsedMsAtStart: request.elapsedMs,
      cancellation: options.cancellation,
      now: retryOptions.now,
      random: retryOptions.random,
      sleep: retryOptions.sleep,
      longDelayThresholdMs: retryOptions.longDelayThresholdMs,
      hooks,
      resumedFromWait,
    });
    switch (outcome.kind) {
      case 'ok':
        return outcome.value;
      case 'wait':
        throw new RetryWaitSignal(outcome.delayMs, outcome.attempts);
      case 'cancelled':
        throw new RetryCancelledSignal();
      case 'nonRetryable':
      case 'exhausted':
      case 'elapsedBudgetExceeded':
      default:
        throw outcome.error;
    }
  }

  function emit(result: HostToolResult): HostToolResult {
    options.onToolDispatched?.({ tool: result.tool, memberId: result.memberId, requestId: result.requestId, result });
    return result;
  }

  function refused(request: HostToolRequest, code: ToolRefusalCode, reason: string, registrationCode?: RegistrationRefusal): HostToolResult {
    return emit({
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      tool: request.tool,
      memberId: request.memberId,
      state: 'refused',
      code,
      reason: sanitizedReason(reason),
      ...(registrationCode !== undefined ? { registrationCode } : {}),
    });
  }

  /**
   * A read this dispatch stopped short of, to wait out a long retry delay (9.6).
   * Distinct from a provider-reported `unavailable` so coverage never marks the
   * file terminally uninspectable — see `HostToolResult`'s `deferred` field.
   */
  function deferredForWait(request: HostToolRequest, reason: string): HostToolResult {
    return emit({
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      tool: request.tool,
      memberId: request.memberId,
      state: 'unavailable',
      reason: sanitizedReason(reason),
      deferred: true,
    });
  }

  function nonContent(request: HostToolRequest, state: 'unavailable' | 'binary' | 'tooLarge' | 'notFound' | 'contentDeclined' | 'unknown', reason?: string, byteSize?: number): HostToolResult {
    const base = { toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION, requestId: request.requestId, tool: request.tool, memberId: request.memberId };
    if (state === 'binary' || state === 'tooLarge') return emit({ ...base, state, byteSize });
    return emit({ ...base, state, reason: sanitizedReason(reason ?? `The provider returned "${state}".`) });
  }

  function contentResult(
    request: HostToolRequest,
    state: 'complete' | 'paginated' | 'truncated',
    content: HostToolContent,
    unitsReturned: number,
    extra: { sourceId?: string; digest?: string; cursor?: InvestigationCursor; unitsKnownRemaining?: number } = {},
  ): HostToolResult {
    const base: HostToolResultContentBase = {
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      tool: request.tool,
      memberId: request.memberId,
      unitsReturned,
      sourceId: extra.sourceId,
      digest: extra.digest,
      content,
    };
    if (state === 'paginated') return emit({ ...base, state, cursor: extra.cursor as InvestigationCursor });
    if (state === 'truncated') return emit({ ...base, state, unitsKnownRemaining: extra.unitsKnownRemaining });
    return emit({ ...base, state });
  }

  // ---- 9.2 validation ------------------------------------------------------------

  function validate(phase: RunPhase, request: HostToolRequest): { ok: true; definition: HostToolDefinition; member?: DispatcherMember } | { ok: false; result: HostToolResult } {
    const definition = hostToolDefinition(request.tool);
    if (!definition) return { ok: false, result: refused(request, 'unknownTool', `"${String(request.tool)}" is not an authorized host tool.`) };

    if (!definition.allowedPhases.includes(phase)) {
      return { ok: false, result: refused(request, 'phaseNotAllowed', `${definition.name} is not authorized during the ${phase} phase.`) };
    }

    let member: DispatcherMember | undefined;
    if (request.memberId !== undefined) {
      member = membersById.get(request.memberId);
      if (!member) return { ok: false, result: refused(request, 'unknownMember', `Member ${request.memberId} is not part of this run.`) };
    } else if (request.tool !== 'requestCompletion') {
      return { ok: false, result: refused(request, 'unknownMember', `${definition.name} requires a member.`) };
    }

    for (const rawPath of pathFieldsOf(request)) {
      if (normalizeEvidencePath(rawPath) === undefined) {
        return { ok: false, result: refused(request, 'invalidPath', `"${rawPath}" is not a usable repository-relative path.`) };
      }
    }

    if (member) {
      // What `revisionMismatch` still means, now that no request names a revision to mismatch.
      //
      // This step used to compare a `snapshot` object the model filled in — repoId, baseSha,
      // headSha — against the member's own three values, and refuse any difference. That whole
      // comparison is gone: `snapshotOf` supplies the pin from the member, so a request cannot
      // disagree with it (the history, and the 87-of-319 run that ended it, are recorded there).
      //
      // The code stays, with exactly one live source: a `revision` on `readFile` or
      // `searchRepository` that is not `base` or `head`. That is a choice between two named
      // values, not a transcription, and it stays the model's to make. The model's own path
      // cannot reach here with a bad one — `harnessProtocol.ts` rejects anything but
      // base/head/old/new first, as a parse failure — so this fires for a caller that is not the
      // protocol parser. `HostToolRequest` is exported and the dispatcher is a public seam;
      // `harnessToolDispatcher.test.ts` exercises this arm with `revision: 'sideways' as never`,
      // which is precisely a host caller that got the type wrong at runtime. Typed callers cannot
      // trip it, which is the point: it is the one thing left that a wrong revision could be.
      const revision = pinnedRevisionOf(request);
      if (revision !== undefined && !isPinnedRevision(revision)) {
        return { ok: false, result: refused(request, 'revisionMismatch', `"${String(revision)}" is not a valid pinned revision.`) };
      }
    }

    const cursor = cursorFieldOf(request);
    if (cursor !== undefined && !cursorRegistry.accepts(cursorScopeKey(request), cursor)) {
      return { ok: false, result: refused(request, 'forgedCursor', 'This continuation was not issued by this attempt for this exact request.') };
    }

    if (request.tool === 'readFile') {
      const { startLine, endLine } = request.request;
      const inBounds = Number.isInteger(startLine) && Number.isInteger(endLine) && startLine >= 1 && endLine >= startLine && endLine - startLine + 1 <= policy.diffOrFileReadPageLines;
      if (!inBounds) return { ok: false, result: refused(request, 'outOfBounds', `Line range ${String(startLine)}-${String(endLine)} is not a positive span within ${policy.diffOrFileReadPageLines} lines.`) };
    }
    if (request.tool === 'searchRepository' || request.tool === 'searchDiff') {
      const query = request.request.query;
      if (typeof query !== 'string' || query.trim().length === 0 || query.length > MAX_SEARCH_QUERY_LENGTH) {
        return { ok: false, result: refused(request, 'outOfBounds', `Query must be 1-${MAX_SEARCH_QUERY_LENGTH} characters.`) };
      }
    }
    if (member && definition.pageSizePolicyField && definition.capability) {
      if (!pageBoundWithinPolicy(member.capabilities, definition.capability, policy, definition.pageSizePolicyField)) {
        return { ok: false, result: refused(request, 'outOfBounds', `The provider's declared page bound for ${definition.name} exceeds this attempt's ${definition.pageSizePolicyField} limit.`) };
      }
    }

    if (member && capabilityUnavailable(definition, member)) {
      return { ok: false, result: refused(request, 'capabilityUnavailable', `Member ${member.memberId}'s provider does not support ${definition.name}.`) };
    }

    return { ok: true, definition, member };
  }

  /** Known only for a registered-evidence result (the byte count already charged against budget) or a binary/oversized one (the provider's own reported size) — `undefined`, never a fabricated 0, for everything else (a manifest page, a refusal, a policy echo — none of which this dispatcher counts in bytes at all). */
  function resultByteHint(result: HostToolResult, evidenceBytes: number): number | undefined {
    if (evidenceBytes > 0) return evidenceBytes;
    if (result.state === 'binary' || result.state === 'tooLarge') return result.byteSize;
    return undefined;
  }

  async function dispatch(phase: RunPhase, request: HostToolRequest, control?: DispatchControl): Promise<HostToolResult> {
    // Times the whole call — validation through the provider round trip (retries included) to the
    // final budget reconcile — the one seam a provider call happens (see this file's own header),
    // timed once, here, with the attempt's own injected clock. `retryStats` is fresh per call
    // (never shared across dispatch calls) and only ever written by `executeWithRetry`'s
    // `onRetryWait` hook, threaded down through `dispatchToHandler`.
    const startedAt = clock();
    const retryStats = { retryWaitMs: 0, retryCount: 0 };
    const attach = (result: HostToolResult, bytes?: number): HostToolResult => ({
      ...result,
      durationMs: clock() - startedAt,
      ...(bytes !== undefined ? { bytes } : {}),
      ...(retryStats.retryCount > 0 ? { retryWaitMs: retryStats.retryWaitMs, retryCount: retryStats.retryCount } : {}),
    });

    const validation = validate(phase, request);
    if (!validation.ok) return attach(validation.result);
    const { definition, member } = validation;

    const reserveOutcome = options.budget.reserve({
      requestId: request.requestId,
      purpose: request.purpose ?? 'exploration',
      memberId: request.memberId,
      elapsedMs: request.elapsedMs,
      toolCalls: 1,
      evidenceBytes: reserveEvidenceBytes(definition, policy),
      hostInitiated: request.hostInitiated ?? false,
    });
    if (!reserveOutcome.ok) {
      return attach(refused(request, reserveOutcome.code === 'cancelled' ? 'cancelled' : 'budgetRefused', reserveOutcome.message));
    }

    if (options.cancellation?.isCancellationRequested) {
      options.budget.reconcile(request.requestId, { modelTurns: 0, toolCalls: 0, evidenceBytes: 0 });
      return attach(refused(request, 'cancelled', 'The attempt was cancelled before this request was dispatched.'));
    }

    let outcome: { result: HostToolResult; evidenceBytes: number };
    try {
      outcome = await dispatchToHandler(member, request, definition, control?.resumedAfterWait === true, retryStats);
    } catch (error) {
      if (error instanceof RetryWaitSignal) {
        outcome = {
          result: deferredForWait(request, `This request needs a longer retry wait (about ${Math.max(1, Math.round(error.delayMs / 1000))}s) and will resume later.`),
          evidenceBytes: 0,
        };
      } else {
        outcome = { result: nonContent(request, 'unavailable', sanitizedReason(error, 'The provider request failed.')), evidenceBytes: 0 };
      }
    }

    if (options.cancellation?.isCancellationRequested) {
      options.budget.reconcile(request.requestId, { modelTurns: 0, toolCalls: 0, evidenceBytes: 0 });
      return attach(refused(request, 'cancelled', 'The attempt was cancelled while this request was in flight.'));
    }

    options.budget.reconcile(request.requestId, { toolCalls: 1, evidenceBytes: outcome.evidenceBytes });
    return attach(outcome.result, resultByteHint(outcome.result, outcome.evidenceBytes));
  }

  // ---- 9.4 handlers ---------------------------------------------------------------

  async function dispatchToHandler(
    member: DispatcherMember | undefined,
    request: HostToolRequest,
    definition: HostToolDefinition,
    resumedFromWait: boolean,
    retryStats: { retryWaitMs: number; retryCount: number },
  ): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    // Bound once per dispatch call so every provider-touching handler retries under the same
    // 9.5/9.6 policy without each handler re-deriving idempotence — `definition.idempotent` is
    // always true here (the two `hostAction` tools below never call `boundExecute` at all), but
    // it is still threaded explicitly rather than assumed (see harnessRetry.ts's file header).
    const boundExecute: ProviderCallExecutor = <T>(fn: () => Promise<T>) => executeWithRetry(request, definition.idempotent, resumedFromWait, fn, retryStats);
    switch (request.tool) {
      case 'listChangedFiles':
        return handleListChangedFiles(member as DispatcherMember, request, boundExecute);
      case 'readDiff':
        return handleReadDiff(member as DispatcherMember, request, boundExecute);
      case 'readFile':
        return handleReadFile(member as DispatcherMember, request, boundExecute);
      case 'searchRepository':
        return handleSearchRepository(member as DispatcherMember, request, boundExecute);
      case 'searchDiff':
        return handleSearchDiff(member as DispatcherMember, request, boundExecute);
      case 'resolvePolicy':
        return handleResolvePolicy(member as DispatcherMember, request, boundExecute);
      case 'getChangeRequestDetails':
        return handleGetChangeRequestDetails(member as DispatcherMember, request, boundExecute);
      case 'getIssueDetails':
        return handleGetIssueDetails(member as DispatcherMember, request, boundExecute);
      case 'submitCandidateFinding':
        return handleSubmitCandidateFinding(request);
      case 'requestCompletion':
        return handleRequestCompletion(request);
      default: {
        const exhaustive: never = request;
        return { result: nonContent(exhaustive as HostToolRequest, 'unknown'), evidenceBytes: 0 };
      }
    }
  }

  function registrationRefusal(request: HostToolRequest, outcome: { ok: false; code: RegistrationRefusal; message: string }): { result: HostToolResult; evidenceBytes: number } {
    return { result: refused(request, 'registrationRefused', outcome.message, outcome.code), evidenceBytes: 0 };
  }

  /**
   * The provider call already resolved by the time this is checked, but the
   * ledger has not been touched yet: a cancellation that lands in that
   * window must still stop registration, not just the eventual return value
   * (`dispatch`'s own post-await check discards the content either way, but
   * only this guard keeps a late result out of the ledger and its evidence
   * budget). Every provider-backed handler calls this immediately before its
   * `ledger.register*` call, never after.
   */
  function cancelledBeforeRegistration(request: HostToolRequest): { result: HostToolResult; evidenceBytes: number } | undefined {
    if (options.cancellation?.isCancellationRequested !== true) return undefined;
    return { result: nonContent(request, 'unavailable', 'The attempt was cancelled while this request was in flight.'), evidenceBytes: 0 };
  }

  async function handleListChangedFiles(member: DispatcherMember, request: ListChangedFilesToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const source = investigationSourceFor(member);
    const method = source.listChangedFiles;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot list changed files.'), evidenceBytes: 0 };
    const normalized: ChangedFileManifestRequest = { ...request.request, snapshot: snapshotOf(member) };
    const result = await execute(() => method.call(source, normalized));
    // Not ledger-registered evidence, but still host-controlled work: a late manifest page must not
    // feed inventory/coverage after cancellation, matching every other handler's post-await guard.
    const cancelled = cancelledBeforeRegistration(request);
    if (cancelled) return cancelled;
    options.onManifestPage?.(member.memberId, result);
    switch (result.state) {
      case 'complete':
        return { result: contentResult(request, 'complete', { tool: 'listChangedFiles', entries: result.value }, result.value.length), evidenceBytes: 0 };
      case 'paginated':
        cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return { result: contentResult(request, 'paginated', { tool: 'listChangedFiles', entries: result.value }, result.value.length, { cursor: result.cursor }), evidenceBytes: 0 };
      case 'truncated':
        return { result: contentResult(request, 'truncated', { tool: 'listChangedFiles', entries: result.value }, result.value.length, { unitsKnownRemaining: result.knownRemainingUnits }), evidenceBytes: 0 };
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      // Explicit, and it has to be: the `default` arm below narrows to
      // `unknown` but typechecks for any state carrying an optional `reason`,
      // so a missing case here would compile and silently relabel a declined
      // read as an unknown one — which coverage reads as "nothing to do".
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleReadDiff(member: DispatcherMember, request: ReadDiffToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const source = investigationSourceFor(member);
    const method = source.readDiff;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot read diffs.'), evidenceBytes: 0 };
    const path = normalizeEvidencePath(request.request.path) as string;
    const result = await execute(() => method.call(source, { ...request.request, path, snapshot: snapshotOf(member) }));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerDiffPage(member.memberId, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'readDiff', patch: source.exactContent }, 1, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleReadFile(member: DispatcherMember, request: ReadFileToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const source = investigationSourceFor(member);
    const method = source.readFile;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot read files.'), evidenceBytes: 0 };
    const path = normalizeEvidencePath(request.request.path) as string;
    const result = await execute(() => method.call(source, { ...request.request, path, snapshot: snapshotOf(member) }));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerFileRange(member.memberId, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'readFile', text: source.exactContent }, 1, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleSearchRepository(member: DispatcherMember, request: SearchRepositoryToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const source = investigationSourceFor(member);
    const method = source.searchRepository;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot search the repository.'), evidenceBytes: 0 };
    const pathScope = request.request.pathScope !== undefined ? normalizeEvidencePath(request.request.pathScope) : undefined;
    const normalizedRequest: RepositorySearchRequest = { ...request.request, pathScope, snapshot: snapshotOf(member) };
    const result = await execute(() => method.call(source, normalizedRequest));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerRepositorySearch(member.memberId, normalizedRequest, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'searchRepository', matchesJson: source.exactContent }, result.value.length, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleSearchDiff(member: DispatcherMember, request: SearchDiffToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const source = investigationSourceFor(member);
    const method = source.searchDiff;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot search diffs.'), evidenceBytes: 0 };
    const pathScope = request.request.pathScope !== undefined ? normalizeEvidencePath(request.request.pathScope) : undefined;
    const normalizedRequest: DiffSearchRequest = { ...request.request, pathScope, snapshot: snapshotOf(member) };
    const result = await execute(() => method.call(source, normalizedRequest));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerDiffSearch(member.memberId, normalizedRequest, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'searchDiff', matchesJson: source.exactContent }, result.value.length, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleResolvePolicy(member: DispatcherMember, request: ResolvePolicyToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const changedPath = normalizeEvidencePath(request.changedPath) as string;
    let chain: AgentsPolicyChain;
    try {
      chain = await execute(() =>
        options.agentsPolicyResolver.resolveChain({ memberId: member.memberId, repoId: member.repositoryId, baseSha: member.baseSha, headSha: member.headSha }, changedPath),
      );
    } catch (error) {
      return { result: nonContent(request, 'unavailable', sanitizedReason(error, 'AGENTS.md policy resolution failed.')), evidenceBytes: 0 };
    }
    const cancelled = cancelledBeforeRegistration(request);
    if (cancelled) return cancelled;
    const levels: ResolvePolicyLevelEcho[] = [];
    let freshBytes = 0;
    for (const level of chain.levels) {
      if (level.state !== 'present') {
        levels.push(level.state === 'absent' ? { directory: level.directory, state: 'absent' } : { directory: level.directory, state: 'unavailable', reason: sanitizedReason(level.reason) });
        continue;
      }
      const cacheKey = `${member.memberId}\u0000${level.directory}\u0000${level.digest}`;
      let source = resolvedPolicyLevels.get(cacheKey);
      if (!source) {
        const registration = options.ledger.registerAgentsPolicy(member.memberId, level);
        if (!registration.ok) return registrationRefusal(request, registration);
        source = registration.source;
        resolvedPolicyLevels.set(cacheKey, source);
        freshBytes += source.byteLength;
      }
      levels.push({ directory: level.directory, state: 'present', sourceId: source.sourceId, digest: source.digest });
    }
    return { result: contentResult(request, 'complete', { tool: 'resolvePolicy', levels }, levels.length), evidenceBytes: freshBytes };
  }

  async function handleGetChangeRequestDetails(member: DispatcherMember, request: GetChangeRequestDetailsToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.getChangeRequestDetails;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot fetch change request details.'), evidenceBytes: 0 };
    const result = await execute(() => method.call(member.connection, { ...request.request, snapshot: snapshotOf(member) }));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerChangeRequestDetail(member.memberId, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'getChangeRequestDetails', detailJson: source.exactContent }, 1, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleGetIssueDetails(member: DispatcherMember, request: GetIssueDetailsToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.getIssueDetails;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot fetch issue details.'), evidenceBytes: 0 };
    const result = await execute(() => method.call(member.connection, { ...request.request, snapshot: snapshotOf(member) }));
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const cancelled = cancelledBeforeRegistration(request);
        if (cancelled) return cancelled;
        const registration = options.ledger.registerIssueDetail(member.memberId, result);
        if (!registration.ok) return registrationRefusal(request, registration);
        const source = registration.source;
        if (result.state === 'paginated') cursorRegistry.issue(cursorScopeKey(request), result.cursor);
        return {
          result: contentResult(request, result.state, { tool: 'getIssueDetails', detailJson: source.exactContent }, 1, {
            sourceId: source.sourceId,
            digest: source.digest,
            cursor: result.state === 'paginated' ? result.cursor : undefined,
            unitsKnownRemaining: result.state === 'truncated' ? result.knownRemainingUnits : undefined,
          }),
          evidenceBytes: source.byteLength,
        };
      }
      case 'unavailable':
        return { result: nonContent(request, 'unavailable', result.reason), evidenceBytes: 0 };
      case 'notFound':
        return { result: nonContent(request, 'notFound', result.reason), evidenceBytes: 0 };
      case 'binary':
        return { result: nonContent(request, 'binary', undefined, result.byteSize), evidenceBytes: 0 };
      case 'tooLarge':
        return { result: nonContent(request, 'tooLarge', undefined, result.byteSize), evidenceBytes: 0 };
      case 'contentDeclined':
        return { result: nonContent(request, 'contentDeclined', result.reason), evidenceBytes: 0 };
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  // Host actions (task 9.4): never touch `Connection`.

  function handleSubmitCandidateFinding(request: SubmitCandidateFindingToolRequest): { result: HostToolResult; evidenceBytes: number } {
    const context: CandidateValidationContext = { ledger: options.ledger, criteria: options.criteria, changedPathsByMember: options.changedPathsByMember, now: now() };
    const outcome = validateCandidate(request.candidate, context);
    options.candidateTracker.record(outcome);
    const content: HostToolContent = { tool: 'submitCandidateFinding', candidateId: outcome.candidateId, outcome: { state: outcome.state, reasons: outcome.reasons.map((reason) => `${reason.code}: ${reason.message}`) } };
    return { result: contentResult(request, 'complete', content, 1), evidenceBytes: 0 };
  }

  function handleRequestCompletion(request: RequestCompletionToolRequest): { result: HostToolResult; evidenceBytes: number } {
    const evaluation = options.evaluateCompletion(request);
    const canContinue = options.budget.canContinue('verification', request.elapsedMs, request.memberId);
    const response = respondToCompletionRequest(evaluation, { canContinue });
    return { result: contentResult(request, 'complete', { tool: 'requestCompletion', response }, 1), evidenceBytes: 0 };
  }

  return { dispatch };
}
