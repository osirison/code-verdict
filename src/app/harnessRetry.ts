/**
 * Bounded transient retry, backoff/wait classification, and the cancellation
 * lifecycle controller (tasks 9.5-9.7 of `add-agentic-review-harness`,
 * design.md D12, spec `agentic-review-harness` "Budgets and retries degrade
 * truthfully").
 *
 * This module introduces no second retryability taxonomy: `runWithRetry`
 * only ever retries a *thrown* error, and only when `isRetryableScmError`
 * (`../platform/errors`) says the wrapped `ScmError` is transient. A typed
 * provider result state (`unavailable`, `notFound`, `binary`, ...) is a
 * truthful domain outcome already (design.md D3.4) and is never inspected
 * here for retryability — `../app/harnessToolDispatcher.ts`'s handlers pass
 * this module only the raw provider call, so a resolved (non-throwing)
 * promise always short-circuits straight to `{kind: 'ok'}` regardless of
 * what result state it carries.
 *
 * **9.5 idempotence.** `options.idempotent` is supplied by the caller, not
 * inferred here — `harnessToolDispatcher.ts` passes
 * `HostToolDefinition.idempotent` for every provider-backed call. When
 * `false`, this module never retries, no matter how the error classifies;
 * a repeat of a non-idempotent side effect (`requestCompletion`) may happen
 * only through the caller re-evaluating current truth, never through this
 * loop resending the identical request.
 *
 * **9.5 delay source.** `ScmError.retryAfterSeconds` (provider guidance)
 * always wins over computed backoff, in both directions — honoured even
 * when it is shorter than what exponential backoff would have chosen
 * (design.md D12: "Provider `Retry-After` or reset metadata takes
 * precedence").
 *
 * **9.6 waiting/resuming — the policy-level seam.** `ReviewRunManager`
 * (`../app/reviewRunManager.ts`) owns the real global execution slot, FIFO
 * queue, and one-active-run-per-target admission, and is replaced by task
 * 12.1 in a separate, currently-uncoordinated change; this module cannot
 * and does not touch any of that. What it *can* do honestly at the policy
 * level: classify a computed delay as short (retried inline, under this
 * same `await`) or long (exceeding `longDelayThresholdMs`, default
 * `policy.backoffMaxMs`), and for a long delay stop holding this call's
 * resources — return the typed `{kind: 'wait'}` outcome immediately,
 * without sleeping through it, after calling `hooks.onCheckpointDue` and
 * `hooks.onEnterWaiting`. `hooks.onResuming` fires on a *later*, separate
 * `runWithRetry` call made with `resumedFromWait: true` — the caller (a
 * future `HarnessAttempt`/run-manager resume path, section 10/12) sets that
 * flag when it re-issues the same logical operation after the wait ends,
 * preserving "returns through resuming" (design.md D12) as an explicit,
 * observable transition rather than an implicit retry. Real slot release
 * and FIFO re-admission around that boundary are section 12's job.
 *
 * **9.7 cancellation.** `cancellableWait` races the injected `sleep`
 * against `cancellation.onCancellationRequested` so a backoff wait cannot
 * outlive a cancellation request; `wireCancellationLifecycle` is the
 * "propagate cancellation to active work" half of 9.7 for the pieces this
 * layer owns: it calls `BudgetTracker.cancel()` synchronously (stopping
 * every new reservation, dispatcher-mediated or not) and then, in order,
 * `onCancelling`, `onCancelled`, `onReleaseRetainedState` — cancelling and
 * cancelled always fire before retained state is released. It is a
 * standalone helper, not auto-wired to one dispatch call, because
 * cancellation is an attempt-wide event, not a per-tool-call one; wiring it
 * once per attempt (as `../app/harnessToolDispatcher.ts` does at
 * construction when given a `cancellation` token) is what makes "stop new
 * reservations synchronously" hold for every budget consumer, not only
 * dispatcher-mediated tool calls.
 */
import type { AgentCancellationToken } from './lmAgent';
import { isRetryableScmError, toScmError } from '../platform/errors';
import type { HarnessPolicy } from '../domain/harnessPolicy';

// ---- Backoff policy ---------------------------------------------------------------

/** The subset of `HarnessPolicy` the retry engine reads — never the whole object, so a caller can pass a literal in tests. */
export interface RetryBackoffPolicy {
  readonly transientRetriesPerOperation: number;
  readonly backoffInitialMs: number;
  readonly backoffMaxMs: number;
  readonly backoffJitter: boolean;
  readonly maxElapsedMsPerAttempt: number;
}

export function retryBackoffPolicyFrom(policy: HarnessPolicy): RetryBackoffPolicy {
  return {
    transientRetriesPerOperation: policy.transientRetriesPerOperation,
    backoffInitialMs: policy.backoffInitialMs,
    backoffMaxMs: policy.backoffMaxMs,
    backoffJitter: policy.backoffJitter,
    maxElapsedMsPerAttempt: policy.maxElapsedMsPerAttempt,
  };
}

// ---- Hooks and outcomes -------------------------------------------------------------

export interface RetryWaitInfo {
  readonly attempt: number;
  readonly delayMs: number;
}

export interface RetryHooks {
  /** "checkpoints it" (design.md D12) — a long delay is about to be entered; the caller should persist state now. */
  readonly onCheckpointDue?: (info: RetryWaitInfo) => void;
  /** "moves the run to `waiting`... releases its global execution slot" — the policy-level half only; see file header. */
  readonly onEnterWaiting?: (info: RetryWaitInfo) => void;
  /** Fires once, at the start of a `runWithRetry` call made with `resumedFromWait: true`. */
  readonly onResuming?: () => void;
}

export type RetryOutcome<T> =
  | { readonly kind: 'ok'; readonly value: T; readonly attempts: number }
  /** Not idempotent, or an error kind `isRetryableScmError` does not allow — refused after exactly one attempt. */
  | { readonly kind: 'nonRetryable'; readonly error: unknown; readonly attempts: number }
  /** `transientRetriesPerOperation` additional attempts were made and every one failed. */
  | { readonly kind: 'exhausted'; readonly error: unknown; readonly attempts: number }
  /** The next delay would cross `maxElapsedMsPerAttempt` — stopped before spending it, per D12's elapsed-time budget. */
  | { readonly kind: 'elapsedBudgetExceeded'; readonly error: unknown; readonly attempts: number }
  /** The next delay was classified long (9.6); the caller owns checkpoint/waiting/resume from here. */
  | { readonly kind: 'wait'; readonly delayMs: number; readonly attempts: number; readonly error: unknown }
  | { readonly kind: 'cancelled'; readonly attempts: number };

export interface RunWithRetryOptions {
  /** `HostToolDefinition.idempotent` for the operation being retried — never inferred here (see file header). */
  readonly idempotent: boolean;
  readonly policy: RetryBackoffPolicy;
  /** The attempt's own elapsed-time clock at the moment this call started (`HostToolRequest.elapsedMs`) — not a wall-clock reading. */
  readonly elapsedMsAtStart: number;
  readonly cancellation?: AgentCancellationToken;
  /** Deterministic injection point, matching `BudgetTrackerOptions`' pattern. Defaults to real time/randomness/timers. */
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** A computed delay greater than this is "long" (9.6). Defaults to `policy.backoffMaxMs`. */
  readonly longDelayThresholdMs?: number;
  readonly hooks?: RetryHooks;
  /** Set by a caller re-issuing the same logical operation after an earlier `wait` outcome (9.6). */
  readonly resumedFromWait?: boolean;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Equal jitter: half the exponential base is fixed (a nonzero floor), half is random — stable under an injected `random`. */
function computeBackoffMs(attempt: number, policy: RetryBackoffPolicy, random: () => number): number {
  const base = Math.min(policy.backoffInitialMs * 2 ** (attempt - 1), policy.backoffMaxMs);
  if (!policy.backoffJitter) return base;
  return base / 2 + random() * (base / 2);
}

/** `ScmError.retryAfterSeconds` wins over computed backoff whenever the provider supplied it (design.md D12), in both directions. */
function delayForAttempt(error: unknown, attempt: number, policy: RetryBackoffPolicy, random: () => number): number {
  const scmError = toScmError(error);
  if (scmError.retryAfterSeconds !== undefined) return Math.max(0, scmError.retryAfterSeconds * 1000);
  return computeBackoffMs(attempt, policy, random);
}

/**
 * Races an injected `sleep` against `cancellation.onCancellationRequested` so
 * a pending backoff wait cannot outlive a cancellation request (9.7,
 * `harnessToolDispatcher.test.ts`-style fakes that merely flip
 * `isCancellationRequested` without ever invoking the listener will not be
 * caught mid-wait by this race — only by the pre/post-attempt checks
 * `runWithRetry` also makes; a token whose `onCancellationRequested` never
 * fires needs the flag polled some other way, which is out of scope here).
 */
function cancellableWait(ms: number, sleep: (ms: number) => Promise<void>, cancellation?: AgentCancellationToken): Promise<'elapsed' | 'cancelled'> {
  if (cancellation?.isCancellationRequested) return Promise.resolve('cancelled');
  if (!cancellation) return sleep(ms).then(() => 'elapsed' as const);
  return new Promise<'elapsed' | 'cancelled'>((resolve) => {
    let settled = false;
    const subscription = cancellation.onCancellationRequested(() => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      resolve('cancelled');
    });
    void sleep(ms).then(() => {
      if (settled) return;
      settled = true;
      subscription.dispose();
      resolve('elapsed');
    });
  });
}

/**
 * Bounded transient retry with provider-guided or exponential-jittered
 * backoff (9.5), classifying each delay as an inline wait or a long wait
 * the caller must checkpoint and release resources for (9.6).
 */
export async function runWithRetry<T>(fn: () => Promise<T>, options: RunWithRetryOptions): Promise<RetryOutcome<T>> {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const longDelayThresholdMs = options.longDelayThresholdMs ?? options.policy.backoffMaxMs;
  const maxAttempts = 1 + Math.max(0, options.policy.transientRetriesPerOperation);
  const startedAt = now();
  let attempts = 0;

  if (options.resumedFromWait === true) options.hooks?.onResuming?.();

  for (;;) {
    if (options.cancellation?.isCancellationRequested) return { kind: 'cancelled', attempts };
    attempts += 1;
    try {
      const value = await fn();
      return { kind: 'ok', value, attempts };
    } catch (error) {
      if (options.cancellation?.isCancellationRequested) return { kind: 'cancelled', attempts };
      if (!options.idempotent || !isRetryableScmError(toScmError(error))) {
        return { kind: 'nonRetryable', error, attempts };
      }
      if (attempts >= maxAttempts) return { kind: 'exhausted', error, attempts };
      const delayMs = delayForAttempt(error, attempts, options.policy, random);
      const projectedElapsedMs = options.elapsedMsAtStart + (now() - startedAt) + delayMs;
      if (projectedElapsedMs >= options.policy.maxElapsedMsPerAttempt) {
        return { kind: 'elapsedBudgetExceeded', error, attempts };
      }
      if (delayMs > longDelayThresholdMs) {
        options.hooks?.onCheckpointDue?.({ attempt: attempts, delayMs });
        options.hooks?.onEnterWaiting?.({ attempt: attempts, delayMs });
        return { kind: 'wait', delayMs, attempts, error };
      }
      const waited = await cancellableWait(delayMs, sleep, options.cancellation);
      if (waited === 'cancelled') return { kind: 'cancelled', attempts };
    }
  }
}

// ---- 9.7: cancellation lifecycle controller ------------------------------------------

export interface CancellationLifecycleHooks {
  readonly onCancelling?: () => void;
  readonly onCancelled?: () => void;
  /** Fires last — releasing retained state (ledger/candidate/checkpoint cleanup) is the caller's job, invoked only after both facts are emitted. */
  readonly onReleaseRetainedState?: () => void;
}

/** The subset of `BudgetTracker` this controller needs — avoids importing the whole module for its type alone. */
export interface CancellableBudget {
  cancel(): void;
}

/**
 * Wires one attempt's cancellation token to its budget tracker and activity
 * hooks (9.7). Idempotent: fires at most once, however many times the token
 * signals, and immediately (synchronously) if the token is already
 * cancelled at wiring time. Order is fixed: `budget.cancel()` (stop new
 * reservations, zero delay) first, then `onCancelling`, then `onCancelled`,
 * then `onReleaseRetainedState` last.
 */
export function wireCancellationLifecycle(
  cancellation: AgentCancellationToken,
  budget: CancellableBudget,
  hooks: CancellationLifecycleHooks = {},
): { dispose(): void } {
  let fired = false;
  function run(): void {
    if (fired) return;
    fired = true;
    budget.cancel();
    hooks.onCancelling?.();
    hooks.onCancelled?.();
    hooks.onReleaseRetainedState?.();
  }
  if (cancellation.isCancellationRequested) {
    run();
    return { dispose(): void {} };
  }
  const subscription = cancellation.onCancellationRequested(run);
  return { dispose: () => subscription.dispose() };
}
