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
