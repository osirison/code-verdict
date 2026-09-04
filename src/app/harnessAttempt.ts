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
 * - *Bootstrap `rootPolicy`* is built from `snapshot.members[i].rootAgentsPolicy`
 *   (already resolved into the immutable snapshot, D3) rather than a fresh
 *   `resolvePolicy` dispatch: `resolvePolicy`'s `allowedPhases` does not
 *   include `bootstrap` (`harnessTools.ts`), so a bootstrap-phase dispatch of
 *   it would be refused `phaseNotAllowed`. `BootstrapPolicySource.text` is
 *   optional, so the envelope is honest either way.
 * - *Issue-detail bootstrap sections are never fetched.* `getIssueDetails`
 *   needs an explicit `issueRepoId`, which
 *   `ReviewRunContextSelections.linkedItemIdsIncluded` does not carry (only
 *   numbers). Bootstrap ships change-request sections only; `issueDetails`
 *   is always `[]`.
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
} from './harnessEvidenceLedger';
import {
  coverageChangedFact,
  createChangedFileInventory,
  type ChangedFileInventory,
  type InventoryFileRecord,
} from './harnessInventory';
import {
  applyRiskFloor,
  computeRiskFloor,
  DEFAULT_RISK_COVERAGE_RULES,
  DEFAULT_RISK_FLOOR_RULES,
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
import {
  buildBootstrapEnvelope,
  buildBootstrapSection,
  type BootstrapMemberIdentity,
  type BootstrapMemberSections,
  type BootstrapPolicySource,
} from '../domain/harnessBootstrap';
import { fitBootstrapToModel } from './harnessBootstrapBudget';
import type { Limitation, Plan, RunPhase } from '../domain/harnessActivity';
import type { RiskLevel } from '../domain/harnessCoverage';
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
 */
export interface HarnessModelSeam {
  readonly modelId: string;
  askModel(input: { phase: RunPhase; repairInstruction: string | undefined; toolResults: readonly HostToolResult[] }): Promise<string>;
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

export type CheckpointReason = 'phaseBoundary' | 'toolCadence' | 'modelSuggested';

export interface CheckpointInfo {
  readonly checkpointId: string;
  readonly phase: RunPhase;
  readonly reason: CheckpointReason;
  readonly elapsedMs: number;
}

export type OnCheckpoint = (info: CheckpointInfo) => void | Promise<void>;

export interface HarnessAttemptOutcome {
  readonly lifecycle: RunLifecycle;
  readonly outcome: CompletionOutcome;
  readonly findings: readonly ValidatedFinding[];
  readonly plan?: Plan;
  readonly cancelled: boolean;
}

export type OnPersist = (outcome: HarnessAttemptOutcome, log: ActivityLog) => void | Promise<void>;

// ---- Member wiring ------------------------------------------------------------------

/**
 * What a caller supplies per changeset member beyond what the immutable
 * snapshot already pins (repository/base/head/capability signature):
 * a live `Connection` and the full `ProviderCapabilities` it was signed
 * from. Never resolved from `src/providers/` here — the caller (runtime
 * wiring, task 10.8) owns that lookup.
 */
export interface HarnessAttemptMemberInput {
  readonly memberId: string;
  readonly connection: Connection;
  readonly capabilities: ProviderCapabilities;
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
}

export interface HarnessAttempt {
  run(): Promise<HarnessAttemptResult>;
}

// ---- Small pure helpers ---------------------------------------------------------------

function mintId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
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

  // ---- Mutable attempt state (everything else is owned by an imported module) ----

  let activityLog: ActivityLog = createActivityLog(runId, lineageId, attemptNumber);
  let currentPhase: RunPhase = 'bootstrap';
  let plan: Plan | undefined;
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

  function isCancelled(): boolean {
    return cancellation?.isCancellationRequested === true;
  }

  function appendActivity(fact: ActivityFact, phase: RunPhase): void {
    const context: ActivityContext = { occurredAt: now(), phase, elapsedMs: clock() };
    activityLog = appendActivityEvent(activityLog, fact, context);
  }

  async function fireCheckpoint(phase: RunPhase, reason: CheckpointReason): Promise<void> {
    const checkpointId = mintId('ckpt');
    appendActivity({ kind: 'checkpoint', checkpointId }, phase);
    await onCheckpoint?.({ checkpointId, phase, reason, elapsedMs: clock() });
  }

  // ---- Collaborators (ledger, budget, inventory, candidates, dispatcher) ----

  const ledgerMembers = ledgerMembersFromSnapshot(snapshot).filter((member) => memberIds.includes(member.memberId));
  const ledger = createEvidenceLedger({ runId, lineageId, attempt: attemptNumber }, ledgerMembers, { policy });

  const budget: BudgetTracker = createBudgetTracker(policy, { members: memberIds });

  const inventory: ChangedFileInventory = createChangedFileInventory(
    options.members.map((member) => {
      const snap = snapshotMember(member.memberId);
      return { memberId: member.memberId, snapshot: { repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha } };
    }),
  );

  const candidateTracker: CandidateTracker = createCandidateTracker({ maxRepairsPerCandidate: policy.protocolRepairsPerPhase });

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
      options.retry?.onEnterWaiting?.(info);
    },
    onResuming: (info) => {
      appendActivity({ kind: 'resuming' }, currentPhase);
      options.retry?.onResuming?.(info);
    },
  };

  const dispatcher: HostToolDispatcher = createHostToolDispatcher({
    members: dispatcherMembers,
    ledger,
    budget,
    candidateTracker,
    criteria: snapshot.criteria,
    agentsPolicyResolver,
    evaluateCompletion: () => currentCompletionEvaluation(),
    onManifestPage: (memberId, result) => {
      inventory.acceptManifestPage(memberId, result);
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
      case 'notFound':
        inventory.markTerminal(memberId, path, 'unavailable', result.reason);
        break;
      default:
        break;
    }
    appendActivity(coverageChangedFact(inventory, riskCoverageRules.requireInspection), currentPhase);
  }

  async function dispatchAndTrack(phase: RunPhase, request: HostToolRequest, control?: DispatchControl): Promise<HostToolResult> {
    const result = await dispatcher.dispatch(phase, request, control);
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

  function choosePurpose(phase: RunPhase): ReservationPurpose {
    return phase === 'verifying' ? 'verification' : 'exploration';
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
          const request = toHostToolRequest(message.call, nextRequestId(), clock(), choosePurpose(phase), false);
          sink.push(await dispatchAndTrack(phase, request));
          break;
        }
        case 'candidateSubmission': {
          const request: HostToolRequest = {
            tool: 'submitCandidateFinding',
            requestId: nextRequestId(),
            elapsedMs: clock(),
            purpose: choosePurpose(phase),
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
      const askModel: PhaseAskModel = (repairInstruction) => options.modelSeam.askModel({ phase, repairInstruction, toolResults: toolResultsForThisAsk });
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

  function rootPolicyFor(): BootstrapPolicySource {
    const first = options.members[0];
    if (!first) return { present: false };
    const resolved = snapshotMember(first.memberId).rootAgentsPolicy;
    // `text` is optional on `BootstrapPolicySource`: the snapshot (D3) carries only identity
    // (sourceId/digest), never content, and `resolvePolicy` is not bootstrap-legal (its
    // `allowedPhases` excludes `bootstrap`, `harnessTools.ts`) — presence/identity is honest
    // without a fresh fetch here.
    return resolved.present ? { present: true, sourceId: resolved.sourceId, digest: resolved.digest } : { present: false };
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
    await fireCheckpoint('bootstrap', 'phaseBoundary');
    appendActivity({ kind: 'actionStarted', action: 'Assembling bootstrap and the changed-file inventory.' }, 'bootstrap');

    const memberIdentities: BootstrapMemberIdentity[] = options.members.map((member) => {
      const snap = snapshotMember(member.memberId);
      return { memberId: member.memberId, repoId: snap.ref.repoId, baseSha: snap.baseSha, headSha: snap.headSha };
    });
    const memberSections: BootstrapMemberSections[] = [];
    for (const member of options.members) memberSections.push(await fetchMemberSections(member));

    const envelope = buildBootstrapEnvelope({
      members: memberIdentities,
      personaLabel: snapshot.personaLabel,
      agentInstructions: snapshot.agentInstructions,
      criteria: snapshot.criteria,
      effort: snapshot.effort,
      effortInstruction: effortPrompt(snapshot.effort),
      contextDeclaration: buildContextDeclaration(),
      rootPolicy: rootPolicyFor(),
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
    await fireCheckpoint('persisting', 'phaseBoundary');
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
    const attemptOutcome: HarnessAttemptOutcome = { lifecycle, outcome, findings, plan, cancelled: cancelledNow };
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
    const outcome: CompletionOutcome = {
      kind: 'failed',
      completeness: 'none',
      findingCount: 0,
      limitations: [limitation],
      replacesRetainedReview: false,
      clean: false,
    };
    const attemptOutcome: HarnessAttemptOutcome = { lifecycle: 'failed', outcome, findings: [], plan: undefined, cancelled: false };
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
