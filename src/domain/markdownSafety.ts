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
 * Three techniques, not one, because the positions need different fixes.
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
 * uses when you copy code containing backticks into markdown. A multi-line
 * fenced block takes that same structural fix (`markdownCodeFence`) rather
 * than the textual one, and for the same reason plus one more: its content is
 * code that has to reach the reader byte-for-byte, so nothing may be escaped,
 * collapsed or padded on the way. The third technique is for prose that must
 * stay prose and must not open a block at all (`neutralizeCodeFences`).
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

/**
 * The delimiter for a fenced block whose own content must not be able to close it early: a run of
 * backticks one longer than the longest backtick run already inside `text`, never shorter than the
 * ordinary three, so the common case (content with no fence run in it) renders byte-identically to
 * a hand-written ``` fence and only genuinely dangerous content pays a wider delimiter.
 *
 * Deliberately not `markdownCodeSpan` above, whose widening idea this is: that helper collapses
 * embedded newlines and pads its delimiter, both wrong for a block that delimits multi-line code a
 * reader is expected to apply verbatim. Deliberately not `escapeMarkdownText` either — escaping the
 * content would change the very bytes the block exists to carry.
 *
 * What the fixed ``` fence it replaces costs: the text being fenced is model-authored replacement
 * code, validated only for length (`../app/harnessCandidateValidation.ts`) and never for content,
 * so a ``` run inside it — a legitimate example fence in a markdown fix, or one forced by prompt
 * injection from attacker-controlled change content — closes the real fence early and everything
 * after it reads as a new top-level block. A forge renders a suggestion block with its own
 * clickable apply control, so a forged second block puts attacker-chosen code the review pipeline
 * never validated one click from the branch.
 *
 * `evidenceFence` (`../app/harnessSynthesisVerification.ts`) stays its own local helper rather than
 * calling this one: it fences an untrusted excerpt with runs of `"` inside a prompt, not with
 * backticks inside markdown, so it shares only the arithmetic, not the delimiter or the position.
 */
export function markdownCodeFence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longestRun = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return '`'.repeat(Math.max(3, longestRun + 1));
}

/**
 * Neutralizes model-authored prose against forging its own markdown code fence, without touching
 * anything else about it: a finding's body is posted and previewed close to verbatim (inline `code`
 * spans, bold, links all meant to survive), so the blunt fix — `escapeMarkdownText`, which
 * backslash-escapes every single backtick and would flatten every legitimate inline code
 * reference — is too broad. Only a run of three or more fence characters is dangerous: backtick
 * runs (```) and tilde runs (~~~) are the two sequences CommonMark/GFM read as a fence delimiter
 * (block-level fences and long-delimiter inline code spans alike — a mixed run of both characters
 * is neither and stays untouched), so a bare ```suggestion...``` (or plain ``` or ~~~) sequence
 * sitting in a finding's own free text becomes a second, independently applyable "Commit
 * suggestion" the instant the comment posts — reachable through nothing more than an ordinary
 * accept-and-submit, no `suggestion` field or `applyFix` toggle involved. Backslash-escaping every
 * character of the run (mirroring `escapeMarkdownText`'s own per-character technique, above) keeps
 * every fence-character byte the reader sees — nothing is stripped or rewritten — while CommonMark
 * fence recognition requires the line's fence characters to be literal and unescaped, and a code
 * span's delimiter run must be unescaped backticks too: escaping every character in the run, not
 * just its first, also stops the remaining (n-1)-length tail from pairing into a stray inline span
 * elsewhere in the same body.
 *
 * The companion of `markdownCodeFence`, not a substitute for it: this one is for text that must
 * never open a block, that one for text that must stay inside the block it is given.
 */
export function neutralizeCodeFences(text: string): string {
  return text.replace(/`{3,}|~{3,}/g, (run) => run.replace(/[`~]/g, '\\$&'));
}
