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
import type { AgentDescriptor } from './agents';
import { AgentTrace, type AgentProgressCallback, type AgentTimeoutReason, type AgentTraceSink } from './agentTrace';
import { changesetHeadSha, validateChangesetResponse, type ChangesetAgentMember } from './combinedAgent';

export type { AgentProgressCallback, AgentRunProgress, AgentTraceSink } from './agentTrace';

const LM_PREFIX = 'lm:';

// Issue #36: a flat total-duration timeout cancels a review that is still
// actively streaming — a large diff on a slower model easily runs past 90s
// with the model working the whole time. Split into two independent limits:
//
// - INACTIVITY: reset on every fragment. A model that keeps producing
//   output keeps the request alive no matter how long the run takes overall.
//   The issue's own worked example is a model that streams one fragment
//   every ~60s; 90s gives that pattern real margin (not a knife's-edge tie)
//   while still recovering a genuinely stuck request in reasonable time.
//   It is also strictly more forgiving than the old flat 90s cutoff — any
//   run the old code allowed to finish, this allows too.
// - CEILING: an absolute backstop that is *not* reset by activity, so a
//   model that streams filler forever (or a run that's just pathologically
//   large) can't hold the extension open indefinitely. 10 minutes is
//   generous enough that a real, healthy review — even a large multi-file
//   diff — should never hit it; if it does, something is actually wrong.
export const INACTIVITY_TIMEOUT_MS = 90_000;
export const CEILING_TIMEOUT_MS = 10 * 60_000;

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
}

export async function discoverLmAgents(): Promise<AgentDescriptor[]> {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({
      id: `${LM_PREFIX}${m.vendor}/${m.family}`,
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      source: 'copilot' as const,
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
    /** Set only when `timedOut` — which of the two limits (see above) cancelled the run. */
    readonly timeoutReason?: AgentTimeoutReason,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export async function runLmAgent(
  agentId: string,
  diff: ChangeRequestDiff,
  criteria: Criteria,
  options?: RunAgentOptions,
): Promise<AgentReviewResponse> {
  const prompt = [
    'You are a code review agent. Review ONLY the diffs below.',
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    ...diff.files.map((f) => `--- ${f.newPath}\n${f.diff}`),
  ].join('\n\n');
  return runPrompt(agentId, prompt, options);
}

export async function runLmChangesetAgent(
  agentId: string,
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
  options?: RunAgentOptions,
): Promise<AgentReviewResponse> {
  const headSha = changesetHeadSha(members);
  const contract = '{ "id", "projectId", "mrIid", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "cross"?: true, "spans"?: [{"projectId","location","role"}], "suggestion"?: {"old","new"} }';
  const prompt = [
    'You are a code review agent. Review this changeset as one distributed unit. Review ONLY the labelled diffs below.',
    'Find both normal per-repository issues and failures that exist only between repositories. A cross-repository item must set cross=true and name both sides in spans[].',
    `Respond with one JSON object: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": ${JSON.stringify(headSha)}, "items": [${contract}], "candidates": [] }`,
    'Every item must use the exact projectId and mrIid labels supplied below. The file and line must identify an added line in that member diff.',
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    ...members.flatMap((member) => member.diff.files.map((file) => [
      // vocab-ok: the agent prompt's wire format — the response parser reads these exact field names back
      `--- projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${file.newPath}`,
      file.diff,
    ].join('\n'))),
  ].join('\n\n');
  return validateChangesetResponse(await runPrompt(agentId, prompt, options), members);
}

export async function runPrompt(agentId: string, prompt: string, options?: RunAgentOptions): Promise<AgentReviewResponse> {
  const [vendor, family] = agentId.slice(LM_PREFIX.length).split('/');
  const requestId = Math.random().toString(16).slice(2, 8);
  const trace = new AgentTrace(options?.trace ?? defaultTraceSink(), requestId, vendor ?? '', family ?? '');
  trace.prompt(prompt);

  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  if (!model) {
    const message = `Agent ${agentId} is no longer available`;
    trace.failure(message);
    throw new AgentRunError(message, requestId, false);
  }

  const tokenSource = new vscode.CancellationTokenSource();
  let timeoutReason: AgentTimeoutReason | undefined;
  const scheduleTimeout = (reason: AgentTimeoutReason, ms: number) =>
    setTimeout(() => {
      timeoutReason = reason;
      tokenSource.cancel();
    }, ms);

  const ceiling = scheduleTimeout('ceiling', CEILING_TIMEOUT_MS);
  let inactivity = scheduleTimeout('inactivity', INACTIVITY_TIMEOUT_MS);
  const resetInactivity = () => {
    clearTimeout(inactivity);
    inactivity = scheduleTimeout('inactivity', INACTIVITY_TIMEOUT_MS);
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
      resetInactivity();
      const progress = trace.fragment(fragment);
      options?.onProgress?.(progress);
    }
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
  } catch (e) {
    if (tokenSource.token.isCancellationRequested) {
      const message =
        timeoutReason === 'ceiling'
          ? `agent exceeded the ${CEILING_TIMEOUT_MS / 1000}s overall time limit`
          : `agent stalled: no output for ${INACTIVITY_TIMEOUT_MS / 1000}s`;
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
    tokenSource.dispose();
  }
}
