import { describe, expect, it } from 'vitest';
import { GITLAB_VOCABULARY } from '../testing/specFixtures';
import type { FlowViewState } from './reviewFlowHtml';
import { renderReviewFlowBody, renderReviewFlowErrorHtml, renderReviewFlowHtml, renderReviewFlowLoadingHtml } from './reviewFlowHtml';

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
  agents: [{ id: 'agent', label: 'HVE Core / PR Review', description: 'Reviews diffs', source: 'demo' }],
  agentId: 'agent',
  agentOpen: false,
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

  it('renders model output as text, never as markup', () => {
    // The answer is whatever the model returned; innerHTML here would be an
    // injection sink fed by an external system.
    expect(html).toContain('text.textContent = t.text');
    expect(html).not.toContain('innerHTML = t.text');
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
