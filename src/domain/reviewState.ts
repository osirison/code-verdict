/**
 * Pure review-state logic (handoff §6): verdicts, summary gating,
 * staleness, auto-advance. UI layers call these; they never own the rules.
 */
import type { AgentReviewResponse } from './agentResponse';
import { normalizeEffortLevel, type EffortLevel } from './effort';
import type { Criteria, Review, ReviewItem, Severity, Verdict } from './types';

export function createReview(input: {
  repoId: string;
  crNumber: string;
  agentId: string;
  /** The model that ran it. Absent for the demo agent, which calls none. */
  modelId?: string;
  effort?: EffortLevel;
  criteria: Criteria;
  response: AgentReviewResponse;
}): Review {
  return {
    repoId: input.repoId,
    crNumber: input.crNumber,
    agentId: input.agentId,
    modelId: input.modelId,
    effort: normalizeEffortLevel(input.effort),
    criteria: input.criteria,
    headSha: input.response.headSha,
    items: input.response.items,
    verdicts: {},
    summary: '',
  };
}

export function setVerdict(
  review: Review,
  itemId: string,
  verdict: Verdict,
  applyFix: boolean,
): Review {
  if (!review.items.some((i) => i.id === itemId)) return review;
  return {
    ...review,
    verdicts: { ...review.verdicts, [itemId]: { verdict, applyFix } },
  };
}

/** `U` — undo the verdict on one item. */
export function clearVerdict(review: Review, itemId: string): Review {
  if (!(itemId in review.verdicts)) return review;
  const verdicts = { ...review.verdicts };
  delete verdicts[itemId];
  return { ...review, verdicts };
}

export interface VerdictCounts {
  accepted: number;
  rejected: number;
  skipped: number;
  undecided: number;
}

export function verdictCounts(review: Review): VerdictCounts {
  const counts: VerdictCounts = { accepted: 0, rejected: 0, skipped: 0, undecided: 0 };
  for (const item of review.items) {
    const v = review.verdicts[item.id];
    if (!v) counts.undecided += 1;
    else counts[v.verdict] += 1;
  }
  return counts;
}

/** "Generate summary" is inert until every item has a verdict. */
export function allDecided(review: Review): boolean {
  return review.items.every((i) => review.verdicts[i.id] !== undefined);
}

/** New commits landed since the agent read the diff. */
export function isStale(review: Review, currentHeadSha: string): boolean {
  return review.headSha !== currentHeadSha;
}

/**
 * `1`–`4` jump to severity (handoff §6). The undecided item comes first —
 * the key exists to reach the work that is left, not to re-read a decision.
 */
export function firstOfSeverity(review: Review, severity: Severity): ReviewItem | undefined {
  const ofSeverity = review.items.filter((i) => i.severity === severity);
  return ofSeverity.find((i) => review.verdicts[i.id] === undefined) ?? ofSeverity[0];
}

/**
 * Auto-advance (spec: Interactions & behavior): the next *undecided* item
 * after the current one, falling back to the first undecided, staying put
 * (undefined) when none remain.
 */
export function nextUndecided(review: Review, fromItemId?: string): ReviewItem | undefined {
  const undecided = review.items.filter((i) => review.verdicts[i.id] === undefined);
  if (undecided.length === 0) return undefined;
  if (fromItemId === undefined) return undecided[0];
  const fromIndex = review.items.findIndex((i) => i.id === fromItemId);
  const after = undecided.find(
    (i) => review.items.findIndex((x) => x.id === i.id) > fromIndex,
  );
  return after ?? undecided[0];
}
