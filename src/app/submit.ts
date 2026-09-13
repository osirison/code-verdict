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
    const headline = [`**${item.title}**`, item.severity, item.category, item.reference]
      .filter(Boolean)
      .join(' · ');
    drafts.push({
      key: item.id,
      body: `${headline}\n\n${item.body}`,
      anchor: {
        filePath: providerRelativePath(item.file, workspaceRootLabel),
        line: anchorLine,
        endLine,
        side: verified ? textMatch.side : 'new',
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

function summaryFindingLocation(item: Review['items'][number]): string {
  const location = `${item.file}:${item.line}`;
  return item.repoId && item.crNumber
    // vocab-ok: changeset member identity uses the same provider-neutral wire labels as the agent prompt
    ? `projectId=${item.repoId} mrIid=${item.crNumber} file=${location}`
    : location;
}

export function composeSummaryBody(
  summaryText: string,
  finalNote: string,
  review?: Review,
  withheldInline: readonly ReviewItem[] = [],
): string {
  const base = finalNote.trim() === '' ? summaryText : `${summaryText}\n\n---\n\n${finalNote.trim()}`;
  const unanchored = review?.items.filter(
    (item) => review.verdicts[item.id]?.verdict === 'accepted' && !isReviewItemAnchored(item),
  ) ?? [];
  const outsideDiff = unanchored
    .map((item) => `### ${summaryFindingLocation(item)} - ${item.title}\n\n${item.body}`)
    .join('\n\n');
  const withoutCurrentAnchor = withheldInline
    .map((item) => [
      `### ${summaryFindingLocation(item)} - ${item.title}`,
      '> Withheld from inline submission because neither its code nor its reported line matches anything currently in the diff.',
      item.body,
    ].join('\n\n'))
    .join('\n\n');
  return [
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
