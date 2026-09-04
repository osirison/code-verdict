/**
 * Resume compatibility, evidence reuse, interruption, and restart — the
 * decision layer for tasks 11.5-11.7 of `add-agentic-review-harness`,
 * design.md D2/D3/D8/D13, spec `background-review-runs` ("A run that could
 * not survive a restart is reported as interrupted").
 *
 * This module makes no I/O of its own, holds no live collaborator, and
 * imports nothing from `src/providers/` or `vscode`: every function here is
 * a pure decision (or a pure transform of already-persisted data) over
 * values a caller already has — a stored `ReviewRunSnapshot`, a stored
 * `PersistedCheckpoint`, a freshly-built candidate `ReviewRunSnapshot` for
 * what a new attempt would use right now, and (for evidence reuse) an
 * `EvidenceLedger` the caller already constructed for the new attempt. That
 * is deliberate: wiring a live resumed `HarnessAttempt` — minting the new
 * attempt's identifiers, constructing its ledger/dispatcher/`Connection`s,
 * executing any refetches this module says are required, and actually
 * starting `createHarnessAttempt` — is runtime integration (task 12.1), not
 * this pass. What this module hands that integration is exactly the pure
 * decision plus data it needs to do so honestly.
 *
 * **REUSE, DO NOT REINVENT.** Every dimension check below compares fields
 * `ReviewRunSnapshot` (task 2.2) and `PersistedCheckpoint` (task 11.2)
 * already carry; nothing here re-derives a value those types do not already
 * store. Evidence reuse calls the evidence ledger's own
 * `importRetainedSource` (task 7.4) and reads its refusal outcome directly —
 * no second digest or content check. Closing a lost attempt as interrupted
 * calls `harnessCheckpoint.ts`'s `closeCheckpointAsTerminal`, which reuses
 * `appendActivityEvent`'s existing sanitizer/validation and
 * `compactActivity`'s existing bound accounting — this module supplies only
 * the terminal fact's content (lifecycle, completeness, and one bounded
 * `Limitation`), never a second activity-mutation path.
 *
 * **D13's rule that matters most, restated as a type-level fact:** nothing
 * in this module ever produces a value that lets a caller treat a resume as
 * anything but a brand new attempt number in the same lineage. There is no
 * function here that "reattaches" or "reconnects" a prior attempt — the only
 * two shapes a caller can act on are `{ kind: 'compatible', payload,
 * startAction }` (start attempt N+1 fresh, seeded from N's checkpoint) and
 * `{ kind: 'incompatible', reasons }` (offer a fresh restart: a new
 * `ReviewRunSnapshot` under a new `lineageId`, attempt 1, built the ordinary
 * way through `buildReviewRunSnapshot` — nothing here is required for that
 * path beyond what already exists, and nothing here can accidentally carry
 * old evidence, findings, or coverage into it, because a fresh restart never
 * calls any function in this module at all). Every user-facing string this
 * module produces is asserted against a forbidden-wording test in
 * `harnessResume.test.ts` ("reconnect", "reattach", "resum(e/ed/ing)",
 * "continu(e/ed/ing/ation)", "still connected", "same session/stream/attempt",
 * "picks ... back up" — none may ever appear).
 */
import { canonicalStringify } from './contentDigest';
import { closeCheckpointAsTerminal, computeSnapshotDigest, requiredSourceIds, type PersistedCheckpoint, type RetryState } from './harnessCheckpoint';
import { sanitizePublicText } from './harnessActivitySanitizer';
import type { ActivityFact } from './harnessActivityLog';
import type { TrackedCandidate } from './harnessCandidateValidation';
import type { BudgetConsumption, MemberCoverage } from '../domain/harnessCoverage';
import type { EvidenceLedger, RegistrationRefusal, RetainedEvidenceRecord } from './harnessEvidenceLedger';
import type { Limitation, Plan, RunPhase } from '../domain/harnessActivity';
import type { AttemptNumber } from '../domain/harnessLifecycle';
import type { ReviewRunAttachmentSnapshot, ReviewRunMemberSnapshot, ReviewRunSnapshot } from '../domain/reviewRunSnapshot';

// ---- Dimension codes (task 11.5) -----------------------------------------------------

/**
 * Every dimension task 11.5 names, as it maps onto `ReviewRunSnapshot`'s own
 * fields (see that type's doc comment for the field list this mirrors).
 * `checkpointIntegrity` is the one dimension that is not a snapshot-field
 * comparison — it is "is the stored checkpoint itself well-formed and still
 * hashes to what it claims" (task 11.5's "digests" and "checkpoint version").
 * "Required exact evidence" (also named in 11.5) deliberately has no code
 * here: per the correctness rule, a retained source that fails to reimport
 * is never a resume blocker by itself — see `importRetainedEvidence` below,
 * which reports it as a per-source refetch decision instead.
 */
export const RESUME_INCOMPATIBILITY_CODES = [
  'checkpointIntegrity',
  'lineageIdentity',
  'schemaVersion',
  'toolContractVersion',
  'harnessPolicyVersion',
  'repositoryIdentity',
  'headRevision',
  'model',
  'agentInstructions',
  'persona',
  'effort',
  'criteria',
  'extraInstructions',
  'contextSelections',
  'attachmentDigests',
  'providerCapabilitySignature',
] as const;

export type ResumeIncompatibilityCode = (typeof RESUME_INCOMPATIBILITY_CODES)[number];

/** Bounds and validates a reason's message the same way `appendActivityEvent` would (`harnessActivityLog.ts`'s own `sanitizeLimitations`) — defense in depth: every message here is already a short, safe, our-own-template string, never raw snapshot content. */
function reason(code: ResumeIncompatibilityCode, message: string): Limitation {
  return { code, message: sanitizePublicText(message) ?? 'A resume compatibility check failed.' };
}

// ---- Checkpoint integrity (task 11.5 "versions, digests") ---------------------------

/**
 * Structural/digest integrity of the checkpoint a resume would build on —
 * separate from whether it still matches the *current* world (that is
 * `checkSnapshotCompatibility` below). A checkpoint already marked
 * incompatible by 11.4's retention bound folds its own reasons in verbatim
 * rather than being re-derived.
 */
export function checkCheckpointIntegrity(storedSnapshot: ReviewRunSnapshot, checkpoint: PersistedCheckpoint): readonly Limitation[] {
  const reasons: Limitation[] = [];
  if (checkpoint.lineageId !== storedSnapshot.lineageId || checkpoint.attempt !== storedSnapshot.attempt) {
    reasons.push(
      reason(
        'checkpointIntegrity',
        `The stored checkpoint belongs to lineage ${checkpoint.lineageId} attempt ${checkpoint.attempt}, not the snapshot's own lineage ${storedSnapshot.lineageId} attempt ${storedSnapshot.attempt}.`,
      ),
    );
  }
  if (computeSnapshotDigest(storedSnapshot) !== checkpoint.snapshotDigest) {
    reasons.push(reason('checkpointIntegrity', 'The stored snapshot no longer hashes to the digest its checkpoint recorded; the checkpoint cannot be trusted for resume.'));
  }
  if (!checkpoint.compatible) {
    for (const retentionReason of checkpoint.incompatibilityReasons) {
      reasons.push(reason('checkpointIntegrity', retentionReason));
    }
    if (checkpoint.incompatibilityReasons.length === 0) {
      reasons.push(reason('checkpointIntegrity', 'The stored checkpoint is marked incompatible.'));
    }
  }
  return reasons;
}

// ---- Snapshot-vs-snapshot compatibility (task 11.5's remaining dimensions) ----------

function sortedIds(ids: readonly string[]): readonly string[] {
  return [...ids].sort();
}

function attachmentKey(attachment: ReviewRunAttachmentSnapshot): string {
  return `${attachment.attachmentId}:${attachment.contentDigest}`;
}

function checkMemberDimensions(stored: ReviewRunMemberSnapshot, candidate: ReviewRunMemberSnapshot, reasons: Limitation[]): void {
  if (stored.providerId !== candidate.providerId || stored.instanceUrl !== candidate.instanceUrl || stored.ref.repoId !== candidate.ref.repoId || stored.ref.number !== candidate.ref.number) {
    reasons.push(reason('repositoryIdentity', `Member ${stored.memberId}'s provider or repository identity changed.`));
  }
  if (stored.baseSha !== candidate.baseSha) {
    reasons.push(reason('headRevision', `Member ${stored.memberId}'s base revision changed from ${stored.baseSha} to ${candidate.baseSha}.`));
  }
  if (stored.headSha !== candidate.headSha) {
    reasons.push(reason('headRevision', `Member ${stored.memberId}'s head revision changed from ${stored.headSha} to ${candidate.headSha}.`));
  }
  if (stored.providerCapabilitySignature !== candidate.providerCapabilitySignature) {
    reasons.push(reason('providerCapabilitySignature', `Member ${stored.memberId}'s provider capability signature changed.`));
  }
  const storedContext = { autoContextEnabled: stored.context.autoContextEnabled, titleIncluded: stored.context.titleIncluded, descriptionIncluded: stored.context.descriptionIncluded, linkedItemIdsIncluded: sortedIds(stored.context.linkedItemIdsIncluded) };
  const candidateContext = { autoContextEnabled: candidate.context.autoContextEnabled, titleIncluded: candidate.context.titleIncluded, descriptionIncluded: candidate.context.descriptionIncluded, linkedItemIdsIncluded: sortedIds(candidate.context.linkedItemIdsIncluded) };
  if (canonicalStringify(storedContext) !== canonicalStringify(candidateContext)) {
    reasons.push(reason('contextSelections', `Member ${stored.memberId}'s context selection changed.`));
  }
  const storedAttachments = sortedIds(stored.context.attachments.map(attachmentKey));
  const candidateAttachments = sortedIds(candidate.context.attachments.map(attachmentKey));
  if (canonicalStringify(storedAttachments) !== canonicalStringify(candidateAttachments)) {
    reasons.push(reason('attachmentDigests', `Member ${stored.memberId}'s attachment set changed.`));
  }
}

/**
 * Every dimension task 11.5 names that is a direct comparison between what a
 * resumed attempt would use right now (`candidate`, built by the caller
 * exactly the way an ordinary new run's snapshot is built — through
 * `buildReviewRunSnapshot`, with the current head, current agent/model/
 * capabilities) and what the lost attempt actually used (`stored`).
 */
export function checkSnapshotCompatibility(stored: ReviewRunSnapshot, candidate: ReviewRunSnapshot): readonly Limitation[] {
  const reasons: Limitation[] = [];

  // D2's "the rule that matters most": a resumed attempt is a new attempt number in the *same*
  // lineage, never a different run or lineage. Nothing else below can catch a caller that built
  // `candidate` from the wrong run — this is the one structural guard for it.
  if (stored.runId !== candidate.runId || stored.lineageId !== candidate.lineageId) {
    reasons.push(reason('lineageIdentity', 'A resumed attempt must stay in the same run and lineage as the attempt it resumes.'));
  }

  if (stored.schemaVersion !== candidate.schemaVersion) reasons.push(reason('schemaVersion', `Snapshot schema version changed from ${stored.schemaVersion} to ${candidate.schemaVersion}.`));
  if (stored.toolContractVersion !== candidate.toolContractVersion) {
    reasons.push(reason('toolContractVersion', `Host tool contract version changed from ${stored.toolContractVersion} to ${candidate.toolContractVersion}.`));
  }
  if (stored.harnessPolicyVersion !== candidate.harnessPolicyVersion) {
    reasons.push(reason('harnessPolicyVersion', `Harness policy version changed from ${stored.harnessPolicyVersion} to ${candidate.harnessPolicyVersion}.`));
  }
  if (stored.targetKind !== candidate.targetKind || stored.changesetId !== candidate.changesetId) {
    reasons.push(reason('repositoryIdentity', 'The run target changed between an individual review and a changeset, or the changeset identity changed.'));
  }
  const storedMemberIds = sortedIds(stored.members.map((member) => member.memberId));
  const candidateMemberIds = sortedIds(candidate.members.map((member) => member.memberId));
  if (canonicalStringify(storedMemberIds) !== canonicalStringify(candidateMemberIds)) {
    reasons.push(reason('repositoryIdentity', 'The set of members in this run changed.'));
  } else {
    const candidateByMemberId = new Map(candidate.members.map((member) => [member.memberId, member] as const));
    for (const storedMember of stored.members) {
      const candidateMember = candidateByMemberId.get(storedMember.memberId);
      if (candidateMember) checkMemberDimensions(storedMember, candidateMember, reasons);
    }
  }

  if (stored.agentId !== candidate.agentId || stored.agentInstructionsDigest !== candidate.agentInstructionsDigest) {
    reasons.push(reason('agentInstructions', 'The selected agent or its resolved instructions changed.'));
  }
  if (stored.personaLabel !== candidate.personaLabel) reasons.push(reason('persona', `Persona changed from "${stored.personaLabel}" to "${candidate.personaLabel}".`));
  if (stored.modelId !== candidate.modelId || canonicalStringify(stored.modelCapability) !== canonicalStringify(candidate.modelCapability)) {
    reasons.push(reason('model', 'The selected model or its capability metadata changed.'));
  }
  if (stored.effort !== candidate.effort || stored.effortInstructionDigest !== candidate.effortInstructionDigest) {
    reasons.push(reason('effort', `Thinking effort changed from ${stored.effort} to ${candidate.effort}.`));
  }
  const storedCriteriaCore = { severityFloor: stored.criteria.severityFloor, categories: sortedIds(stored.criteria.categories), minConfidence: stored.criteria.minConfidence };
  const candidateCriteriaCore = { severityFloor: candidate.criteria.severityFloor, categories: sortedIds(candidate.criteria.categories), minConfidence: candidate.criteria.minConfidence };
  if (canonicalStringify(storedCriteriaCore) !== canonicalStringify(candidateCriteriaCore)) {
    reasons.push(reason('criteria', 'Review criteria (severity floor, categories, or minimum confidence) changed.'));
  }
  if (stored.extraInstructionsDigest !== candidate.extraInstructionsDigest) {
    reasons.push(reason('extraInstructions', 'Extra review instructions changed.'));
  }

  return reasons;
}

// ---- The top-level compatibility check (task 11.5) -----------------------------------

export interface ResumeCompatibilityInput {
  readonly storedSnapshot: ReviewRunSnapshot;
  readonly checkpoint: PersistedCheckpoint;
  /** What a new attempt would use right now, built the ordinary way by the caller (`buildReviewRunSnapshot`) — never re-resolved by this module. */
  readonly candidateSnapshot: ReviewRunSnapshot;
}

export interface ResumeCompatibilityResult {
  readonly compatible: boolean;
  /** Every failing dimension, not the first (task 11.7) — possibly more than one reason per dimension (e.g. two members each with a changed head). */
  readonly reasons: readonly Limitation[];
}

export function evaluateResumeCompatibility(input: ResumeCompatibilityInput): ResumeCompatibilityResult {
  const reasons = [...checkCheckpointIntegrity(input.storedSnapshot, input.checkpoint), ...checkSnapshotCompatibility(input.storedSnapshot, input.candidateSnapshot)];
  return { compatible: reasons.length === 0, reasons };
}

// ---- Evidence reuse (task 11.6: refetch rather than claim stale evidence is visible) --

export interface EvidenceReuseOutcome {
  readonly priorSourceId: string;
  /** Whether a currently-accepted finding actually cites this source (`requiredSourceIds`) — a refusal here must be refetched before citation revalidation; an unrequired refusal can be left for the model to ask for again. */
  readonly requiredByCitation: boolean;
  readonly outcome:
    | { readonly kind: 'reused' }
    | { readonly kind: 'refetchRequired'; readonly code: RegistrationRefusal; readonly reason: Limitation; readonly priorMetadata: RetainedEvidenceRecord };
}

/**
 * D8/11.6: "A resume may import a persisted source only when its exact
 * content is retained and its digest and snapshot still match. Otherwise the
 * new attempt refetches it and records a new source linked to the prior
 * metadata." This function is the whole decision: it calls the evidence
 * ledger's own `importRetainedSource` for every retained record and reports
 * its refusal outcome directly — never a second digest or content check.
 * `ledger` must already be the *new* attempt's ledger (constructed by the
 * caller, task 12.1); a successful import lands in it as a side effect,
 * exactly as it would for a fresh registration.
 */
export function importRetainedEvidence(
  ledger: EvidenceLedger,
  retained: readonly RetainedEvidenceRecord[],
  candidates: readonly TrackedCandidate[],
): readonly EvidenceReuseOutcome[] {
  const required = requiredSourceIds(candidates);
  return retained.map((record): EvidenceReuseOutcome => {
    const requiredByCitation = required.has(record.sourceId);
    const outcome = ledger.importRetainedSource(record);
    if (outcome.ok) return { priorSourceId: record.sourceId, requiredByCitation, outcome: { kind: 'reused' } };
    return {
      priorSourceId: record.sourceId,
      requiredByCitation,
      outcome: {
        kind: 'refetchRequired',
        code: outcome.code,
        reason: { code: outcome.code, message: sanitizePublicText(outcome.message) ?? 'This retained source must be fetched again.' },
        priorMetadata: record,
      },
    };
  });
}

// ---- Interrupting the lost attempt (task 11.6) ---------------------------------------

/**
 * Whatever validated findings survive on the lost attempt's last checkpoint
 * determine whether it closes with completeness `partial` or `none` — the
 * same "cancellation preserves only already-validated findings, as partial"
 * reasoning `harnessAttempt.ts`'s own persistence step uses for cancellation,
 * applied here because a checkpoint has no live inventory/coverage to run a
 * real completion evaluation against.
 */
export function computeInterruptedCompleteness(candidates: readonly TrackedCandidate[]): 'partial' | 'none' {
  return candidates.some((candidate) => candidate.state === 'accepted' && candidate.finding !== undefined) ? 'partial' : 'none';
}

/** No "reconnect"/"resume"/"continue" wording anywhere here (see the file header) — only that this attempt is now closed. */
export function interruptedLimitation(attempt: AttemptNumber, phase: RunPhase): Limitation {
  return {
    code: 'interruptedByRestart',
    message:
      sanitizePublicText(`Attempt ${attempt} did not survive an extension restart. It stopped during the ${phase} phase and is now closed as interrupted.`) ??
      `Attempt ${attempt} is interrupted.`,
  };
}

/**
 * Closes the lost attempt's *own* last checkpoint as `interrupted` (D13:
 * "Activation closes every persisted nonterminal attempt as `interrupted`
 * before rendering") — the same attempt number, never a new one; the new
 * attempt this lineage may later get is a separate act
 * (`describeResumeStart`/`decideResume` below). `undefined` exactly when
 * `closeCheckpointAsTerminal` returns `undefined`: already terminal (a
 * completed run leaves no interrupted marker), or the fact/context failed
 * validation.
 */
export function closeAttemptAsInterrupted(
  latest: PersistedCheckpoint,
  context: { checkpointId: string; occurredAt: string },
  policy: Parameters<typeof closeCheckpointAsTerminal>[2],
): PersistedCheckpoint | undefined {
  const completeness = computeInterruptedCompleteness(latest.candidates);
  const terminalFact: Extract<ActivityFact, { kind: 'terminalResult' }> = {
    kind: 'terminalResult',
    lifecycle: 'interrupted',
    completeness,
    limitations: [interruptedLimitation(latest.attempt, latest.phase)],
  };
  return closeCheckpointAsTerminal(latest, { checkpointId: context.checkpointId, occurredAt: context.occurredAt, reason: 'attemptInterrupted', terminalFact }, policy);
}

// ---- Starting the new attempt (task 11.6: "a new attempt number in the same lineage") --

export function nextAttemptNumber(prior: AttemptNumber): AttemptNumber {
  return prior + 1;
}

/**
 * The public narrative for the new attempt's activity (task 11.8's
 * "no-reconnect wording", spec: "activity and evidence identify the attempt
 * boundary"). Production code does not yet call `appendActivityEvent` with
 * this — no live `HarnessAttempt` exists to own that log until task 12.1
 * starts one — but the string itself is final: it is asserted, post-sanitizer,
 * in `harnessResume.test.ts`.
 */
export function describeResumeStart(priorAttempt: AttemptNumber, newAttempt: AttemptNumber, priorPhase: RunPhase): string {
  return `Starting attempt ${newAttempt} in this lineage from the checkpoint attempt ${priorAttempt} left during the ${priorPhase} phase. Attempt ${priorAttempt} is interrupted; this is a new attempt with its own model and tool session.`;
}

// ---- What section 12 carries forward into the new attempt (task 11.6) ---------------

/**
 * "Preserve the plan and its revision history, coverage, validated findings
 * and their validation state, and budget consumed so far" (task 11.6) — read
 * straight off the compatible checkpoint, untouched. `retainedEvidence` is
 * handed separately to `importRetainedEvidence` once the caller has the new
 * attempt's ledger; this payload only carries the metadata through.
 */
export interface ResumePayload {
  readonly priorAttempt: AttemptNumber;
  readonly newAttempt: AttemptNumber;
  readonly plan?: Plan;
  readonly coverage: readonly MemberCoverage[];
  readonly candidates: readonly TrackedCandidate[];
  readonly budget: BudgetConsumption;
  readonly retry: RetryState;
  readonly retainedEvidence: readonly RetainedEvidenceRecord[];
}

export function buildResumePayload(checkpoint: PersistedCheckpoint): ResumePayload {
  return {
    priorAttempt: checkpoint.attempt,
    newAttempt: nextAttemptNumber(checkpoint.attempt),
    plan: checkpoint.plan,
    coverage: checkpoint.coverage,
    candidates: checkpoint.candidates,
    budget: checkpoint.budget,
    retry: checkpoint.retry,
    retainedEvidence: checkpoint.evidence,
  };
}

// ---- The one decision (tasks 11.6/11.7) ----------------------------------------------

export type ResumeDecision =
  | { readonly kind: 'compatible'; readonly payload: ResumePayload; readonly startAction: string }
  | { readonly kind: 'incompatible'; readonly reasons: readonly Limitation[] };

/**
 * Ties 11.5's check to 11.6/11.7's outcome. `kind: 'incompatible'` is 11.7's
 * "reject with all reasons and offer a fresh restart" — the fresh restart
 * itself needs nothing from this module: it is an ordinary new
 * `ReviewRunSnapshot` under a new `lineageId`, attempt 1, built through
 * `buildReviewRunSnapshot` exactly as any new run is. Because a fresh
 * restart never calls this module at all, it structurally cannot mix in a
 * prior lineage's revisions, attempts, or evidence — there is no code path
 * here that could hand any of that across.
 */
export function decideResume(input: ResumeCompatibilityInput): ResumeDecision {
  const result = evaluateResumeCompatibility(input);
  if (!result.compatible) return { kind: 'incompatible', reasons: result.reasons };
  const newAttempt = nextAttemptNumber(input.checkpoint.attempt);
  return {
    kind: 'compatible',
    payload: buildResumePayload(input.checkpoint),
    startAction: describeResumeStart(input.checkpoint.attempt, newAttempt, input.checkpoint.phase),
  };
}
