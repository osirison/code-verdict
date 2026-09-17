/**
 * What a valid deepening schedule is, decided once.
 *
 * **The live failure this file was written for.** `mergeBaseDepthFactor` was
 * accepted as any positive integer, and 1 is a positive integer. Multiplying a
 * depth by 1 leaves it where it was, so the acquisition loop's
 * `depth >= mergeBaseMaxDepth` exit never came and its ladder had no end —
 * measured on 2026-09-11 against a real `git-http-backend` remote, 13 identical
 * depth-10 fetches went out before the run was stopped from outside. Each rung
 * is a network round trip, so the symptom was an unbounded run of fetches, not
 * merely a hang.
 *
 * `lockStaleFor` did not agree that such a policy was a ladder at all: it
 * counted rungs with a guard the loop did not have, derived a threshold of one
 * rung — 540,000 ms — and would have let a second attempt call that lock stale
 * and seize it while the first was still fetching. Two derivations of one
 * schedule, disagreeing about what a schedule even is.
 *
 * So `depthLadder` is now the only definition of the schedule, both of them read
 * it, and `normalizeLocalGitPolicy` decides at the point a policy is built
 * whether the schedule it names can be run. The cases below are the two halves
 * of that: what normalization will accept, and what the builder does with
 * everything — including the policies that never passed through it.
 */
import { describe, expect, it } from 'vitest';
import { MAX_FETCH_DEPTH, planGitInvocation } from './gitInvocation';
import { DEFAULT_LOCAL_GIT_POLICY, depthLadder, lockStaleFor, normalizeLocalGitPolicy, type LocalGitPolicy } from './localGitPolicy';

/** A full object id and a location this extension will fetch from, so the only thing a plan can refuse below is the depth. */
const HEAD = '0123456789abcdef0123456789abcdef01234567';
const FETCH_URL = 'https://git.example.test/acme/repo.git';
const TARGET_REF = 'refs/heads/main';

/**
 * Every schedule a caller might pass, hostile ones included — the three in the
 * middle are the ones that used to be accepted and could not be run.
 */
const RAW_SCHEDULES: readonly Partial<Record<keyof LocalGitPolicy, unknown>>[] = [
  {},
  { mergeBaseDepthFactor: 1 },
  { mergeBaseDepthFactor: 1.5 },
  { mergeBaseMaxDepth: 5000 },
  { fetchDepth: 2000 },
  { fetchDepth: 1, mergeBaseDepthFactor: 2, mergeBaseMaxDepth: 8 },
  { fetchDepth: 1, mergeBaseDepthFactor: 2, mergeBaseMaxDepth: MAX_FETCH_DEPTH },
  { fetchDepth: 3, mergeBaseDepthFactor: 3, mergeBaseMaxDepth: 100 },
  { fetchDepth: 10, mergeBaseMaxDepth: 10 },
  { fetchDepth: 100, mergeBaseMaxDepth: 10 },
  { fetchDepth: 0, mergeBaseDepthFactor: -4, mergeBaseMaxDepth: Number.NaN },
  { fetchDepth: '10', mergeBaseDepthFactor: null, mergeBaseMaxDepth: Number.POSITIVE_INFINITY },
];

const ladderOf = (policy: LocalGitPolicy): readonly number[] => depthLadder(policy.fetchDepth, policy.mergeBaseDepthFactor, policy.mergeBaseMaxDepth);

describe('the deepening schedule', () => {
  it('is three rungs by default — 10, 100, 1000 — and the lock is derived from those three', () => {
    const policy = normalizeLocalGitPolicy({});

    expect(ladderOf(policy)).toEqual([10, 100, 1000]);
    expect(policy.lockStaleMs).toBe(DEFAULT_LOCAL_GIT_POLICY.lockStaleMs);
    expect(lockStaleFor(policy)).toBe(3 * (2 * policy.fetchTimeoutMs + 10 * policy.readTimeoutMs));
  });

  it.each([1, 1.5, 1.999, 1.000001, 0, -4, Number.NaN, '10', null, undefined])(
    'does not accept %p as a factor, because a factor that cannot deepen names a ladder with no end',
    (factor) => {
      const policy = normalizeLocalGitPolicy({ mergeBaseDepthFactor: factor });

      expect(policy.mergeBaseDepthFactor).toBe(DEFAULT_LOCAL_GIT_POLICY.mergeBaseDepthFactor);
      expect(policy.mergeBaseDepthFactor).toBeGreaterThan(1);
      expect(ladderOf(policy)).toEqual([10, 100, 1000]);
    },
  );

  it.each([MAX_FETCH_DEPTH + 1, 5000, 1_000_000, Number.POSITIVE_INFINITY])(
    'does not accept %p as a depth, because the invocation seam will not plan a fetch that deep',
    (depth) => {
      expect(normalizeLocalGitPolicy({ mergeBaseMaxDepth: depth }).mergeBaseMaxDepth).toBe(DEFAULT_LOCAL_GIT_POLICY.mergeBaseMaxDepth);
      expect(normalizeLocalGitPolicy({ fetchDepth: depth }).fetchDepth).toBe(DEFAULT_LOCAL_GIT_POLICY.fetchDepth);
    },
  );

  it.each(RAW_SCHEDULES)('builds a ladder that ends, for %j', (raw) => {
    const ladder = ladderOf(normalizeLocalGitPolicy(raw));

    // Ending is not asserted by the loop returning — every ladder here is
    // finite by construction — it is asserted by the shape that makes it
    // finite: each rung is strictly deeper than the one before, and they are
    // bounded above.
    expect(ladder.length).toBeGreaterThan(0);
    for (let i = 1; i < ladder.length; i += 1) expect(ladder[i]).toBeGreaterThan(ladder[i - 1] ?? 0);
    expect(ladder[ladder.length - 1]).toBeLessThanOrEqual(MAX_FETCH_DEPTH);
  });

  it.each(RAW_SCHEDULES)('is a schedule the invocation seam will plan every rung of, for %j', (raw) => {
    for (const depth of ladderOf(normalizeLocalGitPolicy(raw))) {
      // Both fetch operations, because the ladder's first rung may be either:
      // a store that already holds the head asks for the target branch alone.
      const combined = planGitInvocation({ kind: 'fetchCommit', fetchUrl: FETCH_URL, commit: HEAD, depth, targetRef: TARGET_REF });
      const targetOnly = planGitInvocation({ kind: 'fetchMergeTarget', fetchUrl: FETCH_URL, targetRef: TARGET_REF, depth });

      expect(combined.ok, combined.ok ? '' : combined.refusal.reason).toBe(true);
      expect(targetOnly.ok, targetOnly.ok ? '' : targetOnly.refusal.reason).toBe(true);
    }
  });

  it.each(RAW_SCHEDULES)('derives the lock’s threshold from the rungs the ladder actually has, for %j', (raw) => {
    const policy = normalizeLocalGitPolicy(raw);

    // A threshold derived for fewer rungs than the ladder has is a lock a second
    // attempt may declare abandoned while the first is still fetching under it,
    // which is the case `lockStaleMs` exists to prevent.
    expect(lockStaleFor(policy)).toBe(ladderOf(policy).length * (2 * policy.fetchTimeoutMs + 10 * policy.readTimeoutMs));
  });

  it('ends for a factor that cannot deepen even when nothing normalized it', () => {
    // The builder's own guarantee, for the policy object somebody writes by hand
    // in TypeScript and passes straight to `lockStaleFor`. A rung is added only
    // when it is strictly deeper than the last, so a factor that multiplies a
    // depth into itself produces the starting depth and stops.
    expect(depthLadder(10, 1, MAX_FETCH_DEPTH)).toEqual([10]);
    expect(depthLadder(10, 0, MAX_FETCH_DEPTH)).toEqual([10]);
    expect(depthLadder(10, -1, MAX_FETCH_DEPTH)).toEqual([10]);
    expect(depthLadder(1, 1, MAX_FETCH_DEPTH)).toEqual([1]);
    expect(depthLadder(10, Number.NaN, MAX_FETCH_DEPTH)).toEqual([10]);
  });

  it('asks for the starting depth whatever the rest of the schedule says', () => {
    expect(depthLadder(10, 10, 10)).toEqual([10]);
    expect(depthLadder(100, 10, 10)).toEqual([100]);
    expect(depthLadder(1, 2, 8)).toEqual([1, 2, 4, 8]);
    expect(depthLadder(3, 3, 100)).toEqual([3, 9, 27, 81, 100]);
  });
});
