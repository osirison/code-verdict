/**
 * Reading and reconciling the agent/model pair a pod holds
 * (spec: review-agents — "Selection is persisted per pod and migrated").
 *
 * Two pure functions, no `vscode` import, because every fallback they
 * describe is a scenario in the spec and each should be a unit test over
 * plain data rather than a panel test.
 */
import { BUILTIN_AGENT_ID, type AgentDescriptor, type ModelDescriptor } from './agents';
import { DEMO_AGENT_ID } from './demoAgent';

const LM_PREFIX = 'lm:';

export interface Selection {
  agentId: string;
  modelId?: string;
}

/** The stored shape, which may predate the agent/model split. */
export interface StoredSelection {
  agentId?: string;
  modelId?: string;
}

/**
 * Reads a pod forward into the current shape without writing anything.
 *
 * Before this split, `agentId` held a *model* id, because every chat model was
 * itself listed as an agent. Such a pod reads as the built-in agent paired
 * with the model it named, so a reviewer reopening it sees the same model
 * they chose, under a name that now means something different.
 *
 * The demo agent's id predates the whole scheme and is left exactly alone —
 * mapping it would strand every demo pod, which is the one case this
 * migration exists to avoid.
 */
export function selectionFromPod(pod: StoredSelection): Selection {
  const stored = pod.agentId ?? '';
  if (stored === DEMO_AGENT_ID) return { agentId: DEMO_AGENT_ID, modelId: undefined };
  // Any `lm:` value in `agentId` is a pre-split model id, whether or not a
  // `modelId` sits beside it. The two can coexist if an older build wrote
  // `agentId` over a pod a newer one had already migrated; passing the `lm:`
  // value through as an agent id would then surface as "the agent
  // lm:copilot/gpt-5 was not found", which names the wrong thing entirely.
  if (stored.startsWith(LM_PREFIX)) {
    return { agentId: BUILTIN_AGENT_ID, modelId: pod.modelId ?? stored };
  }
  return { agentId: stored === '' ? BUILTIN_AGENT_ID : stored, modelId: pod.modelId };
}

export interface Reconciled extends Selection {
  /**
   * What silently changed and why, shown on the Run AI Review screen rather
   * than as a toast: the screen holding the stale selection is where the
   * reviewer is looking.
   */
  notices: string[];
}

/**
 * Settles a stored selection against what actually exists right now. Run after
 * every discovery — startup, a file-system change, a model list change, a
 * settings change — so the two pickers never offer a selection that is gone.
 */
export function reconcile(
  persisted: Selection,
  discovered: { agents: readonly AgentDescriptor[]; models: readonly ModelDescriptor[] },
): Reconciled {
  const notices: string[] = [];

  let agentId = persisted.agentId;
  if (!discovered.agents.some((agent) => agent.id === agentId)) {
    if (agentId !== '' && agentId !== BUILTIN_AGENT_ID) {
      notices.push(`The agent "${agentId}" was not found, so the default review is selected.`);
    }
    agentId = BUILTIN_AGENT_ID;
  }

  const agent = discovered.agents.find((candidate) => candidate.id === agentId);

  // The demo agent calls no model, so it must not drag a model selection
  // along or report one as missing.
  if (agent?.source === 'demo') return { agentId, modelId: undefined, notices };

  let modelId = persisted.modelId;
  if (discovered.models.length === 0) {
    // Nothing to fall back to. Left unset so the screen can say why the run
    // is unavailable, rather than naming a model that does not exist.
    modelId = undefined;
  } else if (modelId === undefined || !discovered.models.some((model) => model.id === modelId)) {
    if (modelId !== undefined) {
      notices.push(`The model "${modelId}" is not available, so ${discovered.models[0]?.label} is selected.`);
    }
    modelId = discovered.models[0]?.id;
  }

  return { agentId, modelId, notices };
}

/**
 * The model an agent asks for, when it is available. A file may name a
 * preferred model; a reviewer who then picks a different one has overruled
 * it, so this only ever applies at the moment of selecting the agent.
 */
export function preferredModelFor(
  agent: AgentDescriptor | undefined,
  models: readonly ModelDescriptor[],
): { modelId?: string; notice?: string } {
  const preferred = agent?.preferredModelId;
  if (!preferred) return {};
  if (models.some((model) => model.id === preferred)) return { modelId: preferred };
  return { notice: `${agent?.label} prefers the model "${preferred}", which is not available.` };
}
