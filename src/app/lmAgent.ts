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
  const [vendor, family] = agentId.slice(LM_PREFIX.length).split('/');
  const requestId = Math.random().toString(16).slice(2, 8);
  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  if (!model) throw new AgentRunError(`Agent ${agentId} is no longer available`, requestId, false);

  const prompt = [
    'You are a code review agent. Review ONLY the diffs below.',
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    ...diff.files.map((f) => `--- ${f.newPath}\n${f.diff}`),
  ].join('\n\n');

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
