/**
 * The changeset review screen patches in place (tasks 7.2, 7.7): it shares
 * `renderReviewFlowBody` and the `flow-body` region with the migrated single-CR
 * flow, so a verdict or a screen transition patches that region instead of
 * rebuilding the document, with `setHtml` kept as the first-paint and reload
 * fallback.
 *
 * Driven through the real `ChangesetReviewPanel` on the real `AppSurface`
 * against a fake connection that counts calls — the sibling harness to
 * `appStoreWiring.test.ts`, which drives `ChangesetPanel` the same way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENT_DESCRIPTOR } from '../app/agents';
import { changesetDraftKeyFor, retainedFromRun, type ChangesetDraft } from '../app/retainedReview';
import type { ReviewRunManager } from '../app/reviewRunManager';
import type { PodStore } from '../app/pods';
import type { KeyValueStore } from '../app/storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod, Review } from '../domain/types';
import type { ChangeRequest } from '../platform/types';

const world = vi.hoisted(() => ({
  calls: { changeRequests: 0, workItems: 0, ciRuns: 0, diffs: 0 },
  crs: [] as ChangeRequest[],
}));

/** The one `AppSurface` panel, with every full `webview.html` assignment logged. */
const panel = vi.hoisted(() => {
  const state = {
    htmlLog: [] as string[],
    messageHandler: undefined as ((message: unknown) => void) | undefined,
  };
  return {
    state,
    title: '',
    active: true,
    reveal: (): void => undefined,
    webview: {
      get html(): string {
        return state.htmlLog.at(-1) ?? '';
      },
      set html(value: string) {
        state.htmlLog.push(value);
      },
      postMessage: vi.fn(),
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        state.messageHandler = handler;
        return { dispose: (): void => undefined };
      },
    },
    onDidDispose: () => ({ dispose: (): void => undefined }),
  };
});

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: () => panel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    onDidChangeWindowState: () => ({ dispose: (): void => undefined }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
    workspaceFolders: [],
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn(() => Promise.resolve(undefined)) } },
  Uri: { joinPath: (...segments: unknown[]) => segments, parse: (value: string) => value },
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      listOpenChangeRequests: async () => {
        world.calls.changeRequests += 1;
        return [...world.crs];
      },
      listWorkItems: async () => {
        world.calls.workItems += 1;
        return [];
      },
      listCiRuns: async () => {
        world.calls.ciRuns += 1;
        return [];
      },
      getChangeRequestDiff: async (ref: { repoId: string; number: string }) => {
        world.calls.diffs += 1;
        return { ref, headSha: 'head', files: [], anchorRefs: undefined };
      },
    }),
}));

// Discovery walks the filesystem and `vscode.lm`; a fixed selection is enough.
vi.mock('./agentRefresh', () => ({
  loadAgentSelection: () =>
    Promise.resolve({
      agents: [BUILTIN_AGENT_DESCRIPTOR],
      models: [{ id: 'lm:acme/turbo', label: 'Turbo' }],
      skippedAgents: [],
      agentId: BUILTIN_AGENT_DESCRIPTOR.id,
      modelId: 'lm:acme/turbo',
      selectionNotices: [],
    }),
  watchAgentSources: () => [],
}));

const CHANGESET_ID = 'manual:tenant1';
const MEMBER_REFS = [
  { repoId: 'acme/repo', number: '7' },
  { repoId: 'acme/repo', number: '8' },
];

function changeRequest(number: string, title: string): ChangeRequest {
  return {
    ref: { repoId: 'acme/repo', number },
    title,
    state: 'open',
    sourceBranch: `feat/${number}`,
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: `https://example.test/pr/${number}`,
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: 'aaaa',
  };
}

function pod(): Pod {
  return {
    id: 'pod-1',
    name: 'Platform squad',
    providerId: 'github',
    instanceUrl: 'https://github.example',
    sources: [{ kind: 'repository', repoId: 'acme/repo' }],
    criteria: structuredClone(DEFAULT_CRITERIA),
    agentId: '',
    repos: [{ id: 'acme/repo', path: 'acme/repo', name: 'repo' }],
    username: 'me',
  };
}

function memoryKv(seed: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

/** A finished changeset run's record, as the run manager writes it. */
function retainedChangesetRecord(): ChangesetDraft {
  const review: Review = {
    repoId: 'changeset',
    crNumber: CHANGESET_ID,
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    modelId: 'lm:acme/turbo',
    criteria: structuredClone(DEFAULT_CRITERIA),
    // The composite head the members will read back as, so the restored
    // draft is not marked stale.
    headSha: 'acme/repo!7:head|acme/repo!8:head',
    items: [
      {
        id: 'i1',
        anchored: true,
        file: 'src/limits.ts',
        line: 3,
        severity: 'major',
        category: 'security',
        confidence: 90,
        title: 'Rate limit window is per instance',
        body: 'Body',
        code: 'const w = 1;',
        repoId: 'acme/repo',
        crNumber: '7',
      },
      {
        id: 'i2',
        anchored: true,
        file: 'src/gateway.ts',
        line: 9,
        severity: 'minor',
        category: 'style',
        confidence: 80,
        title: 'Gateway retries without jitter',
        body: 'Body',
        code: 'retry()',
        repoId: 'acme/repo',
        crNumber: '8',
      },
    ],
    verdicts: {},
    summary: '',
  };
  return retainedFromRun({
    review,
    ranAt: '2026-09-01T10:14:00.000Z',
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    agentLabel: 'Security Reviewer',
    modelId: 'lm:acme/turbo',
  });
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeRuns(): ReviewRunManager {
  return {
    subscribe: () => ({ dispose: (): void => undefined }),
    get: () => undefined,
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    trigger: vi.fn(),
  } as unknown as ReviewRunManager;
}

async function openPanel() {
  const activePod = pod();
  const podStore = { activePod, list: () => [activePod] } as unknown as PodStore;
  const { AppStore } = await import('../app/appStore.js');
  const appStore = new AppStore({
    podStore,
    secrets: {} as never,
    reviewHistory: { list: () => [] } as never,
    baseSeconds: () => 60,
  });
  const workspaceState = memoryKv({ [changesetDraftKeyFor(CHANGESET_ID)]: retainedChangesetRecord() });
  const globalState = memoryKv({
    'codeVerdict.manualChangesets': {
      'pod-1': [{ id: CHANGESET_ID, name: 'Tenant limits', members: MEMBER_REFS }],
    },
  });
  const { ChangesetReviewPanel } = await import('./changesetReview.js');
  await ChangesetReviewPanel.open(
    {
      podStore,
      appStore,
      secrets: {} as never,
      workspaceState,
      globalState,
      runs: fakeRuns(),
      openSingle: () => undefined,
      openDashboard: () => undefined,
    },
    CHANGESET_ID,
  );
  await flush();
  return { workspaceState };
}

function lastPosted(): { type: string; regions: Record<string, string> } {
  return panel.webview.postMessage.mock.calls.at(-1)?.[0] as { type: string; regions: Record<string, string> };
}

beforeEach(async () => {
  vi.resetModules();
  const { clearProviders } = await import('../platform/registry.js');
  const { registerBuiltInProviders } = await import('../registry.js');
  clearProviders();
  registerBuiltInProviders();
  world.calls = { changeRequests: 0, workItems: 0, ciRuns: 0, diffs: 0 };
  world.crs = [
    changeRequest('7', 'Add per-tenant rate limiting'),
    changeRequest('8', 'Enforce the limit at the gateway'),
  ];
  panel.state.htmlLog.length = 0;
  panel.state.messageHandler = undefined;
  panel.webview.postMessage.mockClear();
});

describe('the changeset review screen patches in place (tasks 7.2, 7.7)', () => {
  it('opens on a loading paint, then the retained triage, both as full documents before the page is armed', async () => {
    await openPanel();

    // First paint (task 7.6): the loading document, named after the
    // changeset, assigned before the store read and the member diffs.
    expect(panel.state.htmlLog.length).toBe(2);
    expect(panel.state.htmlLog[0]).toContain(CHANGESET_ID);
    expect(panel.state.htmlLog[0]).toContain('Platform squad');
    // Then the retained review, still a full assignment — the page has not
    // signalled `verdictReady`, so a patch has nothing armed to receive it.
    expect(panel.state.htmlLog[1]).toContain('Rate limit window is per instance');
    // One pod fetch plus one diff per member.
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1, diffs: 2 });
  });

  it('once armed, a verdict patches flow-body — no document reassignment, no platform call', async () => {
    await openPanel();
    panel.state.messageHandler?.({ type: 'verdictReady' });
    const assignmentsBefore = panel.state.htmlLog.length;
    const callsBefore = { ...world.calls };
    panel.webview.postMessage.mockClear();

    panel.state.messageHandler?.({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await flush();

    const posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    expect(Object.keys(posted.regions).sort()).toEqual(['app-crumb-current', 'flow-body']);
    // The patched body carries the recorded verdict (1 of 2 decided) — the
    // next finding is selected, and the progress indicator (spec: "the
    // finding list, the current finding and the progress indicators
    // update") counts the same decision.
    expect(posted.regions['flow-body']).toContain('Gateway retries without jitter');
    expect(posted.regions['flow-body']).toContain('1 of 2 triaged');
    expect(posted.regions['flow-body']).not.toContain('0 of 2 triaged');
    // Patched, not rebuilt; and a verdict is local state — nothing fetched.
    expect(panel.state.htmlLog.length).toBe(assignmentsBefore);
    expect(world.calls).toEqual(callsBefore);
  });

  it('moving between findings patches the same way, immediately and without any fetch', async () => {
    await openPanel();
    panel.state.messageHandler?.({ type: 'verdictReady' });
    const assignmentsBefore = panel.state.htmlLog.length;
    const callsBefore = { ...world.calls };
    panel.webview.postMessage.mockClear();

    panel.state.messageHandler?.({ type: 'move', delta: 1 });
    await flush();

    expect(lastPosted().type).toBe('verdict:regions');
    expect(panel.state.htmlLog.length).toBe(assignmentsBefore);
    expect(world.calls).toEqual(callsBefore);
  });

  it('a webview reload falls back to a full setHtml, restoring the triage already in memory', async () => {
    await openPanel();
    panel.state.messageHandler?.({ type: 'verdictReady' });
    const assignmentsBefore = panel.state.htmlLog.length;
    const callsBefore = { ...world.calls };

    // A second `verdictReady` while armed is the recreated-document signal
    // (see AppSurface): readiness resets and the panel's re-render must
    // reassign the document rather than patch a DOM that no longer exists.
    panel.state.messageHandler?.({ type: 'verdictReady' });
    await flush();

    expect(panel.state.htmlLog.length).toBe(assignmentsBefore + 1);
    expect(panel.state.htmlLog.at(-1)).toContain('Rate limit window is per instance');
    // Restored from memory — no reload-triggered refetch.
    expect(world.calls).toEqual(callsBefore);
  });
});
