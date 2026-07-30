import { describe, expect, it } from 'vitest';
import { parseAgentReviewResponse } from './agentResponse';
import { DEFAULT_CRITERIA } from './criteria';
import { createReview, setVerdict } from './reviewState';
import { composeSummary } from './summary';
import { loadSpecFixtures } from '../testing/specFixtures';

const { response } = parseAgentReviewResponse(loadSpecFixtures().agentReviewResponse);

function reviewWithVerdicts() {
  let review = createReview({
    repoId: '9101',
    crNumber: '2841',
    agentId: response.agentId,
    criteria: DEFAULT_CRITERIA,
    response,
  });
  review = setVerdict(review, 'itm_01H9Z4', 'accepted', true); // blocker
  review = setVerdict(review, 'itm_01H9Z5', 'rejected', false); // blocker rejected
  review = setVerdict(review, 'itm_01H9Z6', 'accepted', false); // minor accepted
  return review;
}

describe('composeSummary (spec §7 composition)', () => {
  it('composes the terse voice per the spec recipe', () => {
    const text = composeSummary(reviewWithVerdicts(), 'HVE Core / PR Review', 'terse');
    expect(text).toContain('Reviewed with HVE Core / PR Review.');
    expect(text).toContain('1 blocker: refresh token logged in error path (token.ts:63). Needs a fix before merge.');
    expect(text).toContain('1 smaller item posted inline.');
    expect(text).toContain('1 finding dismissed as false positives.');
  });

  it('explanatory adds reasoning; blunt strips to one-liners', () => {
    const review = reviewWithVerdicts();
    expect(composeSummary(review, 'A', 'explanatory')).toContain('carries the reasoning');
    const blunt = composeSummary(review, 'A', 'blunt');
    expect(blunt).toContain('1 blockers. Fix before merge.');
    expect(blunt.length).toBeLessThan(90);
  });

  it('omits the blocker sentence when none were accepted', () => {
    let review = createReview({
      repoId: '9101',
      crNumber: '2841',
      agentId: 'a',
      criteria: DEFAULT_CRITERIA,
      response,
    });
    for (const item of review.items) review = setVerdict(review, item.id, 'skipped', false);
    const text = composeSummary(review, 'A', 'terse');
    expect(text).not.toContain('blocker');
    expect(text).not.toContain('posted inline');
  });
});
