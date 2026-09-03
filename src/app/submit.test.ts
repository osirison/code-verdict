import { describe, expect, it, vi } from 'vitest';
import { parseAgentReviewResponse } from '../domain/agentResponse';
import { resolveAnchor } from '../domain/anchor';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { createReview, setVerdict } from '../domain/reviewState';
import type { Review } from '../domain/types';
import { loadSpecFixtures } from '../testing/specFixtures';
import { composeCommentDrafts, composeSummaryBody, performSubmit } from './submit';

const fixtures = loadSpecFixtures();
const { response } = parseAgentReviewResponse(fixtures.agentReviewResponse);
const refs = (fixtures.gitlabMergeRequest as { diff_refs: unknown }).diff_refs;
const storedLineCandidates = (review: Review) => (file: string) => review.items
  .filter((item) => item.file === file)
  .map((item) => ({ line: item.line, text: item.code }));

describe('composeCommentDrafts (spec §7)', () => {
  it('posts accepted items only, with the fixture attribution shape', () => {
    let review = createReview({
      repoId: '9101',
      crNumber: '2841',
      agentId: response.agentId,
      criteria: DEFAULT_CRITERIA,
      response,
    });
    review = setVerdict(review, 'itm_01H9Z4', 'accepted', true);
    review = setVerdict(review, 'itm_01H9Z5', 'rejected', false);
    review = setVerdict(review, 'itm_01H9Z6', 'accepted', false);

    const { drafts } = composeCommentDrafts(
      review,
      'HVE Core · PR Review',
      'you',
      refs,
      storedLineCandidates(review),
    );
    expect(drafts.map((d) => d.key)).toEqual(['itm_01H9Z4', 'itm_01H9Z6']);

    const blocker = drafts[0];
    expect(blocker?.body).toContain('**Refresh token logged in error path** · blocker · security · CWE-532');
    expect(blocker?.footer).toBe(
      '<sub>Flagged by HVE Core · PR Review (96% confidence), accepted by @you via Code Verdict.</sub>',
    );
    // applyFix carries the suggestion; comment-only acceptance drops it.
    expect(blocker?.suggestion).toBeDefined();
    expect(drafts[1]?.suggestion).toBeUndefined();
    expect(blocker?.anchor).toMatchObject({ filePath: 'src/auth/token.ts', line: 63, refs });
  });

  it('appends the final note after a divider', () => {
    expect(composeSummaryBody('Summary.', 'Note.')).toBe('Summary.\n\n---\n\nNote.');
    expect(composeSummaryBody('Summary.', '  ')).toBe('Summary.');
  });

  it('routes accepted attachment findings to the summary and keeps diff findings inline', () => {
    const { response: routed } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [
        { id: 'inline', file: 'src/diff.ts', line: 4, severity: 'major', category: 'tests', confidence: 90, title: 'Inline', body: 'Inline body', code: 'bad();' },
        { id: 'summary', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'Summary only', body: 'Summary body', code: 'stale text' },
      ],
    }, {
      diffPaths: ['src/diff.ts'],
      attachmentManifest: [{ path: 'docs/evidence.md', ranges: [{ startLine: 12, endLine: 12 }] }],
    });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: routed,
    });
    review = setVerdict(review, 'inline', 'accepted', false);
    review = setVerdict(review, 'summary', 'accepted', false);

    expect(composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      storedLineCandidates(review),
    ).drafts.map((draft) => draft.key)).toEqual(['inline']);
    const summary = composeSummaryBody('Review summary.', '', review);
    expect(summary).toContain('## Accepted findings outside the diff');
    expect(summary).toContain('### docs/evidence.md:12 - Summary only');
    expect(summary).toContain('Summary body');
    expect(summary).not.toContain('### src/diff.ts:4');
  });

  it('qualifies duplicate changeset attachment paths with member identity', () => {
    const { response: routed } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'combined',
      items: [
        { id: 'first', projectId: 'repo-a', mrIid: '11', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'First member', body: 'First body', code: 'stale' },
        { id: 'second', projectId: 'repo-b', mrIid: '22', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'Second member', body: 'Second body', code: 'stale' },
      ],
    }, {
      diffPaths: [],
      attachmentManifest: [{ path: 'docs/evidence.md', ranges: [{ startLine: 12, endLine: 12 }] }],
    });
    let review = createReview({
      repoId: 'changeset', crNumber: 'set-1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: routed,
    });
    review = setVerdict(review, 'first', 'accepted', false);
    review = setVerdict(review, 'second', 'accepted', false);

    const summary = composeSummaryBody('Review summary.', '', review);
    expect(summary).toContain('### projectId=repo-a mrIid=11 file=docs/evidence.md:12 - First member');
    expect(summary).toContain('### projectId=repo-b mrIid=22 file=docs/evidence.md:12 - Second member');
  });

  it('keeps a drifted diff-file finding anchored, repairs its line, and posts it inline', () => {
    const { response: drifted } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'drifted', file: 'src/diff.ts', line: 4, endLine: 5, severity: 'major', category: 'tests', confidence: 90, title: 'Drifted', body: 'Body', code: 'bad();' }],
    }, { diffPaths: ['src/diff.ts'] });
    const item = drifted.items[0]!;
    expect(item.anchored).toBe(true);
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: drifted,
    });
    review = setVerdict(review, 'drifted', 'accepted', false);

    const resolution = resolveAnchor([{ line: 9, text: 'bad();' }], item);
    expect(resolution).toEqual({ state: 'moved', line: 9 });
    const composed = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'bad();' }, { line: 10, text: 'next();' }],
    );
    expect(composed.drafts[0]?.anchor.line).toBe(9);
    expect(composed.drafts[0]?.anchor.endLine).toBe(10);
    expect(composed.withheld).toEqual([]);
  });

  it.each([
    ['no matching code', [{ line: 9, text: 'realAddedLine();' }]],
    ['no added lines', []],
    ['no changed file candidates', undefined],
  ] as const)('withholds an accepted anchored finding with %s', (_label, candidates) => {
    const { response: hallucinated } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'hallucinated', file: 'src/diff.ts', line: 999, severity: 'major', category: 'tests', confidence: 90, title: 'Hallucinated', body: 'Body', code: 'notInTheDiff();' }],
    }, { diffPaths: ['src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: hallucinated,
    });
    review = setVerdict(review, 'hallucinated', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, () => candidates);
    expect(composed.drafts).toEqual([]);
    expect(composed.withheld.map((item) => item.id)).toEqual(['hallucinated']);
    expect(composeSummaryBody('Review summary.', '', review, composed.withheld)).toContain(
      'Withheld from inline submission because its code does not match a current added line.',
    );
  });

  it('withholds attached unchanged-line evidence in a changed file from inline submission', () => {
    const { response: attached } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'attached-context', file: 'src/diff.ts', line: 40, severity: 'major', category: 'tests', confidence: 90, title: 'Unchanged context', body: 'Body', code: 'unchangedContext();' }],
    }, {
      diffPaths: ['src/diff.ts'],
      attachmentManifest: [{ path: 'src/diff.ts', ranges: [{ startLine: 40, endLine: 40 }] }],
    });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: attached,
    });
    review = setVerdict(review, 'attached-context', 'accepted', false);

    expect(attached.items[0]?.anchored).toBe(true);
    const composed = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'realAddedLine();' }],
    );
    expect(composed.drafts).toEqual([]);
    expect(composeSummaryBody('Review summary.', '', review, composed.withheld)).toContain(
      '### src/diff.ts:40 - Unchanged context',
    );
  });

  it('never sends a hallucinated line to the provider comment list', async () => {
    const { response: hallucinated } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'hallucinated', file: 'src/diff.ts', line: 999, severity: 'major', category: 'tests', confidence: 90, title: 'Hallucinated', body: 'Body', code: 'notInTheDiff();' }],
    }, { diffPaths: ['src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: hallucinated,
    });
    review = setVerdict(review, 'hallucinated', 'accepted', false);
    const composition = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'realAddedLine();' }],
    );
    const submitReview = vi.fn(async (_ref, submission: { comments: unknown[] }) => ({
      comments: submission.comments,
      summaryPosted: true,
    }));

    await performSubmit({ submitReview } as never, { repoId: 'repo', number: '1' }, {
      drafts: composition.drafts,
      summary: composeSummaryBody('Summary.', '', review, composition.withheld),
      requestChanges: false,
      asSingleThread: false,
    });

    expect(submitReview).toHaveBeenCalledOnce();
    expect(submitReview.mock.calls[0]?.[1].comments).toEqual([]);
  });

  it('removes only the known workspace-root prefix from provider comment anchors', () => {
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{
        id: 'rooted', file: 'api/src/diff.ts', line: 4, severity: 'major', category: 'tests', confidence: 90, code: 'changed();',
      }],
    }, { diffPaths: ['api/src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response,
    });
    review = setVerdict(review, 'rooted', 'accepted', false);

    expect(composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      storedLineCandidates(review),
      'api',
    ).drafts[0]?.anchor.filePath).toBe('src/diff.ts');
  });
});

describe('the verdict is sent once, however many times submit is retried', () => {
  it('withholds request-changes on a retry that already landed it', async () => {
    const sent: Array<{ requestChanges?: boolean }> = [];
    const connection = {
      submitReview: (_ref: unknown, submission: { requestChanges?: boolean }) => {
        sent.push({ requestChanges: submission.requestChanges });
        return Promise.resolve({ comments: [], summaryPosted: true });
      },
    } as unknown as Parameters<typeof performSubmit>[0];

    const plan = { drafts: [], summary: 's', requestChanges: true, asSingleThread: false };
    await performSubmit(connection, { repoId: 'r', number: '1' }, plan as never, {});
    await performSubmit(connection, { repoId: 'r', number: '1' }, plan as never, {
      verdictAlreadyApplied: true,
    });

    // GitHub creates a NEW review per call, so re-sending would stack a second
    // "changes requested" and re-notify the author.
    expect(sent.map((s) => s.requestChanges)).toEqual([true, false]);
  });
});
