/**
 * Review runs, owned by the extension rather than by the screen that started
 * them.
 *
 * A run used to be panel state: the steps, the liveness counters and the
 * pending request all lived on `ReviewFlowPanel`, and two ordinary navigations
 * threw them away — opening another change request, or leaving the Verdict
 * surface for any other screen. The result was discarded on arrival while the
 * model request kept streaming, so the reviewer paid for a review they could
 * never read. And because there was one panel and one cancellation counter on
 * it, a second review was impossible by construction.
 *
 * So a run lives here instead, keyed by the target it reviews. This module owns
 * three things and no more:
 *
 * - **Lifetime.** A run starts when it is triggered and ends when it finishes,
 *   fails, or is cancelled. Nothing about a panel enters that sentence.
 * - **A budget.** Independent targets run concurrently up to a limit; the rest
 *   queue in trigger order. Because a cancelled run really does stop (see
 *   `RunAgentOptions.cancellation`), a released slot is a slot the next run can
 *   actually use.
 * - **Completion.** The result is written, recorded and announced from one
 *   place, whether or not anything is watching. That is what makes "come back
 *   later and the findings are waiting" true.
 *
 * Deliberately `vscode`-free, like the rest of `src/app`: the runners are
 * injected, and cancellation goes through the structural token in `lmAgent.ts`
 * that `vscode.CancellationTokenSource` also satisfies.
 */
import type { AgentDescriptor } from './agents';
import type { ChangesetAgentMember } from './combinedAgent';
import type { AgentCancellationToken, AgentRunTimeouts } from './lmAgent';
import type { AgentRunProgress } from './agentTrace';
import type { ReviewContext } from './reviewContext';
import { ReviewRunStore } from './reviewRuns';
import {
  changesetDraftKeyFor,
  draftKeyFor,
  retainedFromRun,
  runKeyForChangeset,
  runKeyForCr,
} from './retainedReview';
import type { KeyValueStore } from './storage';
import { createReview } from '../domain/reviewState';
import type { AgentReviewResponse } from '../domain/agentResponse';
import type { Criteria } from '../domain/types';
import type { ChangeRequestDiff, ChangeRequestRef } from '../platform/types';

/**
 * Floor between two progress emissions, moved here from `RunLiveness` — four a
 * second already reads as continuous, and a dropped emission loses nothing
 * because the counters it would have carried are on the record.
 *
 * It throttles **progress only**. A state transition always emits at once: a
 * finish that landed within the window would otherwise be delayed or dropped,
 * and the screen watching that target would sit on a spinner after the run was
 * over.
 */
export const PROGRESS_EMIT_MS = 250;

/** A single change request, with everything the agent reads about it. */
export interface CrRunTarget {
  kind: 'cr';
  ref: ChangeRequestRef;
  diff: ChangeRequestDiff;
  reviewContext?: ReviewContext;
}

/** A changeset, reviewed as one distributed unit. */
export interface ChangesetRunTarget {
  kind: 'changeset';
  changesetId: string;
  members: readonly ChangesetAgentMember[];
}

export type RunTarget = CrRunTarget | ChangesetRunTarget;

/**
 * Everything a run needs, captured when it is triggered and never re-read.
 *
 * This is the whole of the attribution guarantee. `finishRun` used to call
 * `podStore.activePod` on the way out, so switching pods while a review ran
 * filed the result under whichever pod happened to be selected when it landed.
 * Nothing on the completion path below reaches for live state, so a pod switch,
 * a criteria edit or a different agent selection cannot reach a run already in
 * flight.
 */
export interface RunInput {
  target: RunTarget;
  /** `!2841`, or the changeset's name — what a notification and the run list say. */
  refLabel: string;
  podId: string;
  criteria: Criteria;
  agent: AgentDescriptor;
  /** Resolved here so the result can name its agent even after the agent file is gone. */
  agentLabel: string;
  /** Absent only for the demo agent, which calls no model. */
  modelId?: string;
  timeouts: AgentRunTimeouts;
  /** The log the running screen walks. The demo runner supplies its own instead. */
  steps: string[];
  /** The demo agent produces findings from the diff without calling a model. */
  demo: boolean;
}

/** What the run screen renders under its log while a request is in flight. */
export interface RunProgress {
  startedAt: number;
  fragmentsReceived: number;
  charsReceived: number;
}

/** The failure fields the run screen already renders. */
export interface RunFailure {
  message: string;
  requestId: string;
  code: string;
}

/**
 * `queued → running → (succeeded | failed | cancelled)`.
 *
 * `interrupted` is not here: it is not a transition anything can make, only
 * what the activation sweep concludes about a run that was `running` when the
 * extension host stopped. See `InFlightRunStore`.
 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRecord {
  key: string;
  input: RunInput;
  status: RunStatus;
  /** When it was triggered — queue order, and what the sidebar counts elapsed from. */
  queuedAt: number;
  /** When it actually started; absent while queued. */
  startedAt?: number;
  finishedAt?: number;
  /** The log being walked, and how far. */
  steps: string[];
  step: number;
  progress?: RunProgress;
  response?: AgentReviewResponse;
  failure?: RunFailure;
}

/** The demo agent's synchronous result, shaped as `demoAgent.ts` returns it. */
export interface DemoRunResult {
  response: AgentReviewResponse;
  steps: string[];
}

export interface RunnerOptions {
  timeouts: AgentRunTimeouts;
  onProgress: (progress: AgentRunProgress) => void;
  cancellation: AgentCancellationToken;
}

/**
 * The two ways a review is produced, injected so this module never imports the
 * transport and a test never needs a fake `vscode`.
 */
export interface ReviewRunners {
  /** Model-backed. Rejects with `AgentRunError`. */
  lm(input: RunInput, options: RunnerOptions): Promise<AgentReviewResponse>;
  /** Demo agent: no model, no network, its own step log. */
  demo(input: RunInput): DemoRunResult;
}

export interface ReviewReadyInfo {
  /** Absent for a changeset, which is not one change request. */
  ref?: ChangeRequestRef;
  refLabel: string;
  itemCount: number;
  /**
   * Which pod the run belonged to. The notification's open action resolves a
   * ref against the *active* pod, so a run that finished after a pod switch
   * must be able to say it is not about this one.
   */
  podId: string;
}

export interface ReviewRunManagerDeps {
  /** Retained review records live here, beside the drafts they grew out of. */
  workspaceState: KeyValueStore;
  /** `ReviewRunStore` and `InFlightRunStore`. */
  globalState: KeyValueStore;
  runners: ReviewRunners;
  onChange?: (record: RunRecord) => void;
  onReviewReady?: (info: ReviewReadyInfo) => void;
  /** Fired only after the store write resolves — see `finish` below. */
  onRunRecorded?: () => void;
  now?: () => number;
  /** Injected so the demo agent's step walk does not make a test wait for it. */
  delay?: (ms: number) => Promise<void>;
}

/** How long the demo agent's log pauses on each step. */
const DEMO_STEP_MS = 320;

/**
 * A cancellation source with no `vscode` in it. `streamText` takes the
 * structural token in `lmAgent.ts`, which this and `vscode.CancellationToken`
 * both satisfy, so the manager stays in `src/app` and its tests stay free of a
 * mocked editor.
 */
interface RunCancellation {
  readonly token: AgentCancellationToken;
  cancel(): void;
  dispose(): void;
}

function runCancellation(): RunCancellation {
  // Closed over locals rather than held on an instance: the token's
  // `isCancellationRequested` has to read the *current* flag, and a class would
  // need to alias `this` inside the getter to do it.
  let cancelled = false;
  let listeners: Array<() => void> = [];
  return {
    token: {
      get isCancellationRequested(): boolean {
        return cancelled;
      },
      onCancellationRequested(listener: () => void): { dispose(): void } {
        // An already-cancelled source fires immediately: a subscriber that
        // arrived late still has to learn it has nothing to wait for.
        if (cancelled) {
          listener();
          return { dispose: () => {} };
        }
        listeners.push(listener);
        return {
          dispose: () => {
            listeners = listeners.filter((l) => l !== listener);
          },
        };
      },
    },
    cancel(): void {
      if (cancelled) return;
      cancelled = true;
      for (const listener of [...listeners]) listener();
    },
    dispose(): void {
      listeners = [];
    },
  };
}

export function runKeyFor(target: RunTarget): string {
  return target.kind === 'cr' ? runKeyForCr(target.ref) : runKeyForChangeset(target.changesetId);
}

/** Where the retained review for a target is stored. */
export function recordKeyFor(target: RunTarget): string {
  return target.kind === 'cr' ? draftKeyFor(target.ref) : changesetDraftKeyFor(target.changesetId);
}

/**
 * How a changeset identifies itself to `ReviewRunStore` and `createReview`.
 * Not invented here: `changesetReview.ts` already builds its `Review` with
 * `repoId: 'changeset'` and the changeset id as the number, so a changeset run
 * records under a key no change-request row can ever match — which is what
 * keeps the dashboard's per-change-request pills honest while the changeset
 * screen and the interrupted sweep still have somewhere to read.
 */
export const CHANGESET_REPO_ID = 'changeset';

function reviewIdentityFor(target: RunTarget): { repoId: string; crNumber: string } {
  return target.kind === 'cr'
    ? { repoId: target.ref.repoId, crNumber: target.ref.number }
    : { repoId: CHANGESET_REPO_ID, crNumber: target.changesetId };
}

export class ReviewRunManager {
  private readonly records = new Map<string, RunRecord>();
  private readonly cancellations = new Map<string, RunCancellation>();
  /** Keys waiting for a slot, in trigger order. */
  private queue: string[] = [];
  private running = 0;
  /**
   * The limit the last trigger was made under. The queue pumps on a terminal
   * transition, where no caller is present to supply one; a lowered limit
   * therefore applies to what starts next and never cancels work in flight.
   */
  private limit = 0;
  private lastEmit = 0;
  private readonly listeners = new Set<(record: RunRecord) => void>();
  private readonly runs: ReviewRunStore;
  private readonly inFlight: InFlightRunStore;

  constructor(private readonly deps: ReviewRunManagerDeps) {
    this.runs = new ReviewRunStore(deps.globalState);
    this.inFlight = new InFlightRunStore(deps.globalState);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  subscribe(listener: (record: RunRecord) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** The record for a target, whatever state it is in. */
  get(key: string): RunRecord | undefined {
    return this.records.get(key);
  }

  /** Everything queued or running, in trigger order — the sidebar's list. */
  active(): RunRecord[] {
    return [...this.records.values()]
      .filter((record) => record.status === 'queued' || record.status === 'running')
      .sort((a, b) => a.queuedAt - b.queuedAt);
  }

  /** Keyed for the dashboard, which already looks its rows up this way. */
  activeByKey(): ReadonlyMap<string, RunRecord> {
    return new Map(this.active().map((record) => [record.key, record]));
  }

  /**
   * Start a review, or refuse because one is already in flight for this target.
   *
   * The refusal is the point: silently superseding would throw away a run the
   * reviewer is waiting on, and starting a second would spend twice for one
   * answer. The caller gets the existing record back and shows its progress.
   */
  trigger(input: RunInput, limit: number): RunRecord {
    this.limit = limit;
    const key = runKeyFor(input.target);
    const existing = this.records.get(key);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) return existing;

    const record: RunRecord = {
      key,
      input,
      status: 'queued',
      queuedAt: this.now(),
      steps: input.steps,
      step: 0,
    };
    this.records.set(key, record);
    this.queue.push(key);
    this.emit(record);
    this.pump();
    // `pump` may have started it synchronously, so return what the map holds
    // rather than the queued literal above.
    return this.records.get(key) ?? record;
  }

  /**
   * Stop a run. A queued one never reaches the transport at all; a running one
   * has its request cancelled, which is what makes the slot it frees usable
   * rather than merely accounted for.
   */
  cancel(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    if (record.status === 'queued') {
      this.queue = this.queue.filter((queued) => queued !== key);
      this.settle(record, { status: 'cancelled' });
      this.pump();
      return;
    }
    if (record.status !== 'running') return;
    // Two things, in this order, and both of them necessary.
    //
    // The token stops the request: that is what makes the tokens stop being
    // spent, and it is the half that was missing entirely before.
    this.cancellations.get(key)?.cancel();
    // The transition happens here rather than in the runner's catch, because
    // the slot must be free *now*. A provider that ignores its token would
    // otherwise hold the slot for as long as it kept streaming, which defeats
    // the queue; and the demo agent has no token at all, so its walk would
    // never stop. Whatever the runner does afterwards lands on a record that is
    // no longer running, and `isRunning` drops it.
    this.settle(record, { status: 'cancelled' });
  }

  /**
   * Every run belonging to a pod, stopped. Used when a pod is deleted — the
   * target it names is gone, so there is nowhere for the result to go.
   *
   * A pod *switch* deliberately does not come through here: a run triggered
   * under one pod finishes and records against that pod, which is what the
   * snapshot in `RunInput` is for.
   */
  cancelForPod(podId: string): void {
    for (const record of this.active()) {
      if (record.input.podId === podId) this.cancel(record.key);
    }
  }

  /**
   * Drop a terminal record once its screen has shown it. Only `failed` records
   * are held: a success already wrote the retained review the target opens on,
   * and a cancellation leaves the previous state exactly as it was.
   */
  acknowledge(key: string): void {
    const record = this.records.get(key);
    if (!record || record.status === 'queued' || record.status === 'running') return;
    this.records.delete(key);
  }

  /** The interrupted sweep — see `InFlightRunStore`. Run once, on activation. */
  async sweepInterrupted(): Promise<number> {
    return sweepInterruptedRuns(this.deps.globalState);
  }

  private pump(): void {
    while (this.queue.length > 0 && (this.limit <= 0 || this.running < this.limit)) {
      const key = this.queue.shift();
      if (key === undefined) return;
      const record = this.records.get(key);
      // A record cancelled while queued was already removed from the queue,
      // but a re-trigger could in principle re-add a key whose record moved on.
      if (!record || record.status !== 'queued') continue;
      this.start(record);
    }
  }

  private start(record: RunRecord): void {
    this.running += 1;
    const startedAt = this.now();
    const started: RunRecord = { ...record, status: 'running', startedAt, step: 0 };
    this.records.set(record.key, started);
    // Written before the request goes out, so a host that stops mid-run leaves
    // the evidence the sweep needs.
    void this.inFlight.add({
      key: record.key,
      podId: record.input.podId,
      refLabel: record.input.refLabel,
      ...reviewIdentityFor(record.input.target),
      startedAt: new Date(startedAt).toISOString(),
    });
    this.emit(started);
    void (record.input.demo ? this.executeDemo(record.key) : this.executeLm(record.key));
  }

  private async executeDemo(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    const result = this.deps.runners.demo(record.input);
    this.patch(key, { steps: result.steps });
    // The log is walked rather than skipped: the demo agent exists to show what
    // a review looks like, and a result that appears instantly shows nothing.
    // It walks in the manager now, so navigating away mid-walk no longer ends
    // it — the same promise every other run gets.
    for (let step = 0; step <= result.steps.length; step += 1) {
      if (!this.isRunning(key)) return;
      this.patch(key, { step });
      await (this.deps.delay?.(DEMO_STEP_MS) ?? new Promise((resolve) => setTimeout(resolve, DEMO_STEP_MS)));
    }
    if (!this.isRunning(key)) return;
    await this.finish(key, result.response);
  }

  private async executeLm(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    const cancellation = runCancellation();
    this.cancellations.set(key, cancellation);
    // The log parks on the last step before "ready" for the whole request; the
    // liveness counters under it are what say the run is alive, not hung.
    this.patch(key, {
      step: Math.max(0, record.steps.length - 3),
      progress: { startedAt: this.now(), fragmentsReceived: 0, charsReceived: 0 },
    });
    try {
      const response = await this.deps.runners.lm(record.input, {
        timeouts: record.input.timeouts,
        onProgress: (progress) => this.recordProgress(key, progress),
        cancellation: cancellation.token,
      });
      if (!this.isRunning(key)) return;
      await this.finish(key, response);
    } catch (error) {
      if (!this.isRunning(key)) return;
      const failure = asRunFailure(error, record.input.timeouts);
      if (failure === 'cancelled') {
        this.settle(this.records.get(key)!, { status: 'cancelled' });
        return;
      }
      this.settle(this.records.get(key)!, { status: 'failed', failure });
    }
  }

  private isRunning(key: string): boolean {
    return this.records.get(key)?.status === 'running';
  }

  private recordProgress(key: string, progress: AgentRunProgress): void {
    const record = this.records.get(key);
    if (!record || record.status !== 'running' || !record.progress) return;
    // `progress.elapsedMs` is deliberately dropped: it is the trace's clock,
    // and a reader measures against `startedAt` so one clock answers both.
    const next: RunRecord = {
      ...record,
      progress: {
        ...record.progress,
        fragmentsReceived: progress.fragmentsReceived,
        charsReceived: progress.charsReceived,
      },
    };
    this.records.set(key, next);
    const now = this.now();
    if (now - this.lastEmit < PROGRESS_EMIT_MS) return;
    this.lastEmit = now;
    this.notify(next);
  }

  /**
   * The completion path, run whether or not anything is watching.
   *
   * `onRunRecorded` fires only after the store write resolves: it fans out to
   * views that read this very store, and firing it first repaints them onto the
   * previous run.
   */
  private async finish(key: string, response: AgentReviewResponse): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    const { input } = record;
    const identity = reviewIdentityFor(input.target);
    const ranAt = new Date(this.now()).toISOString();

    const review = createReview({
      repoId: identity.repoId,
      crNumber: identity.crNumber,
      agentId: input.agent.id,
      modelId: input.modelId,
      criteria: input.criteria,
      response,
    });
    // A clean run is stored the same way as any other — a review with no items
    // — rather than as a deletion. That is the whole of the fix for a change
    // request that had been reviewed and cleared still reading "not run".
    const retained = retainedFromRun({
      review,
      ranAt,
      agentId: input.agent.id,
      agentLabel: input.agentLabel,
      modelId: input.modelId,
      candidates: response.candidates,
      filesRead: response.stats?.filesRead,
    });

    // The write comes FIRST, before anything is told the run succeeded.
    // `settle` notifies synchronously, and a panel watching this target reacts
    // by reading the record back off the store — the one-writer rule in D7. Told
    // first, it would read the *previous* run's review, or an empty screen, and
    // nothing would repaint when the write landed a microtask later.
    await this.deps.workspaceState.update(recordKeyFor(input.target), retained);
    // Cancelled while that write was in flight: the reviewer asked for this run
    // to stop, and `cancel` has already settled the record and freed its slot.
    // The retained review is written either way — the work was done and paid
    // for — but the run must not also report itself as succeeded.
    if (!this.isRunning(key)) return;
    this.settle(record, { status: 'succeeded', response });

    // Read-modify-write with no `await` between the pair, per the contract in
    // `storage.ts` — two runs can finish in the same tick.
    await this.runs.record({
      repoId: identity.repoId,
      crNumber: identity.crNumber,
      outcome: response.items.length === 0 ? 'clean' : 'findings',
      findingCount: response.items.length,
      agentLabel: input.agentLabel,
      ranAt,
    });
    this.deps.onRunRecorded?.();
    this.deps.onReviewReady?.({
      ref: input.target.kind === 'cr' ? input.target.ref : undefined,
      refLabel: input.refLabel,
      itemCount: response.items.length,
      podId: input.podId,
    });
  }

  /** The one place a run leaves the running set: releases its slot, then pumps. */
  private settle(
    record: RunRecord,
    outcome: { status: 'succeeded'; response: AgentReviewResponse }
      | { status: 'failed'; failure: RunFailure }
      | { status: 'cancelled' },
  ): void {
    const wasRunning = record.status === 'running';
    const settled: RunRecord = {
      ...record,
      status: outcome.status,
      finishedAt: this.now(),
      progress: undefined,
      response: outcome.status === 'succeeded' ? outcome.response : undefined,
      failure: outcome.status === 'failed' ? outcome.failure : undefined,
    };
    this.records.set(record.key, settled);
    this.cancellations.get(record.key)?.dispose();
    this.cancellations.delete(record.key);
    void this.inFlight.remove(record.key);
    if (wasRunning) this.running = Math.max(0, this.running - 1);
    // A succeeded or cancelled record has nothing left to tell a screen that
    // did not see it: the retained review, or the absence of a change, is the
    // whole message. Only a failure has to survive until someone reads it.
    if (outcome.status !== 'failed') {
      this.notify(settled);
      this.records.delete(record.key);
    } else {
      this.notify(settled);
    }
    this.pump();
  }

  private patch(key: string, patch: Partial<RunRecord>): void {
    const record = this.records.get(key);
    if (!record) return;
    const next = { ...record, ...patch };
    this.records.set(key, next);
    this.emit(next);
  }

  /** A state change: emitted at once, and it resets the progress throttle. */
  private emit(record: RunRecord): void {
    this.lastEmit = this.now();
    this.notify(record);
  }

  private notify(record: RunRecord): void {
    this.deps.onChange?.(record);
    for (const listener of [...this.listeners]) listener(record);
  }
}

/**
 * Classify a runner rejection. `cancelled` is not a failure to report — the
 * reviewer asked for it — so it is returned as its own thing rather than as an
 * error with a friendlier message.
 */
function asRunFailure(error: unknown, timeouts: AgentRunTimeouts): RunFailure | 'cancelled' {
  const err = error as { message?: unknown; requestId?: unknown; timedOut?: unknown; cancelled?: unknown; timeoutReason?: unknown };
  if (err?.cancelled === true) return 'cancelled';
  const timedOut = err?.timedOut === true;
  return {
    message: typeof err?.message === 'string' ? err.message : String(error),
    requestId: typeof err?.requestId === 'string' ? err.requestId : '------',
    // The window that actually ran out, not the shipped default — a reviewer
    // who lengthened it needs the code to name their number.
    code: timedOut
      ? `copilot.request.timeout · ${err.timeoutReason === 'ceiling' ? timeouts.ceilingMs : timeouts.inactivityMs}ms`
      : 'copilot.request.error',
  };
}

/**
 * What was running when the window closed.
 *
 * A `vscode.lm` stream cannot be reattached after the extension host stops —
 * there is no handle to reattach to — so a run in flight at that moment is
 * simply gone. The alternative to recording it is worse than the loss: the
 * change request would silently read whatever it read before, and a reviewer
 * who started a review, closed the editor and came back would have no way to
 * tell "nothing ran" from "something ran and was lost".
 */
export interface InFlightRun {
  key: string;
  podId: string;
  refLabel: string;
  repoId: string;
  crNumber: string;
  startedAt: string;
}

const IN_FLIGHT_KEY = 'codeVerdict.inFlightRuns';

export class InFlightRunStore {
  constructor(private readonly store: KeyValueStore) {}

  list(): InFlightRun[] {
    return [...(this.store.get<InFlightRun[]>(IN_FLIGHT_KEY) ?? [])];
  }

  /** Latest-wins per key, like `ReviewRunStore.record`. */
  async add(run: InFlightRun): Promise<void> {
    const all = this.list().filter((entry) => entry.key !== run.key);
    all.push(run);
    await this.store.update(IN_FLIGHT_KEY, all);
  }

  async remove(key: string): Promise<void> {
    const all = this.list().filter((entry) => entry.key !== key);
    await this.store.update(IN_FLIGHT_KEY, all);
  }

  async clear(): Promise<void> {
    await this.store.update(IN_FLIGHT_KEY, []);
  }
}

/**
 * Turn whatever survived the last session into recorded `interrupted` runs, and
 * clear the list. Nothing here touches the target's retained review: an
 * interruption is reported *alongside* the last completed review, never in
 * place of it.
 */
export async function sweepInterruptedRuns(globalState: KeyValueStore): Promise<number> {
  const inFlight = new InFlightRunStore(globalState);
  const leftover = inFlight.list();
  if (leftover.length === 0) return 0;
  const runs = new ReviewRunStore(globalState);
  for (const entry of leftover) {
    await runs.record({
      repoId: entry.repoId,
      crNumber: entry.crNumber,
      outcome: 'interrupted',
      findingCount: 0,
      agentLabel: '',
      ranAt: entry.startedAt,
    });
  }
  await inFlight.clear();
  return leftover.length;
}
