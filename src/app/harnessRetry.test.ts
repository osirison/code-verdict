/**
 * Tests for tasks 9.5 (bounded transient retry, provider guidance vs
 * exponential backoff, idempotence gate) and 9.6 (the policy-level
 * short/long delay classification and checkpoint/waiting/resuming hooks) of
 * `add-agentic-review-harness`. See `harnessRetry.ts`'s file header for the
 * exact 9.6 scope boundary against `ReviewRunManager` (task 12.1).
 */
import { describe, expect, it } from 'vitest';
import {
  runWithRetry,
  wireCancellationLifecycle,
  type CancellableBudget,
  type RetryBackoffPolicy,
  type RetryHooks,
  type RunWithRetryOptions,
} from './harnessRetry';
import type { AgentCancellationToken } from './lmAgent';
import { ScmError } from '../platform/errors';

const POLICY: RetryBackoffPolicy = {
  transientRetriesPerOperation: 3,
  backoffInitialMs: 1000,
  backoffMaxMs: 30_000,
  backoffJitter: true,
  maxElapsedMsPerAttempt: 10_000_000,
};

function baseOptions(overrides: Partial<RunWithRetryOptions> = {}): RunWithRetryOptions {
  return {
    idempotent: true,
    policy: POLICY,
    elapsedMsAtStart: 0,
    now: (() => {
      let t = 0;
      return () => t++;
    })(),
    random: () => 0.5,
    sleep: async () => {},
    ...overrides,
  };
}

/** A cancellation token whose listener actually fires — the fakes elsewhere in this codebase only flip the flag, which `cancellableWait`'s race cannot observe (see `harnessRetry.ts`'s file header). */
function manualCancellationToken(): AgentCancellationToken & { cancel(): void } {
  let requested = false;
  const listeners = new Set<() => void>();
  return {
    get isCancellationRequested() {
      return requested;
    },
    onCancellationRequested(listener: () => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    cancel() {
      if (requested) return;
      requested = true;
      for (const listener of [...listeners]) listener();
    },
  };
}

const NETWORK_ERROR = () => new ScmError('network', 'temporary network failure');
const RATE_LIMITED = (retryAfterSeconds: number) => new ScmError('rateLimited', 'slow down', { retryAfterSeconds });
const NOT_FOUND = () => new ScmError('notFound', 'no such resource');

describe('runWithRetry (task 9.5)', () => {
  it('returns ok on the first successful attempt without any delay', async () => {
    const outcome = await runWithRetry(async () => 'value', baseOptions());
    expect(outcome).toEqual({ kind: 'ok', value: 'value', attempts: 1 });
  });

  it('retries a transient network failure and succeeds on the next attempt', async () => {
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw NETWORK_ERROR();
      return 'recovered';
    }, baseOptions());
    expect(outcome).toEqual({ kind: 'ok', value: 'recovered', attempts: 2 });
    expect(calls).toBe(2);
  });

  it('never retries a non-retryable error kind (e.g. notFound), even though idempotent', async () => {
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      throw NOT_FOUND();
    }, baseOptions());
    expect(outcome.kind).toBe('nonRetryable');
    expect(calls).toBe(1);
  });

  it('never retries a non-idempotent operation, even when the error is retryable', async () => {
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      throw NETWORK_ERROR();
    }, baseOptions({ idempotent: false }));
    expect(outcome.kind).toBe('nonRetryable');
    expect(calls).toBe(1);
  });

  it('exhausts after exactly 1 + transientRetriesPerOperation attempts and reports the last error', async () => {
    let calls = 0;
    const lastError = NETWORK_ERROR();
    const outcome = await runWithRetry(async () => {
      calls += 1;
      throw calls === 4 ? lastError : NETWORK_ERROR();
    }, baseOptions());
    expect(calls).toBe(4); // 1 + transientRetriesPerOperation(3)
    expect(outcome).toMatchObject({ kind: 'exhausted', attempts: 4, error: lastError });
  });

  it('honours Retry-After over computed backoff, even when Retry-After is shorter', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw RATE_LIMITED(2); // 2000ms, shorter than a jittered ~1000-2000ms first backoff would sometimes be, but the point is it is *used verbatim*
      return 'ok';
    }, baseOptions({ sleep: async (ms) => { sleeps.push(ms); } }));
    expect(outcome.kind).toBe('ok');
    expect(sleeps).toEqual([2000]);
  });

  it('computes exponential jittered backoff (equal jitter: base/2 + random*base/2) when no Retry-After is present', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    await runWithRetry(async () => {
      calls += 1;
      if (calls <= 2) throw NETWORK_ERROR();
      return 'ok';
    }, baseOptions({ random: () => 0.5, sleep: async (ms) => { sleeps.push(ms); } }));
    // attempt 1 failure -> base = min(1000*2^0, 30000) = 1000 -> 500 + 0.5*500 = 750
    // attempt 2 failure -> base = min(1000*2^1, 30000) = 2000 -> 1000 + 0.5*1000 = 1500
    expect(sleeps).toEqual([750, 1500]);
  });

  it('stops without retrying once the projected elapsed time would cross maxElapsedMsPerAttempt', async () => {
    const outcome = await runWithRetry(async () => {
      throw NETWORK_ERROR();
    }, baseOptions({ elapsedMsAtStart: 9_999_500, policy: { ...POLICY, maxElapsedMsPerAttempt: 10_000_000 } }));
    expect(outcome.kind).toBe('elapsedBudgetExceeded');
  });

  it('checks idempotence and error retryability before ever sleeping', async () => {
    let sleepCalls = 0;
    await runWithRetry(async () => {
      throw NOT_FOUND();
    }, baseOptions({ sleep: async () => { sleepCalls += 1; } }));
    expect(sleepCalls).toBe(0);
  });
});

describe('short vs long delay classification and hooks (task 9.6)', () => {
  it('a delay at or under the threshold is retried inline: no checkpoint/waiting hooks fire', async () => {
    const hooks: RetryHooks = { onCheckpointDue: () => { throw new Error('should not fire'); }, onEnterWaiting: () => { throw new Error('should not fire'); } };
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      if (calls === 1) throw RATE_LIMITED(5); // 5000ms
      return 'ok';
    }, baseOptions({ longDelayThresholdMs: 10_000, hooks }));
    expect(outcome.kind).toBe('ok');
    expect(calls).toBe(2);
  });

  it('a delay over the threshold returns a typed wait outcome without sleeping, after firing onCheckpointDue then onEnterWaiting', async () => {
    const order: string[] = [];
    const hooks: RetryHooks = {
      onCheckpointDue: (info) => order.push(`checkpoint:${info.delayMs}`),
      onEnterWaiting: (info) => order.push(`waiting:${info.delayMs}`),
    };
    let sleepCalls = 0;
    const outcome = await runWithRetry(async () => {
      throw RATE_LIMITED(120); // 120_000ms
    }, baseOptions({ longDelayThresholdMs: 30_000, hooks, sleep: async () => { sleepCalls += 1; } }));
    expect(outcome).toMatchObject({ kind: 'wait', delayMs: 120_000, attempts: 1 });
    expect(order).toEqual(['checkpoint:120000', 'waiting:120000']);
    expect(sleepCalls).toBe(0); // "instead of sleeping through it while holding resources" (design.md D12)
  });

  it('defaults the long-delay threshold to policy.backoffMaxMs when none is supplied', async () => {
    const hooks: RetryHooks = { onEnterWaiting: () => {} };
    let fired = false;
    const outcome = await runWithRetry(async () => {
      throw RATE_LIMITED(31); // 31_000ms > default backoffMaxMs (30_000ms)
    }, baseOptions({ hooks: { ...hooks, onEnterWaiting: () => { fired = true; } } }));
    expect(outcome.kind).toBe('wait');
    expect(fired).toBe(true);
  });

  it('a non-idempotent operation never reaches the wait classification: it is refused after one attempt', async () => {
    const hooks: RetryHooks = { onEnterWaiting: () => { throw new Error('should not fire'); } };
    const outcome = await runWithRetry(async () => {
      throw RATE_LIMITED(999);
    }, baseOptions({ idempotent: false, hooks }));
    expect(outcome.kind).toBe('nonRetryable');
  });

  it('onResuming fires once, at the very start, only when resumedFromWait is set', async () => {
    const calls: string[] = [];
    const hooks: RetryHooks = { onResuming: () => calls.push('resuming') };
    await runWithRetry(async () => 'ok', baseOptions({ hooks, resumedFromWait: true }));
    expect(calls).toEqual(['resuming']);

    calls.length = 0;
    await runWithRetry(async () => 'ok', baseOptions({ hooks }));
    expect(calls).toEqual([]);
  });

  it('a resumed call that fails and needs to wait again fires onResuming then the checkpoint/waiting pair', async () => {
    const order: string[] = [];
    const hooks: RetryHooks = {
      onResuming: () => order.push('resuming'),
      onCheckpointDue: () => order.push('checkpoint'),
      onEnterWaiting: () => order.push('waiting'),
    };
    const outcome = await runWithRetry(async () => {
      throw RATE_LIMITED(999);
    }, baseOptions({ longDelayThresholdMs: 30_000, hooks, resumedFromWait: true }));
    expect(outcome.kind).toBe('wait');
    expect(order).toEqual(['resuming', 'checkpoint', 'waiting']);
  });
});

describe('cancellation during backoff (tasks 9.6/9.7)', () => {
  it('a cancellation fired mid-sleep stops the wait promptly and yields a cancelled outcome, without retrying', async () => {
    const token = manualCancellationToken();
    let neverResolves: () => void = () => {};
    const hangingSleep = () => new Promise<void>((resolve) => { neverResolves = resolve; });
    let calls = 0;
    const outcomePromise = runWithRetry(async () => {
      calls += 1;
      throw NETWORK_ERROR();
    }, baseOptions({ cancellation: token, sleep: hangingSleep }));
    // Give the retry loop a tick to reach the sleep.
    await Promise.resolve();
    await Promise.resolve();
    token.cancel();
    const outcome = await outcomePromise;
    expect(outcome).toEqual({ kind: 'cancelled', attempts: 1 });
    expect(calls).toBe(1);
    void neverResolves; // the hanging sleep is deliberately never awaited to completion
  });

  it('a token already cancelled before the call starts is refused immediately, with zero attempts', async () => {
    const token = manualCancellationToken();
    token.cancel();
    let calls = 0;
    const outcome = await runWithRetry(async () => {
      calls += 1;
      return 'unreachable';
    }, baseOptions({ cancellation: token }));
    expect(outcome).toEqual({ kind: 'cancelled', attempts: 0 });
    expect(calls).toBe(0);
  });

  it('a cancellation observed right after a failed attempt short-circuits before computing or sleeping a delay', async () => {
    const token = manualCancellationToken();
    let sleepCalls = 0;
    const outcome = await runWithRetry(async () => {
      token.cancel();
      throw NETWORK_ERROR();
    }, baseOptions({ cancellation: token, sleep: async () => { sleepCalls += 1; } }));
    expect(outcome).toEqual({ kind: 'cancelled', attempts: 1 });
    expect(sleepCalls).toBe(0);
  });
});

describe('wireCancellationLifecycle (task 9.7)', () => {
  function fakeBudget(): CancellableBudget & { cancelCalls: number } {
    return {
      cancelCalls: 0,
      cancel() {
        this.cancelCalls += 1;
      },
    };
  }

  it('calls budget.cancel() synchronously, then cancelling, then cancelled, then release, exactly once', () => {
    const token = manualCancellationToken();
    const budget = fakeBudget();
    const order: string[] = [];
    wireCancellationLifecycle(token, budget, {
      onCancelling: () => order.push('cancelling'),
      onCancelled: () => order.push('cancelled'),
      onReleaseRetainedState: () => order.push('release'),
    });
    expect(order).toEqual([]); // nothing fires until cancellation is actually requested
    token.cancel();
    expect(budget.cancelCalls).toBe(1);
    expect(order).toEqual(['cancelling', 'cancelled', 'release']);
    token.cancel(); // a second signal (or a token that fires its listener more than once) must not re-run the sequence
    expect(budget.cancelCalls).toBe(1);
    expect(order).toEqual(['cancelling', 'cancelled', 'release']);
  });

  it('runs the sequence immediately when the token is already cancelled at wiring time', () => {
    const token = manualCancellationToken();
    token.cancel();
    const budget = fakeBudget();
    const order: string[] = [];
    wireCancellationLifecycle(token, budget, { onCancelling: () => order.push('cancelling'), onCancelled: () => order.push('cancelled') });
    expect(budget.cancelCalls).toBe(1);
    expect(order).toEqual(['cancelling', 'cancelled']);
  });

  it('works with no hooks supplied at all: budget.cancel() alone must not throw', () => {
    const token = manualCancellationToken();
    const budget = fakeBudget();
    expect(() => wireCancellationLifecycle(token, budget)).not.toThrow();
    expect(() => token.cancel()).not.toThrow();
    expect(budget.cancelCalls).toBe(1);
  });
});
