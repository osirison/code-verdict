/**
 * Markdown → HTML for the prose an agent writes about a finding.
 *
 * The agent's `body`, and every answer it gives in a finding's thread, is
 * model output written as Markdown. Escaping it into a single `<p>` printed
 * the asterisks, ran the bullet list into one line and dropped the code
 * fences, so a well-structured answer arrived as a wall of punctuation. This
 * renders the subset an agent actually writes — paragraphs, headings, lists,
 * fenced and inline code, blockquotes, tables, links, emphasis — and nothing
 * else.
 *
 * Two constraints shape the implementation:
 *
 *  - **Escape first, transform second.** The input is model output and can
 *    contain anything, including deliberate HTML. Every character is escaped
 *    before a single tag is generated, so no path exists from input text to
 *    live markup. Link targets are the one place an input-derived value
 *    reaches an attribute, and those are restricted to http/https/mailto.
 *  - **Classes only, never `style=`.** The webview CSP admits nonce'd
 *    `<style>` elements only; an inline style attribute is dropped without a
 *    console error, so anything positional has to come from `MARKDOWN_CSS`.
 */
import { escapeHtml } from './theme';

/** Marks a hard line break (two trailing spaces, or a trailing backslash). */
const HARD_BREAK = '\u0000';
/** Wraps the index of a stashed code span or backslash-escaped character. */
const STASH_OPEN = '\u0001';
const STASH_CLOSE = '\u0002';

const FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])(\s+)(.*)$/;
const NUMBER = /^(\s*)(\d{1,9})([.)])(\s+)(.*)$/;
const TABLE_DIVIDER = /^\s*\|?(\s*:?-+:?\s*\|)+(\s*:?-+:?\s*)?\|?\s*$/;

interface ListItem {
  /** The item's own lines, already dedented to its content column. */
  lines: string[];
}

interface Marker {
  indent: number;
  ordered: boolean;
  /** Column the item's content starts at — the dedent for continuation lines. */
  contentIndent: number;
  start: number;
  text: string;
}

function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4 - (width % 4);
    else break;
  }
  return width;
}

function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** Indexing with `noUncheckedIndexedAccess` on — an out-of-range line reads blank. */
function at(list: string[], index: number): string {
  return list[index] ?? '';
}

/** Removes up to `width` columns of leading whitespace, tabs counted as 4. */
function dedent(line: string, width: number): string {
  let taken = 0;
  let index = 0;
  while (index < line.length && taken < width) {
    const ch = line[index];
    if (ch === ' ') taken += 1;
    else if (ch === '\t') taken += 4 - (taken % 4);
    else break;
    index += 1;
  }
  return line.slice(index);
}

function markerAt(line: string): Marker | null {
  const bullet = BULLET.exec(line);
  if (bullet) {
    const indent = indentWidth(line);
    const [, , glyph = '', gap = '', text = ''] = bullet;
    return {
      indent,
      ordered: false,
      contentIndent: indent + glyph.length + gap.length,
      start: 1,
      text,
    };
  }
  const numbered = NUMBER.exec(line);
  if (numbered) {
    const indent = indentWidth(line);
    const [, , digits = '', delimiter = '', gap = '', text = ''] = numbered;
    return {
      indent,
      ordered: true,
      contentIndent: indent + digits.length + delimiter.length + gap.length,
      start: Number(digits),
      text,
    };
  }
  return null;
}

interface Fence {
  indent: number;
  marker: string;
  width: number;
  info: string;
}

/**
 * The opening line of a fenced block, or null.
 *
 * The info string is matched with a single `(.*)$` rather than two competing
 * character classes: the earlier `([^`\s]*)[^`]*$` pair overlapped, so a line
 * that opened a fence and held a later backtick could never reach `$` and the
 * engine retried every split point — quadratic, on a synchronous render of
 * untrusted model output.
 */
function fenceAt(line: string): Fence | null {
  const match = FENCE.exec(line);
  if (!match) return null;
  const [, indent = '', ticks = '', rest = ''] = match;
  const marker = ticks[0] ?? '`';
  // A backtick fence may not carry a backtick in its info string.
  if (marker === '`' && rest.includes('`')) return null;
  return { indent: indent.length, marker, width: ticks.length, info: rest.trim().split(/\s+/)[0] ?? '' };
}

/** A header row followed by a delimiter row — the only shape that opens a table. */
function tableStartsAt(lines: string[], index: number): boolean {
  const header = at(lines, index);
  const divider = at(lines, index + 1);
  if (!header.includes('|') || !divider.includes('|')) return false;
  if (!TABLE_DIVIDER.test(divider)) return false;
  return splitCells(divider).length === splitCells(header).length && splitCells(header).length >= 2;
}

/** A line that ends an open paragraph by starting a block of its own. */
function startsBlock(line: string): boolean {
  return (
    fenceAt(line) !== null ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    markerAt(line) !== null
  );
}

function splitCells(row: string): string[] {
  let text = row.trim();
  if (text.startsWith('|')) text = text.slice(1);
  if (text.endsWith('|') && !text.endsWith('\\|')) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (ch === '\\' && text[i + 1] === '|') {
      current += '|';
      i += 1;
    } else if (ch === '|') {
      cells.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  cells.push(current.trim());
  return cells;
}

function alignClass(spec: string): string {
  const cell = spec.trim();
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return ' md-al-center';
  if (right) return ' md-al-right';
  return '';
}

// ---- inline ------------------------------------------------------------------------

/**
 * Only these schemes reach an `href`. A `javascript:` or `data:` target in
 * model output falls through and is rendered as the link's own text.
 *
 * The URL arrives already HTML-escaped — it came out of `escapeHtml` with the
 * rest of the paragraph — so it is attribute-safe as it stands and must not be
 * escaped twice, or an `&amp;` in a query string becomes `&amp;amp;`.
 */
function safeHref(escapedUrl: string): string | null {
  const url = escapedUrl.trim();
  if (url === '') return null;
  // A stash placeholder or a hard-break marker inside the target would be
  // expanded after the attribute was already built. Nothing legitimate needs
  // one, so refuse the link rather than write a marker into an href.
  if (url.includes(STASH_OPEN) || url.includes(HARD_BREAK)) return null;
  // Anchor and path-relative targets have no scheme to abuse. `//host` and
  // `/\host` are neither: both resolve to a remote authority, so they are not
  // admitted by this branch.
  if (/^(#|\/(?![/\\])|\.{1,2}\/)/.test(url)) return url;
  if (/^(https?:\/\/|mailto:)/i.test(url)) return url;
  return null;
}

/**
 * Inline transforms run over already-escaped text, in an order chosen so that
 * no pass ever sees markup an earlier pass generated:
 *
 *   1. an escaped backtick, so it cannot open or close a code span;
 *   2. code spans, whose contents are verbatim — no escape, link or emphasis
 *      pass touches what an agent wrote between backticks;
 *   3. the remaining backslash escapes, so `\*` is a literal asterisk;
 *   4. links, whose `<a>` tags are stashed while the label stays visible to
 *      the emphasis passes — an autolink is stashed whole, because its label
 *      is the URL and a `*` in a URL is not emphasis;
 *   5. emphasis, over what is left, which is only ever escaped source text.
 *
 * Everything generated goes into the stash and comes back at the end, so a
 * `*` or a quote inside a URL can never reach a tag or an attribute that a
 * later regex would rewrite.
 */
function renderInline(escaped: string): string {
  const stash: string[] = [];
  const keep = (html: string): string => {
    stash.push(html);
    return `${STASH_OPEN}${stash.length - 1}${STASH_CLOSE}`;
  };

  let text = escaped;
  text = text.replace(/\\`/g, () => keep('`'));
  // Longest run of backticks first, so ``a ` b`` survives. A hard-break marker
  // inside a code span is a line ending, which a code span renders as a space.
  text = text.replace(/(`+)([\s\S]+?)\1/g, (_all, _ticks: string, code: string) =>
    keep(`<code class="md-code">${code.split(HARD_BREAK).join(' ').replace(/^ (.*) $/, '$1')}</code>`),
  );
  text = text.replace(/\\([\\*_{}[\]()#+\-.!>|~])/g, (_all, ch: string) => keep(escapeHtml(ch)));
  // Images degrade to their alt text — the webview has nothing remote to fetch.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(
    /\[([^\]]+)\]\(([^()\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    (all, label: string, url: string) => {
      const href = safeHref(url);
      return href ? `${keep(`<a class="md-link" href="${href}">`)}${label}${keep('</a>')}` : all;
    },
  );
  // Angle autolinks arrive escaped, so match the entity form.
  text = text.replace(/&lt;((?:https?:\/\/|mailto:)\S+?)&gt;/g, (all, url: string) => {
    const href = safeHref(url);
    return href ? keep(`<a class="md-link" href="${href}">${url}</a>`) : all;
  });
  text = text.replace(
    /\*\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*\*/g,
    '<strong class="md-strong"><em class="md-em">$1</em></strong>',
  );
  text = text.replace(/\*\*(?!\s)([\s\S]+?)(?<!\s)\*\*/g, '<strong class="md-strong">$1</strong>');
  // A single delimiter is deliberately line-scoped: a lone `*` in prose about
  // code is far more common than emphasis wrapped across a soft break.
  text = text.replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '<em class="md-em">$1</em>');
  text = text.replace(/(?<![\w_])__(?!\s)([\s\S]+?)(?<!\s)__(?!\w)/g, '<strong class="md-strong">$1</strong>');
  // Underscores only bind at word edges, so `snake_case_name` stays intact.
  text = text.replace(/(?<![\w_])_(?!\s)([^_\n]+?)(?<!\s)_(?!\w)/g, '<em class="md-em">$1</em>');
  text = text.replace(/~~(?!\s)([\s\S]+?)(?<!\s)~~/g, '<del class="md-del">$1</del>');

  // Restoring is a fixed point, not one pass: a stashed code span can hold the
  // placeholder of an escaped backtick, and String.replace never rescans what
  // it inserted. Each stashed string can only name an earlier index, so this
  // terminates; the bound is a guard, not a limit.
  const placeholder = new RegExp(`${STASH_OPEN}(\\d+)${STASH_CLOSE}`, 'g');
  for (let pass = 0; pass < 8 && text.includes(STASH_OPEN); pass += 1) {
    text = text.replace(placeholder, (_all, index: string) => stash[Number(index)] ?? '');
  }
  // Hard breaks were marked before escaping and swallow the newline they sit
  // on; soft breaks fold into a space, the way a paragraph reads on a page.
  return text.replace(new RegExp(`${HARD_BREAK}\\n?`, 'g'), '<br>').split('\n').join(' ');
}

/** Escapes a run of source lines and renders them as one paragraph's inline content. */
function inlineFromLines(lines: string[]): string {
  const marked = lines.map((line) => {
    const hard = /(\s\s+|\\)$/.test(line);
    return escapeHtml(line.replace(/(\s\s+|\\)$/, '')) + (hard ? HARD_BREAK : '');
  });
  return renderInline(marked.join('\n'));
}

// ---- blocks ------------------------------------------------------------------------

function renderList(lines: string[], start: number): { html: string; next: number } {
  const first = markerAt(at(lines, start)) as Marker;
  const items: ListItem[] = [];
  let loose = false;
  let index = start;
  let pendingBlank = false;

  while (index < lines.length) {
    const line = at(lines, index);
    if (isBlank(line)) {
      pendingBlank = true;
      index += 1;
      continue;
    }
    const marker = markerAt(line);
    // A marker indented as far as the open item's content column belongs to
    // that item — it opens a sublist rather than a sibling.
    const sameLevel = marker !== null && marker.indent < first.contentIndent;
    if (sameLevel && marker.ordered !== first.ordered) break;
    if (sameLevel) {
      if (pendingBlank && items.length > 0) loose = true;
      items.push({ lines: [marker.text] });
      pendingBlank = false;
      index += 1;
      continue;
    }
    const current = items[items.length - 1];
    if (!current) break;
    // A continuation line belongs to the open item when it is indented to the
    // item's content column, or — lazily — when it simply follows the item's
    // own text. An unindented line that opens a block of its own ends the
    // list instead: absorbing it put the fence inside the last <li> and, if
    // that fence held a blank line, tore the rest of the document apart.
    const indented = indentWidth(line) >= first.contentIndent;
    if (!indented && (pendingBlank || startsBlock(line) || tableStartsAt(lines, index))) break;
    if (pendingBlank) {
      loose = true;
      current.lines.push('');
    }
    current.lines.push(dedent(line, first.contentIndent));
    pendingBlank = false;
    index += 1;
  }

  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const rendered = items
    .map((item) => {
      const html = renderBlocks(item.lines);
      return `<li class="md-li">${loose ? html : unwrapParagraph(html)}</li>`;
    })
    .join('');
  return { html: `<${tag} class="md-${tag}"${startAttr}>${rendered}</${tag}>`, next: index };
}

/** A tight list item shows its text directly rather than inside a `<p>`. */
function unwrapParagraph(html: string): string {
  const open = '<p class="md-p">';
  const close = '</p>';
  if (!html.startsWith(open)) return html;
  const end = html.indexOf(close);
  if (end === -1) return html;
  return html.slice(open.length, end) + html.slice(end + close.length);
}

function renderTable(lines: string[], start: number): { html: string; next: number } | null {
  if (!tableStartsAt(lines, start)) return null;
  const header = splitCells(at(lines, start));
  const aligns = splitCells(at(lines, start + 1));
  const rows: string[][] = [];
  let index = start + 2;
  while (index < lines.length && !isBlank(at(lines, index)) && at(lines, index).includes('|')) {
    rows.push(splitCells(at(lines, index)));
    index += 1;
  }
  const head = header
    .map((cell, i) => `<th class="md-th${alignClass(aligns[i] ?? '')}">${inlineFromLines([cell])}</th>`)
    .join('');
  const body = rows
    .map((row) => {
      const cells = header
        .map(
          (_h, i) => `<td class="md-td${alignClass(aligns[i] ?? '')}">${inlineFromLines([row[i] ?? ''])}</td>`,
        )
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');
  return {
    html: `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`,
    next: index,
  };
}

function renderBlocks(lines: string[]): string {
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = at(lines, index);
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = fenceAt(line);
    if (fence) {
      const closer = new RegExp(`^\\${fence.marker}{${fence.width},}\\s*$`);
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        if (closer.test(at(lines, index).trim())) {
          index += 1;
          break;
        }
        body.push(dedent(at(lines, index), fence.indent));
        index += 1;
      }
      const lang = fence.info ? ` data-lang="${escapeHtml(fence.info)}"` : '';
      out.push(`<pre class="md-pre"${lang}><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = (heading[1] ?? '').length;
      out.push(
        `<div class="md-h md-h${level}" role="heading" aria-level="${level}">${inlineFromLines([heading[2] ?? ''])}</div>`,
      );
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push('<hr class="md-hr">');
      index += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [];
      while (index < lines.length) {
        const inner = QUOTE.exec(at(lines, index));
        if (inner) {
          body.push(inner[1] ?? '');
          index += 1;
          continue;
        }
        // Lazy continuation: an unmarked line still belongs to the quote while
        // the quoted paragraph is open.
        if (
          !isBlank(at(lines, index)) &&
          !startsBlock(at(lines, index)) &&
          body.length > 0 &&
          !isBlank(at(body, body.length - 1))
        ) {
          body.push(at(lines, index));
          index += 1;
          continue;
        }
        break;
      }
      out.push(`<blockquote class="md-quote">${renderBlocks(body)}</blockquote>`);
      continue;
    }

    if (markerAt(line)) {
      const list = renderList(lines, index);
      out.push(list.html);
      index = list.next;
      continue;
    }

    if (tableStartsAt(lines, index)) {
      const table = renderTable(lines, index);
      if (table) {
        out.push(table.html);
        index = table.next;
        continue;
      }
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      !isBlank(at(lines, index)) &&
      !(paragraph.length > 0 && (startsBlock(at(lines, index)) || tableStartsAt(lines, index)))
    ) {
      paragraph.push(at(lines, index));
      index += 1;
    }
    out.push(`<p class="md-p">${inlineFromLines(paragraph)}</p>`);
  }

  return out.join('');
}

/**
 * Renders agent prose to HTML. The result is safe to assign as innerHTML:
 * every character of `text` is escaped before any markup is generated.
 */
export function renderMarkdown(text: string): string {
  if (typeof text !== 'string' || text.trim() === '') return '';
  const normalised = text
    .replace(/\r\n?/g, '\n')
    // Control characters would collide with the stash and hard-break markers.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '');
  return renderBlocks(normalised.split('\n'));
}

/**
 * Styling for `renderMarkdown` output, scoped to a `.md` ancestor so a caller
 * opts in by adding the class beside its own (`class="prose md"`).
 */
export const MARKDOWN_CSS = `
.md > :first-child { margin-top: 0; }
.md > :last-child { margin-bottom: 0; }
.md-p { margin: 0 0 9px; }
.md-h { color: var(--fg-hi); font-weight: 600; line-height: 1.35; margin: 14px 0 6px; }
.md-h1 { font-size: 1.16em; }
.md-h2 { font-size: 1.1em; }
.md-h3 { font-size: 1.04em; }
.md-h4, .md-h5, .md-h6 { font-size: 1em; color: var(--fg2); }
.md-ul, .md-ol { margin: 0 0 9px; padding-left: 20px; }
.md-ul { list-style: disc; }
.md-ol { list-style: decimal; }
.md-li { margin: 3px 0; padding-left: 2px; }
.md-li::marker { color: var(--fg-dim); }
.md-li > .md-ul, .md-li > .md-ol { margin: 3px 0 0; }
.md-li > .md-p { margin: 0 0 6px; }
.md-code { font-family: var(--font-mono); font-size: .92em; background: var(--code); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; white-space: break-spaces; }
.md-pre { margin: 0 0 9px; padding: 9px 12px; background: var(--code); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; }
.md-pre code { display: block; font-family: var(--font-mono); font-size: .92em; line-height: 1.65; white-space: pre; color: var(--fg); background: none; border: none; padding: 0; }
.md-quote { margin: 0 0 9px; padding: 1px 0 1px 11px; border-left: 2px solid var(--line2); color: var(--fg-dim); }
.md-hr { margin: 14px 0; border: none; border-top: 1px solid var(--line); }
.md-link { color: var(--link); text-decoration: none; }
.md-link:hover { text-decoration: underline; }
.md-strong { font-weight: 600; color: var(--fg-hi); }
.md-em { font-style: italic; }
.md-del { text-decoration: line-through; color: var(--fg-dim); }
.md-table-wrap { margin: 0 0 9px; overflow-x: auto; }
.md-table { border-collapse: collapse; font-size: .95em; }
.md-th, .md-td { border: 1px solid var(--line); padding: 5px 10px; text-align: left; vertical-align: top; }
.md-th { background: var(--bg2); color: var(--fg-hi); font-weight: 600; }
.md-al-center { text-align: center; }
.md-al-right { text-align: right; }
`;
