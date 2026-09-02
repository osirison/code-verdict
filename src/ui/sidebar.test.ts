/**
 * The sidebar stops fetching on every triage action (issue #46 task 2.1-2.6).
 *
 * Before this change, `setActiveReview`/`setPendingReview`/`setThreads`/
 * `setActiveRoute`/`setActiveRuns` all called the same `render()` that a real
 * pod refresh uses — three platform requests and a full `webview.html`
 * rebuild for pod data that recording a verdict never touches. These tests
 * drive the real `VerdictSidebarProvider` against a fake connection that
 * counts calls, the way a reviewer would: resolve the view, let the initial
 * fetch land, then trigger triage-adjacent state changes and assert nothing
 * reaches the platform a second time.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { clearProviders } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import type { Pod } from '../domain/types';
import type { PodStore } from '../app/pods';
import type { PodData } from '../app/podQuery';
import type { ChangeRequest, WorkItem } from '../platform/types';
import { renderSidebarRegions, type SidebarActiveReview } from './sidebarHtml';
import { toSidebarViewState } from './sidebarState';

const world = vi.hoisted(() => ({
  calls: { changeRequests: 0, workItems: 0, ciRuns: 0 },
  crs: [] as ChangeRequest[],
  workItems: [] as WorkItem[],
}));

const view = vi.hoisted(() => ({
  html: '',
  postMessage: vi.fn(),
  messageHandler: undefined as ((message: unknown) => void) | undefined,
}));

vi.mock('vscode', () => ({
  Uri: {
    // Only ever passed to `webview.asWebviewUri`, which the fake view below
    // leaves undefined — the return value here is never dereferenced.
    joinPath: (...segments: unknown[]) => segments,
  },
  // changesetDetectionOptions (changesetOptions.ts) reads settings through
  // this on every data-path render() — needed even though this file never
  // asserts on changesets.
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: { openExternal: vi.fn() },
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      listOpenChangeRequests: () => {
        world.calls.changeRequests += 1;
        return Promise.resolve(world.crs);
      },
      listWorkItems: () => {
        world.calls.workItems += 1;
        return Promise.resolve(world.workItems);
      },
      listCiRuns: () => {
        world.calls.ciRuns += 1;
        return Promise.resolve([]);
      },
    }),
}));

function pod(): Pod {
  return {
    id: 'platform',
    name: 'Platform squad',
    providerId: 'github',
    instanceUrl: 'https://github.example',
    sources: [{ kind: 'repository', repoId: 'acme/repo' }],
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: [], extraInstructions: '' },
    agentId: '',
    repos: [{ id: 'acme/repo', path: 'acme/repo', name: 'repo' }],
  };
}

function changeRequest(): ChangeRequest {
  return {
    ref: { repoId: 'acme/repo', number: '7' },
    title: 'Add per-tenant rate limiting',
    state: 'open',
    sourceBranch: 'feat/rate-limit',
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: 'https://example.test/pr/7',
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: 'aaaa',
  };
}

function activeReview(overrides: Partial<SidebarActiveReview> = {}): SidebarActiveReview {
  return {
    headline: '#7 · Add per-tenant rate limiting',
    refLabel: '#7',
    context: 'feat/rate-limit',
    agent: 'Copilot review',
    added: 10,
    removed: 2,
    counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
    items: [
      { id: 'f1', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', verdict: 'accepted', selected: true },
    ],
    ...overrides,
  };
}

/** A fake `vscode.WebviewView` — just enough surface for `resolveWebviewView`. */
function fakeWebviewView() {
  return {
    webview: {
      get html(): string {
        return view.html;
      },
      set html(value: string) {
        view.html = value;
      },
      postMessage: view.postMessage,
      onDidReceiveMessage: (handler: (message: unknown) => void) => {
        view.messageHandler = handler;
        return { dispose: () => undefined };
      },
      options: undefined as unknown,
      cspSource: 'test:',
      asWebviewUri: undefined,
    },
    onDidDispose: () => ({ dispose: () => undefined }),
  };
}

/** Drains the microtask queue — render()'s await chain (connectionForPod,
 * then fetchPodData's Promise.all) is several hops deep, more than a fixed
 * number of `await Promise.resolve()` reliably covers. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function makeSidebar() {
  const { VerdictSidebarProvider } = await import('./sidebar.js');
  const activePod = pod();
  const podStore = { activePod, list: () => [activePod] } as unknown as PodStore;
  const sidebar = new VerdictSidebarProvider(podStore, {
    secrets: {} as never,
    extensionUri: {} as never,
    globalState: { get: () => undefined, update: () => Promise.resolve() } as never,
    openCr: () => undefined,
  });
  sidebar.resolveWebviewView(fakeWebviewView() as never);
  // render() is async (it awaits the fake connection) — flush microtasks.
  await flush();
  // The webview's own REGIONS_SCRIPT would post this back; simulate it so
  // patch() takes the postMessage path rather than its not-ready fallback.
  view.messageHandler?.({ type: 'verdictReady' });
  return { sidebar, podStore };
}

beforeEach(() => {
  registerBuiltInProviders();
  world.calls = { changeRequests: 0, workItems: 0, ciRuns: 0 };
  world.crs = [changeRequest()];
  world.workItems = [];
  view.html = '';
  view.postMessage.mockClear();
  view.messageHandler = undefined;
});

afterEach(() => clearProviders());

describe('the sidebar stops fetching on every triage action', () => {
  it('paints the lists screen on the initial render, from one fetch', async () => {
    await makeSidebar();
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
    expect(view.html).toContain('Add per-tenant rate limiting');
  });

  it('recording a verdict patches the active-review region and issues zero platform calls', async () => {
    const { sidebar } = await makeSidebar();
    const htmlBefore = view.html;

    sidebar.setActiveReview(activeReview());

    // The whole point of task 2.1: no additional platform requests.
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
    // Patched in place, not a full document rebuild.
    expect(view.html).toBe(htmlBefore);
    expect(view.postMessage).toHaveBeenCalledTimes(1);
    const posted = view.postMessage.mock.calls[0]?.[0] as { type: string; regions: Record<string, string> };
    expect(posted.type).toBe('verdict:regions');
    expect(posted.regions['sidebar-active-review']).toContain('Refresh token can race');
    expect(posted.regions['sidebar-active-review']).toContain('#7 · Add per-tenant rate limiting');
  });

  it('recording ten verdicts in a row still issues zero platform calls', async () => {
    const { sidebar } = await makeSidebar();
    for (let i = 0; i < 10; i += 1) {
      sidebar.setActiveReview(activeReview({ counts: { accepted: i, rejected: 0, skipped: 0, undecided: 10 - i } }));
    }
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
    expect(view.postMessage).toHaveBeenCalledTimes(10);
  });

  it('a pending-review update, a thread update, a route change and an active-run update all patch and never fetch', async () => {
    const { sidebar } = await makeSidebar();

    sidebar.setPendingReview({ headline: '#7', context: 'feat/x', agent: 'agent', added: 1, removed: 0 });
    sidebar.setThreads({ headline: '#7', context: 'feat/x', summary: [], threads: [] });
    sidebar.setActiveRoute('dashboard');
    sidebar.setActiveRuns([{ key: 'k', label: '#7', state: 'running', elapsedMs: 0 }]);

    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
    expect(view.postMessage).toHaveBeenCalledTimes(4);
  });

  it('clearing an active review falls back to the threads screen when threads are held (precedence)', async () => {
    const { sidebar } = await makeSidebar();
    sidebar.setThreads({ headline: '#7', context: 'feat/x', summary: [], threads: [{ id: 't1', title: 'A thread', meta: 'x.ts:1', status: 'awaiting', selected: false }] });
    sidebar.setActiveReview(activeReview());

    // Threads outrank triage — recomputed fresh each patch, so setting the
    // review while threads are held must not surface it underneath them.
    let posted = view.postMessage.mock.calls.at(-1)?.[0] as { regions: Record<string, string> };
    expect(posted.regions['sidebar-threads']).toContain('A thread');
    expect(posted.regions['sidebar-active-review']).toBe('');

    sidebar.setThreads(undefined);
    posted = view.postMessage.mock.calls.at(-1)?.[0] as { regions: Record<string, string> };
    expect(posted.regions['sidebar-threads']).toBe('');
    expect(posted.regions['sidebar-active-review']).toContain('Refresh token can race');

    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
  });

  it('the change-request/work-item/CI-derived sections are byte-identical before and after triage', async () => {
    const { sidebar, podStore } = await makeSidebar();

    // Ground truth: what the lists screen should show, computed independently
    // from the exact data this test's fake connection served.
    const data: PodData = {
      pod: podStore.activePod as Pod,
      changeRequests: world.crs,
      workItems: world.workItems,
      ciRuns: [],
      fetchedAt: 0,
    };
    const expected = renderSidebarRegions(toSidebarViewState(data, [podStore.activePod as Pod]));

    sidebar.setActiveReview(activeReview());
    sidebar.setActiveReview(undefined);

    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1 });
    const lastPosted = view.postMessage.mock.calls.at(-1)?.[0] as { regions: Record<string, string> };
    // Lists (change requests + issues) and the nav's CR-derived count both
    // came from the same one fetch — a triage action, having never touched
    // either, must leave them exactly as they were.
    expect(lastPosted.regions['sidebar-active-review']).toBe(expected['sidebar-active-review']);
    expect(lastPosted.regions['sidebar-nav']).toBe(expected['sidebar-nav']);
  });

  it('a real pod refresh still fetches and repaints everything', async () => {
    const { sidebar } = await makeSidebar();
    view.postMessage.mockClear();

    sidebar.refresh();
    await flush();

    expect(world.calls).toEqual({ changeRequests: 2, workItems: 2, ciRuns: 2 });
    // A refresh is a full repaint, not a region patch.
    expect(view.postMessage).not.toHaveBeenCalled();
  });
});
