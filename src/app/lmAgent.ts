/**
 * Copilot agent integration via `vscode.lm` (spec §5): discovery lists the
 * user's chat models next to the demo agent; a run sends the changed-file
 * diffs, criteria and extra instructions — never the whole repo — and
 * expects the agentReviewResponse contract back.
 */
import * as vscode from 'vscode';
import type { AgentReviewResponse } from '../domain/agentResponse';
import { AgentResponseError, parseAgentReviewResponse } from '../domain/agentResponse';
import type { Criteria } from '../domain/types';
import type { ChangeRequestDiff } from '../platform/types';
import type { AgentDescriptor, ModelDescriptor } from './agents';
import { AgentTrace, type AgentProgressCallback, type AgentTimeoutReason, type AgentTraceSink } from './agentTrace';
import { changesetHeadSha, validateChangesetResponse, type ChangesetAgentMember } from './combinedAgent';
import { renderReviewContextPrompt, type ReviewContext, type ReviewContextEntry } from './reviewContext';

export type { AgentProgressCallback, AgentRunProgress, AgentTraceSink } from './agentTrace';

const LM_PREFIX = 'lm:';

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
    }));
  } catch {
    // No Copilot in this session (e.g. emulator-only debugging).
    return [];
  }
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
 * `context` carries what the change is for (title, description, linked work
 * items). It sits between the criteria and the diffs so intent is read before
 * evidence, and `renderReviewContextPrompt` is what states that it is intent
 * rather than more surface to review.
 */
export async function runLmAgent(
  agent: AgentDescriptor,
  modelId: string,
  diff: ChangeRequestDiff,
  criteria: Criteria,
  context?: ReviewContext,
  options?: RunAgentOptions,
): Promise<AgentReviewResponse> {
  const prompt = [
    // Element zero is the ONLY agent-controlled part of this array. Everything
    // after it is built here, from these inputs, exactly as it was before
    // agents were selectable — which is what makes it impossible for an agent
    // body to displace the contract, drop the criteria, or change the diffs.
    // The built-in agent's instructions are the literal that used to sit here.
    agent.instructions,
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    renderReviewContextPrompt(context ? [{ context }] : []),
    ...diff.files.map((f) => `--- ${f.newPath}\n${f.diff}`),
  ].filter((part) => part !== '').join('\n\n');
  return runPrompt(modelId, prompt, options);
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

export async function runLmChangesetAgent(
  agent: AgentDescriptor,
  modelId: string,
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
  options?: RunAgentOptions,
): Promise<AgentReviewResponse> {
  const headSha = changesetHeadSha(members);
  const contract = '{ "id", "projectId", "mrIid", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "cross"?: true, "spans"?: [{"projectId","location","role"}], "suggestion"?: {"old","new"} }';
  const prompt = [
    // Same rule as `runLmAgent`: the agent goes first and owns nothing after
    // it. The changeset framing below is system-owned — it describes the
    // labelling contract the response parser enforces, not a persona — so it
    // stays whichever agent is selected. Its old "You are a code review
    // agent." opener has moved into the agent, which is what now supplies it.
    agent.instructions,
    'Review this changeset as one distributed unit. Review ONLY the labelled diffs below.',
    'Find both normal per-repository issues and failures that exist only between repositories. A cross-repository item must set cross=true and name both sides in spans[].',
    `Respond with one JSON object: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": ${JSON.stringify(headSha)}, "items": [${contract}], "candidates": [] }`,
    'Every item must use the exact projectId and mrIid labels supplied below. The file and line must identify an added line in that member diff.',
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    // One block per member that has context, all of them before any diff.
    renderReviewContextPrompt(changesetContextEntries(members)),
    ...members.flatMap((member) => member.diff.files.map((file) => [
      // vocab-ok: the agent prompt's wire format — the response parser reads these exact field names back
      `--- projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${file.newPath}`,
      file.diff,
    ].join('\n'))),
  ].filter((part) => part !== '').join('\n\n');
  return validateChangesetResponse(await runPrompt(modelId, prompt, options), members);
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
  const withPersona = [agent.instructions, prompt].filter((part) => part !== '').join('\n\n');
  return streamText(modelId, withPersona, options, (text, trace) => {
    trace.rawText(text, true);
    trace.success(0);
    return text.trim();
  });
}

export async function runPrompt(modelId: string, prompt: string, options?: RunAgentOptions): Promise<AgentReviewResponse> {
  return streamText(modelId, prompt, options, (text, trace) => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      trace.rawText(text, false, 'no JSON object found');
      throw new AgentResponseError('agent returned no JSON object');
    }
    let parsed: AgentReviewResponse;
    try {
      parsed = parseAgentReviewResponse(JSON.parse(text.slice(start, end + 1))).response;
    } catch (parseError) {
      trace.rawText(text, false, parseError instanceof Error ? parseError.message : String(parseError));
      throw parseError;
    }
    trace.rawText(text, true);
    trace.success(parsed.items.length);
    return parsed;
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
      trace.failure(message);
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
