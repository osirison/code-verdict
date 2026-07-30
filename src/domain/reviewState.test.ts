import { describe, expect, it } from 'vitest';
import { parseAgentReviewResponse } from './agentResponse';
import { DEFAULT_CRITERIA } from './criteria';
import {
  allDecided,
  clearVerdict,
  createReview,
  isStale,
  nextUndecided,
  setVerdict,
  verdictCounts,
} from './reviewState';
import { loadSpecFixtures } from '../testing/specFixtures';

const { response } = parseAgentReviewResponse(loadSpecFixtures().agentReviewResponse);

function freshReview() {
  return createReview({
    repoId: '9101',
    crNumber: '2841',
    agentId: response.agentId,
    criteria: DEFAULT_CRITERIA,
    response,
  });
}

describe('review state (handoff §6)', () => {
  it('locks the summary until every item has a verdict', () => {
    let review = freshReview();
    expect(allDecided(review)).toBe(false);

    review = setVerdict(review, 'itm_01H9Z4', 'accepted', true);
    review = setVerdict(review, 'itm_01H9Z5', 'rejected', false);
    expect(allDecided(review)).toBe(false);
    expect(verdictCounts(review)).toEqual({ accepted: 1, rejected: 1, skipped: 0, undecided: 1 });

    review = setVerdict(review, 'itm_01H9Z6', 'skipped', false);
    expect(allDecided(review)).toBe(true);
  });

  it('undo reopens the summary gate', () => {
    let review = freshReview();
    for (const item of review.items) review = setVerdict(review, item.id, 'accepted', false);
    expect(allDecided(review)).toBe(true);
    review = clearVerdict(review, 'itm_01H9Z5');
    expect(allDecided(review)).toBe(false);
    expect(verdictCounts(review).undecided).toBe(1);
  });

  it('detects staleness by comparing the recorded head against the current one', () => {
    const review = freshReview();
    expect(isStale(review, review.headSha)).toBe(false);
    expect(isStale(review, 'somethingelse')).toBe(true);
  });

  it('auto-advance finds the next undecided item, wraps, and stays put when done', () => {
    let review = freshReview();
    // After deciding the first item, advance passes over it.
    review = setVerdict(review, 'itm_01H9Z4', 'accepted', false);
    expect(nextUndecided(review, 'itm_01H9Z4')?.id).toBe('itm_01H9Z5');

    // Deciding the last item wraps back to the first undecided one.
    review = setVerdict(review, 'itm_01H9Z6', 'skipped', false);
    expect(nextUndecided(review, 'itm_01H9Z6')?.id).toBe('itm_01H9Z5');

    review = setVerdict(review, 'itm_01H9Z5', 'rejected', false);
    expect(nextUndecided(review, 'itm_01H9Z5')).toBeUndefined();
  });

  it('ignores verdicts for unknown items', () => {
    const review = freshReview();
    expect(setVerdict(review, 'itm_nope', 'accepted', false)).toBe(review);
  });
});
