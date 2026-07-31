import { describe, expect, it } from 'vitest';
import { parseAgentReviewResponse } from '../domain/agentResponse';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { createReview, setVerdict } from '../domain/reviewState';
import { loadSpecFixtures } from '../testing/specFixtures';
import { composeCommentDrafts, composeSummaryBody } from './submit';

const fixtures = loadSpecFixtures();
const { response } = parseAgentReviewResponse(fixtures.agentReviewResponse);
const refs = (fixtures.gitlabMergeRequest as { diff_refs: unknown }).diff_refs;

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

    const drafts = composeCommentDrafts(review, 'HVE Core · PR Review', 'you', refs);
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
});
