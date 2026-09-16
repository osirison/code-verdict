/**
 * Neutralizing user/model-authored single-line text before it lands in a
 * structural markdown position — a finding's title as a heading (`### `) or
 * bold run (`**…**`), a withheld reason as a labeled line, a file path
 * already wrapped in a code span. None of that text is trusted: an agent's
 * title is free-form model output, and a title containing a fence
 * (` ``` `) followed by a real newline opens an unterminated code block that
 * swallows the rest of the document — hash marks, asterisks, and brackets
 * distort the rest of the line the same way a stray HTML tag would.
 *
 * Two techniques, not one, because the two positions need different fixes.
 * Plain prose (a heading, a bold run) is repaired by backslash-escaping —
 * CommonMark defines `\` before ASCII punctuation as "render this literal
 * character, don't parse it as syntax," so `\*` still reads as `*` to a
 * person while never toggling emphasis. That is chosen over stripping the
 * characters outright (which would silently change what the title says) or
 * wrapping the whole title in a code span (which would misrepresent prose
 * as code and still fight with the `### `/`**…**` wrapper it sits inside).
 * A code span is a different story: backslash escapes do nothing inside
 * one — the span's own backtick-run delimiter is what closes it, so a raw
 * backtick in the content (a Windows path segment, a shell alias) can
 * terminate the span early regardless of what precedes it. The fix there is
 * structural, not textual: pick a delimiter longer than the longest
 * backtick run the content contains, the same technique GitHub's own editor
 * uses when you copy code containing backticks into markdown.
 */

/** ASCII punctuation that changes markdown's parse when it appears mid-line. */
const MARKDOWN_METACHARACTERS = /[\\`*_[\]#>+~|<-]/g;

/**
 * Make a single line of prose safe to interpolate into a heading or a bold
 * run: collapse any embedded line breaks (the only way this text could ever
 * reach a line's start, where a heading/list/quote marker or a fence would
 * be read as structure) to a space, then backslash-escape every markdown
 * metacharacter so it prints literally instead of being parsed.
 */
export function escapeMarkdownText(text: string): string {
  const singleLine = text.replace(/\r\n|\r|\n/g, ' ');
  return singleLine.replace(MARKDOWN_METACHARACTERS, '\\$&');
}

/**
 * Wrap arbitrary single-line text (a file path, most often) in a markdown
 * code span that cannot be broken out of, however many backticks the text
 * itself contains: the delimiter is one backtick longer than the longest
 * backtick run found inside, so no substring of the content can ever match
 * it and close the span early. A leading/trailing backtick in the content
 * additionally gets a padding space either side, matching how a code span
 * abutting its own delimiter is written everywhere else.
 */
export function markdownCodeSpan(text: string): string {
  const singleLine = text.replace(/\r\n|\r|\n/g, ' ');
  const runs = singleLine.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  const fence = '`'.repeat(longestRun + 1);
  const padded = singleLine.startsWith('`') || singleLine.endsWith('`')
    ? ` ${singleLine} `
    : singleLine;
  return `${fence}${padded}${fence}`;
}
