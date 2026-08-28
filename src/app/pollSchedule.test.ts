import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_REQUESTS_PER_HOUR,
  DEFAULT_POLL_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  pollFanOut,
  pollIntervalMs,
} from './pollSchedule';

const base = DEFAULT_POLL_INTERVAL_SECONDS;

describe('what one background poll costs', () => {
  it('counts four requests per repository plus one per submitted review', () => {
    // Two lists and a run list over REST, one check rollup over GraphQL, and
    // one thread query per review still waiting on a reply.
    expect(pollFanOut({ repoCount: 10, submittedReviews: 5 })).toBe(45);
    expect(pollFanOut({ repoCount: 1, submittedReviews: 0 })).toBe(4);
  });

  it('reads a pod with no repositories as costing nothing', () => {
    expect(pollFanOut({ repoCount: 0, submittedReviews: 0 })).toBe(0);
  });
});

describe('the interval a pod earns', () => {
  it('leaves a small pod on the configured floor', () => {
    // Five repositories cost 20 requests, which is exactly the hourly
    // allowance at 60s — the size the fixed interval was always right for.
    expect(pollIntervalMs({ repoCount: 5, submittedReviews: 0, baseSeconds: base })).toBe(60_000);
    expect(pollIntervalMs({ repoCount: 1, submittedReviews: 0, baseSeconds: base })).toBe(60_000);
  });

  it('stretches for a pod whose poll costs more', () => {
    // 45 requests a poll: at 60s that is 2,700 an hour, over half the whole
    // authenticated budget spent on notifications nobody is waiting for.
    const ms = pollIntervalMs({ repoCount: 10, submittedReviews: 5, baseSeconds: base });
    expect(ms).toBe(135_000);
    const perHour = (pollFanOut({ repoCount: 10, submittedReviews: 5 }) * 3_600_000) / ms;
    expect(Math.round(perHour)).toBe(BACKGROUND_REQUESTS_PER_HOUR);
  });

  it('keeps the same allowance whichever half of the fan-out grew', () => {
    // Repositories and open submitted reviews both cost requests; the schedule
    // must not be sensitive to which one the pod happens to be big in.
    expect(pollIntervalMs({ repoCount: 10, submittedReviews: 0, baseSeconds: base }))
      .toBe(pollIntervalMs({ repoCount: 0, submittedReviews: 40, baseSeconds: base }));
  });

  it('caps at the ceiling rather than computing an hour-long sleep', () => {
    // Past this the honest answer is that the pod is too large to poll and
    // needs one shared fetch across surfaces, not a longer nap.
    expect(pollIntervalMs({ repoCount: 500, submittedReviews: 0, baseSeconds: base }))
      .toBe(MAX_POLL_INTERVAL_SECONDS * 1000);
  });

  it('honours a raised floor and clamps an unusable one', () => {
    expect(pollIntervalMs({ repoCount: 1, submittedReviews: 0, baseSeconds: 300 })).toBe(300_000);
    // Setting the floor below the minimum is a request for a spinner, not a
    // notifier; the manifest advertises the same range this enforces.
    expect(pollIntervalMs({ repoCount: 1, submittedReviews: 0, baseSeconds: 1 }))
      .toBe(MIN_POLL_INTERVAL_SECONDS * 1000);
    expect(pollIntervalMs({ repoCount: 1, submittedReviews: 0, baseSeconds: 99_999 }))
      .toBe(MAX_POLL_INTERVAL_SECONDS * 1000);
  });

  it('falls back to the default when the setting is not a number', () => {
    // `configuration.get` hands back whatever is in settings.json.
    expect(pollIntervalMs({ repoCount: 1, submittedReviews: 0, baseSeconds: Number.NaN }))
      .toBe(DEFAULT_POLL_INTERVAL_SECONDS * 1000);
  });
});
