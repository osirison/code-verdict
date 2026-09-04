/**
 * Bootstrap section models and the isolated bootstrap envelope (tasks 6.2,
 * 6.4, 6.5 of `add-agentic-review-harness`, design.md D4).
 *
 * Pure and `vscode`/`node`-free, like the rest of `src/domain`: digests are
 * computed by the caller (the same division of labor `reviewRunSnapshot.ts`
 * uses — every digest field here is an input, never computed in this file)
 * and any provider or model I/O (fetching `NormalizedDetail`, counting
 * tokens) belongs to the app layer that calls these builders
 * (`harnessBootstrapBudget.ts`, task 6.6).
 *
 * The envelope is a **typed object structure**, not a hand-rolled string
 * with delimiters. That is what makes task 6.4's isolation structural rather
 * than conventional: an `authoritative.agentInstructions` string and an
 * `untrusted[].changeRequestDetails.content` string are different fields of
 * different shape on different sides of the type, so no byte sequence
 * placed inside untrusted content can turn into a tool-catalog entry, a
 * criteria field, or a second bootstrap section — there is no shared
 * delimiter or parser for it to escape through. Task 6.7's adversarial
 * tests (`harnessBootstrap.test.ts`) prove this empirically per field
 * rather than resting on the type alone.
 *
 * `AGENTS.md` policy is repository-sourced but is *not* untrusted data here:
 * design.md D7 and task 6.4 both place "policy" on the authoritative side,
 * alongside host instructions, criteria, tool schemas, evidence rules, and
 * completion rules — the host applies it with authority to steer
 * investigation. Its security boundary is a different axis: it cannot be
 * forged into changing tool authorization (`harnessAgentsPolicy.ts` reads
 * exact pinned content, never model-supplied text) and it is non-citable
 * (enforced later, task 7.4). "Untrusted" here means only the
 * author-controlled bootstrap sections built by `buildBootstrapSection`:
 * linked-issue and change-request metadata, title, body, commits,
 * discussion, labels, check summaries, and relationships.
 */
import type { InvestigationCursor, NormalizedDetail } from '../platform/types';
import type { Criteria } from './criteria';
import type { EffortLevel } from './effort';
import { HOST_TOOL_DEFINITIONS } from './harnessTools';

export type BootstrapSectionKind = 'changeRequestDetails' | 'issueDetails';

export type BootstrapSectionState = 'complete' | 'truncated';

/**
 * A reopenable bootstrap section (task 6.5): a stable reference (`sectionId`),
 * a digest, a truncation state, and a bounded detail-tool cursor, rather
 * than blind concatenation of however much content happened to come back.
 */
export interface BootstrapSection {
  readonly kind: BootstrapSectionKind;
  /** Stable within the attempt — what the (future, section 9) detail tool re-requests to reopen this exact section. */
  readonly sectionId: string;
  /** Digest of the full normalized detail's canonical form — always over the complete detail, never the summary. */
  readonly digest: string;
  readonly state: BootstrapSectionState;
  /** Present only when `state` is `'truncated'` and the underlying fetch itself returned a continuation. */
  readonly cursor?: InvestigationCursor;
  /** The full detail when it fits inline; a truthful bounded summary otherwise. Never a patch or full CI logs — `NormalizedDetail` has no field for either. */
  readonly content: NormalizedDetail | string;
}

/** A truthful, bounded stand-in for a section too large to inline — counts and named omissions, never invented prose. */
export function summarizeNormalizedDetail(detail: NormalizedDetail): string {
  const parts = [
    `Title: ${detail.title}`,
    `${detail.commits.length} commit(s), ${detail.discussion.length} discussion note(s), `
      + `${detail.labels.length} label(s), ${detail.checkSummaries.length} check summary(ies), `
      + `${detail.relationships.length} relationship(s).`,
  ];
  if (detail.unavailableSections.length > 0) {
    parts.push(`Unavailable from the provider: ${detail.unavailableSections.join(', ')}.`);
  }
  return parts.join(' ');
}

export interface BuildBootstrapSectionInput {
  kind: BootstrapSectionKind;
  sectionId: string;
  detail: NormalizedDetail;
  /** Digest of `detail`'s canonical form, computed by the caller. */
  digest: string;
  /** Whether the provider's own fetch was already incomplete, before bootstrap-side budgeting even applies. */
  providerState: 'complete' | 'paginated' | 'truncated';
  /** The provider's own continuation, when `providerState` is not `'complete'`. */
  providerCursor?: InvestigationCursor;
  /** Inline length budget in characters — a rough proxy; task 6.6's real gate counts tokens against the selected model. */
  maxInlineChars: number;
}

/** Inlines the full detail when it is provider-complete and fits the budget; otherwise a bounded summary plus a reopen cursor. */
export function buildBootstrapSection(input: BuildBootstrapSectionInput): BootstrapSection {
  const fitsInline = input.providerState === 'complete' && JSON.stringify(input.detail).length <= input.maxInlineChars;
  if (fitsInline) {
    return { kind: input.kind, sectionId: input.sectionId, digest: input.digest, state: 'complete', content: input.detail };
  }
  return {
    kind: input.kind,
    sectionId: input.sectionId,
    digest: input.digest,
    state: 'truncated',
    cursor: input.providerCursor,
    content: summarizeNormalizedDetail(input.detail),
  };
}

/**
 * One explicit reviewer-selected attachment, rendered exactly as it is
 * returned to the model (task 15.2, D8: "explicit citable attachments...
 * bound to their snapshot digest"). `content` is the *post-budget* text —
 * whatever `renderAttachmentsForModel` (`src/app/reviewContext.ts`) actually
 * produced, truncation marker included when `truncated` is true — because
 * this section exists to be an honest record of what the model was shown,
 * the same role `changeRequestDetails.content` already plays for provider
 * text. The app layer (`harnessAttempt.ts`) is the only place that both
 * builds this section and registers the matching evidence-ledger source, so
 * the two can never drift; this type alone does not guarantee that.
 */
export interface BootstrapAttachmentSection {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
}

export interface BootstrapMemberSections {
  readonly memberId: string;
  readonly changeRequestDetails: BootstrapSection;
  readonly issueDetails: readonly BootstrapSection[];
  /** Absent for a member with no explicit attachments; never absent-vs-empty-meaningfully otherwise. */
  readonly attachments?: readonly BootstrapAttachmentSection[];
}

export interface BootstrapMemberIdentity {
  readonly memberId: string;
  readonly repoId: string;
  readonly baseSha: string;
  readonly headSha: string;
}

/** One host-owned tool the model may call (design.md D6). `description` is non-normative — task 6.6 shortens it first when the envelope must shrink further. */
export interface BootstrapToolSchema {
  readonly name: string;
  readonly requiredScope: string;
  readonly description: string;
}

/**
 * Derived from the section-9 host tool catalog (`harnessTools.ts`'s
 * `HOST_TOOL_DEFINITIONS`), which is now the single source of truth for the
 * ten D6 tools; this projects down to the three fields bootstrap accounting
 * needs (`name`, `requiredScope`, `description`), in the same D6 table order.
 */
export const HOST_TOOL_CATALOG: readonly BootstrapToolSchema[] = HOST_TOOL_DEFINITIONS.map((definition) => ({
  name: definition.name,
  requiredScope: definition.requiredScope,
  description: definition.description,
}));

/** Root `AGENTS.md` presence, digest, and composed text — see the file header for why this is authoritative, not untrusted. */
export interface BootstrapPolicySource {
  readonly present: boolean;
  readonly sourceId?: string;
  readonly digest?: string;
  readonly text?: string;
}

/**
 * One member's own base-revision root `AGENTS.md` identity (task 15.1's
 * member-ownership fix). Every member walks its *own* repository root, so a
 * changeset envelope names one `BootstrapPolicySource` per member rather
 * than one for the whole run — collapsing to a single value silently
 * dropped every member but the first, which is exactly the bug this shape
 * exists to make impossible to reintroduce.
 */
export interface BootstrapMemberRootPolicy {
  readonly memberId: string;
  readonly source: BootstrapPolicySource;
}

export interface BootstrapAuthoritative {
  readonly members: readonly BootstrapMemberIdentity[];
  readonly personaLabel: string;
  readonly agentInstructions: string;
  readonly criteria: Criteria;
  readonly effort: EffortLevel;
  readonly effortInstruction: string;
  /** States which auto-context sources and attachments are present, so the model knows what is (and is not) citable — never the content itself. */
  readonly contextDeclaration: string;
  readonly rootPolicies: readonly BootstrapMemberRootPolicy[];
  readonly toolCatalog: readonly BootstrapToolSchema[];
  readonly toolContractVersion: string;
  readonly harnessPolicyVersion: string;
}

/**
 * Task 6.4: every author-controlled section lives in `untrusted`, structurally
 * apart from `authoritative`. There is no field anywhere in `authoritative`
 * that copies or interpolates untrusted content.
 */
export interface BootstrapEnvelope {
  readonly authoritative: BootstrapAuthoritative;
  readonly untrusted: readonly BootstrapMemberSections[];
}

export interface BuildBootstrapEnvelopeInput {
  members: readonly BootstrapMemberIdentity[];
  personaLabel: string;
  agentInstructions: string;
  criteria: Criteria;
  effort: EffortLevel;
  effortInstruction: string;
  contextDeclaration: string;
  rootPolicies: readonly BootstrapMemberRootPolicy[];
  toolContractVersion: string;
  harnessPolicyVersion: string;
  memberSections: readonly BootstrapMemberSections[];
}

export function buildBootstrapEnvelope(input: BuildBootstrapEnvelopeInput): BootstrapEnvelope {
  return {
    authoritative: {
      members: input.members,
      personaLabel: input.personaLabel,
      agentInstructions: input.agentInstructions,
      criteria: input.criteria,
      effort: input.effort,
      effortInstruction: input.effortInstruction,
      contextDeclaration: input.contextDeclaration,
      rootPolicies: input.rootPolicies,
      toolCatalog: HOST_TOOL_CATALOG,
      toolContractVersion: input.toolContractVersion,
      harnessPolicyVersion: input.harnessPolicyVersion,
    },
    untrusted: input.memberSections,
  };
}

function forceSummary(section: BootstrapSection): BootstrapSection {
  if (typeof section.content === 'string') return section; // already a summary — nothing left to shrink this way
  return { ...section, state: 'truncated', content: summarizeNormalizedDetail(section.content) };
}

/** Task 6.6's first shrink tactic: replace every reopenable section with its bounded summary. Pure — the caller's token-count loop decides when to call this. */
export function withSectionsSummarized(envelope: BootstrapEnvelope): BootstrapEnvelope {
  return {
    ...envelope,
    untrusted: envelope.untrusted.map((memberSections) => ({
      ...memberSections,
      changeRequestDetails: forceSummary(memberSections.changeRequestDetails),
      issueDetails: memberSections.issueDetails.map(forceSummary),
    })),
  };
}

/** Task 6.6's second shrink tactic: drop the tool catalog's non-normative prose, keeping the normative name and required scope. */
export function withMinimalToolDescriptions(envelope: BootstrapEnvelope): BootstrapEnvelope {
  return {
    ...envelope,
    authoritative: {
      ...envelope.authoritative,
      toolCatalog: envelope.authoritative.toolCatalog.map((tool) => ({ ...tool, description: '' })),
    },
  };
}

/** A rough size proxy only, for ordering shrink tactics — task 6.6's real fit decision counts tokens against the selected model. */
export function estimateEnvelopeLength(envelope: BootstrapEnvelope): number {
  return JSON.stringify(envelope).length;
}
