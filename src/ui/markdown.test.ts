import { describe, expect, it } from 'vitest';
import { MARKDOWN_CSS, renderMarkdown } from './markdown';

describe('renderMarkdown — safety', () => {
  it('escapes markup before generating any of its own', () => {
    const html = renderMarkdown('<script>alert(1)</script> and <img src=x onerror=1>');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes quotes so nothing can break out of an attribute', () => {
    expect(renderMarkdown('a " quote')).toContain('&quot;');
    // The target holds spaces, so it is not a link at all — it stays escaped text.
    const attempt = renderMarkdown('[x](" onmouseover=alert(1) ")');
    expect(attempt).not.toContain('<a ');
    expect(attempt).toContain('&quot;');
  });

  it('refuses a javascript: or data: link target and keeps the source text', () => {
    const js = renderMarkdown('[click](javascript:alert(1))');
    expect(js).not.toContain('href');
    expect(js).toContain('[click]');
    expect(renderMarkdown('[x](data:text/html,<b>)')).not.toContain('href');
    expect(renderMarkdown('[x](vbscript:msgbox)')).not.toContain('href');
  });

  it('allows http, https, mailto, and in-page targets', () => {
    expect(renderMarkdown('[a](https://example.com/x)')).toContain('href="https://example.com/x"');
    expect(renderMarkdown('[a](http://example.com)')).toContain('href="http://example.com"');
    expect(renderMarkdown('[a](mailto:x@y.z)')).toContain('href="mailto:x@y.z"');
    expect(renderMarkdown('[a](#anchor)')).toContain('href="#anchor"');
  });

  it('escapes an ampersand in a link target exactly once', () => {
    const html = renderMarkdown('[a](https://example.com/?x=1&y=2)');
    expect(html).toContain('href="https://example.com/?x=1&amp;y=2"');
    expect(html).not.toContain('&amp;amp;');
  });

  it('emits no inline style attribute — the webview CSP would drop it', () => {
    const html = renderMarkdown('# H\n\n- a\n\n```js\nx\n```\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n');
    expect(html).not.toContain('style=');
  });

  it('strips control characters that would collide with its own markers', () => {
    const raw = ['a', String.fromCharCode(0), 'b', String.fromCharCode(1), 'c', String.fromCharCode(2), 'd'].join('');
    expect(renderMarkdown(raw)).toBe('<p class="md-p">abcd</p>');
  });

  it('returns an empty string for empty or blank input', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
    expect(renderMarkdown(undefined as unknown as string)).toBe('');
  });
});

describe('renderMarkdown — blocks', () => {
  it('splits paragraphs on a blank line and folds soft breaks into a space', () => {
    expect(renderMarkdown('one\ntwo\n\nthree')).toBe(
      '<p class="md-p">one two</p><p class="md-p">three</p>',
    );
  });

  it('honours a hard break', () => {
    expect(renderMarkdown('one  \ntwo')).toBe('<p class="md-p">one<br>two</p>');
    expect(renderMarkdown('one\\\ntwo')).toBe('<p class="md-p">one<br>two</p>');
  });

  it('renders headings with an accessible level', () => {
    const html = renderMarkdown('## Why this matters');
    expect(html).toBe(
      '<div class="md-h md-h2" role="heading" aria-level="2">Why this matters</div>',
    );
  });

  it('renders a tight bullet list without wrapping each item in a paragraph', () => {
    expect(renderMarkdown('- one\n- two')).toBe(
      '<ul class="md-ul"><li class="md-li">one</li><li class="md-li">two</li></ul>',
    );
  });

  it('renders an ordered list and carries a non-default start', () => {
    expect(renderMarkdown('1. one\n2. two')).toContain('<ol class="md-ol">');
    expect(renderMarkdown('3. three\n4. four')).toContain('<ol class="md-ol" start="3">');
  });

  it('nests a sublist inside its parent item', () => {
    const html = renderMarkdown('- outer\n  - inner\n- second');
    expect(html).toContain('<li class="md-li">outer<ul class="md-ul"><li class="md-li">inner</li></ul></li>');
    expect(html).toContain('<li class="md-li">second</li>');
  });

  it('keeps a multi-line item together and marks a blank-separated list loose', () => {
    expect(renderMarkdown('- one\n  still one\n- two')).toContain(
      '<li class="md-li">one still one</li>',
    );
    expect(renderMarkdown('- one\n\n- two')).toContain('<li class="md-li"><p class="md-p">one</p></li>');
  });

  it('ends a list at the next paragraph', () => {
    const html = renderMarkdown('- one\n- two\n\nAfter the list.');
    expect(html).toBe(
      '<ul class="md-ul"><li class="md-li">one</li><li class="md-li">two</li></ul>' +
        '<p class="md-p">After the list.</p>',
    );
  });

  it('renders a fenced block verbatim, with its language recorded', () => {
    const html = renderMarkdown('```ts\nconst a = b * c; // _not_ emphasis\n```');
    expect(html).toBe(
      '<pre class="md-pre" data-lang="ts"><code>const a = b * c; // _not_ emphasis</code></pre>',
    );
  });

  it('does not transform markdown inside a fence', () => {
    const html = renderMarkdown('```\n**bold** and <b>tags</b>\n```');
    expect(html).toContain('**bold**');
    expect(html).toContain('&lt;b&gt;');
    expect(html).not.toContain('<strong');
  });

  it('closes an unterminated fence at the end of the text', () => {
    expect(renderMarkdown('```\nx')).toBe('<pre class="md-pre"><code>x</code></pre>');
  });

  it('supports tilde fences and a fence containing backticks', () => {
    expect(renderMarkdown('~~~\n```\n~~~')).toBe('<pre class="md-pre"><code>```</code></pre>');
  });

  it('renders a blockquote and a horizontal rule', () => {
    expect(renderMarkdown('> quoted')).toBe(
      '<blockquote class="md-quote"><p class="md-p">quoted</p></blockquote>',
    );
    expect(renderMarkdown('a\n\n---\n\nb')).toContain('<hr class="md-hr">');
  });

  it('renders a pipe table with column alignment', () => {
    const html = renderMarkdown('| Case | Result |\n| :--- | -----: |\n| null | throws |');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain('<th class="md-th">Case</th>');
    expect(html).toContain('<th class="md-th md-al-right">Result</th>');
    expect(html).toContain('<td class="md-td md-al-right">throws</td>');
  });

  it('leaves a line that only looks like a table as a paragraph', () => {
    expect(renderMarkdown('a | b')).toBe('<p class="md-p">a | b</p>');
  });
});

describe('renderMarkdown — inline', () => {
  it('renders bold, italic, bold-italic and strikethrough', () => {
    expect(renderMarkdown('**b**')).toContain('<strong class="md-strong">b</strong>');
    expect(renderMarkdown('*i*')).toContain('<em class="md-em">i</em>');
    expect(renderMarkdown('_i_')).toContain('<em class="md-em">i</em>');
    expect(renderMarkdown('***bi***')).toContain('<strong class="md-strong"><em class="md-em">bi</em></strong>');
    expect(renderMarkdown('~~gone~~')).toContain('<del class="md-del">gone</del>');
  });

  it('leaves underscores inside an identifier alone', () => {
    expect(renderMarkdown('call refresh_token_value here')).toBe(
      '<p class="md-p">call refresh_token_value here</p>',
    );
  });

  it('leaves a bare asterisk in prose alone', () => {
    expect(renderMarkdown('a * b * c is 2 * 3')).not.toContain('<em');
  });

  it('renders a code span and protects its contents', () => {
    expect(renderMarkdown('use `snake_case` here')).toContain(
      '<code class="md-code">snake_case</code>',
    );
    expect(renderMarkdown('`a * b`')).toBe('<p class="md-p"><code class="md-code">a * b</code></p>');
    expect(renderMarkdown('`<div>`')).toContain('<code class="md-code">&lt;div&gt;</code>');
  });

  it('honours a backslash escape', () => {
    expect(renderMarkdown('2 \\* 3 \\*\\* 4')).toBe('<p class="md-p">2 * 3 ** 4</p>');
  });

  it('renders an angle autolink and drops an image to its alt text', () => {
    expect(renderMarkdown('<https://example.com>')).toContain(
      '<a class="md-link" href="https://example.com">https://example.com</a>',
    );
    expect(renderMarkdown('![a diagram](https://example.com/x.png)')).toBe(
      '<p class="md-p">a diagram</p>',
    );
  });
});

describe('renderMarkdown — an agent finding end to end', () => {
  const body = [
    '`applyPatch` writes the file before validating the hunk header, so a malformed',
    'patch truncates the target.',
    '',
    '**Why it matters**',
    '',
    '1. The write is not atomic — a partial patch leaves the file short.',
    '2. There is no backup, so the loss is unrecoverable.',
    '',
    'Validate first:',
    '',
    '```ts',
    'if (!isValidHunk(hunk)) throw new PatchError(hunk.header);',
    '```',
  ].join('\n');

  it('produces block structure rather than one run-on line', () => {
    const html = renderMarkdown(body);
    expect(html).toContain('<code class="md-code">applyPatch</code>');
    expect(html).toContain('patch truncates the target.</p>');
    expect(html).toContain('<strong class="md-strong">Why it matters</strong>');
    expect(html).toContain('<ol class="md-ol">');
    expect(html).toContain('<li class="md-li">There is no backup, so the loss is unrecoverable.</li>');
    expect(html).toContain('<pre class="md-pre" data-lang="ts">');
    expect(html).not.toContain('**');
  });
});

describe('MARKDOWN_CSS', () => {
  it('scopes every rule under .md and uses theme tokens, not literal colours', () => {
    const selectors = MARKDOWN_CSS.split('\n')
      .map((line) => line.split('{')[0]?.trim() ?? '')
      .filter((line) => line !== '');
    for (const selector of selectors) {
      expect(selector.startsWith('.md')).toBe(true);
    }
    expect(MARKDOWN_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
