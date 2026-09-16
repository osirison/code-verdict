import { describe, expect, it } from 'vitest';
import { escapeMarkdownText, markdownCodeFence, markdownCodeSpan, neutralizeCodeFences } from './markdownSafety';

describe('escapeMarkdownText', () => {
  it('leaves plain prose untouched', () => {
    expect(escapeMarkdownText('Refresh token logged in error path')).toBe(
      'Refresh token logged in error path',
    );
  });

  it('collapses an embedded newline so a fence on its own line cannot open a real code block', () => {
    const title = 'Closes early\n```\nrm -rf /\n```';
    const escaped = escapeMarkdownText(title);
    expect(escaped).not.toContain('\n');
    // Every backtick is neutralized too — even collapsed onto one line, an
    // unescaped run of three would still be readable as a fence.
    expect(escaped).toBe('Closes early \\`\\`\\` rm \\-rf / \\`\\`\\`');
  });

  it('neutralizes a leading heading marker so it cannot be read as document structure', () => {
    expect(escapeMarkdownText('### Fake heading')).toBe('\\#\\#\\# Fake heading');
  });

  it('neutralizes bold/italic/link metacharacters', () => {
    expect(escapeMarkdownText('*bold* _em_ [link](evil) and > quote')).toBe(
      '\\*bold\\* \\_em\\_ \\[link\\](evil) and \\> quote',
    );
  });
});

describe('markdownCodeSpan', () => {
  it('wraps ordinary text in a single pair of backticks', () => {
    expect(markdownCodeSpan('src/app/submit.ts')).toBe('`src/app/submit.ts`');
  });

  it('widens the delimiter so a backtick inside the content cannot close the span early', () => {
    expect(markdownCodeSpan('src/weird`quote.ts')).toBe('``src/weird`quote.ts``');
  });

  it('widens past the longest run the content contains, however long that run is', () => {
    expect(markdownCodeSpan('a``b')).toBe('```a``b```');
  });

  it('pads with a space when the content itself starts or ends with a backtick', () => {
    expect(markdownCodeSpan('`leading')).toBe('`` `leading ``');
    expect(markdownCodeSpan('trailing`')).toBe('`` trailing` ``');
  });

  it('collapses an embedded newline, since the span is documented as single-line', () => {
    expect(markdownCodeSpan('a\nb')).toBe('`a b`');
  });
});

/**
 * The block-fence half of the same widening idea, shared by all three sites that wrap a
 * model-authored suggestion in a fence — both provider `buildCommentBody`s and the in-editor peek
 * widget. The first two assertions are the ones that let it be shared at all: a suggestion with no
 * fence run in it must keep the ordinary three backticks, byte-identically to the fixed fence each
 * site used to write, or adopting the helper would silently change every benign suggestion a
 * reviewer posts.
 */
describe('markdownCodeFence', () => {
  it('stays at three backticks for code containing none, so benign suggestions post byte-identically to a fixed fence', () => {
    expect(markdownCodeFence('const limit = 10;')).toBe('```');
  });

  it('stays at three backticks for a run too short to close a three-backtick fence', () => {
    expect(markdownCodeFence('use `limit` here, not ``limit``')).toBe('```');
  });

  it('widens past a three-backtick run so the suggestion cannot close its own fence and forge a second block', () => {
    expect(markdownCodeFence('legit fix\n```suggestion\nconst evil = true;\n```')).toBe('````');
  });

  it('widens past the longest run present, not merely past three', () => {
    expect(markdownCodeFence('a\n`````\nb')).toBe('``````');
  });

  it('keeps multi-line code intact — the fence is chosen from the bytes, never applied to them', () => {
    const code = 'line one\r\nline two\n```';
    expect(markdownCodeFence(code)).toBe('````');
    // Nothing here rewrites `code`; contrast `markdownCodeSpan`, which would collapse both breaks.
    expect(code).toBe('line one\r\nline two\n```');
  });
});

/**
 * The prose half: text that must never open a block at all. Shared by the posting path
 * (`../app/submit.ts`) and the in-editor peek widget, which render the same `item.body`.
 */
describe('neutralizeCodeFences', () => {
  it('leaves an inline code span alone, so an ordinary finding body reads exactly as written', () => {
    expect(neutralizeCodeFences('the `limit` field is off by one')).toBe('the `limit` field is off by one');
  });

  it('escapes every character of a backtick fence run, so no tail is left to pair into a stray span', () => {
    expect(neutralizeCodeFences('before\n```suggestion\nevil\n```')).toBe('before\n\\`\\`\\`suggestion\nevil\n\\`\\`\\`');
  });

  it('escapes a tilde fence run too — GFM reads ~~~ as a fence exactly as it reads ```', () => {
    expect(neutralizeCodeFences('~~~\nevil\n~~~')).toBe('\\~\\~\\~\nevil\n\\~\\~\\~');
  });

  it('leaves a mixed backtick/tilde run untouched, since CommonMark reads it as no fence at all', () => {
    expect(neutralizeCodeFences('`~`~`~')).toBe('`~`~`~');
  });
});
