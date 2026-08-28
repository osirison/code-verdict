import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `agentRefresh.ts` is the shared half of the two panels that render the Run
 * AI Review screen. What is worth pinning here is that it composes discovery
 * and reconciliation the same way for both, and that it registers a watcher
 * on all three sources that can invalidate the pickers.
 */
const listeners = vi.hoisted(() => ({ create: 0, change: 0, del: 0, models: 0, config: 0 }));
const disposed = vi.hoisted(() => ({ count: 0 }));
const configHandlers = vi.hoisted(() => [] as Array<(e: { affectsConfiguration: (k: string) => boolean }) => void>);

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
      getConfiguration: () => ({ get: () => [] }),
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

describe('loadAgentSelection', () => {
  it('always offers the built-ins, even with no workspace and no agent files', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID });
    expect(state.agents.map((a) => a.id)).toEqual([BUILTIN_AGENT_ID, DEMO_AGENT_ID]);
    expect(state.skippedAgents).toEqual([]);
  });

  it('picks the one available model for a model-backed agent', async () => {
    const state = await loadAgentSelection({ agentId: BUILTIN_AGENT_ID });
    expect(state.models.map((m) => m.id)).toEqual(['lm:copilot/gpt-5']);
    expect(state.modelId).toBe('lm:copilot/gpt-5');
  });

  it('leaves the demo agent with no model', async () => {
    const state = await loadAgentSelection({ agentId: DEMO_AGENT_ID });
    expect(state.modelId).toBeUndefined();
  });

  it('reconciles a stored agent that no longer exists, and says so', async () => {
    const state = await loadAgentSelection({ agentId: 'agent:ws/gone.agent.md' });
    expect(state.agentId).toBe(BUILTIN_AGENT_ID);
    expect(state.selectionNotices.join(' ')).toContain('agent:ws/gone.agent.md');
  });
});

describe('watchAgentSources', () => {
  beforeEach(() => {
    listeners.create = listeners.change = listeners.del = listeners.models = listeners.config = 0;
    disposed.count = 0;
    configHandlers.length = 0;
  });

  it('subscribes to all three sources that can invalidate the pickers', () => {
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

  it('reacts only to its own setting changing', () => {
    let fired = 0;
    watchAgentSources(() => { fired += 1; });
    configHandlers[0]?.({ affectsConfiguration: (key) => key === 'codeVerdict.agentLocations' });
    expect(fired).toBe(1);
    configHandlers[0]?.({ affectsConfiguration: () => false });
    expect(fired).toBe(1);
  });
});
