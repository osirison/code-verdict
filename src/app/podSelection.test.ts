import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_ID, type AgentDescriptor, type ModelDescriptor } from './agents';
import { DEMO_AGENT_ID } from './demoAgent';
import { preferredModelFor, reconcile, selectionFromPod } from './podSelection';

const model = (id: string, label = id): ModelDescriptor => ({
  id, label, description: '', vendor: 'copilot', family: id,
});
const agent = (id: string, extra: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  id, label: id, description: '', source: 'workspace', instructions: 'Review it.', ...extra,
});

const BUILTIN = agent(BUILTIN_AGENT_ID, { source: 'builtin' });
const DEMO = agent(DEMO_AGENT_ID, { source: 'demo', instructions: '' });

describe('selectionFromPod reads a stored pod forward', () => {
  it('reads a pre-migration `lm:` pod as the built-in agent plus that model', () => {
    // Before the split, `agentId` held a model id because every model was
    // listed as an agent. The reviewer must not lose the model they chose.
    expect(selectionFromPod({ agentId: 'lm:copilot/gpt-5' })).toEqual({
      agentId: BUILTIN_AGENT_ID,
      modelId: 'lm:copilot/gpt-5',
    });
  });

  it('leaves a pre-migration demo pod exactly alone', () => {
    // The demo agent's id predates the `agent:` scheme and is already
    // persisted. Re-mapping it would strand every demo pod — the one case
    // this migration exists to avoid.
    expect(selectionFromPod({ agentId: DEMO_AGENT_ID })).toEqual({
      agentId: DEMO_AGENT_ID,
      modelId: undefined,
    });
  });

  it('passes a post-migration pod through unchanged', () => {
    expect(selectionFromPod({ agentId: 'agent:workspace-x/sec.agent.md', modelId: 'lm:copilot/gpt-5' })).toEqual({
      agentId: 'agent:workspace-x/sec.agent.md',
      modelId: 'lm:copilot/gpt-5',
    });
  });

  it('reads an empty pod as the built-in agent', () => {
    expect(selectionFromPod({}).agentId).toBe(BUILTIN_AGENT_ID);
  });

  it('does not mutate the pod it reads', () => {
    const pod = { agentId: 'lm:copilot/gpt-5' };
    const before = JSON.stringify(pod);
    selectionFromPod(pod);
    expect(JSON.stringify(pod)).toBe(before);
  });
});

describe('reconcile settles a selection against what exists', () => {
  const models = [model('lm:copilot/gpt-5', 'GPT-5'), model('lm:copilot/sonnet', 'Sonnet')];

  it('keeps a selection that is still valid, with no notices', () => {
    const sec = agent('agent:ws/sec.agent.md');
    const result = reconcile(
      { agentId: sec.id, modelId: 'lm:copilot/sonnet' },
      { agents: [BUILTIN, sec], models },
    );
    expect(result).toEqual({ agentId: sec.id, modelId: 'lm:copilot/sonnet', notices: [] });
  });

  it('falls back to the built-in agent when the selected agent is gone, and says which', () => {
    const result = reconcile(
      { agentId: 'agent:ws/deleted.agent.md', modelId: 'lm:copilot/gpt-5' },
      { agents: [BUILTIN], models },
    );
    expect(result.agentId).toBe(BUILTIN_AGENT_ID);
    expect(result.notices.join(' ')).toContain('agent:ws/deleted.agent.md');
  });

  it('falls back to the first model when the selected model is gone, and says which', () => {
    const result = reconcile(
      { agentId: BUILTIN_AGENT_ID, modelId: 'lm:copilot/retired' },
      { agents: [BUILTIN], models },
    );
    expect(result.modelId).toBe('lm:copilot/gpt-5');
    expect(result.notices.join(' ')).toContain('lm:copilot/retired');
  });

  it('leaves the model unset when none is available, without inventing a notice about it', () => {
    const result = reconcile({ agentId: BUILTIN_AGENT_ID, modelId: undefined }, { agents: [BUILTIN], models: [] });
    expect(result.modelId).toBeUndefined();
    expect(result.notices).toEqual([]);
  });

  it('picks a model on a first run rather than leaving it unset', () => {
    const result = reconcile({ agentId: BUILTIN_AGENT_ID, modelId: undefined }, { agents: [BUILTIN], models });
    expect(result.modelId).toBe('lm:copilot/gpt-5');
    // Nothing was lost, so nothing is reported.
    expect(result.notices).toEqual([]);
  });

  it('never drags a model onto the demo agent', () => {
    const result = reconcile({ agentId: DEMO_AGENT_ID, modelId: 'lm:copilot/gpt-5' }, { agents: [DEMO], models });
    expect(result).toEqual({ agentId: DEMO_AGENT_ID, modelId: undefined, notices: [] });
  });

  it('reports the agent and the model separately when both are gone', () => {
    const result = reconcile(
      { agentId: 'agent:ws/gone.agent.md', modelId: 'lm:copilot/gone' },
      { agents: [BUILTIN], models },
    );
    expect(result.notices).toHaveLength(2);
  });

  it('an agent from a removed location falls back like any other missing agent', () => {
    // Removing a configured location deletes every agent under it; the
    // selection has to survive that without an error.
    const result = reconcile(
      { agentId: 'agent:location-home-agents/sec.agent.md', modelId: 'lm:copilot/gpt-5' },
      { agents: [BUILTIN], models },
    );
    expect(result.agentId).toBe(BUILTIN_AGENT_ID);
    expect(result.modelId).toBe('lm:copilot/gpt-5');
  });
});

describe('preferredModelFor', () => {
  const models = [model('lm:copilot/gpt-5')];

  it('applies a preferred model that is available', () => {
    expect(preferredModelFor(agent('a', { preferredModelId: 'lm:copilot/gpt-5' }), models))
      .toEqual({ modelId: 'lm:copilot/gpt-5' });
  });

  it('leaves the selection alone and explains when the preferred model is unavailable', () => {
    const result = preferredModelFor(agent('a', { preferredModelId: 'lm:copilot/opus' }), models);
    expect(result.modelId).toBeUndefined();
    expect(result.notice).toContain('lm:copilot/opus');
  });

  it('does nothing for an agent that names no model', () => {
    expect(preferredModelFor(agent('a'), models)).toEqual({});
  });
});
