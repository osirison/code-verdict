/**
 * The settings panel's live checks (task 3.1-3.4): `testConnection()` and the
 * agent-location filesystem scan run on open and on the explicit re-test
 * control only — never as a side effect of an unrelated message, which is
 * what made every checkbox toggle issue a live connection test before this
 * change.
 *
 * Driven through the real panel and `AppSurface` against a mocked `vscode`,
 * the way the reviewer does — the panel's held state is never poked directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodStore } from '../app/pods';
import type { SecretStore } from '../app/storage';
import type { ScmProvider } from '../platform/provider';
import { clearProviders, registerProvider } from '../platform/registry';
import { GITHUB_VOCABULARY } from '../testing/specFixtures';
import type { SettingsPanelDeps } from './settings';

// ---- vscode and module mocks ---------------------------------------------------

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

const panel = vi.hoisted(() => ({
  title: '',
  reveal: vi.fn(),
  webview: {
    html: '',
    postMessage: vi.fn(),
    onDidReceiveMessage: (handler: (message: unknown) => void) => {
      handlers.message = handler;
      return { dispose: vi.fn() };
    },
  },
  onDidDispose: (handler: () => void) => {
    handlers.dispose = handler;
    return { dispose: vi.fn() };
  },
}));

/** A flat backing map keyed by the relative setting name, mirroring how `settings.ts` always reads/writes through `getConfiguration('codeVerdict')`. */
const configBacking = vi.hoisted(() => new Map<string, unknown>());

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  ConfigurationTarget: { Global: 1 },
  window: {
    createWebviewPanel: () => panel,
    showOpenDialog: vi.fn(() => Promise.resolve(undefined)),
  },
  workspace: {
    workspaceFolders: [{ name: 'demo', uri: { fsPath: '/ws' } }],
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (configBacking.has(key) ? configBacking.get(key) : fallback),
      update: (key: string, value: unknown) => {
        configBacking.set(key, value);
        return Promise.resolve();
      },
    }),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  Uri: {
    joinPath: (base: { fsPath: string }, ...segments: string[]) => ({ fsPath: [base.fsPath, ...segments].join('/') }),
    file: (p: string) => ({ fsPath: p }),
  },
}));

const world = vi.hoisted(() => ({
  testConnection: vi.fn(),
  discoverAgents: vi.fn(),
}));

// The live connection check — the one this change confines to open and the
// explicit re-test control.
vi.mock('../app/connections', () => ({
  connectionForPod: () => Promise.resolve({ testConnection: world.testConnection }),
}));

// The live filesystem scan — confined the same way, except for the two
// agent-location messages, which are what the scan exists to serve.
vi.mock('../app/agentDefinitions', () => ({
  DEFAULT_AGENT_DIRECTORY: '.github/agents',
  discoverAgents: (roots: unknown) => world.discoverAgents(roots),
}));

// ---- fixtures --------------------------------------------------------------------

const PROVIDER = {
  id: 'test',
  displayName: 'GitHub',
  vocabulary: GITHUB_VOCABULARY,
  capabilities: {},
  authModesFor: () => ['token'],
  connect: () => {
    throw new Error('the connection is mocked');
  },
} as unknown as ScmProvider;

function pod() {
  return {
    id: 'pod-1',
    name: 'Pod',
    providerId: 'test',
    instanceUrl: 'https://example.test',
    sources: [],
    repos: [],
    username: 'you',
  };
}

function makeDeps(): { deps: SettingsPanelDeps } {
  const secrets: SecretStore = {
    get: () => Promise.resolve('secret-token'),
    store: () => Promise.resolve(),
    delete: () => Promise.resolve(),
  };
  const podStore = { activePod: pod() };
  return { deps: { podStore: podStore as unknown as PodStore, secrets } };
}

/** Drains the microtasks the panel's `await`-chained message handling needs. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type RegionsMessage = { type: 'verdict:regions'; regions: Record<string, string> };

function lastPosted(): RegionsMessage {
  return panel.webview.postMessage.mock.calls.at(-1)?.[0] as RegionsMessage;
}

beforeEach(() => {
  clearProviders();
  registerProvider(PROVIDER);
  panel.webview.html = '';
  panel.webview.postMessage.mockClear();
  configBacking.clear();
  world.testConnection.mockReset();
  world.testConnection.mockResolvedValue({ ok: true, username: 'you', scopes: ['api'] });
  world.discoverAgents.mockReset();
  world.discoverAgents.mockResolvedValue({ agents: [], skipped: [] });
});

afterEach(() => {
  // Dispose the surface so the next test builds a fresh panel and route —
  // `AppSurface`'s and `SettingsPanel`'s statics otherwise survive test
  // boundaries in the same module instance.
  handlers.dispose?.();
  handlers.message = undefined;
});

describe('SettingsPanel — the connection test and the agent scan run only on open and re-test', () => {
  it('opening the panel tests the connection exactly once and shows the result', async () => {
    const { deps } = makeDeps();
    const { SettingsPanel } = await import('./settings.js');

    await SettingsPanel.show(deps);

    expect(world.testConnection).toHaveBeenCalledTimes(1);
    expect(world.discoverAgents).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain('connected as @you');
  });

  it('a setting toggle issues zero platform calls and leaves the shown connection status unchanged', async () => {
    const { deps } = makeDeps();
    const { SettingsPanel } = await import('./settings.js');
    await SettingsPanel.show(deps);
    expect(panel.webview.html).toContain('connected as @you');

    // Arm the route so the panel patches regions instead of falling back to
    // a full setHtml — the shape every migrated screen already uses.
    handlers.message?.({ type: 'verdictReady' });
    panel.webview.postMessage.mockClear();
    world.testConnection.mockClear();
    world.discoverAgents.mockClear();
    // If the toggle re-tested the connection, this would show up below —
    // it must not, so the mock is switched to a result the toggle must not
    // pick up.
    world.testConnection.mockResolvedValue({ ok: false, error: { message: 'connection failed' } });

    handlers.message?.({ type: 'setQuietMode', value: true });
    await flush();

    expect(world.testConnection).not.toHaveBeenCalled();
    expect(world.discoverAgents).not.toHaveBeenCalled();
    const posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    // Only the regions a quiet-hours toggle actually affects were patched —
    // the connection region was not touched, so whatever it showed stays.
    expect(Object.keys(posted.regions).sort()).toEqual(['set-json', 'set-notifications']);
    expect(posted.regions['set-notifications']).toContain('Only blockers and direct mentions interrupt you.');
    // The preview region was patched with the new value, not just included
    // (the pre block is HTML-escaped, so quotes render as entities).
    expect(posted.regions['set-json']).toContain('&quot;codeVerdict.notifications.quietMode&quot;: true');
    expect(panel.webview.html).toContain('connected as @you');
    expect(panel.webview.html).not.toContain('connection failed');
  });

  it('the explicit re-test control does call testConnection, and only then does the status change', async () => {
    const { deps } = makeDeps();
    const { SettingsPanel } = await import('./settings.js');
    await SettingsPanel.show(deps);
    handlers.message?.({ type: 'verdictReady' });
    world.testConnection.mockClear();
    world.discoverAgents.mockClear();
    world.testConnection.mockResolvedValue({ ok: false, error: { message: 'connection failed' } });

    handlers.message?.({ type: 'testConnection' });
    await flush();

    expect(world.testConnection).toHaveBeenCalledTimes(1);
    expect(world.discoverAgents).toHaveBeenCalledTimes(1);
    const posted = lastPosted();
    // Every region, not just connection/agents — re-test is also the only
    // remaining path that picks up a config edit made outside this page
    // while it was already open (see `testLiveState`'s comment).
    expect(Object.keys(posted.regions).sort()).toEqual(
      ['set-agents', 'set-connection', 'set-json', 'set-notifications', 'set-privacy'].sort(),
    );
    expect(posted.regions['set-connection']).toContain('connection failed');
  });

  it('rotating the token does not test the connection', async () => {
    const { deps } = makeDeps();
    const { SettingsPanel } = await import('./settings.js');
    await SettingsPanel.show(deps);
    handlers.message?.({ type: 'verdictReady' });
    world.testConnection.mockClear();
    world.discoverAgents.mockClear();

    handlers.message?.({ type: 'rotateToken' });
    await flush();

    expect(world.testConnection).not.toHaveBeenCalled();
    expect(world.discoverAgents).not.toHaveBeenCalled();
  });

  it('adding or removing an agent location re-scans (it is what the action is about) but never tests the connection', async () => {
    const { deps } = makeDeps();
    const { SettingsPanel } = await import('./settings.js');
    await SettingsPanel.show(deps);
    handlers.message?.({ type: 'verdictReady' });
    world.testConnection.mockClear();
    world.discoverAgents.mockClear();
    world.discoverAgents.mockResolvedValue({ agents: [{ id: 'a1' }, { id: 'a2' }], skipped: [] });

    handlers.message?.({ type: 'removeAgentLocation', label: '.github/agents' });
    await flush();

    expect(world.testConnection).not.toHaveBeenCalled();
    expect(world.discoverAgents).toHaveBeenCalledTimes(1);
    const posted = lastPosted();
    expect(Object.keys(posted.regions).sort()).toEqual(['set-agents']);
    expect(posted.regions['set-agents']).toContain('2 agents');
  });
});
