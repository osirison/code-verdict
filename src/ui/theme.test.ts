import { describe, expect, it } from 'vitest';
import { renderPage } from './theme';

const page = (embedded?: boolean): string =>
  renderPage({ title: 'Verdict: Test', nonce: 'nonce123', css: '', body: '<p>body</p>', embedded });

describe('keyboard overlay (spec §12)', () => {
  it('ships the overlay hidden on every full-page screen', () => {
    const html = page();
    expect(html).toContain('id="verdict-keys"');
    expect(html).toContain('hidden');
    expect(html).toContain('role="dialog"');
    // A modal dialog for assistive tech, with a focusable panel.
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it('renders the four groups and their headline shortcuts', () => {
    const html = page();
    for (const group of ['Triage', 'Agent', 'Navigation', 'Everywhere']) {
      expect(html).toContain(`<div class="section-label">${group}</div>`);
    }
    // One representative per group, plus the spec's A-key note.
    expect(html).toContain('applies the suggested fix when there is one');
    expect(html).toContain('⇧A');
    expect(html).toContain('⌘↩');
    expect(html).toContain('G then D');
    expect(html).toContain('⌘⇧P');
    expect(html).toContain('shortcuts apply when the review tab has focus');
  });

  it('opens on ? and the status bar message, closes on Esc and the scrim', () => {
    const html = page();
    expect(html).toContain("ev.key !== '?'");
    expect(html).toContain("ev.key === 'Escape'");
    expect(html).toContain("ev.data.type === 'verdict:showKeys'");
    expect(html).toContain('ev.target === overlay');
    // Typing a ? into an input must never open it.
    expect(html).toContain("t.closest('input, textarea, select, [contenteditable]')");
  });

  it('swallows every key while open — triage verdicts must not fire behind the scrim', () => {
    const html = page();
    const handler = html.slice(html.indexOf('!overlay.hidden) {'));
    // The open-overlay branch stops propagation before any screen keydown
    // map (capture phase), for every key, not just Esc and ?.
    expect(handler).toContain('ev.preventDefault();');
    expect(handler).toContain('ev.stopPropagation();');
    expect(html).toContain('}, true);');
  });

  it('keeps the overlay out of the embedded sidebar', () => {
    const html = page(true);
    expect(html).not.toContain('verdict-keys');
    expect(html).not.toContain('keys-overlay');
  });

  it('keeps the overlay script inside the CSP nonce', () => {
    const html = page();
    // The overlay must not introduce a second, un-nonced script tag.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="nonce123">');
  });
});

describe('an embedded page that opts into regions can actually arm', () => {
  it('acquires the vscode API even with no script of its own', () => {
    // REGIONS_SCRIPT's first statement posts `verdictReady` through
    // window.verdictVscode. Emitting it without acquiring the API throws on
    // load, so the page never arms — and because "not ready" falls back to a
    // full assignment by design, the screen would quietly rebuild itself on
    // every change with nothing reporting why. The sidebar only escapes this
    // today because it happens to pass a script too.
    const html = renderPage({ title: 'T', nonce: 'n', css: '', body: '<p>x</p>', embedded: true, regions: true });

    expect(html).toContain('acquireVsCodeApi()');
    expect(html.indexOf('acquireVsCodeApi()')).toBeLessThan(html.indexOf('verdictReady'));
  });

  it('still emits no bootstrap for an embedded page that wants neither', () => {
    const html = renderPage({ title: 'T', nonce: 'n', css: '', body: '<p>x</p>', embedded: true });

    expect(html).not.toContain('acquireVsCodeApi()');
    expect(html).not.toContain('verdictReady');
  });
});
