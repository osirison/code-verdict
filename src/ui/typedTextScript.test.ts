/**
 * In-progress text across a region patch (design D8, tasks 9.3, 9.7),
 * executed in jsdom against the real screens and the real shell script the
 * way `dashboardScript.test.ts` executes the dashboard's: type, let the
 * page's own debounced commit fire, patch the region the field lives in, and
 * assert what a reviewer would keep — the typed text, the focus and the
 * caret. The other direction is asserted too: a patch carrying regenerated
 * text must win over what was typed, which is exactly why REGIONS_SCRIPT
 * restores focus and selection but never `value`.
 *
 * `new JSDOM(..., { runScripts: 'dangerously' })` under the normal node
 * environment, for the reasons documented in docs/ARCHITECTURE.md — vitest's
 * jsdom environment never runs the page scripts.
 */
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { renderShellDocument } from './appShell';
import { extractRouteRegions } from './theme';
import type { FlowViewState } from './reviewFlowHtml';
import { renderReviewFlowBody, renderReviewFlowHtml } from './reviewFlowHtml';
import type { PostedThreadView } from '../app/postedReviews';
import type { PostedViewState } from './postedReviewsHtml';
import { renderPostedReviewsHtml, renderPostedReviewsRegions } from './postedReviewsHtml';
import { replyDraftKey } from './postedReviewsState';

const AGENT_LABEL = 'HVE Core / PR Review';

/** The review flow on the submit screen, where the summary and note live. */
function flowState(overrides: Partial<FlowViewState> = {}): FlowViewState {
  return {
    vocabulary: GITLAB_VOCABULARY,
    screen: 'summary',
    // Required since the context-controls change landed. This fixture is
    // about the editable text fields, so every context list is empty.
    effort: 'none',
    effortOpen: false,
    effortComparisonDisclosure: false,
    attachments: [],
    autoContextItems: [],
    unresolvedContextReferences: [],
    attachmentWarnings: [],
    header: {
      refLabel: '!2841',
      projectPath: 'hve/platform/core',
      branch: 'feat/auth-refresh',
      fileCount: 9,
      added: 284,
      removed: 91,
      title: 'Refactor token refresh',
    },
    agents: [{ id: 'agent', label: AGENT_LABEL, description: 'Reviews diffs', source: 'workspace', instructions: 'Review it.', origin: '.github/agents' }],
    agentId: 'agent',
    agentOpen: false,
    models: [{ id: 'lm:copilot/gpt-5', label: 'GPT-5', description: 'copilot · gpt-5', vendor: 'copilot', family: 'gpt-5' }],
    modelId: 'lm:copilot/gpt-5',
    modelOpen: false,
    selectionNotices: [],
    skippedAgents: [],
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions: '' },
    mode: 'diff',
    items: [{
      item: {
        id: 'finding-1',
        anchored: true,
        file: 'src/auth/token.ts',
        line: 63,
        severity: 'blocker',
        category: 'security',
        confidence: 96,
        title: 'Token remains valid after rotation',
        body: 'The cache accepts a superseded key id.',
        code: 'return cachedToken;',
      },
      thread: [],
      verdict: 'accepted',
    }],
    selectedId: 'finding-1',
    counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
    diffLines: [],
    candidates: [],
    filesRead: 9,
    summaryText: 'Two blockers around token rotation.',
    finalNote: '',
    postThread: true,
    requestChanges: true,
    supportsRequestChanges: true,
    username: 'you',
    doneSentence: '',
    crWebUrl: 'https://gitlab.example/hve/platform/core/-/merge_requests/2841',
    ...overrides,
  };
}

function postedThread(): PostedThreadView {
  return {
    threadId: 'thread-1',
    title: 'Refresh token logged in error path',
    severity: 'major',
    file: 'src/auth/token.ts',
    line: 63,
    status: 'replied',
    yourBody: 'This logs the refresh token in cleartext.',
    replies: [
      { author: 'dana', body: 'Pushed a fix — can you re-check?', at: '2026-08-20T11:00:00.000Z', yours: false },
    ],
  };
}

function postedState(replyDrafts: Record<string, string> = {}): PostedViewState {
  const threads = [postedThread()];
  return {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    now: Date.parse('2026-08-22T10:00:00.000Z'),
    waitingOnYouTotal: 1,
    rows: [{
      view: {
        repoId: '9101',
        crNumber: '2841',
        agentLabel: 'Verdict · Demo Review',
        submittedAt: '2026-08-20T10:00:00.000Z',
        threads,
        counts: { you: 1, author: 0, closed: 0 },
      },
      refLabel: '!2841',
      title: 'Add per-tenant rate limiting',
      project: 'core',
      age: '2d',
      archived: false,
    }],
    showArchived: false,
    archivedCount: 0,
    opinions: {},
    replyDrafts,
    expandedThreadId: 'thread-1',
  };
}

/** The resident shell hosting a real screen, all route scripts live. */
function loadShell(routeHtml: string, routeKey: string): { dom: JSDOM; posted: unknown[] } {
  const regions = extractRouteRegions(routeHtml);
  expect(regions).toBeDefined();
  const posted: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(
    renderShellDocument({ title: 'Verdict', nonce: 'testnonce', regions: regions!, routeKey }),
    {
      runScripts: 'dangerously',
      virtualConsole,
      beforeParse(window) {
        (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
          postMessage: (message: unknown) => posted.push(message),
        });
        // jsdom leaves window.scrollTo unimplemented and REGIONS_SCRIPT ends
        // by restoring scroll — a no-op double keeps that off the console.
        window.scrollTo = (() => undefined) as typeof window.scrollTo;
      },
    },
  );
  return { dom, posted };
}

/** Types into a field the way a keystroke does: value, then an input event. */
function type(dom: JSDOM, field: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  field.value = text;
  field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
}

function patch(dom: JSDOM, regions: Record<string, string>): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'verdict:regions', regions },
  }));
}

/** A click anywhere flushes the flow's pending debounced commits (task 9.3a). */
function clickBody(dom: JSDOM): void {
  dom.window.document.body.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('a patch between keystrokes (tasks 9.3, 9.7)', () => {
  it('leaves the typed summary, focus and caret intact — the commit reached the host, the patch paints it back', () => {
    const { dom, posted } = loadShell(renderReviewFlowHtml(flowState(), AGENT_LABEL, 'testnonce'), 'review');
    const document = dom.window.document;
    const typed = 'Two blockers around token rotation. Plus a nit on naming.';

    const field = document.getElementById('summary-text') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, typed);
    clickBody(dom);
    // The page committed the in-progress text to the host — this is what
    // makes it safe for the patch below to carry the current value instead
    // of a stale one.
    expect(posted).toContainEqual({ type: 'editSummary', text: typed });

    field.setSelectionRange(12, 12);
    patch(dom, { 'flow-body': renderReviewFlowBody(flowState({ summaryText: typed }), AGENT_LABEL) });

    const after = document.getElementById('summary-text') as HTMLTextAreaElement;
    expect(after.value).toBe(typed);
    expect(document.activeElement?.id).toBe('summary-text');
    expect(after.selectionStart).toBe(12);
    expect(after.selectionEnd).toBe(12);
  });

  it('leaves the typed note, focus and caret intact the same way', () => {
    const { dom, posted } = loadShell(renderReviewFlowHtml(flowState(), AGENT_LABEL, 'testnonce'), 'review');
    const document = dom.window.document;
    const typed = 'Merge after the pipeline is green.';

    const field = document.getElementById('final-note') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, typed);
    clickBody(dom);
    expect(posted).toContainEqual({ type: 'setNote', text: typed });

    field.setSelectionRange(5, 5);
    patch(dom, { 'flow-body': renderReviewFlowBody(flowState({ finalNote: typed }), AGENT_LABEL) });

    const after = document.getElementById('final-note') as HTMLTextAreaElement;
    expect(after.value).toBe(typed);
    expect(document.activeElement?.id).toBe('final-note');
    expect(after.selectionStart).toBe(5);
  });

  it('leaves a typed reply, focus and caret intact once the per-thread draft commit lands', async () => {
    const { dom, posted } = loadShell(renderPostedReviewsHtml(postedState(), 'testnonce'), 'posted');
    const document = dom.window.document;
    const typed = 'Still not convinced this covers rotation.';

    const field = document.getElementById('reply-input') as HTMLInputElement;
    field.focus();
    type(dom, field, typed);
    // The posted screen's draft commit is debounced on the page's own timer
    // (300ms) with no click flush of its own — wait it out for real.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(posted).toContainEqual({ type: 'replyDraft', threadId: 'thread-1', text: typed });

    field.setSelectionRange(9, 9);
    const withDraft = postedState({ [replyDraftKey('9101', '2841', 'thread-1')]: typed });
    patch(dom, { 'pr-detail': renderPostedReviewsRegions(withDraft)['pr-detail']! });

    const after = document.getElementById('reply-input') as HTMLInputElement;
    expect(after.value).toBe(typed);
    expect(document.activeElement?.id).toBe('reply-input');
    expect(after.selectionStart).toBe(9);
  });

  it('a regenerate still replaces the summary: the patched value wins over what was typed', () => {
    const { dom } = loadShell(renderReviewFlowHtml(flowState(), AGENT_LABEL, 'testnonce'), 'review');
    const document = dom.window.document;

    const field = document.getElementById('summary-text') as HTMLTextAreaElement;
    field.focus();
    // Typed straight into the DOM and never committed — the one value that
    // must NOT survive: restoring it would clobber the regeneration the
    // reviewer just asked for.
    field.value = 'my own words';
    field.setSelectionRange(4, 4);

    const regenerated = 'Regenerated: 1 accepted blocker on token rotation.';
    patch(dom, { 'flow-body': renderReviewFlowBody(flowState({ summaryText: regenerated }), AGENT_LABEL) });

    const after = document.getElementById('summary-text') as HTMLTextAreaElement;
    expect(after.value).toBe(regenerated);
    expect(after.value).not.toContain('my own words');
    // Focus and caret still come back — only the value is never restored.
    expect(document.activeElement?.id).toBe('summary-text');
    expect(after.selectionStart).toBe(4);
  });

  it('a reply that sends successfully ends empty: the cleared draft is what the patch paints', () => {
    const { dom } = loadShell(renderPostedReviewsHtml(postedState(), 'testnonce'), 'posted');
    const document = dom.window.document;

    const field = document.getElementById('reply-input') as HTMLInputElement;
    type(dom, field, 'Still not convinced.');
    // The host cleared the per-thread draft on the successful send (task
    // 7.4b) and re-rendered the detail region; the emitted field is
    // genuinely empty, not blanked out from under the reviewer.
    patch(dom, { 'pr-detail': renderPostedReviewsRegions(postedState({}))['pr-detail']! });

    expect((document.getElementById('reply-input') as HTMLInputElement).value).toBe('');
  });

  it('Enter sends the reply and leaves the field focused — the sent text must not hold against the host\'s cleared draft', () => {
    // The sibling of the test above, but through the DESIGNED primary path
    // (postedReviewsHtml.ts: "a single-line input has no reason to require
    // the chord (#33)"), not a direct patch. Enter fires no click and no
    // blur — none of the three DOM signals REGIONS_SCRIPT forgets a typed
    // value on — so unlike the test above, the field is still focused and
    // still carries the sent text at patch time, which is exactly the case
    // that clobbered the host's clear and let a second Enter resend it.
    const { dom, posted } = loadShell(renderPostedReviewsHtml(postedState(), 'testnonce'), 'posted');
    const document = dom.window.document;
    const sent = 'Still not convinced.';

    const field = document.getElementById('reply-input') as HTMLInputElement;
    field.focus();
    type(dom, field, sent);
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(posted).toContainEqual({ type: 'reply', threadId: 'thread-1', text: sent });

    patch(dom, { 'pr-detail': renderPostedReviewsRegions(postedState({}))['pr-detail']! });

    const after = document.getElementById('reply-input') as HTMLInputElement;
    expect(after.value).toBe('');
    expect(document.activeElement?.id).toBe('reply-input');

    // The duplicate-send symptom, not just the display: a second Enter on the
    // now-empty field must post nothing, which it only does if the value
    // really is empty rather than the sent text painted back by the hold.
    posted.length = 0;
    after.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(posted).toHaveLength(0);
  });
});

// ---- an update to one thread does not disturb a DIFFERENT thread the reviewer
// is composing in (ui-responsiveness: "A field the reviewer is composing in a
// list that updates" and "Expanded sections") ---------------------------------
//
// `postedState()` above carries one thread; both scenarios below need a
// second so "another thread on the same screen changes" is a real, separate
// row rather than the same one patching itself.

function secondThread(status: PostedThreadView['status'] = 'awaiting'): PostedThreadView {
  return {
    threadId: 'thread-2',
    title: 'Gateway retries without jitter',
    severity: 'minor',
    file: 'src/gateway.ts',
    line: 9,
    status,
    yourBody: 'This can thunder on a shared outage.',
    replies: [],
  };
}

function postedStateTwoThreads(opts: {
  expandedThreadId?: string;
  replyDrafts?: Record<string, string>;
  /** thread-1's status — the thread that changes while thread-2 is composed in. */
  firstThreadStatus?: PostedThreadView['status'];
}): PostedViewState {
  return {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    now: Date.parse('2026-08-22T10:00:00.000Z'),
    waitingOnYouTotal: 2,
    rows: [{
      view: {
        repoId: '9101',
        crNumber: '2841',
        agentLabel: 'Verdict · Demo Review',
        submittedAt: '2026-08-20T10:00:00.000Z',
        threads: [{ ...postedThread(), status: opts.firstThreadStatus ?? 'replied' }, secondThread()],
        counts: { you: 2, author: 0, closed: 0 },
      },
      refLabel: '!2841',
      title: 'Add per-tenant rate limiting',
      project: 'core',
      age: '2d',
      archived: false,
    }],
    showArchived: false,
    archivedCount: 0,
    opinions: {},
    replyDrafts: opts.replyDrafts ?? {},
    expandedThreadId: opts.expandedThreadId,
  };
}

describe('an update to one thread does not disturb another the reviewer is composing in', () => {
  it('the composed reply stays put — value, focus and caret — while a DIFFERENT thread\'s status changes', async () => {
    const { dom, posted } = loadShell(
      renderPostedReviewsHtml(postedStateTwoThreads({ expandedThreadId: 'thread-2' }), 'testnonce'),
      'posted',
    );
    const document = dom.window.document;
    const typed = 'Let me check the retry budget first.';

    const field = document.getElementById('reply-input') as HTMLInputElement;
    field.focus();
    type(dom, field, typed);
    // As in the single-thread case above: the debounced commit is real, on
    // the page's own timer.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(posted).toContainEqual({ type: 'replyDraft', threadId: 'thread-2', text: typed });

    field.setSelectionRange(6, 6);
    // thread-1 — collapsed, not the one being composed in — changes: new
    // commits moved its anchor. The same region (`pr-detail`) is replaced
    // wholesale, exactly as a real action on thread-1 (resolve, concede, a
    // reply landing) would patch it.
    patch(dom, {
      'pr-detail': renderPostedReviewsRegions(postedStateTwoThreads({
        expandedThreadId: 'thread-2',
        replyDrafts: { [replyDraftKey('9101', '2841', 'thread-2')]: typed },
        firstThreadStatus: 'stale',
      }))['pr-detail']!,
    });

    // The list actually updated — thread-1's own row shows it — so this is a
    // genuine redraw, not a no-op the field merely survived by accident.
    expect(document.querySelector('.th-row[data-thread="thread-1"] .pill')?.textContent).toBe('thread stale');

    // The composed reply survived it: still there, still focused, caret
    // exactly where it was left.
    const after = document.getElementById('reply-input') as HTMLInputElement;
    expect(after.value).toBe(typed);
    expect(document.activeElement?.id).toBe('reply-input');
    expect(after.selectionStart).toBe(6);
    expect(after.selectionEnd).toBe(6);
  });

  /**
   * "Expanded sections" (ui-responsiveness): no renderer in this codebase
   * emits a `<details id="…">` — the one real `<details>` element
   * (dashboardHtml.ts's rate-limit disclosure) carries no id and appears only
   * in `renderFallbackHtml`'s script-free error page, which is never patched,
   * so REGIONS_SCRIPT's generic `details[id]` capture/restore (exercised
   * against synthetic markup in dashboardScript.test.ts) never runs against
   * a real one. The posted-reviews screen's own expand/collapse is this
   * product's real analogue: `expandedThreadId` is host state, echoed into
   * every redraw of `#pr-detail` — this proves an unrelated redraw does not
   * collapse it.
   */
  it('the expanded thread stays expanded across the same unrelated update', () => {
    const { dom } = loadShell(
      renderPostedReviewsHtml(postedStateTwoThreads({ expandedThreadId: 'thread-2' }), 'testnonce'),
      'posted',
    );
    const document = dom.window.document;
    // thread-2 alone is expanded on first paint.
    expect(document.querySelectorAll('.th-body')).toHaveLength(1);
    expect(document.querySelector('.th-row[data-thread="thread-2"] .th-body')).not.toBeNull();

    patch(dom, {
      'pr-detail': renderPostedReviewsRegions(postedStateTwoThreads({
        expandedThreadId: 'thread-2',
        firstThreadStatus: 'stale',
      }))['pr-detail']!,
    });

    // thread-1 changed (same fact the sibling test asserts) — a real redraw.
    expect(document.querySelector('.th-row[data-thread="thread-1"] .pill')?.textContent).toBe('thread stale');
    // thread-2 is still expanded — the unrelated update did not collapse it.
    expect(document.querySelectorAll('.th-body')).toHaveLength(1);
    expect(document.querySelector('.th-row[data-thread="thread-2"] .th-body')).not.toBeNull();
  });
});

// ---- a reply that is still in flight -----------------------------------------
//
// Enter releases REGIONS_SCRIPT's typed hold on the field (it fires no click
// and no blur, so nothing else would), which is what stops the sent text from
// beating the host's cleared draft and being resent. From that moment the
// field is painted from host state alone — so the host has to HOLD the text
// for as long as the send is unresolved, or any patch of `#pr-detail` in that
// window blanks a reply that has not landed yet. Every other thread's
// resolve/concede/second-opinion patches that same region.

/**
 * The drafts the PAGE itself committed, keyed the way the host keys them.
 * The host's `replyDraft` case is a plain assignment into `replyDrafts`, so
 * replaying the page's own messages through this map is exactly the state a
 * patch would render from. Built from `posted` rather than written out by
 * hand on purpose: a page that commits nothing yields an empty map and a
 * field that paints blank, instead of a test quietly supplying the copy it is
 * supposed to be proving the page made.
 */
function draftsFromPosted(posted: unknown[]): Record<string, string> {
  const drafts: Record<string, string> = {};
  for (const message of posted as { type?: string; threadId?: string; text?: string }[]) {
    if (message.type === 'replyDraft' && message.threadId !== undefined) {
      drafts[replyDraftKey('9101', '2841', message.threadId)] = message.text ?? '';
    }
  }
  return drafts;
}

describe('a reply still in flight is held by the host, not by the field it was typed into', () => {
  it('Enter commits the text as this thread\'s draft BEFORE posting the reply, so an unrelated thread\'s patch arriving while the send is unresolved repaints the text instead of blanking it', () => {
    const { dom, posted } = loadShell(
      renderPostedReviewsHtml(postedStateTwoThreads({ expandedThreadId: 'thread-2' }), 'testnonce'),
      'posted',
    );
    const document = dom.window.document;
    const sent = 'Let me check the retry budget first.';

    const field = document.getElementById('reply-input') as HTMLInputElement;
    field.focus();
    type(dom, field, sent);
    // No 350ms wait here, unlike the blocks above, and that is the whole
    // precondition: in ordinary typing Enter beats the page's own 300ms
    // debounce, so the send path is the only thing that can hand the text to
    // the host. Once the debounce has already fired the host holds the text
    // anyway and this defect cannot occur — which is why waiting here would
    // make the test pass with or without the fix.
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(posted).toContainEqual({ type: 'replyDraft', threadId: 'thread-2', text: sent });
    expect(posted).toContainEqual({ type: 'reply', threadId: 'thread-2', text: sent });
    // Ordered, not merely present: the host's `replyDraft` case is a
    // synchronous assignment and its `reply` case awaits the platform, so a
    // draft posted first is in host state before the round trip can resolve
    // either way — including before it fails.
    const indexOfType = (wanted: string): number =>
      posted.findIndex((message) => (message as { type: string }).type === wanted);
    expect(indexOfType('replyDraft')).toBeLessThan(indexOfType('reply'));

    field.setSelectionRange(6, 6);
    // thread-1 resolves while the reply is still unresolved — the shape every
    // resolve/concede/second-opinion on another thread produces: the same
    // region, re-rendered from host state, which now includes the draft the
    // page committed a moment ago.
    patch(dom, {
      'pr-detail': renderPostedReviewsRegions(postedStateTwoThreads({
        expandedThreadId: 'thread-2',
        replyDrafts: draftsFromPosted(posted),
        firstThreadStatus: 'stale',
      }))['pr-detail']!,
    });

    // A genuine redraw — thread-1's own row changed — so the text below
    // survived a real region replacement rather than a no-op.
    expect(document.querySelector('.th-row[data-thread="thread-1"] .pill')?.textContent).toBe('thread stale');

    const after = document.getElementById('reply-input') as HTMLInputElement;
    expect(after.value).toBe(sent);
    expect(document.activeElement?.id).toBe('reply-input');
    expect(after.selectionStart).toBe(6);
    expect(after.selectionEnd).toBe(6);
  });

  it('a send that FAILS leaves the text re-sendable, not just visible: the held draft refills the box on the next repaint and a second Enter posts the same reply again', () => {
    const { dom, posted } = loadShell(
      renderPostedReviewsHtml(postedStateTwoThreads({ expandedThreadId: 'thread-2' }), 'testnonce'),
      'posted',
    );
    const document = dom.window.document;
    const sent = 'Let me check the retry budget first.';

    const field = document.getElementById('reply-input') as HTMLInputElement;
    field.focus();
    type(dom, field, sent);
    field.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    // `replyToThread` rejected: the host's outer catch reports the error and
    // returns without deleting the draft and without a patch of its own (the
    // host half of this is "a failed reply keeps the held draft" in
    // postedReviews.test.ts — what was missing was the page ever committing
    // one). The reviewer then does anything local, here expanding a thread,
    // and THAT repaint is what has to hand the text back.
    const heldDrafts = draftsFromPosted(posted);
    posted.length = 0;
    patch(dom, {
      'pr-detail': renderPostedReviewsRegions(postedStateTwoThreads({
        expandedThreadId: 'thread-2',
        replyDrafts: heldDrafts,
      }))['pr-detail']!,
    });

    const after = document.getElementById('reply-input') as HTMLInputElement;
    expect(after.value).toBe(sent);
    // Recovered means usable, not merely displayed: the retry goes back out
    // through the same Enter path, carrying the same text, with no retyping.
    after.focus();
    after.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(posted).toContainEqual({ type: 'reply', threadId: 'thread-2', text: sent });
  });
});

// ---- the lagging-value race on the Run review screen -------------------------
//
// Every block above lets the debounced commit reach the host BEFORE the patch,
// so the value the patch carries is current and holding it off is never
// tested. The extra-instructions field is the one editable whose host handler
// re-renders (`setInstructions` → `scheduleContextUsage()` → `render()`, in
// both `ReviewFlowPanel` and `ChangesetReviewPanel`), so its patches arrive
// while the reviewer is still typing and carry the DEBOUNCED text — behind the
// field they came from. Painting that back is not a cosmetic caret jump: the
// keystrokes after the commit are gone, and the caret then clamps to the end of
// the shorter text, which is the reported "cursor moves to the beginning and it
// constantly overwrites itself".

/** The Run review screen, where `#extra` lives, with the host's committed text. */
function runReviewState(extraInstructions: string): FlowViewState {
  return flowState({
    screen: 'agent',
    criteria: { severityFloor: 'minor', minConfidence: 70, categories: ['security'], extraInstructions },
  });
}

/** The reviewer's committed text, and what they have typed past it since. */
const COMMITTED = 'No praise.';
const TYPED_SINCE = 'No praise. Cite the CVE class.';

describe('a patch carrying the debounced instruction text cannot overwrite the field it came from', () => {
  it('keeps the keystrokes typed after the commit, and the caret where they left it, not clamped to the stale text', async () => {
    const { dom, posted } = loadShell(
      renderReviewFlowHtml(runReviewState(''), AGENT_LABEL, 'testnonce'),
      'review',
    );
    const document = dom.window.document;

    const field = document.getElementById('extra') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, COMMITTED);
    // The flow's own 300ms debounce, waited out rather than flushed with a
    // click: a click is one of the signals that tells REGIONS_SCRIPT the host
    // is now current, and the whole point here is that it is NOT.
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(posted).toContainEqual({ type: 'setInstructions', text: COMMITTED });

    // The reviewer keeps typing while the context-usage estimate that commit
    // scheduled is still in flight.
    type(dom, field, TYPED_SINCE);
    field.setSelectionRange(29, 29);

    // The estimate lands and the host re-renders the whole body from its own
    // state — which still holds the committed text, 19 characters behind.
    patch(dom, { 'flow-body': renderReviewFlowBody(runReviewState(COMMITTED), AGENT_LABEL) });

    const after = document.getElementById('extra') as HTMLTextAreaElement;
    // The assertion that fails without the fix: the patch paints COMMITTED.
    expect(after.value).toBe(TYPED_SINCE);
    expect(document.activeElement?.id).toBe('extra');
    // And the caret, which without the value held is clamped to COMMITTED's
    // length — the 10 the reviewer sees as "back to the beginning".
    expect(after.selectionStart).toBe(29);
    expect(after.selectionEnd).toBe(29);
  });

  it('survives a SECOND stale patch, because the element the input listener watched was destroyed by the first', async () => {
    const { dom } = loadShell(
      renderReviewFlowHtml(runReviewState(''), AGENT_LABEL, 'testnonce'),
      'review',
    );
    const document = dom.window.document;

    const field = document.getElementById('extra') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, COMMITTED);
    await new Promise((resolve) => setTimeout(resolve, 350));
    type(dom, field, TYPED_SINCE);
    field.setSelectionRange(29, 29);

    // Two renders carrying the same committed text — the keystroke's own
    // render, then the context-usage estimate landing after it. This is why
    // the report says "constantly": one held patch is not enough if the hold
    // does not re-arm against the rebuilt element.
    patch(dom, { 'flow-body': renderReviewFlowBody(runReviewState(COMMITTED), AGENT_LABEL) });
    patch(dom, { 'flow-body': renderReviewFlowBody(runReviewState(COMMITTED), AGENT_LABEL) });

    const after = document.getElementById('extra') as HTMLTextAreaElement;
    expect(after.value).toBe(TYPED_SINCE);
    expect(after.selectionStart).toBe(29);
  });

  it('restores the direction of a shift-extended selection, so extending it further grows it instead of jumping', async () => {
    const { dom } = loadShell(
      renderReviewFlowHtml(runReviewState(''), AGENT_LABEL, 'testnonce'),
      'review',
    );
    const document = dom.window.document;

    const field = document.getElementById('extra') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, COMMITTED);
    await new Promise((resolve) => setTimeout(resolve, 350));
    type(dom, field, TYPED_SINCE);
    // Selected leftwards from 24 to 11: the anchor is the RIGHT edge, which is
    // exactly the fact a start/end-only restore throws away.
    field.setSelectionRange(11, 24, 'backward');

    patch(dom, { 'flow-body': renderReviewFlowBody(runReviewState(COMMITTED), AGENT_LABEL) });

    const after = document.getElementById('extra') as HTMLTextAreaElement;
    expect(after.selectionStart).toBe(11);
    expect(after.selectionEnd).toBe(24);
    expect(after.selectionDirection).toBe('backward');
  });
});

describe('a host-authored value still wins over text the reviewer really typed', () => {
  /**
   * The sibling of "a regenerate still replaces the summary" above, and the
   * sharp one: that test sets `.value` with no `input` event, so the page never
   * watched the typing and nothing had to be given up. Here the reviewer types
   * for real — input events and all — and then clicks Regenerate. The click is
   * what tells the page its text has been handed to the host (the same signal
   * `flushCommits` acts on), so the value the host sends back is its answer and
   * must land. Without that release the hold would become "the DOM always beats
   * the host" and regenerate would silently do nothing.
   */
  it('a regenerate clicked after real typing replaces the summary, even though the field is still focused', () => {
    const { dom, posted } = loadShell(renderReviewFlowHtml(flowState(), AGENT_LABEL, 'testnonce'), 'review');
    const document = dom.window.document;

    const field = document.getElementById('summary-text') as HTMLTextAreaElement;
    field.focus();
    type(dom, field, 'my own words');
    field.setSelectionRange(4, 4);

    // The reviewer clicks Regenerate. The page flushes the pending commit on
    // the way out, so the host is current before it regenerates.
    document.getElementById('regenerate')!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    expect(posted).toContainEqual({ type: 'editSummary', text: 'my own words' });
    expect(posted).toContainEqual({ type: 'regenerate' });

    const regenerated = 'Regenerated: 1 accepted blocker on token rotation.';
    patch(dom, { 'flow-body': renderReviewFlowBody(flowState({ summaryText: regenerated }), AGENT_LABEL) });

    const after = document.getElementById('summary-text') as HTMLTextAreaElement;
    expect(after.value).toBe(regenerated);
    expect(after.value).not.toContain('my own words');
    expect(document.activeElement?.id).toBe('summary-text');
  });
});
