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
import { changesetHeadSha, validateChangesetResponse, type ChangesetAgentMember } from './combinedAgent';

const LM_PREFIX = 'lm:';
const TIMEOUT_MS = 90_000;

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
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

export async function runLmAgent(
  agentId: string,
  diff: ChangeRequestDiff,
  criteria: Criteria,
): Promise<AgentReviewResponse> {
  const prompt = [
    'You are a code review agent. Review ONLY the diffs below.',
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    ...diff.files.map((f) => `--- ${f.newPath}\n${f.diff}`),
  ].join('\n\n');
  return runPrompt(agentId, prompt);
}

export async function runLmChangesetAgent(
  agentId: string,
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
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
  return validateChangesetResponse(await runPrompt(agentId, prompt), members);
}

async function runPrompt(agentId: string, prompt: string): Promise<AgentReviewResponse> {
  const [vendor, family] = agentId.slice(LM_PREFIX.length).split('/');
  const requestId = Math.random().toString(16).slice(2, 8);
  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  if (!model) throw new AgentRunError(`Agent ${agentId} is no longer available`, requestId, false);

  const tokenSource = new vscode.CancellationTokenSource();
  const timeout = setTimeout(() => tokenSource.cancel(), TIMEOUT_MS);
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      tokenSource.token,
    );
    let text = '';
    for await (const fragment of response.text) {
      text += fragment;
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) {
      throw new AgentResponseError('agent returned no JSON object');
    }
    return parseAgentReviewResponse(JSON.parse(text.slice(start, end + 1))).response;
  } catch (e) {
    if (tokenSource.token.isCancellationRequested) {
      throw new AgentRunError(`timed out after ${TIMEOUT_MS / 1000}s`, requestId, true);
    }
    if (e instanceof AgentResponseError || e instanceof SyntaxError) {
      throw new AgentRunError(`agent response did not match the contract: ${e.message}`, requestId, false);
    }
    throw new AgentRunError(e instanceof Error ? e.message : String(e), requestId, false);
  } finally {
    clearTimeout(timeout);
    tokenSource.dispose();
  }
}
