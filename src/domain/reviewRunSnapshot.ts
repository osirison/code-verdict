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

/**
 * What a recorded `baseSha` means (`add-local-git-investigation` design.md
 * D4). The two are different commits whenever anything has landed on the
 * target branch since the change request was cut, and nothing in a 40-hex
 * string says which one it is.
 */
export type BaseRevisionKind = 'mergeBase' | 'targetBranchTip';

/**
 * Which source answered this member's five pinned investigation operations
 * (`add-local-git-investigation` design.md D5). Two of them exist: a local
 * object store this extension owns, and the provider connection itself.
 */
/**
 * What served a member's investigation.
 *
 * - `localGit` — a bare object store this extension owns, read by git. The only
 *   kind a connected pod can ever produce.
 * - `sample` — the demo pod's built-in sample change, which exists in no
 *   repository and on no remote, so there is nothing for git to read. Supplied
 *   by the host for that one pod; never selected in competition with anything.
 * - `provider` — a forge, answering the five pinned operations over its REST
 *   API. **Nothing writes this any more.** It stays in the union because stored
 *   snapshots carry it, and resume has to read one and refuse it with the
 *   source-changed reason rather than fail to parse a record it wrote itself.
 */
export type InvestigationSourceKind = 'localGit' | 'sample' | 'provider';

/**
 * The selected source, recorded on the member snapshot (task 9.4).
 *
 * It sits beside `providerCapabilitySignature` rather than replacing it: the
 * provider still serves change-request details, the head check and posting, so
 * both statements are true at once and each describes a different answerer.
 *
 * - `contractVersion` is the version of the neutral investigation contract the
 *   source answered under (`INVESTIGATION_CONTRACT_VERSION`), so a record says
 *   which shape of request and result it was written against.
 * - `capabilitySignature` signs the investigation capability set this attempt
 *   actually had for this member — the selected source's own declaration after
 *   the host's policy narrowed it — so a later attempt cannot silently gain a
 *   tool the recorded one did not have.
 */
export interface ReviewRunInvestigationSource {
  readonly kind: InvestigationSourceKind;
  readonly contractVersion: string;
  readonly capabilitySignature: string;
}

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
  /**
   * Which commit `baseSha` above is. Optional for exactly one reason: records
   * already on disk predate the field, and they were all written when
   * `baseSha` was the target-branch tip. Read it through
   * `baseRevisionKindOf()` — never `?? something` at a call site, or the
   * default stops being one decision.
   */
  baseRevisionKind?: BaseRevisionKind;
  headSha: string;
  /**
   * Which source served this member's investigation, selected once before any
   * model work (task 9.1). Optional for the same single reason
   * `baseRevisionKind` is: records already on disk predate the field, and every
   * one of them was served by the provider, because nothing else existed. Read
   * it through `investigationSourceKindOf()`.
   */
  investigationSource?: ReviewRunInvestigationSource;
  providerCapabilitySignature: string;
  rootAgentsPolicy: ReviewRunAgentsPolicySource;
  context: ReviewRunContextSelections;
}

/**
 * The meaning a member snapshot's `baseSha` carries.
 *
 * Absence is a fact, not an unknown: every snapshot written before
 * `add-local-git-investigation` used the target-branch tip by construction
 * (GitHub reported `pull.base.sha`), so a stored record with no
 * `baseRevisionKind` is a record of a target-branch tip and is read as one.
 * Resume compares the meaning before it compares the commit (task 9.5), and
 * this is the single place that decision lives.
 */
export function baseRevisionKindOf(member: Pick<ReviewRunMemberSnapshot, 'baseRevisionKind'>): BaseRevisionKind {
  return member.baseRevisionKind ?? 'targetBranchTip';
}

/**
 * Which source a member snapshot's evidence came from.
 *
 * Absence is a fact here too: every snapshot written before
 * `add-local-git-investigation` was served by the provider connection, because
 * it was the only thing that could answer an investigation operation. So a
 * stored record with no `investigationSource` is a record of a provider-served
 * attempt and is read as one — and a resumed attempt that would now use the
 * local source compares as a source change (task 9.5), which is exactly what it
 * is.
 *
 * Only the kind has a defined meaning for an absent field: the contract version
 * and capability signature of a record that predates them were never written
 * down, and inventing values for them would put two claims in a record that
 * only ever made one. Resume compares the kind and nothing else here (task 9.5).
 */
export function investigationSourceKindOf(member: Pick<ReviewRunMemberSnapshot, 'investigationSource'>): InvestigationSourceKind {
  return member.investigationSource?.kind ?? 'provider';
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
