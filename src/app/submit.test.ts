import { describe, expect, it, vi } from 'vitest';
import { parseAgentReviewResponse } from '../domain/agentResponse';
import { resolveAnchor } from '../domain/anchor';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { diffAnchorCandidates } from '../domain/diffHunks';
import { createReview, setVerdict } from '../domain/reviewState';
import type { Review } from '../domain/types';
import { loadSpecFixtures } from '../testing/specFixtures';
import { composeCommentDrafts, composeSummaryBody, performSubmit } from './submit';

const fixtures = loadSpecFixtures();
const { response } = parseAgentReviewResponse(fixtures.agentReviewResponse);
const refs = (fixtures.gitlabMergeRequest as { diff_refs: unknown }).diff_refs;
const storedLineCandidates = (review: Review) => (file: string) => review.items
  .filter((item) => item.file === file)
  .map((item) => ({ line: item.line, text: item.code }));

describe('composeCommentDrafts (spec §7)', () => {
  it('posts accepted items only, with the fixture attribution shape', () => {
    let review = createReview({
      repoId: '9101',
      crNumber: '2841',
      agentId: response.agentId,
      criteria: DEFAULT_CRITERIA,
      response,
    });
    review = setVerdict(review, 'itm_01H9Z4', 'accepted', true);
    review = setVerdict(review, 'itm_01H9Z5', 'rejected', false);
    review = setVerdict(review, 'itm_01H9Z6', 'accepted', false);

    const { drafts } = composeCommentDrafts(
      review,
      'HVE Core · PR Review',
      'you',
      refs,
      storedLineCandidates(review),
    );
    expect(drafts.map((d) => d.key)).toEqual(['itm_01H9Z4', 'itm_01H9Z6']);

    const blocker = drafts[0];
    expect(blocker?.body).toContain('**Refresh token logged in error path** · blocker · security · CWE-532');
    expect(blocker?.footer).toBe(
      '<sub>Flagged by HVE Core · PR Review (96% confidence), accepted by @you via Code Verdict.</sub>',
    );
    // applyFix carries the suggestion; comment-only acceptance drops it.
    expect(blocker?.suggestion).toBeDefined();
    expect(drafts[1]?.suggestion).toBeUndefined();
    expect(blocker?.anchor).toMatchObject({ filePath: 'src/auth/token.ts', line: 63, refs });
  });

  it('appends the final note after a divider', () => {
    expect(composeSummaryBody('Summary.', 'Note.')).toBe('Summary.\n\n---\n\nNote.');
    expect(composeSummaryBody('Summary.', '  ')).toBe('Summary.');
  });

  it('routes accepted attachment findings to the summary and keeps diff findings inline', () => {
    const { response: routed } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [
        { id: 'inline', file: 'src/diff.ts', line: 4, severity: 'major', category: 'tests', confidence: 90, title: 'Inline', body: 'Inline body', code: 'bad();' },
        { id: 'summary', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'Summary only', body: 'Summary body', code: 'stale text' },
      ],
    }, {
      diffPaths: ['src/diff.ts'],
      attachmentManifest: [{ path: 'docs/evidence.md', ranges: [{ startLine: 12, endLine: 12 }] }],
    });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: routed,
    });
    review = setVerdict(review, 'inline', 'accepted', false);
    review = setVerdict(review, 'summary', 'accepted', false);

    expect(composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      storedLineCandidates(review),
    ).drafts.map((draft) => draft.key)).toEqual(['inline']);
    const summary = composeSummaryBody('Review summary.', '', review);
    expect(summary).toContain('## Accepted findings outside the diff');
    expect(summary).toContain('### docs/evidence.md:12 - Summary only');
    expect(summary).toContain('Summary body');
    expect(summary).not.toContain('### src/diff.ts:4');
  });

  it('qualifies duplicate changeset attachment paths with member identity', () => {
    const { response: routed } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'combined',
      items: [
        { id: 'first', projectId: 'repo-a', mrIid: '11', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'First member', body: 'First body', code: 'stale' },
        { id: 'second', projectId: 'repo-b', mrIid: '22', file: 'docs/evidence.md', line: 12, severity: 'minor', category: 'docs', confidence: 85, title: 'Second member', body: 'Second body', code: 'stale' },
      ],
    }, {
      diffPaths: [],
      attachmentManifest: [{ path: 'docs/evidence.md', ranges: [{ startLine: 12, endLine: 12 }] }],
    });
    let review = createReview({
      repoId: 'changeset', crNumber: 'set-1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: routed,
    });
    review = setVerdict(review, 'first', 'accepted', false);
    review = setVerdict(review, 'second', 'accepted', false);

    const summary = composeSummaryBody('Review summary.', '', review);
    expect(summary).toContain('### projectId=repo-a mrIid=11 file=docs/evidence.md:12 - First member');
    expect(summary).toContain('### projectId=repo-b mrIid=22 file=docs/evidence.md:12 - Second member');
  });

  it('keeps a drifted diff-file finding anchored, repairs its line, and posts it inline', () => {
    const { response: drifted } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'drifted', file: 'src/diff.ts', line: 4, endLine: 5, severity: 'major', category: 'tests', confidence: 90, title: 'Drifted', body: 'Body', code: 'bad();' }],
    }, { diffPaths: ['src/diff.ts'] });
    const item = drifted.items[0]!;
    expect(item.anchored).toBe(true);
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: drifted,
    });
    review = setVerdict(review, 'drifted', 'accepted', false);

    const resolution = resolveAnchor([{ line: 9, text: 'bad();' }], item);
    expect(resolution).toEqual({ state: 'moved', line: 9 });
    const composed = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'bad();' }, { line: 10, text: 'next();' }],
    );
    expect(composed.drafts[0]?.anchor.line).toBe(9);
    expect(composed.drafts[0]?.anchor.endLine).toBe(10);
    expect(composed.withheld).toEqual([]);
  });

  it.each([
    ['no matching code', [{ line: 9, text: 'realAddedLine();' }]],
    ['no added lines', []],
    ['no changed file candidates', undefined],
  ] as const)('withholds an accepted anchored finding with %s', (_label, candidates) => {
    const { response: hallucinated } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'hallucinated', file: 'src/diff.ts', line: 999, severity: 'major', category: 'tests', confidence: 90, title: 'Hallucinated', body: 'Body', code: 'notInTheDiff();' }],
    }, { diffPaths: ['src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: hallucinated,
    });
    review = setVerdict(review, 'hallucinated', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, () => candidates);
    expect(composed.drafts).toEqual([]);
    expect(composed.withheld.map((item) => item.id)).toEqual(['hallucinated']);
    expect(composeSummaryBody('Review summary.', '', review, composed.withheld)).toContain(
      'Withheld from inline submission because neither its code nor its reported line matches anything currently in the diff.',
    );
  });

  it('withholds attached unchanged-line evidence in a changed file from inline submission', () => {
    const { response: attached } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'attached-context', file: 'src/diff.ts', line: 40, severity: 'major', category: 'tests', confidence: 90, title: 'Unchanged context', body: 'Body', code: 'unchangedContext();' }],
    }, {
      diffPaths: ['src/diff.ts'],
      attachmentManifest: [{ path: 'src/diff.ts', ranges: [{ startLine: 40, endLine: 40 }] }],
    });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: attached,
    });
    review = setVerdict(review, 'attached-context', 'accepted', false);

    expect(attached.items[0]?.anchored).toBe(true);
    const composed = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'realAddedLine();' }],
    );
    expect(composed.drafts).toEqual([]);
    expect(composeSummaryBody('Review summary.', '', review, composed.withheld)).toContain(
      '### src/diff.ts:40 - Unchanged context',
    );
  });

  it('never sends a hallucinated line to the provider comment list', async () => {
    const { response: hallucinated } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{ id: 'hallucinated', file: 'src/diff.ts', line: 999, severity: 'major', category: 'tests', confidence: 90, title: 'Hallucinated', body: 'Body', code: 'notInTheDiff();' }],
    }, { diffPaths: ['src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response: hallucinated,
    });
    review = setVerdict(review, 'hallucinated', 'accepted', false);
    const composition = composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      () => [{ line: 9, text: 'realAddedLine();' }],
    );
    const submitReview = vi.fn(async (_ref, submission: { comments: unknown[] }) => ({
      comments: submission.comments,
      summaryPosted: true,
    }));

    await performSubmit({ submitReview } as never, { repoId: 'repo', number: '1' }, {
      drafts: composition.drafts,
      summary: composeSummaryBody('Summary.', '', review, composition.withheld),
      requestChanges: false,
      asSingleThread: false,
    });

    expect(submitReview).toHaveBeenCalledOnce();
    expect(submitReview.mock.calls[0]?.[1].comments).toEqual([]);
  });

  it('removes only the known workspace-root prefix from provider comment anchors', () => {
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{
        id: 'rooted', file: 'api/src/diff.ts', line: 4, severity: 'major', category: 'tests', confidence: 90, code: 'changed();',
      }],
    }, { diffPaths: ['api/src/diff.ts'] });
    let review = createReview({
      repoId: 'repo', crNumber: '1', agentId: 'agent', criteria: DEFAULT_CRITERIA, response,
    });
    review = setVerdict(review, 'rooted', 'accepted', false);

    expect(composeCommentDrafts(
      review,
      'Agent',
      'you',
      refs,
      storedLineCandidates(review),
      'api',
    ).drafts[0]?.anchor.filePath).toBe('src/diff.ts');
  });
});

// A hunk that rewrites part of a function, leaving several statements as
// unchanged context around two real additions. Widening the candidate
// universe past added-only lines is what makes a finding on any of these
// context lines anchorable at all — a categorical bug confirmed by reading
// `anchorCandidates`, independent of whether it is what withheld any one
// real finding.
const REWRITE_DIFF = [
  '@@ -10,7 +10,9 @@ impl Panel {',
  ' fn shared() {}',
  '+fn resolve_click_space() -> bool {',
  '     let a = 1;',
  '     if a == 1 {',
  '         return true;',
  '     }',
  '+    false',
  ' }',
].join('\n');

function itemAt(id: string, line: number, code: string): Record<string, unknown> {
  return { id, file: 'src/panel.rs', line, severity: 'major', category: 'craftsmanship', confidence: 90, title: id, body: 'Body', code };
}

describe('mandate A: a finding on a context or removed line anchors inline', () => {
  const candidatesFor = () => diffAnchorCandidates(REWRITE_DIFF);

  it('anchors five findings that all sit on context lines around a rewritten hunk — none withheld', () => {
    // New-file line numbers of the five context lines in REWRITE_DIFF: the
    // function above the rewrite (10), the three untouched statements inside
    // it (12, 13, 14), and the closing brace (17).
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [
        itemAt('above', 10, 'fn shared() {}'),
        itemAt('assign', 12, '    let a = 1;'),
        itemAt('condition', 13, '    if a == 1 {'),
        itemAt('return', 14, '        return true;'),
        itemAt('brace', 17, '}'),
      ],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    for (const item of response.items) review = setVerdict(review, item.id, 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.withheld).toEqual([]);
    expect(composed.drafts.map((d) => [d.key, d.anchor.line, d.anchor.side])).toEqual([
      ['above', 10, 'new'],
      ['assign', 12, 'new'],
      ['condition', 13, 'new'],
      ['return', 14, 'new'],
      ['brace', 17, 'new'],
    ]);
  });

  it('carries a context anchor\'s paired old-file line, and leaves it off a plain addition', () => {
    // GitLab's position API needs BOTH coordinates for an unchanged line
    // (`gitlab/mappers.ts#buildPosition`); this is where that pairing must
    // survive the anchoring pipeline into the drafted comment. Line 12
    // ('let a = 1;') is context — new 12 pairs with old 11 in REWRITE_DIFF.
    // Line 11 ('fn resolve_click_space...') is a pure addition and must
    // carry no old-side number at all.
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [
        itemAt('context-line', 12, '    let a = 1;'),
        itemAt('added-line', 11, 'fn resolve_click_space() -> bool {'),
      ],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    for (const item of response.items) review = setVerdict(review, item.id, 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.withheld).toEqual([]);
    expect(composed.drafts.find((d) => d.key === 'context-line')?.anchor).toMatchObject({ line: 12, oldLine: 11 });
    expect(composed.drafts.find((d) => d.key === 'added-line')?.anchor.oldLine).toBeUndefined();
  });

  it('anchors a finding about a removed statement on the old side, side LEFT', () => {
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'removed', file: 'src/legacy.rs', line: 61, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'Removed without replacement', body: 'Body', code: "logger.error('refresh failed')",
        suggestion: { old: 'x', new: 'y' },
      }],
    }, { diffPaths: ['src/legacy.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'removed', 'accepted', true);

    const diff = [
      '@@ -60,4 +60,3 @@ export class TokenStore {',
      '   async refresh() {',
      "-    logger.error('refresh failed')",
      '     throw new RefreshError()',
      '   }',
    ].join('\n');
    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, () => diffAnchorCandidates(diff));
    expect(composed.withheld).toEqual([]);
    expect(composed.drafts[0]?.anchor).toMatchObject({ line: 61, side: 'old' });
    // A suggestion fence replaces a line's content — meaningless on a
    // deletion, since there is no live line left to replace.
    expect(composed.drafts[0]?.suggestion).toBeUndefined();
  });

  it('withholds a multi-line range that reaches past what the diff shows', () => {
    // The hunk's new side ends at line 17; a range that claims to run to 20
    // has three lines the diff carries no text for at all, so the whole
    // comment is withheld rather than posted against a guessed range.
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'overreach', file: 'src/panel.rs', line: 14, endLine: 20, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'Overreaching range', body: 'Body', code: '        return true;',
      }],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'overreach', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.drafts).toEqual([]);
    expect(composed.withheld.map((i) => i.id)).toEqual(['overreach']);
  });

  it('anchors on the recorded line when its code matches nowhere at all — the recorded line is the PRIMARY anchor', () => {
    // Reproduces the confirmed shape of the 2026-09-12 incident: the finding's
    // recorded line (11) is genuinely an added line in the diff — trim-match
    // would find it instantly for a one-line quote — but `code` here is the
    // multi-line hunk the field is documented to carry, which can never
    // trim-equal any single candidate line. Withholding this finding would be
    // wrong: its location was never in question, only the text comparison.
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'multiline-code', file: 'src/panel.rs', line: 11, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'Multi-line quote', body: 'Body',
        code: 'fn resolve_click_space() -> bool {\n    false\n}',
        suggestion: { old: 'x', new: 'y' },
      }],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'multiline-code', 'accepted', true);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.withheld).toEqual([]);
    expect(composed.drafts[0]?.anchor).toMatchObject({ line: 11, side: 'new' });
    // Unverified — the fix's target text was never confirmed — so no
    // suggestion fence is offered even though the finding carried one.
    expect(composed.drafts[0]?.suggestion).toBeUndefined();
  });

  it('carries the recorded line\'s paired old-file number through the fallback too, when it lands on context', () => {
    // Same shape as the incident reproduction above, but the recorded line
    // (12) is a context line rather than a plain addition — its `oldLine`
    // pairing must survive the unverified fallback exactly as it does the
    // verified path, or a GitLab comment built from this draft would be
    // missing the coordinate its position API requires.
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'multiline-context', file: 'src/panel.rs', line: 12, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'Multi-line quote on context', body: 'Body',
        code: 'fn resolve_click_space() -> bool {\n    false\n}',
      }],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'multiline-context', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.withheld).toEqual([]);
    expect(composed.drafts[0]?.anchor).toMatchObject({ line: 12, side: 'new', oldLine: 11 });
  });

  it('still withholds when the code matches nothing AND the recorded line is not addressable either', () => {
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'nowhere', file: 'src/panel.rs', line: 500, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'Nowhere near the hunk', body: 'Body', code: 'fn resolve_click_space() -> bool {\n    false\n}',
      }],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'nowhere', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.drafts).toEqual([]);
    expect(composed.withheld.map((i) => i.id)).toEqual(['nowhere']);
  });

  it.each([
    ['an empty-string code field', { code: '' }],
    ['an omitted code field', {}],
  ] as const)('withholds a finding with %s even when its recorded line is addressable', (_label, codeField) => {
    // Line 11 is genuinely an added line in REWRITE_DIFF — exactly the shape
    // the recorded-line fallback exists to rescue — but the fallback's
    // justification is "evidence existed but could not be text-matched", not
    // "there was no evidence at all". `resolveAnchor` already reports empty
    // code as unconditionally `lost`; this finding must not then fall
    // through to trusting the bare line number anyway.
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'h',
      items: [{
        id: 'no-evidence', file: 'src/panel.rs', line: 11, severity: 'major', category: 'craftsmanship',
        confidence: 90, title: 'No supporting code', body: 'Body', ...codeField,
      }],
    }, { diffPaths: ['src/panel.rs'] });
    let review = createReview({ repoId: 'r', crNumber: '1', agentId: 'a', criteria: DEFAULT_CRITERIA, response });
    review = setVerdict(review, 'no-evidence', 'accepted', false);

    const composed = composeCommentDrafts(review, 'Agent', 'you', refs, candidatesFor);
    expect(composed.drafts).toEqual([]);
    expect(composed.withheld.map((i) => i.id)).toEqual(['no-evidence']);
  });
});

describe('the verdict is sent once, however many times submit is retried', () => {
  it('withholds request-changes on a retry that already landed it', async () => {
    const sent: Array<{ requestChanges?: boolean }> = [];
    const connection = {
      submitReview: (_ref: unknown, submission: { requestChanges?: boolean }) => {
        sent.push({ requestChanges: submission.requestChanges });
        return Promise.resolve({ comments: [], summaryPosted: true });
      },
    } as unknown as Parameters<typeof performSubmit>[0];

    const plan = { drafts: [], summary: 's', requestChanges: true, asSingleThread: false };
    await performSubmit(connection, { repoId: 'r', number: '1' }, plan as never, {});
    await performSubmit(connection, { repoId: 'r', number: '1' }, plan as never, {
      verdictAlreadyApplied: true,
    });

    // GitHub creates a NEW review per call, so re-sending would stack a second
    // "changes requested" and re-notify the author.
    expect(sent.map((s) => s.requestChanges)).toEqual([true, false]);
  });
});
