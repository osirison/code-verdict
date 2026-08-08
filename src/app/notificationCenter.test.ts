import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotificationPrefs, VerdictNotification } from '../domain/notifications';
import { NotificationCenter, type PendingNotification } from './notificationCenter';

interface Recorded {
  interrupts: VerdictNotification[];
  badges: Array<readonly PendingNotification[]>;
  digests: Array<readonly PendingNotification[]>;
}

function makeCenter(overrides?: Partial<NotificationPrefs>): { center: NotificationCenter; got: Recorded } {
  const got: Recorded = { interrupts: [], badges: [], digests: [] };
  const center = new NotificationCenter({
    prefs: () => ({ modes: {}, quietMode: false, digestCadence: 'Hourly', ...overrides }),
    sinks: {
      interrupt: (n) => got.interrupts.push(n),
      badgeChanged: (pending) => got.badges.push([...pending]),
      digestFlush: (batch) => got.digests.push(batch),
    },
  });
  return { center, got };
}

const event = (overrides?: Partial<VerdictNotification>): VerdictNotification => ({
  key: 'agentFinished',
  title: 'Review ready · 8 items on !2841',
  ...overrides,
});

const snapshot = () => ({ changeRequests: [], ciRuns: [], threads: [] });
const ctx = { you: 'you', submittedRefs: new Set<string>(), formatRef: (n: string) => `!${n}` };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 7, 7, 12, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NotificationCenter', () => {
  it('routes Interrupt events straight to the interrupt sink', () => {
    const { center, got } = makeCenter();
    center.notify(event());
    expect(got.interrupts).toHaveLength(1);
    expect(got.badges).toHaveLength(0);
  });

  it('queues Badge events and reports every queue change', () => {
    const { center, got } = makeCenter();
    center.notify(event({ key: 'authorPushed', title: 'Author pushed to !2841' }));
    center.notify(event({ key: 'mentioned', title: 'Mentioned on !2833 · @ravi' }));
    expect(got.badges.map((q) => q.length)).toEqual([1, 2]);
    expect(center.pending().map((n) => n.key)).toEqual(['authorPushed', 'mentioned']);
  });

  it('acknowledge clears the badge queue exactly once', () => {
    const { center, got } = makeCenter();
    center.notify(event({ key: 'authorPushed' }));
    center.acknowledge();
    center.acknowledge();
    expect(got.badges.map((q) => q.length)).toEqual([1, 0]);
    expect(center.pending()).toEqual([]);
  });

  it('drops Off events silently', () => {
    const { center, got } = makeCenter({ modes: { agentFinished: 'Off' } });
    center.notify(event());
    expect(got.interrupts).toHaveLength(0);
    expect(got.badges).toHaveLength(0);
  });

  it('holds Digest events until the cadence elapses, then flushes the batch once', () => {
    const { center, got } = makeCenter();
    center.notify(event({ key: 'pipelineFailed', title: 'Pipeline #90412 failed' }));
    center.notify(event({ key: 'threadStale', title: 'Thread went stale on !2833' }));
    expect(got.digests).toHaveLength(0);
    vi.advanceTimersByTime(60 * 60 * 1000); // 12:00 → 13:00, the Hourly flush
    expect(got.digests).toHaveLength(1);
    expect(got.digests[0]?.map((n) => n.key)).toEqual(['pipelineFailed', 'threadStale']);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(got.digests).toHaveLength(1); // empty queue never flushes
  });

  it('re-arms the digest timer for items queued after a flush', () => {
    const { center, got } = makeCenter();
    center.notify(event({ key: 'pipelineFailed' }));
    vi.advanceTimersByTime(60 * 60 * 1000);
    center.notify(event({ key: 'pipelineFailed' }));
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(got.digests).toHaveLength(2);
  });

  it('reschedule re-aims a pending flush at the new cadence', () => {
    let cadence: NotificationPrefs['digestCadence'] = 'End of day';
    const got: Recorded = { interrupts: [], badges: [], digests: [] };
    const center = new NotificationCenter({
      prefs: () => ({ modes: {}, quietMode: false, digestCadence: cadence }),
      sinks: {
        interrupt: (n) => got.interrupts.push(n),
        badgeChanged: (p) => got.badges.push([...p]),
        digestFlush: (b) => got.digests.push(b),
      },
    });
    center.notify(event({ key: 'pipelineFailed' }));
    cadence = 'Hourly';
    center.reschedule();
    vi.advanceTimersByTime(60 * 60 * 1000); // Hourly fires at 13:00; End of day would wait for 17:00
    expect(got.digests).toHaveLength(1);
    center.dispose();
  });

  it('demoteToBadge parks an interrupt on the badge queue', () => {
    const { center } = makeCenter();
    center.demoteToBadge(event());
    expect(center.pending().map((n) => n.key)).toEqual(['agentFinished']);
  });

  it('observe treats the first snapshot per pod as a silent baseline', () => {
    const { center, got } = makeCenter();
    const withFailure = {
      ...snapshot(),
      ciRuns: [{ id: '90412', repoId: '9101', status: 'failed' as const }],
    };
    center.observe('pod-1', withFailure, ctx); // baseline — the failure predates us
    expect(got.interrupts).toHaveLength(0);
    center.observe('pod-1', { ...snapshot(), ciRuns: [{ id: '90413', repoId: '9101', status: 'failed' as const }] }, ctx);
    expect(got.digests).toHaveLength(0); // digest-mode default: queued, not toasted
    expect(center.pending()).toHaveLength(0);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(got.digests).toHaveLength(1);
  });

  it('keeps baselines per pod — a pod switch never floods', () => {
    const { center, got } = makeCenter();
    center.observe('pod-1', snapshot(), ctx);
    center.observe('pod-2', { ...snapshot(), ciRuns: [{ id: '1', repoId: 'r', status: 'failed' as const }] }, ctx);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(got.digests).toHaveLength(0);
  });

  it('dispose cancels the pending flush and further delivery', () => {
    const { center, got } = makeCenter();
    center.notify(event({ key: 'pipelineFailed' }));
    center.dispose();
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    center.notify(event());
    expect(got.digests).toHaveLength(0);
    expect(got.interrupts).toHaveLength(0);
  });
});
