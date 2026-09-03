import type { Connection } from '../platform/provider';
import type { AnchorRefs, ChangeRequestRef, ReviewSubmission } from '../platform/types';
import type { AnchorCandidate } from '../domain/anchor';
import type { Review, ReviewItem } from '../domain/types';
import { composeCommentDrafts, composeSummaryBody } from './submit';

export interface ChangesetSubmitMember {
  ref: ChangeRequestRef;
  anchorRefs: AnchorRefs;
  candidatesFor: (file: string) => readonly AnchorCandidate[] | undefined;
  projectLabel?: string;
  workspaceRootLabel?: string;
}

export interface ChangesetMemberPlan {
  ref: ChangeRequestRef;
  submission: ReviewSubmission;
  withheld: ReviewItem[];
}

export interface ChangesetSubmitState {
  postedCommentKeys: string[];
  summaryRefs: string[];
  requestChangesRefs: string[];
  threadIds: Record<string, string>;
  /**
   * Refs whose verdict the platform refuses outright. Recorded so a retry
   * stops asking: without this the submit never reports complete, and the
   * user is left retrying a request that can only ever be refused.
   */
  verdictRefusedRefs?: string[];
}

export interface ChangesetSubmitFailure {
  ref: ChangeRequestRef;
  operation: 'comment' | 'summary' | 'requestChanges' | 'request';
  key?: string;
  message: string;
}

const refKey = (ref: ChangeRequestRef): string => `${ref.repoId}!${ref.number}`;

export function buildChangesetSubmitPlans(
  review: Review,
  members: readonly ChangesetSubmitMember[],
  agentLabel: string,
  you: string,
  summary: string,
  requestChanges: boolean,
  asSingleThread: boolean,
): ChangesetMemberPlan[] {
  const labels = new Map(members.map((member) => [member.ref.repoId, member.projectLabel ?? member.ref.repoId]));
  return members.map((member) => {
    const memberItems = review.items.filter((item) => item.repoId === member.ref.repoId && item.crNumber === member.ref.number);
    const memberReview: Review = { ...review, items: memberItems };
    const composition = composeCommentDrafts(
      memberReview,
      agentLabel,
      you,
      member.anchorRefs,
      member.candidatesFor,
      member.workspaceRootLabel,
    );
    const comments = composition.drafts.map((comment) => {
      const item = memberItems.find((candidate) => candidate.id === comment.key);
      if (!item?.cross || !item.spans?.length) return comment;
      const spans = item.spans.map((span) => `- ${labels.get(span.repoId) ?? span.repoId} · ${span.location} · ${span.role}`).join('\n');
      return { ...comment, body: `${comment.body}\n\n**Spans two repositories**\n${spans}` };
    });
    return {
      ref: member.ref,
      submission: {
        comments,
        summary: composeSummaryBody(summary, '', undefined, composition.withheld),
        requestChanges,
        asSingleThread,
      },
      withheld: composition.withheld,
    };
  });
}

export async function performChangesetSubmit(
  connection: Connection,
  plans: readonly ChangesetMemberPlan[],
  previous?: ChangesetSubmitState,
): Promise<{ complete: boolean; state: ChangesetSubmitState; failures: ChangesetSubmitFailure[] }> {
  const posted = new Set(previous?.postedCommentKeys ?? []);
  const summaries = new Set(previous?.summaryRefs ?? []);
  const requested = new Set(previous?.requestChangesRefs ?? []);
  const refused = new Set(previous?.verdictRefusedRefs ?? []);
  const threadIds = { ...(previous?.threadIds ?? {}) };
  const failures: ChangesetSubmitFailure[] = [];

  for (const plan of plans) {
    const key = refKey(plan.ref);
    const comments = plan.submission.comments.filter((comment) => !posted.has(comment.key));
    const needsSummary = !summaries.has(key);
    const needsRequestChanges = Boolean(plan.submission.requestChanges)
      && !requested.has(key) && !refused.has(key);
    if (comments.length === 0 && !needsSummary && !needsRequestChanges) continue;
    try {
      const result = await connection.submitReview(plan.ref, {
        ...plan.submission,
        comments,
        summary: needsSummary ? plan.submission.summary : undefined,
        requestChanges: needsRequestChanges,
      });
      for (const outcome of result.comments) {
        if (outcome.ok) {
          posted.add(outcome.key);
          if (outcome.threadId) threadIds[outcome.key] = outcome.threadId;
        } else failures.push({ ref: plan.ref, operation: 'comment', key: outcome.key, message: outcome.error?.message ?? 'comment failed' });
      }
      if (result.summaryPosted) summaries.add(key);
      else if (needsSummary && result.summaryError) failures.push({ ref: plan.ref, operation: 'summary', message: result.summaryError.message });
      if (result.requestChangesApplied) requested.add(key);
      else if (needsRequestChanges && result.requestChangesError) {
        // Still reported as a failure — the user must know the verdict did not
        // land — but a refusal is terminal, so it stops gating completion.
        if (result.requestChangesError.kind === 'verdictRefused') refused.add(key);
        failures.push({ ref: plan.ref, operation: 'requestChanges', message: result.requestChangesError.message });
      }
    } catch (error) {
      failures.push({ ref: plan.ref, operation: 'request', message: error instanceof Error ? error.message : String(error) });
    }
  }

  const allCommentKeys = plans.flatMap((plan) => plan.submission.comments.map((comment) => comment.key));
  const allRefs = plans.map((plan) => refKey(plan.ref));
  const requestRefs = plans.filter((plan) => plan.submission.requestChanges).map((plan) => refKey(plan.ref));
  const state: ChangesetSubmitState = {
    postedCommentKeys: allCommentKeys.filter((key) => posted.has(key)),
    summaryRefs: allRefs.filter((key) => summaries.has(key)),
    requestChangesRefs: requestRefs.filter((key) => requested.has(key)),
    threadIds,
    verdictRefusedRefs: refused.size > 0 ? [...refused] : undefined,
  };
  const complete = allCommentKeys.every((key) => posted.has(key))
    && allRefs.every((key) => summaries.has(key))
    && requestRefs.every((key) => requested.has(key) || refused.has(key));
  return { complete, state, failures };
}