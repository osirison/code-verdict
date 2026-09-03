/**
 * Submit composition and orchestration (spec §7): accepted items become
 * positioned comments (suggestion attached when applyFix), rejected and
 * skipped items never leave the machine. Partial failure retries only the
 * remainder — never re-posts what already landed.
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
    const resolved = candidates ? resolveAnchor(candidates, item) : undefined;
    if (!candidates || !resolved || resolved.state === 'lost') {
      withheld.push(item);
      continue;
    }
    const endLine = item.endLine === undefined
      ? undefined
      : resolved.line + (item.endLine - item.line);
    if (endLine !== undefined) {
      const addedLineNumbers = new Set(candidates.map((candidate) => candidate.line));
      const rangeLength = endLine - resolved.line + 1;
      let rangeIsAdded = rangeLength > 0 && rangeLength <= addedLineNumbers.size;
      if (rangeIsAdded) {
        for (let line = resolved.line; line <= endLine; line += 1) {
          if (!addedLineNumbers.has(line)) {
            rangeIsAdded = false;
            break;
          }
        }
      }
      if (!rangeIsAdded) {
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
        line: resolved.line,
        endLine,
        refs: anchorRefs,
      },
      suggestion: applyFix && item.suggestion ? item.suggestion : undefined,
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
      '> Withheld from inline submission because its code does not match a current added line.',
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
