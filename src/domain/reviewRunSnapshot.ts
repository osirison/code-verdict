/**
 * `ReviewRunSnapshot` and per-member snapshot types (task 2.2 of
 * `add-agentic-review-harness`, design.md D3).
 *
 * This is a new, additive domain type — it does not replace, alias, or
 * narrow `RunInput` in `src/app/reviewRunManager.ts`. D3's "`RunInput`
 * becomes a versioned `ReviewRunSnapshot`" describes where this migration is
 * headed across the whole change, not an edit made in this task: task 15.8
 * still names `RunInput` and only removes whole-diff capture from it, and
 * task 6.1 (a later section) is what actually replaces the mutable
 * run-input payload with a snapshot builder. Until then `RunInput` keeps
 * carrying what a runner call needs (UI labels, timeouts, the in-flight
 * step log), while `ReviewRunSnapshot` carries what evidence, resume and
 * completion validation need: immutable identity, revisions and digests.
 * Every field below is a primitive, digest, or a locally defined shape —
 * never an app-layer type (`AgentDescriptor`, `Attachment`, `ReviewContext`)
 * — so `src/domain/` does not gain a dependency on `src/app/`.
 */
import type { ChangeRequestRef } from '../platform/types';
import type { Criteria } from './types';
import type { EffortLevel } from './effort';
import type { AttemptNumber, LineageId, RunId } from './harnessLifecycle';

export type ReviewRunTargetKind = 'cr' | 'changeset';

/** An `AGENTS.md` chain always starts at a member's own base-revision root. */
export type ReviewRunAgentsPolicySource =
  | { readonly present: true; readonly sourceId: string; readonly digest: string }
  | { readonly present: false };

/** One explicit citable attachment, bound to the member that owns it. */
export interface ReviewRunAttachmentSnapshot {
  attachmentId: string;
  label: string;
  contentDigest: string;
}

/** What auto-derived context and explicit attachments this member's run carried. */
export interface ReviewRunContextSelections {
  autoContextEnabled: boolean;
  titleIncluded: boolean;
  descriptionIncluded: boolean;
  /** Individually removable per `review-context-controls`; the ids actually included, not just a count. */
  linkedItemIdsIncluded: readonly string[];
  attachments: readonly ReviewRunAttachmentSnapshot[];
}

/**
 * One repository within the run: an individual review has exactly one, a
 * changeset has one per member. Provider/host/repository/target identity
 * (D3) is `providerId` + `instanceUrl` + `ref`; changeset-member identity is
 * `memberId`.
 */
export interface ReviewRunMemberSnapshot {
  memberId: string;
  providerId: string;
  instanceUrl: string;
  ref: ChangeRequestRef;
  baseSha: string;
  headSha: string;
  providerCapabilitySignature: string;
  rootAgentsPolicy: ReviewRunAgentsPolicySource;
  context: ReviewRunContextSelections;
}

/** Absent entirely for the demo agent, which calls no model. */
export interface ReviewRunModelCapabilitySnapshot {
  vendor: string;
  family: string;
  maxInputTokens?: number;
}

/**
 * Captured once, before admission dispatch, and never re-read: a pod switch,
 * a criteria edit or an agent-file change after this point cannot reach an
 * attempt already using this snapshot (D3).
 */
export interface ReviewRunSnapshot {
  schemaVersion: string;
  runId: RunId;
  lineageId: LineageId;
  attempt: AttemptNumber;
  createdAt: string;
  targetKind: ReviewRunTargetKind;
  /** Present only when `targetKind` is `'changeset'`. */
  changesetId?: string;
  members: readonly ReviewRunMemberSnapshot[];
  agentId: string;
  /** The resolved instruction text itself, so a resumed attempt never re-reads a possibly-changed agent file. */
  agentInstructions: string;
  agentInstructionsDigest: string;
  personaLabel: string;
  /** Absent only for the demo agent. */
  modelId?: string;
  modelCapability?: ReviewRunModelCapabilitySnapshot;
  effort: EffortLevel;
  effortInstructionDigest: string;
  criteria: Criteria;
  extraInstructionsDigest: string;
  toolContractVersion: string;
  harnessPolicyVersion: string;
}
