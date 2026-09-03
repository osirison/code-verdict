/**
 * The call sites behind the store (tasks 6.1, 6.2, 6.4, 6.6): the dashboard,
 * the sidebar and the changeset screen read one shared, freshness-tracked
 * copy of the pod's data instead of fetching their own. Driven through the
 * real panels against a mocked `vscode` and a fake connection that counts
 * calls — before this change, one submit fanned out to four surfaces and
 * three separate pod fetches; these tests pin that the fan-out now costs at
 * most one, and that a poll finding nothing new repaints nothing.
 *
 * The dashboard and the changeset screen are routes on one `AppSurface`, so
 * only one of them can be live at a time — the shared-flight test therefore
 * pairs the dashboard with the sidebar (a `WebviewView`, always resident)
 * and a background tick standing in for the notifier's poll.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pod } from '../domain/types';
import type { PodStore } from '../app/pods';
import type { KeyValueStore } from '../app/storage';
import type { ChangeRequest } from '../platform/types';

const world = vi.hoisted(() => ({
  calls: { changeRequests: 0, workItems: 0, ciRuns: 0, diffs: 0 },
  crs: [] as ChangeRequest[],
  gate: undefined as Promise<void> | undefined,
  /** Set to make the next connection attempt fail — a revalidation gone bad. */
  failWith: undefined as Error | undefined,
}));

/** The one `AppSurface` panel, with every full assignment logged. */
const panel = vi.hoisted(() => {
  const state = {
    htmlLog: [] as string[],
    messageHandler: undefined as ((message: unknown) => void) | undefined,
  };
  return {
    state,
    title: '',
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

/** The sidebar's `WebviewView`, separate from the panel. */
const view = vi.hoisted(() => ({
  html: '',
  postMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: () => panel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    showQuickPick: vi.fn(() => Promise.resolve(undefined)),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: { openExternal: vi.fn() },
  Uri: { joinPath: (...segments: unknown[]) => segments, parse: (value: string) => value },
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () => {
    // The one failure injection this suite has: a rejected connection stands
    // in for a revalidation the platform refused. Checked at connection time
    // rather than per-list-call — simplest fake that still makes the whole
    // fetch behind a stale read reject the way a real platform error would.
    if (world.failWith) return Promise.reject(world.failWith);
    return Promise.resolve({
      listOpenChangeRequests: async () => {
        world.calls.changeRequests += 1;
        if (world.gate) await world.gate;
        return [...world.crs];
      },
      listWorkItems: async () => {
        world.calls.workItems += 1;
        if (world.gate) await world.gate;
        return [];
      },
      listCiRuns: async () => {
        world.calls.ciRuns += 1;
        if (world.gate) await world.gate;
        return [];
      },
      getChangeRequestDiff: async (ref: { repoId: string; number: string }) => {
        world.calls.diffs += 1;
        if (world.gate) await world.gate;
        return { ref, headSha: 'head', files: [], anchorRefs: undefined };
      },
    });
  },
}));

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
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: [], extraInstructions: '' },
    agentId: '',
    repos: [{ id: 'acme/repo', path: 'acme/repo', name: 'repo' }],
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

/** A fetch held open until the test releases it. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Fresh modules per test: `AppSurface` and the panel singletons are module
 * state, and a previous test's live dashboard must not leak into the next. */
async function setup() {
  const { AppStore } = await import('../app/appStore.js');
  const { registerBuiltInProviders } = await import('../registry.js');
  registerBuiltInProviders();
  const activePod = pod();
  const podStore = { activePod, list: () => [activePod] } as unknown as PodStore;
  const clock = { t: 1_000_000 };
  const appStore = new AppStore({
    podStore,
    secrets: {} as never,
    reviewHistory: { list: () => [] } as never,
    baseSeconds: () => 60,
    now: () => clock.t,
  });
  return { appStore, podStore, activePod, clock };
}

async function openDashboard(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { DashboardPanel } = await import('./dashboard.js');
  await DashboardPanel.show(setupResult.podStore, setupResult.appStore);
  return DashboardPanel;
}

async function openSidebar(setupResult: Awaited<ReturnType<typeof setup>>) {
  const { VerdictSidebarProvider } = await import('./sidebar.js');
  const sidebar = new VerdictSidebarProvider(setupResult.podStore, {
    appStore: setupResult.appStore,
    extensionUri: {} as never,
    globalState: memoryKv() as never,
    openCr: () => undefined,
  });
  sidebar.resolveWebviewView({
    webview: {
      get html(): string {
        return view.html;
      },
      set html(value: string) {
        view.html = value;
      },
      postMessage: view.postMessage,
      onDidReceiveMessage: () => ({ dispose: (): void => undefined }),
      options: undefined as unknown,
      cspSource: 'test:',
      asWebviewUri: undefined,
    },
    onDidDispose: () => ({ dispose: (): void => undefined }),
  } as never);
  await flush();
  return sidebar;
}

beforeEach(() => {
  vi.resetModules();
  world.calls = { changeRequests: 0, workItems: 0, ciRuns: 0, diffs: 0 };
  world.crs = [changeRequest('7', 'Add per-tenant rate limiting')];
  world.gate = undefined;
  world.failWith = undefined;
  panel.state.htmlLog.length = 0;
  panel.state.messageHandler = undefined;
  panel.webview.postMessage.mockClear();
  view.html = '';
  view.postMessage.mockClear();
});

describe('one pod fetch is shared by every surface that wants it (task 6.6)', () => {
  it('the dashboard, the sidebar and a background tick opening together issue one set of platform calls', async () => {
    const s = await setup();
    const { DashboardPanel } = await import('./dashboard.js');
    const held = gate();
    world.gate = held.promise;

    // All three want the pod's data before anything has landed.
    const shown = DashboardPanel.show(s.podStore, s.appStore);
    const sidebarReady = openSidebar(s);
    const tick = s.appStore.revalidate(s.activePod);

    held.open();
    await Promise.all([shown, sidebarReady, tick]);
    await flush();

    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1, diffs: 0 });
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');
    expect(view.html).toContain('Add per-tenant rate limiting');
  });

  it('a repaint event inside the freshness window repaints every surface and issues zero platform calls', async () => {
    const s = await setup();
    await openDashboard(s);
    const sidebar = await openSidebar(s);
    const before = { ...world.calls };
    panel.state.htmlLog.length = 0;
    view.html = '';

    // What a submit or a recorded run fans out to (extension.ts's
    // repaintReviewSurfaces) — each call now reads held state.
    sidebar.refresh();
    const { DashboardPanel } = await import('./dashboard.js');
    await DashboardPanel.refreshIfOpen();
    await flush();

    expect(world.calls).toEqual(before);
    // Both surfaces still repainted from the held copy.
    expect(panel.state.htmlLog.length).toBeGreaterThan(0);
    expect(view.html).toContain('Add per-tenant rate limiting');
  });

  it('the refresh button fetches inside the freshness window, where a background repaint would not', async () => {
    const s = await setup();
    await openDashboard(s);
    const before = { ...world.calls };

    // A background repaint inside the window is free — that is the whole
    // point of the window.
    const { DashboardPanel } = await import('./dashboard.js');
    await DashboardPanel.refreshIfOpen();
    await flush();
    expect(world.calls).toEqual(before);

    // The reviewer pressing the button is not background work. Driven through
    // the message handler, exactly as the ⟳ click arrives. Serving this from
    // held data is what made the button appear broken in #47, and the
    // freshness window must not reintroduce it.
    panel.state.messageHandler?.({ type: 'refresh' });
    await flush();
    expect(world.calls.changeRequests).toBe(before.changeRequests + 1);
  });

  it('the same event past the window shares one revalidation across the surfaces', async () => {
    const s = await setup();
    await openDashboard(s);
    const sidebar = await openSidebar(s);
    const before = { ...world.calls };
    s.clock.t += 60_000;

    sidebar.refresh();
    const { DashboardPanel } = await import('./dashboard.js');
    await DashboardPanel.refreshIfOpen();
    await flush();

    // One set of list calls, not one per surface: the second stale read
    // joined the revalidation the first one started.
    expect(world.calls).toEqual({
      changeRequests: before.changeRequests + 1,
      workItems: before.workItems + 1,
      ciRuns: before.ciRuns + 1,
      diffs: 0,
    });
  });

  it('a poll that finds nothing new repaints nothing', async () => {
    const s = await setup();
    await openDashboard(s);
    await openSidebar(s);
    s.clock.t += 60_000;
    panel.state.htmlLog.length = 0;
    const sidebarHtmlBefore = view.html;
    view.postMessage.mockClear();

    await s.appStore.revalidate(s.activePod);
    await flush();

    // The fetch happened — the data was stale — but nothing changed, so no
    // subscriber heard anything and no surface repainted.
    expect(world.calls.changeRequests).toBe(2);
    expect(panel.state.htmlLog).toEqual([]);
    expect(view.html).toBe(sidebarHtmlBefore);
    expect(view.postMessage).not.toHaveBeenCalled();
  });

  it('a poll that finds changed data repaints every open surface from the one fetch', async () => {
    const s = await setup();
    await openDashboard(s);
    await openSidebar(s);
    s.clock.t += 60_000;
    world.crs = [changeRequest('7', 'Rename the tenant header')];
    panel.state.htmlLog.length = 0;

    await s.appStore.revalidate(s.activePod);
    await flush();

    expect(world.calls.changeRequests).toBe(2);
    expect(panel.webview.html).toContain('Rename the tenant header');
    expect(view.html).toContain('Rename the tenant header');
  });
});

describe('the dashboard keeps its skeleton for a cold pod and skips it for a held one (task 6.1)', () => {
  it('the first open with nothing held paints the loading skeleton, then the data', async () => {
    const s = await setup();
    const { DashboardPanel } = await import('./dashboard.js');
    const held = gate();
    world.gate = held.promise;

    const shown = DashboardPanel.show(s.podStore, s.appStore);
    // The skeleton is on screen while the fetch runs — synchronously, before
    // the first await, so navigation never leaves the previous screen frozen.
    expect(panel.webview.html).toContain('class="skel');

    held.open();
    await shown;
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');
  });

  it('reopening with held data paints it immediately, with no loading state', async () => {
    const s = await setup();
    await openDashboard(s);
    const before = { ...world.calls };

    // Navigate away, then back: a fresh DashboardPanel instance whose store
    // still holds the pod's data.
    const { AppSurface } = await import('./appSurface.js');
    AppSurface.show('elsewhere', 'Elsewhere');
    panel.state.htmlLog.length = 0;
    await openDashboard(s);

    expect(world.calls).toEqual(before);
    expect(panel.state.htmlLog.some((html) => html.includes('class="skel'))).toBe(false);
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');
  });

  it('a revalidation behind a stale reopen can fail without disturbing what is painted', async () => {
    const s = await setup();
    await openDashboard(s);
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');

    // Navigate away and let the held data go stale, exactly like the test
    // above — except this time the revalidation reopening starts behind the
    // paint is going to fail.
    const { AppSurface } = await import('./appSurface.js');
    AppSurface.show('elsewhere', 'Elsewhere');
    s.clock.t += 60_000;
    world.failWith = new Error('rate limited');
    panel.state.htmlLog.length = 0;

    await openDashboard(s);
    // The data already on screen remains shown: reopening on stale held data
    // paints that data immediately — no loading state, and (since a repaint
    // only ever follows a fetch that *succeeded*) no error either, no matter
    // how the revalidation behind it turns out.
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');
    expect(panel.state.htmlLog.every((html) => !html.includes('Could not load the pod'))).toBe(true);

    // Single-flight: reading the same pod now either joins the exact
    // background revalidation the reopened dashboard's stale read started
    // behind its paint, or — if that flight already settled — starts an
    // identical one, `world.failWith` still armed. Either way this is proof
    // the failure is reported to whoever is waiting on it, not silently
    // swallowed into a success the way a dropped rejection would be.
    const behind = s.appStore.read(s.activePod);
    await expect(behind.fetch).rejects.toThrow('rate limited');
    await flush();

    // What was on screen stays on screen; no error document ever replaced it.
    expect(panel.webview.html).toContain('Add per-tenant rate limiting');
    expect(panel.state.htmlLog.every((html) => !html.includes('Could not load the pod'))).toBe(true);
  });
});

describe('the changeset screen reads the pod through the store (task 6.2)', () => {
  const CHANGESET_ID = 'manual:test1';

  /** Built synchronously (no dynamic import) so a caller timing a paint
   * against `ChangesetPanel.show()` itself — not this whole async helper —
   * can import once, then call `.show()` unawaited without the import's own
   * microtask gap swallowing the synchronous part of `load()`. */
  function changesetDeps(s: Awaited<ReturnType<typeof setup>>) {
    const globalState = memoryKv({
      'codeVerdict.manualChangesets': {
        'pod-1': [
          {
            id: CHANGESET_ID,
            name: 'Tenant limits',
            members: [
              { repoId: 'acme/repo', number: '7' },
              { repoId: 'acme/repo', number: '8' },
            ],
          },
        ],
      },
    });
    return {
      podStore: s.podStore,
      appStore: s.appStore,
      secrets: {} as never,
      globalState,
      workspaceState: memoryKv(),
      openCr: () => undefined,
      openReview: () => undefined,
      openDashboard: () => undefined,
    };
  }

  async function openChangeset(s: Awaited<ReturnType<typeof setup>>) {
    const { ChangesetPanel } = await import('./changeset.js');
    await ChangesetPanel.show(changesetDeps(s), CHANGESET_ID);
    return ChangesetPanel;
  }

  beforeEach(() => {
    world.crs = [
      changeRequest('7', 'Add per-tenant rate limiting'),
      changeRequest('8', 'Enforce the limit at the gateway'),
    ];
  });

  it('opening it costs one pod read plus the member diffs; an event repaint inside the window costs diffs only', async () => {
    const s = await setup();
    const ChangesetPanel = await openChangeset(s);
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1, diffs: 2 });
    expect(panel.webview.html).toContain('Tenant limits');

    // The event fan-out's call: the pod read is served held, so only the
    // member diffs — per change request, never pod-keyed — hit the platform.
    ChangesetPanel.refreshIfOpen();
    await flush();
    expect(world.calls).toEqual({ changeRequests: 1, workItems: 1, ciRuns: 1, diffs: 4 });
  });

  it('a poll that finds changed data repaints the open changeset screen', async () => {
    const s = await setup();
    await openChangeset(s);
    s.clock.t += 60_000;
    world.crs = [
      changeRequest('7', 'Add per-tenant rate limiting'),
      changeRequest('8', 'Enforce the limit at the edge proxy'),
    ];

    await s.appStore.revalidate(s.activePod);
    await flush();

    expect(world.calls.changeRequests).toBe(2);
    expect(panel.webview.html).toContain('Enforce the limit at the edge proxy');
  });

  describe('the loading first paint (task 7.6)', () => {
    it('a cold open shows the pod name and the raw changeset id, upgraded to the real name once data lands', async () => {
      const s = await setup();
      // Imported and awaited BEFORE the gate and the `.show()` call below —
      // a dynamic import is itself an async gap, and awaiting `openChangeset`
      // as a whole would swallow the synchronous part of `load()` this
      // assertion is timed against (the dashboard's equivalent test at
      // ":341" does the same).
      const { ChangesetPanel } = await import('./changeset.js');
      const held = gate();
      world.gate = held.promise;

      const shown = ChangesetPanel.show(changesetDeps(s), CHANGESET_ID);
      // Synchronous, before the first await — nothing has been held for this
      // pod yet, so the label falls back to the id `load()` was called with.
      expect(panel.webview.html).toContain('Platform squad');
      expect(panel.webview.html).toContain(CHANGESET_ID);
      expect(panel.webview.html).not.toContain('Tenant limits');
      expect(panel.webview.html).toContain('class="skel');

      held.open();
      // `await shown` alone is not enough here: the store's own subscription
      // (constructor above) fires a SECOND, untracked `load()` the moment
      // this first-ever fetch installs and notifies (D4) — synchronously,
      // from inside the flight's own continuation, before `shown`'s awaited
      // call ever resumes past its `seq !== this.loadSeq` guard. On the
      // dashboard the analogous second call finishes in that same
      // synchronous turn (nothing left to await once data is held), so
      // `shown` alone suffices there; here it does not, because this screen
      // owes an EXTRA real await afterwards — the member diffs on a direct
      // connection — so the second call's actual render still needs a few
      // more microtask turns after `shown` settles.
      await shown;
      await flush();
      expect(panel.webview.html).toContain('Tenant limits');
    });

    it('reopening with held pod data upgrades the label to the real changeset name before the member diffs resolve', async () => {
      const s = await setup();
      const { ChangesetPanel } = await import('./changeset.js');
      await ChangesetPanel.show(changesetDeps(s), CHANGESET_ID);
      const { AppSurface } = await import('./appSurface.js');
      AppSurface.show('elsewhere', 'Elsewhere');
      panel.state.htmlLog.length = 0;
      // Gate only the diffs this time — the pod read is served from the
      // store's held copy (fresh: `clock.t` has not advanced), so nothing
      // blocks the label upgrade itself, only the rest of the page.
      const held = gate();
      world.gate = held.promise;

      const shown = ChangesetPanel.show(changesetDeps(s), CHANGESET_ID);
      expect(panel.webview.html).toContain('Tenant limits');
      expect(panel.webview.html).toContain('class="skel');

      held.open();
      await shown;
    });
  });

  it('navigating between the dashboard and the changeset screen inside the window issues no pod fetch', async () => {
    const s = await setup();
    await openDashboard(s);
    const before = { ...world.calls };

    // Dashboard → changeset → dashboard → changeset, all inside the
    // freshness window. The pod data every screen needs is served held; the
    // only platform traffic is the changeset screen's per-member diffs,
    // which are per change request — the store never holds them (task 6.2's
    // deliberate boundary), so each entry to that screen re-fetches its own.
    await openChangeset(s);
    await openDashboard(s);
    await openChangeset(s);
    await flush();

    expect(world.calls.changeRequests).toBe(before.changeRequests);
    expect(world.calls.workItems).toBe(before.workItems);
    expect(world.calls.ciRuns).toBe(before.ciRuns);
    expect(world.calls.diffs).toBe(4);
  });

  describe('the region patch (task 7.3)', () => {
    /** Arms the route the way REGIONS_SCRIPT does on a real page load. */
    function armReady(): void {
      panel.state.messageHandler?.({ type: 'verdictReady' });
    }

    it('a repaint after the page is ready patches cs-body instead of reassigning the document', async () => {
      const s = await setup();
      await openChangeset(s);
      armReady();
      panel.webview.postMessage.mockClear();
      panel.state.htmlLog.length = 0;
      s.clock.t += 60_000;
      world.crs = [
        changeRequest('7', 'Add per-tenant rate limiting'),
        changeRequest('8', 'Enforce the limit at the edge proxy'),
      ];

      await s.appStore.revalidate(s.activePod);
      await flush();

      expect(panel.state.htmlLog).toEqual([]);
      expect(panel.webview.postMessage).toHaveBeenCalledTimes(1);
      const posted = panel.webview.postMessage.mock.calls[0]?.[0] as { type: string; regions: Record<string, string> };
      expect(posted.type).toBe('verdict:regions');
      expect(Object.keys(posted.regions)).toEqual(['cs-body']);
      expect(posted.regions['cs-body']).toContain('Enforce the limit at the edge proxy');
    });

    it('a reload re-arms readiness to false and the next repaint falls back to a full setHtml', async () => {
      const s = await setup();
      await openChangeset(s);
      armReady();
      // A second `verdictReady` while already ready is what a webview reload
      // looks like (AppRoute.onReload's doc comment) — it resets `ready` and
      // fires the reload handlers, which for this screen is `load()` again.
      armReady();
      panel.webview.postMessage.mockClear();
      panel.state.htmlLog.length = 0;

      await flush();

      expect(panel.webview.postMessage).not.toHaveBeenCalled();
      expect(panel.state.htmlLog.length).toBeGreaterThan(0);
      expect(panel.webview.html).toContain('Tenant limits');
    });
  });
});
