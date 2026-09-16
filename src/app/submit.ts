/**
 * Submit composition and orchestration (spec §7): accepted items become
 * positioned comments (suggestion attached when applyFix), rejected and
 * skipped items never leave the machine. Partial failure retries only the
 * remainder — never re-posts what already landed.
 *
 * Anchoring policy (mandate A): a finding's recorded line is the PRIMARY
 * anchor. Text matching (`resolveAnchor`) runs first and wins whenever it
 * finds the code anywhere in the diff — verifying it in place, or re-locating
 * it after drift — because a finding that genuinely moved must follow the
 * move, not post against a stale line. Only when text matching finds the
 * code nowhere at all does the recorded line fall back to being trusted on
 * its own, restricted to a line the diff's new side actually carries: `code`
 * is documented as "the offending hunk", not guaranteed to be one line, and a
 * multi-line or paraphrased quote can never trim-equal any single candidate
 * — that failure says nothing about whether the location is right. The
 * fallback still requires `code` to be non-empty: it exists to excuse a text
 * match that could not be made, not to excuse having no text to match at
 * all, so a finding with an empty or missing `code` field is withheld
 * exactly as it always was, whatever its recorded line says. A finding is
 * withheld only when neither its code nor its own recorded line can be
 * placed in the current diff at all.
 */
import type { Connection } from '../platform/provider';
import type { AnchorRefs, ChangeRequestRef, ReviewCommentDraft, SubmitProgressFn, SubmitResult } from '../platform/types';
import { resolveAnchor, type AnchorCandidate } from '../domain/anchor';
import { escapeMarkdownText, markdownCodeSpan } from '../domain/markdownSafety';
import type { Review, ReviewItem } from '../domain/types';
import { isReviewItemAnchored } from '../domain/types';
import { providerRelativePath } from './modelVisiblePath';

export interface CommentDraftComposition {
  drafts: ReviewCommentDraft[];
  withheld: ReviewItem[];
}

export function composeCommentDrafts(
  review: Review,
  agentLabel: string,
  you: string,
  anchorRefs: AnchorRefs,
  candidatesFor: (file: string) => readonly AnchorCandidate[] | undefined,
  workspaceRootLabel?: string,
): CommentDraftComposition {
  const drafts: ReviewCommentDraft[] = [];
  const withheld: ReviewItem[] = [];
  for (const item of review.items) {
    if (review.verdicts[item.id]?.verdict !== 'accepted' || !isReviewItemAnchored(item)) continue;
    const candidates = candidatesFor(item.file);
    if (!candidates) {
      withheld.push(item);
      continue;
    }
    const textMatch = resolveAnchor(candidates, item);
    // Mandate A: the finding's recorded line is the PRIMARY anchor; text
    // matching only verifies it or re-locates it on drift. Text matching
    // still runs first and wins whenever it finds anything — a finding whose
    // code drifted to a different line after new commits must follow that
    // drift, not blindly trust a now-wrong line number. Only when text
    // matching finds the code NOWHERE in the diff does the recorded line
    // fall back to being trusted on its own: `item.code` is documented as
    // "the offending hunk", not guaranteed single-line, and a multi-line or
    // paraphrased quote can never trim-equal any one candidate line however
    // exactly the finding's location is right — the real 2026-09-12 incident
    // (5 findings on `panel.rs`, all independently confirmed to sit on lines
    // the diff already carries as additions) fits exactly this shape: the
    // recorded line was always addressable, so text-match strictness, not a
    // narrow candidate set, was withholding them. The fallback is restricted
    // to the new side — an old-side match with no text to justify it would
    // be coordinate-space guessing, so a deletion still requires a real
    // text match. And it only ever excuses a failed *comparison*: an empty
    // or missing `code` never had any text to compare, so `resolveAnchor`
    // already reports it `lost` unconditionally — this fallback must not
    // then trust the bare line number anyway, or a finding with zero
    // supporting evidence posts verbatim on say-so alone.
    const recordedCandidate = candidates.find(
      (c) => c.line === item.line && (c.side ?? 'new') === 'new',
    );
    const verified = textMatch.state !== 'lost';
    if (!verified && (item.code.trim() === '' || !recordedCandidate)) {
      withheld.push(item);
      continue;
    }
    const anchorLine = verified ? textMatch.line : item.line;
    // A resolved side of `undefined` means the candidates carried no side
    // markers at all (e.g. `documentCandidates`, or a test double) — treat
    // that the same as 'new', the only side such a haystack could mean.
    const side = verified ? textMatch.side ?? 'new' : 'new';
    // The candidate's paired old-side line number, present only for a
    // context line (GitLab's position API rejects an unchanged line's
    // position unless it carries both coordinates — see
    // `gitlab/mappers.ts#buildPosition`). An addition or a deletion has no
    // pairing to offer, so this stays undefined for both.
    const oldLine = verified ? textMatch.oldLine : recordedCandidate?.oldLine;
    const endLine = item.endLine === undefined
      ? undefined
      : anchorLine + (item.endLine - item.line);
    if (endLine !== undefined) {
      // Every line of a multi-line range must be addressable on the SAME
      // side the start line resolved to — GitHub takes one `side` for the
      // whole range. Not "added": a range sitting on unchanged context, or
      // wholly inside a deletion, is exactly as postable as one on fresh
      // additions.
      const sameSideLines = new Set(
        candidates.filter((c) => (c.side ?? 'new') === side).map((c) => c.line),
      );
      const rangeLength = endLine - anchorLine + 1;
      let rangeIsAddressable = rangeLength > 0 && rangeLength <= sameSideLines.size;
      if (rangeIsAddressable) {
        for (let line = anchorLine; line <= endLine; line += 1) {
          if (!sameSideLines.has(line)) {
            rangeIsAddressable = false;
            break;
          }
        }
      }
      if (!rangeIsAddressable) {
        withheld.push(item);
        continue;
      }
    }
    const applyFix = review.verdicts[item.id]?.applyFix ?? false;
    const headline = [`**${escapeMarkdownText(item.title)}**`, ...findingMetaParts(item)].join(' · ');
    drafts.push({
      key: item.id,
      body: `${headline}\n\n${item.body}`,
      anchor: {
        filePath: providerRelativePath(item.file, workspaceRootLabel),
        line: anchorLine,
        endLine,
        side,
        oldLine,
        refs: anchorRefs,
      },
      // A suggestion replaces a line's content — meaningless on the old side
      // (nothing left there to replace), and withheld on an unverified
      // anchor too: the content a fix is meant to change was never confirmed
      // to still be what the finding thinks it is.
      suggestion: applyFix && item.suggestion && side === 'new' && verified ? item.suggestion : undefined,
      footer: `<sub>Flagged by ${agentLabel} (${item.confidence}% confidence), accepted by @${you} via Code Verdict.</sub>`,
    });
  }
  return { drafts, withheld };
}

export interface SubmitPlan {
  drafts: ReviewCommentDraft[];
  summary: string;
  requestChanges: boolean;
  asSingleThread: boolean;
}

/**
 * The severity/category/(confidence)/reference vocabulary shared with the
 * inline comment headline (`composeCommentDrafts`) — a summary-carried
 * finding must read in the same terms as one posted inline, not a second,
 * invented style. Confidence is opt-in: the inline headline leaves it to the
 * footer's attribution line, which a summary-carried finding has none of.
 */
function findingMetaParts(item: ReviewItem, options: { confidence?: boolean } = {}): string[] {
  // `severity`/`category` are enum-validated and `confidence` is a number —
  // none can carry structure-breaking text. `reference` is model-authored
  // free text (`parseAgentReviewResponse` only coerces it to a string), so
  // it gets the same neutralizing as a title before landing in this line.
  return [
    item.severity,
    item.category,
    options.confidence ? `${item.confidence}% confidence` : undefined,
    item.reference ? escapeMarkdownText(item.reference) : undefined,
  ].filter((part): part is string => Boolean(part));
}

/**
 * A group of findings shares one change request identity when every item
 * carries the same `repoId`/`crNumber` pair (including "neither carries
 * one" — a plain, non-changeset review). `''` is that shared, unlabeled
 * group; only a review whose items genuinely span more than one change
 * request (the changeset-wide preview in `changesetReview.ts`, never a
 * per-member submission — `buildChangesetSubmitPlans` already filters each
 * member's items down to its own pair) produces more than one key.
 */
function findingGroupKey(item: ReviewItem): string {
  return item.repoId && item.crNumber ? `${item.repoId}!${item.crNumber}` : '';
}

// vocab-ok: "change request" is the neutral contract's own word, not a platform noun
//
// `repoId`/`crNumber` reach here as `projectId`/`mrIid` off the model's own
// response (task 15.8 removed the changeset response validator that used to
// restrict them to real member refs) — model-authored text, same as a
// title, so it gets the same neutralizing before landing in this bold run.
function findingGroupLabel(item: ReviewItem): string {
  return `${escapeMarkdownText(item.repoId ?? '')} · change request ${escapeMarkdownText(item.crNumber ?? '')}`;
}

/**
 * One finding, rendered to read like something a human wrote: the title as
 * a heading, its severity/category/confidence in the inline vocabulary, its
 * location as prose (full path, never a `file=`/`line=` pair), an optional
 * withholding reason as a short labeled line, then the body.
 */
function renderFindingBlock(item: ReviewItem, withheldReason?: string): string {
  const parts = [
    `### ${escapeMarkdownText(item.title)}`,
    findingMetaParts(item, { confidence: true }).join(' · '),
    `${markdownCodeSpan(item.file)}, line ${item.line}`,
  ];
  if (withheldReason) parts.push(`**Withheld:** ${escapeMarkdownText(withheldReason)}`);
  parts.push(item.body);
  return parts.join('\n\n');
}

/**
 * A section of summary-carried findings. The change-request identity that
 * `findingGroupKey` computes is named at most once per group — the summary
 * already sits on that change request, so a single-group section (the
 * ordinary case, and every per-member changeset submission) never repeats
 * it at all; only a section spanning more than one change request (the
 * changeset-wide preview) names each member once, above its findings.
 *
 * Whether labels print is decided by `multipleMembers`, the whole summary's
 * span across every section it renders — never by this section's own slice
 * of items. A changeset spanning two repos must label every section's
 * groups even when one section's items all happen to come from a single
 * repo, or a reader loses the only cue for which repo a finding's path
 * belongs to; a genuinely single-member summary must never label at all.
 */
function renderFindingSection(
  items: readonly ReviewItem[],
  multipleMembers: boolean,
  withheldReason?: string,
): string {
  if (items.length === 0) return '';
  const groups = new Map<string, ReviewItem[]>();
  for (const item of items) {
    const key = findingGroupKey(item);
    const group = groups.get(key);
    if (group) group.push(item); else groups.set(key, [item]);
  }
  const blocks: string[] = [];
  for (const groupItems of groups.values()) {
    if (multipleMembers && findingGroupKey(groupItems[0]!) !== '') {
      blocks.push(`**${findingGroupLabel(groupItems[0]!)}**`);
    }
    for (const item of groupItems) blocks.push(renderFindingBlock(item, withheldReason));
  }
  return blocks.join('\n\n');
}

/** The 7-character prefix convention this module's own `reviewedRevisionLine` (and `harnessCompletion.ts`'s matching helper) both read as "the short sha". */
function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/**
 * One line naming the revision the findings actually describe, present only when the branch has
 * moved since — so a PR reader arriving after further commits landed knows which revision every
 * finding below was computed against, rather than assuming the summary describes the tip they see
 * now. `liveHeadSha` is the caller's best knowledge of the current head at submit time (never
 * re-fetched here); omitted entirely when it is unknown or matches `review.headSha` exactly —
 * agreement is the ordinary case and earns no line.
 */
function reviewedRevisionLine(review: Review | undefined, liveHeadSha: string | undefined): string {
  if (!review || liveHeadSha === undefined || liveHeadSha === review.headSha) return '';
  return `Reviewed at ${markdownCodeSpan(shortSha(review.headSha))}; the branch has since moved to ${markdownCodeSpan(shortSha(liveHeadSha))}.`;
}

export function composeSummaryBody(
  summaryText: string,
  finalNote: string,
  review?: Review,
  withheldInline: readonly ReviewItem[] = [],
  liveHeadSha?: string,
): string {
  const base = finalNote.trim() === '' ? summaryText : `${summaryText}\n\n---\n\n${finalNote.trim()}`;
  const unanchored = review?.items.filter(
    (item) => review.verdicts[item.id]?.verdict === 'accepted' && !isReviewItemAnchored(item),
  ) ?? [];
  // The label decision spans BOTH sections together — a summary is
  // multi-member when the union of everything it renders carries more than
  // one change-request identity, never when either section happens to be
  // single-member on its own (see `renderFindingSection`).
  const multipleMembers = new Set([...unanchored, ...withheldInline].map(findingGroupKey)).size > 1;
  const outsideDiff = renderFindingSection(unanchored, multipleMembers);
  const withoutCurrentAnchor = renderFindingSection(
    withheldInline,
    multipleMembers,
    'neither its code nor its reported line matches anything currently in the diff.',
  );
  return [
    reviewedRevisionLine(review, liveHeadSha),
    base,
    outsideDiff === '' ? '' : `## Accepted findings outside the diff\n\n${outsideDiff}`,
    withoutCurrentAnchor === ''
      ? ''
      : `## Accepted findings without a current inline anchor\n\n${withoutCurrentAnchor}`,
  ]
    .filter((part) => part.trim() !== '')
    .join('\n\n');
}

/**
 * Submit, or retry only the remainder of a partial failure. `retryKeys`
 * restricts the batch to previously-failed comments; the summary is only
 * (re)sent when it has not been posted yet.
 */
export async function performSubmit(
  connection: Connection,
  ref: ChangeRequestRef,
  plan: SubmitPlan,
  state: {
    retryKeys?: ReadonlySet<string>;
    summaryAlreadyPosted?: boolean;
    /**
     * The request-changes verdict already landed on a previous attempt. It must
     * not be sent again: a platform that creates a new review per call (GitHub)
     * would stack duplicate verdicts and re-notify the author on every retry.
     * `performChangesetSubmit` tracks the same thing as `requestChangesRefs`.
     */
    verdictAlreadyApplied?: boolean;
  } = {},
  onProgress?: SubmitProgressFn,
): Promise<SubmitResult> {
  const drafts = state.retryKeys
    ? plan.drafts.filter((d) => state.retryKeys?.has(d.key))
    : plan.drafts;
  return connection.submitReview(ref, {
    comments: drafts,
    summary: state.summaryAlreadyPosted ? undefined : plan.summary,
    requestChanges: state.verdictAlreadyApplied ? false : plan.requestChanges,
    asSingleThread: plan.asSingleThread,
  }, onProgress);
}
