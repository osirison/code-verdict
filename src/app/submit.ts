/**
 * Submit composition and orchestration (spec §7): accepted items become
 * positioned comments (suggestion attached when applyFix), rejected and
 * skipped items never leave the machine. Partial failure retries only the
 * remainder — never re-posts what already landed.
 */
import type { Connection } from '../platform/provider';
import type { AnchorRefs, ChangeRequestRef, ReviewCommentDraft, SubmitProgressFn, SubmitResult } from '../platform/types';
import type { Review } from '../domain/types';

export function composeCommentDrafts(
  review: Review,
  agentLabel: string,
  you: string,
  anchorRefs: AnchorRefs,
): ReviewCommentDraft[] {
  return review.items
    .filter((item) => review.verdicts[item.id]?.verdict === 'accepted')
    .map((item) => {
      const applyFix = review.verdicts[item.id]?.applyFix ?? false;
      const headline = [`**${item.title}**`, item.severity, item.category, item.reference]
        .filter(Boolean)
        .join(' · ');
      return {
        key: item.id,
        body: `${headline}\n\n${item.body}`,
        anchor: {
          filePath: item.file,
          line: item.line,
          endLine: item.endLine,
          refs: anchorRefs,
        },
        suggestion: applyFix && item.suggestion ? item.suggestion : undefined,
        footer: `<sub>Flagged by ${agentLabel} (${item.confidence}% confidence), accepted by @${you} via Code Verdict.</sub>`,
      };
    });
}

export interface SubmitPlan {
  drafts: ReviewCommentDraft[];
  summary: string;
  requestChanges: boolean;
  asSingleThread: boolean;
}

export function composeSummaryBody(summaryText: string, finalNote: string): string {
  return finalNote.trim() === '' ? summaryText : `${summaryText}\n\n---\n\n${finalNote.trim()}`;
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
