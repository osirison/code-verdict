/**
 * Discovery, reconciliation and live-update wiring for the agent/model pair,
 * shared by the two panels that render the Run AI Review screen
 * (`reviewFlow.ts` and `changesetReview.ts`).
 *
 * It lives here rather than in either panel because both show the same
 * screen: an agent file appearing on disk has to reach whichever of them is
 * open, and a second copy of this logic would drift into two screens that
 * answer the same question differently.
 */
import * as vscode from 'vscode';
import { AGENT_FILE_SUFFIX, discoverAgents, type SkippedDefinition } from '../app/agentDefinitions';
import { BUILT_IN_AGENTS, type AgentDescriptor, type ModelDescriptor } from '../app/agents';
import { discoverModels } from '../app/lmAgent';
import { reconcile, type Selection } from '../app/podSelection';
import { agentSearchRoots } from './agentLocations';

export interface AgentSelectionState {
  agents: AgentDescriptor[];
  models: ModelDescriptor[];
  skippedAgents: SkippedDefinition[];
  agentId: string;
  modelId?: string;
  selectionNotices: string[];
}

/**
 * Everything the pickers need, settled against what exists right now. Run at
 * load and again on every change — the reconciliation is the same either way,
 * so there is no first-time path to get wrong.
 */
export async function loadAgentSelection(persisted: Selection): Promise<AgentSelectionState> {
  const [discovered, models] = await Promise.all([discoverAgents(agentSearchRoots()), discoverModels()]);
  const agents = [...BUILT_IN_AGENTS, ...discovered.agents];
  const settled = reconcile(persisted, { agents, models });
  return {
    agents,
    models,
    skippedAgents: discovered.skipped,
    agentId: settled.agentId,
    modelId: settled.modelId,
    selectionNotices: settled.notices,
  };
}

/**
 * The three things that can invalidate the pickers while the screen is open.
 * The caller disposes what comes back when its panel goes away.
 */
export function watchAgentSources(onChange: () => void): vscode.Disposable[] {
  const watcher = vscode.workspace.createFileSystemWatcher(`**/*${AGENT_FILE_SUFFIX}`);
  return [
    watcher,
    watcher.onDidCreate(onChange),
    watcher.onDidChange(onChange),
    watcher.onDidDelete(onChange),
    vscode.lm.onDidChangeChatModels(onChange),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('codeVerdict.agentLocations')) onChange();
    }),
  ];
}
