/**
 * The local source's own bounds, as injected values rather than constants at
 * call sites — task 7.9, and design.md's "Configurable Initial Defaults".
 *
 * Every number here is configuration, not product meaning. The distinction
 * matters in this module more than most: a cache bound, a lock wait and a lease
 * staleness threshold are exactly the values a test has to move to reach the
 * behaviour they guard. A 2 GiB bound asserted by filling 2 GiB of disk is not a
 * test anyone will run; a 2 GiB bound asserted by injecting 1 KiB is the same
 * code path in a hundredth of a second. So the defaults live here once, and
 * `createObjectCache` takes a `Partial<LocalGitPolicy>` — no call site in
 * `objectCache.ts` or `objectAcquisition.ts` reads a literal.
 *
 * `leaseStaleMs` is deliberately not a number of its own: task 7.7 names the
 * harness's maximum attempt elapsed time as the threshold, so it is read from
 * `DEFAULT_HARNESS_POLICY` rather than written down again. A second copy of "30
 * minutes" would go stale the day the harness's own bound moved, and the failure
 * would be an attempt evicted out from under itself.
 */
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import { DEFAULT_GIT_BOUNDS, MAX_FETCH_DEPTH, type GitInvocationBounds } from './gitInvocation';

export interface LocalGitPolicy {
  /** Total bytes the whole object cache may occupy before eviction runs (design D3). */
  cacheMaxBytes: number;
  /** How long an entry may go unused before eviction removes it even under the byte bound. */
  entryIdleLifetimeMs: number;
  /** Wall-clock bound on one `git fetch`. */
  fetchTimeoutMs: number;
  /** Wall-clock bound on one local read — `diff`, `show`, `grep`, `rev-parse`. */
  readTimeoutMs: number;
  /** Bytes of stdout one invocation may produce before the child is killed. */
  maxStdoutBytes: number;
  /** How long an acquisition waits for another attempt's lock before giving up. */
  lockWaitMs: number;
  /**
   * When a lock file is old enough to be treated as abandoned.
   *
   * Not a taste value: it has to exceed the longest an honest acquisition can
   * hold the lock, or a slow fetch would have its lock stolen while it was still
   * using it.
   *
   * The longest honest hold is a full ladder. Each rung is one fetch plus, where
   * the descriptor carries a ref hint, one retry through it — two fetches, each
   * bounded by `fetchTimeoutMs` — and there are as many rungs as the depth
   * schedule allows (10, 100, 1000 by default: three). Around them sit the
   * presence, verification, merge-base, shallow-boundary and merge-base-proof
   * reads, each bounded by `readTimeoutMs`. `lockStaleFor` below computes that
   * sum from the same fields rather than restating it, because the arithmetic
   * has changed twice already — it used to be "the pinned pair, two fetches",
   * which was right while acquisition fetched two commits and did no computing,
   * and then "six reads per rung", which was right until every rung also had to
   * prove its merge base — and a derivation that has to be remembered is one
   * that goes stale silently, with a slow acquisition losing its lock mid-fetch
   * as the symptom.
   *
   * It is only ever reached by a process that died: a live holder that finishes
   * releases the lock, and a live holder that is merely slow is bounded by the
   * same timeouts this is derived from.
   *
   * It is also not the only way out of a dead holder's lock. A lock naming a
   * process that no longer exists is taken at once, which is what makes crash
   * recovery immediate rather than a wait of this length.
   */
  lockStaleMs: number;
  /**
   * How much history the first fetch asks for, on both the pinned head and the
   * change request's target branch.
   *
   * It used to be 1, and 1 was right while the merge base came from the forge:
   * a diff compares two trees and needs no history between them. Computing the
   * merge base here instead makes history the whole question, and 1 cannot
   * answer it — measured on 2026-09-11 against this project's own repository,
   * a depth-1 fetch of the pinned head and `refs/heads/main` cost 2.49 MB and
   * `git merge-base` reported none, because at depth 1 the two graphs share
   * nothing.
   *
   * 10 is the measured first answer. The same pair at depth 10 cost 2.62 MB —
   * 0.13 MB more — and found the merge base in one round trip. Starting at 1
   * and deepening to 10 cost 3.16 MB in total, *more* than asking for 10
   * outright, because the second pack re-sends what the first already held. So
   * a start that usually succeeds is cheaper than a start that usually
   * escalates, and being a little too deep costs kilobytes while being too
   * shallow costs a whole extra round trip.
   */
  fetchDepth: number;
  /**
   * What the depth is multiplied by when the merge base is not in the history
   * that was fetched: 10 -> 100 -> 1000.
   *
   * Multiplied rather than added, because the cost of another step is a network
   * round trip — measured at 1.6-2.9 s against a real remote — plus a pack that
   * overlaps what is already held, and neither shrinks with the size of the
   * step. Two multiplications cover two orders of magnitude; adding a fixed
   * amount would take dozens of round trips to reach the same place and pay the
   * overlap on every one.
   *
   * **Greater than 1, and normalization enforces it.** A factor of 1 multiplies
   * a depth into itself: it does not describe a shallower ladder, it describes
   * one that never reaches its bound. `normalizeLocalGitPolicy` falls it back to
   * the default rather than accepting it, for the reason `depthLadder` records —
   * the loop that consumed it fetched the same depth 13 times against a real
   * remote. A caller who wants no deepening says so by setting
   * `mergeBaseMaxDepth` to `fetchDepth`, which is one rung and terminates by
   * arithmetic rather than by luck.
   */
  mergeBaseDepthFactor: number;
  /**
   * The deepest fetch this will ask for before refusing and saying so.
   *
   * The default is `MAX_FETCH_DEPTH` — the invocation seam's own bound, imported
   * rather than restated, so the two cannot drift. A value above it is not a
   * deeper ladder, it is a rung the seam will refuse to plan, and
   * `normalizeLocalGitPolicy` falls it back for that reason: the alternative was
   * a review that ended as `requestRefused` carrying the seam's depth rule,
   * which names the fetch planner's limit to somebody who set a policy bound. It
   * now ends, truthfully, at the deepest history this will fetch.
   *
   * The cost of it being too low: a change request whose merge base is more
   * than 1000 commits behind either tip is refused, with a reason naming the
   * depth that was reached, on a repository where git could have answered. The
   * reviewer sees why and this value is injectable.
   *
   * The cost of it being too high: bytes and seconds spent on a failure path.
   * That cost is bounded by the repository's own history rather than by this
   * number, because a depth past the end of history simply is the whole history
   * — measured, `--depth=160` and `--depth=640` against a 131-commit repository
   * both returned every commit and the same 3.41 MB a full fetch costs. The
   * shallow-boundary check stops the ladder at that point anyway, so the high
   * side is bounded twice.
   */
  mergeBaseMaxDepth: number;
  /**
   * When an attempt's lease stops holding its repository against eviction.
   *
   * Task 7.7 names the harness's maximum attempt elapsed time, so the default is
   * read from `DEFAULT_HARNESS_POLICY.maxElapsedMsPerAttempt` rather than
   * restated. An attempt cannot still be running past its own elapsed bound, so
   * a lease older than it belongs to a process that died.
   */
  leaseStaleMs: number;
}

/** Versions the *shape and defaults* of `LocalGitPolicy`, the way `HARNESS_POLICY_VERSION` does for the harness. */
export const LOCAL_GIT_POLICY_VERSION = '1';

/**
 * The deepening schedule itself: every depth the ladder will ask for, in order.
 *
 * **This is the one definition of what the schedule is**, and both things that
 * need to know consume it — `lockStaleFor` below takes its length, and
 * `objectAcquisition.ts`'s acquisition loop walks it rung by rung. They used to
 * derive the schedule separately, one counting rungs and the other multiplying
 * a depth, and the two disagreed about what a valid schedule even was.
 *
 * **The live failure that disagreement produced.** With
 * `mergeBaseDepthFactor: 1` the loop's own arithmetic could not advance —
 * `Math.min(depth * 1, max)` leaves the depth where it was, and the
 * `depth >= mergeBaseMaxDepth` exit never came — so the ladder never ended.
 * Measured: 13 identical depth-10 fetches at a real remote before an external
 * guard stopped it, each one a full network round trip. The counterpart here
 * stopped at one rung for the same policy, because it had a `factor > 1` guard
 * the loop did not, so `lockStaleFor` derived a threshold of 1 rung — 540,000
 * ms — for a ladder that never finished. A second attempt could then declare
 * that lock stale and seize it while the first was still fetching, which is
 * precisely the case `lockStaleMs` exists to prevent.
 *
 * **Why this terminates for any numbers at all.** A rung is only added when it
 * is strictly deeper than the one before it, so the depths are a strictly
 * increasing sequence bounded above by `maxDepth`, which is finite. That is not
 * a counter bolted on beside the arithmetic — it is the arithmetic's own exit,
 * and it fires for exactly the input that had none: a factor of 1 produces
 * `next === depth` and the ladder ends. `normalizeLocalGitPolicy` rejects such a
 * factor before it gets here, so this is the second lock on that door rather
 * than the first, and it is the one that also holds for a policy object built by
 * hand in TypeScript without passing through normalization.
 *
 * Always at least one rung — the starting depth is asked for whatever the rest
 * of the schedule says, including when it already meets or exceeds the bound —
 * and the return type says so, so the loop that walks it needs no branch for a
 * ladder with nowhere to start.
 */
export function depthLadder(fetchDepth: number, factor: number, maxDepth: number): readonly [number, ...number[]] {
  const rungs: [number, ...number[]] = [fetchDepth];
  let depth = fetchDepth;
  while (depth < maxDepth) {
    const next = Math.min(depth * factor, maxDepth);
    // `!(next > depth)` rather than `next <= depth`, which differs only for a
    // factor of NaN: the comparison is false either way, and the schedule has
    // to end on the answer it cannot order rather than run on it.
    if (!(next > depth)) break;
    rungs.push(next);
    depth = next;
  }
  return rungs;
}

/**
 * The longest an honest acquisition can hold the lock: every rung of the ladder,
 * each costing a fetch and a possible ref-hint retry, plus the local reads that
 * bracket them — presence, verification, merge base, shallow boundary, the
 * merge-base proof's frontier walk and the commit objects it reads to tell a
 * truncation point from a genuine root, and the ref write for the computed base.
 * Ten reads per rung is generous on purpose; this is a threshold for deciding a
 * *process died*, and being late costs a waiter some seconds while being early
 * corrupts a store somebody is writing.
 *
 * The rung count is `depthLadder`'s, which is the same array the acquisition
 * loop walks — not a second derivation that agrees with it by inspection. That
 * is the whole reason the builder exists: this threshold and that loop once
 * counted rungs separately and disagreed, and the disagreement's shape was a
 * lock declared stale after one rung's worth of time while the loop was still on
 * a ladder with no end.
 */
export function lockStaleFor(
  bounds: Pick<LocalGitPolicy, 'fetchTimeoutMs' | 'readTimeoutMs' | 'fetchDepth' | 'mergeBaseDepthFactor' | 'mergeBaseMaxDepth'>,
): number {
  const rungs = depthLadder(bounds.fetchDepth, bounds.mergeBaseDepthFactor, bounds.mergeBaseMaxDepth).length;
  return rungs * (2 * bounds.fetchTimeoutMs + 10 * bounds.readTimeoutMs);
}

/**
 * The depth schedule, named once. Two fields below are derived from it —
 * `lockStaleMs`, because how long an acquisition may honestly hold its lock is a
 * function of how many rungs the ladder has — so writing the numbers twice is
 * how the lock threshold would come to describe a schedule that no longer
 * exists.
 */
const DEPTHS = { fetchDepth: 10, mergeBaseDepthFactor: 10, mergeBaseMaxDepth: MAX_FETCH_DEPTH } as const;

export const DEFAULT_LOCAL_GIT_POLICY: Readonly<LocalGitPolicy> = {
  cacheMaxBytes: 2 * 1024 * 1024 * 1024,
  entryIdleLifetimeMs: 30 * 24 * 60 * 60 * 1000,
  // The three invocation bounds are the seam's own defaults, read from it rather
  // than repeated: `DEFAULT_GIT_BOUNDS` is what an invocation uses when a caller
  // passes nothing, and two spellings of one default is a disagreement waiting
  // to happen.
  fetchTimeoutMs: DEFAULT_GIT_BOUNDS.fetchTimeoutMs,
  readTimeoutMs: DEFAULT_GIT_BOUNDS.readTimeoutMs,
  maxStdoutBytes: DEFAULT_GIT_BOUNDS.maxStdoutBytes,
  lockWaitMs: 60_000,
  lockStaleMs: lockStaleFor({
    fetchTimeoutMs: DEFAULT_GIT_BOUNDS.fetchTimeoutMs,
    readTimeoutMs: DEFAULT_GIT_BOUNDS.readTimeoutMs,
    ...DEPTHS,
  }),
  ...DEPTHS,
  leaseStaleMs: DEFAULT_HARNESS_POLICY.maxElapsedMsPerAttempt,
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A whole number in `[1, MAX_FETCH_DEPTH]`, or the field's own default.
 *
 * The upper bound is the seam's, not a taste of this module's: every depth in
 * the schedule is planned by `planGitInvocation`, which refuses one outside that
 * range, so a policy that names a deeper start or a deeper bound is a policy
 * whose ladder cannot run. Falling back rather than clamping matches how every
 * other field here treats a value it cannot use — one unusable number becomes
 * its own default and the rest of the policy stands.
 */
function fetchableDepth(value: unknown, fallback: number): number {
  const depth = positiveInteger(value, fallback);
  return depth <= MAX_FETCH_DEPTH ? depth : fallback;
}

/**
 * A deepening factor, which has to be *greater than* 1 to be one at all.
 *
 * `positiveInteger` accepts 1 and floors 1.5 to 1, and both leave a ladder that
 * multiplies a depth into itself and never reaches its bound —
 * `depthLadder` above records what that cost when the acquisition loop
 * believed it. This is the point the policy is built, so this is where a
 * schedule that cannot terminate is turned into one that can, rather than being
 * discovered on the thirteenth fetch.
 */
function deepeningFactor(value: unknown, fallback: number): number {
  const factor = positiveInteger(value, fallback);
  return factor > 1 ? factor : fallback;
}

/**
 * Per-field fallback, matching `normalizeHarnessPolicy`: one unusable value
 * falls back to its own default.
 *
 * **This is where a deepening schedule is decided to be valid**, and it is the
 * only place one has to be: every `LocalGitPolicy` in this codebase is born
 * here — `createObjectCache` and `createLocalGitSource` both normalize what they
 * are given, and nothing else constructs one — so the three fields the ladder is
 * built from are checked once, at the point they are built, rather than at the
 * two places that later read them. A factor that cannot deepen and a depth the
 * invocation seam will not plan are both unusable numbers in exactly the sense
 * this function already exists to handle.
 */
export function normalizeLocalGitPolicy(value: Partial<Record<keyof LocalGitPolicy, unknown>> = {}): LocalGitPolicy {
  return {
    cacheMaxBytes: positiveInteger(value.cacheMaxBytes, DEFAULT_LOCAL_GIT_POLICY.cacheMaxBytes),
    entryIdleLifetimeMs: positiveInteger(value.entryIdleLifetimeMs, DEFAULT_LOCAL_GIT_POLICY.entryIdleLifetimeMs),
    fetchTimeoutMs: positiveInteger(value.fetchTimeoutMs, DEFAULT_LOCAL_GIT_POLICY.fetchTimeoutMs),
    readTimeoutMs: positiveInteger(value.readTimeoutMs, DEFAULT_LOCAL_GIT_POLICY.readTimeoutMs),
    maxStdoutBytes: positiveInteger(value.maxStdoutBytes, DEFAULT_LOCAL_GIT_POLICY.maxStdoutBytes),
    // Zero is a meaningful wait — "do not queue behind another attempt" — and it
    // is what eviction passes when it tries an entry's lock without blocking, so
    // this one field admits it where every other rejects it.
    lockWaitMs:
      typeof value.lockWaitMs === 'number' && Number.isFinite(value.lockWaitMs) && value.lockWaitMs >= 0
        ? Math.floor(value.lockWaitMs)
        : DEFAULT_LOCAL_GIT_POLICY.lockWaitMs,
    lockStaleMs: positiveInteger(value.lockStaleMs, DEFAULT_LOCAL_GIT_POLICY.lockStaleMs),
    fetchDepth: fetchableDepth(value.fetchDepth, DEFAULT_LOCAL_GIT_POLICY.fetchDepth),
    mergeBaseDepthFactor: deepeningFactor(value.mergeBaseDepthFactor, DEFAULT_LOCAL_GIT_POLICY.mergeBaseDepthFactor),
    mergeBaseMaxDepth: fetchableDepth(value.mergeBaseMaxDepth, DEFAULT_LOCAL_GIT_POLICY.mergeBaseMaxDepth),
    leaseStaleMs: positiveInteger(value.leaseStaleMs, DEFAULT_LOCAL_GIT_POLICY.leaseStaleMs),
  };
}

/**
 * The invocation bounds this policy implies.
 *
 * `maxStderrBytes` is the seam's own and stays there: it bounds this process's
 * memory against a child that loops writing diagnostics, which is not a policy
 * anyone configures a review with.
 */
export function gitBoundsFromPolicy(policy: LocalGitPolicy): GitInvocationBounds {
  return {
    readTimeoutMs: policy.readTimeoutMs,
    fetchTimeoutMs: policy.fetchTimeoutMs,
    maxStdoutBytes: policy.maxStdoutBytes,
    maxStderrBytes: DEFAULT_GIT_BOUNDS.maxStderrBytes,
  };
}
