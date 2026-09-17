import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agentRefresh.ts` is the shared half of the two panels that render the Run
 * AI Review screen. What is worth pinning here is that it composes discovery
 * and reconciliation the same way for both, and that it registers a watcher
 * on all four sources that can invalidate the pickers.
 */
const listeners = vi.hoisted(() => ({ create: 0, change: 0, del: 0, models: 0, config: 0 }));
const disposed = vi.hoisted(() => ({ count: 0 }));
const configHandlers = vi.hoisted(() => [] as Array<(e: { affectsConfiguration: (k: string) => boolean }) => void>);
/** Only `showDemoAgent` is set here; `agentLocations` keeps answering `[]` as it always did. */
const settings = vi.hoisted(() => ({ showDemoAgent: undefined as unknown }));

vi.mock('vscode', () => {
  const sub = (bump: () => void) => (handler: () => void) => {
    bump();
    return { dispose: () => { disposed.count += 1; }, handler };
  };
  return {
    FileType: { File: 1, Directory: 2 },
    Uri: { joinPath: (b: { path: string }, ...p: string[]) => ({ path: [b.path, ...p].join('/') }), file: (path: string) => ({ path }) },
    workspace: {
      workspaceFolders: [],
      getConfiguration: () => ({ get: (key: string) => (key === 'showDemoAgent' ? settings.showDemoAgent : []) }),
      fs: { readDirectory: async () => { throw new Error('ENOENT'); }, readFile: async () => new Uint8Array() },
      createFileSystemWatcher: () => ({
        dispose: () => { disposed.count += 1; },
        onDidCreate: sub(() => { listeners.create += 1; }),
        onDidChange: sub(() => { listeners.change += 1; }),
        onDidDelete: sub(() => { listeners.del += 1; }),
      }),
      onDidChangeConfiguration: (handler: (e: { affectsConfiguration: (k: string) => boolean }) => void) => {
        listeners.config += 1;
        configHandlers.push(handler);
        return { dispose: () => { disposed.count += 1; } };
      },
    },
    lm: {
      selectChatModels: async () => [{ vendor: 'copilot', family: 'gpt-5', name: 'GPT-5' }],
      onDidChangeChatModels: (handler: () => void) => {
        listeners.models += 1;
        return { dispose: () => { disposed.count += 1; }, handler };
      },
    },
    window: { createOutputChannel: () => ({ appendLine: () => {} }) },
  };
});

import { loadAgentSelection, watchAgentSources } from './agentRefresh';
import { BUILTIN_AGENT_ID } from '../app/agents';
import { DEMO_AGENT_ID } from '../app/demoAgent';
import { SAMPLE_DATA_PROVIDER_ID } from '../registry';

/** A pod on a real platform, holding no agent — the case every assertion below varies from. */
const REAL_POD = { providerId: 'gitlab' } as const;

describe('loadAgentSelection', () => {
  beforeEach(() => {
    settings.showDemoAgent = undefined;
  });

  it('always offers the built-in default review, even with no workspace and no agent files', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, REAL_POD);
    expect(state.agents.map((a) => a.id)).toEqual([BUILTIN_AGENT_ID]);
    expect(state.skippedAgents).toEqual([]);
  });

  it('picks the one available model for a model-backed agent', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, REAL_POD);
    expect(state.models.map((m) => m.id)).toEqual(['lm:copilot/gpt-5']);
    expect(state.modelId).toBe('lm:copilot/gpt-5');
  });

  it('leaves the demo agent with no model', async () => {
    const state = await loadAgentSelection({ agentId: DEMO_AGENT_ID }, REAL_POD);
    expect(state.modelId).toBeUndefined();
  });

  it('reconciles a stored agent that no longer exists, and says so', async () => {
    const state = await loadAgentSelection({ agentId: 'agent:ws/gone.agent.md' }, REAL_POD);
    expect(state.agentId).toBe(BUILTIN_AGENT_ID);
    expect(state.selectionNotices.join(' ')).toContain('agent:ws/gone.agent.md');
  });
});

/**
 * The demo agent invents findings from the diff without calling a model, so it
 * is a debugging tool rather than a review and does not belong one click away
 * in the picker. Hiding it is the default; these pin the default and the three
 * things that override it.
 */
describe('loadAgentSelection and the demo agent', () => {
  beforeEach(() => {
    settings.showDemoAgent = undefined;
  });

  it('is not offered with codeVerdict.showDemoAgent unset — the whole point of the setting', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, REAL_POD);
    expect(state.agents.map((a) => a.id)).not.toContain(DEMO_AGENT_ID);
  });

  it('is offered again, after the default review, with codeVerdict.showDemoAgent on', async () => {
    settings.showDemoAgent = true;
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, REAL_POD);
    expect(state.agents.map((a) => a.id)).toEqual([BUILTIN_AGENT_ID, DEMO_AGENT_ID]);
  });

  it('reads a non-boolean setting value as off rather than as a request to show it', async () => {
    settings.showDemoAgent = 'true';
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, REAL_POD);
    expect(state.agents.map((a) => a.id)).not.toContain(DEMO_AGENT_ID);
  });

  /**
   * Sharp because of what `reconcile` does with an agent id missing from the
   * list: it swaps the selection for the default review and pushes "The agent
   * X was not found". That sentence would be false — the agent exists, this
   * build just declined to list it — and the pod's stored choice would have
   * been changed without anyone asking. Asserting on the empty notices and on
   * the surviving `agentId`, not only on list membership, is what catches it.
   */
  it('stays listed and stays selected when the pod stores it, with the setting off, so no surface claims it was not found', async () => {
    const state = await loadAgentSelection({ agentId: DEMO_AGENT_ID }, { ...REAL_POD, agentId: DEMO_AGENT_ID });
    expect(state.agents.map((a) => a.id)).toContain(DEMO_AGENT_ID);
    expect(state.agentId).toBe(DEMO_AGENT_ID);
    expect(state.selectionNotices).toEqual([]);
  });

  /**
   * `refreshAgents` reconciles what the *panel* holds, which is not yet what
   * the pod stores — the pod is only written at run time. A reviewer who
   * picked the demo agent and then saved an agent file would otherwise watch
   * it vanish from the picker mid-selection.
   */
  it('stays listed when only the panel holds it, so a live refresh cannot drop the selection out of its own list', async () => {
    const state = await loadAgentSelection({ agentId: DEMO_AGENT_ID }, { ...REAL_POD, agentId: BUILTIN_AGENT_ID });
    expect(state.agents.map((a) => a.id)).toContain(DEMO_AGENT_ID);
    expect(state.agentId).toBe(DEMO_AGENT_ID);
    expect(state.selectionNotices).toEqual([]);
  });

  /**
   * The mirror of the test above, and the only one that exercises the
   * `pod.agentId` half of `selectedAgentIds` — both other decision-1 tests
   * pass the demo id as `persisted` as well, so dropping `pod.agentId` from
   * the visibility input leaves them green. The live case: the pod stores the
   * demo agent, the reviewer switches the picker to the default review
   * (`this.agentId`, written at once; `pod.agentId` only at run time), and a
   * saved agent file fires `refreshAgents` — without the pod half the demo
   * row disappears and there is no way back to the choice the pod still holds.
   */
  it('stays listed when only the pod stores it and the panel has moved off it, so a refresh cannot strip the pod its own stored choice', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, { ...REAL_POD, agentId: DEMO_AGENT_ID });
    expect(state.agents.map((a) => a.id)).toEqual([BUILTIN_AGENT_ID, DEMO_AGENT_ID]);
    expect(state.selectionNotices).toEqual([]);
  });

  /**
   * The sample-data pod's change requests exist in no repository and it is
   * what onboarding hands someone with no token. Every other agent needs a
   * chat model, and `renderRunReview` blocks the run when there is none — so
   * with the demo agent hidden there, that pod offers no review it can run.
   */
  it('is offered on the sample-data pod with the setting off, because it is the only model-free agent that pod has', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID }, { providerId: SAMPLE_DATA_PROVIDER_ID });
    expect(state.agents.map((a) => a.id)).toEqual([BUILTIN_AGENT_ID, DEMO_AGENT_ID]);
  });
});

describe('watchAgentSources', () => {
  beforeEach(() => {
    listeners.create = listeners.change = listeners.del = listeners.models = listeners.config = 0;
    disposed.count = 0;
    configHandlers.length = 0;
  });

  it('subscribes to all four sources that can invalidate the pickers', () => {
    watchAgentSources(() => {});
    expect(listeners).toMatchObject({ create: 1, change: 1, del: 1, models: 1, config: 1 });
  });

  it('hands back every subscription so a panel can dispose them', () => {
    const subs = watchAgentSources(() => {});
    // The watcher itself plus its three events, the model event, the config event.
    expect(subs).toHaveLength(6);
    for (const sub of subs) sub.dispose();
    expect(disposed.count).toBe(6);
  });

  /**
   * Both settings this module reads, and nothing else. `showDemoAgent` is in
   * here because a reader without a matching watch is a picker that ignores
   * the toggle until the window is reloaded — the failure mode is invisible
   * in a unit test of the reader alone.
   */
  it('reacts to each setting it reads — agentLocations and showDemoAgent — and to nothing else', () => {
    let fired = 0;
    watchAgentSources(() => { fired += 1; });
    configHandlers[0]?.({ affectsConfiguration: (key) => key === 'codeVerdict.agentLocations' });
    expect(fired).toBe(1);
    configHandlers[0]?.({ affectsConfiguration: (key) => key === 'codeVerdict.showDemoAgent' });
    expect(fired).toBe(2);
    configHandlers[0]?.({ affectsConfiguration: () => false });
    expect(fired).toBe(2);
  });
});
