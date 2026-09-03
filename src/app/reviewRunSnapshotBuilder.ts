/**
 * Builds an immutable `ReviewRunSnapshot` (task 6.1 of
 * `add-agentic-review-harness`, design.md D3).
 *
 * This is additive, not a replacement of `RunInput` (`reviewRunManager.ts`):
 * repo memory already resolved that `ReviewRunSnapshot` is a new, distinct
 * type, and `RunInput`'s own removal is tasks 12/15.8 — not this one. Nothing
 * here is wired into `ReviewRunManager` yet; a future admission path calls
 * `buildReviewRunSnapshot` with values it already resolved (the agent, model,
 * effort, criteria, per-member repository/revision/capabilities and context),
 * and this module resolves those into the frozen snapshot shape and computes
 * every digest — it performs no provider or model I/O of its own.
 *
 * "Resolves" here means *settles* the given inputs into the immutable
 * snapshot shape, not *looks up* live state — D3 is explicit that the
 * snapshot "never reads mutable pod, picker, workspace, branch, or
 * agent-file state again" once built, so any network resolution (base SHA,
 * `AGENTS.md` presence) happens in the caller before this function runs
 * (`AGENTS.md` chain resolution itself is task 6.3, `harnessAgentsPolicy.ts`).
 *
 * Digests use `node:crypto` sha256 hex, the same primitive
 * `src/ui/reviewFlow.ts` and `src/ui/changesetReview.ts` already use for a
 * prompt hash — no new hashing dependency. Capability signatures hash a
 * canonical (sorted-key) JSON serialization so two structurally identical
 * `ProviderCapabilities` objects always sign the same regardless of source
 * key order, and any real capability difference always signs differently.
 * Both helpers live in `./contentDigest` so the evidence ledger shares them.
 */
import type { AgentDescriptor, ModelDescriptor } from './agents';
import { canonicalStringify, sha256Hex } from './contentDigest';
import type { Attachment, ReviewContext } from './reviewContext';
import { HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import type { Criteria } from '../domain/types';
import { effortPrompt, type EffortLevel } from '../domain/effort';
import type { AttemptNumber, LineageId, RunId } from '../domain/harnessLifecycle';
import type {
  ReviewRunAgentsPolicySource,
  ReviewRunContextSelections,
  ReviewRunMemberSnapshot,
  ReviewRunSnapshot,
  ReviewRunTargetKind,
} from '../domain/reviewRunSnapshot';
import type { ChangeRequestRef } from '../platform/types';
import type { ProviderCapabilities } from '../platform/provider';

/** Versions the shape of the (not-yet-built, section 9) host tool catalog this snapshot pins. */
export const HARNESS_TOOL_CONTRACT_VERSION = '1';

/** Content-addressed: identical capability declarations always sign identically, any real difference never does. */
export function providerCapabilitySignature(capabilities: ProviderCapabilities): string {
  return sha256Hex(canonicalStringify(capabilities));
}

/**
 * One repository/member input to the snapshot. `baseSha`/`headSha` and
 * `rootAgentsPolicy` must already be resolved by the caller (D3's snapshot
 * never performs its own provider reads).
 */
export interface ReviewRunSnapshotMemberInput {
  memberId: string;
  providerId: string;
  instanceUrl: string;
  ref: ChangeRequestRef;
  baseSha: string;
  headSha: string;
  capabilities: ProviderCapabilities;
  rootAgentsPolicy: ReviewRunAgentsPolicySource;
  /** Absent for a member with no auto-derived context at all (e.g. the demo agent). */
  context?: ReviewContext;
  /** Explicit citable evidence selected for this member. */
  attachments?: readonly Attachment[];
}

export interface ReviewRunSnapshotInput {
  runId: RunId;
  lineageId: LineageId;
  attempt: AttemptNumber;
  /** Defaults to the current time; tests pass an explicit value for determinism. */
  createdAt?: string;
  targetKind: ReviewRunTargetKind;
  /** Required only when `targetKind` is `'changeset'`. */
  changesetId?: string;
  members: readonly ReviewRunSnapshotMemberInput[];
  agent: AgentDescriptor;
  /** Absent only for the demo agent, which calls no model. */
  model?: ModelDescriptor;
  effort: EffortLevel;
  criteria: Criteria;
  toolContractVersion?: string;
}

/**
 * `ReviewRunContextSelections.autoContextEnabled` has no upstream single
 * boolean to read: `review-context-controls` tracks inclusion per source
 * (title/description/each linked item), not one master switch. Resolved
 * here as "a context was available for this member at all" — `false` only
 * when the member carries no `ReviewContext` (e.g. the demo agent), `true`
 * otherwise even if every individual source was toggled off, which is
 * exactly what `titleIncluded`/`descriptionIncluded`/`linkedItemIdsIncluded`
 * already report distinctly.
 */
function buildContextSelections(
  context: ReviewContext | undefined,
  attachments: readonly Attachment[] | undefined,
): ReviewRunContextSelections {
  return {
    autoContextEnabled: context !== undefined,
    titleIncluded: context !== undefined && context.includeTitle !== false,
    descriptionIncluded: context !== undefined && context.includeDescription !== false,
    linkedItemIdsIncluded: context ? context.linkedItems.map((item) => item.number) : [],
    attachments: (attachments ?? []).map((attachment) => ({
      attachmentId: attachment.id,
      label: attachment.label,
      contentDigest: sha256Hex(attachment.content),
    })),
  };
}

function buildMemberSnapshot(member: ReviewRunSnapshotMemberInput): ReviewRunMemberSnapshot {
  return {
    memberId: member.memberId,
    providerId: member.providerId,
    instanceUrl: member.instanceUrl,
    ref: member.ref,
    baseSha: member.baseSha,
    headSha: member.headSha,
    providerCapabilitySignature: providerCapabilitySignature(member.capabilities),
    rootAgentsPolicy: member.rootAgentsPolicy,
    context: buildContextSelections(member.context, member.attachments),
  };
}

/**
 * Builds the frozen `ReviewRunSnapshot`. Every agent, model, effort,
 * criteria, context-control, attachment, provider-capability, repository,
 * and revision input is resolved into the snapshot's own fields here, and
 * every digested field (`agentInstructionsDigest`, `effortInstructionDigest`,
 * `extraInstructionsDigest`, each member's `providerCapabilitySignature` and
 * each attachment's `contentDigest`) is computed by this function — a
 * caller never passes a pre-computed digest in.
 */
export function buildReviewRunSnapshot(input: ReviewRunSnapshotInput): ReviewRunSnapshot {
  if (input.members.length === 0) {
    throw new Error('buildReviewRunSnapshot requires at least one member.');
  }
  return {
    schemaVersion: '1',
    runId: input.runId,
    lineageId: input.lineageId,
    attempt: input.attempt,
    createdAt: input.createdAt ?? new Date().toISOString(),
    targetKind: input.targetKind,
    changesetId: input.changesetId,
    members: input.members.map(buildMemberSnapshot),
    agentId: input.agent.id,
    agentInstructions: input.agent.instructions,
    agentInstructionsDigest: sha256Hex(input.agent.instructions),
    personaLabel: input.agent.label,
    modelId: input.model?.id,
    modelCapability: input.model
      ? { vendor: input.model.vendor, family: input.model.family, maxInputTokens: input.model.maxInputTokens }
      : undefined,
    effort: input.effort,
    effortInstructionDigest: sha256Hex(effortPrompt(input.effort)),
    criteria: input.criteria,
    extraInstructionsDigest: sha256Hex(input.criteria.extraInstructions),
    toolContractVersion: input.toolContractVersion ?? HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
  };
}
