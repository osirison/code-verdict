/**
 * How often the background poll is allowed to run.
 *
 * One poll's cost is not a constant: `fetchPodData` issues three list calls per
 * repository plus one check query per repository, and the notifier adds one
 * thread query per submitted review whose change request is still open. A fixed
 * 60-second interval is therefore two different settings wearing one number —
 * comfortable for a two-repository pod, and around 2,400 requests an hour for a
 * ten-repository one, which is half the authenticated hourly budget spent on
 * notifications nobody is waiting for. That is the shape of the failure the
 * user hit.
 *
 * So the interval is derived from the fan-out against a background allowance,
 * and the configured interval is its *floor* rather than its value. Conditional
 * requests already make a steady-state poll nearly free; this allowance is
 * sized for the two cases where they do not help — the first poll after the
 * extension host starts, when no validator is held, and a burst where every
 * list genuinely changed.
 */

/**
 * Requests one repository costs per poll: the change-request list, the work
 * item list, the run list, and one check-rollup query. Batching already fixed
 * the per-item fan-out; this is what remains and it is per repository by
 * design, not by accident.
 */
export const REQUESTS_PER_REPO = 4;

/**
 * What background polling may issue per hour.
 *
 * 1,200 is a quarter of GitHub's 5,000/hour authenticated budget if every one
 * of them were charged, and close to nothing once validators are held. The
 * quarter is the number that matters: it is the worst case, and it leaves the
 * other three quarters for the person using the editor.
 */
export const BACKGROUND_REQUESTS_PER_HOUR = 1_200;

/**
 * The floor, and the setting's default. 60s is what the notifier always used;
 * kept because it is right for the pods it was right for — a five-repository
 * pod costs 20 requests a poll, which is exactly the allowance at 60s. Larger
 * pods are what the scaling is for.
 */
export const DEFAULT_POLL_INTERVAL_SECONDS = 60;

/** Below this the poll is a spinner, not a notifier, whatever the pod size. */
export const MIN_POLL_INTERVAL_SECONDS = 30;

/**
 * A ceiling, so a pod large enough to compute an hour-long interval still
 * checks in. Past this point the honest answer is that the pod is too large to
 * poll and needs the shared-fetch redesign, not a longer sleep.
 */
export const MAX_POLL_INTERVAL_SECONDS = 900;

export interface PollFanOut {
  repoCount: number;
  /** Submitted reviews still open — one thread query each. */
  submittedReviews: number;
}

/** Requests one poll of this pod issues. */
export function pollFanOut({ repoCount, submittedReviews }: PollFanOut): number {
  return Math.max(0, repoCount) * REQUESTS_PER_REPO + Math.max(0, submittedReviews);
}

/**
 * The interval this pod has earned: never faster than `baseSeconds`, never
 * slower than the ceiling, and in between, whatever keeps the fan-out inside
 * the hourly allowance.
 */
export function pollIntervalMs(input: PollFanOut & { baseSeconds: number }): number {
  const base = clamp(
    Number.isFinite(input.baseSeconds) ? input.baseSeconds : DEFAULT_POLL_INTERVAL_SECONDS,
    MIN_POLL_INTERVAL_SECONDS,
    MAX_POLL_INTERVAL_SECONDS,
  );
  const earned = (pollFanOut(input) * 3_600_000) / BACKGROUND_REQUESTS_PER_HOUR;
  return clamp(
    Math.round(Math.max(base * 1000, earned)),
    base * 1000,
    MAX_POLL_INTERVAL_SECONDS * 1000,
  );
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}
