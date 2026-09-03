import { describe, expect, it, vi } from 'vitest';
import type { Review } from '../domain/types';
import type { Connection } from '../platform/provider';
import type { ReviewSubmission, SubmitResult } from '../platform/types';
import { ScmError } from '../platform/errors';
import { buildChangesetSubmitPlans, performChangesetSubmit } from './changesetSubmit';

const review: Review = {
  repoId: 'changeset', crNumber: 'trailer:1180', agentId: 'agent', headSha: 'combined', summary: '',
  criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['apiContract'], extraInstructions: '' },
  items: [
    { id: 'gateway', repoId: '9103', crNumber: '381', file: 'src/routes/session.ts', anchored: true, line: 88, severity: 'blocker', category: 'apiContract', confidence: 94, title: 'Gateway contract changed', body: 'The response changed.', code: 'expires_at' },
    { id: 'console-a', repoId: '9210', crNumber: '1509', file: 'src/api/session.ts', anchored: true, line: 41, severity: 'blocker', category: 'apiContract', confidence: 94, title: 'Console reads old field', body: 'The old field remains.', code: 'data.expiry', cross: true, spans: [{ repoId: '9103', location: 'src/routes/session.ts:88', role: 'renames the field' }, { repoId: '9210', location: 'src/api/session.ts:41', role: 'reads the old field' }] },
    { id: 'console-b', repoId: '9210', crNumber: '1509', file: 'src/api/session.ts', anchored: true, line: 42, severity: 'minor', category: 'apiContract', confidence: 80, title: 'Missing compatibility test', body: 'Add a test.', code: 'expect(expiry)' },
  ],
  verdicts: {
    gateway: { verdict: 'accepted', applyFix: false },
    'console-a': { verdict: 'accepted', applyFix: false },
    'console-b': { verdict: 'accepted', applyFix: false },
  },
};

const memberCandidates = (repoId: string) => (file: string) => review.items
  .filter((item) => item.repoId === repoId && item.file === file)
  .map((item) => ({ line: item.line, text: item.code }));

describe('changeset submission', () => {
  it('completes when the platform refuses the verdict, instead of retrying forever', async () => {
    // Neither GitHub nor GitLab lets an author request changes on their own
    // change request. Treating that as retryable never reports complete, so
    // the flow is stuck while every comment is already live on the platform.
    const plans = buildChangesetSubmitPlans(review, [
      { ref: { repoId: '9103', number: '381' }, anchorRefs: { head: 'gateway' }, candidatesFor: memberCandidates('9103') },
    ], 'Agent', 'you', 'Summary.', true, true);
    const submitReview = vi.fn(async (_ref, submission: ReviewSubmission): Promise<SubmitResult> => ({
      comments: submission.comments.map((c) => ({ key: c.key, ok: true, threadId: `thread-${c.key}` })),
      summaryPosted: true,
      requestChangesApplied: false,
      requestChangesError: new ScmError('verdictRefused', 'Can not request changes on your own pull request'),
    }));
    const connection = { submitReview } as unknown as Connection;

    const first = await performChangesetSubmit(connection, plans);
    expect(first.complete).toBe(true);
    // Reported, so the user is told — just not retried.
    expect(first.failures.map((f) => f.operation)).toEqual(['requestChanges']);
    expect(first.state.verdictRefusedRefs).toEqual(['9103!381']);

    // A retry from that state asks for nothing at all.
    const calls = submitReview.mock.calls.length;
    const second = await performChangesetSubmit(connection, plans, first.state);
    expect(second.complete).toBe(true);
    expect(submitReview.mock.calls.length).toBe(calls);
  });

  it('still retries a verdict that failed for an ordinary reason', async () => {
    const plans = buildChangesetSubmitPlans(review, [
      { ref: { repoId: '9103', number: '381' }, anchorRefs: { head: 'gateway' }, candidatesFor: memberCandidates('9103') },
    ], 'Agent', 'you', 'Summary.', true, true);
    const submitReview = vi.fn(async (_ref, submission: ReviewSubmission): Promise<SubmitResult> => ({
      comments: submission.comments.map((c) => ({ key: c.key, ok: true, threadId: `t-${c.key}` })),
      summaryPosted: true,
      requestChangesApplied: false,
      requestChangesError: new ScmError('network', 'connection reset'),
    }));
    const connection = { submitReview } as unknown as Connection;
    const first = await performChangesetSubmit(connection, plans);
    expect(first.complete).toBe(false);
    expect(first.state.verdictRefusedRefs).toBeUndefined();
  });

  it('routes comments by owning MR and retries only missing operations', async () => {
    const plans = buildChangesetSubmitPlans(review, [
      { ref: { repoId: '9103', number: '381' }, anchorRefs: { head: 'gateway' }, candidatesFor: memberCandidates('9103'), projectLabel: 'hve/platform/gateway' },
      { ref: { repoId: '9210', number: '1509' }, anchorRefs: { head: 'console' }, candidatesFor: memberCandidates('9210'), projectLabel: 'hve/platform/console' },
    ], 'HVE Core / PR Review', 'you', 'Combined summary.', true, true);
    expect(plans[0]?.submission.comments.map((comment) => comment.key)).toEqual(['gateway']);
    expect(plans[1]?.submission.comments.map((comment) => comment.key)).toEqual(['console-a', 'console-b']);
    expect(plans[1]?.submission.comments[0]?.body).toContain('Spans two repositories');
    expect(plans[1]?.submission.comments[0]?.body).toContain('hve/platform/gateway · src/routes/session.ts:88');
    expect(plans[1]?.submission.comments[0]?.body).toContain('hve/platform/console · src/api/session.ts:41');

    let consoleAttempt = 0;
    const submitReview = vi.fn(async (ref: { repoId: string }, submission: ReviewSubmission): Promise<SubmitResult> => {
      if (ref.repoId === '9103') return { comments: submission.comments.map((comment) => ({ key: comment.key, ok: true, threadId: `thread-${comment.key}` })), summaryPosted: true, requestChangesApplied: true };
      consoleAttempt += 1;
      if (consoleAttempt === 1) return { comments: [{ key: 'console-a', ok: true, threadId: 'thread-console-a' }, { key: 'console-b', ok: false }], summaryPosted: false };
      return { comments: submission.comments.map((comment) => ({ key: comment.key, ok: true, threadId: `thread-${comment.key}` })), summaryPosted: true, requestChangesApplied: true };
    });
    const connection = { submitReview } as unknown as Connection;

    const first = await performChangesetSubmit(connection, plans);
    expect(first.complete).toBe(false);
    expect(first.state.postedCommentKeys).toEqual(['gateway', 'console-a']);
    expect(first.state.summaryRefs).toEqual(['9103!381']);

    const second = await performChangesetSubmit(connection, plans, first.state);
    expect(second.complete).toBe(true);
    expect(submitReview).toHaveBeenCalledTimes(3);
    const retrySubmission = submitReview.mock.calls[2]?.[1];
    expect(retrySubmission?.comments.map((comment) => comment.key)).toEqual(['console-b']);
    expect(second.state.summaryRefs).toEqual(['9103!381', '9210!1509']);
  });

  it('resolves identical paths against each changeset member own added lines', () => {
    const memberReview: Review = {
      ...review,
      items: [
        { ...review.items[0]!, id: 'repo-a', repoId: 'repo-a', crNumber: '1', file: 'src/shared.ts', line: 10, code: 'shared();' },
        { ...review.items[0]!, id: 'repo-b', repoId: 'repo-b', crNumber: '2', file: 'src/shared.ts', line: 10, code: 'shared();' },
      ],
      verdicts: {
        'repo-a': { verdict: 'accepted', applyFix: false },
        'repo-b': { verdict: 'accepted', applyFix: false },
      },
    };
    const plans = buildChangesetSubmitPlans(memberReview, [
      {
        ref: { repoId: 'repo-a', number: '1' },
        anchorRefs: { head: 'a' },
        candidatesFor: () => [{ line: 21, text: 'shared();' }],
      },
      {
        ref: { repoId: 'repo-b', number: '2' },
        anchorRefs: { head: 'b' },
        candidatesFor: () => [{ line: 34, text: 'shared();' }],
      },
    ], 'Agent', 'you', 'Summary.', false, false);

    expect(plans.map((plan) => plan.submission.comments[0]?.anchor.line)).toEqual([21, 34]);
    expect(plans.flatMap((plan) => plan.withheld)).toEqual([]);
  });

  it('withholds a lost member finding and names it in only that member submission summary', () => {
    const lostReview: Review = {
      ...review,
      items: [{
        ...review.items[0]!,
        id: 'lost',
        repoId: 'repo-a',
        crNumber: '1',
        file: 'src/shared.ts',
        line: 999,
        code: 'hallucinated();',
        title: 'Lost member finding',
      }],
      verdicts: { lost: { verdict: 'accepted', applyFix: false } },
    };
    const plans = buildChangesetSubmitPlans(lostReview, [
      {
        ref: { repoId: 'repo-a', number: '1' },
        anchorRefs: { head: 'a' },
        candidatesFor: () => [{ line: 21, text: 'realAddedLine();' }],
      },
      {
        ref: { repoId: 'repo-b', number: '2' },
        anchorRefs: { head: 'b' },
        candidatesFor: () => [{ line: 34, text: 'otherAddedLine();' }],
      },
    ], 'Agent', 'you', 'Summary.', false, false);

    expect(plans[0]?.submission.comments).toEqual([]);
    expect(plans[0]?.withheld.map((item) => item.id)).toEqual(['lost']);
    expect(plans[0]?.submission.summary).toContain('projectId=repo-a mrIid=1 file=src/shared.ts:999');
    expect(plans[1]?.submission.summary).not.toContain('Lost member finding');
  });
});