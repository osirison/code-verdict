/**
 * The notifier's cadence: what it costs, when it stands down, and how often it
 * says so. The delivery paths (toasts, quick picks) are covered through the
 * notification engine's own tests; these are about the poll itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { ScmError } from '../platform/errors';
import type { ScmProvider } from '../platform/provider';
import { clearProviders, registerProvider } from '../platform/registry';
import { GITHUB_VOCABULARY } from '../testing/specFixtures';
import type { PodStore } from '../app/pods';
import type { ReviewHistory } from '../app/reviewHistory';
import type { SecretStore } from '../app/storage';
import { STALE_SNAPSHOT_MS } from '../app/notificationCenter';
import { pollIntervalMs } from '../app/pollSchedule';

const world = vi.hoisted(() => ({
  polls: 0,
  intents: [] as Array<string | undefined>,
  warnings: [] as string[],
  infos: [] as string[],
  failWith: undefined as unknown,
  focus: undefined as undefined | ((state: { focused: boolean }) => void),
  crs: [] as unknown[],
}));

vi.mock('vscode', () => ({
  window: {
    onDidChangeWindowState: (handler: (state: { focused: boolean }) => void) => {
      world.focus = handler;
      return { dispose: (): void => undefined };
    },
    showInformationMessage: (message: string) => {
      world.infos.push(message);
      return Promise.resolve(undefined);
    },
    showWarningMessage: (message: string) => {
      world.warnings.push(message);
      return Promise.resolve(undefined);
    },
    showQuickPick: () => Promise.resolve(undefined),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  env: { openExternal: () => undefined },
  Uri: { parse: () => undefined },
  ViewColumn: { One: 1 },
  commands: { executeCommand: () => undefined },
}));

vi.mock('../app/connections', () => ({
  connectionForPod: (_pod: unknown, _secrets: unknown, opts?: { intent?: string }) => {
    world.intents.push(opts?.intent);
    return Promise.resolve({
      listOpenChangeRequests: () => {
        world.polls += 1;
        return world.failWith === undefined ? Promise.resolve(world.crs) : Promise.reject(world.failWith);
      },
      listWorkItems: () => Promise.resolve([]),
      listCiRuns: () => Promise.resolve([]),
      listThreads: () => Promise.resolve([]),
    });
  },
}));

const PROVIDER = {
  id: 'test',
  displayName: 'GitHub',
  vocabulary: GITHUB_VOCABULARY,
  authModesFor: () => ['token'],
  connect: () => {
    throw new Error('the connection is mocked');
  },
} as unknown as ScmProvider;

/** One open change request, optionally naming the pod owner a reviewer. */
function changeRequest(reviewers: string[]) {
  return {
    ref: { repoId: 'acme/repo-0', number: '7' },
    title: 'Add per-tenant rate limiting',
    state: 'open' as const,
    sourceBranch: 'feat/rate-limit',
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: reviewers.map((username) => ({ username })),
    webUrl: 'https://example.test/pr/7',
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: 'aaaa',
  };
}

function pod(repoCount: number): Pod {
  return {
    id: 'pod-1',
    username: 'me',
    name: 'Platform',
    providerId: 'test',
    instanceUrl: 'https://example.test',
    sources: Array.from({ length: repoCount }, (_, i) => ({
      kind: 'repository' as const,
      repoId: `acme/repo-${i}`,
    })),
    criteria: DEFAULT_CRITERIA,
    agentId: 'demo',
  };
}

const rateLimited = (seconds?: number): ScmError =>
  new ScmError('rateLimited', 'API rate limit exceeded for user ID 1', { retryAfterSeconds: seconds });

let dispose: (() => void) | undefined;

async function notifierFor(repoCount = 1) {
  const { VerdictNotifier } = await import('./notifier.js');
  const onPollPaused = vi.fn();
  const podStore = { activePod: pod(repoCount) };
  const notifier = new VerdictNotifier({
    podStore: podStore as unknown as PodStore,
    secrets: {} as unknown as SecretStore,
    reviewHistory: {
      list: () => [],
      submittedRefs: () => new Set<string>(),
    } as unknown as ReviewHistory,
    onBadgeCount: () => undefined,
    onPollPaused,
    openReview: () => undefined,
    openPostedReviews: () => undefined,
  });
  dispose = () => notifier.dispose();
  return { notifier, onPollPaused, podStore };
}

describe('the poll that stands down', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    world.polls = 0;
    world.intents = [];
    world.warnings = [];
    world.infos = [];
    world.failWith = undefined;
    world.focus = undefined;
    world.crs = [];
    clearProviders();
    registerProvider(PROVIDER);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  it('declares itself background so the provider can hold a reserve', async () => {
    const { notifier } = await notifierFor();
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    // This poll runs on a schedule nobody asked for. It must not be what
    // spends the last requests before the user opens a review.
    expect(world.intents).toEqual(['background']);
  });

  it('skips polls while the window is exhausted, then resumes by itself', async () => {
    const { notifier, onPollPaused } = await notifierFor();
    world.failWith = rateLimited(300);

    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);
    expect(onPollPaused).toHaveBeenCalledWith(
      expect.objectContaining({ platformName: 'GitHub', resumesAt: expect.any(Number) as number }),
    );

    // Five ordinary intervals pass. Polling into a shut window is what turns
    // one refusal into a refusal a minute for the rest of the window.
    await vi.advanceTimersByTimeAsync(299_000);
    expect(world.polls).toBe(1);

    world.failWith = undefined;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(world.polls).toBe(2);
    expect(onPollPaused).toHaveBeenLastCalledWith(undefined);
  });

  it('stands down for a minute when the platform named no reset', async () => {
    const { notifier } = await notifierFor();
    world.failWith = rateLimited(undefined);

    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    world.failWith = undefined;
    // A minute, because that is what a secondary limit sends when it sends
    // anything. Guessing an hour would silence a pod over a passing burst.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.polls).toBe(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(world.polls).toBe(2);
  });

  it('tells the user once per exhaustion, not once per refused poll', async () => {
    const { notifier } = await notifierFor();
    world.failWith = rateLimited(60);

    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.warnings).toHaveLength(1);
    expect(world.warnings[0]).toContain('GitHub');

    // The resume attempt is refused too. That is the same episode, and a
    // second toast for it is the nagging this exists to avoid.
    await vi.advanceTimersByTimeAsync(65_000);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(world.polls).toBe(3);
    expect(world.warnings).toHaveLength(1);

    // Only a poll that succeeds ends the episode — and the next one is new.
    world.failWith = undefined;
    await vi.advanceTimersByTimeAsync(65_000);
    world.failWith = rateLimited(60);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.warnings).toHaveLength(2);
  });

  it('ignores a window focus that lands inside the pause', async () => {
    const { notifier } = await notifierFor();
    world.failWith = rateLimited(300);

    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    world.focus?.({ focused: true });
    await vi.advanceTimersByTimeAsync(0);

    // Focus is throttled at 15s, so this would have polled. The pause outranks
    // the throttle: an exhausted budget answers a focus poll exactly as it
    // answered the last one.
    expect(world.polls).toBe(1);
    expect(world.warnings).toHaveLength(1);
  });

  it('does not carry one pod\u2019s exhausted window over to another pod', async () => {
    const { notifier, podStore } = await notifierFor();
    world.failWith = rateLimited(3_000);

    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);

    // Another pod is another host, or at least another token, and its budget
    // is its own. Inheriting this pause would silence it for the rest of an
    // hour it had nothing to do with.
    world.failWith = undefined;
    podStore.activePod = { ...pod(1), id: 'pod-2' };
    // Past the focus throttle, but nowhere near the paused pod's reset.
    await vi.advanceTimersByTimeAsync(20_000);
    world.focus?.({ focused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(2);
  });

  it('polls a large pod less often, because one poll of it costs more', async () => {
    const { notifier } = await notifierFor(20);
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);

    // 20 repositories cost 80 requests a poll; at 60s that is 4,800 an hour,
    // the whole authenticated budget spent on notifications.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.polls).toBe(1);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(world.polls).toBe(2);
  });

  it('keeps the configured floor for a pod small enough to deserve it', async () => {
    const { notifier } = await notifierFor(1);
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(world.polls).toBe(2);
  });
});

describe('the cadence has to stay inside the window the engine still diffs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    world.polls = 0;
    world.intents = [];
    world.warnings = [];
    world.infos = [];
    world.failWith = undefined;
    world.focus = undefined;
    world.crs = [];
    clearProviders();
    registerProvider(PROVIDER);
  });

  afterEach(() => {
    dispose?.();
    dispose = undefined;
    vi.useRealTimers();
  });

  /**
   * The engine re-baselines silently across a gap it reads as a pod waking up.
   * A pod big enough to earn an interval wider than that gap would therefore
   * poll forever and derive nothing — not fewer notifications, none, with
   * every poll still paid for. This is the test that keeps the two numbers
   * tied together; raise the cap or lower the window and it fails here.
   */
  it('still derives events for a pod whose earned interval exceeds the default stale window', async () => {
    const { notifier } = await notifierFor(60);
    const earned = pollIntervalMs({ repoCount: 60, submittedReviews: 0, baseSeconds: 60 });
    expect(earned).toBeGreaterThan(STALE_SNAPSHOT_MS);

    world.crs = [changeRequest([])];
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);

    // One earned interval later the pod owner is added as a reviewer.
    world.crs = [changeRequest(['me'])];
    await vi.advanceTimersByTimeAsync(earned);
    expect(world.polls).toBe(2);
    expect(world.infos.join(' ')).toContain('Review requested');
  });

  it('a small pod keeps the 15s focus gap it always had', async () => {
    const { notifier } = await notifierFor(1);
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    world.focus?.({ focused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(2);
  });

  /**
   * The focus path is the one the scheduled cadence does not bound. A flat 15s
   * gap against a 240s interval is 16 polls where the allowance budgeted one:
   * an hour of Alt-Tab on this pod issued ~19,000 requests against 1,200.
   */
  it('scales the focus gap with the pod, so a focus flurry cannot outrun the allowance', async () => {
    const { notifier } = await notifierFor(20);
    notifier.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(1);

    // A quarter of the 240s this pod earned. Every focus before that is refused.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(15_000);
      world.focus?.({ focused: true });
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(world.polls).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000);
    world.focus?.({ focused: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(world.polls).toBe(2);
  });
});
