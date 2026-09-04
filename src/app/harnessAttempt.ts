/**
 * `HarnessAttempt`: the orchestrator that drives one harness attempt end to
 * end through the six `RunPhase` values (tasks 10.3-10.5 of
 * `add-agentic-review-harness`, design.md D1/D5/D10/D11/D12, spec
 * `agentic-review-harness` "Review work follows explicit phases" and
 * "Coverage and risk govern investigation").
 *
 * This module is a pure orchestrator: it sequences and wires together
 * modules that already own every piece of logic an attempt needs —
 * `harnessBudgets` (budgets/reserves), `harnessInventory` (coverage),
 * `harnessEvidenceLedger` (evidence), `harnessCandidateValidation`
 * (candidates), `harnessCompletion` (the host gate), `harnessActivityLog`/
 * `harnessActivityPlan` (activity and plan), `harnessRiskFloors` (risk),
 * `harnessToolDispatcher` (tool dispatch), `harnessTurn`/`harnessProtocol`
 * (model turns), and `harnessRetry` (cancellation lifecycle). It introduces
 * no second implementation of anything those modules already do.
 *
 * **Phase sub-structure.** `RunPhase` has exactly six values (`bootstrap |
 * planning | investigating | verifying | completing | persisting`). The
 * spec's finer-grained phase list (bootstrap/inventory, planning, risk
 * classification, logical-unit investigation, checkpoint, synthesis,
 * verification/contradiction/deduplication, host validation, persistence) is
 * sub-structure *within* those six, not a seventh phase:
 * - risk classification runs as the first step of `investigating` (the
 *   committed protocol, task 10.1, carries no model risk-proposal message —
 *   see the note on `classifyFile` below);
 * - synthesis and verification/contradiction/deduplication both run inside
 *   `verifying`, before the turn loop that lets the model request
 *   completion;
 * - host validation runs in `completing`;
 * - the terminal activity event and the injected persistence hook fire in
 *   `persisting`.
 *
 * **Injected collaborators (deliberately left as seams for later tasks).**
 * `synthesisVerification` is task 10.6's collaborator — this module ships
 * `defaultSynthesisVerification`, a no-op-but-honest implementation that
 * reports every pass as *not* complete, so a run can never look complete
 * because verification silently didn't run. `onCheckpoint`/`onPersist` are
 * section 11's collaborators — both default to no-ops here; this module
 * builds no store.
 *
 * **One model, many phases (10.4).** `HarnessAttemptOptions.modelSeam` is a
 * single `{modelId, askModel}` value. Planning, investigating, and verifying
 * turns all close over this same seam (via `runHarnessTurn`'s own
 * phase-scoped `AskModel`), and it is also handed to the synthesis/
 * verification collaborator — there is no second seam anywhere in this
 * module for a caller to construct.
 *
 * **Interpretations documented, not silently narrowed:**
 * - *No model risk-proposal channel.* Design.md D10 says "the model proposes
 *   risk and logical units [and] the host applies mandatory risk floors...
 *   Model proposal never lowers a host floor," but the committed protocol
 *   (task 10.1, `harnessProtocol.ts`) has no message kind carrying a risk
 *   proposal. `classifyFile` below accepts an optional proposed risk (so the
 *   floor-overrides-a-low-proposal rule is real, testable code) and this
 *   module always calls it with `undefined` today — the floor alone decides.
 *   Extending the protocol with a risk-proposal message is out of this
 *   pass's scope (task 10.1 is committed) and is reported as a gap, not
 *   invented here.
 * - *`unresolvedFetches` is always 0.* Every tool dispatch in this module is
 *   `await`ed to a definite result before the turn loop continues; there is
 *   no pending/queued fetch state for `UnresolvedWork.unresolvedFetches` to
 *   count.
 * - *Bootstrap `rootPolicies`* is built from `snapshot.members[i].rootAgentsPolicy`
 *   (already resolved into the immutable snapshot, D3) rather than a fresh
 *   `resolvePolicy` dispatch: `resolvePolicy`'s `allowedPhases` does not
 *   include `bootstrap` (`harnessTools.ts`), so a bootstrap-phase dispatch of
 *   it would be refused `phaseNotAllowed`. `BootstrapPolicySource.text` is
 *   optional, so the envelope is honest either way. One entry is built per
 *   member (task 15.1) — an earlier version of this function collapsed the
 *   whole envelope to `options.members[0]`'s policy alone, silently dropping
 *   every other changeset member's root `AGENTS.md` identity from bootstrap.
 * - *Issue-detail bootstrap sections are never fetched.* `getIssueDetails`
 *   needs an explicit `issueRepoId`, which
 *   `ReviewRunContextSelections.linkedItemIdsIncluded` does not carry (only
 *   numbers). Bootstrap ships change-request sections only; `issueDetails`
 *   is always `[]`.
 * - *Explicit attachments become citable in `runBootstrap`, not earlier.*
 *   `renderAttachmentsForModel` (`reviewContext.ts`) is called once per
 *   member to build both the bootstrap `attachments` section (task 15.2's
 *   record of exactly what is shown) and the ledger registration input —
 *   the same budgeted/truncated bytes, never recomputed twice. Registration
 *   happens only after `fitBootstrapToModel` reports `ok: true`: a bootstrap
 *   that overflows never asks the model anything, so nothing was returned
 *   and nothing may become citable. Auto-derived title/body/discussion needs
 *   no separate registration call: it already reaches the ledger through
 *   `fetchMemberSections` -> `registerChangeRequestDetail`/`registerIssueDetail`,
 *   whose origins sit outside `CITABLE_ORIGINS` by construction (task 7.4) —
 *   a second `registerIntent` of the same bytes would just double-book the
 *   evidence-byte budget for content already correctly non-citable.
 *
 * **No `vscode` import, nothing from `src/providers/`.** The model call
 * arrives as the injected `modelSeam`; the provider arrives as an injected
 * `Connection` per member, exactly as `harnessToolDispatcher.ts` already
 * requires.
 */
import { randomBytes } from 'node:crypto';
import type { AgentCancellationToken } from './lmAgent';
import { createAgentsPolicyResolver } from './harnessAgentsPolicy';
import {
  appendActivityEvent,
  createActivityLog,
  type ActivityContext,
  type ActivityFact,
  type ActivityLog,
} from './harnessActivityLog';
import { planCreatedFact, planItemStateChangedFact, planRevisedFact } from './harnessActivityPlan';
import {
  budgetWarningLimitation,
  createBudgetTracker,
  partitionPool,
  resolveReservePercents,
  type BudgetTracker,
  type ReservationPurpose,
} from './harnessBudgets';
import {
  createCandidateTracker,
  revalidateFindings,
  type CandidateTracker,
  type TrackedCandidate,
  type ValidatedFinding,
} from './harnessCandidateValidation';
import {
  classifyOutcome,
  evaluateCompletion,
  type CompletionEvaluation,
  type CompletionEvaluationInput,
  type CompletionOutcome,
  type CitationRevalidationSummary,
  type MemberHeadCheck,
  type VerificationPasses,
} from './harnessCompletion';
import { sha256Hex, canonicalStringify } from './contentDigest';
import {
  createEvidenceLedger,
  ledgerMembersFromSnapshot,
  normalizeEvidencePath,
  type EvidenceLedger,
  type LedgerEvidenceSource,
} from './harnessEvidenceLedger';
import {
  applyCoverageSeed,
  coverageChangedFact,
  createChangedFileInventory,
  type ChangedFileInventory,
  type InventoryFileRecord,
} from './harnessInventory';
import { importRetainedEvidence, type EvidenceReuseOutcome, type ResumePayload } from './harnessResume';
import {
  applyRiskFloor,
  computeRiskFloor,
  DEFAULT_RISK_COVERAGE_RULES,
  DEFAULT_RISK_FLOOR_RULES,
  isReserveEligible,
  type RiskCoverageRules,
  type RiskFloorRules,
} from './harnessRiskFloors';
import {
  createHostToolDispatcher,
  type DispatchControl,
  type DispatcherMember,
  type HostToolDispatcher,
  type HostToolRequest,
  type HostToolResult,
  type HostToolRetryOptions,
} from './harnessToolDispatcher';
import { runHarnessTurn, type AskModel as PhaseAskModel } from './harnessTurn';
import { renderAttachmentsForModel, type Attachment } from './reviewContext';
import {
  buildBootstrapEnvelope,
  buildBootstrapSection,
  type BootstrapAttachmentSection,
  type BootstrapEnvelope,
  type BootstrapMemberIdentity,
  type BootstrapMemberRootPolicy,
  type BootstrapMemberSections,
  type BootstrapPolicySource,
} from '../domain/harnessBootstrap';
import { fitBootstrapToModel } from './harnessBootstrapBudget';
import type { Limitation, Plan, RunPhase } from '../domain/harnessActivity';
import type { BudgetConsumption, MemberCoverage, RiskLevel, UnresolvedWork } from '../domain/harnessCoverage';
import { effortPrompt } from '../domain/effort';
import { isTerminalLifecycle, type RunLifecycle } from '../domain/harnessLifecycle';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import type { ParsedToolCall, ProtocolMessage } from '../domain/harnessProtocol';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { Connection, ProviderCapabilities } from '../platform/provider';
import type {
  ChangedFileEntry,
  CurrentHeadResult,
  DetailSection,
  InvestigationCursor,
  NormalizedDetail,
} from '../platform/types';

// ---- Injected model seam (10.4: one seam, every model phase) ----------------------

/**
 * One model+persona for the whole attempt. `askModel` is called once per
 * model turn in `planning`/`investigating`/`verifying`, and the same seam is
 * handed to the synthesis/verification collaborator — there is no second
 * seam anywhere a caller could construct. `toolResults` is the previous
 * turn's dispatch results (empty on a phase's first turn), so a real caller
 * can quote a `sourceId`/`digest` the ledger actually minted back at the
 * model in its next prompt; this module never inspects the array itself.
 *
 * `envelope` is the fitted `BootstrapEnvelope` (`fitBootstrapToModel`'s own
 * `ok: true` result — already shrunk to the selected model's input limit
 * when it had to be) that `runBootstrap` below built and confirmed fits,
 * threaded through on every `planning`/`investigating`/`verifying` call this
 * module itself makes (`runPhaseLoop`) so a real seam can render it into
 * literal model-facing prompt text without a second bootstrap fetch of its
 * own. Optional only so a hand-constructed test call — e.g.
 * `harnessSynthesisVerification.ts`'s own direct `askModel` call for its
 * contradiction-check turn, which already has full context from the
 * surrounding investigation and needs no fresh envelope — is not forced to
 * fabricate one; a real production seam always receives it on every
 * `runPhaseLoop`-issued call and fails closed when it does not (see
 * `harnessModelSeam.ts`).
 */
export interface HarnessModelSeam {
  readonly modelId: string;
  askModel(input: {
    phase: RunPhase;
    repairInstruction: string | undefined;
    toolResults: readonly HostToolResult[];
    envelope?: BootstrapEnvelope;
  }): Promise<string>;
}

// ---- Injected synthesis/verification collaborator (task 10.6's seam) --------------

/** Mirrors `harnessActivityLog.ts`'s own local `DistributiveOmit` — a union type needs the distributive form or `Omit` collapses it. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export interface SynthesisVerificationInput {
  readonly modelSeam: HarnessModelSeam;
  readonly ledger: EvidenceLedger;
  /** Currently-accepted findings (`candidateTracker.triageFindings()`); the collaborator returns the post-grouping/dedup set. */
  readonly findings: readonly ValidatedFinding[];
  /** Bound to phase `'verifying'`, defaulting to `purpose: 'verification'` when the caller does not override it. */
  readonly dispatch: (request: DistributiveOmit<HostToolRequest, 'requestId' | 'elapsedMs'>) => Promise<HostToolResult>;
  readonly policy: HarnessPolicy;
  readonly cancellation?: AgentCancellationToken;
  readonly elapsedMs: () => number;
}

/** One finding the contradiction pass excluded, with a bounded public reason — task 10.6's collaborator (`./harnessSynthesisVerification.ts`) populates this so a contradicted finding is recorded, never silently dropped; the honest no-op default below and any collaborator that skips the stage simply omit it. */
export interface ContradictedFindingRecord {
  readonly candidateId: string;
  readonly reason: string;
}

export interface SynthesisVerificationOutput {
  /** The findings that survive grouping/deduplication/contradiction; a default pass-through implementation returns `input.findings` unchanged. */
  readonly findings: readonly ValidatedFinding[];
  readonly contradictionPassComplete: boolean;
  readonly deduplicationComplete: boolean;
  readonly finalVerificationComplete: boolean;
  /** Optional: findings the contradiction pass excluded, each with why. Absent from the honest no-op default and from any collaborator that does not run a contradiction pass. */
  readonly contradicted?: readonly ContradictedFindingRecord[];
}

export type SynthesisVerificationRunner = (input: SynthesisVerificationInput) => Promise<SynthesisVerificationOutput>;

/**
 * Honest no-op (task 10.6's seam, default until that task fills it in):
 * passes candidates through unchanged and reports every pass incomplete, so
 * `evaluateCompletion`'s `contradictionPassComplete`/`deduplicationComplete`/
 * `finalVerificationComplete` clauses can never be satisfied by *not* running
 * real verification. A run using this default cannot reach `complete`.
 */
export const defaultSynthesisVerification: SynthesisVerificationRunner = async (input) =>
  Object.freeze({
    findings: input.findings,
    contradictionPassComplete: false,
    deduplicationComplete: false,
    finalVerificationComplete: false,
  });

// ---- Injected checkpoint/persistence collaborators (section 11's seams) -----------

/**
 * `attemptInterrupted` is never produced by this module's own `fireCheckpoint`
 * (an attempt always runs live when it calls that) — it is task 11.6's reason
 * for the one other way a `PersistedCheckpoint` can change,
 * `harnessCheckpoint.ts`'s `closeCheckpointAsTerminal`, used by
 * `harnessResume.ts` to close a lost attempt as `interrupted` from its last
 * persisted checkpoint after an extension restart.
 */
export const CHECKPOINT_REASONS = ['phaseBoundary', 'toolCadence', 'modelSuggested', 'attemptInterrupted'] as const;

export type CheckpointReason = (typeof CHECKPOINT_REASONS)[number];

export function isCheckpointReason(value: unknown): value is CheckpointReason {
  return (CHECKPOINT_REASONS as readonly unknown[]).includes(value);
}

export function parseCheckpointReason(value: unknown): CheckpointReason | undefined {
  return isCheckpointReason(value) ? value : undefined;
}

/**
 * What a checkpoint collaborator (task 11.2's real implementation) receives:
 * `checkpointId`/`phase`/`reason`/`elapsedMs` name the event itself; every
 * other field is a **value snapshot** (a frozen array or plain object
 * already returned by its owning module's own read API — `ledger.sources()`,
 * `budget.consumption()`, `candidateTracker.all()`, `inventory.coverage()`)
 * taken at the moment of the checkpoint, never a live handle back into this
 * closure. `activityLog` is the attempt's own sanitized log (every field on
 * it already passed `appendActivityEvent`'s sanitizer) — a collaborator that
 * derives a checkpoint's public plan from it, rather than from the mutable
 * `plan` variable this module tracks internally, never risks persisting
 * unsanitized model-supplied plan text (`plan` above is set directly from
 * `message.plan`, before sanitization). `occurredAt` is `now()`, matching
 * every other activity timestamp — a checkpoint store must never read a
 * clock of its own (this module's own determinism rule, matching
 * `harnessBudgets.ts`/`harnessRetry.ts`).
 */
export interface CheckpointInfo {
  readonly checkpointId: string;
  readonly runId: string;
  readonly lineageId: string;
  readonly attempt: number;
  readonly phase: RunPhase;
  readonly reason: CheckpointReason;
  readonly occurredAt: string;
  readonly elapsedMs: number;
  readonly activityLog: ActivityLog;
  readonly evidenceSources: readonly LedgerEvidenceSource[];
  readonly candidates: readonly TrackedCandidate[];
  readonly contradicted: readonly ContradictedFindingRecord[];
  readonly budget: BudgetConsumption;
  readonly coverage: readonly MemberCoverage[];
  readonly unresolved: UnresolvedWork;
}

export type OnCheckpoint = (info: CheckpointInfo) => void | Promise<void>;

export interface HarnessAttemptOutcome {
  readonly lifecycle: RunLifecycle;
  readonly outcome: CompletionOutcome;
  readonly findings: readonly ValidatedFinding[];
  readonly plan?: Plan;
  readonly cancelled: boolean;
  /** The contradiction pass's exclusions (task 10.6's collaborator), wired through in task 11.2 so persistence and activity can both see them instead of silently dropping them at this boundary. Empty when no contradiction pass ran (the honest default collaborator, or a bootstrap failure before verification). */
  readonly contradicted: readonly ContradictedFindingRecord[];
}

export type OnPersist = (outcome: HarnessAttemptOutcome, log: ActivityLog) => void | Promise<void>;

// ---- Member wiring ------------------------------------------------------------------

/**
 * What a caller supplies per changeset member beyond what the immutable
 * snapshot already pins (repository/base/head/capability signature):
 * a live `Connection` and the full `ProviderCapabilities` it was signed
 * from. Never resolved from `src/providers/` here — the caller (runtime
 * wiring, task 10.8) owns that lookup.
 *
 * `attachments` is the *content* side of this member's explicit citable
 * evidence (task 15.2): the snapshot (`ReviewRunContextSelections.attachments`)
 * pins only each attachment's id, label, and content digest — D3's snapshot
 * never carries mutable content — so the full `Attachment` (with its actual
 * bytes) travels here instead, exactly mirroring how `ReviewRunSnapshotMemberInput`
 * separates the two (`reviewRunSnapshotBuilder.ts`). Absent for a member with
 * no explicit attachments. The caller must pass the *same* content used to
 * build the snapshot; `ledger.registerAttachment`'s digest check (D3/D8) is
 * what catches drift between the two, not this module.
 */
export interface HarnessAttemptMemberInput {
  readonly memberId: string;
  readonly connection: Connection;
  readonly capabilities: ProviderCapabilities;
  readonly attachments?: readonly Attachment[];
}

export interface HarnessAttemptOptions {
  readonly snapshot: ReviewRunSnapshot;
  readonly members: readonly HarnessAttemptMemberInput[];
  readonly modelSeam: HarnessModelSeam;
  readonly policy?: HarnessPolicy;
  readonly riskFloorRules?: RiskFloorRules;
  readonly riskCoverageRules?: RiskCoverageRules;
  /** Caller-supplied attempt clock (elapsed ms since attempt start), never read inline from `Date.now()`. */
  readonly clock: () => number;
  readonly now?: () => string;
  readonly cancellation?: AgentCancellationToken;
  /** For the bootstrap-fit check (`harnessBootstrapBudget.ts`); absent when the model has no declared input limit. */
  readonly countTokens?: (text: string) => Promise<number | undefined>;
  readonly synthesisVerification?: SynthesisVerificationRunner;
  readonly onCheckpoint?: OnCheckpoint;
  readonly onPersist?: OnPersist;
  readonly retry?: HostToolRetryOptions;
  /**
   * Task 14.6: what this attempt carries forward from a compatible prior attempt in the same
   * lineage (`harnessResume.ts`'s `decideResume`) — the caller's job is only to decide *whether*
   * to resume and to build this attempt's `snapshot` at the next attempt number; every seed below
   * is applied here, the one place that owns the collaborators it seeds:
   *
   * - `payload.plan`: becomes this attempt's starting plan, exactly as revised so far, AND is
   *   appended to this fresh attempt's own activity log as its first `planCreated` fact at
   *   bootstrap — never left as a value only this closure holds. Without that append, this
   *   attempt's own earliest checkpoints (`buildCheckpoint`'s `plan` derives from the log, by
   *   scanning it, not from a value passed alongside it) would report no plan at all until the
   *   model's own first planning turn — losing "preserve the plan" a second time if *this* attempt
   *   is itself interrupted before planning runs. Design.md's own resume note ("the model starts
   *   over... resume language says 'new attempt from checkpoint', never 'reconnected'") is why this
   *   seed is host-state preservation only: the plan is NOT threaded into the bootstrap prompt, so
   *   the model always plans this attempt fresh, exactly as attempt 1 did.
   * - `startAction`: the public narrative for the attempt boundary itself
   *   (`describeResumeStart`'s pinned string), appended as an `actionStarted` fact at bootstrap —
   *   spec `review-run-activity`'s "activity and evidence identify the attempt boundary".
   * - `payload.coverage`: replayed onto this attempt's own freshly enumerated inventory
   *   (`applyCoverageSeed`) as each manifest page arrives — never a persisted enumeration/cursor,
   *   which this attempt re-derives itself; identical heads (`decideResume` already checked) make
   *   re-enumeration deterministic.
   * - `payload.candidates`: loaded into this attempt's `CandidateTracker` verbatim, then revisited
   *   once evidence re-import (below) is known: an accepted candidate whose cited source could not
   *   be reused moves to unresolved rather than staying accepted on stale evidence (D8).
   * - `payload.budget`: carried into this attempt's `BudgetTracker` as already-spent consumption
   *   (D12/D15 docs on `BudgetTrackerOptions.carryForward` cover exactly what is and is not
   *   reconstructible).
   * - `payload.retainedEvidence`: imported into this attempt's own evidence ledger
   *   (`harnessResume.ts`'s `importRetainedEvidence`) as soon as the ledger exists, before any
   *   candidate seeding reads it — a source whose exact content and digest still match reuses its
   *   prior id; one that does not is left for the model, or the caller, to fetch again.
   *
   * `payload.priorAttempt`/`.newAttempt`/`.retry` are not read here: attempt numbering lives on
   * `snapshot` itself, and `RetryState` has no live consumer yet (`harnessCheckpoint.ts`'s own doc
   * comment — `INITIAL_RETRY_STATE` is a placeholder until a real waiting/backoff loop reads it back).
   */
  readonly resumeSeed?: { readonly payload: ResumePayload; readonly startAction: string };
}

export interface HarnessAttemptResult {
  readonly runId: string;
  readonly lineageId: string;
  readonly attempt: number;
  readonly lifecycle: RunLifecycle;
  readonly outcome: CompletionOutcome;
  readonly findings: readonly ValidatedFinding[];
  readonly plan?: Plan;
  readonly activityLog: ActivityLog;
  readonly cancelled: boolean;
  readonly small: boolean;
  readonly turnsUsed: number;
  readonly toolCallsUsed: number;
  readonly contradicted: readonly ContradictedFindingRecord[];
}

export interface HarnessAttempt {
  run(): Promise<HarnessAttemptResult>;
}

// ---- Small pure helpers ---------------------------------------------------------------

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

/** Key for `registeredAttachmentSources` below — member id and attachment id joined so neither can collide with the other across members. */
function attachmentSourceKey(memberId: string, attachmentId: string): string {
  return `${memberId}:${attachmentId}`;
}

/**
 * The host-side classification step (D10). `proposed` is always `undefined`
 * from this module today (see the file header's documented protocol gap),
 * but the parameter exists so the floor-overrides-a-low-proposal rule is
 * real, callable code rather than only asserted in `harnessRiskFloors.test.ts`.
 */
export function classifyFile(
  entry: ChangedFileEntry,
  proposed: RiskLevel | undefined,
  rules: RiskFloorRules = DEFAULT_RISK_FLOOR_RULES,
): { readonly risk: RiskLevel; readonly floorReasons: readonly { readonly ruleId: string; readonly risk: RiskLevel; readonly reason: string }[] } {
  const floor = computeRiskFloor({ entry }, rules);
  const applied = applyRiskFloor(proposed, floor);
  return { risk: applied.risk, floorReasons: floor.reasons };
}

/**
 * The "small review" threshold (task 10.5): the complete inventory fits in
 * one manifest page (`policy.manifestPageSize`, the field that already
 * gates manifest pagination) and the total known changed bytes fit the
 * attempt's *ordinary* evidence lane (`partitionPool`'s own accounting, the
 * pool exploration draws from) rather than the whole per-attempt evidence
 * budget — "fits without ever touching a reserve." Both bounds reuse fields
 * `HarnessPolicy` already defines for other purposes; nothing here is a new
 * magic number.
 */
export function isSmallReview(fileCount: number, totalKnownBytes: number, policy: HarnessPolicy): boolean {
  const ordinaryEvidenceCapacity = partitionPool(policy.maxEvidenceBytesPerAttempt, resolveReservePercents(policy)).ordinary;
  return fileCount <= policy.manifestPageSize && totalKnownBytes <= ordinaryEvidenceCapacity;
}

function toHostToolRequest(
  call: ParsedToolCall,
  requestId: string,
  elapsedMs: number,
  purpose: ReservationPurpose,
  hostInitiated: boolean,
): HostToolRequest {
  switch (call.tool) {
    case 'listChangedFiles':
      return { tool: 'listChangedFiles', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'readDiff':
      return { tool: 'readDiff', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'readFile':
      return { tool: 'readFile', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'searchRepository':
      return { tool: 'searchRepository', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'searchDiff':
      return { tool: 'searchDiff', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'resolvePolicy':
      return { tool: 'resolvePolicy', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, changedPath: call.changedPath };
    case 'getChangeRequestDetails':
      return { tool: 'getChangeRequestDetails', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    case 'getIssueDetails':
      return { tool: 'getIssueDetails', requestId, elapsedMs, purpose, hostInitiated, memberId: call.memberId, request: call.request };
    default: {
      const exhaustive: never = call;
      throw new Error(`Unhandled tool call kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Whether a turn's batch contains any work the host should act on beyond bookkeeping — the stall signal that ends a phase's loop (advisor-reviewed addition: a turn with none of this is the model saying "done here"). */
function turnHasActionableWork(messages: readonly ProtocolMessage[]): boolean {
  return messages.some((message) => message.kind === 'toolRequest' || message.kind === 'candidateSubmission' || message.kind === 'planCreated' || message.kind === 'planRevised' || message.kind === 'completionRequest');
}

let requestCounter = 0;
/** A process-wide monotonic counter, never a wall-clock read — determinism (this module never reads `Date.now()` inline) matters more than global uniqueness here, and a counter is already unique within one process. */
function nextRequestId(): string {
  requestCounter += 1;
  return `attempt-req-${requestCounter}`;
}

const ALL_DETAIL_SECTIONS: readonly DetailSection[] = ['metadata', 'commits', 'discussion', 'labels', 'checkSummaries', 'relationships'];

type StopReason = 'condition' | 'noActionableWork' | 'budgetExhausted' | 'cancelled' | 'repairExhausted';

interface ProcessMessagesOutcome {
  readonly hadActionableWork: boolean;
  readonly completionGranted: boolean;
}

// ---- The orchestrator ---------------------------------------------------------------

/**
 * Builds one `HarnessAttempt` from an immutable snapshot and already-tested
 * collaborators. Nothing here performs its own budget accounting, coverage
 * tracking, evidence storage, completion decision, or plan modeling — every
 * one of those lives in the modules imported above; this function only
 * sequences calls into them in phase order and translates between their
 * shapes (`ParsedToolCall` -> `HostToolRequest`, tool results -> inventory
 * transitions and activity facts).
 */
export function createHarnessAttempt(options: HarnessAttemptOptions): HarnessAttempt {
  const policy = options.policy ?? DEFAULT_HARNESS_POLICY;
  const riskFloorRules = options.riskFloorRules ?? DEFAULT_RISK_FLOOR_RULES;
  const riskCoverageRules = options.riskCoverageRules ?? DEFAULT_RISK_COVERAGE_RULES;
  const snapshot = options.snapshot;
  const now = options.now ?? (() => new Date().toISOString());
  const clock = options.clock;
  const cancellation = options.cancellation;
  const synthesisVerification = options.synthesisVerification ?? defaultSynthesisVerification;
  const onCheckpoint = options.onCheckpoint;
  const onPersist = options.onPersist;

  if (snapshot.modelId !== undefined && snapshot.modelId !== options.modelSeam.modelId) {
    throw new Error(`HarnessAttempt's model seam ("${options.modelSeam.modelId}") does not match the snapshot's selected model ("${snapshot.modelId}").`);
  }
  if (options.members.length === 0) {
    throw new Error('HarnessAttempt requires at least one member.');
  }

  const runId = snapshot.runId;
  const lineageId = snapshot.lineageId;
  const attemptNumber = snapshot.attempt;

  const snapshotMembersById = new Map(snapshot.members.map((member) => [member.memberId, member] as const));
  for (const member of options.members) {
    if (!snapshotMembersById.has(member.memberId)) {
      throw new Error(`Member ${member.memberId} is not part of this attempt's snapshot.`);
    }
  }
  const inputMembersById = new Map(options.members.map((member) => [member.memberId, member] as const));
  const memberIds = options.members.map((member) => member.memberId);

  function snapshotMember(memberId: string) {
    const snap = snapshotMembersById.get(memberId);
    if (!snap) throw new Error(`Member ${memberId} is not part of this attempt's snapshot.`);
    return snap;
  }

  /** Task 14.6: what this attempt carries forward from a prior attempt in the same lineage, if any — see `HarnessAttemptOptions.resumeSeed`'s own doc comment. */
  const resumeSeed = options.resumeSeed;

  // ---- Mutable attempt state (everything else is owned by an imported module) ----

  let activityLog: ActivityLog = createActivityLog(runId, lineageId, attemptNumber);
  let currentPhase: RunPhase = 'bootstrap';
  /** The fitted bootstrap envelope (`runBootstrap`'s own `fit.envelope`) — set once, after `fitBootstrapToModel` confirms it fits, and handed to `options.modelSeam.askModel` on every `planning`/`investigating`/`verifying` call `runPhaseLoop` makes. See `HarnessModelSeam.envelope`'s own doc comment. */
  let fittedEnvelope: BootstrapEnvelope | undefined;
  /** Seeded from the prior attempt's checkpoint on a resume — a fresh attempt still creates its own on the first planning turn, same as always. */
  let plan: Plan | undefined = resumeSeed?.payload.plan;
  let lastTurnResults: readonly HostToolResult[] = [];
  let toolCallsSinceCheckpoint = 0;
  let smallFlag = false;
  const extraLimitations: Limitation[] = [];
  let latestHeads: readonly MemberHeadCheck[] = [];
  let latestCitations: CitationRevalidationSummary = { revalidated: false, invalidatedCount: 0 };
  let latestPasses: VerificationPasses = { contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false };
  let survivingFindings: readonly ValidatedFinding[] = [];
  let verificationRan = false;
  let passesStale = false;
  /** The contradiction pass's exclusions (task 10.6's collaborator's `output.contradicted`), captured here so `fireCheckpoint`/`runPersisting` can hand them to the checkpoint collaborator and `HarnessAttemptOutcome` instead of dropping them at this closure's boundary. */
  let latestContradicted: readonly ContradictedFindingRecord[] = [];
  /**
   * Task 9.6's production trigger for `DispatchControl.resumedAfterWait`/`onResuming`. Keys are
   * `waitKeyFor(request)` for every logical tool-call operation `retryOptions.onEnterWaiting`
   * (below) observed entering a 9.6 long-delay `wait`; `dispatchAndTrack` consumes (deletes) a key
   * the moment the same operation is dispatched again, marking that re-dispatch resumed. Every
   * dispatch in this module is awaited one at a time (never concurrently), so `inFlightRequest`
   * safely names "whichever request `dispatcher.dispatch` is currently working on" for
   * `onEnterWaiting` to key off of — `DispatcherRetryWaitInfo` itself carries only `tool`/
   * `memberId`, not the operation's own request fields (`path`/`query`/...).
   */
  const pendingWaitKeys = new Set<string>();
  let inFlightRequest: HostToolRequest | undefined;

  function isCancelled(): boolean {
    return cancellation?.isCancellationRequested === true;
  }

  function appendActivity(fact: ActivityFact, phase: RunPhase): void {
    const context: ActivityContext = { occurredAt: now(), phase, elapsedMs: clock() };
    activityLog = appendActivityEvent(activityLog, fact, context);
  }

  /**
   * The state-snapshot half of a checkpoint, without appending an activity marker for it. Split out
   * of `fireCheckpoint` (below) so `runPersisting`/`finalizeBootstrapFailure` can report a checkpoint
   * for the terminal `activityLog` state — with the `terminalResult` fact already the log's last
   * event — without appending a trailing `{kind:'checkpoint'}` marker that would displace it.
   * `deriveLifecycle` (`harnessActivityProjection.ts`) reads only the log's last event, so a
   * checkpoint marker appended after `terminalResult` would make every terminal checkpoint project
   * as non-terminal — the bug task 14.6 found and fixed here: no attempt, successful or not, ever
   * landed in `HarnessRunStore.terminalAttempts` before this change, because `fireCheckpoint`'s own
   * marker for the 'persisting' phase boundary always fired *before* `runPersisting` appended the
   * terminal fact.
   */
  async function reportCheckpoint(checkpointId: string, phase: RunPhase, reason: CheckpointReason): Promise<void> {
    if (!onCheckpoint) return; // nothing to gather a state snapshot for
    const coverage: MemberCoverage[] = [];
    for (const member of inventory.members()) {
      const memberCoverage = inventory.coverage(member.memberId);
      if (memberCoverage) coverage.push(memberCoverage);
    }
    const info: CheckpointInfo = {
      checkpointId,
      runId,
      lineageId,
      attempt: attemptNumber,
      phase,
      reason,
      occurredAt: now(),
      elapsedMs: clock(),
      activityLog,
      evidenceSources: ledger.sources(),
      candidates: candidateTracker.all(),
      contradicted: latestContradicted,
      budget: budget.consumption(),
      coverage,
      unresolved: { unresolvedFetches: 0, unresolvedCandidates: candidateTracker.unresolvedCount() },
    };
    await onCheckpoint(info);
  }

  async function fireCheckpoint(phase: RunPhase, reason: CheckpointReason): Promise<void> {
    const checkpointId = mintId('ckpt');
    // The checkpoint's own activity event is appended first (unconditionally — it is public
    // progress, independent of whether a persistence collaborator is injected), so a collaborator
    // reading `activityLog` below sees its own checkpoint marker as the log's latest event.
    appendActivity({ kind: 'checkpoint', checkpointId }, phase);
    await reportCheckpoint(checkpointId, phase, reason);
  }

  // ---- Collaborators (ledger, budget, inventory, candidates, dispatcher) ----

  const ledgerMembers = ledgerMembersFromSnapshot(snapshot).filter((member) => memberIds.includes(member.memberId));
  const ledger = createEvidenceLedger({ runId, lineageId, attempt: attemptNumber }, ledgerMembers, { policy });

  // Evidence re-import happens as soon as the ledger exists, and before candidate seeding below
  // reads its outcome (D8: an accepted candidate citing a source that came back `refetchRequired`
  // must not stay accepted on stale evidence).
  const evidenceReuse: readonly EvidenceReuseOutcome[] = resumeSeed
    ? importRetainedEvidence(ledger, resumeSeed.payload.retainedEvidence, resumeSeed.payload.candidates)
    : [];

  const budget: BudgetTracker = createBudgetTracker(policy, { members: memberIds, carryForward: resumeSeed?.payload.budget });

  const inventory: ChangedFileInventory = createChangedFileInventory(
    options.members.map((member) => {
      const snap = snapshotMember(member.memberId);
      return { memberId: member.memberId, snapshot: { repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha } };
    }),
  );

  const candidateTracker: CandidateTracker = createCandidateTracker({
    maxRepairsPerCandidate: policy.protocolRepairsPerPhase,
    seed: resumeSeed?.payload.candidates,
  });

  // A seeded accepted candidate whose cited source could not be reused moves to unresolved until
  // the refetch lands and revalidates it — the same ordering rule `revalidateFindings` enforces
  // for a live head change, applied here for a resumed evidence source instead.
  for (const reuse of evidenceReuse) {
    if (reuse.outcome.kind !== 'refetchRequired' || !reuse.requiredByCitation) continue;
    for (const tracked of resumeSeed?.payload.candidates ?? []) {
      if (tracked.state !== 'accepted' || !tracked.finding) continue;
      const cites = tracked.finding.evidence.primary.sourceId === reuse.priorSourceId
        || tracked.finding.evidence.supporting.some((source) => source.sourceId === reuse.priorSourceId);
      if (cites) candidateTracker.invalidate(tracked.candidateId, [reuse.outcome.reason]);
    }
  }

  const dispatcherMembers: DispatcherMember[] = options.members.map((member) => {
    const snap = snapshotMember(member.memberId);
    return {
      memberId: member.memberId,
      repositoryId: snap.ref.repoId,
      baseSha: snap.baseSha,
      headSha: snap.headSha,
      changeRequestNumber: snap.ref.number,
      connection: member.connection,
      capabilities: member.capabilities,
    };
  });

  const agentsPolicyResolver = createAgentsPolicyResolver(
    (member) => (inputMembersById.get(member.memberId) as HarnessAttemptMemberInput).connection,
    { capabilities: (member) => inputMembersById.get(member.memberId)?.capabilities },
  );

  function currentCompletionEvaluation(): CompletionEvaluation {
    const input: CompletionEvaluationInput = {
      heads: latestHeads,
      inventory,
      coverageRules: riskCoverageRules,
      unresolved: { unresolvedFetches: 0, unresolvedCandidates: candidateTracker.unresolvedCount() },
      citations: latestCitations,
      passes: latestPasses,
      budget: { hardExhausted: budget.state().hardExhausted, timedOut: budget.state().timedOut },
    };
    return evaluateCompletion(input);
  }

  const retryOptions: HostToolRetryOptions = {
    ...options.retry,
    onCheckpointDue: (info) => {
      void fireCheckpoint(currentPhase, 'toolCadence');
      options.retry?.onCheckpointDue?.(info);
    },
    onEnterWaiting: (info) => {
      appendActivity({ kind: 'waiting', reason: 'A transient provider issue requires a longer wait before this request can continue.' }, currentPhase);
      // Closes task 9.6: remember which logical operation just entered `waiting`, so
      // `dispatchAndTrack`'s next dispatch of that same operation is marked
      // `resumedAfterWait: true` — the one production trigger for `onResuming` below.
      if (inFlightRequest) pendingWaitKeys.add(waitKeyFor(inFlightRequest));
      options.retry?.onEnterWaiting?.(info);
    },
    onResuming: (info) => {
      appendActivity({ kind: 'resuming' }, currentPhase);
      options.retry?.onResuming?.(info);
    },
  };

  /**
   * D8/13.5's attachment-inline-routing rule ("inline only when its path is also a changed file
   * of that member") needs each member's changed-file set as manifest pages arrive — this Map is
   * mutated in place by `onManifestPage` below and read live by every later
   * `submitCandidateFinding` dispatch, never rebuilt or snapshotted once passed to the dispatcher.
   */
  const changedPathsByMember = new Map<string, Set<string>>(memberIds.map((memberId) => [memberId, new Set<string>()]));

  const dispatcher: HostToolDispatcher = createHostToolDispatcher({
    members: dispatcherMembers,
    ledger,
    budget,
    candidateTracker,
    criteria: snapshot.criteria,
    changedPathsByMember,
    agentsPolicyResolver,
    evaluateCompletion: () => currentCompletionEvaluation(),
    onManifestPage: (memberId, result) => {
      inventory.acceptManifestPage(memberId, result);
      if (result.state === 'complete' || result.state === 'paginated' || result.state === 'truncated') {
        const paths = changedPathsByMember.get(memberId);
        for (const entry of result.value) paths?.add(entry.path);
      }
      // Re-applies whatever classifications this page's newly-known files carried on the prior
      // attempt's checkpoint; a no-op for any file not yet enumerated, and safely idempotent for
      // one already re-applied by an earlier page (`applyCoverageSeed`'s own doc comment).
      if (resumeSeed) applyCoverageSeed(inventory, resumeSeed.payload.coverage);
    },
    policy,
    cancellation,
    now,
    retry: retryOptions,
    cancellationLifecycle: cancellation
      ? {
          onCancelling: () => appendActivity({ kind: 'cancelling' }, currentPhase),
          onCancelled: () => appendActivity({ kind: 'cancelled' }, currentPhase),
        }
      : undefined,
  });

  // ---- Tool dispatch bookkeeping: activity, inventory, checkpoint cadence ----

  function pathOrIdOf(request: HostToolRequest): string | undefined {
    switch (request.tool) {
      case 'readDiff':
      case 'readFile':
        return request.request.path;
      case 'searchRepository':
      case 'searchDiff':
        return request.request.query;
      case 'resolvePolicy':
        return request.changedPath;
      case 'getChangeRequestDetails':
        return request.request.number;
      case 'getIssueDetails':
        return request.request.issueNumber;
      case 'listChangedFiles':
      case 'submitCandidateFinding':
      case 'requestCompletion':
        return request.memberId;
      default: {
        const exhaustive: never = request;
        return exhaustive;
      }
    }
  }

  /** 9.6: a logical operation's identity for `pendingWaitKeys` — coarser than `requestId` (which is
   * always fresh per dispatch, D12/`DispatchControl`'s own budget note) on purpose: it names "the
   * same tool call the model/host is redoing," not one specific request envelope. */
  function waitKeyFor(request: HostToolRequest): string {
    return [request.tool, request.memberId ?? '', pathOrIdOf(request) ?? ''].join('::');
  }

  function recordToolActivity(phase: RunPhase, request: HostToolRequest, result: HostToolResult): void {
    const target = pathOrIdOf(request);
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const paginationNote = result.state === 'paginated' ? ' (more available)' : result.state === 'truncated' ? ' (truncated by the provider)' : '';
        appendActivity({ kind: 'toolCompleted', tool: request.tool, target, summary: `${result.unitsReturned} unit(s) returned${paginationNote}.` }, phase);
        return;
      }
      case 'refused':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: result.reason }, phase);
        return;
      case 'binary':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: 'The content is binary.' }, phase);
        return;
      case 'tooLarge':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: 'The content is too large to return.' }, phase);
        return;
      case 'unavailable':
      case 'notFound':
      case 'unknown':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: result.reason }, phase);
        return;
      default: {
        const exhaustive: never = result;
        void exhaustive;
      }
    }
  }

  /** `unvisited -> classified`, using only the deterministic host floor (D10; see the file header's documented protocol gap). */
  function ensureClassified(memberId: string, file: InventoryFileRecord): void {
    if (file.state !== 'unvisited') return;
    const entry: ChangedFileEntry = {
      path: file.path,
      oldPath: file.oldPath,
      kind: file.kind,
      binary: file.binary,
      addedLines: file.addedLines,
      removedLines: file.removedLines,
      byteSize: file.byteSize,
    };
    const classified = classifyFile(entry, undefined, riskFloorRules);
    inventory.classify(memberId, file.path, { risk: classified.risk });
  }

  function classifyAllUnvisited(): void {
    for (const member of inventory.members()) {
      for (const file of member.files) ensureClassified(member.memberId, file);
    }
    appendActivity(coverageChangedFact(inventory, riskCoverageRules.requireInspection), currentPhase);
  }

  /** Bridges a `readDiff` result back into inventory state (task 10.3): the dispatcher has no inventory dependency of its own (`harnessToolDispatcher.ts`'s header), so this is the one place a tool result becomes a coverage transition. Only `readDiff` counts as inspection (D10: "Inspection requires model-visible diff evidence"); `readFile`/search results never do. */
  function updateInventoryFromResult(request: HostToolRequest, result: HostToolResult): void {
    if (request.tool !== 'readDiff') return;
    const memberId = request.memberId;
    const path = normalizeEvidencePath(request.request.path);
    if (!path) return;
    const file = inventory.file(memberId, path);
    if (!file) return;
    ensureClassified(memberId, file);
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated':
        inventory.markInspected(memberId, path);
        break;
      case 'binary':
        inventory.markTerminal(memberId, path, 'binary', 'The provider reported this file as binary.');
        break;
      case 'tooLarge':
        inventory.markTerminal(memberId, path, 'oversized', 'The diff for this file exceeded what the provider could return.');
        break;
      case 'unavailable':
        // A read deferred to wait out a long retry (9.6) has not failed — the very next
        // retry may return the diff. `markTerminal` is irreversible, so marking it here
        // would leave the file permanently uninspectable and the run permanently unable
        // to reach complete. Leave it classified-but-uninspected: the completion gate
        // then correctly reports the run incomplete until the read actually lands.
        if (result.deferred) break;
        inventory.markTerminal(memberId, path, 'unavailable', result.reason);
        break;
      case 'notFound':
        inventory.markTerminal(memberId, path, 'unavailable', result.reason);
        break;
      default:
        break;
    }
    appendActivity(coverageChangedFact(inventory, riskCoverageRules.requireInspection), currentPhase);
  }

  async function dispatchAndTrack(phase: RunPhase, request: HostToolRequest, control?: DispatchControl): Promise<HostToolResult> {
    // Closes task 9.6: consume (delete, unconditionally — never left short-circuited by an
    // already-true `control.resumedAfterWait`, or it would linger and misattribute a later,
    // unrelated dispatch of the same operation) any pending wait recorded for this exact
    // operation. This dispatch IS the re-dispatch a caller-supplied `control.resumedAfterWait`
    // would have signalled by hand, so mark it resumed even when no caller passed `control` at
    // all — the model reissuing the identical tool call is the real production path; nothing in
    // this module hand-constructs `DispatchControl` today.
    const hadPendingWait = pendingWaitKeys.delete(waitKeyFor(request));
    const resumedAfterWait = control?.resumedAfterWait === true || hadPendingWait;
    const effectiveControl: DispatchControl | undefined = resumedAfterWait ? { resumedAfterWait: true } : control;
    inFlightRequest = request;
    let result: HostToolResult;
    try {
      result = await dispatcher.dispatch(phase, request, effectiveControl);
    } finally {
      inFlightRequest = undefined;
    }
    recordToolActivity(phase, request, result);
    updateInventoryFromResult(request, result);
    if (result.state !== 'refused') {
      toolCallsSinceCheckpoint += 1;
      if (toolCallsSinceCheckpoint >= policy.checkpointCadenceToolCalls) {
        toolCallsSinceCheckpoint = 0;
        await fireCheckpoint(phase, 'toolCadence');
      }
    }
    return result;
  }

  /**
   * D12/D15's "unvisited and high-risk reserve" is capacity carved out of `ordinary`, meant for
   * exactly one thing: finishing REQUIRED, RESERVE-ELIGIBLE coverage once the ordinary pool runs
   * dry (spec `agentic-review-harness` "High-risk files remain unvisited": "the host uses reserved
   * investigation budget for those files"). `RiskCoverageRules` deliberately separates
   * `requireInspection` (which risk levels must be inspected at all — the default requires every
   * level) from `reserveEligible` (which of THOSE may draw the reserve — the default is `high`
   * alone, `harnessRiskFloors.ts`'s own `DEFAULT_RISK_COVERAGE_RULES`); using `requireInspection`
   * here would let low-risk exploration spend the reserve too, defeating the reserve's entire
   * purpose (protecting *high-risk* coverage specifically once ordinary work has exhausted the
   * shared pool). Before task 16.2's assurance pass, nothing in this module ever reserved with
   * purpose `'highRiskCoverage'` at all — `choosePurpose` returned only `'exploration'`/
   * `'verification'`, so `LANE_ORDER.highRiskCoverage`'s `['ordinary', 'highRiskReserve']` draw
   * order was dead code and the reserve sat unreachable while a required high-risk file starved.
   * This is the real defect the assurance pass found and fixes; see
   * `harnessLargeReview.assurance.test.ts` for the end-to-end proof (16.2) that breaks without it.
   */
  function reserveEligibleCoverageRemains(): boolean {
    for (const member of inventory.members()) {
      for (const file of member.files) {
        if (file.state === 'classified' && file.risk !== undefined && isReserveEligible(file.risk, riskCoverageRules)) return true;
      }
    }
    return false;
  }

  /** Turn-level purpose: coarse by necessity (the model has not yet said which tool it will call), so any reserve-eligible file still needing inspection is enough to let this turn's own reservation draw the reserve if ordinary is spent. Draining still prefers `ordinary` first (`LANE_ORDER.highRiskCoverage`), so this changes nothing while ordinary capacity remains. */
  function choosePurpose(phase: RunPhase): ReservationPurpose {
    if (phase === 'verifying') return 'verification';
    if (phase === 'investigating' && reserveEligibleCoverageRemains()) return 'highRiskCoverage';
    return 'exploration';
  }

  /**
   * Tool-call-level purpose: precise, unlike `choosePurpose` above. Only a `readDiff` naming the
   * exact reserve-eligible file still awaiting inspection draws the reserve; every other tool call
   * (search, an already-inspected or low/medium-risk file, an unrelated read) stays `'exploration'`
   * even while some other file in the run still needs the reserve — otherwise ordinary exploration
   * could spend down capacity meant only for the files it actually protects.
   */
  function purposeForToolCall(phase: RunPhase, call: ParsedToolCall): ReservationPurpose {
    if (phase === 'verifying') return 'verification';
    if (phase === 'investigating' && call.tool === 'readDiff') {
      const file = inventory.file(call.memberId, call.request.path);
      if (file && file.state !== 'inspected' && file.risk !== undefined && isReserveEligible(file.risk, riskCoverageRules)) {
        return 'highRiskCoverage';
      }
    }
    return 'exploration';
  }

  /** The pre-completion head check (D3), refreshed on entry to `verifying` and again in `completing`. Never routed through the dispatcher/model-facing tool catalog — `Connection.getCurrentHead`'s own doc comment: "Used only for the pre-completion head check." */
  async function refreshHeads(): Promise<void> {
    const heads: MemberHeadCheck[] = [];
    for (const member of options.members) {
      const snap = snapshotMember(member.memberId);
      let currentHead: CurrentHeadResult | undefined;
      if (member.connection.getCurrentHead) {
        try {
          currentHead = await member.connection.getCurrentHead({ repoId: snap.ref.repoId, number: snap.ref.number });
        } catch {
          currentHead = undefined;
        }
      }
      heads.push({ memberId: member.memberId, snapshotHeadSha: snap.headSha, currentHead });
    }
    latestHeads = heads;
  }

  // ---- Synthesis and verification (task 10.6's seam; task 10.3 owns the phase around it) ----

  /** Runs the injected collaborator, then the host's own already-built citation revalidation (D9's "the host then reruns citation validation") — never a second dedup/contradiction implementation. */
  async function runSynthesisVerification(): Promise<void> {
    const before = candidateTracker.triageFindings();
    const output = await synthesisVerification({
      modelSeam: options.modelSeam,
      ledger,
      findings: before,
      dispatch: async (partial) => {
        // Default to the verification reserve, never the dispatcher's own 'exploration' default
        // (`harnessToolDispatcher.ts`'s `request.purpose ?? 'exploration'`) — every dispatch made
        // during `verifying`, collaborator-issued or not, must draw the reserve lane first.
        const request = { purpose: 'verification', ...partial, requestId: nextRequestId(), elapsedMs: clock() } as HostToolRequest;
        return dispatchAndTrack('verifying', request);
      },
      policy,
      cancellation,
      elapsedMs: clock,
    });
    const revalidation = revalidateFindings(output.findings, { ledger, now: now() });
    survivingFindings = revalidation.valid;
    latestCitations = { revalidated: true, invalidatedCount: revalidation.invalidated.length };
    latestPasses = {
      contradictionPassComplete: output.contradictionPassComplete,
      deduplicationComplete: output.deduplicationComplete,
      finalVerificationComplete: output.finalVerificationComplete,
    };
    // Known-gap closure (task 11.2): `output.contradicted` used to end here, never reaching
    // activity or persistence. It is now recorded for `fireCheckpoint`/`runPersisting` below, and
    // each exclusion becomes its own public `toolFailed` event — `appendActivity`'s existing
    // sanitizer is still the one boundary that redacts/bounds `entry.reason`, whether or not the
    // injected `synthesisVerification` collaborator already sanitized it itself.
    latestContradicted = output.contradicted ?? [];
    for (const entry of latestContradicted) {
      appendActivity({ kind: 'toolFailed', tool: 'contradictionCheck', target: entry.candidateId, reason: entry.reason }, 'verifying');
    }
    verificationRan = true;
    passesStale = false;
  }

  // ---- Generic protocol-message processing, shared by planning/investigating/verifying ----

  async function processMessages(phase: RunPhase, messages: readonly ProtocolMessage[], sink: HostToolResult[]): Promise<ProcessMessagesOutcome> {
    let completionGranted = false;
    for (const message of messages) {
      switch (message.kind) {
        case 'planCreated':
          plan = message.plan;
          appendActivity(planCreatedFact(plan), phase);
          break;
        case 'planRevised':
          plan = message.plan;
          appendActivity(planRevisedFact(plan), phase);
          break;
        case 'planItemStateChanged':
          appendActivity(planItemStateChangedFact(message.itemId, message.state), phase);
          break;
        case 'publicRationale':
          // No dedicated activity-event kind exists for standalone public rationale (only a plan
          // revision's own `rationale` field does) — `actionStarted` is the existing kind that
          // already carries "the current public narrative", per `harnessActivityProjection.ts`'s
          // `deriveCurrentAction`.
          appendActivity({ kind: 'actionStarted', action: message.rationale, target: message.itemId }, phase);
          break;
        case 'toolRequest': {
          const request = toHostToolRequest(message.call, nextRequestId(), clock(), purposeForToolCall(phase, message.call), false);
          sink.push(await dispatchAndTrack(phase, request));
          break;
        }
        case 'candidateSubmission': {
          // Precise, like `purposeForToolCall`: a finding for a reserve-eligible file draws the
          // reserve regardless of whether that file's *own* read already flipped
          // `reserveEligibleCoverageRemains()` back to false — the submission is still budget work
          // belonging to that file's coverage, not unrelated ordinary exploration. `risk` persists
          // on the file record after inspection (it is never cleared), so this reads correctly
          // however much later the submission turn lands.
          const targetFile = inventory.file(message.candidate.memberId, message.candidate.file);
          const purpose: ReservationPurpose =
            phase === 'investigating' && targetFile?.risk !== undefined && isReserveEligible(targetFile.risk, riskCoverageRules)
              ? 'highRiskCoverage'
              : choosePurpose(phase);
          const request: HostToolRequest = {
            tool: 'submitCandidateFinding',
            requestId: nextRequestId(),
            elapsedMs: clock(),
            purpose,
            hostInitiated: false,
            memberId: message.candidate.memberId,
            candidate: message.candidate,
          };
          sink.push(await dispatchAndTrack(phase, request));
          // A finding accepted after verification already ran has not itself been through
          // contradiction/dedup — the completion gate's `passes` must not stay stale-true.
          if (phase === 'verifying' && verificationRan) passesStale = true;
          break;
        }
        case 'checkpointSuggestion':
          await fireCheckpoint(phase, 'modelSuggested');
          break;
        case 'completionRequest': {
          if (phase === 'verifying' && passesStale) await runSynthesisVerification();
          const request: HostToolRequest = {
            tool: 'requestCompletion',
            requestId: nextRequestId(),
            elapsedMs: clock(),
            purpose: 'verification',
            hostInitiated: false,
            memberId: message.memberId,
          };
          const result = await dispatchAndTrack(phase, request);
          sink.push(result);
          if (result.state === 'complete' && result.content.tool === 'requestCompletion' && result.content.response.granted) {
            completionGranted = true;
          }
          break;
        }
        default: {
          const exhaustive: never = message;
          void exhaustive;
        }
      }
    }
    return { hadActionableWork: turnHasActionableWork(messages), completionGranted };
  }

  /** One phase's model-turn loop: reserve a turn, run it (bounded protocol repair is `runHarnessTurn`'s own job), process the batch, repeat until `shouldStop()`, a turn carries no actionable work, budget/cancellation stops it, or repairs are exhausted. Every exit proceeds onward to host validation (D11) rather than failing silently. */
  async function runPhaseLoop(phase: RunPhase, shouldStop: () => boolean): Promise<StopReason> {
    for (;;) {
      if (isCancelled()) return 'cancelled';
      if (shouldStop()) return 'condition';
      const requestId = nextRequestId();
      const reserved = budget.beginTurn({ requestId, purpose: choosePurpose(phase), elapsedMs: clock() });
      if (!reserved.ok) return reserved.code === 'cancelled' ? 'cancelled' : 'budgetExhausted';

      const toolResultsForThisAsk = lastTurnResults;
      const askModel: PhaseAskModel = (repairInstruction) =>
        options.modelSeam.askModel({ phase, repairInstruction, toolResults: toolResultsForThisAsk, envelope: fittedEnvelope });
      const outcome = await runHarnessTurn(askModel, { phase, previousPlan: plan, policy, cancellation });

      if (!outcome.ok) {
        const detail = outcome.reasons.map((r) => r.message).join('; ') || 'no further detail';
        appendActivity({ kind: 'toolFailed', tool: 'modelTurn', reason: `${outcome.failureKind}: ${detail}` }, phase);
        return outcome.failureKind === 'cancelled' ? 'cancelled' : 'repairExhausted';
      }

      const sink: HostToolResult[] = [];
      const processed = await processMessages(phase, outcome.messages, sink);
      lastTurnResults = sink;
      if (phase === 'verifying' && processed.completionGranted) return 'condition';
      if (!processed.hadActionableWork) return 'noActionableWork';
    }
  }

  // ---- Bootstrap/inventory ----------------------------------------------------------

  function buildContextDeclaration(): string {
    return options.members
      .map((member) => {
        const context = snapshotMember(member.memberId).context;
        const bits = context.autoContextEnabled
          ? [
              `title ${context.titleIncluded ? 'included' : 'excluded'}`,
              `description ${context.descriptionIncluded ? 'included' : 'excluded'}`,
              `${context.linkedItemIdsIncluded.length} linked item(s)`,
            ]
          : ['no auto-context'];
        bits.push(`${context.attachments.length} attachment(s)`);
        return `${member.memberId}: ${bits.join(', ')}`;
      })
      .join(' | ');
  }

  /** One `AGENTS.md` root-policy identity per member (task 15.1 fix — see the file header). */
  function rootPoliciesFor(): readonly BootstrapMemberRootPolicy[] {
    return options.members.map((member): BootstrapMemberRootPolicy => {
      const resolved = snapshotMember(member.memberId).rootAgentsPolicy;
      // `text` is optional on `BootstrapPolicySource`: the snapshot (D3) carries only identity
      // (sourceId/digest), never content, and `resolvePolicy` is not bootstrap-legal (its
      // `allowedPhases` excludes `bootstrap`, `harnessTools.ts`) — presence/identity is honest
      // without a fresh fetch here.
      const source: BootstrapPolicySource = resolved.present
        ? { present: true, sourceId: resolved.sourceId, digest: resolved.digest }
        : { present: false };
      return { memberId: member.memberId, source };
    });
  }

  interface PendingAttachmentRegistration {
    readonly memberId: string;
    readonly attachment: Attachment;
    readonly expectedDigest: string;
  }

  /**
   * Renders this member's explicit attachments exactly once (task 15.2:
   * `renderAttachmentsForModel` is the single computation of "what the model
   * is shown" — the bootstrap section below and the ledger registration
   * both read the same budgeted result, so they cannot drift from each
   * other). Returns the bootstrap-envelope section (always) and the
   * registration work (only for attachments the snapshot actually declared
   * for this member — an input attachment with no matching declaration is
   * never registered, and is reported as a limitation rather than silently
   * dropped, matching the `bootstrapDetailUnavailable` precedent above).
   */
  function attachmentSectionsFor(member: HarnessAttemptMemberInput): {
    readonly sections: readonly BootstrapAttachmentSection[];
    readonly pending: readonly PendingAttachmentRegistration[];
  } {
    const originals = member.attachments ?? [];
    if (originals.length === 0) return { sections: [], pending: [] };
    const rendered = renderAttachmentsForModel(originals);
    const declaredAttachments = snapshotMember(member.memberId).context.attachments;
    const sections: BootstrapAttachmentSection[] = [];
    const pending: PendingAttachmentRegistration[] = [];
    for (const budgeted of rendered.attachments) {
      sections.push({ id: budgeted.id, label: budgeted.label, path: budgeted.path, content: budgeted.content, truncated: budgeted.truncated });
      const original = originals.find((candidate) => candidate.id === budgeted.id);
      const declared = declaredAttachments.find((candidate) => candidate.attachmentId === budgeted.id);
      if (!original || !declared) {
        extraLimitations.push({
          code: 'attachmentNotDeclared',
          message: `Attachment ${budgeted.id} for member ${member.memberId} was supplied to the attempt but is not declared in the run snapshot; it will not become citable.`,
        });
        continue;
      }
      // `registerAttachment` (D3/D8) hashes `attachment.content` against the snapshot's digest of
      // the *full* pre-budget content, then uses `visibleContentLength` to bound what is citable —
      // so the object passed here keeps the original's full content and only carries budgeting's
      // computed truncation forward, never the budgeted (marker-appended) content itself.
      pending.push({
        memberId: member.memberId,
        attachment: { ...original, truncated: budgeted.truncated, visibleContentLength: budgeted.visibleContentLength },
        expectedDigest: declared.contentDigest,
      });
    }
    return { sections, pending };
  }

  async function fetchMemberSections(member: HarnessAttemptMemberInput): Promise<BootstrapMemberSections> {
    const snap = snapshotMember(member.memberId);
    const requestId = nextRequestId();
    const request: HostToolRequest = {
      tool: 'getChangeRequestDetails',
      requestId,
      elapsedMs: clock(),
      purpose: 'exploration',
      hostInitiated: true,
      memberId: member.memberId,
      request: { snapshot: { repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha }, number: snap.ref.number },
    };
    const result = await dispatchAndTrack('bootstrap', request);
    let detail: NormalizedDetail;
    let providerState: 'complete' | 'paginated' | 'truncated' = 'truncated';
    let providerCursor: InvestigationCursor | undefined;
    if ((result.state === 'complete' || result.state === 'paginated' || result.state === 'truncated') && result.content.tool === 'getChangeRequestDetails') {
      detail = JSON.parse(result.content.detailJson) as NormalizedDetail;
      providerState = result.state;
      providerCursor = result.state === 'paginated' ? result.cursor : undefined;
    } else {
      detail = { title: '(unavailable)', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: ALL_DETAIL_SECTIONS };
      extraLimitations.push({ code: 'bootstrapDetailUnavailable', message: `Change-request details for member ${member.memberId} could not be fetched for bootstrap.` });
    }
    const digest = sha256Hex(canonicalStringify(detail));
    const section = buildBootstrapSection({
      kind: 'changeRequestDetails',
      sectionId: `crd:${member.memberId}`,
      detail,
      digest,
      providerState,
      providerCursor,
      maxInlineChars: policy.maxToolResultBytes,
    });
    // Issue-detail bootstrap sections are never fetched: `getIssueDetails` needs an explicit
    // `issueRepoId`, which `ReviewRunContextSelections.linkedItemIdsIncluded` does not carry
    // (only numbers) — see the file header.
    return { memberId: member.memberId, changeRequestDetails: section, issueDetails: [] };
  }

  async function pageManifestToExhaustion(member: HarnessAttemptMemberInput): Promise<void> {
    const snap = snapshotMember(member.memberId);
    let cursor: string | undefined;
    for (;;) {
      const request: HostToolRequest = {
        tool: 'listChangedFiles',
        requestId: nextRequestId(),
        elapsedMs: clock(),
        purpose: 'exploration',
        hostInitiated: true,
        memberId: member.memberId,
        request: { snapshot: { repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha }, cursor },
      };
      const result = await dispatchAndTrack('bootstrap', request);
      if (result.state === 'paginated') {
        cursor = result.cursor;
        continue;
      }
      break; // complete / truncated / unavailable / refused all end this member's paging.
    }
  }

  async function runBootstrap(): Promise<{ ok: true } | { ok: false; limitation: Limitation }> {
    currentPhase = 'bootstrap';
    // Task 14.6: the attempt-boundary narrative and the carried plan land in THIS attempt's own
    // log before its first checkpoint — `buildCheckpoint`'s `plan` scans the log for the latest
    // `planCreated`/`planRevised` fact rather than reading a value passed alongside it, so an
    // attempt interrupted before its own first planning turn would otherwise report no plan at all,
    // silently losing "preserve the plan" a second time on a resume-of-a-resume.
    if (resumeSeed) {
      appendActivity({ kind: 'actionStarted', action: resumeSeed.startAction }, 'bootstrap');
      if (resumeSeed.payload.plan) appendActivity(planCreatedFact(resumeSeed.payload.plan), 'bootstrap');
    }
    await fireCheckpoint('bootstrap', 'phaseBoundary');
    appendActivity({ kind: 'actionStarted', action: 'Assembling bootstrap and the changed-file inventory.' }, 'bootstrap');

    const memberIdentities: BootstrapMemberIdentity[] = options.members.map((member) => {
      const snap = snapshotMember(member.memberId);
      return { memberId: member.memberId, repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha };
    });
    const memberSections: BootstrapMemberSections[] = [];
    const pendingAttachments: PendingAttachmentRegistration[] = [];
    for (const member of options.members) {
      const sections = await fetchMemberSections(member);
      const attachmentWork = attachmentSectionsFor(member);
      memberSections.push({ ...sections, attachments: attachmentWork.sections });
      pendingAttachments.push(...attachmentWork.pending);
    }

    const envelope = buildBootstrapEnvelope({
      members: memberIdentities,
      personaLabel: snapshot.personaLabel,
      agentInstructions: snapshot.agentInstructions,
      criteria: snapshot.criteria,
      effort: snapshot.effort,
      effortInstruction: effortPrompt(snapshot.effort),
      contextDeclaration: buildContextDeclaration(),
      rootPolicies: rootPoliciesFor(),
      toolContractVersion: snapshot.toolContractVersion,
      harnessPolicyVersion: snapshot.harnessPolicyVersion,
      memberSections,
    });

    const fit = await fitBootstrapToModel({
      envelope,
      maxInputTokens: snapshot.modelCapability?.maxInputTokens,
      countTokens: options.countTokens ?? (async () => undefined),
    });
    if (!fit.ok) return { ok: false, limitation: fit.limitation };

    // Task 15.2's citability boundary: an attachment becomes a citable ledger source only here,
    // after the envelope carrying it is confirmed to actually fit the model — never earlier (an
    // overflowing bootstrap makes no model request, so nothing in it was ever returned).
    // Task 15.7 closure: the ledger's own minted `sourceId`/`digest` for each successfully
    // registered attachment is captured here (keyed by member+attachment id, the same identity
    // `BootstrapAttachmentSection.id` already carries) so the envelope patch below can tell the
    // model exactly what to cite back — without this, an attachment registered as evidence could
    // never actually be cited in a live run (the gap task 15.1-15.3 named explicitly).
    const registeredAttachmentSources = new Map<string, { sourceId: string; digest: string }>();
    for (const entry of pendingAttachments) {
      const outcome = ledger.registerAttachment(entry.memberId, entry.attachment, entry.expectedDigest);
      if (!outcome.ok) {
        extraLimitations.push({
          code: 'attachmentRegistrationFailed',
          message: `Attachment ${entry.attachment.id} for member ${entry.memberId} could not be registered as evidence: ${outcome.code}.`,
        });
        continue;
      }
      registeredAttachmentSources.set(attachmentSourceKey(entry.memberId, entry.attachment.id), {
        sourceId: outcome.source.sourceId,
        digest: outcome.source.digest,
      });
    }

    // The *fitted* envelope, never the pre-fit local above: `fitBootstrapToModel`
    // may have summarized sections or minimized tool descriptions to make it
    // fit, and the raw envelope built above was never confirmed to fit the
    // model at all (see `HarnessModelSeam.envelope`'s own doc comment). Patched
    // with each registered attachment's citable identifiers — the shrink
    // tactics (`withSectionsSummarized`/`withMinimalToolDescriptions`) never
    // touch attachment sections, so this patch is safe regardless of whether
    // the envelope needed to shrink to fit.
    fittedEnvelope = {
      ...fit.envelope,
      untrusted: fit.envelope.untrusted.map((section) => ({
        ...section,
        attachments: section.attachments?.map((attachment) => {
          const registered = registeredAttachmentSources.get(attachmentSourceKey(section.memberId, attachment.id));
          return registered ? { ...attachment, sourceId: registered.sourceId, digest: registered.digest } : attachment;
        }),
      })),
    };

    for (const member of options.members) await pageManifestToExhaustion(member);
    appendActivity(coverageChangedFact(inventory, riskCoverageRules.requireInspection), 'bootstrap');
    return { ok: true };
  }

  // ---- Planning, risk classification, investigation ----------------------------------

  async function runPlanning(): Promise<void> {
    currentPhase = 'planning';
    await fireCheckpoint('planning', 'phaseBoundary');
    appendActivity({ kind: 'actionStarted', action: 'Planning the review.' }, 'planning');
    await runPhaseLoop('planning', () => plan !== undefined);
  }

  /**
   * `investigating`'s loop stops on the same stall signal `verifying` does
   * (a turn with no actionable work), never on a host-computed "coverage
   * looks complete" check: a candidate-finding submission cites evidence
   * from an *earlier* turn's dispatch (D8's byte-identity rule), so it is
   * structurally at least one turn behind the read that produced it — a
   * host stop condition keyed on inventory coverage alone would end the
   * loop the instant the last file is read, before the model gets the turn
   * it needs to submit what it found. `evaluateCompletion` (in `completing`)
   * remains the authoritative coverage check either way (D11); this loop
   * only decides how many turns the model gets to work with.
   */
  async function runInvestigating(): Promise<void> {
    currentPhase = 'investigating';
    await fireCheckpoint('investigating', 'phaseBoundary');
    classifyAllUnvisited();
    appendActivity({ kind: 'actionStarted', action: 'Investigating changed files.' }, 'investigating');
    await runPhaseLoop('investigating', () => false);
  }

  // ---- Synthesis, verification, host validation, persistence -------------------------

  async function runVerifying(): Promise<void> {
    currentPhase = 'verifying';
    await fireCheckpoint('verifying', 'phaseBoundary');
    appendActivity({ kind: 'actionStarted', action: 'Synthesizing and verifying findings.' }, 'verifying');
    await refreshHeads();
    await runSynthesisVerification();
    await runPhaseLoop('verifying', () => false);
  }

  async function runCompleting(): Promise<CompletionEvaluation> {
    currentPhase = 'completing';
    await fireCheckpoint('completing', 'phaseBoundary');
    await refreshHeads();
    return currentCompletionEvaluation();
  }

  async function runPersisting(evaluation: CompletionEvaluation): Promise<HarnessAttemptResult> {
    currentPhase = 'persisting';
    const cancelledNow = isCancelled();
    // D11: cancellation preserves only already-*validated* findings, as partial — never routed
    // through synthesis/dedup, and never eligible to replace a complete retained review.
    const findings = cancelledNow ? candidateTracker.triageFindings() : survivingFindings;
    const limitations = [...extraLimitations, ...budget.warnings().map(budgetWarningLimitation)];
    const outcome = classifyOutcome(evaluation, findings.length, { cancelled: cancelledNow, limitations });
    const lifecycle: RunLifecycle = cancelledNow ? 'cancelled' : outcome.completeness === 'complete' ? 'succeeded' : 'failed';
    if (!isTerminalLifecycle(lifecycle)) {
      throw new Error(`HarnessAttempt computed a non-terminal lifecycle at persistence: ${lifecycle}`);
    }
    appendActivity({ kind: 'terminalResult', lifecycle, completeness: outcome.completeness, limitations: outcome.limitations }, 'persisting');
    // Reported after the terminal fact above, deliberately without `fireCheckpoint`'s own marker
    // event (see `reportCheckpoint`'s doc comment) — this is the checkpoint that must land in
    // `HarnessRunStore` as terminal.
    await reportCheckpoint(mintId('ckpt'), 'persisting', 'phaseBoundary');
    const attemptOutcome: HarnessAttemptOutcome = { lifecycle, outcome, findings, plan, cancelled: cancelledNow, contradicted: latestContradicted };
    await onPersist?.(attemptOutcome, activityLog);
    const consumption = budget.consumption();
    return {
      runId,
      lineageId,
      attempt: attemptNumber,
      lifecycle,
      outcome,
      findings,
      plan,
      activityLog,
      cancelled: cancelledNow,
      small: smallFlag,
      turnsUsed: consumption.modelTurnsUsed,
      toolCallsUsed: consumption.toolCallsUsed,
      contradicted: latestContradicted,
    };
  }

  function computeSmallFlag(): void {
    let fileCount = 0;
    let totalBytes = 0;
    for (const member of inventory.members()) {
      for (const file of member.files) {
        fileCount += 1;
        totalBytes += file.byteSize ?? 0;
      }
    }
    smallFlag = isSmallReview(fileCount, totalBytes, policy);
  }

  async function finalizeBootstrapFailure(limitation: Limitation): Promise<HarnessAttemptResult> {
    currentPhase = 'persisting';
    appendActivity({ kind: 'terminalResult', lifecycle: 'failed', completeness: 'none', limitations: [limitation] }, 'bootstrap');
    // Reported after the terminal fact, same as `runPersisting` — a bootstrap failure must also
    // land terminal in `HarnessRunStore` rather than leaving the lineage looking merely stalled.
    await reportCheckpoint(mintId('ckpt'), 'bootstrap', 'phaseBoundary');
    const outcome: CompletionOutcome = {
      kind: 'failed',
      completeness: 'none',
      findingCount: 0,
      limitations: [limitation],
      replacesRetainedReview: false,
      clean: false,
    };
    const attemptOutcome: HarnessAttemptOutcome = { lifecycle: 'failed', outcome, findings: [], plan: undefined, cancelled: false, contradicted: [] };
    await onPersist?.(attemptOutcome, activityLog);
    const consumption = budget.consumption();
    return {
      runId,
      lineageId,
      attempt: attemptNumber,
      lifecycle: 'failed',
      outcome,
      findings: [],
      plan: undefined,
      activityLog,
      cancelled: false,
      small: false,
      turnsUsed: consumption.modelTurnsUsed,
      toolCallsUsed: consumption.toolCallsUsed,
      contradicted: [],
    };
  }

  async function run(): Promise<HarnessAttemptResult> {
    const bootstrapOutcome = await runBootstrap();
    if (!bootstrapOutcome.ok) return finalizeBootstrapFailure(bootstrapOutcome.limitation);

    computeSmallFlag();

    if (!isCancelled()) await runPlanning();
    if (plan === undefined) extraLimitations.push({ code: 'noPlan', message: 'No plan was ever created for this attempt.' });
    if (!isCancelled() && plan !== undefined) await runInvestigating();
    if (!isCancelled()) await runVerifying();

    const evaluation = await runCompleting();
    return runPersisting(evaluation);
  }

  return { run };
}
