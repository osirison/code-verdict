/**
 * Copilot agent integration via `vscode.lm` (spec §5): discovery lists the
 * user's chat models next to the demo agent; a run sends criteria, extra
 * instructions, explicitly attached evidence and changed-file diffs, then
 * expects the agentReviewResponse contract back.
 */
import * as vscode from 'vscode';
import { AgentResponseError } from '../domain/agentResponse';
import type { Criteria } from '../domain/types';
import { effortPrompt, type EffortLevel } from '../domain/effort';
import type { ChangeRequestDiff } from '../platform/types';
import { BUILTIN_AGENT_ID, type AgentDescriptor, type ModelDescriptor } from './agents';
import { modelVisiblePath } from './modelVisiblePath';
import { AgentTrace, type AgentProgressCallback, type AgentTimeoutReason, type AgentTraceSink } from './agentTrace';
import { changesetHeadSha, type ChangesetAgentMember } from './combinedAgent';
import {
  ATTACHMENT_TOTAL_BUDGET,
  DEFAULT_CONTEXT_BUDGETS,
  renderAttachmentsPrompt,
  renderReviewContextPrompt,
  type Attachment,
  type ContextBudgets,
  type ReviewContext,
  type ReviewContextEntry,
} from './reviewContext';

export type { AgentProgressCallback, AgentRunProgress, AgentTraceSink } from './agentTrace';

const LM_PREFIX = 'lm:';

const BUILTIN_ATTACHMENT_INSTRUCTIONS = 'You are a code review agent. Review ONLY the attachments and diffs below.';

function promptAgentInstructions(agent: AgentDescriptor, hasAttachments: boolean): string {
  return agent.id === BUILTIN_AGENT_ID && hasAttachments
    ? BUILTIN_ATTACHMENT_INSTRUCTIONS
    : agent.instructions;
}

// Issue #36 opened this: a flat total-duration timeout cancels a review that
// is still actively streaming. The fix then added an inactivity window but
// kept an absolute ceiling beside it, and the ceiling reproduced the very
// bug the issue was about, ten minutes later — a run streaming healthily the
// whole time was still cancelled, and the panel blamed
// `copilot.request.timeout`. A wall-clock bound cannot tell a productive run
// from a hung one, so neither limit is one any more:
//
// - INACTIVITY: reset on every fragment. A model that keeps producing
//   output keeps the request alive no matter how long the run takes overall.
//   The issue's own worked example is a model that streams one fragment
//   every ~60s; 90s gives that pattern real margin (not a knife's-edge tie)
//   while still recovering a genuinely stuck request in reasonable time.
// - CEILING: a checkpoint, not a kill. On expiry it asks one question — did
//   anything arrive during this window? If yes it re-arms for another full
//   window; only a window that passed with no output at all cancels. So it
//   bounds a run that has gone quiet over a long horizon and never a run
//   that is still producing. With both windows at their defaults inactivity
//   always fires first, which is intended: the ceiling is the bound that is
//   left when a caller turns inactivity off for a model that thinks in
//   multi-minute silences.
//
// Both are settings — `codeVerdict.agentRun.*`, read in the UI layer and
// handed down as `RunAgentOptions.timeouts`, because nothing below `src/ui`
// reads `workspace.getConfiguration`. Zero disables either window.
export const INACTIVITY_TIMEOUT_MS = 90_000;
export const CEILING_TIMEOUT_MS = 10 * 60_000;

/** Both windows in milliseconds; `<= 0` disables that one. */
export interface AgentRunTimeouts {
  inactivityMs: number;
  ceilingMs: number;
}

export const DEFAULT_AGENT_RUN_TIMEOUTS: AgentRunTimeouts = {
  inactivityMs: INACTIVITY_TIMEOUT_MS,
  ceilingMs: CEILING_TIMEOUT_MS,
};

// Reused across runs so we don't spawn a new "Code Verdict: Agent Trace"
// output channel on every review — VS Code shows one entry per channel in
// the output picker and there's no API to replace/dispose the old one from
// here.
let defaultChannel: vscode.OutputChannel | undefined;
function defaultTraceSink(): AgentTraceSink {
  defaultChannel ??= vscode.window.createOutputChannel('Code Verdict: Agent Trace');
  return defaultChannel;
}

/**
 * Options for `runFollowUpPrompt`/`runHarnessModelTurn`, both thin callers
 * of `streamText`. Task 15.8 removed `runLmAgent`/`runLmChangesetAgent` —
 * the one-shot runners that used to also take this options shape and read
 * its attachment/budget/workspace-root fields to assemble a request. Those
 * fields had no other reader, so they left with the runners; what remains
 * is exactly what `streamText` and `runFollowUpPrompt` themselves read.
 */
export interface RunAgentOptions {
  /** Called once per streamed fragment so a caller can show a "still alive" indicator without polling. */
  onProgress?: AgentProgressCallback;
  /** Overrides the default output-channel sink — tests inject a plain in-memory one instead of touching `vscode`. */
  trace?: AgentTraceSink;
  /** The configured windows. Omitted falls back to the defaults above, which is what an unconfigured caller wants. */
  timeouts?: AgentRunTimeouts;
  /**
   * The caller's own stop signal, linked to the internal source below. Without
   * it a caller could only stop *listening* — the request kept streaming, spent
   * its tokens, and the answer was dropped on arrival. That was tolerable while
   * a run belonged to the panel that started it; with runs holding a slot in a
   * concurrency budget it is not, because a run nobody is waiting for would
   * still keep the next one out.
   */
  cancellation?: AgentCancellationToken;
  /** Prompt-level review instruction. `none` contributes no prompt bytes. Read by `runFollowUpPrompt` only. */
  effort?: EffortLevel;
}

export interface AssembleReviewPromptOptions {
  attachments?: readonly Attachment[];
  contextBudgets?: ContextBudgets;
  attachmentBudget?: number;
  /** Exact rendered zone reused by execution so its manifest cannot drift from this prompt. */
  attachmentPrompt?: string;
  effort?: EffortLevel;
  workspaceRootLabel?: string;
}

/**
 * The one piece of `vscode.CancellationToken` this module uses. Declared
 * structurally rather than imported as a type so a caller can hand in a real
 * one and a test can hand in an object literal — `vscode.CancellationToken`
 * satisfies it.
 */
export interface AgentCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * The Copilot chat models available to this session. These are *models*, not
 * agents: what runs a review, not what the review is. The id format is
 * unchanged from when each of these was itself listed as an agent, so
 * `AgentTrace`'s vendor/family split and every pod holding an `lm:` value
 * keep working.
 */
export async function discoverModels(): Promise<ModelDescriptor[]> {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({
      id: `${LM_PREFIX}${m.vendor}/${m.family}`,
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      vendor: m.vendor,
      family: m.family,
      maxInputTokens: m.maxInputTokens > 0 ? m.maxInputTokens : undefined,
    }));
  } catch {
    // No Copilot in this session (e.g. emulator-only debugging).
    return [];
  }
}

/** Count an already assembled prompt without issuing a chat request. */
export async function countPromptTokens(modelId: string, prompt: string): Promise<number | undefined> {
  const [vendor, family] = modelId.slice(LM_PREFIX.length).split('/');
  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  return model ? model.countTokens(prompt) : undefined;
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly requestId: string,
    readonly timedOut: boolean,
    /** Set when the request was cancelled — which limit ran out, or `'caller'`. */
    readonly timeoutReason?: AgentTimeoutReason,
    /**
     * The reviewer stopped it. Kept separate from `timedOut` because the two
     * mean opposite things to whoever reads the result: a timeout is a failure
     * to report and offer a retry for, a cancellation is the outcome that was
     * asked for. Both arrive here as a cancelled token, so without this flag
     * the only way to tell them apart is the message text.
     */
    readonly cancelled: boolean = false,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

/**
 * The exact single-review prompt. Task 15.8 removed `runLmAgent`, the
 * one-shot execution this prompt used to feed straight to `runPrompt` —
 * nothing shipped reached it any more (the harness builds its own bootstrap
 * envelope, `harnessModelSeam.ts`). This builder survives because
 * `ui/reviewFlow.ts`'s pre-run context-usage estimate still calls it to show
 * a token count before the reviewer starts a run — never to execute one.
 */
export function assembleReviewPrompt(
  agent: AgentDescriptor,
  diff: ChangeRequestDiff,
  criteria: Criteria,
  context?: ReviewContext,
  options: AssembleReviewPromptOptions = {},
): string {
  const attachmentPrompt = options.attachmentPrompt
    ?? renderAttachmentsPrompt(options.attachments ?? [], options.attachmentBudget ?? ATTACHMENT_TOTAL_BUDGET);
  return [
    // Element zero is the ONLY agent-controlled part of this array. Everything
    // after it is built here, from these inputs, exactly as it was before
    // agents were selectable — which is what makes it impossible for an agent
    // body to displace the contract, drop the criteria, or change the diffs.
    // The built-in agent's instructions are the literal that used to sit here.
    promptAgentInstructions(agent, attachmentPrompt !== ''),
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    effortPrompt(options.effort),
    renderReviewContextPrompt(context ? [{ context }] : [], options.contextBudgets ?? DEFAULT_CONTEXT_BUDGETS),
    attachmentPrompt,
    ...diff.files.map((f) => `--- ${modelVisiblePath(f.newPath, options.workspaceRootLabel)}\n${f.diff}`),
  ].filter((part) => part !== '').join('\n\n');
}

/**
 * The context blocks the changeset prompt carries, each labelled with the same
 * identifiers the member's diffs carry below it. Exported because the triage
 * screen asks `reviewContextTruncatedForPrompt` whether this prompt was cut,
 * and the total budget counts the labels too — answering that against a set
 * relabelled for the screen would report on a prompt that was never sent.
 */
export function changesetContextEntries(members: readonly ChangesetAgentMember[]): ReviewContextEntry[] {
  return members.flatMap((member) => (member.context
    // vocab-ok: the agent prompt's wire format — the same labels the response parser reads back
    ? [{ context: member.context, label: `for projectId=${member.ref.repoId} mrIid=${member.ref.number}` }]
    : []));
}

/** Member-labelled attachment zone, using the same wire identifiers as each changeset diff. */
export function renderChangesetAttachmentsPrompt(
  members: readonly ChangesetAgentMember[],
  totalBudget = ATTACHMENT_TOTAL_BUDGET,
): string {
  const labelled = members.flatMap((member) => (member.attachments ?? []).map((attachment) => ({
    ...attachment,
    id: `projectId=${member.ref.repoId} mrIid=${member.ref.number} attachment=${attachment.id}`,
    // vocab-ok: the agent prompt's wire format — the member path label parallels the diff label below
    path: `projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${attachment.path}`,
  })));
  return renderAttachmentsPrompt(labelled, totalBudget);
}

export interface AssembleChangesetReviewPromptOptions {
  contextBudgets?: ContextBudgets;
  attachmentBudget?: number;
  effort?: EffortLevel;
  attachmentPrompt?: string;
}

export function assembleChangesetReviewPrompt(
  agent: AgentDescriptor,
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
  options: AssembleChangesetReviewPromptOptions = {},
): string {
  const headSha = changesetHeadSha(members);
  const contract = '{ "id", "projectId", "mrIid", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "cross"?: true, "spans"?: [{"projectId","location","role"}], "suggestion"?: {"old","new"} }';
  const attachmentPrompt = options.attachmentPrompt
    ?? renderChangesetAttachmentsPrompt(members, options.attachmentBudget ?? ATTACHMENT_TOTAL_BUDGET);
  return [
    promptAgentInstructions(agent, attachmentPrompt !== ''),
    'Review this changeset as one distributed unit. Review ONLY the member-labelled diffs and attachments below.',
    'Find both normal per-repository issues and failures that exist only between repositories. A cross-repository item must set cross=true and name both sides in spans[].',
    `Respond with one JSON object: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": ${JSON.stringify(headSha)}, "items": [${contract}], "candidates": [] }`,
    'Every item must use the exact projectId and mrIid labels supplied below. Its file and line must identify an added line in that member diff or a line in that member attachment.',
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    effortPrompt(options.effort),
    renderReviewContextPrompt(changesetContextEntries(members), options.contextBudgets ?? DEFAULT_CONTEXT_BUDGETS),
    attachmentPrompt,
    ...members.flatMap((member) => member.diff.files.map((file) => [
      // vocab-ok: the agent prompt's wire format — the provider-neutral response parser reads this member label
      `--- projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${modelVisiblePath(file.newPath, member.workspaceRootLabel)}`,
      file.diff,
    ].join('\n'))),
  ].filter((part) => part !== '').join('\n\n');
}

/**
 * A follow-up question about one finding (#37). Unlike a review run this
 * expects prose, not the JSON contract, so it shares the streaming, timeout
 * and trace machinery through `streamText` and skips the parse entirely.
 */
export async function runFollowUpPrompt(
  agent: AgentDescriptor,
  modelId: string,
  prompt: string,
  options?: RunAgentOptions,
): Promise<string> {
  // The agent's instructions lead here too, so the answer keeps the persona
  // that produced the finding being asked about. An agent with no
  // instructions contributes nothing and the prompt is what it always was.
  const withPersona = [agent.instructions, effortPrompt(options?.effort), prompt]
    .filter((part) => part !== '')
    .join('\n\n');
  return streamText(modelId, withPersona, options, (text, trace) => {
    trace.response(text, true);
    trace.success(0);
    return text.trim();
  });
}

/**
 * One harness protocol turn (task 15.7 of `add-agentic-review-harness`,
 * `./harnessModelSeam.ts`'s `createLiveModelSeam`): `prompt` already carries
 * the full bootstrap envelope, persona, criteria, tool schemas, protocol
 * contract, prior tool results, and any repair instruction — this function
 * adds nothing to it and reuses `streamText`'s existing streaming path,
 * cancellation, timeout windows, and tracing exactly as `runFollowUpPrompt`
 * does, returning the model's raw reply text for
 * `../domain/harnessProtocol.ts`'s `parseModelTurn` to parse. `runFollowUpPrompt`
 * is the follow-up-question path and stays untouched by this addition (task
 * 10.2's second clause: follow-up questions are not review-harness concerns).
 * Task 15.8 removed `runPrompt`, the one-shot review path that used to sit
 * beside this one — nothing shipped reached it once `runLmAgent`/
 * `runLmChangesetAgent` were removed with it.
 *
 * A missing or refusing model, a timeout, or a cancellation surfaces as the
 * same `AgentRunError` `streamText` always throws — never swallowed here,
 * so `harnessAttempt.ts`'s turn loop (and, above it, `ReviewRunManager`'s
 * `executeAttempt` catch block) sees a genuine rejection and fails the
 * attempt truthfully rather than falling back to anything.
 */
export async function runHarnessModelTurn(
  modelId: string,
  prompt: string,
  options?: RunAgentOptions,
): Promise<string> {
  return streamText(modelId, prompt, options, (text, trace) => {
    trace.response(text, true);
    trace.success(0);
    return text;
  });
}

/**
 * Stream one prompt and hand the collected text to `finish`, which runs INSIDE
 * the try so a parse failure is classified and traced exactly like a transport
 * failure. Everything about timeouts, cancellation and tracing lives here once.
 */
async function streamText<T>(
  modelId: string,
  prompt: string,
  options: RunAgentOptions | undefined,
  finish: (text: string, trace: AgentTrace) => T,
): Promise<T> {
  const [vendor, family] = modelId.slice(LM_PREFIX.length).split('/');
  const requestId = Math.random().toString(16).slice(2, 8);
  const trace = new AgentTrace(options?.trace ?? defaultTraceSink(), requestId, vendor ?? '', family ?? '');
  trace.prompt(prompt);

  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  if (!model) {
    const message = `Model ${modelId} is no longer available`;
    trace.failure(message);
    throw new AgentRunError(message, requestId, false);
  }

  const timeouts = options?.timeouts ?? DEFAULT_AGENT_RUN_TIMEOUTS;
  const tokenSource = new vscode.CancellationTokenSource();
  let timeoutReason: AgentTimeoutReason | undefined;
  /** `ms <= 0` is the setting's documented "no limit" — arm nothing at all. */
  const schedule = (ms: number, onExpiry: () => void): ReturnType<typeof setTimeout> | undefined =>
    ms > 0 ? setTimeout(onExpiry, ms) : undefined;
  const cancelWith = (reason: AgentTimeoutReason) => {
    timeoutReason = reason;
    tokenSource.cancel();
  };

  // The ceiling re-arms itself for as long as output keeps arriving, so its
  // handle is reassigned rather than fixed; `finally` clears whichever one is
  // pending at the end.
  let producedThisCeiling = false;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const armCeiling = () => {
    producedThisCeiling = false;
    ceiling = schedule(timeouts.ceilingMs, () => {
      if (producedThisCeiling) {
        armCeiling();
        return;
      }
      cancelWith('ceiling');
    });
  };
  armCeiling();

  let inactivity = schedule(timeouts.inactivityMs, () => cancelWith('inactivity'));
  // The caller's signal joins the same source the two windows use, so there is
  // one way to stop a request and one place that classifies why it stopped.
  // Checked first as well as subscribed: a token that was already cancelled
  // before the run started fires no event, and would otherwise stream to
  // completion for a caller that had already given up.
  const callerCancel = options?.cancellation;
  const callerSubscription = callerCancel?.onCancellationRequested(() => cancelWith('caller'));
  if (callerCancel?.isCancellationRequested) cancelWith('caller');

  const onFragment = () => {
    producedThisCeiling = true;
    clearTimeout(inactivity);
    inactivity = schedule(timeouts.inactivityMs, () => cancelWith('inactivity'));
  };

  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      tokenSource.token,
    );
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
      onFragment();
      const progress = trace.fragment(fragment);
      options?.onProgress?.(progress);
    }
    return finish(text, trace);
  } catch (e) {
    if (tokenSource.token.isCancellationRequested) {
      if (timeoutReason === 'caller') {
        // Not a failure: the reviewer asked for this. Reported as its own
        // outcome so the caller does not offer to lengthen a window that had
        // nothing to do with it.
        const message = 'run cancelled';
        trace.failure(message, 'caller');
        throw new AgentRunError(message, requestId, false, 'caller', true);
      }
      // Two limits, two sentences: which window ran out tells the reviewer
      // whether to lengthen the short one or the long one.
      const message =
        timeoutReason === 'ceiling'
          ? `agent produced nothing for a full ${timeouts.ceilingMs / 1000}s run window`
          : `agent stalled: no output for ${timeouts.inactivityMs / 1000}s`;
      trace.failure(message, timeoutReason);
      throw new AgentRunError(message, requestId, true, timeoutReason);
    }
    if (e instanceof AgentResponseError || e instanceof SyntaxError) {
      const message = `agent response did not match the contract: ${e.message}`;
      // The thrown `AgentRunError` keeps `e.message` verbatim (existing, tested behaviour: the
      // reviewer-facing failure card). The trace sink does not: a `SyntaxError` from `JSON.parse`
      // quotes a fragment of the model's own output in its own message, so the sink gets a fixed
      // classification instead. Neither surviving `finish` callback below parses JSON — this
      // branch is defensive, kept because it is shared, generic response-classification logic
      // in `streamText` rather than something specific to the one-shot contract task 15.8 removed.
      trace.failure(e instanceof SyntaxError ? 'agent response did not match the contract: malformed JSON' : message);
      throw new AgentRunError(message, requestId, false);
    }
    const message = e instanceof Error ? e.message : String(e);
    trace.failure(message);
    throw new AgentRunError(message, requestId, false);
  } finally {
    clearTimeout(ceiling);
    clearTimeout(inactivity);
    callerSubscription?.dispose();
    tokenSource.dispose();
  }
}
