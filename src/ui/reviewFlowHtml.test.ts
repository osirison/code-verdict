import { describe, expect, it } from 'vitest';
import type { FlowViewState } from './reviewFlowHtml';
import { renderReviewFlowHtml } from './reviewFlowHtml';

const state: FlowViewState = {
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
    expect(html).toContain('summary is posted to every member');
  });
});