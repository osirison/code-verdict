/**
 * ui-responsiveness: "Every screen behaves this way" — "WHEN state changes on
 * the dashboard, the review screen, the changeset screen, the changeset
 * review screen, the posted-reviews screen, the settings screen, the tuning
 * screen, the onboarding screen or the sidebar THEN that screen updates in
 * place rather than being rebuilt." The rejected coverage exercised three of
 * the nine; this table drives the real panel class for every one of them.
 *
 * Every screen but the sidebar shows through the one shared `AppSurface`
 * (appSurface.ts): its `AppRoute.postRegions` sends `{type:'verdict:regions',
 * regions}` with no `routeKey` for a same-route state patch, and only
 * `setHtml` ever assigns `panel.webview.html` — so "updates in place rather
 * than being rebuilt" is observable as: after the panel is armed
 * (`verdictReady`), a state-changing action produces exactly that regions-only
 * message, and `panel.webview.html` is not reassigned again. The sidebar is a
 * separate `WebviewView` (sidebar.ts re-implements the same ready/patch
 * handshake on its own view) and is asserted the same way against it directly.
 *
 * Each row disposes the shared panel/AppSurface in `afterEach` and builds its
 * own minimal pod/deps — no row depends on another having run.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProviders } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import { BUILTIN_AGENT_DESCRIPTOR } from '../app/agents';
import { draftKeyFor, changesetDraftKeyFor, retainedFromRun, type ChangesetDraft, type SessionDraft } from '../app/retainedReview';
import type { ReviewRunManager } from '../app/reviewRunManager';
import type { PodStore } from '../app/pods';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod, Review } from '../domain/types';
import type { ChangeRequest, ReviewThread } from '../platform/types';
import { SHELL_ROUTES } from './appShell';
import { GITHUB_VOCABULARY } from '../testing/specFixtures';
import { renderSidebarHtml, renderSidebarRegions, type SidebarViewState } from './sidebarHtml';

// ---- shared vscode / connections mocks (superset over every screen's needs) ----

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
}));

const panel = vi.hoisted(() => ({
  title: '',
  active: true,
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

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  ConfigurationTarget: { Global: 1 },
  window: {
    createWebviewPanel: () => panel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    onDidChangeWindowState: () => ({ dispose: (): void => undefined }),
  },
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, fallback?: unknown) => fallback,
      update: () => Promise.resolve(undefined),
    }),
    workspaceFolders: [],
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: { openExternal: vi.fn(), clipboard: { writeText: vi.fn(() => Promise.resolve(undefined)) } },
  Uri: { joinPath: (...segments: unknown[]) => segments, parse: (value: string) => value },
}));

const world = vi.hoisted(() => ({
  crs: [] as ChangeRequest[],
  threads: [] as ReviewThread[],
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      listOpenChangeRequests: async () => [...world.crs],
      listWorkItems: async () => [],
      listCiRuns: async () => [],
      getChangeRequestDiff: async (ref: { repoId: string; number: string }) => ({ ref, headSha: 'head', files: [], anchorRefs: undefined }),
      listThreads: async (ref: { repoId: string; number: string }) => world.threads.filter((t) => t.crRef.repoId === ref.repoId && t.crRef.number === ref.number),
      resolveThread: async () => undefined,
      replyToThread: async () => undefined,
      testConnection: async () => ({ ok: true }),
    }),
  // Onboarding's editor-account path checks this synchronously on every
  // render; this screen's row never exercises it, so "unavailable" is enough.
  sessionAvailableFor: () => false,
  acquireSessionFor: () => Promise.resolve(undefined),
}));

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

// ---- fixtures ---------------------------------------------------------------

function pod(overrides: Partial<Pod> = {}): Pod {
  return {
    id: 'pod-1',
    name: 'Platform squad',
    providerId: 'github',
    instanceUrl: 'https://github.example',
    username: 'you',
    sources: [{ kind: 'repository', repoId: 'acme/repo' }],
    criteria: structuredClone(DEFAULT_CRITERIA),
    agentId: '',
    repos: [{ id: 'acme/repo', path: 'acme/repo', name: 'repo' }],
    ...overrides,
  };
}

function podStoreFor(activePod: Pod): PodStore {
  return { activePod, list: () => [activePod], setActive: async () => undefined } as unknown as PodStore;
}

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
    headSha: 'head',
  };
}

function memoryKv(seed: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T,>(key: string) => map.get(key) as T | undefined,
    update: async (key: string, value: unknown) => {
      map.set(key, value);
    },
  };
}

const secrets: SecretStore = {
  get: () => Promise.resolve(undefined),
  store: () => Promise.resolve(undefined),
  delete: () => Promise.resolve(undefined),
};

function fakeRuns(): ReviewRunManager {
  return {
    subscribe: () => ({ dispose: (): void => undefined }),
    get: () => undefined,
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    trigger: vi.fn(),
  } as unknown as ReviewRunManager;
}

function retainedReview(items: Review['items']): Review {
  return {
    repoId: 'acme/repo',
    crNumber: '7',
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    modelId: 'lm:acme/turbo',
    criteria: structuredClone(DEFAULT_CRITERIA),
    headSha: 'head',
    items,
    verdicts: {},
    summary: '',
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function lastPosted(): { type: string; regions?: Record<string, string>; routeKey?: string } {
  return panel.webview.postMessage.mock.calls.at(-1)?.[0] as never;
}

/** The property every row asserts: armed, a state-changing action patches the
 * currently-showing route's regions — never a `routeKey` (that would be a
 * navigation) and never a new `panel.webview.html` assignment. */
function expectInPlacePatch(htmlBefore: string): void {
  const posted = lastPosted();
  expect(posted?.type).toBe('verdict:regions');
  expect(posted?.routeKey).toBeUndefined();
  expect(panel.webview.html).toBe(htmlBefore);
}

beforeEach(() => {
  registerBuiltInProviders();
  world.crs = [changeRequest('7', 'Add per-tenant rate limiting'), changeRequest('8', 'Enforce the limit at the gateway')];
  world.threads = [];
  panel.webview.html = '';
  panel.webview.postMessage.mockClear();
});

afterEach(() => {
  handlers.dispose?.();
  handlers.message = undefined;
  clearProviders();
});

describe('every screen redraws in place on a state change, never a rebuild', () => {
  it('dashboard: another fetch landing (a poll, or another screen) repaints db-body without a new document', async () => {
    const { DashboardPanel } = await import('./dashboard.js');
    const { AppStore } = await import('../app/appStore.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const appStore = new AppStore({ podStore, secrets, reviewHistory: { list: () => [] } as never, baseSeconds: () => 60 });

    await DashboardPanel.show(podStore, appStore, {});
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    // State changes elsewhere: a third CR appears — appStore.forceRefresh is
    // exactly what a background poll or another screen's own fetch calls.
    world.crs = [...world.crs, changeRequest('9', 'Third change request')];
    await appStore.forceRefresh(activePod);
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('db-body');
    expect(lastPosted().regions!['db-body']).toContain('Third change request');
  });

  it('review: moving to the next finding patches flow-body without a new document', async () => {
    const { ReviewFlowPanel } = await import('./reviewFlow.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const ref = { repoId: 'acme/repo', number: '7' };
    const workspaceState = memoryKv({
      [draftKeyFor(ref)]: retainedFromRun({
        review: retainedReview([
          { id: 'i1', file: 'src/limits.ts', line: 3, severity: 'major', category: 'security', confidence: 90, title: 'First finding', body: 'b', code: 'c' },
          { id: 'i2', file: 'src/gateway.ts', line: 9, severity: 'minor', category: 'style', confidence: 80, title: 'Second finding', body: 'b', code: 'c' },
        ]),
        ranAt: '2026-09-01T10:14:00.000Z',
        agentId: BUILTIN_AGENT_DESCRIPTOR.id,
        agentLabel: 'Security Reviewer',
        modelId: 'lm:acme/turbo',
      }) as SessionDraft,
    });

    await ReviewFlowPanel.open(
      { podStore, secrets, workspaceState, globalState: memoryKv(), runs: fakeRuns() },
      ref,
    );
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    handlers.message?.({ type: 'move', delta: 1 });
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('flow-body');
    expect(lastPosted().regions!['flow-body']).toContain('Second finding');
  });

  it('changeset: a repaint (a pod refresh, or a review landing) patches cs-body without a new document', async () => {
    const { ChangesetPanel } = await import('./changeset.js');
    const { AppStore } = await import('../app/appStore.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const appStore = new AppStore({ podStore, secrets, reviewHistory: { list: () => [] } as never, baseSeconds: () => 60 });
    const changesetId = 'manual:tenant1';
    const globalState = memoryKv({
      'codeVerdict.manualChangesets': {
        'pod-1': [{ id: changesetId, name: 'Tenant limits', members: [{ repoId: 'acme/repo', number: '7' }, { repoId: 'acme/repo', number: '8' }] }],
      },
    });

    await ChangesetPanel.show(
      { podStore, appStore, secrets, globalState, workspaceState: memoryKv(), openCr: () => undefined, openReview: () => undefined, openDashboard: () => undefined },
      changesetId,
    );
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    ChangesetPanel.refreshIfOpen();
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('cs-body');
  });

  it('changeset review: recording a verdict patches flow-body without a new document', async () => {
    const { ChangesetReviewPanel } = await import('./changesetReview.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const { AppStore } = await import('../app/appStore.js');
    const appStore = new AppStore({ podStore, secrets, reviewHistory: { list: () => [] } as never, baseSeconds: () => 60 });
    const changesetId = 'manual:tenant1';
    const workspaceState = memoryKv({
      [changesetDraftKeyFor(changesetId)]: retainedFromRun({
        review: {
          ...retainedReview([
            { id: 'i1', file: 'src/limits.ts', line: 3, severity: 'major', category: 'security', confidence: 90, title: 'Rate limit window is per instance', body: 'b', code: 'c', repoId: 'acme/repo', crNumber: '7' },
            { id: 'i2', file: 'src/gateway.ts', line: 9, severity: 'minor', category: 'style', confidence: 80, title: 'Gateway retries without jitter', body: 'b', code: 'c', repoId: 'acme/repo', crNumber: '8' },
          ]),
          repoId: 'changeset',
          crNumber: changesetId,
          headSha: 'acme/repo!7:head|acme/repo!8:head',
        },
        ranAt: '2026-09-01T10:14:00.000Z',
        agentId: BUILTIN_AGENT_DESCRIPTOR.id,
        agentLabel: 'Security Reviewer',
        modelId: 'lm:acme/turbo',
      }) as ChangesetDraft,
    });
    const globalState = memoryKv({
      'codeVerdict.manualChangesets': { 'pod-1': [{ id: changesetId, name: 'Tenant limits', members: [{ repoId: 'acme/repo', number: '7' }, { repoId: 'acme/repo', number: '8' }] }] },
    });

    await ChangesetReviewPanel.open(
      { podStore, appStore, secrets, workspaceState, globalState, runs: fakeRuns(), openSingle: () => undefined, openDashboard: () => undefined },
      changesetId,
    );
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    handlers.message?.({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('flow-body');
    expect(lastPosted().regions!['flow-body']).toContain('Gateway retries without jitter');
  });

  it('posted reviews: toggling a thread patches pr-detail without a new document', async () => {
    const { PostedReviewsPanel } = await import('./postedReviews.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    world.threads = [{ id: 'thread-1', crRef: { repoId: 'acme/repo', number: '7' }, resolved: false, anchorPresent: true, notes: [{ id: 'n1', author: { username: 'you' }, body: 'Body', createdAt: '2026-08-20T10:05:00.000Z' }] }];
    const globalState = memoryKv({
      'codeVerdict.submittedReviews': [{
        repoId: 'acme/repo', crNumber: '7', podId: 'pod-1', agentId: 'verdict.demo-agent', agentLabel: 'Verdict · Demo Review',
        submittedAt: '2026-08-20T10:00:00.000Z', counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
        threads: { item1: 'thread-1' }, postedComments: 1, requestedChanges: false,
      }],
    });

    await PostedReviewsPanel.show({ podStore, secrets, globalState, openReviewFlow: () => undefined });
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('pr-detail');
    expect(lastPosted().regions!['pr-detail']).toContain('th-body');
  });

  it('settings: toggling quiet hours patches its region without a new document', async () => {
    const { SettingsPanel } = await import('./settings.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);

    await SettingsPanel.show({ podStore, secrets });
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    handlers.message?.({ type: 'setQuietMode', value: true });
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(Object.keys(lastPosted().regions ?? {}).length).toBeGreaterThan(0);
  });

  it('tuning: a repaint (pod switch, or a review landing) patches tune-body without a new document', async () => {
    const { TuningPanel } = await import('./tuning.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const globalState = memoryKv();

    TuningPanel.show({ podStore, globalState });
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    TuningPanel.refreshIfOpen();
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('tune-body');
  });

  it('onboarding: naming the pod patches its region without a new document', async () => {
    const { OnboardingPanel } = await import('./onboarding.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);

    OnboardingPanel.show({ podStore, secrets, onComplete: () => undefined });
    await flush();
    handlers.message?.({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    panel.webview.postMessage.mockClear();

    handlers.message?.({ type: 'setName', name: 'Platform squad' });
    await flush();

    expectInPlacePatch(htmlBefore);
    expect(lastPosted().regions).toHaveProperty('onb-body');
    // "Name the pod" is step 2's field; step 1 (Connect) is showing, so the
    // held name is not yet on screen — the redraw-in-place property this row
    // exists to prove holds regardless, so it is asserted structurally
    // rather than by pinning content the current step does not display.
  });

  it('sidebar: recording a verdict patches its active-review region without a new document', async () => {
    const { VerdictSidebarProvider } = await import('./sidebar.js');
    const { AppStore } = await import('../app/appStore.js');
    const activePod = pod();
    const podStore = podStoreFor(activePod);
    const appStore = new AppStore({ podStore, secrets, reviewHistory: { list: () => [] } as never, baseSeconds: () => 60 });
    const view = {
      html: '',
      postMessage: vi.fn(),
      messageHandler: undefined as ((message: unknown) => void) | undefined,
    };
    const sidebar = new VerdictSidebarProvider(podStore, {
      appStore,
      extensionUri: {} as never,
      globalState: { get: () => undefined, update: () => Promise.resolve() } as never,
      openCr: () => undefined,
    });
    sidebar.resolveWebviewView({
      webview: {
        get html(): string { return view.html; },
        set html(value: string) { view.html = value; },
        postMessage: view.postMessage,
        onDidReceiveMessage: (handler: (message: unknown) => void) => { view.messageHandler = handler; return { dispose: () => undefined }; },
        options: undefined as unknown,
        cspSource: 'test:',
        asWebviewUri: undefined,
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    } as never);
    await flush();
    view.messageHandler?.({ type: 'verdictReady' });
    const htmlBefore = view.html;
    view.postMessage.mockClear();

    sidebar.setActiveReview({
      headline: '#7 · Add per-tenant rate limiting', refLabel: '#7', context: 'feat/rate-limit', agent: 'Copilot review',
      added: 10, removed: 2, counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
      items: [{ id: 'f1', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', verdict: 'accepted', selected: true }],
    });

    expect(view.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'verdict:regions' }));
    expect(view.html).toBe(htmlBefore);
  });

  // A tenth screen joining the resident shell needs a row above; the pin in
  // appShell.test.ts is what forces that to be noticed.
  it('covers all nine screens the scenario names', () => {
    expect(SHELL_ROUTES.length).toBe(7); // dashboard, review(=changeset review), posted, changeset, settings, tuning, onboarding
  });
});

// ---- ui-responsiveness: "Triaging with the sidebar open" (the "not
// redrawn" half) --------------------------------------------------------------
//
// Covered elsewhere: the "not re-fetched" half lives in sidebar.test.ts
// (owned by another agent working this same audit concurrently) — not
// duplicated here. This is the missing half: byte-identical DOM proof that
// the sidebar's change-request/work-item nav counts and its lists are
// untouched by a verdict-driven patch.
//
// `renderSidebarHtml` renders through `renderPage({ embedded: true, regions:
// true, ... })` (sidebarHtml.ts's own tail), which per theme.ts's `renderPage`
// means REGIONS_SCRIPT IS present — the sidebar gets the same generic
// verdict:regions listener every other screen does, alongside its own
// click-delegation script. A hand-built `JSDOM` under the node environment
// runs it, exactly as dashboardScript.test.ts runs the dashboard's.
describe('the sidebar\'s change-request, work-item and lists sections are untouched by a verdict-driven patch', () => {
  interface ScrollDouble { x: number; y: number; max: number }

  function loadSidebarPage(html: string): { dom: JSDOM; scroll: ScrollDouble } {
    const scroll: ScrollDouble = { x: 0, y: 0, max: Number.MAX_SAFE_INTEGER };
    const virtualConsole = new VirtualConsole();
    const dom = new JSDOM(html, {
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({ postMessage: (): void => undefined });
        window.scrollTo = ((x: number, y: number) => {
          scroll.x = Math.min(x, scroll.max);
          scroll.y = Math.min(y, scroll.max);
        }) as typeof window.scrollTo;
        Object.defineProperty(window, 'scrollX', { get: () => scroll.x });
        Object.defineProperty(window, 'scrollY', { get: () => scroll.y });
      },
    });
    return { dom, scroll };
  }

  function sidebarState(activeReview: SidebarViewState['activeReview']): SidebarViewState {
    return {
      vocabulary: GITHUB_VOCABULARY,
      podName: 'Platform squad',
      podMeta: '6 repositories',
      pods: [{ id: 'pod-1', name: 'Platform squad', meta: '6 repos', active: true }],
      // The nav's own counts (renderNavRows) and the default lists screen's
      // rows (renderListsSection) both read these — the change-request and
      // work-item data the scenario names.
      mergeRequests: [
        { repoId: 'acme/repo', number: '7', label: '#7', title: 'Add per-tenant rate limiting', project: 'core', waiting: true },
        { repoId: 'acme/repo', number: '11', label: '#11', title: 'Unrelated open change', project: 'core', waiting: false },
      ],
      issues: [{ repoId: 'acme/repo', number: '3', webUrl: 'https://example.test/3', label: '#3', title: 'Rate limit ticket', project: 'core' }],
      waitingOnYou: 2,
      changesets: [{ id: 'manual:tenant1', name: 'Tenant limits' }],
      activeRoute: 'review',
      activeReview,
    };
  }

  it('the nav counts and the CR/work-item lists are byte-identical after recording a verdict', () => {
    const before = sidebarState({
      headline: '#7 · Add per-tenant rate limiting', refLabel: '#7', context: 'feat/rate-limit', agent: 'Copilot review',
      added: 10, removed: 2, counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 1 },
      items: [{ id: 'f1', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', selected: true }],
    });
    const { dom } = loadSidebarPage(renderSidebarHtml(before, 'testnonce'));
    const document = dom.window.document;
    const navBefore = document.getElementById('sidebar-nav')?.innerHTML;
    // The real content this test protects: the CR count in the nav, and — the
    // architecture's own guarantee (renderActiveReviewRegion) — that while
    // triaging, no change-request/work-item ROW markup is present at all,
    // because `sidebar-active-review` shows the triage card in its place.
    expect(navBefore).toContain('<span class="nav-count">2</span>'); // waitingOnYou, into the posted-reviews row
    expect(document.querySelector('[data-cr-repo]')).toBeNull();
    expect(document.querySelector('[data-issue-url]')).toBeNull();

    // Recording a verdict: the same finding, now accepted. Nothing about the
    // pod's own data (mergeRequests, issues, waitingOnYou, changesets,
    // activeRoute) changed.
    const after = sidebarState({
      headline: '#7 · Add per-tenant rate limiting', refLabel: '#7', context: 'feat/rate-limit', agent: 'Copilot review',
      added: 10, removed: 2, counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
      items: [{ id: 'f1', title: 'Refresh token can race', file: 'src/auth.ts', severity: 'major', verdict: 'accepted', selected: true }],
    });
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
      data: { type: 'verdict:regions', regions: renderSidebarRegions(after) },
    }));

    // The active-review section DID update (spec: it updates from state it
    // already has) — the progress bar/counts moved.
    expect(document.getElementById('sidebar-active-review')?.innerHTML).toContain('1/1');
    // The nav — carrying the change-request/work-item counts — is byte
    // identical: recomputed from the same underlying data, so even though
    // the patch resends it (renderSidebarRegions always includes
    // 'sidebar-nav'), nothing in it actually changed.
    expect(document.getElementById('sidebar-nav')?.innerHTML).toBe(navBefore);
    // And no change-request/work-item row appeared anywhere — the lists
    // screen never coexists with an active triage.
    expect(document.querySelector('[data-cr-repo]')).toBeNull();
    expect(document.querySelector('[data-issue-url]')).toBeNull();
  });
});
