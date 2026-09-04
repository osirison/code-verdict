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
 *
 * ---
 *
 * **Task 12.1-12.4 of `add-agentic-review-harness` (design.md D1/D2/D12/D14).**
 * `ReviewRunners` is renamed `ReviewHarnessFactory`: its two members are no
 * longer read as "call this and get a finished review back" but as "run one
 * `HarnessAttempt` for this target" — the demo path is not a second runner
 * (task 10.7 already built a demo participant that drives the same harness);
 * the manager selects a model seam, not a runner. Both members keep their
 * exact `lm`/`demo` names and signatures — extension.ts (out of scope, task
 * 15.7) and this module's own characterization tests inject the pre-harness
 * `{lm, demo}` shape unchanged, which design.md's migration plan explicitly
 * sanctions ("tests may inject the old runner only as a fixture"). What
 * changes is what the manager *does* with one call: it now drives the record
 * through the full canonical lifecycle (`../domain/harnessLifecycle.ts`) via
 * one validated transition path (`isLegalRunTransition`/`transition`, 12.3)
 * instead of flipping a five-value `status` directly. `RunnerOptions` gains
 * two optional hooks, `onEnterWaiting`/`onResuming`, mirroring
 * `harnessRetry.ts`'s own `RetryHooks` — a harness-attempt-backed `lm`
 * (wired in a later task) reports a long backoff through them exactly as
 * `harnessAttempt.ts` already reports it to its own `onCheckpoint`; this
 * module is what actually releases and re-admits the concurrency slot that
 * `harnessRetry.ts`'s own header names as "section 12's job" (closing the
 * open half of task 9.6 — see `enterPausedState`/`beginResuming` below).
 *
 * Because this pass's `lm`/`demo` seam has no per-phase feedback of its own
 * (that is task 10.2/10.8, explicitly out of scope here), the manager drives
 * only the phases it can honestly report: `queued -> planning ->
 * investigating` before dispatch, then `investigating -> completing ->
 * succeeded/failed` on the way out (skipping `verifying`, which nothing
 * behind this seam performs — see `isLegalRunTransition`'s forward-skip
 * allowance). A real `HarnessAttempt`'s finer-grained phase reporting slots
 * into the same transition path without widening it.
 */
import { randomBytes } from 'node:crypto';
import type { AgentDescriptor } from './agents';
import type { AttachmentWarning } from './attachments';
import type { ChangesetAgentMember } from './combinedAgent';
import type { AgentCancellationToken, AgentRunTimeouts } from './lmAgent';
import type { AgentRunProgress } from './agentTrace';
import type { Attachment, ContextBudgets, ReviewContext } from './reviewContext';
import { ReviewRunStore } from './reviewRuns';
import {
  changesetDraftKeyFor,
  draftKeyFor,
  retainedFromRun,
  runKeyForChangeset,
  runKeyForCr,
} from './retainedReview';
import type { KeyValueStore } from './storage';
import type { PersistedCheckpoint } from './harnessCheckpoint';
import { createReview } from '../domain/reviewState';
import type { AgentReviewResponse } from '../domain/agentResponse';
import type { EffortLevel } from '../domain/effort';
import type { Limitation, RunPhase, RunProjection } from '../domain/harnessActivity';
import {
  isActiveLifecycle,
  isTerminalLifecycle,
  type AttemptNumber,
  type LineageId,
  type ResultCompleteness,
  type RunId,
  type RunLifecycle,
} from '../domain/harnessLifecycle';
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
  /** Cached evidence selected before the immutable run snapshot is created. */
  attachments?: readonly Attachment[];
  /** Host-assigned qualification for changed-file paths in a multi-root workspace. */
  workspaceRootLabel?: string;
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
  /** Prompt-level review effort captured with the model selection. */
  effort: EffortLevel;
  timeouts: AgentRunTimeouts;
  /** Normalized UI settings captured with the rest of the run input. */
  contextBudgets: ContextBudgets;
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
 * The five-value compatibility projection over `RunRecord.lifecycle`'s full
 * thirteen-value canonical union (`../domain/harnessLifecycle.ts`), for UI
 * code that has not migrated to the canonical lifecycle (task 14.x) — see
 * `legacyStatusFor` for the one place the mapping is defined.
 *
 * `interrupted` is not here: it is not a transition anything in this module
 * makes, only what the activation sweep concludes about a run that was
 * nonterminal when the extension host stopped. See `InFlightRunStore`.
 */
export type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface RunRecord {
  key: string;
  input: RunInput;
  /**
   * The canonical lifecycle (D2). `transition()` — the one validated path
   * task 12.3 asks for — is the only place this module ever writes it.
   */
  lifecycle: RunLifecycle;
  /** Derived from `lifecycle` via `legacyStatusFor`, never written independently. */
  status: RunStatus;
  /** Independent of `lifecycle` (D2): a run can fail with a partial result or succeed clean. */
  completeness: ResultCompleteness;
  /** The target-level invocation identity — distinct from `key`, which names the target itself. */
  runId: RunId;
  /** Stable across a checkpoint-based resume of this run; a fresh `trigger()` always starts a new lineage. */
  lineageId: LineageId;
  /** Monotonic within the lineage. Always `1` in this pass — resuming a *lost* attempt across restarts is task 12.7. */
  attempt: AttemptNumber;
  /**
   * What every surface renders from (D14) — `../domain/harnessActivity.ts`'s
   * own `RunProjection` type, populated from this record's own known fields
   * rather than reduced from a full activity log (this pass has none to
   * reduce; see the file header).
   */
  projection: RunProjection;
  /**
   * The active phase to return to on `resuming` (D2: "`waiting -> resuming ->
   * prior active phase`"). Set on entering `waiting`/`paused`, consumed and
   * cleared on `resuming`. Manager-internal bookkeeping, not itself a
   * `RunProjection` field.
   */
  resumeTo?: RunLifecycle;
  /** The public reason shown while waiting or paused, surfaced through `projection.currentAction` (mirrors `harnessActivityProjection.ts`'s own repurposing of that field). */
  waitReason?: string;
  /** The attempt's latest checkpoint, once a real harness attempt supplies one through a store (task 12.5+). Always absent from this pass's coarse `lm`/`demo` path. */
  checkpoint?: PersistedCheckpoint;
  /** Always `[]` from this pass's coarse path — no budget/coverage tracking behind `lm`/`demo` yet — but threaded through so a later attempt can report real ones. */
  limitations: readonly Limitation[];
  /** Findings validated before a run ended without reaching `complete` (D11). Always absent from this pass — no partial concept exists behind the coarse `lm`/`demo` seam; task 12.5/12.6 give it real content. */
  partialResult?: AgentReviewResponse;
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
  /** Filesystem-backed attachments dropped at run start. */
  attachmentWarnings?: readonly AttachmentWarning[];
}

/** The demo agent's synchronous result, shaped as `demoAgent.ts` returns it. */
export interface DemoRunResult {
  response: AgentReviewResponse;
  steps: string[];
  attachmentWarnings?: readonly AttachmentWarning[];
}

export interface RunnerOptions {
  timeouts: AgentRunTimeouts;
  onProgress: (progress: AgentRunProgress) => void;
  onAttachmentWarnings: (warnings: readonly AttachmentWarning[]) => void;
  cancellation: AgentCancellationToken;
  /**
   * Task 12.4/9.6: a harness-attempt-backed `lm` may call this when
   * `harnessRetry.ts` classifies a delay as long enough to enter `waiting`
   * (its own `RetryHooks.onEnterWaiting`) — the manager releases this run's
   * concurrency slot at once and keeps the record and its target ownership
   * intact. Optional so every `lm` that never enters a host-managed wait
   * (every implementation that exists today) keeps compiling unchanged.
   */
  onEnterWaiting?: (info?: { reason?: string }) => void;
  /** Mirrors `RetryHooks.onResuming`: fires once execution is about to continue after a wait this same seam reported through `onEnterWaiting`. */
  onResuming?: () => void;
}

/**
 * The two ways one harness attempt is run for an admitted target, injected so
 * this module never imports the transport and a test never needs a fake
 * `vscode` (D1: "Its injected `ReviewRunners` abstraction becomes an injected
 * `ReviewHarnessFactory`"). See the file header for what changed and what did
 * not.
 */
export interface ReviewHarnessFactory {
  /** Model-backed. Rejects with `AgentRunError`. */
  lm(input: RunInput, options: RunnerOptions): Promise<AgentReviewResponse>;
  /** The demo participant (task 10.7): no model, no network, its own step log. */
  demo(input: RunInput): DemoRunResult | Promise<DemoRunResult>;
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
  runners: ReviewHarnessFactory;
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

// ---- 12.3: the one validated lifecycle-transition path -----------------------------

/** Ordered so "a forward skip among active phases" (below) has something to compare ranks against. */
const ACTIVE_PHASE_ORDER: readonly RunLifecycle[] = ['planning', 'investigating', 'verifying', 'completing'];

/**
 * The legal-transition table (D2's lifecycle diagram, plus spec
 * `background-review-runs`'s "it transitions through cancelling to
 * cancelled" — applied uniformly, not only to an active phase, because that
 * scenario is stated generally). Built once at module load; every edge below
 * is a documented, deliberate reading of the diagram:
 *
 * - `queued -> planning` is the only way a run starts (never straight into a
 *   later phase — the diagram shows exactly one edge out of `queued`).
 * - A forward skip **among active phases** (e.g. `planning -> completing`) is
 *   legal, never a backward one: this pass's coarse `lm`/`demo` seam has no
 *   per-phase feedback of its own (file header) and drives only the phases it
 *   can honestly report, while a future finer-grained attempt can still visit
 *   every phase in order through the same table.
 * - `succeeded` is reachable only from `completing` — the diagram funnels
 *   success through the whole active chain, never from an earlier phase.
 * - `waiting`/`paused` are reachable from any active phase (D12's long
 *   backoff can fire from any phase that dispatches a tool, not only
 *   `investigating` — the diagram's single column under `investigating` is
 *   layout, not a constraint the prose states).
 * - `resuming` can land on any active phase because the "prior active phase"
 *   varies per attempt; `resumeStart` below always supplies the record's own
 *   recorded `resumeTo`, never an arbitrary caller-chosen target.
 * - Every nonterminal state has an edge to `cancelling`, and `cancelling`'s
 *   only edge is to `cancelled` — cancellation always crosses that observable
 *   state, from any source, per the spec scenario above.
 * - Every nonterminal state also has an edge to `interrupted`, for the
 *   activation sweep (task 12.7, not built by this pass) closing a lost
 *   attempt from *outside* live execution.
 * - `succeeded | failed | cancelled | interrupted` have no row at all: zero
 *   outgoing edges is the structural guarantee task 12.4 depends on — late
 *   model/provider work cannot move an attempt that already settled, because
 *   no entry above ever adds one.
 */
function buildLegalRunTransitions(): ReadonlyMap<RunLifecycle, ReadonlySet<RunLifecycle>> {
  const table = new Map<RunLifecycle, Set<RunLifecycle>>();
  const allow = (from: RunLifecycle, ...to: readonly RunLifecycle[]): void => {
    const set = table.get(from) ?? new Set<RunLifecycle>();
    for (const target of to) set.add(target);
    table.set(from, set);
  };

  allow('queued', 'planning', 'cancelling', 'interrupted');
  ACTIVE_PHASE_ORDER.forEach((from, index) => {
    const laterPhases = ACTIVE_PHASE_ORDER.slice(index + 1);
    allow(from, ...laterPhases, 'waiting', 'paused', 'cancelling', 'failed', 'interrupted');
  });
  allow('completing', 'succeeded');
  allow('waiting', 'resuming', 'cancelling', 'interrupted');
  allow('paused', 'resuming', 'cancelling', 'interrupted');
  allow('resuming', ...ACTIVE_PHASE_ORDER, 'cancelling', 'interrupted');
  allow('cancelling', 'cancelled');

  return table;
}

const LEGAL_RUN_TRANSITIONS = buildLegalRunTransitions();

/**
 * The one predicate every lifecycle change is validated against (task 12.3).
 * Exported so the full thirteen-value table can be characterized directly,
 * without simulating a whole run per edge.
 */
export function isLegalRunTransition(from: RunLifecycle, to: RunLifecycle): boolean {
  return LEGAL_RUN_TRANSITIONS.get(from)?.has(to) ?? false;
}

/**
 * The documented legacy mapping (12.2) — the *only* place a `RunLifecycle`
 * becomes a `RunStatus`, so it cannot drift between callers.
 *
 * | Canonical lifecycle                                              | Legacy `status` |
 * | ----------------------------------------------------------------- | ---------------- |
 * | `queued`                                                          | `queued`         |
 * | `planning`, `investigating`, `verifying`, `completing`            | `running`        |
 * | `waiting`, `paused`, `resuming`, `cancelling`                     | `running`        |
 * | `succeeded`                                                       | `succeeded`      |
 * | `failed`                                                          | `failed`         |
 * | `cancelled`                                                       | `cancelled`      |
 * | `interrupted`                                                     | `failed`         |
 *
 * The eight active/transient rows all read as "still in progress" to a
 * consumer that only distinguishes queued/running/terminal — exactly what
 * `RunLifecycle`'s own doc comment calls the `running` compatibility
 * projection. `interrupted` has no legacy analogue; `failed` is the nearest
 * honest one (no longer in flight, not a success) — never fabricated as
 * `succeeded` or silently left as `running`.
 */
export function legacyStatusFor(lifecycle: RunLifecycle): RunStatus {
  switch (lifecycle) {
    case 'queued':
      return 'queued';
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'interrupted':
      return 'failed';
    case 'planning':
    case 'investigating':
    case 'verifying':
    case 'completing':
    case 'waiting':
    case 'paused':
    case 'resuming':
    case 'cancelling':
      return 'running';
    default: {
      const exhaustive: never = lifecycle;
      throw new Error(`Unmapped run lifecycle: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function activePhaseFor(lifecycle: RunLifecycle): RunPhase | undefined {
  switch (lifecycle) {
    case 'planning':
      return 'planning';
    case 'investigating':
      return 'investigating';
    case 'verifying':
      return 'verifying';
    case 'completing':
      return 'completing';
    default:
      return undefined;
  }
}

function mintHarnessId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

export class ReviewRunManager {
  private readonly records = new Map<string, RunRecord>();
  private readonly cancellations = new Map<string, RunCancellation>();
  /** Keys waiting for a slot, in trigger order — both freshly queued and `resuming` keys re-entering FIFO. */
  private queue: string[] = [];
  private running = 0;
  /** Exactly the keys currently holding one of `running`'s slots — the single source of truth `settle`/`enterPausedState` release from, so a state that never held one (queued/waiting/paused) can never double-release (task 12.4). */
  private readonly slotHolders = new Set<string>();
  /**
   * Original admission order, for `beginResuming`'s "re-enter the queue at
   * its original position" (D12) — a monotonic counter, never `queuedAt`
   * (wall-clock milliseconds): two runs triggered within the same
   * millisecond would tie under a timestamp comparison, and `Array.sort`'s
   * stability would then leave whichever was already later in `this.queue`
   * (the just-triggered one) ahead of the one resuming, silently breaking
   * the exact fairness guarantee this exists to keep. Cleared once a record
   * reaches a terminal lifecycle (`settle`) — a sequence number is never
   * needed again after that.
   */
  private nextAdmissionSequence = 0;
  private readonly admissionSequence = new Map<string, number>();
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

  /** Everything not yet terminal, in trigger order — the sidebar's list. Includes `waiting`/`paused`/`resuming`/`cancelling`: one-active-run-per-target holds through all of them (D2). */
  active(): RunRecord[] {
    return [...this.records.values()]
      .filter((record) => !isTerminalLifecycle(record.lifecycle))
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
   * "In flight" is any nonterminal lifecycle, not only `queued`/`running`:
   * a `waiting` or `paused` attempt still owns its target (D2).
   */
  trigger(input: RunInput, limit: number): RunRecord {
    this.limit = limit;
    const key = runKeyFor(input.target);
    const existing = this.records.get(key);
    if (existing && !isTerminalLifecycle(existing.lifecycle)) return existing;

    const base: Omit<RunRecord, 'projection'> = {
      key,
      input,
      lifecycle: 'queued',
      status: 'queued',
      completeness: 'none',
      runId: mintHarnessId('run'),
      lineageId: mintHarnessId('lineage'),
      attempt: 1,
      limitations: [],
      queuedAt: this.now(),
      steps: input.steps,
      step: 0,
    };
    const record: RunRecord = { ...base, projection: this.buildProjection(base) };
    this.records.set(key, record);
    this.admissionSequence.set(key, this.nextAdmissionSequence++);
    this.queue.push(key);
    this.emit(record);
    this.pump();
    // `pump` may have started it synchronously, so return what the map holds
    // rather than the queued literal above.
    return this.records.get(key) ?? record;
  }

  /**
   * Stop a run. A queued one never reaches the transport at all; a running,
   * waiting, paused or resuming one always crosses the observable
   * `cancelling` state on the way to `cancelled` (spec
   * `background-review-runs`), and its cancellation token — if this key ever
   * held one — is triggered regardless of which of those states it is in,
   * because a `waiting` attempt's underlying call is still alive in the
   * background even though its slot has already been released.
   */
  cancel(key: string): void {
    const record = this.records.get(key);
    if (!record || isTerminalLifecycle(record.lifecycle)) return;
    if (record.lifecycle === 'queued' || record.lifecycle === 'resuming') {
      this.queue = this.queue.filter((queued) => queued !== key);
    }
    // The token stops the request: that is what makes the tokens stop being
    // spent. A no-op for a state that was never dispatched (queued) or whose
    // dispatch never got a token (a runner with no live call at all) —
    // `RunCancellation`'s own `cancel` is itself idempotent.
    this.cancellations.get(key)?.cancel();
    this.settle(record, { lifecycle: 'cancelled' });
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
   * Reviewer/policy-driven pause (task 14.6 wires the UI control onto this;
   * this pass closes the manager-side mechanics only). Legal only from a live
   * active phase — pausing something that has not started, or that is
   * already waiting/paused/terminal, is refused by `transition` as a no-op.
   */
  pause(key: string, reason?: string): void {
    this.enterPausedState(key, 'paused', reason);
  }

  /**
   * Reviewer-initiated resume from `paused` (task 14.6's UI control calls
   * this directly). Also handles `waiting`, though the production trigger for
   * that is the automatic `RunnerOptions.onResuming` hook, not this method.
   */
  resume(key: string): void {
    this.beginResuming(key);
  }

  /** Drop a terminal record once its screen has shown it. Only `failed` records
   * are held: a success already wrote the retained review the target opens on,
   * and a cancellation leaves the previous state exactly as it was. */
  acknowledge(key: string): void {
    const record = this.records.get(key);
    if (!record || !isTerminalLifecycle(record.lifecycle)) return;
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
      // A record cancelled while queued/resuming was already removed from the
      // queue, but a re-trigger could in principle re-add a key whose record
      // moved on.
      if (!record) continue;
      if (record.lifecycle === 'queued') {
        this.start(record);
      } else if (record.lifecycle === 'resuming') {
        this.resumeStart(record);
      }
    }
  }

  private start(record: RunRecord): void {
    this.running += 1;
    this.slotHolders.add(record.key);
    const startedAt = this.now();
    this.transition(record, 'planning', { startedAt, step: 0 });
    // Written before the request goes out, so a host that stops mid-run leaves
    // the evidence the sweep needs.
    void this.inFlight.add({
      key: record.key,
      podId: record.input.podId,
      refLabel: record.input.refLabel,
      ...reviewIdentityFor(record.input.target),
      startedAt: new Date(startedAt).toISOString(),
    });
    const planning = this.records.get(record.key) ?? record;
    // `investigating` is where this pass's coarse `lm`/`demo` seam actually
    // does its work (file header) — `planning` is real but instantaneous
    // here, never skipped, because `queued -> planning` is the table's only
    // entry edge.
    this.transition(planning, 'investigating');
    void (record.input.demo ? this.executeDemo(record.key) : this.executeLm(record.key));
  }

  /**
   * Re-admits a `resuming` record dequeued by `pump` — the other half of
   * closing task 9.6's open half: FIFO re-entry happened in `beginResuming`
   * (by original `queuedAt`, never appended at the tail), and this is where
   * the slot is actually re-acquired once it is this key's turn.
   *
   * No second dispatch happens here: this pass's coarse `lm`/`demo` seam has
   * no per-turn continuation to re-issue (file header) — the original
   * `executeLm`/`executeDemo` call for this key is still the one unresolved
   * promise, and its eventual resolution settles this record normally, now
   * that `isSettleable` sees an active lifecycle again. A real harness
   * attempt's own resume-from-checkpoint continuation is task 12.7's job.
   */
  private resumeStart(record: RunRecord): void {
    this.running += 1;
    this.slotHolders.add(record.key);
    const target = record.resumeTo ?? 'investigating';
    const applied = this.transition(record, target, { resumeTo: undefined });
    if (!applied) {
      // Should be unreachable — `resuming -> <any active phase>` is always
      // legal — but keep slot accounting honest rather than leak a slot.
      this.running = Math.max(0, this.running - 1);
      this.slotHolders.delete(record.key);
      return;
    }
    void this.inFlight.add({
      key: record.key,
      podId: record.input.podId,
      refLabel: record.input.refLabel,
      ...reviewIdentityFor(record.input.target),
      startedAt: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Task 12.4/9.6: releases the concurrency slot immediately (D12: "a long
   * backoff moves the run to `waiting`... and releases its global execution
   * slot") and keeps everything else about the record exactly as it is. Not
   * a completion: the `InFlightRunStore` marker is deliberately left alone —
   * a host that stops mid-wait must still be able to sweep this run as
   * interrupted, and slot release is not the same fact as "no longer in
   * flight".
   */
  private enterPausedState(key: string, target: 'waiting' | 'paused', reason?: string): void {
    const record = this.records.get(key);
    if (!record || !isActiveLifecycle(record.lifecycle)) return;
    const applied = this.transition(record, target, { resumeTo: record.lifecycle, waitReason: reason });
    if (!applied) return;
    if (this.slotHolders.delete(key)) this.running = Math.max(0, this.running - 1);
    this.pump();
  }

  /**
   * Re-enters the FIFO queue at its *original* admission position — sorting
   * the whole queue by `queuedAt` (which never changes across a resume) is
   * equivalent to a sorted insert, since every other entry's own `queuedAt`
   * is untouched (D12: "returns through `resuming` without losing target
   * ownership or queue fairness").
   */
  private beginResuming(key: string): void {
    const record = this.records.get(key);
    if (!record) return;
    if (record.lifecycle !== 'waiting' && record.lifecycle !== 'paused') return;
    const applied = this.transition(record, 'resuming');
    if (!applied) return;
    this.queue.push(key);
    this.queue.sort((a, b) => (this.admissionSequence.get(a) ?? 0) - (this.admissionSequence.get(b) ?? 0));
    this.pump();
  }

  private async executeDemo(key: string): Promise<void> {
    const record = this.records.get(key);
    if (!record) return;
    const result = await this.deps.runners.demo(record.input);
    if (!this.isSettleable(key)) return;
    this.patch(key, { steps: result.steps, attachmentWarnings: result.attachmentWarnings });
    // The log is walked rather than skipped: the demo agent exists to show what
    // a review looks like, and a result that appears instantly shows nothing.
    // It walks in the manager now, so navigating away mid-walk no longer ends
    // it — the same promise every other run gets.
    for (let step = 0; step <= result.steps.length; step += 1) {
      if (!this.isSettleable(key)) return;
      this.patch(key, { step });
      await (this.deps.delay?.(DEMO_STEP_MS) ?? new Promise((resolve) => setTimeout(resolve, DEMO_STEP_MS)));
    }
    if (!this.isSettleable(key)) return;
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
        onAttachmentWarnings: (warnings) => this.patch(key, { attachmentWarnings: warnings }),
        cancellation: cancellation.token,
        onEnterWaiting: (info) => this.enterPausedState(key, 'waiting', info?.reason),
        onResuming: () => this.beginResuming(key),
      });
      if (!this.isSettleable(key)) return;
      await this.finish(key, response);
    } catch (error) {
      if (!this.isSettleable(key)) return;
      const failure = asRunFailure(error, record.input.timeouts);
      if (failure === 'cancelled') {
        this.settle(this.records.get(key)!, { lifecycle: 'cancelled' });
        return;
      }
      this.settle(this.records.get(key)!, { lifecycle: 'failed', failure });
    }
  }

  /**
   * Whether a result arriving right now for this key still belongs to a live
   * attempt — the structural late-settlement guard task 12.4 asks for.
   * `false` once the record is gone (already settled and, for a
   * succeeded/cancelled run, deleted) or its lifecycle has left the four
   * active phases: `waiting`/`paused`/`resuming`/`cancelling` are all
   * legitimate nonterminal states, but none of them is a phase a stray
   * `lm`/`demo` resolution is allowed to conclude on directly — only
   * `resumeStart` re-entering an active phase makes one settleable again.
   */
  private isSettleable(key: string): boolean {
    const record = this.records.get(key);
    return !!record && isActiveLifecycle(record.lifecycle);
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
      effort: input.effort,
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
      attachmentWarnings: record.attachmentWarnings,
    });

    // The write comes FIRST, before anything is told the run succeeded.
    // `settle` notifies synchronously, and a panel watching this target reacts
    // by reading the record back off the store — the one-writer rule in D7. Told
    // first, it would read the *previous* run's review, or an empty screen, and
    // nothing would repaint when the write landed a microtask later.
    await this.deps.workspaceState.update(recordKeyFor(input.target), retained);
    // Cancelled (or otherwise moved off an active phase) while that write was
    // in flight: the reviewer asked for this run to stop, and `cancel` has
    // already settled the record and freed its slot. The retained review is
    // written either way — the work was done and paid for — but the run must
    // not also report itself as succeeded.
    if (!this.isSettleable(key)) return;
    this.settle(record, { lifecycle: 'succeeded', response });

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

  /**
   * The one place a run reaches a terminal lifecycle: releases its slot (if
   * it held one), then pumps. A cancellation always crosses the observable
   * `cancelling` state first (spec `background-review-runs`); a succeeded or
   * failed outcome transitions directly, since `completing -> succeeded` and
   * every active phase `-> failed` are both direct edges in the table.
   *
   * Routed entirely through `transition` (12.3): if the record is already
   * terminal, both transition attempts below are refused and this method
   * does nothing else — the structural guard 12.4 asks for, so a late
   * `lm`/`demo` resolution racing an earlier cancellation or failure can
   * never re-settle an already-settled record.
   */
  private settle(
    record: RunRecord,
    outcome:
      | { readonly lifecycle: 'succeeded'; readonly response: AgentReviewResponse }
      | { readonly lifecycle: 'failed'; readonly failure: RunFailure }
      | { readonly lifecycle: 'cancelled' },
  ): void {
    if (outcome.lifecycle === 'cancelled') {
      this.transition(record, 'cancelling');
    } else if (outcome.lifecycle === 'succeeded') {
      // `succeeded` is reachable only from `completing` (the table's own
      // funnel, mirroring D2's diagram) — this pass's coarse `lm`/`demo` seam
      // never visits `completing` on its own (file header: it stops advancing
      // once dispatched, at `investigating`), so `finish` crossing it here,
      // right before the terminal transition, is this pass's one place that
      // honestly closes the gap rather than skipping straight to `succeeded`.
      this.transition(record, 'completing');
    }
    const current = this.records.get(record.key) ?? record;

    const patch: Partial<RunRecord> = {
      finishedAt: this.now(),
      progress: undefined,
      response: outcome.lifecycle === 'succeeded' ? outcome.response : undefined,
      failure: outcome.lifecycle === 'failed' ? outcome.failure : undefined,
      // This pass's coarse `lm`/`demo` seam has no partial concept: a
      // successful result is always `complete`, and anything else is `none`
      // rather than a fabricated `partial` (task 12.5/12.6 give partial real
      // content).
      completeness: outcome.lifecycle === 'succeeded' ? 'complete' : 'none',
      resumeTo: undefined,
      waitReason: undefined,
    };
    const applied = this.transition(current, outcome.lifecycle, patch);
    if (!applied) return; // already terminal — a late settlement, structurally refused (12.4)

    if (this.slotHolders.delete(record.key)) this.running = Math.max(0, this.running - 1);
    this.cancellations.get(record.key)?.dispose();
    this.cancellations.delete(record.key);
    // Terminal: this key can never resume again, so its admission-order
    // bookkeeping is done.
    this.admissionSequence.delete(record.key);
    void this.inFlight.remove(record.key);
    // A succeeded or cancelled record has nothing left to tell a screen that
    // did not see it: the retained review, or the absence of a change, is the
    // whole message. Only a failure has to survive until someone reads it.
    if (outcome.lifecycle !== 'failed') this.records.delete(record.key);
    this.pump();
  }

  private patch(key: string, patch: Partial<RunRecord>): void {
    const record = this.records.get(key);
    if (!record) return;
    const next = { ...record, ...patch };
    next.projection = this.buildProjection(next);
    this.records.set(key, next);
    this.emit(next);
  }

  /**
   * The one validated lifecycle-transition path (task 12.3). Refuses
   * (returns `false`, no-op) rather than throwing: a caller racing a late
   * settlement against an already-terminal record checks the result rather
   * than needing a `try`/`catch` around every dispatch continuation.
   * `status`/`projection` are always rederived here, never passed in
   * `patch` — the one place either can drift is this one.
   */
  private transition(record: RunRecord, to: RunLifecycle, patch: Partial<RunRecord> = {}): boolean {
    if (!isLegalRunTransition(record.lifecycle, to)) return false;
    const next: RunRecord = { ...record, ...patch, lifecycle: to, status: legacyStatusFor(to) };
    next.projection = this.buildProjection(next);
    this.records.set(record.key, next);
    this.emit(next);
    return true;
  }

  /**
   * Builds this record's own `RunProjection` directly from its known fields
   * — not a second projection type (12.2 asks to reuse
   * `../domain/harnessActivity.ts`'s own shape, which this does), and not a
   * reduction over a full activity log, which this pass's coarse `lm`/`demo`
   * seam never produces (file header).
   */
  private buildProjection(record: Omit<RunRecord, 'projection'>): RunProjection {
    const elapsedMs = Math.max(0, this.now() - (record.startedAt ?? record.queuedAt));
    // While waiting/paused/resuming, the phase shown is the one being
    // returned to (`resumeTo`), matching `harnessActivityProjection.ts`'s own
    // reducer: a `waiting`/`paused` activity event is tagged with the phase
    // it interrupted, not a phase of its own (`RunPhase` has none).
    const phaseSource =
      record.lifecycle === 'waiting' || record.lifecycle === 'paused' || record.lifecycle === 'resuming'
        ? record.resumeTo
        : record.lifecycle;
    const isTerminal = isTerminalLifecycle(record.lifecycle);
    return {
      runId: record.runId,
      lineageId: record.lineageId,
      attempt: record.attempt,
      lifecycle: record.lifecycle,
      completeness: record.completeness,
      phase: phaseSource ? activePhaseFor(phaseSource) : undefined,
      currentAction: record.lifecycle === 'waiting' || record.lifecycle === 'paused' ? record.waitReason : undefined,
      elapsedMs,
      // No real coverage denominator exists behind this pass's coarse
      // `lm`/`demo` seam (file header) — `indeterminate` is the honest
      // choice per `review-run-activity`'s truthful-progress rule, never a
      // fabricated determinate count.
      progressMode: 'indeterminate',
      attention: record.lifecycle === 'paused' ? 'attentionRequired' : 'none',
      limitations: record.limitations,
      result: isTerminal
        ? { completeness: record.completeness, limitations: record.limitations, findingCount: record.response?.items.length }
        : undefined,
    };
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
