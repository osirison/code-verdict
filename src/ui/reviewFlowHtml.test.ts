import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import { CONTEXT_SECTION_BUDGET, reviewContextTruncatedForPrompt, type ReviewContext } from '../app/reviewContext';
import { parseHunks } from '../domain/diffHunks';
import type { FlowScreen, FlowViewState, ReviewContextView } from './reviewFlowHtml';
import { renderReviewFlowBody, renderReviewFlowErrorHtml, renderReviewFlowHtml, renderReviewFlowLoadingHtml } from './reviewFlowHtml';
import type { Limitation, RunProjection } from '../domain/harnessActivity';
import { INLINE_STYLE_ATTRIBUTE } from '../testing/inlineStyle';

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
  models: [{ id: 'lm:copilot/gpt-5', label: 'GPT-5', description: 'copilot · gpt-5', vendor: 'copilot', family: 'gpt-5', maxInputTokens: 1_000 }],
  modelId: 'lm:copilot/gpt-5',
  modelOpen: false,
  effort: 'none',
  effortOpen: false,
  effortComparisonDisclosure: false,
  selectionNotices: [],
  attachmentWarnings: [],
  skippedAgents: [],
  criteria: {
    severityFloor: 'minor',
    minConfidence: 70,
    categories: ['security'],
    extraInstructions: '',
  },
  attachments: [],
  autoContextItems: [],
  unresolvedContextReferences: [],
  mode: 'diff',
  items: [{
    item: {
      id: 'finding-1',
      file: 'src/auth/token.ts',
      anchored: true,
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

function generatedScript(html: string): string {
  return generatedScripts(html)[0] as string;
}

function generatedScripts(html: string): string[] {
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
    .map((match) => match[1] as string);
  expect(scripts.length).toBeGreaterThan(0);
  return scripts;
}

describe('generated review-flow script', () => {
  const script = generatedScript(renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n'));

  it('compiles as JavaScript', () => {
    expect(() => new Function(script)).not.toThrow();
  });

  it('keeps its only shortcut map inside the keyboard handler', () => {
    expect(script.match(/\bconst map =/g)).toHaveLength(1);
    expect(script).toContain("a: () => verdict('accepted', !ev.shiftKey && acceptCanApplyFix())");
  });

  it('wires the pause and resume buttons to their messages (task 14.6/14.8)', () => {
    expect(script).toContain("on('pause-run', 'pauseRun')");
    expect(script).toContain("on('resume-run', 'resumeRun')");
  });

  it('compiles every script for complete single and changeset context fixtures', () => {
    const attachment = {
      id: 'repo-a:schema',
      kind: 'file' as const,
      label: 'schema <strict> "quoted".ts',
      path: 'repo-a/config/schema <strict>.ts',
      content: 'mode: "strict"\n</script>',
      truncated: false,
    };
    const warning = {
      code: 'attachment-unreadable' as const,
      attachmentId: 'gone',
      label: 'gone <after-run>.ts',
      path: 'repo-b/src/gone.ts',
      reason: 'ENOENT "gone"',
    };
    const contextState: FlowViewState = {
      ...state,
      screen: 'agent',
      criteria: {
        ...state.criteria,
        extraInstructions: 'Compare #file:repo-a/config/schema.ts with #file:repo-b/config/missing.ts',
      },
      autoContextItems: [
        { id: 'auto:title', kind: 'title', label: 'Title <current>', enabled: true },
        { id: 'auto:description', kind: 'description', label: 'Description & intent', enabled: true },
      ],
      attachments: [attachment],
      unresolvedContextReferences: ['#file:repo-b/config/missing.ts'],
      attachmentWarnings: [warning],
    };
    const resultState: FlowViewState = {
      ...contextState,
      screen: 'triage',
      context: {
        open: true,
        truncated: false,
        entries: [{
          label: 'repo-a · !42',
          context: { title: 'Root A <title>', description: 'Resolved reference context', linkedItems: [] },
        }],
      },
    };
    const changeset = {
      id: 'multi-root',
      name: 'Root A + Root B',
      memberCount: 2,
      projectCount: 2,
      refs: ['!42', '!43'],
      repoLabels: { 'repo-a': 'Root A', 'repo-b': 'Root B' },
    };
    const pages = [
      renderReviewFlowHtml(contextState, 'Security <Reviewer>', 'single-context'),
      renderReviewFlowHtml(resultState, 'Security <Reviewer>', 'single-result'),
      renderReviewFlowHtml({ ...contextState, changeset }, 'Security <Reviewer>', 'changeset-context'),
      renderReviewFlowHtml({ ...resultState, changeset }, 'Security <Reviewer>', 'changeset-result'),
    ];

    for (const page of pages) {
      for (const generated of generatedScripts(page)) {
        expect(() => new Function(generated)).not.toThrow();
      }
    }
    const rendered = pages.join('\n');
    expect(rendered).toContain('schema &lt;strict&gt; &quot;quoted&quot;.ts');
    expect(rendered).toContain('#file:repo-b/config/missing.ts did not resolve.');
    expect(rendered).toContain('gone &lt;after-run&gt;.ts');
    expect(rendered).toContain('Root A + Root B');
  });
});

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
    // A class, not a style="width:…" attribute the page CSP drops silently
    // (issue #45) — 3/12 is exactly 25%, which is also an exact 5%-step
    // bucket, so this also confirms the quantisation leaves a round value alone.
    expect(html).toContain('<div class="w-25"></div>');
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

  it('withholds suggestion application for summary-only findings and explains why', () => {
    const base = state.items[0]!;
    const unanchored = [{ ...base, item: { ...base.item, anchored: false } }];

    for (const mode of ['split', 'queue', 'diff'] as const) {
      const body = renderReviewFlowBody({ ...state, mode, items: unanchored }, 'HVE Core / PR Review');
      expect(body).toContain('summary only');
      expect(body).toContain('There is no diff line for a suggestion block to attach to');
      expect(body).not.toContain('Accept &amp; apply');
      expect(body).toContain('data-apply-fix="false"');
    }
  });

  it('counts summary-only accepted findings separately on the submit screen', () => {
    const base = state.items[0]!;
    const body = renderReviewFlowBody({
      ...state,
      screen: 'summary',
      items: [
        { ...base, verdict: 'accepted' },
        { ...base, verdict: 'accepted', item: { ...base.item, id: 'finding-2', anchored: false, title: 'Summary finding' } },
      ],
      counts: { accepted: 2, rejected: 0, skipped: 0, undecided: 0 },
    }, 'HVE Core / PR Review');

    expect(body).toContain('1 accepted finding will go to the summary rather than inline.');
    expect(body).toContain('Line comments to post (1)');
    expect(body).not.toContain('Summary finding');
  });

  it('discloses accepted changed-file findings withheld by current line validation', () => {
    const base = state.items[0]!;
    const body = renderReviewFlowBody({
      ...state,
      screen: 'summary',
      items: [{ ...base, verdict: 'accepted' }],
      counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
      withheldInlineItemIds: ['finding-1'],
    }, 'HVE Core / PR Review');

    expect(body).toContain('1 accepted finding no longer has matching code on a current added line');
    expect(body).toContain('it will be withheld from inline submission and included in the summary');
    expect(body).toContain('Line comments to post (0)');
    expect(body).toContain('No accepted finding has a current added-line anchor for inline submission.');
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
    expect(html.slice(html.indexOf('<body>'))).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    // this.cr is not yet assigned at this point, so nothing item-specific renders.
    expect(html).not.toContain('data-item=');
  });

  it('ships the full page script on the loading page so delegated listeners are already armed', () => {
    const html = renderReviewFlowLoadingHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'n');
    expect(html).toContain("post({ type: 'run', instructions })");
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
  /** Split mode throughout: `reviewContextPanel` is part of the shared triage
   *  header, rendered identically whichever mode is active — split is simply
   *  the one this block has always used. */
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
    expect(render({})).not.toMatch(INLINE_STYLE_ATTRIBUTE);
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
 * The running screen used to be a spinner over a canned five-step log parked
 * on step 2, with a fragment/character counter underneath — a healthy
 * multi-minute review and a hung one looked identical, and the counters
 * could never be more than the transport's own byte count (task 14.1,
 * design.md D10/D14). These assert the screen now renders only what the
 * shared `RunProjection` and ordered activity actually say.
 */
describe('the running screen renders from the shared projection alone (task 14.1)', () => {
  function baseProjection(overrides: Partial<RunProjection> = {}): RunProjection {
    return {
      runId: 'run-1',
      lineageId: 'lineage-1',
      attempt: 1,
      lifecycle: 'investigating',
      completeness: 'none',
      elapsedMs: 185_000,
      progressMode: 'indeterminate',
      attention: 'none',
      limitations: [],
      ...overrides,
    };
  }

  function running(overrides: Partial<FlowViewState> = {}): string {
    return renderReviewFlowBody({ ...state, screen: 'running', runProjection: baseProjection(), ...overrides }, 'HVE Core');
  }

  it('shows the current lifecycle and action from the projection, with the start stamp the page ticks from', () => {
    const html = running({
      runProjection: baseProjection({ currentAction: 'Reading changed files', currentTarget: 'src/auth/token.ts' }),
      runStartedAt: 1_770_000_000_000,
    });
    expect(html).toContain('data-started="1770000000000"');
    expect(html).toContain('>3:05</b> elapsed');
    expect(html).toContain('Investigating');
    expect(html).toContain('Reading changed files — src/auth/token.ts');
  });

  it('shows indeterminate progress, with no percentage, before any inventory exists', () => {
    const html = running({ runProjection: baseProjection({ progressMode: 'indeterminate' }) });
    expect(html).toContain('progress-indeterminate');
    expect(html).not.toContain('progress-det');
    expect(html).not.toMatch(/\d+%/);
  });

  it('shows a real percentage only once a denominator exists, and it is exactly the projection\'s own numbers', () => {
    const html = running({
      runProjection: baseProjection({
        progressMode: 'determinate',
        progressUnits: { completed: 5, total: 20 },
        coverage: { classified: 5, total: 20, inspected: 0 },
      }),
    });
    expect(html).toContain('progress-det');
    expect(html).not.toContain('progress-indeterminate');
    expect(html).toContain('width="25"');
    expect(html).toContain('5 of 20 changed files classified');
  });

  it('never estimates a percentage from a partial (incomplete) inventory', () => {
    // Known units, no total yet — D10: "it does not derive a completion
    // percentage from the known subset".
    const html = running({
      runProjection: baseProjection({
        progressMode: 'indeterminate',
        coverage: { classified: 5, total: undefined, inspected: 0 },
      }),
    });
    expect(html).toContain('progress-indeterminate');
    expect(html).toContain('5 changed files classified so far');
    expect(html).not.toMatch(/\d+%/);
  });

  // The `startedAt`/`fragmentsReceived`/`charsReceived` fields this test
  // (#45, task 8.5) originally exercised belonged to the fragment-count
  // progress view task 14.1 deleted; `running()` now builds its state from
  // `runProjection` instead. The assertion itself — no screen ever emits a
  // `style="…"` attribute, since the CSP drops it silently — still holds and
  // is re-run here against the current determinate-progress shape (it is
  // also covered, along with every other screen, by the "no screen writes an
  // inline style attribute" suite below).
  it('carries no style attribute — a nonce authorises style elements only (#45, task 8.5)', () => {
    const html = running({
      runProjection: baseProjection({
        progressMode: 'determinate',
        progressUnits: { completed: 5, total: 20 },
        coverage: { classified: 5, total: 20, inspected: 0 },
      }),
    });
    expect(html).not.toMatch(INLINE_STYLE_ATTRIBUTE);
  });

  it('shows both coverage denominators when both exist', () => {
    const html = running({
      runProjection: baseProjection({
        coverage: { classified: 20, total: 20, inspected: 6, requiredInspected: 9 },
      }),
    });
    expect(html).toContain('20 of 20 changed files classified');
    expect(html).toContain('6 of 9 required files inspected');
  });

  it('shows the public plan and its revisions, with stable item identifiers across a revision', () => {
    const activity: FlowViewState['runActivity'] = [
      {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 1, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'planning', elapsedMs: 0,
        kind: 'planCreated',
        plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect authorization changes', state: 'active' }] },
      },
      {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 2, occurredAt: '2026-08-28T09:01:00.000Z', phase: 'investigating', elapsedMs: 1_000,
        kind: 'planRevised',
        plan: {
          revision: 2,
          rationale: 'A schema consumer was found in another member',
          items: [
            { id: 'p1', description: 'Inspect authorization changes', state: 'completed' },
            { id: 'p2', description: 'Check the schema consumer', state: 'active' },
          ],
        },
      },
    ];
    const html = running({ runActivity: activity });
    expect(html).toContain('revision 2 of 2');
    expect(html).toContain('A schema consumer was found in another member');
    // The prior item's identifier survived the revision — same row, not a new one.
    expect(html).toContain('Inspect authorization changes');
    expect(html).toContain('Check the schema consumer');
  });

  it('shows the activity feed in protocol sequence order and drops a redelivered duplicate', () => {
    // Spec `review-run-activity`: order by sequence, not arrival order; a
    // duplicate event does not create duplicate activity. Handed
    // deliberately out of order, as a deserialized persisted array would
    // arrive — nothing guarantees storage returns events pre-sorted.
    const activity: FlowViewState['runActivity'] = [
      { runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 2, occurredAt: '2026-08-28T09:01:00.000Z', phase: 'investigating', elapsedMs: 1_000, kind: 'actionStarted', action: 'Reading src/b.ts' },
      { runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 1, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'investigating', elapsedMs: 0, kind: 'actionStarted', action: 'Reading src/a.ts' },
      { runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 2, occurredAt: '2026-08-28T09:01:00.000Z', phase: 'investigating', elapsedMs: 1_000, kind: 'actionStarted', action: 'Reading src/b.ts' },
    ];
    const html = running({ runActivity: activity });
    const firstIndex = html.indexOf('Reading src/a.ts');
    const secondIndex = html.indexOf('Reading src/b.ts');
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(firstIndex);
    // Not rendered twice despite the redelivered duplicate.
    expect(html.match(/Reading src\/b\.ts/g)?.length).toBe(1);
  });

  it('shows limitations from the projection', () => {
    const html = running({
      runProjection: baseProjection({ limitations: [{ code: 'incompleteInventory', message: 'The provider could not return the full changed-file manifest.' }] }),
    });
    expect(html).toContain('The provider could not return the full changed-file manifest.');
  });

  it('says nothing extra about completeness while it is still none (D2: independent of lifecycle)', () => {
    const html = running({ runProjection: baseProjection({ completeness: 'none' }) });
    expect(html).not.toContain('Validated findings so far');
  });

  it('shows a partial-completeness note the moment the projection reports one, without waiting for a terminal state', () => {
    const html = running({ runProjection: baseProjection({ completeness: 'partial' }) });
    expect(html).toContain('Validated findings so far: partial');
  });

  it('carries no inline style attribute — this page\'s CSP authorises nonce\'d style elements only (#45)', () => {
    const html = running({
      runProjection: baseProjection({
        progressMode: 'determinate',
        progressUnits: { completed: 5, total: 20 },
        currentAction: 'Reading changed files',
      }),
      runActivity: [{
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 1, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'planning', elapsedMs: 0,
        kind: 'planCreated',
        plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect authorization changes', state: 'active' }] },
      }],
    });
    expect(html).not.toContain('style="');
  });
});

/**
 * Task 14.6: pause/resume/cancel render only where `runControls` (computed
 * in `reviewFlow.ts` from `isLegalRunTransition`) says the manager actually
 * accepts them — never a hand-listed set of lifecycles this renderer keeps
 * in sync on its own.
 */
describe('run controls render only where the manager accepts them (task 14.6)', () => {
  function running(overrides: Partial<FlowViewState> = {}): string {
    return renderReviewFlowBody(
      {
        ...state,
        screen: 'running',
        runProjection: {
          runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
          lifecycle: 'investigating', completeness: 'none', elapsedMs: 10_000,
          progressMode: 'indeterminate', attention: 'none', limitations: [],
        },
        ...overrides,
      },
      'HVE Core',
    );
  }

  it('offers pause and cancel during an active phase — resume is not a legal transition from investigating', () => {
    const html = running({ runControls: { canPause: true, canResume: false, canCancel: true } });
    expect(html).toContain('id="pause-run"');
    expect(html).not.toContain('id="resume-run"');
    expect(html).toContain('id="cancel-run"');
  });

  it('offers resume and cancel, not pause, once the run is already paused', () => {
    const html = running({
      runProjection: {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
        lifecycle: 'paused', completeness: 'none', currentAction: 'Waiting on a rate limit', elapsedMs: 10_000,
        progressMode: 'indeterminate', attention: 'attentionRequired', limitations: [],
      },
      runControls: { canPause: false, canResume: true, canCancel: true },
    });
    expect(html).not.toContain('id="pause-run"');
    expect(html).toContain('id="resume-run"');
    expect(html).toContain('id="cancel-run"');
  });

  it('offers no control at all once the run is cancelling — the manager would refuse every one of them', () => {
    const html = running({
      runProjection: {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1,
        lifecycle: 'cancelling', completeness: 'none', elapsedMs: 10_000,
        progressMode: 'indeterminate', attention: 'none', limitations: [],
      },
      runControls: { canPause: false, canResume: false, canCancel: false },
    });
    expect(html).not.toContain('id="pause-run"');
    expect(html).not.toContain('id="resume-run"');
    expect(html).not.toContain('id="cancel-run"');
  });

  it('renders no controls row at all before the manager has admitted the run', () => {
    const html = running({ runControls: undefined });
    expect(html).not.toContain('id="pause-run"');
    expect(html).not.toContain('id="resume-run"');
    expect(html).not.toContain('id="cancel-run"');
  });
});

/**
 * Task 14.6: the `'agent'` picker screen's resume-from-checkpoint offer —
 * `FlowViewState.interruptedPrior`, set only for a target whose last outcome
 * was `interrupted` and nothing is running now (`reviewFlow.ts`'s own
 * `deriveRunControls`-backed derivation, never re-derived here). Mirrors
 * `harnessResume.test.ts`'s own "no-reconnect wording" check (D13): a
 * resumed run is always a new attempt from a checkpoint, never a claim the
 * lost session picked back up.
 */
describe('resume-from-checkpoint offer on the picker screen (task 14.6)', () => {
  const FORBIDDEN = [/reconnect/i, /reattach/i, /\bresum(e|ed|ing)\b/i, /\bcontinu(e|ed|ing|ation)\b/i, /still connected/i, /same (session|stream|attempt)/i, /picks?\s.*back up/i];

  /**
   * The rule is about what the reviewer reads, so the scan runs over text
   * nodes only. Element ids and classes are machine-facing wiring the
   * page script addresses buttons by — `id="resume-from-checkpoint"` names
   * the control's job, and renaming it would not change one word anyone
   * sees.
   */
  function visibleText(html: string): string {
    return html.replace(/<[^>]*>/g, ' ');
  }

  function agentScreen(interruptedPrior: FlowViewState['interruptedPrior']): string {
    return renderReviewFlowBody({ ...state, screen: 'agent', interruptedPrior }, 'HVE Core');
  }

  it('offers "Start new attempt from checkpoint" when the stored checkpoint is resumable, in wording that never implies reconnection', () => {
    const html = agentScreen({ resumable: true });
    expect(html).toContain('id="resume-from-checkpoint"');
    expect(html).toContain('Start new attempt from checkpoint');
    for (const pattern of FORBIDDEN) expect(visibleText(html)).not.toMatch(pattern);
  });

  it('shows every stored reason and no button when the checkpoint cannot be carried into a new attempt', () => {
    const reasons: Limitation[] = [
      { code: 'model', message: 'The model changed since the checkpoint was written.' },
      { code: 'repositoryIdentity', message: 'The repository no longer matches the checkpoint.' },
    ];
    const html = agentScreen({ resumable: false, reasons });
    expect(html).not.toContain('id="resume-from-checkpoint"');
    expect(html).toContain('The model changed since the checkpoint was written.');
    expect(html).toContain('The repository no longer matches the checkpoint.');
    for (const pattern of FORBIDDEN) expect(visibleText(html)).not.toMatch(pattern);
  });

  it('renders nothing at all when the target has no interrupted prior attempt', () => {
    const html = agentScreen(undefined);
    expect(html).not.toContain('id="resume-from-checkpoint"');
    expect(html).not.toContain('interrupted');
  });

  it('the ordinary "Run review" button is always present alongside the offer — restart costs nothing new', () => {
    const html = agentScreen({ resumable: true });
    expect(html).toContain('id="run"');
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

  it('offers the exact add-context action with a plus icon', () => {
    const html = renderReviewFlowHtml({ ...state, screen: 'agent' }, 'x', 'n');

    expect(html).toContain('id="add-context"');
    expect(html).toContain('class="codicon codicon-add"');
    expect(html).toContain('Add Context…');
    expect(html).toContain("on('add-context', 'addContext')");
  });

  it('flushes the current instructions with Run instead of racing the input debounce', () => {
    const html = renderReviewFlowHtml({ ...state, screen: 'agent' }, 'x', 'n');

    expect(html).toContain("const instructions = document.getElementById('extra')?.value");
    expect(html).toContain("post({ type: 'run', instructions })");
  });

  it('renders both pickers, each labelled', () => {
    const html = run({});
    expect(html).toContain('>Agent</div>');
    expect(html).toContain('>Model</div>');
    expect(html).toContain('GPT-5');
  });

  it('states the live changed-file and attachment count', () => {
    const html = run({ attachments: [
      { id: 'a', kind: 'file', label: 'a.ts', path: 'src/a.ts', content: 'a', truncated: false },
      { id: 'b', kind: 'file', label: 'b.ts', path: 'src/b.ts', content: 'b', truncated: false },
      { id: 'c', kind: 'file', label: 'c.ts', path: 'src/c.ts', content: 'c', truncated: false },
    ] });
    expect(html).toContain('9 changed files + 3 attachments go to the agent.');
    expect(html).not.toContain('never the whole repo');
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
    const page = renderReviewFlowHtml({
      ...state,
      screen: 'agent',
      agents: [BUILTIN, DEMO],
      agentId: DEMO.id,
    }, 'x', 'n');
    expect(html).toContain('Not used by this agent');
    expect(html).not.toContain('id="model-toggle"');
    expect(html).toContain('id="effort-toggle"');
    expect(html).toContain('model-picker-config-hidden');
    expect(page).toContain('.model-picker-config-hidden { display: none; }');
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

  it('renders thinking effort as a plain-text second segment with the Configure Model tooltip', () => {
    const html = run({ effort: 'xhigh' });
    const picker = html.slice(html.indexOf('<div class="model-picker-split">'), html.indexOf('<div class="crit-grid">'));

    expect(picker).toContain('id="effort-toggle"');
    expect(picker).toContain('title="Configure Model"');
    expect(picker).toContain('>Extra High</button>');
    expect(picker).not.toContain('Extra High &gt;');
    expect(picker).not.toContain('· Extra High');
  });

  it('renders all effort levels as one accessible radio group with descriptions and the default marked', () => {
    const html = run({ effort: 'high', effortOpen: true });

    expect(html).toContain('role="menu" aria-label="Thinking Effort"');
    expect(html.match(/role="menuitemradio"/g)).toHaveLength(7);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toContain('data-effort="high" title="reason carefully; consider alternatives before reporting"');
    expect(html).toContain('<span class="effort-default">Default</span>');
    expect(html).toContain("Applied as review instructions in the prompt, not as the model's own reasoning configuration.");
  });

  it('restores the selected level after the CSS-hidden control becomes applicable again', () => {
    const hidden = run({ agents: [BUILTIN, DEMO], agentId: DEMO.id, effort: 'max' });
    const shown = run({ agents: [BUILTIN, DEMO], agentId: BUILTIN.id, effort: 'max' });

    expect(hidden).toContain('model-picker-config-hidden');
    expect(hidden).toContain('>Max</button>');
    expect(shown).toContain('id="effort-toggle"');
    expect(shown).toContain('>Max</button>');
  });

  it('discloses that a differently instructed rerun is not comparable with existing findings', () => {
    const html = run({ effortComparisonDisclosure: true, effortOpen: true });

    expect(html).toContain('next run not comparable with the findings already in hand');
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

  it('writes no inline style attribute anywhere on the screen, pickers or category chips — the webview CSP drops them silently (#45, task 8.5)', () => {
    const html = run({ agentOpen: true, modelOpen: true });
    const pickers = html.slice(html.indexOf('<div class="picker-stack">'), html.indexOf('<div class="crit-grid">'));
    expect(pickers).toContain('agent-select');
    expect(html).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    // The fixture's one active category ('security') gets a coloured class
    // in place of the style="…" this used to carry directly.
    expect(html).toContain('class="cat cat-on-security"');
  });
});

describe('the pre-run context area', () => {
  const run = (over: Partial<FlowViewState> = {}): string => renderReviewFlowHtml({
    ...state,
    screen: 'agent',
    autoContextItems: [
      { id: 'auto:title', kind: 'title', label: 'Refactor token refresh', enabled: true },
      { id: 'auto:description', kind: 'description', label: 'Change request description', enabled: false },
      { id: 'auto:linked:1180', kind: 'linkedItem', label: '#1180 · Rotate keys', enabled: true },
    ],
    attachments: [{
      id: 'schema.ts', kind: 'file', label: 'schema.ts', path: 'src/schema.ts', content: 'schema', truncated: false,
    }],
    ...over,
  }, 'x', 'n');

  it('shows every auto-derived item with its independent enabled state', () => {
    const html = run();

    expect(html).toContain('Refactor token refresh');
    expect(html).toContain('Change request description');
    expect(html).toContain('#1180 · Rotate keys');
    expect(html).toContain('Automatically derived');
    expect(html).toContain('data-auto-context="auto:description" aria-pressed="false"');
    expect(html).toContain("type: 'toggleAutoContextItem'");
  });

  it('renders accessible removable attachment chips with all removal gestures', () => {
    const html = run();

    expect(html).toContain('class="context-chip context-attachment" role="button" tabindex="0"');
    expect(html).toContain('title="Remove from context"');
    expect(html).toContain('aria-label="Remove from context"');
    expect(html).toContain("ev.key === 'Backspace' || ev.key === 'Delete'");
    expect(html).toContain("document.addEventListener('auxclick'");
    expect(html).toContain("type: 'removeContextItem'");
    expect(html).not.toContain('more context');
  });

  it('states the empty context case directly', () => {
    expect(run({ autoContextItems: [], attachments: [] }))
      .toContain('No context will be sent beyond the changed-file diffs.');
  });

  it('discloses truncated attachments and unresolved typed references', () => {
    const html = run({
      attachments: [{ id: 'large', kind: 'file', label: 'large.log', path: 'large.log', content: 'x', truncated: true }],
      unresolvedContextReferences: ['#file:missing.ts'],
    });

    expect(html).toContain('Part sent');
    expect(html).toContain('#file:missing.ts did not resolve.');
    expect(html).toContain('role="status"');
  });

  it('uses classes rather than inline styles throughout the context area', () => {
    const html = run({ contextUsage: { usedTokens: 760, totalTokens: 1_000 } });
    const area = html.slice(html.indexOf('<div class="context-area"'), html.indexOf('<div class="footer-row">'));

    expect(area).toContain('context-usage-warning');
    expect(area).not.toContain('style=');
  });

  it.each([
    [500, 'context-usage-normal', false],
    [750, 'context-usage-warning', true],
    [900, 'context-usage-error', true],
  ])('renders %i tokens with the expected usage state', (usedTokens, cssClass, warned) => {
    const html = run({ contextUsage: { usedTokens, totalTokens: 1_000 } });

    expect(html).toContain(cssClass);
    expect(html).toContain(`aria-label="Context window usage: ${usedTokens / 10}%"`);
    expect(html).toContain(`title="${usedTokens} / 1000 tokens"`);
    expect(html.includes('Quality may decline as limit nears.')).toBe(warned);
  });

  it('hides usage entirely when no reliable count is supplied', () => {
    expect(run({ contextUsage: undefined })).not.toContain('class="context-usage context-usage-');
  });

  it('hides stale usage for unknown capacity, no model, and a model-free agent', () => {
    const staleUsage = { usedTokens: 500, totalTokens: 1_000 };
    const unknownCapacity = state.models.map((model) => ({ ...model, maxInputTokens: undefined }));
    const demo = { id: 'demo', label: 'Demo', description: 'No model', source: 'demo' as const, instructions: '' };

    expect(run({ models: unknownCapacity, contextUsage: staleUsage })).not.toContain('context-usage-normal');
    expect(run({ models: [], modelId: undefined, contextUsage: staleUsage })).not.toContain('context-usage-normal');
    expect(run({ agents: [demo], agentId: demo.id, contextUsage: staleUsage })).not.toContain('context-usage-normal');
  });

  it('shows the same context controls for a changeset with member-labelled attachments', () => {
    const html = run({
      changeset: {
        id: 'cs', name: 'Release', memberCount: 2, projectCount: 2, refs: ['!1', '!2'],
      },
      attachments: [{
        id: 'repo-1!1:schema', kind: 'file', label: 'org/api · schema.ts', path: 'schema.ts', content: 'x', truncated: false,
      }],
      autoContextItems: [{
        id: 'auto:repo-1!1:title', kind: 'title', label: 'org/api · Title · API', enabled: true,
      }],
    });

    expect(html).toContain('id="add-context"');
    expect(html).toContain('org/api · schema.ts');
    expect(html).toContain('org/api · Title · API');
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

  it('shows the recorded effort in the review header', () => {
    const html = renderReviewFlowBody({
      ...state,
      screen: 'triage',
      mode: 'split',
      reviewEffortLabel: 'Extra High',
    } as FlowViewState, 'Security Reviewer');

    expect(html).toContain('effort Extra High');
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

  it('shows retained attachment omissions on both findings and clean results', () => {
    const attachmentWarnings = [{
      code: 'attachment-unreadable' as const,
      attachmentId: 'schema',
      label: 'schema.ts',
      path: 'src/schema.ts',
      reason: 'ENOENT',
    }];

    for (const html of [
      body({ screen: 'triage', attachmentWarnings }),
      body({ screen: 'clean', attachmentWarnings }),
    ]) {
      expect(html).toContain('Some attached context could not be read at run start and was excluded');
      expect(html).toContain('schema.ts');
      expect(html).toContain('ENOENT');
    }
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
    const html = body({ screen: 'running', retainedAvailable: true });
    expect(html).toContain('id="back-to-result"');
    expect(html).toContain('Back to the review you have');
  });

  it('offers no way back when there is no retained review to go back to', () => {
    const html = body({ screen: 'running', retainedAvailable: false });
    expect(html).not.toContain('id="back-to-result"');
  });

  it('says a queued run is waiting for a slot, not that it is failing', () => {
    const html = body({ screen: 'running', runQueued: true });
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
      retainedAvailable: true,
    });
    expect(html).not.toMatch(INLINE_STYLE_ATTRIBUTE);
  });
});

/**
 * Task 14.2 (design.md D14/D16): retained/completed run details — the full
 * ordered activity, plan, coverage, and attempt lineage a real harness
 * attempt produced, or an honest statement of provenance and nothing
 * fabricated for a legacy result.
 */
describe('retained/completed run details show what actually happened (task 14.2)', () => {
  const body = (over: Partial<FlowViewState>): string =>
    renderReviewFlowBody({ ...state, ...over } as FlowViewState, 'Security Reviewer');

  it('states a legacy review\'s provenance and shows no plan, activity, or coverage it does not have', () => {
    const html = body({
      screen: 'clean',
      retainedMeta: { ranAt: '2026-07-28T09:00:00.000Z' },
      retainedDetails: { completeness: 'complete', protocolProvenance: 'legacy-one-shot', limitations: [], activity: [] },
    });
    expect(html).toContain('Legacy review');
    expect(html).toContain('plan, activity, and coverage detail');
    expect(html).not.toContain('plan-block');
    expect(html).not.toContain('activity-log');
    expect(html).not.toContain('coverage-line');
  });

  it('renders a harness result\'s plan, coverage, and lineage on the clean screen', () => {
    const activity: FlowViewState['runActivity'] = [
      {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 1, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'planning', elapsedMs: 0,
        kind: 'planCreated',
        plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect authorization changes', state: 'completed' }] },
      },
      {
        runId: 'run-1', lineageId: 'lineage-1', attempt: 1, sequence: 2, occurredAt: '2026-08-28T09:01:00.000Z', phase: 'investigating', elapsedMs: 1_000,
        kind: 'coverageChanged',
        coverage: { classified: 20, total: 20, inspected: 20 },
      },
    ];
    const html = body({
      screen: 'clean',
      retainedMeta: { ranAt: '2026-08-28T09:00:00.000Z' },
      retainedDetails: { completeness: 'complete', protocolProvenance: 'harness', lineageId: 'lineage-1', attempt: 1, limitations: [], activity },
    });
    expect(html).not.toContain('Legacy review');
    expect(html).toContain('Inspect authorization changes');
    expect(html).toContain('20 of 20 changed files classified');
    expect(html).toContain('Attempt 1');
  });

  it('shows an interrupted earlier attempt when the retained result is attempt 2 or later', () => {
    const html = body({
      screen: 'done',
      doneSentence: 'Review submitted.',
      retainedDetails: { completeness: 'complete', protocolProvenance: 'harness', lineageId: 'lineage-1', attempt: 2, limitations: [], activity: [] },
    });
    expect(html).toContain('Attempt 2');
    expect(html).toContain('an earlier attempt in this lineage was interrupted');
  });

  it('says nothing about an interrupted attempt for a first, un-resumed attempt', () => {
    const html = body({
      screen: 'done',
      doneSentence: 'Review submitted.',
      retainedDetails: { completeness: 'complete', protocolProvenance: 'harness', lineageId: 'lineage-1', attempt: 1, limitations: [], activity: [] },
    });
    expect(html).not.toContain('was interrupted');
  });

  it('shows the same legacy/lineage fact on the triage header, without the full activity feed', () => {
    const legacy = body({
      screen: 'triage',
      mode: 'split',
      retainedDetails: { completeness: 'complete', protocolProvenance: 'legacy-one-shot', limitations: [], activity: [] },
    });
    expect(legacy).toContain('legacy review, no coverage detail');
    expect(legacy).not.toContain('activity-log');

    const resumed = body({
      screen: 'triage',
      mode: 'split',
      retainedDetails: { completeness: 'complete', protocolProvenance: 'harness', lineageId: 'lineage-1', attempt: 2, limitations: [], activity: [] },
    });
    expect(resumed).toContain('attempt 2 — an earlier attempt was interrupted');
  });

  it('writes no inline style attribute in the retained-details block', () => {
    const activity: FlowViewState['runActivity'] = [{
      runId: 'run-1', lineageId: 'lineage-1', attempt: 2, sequence: 1, occurredAt: '2026-08-28T09:00:00.000Z', phase: 'planning', elapsedMs: 0,
      kind: 'planCreated',
      plan: { revision: 1, items: [{ id: 'p1', description: 'Inspect authorization changes', state: 'completed' }] },
    }];
    const html = body({
      screen: 'clean',
      retainedDetails: {
        completeness: 'complete', protocolProvenance: 'harness', lineageId: 'lineage-1', attempt: 2,
        limitations: [{ code: 'someLimit', message: 'A limitation.' }], activity,
      },
    });
    expect(html).not.toContain('style="');
  });
});

/**
 * The host holds every editable's in-progress text (task 9.3, design D8):
 * committed on debounced input — 'change' fires on blur, which left
 * mid-typing text nowhere but the DOM for a flow-body patch to paint over —
 * and rendered back into the field, because REGIONS_SCRIPT restores focus
 * and selection only, never `value`.
 */
describe('in-progress text is committed to the host (task 9.3)', () => {
  const html = renderReviewFlowHtml(state, 'HVE Core / PR Review', 'n');

  it('commits the summary, note and instructions on debounced input, never on change', () => {
    expect(html).toContain("post({ type: 'editSummary', text })");
    expect(html).toContain("post({ type: 'setNote', text })");
    expect(html).toContain("post({ type: 'setInstructions', text })");
    expect(html).not.toContain("post({ type: 'editSummary', text: ev.target.value })");
    expect(html).not.toContain("post({ type: 'setNote', text: ev.target.value })");
    expect(html).not.toContain("post({ type: 'setInstructions', text: ev.target.value })");
  });

  it('keeps the one podStore write on blur, as commitInstructions', () => {
    // The per-keystroke setInstructions updates in-memory criteria only —
    // podStore.upsert is a read-modify-write, and one per character is what
    // task 4.5 forbids.
    expect(html).toContain("post({ type: 'commitInstructions', text: ev.target.value })");
  });

  it('flushes pending commits before any click reaches an action handler', () => {
    // Capture phase, so a submit, copy-md or verdict acts on the text as
    // typed — a debounce timer outliving the action that consumes it is how
    // stale text resurrects.
    expect(html).toContain('pendingCommits');
    expect(html).toContain('}, true);');
  });

  it('renders the per-finding ask draft back into the field, escaped', () => {
    const base = state.items[0]!;
    const withDraft = renderReviewFlowBody(
      { ...state, mode: 'split', items: [{ ...base, askDraft: 'why is "x" safe?' }] } as FlowViewState,
      'HVE Core / PR Review',
    );
    expect(withDraft).toContain('id="ask"');
    expect(withDraft).toContain('value="why is &quot;x&quot; safe?"');
  });

  it('cancels the pending draft commit when the question is sent', () => {
    // A commit firing after the host clears the draft on send would write the
    // already-sent question back for the next patch to replay.
    expect(html).toContain("dropCommit('ask:' + id)");
  });

  it('flushes pending commits on blur, not only on a click in the page', () => {
    // The palette reaches submit directly (codeVerdict.submitReview) without
    // any click landing in the webview, so a click-only flush would let it
    // post a summary up to the debounce window out of date — to the platform.
    // Blur is the one signal every such path shares.
    expect(html).toContain("document.addEventListener('click', flushCommits, true)");
    expect(html).toContain("document.addEventListener('blur', flushCommits, true)");
    expect(html).toContain("window.addEventListener('blur', flushCommits)");
  });

  it('emits a page script that actually parses', () => {
    // tsc and eslint never parse the JS inside these template literals, so a
    // syntax error here reaches the webview and disables the whole page
    // silently. Compile the emitted script body rather than trusting review.
    const script = /<script nonce="[^"]*">([\s\S]*?)<\/script>/.exec(html)?.[1];
    expect(script).toBeTruthy();
    expect(() => new Function(script!)).not.toThrow();
  });
});

/**
 * Task 8.5 (issue #45): the page CSP is `style-src 'nonce-…'` — a nonce
 * authorises the `<style>` element only, so a `style="…"` attribute is
 * dropped before layout with no error anywhere. One state per `FlowScreen`,
 * keyed by a `Record<FlowScreen, …>` rather than a hand-picked list: adding a
 * member to that union without adding a state here fails typecheck, so a new
 * screen cannot silently skip this check the way the category chips and the
 * running screen's progress bar did before this task.
 */
describe('no screen writes an inline style attribute (issue #45, task 8.5)', () => {
  const SCREEN_STATES: Record<FlowScreen, FlowViewState> = {
    agent: { ...state, screen: 'agent' },
    running: {
      ...state,
      screen: 'running',
      runProjection: {
        runId: 'run-1',
        lineageId: 'lineage-1',
        attempt: 1,
        lifecycle: 'investigating',
        completeness: 'none',
        elapsedMs: 5_000,
        progressMode: 'determinate',
        progressUnits: { completed: 1, total: 2 },
        attention: 'none',
        limitations: [],
      },
    },
    triage: { ...state, screen: 'triage', mode: 'diff' },
    clean: { ...state, screen: 'clean', items: [], selectedId: undefined, diffLines: undefined },
    summary: {
      ...state,
      screen: 'summary',
      items: state.items.map((v) => ({ ...v, verdict: 'accepted' as const })),
      counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 },
    },
    submitting: { ...state, screen: 'submitting', submitProgress: { stage: 'comments', posted: 3, total: 12 } },
    done: { ...state, screen: 'done' },
  };

  it('renders none of the seven screens with a style attribute', () => {
    for (const screen of Object.keys(SCREEN_STATES) as FlowScreen[]) {
      const html = renderReviewFlowBody(SCREEN_STATES[screen], 'HVE Core / PR Review');
      expect(html, `screen: ${screen}`).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    }
  });

  it('covers the variants FlowScreen alone does not reach: every triage mode, a failed or queued run, and the pre-load pages', () => {
    for (const mode of ['split', 'queue', 'diff'] as const) {
      const html = renderReviewFlowBody({ ...state, screen: 'triage', mode }, 'HVE Core / PR Review');
      expect(html, `triage mode: ${mode}`).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    }
    const runError = renderReviewFlowBody(
      { ...state, screen: 'running', runError: { message: 'boom', requestId: 'r1', partialCount: 2, code: 'E_TIMEOUT' } },
      'HVE Core / PR Review',
    );
    expect(runError).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    const runQueued = renderReviewFlowBody(
      { ...state, screen: 'running', runQueued: true },
      'HVE Core / PR Review',
    );
    expect(runQueued).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    expect(renderReviewFlowLoadingHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'n')).not.toMatch(INLINE_STYLE_ATTRIBUTE);
    expect(renderReviewFlowErrorHtml({ refLabel: '!2841', projectPath: 'hve/platform/core' }, 'boom', 'n')).not.toMatch(INLINE_STYLE_ATTRIBUTE);
  });
});

// ---- a patch preserves scroll on the real diff screen (ui-responsiveness:
// "Scrolled partway through a long diff") -------------------------------------
//
// The rejected test (dashboardScript.test.ts) patched a synthetic
// `statefulRegion()` string the test itself injected — no diff, no review
// screen. This drives the real `renderReviewFlowHtml`/`renderReviewFlowBody`
// in `mode: 'diff'`, in jsdom, the same way dashboardScript.test.ts drives the
// dashboard's page script (that file's own comment explains why: jsdom has no
// layout, so its `window.scrollTo` is unimplemented, and vitest's jsdom
// environment never runs page scripts at all — hence a hand-built `JSDOM`
// under the node environment, and a scroll double duplicated here rather than
// imported from that file).

interface ScrollDouble { x: number; y: number; max: number }

function loadFlowPage(html: string): { dom: JSDOM; scroll: ScrollDouble } {
  const scroll: ScrollDouble = { x: 0, y: 0, max: Number.MAX_SAFE_INTEGER };
  const virtualConsole = new VirtualConsole();
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    virtualConsole,
    beforeParse(window) {
      (window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
        postMessage: (): void => undefined,
      });
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

function patchFlow(dom: JSDOM, regions: Record<string, string>): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent('message', {
    data: { type: 'verdict:regions', regions },
  }));
}

describe('a patch preserves scroll position on the real in-diff triage screen', () => {
  /** A second, unrelated finding — a real diff screen only ever shows the
   * SELECTED finding's file, so a second one is what makes the redraw below
   * genuinely unrelated to the diff on screen rather than a no-op. */
  const otherFinding = {
    item: {
      id: 'finding-2', anchored: true, file: 'src/auth/session.ts', line: 10, severity: 'minor' as const,
      category: 'style' as const, confidence: 80, title: 'Unrelated finding',
      body: 'Not the one being read.', code: 'x',
    },
    thread: [],
  };
  function diffState(overrides: Partial<FlowViewState> = {}): FlowViewState {
    return {
      ...state,
      mode: 'diff',
      items: [state.items[0]!, otherFinding],
      counts: { accepted: 0, rejected: 0, skipped: 0, undecided: 2 },
      ...overrides,
    };
  }

  it('the diff stays at the same window scroll position after a patch caused by an unrelated finding', () => {
    const { dom, scroll } = loadFlowPage(renderReviewFlowHtml(diffState(), 'HVE Core / PR Review', 'testnonce'));
    const document = dom.window.document;
    // The real renderer, not injected markup: the diff lines and the flagged
    // widget this file's own fixture (`state.diffLines`) describes.
    expect(document.querySelector('.diff-code')).not.toBeNull();
    expect(document.querySelector('.diff-line')).not.toBeNull();

    dom.window.scrollTo(0, 640);

    // The redraw: the OTHER finding gets decided in the background. The
    // selected finding, its diff and its body are untouched.
    patchFlow(dom, {
      'flow-body': renderReviewFlowBody(
        diffState({
          items: [diffState().items[0]!, { ...otherFinding, verdict: 'accepted' }],
          counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 1 },
        }),
        'HVE Core / PR Review',
      ),
    });

    expect(scroll.y).toBe(640);
    // Still the real diff markup after the patch, not a blank or reset region.
    expect(document.querySelector('.diff-code')).not.toBeNull();
  });
});

// ---- an unchanged diff is not re-derived (ui-responsiveness) ---------------
//
// `parseHunks` (domain/diffHunks.ts) memoizes on the diff string and — its own
// doc comment says so — "returns the SAME Hunk[] on a cache hit rather than a
// copy". `diffHunks.test.ts`'s "memoization (D10)" block already proves that
// at the pure-function level. What is missing is the render-level half the
// audit asked for: proof that the exact derivation `reviewFlow.ts` performs
// for the triage-diff screen (reviewFlowHtml.ts's `diffLines`: `parseHunks(
// file.diff).flatMap(hunk => hunk.lines)`), called twice the way two renders
// across an unrelated redraw would call it, yields the identical `HunkLine`
// objects — not merely equal ones — so nothing downstream re-parsed anything.
//
// The finding's body (markdown) is the other half named in the scenario's
// THEN. `renderMarkdown` (ui/markdown.ts) wraps the same `memoize` and its own
// `markdown.test.ts` ("memoization (D10)") already covers it — but only via an
// independently-constructed `memoize(vi.fn(renderMarkdownUncached))`, never
// the real exported `renderMarkdown`'s own cache: that cache closes over
// `renderMarkdownUncached` at module load, so a spy placed on the export
// afterwards cannot observe it, and `renderMarkdown`'s return value is a
// plain string — two calls with identical input are `===` by value whether or
// not a re-parse happened, so reference identity proves nothing for it the
// way it does for `parseHunks`'s array return. No render-level test is added
// for the body half; this is a limit of what is externally observable, not an
// uncovered scenario.
describe('an unchanged diff is not re-derived across an unrelated redraw', () => {
  it('the diffLines a render actually consumes are the identical HunkLine objects on a second render', () => {
    const diffText = '@@ -62,3 +62,3 @@\n if (cachedToken) {\n-  return staleToken;\n+  return cachedToken;\n }\n';
    // Exactly how reviewFlowHtml.ts's `diffLines` is derived — the same
    // production function, called the same way a real render would.
    const linesA = parseHunks(diffText).flatMap((hunk) => hunk.lines);
    // A second render, for a reason unrelated to this diff (another finding
    // decided, the tallies changed) — the diff text itself is unchanged.
    const linesB = parseHunks(diffText).flatMap((hunk) => hunk.lines);

    expect(linesA).toHaveLength(4);
    expect(linesA.map((l) => l.text)).toEqual(['if (cachedToken) {', '  return staleToken;', '  return cachedToken;', '}']);
    // Reference identity, not deep equality: `parseHunksUncached` builds a
    // fresh array of fresh objects on every real parse, so the same object at
    // the same index across two calls is only possible if the second call
    // served the memoized Hunk rather than re-parsing.
    for (let i = 0; i < linesA.length; i += 1) expect(linesB[i]).toBe(linesA[i]);

    // What the render actually emits from each is identical too — nothing
    // about the finding changed between the two.
    const stateA: FlowViewState = { ...state, mode: 'diff', diffLines: linesA };
    const stateB: FlowViewState = { ...state, mode: 'diff', diffLines: linesB, counts: { accepted: 1, rejected: 0, skipped: 0, undecided: 0 } };
    const diffMarkupOf = (html: string): string => html.slice(html.indexOf('<div class="diff-code">'));
    expect(diffMarkupOf(renderReviewFlowBody(stateB, 'HVE Core / PR Review')))
      .toBe(diffMarkupOf(renderReviewFlowBody(stateA, 'HVE Core / PR Review')));
  });
});
