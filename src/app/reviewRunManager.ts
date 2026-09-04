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
 * The injected `ReviewRunners` abstraction is replaced, not renamed: the
 * shipped `ReviewHarnessFactory` produces a `HarnessAttempt`
 * (`create`/`createDemo` — two *model-seam* selections, never a second
 * runner) that the manager itself drives to a finish, rather than a function
 * that hands back an already-finished review. `executeAttempt` is the one
 * driver: it awaits `HarnessAttempt.run()`, and every intermediate
 * `onCheckpoint` call (`HarnessAttemptRunOptions`, mirroring
 * `harnessAttempt.ts`'s own `OnCheckpoint`) is what actually advances the
 * record through `planning -> investigating -> verifying -> completing`
 * (`applyCheckpoint`) and fills `RunRecord.checkpoint`/`.projection` from
 * what the attempt reports — never a manager-side guess. `onEnterWaiting`/
 * `onResuming` mirror `harnessRetry.ts`'s own `RetryHooks`, closing the open
 * half of task 9.6: this module releases and re-admits the concurrency slot
 * a real attempt's long backoff reports through them
 * (`enterPausedState`/`beginResuming`).
 *
 * `ReviewRunnersLegacy` (the old `lm`/`demo` shape) is accepted only as a
 * `@deprecated` compatibility path — normalized into a real
 * `ReviewHarnessFactory` by `legacyRunnersToHarnessFactory` in the
 * constructor, which is the *one* place this module still knows that shape
 * exists. `extension.ts` (out of scope, task 15.7) still constructs it today;
 * this module's own execution path (`executeAttempt`/`completeAttempt`)
 * never branches on it — it only ever drives an opaque `HarnessAttempt` and
 * reads back an opaque `HarnessAttemptResult`. See
 * `legacyRunnersToHarnessFactory`'s own doc comment for exactly what is and
 * is not preserved through that adapter.
 *
 * **A real attempt cannot actually be paused while `waiting`.**
 * `reviewRunManagerHarnessIntegration.test.ts` drives a genuine
 * `createHarnessAttempt` through a forced long backoff and found two
 * consequences, both now load-bearing here: (1) `harnessToolDispatcher.ts`'s
 * "wait" classification never suspends the attempt — it reports one tool
 * call unavailable and the attempt's own turn loop presses on regardless —
 * so the same one live `HarnessAttempt.run()` promise is still the
 * authoritative result whenever it resolves, `waiting` or not; `isSettleable`
 * therefore treats `waiting`/`paused`/`resuming` as settleable, and `settle`
 * performs the "resuming -> prior active phase" hop itself when it finds one
 * of those three, rather than requiring an external `resume()` first. (2) a
 * later pass closed task 9.6's remaining gap: `harnessAttempt.ts`'s
 * `dispatchAndTrack` now marks the model's re-dispatch of a logical operation
 * that previously entered `waiting` with `DispatchControl.resumedAfterWait:
 * true`, so `onResuming` now also fires automatically, from a real attempt's
 * own retry loop, not only via the reviewer-initiated `resume()` path (task
 * 14.6's future UI control) this module still separately supports; see
 * `harnessAttempt.ts`'s own file header and `harnessAttempt.test.ts`'s "9.6"
 * test for the production trigger and its end-to-end proof. Either way, the
 * one live `HarnessAttempt.run()` promise remains this module's sole source
 * of truth for when the attempt actually finishes — (1) above still holds.
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
  changesetPartialDraftKeyFor,
  draftKeyFor,
  partialDraftKeyFor,
  retainedFromRun,
  runKeyForChangeset,
  runKeyForCr,
} from './retainedReview';
import type { KeyValueStore } from './storage';
import type { CheckpointInfo, HarnessAttempt, HarnessAttemptResult } from './harnessAttempt';
import { reduceActivity } from './harnessActivityProjection';
import type { CompletionOutcome } from './harnessCompletion';
import type { ValidatedFinding } from './harnessCandidateValidation';
import { createHarnessRunStore, type HarnessRunStore } from './harnessRunStore';
import { checkCheckpointIntegrity, closeAttemptAsInterrupted } from './harnessResume';
import { createReview } from '../domain/reviewState';
import type { AgentReviewResponse } from '../domain/agentResponse';
import type { EffortLevel } from '../domain/effort';
import type { Limitation, RunProjection } from '../domain/harnessActivity';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import {
  isActiveLifecycle,
  isTerminalLifecycle,
  type AttemptNumber,
  type LineageId,
  type ResultCompleteness,
  type RunId,
  type RunLifecycle,
} from '../domain/harnessLifecycle';
import type { Criteria, ReviewItem } from '../domain/types';
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
  /** Independent of `lifecycle` (D2): a run can fail with a partial result or succeed clean. Taken from the attempt's own `CompletionOutcome` (`completeAttempt`), not inferred from resolve/reject. */
  completeness: ResultCompleteness;
  /** The target-level invocation identity — distinct from `key`, which names the target itself. */
  runId: RunId;
  /** Stable across a checkpoint-based resume of this run; a fresh `trigger()` always starts a new lineage. */
  lineageId: LineageId;
  /** Monotonic within the lineage. Always `1` in this pass — resuming a *lost* attempt across restarts is task 12.7. */
  attempt: AttemptNumber;
  /**
   * What every surface renders from (D14) — `../domain/harnessActivity.ts`'s
   * own `RunProjection` type. Refreshed from `reduceActivity` over the
   * attempt's own reported activity log whenever a checkpoint arrives
   * (`applyCheckpoint`); a manager-only fallback (`buildProjection`) covers
   * states the attempt itself never reports (`queued`, `cancelling`,
   * terminal settlement, `waiting`/`paused`/`resuming`).
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
  /**
   * The attempt's latest reported checkpoint (`harnessAttempt.ts`'s own
   * `CheckpointInfo` — "what a checkpoint collaborator receives", verbatim,
   * never upgraded into a store-ready `PersistedCheckpoint`: that needs a
   * `snapshotDigest` from a real `ReviewRunSnapshot`, which no code path
   * feeding this manager builds yet — `HarnessRunStore` wiring is task
   * 12.5+'s job, once one does). Absent for a `ReviewRunnersLegacy`-adapted
   * run, which reports no checkpoints at all.
   */
  checkpoint?: CheckpointInfo;
  /** From the attempt's own `CompletionOutcome.limitations` (`completeAttempt`); `[]` for a legacy-adapted run, which has none to report. */
  limitations: readonly Limitation[];
  /** Findings the attempt validated before ending without reaching `complete` (D11) — from `HarnessAttemptResult.findings` when `outcome.completeness !== 'complete'`. Always absent for a legacy-adapted run (`ReviewRunnersLegacy` has no partial concept). Held only in memory; task 12.5/12.6 make it durably, separately reachable. */
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

/**
 * The pre-harness runner's reporting surface: timeouts, progress, attachment
 * warnings, cancellation. Deliberately narrow and unchanged so
 * `extension.ts` (out of scope, task 15.7) keeps compiling and behaving
 * exactly as it does today against `ReviewRunnersLegacy.lm`.
 *
 * @deprecated Only `ReviewRunnersLegacy` still uses this narrow shape.
 * `HarnessAttemptRunOptions` (below) is what a real `ReviewHarnessFactory`
 * receives.
 */
export interface RunnerOptions {
  timeouts: AgentRunTimeouts;
  onProgress: (progress: AgentRunProgress) => void;
  onAttachmentWarnings: (warnings: readonly AttachmentWarning[]) => void;
  cancellation: AgentCancellationToken;
}

/**
 * The pre-harness runner shape: `lm`/`demo` each hand back an already-finished
 * result directly, rather than a `HarnessAttempt` the manager drives.
 *
 * @deprecated Temporary compatibility only. `extension.ts` still constructs
 * this shape (task 15.7 replaces it with a real `ReviewHarnessFactory`); this
 * module's own tests use it only as the fixture design.md's migration plan
 * sanctions ("tests may inject the old runner only as a fixture; no shipped
 * runtime setting exposes a bypass"). Normalized into a real
 * `ReviewHarnessFactory` by `legacyRunnersToHarnessFactory` in the
 * constructor — `ReviewRunManager`'s execution path never sees this shape
 * itself, only what that adapter produces from it.
 */
export interface ReviewRunnersLegacy {
  /** Model-backed. Rejects with `AgentRunError`. */
  lm(input: RunInput, options: RunnerOptions): Promise<AgentReviewResponse>;
  /** The demo participant: no model, no network, its own step log. */
  demo(input: RunInput): DemoRunResult | Promise<DemoRunResult>;
}

/**
 * What the manager gives a `HarnessAttempt` factory to report back through
 * (task 12.1, design.md D1): the same reporting surface `RunnerOptions`
 * already had, plus the checkpoint/waiting/resuming hooks
 * `harnessAttempt.ts`'s own `HarnessAttemptOptions.onCheckpoint` /
 * `.retry.onEnterWaiting` / `.retry.onResuming` already know how to call. A
 * real factory implementation (`extension.ts`, task 15.7) wires these
 * straight into `createHarnessAttempt`'s own options when it builds the
 * attempt; `ReviewRunManager` never reaches inside the attempt itself for
 * them — it only ever receives what the attempt chooses to report through
 * here, and through the settled `HarnessAttemptResult`.
 */
export interface HarnessAttemptRunOptions extends RunnerOptions {
  /**
   * The record's own harness identity (task 15.7 gap closure): `trigger()`
   * mints `runId`/`lineageId` into `RunRecord` before any factory ever runs,
   * but neither `RunInput` nor the rest of this options bag carried them
   * through — so a real factory building a `ReviewRunSnapshot`
   * (`buildReviewRunSnapshot`) had no way to give it the *same* identity the
   * manager already stores in `InFlightRun`/uses for `sweepInterrupted`'s
   * `harnessRunStore.latestCheckpoint(lineageId)` lookup. Without this, a
   * checkpoint written under a factory-invented id would be unreachable by
   * the activation sweep and by resume compatibility — dead on arrival.
   */
  identity: { readonly runId: RunId; readonly lineageId: LineageId; readonly attempt: AttemptNumber };
  /**
   * Fires at every phase boundary and tool-call-cadence checkpoint the
   * attempt reaches (`harnessAttempt.ts`'s own `fireCheckpoint`) — this is
   * what actually drives `planning`/`investigating`/`verifying`/`completing`
   * through the manager's one validated transition path, and what fills
   * `RunRecord.checkpoint`/`.projection` from what the attempt reports
   * rather than a manager-side guess. See `applyCheckpoint`.
   */
  onCheckpoint: (info: CheckpointInfo) => void;
  /**
   * Task 12.4/9.6: a real attempt's dispatcher reports this (via
   * `harnessRetry.ts`'s own `RetryHooks.onEnterWaiting`, threaded through
   * `HarnessAttemptOptions.retry`) when a long backoff means the manager
   * should release this run's concurrency slot at once, keeping the record
   * and its target ownership intact. Optional so an attempt that never
   * enters a host-managed wait needs nothing extra.
   */
  onEnterWaiting?: (info?: { reason?: string }) => void;
  /** Mirrors `RetryHooks.onResuming`: fires once execution is about to continue after a wait this same seam reported through `onEnterWaiting`. */
  onResuming?: () => void;
}

/**
 * Builds one `HarnessAttempt` for an admitted run (D1: "each admitted run
 * creates a `HarnessAttempt`"). `create`/`createDemo` are two *model-seam*
 * selections into the identical manager-side driving path
 * (`executeAttempt`) — the demo participant (task 10.7) is not a second
 * runner; it drives the same harness with a deterministic model seam instead
 * of a real one.
 */
export interface ReviewHarnessFactory {
  /** Builds one model-backed `HarnessAttempt` for this admitted run. */
  create(input: RunInput, options: HarnessAttemptRunOptions): HarnessAttempt;
  /** Builds the deterministic demo participant's attempt (task 10.7). */
  createDemo(input: RunInput, options: HarnessAttemptRunOptions): HarnessAttempt;
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
  /**
   * Task 14.7 (spec `review-run-activity`: "the notification distinguishes
   * complete, partial, failed, and cancelled outcomes"): `onReviewReady`
   * only ever fires for a `succeeded` lifecycle (D2: succeeded may still be
   * `partial` — an attempt that validated findings but did not satisfy
   * every completion condition), so this is the one thing a "review ready"
   * toast still has to get right — never say "ready" for a result that is
   * not actually done.
   */
  completeness: ResultCompleteness;
}

/**
 * Task 14.7: the terminal outcomes `onReviewReady` does not cover — a
 * `succeeded` result always fires `onReviewReady` instead (see that
 * interface's own doc comment), so this never duplicates it. Fired from the
 * one settlement funnel (`settle`), so every `failed`/`cancelled` path —
 * a cooperative attempt result, the cancel grace timeout, a genuine crash,
 * or cancelling a run that never dispatched — notifies exactly once,
 * whether or not any Verdict screen is open (spec `background-review-runs`:
 * "A run completes whether or not anyone is watching").
 */
export interface RunOutcomeInfo {
  lifecycle: 'failed' | 'cancelled';
  completeness: ResultCompleteness;
  refLabel: string;
  ref?: ChangeRequestRef;
  podId: string;
  /** Validated findings kept as an explicit partial (D11) — `undefined` when none were. */
  findingCount?: number;
}

export interface ReviewRunManagerDeps {
  /** Retained review records live here, beside the drafts they grew out of. */
  workspaceState: KeyValueStore;
  /** `ReviewRunStore` and `InFlightRunStore`. */
  globalState: KeyValueStore;
  /**
   * `ReviewHarnessFactory` is the shipped shape (D1). `ReviewRunnersLegacy` is
   * accepted only as the temporary compatibility path `extension.ts` (out of
   * scope, task 15.7) and this module's pre-migration test fixtures still
   * supply — normalized into a real factory by
   * `legacyRunnersToHarnessFactory` in the constructor. Everything below the
   * constructor drives a `ReviewHarnessFactory`; nothing branches on which
   * one was actually injected.
   */
  runners: ReviewHarnessFactory | ReviewRunnersLegacy;
  onChange?: (record: RunRecord) => void;
  onReviewReady?: (info: ReviewReadyInfo) => void;
  /** Task 14.7: the `failed`/`cancelled` counterpart to `onReviewReady` — see `RunOutcomeInfo`'s own doc comment. */
  onRunOutcome?: (info: RunOutcomeInfo) => void;
  /** Fired only after the store write resolves — see `completeAttempt` below. */
  onRunRecorded?: () => void;
  now?: () => number;
  /** Injected so a legacy-adapted demo walk's step pauses do not make a test wait for them. */
  delay?: (ms: number) => Promise<void>;
  /**
   * How long `cancel()` waits, once cancellation has reached a dispatched
   * attempt, for that attempt's own cancelled result to settle the record
   * before this module gives up on it and settles with none itself (see
   * `armCancelGrace`). Defaults to a real production-sized window — a test
   * that means to exercise the fallback overrides `cancelGrace` below with a
   * deterministic stand-in rather than actually waiting out this many
   * milliseconds.
   */
  cancelGraceMs?: number;
  /**
   * The sleep `armCancelGrace` waits on, deliberately its own injection
   * point rather than a reuse of `delay` above: `delay` paces the
   * legacy-adapted demo walk, and every test's default resolves it at once
   * (so a step-by-step walk does not make a test actually wait) — sharing
   * that default here would let the grace timer race ahead of, and discard,
   * the very findings this exists to keep, on every single cancellation in
   * every test that has no interest in the timeout at all. Defaults to a
   * real `setTimeout`.
   */
  cancelGrace?: (ms: number) => Promise<void>;
}

/** How long a legacy-adapted demo walk pauses on each step (see `legacyRunnersToHarnessFactory`). */
const DEMO_STEP_MS = 320;

/**
 * `cancel()`'s own bounded wait — see `ReviewRunManagerDeps.cancelGraceMs`.
 * Long enough that a cooperative attempt's own settlement (which always
 * reaches the record first when the attempt actually answers — see
 * `armCancelGrace`) has every realistic chance to arrive before this does;
 * short enough that an attempt which truly never answers does not strand the
 * record in `cancelling` for the rest of the session.
 */
const DEFAULT_CANCEL_GRACE_MS = 30_000;

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
 * Where a target's *partial* result is stored (task 12.5) — always a
 * separate key from `recordKeyFor`, so a partial can never be mistaken for,
 * or silently merge into, the target's retained complete review.
 */
export function partialRecordKeyFor(target: RunTarget): string {
  return target.kind === 'cr' ? partialDraftKeyFor(target.ref) : changesetPartialDraftKeyFor(target.changesetId);
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

/**
 * The `AgentReviewResponse.headSha` a retained review is filed under. For a
 * changeset, mirrors `combinedAgent.ts`'s own (private) composite format —
 * `repoId!number:headSha` per member, joined by `|` — so
 * `parseChangesetHeadSha` (already used elsewhere to read a changeset's
 * composite head back apart) still parses what this module writes. Not
 * imported from there because the builder itself is not exported; this is
 * one line of that same format, not a second implementation of it.
 */
function headShaFor(target: RunTarget): string {
  if (target.kind === 'cr') return target.diff.headSha;
  return target.members.map((member) => `${member.ref.repoId}!${member.ref.number}:${member.diff.headSha}`).join('|');
}

// ---- 12.1: the pre-harness runner shape, accepted only as a temporary fixture -------

/**
 * Wraps the pre-harness `{lm, demo}` shape as a `ReviewHarnessFactory` (D1) —
 * the one place this module still knows `ReviewRunnersLegacy` exists.
 *
 * **What is preserved exactly.** A legacy `lm` rejection (a network/model
 * error, or the cancellation-token convention `asRunFailure` already
 * classifies) is rethrown as-is, never converted into a resolved
 * `HarnessAttemptResult` — so `executeAttempt`'s existing catch-block
 * failure/cancellation handling, and every characterization test built
 * against it, sees exactly what it did before this pass. A successful `lm`
 * call, and a demo walk that reaches its end uncancelled, become a
 * `HarnessAttemptResult` with `lifecycle: 'succeeded'`,
 * `outcome.completeness: 'complete'`, `outcome.replacesRetainedReview: true`
 * — the same "the whole thing worked" shape the pre-harness manager assumed
 * for any resolved promise.
 *
 * **What is deliberately not preserved.** There is no bridge from a resolved
 * `AgentReviewResponse` to `ValidatedFinding`'s richer provenance/evidence
 * fields — `findingsFrom` below fills only `.item` (the one field
 * `completeAttempt` ever reads) and type-erases the rest, since fabricating
 * plausible-looking evidence citations for findings that were never actually
 * validated against cited sources would be worse than admitting there is
 * none. `response.candidates` (the below-criteria bucket) has no channel
 * through `HarnessAttemptResult` in *either* direction, harness-backed or
 * legacy-adapted; see `completeAttempt`'s own note. A checkpoint is never
 * reported (`onCheckpoint` is simply never called) — `RunRecord.checkpoint`
 * stays absent for a legacy-adapted run, honestly, rather than a synthesized
 * one.
 *
 * **The demo step walk.** `RunRecord.step`/`.steps` used to be updated live,
 * once a step, by the manager's own loop. There is no
 * `HarnessAttemptRunOptions` hook for a bare step index (a checkpoint reports
 * a *phase*, not a step) — moving that loop here, unable to reach the
 * manager's private `patch`, means it can no longer animate `record.step`
 * live. It still exists to preserve the two behaviors that *are*
 * characterized: the walk takes real time (`clocks.delay`, so a screen
 * watching a long review does not see it resolve instantly) and a
 * cancellation mid-walk stops it before the retained review is ever written.
 * `extension.ts`'s own demo agent therefore temporarily loses its live step
 * counter until task 15.7 migrates it to a real harness factory (whose demo
 * participant, task 10.7, reports real checkpoints instead) — a known,
 * documented gap, not a silently absorbed one.
 */
function legacyRunnersToHarnessFactory(
  legacy: ReviewRunnersLegacy,
  clocks: { readonly delay: (ms: number) => Promise<void> },
): ReviewHarnessFactory {
  function findingsFrom(items: readonly ReviewItem[]): readonly ValidatedFinding[] {
    // Only `.item` is ever read back out (`completeAttempt`); every other
    // `ValidatedFinding` field describes real citation provenance this
    // adapter has none of. See the file header above.
    return items.map((item) => ({ item }) as unknown as ValidatedFinding);
  }

  function outcomeFrom(response: AgentReviewResponse): CompletionOutcome {
    const count = response.items.length;
    return {
      kind: count > 0 ? 'completeFindings' : 'completeClean',
      completeness: 'complete',
      findingCount: count,
      limitations: [],
      replacesRetainedReview: true,
      clean: count === 0,
    };
  }

  function resultFrom(input: RunInput, response: AgentReviewResponse): HarnessAttemptResult {
    return {
      runId: input.refLabel,
      lineageId: input.refLabel,
      attempt: 1,
      lifecycle: 'succeeded',
      outcome: outcomeFrom(response),
      findings: findingsFrom(response.items),
      activityLog: { runId: input.refLabel, lineageId: input.refLabel, attempt: 1, events: [] },
      cancelled: false,
      small: true,
      turnsUsed: 0,
      toolCallsUsed: 0,
      contradicted: [],
    };
  }

  function cancelledError(): unknown {
    return Object.assign(new Error('run cancelled'), { cancelled: true, requestId: 'demo' });
  }

  return {
    create(input, options) {
      return {
        run: () => legacy.lm(input, options).then((response) => resultFrom(input, response)),
      };
    },
    createDemo(input, options) {
      return {
        async run(): Promise<HarnessAttemptResult> {
          const result = await legacy.demo(input);
          options.onAttachmentWarnings(result.attachmentWarnings ?? []);
          // The walk is real (the demo agent exists to show what a review
          // looks like; a result that appears instantly shows nothing) and
          // stoppable (checked between every step) — it can no longer
          // animate `record.step` live; see the file header.
          for (let step = 0; step <= result.steps.length; step += 1) {
            if (options.cancellation.isCancellationRequested) throw cancelledError();
            await clocks.delay(DEMO_STEP_MS);
          }
          if (options.cancellation.isCancellationRequested) throw cancelledError();
          return resultFrom(input, result.response);
        },
      };
    },
  };
}

function isLegacyRunners(runners: ReviewHarnessFactory | ReviewRunnersLegacy): runners is ReviewRunnersLegacy {
  return typeof (runners as Partial<ReviewRunnersLegacy>).lm === 'function';
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
 *   legal, never a backward one: a real attempt reports whichever phases it
 *   actually visits through `onCheckpoint` (`applyCheckpoint`), and a
 *   legacy-adapted run (file header) reports none until its terminal
 *   settlement crosses straight to `completing`.
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

function mintHarnessId(prefix: string): string {
  return `${prefix}_${randomBytes(16).toString('hex')}`;
}

/** The `RunLifecycle` -> `RunPhase` collapse `harnessActivityProjection.ts` uses internally (not exported there) — needed here only for `buildProjection`'s manager-authored fallback below, which has no activity log to reduce. */
function activePhaseFor(lifecycle: RunLifecycle): RunProjection['phase'] {
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
  /**
   * Task 12.7: the same bounded store `HarnessRunStore` (task 11.1) already
   * defines, built here exactly as `ReviewRunStore`/`InFlightRunStore` above
   * are — self-contained, no `extension.ts` change needed. Nothing on the
   * live execution path writes to it yet: durable checkpoint persistence
   * needs a real `ReviewRunSnapshot` per run (`RunRecord.checkpoint`'s own
   * doc comment — "once one does"), which is the section 15 runtime cutover,
   * not this pass. It exists here so the activation sweep
   * (`sweepInterrupted`) can honestly consult whatever a later pass writes,
   * without a second store construction path to keep in sync — see
   * `sweepInterruptedRuns`'s own doc comment for exactly what it does with
   * an empty store today.
   */
  private readonly harnessRunStore: HarnessRunStore;
  /** Always a real `ReviewHarnessFactory` by the time the constructor returns — `deps.runners`'s legacy shape, if that is what was injected, is normalized once here (see `legacyRunnersToHarnessFactory`). Nothing past this point branches on which one was supplied. */
  private readonly harnessFactory: ReviewHarnessFactory;
  /** Resolved once here from `deps.cancelGrace` — see `armCancelGrace`. */
  private readonly cancelGrace: (ms: number) => Promise<void>;

  constructor(private readonly deps: ReviewRunManagerDeps) {
    this.runs = new ReviewRunStore(deps.globalState);
    this.inFlight = new InFlightRunStore(deps.globalState);
    this.harnessRunStore = createHarnessRunStore(deps.globalState, { now: () => this.now() });
    this.harnessFactory = isLegacyRunners(deps.runners)
      ? legacyRunnersToHarnessFactory(deps.runners, {
          delay: (ms) => this.deps.delay?.(ms) ?? new Promise((resolve) => setTimeout(resolve, ms)),
        })
      : deps.runners;
    this.cancelGrace = deps.cancelGrace ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
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
   * Stop a run. A queued one never reached the transport at all — nothing
   * will ever report back for it, so it settles as `cancelled` at once, the
   * same as always. Every other nonterminal state (running, waiting, paused,
   * resuming) instead crosses the observable `cancelling` state and *stays*
   * there (spec `background-review-runs`): this call does not itself settle
   * the record. What settles it is the dispatched attempt's own cancelled
   * result, arriving through the normal `executeAttempt` ->
   * `completeAttempt` -> `settle` path — the same path a failure already
   * uses (D11: "cancellation may preserve already validated findings only as
   * partial"). The old synchronous settle here used to beat that result to
   * the record every time, discarding findings the attempt had already
   * validated; letting the attempt answer for itself is the whole fix.
   *
   * Two things do not wait for that answer, though, and both happen
   * synchronously, right here:
   * - **The concurrency slot.** Task 12.4's published guarantee — the next
   *   queued run must not wait for a provider or model to notice it was
   *   asked to stop.
   * - **The cancellation token**, if this key ever held one — triggered
   *   regardless of which state it is in, because a `waiting` or `paused`
   *   attempt's underlying call is still alive in the background even though
   *   its slot has already been released (see the file header: no seam this
   *   pass drives can genuinely suspend a live attempt).
   *
   * A provider or model that ignores the token entirely (design.md's own
   * named risk) must still not strand the record in `cancelling` forever —
   * `armCancelGrace` below is the bounded fallback for exactly that.
   */
  cancel(key: string): void {
    const record = this.records.get(key);
    if (!record || isTerminalLifecycle(record.lifecycle) || record.lifecycle === 'cancelling') return;
    if (record.lifecycle === 'queued' || record.lifecycle === 'resuming') {
      this.queue = this.queue.filter((queued) => queued !== key);
    }
    // Whatever slot this key currently holds — only an active phase ever
    // does, per `slotHolders`'s own doc comment — is released right now,
    // before anything downstream of a live attempt gets a chance to run.
    if (this.slotHolders.delete(key)) this.running = Math.max(0, this.running - 1);
    // A registered cancellation is exactly "this key was actually
    // dispatched" (`executeAttempt` is the only place one is created, and
    // only a terminal `settle` ever removes it) — the same distinction the
    // token call below already needs.
    const dispatched = this.cancellations.has(key);
    // The token stops the request: that is what makes the tokens stop being
    // spent. A no-op for a state that was never dispatched (queued) or whose
    // dispatch never got a token (a runner with no live call at all) —
    // `RunCancellation`'s own `cancel` is itself idempotent.
    this.cancellations.get(key)?.cancel();
    if (!dispatched) {
      // Never reached the transport — nothing will ever report back, so
      // there is nothing to wait for. `settle` releases nothing here (the
      // slot was never held) and pumps the queue on the way out.
      this.settle(record, { lifecycle: 'cancelled' });
      return;
    }
    // Every nonterminal source has a direct edge to `cancelling`
    // (`buildLegalRunTransitions`'s own table) — `applied` is defensive, not
    // a real failure path.
    if (!this.transition(record, 'cancelling')) return;
    this.pump();
    this.armCancelGrace(key);
  }

  /**
   * The bounded wait behind `cancel()`'s `cancelling` state. A cooperative
   * attempt — harness-backed or legacy-adapted — settles the record itself,
   * through `executeAttempt`'s ordinary success/catch handling, well before
   * this ever fires; see `cancel`'s own doc comment. This exists for the one
   * risk design.md names directly: a provider or model that never notices
   * the cancellation token at all. When that happens, the record settles as
   * `cancelled` with no findings — the same shape `executeAttempt`'s own
   * catch-block cancellation already produces for a runner that rejects
   * outright, just reached by a different route.
   *
   * Guarded on the record still being `cancelling` when the wait ends: a
   * cooperative attempt's own settlement is what usually gets there first,
   * and this must never overwrite it. `settle`'s own terminal-refusal guard
   * (task 12.4) would refuse a stale settlement anyway, but checking first
   * also skips it for the ordinary case rather than relying on that guard
   * alone.
   */
  private armCancelGrace(key: string): void {
    const graceMs = this.deps.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
    void this.cancelGrace(graceMs).then(() => {
      const record = this.records.get(key);
      if (!record || record.lifecycle !== 'cancelling') return;
      this.settle(record, { lifecycle: 'cancelled' });
    });
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
   * that is the automatic `HarnessAttemptRunOptions.onResuming` hook, not
   * this method.
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
    return sweepInterruptedRuns(this.deps.globalState, { harnessRunStore: this.harnessRunStore, now: () => this.now() });
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
    // `queued -> planning` is the table's only entry edge, and the only
    // transition this module makes synchronously before the attempt itself
    // gets a chance to run — the attempt's own first `onCheckpoint` call
    // (`applyCheckpoint`) advances it from there, whenever it actually
    // arrives (which cannot be assumed synchronous — see `executeAttempt`).
    this.transition(record, 'planning', { startedAt, step: 0 });
    // Written before the request goes out, so a host that stops mid-run leaves
    // the evidence the sweep needs.
    void this.inFlight.add({
      key: record.key,
      podId: record.input.podId,
      refLabel: record.input.refLabel,
      ...reviewIdentityFor(record.input.target),
      startedAt: new Date(startedAt).toISOString(),
      // Task 12.7: lets the activation sweep find this run's lineage in
      // `harnessRunStore`, once something writes one there (see the store
      // field's own doc comment) — absent costs the sweep nothing today.
      runId: record.runId,
      lineageId: record.lineageId,
    });
    void this.executeAttempt(record.key);
  }

  /**
   * Re-admits a `resuming` record dequeued by `pump` — the other half of
   * closing task 9.6's open half: FIFO re-entry happened in `beginResuming`
   * (by original admission order, never appended at the tail), and this is
   * where the slot is actually re-acquired once it is this key's turn.
   *
   * No second dispatch happens here: a resumed attempt's own continuation
   * from checkpoint is task 12.7's job (resuming a *lost* attempt across a
   * restart). Within one still-live process, the original `executeAttempt`
   * call for this key is still the one unresolved `attempt.run()` promise —
   * `onEnterWaiting`/`onResuming` are bookkeeping notifications about that
   * SAME call's own internal retry loop, never a signal to re-dispatch. Its
   * eventual resolution would have settled this record correctly even
   * without this method ever running (`isSettleable`/`settle`'s own implicit
   * resume — see the file header); reaching an active phase explicitly here
   * just makes that visible sooner, and lets `applyCheckpoint` resume
   * driving phase advances from a real attempt's later checkpoints too.
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
      runId: record.runId,
      lineageId: record.lineageId,
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
   *
   * The slot is released *before* the transition (which notifies
   * synchronously) rather than after: a real integration test proved that a
   * listener reacting synchronously to the `waiting` notification — an
   * immediate `resume()`, say — otherwise sees `running` a half-tick stale
   * and cannot yet claim the slot this same call is about to free. Safe to
   * reorder because `record.lifecycle` was just confirmed active, and every
   * active phase has a direct edge to both `waiting` and `paused` in the
   * table (`isLegalRunTransition`'s own construction), so the transition
   * below is structurally guaranteed to succeed — `applied` is defensive,
   * not a real failure path that would leave the release uncompensated.
   */
  private enterPausedState(key: string, target: 'waiting' | 'paused', reason?: string): void {
    const record = this.records.get(key);
    if (!record || !isActiveLifecycle(record.lifecycle)) return;
    if (this.slotHolders.delete(key)) this.running = Math.max(0, this.running - 1);
    const applied = this.transition(record, target, { resumeTo: record.lifecycle, waitReason: reason });
    if (!applied) return;
    this.pump();
  }

  /**
   * Re-enters the FIFO queue at its *original* admission position — sorting
   * the whole queue by admission sequence (which never changes across a
   * resume) is equivalent to a sorted insert, since every other entry's own
   * sequence is untouched (D12: "returns through `resuming` without losing
   * target ownership or queue fairness").
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

  /**
   * Drives one admitted run's `HarnessAttempt` to a finish (task 12.1's
   * central method): builds the reporting options every checkpoint/waiting/
   * resuming signal arrives through, asks `harnessFactory` for the attempt
   * (model-backed or the demo participant), awaits it, and hands a resolved
   * `HarnessAttemptResult` to `completeAttempt`.
   *
   * `HarnessAttempt.run()` only ever *rejects* for a genuine crash — a
   * normal failed or cancelled review outcome comes back as a *resolved*
   * result with `lifecycle: 'failed' | 'cancelled'` (`runPersisting`'s own
   * guarantee in `harnessAttempt.ts`; `completeAttempt` branches on it). The
   * `catch` below therefore preserves exactly the pre-harness
   * `asRunFailure`/cancellation-token classification, which is also what
   * `legacyRunnersToHarnessFactory`'s rethrown `lm` rejection still lands on.
   */
  private async executeAttempt(key: string): Promise<void> {
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
    const options: HarnessAttemptRunOptions = {
      identity: { runId: record.runId, lineageId: record.lineageId, attempt: record.attempt },
      timeouts: record.input.timeouts,
      onProgress: (progress) => this.recordProgress(key, progress),
      onAttachmentWarnings: (warnings) => this.patch(key, { attachmentWarnings: warnings }),
      cancellation: cancellation.token,
      onCheckpoint: (info) => this.applyCheckpoint(key, info),
      onEnterWaiting: (info) => this.enterPausedState(key, 'waiting', info?.reason),
      onResuming: () => this.beginResuming(key),
    };
    const attempt = record.input.demo
      ? this.harnessFactory.createDemo(record.input, options)
      : this.harnessFactory.create(record.input, options);
    try {
      const result = await attempt.run();
      if (!this.isSettleable(key)) return;
      await this.completeAttempt(key, result);
    } catch (error) {
      if (!this.isSettleable(key)) return;
      const current = this.records.get(key)!;
      const failure = asRunFailure(error, record.input.timeouts);
      // A genuine crash (not the cancellation-token rejection convention
      // itself) arriving after the reviewer already asked this run to stop:
      // `cancelling`'s only legal edge is to `cancelled`
      // (`buildLegalRunTransitions`), so settling this as `failed` would
      // silently no-op and strand the record. A rejection carries no
      // findings either way, so this settles exactly like a cooperative
      // cancellation with none.
      if (failure === 'cancelled' || current.lifecycle === 'cancelling') {
        this.settle(current, { lifecycle: 'cancelled' });
        return;
      }
      this.settle(current, { lifecycle: 'failed', failure });
    }
  }

  /**
   * Whether a result arriving right now for this key still belongs to a live
   * attempt — the structural late-settlement guard task 12.4 asks for.
   * `false` only once the record is gone (already settled and, for a
   * succeeded/cancelled run, deleted) or has reached a *terminal* lifecycle
   * by some other path (`cancel`, or an earlier settlement) — matching
   * `active()`/`trigger()`'s own admission check, `!isTerminalLifecycle`.
   *
   * `waiting`/`paused`/`resuming` are deliberately *still* settleable: this
   * pass's coarse `lm`/`demo` seam, and — a real integration test proved —
   * the committed harness engine itself, have no way to actually suspend a
   * live attempt while the manager's own bookkeeping calls it "waiting"; the
   * same one live promise keeps running underneath and is still the
   * authoritative result whenever it arrives. `settle` performs the
   * "resuming -> prior active phase" hop itself when it finds one of these
   * three lifecycles, rather than requiring an external `resume()` call to
   * have already happened — see `settle`'s own doc comment.
   */
  private isSettleable(key: string): boolean {
    const record = this.records.get(key);
    return !!record && !isTerminalLifecycle(record.lifecycle);
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
   * Task 12.1/12.2: every checkpoint a real attempt reports refreshes
   * `RunRecord.checkpoint`/`.projection` from what the attempt actually
   * said — `reduceActivity` (`harnessActivityProjection.ts`, task 5.4) is
   * the *same* reducer a real store-backed checkpoint write would use
   * (`harnessCheckpoint.ts`'s `buildCheckpoint` calls it identically); this
   * method never re-derives a lifecycle from `RunPhase` itself.
   *
   * Only ever *advances* the record among the four active phases
   * (`planning -> investigating -> verifying -> completing`), and only when
   * the table says the specific hop is legal. `waiting`/`paused`/
   * `cancelling`/terminal lifecycles stay exclusively
   * `enterPausedState`/`beginResuming`/`settle`'s job — if this method ever
   * drove one of those from a checkpoint alone, the record would move but no
   * concurrency slot would be released or reserved to match, corrupting
   * `running`'s count. A same-phase checkpoint (tool-cadence, model-suggested)
   * still refreshes `checkpoint`/`projection`/`limitations`, but repaints
   * rather than forcing the unthrottled notification a genuine transition
   * gets (D14: "checkpoint events repaint but do not notify") — reusing the
   * same throttle window `recordProgress` already applies to routine mid-run
   * updates.
   */
  private applyCheckpoint(key: string, info: CheckpointInfo): void {
    const record = this.records.get(key);
    if (!record) return;
    const projection = reduceActivity(info.activityLog);
    const patch: Partial<RunRecord> = { checkpoint: info, projection, limitations: projection.limitations };
    const isPhaseAdvance = projection.lifecycle !== record.lifecycle && isActiveLifecycle(projection.lifecycle);
    if (isPhaseAdvance && isLegalRunTransition(record.lifecycle, projection.lifecycle)) {
      this.transition(record, projection.lifecycle, patch);
      return;
    }
    const next: RunRecord = { ...record, ...patch };
    this.records.set(key, next);
    const now = this.now();
    if (now - this.lastEmit < PROGRESS_EMIT_MS) return;
    this.lastEmit = now;
    this.notify(next);
  }

  /**
   * The one place a resolved `HarnessAttemptResult` becomes a record's
   * terminal state (task 12.1/12.2, D11). `result.outcome` — never this
   * module's own guess — supplies `completeness`, `limitations`, and
   * whether the result replaces the retained review;
   * `result.findings[].item` (already a `ReviewItem`, D9) supplies what the
   * retained review's `items` are. `result.lifecycle` is always terminal by
   * the time it reaches here (`runPersisting`'s own guard in
   * `harnessAttempt.ts`).
   *
   * `runPersisting`'s own invariant is `lifecycle === 'succeeded' <=>
   * outcome.completeness === 'complete' <=> outcome.replacesRetainedReview`
   * — this branches on `result.lifecycle` itself, never on
   * `replacesRetainedReview` alone, so a hypothetical violation of that
   * invariant can only ever skip a retained-review write it should have
   * made; it can never turn a genuine success into a reported failure.
   *
   * `response.candidates` (findings the criteria filtered below the bar) has
   * no channel through `HarnessAttemptResult` in this pass — an honest `[]`,
   * matching what `legacyRunnersToHarnessFactory` also reports, rather than
   * a fabricated bucket.
   */
  private async completeAttempt(key: string, rawResult: HarnessAttemptResult): Promise<void> {
    // An entry guard of its own, not only reliance on `executeAttempt`'s own
    // pre-call check: this keeps "never touch storage for a record that
    // is not settleable" a property of this method itself, provable without
    // assuming every future caller remembers to check first.
    if (!this.isSettleable(key)) return;
    const record = this.records.get(key)!;
    const { input } = record;
    // The reviewer already asked this run to stop (the record is already
    // `cancelling`) before this result arrived. `cancelling`'s only legal
    // edge is to `cancelled` (`buildLegalRunTransitions`) — an attempt that
    // ignores the cancellation token and reports `succeeded` or `failed`
    // anyway must not settle as either below: `succeeded` would silently
    // report a run the reviewer stopped as ready (retained review, run
    // history, `onReviewReady`, all fired for real), and `failed` has no
    // edge out of `cancelling` at all and would strand the record until
    // `armCancelGrace`'s bounded fallback finally gives up on it. Reclassify
    // it as a cancellation instead: whatever it validated is still kept, but
    // only as a partial (D11), through exactly the same path below a
    // genuinely cooperative cancellation already takes — never as a
    // replacing success.
    const result: HarnessAttemptResult =
      record.lifecycle === 'cancelling' && rawResult.lifecycle !== 'cancelled'
        ? {
            ...rawResult,
            lifecycle: 'cancelled',
            outcome: {
              ...rawResult.outcome,
              completeness: rawResult.findings.length > 0 ? 'partial' : 'none',
              replacesRetainedReview: false,
            },
          }
        : rawResult;
    const items = result.findings.map((finding) => finding.item);

    if (result.lifecycle === 'succeeded') {
      const response: AgentReviewResponse = {
        schemaVersion: '1',
        agentId: input.agent.id,
        agentLabel: input.agentLabel,
        headSha: headShaFor(input.target),
        items,
        candidates: [],
      };
      if (result.outcome.replacesRetainedReview) {
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
        // A clean run is stored the same way as any other — a review with no
        // items — rather than as a deletion.
        const retained = retainedFromRun({
          review,
          ranAt,
          agentId: input.agent.id,
          agentLabel: input.agentLabel,
          modelId: input.modelId,
          candidates: response.candidates,
          // Not exposed by `HarnessAttemptResult` in this pass.
          filesRead: undefined,
          attachmentWarnings: record.attachmentWarnings,
          // Task 14.2 (design.md D16): `result.plan` is set only by a real
          // harness attempt (D5: planning always produces one) — never set
          // by the temporary `legacyRunnersToHarnessFactory` adapter, which
          // fabricates no plan for the shape it wraps. Absent here, never
          // guessed as `'legacy-one-shot'`: that inference belongs to
          // `readRetained` alone, over an absent stored value.
          protocolProvenance: result.plan ? 'harness' : undefined,
          lineageId: result.lineageId,
          attempt: result.attempt,
          activity: result.activityLog.events,
        });
        // The write comes FIRST, before anything is told the run succeeded.
        // `settle` notifies synchronously, and a panel watching this target
        // reacts by reading the record back off the store — the one-writer
        // rule in D7. Told first, it would read the *previous* run's review,
        // or an empty screen, and nothing would repaint when the write
        // landed a microtask later.
        await this.deps.workspaceState.update(recordKeyFor(input.target), retained);
        // Task 12.5: a fresh complete success is the one thing that ever
        // clears a stale partial (mirrors this file's own header: a retained
        // review "is deleted by exactly one thing — a newer run on the same
        // target that succeeded"). Still before `settle`'s notify below —
        // same write-before-notify discipline as the retained-review write
        // just above.
        await this.deps.workspaceState.update(partialRecordKeyFor(input.target), undefined);
        // Cancelled (or otherwise moved off an active phase) while that
        // write was in flight: the reviewer asked for this run to stop, and
        // `cancel` has already settled the record and freed its slot. The
        // retained review is written either way — the work was done and
        // paid for — but the run must not also report itself as succeeded.
        if (!this.isSettleable(key)) return;
        this.settle(record, {
          lifecycle: 'succeeded',
          response,
          completeness: result.outcome.completeness,
          limitations: result.outcome.limitations,
        });

        // Read-modify-write with no `await` between the pair, per the
        // contract in `storage.ts` — two runs can finish in the same tick.
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
          completeness: result.outcome.completeness,
        });
        return;
      }
      // Unreachable under `runPersisting`'s own invariant — see this
      // method's own doc comment above.
      if (!this.isSettleable(key)) return;
      this.settle(record, {
        lifecycle: 'succeeded',
        response,
        completeness: result.outcome.completeness,
        limitations: result.outcome.limitations,
      });
      return;
    }

    if (!this.isSettleable(key)) return;
    const partial: AgentReviewResponse | undefined = items.length > 0
      ? { schemaVersion: '1', agentId: input.agent.id, agentLabel: input.agentLabel, headSha: headShaFor(input.target), items, candidates: [] }
      : undefined;
    const identity = reviewIdentityFor(input.target);
    const ranAt = new Date(this.now()).toISOString();
    if (partial) {
      // Task 12.5/12.6: a partial result is durably, separately reachable —
      // its own key (`partialRecordKeyFor`), never the target's retained
      // review — not merged into it and never presented as if it were
      // complete. Written before anything is told the run ended, same
      // write-before-notify discipline as the succeeded path above.
      const review = createReview({
        repoId: identity.repoId,
        crNumber: identity.crNumber,
        agentId: input.agent.id,
        modelId: input.modelId,
        effort: input.effort,
        criteria: input.criteria,
        response: partial,
      });
      const partialRecord = retainedFromRun({
        review,
        ranAt,
        agentId: input.agent.id,
        agentLabel: input.agentLabel,
        modelId: input.modelId,
        candidates: partial.candidates,
        // Not exposed by `HarnessAttemptResult` in this pass (matches the succeeded path above).
        filesRead: undefined,
        attachmentWarnings: record.attachmentWarnings,
        // Explicitly incomplete: never defaults to 'complete' the way a plain `retainedFromRun`
        // call would (`result.outcome.completeness` here is always `'partial'` under
        // `runPersisting`'s own invariant — cancellation/failure never reach `complete`).
        completeness: result.outcome.completeness,
        limitations: result.outcome.limitations,
        // Task 14.2: same rule as the succeeded path above — set only from
        // `result.plan`'s actual presence, never guessed.
        protocolProvenance: result.plan ? 'harness' : undefined,
        lineageId: result.lineageId,
        attempt: result.attempt,
        activity: result.activityLog.events,
      });
      await this.deps.workspaceState.update(partialRecordKeyFor(input.target), partialRecord);
      if (!this.isSettleable(key)) return;
    }
    if (result.lifecycle === 'cancelled') {
      this.settle(record, {
        lifecycle: 'cancelled',
        completeness: result.outcome.completeness,
        limitations: result.outcome.limitations,
        partialResult: partial,
      });
      if (partial) await this.recordPartialHistory(identity, input.agentLabel, partial.items.length, ranAt, result.outcome.limitations);
      return;
    }
    // 'failed', or (structurally unreachable from a live `.run()` — see this
    // method's own doc comment) any other value: never fabricated as a
    // success.
    const failure: RunFailure = {
      message: result.outcome.limitations.map((limitation) => limitation.message).join(' ') || 'The review could not be completed.',
      requestId: '------',
      code: result.outcome.limitations[0]?.code ?? 'harness.incomplete',
    };
    this.settle(record, {
      lifecycle: 'failed',
      failure,
      completeness: result.outcome.completeness,
      limitations: result.outcome.limitations,
      partialResult: partial,
    });
    if (partial) await this.recordPartialHistory(identity, input.agentLabel, partial.items.length, ranAt, result.outcome.limitations);
  }

  /**
   * Task 12.5: the run-history counterpart to a durable partial write
   * (`completeAttempt`'s failed/cancelled tail) — an explicit `'partial'`
   * outcome, never folded into `'findings'`. Recorded after `settle`'s
   * notify, mirroring the succeeded path's own `this.runs.record`/
   * `onRunRecorded` ordering above (run-history/dashboard metadata, not the
   * result a panel reads back to render — see `completeAttempt`'s own
   * write-before-notify comment on the retained-review and durable-partial
   * writes themselves, which do precede notify).
   *
   * Task 14.4: `limitations` is the same `HarnessAttemptResult.outcome.
   * limitations` the durable partial record and the `settle` call just
   * above both already carry — never a second read or a re-derivation —
   * so the dashboard row's "why partial" tooltip can read straight off
   * `ReviewRun.limitations` instead of only off the record a panel opens.
   */
  private async recordPartialHistory(
    identity: { repoId: string; crNumber: string },
    agentLabel: string,
    findingCount: number,
    ranAt: string,
    limitations: readonly Limitation[],
  ): Promise<void> {
    await this.runs.record({
      repoId: identity.repoId,
      crNumber: identity.crNumber,
      outcome: 'partial',
      findingCount,
      agentLabel,
      ranAt,
      limitations,
    });
    this.deps.onRunRecorded?.();
  }

  /**
   * The one place a run reaches a terminal lifecycle: releases its slot (if
   * it held one), then pumps. A cancellation always crosses the observable
   * `cancelling` state first (spec `background-review-runs`); a succeeded or
   * failed outcome transitions directly, since `completing -> succeeded` and
   * every active phase `-> failed` are both direct edges in the table.
   *
   * **The implicit resume.** If the record is currently `waiting`, `paused`,
   * or `resuming`, this method performs the "resuming -> prior active phase"
   * hop itself before anything else, using the record's own recorded
   * `resumeTo` — exactly what `resumeStart` does, but without going through
   * the queue, because settling a result that already arrived is not
   * starting new work and needs no slot. This is deliberate, not an
   * oversight: neither this pass's coarse `lm`/`demo` seam nor the committed
   * harness engine (`harnessToolDispatcher.ts`'s "wait" classification never
   * actually suspends the attempt — a real integration test proved it keeps
   * running and settles normally) can genuinely pause a live attempt while
   * the manager calls it "waiting", so the one live promise is still the
   * authoritative result whenever it resolves, whether or not an explicit
   * `resume()` happened first (`isSettleable`'s own doc comment).
   *
   * Routed entirely through `transition` (12.3): if the record is already
   * terminal, every transition attempt below is refused and this method
   * does nothing else — the structural guard 12.4 asks for, so a late
   * attempt resolution racing an earlier cancellation or failure can never
   * re-settle an already-settled record. `completeness`/`limitations`/
   * `partialResult` default to the pre-harness values (`complete`/`none`,
   * `[]`, absent) when a caller does not supply them — `cancel()`'s own call
   * site, which has no `HarnessAttemptResult` to read them from.
   */
  private settle(
    record: RunRecord,
    outcome:
      | { readonly lifecycle: 'succeeded'; readonly response: AgentReviewResponse; readonly completeness?: ResultCompleteness; readonly limitations?: readonly Limitation[] }
      | { readonly lifecycle: 'failed'; readonly failure: RunFailure; readonly completeness?: ResultCompleteness; readonly limitations?: readonly Limitation[]; readonly partialResult?: AgentReviewResponse }
      | { readonly lifecycle: 'cancelled'; readonly completeness?: ResultCompleteness; readonly limitations?: readonly Limitation[]; readonly partialResult?: AgentReviewResponse },
  ): void {
    let current = this.records.get(record.key) ?? record;
    // Skipped entirely for `cancelled`: `waiting`/`paused`/`resuming` already
    // have a *direct* edge to `cancelling` in the table, and cancelling a
    // waiting run should read as exactly that, not as an implicit resume
    // immediately followed by a cancellation.
    if (outcome.lifecycle !== 'cancelled') {
      if (current.lifecycle === 'waiting' || current.lifecycle === 'paused') {
        this.transition(current, 'resuming');
        current = this.records.get(record.key) ?? current;
      }
      if (current.lifecycle === 'resuming') {
        this.transition(current, current.resumeTo ?? 'investigating', { resumeTo: undefined });
        current = this.records.get(record.key) ?? current;
      }
    }

    if (outcome.lifecycle === 'cancelled') {
      this.transition(current, 'cancelling');
    } else if (outcome.lifecycle === 'succeeded') {
      // `succeeded` is reachable only from `completing` (the table's own
      // funnel, mirroring D2's diagram). A real attempt's own `completing`
      // checkpoint (`applyCheckpoint`) may already have crossed this — the
      // attempt is idempotent-safe either way, since `transition` simply
      // refuses a same-state hop and `current` below reads whatever is
      // actually there.
      this.transition(current, 'completing');
    }
    current = this.records.get(record.key) ?? current;

    const patch: Partial<RunRecord> = {
      finishedAt: this.now(),
      progress: undefined,
      response: outcome.lifecycle === 'succeeded' ? outcome.response : undefined,
      failure: outcome.lifecycle === 'failed' ? outcome.failure : undefined,
      completeness: outcome.completeness ?? (outcome.lifecycle === 'succeeded' ? 'complete' : 'none'),
      limitations: outcome.limitations ?? [],
      partialResult: outcome.lifecycle !== 'succeeded' ? outcome.partialResult : undefined,
      resumeTo: undefined,
      waitReason: undefined,
    };
    const applied = this.transition(current, outcome.lifecycle, patch);
    if (!applied) return; // already terminal — a late settlement, structurally refused (12.4)

    // Task 14.7: `onReviewReady` already covers `succeeded` (including a
    // `succeeded` result that is only `partial` — see that callback's own
    // doc comment); every other terminal lifecycle reaching this, the one
    // settlement funnel, notifies exactly once here — whichever of
    // `completeAttempt`, the cancel grace timeout, or a genuine crash in
    // `executeAttempt`'s catch block produced it.
    if (outcome.lifecycle === 'failed' || outcome.lifecycle === 'cancelled') {
      this.deps.onRunOutcome?.({
        lifecycle: outcome.lifecycle,
        completeness: patch.completeness!,
        refLabel: record.input.refLabel,
        ref: record.input.target.kind === 'cr' ? record.input.target.ref : undefined,
        podId: record.input.podId,
        findingCount: outcome.partialResult?.items.length,
      });
    }

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
   * `status` is always rederived here, never passed in `patch` — the one
   * place it can drift is this one. `projection` is taken from `patch` when
   * a caller supplies one (`applyCheckpoint`'s attempt-reported projection),
   * and only otherwise rebuilt from this record's own known fields
   * (`buildProjection`) — never overwritten once a real one exists.
   */
  private transition(record: RunRecord, to: RunLifecycle, patch: Partial<RunRecord> = {}): boolean {
    if (!isLegalRunTransition(record.lifecycle, to)) return false;
    const next: RunRecord = { ...record, ...patch, lifecycle: to, status: legacyStatusFor(to) };
    if (!patch.projection) next.projection = this.buildProjection(next);
    this.records.set(record.key, next);
    this.emit(next);
    return true;
  }

  /**
   * The manager-authored fallback `RunProjection` (12.2: reuses
   * `../domain/harnessActivity.ts`'s own shape, never a second one) for
   * states no attempt-reported checkpoint covers: `queued`, the manager's
   * own `cancelling`/terminal settlement, and `waiting`/`paused`/`resuming`
   * (whose activity the attempt reports through its *own* activity log, but
   * whose lifecycle transition this module always makes itself — see
   * `applyCheckpoint`'s doc comment on why a checkpoint alone never drives
   * these). Once a real checkpoint has reported a genuine `RunProjection`
   * (`applyCheckpoint`), `transition`/`patch` never call this to replace it.
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
      // No real coverage denominator exists for a state this fallback
      // covers — `indeterminate` is the honest choice per
      // `review-run-activity`'s truthful-progress rule, never a fabricated
      // determinate count.
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
  /**
   * Task 12.7: this run's harness identity, so the activation sweep can look
   * up its lineage in `HarnessRunStore` (`sweepInterruptedRuns`). Optional so
   * every pre-this-change persisted entry (`migrationFixtures.ts`'s
   * `LEGACY_IN_FLIGHT_RUN`) still parses unchanged, and so a legacy-adapted
   * run (which reports no checkpoints at all) can still be swept the way it
   * always was.
   */
  runId?: string;
  lineageId?: string;
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

/** Task 12.7's optional collaborators — see `sweepInterruptedRuns`'s own doc comment. */
export interface SweepInterruptedOptions {
  readonly harnessRunStore?: HarnessRunStore;
  /** Bound values only (`closeAttemptAsInterrupted`'s activity retention, `HarnessRunStore.writeCheckpoint`'s per-lineage retention) — defaults to `DEFAULT_HARNESS_POLICY`, matching every other module in this change with no live policy to read. */
  readonly policy?: HarnessPolicy;
  /** This module's determinism rule ("a checkpoint store must never read a clock of its own") applies to the closed checkpoint's `occurredAt` too — defaults to `() => Date.now()` only for callers with no injected clock (today's tests, legacy call sites); `ReviewRunManager.sweepInterrupted` passes its own. */
  readonly now?: () => number;
}

/** `computeInterruptedCompleteness`'s own predicate (`harnessResume.ts`), counted rather than reduced to a boolean — never a second definition of "which candidates count". */
function acceptedFindingCount(candidates: readonly { readonly state: string; readonly finding?: unknown }[]): number {
  return candidates.filter((candidate) => candidate.state === 'accepted' && candidate.finding !== undefined).length;
}

/**
 * Turn whatever survived the last session into recorded `interrupted` runs, and
 * clear the list. Nothing here touches the target's retained review: an
 * interruption is reported *alongside* the last completed review, never in
 * place of it.
 *
 * Task 12.7: when `options.harnessRunStore` is given and a leftover entry
 * carries `runId`/`lineageId` (`InFlightRun`'s own doc comment) with a
 * nonterminal checkpoint on record there, that attempt is closed as
 * `interrupted` in the store too — `harnessResume.ts`'s
 * `closeAttemptAsInterrupted`, the same function task 11.6's own tests
 * already exercise, never a second close path. The recorded finding count
 * then reflects whatever validated findings the last checkpoint actually
 * held, and `ReviewRun.resumable` reports whether the *stored* checkpoint
 * alone is sound (`harnessResume.ts`'s `checkCheckpointIntegrity` — never
 * the live head/model/policy comparison `decideResume`'s remaining
 * dimensions need, which this sweep has no live snapshot to build; offering
 * an *actual* resume — starting a new attempt — needs that live snapshot too
 * and stays out of this pass, see `ReviewRunManager`'s own `harnessRunStore`
 * field doc comment). Every leftover entry with nothing to consult — every
 * entry today, since nothing on the live execution path writes checkpoints
 * yet, and every legacy-adapted run always — falls back to exactly the
 * crude behavior this function always had.
 */
export async function sweepInterruptedRuns(globalState: KeyValueStore, options: SweepInterruptedOptions = {}): Promise<number> {
  const inFlight = new InFlightRunStore(globalState);
  const leftover = inFlight.list();
  if (leftover.length === 0) return 0;
  const runs = new ReviewRunStore(globalState);
  const harnessRunStore = options.harnessRunStore;
  const policy = options.policy ?? DEFAULT_HARNESS_POLICY;
  const now = options.now ?? (() => Date.now());
  for (const entry of leftover) {
    let findingCount = 0;
    let resumable: boolean | undefined;
    // Task 14.6: the same reasons `resumable`'s own boolean already
    // collapsed `.length === 0` from — kept here too, never a second
    // check, so a UI can show *why* a checkpoint failed integrity rather
    // than only that it did.
    let resumeReasons: readonly Limitation[] | undefined;
    if (harnessRunStore && entry.runId && entry.lineageId) {
      const lineageId = entry.lineageId as LineageId;
      const latest = harnessRunStore.latestCheckpoint(lineageId);
      if (latest && !isTerminalLifecycle(latest.projection.lifecycle)) {
        const closed = closeAttemptAsInterrupted(latest, { checkpointId: mintHarnessId('ckpt'), occurredAt: new Date(now()).toISOString() }, policy);
        if (closed) {
          await harnessRunStore.writeCheckpoint(closed, policy);
          findingCount = acceptedFindingCount(closed.candidates);
          const storedSnapshot = harnessRunStore.readSnapshot(lineageId, closed.attempt);
          const reasons = storedSnapshot ? checkCheckpointIntegrity(storedSnapshot, closed) : undefined;
          resumable = reasons ? reasons.length === 0 : false;
          if (reasons && reasons.length > 0) resumeReasons = reasons;
        }
      }
    }
    await runs.record({
      repoId: entry.repoId,
      crNumber: entry.crNumber,
      outcome: 'interrupted',
      findingCount,
      agentLabel: '',
      ranAt: entry.startedAt,
      ...(resumable !== undefined ? { resumable } : {}),
      ...(resumeReasons !== undefined ? { resumeReasons } : {}),
    });
  }
  await inFlight.clear();
  return leftover.length;
}
