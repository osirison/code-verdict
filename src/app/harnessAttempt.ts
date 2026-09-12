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
import type { AgentCancellationToken, ModelTurnTiming } from './lmAgent';
import type { AgentTimeoutReason } from './agentTrace';
import { runWithRetry, retryBackoffPolicyFrom } from './harnessRetry';
import type { RetryState } from './harnessCheckpoint';
import {
  INVESTIGATION_MAP_OFF_MANIFEST_SHOWN,
  type InvestigationMapFile,
  type InvestigationMapMember,
  type InvestigationSubmission,
  promptByteLength,
  PromptCeilingExceededError,
  type PromptBudgetOverrun,
} from './harnessModelSeam';
import {
  admitContent,
  describeDeferral,
  describeExceedsAllowance,
  describeFramingOverrun,
  formatExactBytes,
  resolvePromptBudget,
  type ContentSizeEstimate,
} from '../domain/harnessPromptBudget';
import { sanitizePublicText } from './harnessActivitySanitizer';
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
  forecastCoverageShortfall,
  respondToCompletionRequest,
  type CompletionClause,
  type CompletionEvaluation,
  type CompletionEvaluationInput,
  type CompletionOutcome,
  type CompletionRequestResponse,
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
  toolCapabilityAvailable,
  type DispatchControl,
  type DispatcherMember,
  type HostToolDispatcher,
  type HostToolRequest,
  type HostToolResult,
  type HostToolRetryOptions,
} from './harnessToolDispatcher';
import { runHarnessTurn, type AskModel as PhaseAskModel } from './harnessTurn';
import { HARNESS_TOOL_CONTRACT_VERSION, hostToolDefinition } from '../domain/harnessTools';
import { renderAttachmentsForModel, type Attachment } from './reviewContext';
import {
  buildBootstrapEnvelope,
  buildBootstrapSection,
  HOST_TOOL_CATALOG,
  type BootstrapAttachmentSection,
  type BootstrapEnvelope,
  type BootstrapMemberIdentity,
  type BootstrapMemberRootPolicy,
  type BootstrapMemberSections,
  type BootstrapPolicySource,
  type BootstrapToolSchema,
} from '../domain/harnessBootstrap';
import { fitBootstrapToModel } from './harnessBootstrapBudget';
import type { Limitation, Plan, RunPhase } from '../domain/harnessActivity';
import type { BudgetConsumption, FileInspectionState, MemberCoverage, RiskLevel, UnresolvedWork } from '../domain/harnessCoverage';
import { effortPrompt } from '../domain/effort';
import { isTerminalLifecycle, type RunLifecycle } from '../domain/harnessLifecycle';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import type { ParsedToolCall, ProtocolMessage } from '../domain/harnessProtocol';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { Connection, MemberCapabilities } from '../platform/provider';
import type {
  ChangedFileEntry,
  CurrentHeadResult,
  DetailSection,
  InvestigationCursor,
  InvestigationSource,
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
    /**
     * What the model has already gathered across the whole attempt — every changed file, which of
     * them have been read, and the sourceIds held for each. Passed per call rather than built into
     * the seam because it changes with every tool result, and passed at all because without it the
     * model's only memory is `toolResults` above: one turn deep. A run against a 26-file change
     * spent 234 of 256 tool calls re-fetching what it had already seen and finished with no
     * findings. Optional for the same reason as `envelope` — a hand-built test seam is not forced
     * to supply one — and `runPhaseLoop` always does.
     */
    investigation?: readonly InvestigationMapMember[];
    /**
     * Every candidate the model has submitted this attempt, in submission order — the output-side
     * counterpart of `investigation`, and passed for the same reason: without it a stateless model
     * cannot know whether it has recorded anything yet, and a live run that had read everything
     * restarted reading from the top four times rather than submit (see
     * `harnessModelSeam.ts`'s `InvestigationSubmission`). Optional for the same reason as
     * `investigation` — a hand-built test seam is not forced to supply one — and `runPhaseLoop`
     * always does.
     */
    submissions?: readonly InvestigationSubmission[];
    /**
     * Fires exactly once per raw model call, on every exit — a received reply, an empty reply,
     * AND a thrown transport failure — with a real duration, two byte counts and an outcome tag,
     * from `../app/lmAgent.ts`'s own `streamText` (`ModelTurnTiming`, imported type-only so this
     * module stays free of `vscode`), never a second, independently-measured timing. Firing on a
     * thrown failure too means `askModel`'s own promise can still reject after this ran — the
     * timing is reported first, the failure propagates second, both are real. Optional so a hand-
     * built test seam (`harnessTurn.test.ts`'s scripted `AskModel`, this module's own synthesis-
     * verification default) is never forced to supply one; `createLiveModelSeam` (`./harnessModelSeam.ts`)
     * is the only production caller that has anything to report through it.
     */
    onTiming?: (timing: ModelTurnTiming) => void;
    /**
     * Told when the assembled prompt could not be held under
     * `HarnessPolicy.maxPromptBytesPerTurn` by composition alone — see
     * `harnessModelSeam.ts`'s `PromptBudgetOverrun`. This module turns it into a public activity
     * event and an attempt limitation, because a prompt that had to have results dropped, or a
     * review whose own framing does not fit its cap, is a fact the reviewer is entitled to rather
     * than something to absorb quietly.
     */
    onPromptOverrun?: (overrun: PromptBudgetOverrun) => void;
  }): Promise<string>;
  /**
   * The assembled size, in bytes, of the prompt these inputs would produce — the seam's own
   * renderer, asked rather than re-implemented.
   *
   * `runPhaseLoop` calls this before each tool dispatch to decide whether the next result still
   * fits the turn (see `serveWithinPromptBudget`). Optional, and `undefined` is a legitimate
   * answer: a hand-built test seam or the demo participant renders nothing this module could
   * measure, and a seam that cannot measure its own prompt simply serves every request as it
   * always did. `createLiveModelSeam` — the only seam a real review ever runs on — always answers.
   */
  measurePromptBytes?(input: {
    phase: RunPhase;
    toolResults: readonly HostToolResult[];
    envelope?: BootstrapEnvelope;
    investigation?: readonly InvestigationMapMember[];
    submissions?: readonly InvestigationSubmission[];
  }): number | undefined;
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
  /** Same reporting seam `HarnessModelSeam.askModel`'s own `onTiming` field documents — the contradiction-check pass (`./harnessSynthesisVerification.ts`'s `runContradictionChecks`) calls `askModel` directly, outside `runPhaseLoop`'s own turn loop, so without this its model-wait time would silently disappear from the diagnostics report's totals instead of landing in `verifying`. */
  readonly onModelTurnTiming?: (timing: ModelTurnTiming) => void;
}

/** One finding the contradiction pass excluded, with a bounded public reason — task 10.6's collaborator (`./harnessSynthesisVerification.ts`) populates this so a contradicted finding is recorded, never silently dropped; the honest no-op default below and any collaborator that skips the stage simply omit it. */
export interface ContradictedFindingRecord {
  readonly candidateId: string;
  readonly reason: string;
}

/**
 * One *surviving* finding whose contradiction check did not happen or did not
 * conclude, with why — the opposite outcome to `ContradictedFindingRecord` and
 * deliberately its own type, because the consequence is the opposite too: this
 * finding is KEPT and still reaches the reviewer. A collaborator reporting any
 * of these must also report `contradictionPassComplete: false`; the flag says
 * the stage did not finish, these say which findings that was about.
 */
export interface UnverifiedFindingRecord {
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
  /** Optional: surviving findings the contradiction pass could not check, each with why (see `UnverifiedFindingRecord`). */
  readonly unverified?: readonly UnverifiedFindingRecord[];
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
 *
 * `attemptFailed` is the opposite case: it *is* produced by this module's own
 * `fireCheckpoint`, from `run()`'s top-level catch-all
 * (`finalizeEscapedError` below) — the one other way `run()` itself can end,
 * when an error escapes every phase runner instead of resolving through the
 * normal `runCompleting` -> `runPersisting` funnel (a model-turn transport
 * failure such as a provider timeout is the motivating case; see that
 * function's own doc comment). Never produced anywhere `runPersisting`/
 * `finalizeBootstrapFailure` already ran to completion for this attempt.
 */
export const CHECKPOINT_REASONS = ['phaseBoundary', 'toolCadence', 'modelSuggested', 'attemptInterrupted', 'attemptFailed'] as const;

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
  /**
   * Fix 1's live attempt-level counter (`modelRetryTransientAttempts`) — model-turn retries only
   * (see that field's own doc comment for why tool-call retries stay unwired here, as before).
   * `harnessCheckpoint.ts`'s `CheckpointBuildInput.retry` already accepts this shape
   * (`INITIAL_RETRY_STATE` was its only value until now); a caller building a `PersistedCheckpoint`
   * from this `CheckpointInfo` need only forward it to make `PersistedCheckpoint.retry` truthful for
   * model-turn retries. Production wiring (`harnessRuntime.ts`'s `onCheckpoint` closure, which lists
   * `buildAndWriteCheckpoint`'s input fields explicitly rather than spreading this object) is left
   * for that module's own owner to add — see this fix's own final report for the exact line.
   * Optional, matching `CheckpointBuildInput.retry`'s own convention (`buildCheckpoint` defaults a
   * missing one to `INITIAL_RETRY_STATE`) — `reportCheckpoint` always supplies it for a real
   * attempt; a hand-built test fixture predating this fix is not forced to.
   */
  readonly retry?: RetryState;
}

export type OnCheckpoint = (info: CheckpointInfo) => void | Promise<void>;

export interface HarnessAttemptOutcome {
  readonly lifecycle: RunLifecycle;
  readonly outcome: CompletionOutcome;
  readonly findings: readonly ValidatedFinding[];
  readonly plan?: Plan;
  /**
   * The model's own closing statement, from the `completionRequest` the host granted. Absent
   * whenever no model turn produced one — a host-synthesized completion (`noActionableWork`,
   * `repairExhausted`), a cancellation, or a bootstrap failure — so a reader must never treat its
   * absence as "the model had nothing to say".
   */
  readonly conclusion?: string;
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
  readonly capabilities: MemberCapabilities;
  /**
   * What serves this member's five revision-pinned operations — the local
   * object store, chosen once by source selection before this attempt was built
   * (`add-local-git-investigation` task 9.1).
   *
   * Required. It was optional while a connection could serve them itself, and
   * that fallback is gone: a member whose source could not be obtained never
   * reaches an attempt.
   *
   * The snapshot records which kind was chosen
   * (`ReviewRunMemberSnapshot.investigationSource`); this is the live object
   * itself, which a snapshot cannot carry.
   */
  readonly investigationSource: InvestigationSource;
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
  /**
   * A fact the caller established *before* this attempt was built that makes it
   * unable to start — today exactly one: no investigation source can serve one
   * of its members (`add-local-git-investigation` task 9.3, design D5's third
   * branch). The attempt ends before bootstrap with completeness `none` and
   * this limitation, the same shape and the same code path a bootstrap envelope
   * that does not fit already ends with (`finalizeBootstrapFailure`).
   *
   * It is carried here rather than thrown by the caller for one reason: a
   * rejection from the factory settles as a generic run failure with a single
   * message, while this shape puts the terminal fact in the attempt's own
   * activity log and its own terminal checkpoint, which is what a reviewer and
   * the diagnostics report actually read. No model turn, no tool call and no
   * provider fetch happens on this path.
   */
  readonly preflightFailure?: Limitation;
  /**
   * Facts about this attempt that the caller established before building it and
   * that do not stop it from running — today, that the source it would have
   * preferred for investigation was unavailable, with the reason (design D8,
   * task 9.1). Appended to the attempt's own limitations, so a run that
   * succeeded through the second source still reports which one it used.
   */
  readonly limitations?: readonly Limitation[];
  /**
   * Work the caller did on this attempt's behalf before it was built, replayed
   * into this attempt's activity log as its first events — today, obtaining the
   * pinned commits into a local object store (`add-local-git-investigation`
   * task 10.2, `investigationSourceSelection.ts`).
   *
   * Replayed rather than streamed because there is nowhere to stream to: the
   * manager learns what a run is doing from the checkpoints this attempt
   * reports (`HarnessAttemptRunOptions.onCheckpoint`), and no attempt exists
   * while selection is still deciding which source there will be. Replaying
   * puts the fetch in the log, the projection, the first checkpoint and the
   * diagnostics report, which is everywhere a reviewer actually reads. The
   * facts carry their own `durationMs`, so a first review of a large repository
   * shows how long the fetch really took even though the attempt's own clock
   * started after it.
   *
   * Every fact still goes through `appendActivityEvent`'s sanitizer like any
   * other; nothing here is a second way into the log.
   */
  readonly preludeActivity?: readonly ActivityFact[];
}

export interface HarnessAttemptResult {
  readonly runId: string;
  readonly lineageId: string;
  readonly attempt: number;
  readonly lifecycle: RunLifecycle;
  readonly outcome: CompletionOutcome;
  readonly findings: readonly ValidatedFinding[];
  readonly plan?: Plan;
  /** See `HarnessAttemptOutcome.conclusion`. */
  readonly conclusion?: string;
  readonly activityLog: ActivityLog;
  readonly cancelled: boolean;
  readonly small: boolean;
  readonly turnsUsed: number;
  readonly toolCallsUsed: number;
  readonly contradicted: readonly ContradictedFindingRecord[];
  /**
   * `runCompleting`'s own `evaluateCompletion` verdict, verbatim — every D11 clause's pass/fail,
   * not just `outcome.blockerDetails`' bounded failures (task: a diagnostics command needs "every
   * completion clause with pass/fail", which `CompletionOutcome` alone never carried). `undefined`
   * only when a bootstrap failure ended the attempt before `runCompleting` ever ran
   * (`finalizeBootstrapFailure`) — there is no evaluation to report, not an empty one.
   */
  readonly completionEvaluation?: CompletionEvaluation;
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

/** Whether a turn's batch contains any work the host should act on beyond bookkeeping — the stall signal that ends a phase's loop (advisor-reviewed addition: a turn with none of this is the model saying "done here"). This catches a model that *stops*; it cannot catch one that runs in place, which is `turnAdvancedTheReview`'s job below. */
function turnHasActionableWork(messages: readonly ProtocolMessage[]): boolean {
  return messages.some((message) => message.kind === 'toolRequest' || message.kind === 'candidateSubmission' || message.kind === 'planCreated' || message.kind === 'planRevised' || message.kind === 'completionRequest');
}

/**
 * The half of `turnHasActionableWork` that is progress on the review's own terms, rather than a
 * request to go on looking: a submitted candidate, a shaped plan, or an explicit completion ask.
 * Deliberately NOT tool requests — those are counted as progress only when they actually changed
 * coverage state, which `runPhaseLoop` measures against the inventory (the same collaborator the
 * completion gate reads), not against the requests themselves. A live run against a 26-file
 * change is why the distinction exists: the model reached full coverage and then kept sending
 * eight `readDiff` re-reads of already-inspected files every turn — actionable work by the test
 * above, forever — so the stall machinery never fired, `investigating` never ended, and the run
 * hung until an external watchdog killed it with zero findings submitted. A turn that asks only
 * for what the host already gave it is, once nothing the phase owns is missing, the loop-shaped
 * equivalent of stopping — `runPhaseLoop`'s doc comment carries the deliberately asymmetric
 * handling of the two cases.
 */
function turnAdvancedTheReview(messages: readonly ProtocolMessage[]): boolean {
  return messages.some((message) => message.kind === 'candidateSubmission' || message.kind === 'planCreated' || message.kind === 'planRevised' || message.kind === 'completionRequest');
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
  /**
   * How many of this turn's tool requests the per-turn prompt budget **deferred** — the
   * re-requestable kind, and deliberately not the terminal kind.
   *
   * Read by `runPhaseLoop`'s run-in-place check, which ends a phase when a turn adds no coverage
   * and no evidence. A deferred request adds neither by construction, so without this a model that
   * over-asked once would be nudged toward completion for it — punished for asking. A request
   * refused *terminally* (`exceedsAllowance`) is the opposite case and is counted nowhere: the
   * first one changes the inventory, so that turn is productive on its own; a model that keeps
   * asking for the same unservable file after that is running in place, which is exactly what the
   * existing check is for and how this budget converges instead of ping-ponging.
   */
  readonly deferredForPromptBudget: number;
}

/**
 * `investigating`/`verifying` only (see `runPhaseLoop`'s own doc comment): the two phases whose
 * loop a model can end early by simply sending a turn with nothing actionable in it, and whose
 * D11 completion clauses can still be unmet at that moment. `planning`'s own `shouldStop` already
 * gates on a plan existing — a model that stops there with none is reported as `noPlan` (`run()`
 * below), never nudged into inventory/coverage work `evaluateCompletion` was never asked to judge
 * before a plan exists.
 */
const EARLY_STOP_NUDGE_PHASES: ReadonlySet<RunPhase> = new Set<RunPhase>(['investigating', 'verifying']);

/**
 * Bounds the fix below: a model that keeps stopping without doing anything must not turn one
 * phase into an unbounded loop. Deliberately its own documented constant, not a reuse of
 * `HarnessPolicy.protocolRepairsPerPhase` — that field bounds retries after a *malformed* turn
 * (`harnessTurn.ts`), a different failure mode from a well-formed turn that simply asks for
 * nothing. Every nudge still costs at least one real model turn (`budget.beginTurn` at the top of
 * every loop iteration runs regardless), so this is a bound on top of budget exhaustion, not a
 * replacement for it.
 */
const MAX_EARLY_STOP_NUDGES_PER_PHASE = 3;

/**
 * What one tool result costs the assembled prompt on top of its own content, when nothing has been
 * measured yet this turn.
 *
 * This is a floor under a measurement, not a margin standing in for one: `serveWithinPromptBudget`
 * re-measures the real assembled prompt after every dispatch anyway, so the true overhead of this
 * turn's own previous result is known exactly and `TurnContentBudget.overheadBytes` is raised to
 * it. The floor governs two cases the measurement cannot: a decision taken before any result of
 * this turn carried content, and the byte or two by which the *next* result costs more than the
 * one that was measured. The second is not hypothetical — with the floor removed, the sweep below
 * charges a 59,714-byte first read's measured 455-byte overhead to a second read whose own path is
 * one character longer, admits it at exactly the boundary, assembles 120,001 bytes and drops it.
 *
 * **Where the number comes from.** Driven through the real runtime on a two-file review at a
 * 120,000-byte cap, sweeping the second read's size, a read was fetched-then-dropped anywhere in
 * the 455 bytes above the true fit: the rendered envelope (`[result N] tool=readDiff member=…
 * state=complete units=… sourceId=ev_… digest=… (CITABLE)`) plus the map line flipping from
 * `not read` to `read` and gaining the 35-character source id. That fixture has two short paths
 * and an unbounded map; a bounded map (above `INVESTIGATION_MAP_FULL_LISTING_MAX`) also reveals a
 * previously elided unread line and rewrites its elision counter when a file flips, and real
 * repository paths are longer. 1 KB covers those.
 *
 * **What it costs, measured on the same sweep.** The largest second read that still shares a turn
 * with a 59,714-byte first read falls from 50,000 bytes to about 49,431 — 1.1% of that read, and
 * one extra turn for a file landing in the gap. Nothing goes unread for it: the deferred request
 * is re-asked and served on the next turn, which
 * `harnessPromptBudgetHonesty.assurance.test.ts` holds to by asserting, across twenty-four seeded
 * reviews, both no overrun *and* that every changed file was still read.
 */
const RESULT_OVERHEAD_FLOOR_BYTES = 1024;

/**
 * Room held back for one dispatch the model sent later in the same turn as a read and that skips
 * admission entirely: a candidate submission, or a completion request.
 *
 * Neither is ever deferred — a finding is work the model has already done, and refusing it would
 * throw the work away and buy a whole resubmission turn; a completion request is the model asking
 * a question the host must answer — so the only place their bytes can be accounted for is against
 * the reads that precede them. Its cost is its result envelope plus the
 * investigation-map line it adds from that turn on, and the expensive case is a *refused* one:
 * `renderSubmission` prints the validation reason under the line, bounded at
 * `INVESTIGATION_MAP_REASON_MAX` (300 characters), and the result envelope repeats the same
 * reasons as JSON.
 *
 * **Measured.** Each refused submission in `harnessPromptBudgetHonesty.assurance.test.ts`'s
 * eight-submission turn adds 551 bytes to the assembled prompt. Without this reservation that turn
 * served a 107,000-byte read and then assembled 121,370 bytes against a 120,000-byte cap — 1,370
 * bytes of submission cost the read had already been admitted against, and five results dropped at
 * render. 1 KB is set above the 551 measured because that fixture's refusal reasons are well short
 * of the 300-character bound; it is held back only on a turn that actually carries submissions,
 * and only for the ones still ahead of the request being admitted.
 */
const PROJECTED_SUBMISSION_BYTES = 1024;

/**
 * Clauses `investigating` can still act on when a turn stops early. `headUnchanged` and the four
 * `verifying`-only clauses (`everyRetainedCitationValid`, `contradictionPassComplete`,
 * `deduplicationComplete`, `finalVerificationComplete`) have not run yet at this point in the
 * attempt — `refreshHeads`/`runSynthesisVerification` are only ever called from `runVerifying`
 * (this module's own header: "the head check... refreshed on entry to verifying"; "synthesis and
 * verification... both run inside verifying") — so a raw `evaluateCompletion()` reports every one
 * of them failing during `investigating` regardless of how much coverage is actually done. Worse,
 * an unverified head check fails with blocker `providerLimit`, which is not in
 * `REPAIRABLE_BLOCKERS` (`harnessCompletion.ts`) — so left unscoped, that one always-present
 * failure would mark the *whole* evaluation unrepairable and silence the nudge below on every
 * single `investigating` phase, healthy or not, defeating the fix it exists to make. Restricting
 * to the clauses `investigating` actually owns leaves every clause's own pass/fail verdict exactly
 * as `evaluateCompletion` computed it — this only decides which of those verdicts this phase
 * should act on, not a second predicate for any of them. `verifying` needs no equivalent
 * restriction: by the time its own loop can reach this branch, `runVerifying` has already
 * refreshed heads once and reconciled any stale verification pass
 * (`runPhaseLoop`'s own call below, mirroring `processMessages`'s `completionRequest` case), so
 * every clause reflects real, current state there.
 */
const INVESTIGATING_RELEVANT_CLAUSES: ReadonlySet<CompletionClause> = new Set<CompletionClause>([
  'inventoryCompleteForEveryMember',
  'everyFileClassified',
  'configuredRiskCoverageSatisfied',
  'noUnresolvedFetches',
  'noUnresolvedCandidates',
]);

/**
 * A view of `evaluation` restricted to `clauses` — the same fields `respondToCompletionRequest`
 * reads (`eligible`/`details`/`blockers`/`repairable`), recomputed from the restricted detail set
 * rather than the whole-attempt one. Every detail kept is `evaluateCompletion`'s own, byte for
 * byte; none of its pass/fail reasoning is redone here.
 */
function scopedForNudge(evaluation: CompletionEvaluation, clauses: ReadonlySet<CompletionClause>): CompletionEvaluation {
  const details = evaluation.details.filter((detail) => detail.clause !== undefined && clauses.has(detail.clause));
  const eligible = details.length === 0;
  return {
    ...evaluation,
    eligible,
    details,
    blockers: [...new Set(details.map((detail) => detail.blocker))],
    repairable: !eligible && details.every((detail) => detail.repairable),
  };
}

/**
 * Fix 1's retry classifier, passed to `askModelRetried`'s `runWithRetry` call as `isRetryable`.
 *
 * A *structural* check against `./lmAgent.ts`'s `AgentRunError` shape — deliberately never
 * `error instanceof AgentRunError`, which would require importing that class as a runtime value.
 * `lmAgent.ts` is the one module in this codebase that imports the real `vscode` package, so this
 * module (like `harnessToolDispatcher.ts`/`harnessTurn.ts` before it — see their own headers)
 * imports only its *types* from there (`AgentCancellationToken`, `ModelTurnTiming`); a value import
 * would load `vscode` transitively into every test that exercises `createHarnessAttempt`, none of
 * which mock it (`lmAgent.test.ts` is the one file that does). Mirrors `AgentCancellationToken`'s
 * own doc comment in `lmAgent.ts`: "Declared structurally rather than imported as a type so a
 * caller can hand in a real one and a test can hand in an object literal" — same reasoning, applied
 * to a runtime check instead of a type.
 *
 * `name === 'AgentRunError'` (always set by that class's constructor) plus the exact `timedOut`/
 * `timeoutReason` shape its two timeout-throwing branches use is enough to identify it without the
 * class reference: only `'firstOutput'` (no output at all) and `'inactivity'` (output, then
 * silence) qualify — see `AgentTimeoutReason` (`./agentTrace.ts`, imported type-only) for the full
 * set. `'ceiling'` also sets `timedOut: true` but is deliberately excluded (the model kept
 * answering, just past the whole run-window ceiling — retrying only doubles the wait for a cause a
 * retry cannot fix); `'caller'` never reaches the `timedOut` check because that branch throws with
 * `timedOut: false` (the reviewer's own cancellation, not a failure).
 */
function isRetryableModelTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'AgentRunError') return false;
  const record = error as { timedOut?: unknown; timeoutReason?: AgentTimeoutReason };
  return record.timedOut === true && (record.timeoutReason === 'firstOutput' || record.timeoutReason === 'inactivity');
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
  /** Fix 1 (a model round trip consumes the transient retry budget instead of killing the attempt): the same policy subset `harnessToolDispatcher.ts` derives for its own provider-call retries, reused here for a model round trip's own bounded retry — one policy, two retry-wrapped seams, never a second set of numbers to keep in sync. */
  const modelRetryBackoffPolicy = retryBackoffPolicyFrom(policy);
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
  /** See `HarnessAttemptOutcome.conclusion` — set once, by a granted `completionRequest`. */
  let conclusion: string | undefined;
  let lastTurnResults: readonly HostToolResult[] = [];
  let toolCallsSinceCheckpoint = 0;
  let smallFlag = false;
  // Seeded with whatever the caller established before this attempt existed —
  // today, that its preferred investigation source could not be used and why
  // (`add-local-git-investigation` task 9.1/design D8). They are attempt
  // limitations like any other: reported on the terminal result, carried into
  // every checkpoint, and never silently dropped because the attempt went on to
  // succeed with the other source.
  const extraLimitations: Limitation[] = [...(options.limitations ?? [])];
  let latestHeads: readonly MemberHeadCheck[] = [];
  let latestCitations: CitationRevalidationSummary = { revalidated: false, invalidatedCount: 0 };
  let latestPasses: VerificationPasses = { contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false };
  let survivingFindings: readonly ValidatedFinding[] = [];
  let verificationRan = false;
  let passesStale = false;
  /** The contradiction pass's exclusions (task 10.6's collaborator's `output.contradicted`), captured here so `fireCheckpoint`/`runPersisting` can hand them to the checkpoint collaborator and `HarnessAttemptOutcome` instead of dropping them at this closure's boundary. */
  let latestContradicted: readonly ContradictedFindingRecord[] = [];
  /**
   * Set the moment `runPersisting`/`finalizeBootstrapFailure` succeeds in writing this attempt's
   * one terminal checkpoint — read by `finalizeEscapedError` (`run()`'s catch-all) so an error that
   * escapes *after* that point (e.g. from `onPersist`) can never write a second, competing terminal
   * checkpoint over an attempt that already correctly closed itself.
   */
  let terminalCheckpointWritten = false;
  /**
   * Fix 1's attempt-level retry counter — the one `harnessCheckpoint.ts`'s own header says does not
   * exist yet ("No attempt-level retry counter exists yet to read... wiring one through is
   * integration work"). Scoped to model-turn retries only (tool-call transient attempts stay
   * unwired, exactly as before this fix — out of its scope): every inline backoff wait
   * `askModelRetried` actually takes, across every `planning`/`investigating`/`verifying`/
   * `verifying`-contradiction-check round trip this attempt makes, in lineage order. `waiting` in
   * the `RetryState` this feeds `reportCheckpoint` is always `false` — a model round trip's own
   * long-delay classification (9.6's `'wait'` outcome) is treated as a failure here, never an actual
   * paused/resumed state (see `askModelRetried`'s own doc comment), so there is never a real
   * "waiting on a model retry" state to report.
   */
  let modelRetryTransientAttempts = 0;
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
  /**
   * Per member, the paths the model asked for that this member's manifest does not contain, and
   * how many such requests have been answered. Read by `investigationMap` into
   * `InvestigationMapMember.offManifestPaths`, which carries the whole story of why this exists.
   *
   * A `Set` because insertion order is the recency order the map wants, and because a repeated
   * guess must bump its position rather than add a second row — the measured failure was the same
   * wrong path six times, so de-duplication is most of what keeps this list short. `requests`
   * counts every off-manifest answer, repeats included, and is the only number the prompt claims
   * to be exact.
   */
  const offManifestByMember = new Map<string, { readonly paths: Set<string>; requests: number }>();

  /**
   * Which file each `readDiff` request marked inspected, keyed by the request id its result
   * carries — the only identifier a `HostToolResult` has in common with the request that produced
   * it. `withholdEvidence` reads it when the renderer drops a result, to put the file it belongs
   * to back to unread.
   *
   * Bounded by `maxToolRequestsPerAttempt` and holding two short strings per entry, so it is not
   * a memory concern, and it is deliberately not pruned per turn: a drop is detected while the
   * *next* prompt is being assembled, which is after the turn that produced the result has ended.
   */
  const inspectedByRequestId = new Map<string, { readonly memberId: string; readonly path: string }>();

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
      retry: { waiting: false, transientAttempts: modelRetryTransientAttempts },
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
      // Required: an attempt only exists for members whose source was obtained,
      // and the three forge-only operations keep using `connection` above.
      investigationSource: member.investigationSource,
    };
  });

  // Reads `AGENTS.md` from the same source the member's diffs come from — it is
  // a file in the repository at the base revision, which is git's to answer.
  const agentsPolicyResolver = createAgentsPolicyResolver(
    (member) => inputMembersById.get(member.memberId)?.investigationSource,
    { capabilities: (member) => inputMembersById.get(member.memberId)?.capabilities.reviewInvestigation },
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
    clock,
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

  /** Metadata shared by every `toolCompleted`/`toolFailed` fact `recordToolActivity` appends — read straight off `result` (`harnessToolDispatcher.ts`'s `dispatch` already timed the call and surfaced its own retry-wait accounting), never recomputed here. */
  function callMetadataFor(result: HostToolResult): Pick<HostToolResult, never> & { durationMs?: number; memberId?: string; bytesReceived?: number; resultState?: string; retryWaitMs?: number; retryCount?: number } {
    return {
      durationMs: result.durationMs,
      memberId: result.memberId,
      bytesReceived: result.bytes,
      resultState: result.state,
      retryWaitMs: result.retryWaitMs,
      retryCount: result.retryCount,
    };
  }

  function recordToolActivity(phase: RunPhase, request: HostToolRequest, result: HostToolResult): void {
    const target = pathOrIdOf(request);
    const metadata = callMetadataFor(result);
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        const paginationNote = result.state === 'paginated' ? ' (more available)' : result.state === 'truncated' ? ' (truncated by the provider)' : '';
        appendActivity({ kind: 'toolCompleted', tool: request.tool, target, summary: `${result.unitsReturned} unit(s) returned${paginationNote}.`, ...metadata }, phase);
        return;
      }
      case 'refused':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: result.reason, ...metadata }, phase);
        return;
      case 'binary':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: 'The content is binary.', ...metadata }, phase);
        return;
      case 'tooLarge':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: 'The content is too large to return.', ...metadata }, phase);
        return;
      case 'unavailable':
      case 'notFound':
      case 'contentDeclined':
      case 'unknown':
        appendActivity({ kind: 'toolFailed', tool: request.tool, target, reason: result.reason, ...metadata }, phase);
        return;
      default: {
        const exhaustive: never = result;
        void exhaustive;
      }
    }
  }

  /**
   * One `tool: 'modelTurn'` fact per raw model call, `toolCompleted` or `toolFailed` matching
   * `timing.outcome` — `lmAgent.ts`'s `streamText` now fires `onTiming` on every exit path,
   * including a thrown transport failure (timeout, cancellation, no model, bad contract), not
   * only a received reply. Without the `toolFailed` branch, a call that died mid-stream reported
   * no duration at all, and its wall-clock time silently misattributed to host time in the
   * diagnostics report — the exact distortion this whole feature exists to avoid. Fired once per
   * actual `askModel` round trip, not once per `runHarnessTurn` call: a repaired turn (D5 rule 5)
   * makes several raw calls before it either parses or exhausts its repair allowance, and every
   * one of them is real model wait time the diagnostics report must account for. How many tool
   * calls a turn's own messages went on to request is never stored here — the report derives it
   * by counting the real tool-call facts between one `modelTurn` fact and the next
   * (`harnessDiagnostics.ts`), so this stays a plain timing record, nothing more.
   */
  function recordModelTurnTiming(phase: RunPhase, timing: ModelTurnTiming): void {
    const summary = `Model call: ${timing.promptBytes} byte(s) sent, ${timing.replyBytes} byte(s) received.`;
    appendActivity(
      timing.outcome === 'completed'
        ? { kind: 'toolCompleted', tool: 'modelTurn', summary, durationMs: timing.durationMs, bytesSent: timing.promptBytes, bytesReceived: timing.replyBytes }
        : { kind: 'toolFailed', tool: 'modelTurn', reason: summary, durationMs: timing.durationMs, bytesSent: timing.promptBytes, bytesReceived: timing.replyBytes },
      phase,
    );
  }

  /**
   * Fix 1 (the incident this closes): a real harness run's second model call
   * (`lm:ollama-models/glm-5.3`, cloud-proxied) produced zero output for 300s;
   * `lmAgent.ts`'s `streamText` threw `AgentRunError(timedOut: true, timeoutReason: 'firstOutput')`;
   * nothing between there and `run()`'s own catch-all retried it or even slowed it down — Ollama's
   * access log showed exactly two POSTs despite `transientRetriesPerOperation: 3`, because model
   * turns never entered `harnessRetry.ts`'s bounded-retry loop at all; only provider tool calls did
   * (`harnessToolDispatcher.ts`'s `executeWithRetry`). This wraps every real model round trip
   * (`options.modelSeam.askModel`) in the same bounded transient retry, so a stall consumes the
   * budget instead of killing the attempt on the first one.
   *
   * **Seam.** Wraps the `askModel` closure `runPhaseLoop` builds for `runHarnessTurn` (below) and
   * `runSynthesisVerification`'s own `modelSeam.askModel` override for the contradiction-check
   * pass — every direct `options.modelSeam.askModel` call site in this module. `runHarnessTurn`
   * itself is never touched: it retries each round trip independently, repair turns (D5 rule 5)
   * included, and `runPhaseLoop`'s existing `PromptCeilingExceededError` handling (a prompt-ceiling
   * error is a budget statement, never a stall) stays exactly as it was — that error is thrown by
   * the seam's own prompt renderer before a request is ever sent, so it never reaches `call()` here
   * at all. `harnessBootstrapBudget.ts`'s bootstrap-fit check calls only `countTokens`, never
   * `askModel` — no model round trip happens there, so nothing to wrap.
   *
   * **Retry set.** Only what `isRetryableModelTimeout` (below) accepts: a thrown `AgentRunError`
   * (`./lmAgent.ts`) with `timedOut === true` and `timeoutReason` `'firstOutput'` (never started
   * answering) or `'inactivity'` (went silent mid-reply) — the two "no output"/"stalled output"
   * reasons a fresh attempt can plausibly fix. `'ceiling'` (the model was answering, just too slowly
   * — a retry only doubles the worst-case wait for a cause retrying cannot help) and `'caller'` (the
   * reviewer's own cancellation, `timedOut: false` besides) are never retried; neither is any
   * non-`AgentRunError` throw (a bad-contract `AgentResponseError`/`SyntaxError`, an unavailable
   * model). All of those are `nonRetryable` after exactly one attempt — the same single-attempt
   * behavior this fix replaces *only* for the two stall reasons above, never widened beyond them.
   *
   * **Taxonomy.** `harnessRetry.ts`'s own header says it "introduces no second retryability
   * taxonomy": `runWithRetry` only ever retried a *thrown error classified through `ScmError`*. An
   * `AgentRunError` is not an `ScmError` — `../platform/errors.ts`'s own header says providers "map
   * their HTTP reality onto these kinds", and a model stall is this host's own timer firing, not
   * provider HTTP reality, so mapping it into `toScmError` would corrupt what `ScmErrorKind` means.
   * Instead this passes `isRetryable: isRetryableModelTimeout` — `runWithRetry`'s new, explicit
   * classifier override (header/tests/design.md D12 amended alongside it) — so the module still
   * invents no taxonomy of its own; it retries exactly the one classifier a caller hands it, exactly
   * as it already did with its own default.
   *
   * **Budget.** No new model-turn reservation: `runPhaseLoop`'s `budget.beginTurn` already reserves
   * one `modelTurns` unit per phase-loop iteration, *before* this wrapper's closure is ever
   * invoked — every repair ask and every retry of every repair ask happens underneath that one
   * reservation, exactly mirroring `harnessToolDispatcher.ts`'s own convention (`dispatch` reserves
   * one `toolCalls` unit once, then `executeWithRetry` retries underneath it without a second
   * reservation per attempt). A timed-out-and-retried turn is counted the way a timed-out-and-
   * retried tool call already is: once.
   *
   * **Idempotence.** `idempotent: true`, always — a model round trip resends the identical rendered
   * prompt and asks again; it is a re-issuable read of "what does the model say to this text", never
   * a side effect a retry could duplicate (submitting a finding, posting a review). Unlike
   * `HostToolDefinition.idempotent`, there is no per-call choice to thread through: every
   * `askModel` call this module makes is this same kind of call.
   *
   * **Every `RetryOutcome` kind, explicitly:**
   * - `'ok'`: the round trip's own text, returned.
   * - `'nonRetryable'` / `'exhausted'`: the underlying error, rethrown unchanged — it escapes exactly
   *   as it did before this fix (through `runHarnessTurn`, through `runPhaseLoop`'s catch, which
   *   only absorbs `PromptCeilingExceededError`), and Fix 2's `finalizeEscapedError` writes the
   *   terminal `'failed'` checkpoint from it.
   * - `'elapsedBudgetExceeded'`: a public note that another retry would cross this attempt's own
   *   elapsed-time budget, then the underlying error, rethrown — same escape path.
   * - `'wait'`: with this policy's defaults a model-turn delay cannot exceed `backoffMaxMs` (the
   *   default `longDelayThresholdMs`), so this should never fire in production — handled
   *   defensively anyway, as a failure carrying a limitation, never a silent hang: this host has no
   *   pause/resume machinery for a model round trip the way `harnessToolDispatcher.ts`'s 9.6 does
   *   for a tool call (there is no `DispatchControl`-shaped re-issue for "the model's next turn"),
   *   so a long delay here is reported and the underlying error is rethrown, same escape path again.
   * - `'cancelled'`: the reviewer's own cancellation firing mid-backoff-wait, which carries no
   *   `error` of its own (`RetryOutcome`'s shape) — rethrows whatever the *last* real attempt in this
   *   round trip actually failed with, tracked locally, since that is the truthful proximate cause;
   *   a placeholder message only when no attempt ever ran (cancelled before the first try).
   *
   * **Diagnostics.** Every raw attempt already gets its own `modelTurn` `toolCompleted`/`toolFailed`
   * fact "for free" — `onTiming` fires on every exit path of every real call `lmAgent.ts` makes,
   * retried or not, so a retried round trip already shows each stall as its own activity line. What
   * did not exist before is a *retry* fact: when `retryStats.retryCount > 0`, one more `modelTurn`
   * fact is appended for the round trip as a whole, carrying `retryWaitMs`/`retryCount` — the same
   * two fields `harnessToolDispatcher.ts`'s own retries already attach to a `HostToolResult`
   * (`ActivityCallMetadata`'s existing fields; no new activity kind). `modelRetryTransientAttempts`
   * (this closure's own running total) feeds `reportCheckpoint`'s `retry: RetryState` the same way —
   * see that field's own doc comment for why `waiting` stays `false`.
   */
  async function askModelRetried(phase: RunPhase, call: () => Promise<string>): Promise<string> {
    const retryStats = { retryWaitMs: 0, retryCount: 0 };
    let lastAttemptError: unknown;
    const outcome = await runWithRetry(
      async () => {
        try {
          return await call();
        } catch (error) {
          lastAttemptError = error;
          throw error;
        }
      },
      {
        idempotent: true,
        policy: modelRetryBackoffPolicy,
        elapsedMsAtStart: clock(),
        cancellation,
        isRetryable: isRetryableModelTimeout,
        now: options.retry?.now,
        random: options.retry?.random,
        sleep: options.retry?.sleep,
        longDelayThresholdMs: options.retry?.longDelayThresholdMs,
        hooks: {
          onRetryWait: (info) => {
            retryStats.retryWaitMs += info.delayMs;
            retryStats.retryCount += 1;
            modelRetryTransientAttempts += 1;
          },
        },
      },
    );
    if (retryStats.retryCount > 0) {
      appendActivity(
        outcome.kind === 'ok'
          ? { kind: 'toolCompleted', tool: 'modelTurn', summary: `Recovered after ${retryStats.retryCount} transient retry(ies).`, retryWaitMs: retryStats.retryWaitMs, retryCount: retryStats.retryCount }
          : { kind: 'toolFailed', tool: 'modelTurn', reason: `Still failing after ${retryStats.retryCount} transient retry(ies).`, retryWaitMs: retryStats.retryWaitMs, retryCount: retryStats.retryCount },
        phase,
      );
    }
    switch (outcome.kind) {
      case 'ok':
        return outcome.value;
      case 'nonRetryable':
      case 'exhausted':
        throw outcome.error;
      case 'elapsedBudgetExceeded':
        appendActivity({ kind: 'toolFailed', tool: 'modelTurn', reason: 'Retrying this stalled model turn again would exceed this attempt\'s own elapsed-time budget.' }, phase);
        throw outcome.error;
      case 'wait':
        appendActivity({ kind: 'toolFailed', tool: 'modelTurn', reason: 'A stalled model turn needed a longer retry wait than a model round trip can hold open; this host has no pause/resume path for one.' }, phase);
        throw outcome.error;
      case 'cancelled':
        throw lastAttemptError ?? new Error('The attempt was cancelled before a stalled model turn could be retried.');
      default: {
        const exhaustive: never = outcome;
        throw new Error(`askModelRetried: unhandled RetryOutcome kind ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /**
   * The per-turn prompt ceiling could not be held by composition alone — reported, never absorbed.
   *
   * Two conditions arrive here and they mean different things, so they are reported differently:
   *
   * - *Results were dropped.* The renderer had to leave whole tool results out of a prompt to keep
   *   it under `maxPromptBytesPerTurn`. That is this host's accounting missing, not the model's
   *   fault, and it costs the model evidence it had already paid for — so it becomes a public
   *   event and a limitation the reviewer sees, rather than a quieter prompt nobody notices. It is
   *   a backstop: `serveWithinPromptBudget` declines before dispatching, so in a healthy run this
   *   never fires, which is exactly what makes it worth reporting when it does.
   * - *The framing alone is over the cap.* Nothing can be dropped, because none of what is over is
   *   optional — persona, tool catalog, protocol contract, the change-request description. The run
   *   has no room to serve content at all, and the limitation says so in those words and names the
   *   setting, instead of leaving a reviewer to wonder why a review read nothing.
   *
   * One limitation per condition per attempt: a 40-turn review that is structurally over the cap
   * would otherwise push forty identical sentences at the reviewer. The activity trail keeps every
   * occurrence.
   */
  const promptOverrunReported = new Set<string>();
  function recordPromptOverrun(overrun: PromptBudgetOverrun): void {
    const framingOver = overrun.framingOverrunBytes > 0 || overrun.budget.framingOverrunBytes > 0;
    const reason = framingOver
      ? describeFramingOverrun(overrun.budget)
      : `The assembled prompt for a ${overrun.phase} turn reached ${formatExactBytes(overrun.assembledBytes)} bytes against a cap of ${formatExactBytes(overrun.budget.ceilingBytes)}, so ${overrun.droppedResults} tool result(s) were left out of it. Those requests were not shown to the model and remain available to it.`;
    appendActivity({ kind: 'toolFailed', tool: 'modelPrompt', reason }, overrun.phase);
    // Before the dedup guard below, and deliberately: the limitation is reported once per attempt
    // so a structurally over-cap review does not push forty identical sentences at the reviewer,
    // but every single drop has to be undone. Putting this after the guard would leave the second
    // and every later drop of an attempt recorded as a completed inspection.
    withholdEvidence(overrun);
    const key = framingOver ? 'framing' : 'dropped';
    if (promptOverrunReported.has(key)) return;
    promptOverrunReported.add(key);
    extraLimitations.push({ code: framingOver ? 'promptBudgetNoRoom' : 'promptBudgetOverrun', message: reason });
  }

  /**
   * Undoes what a dropped result was already recorded as having proved.
   *
   * **Why this exists, measured.** A `readDiff` result marks its file inspected and registers its
   * bytes as citable evidence the moment the dispatcher answers — both inside `dispatchAndTrack`,
   * both before the prompt that would carry the result is assembled. The renderer assembles that
   * prompt afterwards and drops whole results from the end when the ceiling cannot be held any
   * other way. Driven on a two-file review at a 120,000-byte cap, a second read anywhere in a
   * 455-byte window was fetched, marked inspected, and then removed from the prompt: the map told
   * the model the file was read, the completion gate counted it as satisfied, and the review
   * reported itself complete over a file the model never saw a byte of. That is the same lie the
   * whole of this work exists to remove — a clean review over unread code — arriving through our
   * own renderer instead of through a forge that declined to render a diff.
   *
   * Two things are withdrawn, and the second is not optional either:
   *
   * - *The inspection.* `inventory.revokeInspection` puts the file back to `classified`: unread,
   *   still worth asking for, and still blocking completion. `markInspected`'s contract is that
   *   the caller attests model-visible evidence; the attestation was false, so it is withdrawn.
   * - *The evidence.* `ledger.revoke` stops the source being citable. A citation is validated
   *   against the ledger's digest, and a digest the model was never shown is content it can only
   *   have invented — which is exactly the fabrication the ledger exists to refuse. The record
   *   stays in append order with its bytes still charged, because the fetch really happened.
   *
   * One inconsistency is accepted rather than papered over: *this* prompt's investigation map was
   * rendered inside the same assembly that decided the drop, so it still says `read` for a file
   * whose content was withheld — beside the renderer's own line saying results were withheld and
   * to ask again. The next prompt's map is correct, which is the turn at which the model acts on
   * it. Fixing the current one would mean rendering the map after the drop and re-measuring, which
   * is circular: the map is part of what the ceiling is measured against. The map can still name
   * the revoked source id on that one page, so the model can try to cite it — which is exactly why
   * the ledger entry is revoked and not merely hidden: `harnessCitations.ts` refuses it by name.
   *
   * One window is left open and named rather than half-closed: a checkpoint written between the
   * dispatch and the drop (`fireCheckpoint` runs on tool-call cadence, inside the turn) records
   * the file as inspected and its source as retained, and a resume from *that* checkpoint replays
   * both. The next checkpoint of this attempt writes the corrected state, so the window is the
   * process dying inside one turn; closing it properly means rewriting an already-persisted
   * checkpoint, which is a different mechanism from this budget.
   *
   * Not every dropped result has something to withdraw. A search or a file read registers evidence
   * but inspects nothing; a submission result records a finding that really was recorded, whose
   * state and reason the next turn's map carries anyway.
   *
   * **And the file is closed when the drop proved it can never fit.** Revoking alone is honest and
   * non-terminating: driven against a provider whose manifest said 1,000 bytes and whose diff
   * returned 130,000 against a 120,000-byte cap, the file went back to unread, the model read its
   * own map, asked again, and the host fetched and dropped it 24 times before the attempt ran out
   * of budget. The measurement the drop produces is exactly what settles it — the result's real
   * content size, which nothing before the fetch knew — so a result whose content alone exceeds
   * the turn's whole content allowance is marked `oversized`, the same terminal state a
   * manifest-predicted oversized file already gets, and the map stops listing it as work to do. A
   * drop with content that *does* fit the allowance was caused by something else in the turn (a
   * protocol repair instruction appended after serving) and is left re-askable, because that file
   * will fit perfectly well on a turn without one.
   */
  function withholdEvidence(overrun: PromptBudgetOverrun): void {
    let coverageChanged = false;
    for (const result of overrun.withheld) {
      if (result.state !== 'complete' && result.state !== 'paginated' && result.state !== 'truncated') continue;
      if (result.sourceId !== undefined) ledger.revoke(result.sourceId);
      const target = inspectedByRequestId.get(result.requestId);
      if (target === undefined) continue;
      const revoked = inventory.revokeInspection(target.memberId, target.path);
      if (revoked.ok && revoked.changed) coverageChanged = true;
      const contentBytes = servedContentBytes(result);
      const tooLargeForAnyTurn = contentBytes !== undefined && contentBytes > overrun.budget.contentAllowanceBytes;
      const reason = tooLargeForAnyTurn
        ? `This file's diff returned ${formatExactBytes(contentBytes)} bytes — more than this turn's whole content allowance of ${formatExactBytes(overrun.budget.contentAllowanceBytes)} (the prompt cap is ${formatExactBytes(overrun.budget.ceilingBytes)}), and more than the size its manifest entry reported. It was fetched and could not be shown to you, so no turn of this attempt can carry it. Review the rest of the change and say in a finding or rationale that this file went unread.`
        : `This diff was fetched but never shown to you: the prompt that would have carried it was over its ${formatExactBytes(overrun.budget.ceilingBytes)}-byte cap. The file counts as unread and its evidence is not citable — ask for it again, on a turn with fewer other requests.`;
      if (tooLargeForAnyTurn) {
        const closed = inventory.markTerminal(target.memberId, target.path, 'oversized', reason);
        if (closed.ok && closed.changed) coverageChanged = true;
      }
      appendActivity({ kind: 'toolFailed', tool: 'readDiff', target: target.path, reason }, overrun.phase);
    }
    if (coverageChanged) appendActivity(coverageChangedFact(inventory, riskCoverageRules.requireInspection), currentPhase);
  }

  /** `unvisited -> classified`, using only the deterministic host floor (D10; see the file header's documented protocol gap). */
  function ensureClassified(memberId: string, file: InventoryFileRecord): void {
    if (file.state !== 'unvisited') return;
    const entry: ChangedFileEntry = {
      path: file.path,
      oldPath: file.oldPath,
      kind: file.kind,
      binary: file.binary,
      contentDeclined: file.contentDeclined,
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

  /**
   * Remembers one path the model asked for that is not in the member's change.
   *
   * The prompt is stateless, so an answer the host does not write down is an answer the next turn
   * cannot have. A 207-file live review asked for 13 paths that were not in the change at all, up
   * to six times each, 57 tool calls in total, because the host answered "no such path" and kept
   * nothing: `updateInventoryFromResult` looked the path up in the inventory, found nothing, and
   * returned. This is the write that was missing.
   *
   * `sanitizePublicText` for the same reason every other model-supplied string that reaches an
   * output channel goes through it — this one is echoed back into every later prompt, and
   * `normalizeEvidencePath` (which the caller already applied) rejects traversal and NUL but caps
   * no length and strips no control characters. A path so malformed that normalization rejected it
   * never reaches here at all; it is refused a turn earlier and simply not remembered, which costs
   * at most a repeat of a request no reasonable model makes twice.
   *
   * Bounded at `INVESTIGATION_MAP_OFF_MANIFEST_SHOWN`, dropping the least recently guessed: a
   * confused (or hostile) model can mint unlimited path strings, and this list is re-sent every
   * turn. What is dropped is the count of distinct paths, never the count of requests — the map
   * prints the exact request total instead of pretending to an elision count this cannot keep.
   */
  function recordOffManifestPath(memberId: string, rawPath: string): void {
    const path = sanitizePublicText(rawPath);
    if (path === undefined) return;
    const entry = offManifestByMember.get(memberId) ?? { paths: new Set<string>(), requests: 0 };
    offManifestByMember.set(memberId, entry);
    entry.requests += 1;
    entry.paths.delete(path); // a repeated guess moves to the front of the queue, it does not add a row
    entry.paths.add(path);
    while (entry.paths.size > INVESTIGATION_MAP_OFF_MANIFEST_SHOWN) {
      const oldest = entry.paths.values().next().value;
      if (oldest === undefined) break;
      entry.paths.delete(oldest);
    }
  }

  /** Bridges a `readDiff` result back into inventory state (task 10.3): the dispatcher has no inventory dependency of its own (`harnessToolDispatcher.ts`'s header), so this is the one place a tool result becomes a coverage transition. Only `readDiff` counts as inspection (D10: "Inspection requires model-visible diff evidence"); `readFile`/search results never do. */
  function updateInventoryFromResult(request: HostToolRequest, result: HostToolResult): void {
    if (request.tool !== 'readDiff') return;
    const memberId = request.memberId;
    const path = normalizeEvidencePath(request.request.path);
    if (!path) return;
    const file = inventory.file(memberId, path);
    if (!file) {
      // The one state that proves a path is absent from the change rather than merely unreadable.
      // A `complete` read of a path the manifest has not enumerated yet, or a `binary`/`tooLarge`
      // answer for one, says nothing about whether the change contains it — telling the model
      // "not in this change" on that evidence would be a lie it cannot check. Only `readDiff`
      // reaches here at all (this function's own header), which is also the only tool for which
      // "not in this change" is the right thing to say: `readFile` targets repository content,
      // where a path outside the change is legitimate, not a mistake to be refused once.
      if (result.state === 'notFound') recordOffManifestPath(memberId, path);
      return;
    }
    ensureClassified(memberId, file);
    switch (result.state) {
      case 'complete':
      case 'paginated':
      case 'truncated': {
        // Remembered so a later drop can find its way back here. A `HostToolResult` carries no
        // path, only the `requestId` it answers, and by the time the renderer decides what will
        // not fit the request itself is long out of scope — see `withholdEvidence`.
        //
        // `changed` and not merely `ok`: a model re-reading a file it inspected three turns ago,
        // to cite it in this turn's submission, gets `changed: false` because the file is already
        // inspected. Recording that read here would let a drop of it revoke an inspection whose
        // evidence the model really did see — putting a genuinely read file back to unread and
        // buying a refetch for nothing.
        const inspection = inventory.markInspected(memberId, path);
        if (inspection.ok && inspection.changed) inspectedByRequestId.set(request.requestId, { memberId, path });
        break;
      }
      case 'binary':
        inventory.markTerminal(memberId, path, 'binary', 'The provider reported this file as binary.');
        break;
      case 'contentDeclined':
        // The whole point of `add-local-git-investigation` task 3.5, in one
        // arm: no `markTerminal`. The source enumerated this file and would
        // not serve its content, which says nothing about the content — the
        // same two commits read by another source produce the diff exactly.
        // Marking it terminal here is what made 137 of one measured change's
        // 207 plain-TypeScript files permanently uninspectable, and then let
        // the run report itself complete and clean, because the gate counts
        // `binary` as satisfied. It stays classified and unread, which the
        // gate refuses to call complete (`harnessCompletion.ts`, the
        // `declinedContent` blocker).
        inventory.markContentDeclined(memberId, path);
        break;
      case 'tooLarge':
        // The host's own reason when it has one — the per-turn prompt budget declining a file no
        // turn of this attempt can carry (`serveWithinPromptBudget`). A provider's own `tooLarge`
        // carries none, and keeps the sentence it always had.
        inventory.markTerminal(memberId, path, 'oversized', result.reason ?? 'The diff for this file exceeded what the provider could return.');
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
      case 'unknown':
        // No `markTerminal` here either, and for a stronger reason than the
        // declined arm above: this state is the source saying it established
        // nothing at all. The local source answers `unknown` for an invocation
        // stopped at a time or output bound, a pinned revision the object store
        // cannot resolve, and a diff that failed for a path the manifest had
        // just enumerated — an object store evicted mid-attempt is exactly
        // that, with both commits still resolvable. Closing the file on any of
        // them would record a state nobody proved.
        //
        // What was missing was the other half. Recording nothing at all left
        // the file merely `classified`, and a merely-classified file blocks
        // completion only when its risk demands inspection — so a low-risk file
        // whose every read failed left the gate eligible with zero blockers,
        // and the run ended complete and clean. Design D8 promises the
        // opposite in its closing sentence; `markReadFailed` is what makes the
        // promise true, at every risk level (`harnessCompletion.ts`, the
        // `readFailed` blocker).
        //
        // No `deferred` guard, unlike the `unavailable` arm: a deferred result
        // is only ever minted by the dispatcher's `deferredForWait`, which
        // always emits `unavailable`, so an `unknown` here is always a real
        // answer from the source rather than a wait this dispatch chose.
        inventory.markReadFailed(memberId, path);
        break;
      default:
        // `refused` only — a request the host itself turned down (budget,
        // cancellation, validation) never reached the source, so it says
        // nothing about the file and records nothing against it.
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
      // Wrapped, not handed over bare: the contradiction pass calls `askModel` directly, outside
      // `runPhaseLoop`, so without this its prompts would be the one model call in the attempt
      // whose ceiling breach nobody heard about. Same reasoning as `onModelTurnTiming` below,
      // which exists because that call's duration went missing for the same structural reason.
      // Fix 1: also the one other direct `askModel` call site this module has (bootstrap fit never
      // calls `askModel` at all — see `askModelRetried`'s own doc comment) — wrapped through the
      // same bounded retry so a stalled contradiction-check turn is retried, not fatal.
      modelSeam: {
        ...options.modelSeam,
        askModel: (input) =>
          askModelRetried(input.phase, () => options.modelSeam.askModel({ ...input, onPromptOverrun: input.onPromptOverrun ?? ((overrun) => recordPromptOverrun(overrun)) })),
      },
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
      onModelTurnTiming: (timing) => recordModelTurnTiming('verifying', timing),
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
    // The same public trail for the opposite outcome. A finding whose check never
    // ran (`output.unverified`) is kept and reaches the reviewer looking exactly
    // like a checked one; without this event the only record is the aggregate
    // `contradictionPassComplete: false`, which names no finding. A distinct tool
    // name because the meaning is distinct: `contradictionCheck` above says the
    // finding was excluded, this says it was not checked.
    for (const entry of output.unverified ?? []) {
      appendActivity({ kind: 'toolFailed', tool: 'contradictionCheckSkipped', target: entry.candidateId, reason: entry.reason }, 'verifying');
    }
    verificationRan = true;
    passesStale = false;
  }

  // ---- Generic protocol-message processing, shared by planning/investigating/verifying ----

  /**
   * One turn's content accounting against `HarnessPolicy.maxPromptBytesPerTurn`.
   *
   * The rule the user asked for, in one sentence: serve the model's own requests in the order it
   * made them until the next result would breach the ceiling, then stop and say plainly which ones
   * were not served. An overshoot must cost nothing, so a deferred request is never dispatched —
   * no provider call, no evidence bytes, no tool-call budget — and, being nothing but a request
   * the model already knows how to make, it is simply re-requestable next turn. That is how
   * pagination already behaves here.
   *
   * **What is measured.** Not the sum of tool-result bytes, which is the easy number and the wrong
   * one: the guarantee is about the assembled prompt, so the assembled prompt is what is measured.
   * `modelSeam.measurePromptBytes` re-renders the real next prompt after every dispatch, with the
   * investigation map and submissions exactly as they stand, and the remainder is the ceiling
   * minus that. The framing is therefore re-measured as it grows within the turn rather than
   * estimated once — a file flipping to "read" changes the map, and the map is framing.
   *
   * **What can be predicted, and what cannot.** A whole-file `readDiff` has an exact size the
   * manifest already carried (`InventoryFileRecord.byteSize`), which is the request this has to
   * govern — it is what a model asks for eight at a time. A search, a file read, or a cursored
   * page does not, and the answer for those used to be "serve it while any room remains and let
   * the renderer drop it if it overshoots". That was wrong twice over. The measurement it leaned
   * on lied (see `AssembledModelPrompt` — the rendered size has already had results dropped out
   * of it, so it never reads above the cap), and dropping a dispatched result means a provider
   * call made and evidence bytes charged for content the model is never shown. So an unpredictable
   * request now reserves the most its page can return — the policy's own `searchResultPageBytes` /
   * `diffOrFileReadPageBytes`, never a number invented here — and is deferred when that will not
   * fit. The exception is a turn nothing has consumed yet, which serves whatever it is asked for:
   * `diffOrFileReadPageBytes` is above a whole turn's allowance at the shipped defaults, so
   * without it a `readFile` could never be served at all.
   *
   * **What the reservation costs:** a search asked for at the end of an already-full turn is
   * deferred and must be asked for again, one round trip later, instead of being fetched and
   * discarded. That is the trade taken deliberately — a deferral costs nothing and is re-askable,
   * a drop costs a provider call and buys nothing.
   *
   * **A result costs more than its content, and that difference used to be thrown away.** The
   * admission test compared the *content* size against the room left. What a result really adds to
   * the prompt is its content plus its rendered envelope (`[result N] tool=readDiff …
   * sourceId= digest= (CITABLE)`) plus the map line flipping from `not read` to `read` and gaining
   * the held source id. Driven on a two-file review at a 120,000-byte cap, sweeping the second
   * read's size, the difference measured 455 bytes:
   *
   *     50,000            served, assembled exactly 120,000
   *     50,001 - 50,45x   fetched, then dropped at render, assembled 120,001-120,45x
   *     50,46x +          deferred cleanly, nothing fetched
   *
   * — and the dropped read was still marked inspected, so coverage claimed a file the model never
   * saw. `observedOverheadBytes` closes it by measurement rather than by margin, which is what
   * this budget does everywhere else: the assembled prompt is re-measured after every dispatch
   * anyway, so the *real* overhead of this turn's own previous result is
   * `(assembledAfter - assembledBefore) - its content bytes`, and the next admission is charged
   * the largest one seen this turn. `RESULT_OVERHEAD_FLOOR_BYTES` is the floor for the case with
   * nothing yet to measure.
   *
   * **The two drops still reachable, and why each is left.** Both are reported as a
   * `promptBudgetOverrun` limitation *and* revoke what the dropped result was recorded as having
   * proved (`recordPromptOverrun`), so neither can produce a review that claims to have read
   * something it did not. Neither happens on a healthy run — `harnessPromptBudget.assurance.test.ts`
   * asserts zero over a driven review, and `harnessPromptBudgetHonesty.assurance.test.ts` asserts
   * zero over twenty-four seeded ones.
   *
   * 1. *A repair turn.* A turn served to the brim whose reply then fails to parse is re-asked with
   *    a protocol repair instruction appended (`buildRepairInstruction`, bounded at
   *    `MAX_REPAIR_INSTRUCTION_LENGTH`), which is bytes this budget did not count, so the renderer
   *    may drop that turn's last result. Reserving the margin here was considered and not taken:
   *    it would hold ~2 KB back from every turn of every review, and — because the allowance the
   *    *model* is told comes from the real assembled framing, not from this — the number the host
   *    enforces and the number the prompt announces would stop agreeing. A malformed model reply
   *    is not the normal path, the dropped request stays available to ask for again, and the file
   *    it belonged to goes back to unread rather than being counted as inspected.
   * 2. *A provider that returns more than it said it would.* Either an unpredictable page served
   *    under the untouched-turn waiver (the waiver exists because `diffOrFileReadPageBytes`,
   *    256 KB shipped, is above a whole turn's allowance, so a `readFile` or a cursored page has
   *    to be servable on an empty turn or never), or a manifest whose `byteSize` understates the
   *    diff the same provider then serves. Both are sizes the host cannot predict from anything it
   *    holds, so no accounting closes them; what closes the damage is that the drop revokes the
   *    inspection and the ledger entry, leaving the file honestly unread. A stubborn re-ask is
   *    first-of-turn again and is fetched and dropped again, until `runPhaseLoop`'s run-in-place
   *    bound ends the phase, and the completion gate then reports the file as one this attempt
   *    could not read.
   *
   * **Two turn-level numbers, held apart.** `allowanceBytes` is the whole content allowance
   * measured before anything was served, and it is what decides whether a file can *ever* be
   * served; `remainingBytes` is what is left right now, and it decides whether it can be served
   * *this* turn. A file bigger than the whole allowance is terminal, not deferred, because
   * deferring it would produce the identical refusal every turn forever — the ping-pong the design
   * explicitly forbids. Terminal here is slightly conservative: the allowance is measured against
   * this turn's framing, which is a few KB tighter than the best case, so a file sitting in that
   * narrow window is refused on a margin it might have squeezed past on turn one. That trade is
   * taken deliberately — one such file is better refused with a reason than served into a prompt
   * the model cannot answer.
   */
  interface TurnContentBudget {
    readonly ceilingBytes: number;
    readonly allowanceBytes: number;
    remainingBytes: number;
    /** The largest real per-result overhead measured so far *this turn* — see this comment block's own "A result costs more than its content". Starts at the floor. */
    overheadBytes: number;
    /** Re-requestable deferrals only — see `ProcessMessagesOutcome.deferredForPromptBudget` for why a terminal refusal is not counted here. */
    deferrals: number;
  }

  /** The prompt these results would produce, measured by the seam that renders it; `undefined` when this seam cannot render one (the demo participant, a hand-built test seam) — in which case no prompt budget applies and every request is served exactly as before. */
  function measureNextPrompt(phase: RunPhase, results: readonly HostToolResult[]): number | undefined {
    return options.modelSeam.measurePromptBytes?.({
      phase,
      toolResults: results,
      envelope: fittedEnvelope,
      investigation: investigationMap(),
      submissions: submissionsSummary(),
    });
  }

  /**
   * Two measurements, deliberately: the allowance is what the turn would have had with nothing
   * served at all, and the remainder is what it has right now. They differ when a turn submitted a
   * finding or asked to finish before its first read — small results, but the distinction is not
   * about their size. `allowanceBytes` decides whether a file can *ever* be served, and that answer
   * must not depend on what else happened to be in this particular turn.
   */
  function openTurnContentBudget(phase: RunPhase, served: readonly HostToolResult[]): TurnContentBudget | undefined {
    const framing = measureNextPrompt(phase, []);
    if (framing === undefined) return undefined;
    const ceilingBytes = policy.maxPromptBytesPerTurn;
    const allowanceBytes = Math.max(0, ceilingBytes - framing);
    const assembled = measureNextPrompt(phase, served);
    return {
      ceilingBytes,
      allowanceBytes,
      remainingBytes: assembled === undefined ? allowanceBytes : ceilingBytes - assembled,
      overheadBytes: RESULT_OVERHEAD_FLOOR_BYTES,
      deferrals: 0,
    };
  }

  /**
   * A host-built result for a request the budget never dispatched — the same two shapes the
   * dispatcher itself mints, so `harnessModelSeam.ts` renders them with no special case and the
   * model reads exactly one result per request it made. That 1:1 is not decoration: appending host
   * text to a turn's results instead was tried and rejected because it perturbs a healthy flow
   * (`harnessDemoParticipant.ts` treats an unexpected extra result as harness drift and fails
   * loudly, by design).
   */
  function budgetRefusal(request: HostToolRequest, reason: string): HostToolResult {
    return {
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      tool: request.tool,
      ...(request.memberId === undefined ? {} : { memberId: request.memberId }),
      state: 'refused',
      code: 'promptBudgetDeferred',
      reason,
    };
  }

  function budgetTooLarge(request: HostToolRequest, byteSize: number, reason: string): HostToolResult {
    return {
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: request.requestId,
      tool: request.tool,
      ...(request.memberId === undefined ? {} : { memberId: request.memberId }),
      state: 'tooLarge',
      byteSize,
      reason,
    };
  }

  /** The exact patch size the host already holds for a whole-file `readDiff`; `undefined` for every other request, and for a cursored page whose remaining bytes nothing here knows. */
  function knownResultBytes(request: HostToolRequest): number | undefined {
    if (request.tool !== 'readDiff' || request.request.cursor !== undefined) return undefined;
    const path = normalizeEvidencePath(request.request.path);
    if (!path) return undefined;
    return inventory.file(request.memberId, path)?.byteSize;
  }

  /**
   * The most a request can return, for the requests whose real size nobody knows until the
   * provider answers. These are the policy's own page bounds — the numbers a source is told to
   * page to — so this invents no limit of its own and cannot drift from what the dispatcher asks
   * for.
   *
   * `undefined` for everything else (details sections, manifest pages, `resolvePolicy`), whose
   * pages are bounded by entry counts rather than bytes. Reserving `maxToolResultBytes` for those
   * was considered and rejected: at the shipped defaults that is 256 KB against a ~137 KB
   * allowance, so a details fetch could only ever be a turn's first request, which is a large
   * behavioural cost to buy protection against results that are a few hundred bytes in practice.
   */
  function unpredictablePageBound(request: HostToolRequest): number | undefined {
    switch (request.tool) {
      case 'searchRepository':
      case 'searchDiff':
        return policy.searchResultPageBytes;
      case 'readFile':
      case 'readDiff':
        return policy.diffOrFileReadPageBytes;
      default:
        return undefined;
    }
  }

  /**
   * How big this request's result will be, and how sure the host is — the input `admitContent`
   * reasons from.
   *
   * **Why the `atMost` arm exists.** It used to be "exact size, or serve it and hope". A search or
   * a cursored read went out whenever a single byte of the turn was left, and when the result came
   * back larger than that the renderer dropped it at assembly: a provider call made, evidence
   * bytes charged to the attempt, and the model shown none of it. Measured on a twelve-file review
   * with one 45 KB search against a 120,000-byte cap, that is exactly what happened — 157,157
   * bytes assembled, one paid-for result dropped. Reserving the page bound instead turns that into
   * a deferral that costs nothing and that the model is told how to act on.
   */
  function predictedResultBytes(request: HostToolRequest): ContentSizeEstimate {
    const exact = knownResultBytes(request);
    if (exact !== undefined) return { kind: 'exact', bytes: exact };
    const bound = unpredictablePageBound(request);
    return bound === undefined ? { kind: 'unknown' } : { kind: 'atMost', bytes: bound };
  }

  /**
   * The content bytes a served result really carried, for the shapes whose size the admission test
   * predicted — and `undefined` for every other shape and every non-content state.
   *
   * It exists to measure the *overhead*: subtracting this from the real growth of the assembled
   * prompt leaves exactly what the envelope and the map transition cost, which is the number the
   * next admission has to charge. Returning `undefined` rather than 0 for a refusal or a manifest
   * page is the whole discipline — a refusal's ~200-byte envelope with no content would read as
   * "one result costs 200 bytes of overhead", and charging a 50 KB diff that figure is how the
   * measured 455-byte gap opened in the first place.
   */
  function servedContentBytes(result: HostToolResult): number | undefined {
    if (result.state !== 'complete' && result.state !== 'paginated' && result.state !== 'truncated') return undefined;
    switch (result.content.tool) {
      case 'readDiff':
        return promptByteLength(result.content.patch);
      case 'readFile':
        return promptByteLength(result.content.text);
      case 'searchRepository':
      case 'searchDiff':
        return promptByteLength(result.content.matchesJson);
      case 'getChangeRequestDetails':
      case 'getIssueDetails':
        return promptByteLength(result.content.detailJson);
      default:
        return undefined;
    }
  }

  /**
   * Dispatches one tool request, or declines it on the turn's prompt budget and says why. Returns
   * the result that goes to the model either way — never nothing, so the model always reads one
   * result per request it made.
   *
   * `reservedBytes` is what the rest of this same turn has already committed to and not yet spent:
   * the candidate submissions still ahead of this request in the model's own message list. They
   * are dispatched unconditionally (a finding is work already done; refusing it would throw it
   * away and force a resubmission turn), so the only honest way to account for them is to hold
   * their room back from the reads that precede them.
   */
  async function serveWithinPromptBudget(phase: RunPhase, request: HostToolRequest, budget: TurnContentBudget | undefined, served: readonly HostToolResult[], reservedBytes = 0): Promise<HostToolResult> {
    if (budget === undefined) return dispatchAndTrack(phase, request);
    const before = budget.ceilingBytes - budget.remainingBytes;
    const result = await decideAndServe(phase, request, budget, reservedBytes);
    // Re-measured against the real prompt, never accumulated from the result's own size — and
    // after a refusal as much as after a read. The map grew with a read, and the map is framing;
    // a refusal is only a few hundred bytes, but eight of them in one turn are still bytes this
    // prompt has to carry, and "measure the thing itself" is the rule that makes them countable
    // without a second, drifting idea of what a result costs.
    const assembled = measureNextPrompt(phase, [...served, result]);
    if (assembled !== undefined) {
      const content = servedContentBytes(result);
      // The overhead this result really cost, kept as the largest seen: the next admission in this
      // turn is charged what a result of this turn actually weighs rather than what its content
      // weighs. `content > 0` guards against a zero-byte page teaching the same wrong lesson a
      // refusal would.
      if (content !== undefined && content > 0) budget.overheadBytes = Math.max(budget.overheadBytes, assembled - before - content);
      budget.remainingBytes = budget.ceilingBytes - assembled;
    }
    return result;
  }

  /**
   * Re-measures the turn's remaining room after a dispatch that never went through admission —
   * a candidate submission or a completion request.
   *
   * Those are not evidence and are never deferred, but their results and their investigation-map
   * lines are bytes the prompt has to carry all the same. Before this, they were dispatched with
   * no accounting at all: a read admitted earlier in the same turn had been measured against room
   * that eight submissions then took, which is what widened the measured 455-byte accounting gap
   * to ~2,200 and pushed a turn 200 bytes past the cap in
   * `harnessPromptBudgetHonesty.assurance.test.ts`'s eight-submission case.
   */
  function noteUnadmittedDispatch(phase: RunPhase, budget: TurnContentBudget | undefined, served: readonly HostToolResult[]): void {
    if (budget === undefined) return;
    const assembled = measureNextPrompt(phase, served);
    if (assembled !== undefined) budget.remainingBytes = budget.ceilingBytes - assembled;
  }

  async function decideAndServe(phase: RunPhase, request: HostToolRequest, budget: TurnContentBudget, reservedBytes: number): Promise<HostToolResult> {
    const admission = admitContent({
      estimate: predictedResultBytes(request),
      remainingBytes: budget.remainingBytes,
      allowanceBytes: budget.allowanceBytes,
      overheadBytes: budget.overheadBytes,
      reservedBytes,
    });
    if (admission.kind === 'exceedsAllowance') {
      const reason = describeExceedsAllowance({ knownBytes: admission.knownBytes, allowanceBytes: admission.allowanceBytes, ceilingBytes: budget.ceilingBytes });
      const result = budgetTooLarge(request, admission.knownBytes, reason);
      // Terminal, through the same bridge a provider's own `tooLarge` goes through: the inventory
      // marks the file oversized, the completion gate reports it as content this attempt could not
      // inspect, and the map stops listing it as work to do. That is the whole no-loop guarantee —
      // the mechanism that already stops a model re-requesting a file fifteen times, reused rather
      // than reinvented — and a repeated ask after it adds nothing, which is the run-in-place
      // signal `runPhaseLoop` already bounds.
      updateInventoryFromResult(request, result);
      appendActivity({ kind: 'toolFailed', tool: request.tool, target: pathOrIdOf(request), reason }, phase);
      return result;
    }
    if (admission.kind === 'defer') {
      const reason = describeDeferral({ knownBytes: admission.knownBytes, remainingBytes: admission.remainingBytes, allowanceBytes: budget.allowanceBytes, sizeIsUpperBound: admission.sizeIsUpperBound });
      budget.deferrals += 1;
      appendActivity({ kind: 'toolFailed', tool: request.tool, target: pathOrIdOf(request), reason }, phase);
      return budgetRefusal(request, reason);
    }
    return dispatchAndTrack(phase, request);
  }

  async function processMessages(phase: RunPhase, messages: readonly ProtocolMessage[], sink: HostToolResult[]): Promise<ProcessMessagesOutcome> {
    let completionGranted = false;
    // Opened lazily, on the turn's first tool request: a turn that only submits findings or shapes
    // the plan pays nothing to measure a prompt whose results it is not adding to.
    let contentBudget: TurnContentBudget | undefined;
    let contentBudgetOpened = false;
    // How many dispatches that skip admission still follow each position in the model's own message
    // list. The model sends one batch per turn, so the whole turn's commitments are known before
    // the first read is dispatched — which is the only moment at which holding room back for them
    // is any use. Built once, backwards, rather than re-scanned per message.
    //
    // Both kinds count. A candidate submission is the common one; a `completionRequest` is the
    // quiet one, and a *refused* completion is the expensive shape — its response carries the
    // gate's blocker detail as JSON, which is exactly the turn where the model most needs to read
    // why it was refused, and the one place a dropped result would take that away.
    const unadmittedStillAhead: number[] = new Array(messages.length + 1).fill(0);
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const kind = messages[index]?.kind;
      unadmittedStillAhead[index] = (unadmittedStillAhead[index + 1] ?? 0) + (kind === 'candidateSubmission' || kind === 'completionRequest' ? 1 : 0);
    }
    for (const [messageIndex, message] of messages.entries()) {
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
          if (!contentBudgetOpened) {
            contentBudget = openTurnContentBudget(phase, sink);
            contentBudgetOpened = true;
          }
          sink.push(await serveWithinPromptBudget(phase, request, contentBudget, sink, (unadmittedStillAhead[messageIndex + 1] ?? 0) * PROJECTED_SUBMISSION_BYTES));
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
          noteUnadmittedDispatch(phase, contentBudget, sink);
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
          noteUnadmittedDispatch(phase, contentBudget, sink);
          if (result.state === 'complete' && result.content.tool === 'requestCompletion' && result.content.response.granted) {
            completionGranted = true;
            // The model's own closing statement, kept because it is the only sentence that says
            // *why* a review ended the way it did. Until this, it was parsed and sanitized
            // (`harnessProtocol.ts`'s `parseCompletionRequest`) and then dropped on the floor: a
            // clean run rendered a tick, "no findings above your criteria", four generic host
            // phase labels and an Approve button, and a reviewer had no way to see that the model
            // had actually checked the thing that mattered. Recorded only on a *granted*
            // completion — a refused request is a claim the host disagreed with, not a verdict —
            // and already bounded and sanitized at parse, so nothing untrusted reaches the record.
            if (message.rationale !== undefined && message.rationale.trim() !== '') conclusion = message.rationale.trim();
          }
          break;
        }
        default: {
          const exhaustive: never = message;
          void exhaustive;
        }
      }
    }
    return { hadActionableWork: turnHasActionableWork(messages), completionGranted, deferredForPromptBudget: contentBudget?.deferrals ?? 0 };
  }

  /**
   * A host-synthesized `requestCompletion` result, byte-for-byte the same shape
   * `handleRequestCompletion` (`harnessToolDispatcher.ts`) builds for the model's own explicit
   * ask — reused here, not reinvented, because the model-seam's prompt renderer
   * (`harnessModelSeam.ts`'s `renderToolResult`) already knows how to show this shape and does so
   * with no phase awareness at all. Built directly rather than through `dispatcher.dispatch`
   * because `requestCompletion`'s tool-catalog `allowedPhases` is `['verifying', 'completing']`
   * (`harnessTools.ts`) — a restriction on what the *model* may ask for, not on what the *host*
   * may tell it, and D11's completion gate is a whole-attempt check the host is always entitled to
   * run. Costs no extra tool call (`evidenceBytes`/`toolCalls` are never reserved for it) — the
   * real cost of the extra turn it buys is the ordinary `budget.beginTurn` reservation at the top
   * of the next loop iteration, same as every other turn.
   */
  function earlyStopNudgeResult(response: CompletionRequestResponse): HostToolResult {
    return {
      toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
      requestId: nextRequestId(),
      tool: 'requestCompletion',
      unitsReturned: 1,
      state: 'complete',
      content: { tool: 'requestCompletion', response },
    };
  }

  /** Why a file is not "read", when it never will be. Read files say nothing; unvisited/classified say nothing either — they are still to do. */
  const NOT_INSPECTED_NOTE: Partial<Record<FileInspectionState, string>> = {
    excludedByPolicy: 'excluded by policy',
    unavailable: 'unavailable',
    binary: 'binary',
    oversized: 'oversized',
  };

  /**
   * The investigation as the model needs to see it, rebuilt for every turn.
   *
   * Read from the inventory and the ledger — the two collaborators that already know — rather than
   * accumulated separately, so what the model is told about its own coverage can never disagree
   * with what the completion gate measures.
   *
   * Only citable sources are indexed: an "ev_..." the model cannot cite is noise in a prompt paid
   * for on every turn.
   */
  function investigationMap(): readonly InvestigationMapMember[] {
    const heldByPath = new Map<string, string[]>();
    // Ledger append position of each path's most recent citable source. `sourceId`s are opaque
    // (128 random bits, deliberately unordered), so append order is the only recency there is;
    // `renderInvestigationMap`'s bounded form for a very large member uses it to keep detail
    // lines for the newest reads — the only ones whose results can still be in front of the model.
    const lastFetchByPath = new Map<string, number>();
    let fetchOrder = 0;
    for (const source of ledger.sources()) {
      fetchOrder += 1;
      if (source.path === undefined || !source.citable) continue;
      const key = `${source.memberId}\u0000${source.path}`;
      lastFetchByPath.set(key, fetchOrder);
      const held = heldByPath.get(key);
      if (held === undefined) heldByPath.set(key, [source.sourceId]);
      else if (!held.includes(source.sourceId)) held.push(source.sourceId);
    }
    return inventory.members().map((member): InvestigationMapMember => {
      const offManifest = offManifestByMember.get(member.memberId);
      return {
        memberId: member.memberId,
        manifestComplete: member.enumeration === 'complete',
        files: member.files.map((file): InvestigationMapFile => {
          const note = NOT_INSPECTED_NOTE[file.state];
          const lastFetch = lastFetchByPath.get(`${member.memberId}\u0000${file.path}`);
          return {
            path: file.path,
            inspected: file.state === 'inspected',
            ...(file.addedLines !== undefined ? { addedLines: file.addedLines } : {}),
            ...(file.removedLines !== undefined ? { removedLines: file.removedLines } : {}),
            // The host's own classification, carried through so the bounded form can name the
            // riskiest unread files first instead of the alphabetically earliest — see
            // `renderBoundedMemberFiles`. Absent until `ensureClassified` has run for this file.
            ...(file.risk !== undefined ? { risk: file.risk } : {}),
            // The manifest's own per-file diff size, carried through so the map can show the model
            // what a read will actually cost it before it asks for eight of them — and so
            // `serveWithinPromptBudget` below can decide, without a round trip, which of those
            // eight fit this turn. Absent when the source did not report one.
            ...(file.byteSize !== undefined ? { patchBytes: file.byteSize } : {}),
            ...(note !== undefined ? { note } : {}),
            sourceIds: heldByPath.get(`${member.memberId}\u0000${file.path}`) ?? [],
            ...(lastFetch !== undefined ? { lastFetchOrder: lastFetch } : {}),
          };
        }),
        // Most recent first: `recordOffManifestPath` keeps the Set in guess order, and the guess
        // the model is still making is the one worth naming at the top.
        ...(offManifest !== undefined && offManifest.paths.size > 0
          ? { offManifestPaths: [...offManifest.paths].reverse(), offManifestRequests: offManifest.requests }
          : {}),
      };
    });
  }

  /**
   * The submitted side of the investigation map: every candidate this attempt has tracked, read
   * from `candidateTracker` — the collaborator that already knows — for the same reason
   * `investigationMap` reads the inventory and the ledger: what the model is told about its own
   * output can never disagree with what the completion gate counts. The path is the accepted
   * finding's primary-evidence path; an unresolved or rejected candidate keeps no finding, so it
   * is named by id and the reason validation gave for refusing it.
   *
   * That reason is carried here because the tracker already holds it and nothing else was reading
   * it. Without it the map said only "rejected <id> (do not resubmit)", and a stateless model that
   * is told it is wrong without being told what is wrong cannot do anything but stop — see
   * `InvestigationSubmission.reason` for the run that made this necessary.
   */
  function submissionsSummary(): readonly InvestigationSubmission[] {
    return candidateTracker.all().map((candidate): InvestigationSubmission => {
      const reason = candidate.reasons.map((entry) => `${entry.code}: ${entry.message}`).join(' ');
      return {
        candidateId: candidate.candidateId,
        state: candidate.state,
        ...(candidate.finding !== undefined ? { path: candidate.finding.evidence.primary.path } : {}),
        ...(reason === '' ? {} : { reason }),
      };
    });
  }

  /**
   * One phase's model-turn loop: reserve a turn, run it (bounded protocol repair is
   * `runHarnessTurn`'s own job), process the batch, repeat until `shouldStop()`, budget/
   * cancellation stops it, repairs are exhausted, or a turn carries no actionable work AND (for
   * `investigating`/`verifying`) either nothing is missing or nudging is exhausted/not repairable.
   * Every exit proceeds onward to host validation (D11) rather than failing silently.
   *
   * **The early-stop fix.** `turnHasActionableWork`'s stall signal only says the model sent
   * nothing this host need act on — it is the model's own belief that it is finished, or a bare
   * `publicRationale`/malformed drift off protocol, never a host confirmation that D11's clauses
   * are actually satisfied. Ending the phase on that signal alone was the bug: a model that
   * stopped early left required coverage (or, in `verifying`, unresolved candidates/citations/
   * verification passes) outstanding while budget sat unspent, and the run then failed with zero
   * findings even though nothing was blocking further work. An explicit `completionRequest`
   * already gets exactly this courtesy from `respondToCompletionRequest` (D11's "repairable early
   * completion request"); a model that simply stops asking must get the same one, not a lesser
   * one — bounded (`MAX_EARLY_STOP_NUDGES_PER_PHASE`) so a model that keeps stopping without doing
   * anything cannot spin the phase forever.
   *
   * **The run-in-place fix.** The early-stop machinery above caught a model that stops; it was
   * blind to a model that runs in place, because any turn carrying a `toolRequest` counted as
   * actionable and skipped the whole stall path. A live run did exactly that: full coverage on a
   * 26-file change, then turn after turn of eight `readDiff` re-reads of already-inspected files,
   * zero submissions, `investigating` never ending — until an external watchdog killed the run
   * (see `turnAdvancedTheReview`). So a turn now has to *earn* its unconditional `continue`: it
   * must submit, shape the plan, ask for completion, or actually add something — new coverage
   * state (an `inventory.counts()` delta) or content the attempt did not already hold (a new
   * ledger digest; a fresh sourceId alone is not enough, since a byte-identical re-read mints one
   * too). Both measures read the completion gate's own collaborators, so "progress" here can
   * never disagree with what the gate later measures. A turn that added nothing is then judged by
   * where the phase stands, deliberately asymmetrically:
   * - *Short of the phase's own conditions*, it is let through on budget's account: redundant
   *   fetching is self-limiting (every turn burns turn/tool budget and the map re-lists every
   *   unread file), and a probe that registers nothing new — an already-cached policy chain, a
   *   refused read — is often a legitimate step on the way to a submission
   *   (`harnessSmallReviewCost.assurance.test.ts`'s resolvePolicy-per-file scenario does exactly
   *   this and must not be molested for it).
   * - *With every phase-owned condition met*, there is nothing left to be on the way to. The map
   *   is already telling the model, in every prompt, to submit now or stop; the host grants
   *   `MAX_EARLY_STOP_NUDGES_PER_PHASE` further turns for that (fewer when stop-nudges already
   *   drew on the same counter — the bound is total host patience per phase, not a separate grace
   *   budget) and then ends the phase truthfully
   *   — which withdraws no read tool and loses no submission window (`lastTurnResults` carries the
   *   final turn's results into the next phase's first prompt, and `verifying` still accepts
   *   `candidateSubmission`).
   * Unlike the stop path below, no synthesized `requestCompletion` result is ever fed back for a
   * run-in-place turn: appending host text to the results was tried first and rejected because it
   * perturbs healthy flows (`harnessDemoParticipant.ts` treats an unexpected extra result as
   * harness drift and fails loudly — by design), and replacing the results would delete the
   * model's only citable evidence at exactly the moment it is being told to submit.
   */
  async function runPhaseLoop(phase: RunPhase, shouldStop: () => boolean): Promise<StopReason> {
    let earlyStopNudges = 0;
    for (;;) {
      if (isCancelled()) return 'cancelled';
      if (shouldStop()) return 'condition';
      const requestId = nextRequestId();
      const reserved = budget.beginTurn({ requestId, purpose: choosePurpose(phase), elapsedMs: clock() });
      if (!reserved.ok) return reserved.code === 'cancelled' ? 'cancelled' : 'budgetExhausted';

      const toolResultsForThisAsk = lastTurnResults;
      // Fix 1: every repair ask (D5 rule 5) is its own round trip, retried independently — see
      // `askModelRetried`'s own doc comment.
      const askModel: PhaseAskModel = (repairInstruction) =>
        askModelRetried(phase, () =>
          options.modelSeam.askModel({
            phase,
            repairInstruction,
            toolResults: toolResultsForThisAsk,
            envelope: fittedEnvelope,
            investigation: investigationMap(),
            submissions: submissionsSummary(),
            onTiming: (timing) => recordModelTurnTiming(phase, timing),
            onPromptOverrun: (overrun) => recordPromptOverrun(overrun),
          }),
        );
      // The one failure that is not the model's and not a provider's: the prompt this turn would
      // have sent is over `maxPromptBytesPerTurn` and nothing could be dropped out of it, because
      // none of what is over is optional. `runBootstrap` already refuses an attempt whose framing
      // does not fit before turn one; this is the same condition arriving later, when the
      // investigation map has grown into the cap mid-review. `recordPromptOverrun` has already
      // pushed the `promptBudgetNoRoom` limitation naming the setting and the number, so the
      // reviewer is told why the review stopped rather than being handed a short one silently.
      // The phase ends instead of retrying: the next turn's framing is the same framing.
      let outcome: Awaited<ReturnType<typeof runHarnessTurn>>;
      try {
        outcome = await runHarnessTurn(askModel, { phase, previousPlan: plan, policy, cancellation });
      } catch (error) {
        if (!(error instanceof PromptCeilingExceededError)) throw error;
        appendActivity({ kind: 'toolFailed', tool: 'modelPrompt', reason: error.message }, phase);
        return 'budgetExhausted';
      }

      if (!outcome.ok) {
        const detail = outcome.reasons.map((r) => r.message).join('; ') || 'no further detail';
        appendActivity({ kind: 'toolFailed', tool: 'modelTurn', reason: `${outcome.failureKind}: ${detail}` }, phase);
        // Surfaced as the attempt's own limitation (not only an activity-log line) so it reaches
        // the reviewer as *the* reason this phase ended, rather than only ever showing up as
        // whatever coverage/candidate complaint `evaluateCompletion` separately reports once the
        // phase gives up early — the exact "wrong blame" failure mode the empty-response bug
        // produced (the model returned nothing, repeatedly, and the run reported
        // `insufficientRiskCoverage` instead). Never pushed for `cancelled`: that is the
        // reviewer's own choice, already tracked through the run's `cancelled` lifecycle.
        if (outcome.failureKind !== 'cancelled') {
          extraLimitations.push({ code: 'modelTurnFailed', message: `The model's turn in the ${phase} phase could not be completed after repeated attempts: ${detail}` });
        }
        return outcome.failureKind === 'cancelled' ? 'cancelled' : 'repairExhausted';
      }

      const countsBeforeTurn = JSON.stringify(inventory.counts());
      const digestsBeforeTurn = new Set(ledger.sources().map((source) => source.digest));
      const sink: HostToolResult[] = [];
      const processed = await processMessages(phase, outcome.messages, sink);
      lastTurnResults = sink;
      if (phase === 'verifying' && processed.completionGranted) return 'condition';
      // The run-in-place fix (this function's own doc comment): a `continue` must be earned by
      // progress the host can see — new coverage, or content the attempt did not already hold.
      // Digest, never sourceId: the ledger mints a fresh sourceId for every registration, so a
      // byte-identical re-read grows the source list while adding no digest — which is exactly
      // the distinction between fetching something and re-fetching it.
      const productive =
        turnAdvancedTheReview(outcome.messages) ||
        JSON.stringify(inventory.counts()) !== countsBeforeTurn ||
        ledger.sources().some((source) => !digestsBeforeTurn.has(source.digest)) ||
        // A request this host declined on the per-turn prompt budget produced no coverage and no
        // evidence by construction, which is indistinguishable from running in place — and it is
        // not the same thing at all: the model asked for work and the host deferred it. Without
        // this a turn that over-asked would be answered with a nudge toward completion, which is
        // the opposite of what it needs (see `ProcessMessagesOutcome.deferredForPromptBudget`).
        processed.deferredForPromptBudget > 0;
      if (processed.hadActionableWork && (productive || !EARLY_STOP_NUDGE_PHASES.has(phase))) continue;
      if (!EARLY_STOP_NUDGE_PHASES.has(phase)) return 'noActionableWork';

      // Mirrors `processMessages`'s own `completionRequest` case: a candidate accepted since the
      // last verification pass must be reconciled before this evaluation can trust `latestPasses`,
      // or a merely-stale-not-yet-rerun pass would look identical to a genuinely missing one.
      if (phase === 'verifying' && passesStale) await runSynthesisVerification();

      const evaluation = currentCompletionEvaluation();
      const forNudge = phase === 'investigating' ? scopedForNudge(evaluation, INVESTIGATING_RELEVANT_CLAUSES) : evaluation;

      if (processed.hadActionableWork) {
        // The model ran in place: tool requests that returned only what the attempt already held.
        // Short of coverage that is wasteful but self-limiting — every such turn still burns
        // turn/tool budget, and the map names each unread file every turn — so the host lets
        // budget bound it rather than intervening mid-flow (a policy probe or refused read is
        // often a legitimate step on the way to a submission; see the resolvePolicy-per-file
        // scenario in `harnessSmallReviewCost.assurance.test.ts`). Once nothing the phase owns is
        // missing, though, there is nothing left this phase can be "on the way" to: the prompt's
        // own map is already saying "submit now or stop", so the host grants a bounded number of
        // further turns for exactly that and then ends the phase truthfully. No synthesized
        // `requestCompletion` result is fed back here (unlike the stop path below): the map text
        // carries the instruction, and the turn's real results — the model's only citable
        // evidence — stay exactly what `lastTurnResults` already holds.
        if (!forNudge.eligible) continue;
        if (earlyStopNudges >= MAX_EARLY_STOP_NUDGES_PER_PHASE) {
          appendActivity(
            {
              kind: 'actionStarted',
              action: `The model kept requesting tools that added nothing new for ${MAX_EARLY_STOP_NUDGES_PER_PHASE + 1} turn(s) after this phase's own conditions were all met; moving on rather than asking again.`,
            },
            phase,
          );
          return 'noActionableWork';
        }
        earlyStopNudges += 1;
        // Recorded so a live activity log tells a circling run apart from a working one — the
        // exact diagnosis step the original hang forced through raw trace files.
        appendActivity(
          { kind: 'actionStarted', action: 'The model requested tools that added nothing new although nothing this phase owns is missing; waiting for it to submit findings or stop.' },
          phase,
        );
        continue;
      }

      if (forNudge.eligible) return 'noActionableWork'; // Nothing this phase owns is missing — the model was right to stop.
      if (earlyStopNudges >= MAX_EARLY_STOP_NUDGES_PER_PHASE) {
        appendActivity(
          {
            kind: 'actionStarted',
            action: `The model stopped without finishing ${MAX_EARLY_STOP_NUDGES_PER_PHASE} time(s) in this phase; ending it truthfully with its current coverage rather than asking again.`,
          },
          phase,
        );
        return 'noActionableWork';
      }
      // Same budget purpose and check `handleRequestCompletion` uses for the model's own explicit
      // ask — no member scope, since D11 completion is a whole-attempt gate, not one member's.
      const response = respondToCompletionRequest(forNudge, { canContinue: budget.canContinue('verification', clock()) });
      if (response.granted) return 'noActionableWork'; // Unreachable given `evaluation.eligible` was false above; narrows the union for the branch below.
      if (!response.repairable) return 'noActionableWork'; // An unrepairable blocker, or budget cannot afford another turn.

      earlyStopNudges += 1;
      appendActivity(
        {
          kind: 'actionStarted',
          action: `The model stopped without finishing; asking it to continue — ${response.missingConditions.length} condition(s) still outstanding.`,
        },
        phase,
      );
      lastTurnResults = [earlyStopNudgeResult(response)];
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

  /**
   * The tool catalog this attempt actually offers the model — `HOST_TOOL_CATALOG` (design.md D6's
   * fixed ten tools) minus any tool no member's *effective* capabilities support
   * (`toolCapabilityAvailable`, the exact same test `harnessToolDispatcher.ts`'s dispatch-time
   * `capabilityUnavailable` already applies — reused, not reinvented). A tool present for some
   * members but not others is still withheld attempt-wide: the catalog is one shared prompt section
   * (D4), so advertising a tool that only some members can actually answer would still cost the
   * model a wasted turn against whichever member cannot. `harnessRuntime.ts`'s `effectiveCapabilities`
   * is what actually turns a reviewer's "scope this review to its changed files" setting into a
   * withheld capability here — this function only ever reads the capabilities it is given.
   */
  function availableToolCatalog(): readonly BootstrapToolSchema[] {
    return HOST_TOOL_CATALOG.filter((schema) => {
      const definition = hostToolDefinition(schema.name);
      return definition !== undefined && options.members.every((member) => toolCapabilityAvailable(definition, member.capabilities));
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
      // No pin here either: `harnessToolDispatcher.ts` supplies every request's revisions from the
      // member it names, so a host-initiated bootstrap call builds one the same way a model turn
      // does — one code path, one place the pin comes from.
      request: { number: snap.ref.number },
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
    let cursor: string | undefined;
    for (;;) {
      const request: HostToolRequest = {
        tool: 'listChangedFiles',
        requestId: nextRequestId(),
        elapsedMs: clock(),
        purpose: 'exploration',
        hostInitiated: true,
        memberId: member.memberId,
        request: { cursor },
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
      toolCatalog: availableToolCatalog(),
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

    // Fails closed on the one condition no amount of careful serving can fix: this review's own
    // mandatory framing — persona, host tools, protocol contract, the change-request description —
    // does not fit `maxPromptBytesPerTurn`, so no turn has room for a single byte of evidence.
    // Measured here rather than guessed, and measured *after* the manifest so the investigation map
    // is the real one. The precedent is `fitBootstrapToModel`'s own `bootstrapOverflow`, which
    // refuses the same way for the model's token limit: reporting "this cannot work, and here is
    // the number" before the first turn beats forty turns that each read nothing.
    const framingBytes = measureNextPrompt('planning', []);
    if (framingBytes !== undefined && framingBytes >= policy.maxPromptBytesPerTurn) {
      return {
        ok: false,
        limitation: {
          code: 'promptBudgetNoRoom',
          message: describeFramingOverrun(resolvePromptBudget(policy.maxPromptBytesPerTurn, framingBytes)),
        },
      };
    }
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
   * `investigating`'s loop stops on the same stall signals `verifying` does
   * (a turn with no actionable work, or one that ran in place — see
   * `runPhaseLoop`'s doc comment), never on a bare "coverage looks
   * complete" check: a candidate-finding submission cites evidence from an
   * *earlier* turn's dispatch (D8's byte-identity rule), so it is
   * structurally at least one turn behind the read that produced it — a
   * host stop condition keyed on inventory coverage alone would end the
   * loop the instant the last file is read, before the model gets the turn
   * it needs to submit what it found. The run-in-place stall keeps that
   * guarantee: it fires one turn *after* the last read at the earliest (the
   * turn whose prompt carried those results and whose reply submitted
   * nothing and read nothing new), so the submission window is always
   * offered before the phase can end — and the stalling turn's own results
   * still carry into the next phase's first prompt. `evaluateCompletion`
   * (in `completing`) remains the authoritative coverage check either way
   * (D11); this loop only decides how many turns the model gets to work
   * with.
   */
  async function runInvestigating(): Promise<void> {
    currentPhase = 'investigating';
    await fireCheckpoint('investigating', 'phaseBoundary');
    classifyAllUnvisited();
    // The moment required coverage and remaining budget are both first fully known — the
    // manifest is paged to exhaustion in bootstrap and every file was just classified — and
    // before a single investigating turn is paid for. A 204-file live run spent 80% of its
    // budget (every lane a medium-risk read may draw, to zero) discovering an arithmetic fact
    // that was provable right here; the reviewer's first sight of it was the terminal
    // limitations list. Stated once, up front, instead: as this attempt's leading limitation
    // (`extraLimitations` precedes the budget warnings in `runPersisting`) and as a
    // `partialResult` activity event — the one event kind `deriveLimitations` surfaces to a
    // *live* projection before any terminal result exists. The run still proceeds: partial
    // coverage of a too-large change is worth having, it just must never present as the full
    // review. See `forecastCoverageShortfall` for the floors that keep this claim honest.
    const budgetState = budget.state();
    const shortfall = forecastCoverageShortfall({
      inventory,
      coverageRules: riskCoverageRules,
      toolCalls: {
        ordinaryRemaining: budgetState.pools.toolCalls.lanes.ordinary.remaining,
        highRiskReserveRemaining: budgetState.pools.toolCalls.lanes.highRiskReserve.remaining,
      },
      modelTurns: {
        ordinaryRemaining: budgetState.pools.modelTurns.lanes.ordinary.remaining,
        highRiskReserveRemaining: budgetState.pools.modelTurns.lanes.highRiskReserve.remaining,
      },
      maxToolRequestsPerTurn: policy.maxToolRequestsPerTurn,
    });
    if (shortfall !== undefined) {
      extraLimitations.push(shortfall.limitation);
      appendActivity({ kind: 'partialResult', limitations: [...extraLimitations] }, 'investigating');
    }
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
    // Task 16.7's own mutation pass found this gap: a candidate accepted *after* synthesis/
    // verification already ran once on this attempt sets `passesStale = true`
    // (`processMessages`'s `candidateSubmission` case), but the only place that used to consult it
    // was a later `completionRequest`. A model that stops the phase loop without ever sending one —
    // a `publicRationale`, or simply no more actionable work — left `latestPasses`/
    // `survivingFindings` at their *first* run's stale snapshot: every clause could still read
    // satisfied, and the newly accepted, validly cited candidate was silently absent from the
    // result — `runCompleting()`/`runPersisting()` could report `completeClean` over a genuinely
    // accepted finding. Reconciling here, unconditionally whenever synthesis went stale and the
    // attempt was not cancelled, closes that gap the same way an explicit `completionRequest`
    // already did — `runSynthesisVerification()` is idempotent-safe to call again (it always resets
    // `passesStale` to `false`), so this is a no-op whenever the model itself already triggered the
    // mid-loop reconciliation. See `harnessCompletionMutation.assurance.test.ts`'s "headline
    // finding" test, which fails against the pre-fix behaviour and passes against this.
    if (passesStale && !isCancelled()) await runSynthesisVerification();
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
    terminalCheckpointWritten = true;
    const attemptOutcome: HarnessAttemptOutcome = { lifecycle, outcome, findings, plan, conclusion, cancelled: cancelledNow, contradicted: latestContradicted };
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
      conclusion,
      activityLog,
      cancelled: cancelledNow,
      small: smallFlag,
      turnsUsed: consumption.modelTurnsUsed,
      toolCallsUsed: consumption.toolCallsUsed,
      contradicted: latestContradicted,
      completionEvaluation: evaluation,
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
    terminalCheckpointWritten = true;
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

  /**
   * `run()`'s catch-all — the second of two fixes for a `HarnessAttempt` that dies in-process on
   * an escaping error. Every phase runner (`runBootstrap`/`runPlanning`/`runInvestigating`/
   * `runVerifying`/`runCompleting`/`runPersisting`) is expected to resolve, but one throw is
   * already known to reach here today: `runHarnessTurn` throwing anything other than
   * `PromptCeilingExceededError` (`runPhaseLoop`'s own catch, above, only absorbs that one) —
   * the exact shape of a model transport failure such as a provider read that never produces its
   * first token and times out. Left unhandled, that throw unwound `run()` with no terminal
   * checkpoint ever written: `HarnessRunStore`'s lineage record was left stuck at its last live,
   * nonterminal checkpoint, indistinguishable from a run that was merely still going, until the
   * next extension activation's `sweepInterruptedRuns` finally noticed — if it ever came, which it
   * does not for a window that stays open.
   *
   * This function only makes the lineage's own persisted history honest; it changes nothing about
   * what escapes `run()` or what the caller does with it (`ReviewRunManager.executeAttempt`'s own
   * catch already settles its in-memory `RunRecord` as `failed` from any rethrow — that behavior
   * is untouched). It:
   *
   * 1. Skips entirely once `terminalCheckpointWritten` is already true — `runPersisting`/
   *    `finalizeBootstrapFailure` already ran to completion and wrote this attempt's one real
   *    terminal checkpoint (a normal success, failure, or cancellation); a later throw (e.g. from
   *    `onPersist`) must never overwrite that correct record with this best-effort one.
   * 2. Appends the same public `terminalResult` fact those two paths append, with `lifecycle:
   *    'failed'` and a `limitations` entry naming the error — `completeness` follows this
   *    module's own convention (`classifyOutcome`'s partial-vs-none split): `partial` only when a
   *    validated finding actually survived to be triaged, `none` otherwise. Never `complete`,
   *    which only a real `runCompleting`/`runPersisting` pass may report.
   * 3. Reports ONE checkpoint for that terminal state (`'attemptFailed'`, the reason this catch-all
   *    owns — see `CHECKPOINT_REASONS`'s own doc comment), wrapped so that a persistence failure
   *    here — the write itself throwing — is recorded as a `toolFailed` activity fact (this
   *    module's only diagnostic seam; the file header's "no `vscode` import" note is why there is
   *    no separate trace channel to reach for) and otherwise swallowed, never allowed to replace
   *    the original error `run()` is about to rethrow.
   */
  async function finalizeEscapedError(error: unknown): Promise<void> {
    if (terminalCheckpointWritten) return;
    const message = error instanceof Error ? error.message : String(error);
    const survivedFindings = candidateTracker.triageFindings();
    appendActivity(
      {
        kind: 'terminalResult',
        lifecycle: 'failed',
        completeness: survivedFindings.length > 0 ? 'partial' : 'none',
        limitations: [{ code: 'attemptFailed', message: `An unhandled error ended this attempt: ${message}` }],
      },
      currentPhase,
    );
    try {
      await reportCheckpoint(mintId('ckpt'), currentPhase, 'attemptFailed');
      terminalCheckpointWritten = true;
    } catch (writeError) {
      const writeMessage = writeError instanceof Error ? writeError.message : String(writeError);
      appendActivity({ kind: 'toolFailed', tool: 'checkpointWrite', reason: `Writing this attempt's terminal checkpoint failed: ${writeMessage}` }, currentPhase);
    }
  }

  async function run(): Promise<HarnessAttemptResult> {
    try {
      // The work the caller did before this attempt existed, replayed into this
      // attempt's own log as its first events (`HarnessAttemptOptions.preludeActivity`,
      // `add-local-git-investigation` task 10.2). Before the preflight check
      // below, so an attempt that never starts still shows the fetch it was
      // waiting on — which is exactly the run whose reviewer most needs to see it.
      for (const fact of options.preludeActivity ?? []) appendActivity(fact, 'bootstrap');

      // Checked before `runBootstrap`, which is where the first provider fetch
      // and the first activity of a real attempt happen: an attempt that has no
      // source to read the change with must not go and read parts of it anyway.
      if (options.preflightFailure) return await finalizeBootstrapFailure(options.preflightFailure);

      const bootstrapOutcome = await runBootstrap();
      if (!bootstrapOutcome.ok) return await finalizeBootstrapFailure(bootstrapOutcome.limitation);

      computeSmallFlag();

      if (!isCancelled()) await runPlanning();
      if (plan === undefined) extraLimitations.push({ code: 'noPlan', message: 'No plan was ever created for this attempt.' });
      if (!isCancelled() && plan !== undefined) await runInvestigating();
      if (!isCancelled()) await runVerifying();

      const evaluation = await runCompleting();
      return await runPersisting(evaluation);
    } catch (error) {
      // The catch-all itself: see `finalizeEscapedError`'s own doc comment. The original error
      // always propagates, whether or not the terminal checkpoint it triggers could be written.
      await finalizeEscapedError(error);
      throw error;
    }
  }

  return { run };
}
