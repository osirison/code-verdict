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
    expect(blunt).toContain('1 blocker. Fix before merge.');
    expect(blunt).toContain('1 inline comment.');
    expect(blunt.length).toBeLessThan(90);
  });

  it('reports posted-and-withheld together when anchor resolution withheld some accepted items', () => {
    // itm_01H9Z6 is the one non-blocker accepted item — mark it withheld, as
    // `composeCommentDrafts` would when its code no longer matches the diff.
    const review = reviewWithVerdicts();
    const withheld = [review.items.find((i) => i.id === 'itm_01H9Z6')!];
    const text = composeSummary(review, 'HVE Core / PR Review', 'terse', withheld);
    expect(text).not.toContain('posted inline');
    expect(text).toContain('1 finding could not be anchored to the diff — see below.');
  });

  it('names the true post-resolution split, never the pre-resolution verdict tally', () => {
    // Two non-blocker accepted items, one anchors and one does not — the
    // headline must say "1 posted" and "1 could not be anchored", never "2
    // smaller items posted inline" computed from verdicts alone.
    const { response: two } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [
        { id: 'a', file: 'src/a.ts', line: 1, severity: 'minor', category: 'style', confidence: 80, title: 'A', body: 'A', code: 'a();' },
        { id: 'b', file: 'src/b.ts', line: 1, severity: 'minor', category: 'style', confidence: 80, title: 'B', body: 'B', code: 'b();' },
      ],
    });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: two });
    review = setVerdict(review, 'a', 'accepted', false);
    review = setVerdict(review, 'b', 'accepted', false);
    const withheldB = review.items.find((i) => i.id === 'b')!;
    const text = composeSummary(review, 'A', 'terse', [withheldB]);
    expect(text).toContain('1 smaller item posted inline.');
    expect(text).toContain('1 finding could not be anchored to the diff — see below.');
  });

  it('a withheld blocker still counts toward "could not be anchored", though never toward "posted inline"', () => {
    const review = reviewWithVerdicts();
    const blocker = review.items.find((i) => i.id === 'itm_01H9Z4')!;
    const text = composeSummary(review, 'A', 'terse', [blocker]);
    // The blocker sentence names it regardless — no "posted inline" claim to
    // get wrong there — but the withheld count must still see it, because
    // the summary body's withheld section will list it.
    expect(text).toContain('Needs a fix before merge.');
    expect(text).toContain('1 smaller item posted inline.');
    expect(text).toContain('1 finding could not be anchored to the diff — see below.');
  });

  it('says nothing was posted when every accepted item was withheld', () => {
    const review = reviewWithVerdicts();
    const all = review.items.filter((i) => review.verdicts[i.id]?.verdict === 'accepted' && i.severity !== 'blocker');
    const text = composeSummary(review, 'A', 'terse', all);
    expect(text).not.toContain('posted inline');
    expect(text).toContain(`${all.length} finding could not be anchored to the diff — see below.`);
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
