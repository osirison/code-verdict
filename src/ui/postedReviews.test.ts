/**
 * The posted-reviews panel stops refetching history on a thread action
 * (issue #46 tasks 7.4, 7.4a, 7.4b, and the posted-reviews half of 9.3).
 *
 * Before this change, `resolve`/`concede`/`reply` all ended in `await
 * this.refresh()` — a full re-fetch (the open-CR list plus one
 * `buildPostedReview` per submitted review) just to reflect one thread
 * changing. These tests drive the real `PostedReviewsPanel` through its
 * message handler against a fake connection that counts calls, the way a
 * reviewer would: open the panel, let the initial fetch land, then act on a
 * thread and assert nothing reaches the platform beyond the action's own
 * call.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearProviders } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import type { PodStore } from '../app/pods';
import type { KeyValueStore, SecretStore } from '../app/storage';
import type { SubmittedReview } from '../app/reviewHistory';
import type { ChangeRequest, ReviewThread } from '../platform/types';
import type { PostedReviewsDeps } from './postedReviews';
import { AppSurface } from './appSurface';

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

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: {
    createWebviewPanel: () => panel,
    showErrorMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  commands: { executeCommand: vi.fn(() => Promise.resolve(undefined)) },
}));

const world = vi.hoisted(() => ({
  calls: { listOpenChangeRequests: 0, listThreads: 0, resolveThread: 0, replyToThread: 0 },
  crs: [] as ChangeRequest[],
  threads: [] as ReviewThread[],
}));

vi.mock('../app/connections', () => ({
  connectionForPod: () =>
    Promise.resolve({
      listOpenChangeRequests: () => {
        world.calls.listOpenChangeRequests += 1;
        return Promise.resolve(world.crs);
      },
      listThreads: (ref: { repoId: string; number: string }) => {
        world.calls.listThreads += 1;
        // Filtered by ref (as the real platform call is scoped): every
        // existing test seeds `world.threads` for REF alone, so this is a
        // no-op there — filtering only matters once a second submitted
        // review with its own crNumber is in play (the archived-filter
        // test), where an unfiltered return would show REF's threads under
        // the wrong review.
        return Promise.resolve(world.threads.filter((t) => t.crRef.repoId === ref.repoId && t.crRef.number === ref.number));
      },
      resolveThread: () => {
        world.calls.resolveThread += 1;
        return Promise.resolve(undefined);
      },
      replyToThread: () => {
        world.calls.replyToThread += 1;
        return Promise.resolve(undefined);
      },
    }),
}));

// ---- fixtures --------------------------------------------------------------------

const REF = { repoId: 'acme/repo', number: '7' };

function pod() {
  return {
    id: 'pod-1',
    name: 'Platform squad',
    providerId: 'github',
    instanceUrl: 'https://github.example',
    username: 'you',
    sources: [{ kind: 'repository', repoId: REF.repoId }],
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: [], extraInstructions: '' },
    agentId: '',
    repos: [{ id: REF.repoId, path: REF.repoId, name: 'repo' }],
  };
}

function submittedReview(): SubmittedReview {
  return {
    repoId: REF.repoId,
    crNumber: REF.number,
    podId: 'pod-1',
    agentId: 'verdict.demo-agent',
    agentLabel: 'Verdict · Demo Review',
    submittedAt: '2026-08-20T10:00:00.000Z',
    counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
    threads: { item1: 'thread-1' },
    postedComments: 1,
    requestedChanges: false,
  };
}

function changeRequest(): ChangeRequest {
  return {
    ref: REF,
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

/** A thread the author has replied to — open, "awaiting" from the reviewer's side. */
function reviewThread(overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    id: 'thread-1',
    crRef: REF,
    resolved: false,
    anchorPresent: true,
    notes: [
      { id: 'n1', author: { username: 'you' }, body: 'This logs the refresh token in cleartext.', createdAt: '2026-08-20T10:05:00.000Z' },
      { id: 'n2', author: { username: 'author' }, body: 'Pushed a fix — can you re-check?', createdAt: '2026-08-20T11:00:00.000Z' },
    ],
    ...overrides,
  };
}

function memoryStore(seed: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T,>(key: string) => map.get(key) as T | undefined,
    update: (key: string, value: unknown) => {
      map.set(key, value);
      return Promise.resolve();
    },
  };
}

function makeDeps(globalState: KeyValueStore): PostedReviewsDeps {
  const activePod = pod();
  const podStore = { activePod } as unknown as PodStore;
  return {
    podStore,
    secrets: {} as SecretStore,
    globalState,
    openReviewFlow: vi.fn(),
    onSidebarThreads: vi.fn(),
  };
}

/** Drains the microtask queue for the panel's `await`-chained refresh/message handling. */
async function flush(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

type RegionsMessage = { type: 'verdict:regions'; regions: Record<string, string> };

/** The last region patch; the page is also sent `verdict:replySettled` after a reply ends. */
function lastPosted(): RegionsMessage {
  return panel.webview.postMessage.mock.calls
    .map((c) => c[0] as { type: string })
    .filter((m) => m.type === 'verdict:regions')
    .at(-1) as RegionsMessage;
}

async function openPanel(globalState: KeyValueStore) {
  const { PostedReviewsPanel } = await import('./postedReviews.js');
  const deps = makeDeps(globalState);
  await PostedReviewsPanel.show(deps);
  await flush();
  // Arm the route so the panel patches regions instead of falling back to a
  // full setHtml — the shape every migrated screen already uses.
  handlers.message?.({ type: 'verdictReady' });
  panel.webview.postMessage.mockClear();
  return { deps };
}

beforeEach(() => {
  registerBuiltInProviders();
  world.calls = { listOpenChangeRequests: 0, listThreads: 0, resolveThread: 0, replyToThread: 0 };
  world.crs = [changeRequest()];
  world.threads = [reviewThread()];
  panel.webview.html = '';
  panel.webview.postMessage.mockClear();
});

/**
 * Settlers for every `replyToThread` a test left pending. The panel's one-send-
 * per-thread guard is static (it must outlive a panel), so a send still pending
 * when a test ends would make the next test's replies be dropped.
 */
const pendingSends: Array<() => void> = [];
/**
 * Pages a test wired to the panel. A page left open keeps its 300ms draft timer,
 * which would fire into the next test's panel (`handlers.message` is shared).
 */
const openPages: JSDOM[] = [];

afterEach(async () => {
  for (const settle of pendingSends.splice(0)) settle();
  await flush();
  for (const page of openPages.splice(0)) page.window.close();
  panel.webview.postMessage.mockReset();
  // Dispose the surface so the next test builds a fresh panel and route —
  // `AppSurface`'s and `PostedReviewsPanel`'s statics otherwise survive test
  // boundaries in the same module instance.
  handlers.dispose?.();
  handlers.message = undefined;
  clearProviders();
});

describe('posted-review thread actions patch instead of refetching (task 7.4)', () => {
  it('opening the panel fetches the open-CR list and every thread list once', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    await openPanel(globalState);
    expect(world.calls).toEqual({ listOpenChangeRequests: 1, listThreads: 1, resolveThread: 0, replyToThread: 0 });
  });

  it('resolving a thread calls resolveThread and issues no other platform call', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    await openPanel(globalState);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'resolve', threadId: 'thread-1', resolved: true });
    await flush();

    expect(world.calls).toEqual({ listOpenChangeRequests: 1, listThreads: 1, resolveThread: 1, replyToThread: 0 });
    const posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    expect(posted.regions['pr-detail']).toContain('resolved by @you');
    expect(posted.regions['pr-detail']).toContain('data-reopen="thread-1"');
  });

  it('conceding a thread calls resolveThread and issues no other platform call', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    await openPanel(globalState);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'concede', threadId: 'thread-1' });
    await flush();

    expect(world.calls).toEqual({ listOpenChangeRequests: 1, listThreads: 1, resolveThread: 1, replyToThread: 0 });
    const posted = lastPosted();
    expect(posted.regions['pr-detail']).toContain("conceded — they were right");
  });

  it('replying calls replyToThread and issues no other platform call, and clears the draft on success', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    await openPanel(globalState);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'Still not convinced.' });
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
    await flush();

    expect(world.calls).toEqual({ listOpenChangeRequests: 1, listThreads: 1, resolveThread: 0, replyToThread: 1 });
    const posted = lastPosted();
    expect(posted.regions['pr-detail']).toContain('Still not convinced.');
    // The draft is gone — the field the patch emits is empty, not the sent text.
    expect(posted.regions['pr-detail']).toContain('id="reply-input" data-reply="thread-1" value=""');
  });

  it('a failed reply posts no patch and the outer catch reports the error — the typed text is never touched', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    const { PostedReviewsPanel } = await import('./postedReviews.js');
    const deps = makeDeps(globalState);
    await PostedReviewsPanel.show(deps);
    await flush();
    handlers.message?.({ type: 'verdictReady' });

    const vscode = await import('vscode');
    const connections = await import('../app/connections.js');
    const spy = vi.spyOn(connections, 'connectionForPod').mockResolvedValueOnce({
      listOpenChangeRequests: () => Promise.resolve(world.crs),
      listThreads: () => Promise.resolve(world.threads),
      resolveThread: () => Promise.resolve(undefined),
      replyToThread: () => Promise.reject(new Error('network down')),
    } as never);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
    await flush();

    // No patch, only the note that the send is over (so the page can allow a retry).
    expect(panel.webview.postMessage.mock.calls.map((c) => (c[0] as { type: string }).type)).toEqual(['verdict:replySettled']);
    expect(panel.webview.postMessage).toHaveBeenCalledWith({
      type: 'verdict:replySettled', threadId: 'thread-1', text: 'Still not convinced.', ok: false,
    });
    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(expect.stringContaining('network down'));
    spy.mockRestore();
  });

  it('a failed reply keeps the held draft — the next repaint still offers the typed text for a retry (task 9.7)', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    const { PostedReviewsPanel } = await import('./postedReviews.js');
    const deps = makeDeps(globalState);
    await PostedReviewsPanel.show(deps);
    await flush();
    handlers.message?.({ type: 'verdictReady' });

    const connections = await import('../app/connections.js');
    const spy = vi.spyOn(connections, 'connectionForPod').mockResolvedValueOnce({
      listOpenChangeRequests: () => Promise.resolve(world.crs),
      listThreads: () => Promise.resolve(world.threads),
      resolveThread: () => Promise.resolve(undefined),
      replyToThread: () => Promise.reject(new Error('network down')),
    } as never);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'Still not convinced.' });
    handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
    await flush();

    // Collapse and re-expand the thread: the re-render reads the held draft,
    // and the failed send must not have deleted it — only a send that reached
    // the platform makes the draft stale (task 7.4b).
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    const posted = lastPosted();
    expect(posted.regions['pr-detail']).toContain('value="Still not convinced."');
    spy.mockRestore();
  });

  describe('while a reply is still being sent', () => {
    /** A `replyToThread` the test answers by hand; `calls` counts what reached the platform. */
    async function slowSend() {
      const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
      const { PostedReviewsPanel } = await import('./postedReviews.js');
      await PostedReviewsPanel.show(makeDeps(globalState));
      await flush();
      handlers.message?.({ type: 'verdictReady' });
      let settle!: { resolve: () => void; reject: (e: Error) => void };
      const calls: string[] = [];
      const connections = await import('../app/connections.js');
      const spy = vi.spyOn(connections, 'connectionForPod').mockResolvedValue({
        listOpenChangeRequests: () => Promise.resolve(world.crs),
        listThreads: () => Promise.resolve(world.threads),
        resolveThread: () => Promise.resolve(undefined),
        replyToThread: (_ref: unknown, _id: string, body: string) => {
          calls.push(body);
          return new Promise<void>((resolve, reject) => {
            settle = { resolve, reject };
            pendingSends.push(resolve);
          });
        },
      } as never);
      handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
      panel.webview.postMessage.mockClear();
      return { calls, spy, settle: () => settle };
    }

    it('a second reply for the same thread is dropped, not posted twice', async () => {
      const { calls, spy, settle } = await slowSend();
      handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
      await flush();
      handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
      await flush();
      settle().resolve();
      await flush();
      expect(calls).toEqual(['Still not convinced.']);
      spy.mockRestore();
    });

    it('a draft typed during the send survives its success and is not sent', async () => {
      const { calls, spy, settle } = await slowSend();
      handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'Still not convinced.' });
      handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
      await flush();
      handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'And one more thing' });
      settle().resolve();
      await flush();
      expect(calls).toEqual(['Still not convinced.']);
      expect(lastPosted().regions['pr-detail']).toContain('value="And one more thing"');
      spy.mockRestore();
    });

    it('a failed send leaves the held draft exactly as the page last committed it, and releases the thread for a retry', async () => {
      const { calls, spy, settle } = await slowSend();
      handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'Still not convinced.' });
      handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
      await flush();
      handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'Still not convinced. And one more thing' });
      settle().reject(new Error('network down'));
      await flush();
      expect(calls).toEqual(['Still not convinced.']);
      handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
      handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
      expect(lastPosted().regions['pr-detail']).toContain('value="Still not convinced. And one more thing"');
      // The failure released the thread: a retry goes out.
      handlers.message?.({ type: 'reply', threadId: 'thread-1', text: 'Still not convinced.' });
      await flush();
      expect(calls).toHaveLength(2);
      settle().resolve();
      await flush();
      spy.mockRestore();
    });
  });

  it('a resolve on one thread does not disturb an unrelated thread\'s in-progress reply draft', async () => {
    world.threads = [
      reviewThread({ id: 'thread-1' }),
      reviewThread({ id: 'thread-2', notes: [{ id: 'n3', author: { username: 'you' }, body: 'Second finding.', createdAt: '2026-08-20T10:06:00.000Z' }] }),
    ];
    const entry = { ...submittedReview(), threads: { item1: 'thread-1', item2: 'thread-2' } };
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [entry] });
    await openPanel(globalState);

    // Type into thread-2's field, then switch to thread-1 and resolve it.
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-2' });
    handlers.message?.({ type: 'replyDraft', threadId: 'thread-2', text: 'Draft for the other thread.' });
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-2' }); // collapse thread-2
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' }); // expand thread-1
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'resolve', threadId: 'thread-1', resolved: true });
    await flush();

    // Expand thread-2 again and confirm its draft survived the unrelated
    // thread-1 action untouched (watch point: a patch must not destroy a
    // draft for a different thread than the one being acted on).
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' }); // collapse thread-1
    handlers.message?.({ type: 'toggleThread', threadId: 'thread-2' }); // expand thread-2
    const posted = lastPosted();
    expect(posted.regions['pr-detail']).toContain('value="Draft for the other thread."');
  });

  it('a real refresh (⟳) still fetches everything and drops drafts for threads no longer returned', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    await openPanel(globalState);

    handlers.message?.({ type: 'toggleThread', threadId: 'thread-1' });
    handlers.message?.({ type: 'replyDraft', threadId: 'thread-1', text: 'About to vanish.' });

    // The next fetch no longer returns this thread at all (e.g. the platform
    // discussion itself is gone) — the draft must not survive it forever.
    world.threads = [];
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'refresh' });
    await flush();

    expect(world.calls).toEqual({ listOpenChangeRequests: 2, listThreads: 2, resolveThread: 0, replyToThread: 0 });
    // The panel was already painted once (issue #39's "arrived by
    // navigation" guard), so this refresh patches regions same as any other
    // render — the draft prune is what this test is really after: the thread
    // is gone from the fetch, so its draft must not survive into the patch.
    const posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    expect(posted.regions['pr-detail']).not.toContain('About to vanish.');

    // Prove the draft was actually deleted, not merely hidden behind an
    // absent thread: bring thread-1 back on the next fetch and confirm its
    // reply field comes back empty rather than replaying the old text.
    // expandedThreadId is untouched panel state — still 'thread-1' from
    // earlier in this test — so thread-1 renders expanded again with no
    // further toggle needed.
    world.threads = [reviewThread()];
    handlers.message?.({ type: 'refresh' });
    await flush();
    const rePosted = lastPosted();
    expect(rePosted.regions['pr-detail']).toContain('id="reply-input" data-reply="thread-1" value=""');
  });
});

// ---- filtering updates the list from state already held (ui-responsiveness: "Filtering or changing severity floor") ----

describe('the archived filter reveals its own rows from state already held', () => {
  it('toggling "Archived" shows the archived review\'s own row, not merely an unchanged fetch count', async () => {
    // review-7's CR is still open (world.crs, seeded in beforeEach); review-99's
    // is not — buildPostedRows marks a row archived exactly when its CR is
    // absent from that same open-CR list, so review-99 is archived with no
    // separate flag to set.
    const archived: SubmittedReview = {
      ...submittedReview(),
      crNumber: '99',
      submittedAt: '2026-08-19T10:00:00.000Z',
      threads: {},
    };
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview(), archived] });
    await openPanel(globalState);

    // Hidden by default — the THEN this test exists to strengthen is that the
    // toggle changes what the list actually shows, not just that no fetch runs.
    expect(panel.webview.html).not.toContain('#99');

    handlers.message?.({ type: 'toggleArchived' });
    await flush();

    expect(world.calls.listOpenChangeRequests).toBe(1);
    expect(world.calls.listThreads).toBe(2);
    const posted = lastPosted();
    expect(posted.type).toBe('verdict:regions');
    // The filtered set itself changed — review-99's row is now in the list,
    // from the fetch already held, with zero further platform calls.
    expect(posted.regions['pr-rows']).toContain('#99');
    expect(world.calls.listOpenChangeRequests).toBe(1);
    expect(world.calls.listThreads).toBe(2);

    // And toggling back off removes it again — this is a filter, not a permanent reveal.
    panel.webview.postMessage.mockClear();
    handlers.message?.({ type: 'toggleArchived' });
    await flush();
    expect(lastPosted().regions['pr-rows']).not.toContain('#99');
  });
});

// ---- a hidden screen's data changes (ui-responsiveness: "A hidden screen's data changes") ----

describe('posted reviews while the reviewer is looking at another screen', () => {
  it('data changing while posted reviews is hidden reaches neither the platform nor the webview, and shows on return', async () => {
    const globalState = memoryStore({ 'codeVerdict.submittedReviews': [submittedReview()] });
    const { deps } = await openPanel(globalState);
    const { PostedReviewsPanel } = await import('./postedReviews.js');

    // The reviewer navigates to another real screen — AppSurface itself, the
    // shared surface every screen shows through, stands in for it: showing a
    // different route id disposes the panel's route exactly as a real
    // navigation to the dashboard, settings, or anywhere else would.
    AppSurface.show('elsewhere', 'Verdict: Elsewhere');

    // Background activity changes posted reviews' own data while it is not
    // the visible screen: new commits moved the anchor out from under
    // thread-1 (the platform's own "line moved" signal), something only this
    // screen depends on.
    world.threads = [reviewThread({ anchorPresent: false })];
    panel.webview.postMessage.mockClear();
    const callsBefore = { ...world.calls };

    // The panel's own "something changed" path, called the way a background
    // poll or another screen's fetch would call it.
    await PostedReviewsPanel.refreshIfOpen();

    // The visible screen (the other route) is unaffected: disposed on
    // leaving, this panel does not even attempt a refetch or a repaint.
    expect(world.calls).toEqual(callsBefore);
    expect(panel.webview.postMessage).not.toHaveBeenCalled();

    // The reviewer returns: a fresh open re-fetches (no mockClear() until the
    // shared helper's own — read the patch it produces first) and shows the
    // change that happened while the screen was hidden.
    await PostedReviewsPanel.show(deps);
    await flush();
    expect(world.calls.listThreads).toBe(callsBefore.listThreads + 1);
    expect(lastPosted().regions['pr-detail']).toContain('thread stale');
  });
});

// ---- the real panel and the real page script, wired together ----------------------
//
// Reported from a live run: two Enter presses during one send post it twice,
// and text typed while a send is in flight is dropped. The tests above drive
// the panel with hand-written messages and the page tests drive the script
// with hand-written patches; neither can see a defect that lives in the
// hand-off between them (a patch the page holds off, a draft the host replaces).
// Here the page's postMessage goes to the panel's handler, the panel's
// postMessage goes to the page's window, `replyToThread` is settled by hand,
// and the assertions are on what the field shows and what the platform got.

describe('a reply sent while its send is in flight (panel and page wired together)', () => {
  const SENT = 'Still not convinced.';
  const MORE = ' And one more thing';

  interface Send { body: string; resolve: () => void; reject: (e: Error) => void }

  async function wired() {
    const entry = { ...submittedReview(), threads: { item1: 'thread-1', item2: 'thread-2' } };
    // A second review (#8) with its own thread, so "click another review" is real.
    const other = { ...submittedReview(), crNumber: '8', submittedAt: '2026-08-19T10:00:00.000Z', threads: { item1: 'thread-9' } };
    const otherRef = { repoId: REF.repoId, number: '8' };
    world.crs = [changeRequest(), { ...changeRequest(), ref: otherRef }];
    world.threads = [
      reviewThread({ id: 'thread-1' }),
      reviewThread({ id: 'thread-2', notes: [{ id: 'n3', author: { username: 'you' }, body: 'Second finding.', createdAt: '2026-08-20T10:06:00.000Z' }] }),
      reviewThread({ id: 'thread-9', crRef: otherRef }),
    ];
    const { PostedReviewsPanel } = await import('./postedReviews.js');
    const deps = makeDeps(memoryStore({ 'codeVerdict.submittedReviews': [entry, other] }));
    await PostedReviewsPanel.show(deps);
    await flush();

    const sends: Send[] = [];
    const connections = await import('../app/connections.js');
    const spy = vi.spyOn(connections, 'connectionForPod').mockResolvedValue({
      listOpenChangeRequests: () => Promise.resolve(world.crs),
      listThreads: () => Promise.resolve(world.threads),
      resolveThread: () => Promise.resolve(undefined),
      replyToThread: (_ref: unknown, _id: string, body: string) =>
        new Promise<void>((resolve, reject) => {
          sends.push({ body, resolve, reject });
          pendingSends.push(resolve);
        }),
    } as never);

    // What the page sends the panel.
    const toPanel: Array<{ type: string }> = [];
    const dom = new JSDOM(panel.webview.html, {
      runScripts: 'dangerously',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: (m: { type: string }) => { toPanel.push(m); handlers.message?.(m); },
        });
        window.scrollTo = (() => undefined) as typeof window.scrollTo;
      },
    });
    openPages.push(dom);
    panel.webview.postMessage.mockImplementation((m: unknown) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
      return Promise.resolve(true);
    });
    await flush();
    const document = dom.window.document;

    const click = async (selector: string): Promise<void> => {
      (document.querySelector(selector) as HTMLElement).click();
      await flush();
    };
    const field = (): HTMLInputElement => document.getElementById('reply-input') as HTMLInputElement;
    /** Types at the end of the field, as a person at the caret does. */
    const typeMore = (extra: string): void => {
      field().focus();
      field().value += extra;
      field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    };
    const enter = async (): Promise<void> => {
      field().focus();
      field().dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await flush();
    };
    const sendBodies = (): string[] => sends.map((s) => s.body);
    const settle = async (index: number, how: 'resolve' | 'reject'): Promise<void> => {
      if (how === 'resolve') sends[index]!.resolve(); else sends[index]!.reject(new Error('network down'));
      await flush();
    };
    const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

    await click('[data-toggle="thread-1"]');
    return { spy, dom, document, click, field, typeMore, enter, sendBodies, settle, wait, deps, toPanel, PostedReviewsPanel };
  }

  it('keeps the text in the field for the whole send, and clears it once the send succeeds', async () => {
    const { spy, field, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    expect(sendBodies()).toEqual([SENT]);
    expect(field().value).toBe(SENT);
    await settle(0, 'resolve');
    expect(field().value).toBe('');
    spy.mockRestore();
  });

  it('a press during a send reaches the platform once, and the field keeps its text', async () => {
    const { spy, field, typeMore, enter, click, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    await enter();
    await click('[data-reply-send]');
    expect(sendBodies()).toEqual([SENT]);
    expect(field().value).toBe(SENT);
    // New text and another Enter while A is pending: not posted, not hidden.
    typeMore(MORE);
    await enter();
    expect(sendBodies()).toEqual([SENT]);
    expect(field().value).toBe(SENT + MORE);
    await settle(0, 'resolve');
    // Only what was sent left the field; the rest waits for an explicit Enter.
    expect(field().value).toBe('And one more thing');
    expect(sendBodies()).toEqual([SENT]);
    await enter();
    expect(sendBodies()).toEqual([SENT, 'And one more thing']);
    spy.mockRestore();
  });

  it('a failed send leaves sent text and later typing in the field, and a retry sends all of it', async () => {
    const { spy, field, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    await settle(0, 'reject');
    expect(field().value).toBe(SENT + MORE);
    await enter();
    expect(sendBodies()).toEqual([SENT, SENT + MORE]);
    await settle(1, 'resolve');
    expect(field().value).toBe('');
    spy.mockRestore();
  });

  it('a failed send with no typing since lets the same text be retried', async () => {
    const { spy, field, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    await settle(0, 'reject');
    expect(field().value).toBe(SENT);
    await enter();
    expect(sendBodies()).toEqual([SENT, SENT]);
    spy.mockRestore();
  });

  it('a field edited so it no longer starts with the sent text is left alone when the send succeeds', async () => {
    const { spy, dom, field, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    field().value = 'Something else entirely';
    field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(0, 'resolve');
    expect(field().value).toBe('Something else entirely');
    expect(sendBodies()).toEqual([SENT]);
    spy.mockRestore();
  });

  it('typing before the debounce fires: success keeps only the new text, and the late draft commit does not bring the old back', async () => {
    const { spy, field, typeMore, enter, click, settle, wait } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    await settle(0, 'resolve');
    expect(field().value).toBe('And one more thing');
    await wait(350);
    // A repaint from the host's held draft shows what the host believes.
    await click('[data-toggle="thread-2"]');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('And one more thing');
    spy.mockRestore();
  });

  it('typing after the debounce fired: the same result', async () => {
    const { spy, field, typeMore, enter, click, settle, wait } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    await wait(350);
    await settle(0, 'resolve');
    expect(field().value).toBe('And one more thing');
    await click('[data-toggle="thread-2"]');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('And one more thing');
    spy.mockRestore();
  });

  it('an unrelated thread refilling the box with the sent text mid-send does not leave it postable after success', async () => {
    const { spy, dom, field, typeMore, enter, click, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    // Another thread is opened and thread-1 reopened: its field is repainted from the held draft.
    await click('[data-toggle="thread-2"]');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe(SENT);
    // The person types a character and deletes it.
    typeMore('x');
    field().value = field().value.slice(0, -1);
    field().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await settle(0, 'resolve');
    expect(field().value).toBe('');
    await enter();
    expect(sendBodies()).toEqual([SENT]);
    spy.mockRestore();
  });

  it('two threads sending at once settle independently', async () => {
    const { spy, field, typeMore, enter, click, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    await click('[data-toggle="thread-2"]');
    expect(field().value).toBe('');
    typeMore('Second thread reply');
    await enter();
    expect(sendBodies()).toEqual([SENT, 'Second thread reply']);
    // Thread 1 finishes while thread 2 is on screen: thread 2's field is untouched.
    await settle(0, 'resolve');
    expect(field().value).toBe('Second thread reply');
    await settle(1, 'resolve');
    expect(field().value).toBe('');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('');
    expect(sendBodies()).toHaveLength(2);
    spy.mockRestore();
  });

  it('leaving the screen mid-send and coming back: the send is still guarded, and the settled note still reaches the page', async () => {
    const { spy, field, typeMore, enter, click, sendBodies, settle, deps, PostedReviewsPanel } = await wired();
    typeMore(SENT);
    await enter();
    // The panel is disposed on leaving; the call is not.
    AppSurface.show('elsewhere', 'Verdict: Elsewhere');
    await PostedReviewsPanel.show(deps);
    await flush();
    await click('[data-toggle="thread-1"]');
    // Whatever the repaint put back (the held draft may or may not have been
    // shown yet), the field holds exactly the text that is still being sent.
    field().value = '';
    typeMore(SENT);
    await enter();
    expect(sendBodies()).toEqual([SENT]);
    await settle(0, 'resolve');
    // The old panel is gone, yet the page was told: the sent text comes off.
    expect(field().value).toBe('');
    typeMore('A new reply');
    await enter();
    expect(sendBodies()).toEqual([SENT, 'A new reply']);
    spy.mockRestore();
  });

  it('text typed after the send is not filed under another review when the reviewer moves away and back before the send ends', async () => {
    const { spy, field, typeMore, enter, click, sendBodies, settle, wait } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    await wait(350);
    await click('.rev-row[data-number="8"]');
    await settle(0, 'resolve');
    await click('.rev-row[data-number="7"]');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('And one more thing');
    expect(sendBodies()).toEqual([SENT]);
    spy.mockRestore();
  });

  it('a success whose settled note never reaches the page still leaves the panel holding only the new text', async () => {
    const { spy, dom, field, typeMore, enter, click, settle, wait } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    await wait(350);
    panel.webview.postMessage.mockImplementation((m: unknown) => {
      if ((m as { type: string }).type !== 'verdict:replySettled') {
        dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
      }
      return Promise.resolve(true);
    });
    await settle(0, 'resolve');
    await click('.rev-row[data-number="8"]');
    await click('.rev-row[data-number="7"]');
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('And one more thing');
    spy.mockRestore();
  });

  it('keeps the caret on the person\'s own text when the sent text comes off in front of it', async () => {
    const { spy, field, typeMore, enter, settle } = await wired();
    typeMore(SENT);
    await enter();
    typeMore(MORE);
    const at = (SENT + MORE).indexOf('one more');
    field().setSelectionRange(at, at);
    await settle(0, 'resolve');
    expect(field().value).toBe('And one more thing');
    expect(field().selectionStart).toBe(field().value.indexOf('one more'));
    expect(field().selectionEnd).toBe(field().selectionStart);
    spy.mockRestore();
  });

  it('a send that ends while its thread is collapsed leaves no empty draft behind and the thread opens empty', async () => {
    const { spy, field, typeMore, enter, click, settle, toPanel } = await wired();
    typeMore(SENT);
    await enter();
    await click('[data-toggle="thread-1"]');
    const before = toPanel.length;
    await settle(0, 'resolve');
    expect(toPanel.slice(before).filter((m) => m.type === 'replyDraft')).toEqual([]);
    await click('[data-toggle="thread-1"]');
    expect(field().value).toBe('');
    spy.mockRestore();
  });

  it('a render that throws after a successful send still tells the page and releases the thread', async () => {
    const { spy, dom, field, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    panel.webview.postMessage.mockImplementation((m: unknown) => {
      if ((m as { type: string }).type === 'verdict:regions') throw new Error('webview went away');
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
      return Promise.resolve(true);
    });
    await settle(0, 'resolve');
    expect(field().value).toBe('');
    typeMore('Again');
    await enter();
    expect(sendBodies()).toEqual([SENT, 'Again']);
    spy.mockRestore();
  });

  it('a webview that throws on every message still releases the thread, and nothing escapes the handler', async () => {
    const { spy, dom, typeMore, enter, sendBodies, settle } = await wired();
    typeMore(SENT);
    await enter();
    panel.webview.postMessage.mockImplementation(() => { throw new Error('Webview is disposed'); });
    await settle(0, 'resolve');
    panel.webview.postMessage.mockImplementation((m: unknown) => {
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: m }));
      return Promise.resolve(true);
    });
    typeMore(' again');
    await enter();
    expect(sendBodies()).toHaveLength(2);
    spy.mockRestore();
  });
});
