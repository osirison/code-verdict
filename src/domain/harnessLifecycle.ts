/**
 * Run/lineage/attempt identity and the canonical harness lifecycle (task 2.1
 * of `add-agentic-review-harness`, design.md D2). `RunLifecycle` is the
 * execution state machine; `ResultCompleteness` is tracked independently, so
 * no lifecycle value implies a completeness by itself.
 */

/** The target-level invocation a reviewer sees — distinct from `RunRecord.key`, which names the target itself. */
export type RunId = string;

/** An original attempt and any checkpoint-based resumes of it; stable across restarts. */
export type LineageId = string;

/** Monotonically increasing within a lineage — the resumed attempt's version number. */
export type AttemptNumber = number;

/**
 * `running` is deliberately absent here: it is a compatibility projection over
 * `planning | investigating | verifying | completing` for compact consumers,
 * not a state a run is ever actually in.
 */
export const RUN_LIFECYCLES = [
  'queued',
  'planning',
  'investigating',
  'verifying',
  'completing',
  'waiting',
  'paused',
  'resuming',
  'cancelling',
  'cancelled',
  'succeeded',
  'failed',
  'interrupted',
] as const;

export type RunLifecycle = (typeof RUN_LIFECYCLES)[number];

export const RESULT_COMPLETENESS_VALUES = ['none', 'partial', 'complete'] as const;

/** Independent of lifecycle: a run can fail with a partial result or succeed clean. */
export type ResultCompleteness = (typeof RESULT_COMPLETENESS_VALUES)[number];

export function isRunLifecycle(value: unknown): value is RunLifecycle {
  return (RUN_LIFECYCLES as readonly unknown[]).includes(value);
}

export function isResultCompleteness(value: unknown): value is ResultCompleteness {
  return (RESULT_COMPLETENESS_VALUES as readonly unknown[]).includes(value);
}

/** Fails closed: an unparseable persisted value is `undefined`, never guessed as a valid state. */
export function parseRunLifecycle(value: unknown): RunLifecycle | undefined {
  return isRunLifecycle(value) ? value : undefined;
}

export function parseResultCompleteness(value: unknown): ResultCompleteness | undefined {
  return isResultCompleteness(value) ? value : undefined;
}

const ACTIVE_LIFECYCLES = new Set<RunLifecycle>(['planning', 'investigating', 'verifying', 'completing']);

/** The `running` compatibility projection D2 describes for compact consumers. */
export function isActiveLifecycle(lifecycle: RunLifecycle): boolean {
  return ACTIVE_LIFECYCLES.has(lifecycle);
}

const TERMINAL_LIFECYCLES = new Set<RunLifecycle>(['succeeded', 'failed', 'cancelled', 'interrupted']);

/** A nonterminal attempt still persisted after restart is what the activation sweep closes as `interrupted`. */
export function isTerminalLifecycle(lifecycle: RunLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}
