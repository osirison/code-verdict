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
import type { Connection, InvestigationOperationCapability, ProviderCapabilities, ReviewInvestigationCapabilities } from '../platform/provider';
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
  IssueDetailRequest,
  PinnedRevision,
  RepositorySearchRequest,
} from '../platform/types';

// ---- Members ----------------------------------------------------------------

/** An `EvidenceLedgerMember` plus what the dispatcher additionally needs to reach that member's provider (D15: a changeset can span providers/instances). */
export interface DispatcherMember extends EvidenceLedgerMember {
  readonly connection: Connection;
  readonly capabilities: ProviderCapabilities;
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

export type ListChangedFilesToolRequest = ToolRequestCommon & { readonly tool: 'listChangedFiles'; readonly memberId: string; readonly request: ChangedFileManifestRequest };
export type ReadDiffToolRequest = ToolRequestCommon & { readonly tool: 'readDiff'; readonly memberId: string; readonly request: DiffPageRequest };
export type ReadFileToolRequest = ToolRequestCommon & { readonly tool: 'readFile'; readonly memberId: string; readonly request: FileRangeRequest };
export type SearchRepositoryToolRequest = ToolRequestCommon & { readonly tool: 'searchRepository'; readonly memberId: string; readonly request: RepositorySearchRequest };
export type SearchDiffToolRequest = ToolRequestCommon & { readonly tool: 'searchDiff'; readonly memberId: string; readonly request: DiffSearchRequest };
export type ResolvePolicyToolRequest = ToolRequestCommon & { readonly tool: 'resolvePolicy'; readonly memberId: string; readonly changedPath: string };
export type GetChangeRequestDetailsToolRequest = ToolRequestCommon & { readonly tool: 'getChangeRequestDetails'; readonly memberId: string; readonly request: ChangeRequestDetailRequest };
export type GetIssueDetailsToolRequest = ToolRequestCommon & { readonly tool: 'getIssueDetails'; readonly memberId: string; readonly request: IssueDetailRequest };
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
  | 'cancelled'
  | 'registrationRefused';

interface HostToolResultBase {
  readonly toolContractVersion: string;
  readonly requestId: string;
  readonly tool: HostToolName;
  readonly memberId?: string;
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
  | (HostToolResultBase & { readonly state: 'unavailable'; readonly reason: string })
  | (HostToolResultBase & { readonly state: 'binary'; readonly byteSize?: number })
  | (HostToolResultBase & { readonly state: 'tooLarge'; readonly byteSize?: number })
  | (HostToolResultBase & { readonly state: 'notFound'; readonly reason: string })
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

function snapshotsEqual(a: InvestigationSnapshotRef, b: { repositoryId: string; baseSha: string; headSha: string }): boolean {
  return a.repoId === b.repositoryId && a.baseSha === b.baseSha && a.headSha === b.headSha;
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

function snapshotFieldOf(request: HostToolRequest): InvestigationSnapshotRef | undefined {
  switch (request.tool) {
    case 'listChangedFiles':
    case 'readDiff':
    case 'readFile':
    case 'searchRepository':
    case 'searchDiff':
    case 'getChangeRequestDetails':
    case 'getIssueDetails':
      return request.request.snapshot;
    default:
      return undefined;
  }
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

/** Provider-declared page bound (its own per-operation override, falling back to the shared default) vs the policy field that must not be exceeded. `undefined` when nothing is declared — `capabilityUnavailable` catches that gap next, not this check. */
function pageBoundWithinPolicy(
  capabilities: ProviderCapabilities,
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

function capabilityUnavailable(definition: HostToolDefinition, member: DispatcherMember): boolean {
  if (definition.connectionMethod !== undefined && member.connection[definition.connectionMethod] === undefined) return true;
  const investigation = member.capabilities.reviewInvestigation;
  if (definition.capability !== undefined) {
    const operation = investigation?.[definition.capability] as InvestigationOperationCapability | undefined;
    if (!operation || operation.supported === false) return true;
  }
  // `resolvePolicy` declares no `capability` of its own (design.md D7): it rides on `fileReads`,
  // since it resolves through repeated `Connection.readFile` calls, not a dedicated operation.
  if (definition.name === 'resolvePolicy') {
    const fileReads = investigation?.fileReads;
    if (!fileReads || fileReads.supported === false) return true;
  }
  return false;
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

  /** 9.5/9.6: retries the provider call underneath `rawExecute`, using `definition.idempotent` — never assumed — to gate retry eligibility. */
  async function executeWithRetry<T>(request: HostToolRequest, idempotent: boolean, resumedFromWait: boolean, fn: () => Promise<T>): Promise<T> {
    const hooks: RetryHooks = {
      onCheckpointDue: (info) => retryOptions.onCheckpointDue?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId, ...info }),
      onEnterWaiting: (info) => retryOptions.onEnterWaiting?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId, ...info }),
      onResuming: () => retryOptions.onResuming?.({ tool: request.tool, requestId: request.requestId, memberId: request.memberId }),
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

  function nonContent(request: HostToolRequest, state: 'unavailable' | 'binary' | 'tooLarge' | 'notFound' | 'unknown', reason?: string, byteSize?: number): HostToolResult {
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
      const snapshot = snapshotFieldOf(request);
      if (snapshot && !snapshotsEqual(snapshot, member)) {
        return {
          ok: false,
          result: refused(request, 'revisionMismatch', `Request is pinned to ${snapshot.repoId}@${snapshot.baseSha}..${snapshot.headSha}, not member ${member.memberId}'s ${member.baseSha}..${member.headSha}.`),
        };
      }
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

  async function dispatch(phase: RunPhase, request: HostToolRequest, control?: DispatchControl): Promise<HostToolResult> {
    const validation = validate(phase, request);
    if (!validation.ok) return validation.result;
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
      return refused(request, reserveOutcome.code === 'cancelled' ? 'cancelled' : 'budgetRefused', reserveOutcome.message);
    }

    if (options.cancellation?.isCancellationRequested) {
      options.budget.reconcile(request.requestId, { modelTurns: 0, toolCalls: 0, evidenceBytes: 0 });
      return refused(request, 'cancelled', 'The attempt was cancelled before this request was dispatched.');
    }

    let outcome: { result: HostToolResult; evidenceBytes: number };
    try {
      outcome = await dispatchToHandler(member, request, definition, control?.resumedAfterWait === true);
    } catch (error) {
      if (error instanceof RetryWaitSignal) {
        outcome = {
          result: nonContent(request, 'unavailable', `This request needs a longer retry wait (about ${Math.max(1, Math.round(error.delayMs / 1000))}s) and will resume later.`),
          evidenceBytes: 0,
        };
      } else {
        outcome = { result: nonContent(request, 'unavailable', sanitizedReason(error, 'The provider request failed.')), evidenceBytes: 0 };
      }
    }

    if (options.cancellation?.isCancellationRequested) {
      options.budget.reconcile(request.requestId, { modelTurns: 0, toolCalls: 0, evidenceBytes: 0 });
      return refused(request, 'cancelled', 'The attempt was cancelled while this request was in flight.');
    }

    options.budget.reconcile(request.requestId, { toolCalls: 1, evidenceBytes: outcome.evidenceBytes });
    return outcome.result;
  }

  // ---- 9.4 handlers ---------------------------------------------------------------

  async function dispatchToHandler(
    member: DispatcherMember | undefined,
    request: HostToolRequest,
    definition: HostToolDefinition,
    resumedFromWait: boolean,
  ): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    // Bound once per dispatch call so every provider-touching handler retries under the same
    // 9.5/9.6 policy without each handler re-deriving idempotence — `definition.idempotent` is
    // always true here (the two `hostAction` tools below never call `boundExecute` at all), but
    // it is still threaded explicitly rather than assumed (see harnessRetry.ts's file header).
    const boundExecute: ProviderCallExecutor = <T>(fn: () => Promise<T>) => executeWithRetry(request, definition.idempotent, resumedFromWait, fn);
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
    const method = member.connection.listChangedFiles;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot list changed files.'), evidenceBytes: 0 };
    const normalized: ChangedFileManifestRequest = { ...request.request };
    const result = await execute(() => method.call(member.connection, normalized));
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
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleReadDiff(member: DispatcherMember, request: ReadDiffToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.readDiff;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot read diffs.'), evidenceBytes: 0 };
    const path = normalizeEvidencePath(request.request.path) as string;
    const result = await execute(() => method.call(member.connection, { ...request.request, path }));
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
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleReadFile(member: DispatcherMember, request: ReadFileToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.readFile;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot read files.'), evidenceBytes: 0 };
    const path = normalizeEvidencePath(request.request.path) as string;
    const result = await execute(() => method.call(member.connection, { ...request.request, path }));
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
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleSearchRepository(member: DispatcherMember, request: SearchRepositoryToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.searchRepository;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot search the repository.'), evidenceBytes: 0 };
    const pathScope = request.request.pathScope !== undefined ? normalizeEvidencePath(request.request.pathScope) : undefined;
    const normalizedRequest: RepositorySearchRequest = { ...request.request, pathScope };
    const result = await execute(() => method.call(member.connection, normalizedRequest));
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
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleSearchDiff(member: DispatcherMember, request: SearchDiffToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.searchDiff;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot search diffs.'), evidenceBytes: 0 };
    const pathScope = request.request.pathScope !== undefined ? normalizeEvidencePath(request.request.pathScope) : undefined;
    const normalizedRequest: DiffSearchRequest = { ...request.request, pathScope };
    const result = await execute(() => method.call(member.connection, normalizedRequest));
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
    const result = await execute(() => method.call(member.connection, request.request));
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
      default:
        return { result: nonContent(request, 'unknown', result.reason), evidenceBytes: 0 };
    }
  }

  async function handleGetIssueDetails(member: DispatcherMember, request: GetIssueDetailsToolRequest, execute: ProviderCallExecutor): Promise<{ result: HostToolResult; evidenceBytes: number }> {
    const method = member.connection.getIssueDetails;
    if (!method) return { result: nonContent(request, 'unavailable', 'This connection cannot fetch issue details.'), evidenceBytes: 0 };
    const result = await execute(() => method.call(member.connection, request.request));
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
