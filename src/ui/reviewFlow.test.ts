/**
 * The review-flow panel's navigation race guards and draft persistence: run
 * preparation cannot land on a newer target, while coalesced writes retain
 * result fields and cannot overwrite a newer run's review (design D9).
 *
 * Everything here drives the real panel through its message handler against an
 * in-memory `KeyValueStore`, the way the reviewer does — the writer is never
 * poked directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppStore } from '../app/appStore';
import { BUILTIN_AGENT_DESCRIPTOR } from '../app/agents';
import { DRAFT_WRITE_WINDOW_MS } from '../app/draftWriter';
import {
  draftKeyFor,
  retainedFromRun,
  runKeyForCr,
  type SessionDraft,
} from '../app/retainedReview';
import type { ReviewRunManager, RunRecord } from '../app/reviewRunManager';
import type { KeyValueStore } from '../app/storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Review } from '../domain/types';
import type { ScmProvider } from '../platform/provider';
import { clearProviders, registerProvider } from '../platform/registry';
import type { ChangeRequestDiff, ChangeRequestRef, SubmitResult } from '../platform/types';
import { GITHUB_VOCABULARY } from '../testing/specFixtures';
import type { ReviewFlowDeps } from './reviewFlow';
import { VerdictSidebarProvider, VerdictStatusBar } from './sidebar';

// ---- vscode and module mocks ---------------------------------------------------

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
  viewState: undefined as ((event: { webviewPanel: { active: boolean; visible: boolean } }) => void) | undefined,
  windowState: undefined as ((state: { focused: boolean }) => void) | undefined,
}));

/** `VerdictStatusBar`'s segments, in creation order (verdict, agent, keys, …) — see statusBar.test.ts's own `segments()`. */
const statusBarItems = vi.hoisted(() => [] as Array<Record<string, unknown>>);

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
  onDidChangeViewState: (handler: (event: { webviewPanel: { active: boolean; visible: boolean } }) => void) => {
    handlers.viewState = handler;
    return { dispose: vi.fn() };
  },
  onDidDispose: (handler: () => void) => {
    handlers.dispose = handler;
    return { dispose: vi.fn() };
  },
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1, Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  StatusBarAlignment: { Left: 1 },
  window: {
    createWebviewPanel: () => panel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    onDidChangeWindowState: (handler: (state: { focused: boolean }) => void) => {
      handlers.windowState = handler;
      return { dispose: vi.fn() };
    },
    // Only the gap-3 propagation test (task 10.1) builds a real
    // `VerdictStatusBar` — every other test here never touches this.
    createStatusBarItem: vi.fn((_alignment: number, priority: number) => {
      const item = {
        priority,
        text: '',
        tooltip: '',
        command: '',
        visible: false,
        show(): void {
          item.visible = true;
        },
        hide(): void {
          item.visible = false;
        },
        dispose: vi.fn(),
      };
      statusBarItems.push(item as unknown as Record<string, unknown>);
      return item;
    }),
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    workspaceFolders: [],
    onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: {
    clipboard: { writeText: vi.fn(() => Promise.resolve(undefined)) },
    openExternal: vi.fn(),
  },
  // `joinPath` backs the sidebar's codicon asset lookup (sidebar.ts's
  // `codicons()`), evaluated unconditionally even when nothing reads it.
  Uri: { parse: () => ({}), joinPath: (...segments: unknown[]) => segments },
}));

vi.mock('./agentRefresh', () => ({
  loadAgentSelection: (...args: unknown[]) => world.loadAgentSelection(...args),
  watchAgentSources: () => [],
}));

vi.mock('../app/lmAgent', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, discoverModels: world.discoverModels };
});

vi.mock('./contextAttachmentPicker', () => ({
  attachmentFileTarget: vi.fn(),
  attachmentRange: vi.fn(),
  findReferenceFile: world.findReferenceFile,
  modelVisibleWorkspaceRoots: vi.fn(() => []),
  pickContextAttachment: vi.fn(),
}));

vi.mock('../app/attachments', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveAttachment: world.resolveAttachment };
});

vi.mock('./inDiffEditor', () => ({
  InDiffEditor: class {
    show(): Promise<boolean> {
      return Promise.resolve(false);
    }
    dispose(): void {}
  },
  locateInWorkspace: () => Promise.resolve(undefined),
}));

const world = vi.hoisted(() => ({
  submitReview: undefined as ((submission: { comments: Array<{ key: string }>; requestChanges: boolean }) => Promise<unknown>) | undefined,
  submitCalls: [] as Array<{ storedAtCall: unknown }>,
  workspaceState: undefined as (KeyValueStore & { updates: number }) | undefined,
  /** Every platform call, so triage actions can be asserted to make none. */
  calls: { changeRequests: 0, diffs: 0, workItems: 0, submits: 0 },
  changeRequests: [] as ReturnType<typeof changeRequest>[],
  loadAgentSelection: vi.fn(),
  discoverModels: vi.fn(),
  findReferenceFile: vi.fn(),
  resolveAttachment: vi.fn(),
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      // Counted, so a triage action can be asserted to issue none; the
      // bodies are main's, which serve per-ref diffs and a settable CR list.
      listOpenChangeRequests: () => {
        world.calls.changeRequests += 1;
        return Promise.resolve([...world.changeRequests]);
      },
      getChangeRequestDiff: (ref: ChangeRequestRef) => {
        world.calls.diffs += 1;
        return Promise.resolve(diffFor(ref));
      },
      listWorkItems: () => {
        world.calls.workItems += 1;
        return Promise.resolve([]);
      },
      // Only the gap-3 propagation test (task 10.1) builds a real `AppStore`
      // for the sidebar to read through — `fetchPodData` calls this too.
      listCiRuns: () => Promise.resolve([]),
      submitReview: (_ref: unknown, submission: { comments: Array<{ key: string }>; requestChanges: boolean }) => {
        world.calls.submits += 1;
        // Snapshot what is on disk at the moment the platform is called — the
        // flush-before-submit assertions read it back.
        world.submitCalls.push({ storedAtCall: world.workspaceState?.get(draftKeyFor(REF)) });
        return (world.submitReview ?? defaultSubmitReview)(submission);
      },
    }),
}));

function defaultSubmitReview(submission: { comments: Array<{ key: string }>; requestChanges: boolean }): Promise<SubmitResult> {
  return Promise.resolve({
    comments: submission.comments.map((draft) => ({ key: draft.key, ok: true, threadId: `t-${draft.key}` })),
    summaryPosted: true,
    requestChangesApplied: submission.requestChanges,
    postedAsSingleReview: true,
  });
}

// ---- fixtures ------------------------------------------------------------------

const REF: ChangeRequestRef = { repoId: 'acme/repo-0', number: '7' };
const REF_B: ChangeRequestRef = { repoId: REF.repoId, number: '8' };
const RAN_AT = '2026-09-01T10:14:00.000Z';

const DIFF: ChangeRequestDiff = {
  ref: REF,
  headSha: 'aaaa',
  files: [
    { oldPath: 'src/a.ts', newPath: 'src/a.ts', diff: '@@ -1 +1 @@\n+const a = 1;' },
    { oldPath: 'src/b.ts', newPath: 'src/b.ts', diff: '@@ -1 +1 @@\n+const b = 2;' },
  ],
  anchorRefs: {},
};

function diffFor(ref: ChangeRequestRef): ChangeRequestDiff {
  return ref.number === REF.number
    ? DIFF
    : { ...DIFF, ref, headSha: `head-${ref.number}` };
}

function changeRequest(ref: ChangeRequestRef = REF, title = 'Add per-tenant rate limiting') {
  return {
    ref,
    title,
    description: `${title} context`,
    state: 'open' as const,
    sourceBranch: `feat/${ref.number}`,
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: `https://example.test/pr/${ref.number}`,
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: diffFor(ref).headSha,
  };
}

function review(itemIds: string[]): Review {
  return {
    repoId: REF.repoId,
    crNumber: REF.number,
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    modelId: 'lm:acme/turbo',
    criteria: DEFAULT_CRITERIA,
    headSha: 'aaaa',
    items: itemIds.map((id, index) => ({
      id,
      file: 'src/a.ts',
      anchored: true,
      line: index + 1,
      severity: 'major' as const,
      category: 'security' as const,
      confidence: 90,
      title: `Finding ${id}`,
      body: 'Body',
      code: 'const a = 1;',
    })),
    verdicts: {},
    summary: '',
  };
}

/** Exactly what the run manager writes when a run succeeds (one-writer rule). */
function retainedRecord(itemIds: string[], ranAt = RAN_AT): SessionDraft {
  return retainedFromRun({
    review: review(itemIds),
    ranAt,
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    agentLabel: 'Security Reviewer',
    modelId: 'lm:acme/turbo',
    candidates: [{ severity: 'minor', category: 'style', confidence: 40, reason: 'belowConfidence', count: 2 }],
    filesRead: 2,
  });
}

function memoryStore(): KeyValueStore & { updates: number } {
  const map = new Map<string, unknown>();
  return {
    // Synchronous write, then a resolved promise — the contract `storage.ts`
    // states and every real `Memento` satisfies.
    get: <T>(key: string) => map.get(key) as T | undefined,
    update(key, value) {
      this.updates += 1;
      map.set(key, value);
      return Promise.resolve();
    },
    updates: 0,
  };
}

const PROVIDER = {
  id: 'test',
  displayName: 'GitHub',
  vocabulary: GITHUB_VOCABULARY,
  capabilities: { requestChanges: true, batchedReview: true },
  authModesFor: () => ['token'],
  connect: () => {
    throw new Error('the connection is mocked');
  },
} as unknown as ScmProvider;

function pod() {
  return {
    id: 'pod-1',
    name: 'Platform',
    providerId: 'test',
    instanceUrl: 'https://example.test',
    sources: [{ kind: 'repository' as const, repoId: REF.repoId }],
    criteria: structuredClone(DEFAULT_CRITERIA),
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    modelId: 'lm:acme/turbo',
    repos: [{ id: REF.repoId, path: 'acme/repo-0', name: 'repo-0' }],
    username: 'me',
  };
}

/**
 * A stand-in for `ReviewRunManager` with the surface the panel touches. Tests
 * play the manager's part by writing the retained record and then notifying —
 * in that order, which is the one-writer rule the real manager keeps.
 */
function fakeRuns() {
  const listeners = new Set<(record: RunRecord) => void>();
  return {
    subscribe(listener: (record: RunRecord) => void) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    get: () => undefined,
    acknowledge: vi.fn(),
    cancel: vi.fn(),
    trigger: vi.fn(),
    settle(record: Partial<RunRecord>): void {
      for (const listener of [...listeners]) listener(record as RunRecord);
    },
  };
}

interface Harness {
  deps: ReviewFlowDeps;
  workspaceState: KeyValueStore & { updates: number };
  runs: ReturnType<typeof fakeRuns>;
  open: (ref?: ChangeRequestRef) => Promise<void>;
  post: (message: unknown) => Promise<void>;
  stored: () => SessionDraft | undefined;
}

async function harness(seed?: SessionDraft): Promise<Harness> {
  const workspaceState = memoryStore();
  world.workspaceState = workspaceState;
  if (seed) await workspaceState.update(draftKeyFor(REF), seed);
  workspaceState.updates = 0;
  const runs = fakeRuns();
  const deps: ReviewFlowDeps = {
    podStore: { activePod: pod(), upsert: vi.fn(() => Promise.resolve()) } as unknown as ReviewFlowDeps['podStore'],
    secrets: { get: () => Promise.resolve(undefined), store: () => Promise.resolve(), delete: () => Promise.resolve() },
    workspaceState,
    globalState: memoryStore(),
    runs: runs as unknown as ReviewRunManager,
  };
  const { ReviewFlowPanel } = await import('./reviewFlow.js');
  return {
    deps,
    workspaceState,
    runs,
    open: (ref = REF) => ReviewFlowPanel.open(deps, ref),
    post: async (message) => {
      handlers.message?.(message);
      // Message handling is `void`-dispatched; let its microtasks and any
      // immediate macrotask (the mocked connection's resolutions) drain.
      // Under fake timers a real setTimeout would stall, so advance by zero —
      // which runs due timers and flushes microtasks without reaching the
      // coalescing window.
      for (let i = 0; i < 8; i += 1) {
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
        else await new Promise((resolve) => setTimeout(resolve, 0));
      }
    },
    stored: () => workspaceState.get<SessionDraft>(draftKeyFor(REF)),
  };
}

beforeEach(() => {
  clearProviders();
  registerProvider(PROVIDER);
  panel.webview.html = '';
  panel.webview.postMessage.mockClear();
  world.submitReview = undefined;
  world.submitCalls = [];
  world.calls = { changeRequests: 0, diffs: 0, workItems: 0, submits: 0 };
  statusBarItems.length = 0;
  world.changeRequests = [changeRequest(), changeRequest(REF_B, 'Change B')];
  world.loadAgentSelection.mockReset().mockResolvedValue({
    agents: [BUILTIN_AGENT_DESCRIPTOR],
    models: [{ id: 'lm:acme/turbo', label: 'Turbo' }],
    skippedAgents: [],
    agentId: BUILTIN_AGENT_DESCRIPTOR.id,
    modelId: 'lm:acme/turbo',
    selectionNotices: [],
  });
  world.discoverModels.mockReset().mockResolvedValue([{ id: 'lm:acme/turbo', label: 'Turbo' }]);
  world.findReferenceFile.mockReset().mockResolvedValue(undefined);
  world.resolveAttachment.mockReset().mockResolvedValue({
    id: 'old-a-reference',
    kind: 'file',
    label: 'a.ts',
    path: 'a.ts',
    content: 'old A context',
  });
});

afterEach(() => {
  // Dispose the surface so the next test builds a fresh panel and route.
  handlers.dispose?.();
  handlers.message = undefined;
  handlers.viewState = undefined;
  handlers.windowState = undefined;
  vi.useRealTimers();
});

describe('run preparation stays bound to the target that started it', () => {
  it('drops delayed reference preparation after navigating to another change request', async () => {
    const h = await harness();
    await h.open();
    let releaseReference!: (target: { uri: unknown; workspaceFolder: unknown; relativePath: string }) => void;
    world.findReferenceFile.mockImplementationOnce(() => new Promise((resolve) => {
      releaseReference = resolve;
    }));

    void h.post({ type: 'run', instructions: 'Review #file:a.ts' });
    await vi.waitFor(() => expect(releaseReference).toBeTypeOf('function'));

    await h.open(REF_B);
    const beforeResolution = panel.webview.html;
    expect(beforeResolution).toContain('Change B');
    expect(beforeResolution).toContain('#file:a.ts did not resolve.');

    releaseReference({ uri: {}, workspaceFolder: {}, relativePath: 'a.ts' });
    await vi.waitFor(() => expect(world.resolveAttachment).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.runs.trigger).not.toHaveBeenCalled();
    expect(panel.webview.html).toBe(beforeResolution);
  });

  it('drops a run after navigation while pod selection persistence is pending', async () => {
    const h = await harness();
    await h.open();
    let releaseUpsert!: () => void;
    vi.mocked(h.deps.podStore.upsert).mockImplementationOnce(() => new Promise<void>((resolve) => {
      releaseUpsert = resolve;
    }));

    void h.post({ type: 'run' });
    await vi.waitFor(() => expect(releaseUpsert).toBeTypeOf('function'));

    await h.open(REF_B);
    const beforePersistence = panel.webview.html;
    releaseUpsert();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.runs.trigger).not.toHaveBeenCalled();
    expect(panel.webview.html).toBe(beforePersistence);
  });

  it('drops a run after navigation while model discovery is pending', async () => {
    const h = await harness();
    await h.open();
    let releaseDiscovery!: (models: Array<{ id: string; label: string }>) => void;
    world.discoverModels.mockImplementationOnce(() => new Promise((resolve) => {
      releaseDiscovery = resolve;
    }));

    void h.post({ type: 'run' });
    await vi.waitFor(() => expect(releaseDiscovery).toBeTypeOf('function'));

    await h.open(REF_B);
    const beforeDiscovery = panel.webview.html;
    releaseDiscovery([{ id: 'lm:acme/turbo', label: 'Turbo' }]);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(h.runs.trigger).not.toHaveBeenCalled();
    expect(panel.webview.html).toBe(beforeDiscovery);
  });
});

// ---- 4.3a — the carry-forward is a repair, not just a prerequisite -------------

describe('draft writes carry the retained result forward', () => {
  it('keeps ranAt and the result fields after a verdict, and the reopened target still says "Ran …"', async () => {
    const h = await harness(retainedRecord(['i1']));
    await h.open();

    // Triage and submit the review the way the reviewer does.
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'generateSummary' });
    await h.post({ type: 'submit' });

    // The record the run manager wrote must not have been stripped by the
    // panel's own draft writes: every result field survives the triage.
    const stored = h.stored();
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
    expect(stored?.ranAt).toBe(RAN_AT);
    expect(stored?.outcome).toBe('findings');
    expect(stored?.agentId).toBe(BUILTIN_AGENT_DESCRIPTOR.id);
    expect(stored?.agentLabel).toBe('Security Reviewer');
    expect(stored?.modelId).toBe('lm:acme/turbo');
    expect(stored?.candidates).toEqual([
      { severity: 'minor', category: 'style', confidence: 40, reason: 'belowConfidence', count: 2 },
    ]);
    expect(stored?.filesRead).toBe(2);
    expect(stored?.submittedAt).toBeDefined();

    // Reopening the target re-reads the record from storage; the done screen
    // renders its "Ran …" line from what was stored, not from panel memory.
    await h.open();
    expect(panel.webview.html).toContain('Ran ');
  });
});

// ---- 4.6 — coalescing, flush points, and the two drop mechanisms ---------------

describe('coalesced draft writes', () => {
  it('collapses several verdicts into one write carrying the final state', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1', 'i2', 'i3']));
    await h.open();

    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'verdict', itemId: 'i2', verdict: 'rejected' });
    await h.post({ type: 'verdict', itemId: 'i3', verdict: 'skipped' });
    // Nothing has landed yet — the burst is inside the window.
    expect(h.workspaceState.updates).toBe(0);

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    expect(h.workspaceState.updates).toBe(1);
    const stored = h.stored();
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
    expect(stored?.review.verdicts['i2']?.verdict).toBe('rejected');
    expect(stored?.review.verdicts['i3']?.verdict).toBe('skipped');
  });

  it('flushes when the panel is disposed, before the handler yields', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    handlers.dispose?.();

    // Synchronously durable: no timers were advanced, no promises awaited.
    expect(h.workspaceState.updates).toBe(1);
    expect(h.stored()?.review.verdicts['i1']?.verdict).toBe('accepted');
  });

  it('flushes when the tab stops being visible, before the handler yields', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    handlers.viewState?.({ webviewPanel: { active: false, visible: false } });

    expect(h.workspaceState.updates).toBe(1);
    expect(h.stored()?.review.verdicts['i1']?.verdict).toBe('accepted');
  });

  it('flushes when the editor window loses focus, before the handler yields', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    handlers.windowState?.({ focused: false });

    expect(h.workspaceState.updates).toBe(1);
    expect(h.stored()?.review.verdicts['i1']?.verdict).toBe('accepted');
  });

  it('flushes before the submit reaches the platform', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'generateSummary' });
    expect(h.workspaceState.updates).toBe(0);

    await h.post({ type: 'submit' });

    // What was on disk at the moment the platform was called already carried
    // the whole triage — the flush came first.
    expect(world.submitCalls).toHaveLength(1);
    const atCall = world.submitCalls[0]?.storedAtCall as SessionDraft;
    expect(atCall.review.verdicts['i1']?.verdict).toBe('accepted');
    expect(atCall.summaryText).not.toBe('');
    expect(atCall.ranAt).toBe(RAN_AT);
  });
});

describe('the generation guard and cancel-on-settle', () => {
  it('drops a pending write when a re-run settles, and the new run\'s retained review survives', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1', 'i2']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    // The manager finishing a re-run: it writes the new record FIRST, then
    // settles — the one-writer rule the panel's read-back depends on.
    const rerun = retainedRecord(['i9'], '2026-09-02T08:00:00.000Z');
    await h.workspaceState.update(draftKeyFor(REF), rerun);
    h.runs.settle({ key: runKeyForCr(REF), status: 'succeeded' });
    await h.post({ type: 'noop' });

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    // *A cached review is replaced only by a review that succeeds* — and the
    // pending write from before the settle is not such a review.
    const stored = h.stored();
    expect(stored?.ranAt).toBe('2026-09-02T08:00:00.000Z');
    expect(stored?.review.items.map((item) => item.id)).toEqual(['i9']);
    expect(stored?.review.verdicts).toEqual({});
    // The panel is showing the new run, not the old triage.
    expect(panel.webview.html).toContain('Finding i9');
  });

  it('drops a pending write whose record was replaced underneath it, without a settle observed', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    // The record changes hands without this panel being told (no settle
    // reaches it) — only the guard's own re-read stands between the deferred
    // write and the new record.
    const rerun = retainedRecord(['i9'], '2026-09-02T08:00:00.000Z');
    await h.workspaceState.update(draftKeyFor(REF), rerun);
    const updatesAfterRerun = h.workspaceState.updates;

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    // The deferred write re-read the key, saw a different `ranAt`, and
    // dropped itself: no further update, the re-run's record intact.
    expect(h.workspaceState.updates).toBe(updatesAfterRerun);
    expect(h.stored()?.ranAt).toBe('2026-09-02T08:00:00.000Z');
    expect(h.stored()?.review.items.map((item) => item.id)).toEqual(['i9']);
  });

  it('drops a pending write when a CLEAN re-run replaced the record', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    // A clean run is stored as a review with no items — a result, not a
    // deletion — and it too must not be clobbered by the stale triage write.
    const clean = retainedRecord([], '2026-09-02T08:00:00.000Z');
    await h.workspaceState.update(draftKeyFor(REF), clean);
    h.runs.settle({ key: runKeyForCr(REF), status: 'succeeded' });
    await h.post({ type: 'noop' });

    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    const stored = h.stored();
    expect(stored?.outcome).toBe('clean');
    expect(stored?.ranAt).toBe('2026-09-02T08:00:00.000Z');
    expect(stored?.review.items).toEqual([]);
    expect(panel.webview.html).toContain('No findings above your criteria');
  });
});

// ---- 4.7 — a coalesced record is one action's state, never a blend -------------

describe('coalesced record integrity', () => {
  it('reads back as the final complete state, never a mixture of two actions', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();

    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'generateSummary' });
    await h.post({ type: 'editSummary', text: 'Edited summary' });
    await h.post({ type: 'setNote', text: 'A final note' });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    // One write, and it is the state as of the LAST action in full: the
    // verdict from the first action and the texts from the later ones — not
    // the summary of one paired with the verdicts of another.
    expect(h.workspaceState.updates).toBe(1);
    const stored = h.stored();
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
    expect(stored?.summaryText).toBe('Edited summary');
    expect(stored?.finalNote).toBe('A final note');
    expect(stored?.ranAt).toBe(RAN_AT);
  });
});

// ---- 9.3 — the host holds every editable's in-progress text ---------------------

describe('instructions text commits (task 9.3)', () => {
  it('updates the in-memory criteria per keystroke and lands the one upsert on blur', async () => {
    const h = await harness(retainedRecord(['i1']));
    await h.open();

    // The debounced input commit: in-memory only — a podStore.upsert here
    // would be one uncoalesced read-modify-write per character (task 4.5).
    await h.post({ type: 'setInstructions', text: 'No nits' });
    expect(h.deps.podStore.activePod?.criteria.extraInstructions).toBe('No nits');
    expect(h.deps.podStore.upsert).not.toHaveBeenCalled();

    // The blur commit carries the write.
    await h.post({ type: 'commitInstructions', text: 'No nits.' });
    expect(h.deps.podStore.activePod?.criteria.extraInstructions).toBe('No nits.');
    expect(h.deps.podStore.upsert).toHaveBeenCalledTimes(1);
  });
});

describe('ask drafts are held per finding (task 9.3)', () => {
  it('stores a draft without rendering, and renders it back on the next repaint', async () => {
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    const before = panel.webview.html;

    await h.post({ type: 'askDraft', itemId: 'i1', text: 'is the cache keyed?' });
    // Stored and nothing more: a per-keystroke commit re-rendering the region
    // holding #ask would fight the caret it exists to protect.
    expect(panel.webview.html).toBe(before);

    await h.post({ type: 'select', itemId: 'i1' });
    expect(panel.webview.html).toContain('value="is the cache keyed?"');
  });

  it('drops the draft once the question is sent', async () => {
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'askDraft', itemId: 'i1', text: 'why?' });
    await h.post({ type: 'ask', itemId: 'i1', preset: 'freeform', text: 'why?' });

    // A repaint after the send must not resurrect the already-sent question.
    await h.post({ type: 'select', itemId: 'i1' });
    expect(panel.webview.html).not.toContain('value="why?"');
  });
});

describe('a regenerate replaces the summary text (task 9.7)', () => {
  it('renders the composed summary again, not the edit the reviewer had typed over it', async () => {
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'generateSummary' });

    // The composed text, as the summary screen just rendered it.
    const summaryOf = (html: string): string =>
      /<textarea class="summary" id="summary-text">([\s\S]*?)<\/textarea>/.exec(html)?.[1] ?? '';
    const generated = summaryOf(panel.webview.html);
    expect(generated).not.toBe('');

    await h.post({ type: 'editSummary', text: 'my own words' });
    // A sentinel proves the regenerate really repainted — editSummary
    // deliberately renders nothing, so without it a stale document would
    // pass the assertions below for free.
    panel.webview.html = 'sentinel';
    await h.post({ type: 'regenerate' });

    // The typed edit is deliberately NOT preserved: regenerate is the
    // reviewer asking for the composed text back (the other direction of the
    // typed-text requirement — see typedTextScript.test.ts for the page
    // half, where REGIONS_SCRIPT must not restore the stale value either).
    expect(panel.webview.html).not.toBe('sentinel');
    expect(summaryOf(panel.webview.html)).toBe(generated);
    expect(panel.webview.html).not.toContain('my own words');
  });
});

// ---- triage is local: patches, no platform calls (spec: an action fetches ------
// ---- only the data it could have changed / a state change redraws only the ----
// ---- part of the screen it affects) --------------------------------------------

describe('triage actions patch in place and never reach the platform', () => {
  it('a verdict, a move and a severity-floor change each patch flow-body — zero platform calls, no document reassignment', async () => {
    const h = await harness(retainedRecord(['i1', 'i2']));
    await h.open();
    // Arm the page the way REGIONS_SCRIPT does, so render() patches.
    await h.post({ type: 'verdictReady' });
    const htmlBefore = panel.webview.html;
    const callsBefore = { ...world.calls };
    panel.webview.postMessage.mockClear();

    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h.post({ type: 'move', delta: 1 });
    await h.post({ type: 'setFloor', floor: 'major' });

    // Three patches, each the flow-body region and the breadcrumb.
    const posted = panel.webview.postMessage.mock.calls
      .map((call) => call[0] as { type: string; regions?: Record<string, string> })
      .filter((message) => message.type === 'verdict:regions');
    expect(posted).toHaveLength(3);
    for (const message of posted) {
      expect(Object.keys(message.regions ?? {}).sort()).toEqual(['app-crumb-current', 'flow-body']);
    }
    // The document was never reassigned, and nothing was fetched: every one
    // of these interactions is local state.
    expect(panel.webview.html).toBe(htmlBefore);
    expect(world.calls).toEqual(callsBefore);
  });
});

// ---- freshness applies to platform data, not to review results -----------------

describe('a retained review does not expire (spec: freshness applies to platform data, not to review results)', () => {
  it('opening a target whose review is far older than any freshness window shows it in full and starts no run', async () => {
    // Ran three months ago — older than any poll interval by orders of
    // magnitude. Freshness governs pod data; this record has no TTL.
    const old = retainedRecord(['i1', 'i2'], '2026-06-01T08:00:00.000Z');
    old.review.verdicts = { i1: { verdict: 'accepted', applyFix: false } };
    const h = await harness(old);

    await h.open();

    // Shown in full, with its verdicts: the triage screen, opened on the
    // one undecided finding, with the recorded verdict already counted.
    expect(panel.webview.html).toContain('Finding i2');
    expect(panel.webview.html).toContain('1 of 2 triaged');
    expect(panel.webview.html).toContain('Run a new review');
    // Queue mode lists every finding, decided ones included.
    await h.post({ type: 'setMode', mode: 'queue' });
    expect(panel.webview.html).toContain('Finding i1');
    // And no new run was started to produce any of it.
    expect(h.runs.trigger).not.toHaveBeenCalled();
    expect(h.stored()?.review.verdicts['i1']?.verdict).toBe('accepted');
  });
});

// ---- 10.2 — the background-review-runs invariants, re-run against the ----------
// ---- coalesced persistence path ------------------------------------------------

describe('background-review-runs invariants against the coalesced path (task 10.2)', () => {
  it('a retained review, triaged through the coalescing writer, survives a restart in full', async () => {
    vi.useFakeTimers();
    const h1 = await harness(retainedRecord(['i1', 'i2']));
    await h1.open();
    await h1.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    await h1.post({ type: 'verdict', itemId: 'i2', verdict: 'rejected' });
    await h1.post({ type: 'generateSummary' });
    await h1.post({ type: 'editSummary', text: 'Summary that must survive' });
    await h1.post({ type: 'setNote', text: 'Note that must survive' });
    // The editor closes: dispose is the flush point.
    handlers.dispose?.();
    const onDisk = h1.stored();
    expect(onDisk).toBeDefined();

    // A restart: fresh module state, fresh panel, and the record read back
    // through the same JSON round-trip a real Memento imposes — a Date or a
    // Map smuggled into the record would not survive one.
    vi.useRealTimers();
    const carried = JSON.parse(JSON.stringify(onDisk)) as SessionDraft;
    const h2 = await harness(carried);
    await h2.open();

    expect(panel.webview.html).toContain('Finding i1');
    expect(panel.webview.html).toContain('2 of 2 triaged');
    const reread = h2.stored();
    expect(reread?.review.verdicts['i1']?.verdict).toBe('accepted');
    expect(reread?.review.verdicts['i2']?.verdict).toBe('rejected');
    expect(reread?.summaryText).toBe('Summary that must survive');
    expect(reread?.finalNote).toBe('Note that must survive');
    expect(reread?.ranAt).toBe(RAN_AT);
    expect(reread?.outcome).toBe('findings');
  });

  it('a re-run that FAILS does not replace the retained review — the pending triage write still lands on it', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    expect(h.workspaceState.updates).toBe(0);

    // The manager reports a failed re-run on this target. It wrote nothing
    // (a failure never touches the retained record), so the panel's pending
    // write belongs to the record still stored — it must NOT be dropped.
    h.runs.settle({ key: runKeyForCr(REF), status: 'failed' });
    await h.post({ type: 'noop' });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    const stored = h.stored();
    expect(stored?.ranAt).toBe(RAN_AT);
    expect(stored?.review.items.map((item) => item.id)).toEqual(['i1']);
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
  });

  it('a re-run that is CANCELLED leaves the retained review and its fresh verdicts intact', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });

    h.runs.settle({ key: runKeyForCr(REF), status: 'cancelled' });
    await h.post({ type: 'noop' });
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);

    // Cancellation re-enters the retained record (flushing the pending
    // write first); the screen shows the review again, unchanged.
    expect(panel.webview.html).toContain('Finding i1');
    const stored = h.stored();
    expect(stored?.ranAt).toBe(RAN_AT);
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
  });

  it('an in-flight run interrupted by a restart is reported interrupted, alongside an intact triage draft', async () => {
    vi.useFakeTimers();
    const h = await harness(retainedRecord(['i1']));
    await h.open();
    // A re-run is in flight, persistently recorded — what the manager writes
    // when it starts executing.
    const { InFlightRunStore, sweepInterruptedRuns } = await import('../app/reviewRunManager.js');
    const { ReviewRunStore } = await import('../app/reviewRuns.js');
    await new InFlightRunStore(h.deps.globalState).add({
      key: runKeyForCr(REF),
      podId: 'pod-1',
      refLabel: '#7',
      repoId: REF.repoId,
      crNumber: REF.number,
      startedAt: '2026-09-02T09:30:00.000Z',
    });
    // The reviewer triages meanwhile; the window losing focus flushes the
    // coalesced write before the editor goes down.
    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });
    handlers.windowState?.({ focused: false });

    // The restart: the sweep runs before anything paints (extension.ts).
    const swept = await sweepInterruptedRuns(h.deps.globalState);

    expect(swept).toBe(1);
    const run = new ReviewRunStore(h.deps.globalState).byRef().get(runKeyForCr(REF));
    expect(run?.outcome).toBe('interrupted');
    // Named with its own start time, not the sweep's.
    expect(run?.ranAt).toBe('2026-09-02T09:30:00.000Z');
    // The interruption is reported alongside the retained review, never in
    // place of it: the draft still carries the run's result and the triage.
    const stored = h.stored();
    expect(stored?.ranAt).toBe(RAN_AT);
    expect(stored?.review.verdicts['i1']?.verdict).toBe('accepted');
  });
});

// ---- task 10.3: what a triage session costs ------------------------------------

describe('a full triage session (task 10.3)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens, records ten verdicts and submits, without a platform call per verdict', async () => {
    const h = await harness(retainedRecord(Array.from({ length: 10 }, (_, i) => `i${i + 1}`)));
    await h.open();

    // What opening the target costs: the change-request lookup and the diff.
    // Everything after this is the session proper.
    const afterOpen = { ...world.calls };
    const writesAfterOpen = h.workspaceState.updates;

    for (let i = 1; i <= 10; i += 1) {
      await h.post({ type: 'verdict', itemId: `i${i}`, verdict: 'accepted', applyFix: false });
    }

    // Ten verdicts, zero platform calls. Before this change each render fired
    // onSidebarState, which refetched the whole pod — three calls a verdict,
    // thirty for this loop — and each verdict wrote the entire record.
    expect(world.calls).toEqual(afterOpen);
    expect(h.workspaceState.updates - writesAfterOpen).toBeLessThanOrEqual(1);

    // And the decisions are all there once the window closes: coalescing
    // collapses the writes, it does not drop any of the state they carried.
    await vi.advanceTimersByTimeAsync(DRAFT_WRITE_WINDOW_MS);
    const stored = h.stored();
    for (let i = 1; i <= 10; i += 1) {
      expect(stored?.review.verdicts[`i${i}`]?.verdict).toBe('accepted');
    }
  });
});

// ---- task 10.1 gap 3: a verdict reaches every screen showing the review's progress

describe("recording a verdict reaches every screen that shows the review's progress", () => {
  it('propagates through onSidebarState to the sidebar\'s triage region and the status bar', async () => {
    // The "no platform request" half of this scenario is covered throughout
    // this file already (e.g. task 10.3's assertion above). What is missing
    // is the AND clause: every screen showing the review's progress reflects
    // the new verdict. Driven for real — a real AppStore, VerdictSidebarProvider
    // and VerdictStatusBar, wired through onSidebarState exactly the way
    // extension.ts wires them (sidebar.setActiveReview + statusBar.setActiveReview) —
    // rather than asserting on a fake stand-in for either screen.
    const sidebarPod = pod();
    const podStoreFake = { activePod: sidebarPod, list: () => [sidebarPod] } as never;
    const appStore = new AppStore({
      podStore: podStoreFake,
      secrets: {} as never,
      reviewHistory: { list: () => [] } as never,
      baseSeconds: () => 60,
    });
    const sidebarView = { html: '', postMessage: vi.fn() };
    const sidebar = new VerdictSidebarProvider(podStoreFake, {
      appStore,
      extensionUri: {} as never,
      globalState: memoryStore() as never,
      openCr: () => undefined,
    });
    sidebar.resolveWebviewView({
      webview: {
        get html(): string {
          return sidebarView.html;
        },
        set html(value: string) {
          sidebarView.html = value;
        },
        postMessage: sidebarView.postMessage,
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        options: undefined,
        cspSource: 'test:',
        asWebviewUri: undefined,
      },
      onDidDispose: () => ({ dispose: () => undefined }),
    } as never);
    // The sidebar's own first pod read (unrelated to the review) lands here.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const statusBar = new VerdictStatusBar();
    const verdictSegment = statusBarItems[0] as unknown as { text: string; tooltip: string };

    const h = await harness(retainedRecord(['i1', 'i2']));
    h.deps.onSidebarState = (state) => {
      sidebar.setActiveReview(state);
      statusBar.setActiveReview(state);
    };
    await h.open();

    // Baseline, before any triage: two undecided findings, nothing recorded.
    expect(sidebarView.html).toContain('0 acc');
    expect(sidebarView.html).toContain('2 left');
    expect(verdictSegment.tooltip).toContain('0 accepted, 0 rejected, 0 skipped');
    expect(verdictSegment.text).toContain('2 left');

    await h.post({ type: 'verdict', itemId: 'i1', verdict: 'accepted' });

    // Both screens reflect the actual new counts — not a string ("Verdict",
    // "acc"/"left" labels) that would read the same regardless of which
    // verdict was recorded, but the accepted/undecided numbers themselves.
    expect(sidebarView.html).toContain('1 acc');
    expect(sidebarView.html).toContain('1 left');
    expect(sidebarView.html).toContain('1/2');
    expect(verdictSegment.tooltip).toContain('1 accepted, 0 rejected, 0 skipped');
    expect(verdictSegment.text).toContain('1 left');

    statusBar.dispose();
  });
});
