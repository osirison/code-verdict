/**
 * The review-flow panel's draft persistence: the coalescing writer, its flush
 * points, the carry-forward of the run-manager's result fields, and the
 * generation guard that keeps a deferred write from landing on top of a newer
 * run's retained review (design D9).
 *
 * Everything here drives the real panel through its message handler against an
 * in-memory `KeyValueStore`, the way the reviewer does — the writer is never
 * poked directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// ---- vscode and module mocks ---------------------------------------------------

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
  dispose: undefined as (() => void) | undefined,
  viewState: undefined as ((event: { webviewPanel: { active: boolean; visible: boolean } }) => void) | undefined,
  windowState: undefined as ((state: { focused: boolean }) => void) | undefined,
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
  window: {
    createWebviewPanel: () => panel,
    showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    showWarningMessage: vi.fn(() => Promise.resolve(undefined)),
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
    onDidChangeWindowState: (handler: (state: { focused: boolean }) => void) => {
      handlers.windowState = handler;
      return { dispose: vi.fn() };
    },
  },
  workspace: {
    getConfiguration: () => ({ get: (_key: string, fallback?: unknown) => fallback }),
    workspaceFolders: [],
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
  env: {
    clipboard: { writeText: vi.fn(() => Promise.resolve(undefined)) },
    openExternal: vi.fn(),
  },
  Uri: { parse: () => ({}) },
}));

// The pickers' discovery walks the filesystem and `vscode.lm`; the tests are
// about persistence, so a fixed selection is enough.
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
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      listOpenChangeRequests: () => Promise.resolve([changeRequest()]),
      getChangeRequestDiff: () => Promise.resolve(DIFF),
      listWorkItems: () => Promise.resolve([]),
      submitReview: (_ref: unknown, submission: { comments: Array<{ key: string }>; requestChanges: boolean }) => {
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

function changeRequest() {
  return {
    ref: REF,
    title: 'Add per-tenant rate limiting',
    state: 'open' as const,
    sourceBranch: 'feat/rate-limit',
    targetBranch: 'main',
    author: { username: 'author' },
    reviewers: [],
    webUrl: 'https://example.test/pr/7',
    updatedAt: '2026-08-20T09:00:00Z',
    headSha: 'aaaa',
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
});

afterEach(() => {
  // Dispose the surface so the next test builds a fresh panel and route.
  handlers.dispose?.();
  handlers.message = undefined;
  handlers.viewState = undefined;
  handlers.windowState = undefined;
  vi.useRealTimers();
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
