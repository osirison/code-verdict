import { describe, expect, it } from 'vitest';
import { escapeMarkdownText, markdownCodeSpan } from './markdownSafety';

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
