import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { CONTEXT_SECTION_BUDGET, reviewContextTruncatedForPrompt, type ReviewContext } from '../app/reviewContext';
import type { FlowViewState, ReviewContextView } from './reviewFlowHtml';
import { renderReviewFlowBody, renderReviewFlowErrorHtml, renderReviewFlowHtml, renderReviewFlowLoadingHtml, runOutputSummary } from './reviewFlowHtml';

const state: FlowViewState = {
  vocabulary: GITLAB_VOCABULARY,
  screen: 'triage',
  header: {
    refLabel: '!2841',
    projectPath: 'hve/platform/core',
    branch: 'feat/auth-refresh',
    fileCount: 9,
    added: 284,
    removed: 91,
    title: 'Refactor token refresh',
  },
  agents: [{ id: 'agent', label: 'HVE Core / PR Review', description: 'Reviews diffs', source: 'workspace', instructions: 'Review it.', origin: '.github/agents' }],
  agentId: 'agent',
  agentOpen: false,
  models: [{ id: 'lm:copilot/gpt-5', label: 'GPT-5', description: 'copilot · gpt-5', vendor: 'copilot', family: 'gpt-5' }],
  modelId: 'lm:copilot/gpt-5',
  modelOpen: false,
  selectionNotices: [],
  skippedAgents: [],
  criteria: {
    severityFloor: 'minor',
    minConfidence: 70,
    categories: ['security'],
    extraInstructions: '',
  },
  runSteps: [],
  runStep: 0,
  mode: 'diff',
  items: [{
    item: {
      id: 'finding-1',
      file: 'src/auth/token.ts',
      line: 63,
      severity: 'blocker',
      category: 'security',
      confidence: 96,
      title: 'Token remains valid after rotation',
      body: 'The cache accepts a superseded key id.',
      code: 'return cachedToken;',
      suggestion: { old: 'return cachedToken;', new: 'return refreshToken();' },
    },
    thread: [],
  }],
  selectedId: 'finding-1',
  counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 1 },
  diffLines: [
    { kind: 'context', text: 'if (cachedToken) {', oldLine: 62, newLine: 62 },
    { kind: 'add', text: 'return cachedToken;', newLine: 63 },
    { kind: 'context', text: '}', oldLine: 63, newLine: 64 },
  ],
  candidates: [],
  filesRead: 9,
  summaryText: '',
  finalNote: '',
  postThread: true,
  requestChanges: true,
  supportsRequestChanges: true,
  username: 'you',
  doneSentence: '',
  crWebUrl: 'https://gitlab.example/hve/platform/core/-/merge_requests/2841',
};

describe('follow-up answers patch in place (#37, #38)', () => {
  const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');

  it('gives each finding a thread container the client can target', () => {
    // Without a container the only way to show an answer is to re-render the
    // document, which rebuilds the ask box and drops focus mid-question.
    expect(html).toContain('data-thread-for=');
  });

  it('patches the thread rather than replacing the document', () => {
    expect(html).toContain("data.type !== 'verdict:thread'");
    expect(html).toContain('replaceChildren');
  });

  it('escapes the item id for the thread selector instead of stripping quotes', () => {
    const id = 'itm"a\\';
    const base = state.items[0]!;
    const html = renderReviewFlowHtml({
      ...state,
      mode: 'split',
      items: [{ ...base, thread: base.thread ?? [], item: { ...base.item, id } }],
      selectedId: id,
    }, 'HVE Core / PR Review', 'n');

    // The attribute carries the id verbatim (HTML-escaped only), so any lookup
    // that alters the value cannot match its own element.
    expect(html).toContain('data-thread-for="itm&quot;a\\"');
    // Stripping quotes broke that match, and a trailing backslash escaped the
    // selector's closing quote so querySelector threw and the agent's answer
    // never arrived.
    expect(html).toContain('CSS.escape(String(data.itemId))');
    expect(html).not.toContain("String(data.itemId).replace(");
  });

  it('never assigns the raw model answer as markup', () => {
    // The patch renders Markdown now, but only from the html the host built
    // with renderMarkdown — which escapes every character before emitting a
    // tag. The model's own string is still only ever set as text.
    expect(html).toContain('text.innerHTML = t.html');
    expect(html).toContain('text.textContent = t.text');
    expect(html).not.toContain('innerHTML = t.text');
  });
});

describe('agent prose renders as markdown (#52)', () => {
  const body = [
    'The cache accepts a **superseded** key id.',
    '',
    '- rotation leaves the old id valid',
    '- `verifyKid` never runs',
    '',
    '```ts',
    'const ok = cache.get(kid);',
    '```',
  ].join('\n');

  const withBody = (mode: FlowViewState['mode']): string => {
    const base = state.items[0]!;
    return renderReviewFlowBody(
      {
        ...state,
        mode,
        items: [
          {
            ...base,
            thread: [{ label: 'Agent', text: 'Because **kid** is ignored.' }],
            item: { ...base.item, body },
          },
        ],
      },
      'HVE Core / PR Review',
    );
  };

  for (const mode of ['split', 'queue', 'diff'] as const) {
    it(`structures the finding body in ${mode} mode`, () => {
      const html = withBody(mode);

      expect(html).toContain('<div class="prose md">');
      expect(html).toContain('<strong class="md-strong">superseded</strong>');
      expect(html).toContain('<ul class="md-ul">');
      expect(html).toContain('<code class="md-code">verifyKid</code>');
      expect(html).toContain('<pre class="md-pre" data-lang="ts">');
      // The asterisks and backticks used to print verbatim.
      expect(html).not.toContain('**superseded**');
      expect(html).not.toContain('- rotation leaves');
    });

    it(`structures a thread answer in ${mode} mode`, () => {
      expect(withBody(mode)).toContain(
        '<div class="thread-text md"><p class="md-p">Because <strong class="md-strong">kid</strong> is ignored.</p></div>',
      );
    });
  }

  it('keeps block markup out of a <p>, which the browser would reparse', () => {
    // <ul> and <pre> inside <p> is invalid: the parser closes the paragraph
    // early and the list escapes the styled wrapper.
    expect(withBody('split')).not.toContain('<p class="prose">');
  });

  it('ships the markdown rules in the nonced stylesheet the page already has', () => {
    const page = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');

    expect(page).toContain('.md-pre {');
    expect(page).toContain('.md-code {');
  });

  it('escapes markup in the body rather than passing it through', () => {
    const base = state.items[0]!;
    const html = renderReviewFlowBody(
      {
        ...state,
        mode: 'split',
        items: [{ ...base, thread: [], item: { ...base.item, body: '<img src=x onerror=alert(1)>' } }],
      },
      'HVE Core / PR Review',
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('the submitting screen (#42)', () => {
  const submitting = (submitProgress: FlowViewState['submitProgress']): string =>
    renderReviewFlowHtml({ ...state, screen: 'submitting', submitProgress }, 'HVE Core / PR Review', 'n');

  it('says what it is doing before the first outcome is known', () => {
    // The whole point: something renders immediately, before any round trip.
    expect(submitting(undefined)).toContain('Starting…');
  });

  it('counts comments as they post', () => {
    const html = submitting({ stage: 'comments', posted: 3, total: 12 });
    expect(html).toContain('Posting 3 of 12 inline comments…');
    expect(html).toContain('width:25%');
  });

  it('names the summary and verdict stages, which have nothing to count', () => {
    expect(submitting({ stage: 'summary', posted: 0, total: 0 })).toContain('Posting the summary…');
    expect(submitting({ stage: 'verdict', posted: 0, total: 0 })).toContain('Applying the verdict…');
  });

  it('reads naturally for a single comment', () => {
    expect(submitting({ stage: 'comments', posted: 0, total: 1 })).toContain('0 of 1 inline comment…');
  });
});

describe('in-diff triage fidelity (spec §5)', () => {
  it('renders the third mode with a numbered diff and inline finding widget', () => {
    const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'nonce123');

    expect(html).toContain('data-mode="diff"');
    expect(html).toContain('src/auth/token.ts');
    expect(html).toContain('1 of 1');
    expect(html).toContain('diff-flagged');
    expect(html).toContain('Token remains valid after rotation');
    expect(html).toContain('96% · 1 of 1');
  });

  it('offers suggestion-aware and comment-only acceptance actions', () => {
    const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'nonce123');

    expect(html).toContain('Accept &amp; apply');
    expect(html).toContain('Accept, comment only');
    expect(html).toContain("type: 'verdict', itemId: id, verdict: 'accepted', applyFix: false");
  });
});

describe('stale anchors during triage (spec §5)', () => {
  const stale = (over: Partial<FlowViewState>): string =>
    renderReviewFlowHtml({ ...state, ...over }, 'HVE Core / PR Review', 'nonce123');

  it('names how many findings moved and how many of them were accepted', () => {
    const html = stale({
      stale: { newHead: 'ff31ac2', affected: 2, affectedAccepted: 1 },
      items: [{ ...state.items[0]!, lineMoved: true }],
    });

    expect(html).toContain('New commits on feat/auth-refresh while you were reviewing');
    expect(html).toContain('2 findings — including one you accepted — no longer sit on the lines');
    expect(html).toContain('Re-anchor to HEAD');
    expect(html).toContain('Re-run agent');
  });

  it('does not claim work when the push left every anchor intact', () => {
    const html = stale({ stale: { newHead: 'ff31ac2', affected: 0, affectedAccepted: 0 } });

    expect(html).toContain('Every finding still sits on the line the agent read');
    expect(html).not.toContain('no longer sit on the lines');
  });

  it('chips the moved item in every mode that shows it', () => {
    const moved = [{ ...state.items[0]!, lineMoved: true }];

    for (const mode of ['split', 'queue', 'diff'] as const) {
      expect(stale({ mode, items: moved })).toContain('⚠ line moved');
    }
    // An item that did not move carries no chip.
    expect(stale({ mode: 'split' })).not.toContain('line moved');
  });
});

describe('changeset triage fidelity (spec §15)', () => {
  const changesetState: FlowViewState = {
    ...state,
    changeset: {
      id: 'trailer:1180', name: 'Key rotation, end to end', linkedIssue: '#1180',
      memberCount: 4, projectCount: 4, refs: ['!812', '!2841', '!381', '!1509'],
    },
    mode: 'split',
    items: [{
      ...state.items[0]!,
      projectLabel: 'console',
      refLabel: '!1509',
      item: {
        ...state.items[0]!.item,
        repoId: '9210', crNumber: '1509', cross: true,
        spans: [
          { repoId: '9103', location: 'src/routes/session.ts:88', role: 'renames the field' },
          { repoId: '9210', location: 'src/api/session.ts:41', role: 'still reads the old name' },
        ],
      },
    }],
  };

  it('labels changeset scope and both sides of a cross-repository finding', () => {
    const html = renderReviewFlowHtml(changesetState, 'HVE Core / PR Review', 'nonce123');

    expect(html).toContain('Reviewing Key rotation, end to end · 4 MRs');
    expect(html).toContain('Review this MR alone');
    expect(html).toContain('console · !1509');
    expect(html).toContain('spans two repositories');
    expect(html).toContain('src/routes/session.ts:88');
    expect(html).toContain('still reads the old name');
    expect(html).toContain('<title>Verdict: Review · 4 MRs</title>');
  });

  it('routes summary copy and submit actions across every member', () => {
    const html = renderReviewFlowHtml({
      ...changesetState,
      screen: 'summary',
      items: changesetState.items.map((item) => ({ ...item, verdict: 'accepted' })),
      counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
    }, 'HVE Core / PR Review', 'nonce123');

    expect(html).toContain('Submit review across 4 merge requests');
    expect(html).toContain('console · token.ts:63');
    expect(html).toContain('Submit across 4 MRs');
    // README §15: the ⧉ note above the list states where everything lands.
    expect(html).toContain('⧉ Posted to all 4 merge requests in this changeset, each comment landing in the repo it belongs to, cross-linked to');
  });
});
describe('changeset scope additions (issue #15)', () => {
  const changesetState: FlowViewState = {
    ...state,
    changeset: {
      id: 'trailer:1180', name: 'Key rotation, end to end', linkedIssue: '#1180',
      memberCount: 4, projectCount: 4, refs: ['!812', '!2841', '!381', '!1509'],
    },
    mode: 'split',
    items: [{
      ...state.items[0]!,
      projectLabel: 'console',
      refLabel: '!1509',
      crossTargets: [
        { repoId: '9103', number: '381', location: 'src/routes/session.ts:88', active: false },
        { repoId: '9210', number: '1509', location: 'src/api/session.ts:41', active: true },
      ],
      item: {
        ...state.items[0]!.item,
        repoId: '9210', crNumber: '1509', cross: true,
        spans: [
          { repoId: '9103', location: 'src/routes/session.ts:88', role: 'renames the field' },
          { repoId: '9210', location: 'src/api/session.ts:41', role: 'still reads the old name' },
        ],
      },
    }],
  };

  it('marks the posting side and offers only resolvable sides as overrides', () => {
    const html = renderReviewFlowHtml(changesetState, 'HVE Core / PR Review', 'n');

    expect(html).toContain('comment posts here');
    expect(html).toContain('data-cross-target=');
    expect(html).toContain('data-target-repo="9103"');
    expect(html).toContain('post here instead');
    expect(html).toContain("type: 'setCrossTarget'");
  });

  it('prefixes rejected rows with their repo on the changeset summary screen', () => {
    const html = renderReviewFlowHtml({
      ...changesetState,
      screen: 'summary',
      items: changesetState.items.map((view) => ({ ...view, verdict: 'rejected' as const })),
      counts: { accepted: 0, rejected: 1, skipped: 0, undecided: 0 },
    }, 'HVE Core / PR Review', 'n');

    expect(html).toMatch(/rejected-row">console · /);
  });

  it('falls back to the changeset name in the ⧉ note when there is no linked issue', () => {
    const html = renderReviewFlowHtml({
      ...changesetState,
      changeset: { ...changesetState.changeset!, linkedIssue: undefined },
      screen: 'summary',
      counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 1 },
    }, 'HVE Core / PR Review', 'n');

    expect(html).toContain('cross-linked to Key rotation, end to end.');
  });

  it('shows the member-of-changeset entry point on a single-CR run screen', () => {
    const html = renderReviewFlowHtml({
      ...state,
      screen: 'agent',
      memberOfChangeset: { id: 'trailer:1180', name: 'Key rotation, end to end', memberCount: 4 },
    }, 'HVE Core / PR Review', 'n');

    expect(html).toContain('⧉ Part of Key rotation, end to end · 4 MRs');
    expect(html).toContain('open the changeset');
    expect(html).toContain("type: 'openChangeset'");
  });
});

describe('loading skeleton and region patching (issue #39)', () => {
  it('renderReviewFlowLoadingHtml shows the ref label before the fetch', () => {
    const html = renderReviewFlowLoadingHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'n');

    expect(html).toContain('!2841');
    expect(html).toContain('hve/platform/core');
    expect(html).toContain('class="skel skel-title"');
    expect(html).toContain('class="skel skel-meta"');
    // Every value comes from a class in this page's own nonce'd CSS (issue
    // #45) — a nonce authorises style elements, never a style attribute, so
    // anything set that way is dropped before layout.
    expect(html.slice(html.indexOf('<body>'))).not.toContain('style="');
    // this.cr is not yet assigned at this point, so nothing item-specific renders.
    expect(html).not.toContain('data-item=');
  });

  it('ships the full page script on the loading page so delegated listeners are already armed', () => {
    const html = renderReviewFlowLoadingHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'n');
    expect(html).toContain("on('run', 'run')");
  });

  it('renderReviewFlowBody output is a substring of the full page for the same state', () => {
    const bodyOnly = renderReviewFlowBody(state, 'HVE Core / PR Review');
    const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');
    expect(html).toContain(bodyOnly);
  });

  it('wraps the body in the #flow-body region a patch targets', () => {
    const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');
    expect(html).toContain('id="flow-body"');
  });

  it('binds listeners once on document, not per element (region patching survives without re-binding)', () => {
    const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');
    expect(html).not.toContain("querySelectorAll('.agent-option').forEach");
    expect(html).toContain("ev.target.closest('.agent-option')");
    expect(html).not.toContain("document.getElementById('accept')?.addEventListener");
    expect(html).toContain("ev.target.closest('#accept')");
  });
});

describe('load-failure error screen (issue #39)', () => {
  it('shows the escaped message, a breadcrumb and a retry control', () => {
    const html = renderReviewFlowErrorHtml(
      { refLabel: '!2841', projectPath: 'hve/platform/core' },
      'connection refused <script>',
      'n',
    );

    // Escaped, not raw markup — the message comes from a caught error.
    expect(html).toContain('connection refused &lt;script&gt;');
    expect(html).not.toContain('refused <script>');
    // The loading page's breadcrumb, unchanged — its ‹ Dashboard button is
    // wired by AppSurface itself, so it works here with no extra plumbing.
    expect(html).toContain('id="app-crumb-current"');
    expect(html).toContain('!2841');
    expect(html).toContain('‹ Dashboard');
    // A way out that re-issues the same load.
    expect(html).toContain('id="retry-load"');
    expect(html).toContain(">Retry<");
    expect(html).toContain("on('retry-load', 'retryLoad')");
  });

  it('wraps the body in the same #flow-body region a patch targets', () => {
    const html = renderReviewFlowErrorHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'boom', 'n');
    expect(html).toContain('id="flow-body"');
  });
});

describe('the context the agent was given, on the screen where the human decides', () => {
  const reviewContext: ReviewContext = {
    title: 'Rotate signing keys without a restart',
    description: 'Part-of: #1180\n\nAccept both keys for one TTL, then drop the old one.',
    linkedItems: [{
      number: '1180',
      resolved: true,
      state: 'open',
      title: 'Key rotation, end to end',
      description: 'The gateway must accept the outgoing key for one TTL.',
      webUrl: 'https://gitlab.example/issues/1180',
    }],
  };
  /** Split mode throughout: the fixture's diff mode is the one screen that still
   *  carries a pre-existing style attribute (--item-sev), which the last case here
   *  would trip over for a reason that has nothing to do with this box (#45). */
  const render = (context: Partial<ReviewContextView>, over: Partial<FlowViewState> = {}): string =>
    renderReviewFlowBody(
      { ...state, mode: 'split', context: { open: true, truncated: false, entries: [{ context: reviewContext }], ...context }, ...over },
      'HVE Core / PR Review',
    );

  it('shows the description and the linked item the prompt carried', () => {
    const html = render({});

    expect(html).toContain('What this change is for');
    expect(html).toContain('Accept both keys for one TTL, then drop the old one.');
    expect(html).toContain('#1180 · open · Key rotation, end to end');
    expect(html).toContain('The gateway must accept the outgoing key for one TTL.');
  });

  it('collapses to a single row that says what is inside, and renders nothing at all without a context', () => {
    // Findings are the point of this screen; an open description would push the
    // selected one under the fold.
    const collapsed = render({ open: false });
    expect(collapsed).toContain('Merge request description · 1 issue linked');
    expect(collapsed).not.toContain('Accept both keys for one TTL, then drop the old one.');
    // The row opens it, through the same delegated binding every other control
    // on this page uses — the panel holds open/closed, because a region patch
    // (#39) replaces this markup on every verdict.
    expect(renderReviewFlowHtml({ ...state, mode: 'split' }, 'HVE Core / PR Review', 'n'))
      .toContain("on('ctx-toggle', 'toggleReviewContext')");

    // No context (before the fetch returns, or on a screen that never had one)
    // is not an empty box — it is no box.
    expect(renderReviewFlowBody({ ...state, mode: 'split' }, 'HVE Core / PR Review')).not.toContain('ctx-head');
  });

  it('escapes the markdown a human wrote instead of running it', () => {
    const html = render({
      entries: [{
        context: {
          ...reviewContext,
          description: '<script>alert(1)</script> Rotate A & B',
        },
      }],
    });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Rotate A &amp; B');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('says plainly that nothing is linked rather than showing an empty box', () => {
    const html = render({ entries: [{ context: { ...reviewContext, linkedItems: [] } }] });

    expect(html).toContain('No issue is linked from the description — the agent was given this merge request alone.');
  });

  it('says the reference was all the agent got when the item could not be read', () => {
    const html = render({ entries: [{ context: { ...reviewContext, linkedItems: [{ number: '1181', resolved: false }] } }] });

    expect(html).toContain('The agent was given this reference only — the issue itself could not be read.');
  });

  it('marks a prompt that was cut, and marks nothing when it was not', () => {
    // A real over-budget description, measured by the same predicate the panel
    // uses — the notice has to track what the prompt actually carried.
    const long = { ...reviewContext, description: 'x'.repeat(CONTEXT_SECTION_BUDGET + 1) };
    const entries = [{ context: long }];
    expect(reviewContextTruncatedForPrompt(entries)).toBe(true);

    const cut = render({ truncated: reviewContextTruncatedForPrompt(entries), entries });
    expect(cut).toContain('agent saw a shortened copy');
    expect(cut).toContain('some of the text below did not fit its prompt');
    // The full text is still on screen — that is what the reviewer judges against.
    expect(cut).toContain('x'.repeat(CONTEXT_SECTION_BUDGET + 1));

    expect(reviewContextTruncatedForPrompt([{ context: reviewContext }])).toBe(false);
    expect(render({})).not.toContain('agent saw a shortened copy');
  });

  it('names the linked item in the platform own noun', () => {
    const html = render({}, {
      vocabulary: { ...GITLAB_VOCABULARY, workItemNoun: 'ticket', workItemNounPlural: 'tickets' },
    });

    expect(html).toContain('1 ticket linked');
    expect(html).not.toContain('1 issue linked');
  });

  it('carries no style attribute — a nonce authorises style elements only (#45)', () => {
    expect(render({})).not.toContain('style="');
  });

  it('labels one block per member in changeset scope', () => {
    const html = render({
      entries: [
        { context: reviewContext, label: 'hve/platform/core · !2841' },
        { context: { title: 'Read both keys', description: undefined, linkedItems: [] }, label: 'hve/console · !1509' },
      ],
    });

    expect(html).toContain('hve/platform/core · !2841 · Rotate signing keys without a restart');
    expect(html).toContain('hve/console · !1509 · Read both keys');
    expect(html).toContain('No description on this merge request — the agent was given the title alone.');
    // Two blocks, so the row counts them instead of describing the one.
    expect(html).toContain('2 merge requests · 1 issue linked');
  });
});

/**
 * The running screen used to be a spinner over a canned log parked on step 2,
 * so a healthy long review and a hung one looked the same. These assert the
 * numbers that tell them apart are actually on the page.
 */
describe('the running screen shows the run is alive', () => {
  function running(runLive?: FlowViewState['runLive']): string {
    return renderReviewFlowBody({ ...state, screen: 'running', runSteps: ['Resolving agent…', 'Items ready'], runStep: 1, runLive }, 'HVE Core');
  }

  it('counts elapsed time and arriving output, with the start stamp the page ticks from', () => {
    const html = running({ startedAt: 1_770_000_000_000, elapsedMs: 185_000, fragmentsReceived: 12, charsReceived: 8421 });
    expect(html).toContain('data-started="1770000000000"');
    expect(html).toContain('>3:05</b> elapsed');
    expect(html).toContain('12 fragments · 8,421 characters');
  });

  it('says it is waiting rather than showing a zero before the first fragment', () => {
    const html = running({ startedAt: 1_770_000_000_000, elapsedMs: 0, fragmentsReceived: 0, charsReceived: 0 });
    expect(html).toContain('>0:00</b> elapsed');
    expect(html).toContain('waiting for the first output');
    expect(html).not.toContain('0 fragments');
  });

  it('renders no liveness line for the demo agent, which walks its own log', () => {
    expect(running(undefined)).not.toContain('run-live');
  });

  it('carries no style attribute of its own — a nonce authorises style elements only (#45)', () => {
    const html = running({ startedAt: 1, elapsedMs: 0, fragmentsReceived: 1, charsReceived: 1 });
    // The pre-existing progress bar still writes one (#45 is open against it); nothing new does.
    expect(html.match(/style="/g)?.length ?? 0).toBe(1);
  });

  it('formats the same counters for the page as for the markup, so a push never disagrees with a render', () => {
    expect(runOutputSummary(1, 40)).toBe('1 fragment · 40 characters');
    expect(runOutputSummary(0, 0)).toBe('waiting for the first output');
    expect(runOutputSummary(9, 1_234_567)).toBe('9 fragments · 1,234,567 characters');
  });
});

describe('the author is never offered a verdict on their own change request', () => {
  const clean: FlowViewState = { ...state, screen: 'clean', items: [], selectedId: undefined, diffLines: undefined };
  const summary: FlowViewState = {
    ...state,
    screen: 'summary',
    items: state.items.map((view) => ({ ...view, verdict: 'accepted' as const })),
    counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
  };
  // The note's own wording contains "approval", so absence is asserted on the
  // button's id, never on the word.
  const NOTE = 'You opened this merge request — GitLab does not accept an approval from its author.';

  it('hides Approve on the clean screen and says why, in the platform\'s own nouns', () => {
    const html = renderReviewFlowBody({ ...clean, selfAuthored: true }, 'HVE Core / PR Review');

    expect(html).not.toContain('id="approve"');
    expect(html).toContain(NOTE);
    // The way out is still there — only the verdict is withheld.
    expect(html).toContain('id="lower-bar"');
    expect(html).toContain('id="back-dash"');
  });

  it('keeps Approve when the change request is someone else\'s', () => {
    const html = renderReviewFlowBody({ ...clean, selfAuthored: false }, 'HVE Core / PR Review');

    expect(html).toContain('id="approve"');
    expect(html).toContain('Approve merge request');
    expect(html).not.toContain(NOTE);
  });

  it('keeps Approve when authorship is unknown — an absent flag is not a yes', () => {
    // `Pod.username` is optional, so the builder cannot always answer. Unknown
    // has to behave exactly as before: the button renders and the platform's
    // own refusal is what the reviewer sees, if it is even their own MR.
    const html = renderReviewFlowBody(clean, 'HVE Core / PR Review');

    expect(clean.selfAuthored).toBeUndefined();
    expect(html).toContain('id="approve"');
    expect(html).not.toContain(NOTE);
  });

  it('never offers Approve on a changeset clean screen, whoever authored it', () => {
    // A changeset spans four MRs — there is no single one the button could
    // approve, and changesetReview.ts only navigates to the dashboard.
    const html = renderReviewFlowBody({
      ...clean,
      changeset: {
        id: 'trailer:1180', name: 'Key rotation, end to end', linkedIssue: '#1180',
        memberCount: 4, projectCount: 4, refs: ['!812', '!2841', '!381', '!1509'],
      },
    }, 'HVE Core / PR Review');

    expect(html).not.toContain('id="approve"');
    expect(html).toContain('id="back-dash"');
  });

  it('shows the request-changes option as unavailable, with the same reason', () => {
    const html = renderReviewFlowBody({ ...summary, selfAuthored: true }, 'HVE Core / PR Review');

    expect(html).toContain('id="opt-changes" disabled');
    expect(html).not.toContain('id="opt-changes" checked');
    expect(html).toContain('GitLab does not accept a request for changes from its author.');
    // The unrelated option is untouched.
    expect(html).toContain('id="opt-thread"');
  });

  it('leaves the request-changes option alone for everyone else', () => {
    const html = renderReviewFlowBody({ ...summary, selfAuthored: false }, 'HVE Core / PR Review');

    expect(html).toContain('id="opt-changes" checked');
    expect(html).not.toContain('id="opt-changes" disabled');
    expect(html).not.toContain('from its author');
  });

  it('renders nothing at all when the provider has no request-changes verdict', () => {
    // Distinct from the author case: there is no such verdict to explain.
    const html = renderReviewFlowBody(
      { ...summary, supportsRequestChanges: false, selfAuthored: true },
      'HVE Core / PR Review',
    );

    expect(html).not.toContain('id="opt-changes"');
    expect(html).not.toContain('a request for changes from its author');
  });

  it('centres the clean actions row with a class, not a CSP-dropped style attribute (#45)', () => {
    const page = renderReviewFlowHtml({ ...clean, selfAuthored: true }, 'HVE Core / PR Review', 'n');

    expect(page).toContain('class="actions-row actions-center"');
    expect(page).toContain('.actions-center { justify-content: center; }');
    expect(renderReviewFlowBody(clean, 'HVE Core / PR Review')).not.toContain('style="justify-content:center"');
  });
});

describe('the agent and model pickers (spec: review-agents)', () => {
  const DEMO = { id: 'verdict.demo-agent', label: 'Verdict · Demo Review', description: 'Deterministic.', source: 'demo' as const, instructions: '' };
  const BUILTIN = { id: 'agent:builtin/default', label: 'Default review', description: 'Ships with the extension.', source: 'builtin' as const, instructions: 'Review it.' };
  const run = (over: Partial<FlowViewState>) =>
    renderReviewFlowBody({ ...state, screen: 'agent', ...over } as FlowViewState, 'x');

  it('renders both pickers, each labelled', () => {
    const html = run({});
    expect(html).toContain('>Agent</div>');
    expect(html).toContain('>Model</div>');
    expect(html).toContain('GPT-5');
  });

  it('no longer claims agents come from the Copilot workspace', () => {
    const html = run({});
    expect(html).not.toContain('Agents come from your Copilot workspace');
    expect(html).not.toContain('Copilot agents in this workspace');
  });

  it('shows each agent its origin, so two agents of the same name stay apart', () => {
    const html = run({
      agentOpen: true,
      agents: [
        BUILTIN,
        { id: 'agent:one/sec.agent.md', label: 'Security', description: 'd', source: 'workspace', instructions: 'i', origin: 'one/.github/agents' },
        { id: 'agent:two/sec.agent.md', label: 'Security', description: 'd', source: 'workspace', instructions: 'i', origin: 'two/.github/agents' },
      ],
    });
    expect(html).toContain('one/.github/agents');
    expect(html).toContain('two/.github/agents');
    expect(html).toContain('built-in');
  });

  it('neutralises the model picker for the demo agent, which calls no model', () => {
    const html = run({ agents: [BUILTIN, DEMO], agentId: DEMO.id });
    expect(html).toContain('Not used by this agent');
    expect(html).not.toContain('id="model-toggle"');
  });

  it('states why a run is unavailable when no model exists, and disables Run', () => {
    const html = run({ models: [], modelId: undefined });
    expect(html).toContain('No model available');
    expect(html).toContain('needs a Copilot model, and none is available');
    expect(html).toMatch(/id="run"[^>]*disabled/);
  });

  it('leaves Run enabled for the demo agent even with no model', () => {
    const html = run({ models: [], modelId: undefined, agents: [BUILTIN, DEMO], agentId: DEMO.id });
    expect(html).not.toMatch(/id="run"[^>]*disabled/);
  });

  it('renders reconciliation notices on the screen rather than as a toast', () => {
    const html = run({ selectionNotices: ['The agent "agent:ws/gone.agent.md" was not found, so the default review is selected.'] });
    expect(html).toContain('agent:ws/gone.agent.md');
    expect(html).toContain('id="dismiss-notices"');
  });

  it('reports skipped agent files as a count with the detail behind it', () => {
    const html = run({ skippedAgents: [{ path: 'a.agent.md', reason: 'no `name` in the header' }] });
    expect(html).toContain('1 agent file was skipped');
    expect(html).toContain('id="show-skipped"');
  });

  it('pluralises the skipped-file count', () => {
    const html = run({ skippedAgents: [
      { path: 'a.agent.md', reason: 'r' },
      { path: 'b.agent.md', reason: 'r' },
    ] });
    expect(html).toContain('2 agent files were skipped');
  });

  it('the picker markup writes no inline style attribute — the webview CSP drops them silently', () => {
    const html = run({ agentOpen: true, modelOpen: true });
    const pickers = html.slice(html.indexOf('<div class="picker-stack">'), html.indexOf('<div class="crit-grid">'));
    expect(pickers).toContain('agent-select');
    expect(pickers).not.toMatch(/<[^>]+\sstyle="/);
    // NOTE: the category buttons further down this screen DO carry inline
    // `style=` and are therefore uncoloured under the CSP. That predates this
    // change and is left alone here rather than fixed in passing.
  });
});

describe('a stored review says what produced it (task 7.4)', () => {
  it('names the model beside the agent on a finding', () => {
    const html = renderReviewFlowBody({ ...state, screen: 'triage', mode: 'split', reviewModelLabel: 'GPT-5' } as FlowViewState, 'Security Reviewer');
    expect(html).toContain('Security Reviewer');
    expect(html).toContain('GPT-5');
  });

  it('says the model is unknown for a review stored before models were recorded', () => {
    const html = renderReviewFlowBody({ ...state, screen: 'triage', mode: 'split', reviewModelLabel: undefined } as FlowViewState, 'Verdict · Demo Review');
    expect(html).toContain('model unknown');
  });
});

/**
 * A completed review is what its target opens on, and re-running never
 * destroys it first. These are the screens that has to be true on.
 */
describe('a retained review, and the way back to it', () => {
  const body = (over: Partial<FlowViewState>): string =>
    renderReviewFlowBody({ ...state, ...over } as FlowViewState, 'Security Reviewer');

  it('offers a new review from triage, saying the findings survive it', () => {
    const html = body({ screen: 'triage', mode: 'split' });
    expect(html).toContain('id="new-run"');
    expect(html).toContain('Run a new review');
    // The promise the control makes, spelled out where it is made.
    expect(html).toContain('stay until the new run succeeds');
  });

  it('offers a new review from a clean result, and says when it ran', () => {
    const html = body({
      screen: 'clean',
      retainedMeta: { ranAt: '2026-08-28T09:15:00.000Z', agentLabel: 'Security Reviewer', modelLabel: 'GPT-5' },
    });
    expect(html).toContain('id="new-run"');
    expect(html).toContain('Security Reviewer');
    expect(html).toContain('GPT-5');
    expect(html).toContain('Ran ');
  });

  it('offers a new review from a submitted result', () => {
    const html = body({ screen: 'done', doneSentence: '3 inline comments posted.' });
    expect(html).toContain('id="new-run"');
    expect(html).toContain('3 inline comments posted.');
  });

  it('renders no meta line for a record that never stored when it ran', () => {
    // A record written before the result fields existed. Nothing to say beats
    // an empty label or a fabricated timestamp.
    expect(body({ screen: 'clean', retainedMeta: undefined })).not.toContain('Ran ');
  });

  it('keeps the retained review reachable from a run in flight', () => {
    const html = body({ screen: 'running', runSteps: ['One', 'Two'], runStep: 1, retainedAvailable: true });
    expect(html).toContain('id="back-to-result"');
    expect(html).toContain('Back to the review you have');
  });

  it('offers no way back when there is no retained review to go back to', () => {
    const html = body({ screen: 'running', runSteps: ['One', 'Two'], runStep: 1, retainedAvailable: false });
    expect(html).not.toContain('id="back-to-result"');
  });

  it('says a queued run is waiting for a slot, not that it is failing', () => {
    const html = body({ screen: 'running', runQueued: true, runSteps: [], runStep: 0 });
    expect(html).toContain('Waiting for a free slot');
    expect(html).toContain('id="cancel-run"');
    // Accepted and held: nothing here may read as an error.
    expect(html).not.toContain('fail-card');
  });

  it('writes no inline style attribute in any of the new markup', () => {
    // The webview CSP is `style-src 'nonce-…'`: an inline style attribute is
    // dropped silently, so it never applies and nothing reports it.
    const html = body({
      screen: 'running',
      runQueued: true,
      runSteps: [],
      runStep: 0,
      retainedAvailable: true,
    });
    expect(html).not.toMatch(/<[^>]+\sstyle="/);
  });
});
