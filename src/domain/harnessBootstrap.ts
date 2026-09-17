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
import type { InvestigationCursor, NormalizedCommit, NormalizedDetail } from '../platform/types';
import type { Criteria } from './criteria';
import type { EffortLevel } from './effort';
import { HOST_TOOL_DEFINITIONS } from './harnessTools';
import type { PolicyFileKind } from './reviewRunSnapshot';

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

/**
 * Collapses an embedded line break in a single-line untrusted value into a space before it is
 * interpolated into this module's own `## `-headed section text. `detail.title` reaches
 * `summarizeNormalizedDetail` with no schema layer upstream to reject a raw newline (provider
 * mappers pass it straight through — `github/mappers.ts`, `gitlab/mappers.ts` — and this module's
 * own header names title among the "author-controlled" content the isolation is meant to hold),
 * and the sibling inline-detail path (`buildBootstrapSection`'s `fitsInline` branch) is safe only
 * by accident: it `JSON.stringify`s the whole `NormalizedDetail`, which escapes a newline as the
 * two literal characters `\n` rather than emitting one. This summary path has no such stringify
 * step, so a title carrying a real newline reproduces verbatim — forging a fake `## `/`### ` line
 * inside `BootstrapSection.content`, structurally indistinguishable from the module's own section
 * headers once it renders. A value must not be able to open its own section: collapsing the break
 * to a space keeps the title's content unchanged and readable while making that structurally
 * impossible, the same newline-collapse step `escapeMarkdownText` uses
 * (`./markdownSafety.ts`) — kept local here rather than imported, matching `evidenceFence`'s own
 * precedent (`../app/harnessSynthesisVerification.ts`) of a small mirrored helper over a shared one.
 */
function neutralizeLineBreaks(text: string): string {
  return text.replace(/\r\n|\r|\n|\u2028|\u2029|\u0085/g, ' ');
}

/** A truthful, bounded stand-in for a section too large to inline — counts and named omissions, never invented prose. */
export function summarizeNormalizedDetail(detail: NormalizedDetail): string {
  const parts = [
    `Title: ${neutralizeLineBreaks(detail.title)}`,
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
 *
 * `sourceId`/`digest` are the evidence ledger's own minted identifiers for
 * this attachment (task 15.7 closure of a gap task 15.1-15.3 named
 * explicitly: an attachment registered as citable evidence but never told to
 * the model can never actually be cited). Absent until `harnessAttempt.ts`'s
 * `runBootstrap` registers the attachment with the ledger — which always
 * succeeds before this section is ever handed to a real model seam, since a
 * registration failure is reported as a limitation and the attachment's `id`
 * alone remains, uncitable, exactly like a `pending`-registration gap always
 * was.
 */
export interface BootstrapAttachmentSection {
  readonly id: string;
  readonly label: string;
  readonly path: string;
  readonly content: string;
  readonly truncated: boolean;
  readonly sourceId?: string;
  readonly digest?: string;
}

export interface BootstrapMemberSections {
  readonly memberId: string;
  readonly changeRequestDetails: BootstrapSection;
  readonly issueDetails: readonly BootstrapSection[];
  /** Absent for a member with no explicit attachments; never absent-vs-empty-meaningfully otherwise. */
  readonly attachments?: readonly BootstrapAttachmentSection[];
}

/**
 * What the bootstrap pinned for one member — the host's own record, not a set of values the model
 * is asked to repeat back. `baseSha`/`headSha` are deliberately not rendered into the prompt any
 * more (`../app/harnessModelSeam.ts`): no request carries a revision, because the dispatcher
 * supplies each member's pin itself. They stay here because this is where D3's "the host snapshots
 * base and head revisions" is attributed for a bootstrap envelope, and the envelope is what the
 * bootstrap budget and the run record are built from.
 */
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

/**
 * Root `AGENTS.md`/`CLAUDE.md` presence, digest, and composed text — see the file header for why
 * this is authoritative, not untrusted.
 *
 * `text` is what actually reaches the model as the "Repository policy" content: `harnessAttempt.ts`'s
 * `rootPoliciesFor` copies it straight off the snapshot's already-resolved `rootAgentsPolicy`, and
 * `harnessModelSeam.ts`'s `renderAuthoritative` prints it under that heading whenever it is defined.
 * `files`/`identical` say which of the two files it came from, for the same render to name correctly
 * ("AGENTS.md present" vs "CLAUDE.md present" vs "AGENTS.md and CLAUDE.md present (identical/differ)").
 *
 * `textOmittedReason` and `unavailableReason` are the two honesty escape hatches `fitBootstrapToModel`
 * (`../app/harnessBootstrapBudget.ts`) and the resolver (`../app/harnessAgentsPolicy.ts`) use,
 * respectively, when there is something to say about content that is not itself shown: the former
 * when `text` existed but had to be dropped to fit the model's input limit, the latter when
 * `present` is `false` because the host could not determine presence at all — as opposed to a
 * confirmed absence, which carries neither field.
 *
 * `companionUnavailable` is the third: `present` is `true`, one of the two files was read, and the
 * other could not be. Without it the render names the file that contributed and says nothing about
 * the one that did not, which reads identically to a companion the host confirmed does not exist —
 * so a model told "root AGENTS.md present" would have no way to know a `CLAUDE.md` full of rules
 * went unread. Its `reason` can be a source's own `error.message`, so the render neutralizes it the
 * way it neutralizes every other unframed untrusted value.
 */
export interface BootstrapPolicySource {
  readonly present: boolean;
  readonly sourceId?: string;
  readonly digest?: string;
  readonly text?: string;
  readonly files?: readonly PolicyFileKind[];
  readonly identical?: boolean;
  readonly textOmittedReason?: string;
  readonly unavailableReason?: string;
  readonly companionUnavailable?: { readonly file: PolicyFileKind; readonly reason: string };
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
  /**
   * Defaults to the full `HOST_TOOL_CATALOG`. `harnessAttempt.ts`'s bootstrap passes a narrower
   * list when a member's effective capabilities (`harnessRuntime.ts`'s `effectiveCapabilities`)
   * withhold a tool — keeping the model-facing catalog honest about what the dispatcher will
   * actually accept, never advertising a tool only to refuse it later.
   */
  toolCatalog?: readonly BootstrapToolSchema[];
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
      toolCatalog: input.toolCatalog ?? HOST_TOOL_CATALOG,
      toolContractVersion: input.toolContractVersion,
      harnessPolicyVersion: input.harnessPolicyVersion,
    },
    untrusted: input.memberSections,
  };
}

/**
 * Caps for the newest shrink tactic (below): how many of a change request's commits survive
 * inline, how long any one surviving commit message may be, and how much of the PR/MR body is
 * kept. Fixed numbers, not a fraction of whatever budget happens to be asking: the caller (the
 * fit loop in `../app/harnessBootstrapBudget.ts`, and the per-turn byte retry in
 * `../app/harnessAttempt.ts`) already has three further, more aggressive tactics behind this one
 * if a fixed cap is not enough, so this tactic does not need to know the caller's actual budget to
 * be useful — it only needs to turn "40 commits and a long description" into "a bounded amount of
 * real content" before falling back to the bare-counts summary that erases it entirely.
 */
export interface UntrustedContentCaps {
  /** Commits kept inline; older ones collapse into one elision entry. */
  readonly maxCommits: number;
  /** Characters kept per surviving commit message. */
  readonly maxCommitMessageChars: number;
  /** Characters kept from the head of the PR/MR body. */
  readonly maxBodyChars: number;
}

export const DEFAULT_UNTRUSTED_CONTENT_CAPS: UntrustedContentCaps = {
  maxCommits: 20,
  maxCommitMessageChars: 500,
  maxBodyChars: 4_000,
};

const FRAMING_CAP_REASON = 'framing exceeded the per-turn prompt cap';

/** The `sha` this tactic mints for its own elision entry — recognized on a re-application (see `capCommitList`) so capping twice is a fixed point rather than eliding the previous elision. */
const ELIDED_COMMIT_SHA = '(elided)';

/**
 * Keeps the newest `caps.maxCommits` commits (each message capped at `caps.maxCommitMessageChars`)
 * and replaces everything older with one truthful elision entry — never a silent drop, and never a
 * change to `sha`/`author`/`message` for a commit that survives uncapped.
 *
 * "Newest" assumes `commits` arrives oldest-first, the order GitHub's PR-commits API returns
 * (`../providers/github/mappers.ts` passes it through unchanged). A provider that hands over
 * newest-first instead would have this keep the oldest commits rather than the newest — the
 * safety property (bounded count, bounded message length, an honest count of what is missing)
 * holds either way; only which specific commits survive would differ.
 *
 * Idempotent: a list already starting with this tactic's own elision entry is recognized as such,
 * so re-running it (never done by `withUntrustedContentCapped` itself, which runs once per fit
 * attempt, but kept true because nothing here should assume its own caller) caps only the commits
 * after that entry rather than eliding the elision.
 */
function capCommitList(commits: readonly NormalizedCommit[], caps: UntrustedContentCaps): readonly NormalizedCommit[] {
  const alreadyElided = commits.length > 0 && commits[0]!.sha === ELIDED_COMMIT_SHA;
  const real = alreadyElided ? commits.slice(1) : commits;
  let changed = false;
  const shortened = real.map((commit) => {
    if (commit.message.length <= caps.maxCommitMessageChars) return commit;
    changed = true;
    return { ...commit, message: `${commit.message.slice(0, caps.maxCommitMessageChars)}… (message truncated: ${FRAMING_CAP_REASON})` };
  });
  const overflow = shortened.length - caps.maxCommits;
  if (overflow <= 0) {
    if (!changed) return commits; // fixed point, with or without a marker already present
    return alreadyElided ? [commits[0]!, ...shortened] : shortened;
  }
  const elided: NormalizedCommit = {
    sha: ELIDED_COMMIT_SHA,
    author: '(host)',
    message: `… ${overflow} older commit message(s) omitted: ${FRAMING_CAP_REASON}.`,
  };
  return [elided, ...shortened.slice(overflow)];
}

/** Keeps the head of `body` within `caps.maxBodyChars`, with a truthful count of what was cut. */
function capBodyText(body: string | undefined, caps: UntrustedContentCaps): string | undefined {
  if (body === undefined || body.length <= caps.maxBodyChars) return body;
  const omitted = body.length - caps.maxBodyChars;
  return `${body.slice(0, caps.maxBodyChars)}\n… ${omitted} more character(s) of the description omitted: ${FRAMING_CAP_REASON}.`;
}

/** `undefined` when neither the commit list nor the body needed capping — the caller's no-op check. */
function capNormalizedDetail(detail: NormalizedDetail, caps: UntrustedContentCaps): NormalizedDetail | undefined {
  const commits = capCommitList(detail.commits, caps);
  const body = capBodyText(detail.body, caps);
  if (commits === detail.commits && body === detail.body) return undefined;
  return { ...detail, commits, body };
}

/**
 * Caps one section's commit list and body when it is still a full `NormalizedDetail` (`state:
 * 'complete'`) — a section `withSectionsSummarized` already collapsed to a bare-counts string has
 * nothing left for this tactic to cap, so it passes through unchanged, same as `forceSummary`'s own
 * is-string check. Capping is itself a truncation the model was not shown before, so it moves
 * `state` to `'truncated'` — honest about what changed, even though (unlike a provider-side
 * truncation) there is no cursor to reopen it with; the section stays reopenable in full through
 * the detail tool via its unchanged `digest`.
 */
function capSection(section: BootstrapSection, caps: UntrustedContentCaps): BootstrapSection {
  if (typeof section.content === 'string') return section;
  const capped = capNormalizedDetail(section.content, caps);
  if (capped === undefined) return section;
  return { ...section, state: 'truncated', content: capped };
}

/**
 * Task 6.6's first shrink tactic (inserted ahead of section summarization by the incident fix
 * below): cap each untrusted section's commit list and body rather than jumping straight to a
 * bare-counts summary. `withSectionsSummarized` already destroys commit messages and the body
 * entirely, so this has to run *before* it — capping a section that summarization already reduced
 * to a string would have nothing left to cap. Tried first because it is the gentlest of the four
 * tactics: real commit and description content survives, just bounded, so a model that only needed
 * a little more headroom keeps the detail the later tactics would erase outright.
 */
export function withUntrustedContentCapped(envelope: BootstrapEnvelope, caps: UntrustedContentCaps = DEFAULT_UNTRUSTED_CONTENT_CAPS): BootstrapEnvelope {
  return {
    ...envelope,
    untrusted: envelope.untrusted.map((memberSections) => ({
      ...memberSections,
      changeRequestDetails: capSection(memberSections.changeRequestDetails, caps),
      issueDetails: memberSections.issueDetails.map((section) => capSection(section, caps)),
    })),
  };
}

function forceSummary(section: BootstrapSection): BootstrapSection {
  if (typeof section.content === 'string') return section; // already a summary — nothing left to shrink this way
  return { ...section, state: 'truncated', content: summarizeNormalizedDetail(section.content) };
}

/** Task 6.6's second shrink tactic: replace every reopenable section with its bounded summary. Pure — the caller's token-count loop decides when to call this. */
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

/** Task 6.6's third shrink tactic: drop the tool catalog's non-normative prose, keeping the normative name and required scope. */
export function withMinimalToolDescriptions(envelope: BootstrapEnvelope): BootstrapEnvelope {
  return {
    ...envelope,
    authoritative: {
      ...envelope.authoritative,
      toolCatalog: envelope.authoritative.toolCatalog.map((tool) => ({ ...tool, description: '' })),
    },
  };
}

/**
 * A fourth, last-resort shrink tactic added alongside the root-policy content fix: drop the
 * composed policy `text` for every member that carries one, keeping identity (`sourceId`/`digest`/
 * `files`/`identical`) and recording why the text is missing. Tried only after all three tactics
 * above, on the theory that a repository's own authoritative conventions are worth more bootstrap
 * space than untrusted-section detail or tool-description prose — but an envelope that still does
 * not fit must degrade this too rather than fail outright while ordinary bootstrap content
 * survives untouched. Never a silent truncation: a member whose text is dropped keeps its exact
 * identity line, and `harnessModelSeam.ts`'s `renderAuthoritative` states the omission inline
 * rather than mid-sentence-cutting the policy prose itself.
 */
export function withPolicyTextOmitted(envelope: BootstrapEnvelope, reason: string): BootstrapEnvelope {
  return {
    ...envelope,
    authoritative: {
      ...envelope.authoritative,
      rootPolicies: envelope.authoritative.rootPolicies.map((entry) => {
        if (entry.source.text === undefined) return entry;
        return {
          memberId: entry.memberId,
          source: {
            present: entry.source.present,
            sourceId: entry.source.sourceId,
            digest: entry.source.digest,
            files: entry.source.files,
            identical: entry.source.identical,
            textOmittedReason: reason,
          },
        };
      }),
    },
  };
}

/** A rough size proxy only, for ordering shrink tactics — task 6.6's real fit decision counts tokens against the selected model. */
export function estimateEnvelopeLength(envelope: BootstrapEnvelope): number {
  return JSON.stringify(envelope).length;
}
