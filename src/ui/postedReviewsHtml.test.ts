import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import type { PostedRow, PostedViewState } from './postedReviewsHtml';
import { renderPostedReviewsHtml, renderPostedReviewsRegions } from './postedReviewsHtml';

function thread(overrides: Partial<PostedThreadView> = {}): PostedThreadView {
  return {
    threadId: 'thread-1',
    title: 'Refresh token logged in error path',
    severity: 'major',
    file: 'src/auth/token.ts',
    line: 63,
    status: 'replied',
    yourBody: 'This logs the refresh token in cleartext.',
    replies: [{ author: 'dana', body: 'Pushed a fix — can you re-check?', at: '2026-08-20T11:00:00.000Z' }],
    ...overrides,
  };
}

function view(threads: PostedThreadView[]): PostedReviewView {
  const counts = { you: 0, author: 0, closed: 0 };
  for (const t of threads) {
    if (t.status === 'resolved' || t.status === 'conceded') counts.closed += 1;
    else if (t.status === 'replied' || t.status === 'stale') counts.you += 1;
    else counts.author += 1;
  }
  return {
    repoId: '9101',
    crNumber: '2841',
    agentLabel: 'Verdict · Demo Review',
    submittedAt: '2026-08-20T10:00:00.000Z',
    threads,
    counts,
  };
}

function row(threads: PostedThreadView[]): PostedRow {
  return {
    view: view(threads),
    refLabel: '!2841',
    title: 'Add per-tenant rate limiting',
    project: 'core',
    age: '2d',
  };
}

function state(rows: PostedRow[], overrides: Partial<PostedViewState> = {}): PostedViewState {
  return {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    now: Date.parse('2026-08-22T10:00:00.000Z'),
    waitingOnYouTotal: rows.reduce((n, r) => n + r.view.counts.you, 0),
    rows,
    selectedIndex: 0,
    opinions: {},
    ...overrides,
  };
}

describe('reply affordance (#33 — Enter did nothing, no send button)', () => {
  it('renders a visible Send button next to the reply input on an open, expanded thread', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread()])], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    expect(html).toContain('data-reply="thread-1"');
    expect(html).toContain('data-reply-send="thread-1"');
    expect(html).toContain('>Send<');
  });

  it('submits on plain Enter, not only on the ⌘/Ctrl chord', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread()])], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    // The old reply handler gated on `ev.metaKey || ev.ctrlKey` — a plain
    // Enter in a single-line input was silently swallowed. The fix checks
    // only the key. (The page chrome's separate "?" shortcuts-overlay script
    // legitimately checks metaKey for its own binding, so scope the
    // assertion to this file's own script, then to the submitReply handler
    // within it, rather than the whole page — the shared keyboard-overlay
    // and region-patch scripts are appended after it in the same tag.)
    const scriptStart = html.indexOf('<script nonce=');
    const script = html.slice(scriptStart, html.indexOf('</script>', scriptStart));
    const ownScript = script.slice(0, script.indexOf("const overlay = document.getElementById('verdict-keys')"));
    const replyHandler = ownScript.slice(ownScript.indexOf('function submitReply'));
    expect(replyHandler).not.toContain('metaKey');
    expect(replyHandler).not.toContain('ctrlKey');
    expect(replyHandler).toContain("ev.key === 'Enter'");
  });

  it('wires the Send button to the same submit path as the input', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread()])], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    expect(html).toContain('function submitReply(input)');
    expect(html).toContain("post({ type: 'reply', threadId: input.dataset.reply, text });");
    expect(html).toContain('data-reply-send');
    expect(html).toContain(".closest('.reply-row')");
  });

  it('never clears the input eagerly — a failed send must not lose the typed text', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread()])], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    // Clearing happened unconditionally right after `post(...)` before the
    // fix — before the extension had even attempted the round trip. The
    // script must post and stop; the field only ever blanks because a
    // successful reply flows into a fresh render(), never a scripted clear.
    expect(html).not.toContain('.value = \'\'');
  });

  it('omits the reply row entirely once a thread is closed', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread({ status: 'resolved', closedBy: 'resolved by @dana' })])], {
        expandedThreadId: 'thread-1',
      }),
      'nonce123',
    );

    expect(html).not.toContain('data-reply=');
    expect(html).not.toContain('data-reply-send=');
    expect(html).toContain('data-reopen="thread-1"');
  });
});

describe('refresh renders whatever the state carries (#34 — data → pixels)', () => {
  it('renders every reply body in an expanded thread, in order, from state alone', () => {
    // renderPostedReviewsHtml has no fetch, no cache, no diffing against a
    // previous render: it is a pure function of the state handed to it. This
    // is the renderer half of the #34 evidence — the app-layer half (that a
    // second buildPostedReview() call actually returns a note added through
    // another channel) lives in app/postedReviews.test.ts against the
    // GitLab emulator, exercising the exact call refresh() makes.
    const html = renderPostedReviewsHtml(
      state([
        row([
          thread({
            replies: [
              { author: 'dana', body: 'First pass — looks fine to me.', at: '2026-08-20T11:00:00.000Z' },
              { author: 'dana', body: 'Posted from the web UI directly.', at: '2026-08-21T09:00:00.000Z' },
            ],
          }),
        ]),
      ], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    const firstIndex = html.indexOf('First pass — looks fine to me.');
    const secondIndex = html.indexOf('Posted from the web UI directly.');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
  });

  it('keeps a thread rendered as expanded across a re-render — refresh() never resets it', () => {
    // expandedThreadId is carried straight through from PostedViewState; a
    // refresh() that refetches and re-renders with the same expandedThreadId
    // reopens the same thread with whatever notes came back this time.
    const collapsed = renderPostedReviewsHtml(state([row([thread()])]), 'nonce123');
    const expanded = renderPostedReviewsHtml(
      state([row([thread()])], { expandedThreadId: 'thread-1' }),
      'nonce123',
    );

    expect(collapsed).not.toContain('class="th-body"');
    expect(expanded).toContain('class="th-body"');
    expect(expanded).toContain('Pushed a fix — can you re-check?');
  });
});

describe('loading skeleton and region patching (issue #39)', () => {
  it('renders history-derived rows with skeleton title and counts under loading', () => {
    const html = renderPostedReviewsHtml(
      state([], {
        loading: true,
        rows: [],
        pendingRows: [{ refLabel: '!2841', project: 'core', age: '2d' }],
      }),
      'nonce123',
    );

    expect(html).toContain('!2841');
    expect(html).toContain('core');
    expect(html).toContain('2d');
    expect(html).toContain('class="skel"');
    // Nothing is selected while loading — no thread panel to show yet.
    expect(html).not.toContain('class="sel-bar"');
  });

  it('wraps the rows and detail in the two regions a patch targets', () => {
    const html = renderPostedReviewsHtml(state([row([thread()])], { expandedThreadId: 'thread-1' }), 'n');
    expect(html).toContain('id="pr-rows"');
    expect(html).toContain('id="pr-detail"');
  });

  it('renderPostedReviewsRegions produces exactly the two regions, as a substring of the full page for the same state', () => {
    const s = state([row([thread()])], { expandedThreadId: 'thread-1' });
    const regions = renderPostedReviewsRegions(s);

    expect(Object.keys(regions).sort()).toEqual(['pr-detail', 'pr-rows']);
    const html = renderPostedReviewsHtml(s, 'n');
    expect(html).toContain(regions['pr-rows']);
    expect(html).toContain(regions['pr-detail']);
  });

  it('binds listeners once on document, not per element (region patching survives without re-binding)', () => {
    const html = renderPostedReviewsHtml(state([row([thread()])], { expandedThreadId: 'thread-1' }), 'n');
    expect(html).not.toContain("querySelectorAll('.rev-row').forEach");
    expect(html).toContain("ev.target.closest('.rev-row')");
    expect(html).not.toContain("querySelectorAll('[data-resolve]').forEach");
    expect(html).toContain("ev.target.closest('[data-resolve]')");
  });
});
