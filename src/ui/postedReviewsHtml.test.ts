import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import type { PostedRow, PostedViewState } from './postedReviewsHtml';
import { renderPostedReviewsHtml, renderPostedReviewsRegions } from './postedReviewsHtml';
import {
  buildPostedRows,
  countArchived,
  countWaitingOnYou,
  selectedPostedRow,
  visiblePostedRows,
} from './postedReviewsState';
import type { ChangeRequest } from '../platform/types';

function thread(overrides: Partial<PostedThreadView> = {}): PostedThreadView {
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

function row(threads: PostedThreadView[], overrides: Partial<PostedRow> = {}): PostedRow {
  return {
    view: view(threads),
    refLabel: '!2841',
    title: 'Add per-tenant rate limiting',
    project: 'core',
    age: '2d',
    archived: false,
    ...overrides,
  };
}

function state(rows: PostedRow[], overrides: Partial<PostedViewState> = {}): PostedViewState {
  return {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    now: Date.parse('2026-08-22T10:00:00.000Z'),
    waitingOnYouTotal: countWaitingOnYou(rows),
    rows,
    showArchived: false,
    archivedCount: 0,
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
              { author: 'dana', body: 'First pass — looks fine to me.', at: '2026-08-20T11:00:00.000Z', yours: false },
              { author: 'dana', body: 'Posted from the web UI directly.', at: '2026-08-21T09:00:00.000Z', yours: false },
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

describe('a reply of yours is not the author replying to you', () => {
  /**
   * The `class="entry …"` attribute of the block that renders `body`. Anchors
   * on the body itself rather than on ordinal position, so it keeps testing
   * the same thing if entries are ever reordered or one is added between.
   */
  function entryClassOf(html: string, body: string): string {
    const at = html.indexOf(body);
    expect(at).toBeGreaterThan(-1);
    const open = html.lastIndexOf('<div class="entry ', at);
    return html.slice(open, html.indexOf('>', open));
  }

  it('renders your reply and the author\'s in different entry classes', () => {
    // `replies` now carries both, so the class has to be picked per reply.
    // Rendering yours in the author's colour would show the author conceding
    // your own argument back to you — the CSS has carried .entry-you and
    // .entry-author for exactly this distinction all along.
    const html = renderPostedReviewsHtml(
      state(
        [
          row([
            thread({
              replies: [
                { author: 'dana', body: 'The shipper scrubs secrets in prod.', at: '2026-08-20T11:00:00.000Z', yours: false },
                { author: 'you', body: 'It scrubs known keys only, not this one.', at: '2026-08-21T09:00:00.000Z', yours: true },
              ],
            }),
          ]),
        ],
        { expandedThreadId: 'thread-1' },
      ),
      'nonce123',
    );

    expect(entryClassOf(html, 'The shipper scrubs secrets in prod.')).toContain('entry-author');
    expect(entryClassOf(html, 'It scrubs known keys only, not this one.')).toContain('entry-you');
    expect(entryClassOf(html, 'It scrubs known keys only, not this one.')).not.toContain('entry-author');
    // The posted comment keeps its own block — it is the finding, not a reply.
    expect(entryClassOf(html, 'This logs the refresh token in cleartext.')).toContain('entry-you');
    expect(html).toContain('you · posted comment');
    // Your reply is labelled as yours, not as an @-mention of your own login.
    expect(html).not.toContain('@you');
  });

  it('renders a thread whose every reply is yours instead of dropping the conversation', () => {
    // The reported case: on a change request you authored yourself every note
    // is yours, and the screen showed only the posted comment.
    const html = renderPostedReviewsHtml(
      state(
        [
          row([
            thread({
              status: 'awaiting',
              replies: [
                { author: 'you', body: 'Still reproduces on main.', at: '2026-08-20T11:00:00.000Z', yours: true },
                { author: 'you', body: 'Trace attached in the pipeline log.', at: '2026-08-21T09:00:00.000Z', yours: true },
              ],
            }),
          ]),
        ],
        { expandedThreadId: 'thread-1' },
      ),
      'nonce123',
    );

    const first = html.indexOf('Still reproduces on main.');
    const second = html.indexOf('Trace attached in the pipeline log.');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // Asserted per entry, not over the whole page: `.entry-author` is also a
    // CSS rule in the page's style block, so a document-wide check would pass
    // whatever the entries actually rendered as.
    expect(entryClassOf(html, 'Still reproduces on main.')).not.toContain('entry-author');
    expect(entryClassOf(html, 'Trace attached in the pipeline log.')).not.toContain('entry-author');
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
    expect(html).toContain('class="skel skel-title"');
    // Nothing is selected while loading — no thread panel to show yet.
    expect(html).not.toContain('class="sel-bar"');
  });

  it('sizes every skeleton placeholder from a CSS class, never a style attribute (issue #45 — the CSP blocks style attributes, not style elements)', () => {
    const html = renderPostedReviewsHtml(
      state([], { loading: true, rows: [], pendingRows: [{ refLabel: '!2841', project: 'core', age: '2d' }] }),
      'nonce123',
    );
    expect(html).not.toContain('style="');
  });

  it('guards skeleton rows against selecting a non-existent review — pendingRows carry no ref', () => {
    const html = renderPostedReviewsHtml(
      state([], { loading: true, rows: [], pendingRows: [{ refLabel: '!2841', project: 'core', age: '2d' }] }),
      'nonce123',
    );
    expect(html).not.toContain('data-number=');
    expect(html).toContain('row.dataset.number === undefined) return');
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

/**
 * The report: "Post Reviews remain even after the issue has been closed,
 * only the active PR should there, they should automatically 'archived' and
 * only explicitly shown when the filter is set."
 */
describe('archived posted reviews — history is append-only, the open list is the signal', () => {
  function cr(number: string, title: string): ChangeRequest {
    return {
      ref: { repoId: '9101', number },
      title,
      state: 'open',
      sourceBranch: 'feat/x',
      targetBranch: 'main',
      author: { username: 'dana' },
      reviewers: [],
      webUrl: 'https://example.invalid/x',
      updatedAt: '2026-08-21T09:00:00.000Z',
      headSha: 'abc123',
    };
  }

  /** One review per change request number, each with its own thread id. */
  function source(number: string) {
    const base = row([thread({ threadId: `thread-${number}` })]);
    return {
      view: { ...base.view, crNumber: number },
      refLabel: `!${number}`,
      project: 'core',
      age: '2d',
    };
  }

  it('archives a review whose change request is no longer in the open list, and leaves an open one alone', () => {
    const rows = buildPostedRows(
      [source('100'), source('200')],
      [cr('100', 'Add per-tenant rate limiting')],
    );

    expect(rows[0]?.archived).toBe(false);
    expect(rows[0]?.title).toBe('Add per-tenant rate limiting');
    // Absent from the batched open list means merged or closed — the same
    // inference notifier.ts scopes reply polling with. The title falls back
    // to the ref, exactly as it did before the flag existed.
    expect(rows[1]?.archived).toBe(true);
    expect(rows[1]?.title).toBe('!200');
    expect(countArchived(rows)).toBe(1);
  });

  it('un-archives on the next derivation when the change request reopens — nothing is persisted', () => {
    const sources = [source('100')];
    expect(buildPostedRows(sources, [])[0]?.archived).toBe(true);
    expect(buildPostedRows(sources, [cr('100', 'Reopened')])[0]?.archived).toBe(false);
  });

  it('hides archived rows by default and reveals them when the filter is on', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);

    expect(visiblePostedRows(rows, false).map((r) => r.refLabel)).toEqual(['!100']);
    expect(visiblePostedRows(rows, true).map((r) => r.refLabel)).toEqual(['!100', '!200']);
  });

  it('keeps the archived row out of the list but its count in the header while the filter is off', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);
    const html = renderPostedReviewsHtml(
      state(visiblePostedRows(rows, false), { archivedCount: countArchived(rows) }),
      'n',
    );

    expect(html).toContain('data-number="100"');
    expect(html).not.toContain('data-number="200"');
    // One click away, never vanished: the count is the only mitigation for
    // the getAll maxPages truncation, so it must render with the filter off.
    expect(html).toContain('Archived · 1');
    expect(renderPostedReviewsRegions(state(visiblePostedRows(rows, false), { archivedCount: 1 }))['pr-rows'])
      .toContain('data-archived-filter');
  });

  it('marks the revealed rows as archived so the filter does not look broken', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);
    const html = renderPostedReviewsHtml(
      state(visiblePostedRows(rows, true), { showArchived: true, archivedCount: 1 }),
      'n',
    );

    expect(html).toContain('data-number="200"');
    expect(html).toContain('pill-archived');
    expect(html).toContain('class="tool active"');
  });

  it('selects the review that was clicked while the filter is active — rows are addressed by ref, not by index', () => {
    // The index trap: with the filter on, !300 sits at index 2 of the visible
    // rows and at index 2 of all rows; with it off it moves to index 1 while
    // the markup that produced the click still said 2. Refs do not move.
    const rows = buildPostedRows(
      [source('100'), source('200'), source('300')],
      [cr('100', 'First'), cr('300', 'Third')],
    );
    const selectedRef = { repoId: '9101', number: '300' };

    const revealed = renderPostedReviewsHtml(
      state(visiblePostedRows(rows, true), { showArchived: true, archivedCount: 1, selectedRef }),
      'n',
    );
    const filtered = renderPostedReviewsHtml(
      state(visiblePostedRows(rows, false), { archivedCount: 1, selectedRef }),
      'n',
    );

    for (const html of [revealed, filtered]) {
      expect(html).toContain('<div class="rev-row selected" data-repo="9101" data-number="300"');
      expect(html).not.toContain('<div class="rev-row selected" data-repo="9101" data-number="100"');
      // The detail panel resolves the selection through the same helper, so
      // a reply or a resolve cannot land on a different review than the one
      // the list draws as selected.
      expect(html).toContain('<div class="who">!300 · Third');
    }

    expect(revealed.indexOf('data-number="300"')).toBeGreaterThan(revealed.indexOf('data-number="200"'));
  });

  it('posts the clicked row\'s ref rather than its position in the visible list', () => {
    const html = renderPostedReviewsHtml(state([row([thread()])]), 'n');
    expect(html).not.toContain('data-index=');
    expect(html).toContain("post({ type: 'selectReview', repoId: row.dataset.repo, number: row.dataset.number })");
    expect(html).toContain("closest('[data-archived-filter]')");
    expect(html).toContain("post({ type: 'toggleArchived' })");
  });

  it('falls back to the first visible row when the selected review is archived and hidden', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);
    const visible = visiblePostedRows(rows, false);

    expect(selectedPostedRow(visible, { repoId: '9101', number: '200' })?.refLabel).toBe('!100');
    expect(selectedPostedRow(visiblePostedRows(rows, true), { repoId: '9101', number: '200' })?.refLabel).toBe('!200');
    expect(selectedPostedRow([], { repoId: '9101', number: '200' })).toBeUndefined();
  });

  it('counts "on you" over the visible rows only — an archived review\'s open thread is not actionable', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);
    // Both reviews carry one thread waiting on you; only the open one counts
    // while the filter hides the other.
    expect(countWaitingOnYou(rows)).toBe(2);
    expect(countWaitingOnYou(visiblePostedRows(rows, false))).toBe(1);

    const html = renderPostedReviewsHtml(
      state(visiblePostedRows(rows, false), { archivedCount: 1 }),
      'n',
    );
    expect(html).toContain('<span class="on-you">1 on you</span>');
  });

  it('says so when every submitted review is archived, instead of claiming nothing was submitted', () => {
    const rows = buildPostedRows([source('100'), source('200')], []);
    // The rows region, not the whole page: the delegated click handler names
    // the filter attribute in the script too, so a page-wide assertion would
    // pass on the script alone.
    const region = renderPostedReviewsRegions(
      state(visiblePostedRows(rows, false), { archivedCount: countArchived(rows) }),
    )['pr-rows'] as string;

    expect(region).not.toContain('Nothing submitted yet —');
    expect(region).toContain('Every review you submitted here is archived');
    expect(region).toContain('Show 2 archived');
    // The header tool and the in-body offer are the same control rendered
    // twice — an attribute, never a duplicated id.
    expect(region).not.toContain('id="toggle-archived"');
    expect(region.match(/data-archived-filter/g)?.length).toBe(2);
  });

  it('keeps the original empty copy when nothing was ever submitted, and keeps the filter reachable when it is on', () => {
    const pristine = renderPostedReviewsRegions(state([]))['pr-rows'] as string;
    expect(pristine).toContain('Nothing submitted yet — run a review and submit it');
    expect(pristine).not.toContain('data-archived-filter');

    // Filter on with an empty history: the affordance has to stay reachable
    // or the reviewer cannot turn it back off.
    const filtered = renderPostedReviewsRegions(state([], { showArchived: true }))['pr-rows'] as string;
    expect(filtered).toContain('Nothing submitted yet, archived included');
    expect(filtered).toContain('data-archived-filter');
  });

  it('renders the archived chrome from CSS classes only — the CSP blocks style attributes (issue #45)', () => {
    const rows = buildPostedRows([source('100'), source('200')], [cr('100', 'Still open')]);
    for (const showArchived of [true, false]) {
      const html = renderPostedReviewsHtml(
        state(visiblePostedRows(rows, showArchived), {
          showArchived,
          archivedCount: 1,
          expandedThreadId: 'thread-100',
        }),
        'n',
      );
      expect(html).not.toContain('style="');
    }
    expect(renderPostedReviewsHtml(state(buildPostedRows([source('100')], []), { archivedCount: 1 }), 'n'))
      .not.toContain('style="');
  });
});

describe('a posted comment reads like the review card that produced it (#52)', () => {
  it('renders the posted body and every reply as markdown', () => {
    // The posted comment is the agent's own finding body (composeCommentDrafts
    // sends `${headline}\n\n${item.body}`), so printing it flat here showed the
    // same wall of asterisks the triage card no longer does.
    const html = renderPostedReviewsHtml(
      state(
        [
          row([
            thread({
              yourBody: '**Refresh token logged**\n\nThe path logs it in cleartext.\n\n- rotation does not help\n- `scrubSecrets` runs later',
              replies: [{ author: 'dana', body: 'Fixed in `token.ts` — see **line 63**.', at: '2026-08-20T11:00:00.000Z', yours: false }],
            }),
          ]),
        ],
        { expandedThreadId: 'thread-1' },
      ),
      'nonce123',
    );

    expect(html).toContain('<strong class="md-strong">Refresh token logged</strong>');
    expect(html).toContain('<ul class="md-ul">');
    expect(html).toContain('<code class="md-code">scrubSecrets</code>');
    expect(html).toContain('<code class="md-code">token.ts</code>');
    expect(html).not.toContain('**Refresh token logged**');
    // This panel has its own stylesheet, so the rules have to ship here too.
    expect(html).toContain('.md-code {');
  });

  it('still escapes markup in a body it did not write', () => {
    const html = renderPostedReviewsHtml(
      state([row([thread({ yourBody: '<img src=x onerror=alert(1)>', replies: [] })])], {
        expandedThreadId: 'thread-1',
      }),
      'nonce123',
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
