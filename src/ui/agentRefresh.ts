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
import { builtInAgents, type AgentDescriptor, type ModelDescriptor } from '../app/agents';
import { discoverModels } from '../app/lmAgent';
import { reconcile, type Selection } from '../app/podSelection';
import { SAMPLE_DATA_PROVIDER_ID } from '../registry';
import { agentSearchRoots } from './agentLocations';

/** The setting that reveals the demo agent, and the key `watchAgentSources` re-discovers on. */
const SHOW_DEMO_AGENT_SETTING = 'showDemoAgent';

/**
 * Read here rather than in `app/agents.ts` on the `agentLocations.ts`
 * precedent: settings are read in the UI layer and handed down as plain data,
 * so the app layer never reaches for `workspace.getConfiguration`. It sits
 * beside `watchAgentSources` because the two have to name the same setting —
 * a reader added without its watch is a picker that ignores the toggle until
 * the window reloads.
 *
 * Anything that is not a boolean is a malformed setting, not a request to
 * show a debugging agent, so it reads as off.
 */
function readShowDemoAgent(): boolean {
  const value = vscode.workspace.getConfiguration('codeVerdict').get<unknown>(SHOW_DEMO_AGENT_SETTING);
  return typeof value === 'boolean' ? value : false;
}

/** What the pod contributes to the agent list: its provider, and the agent it has stored. */
export interface AgentSelectionPod {
  providerId: string;
  agentId?: string;
}

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
 *
 * `persisted` is the selection the caller is about to reconcile, which on a
 * refresh is what the panel holds rather than what the pod stored; both are
 * fed to `builtInAgents` so a demo agent that either of them names is listed
 * and `reconcile` never reports it missing.
 */
export async function loadAgentSelection(
  persisted: Selection,
  pod: AgentSelectionPod,
): Promise<AgentSelectionState> {
  const [discovered, models] = await Promise.all([discoverAgents(agentSearchRoots()), discoverModels()]);
  const agents = [
    ...builtInAgents({
      setting: readShowDemoAgent(),
      selectedAgentIds: [persisted.agentId, pod.agentId],
      podReviewsSampleData: pod.providerId === SAMPLE_DATA_PROVIDER_ID,
    }),
    ...discovered.agents,
  ];
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
 * The four things that can invalidate the pickers while the screen is open.
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
      if (
        event.affectsConfiguration('codeVerdict.agentLocations')
        || event.affectsConfiguration(`codeVerdict.${SHOW_DEMO_AGENT_SETTING}`)
      ) onChange();
    }),
  ];
}
