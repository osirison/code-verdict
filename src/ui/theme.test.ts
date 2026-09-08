import { describe, expect, it } from 'vitest';
import { renderPage } from './theme';

const page = (embedded?: boolean, isMac = false): string =>
  renderPage({ title: 'Verdict: Test', nonce: 'nonce123', css: '', body: '<p>body</p>', embedded, isMac });

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

  it('renders the groups and their headline shortcuts', () => {
    const html = page();
    for (const group of ['Triage', 'Agent', 'Everywhere']) {
      expect(html).toContain(`<div class="section-label">${group}</div>`);
    }
    // One representative per group, plus the spec's A-key note.
    expect(html).toContain('applies the suggested fix when there is one');
    expect(html).toContain('⌃⇧⌥A');
    expect(html).toContain('⌃⇧⌥M');
    expect(html).toContain('⌃↩');
    expect(html).toContain('⌃⇧P');
    // The ask chord is bound at both layers and does two different things
    // (design D6). The overlay names both, or the editor-level one is invisible.
    expect(html).toContain('sends what you typed, from the ask box');
    expect(html).toContain('the selected finding, from elsewhere on triage');
    // The note now says where the triage keys apply, not merely that the tab
    // must be focused — the screen is half of what arms them.
    expect(html).toContain('triage keys apply on the triage screen');
  });

  it('writes the chords in the notation of the reviewer\'s platform', () => {
    // Both notations are in the markup — the other one sits in `data-alt` so
    // the client can swap under Remote — so these assert what is *shown*.
    const shown = (html: string, cap: string): boolean => html.includes(`>${cap}</span>`);

    const mac = page(false, true);
    expect(shown(mac, '⌘⇧⌥A')).toBe(true);
    expect(shown(mac, '⌘⇧⌥1–4')).toBe(true);
    expect(shown(mac, '⌘↩')).toBe(true);
    expect(shown(mac, '⌘⇧P')).toBe(true);
    expect(shown(mac, '⌃⇧⌥A')).toBe(false);
    expect(mac).toContain('data-alt="⌃⇧⌥A"');

    const other = page(false, false);
    expect(shown(other, '⌃⇧⌥A')).toBe(true);
    expect(shown(other, '⌃⇧⌥1–4')).toBe(true);
    expect(shown(other, '⌘⇧⌥A')).toBe(false);
    expect(other).toContain('data-alt="⌘⇧⌥A"');
  });

  it('lets the client correct the notation, because the host may be a remote machine', () => {
    // Under SSH / Containers / WSL / Codespaces the extension host's platform
    // is the remote's, while VS Code resolves the `mac` keybinding variant
    // against the client. The overlay stamps the host's guess and the webview
    // script — which runs on the client — swaps every `data-alt` when the two disagree.
    const html = page(false, false);
    expect(html).toContain('data-mac="false"');
    expect(html).toContain('navigator.userAgentData');
    expect(html).toContain("overlay.dataset.mac === 'true'");
    expect(html).toContain('[data-alt]');
    // The deprecated field stays out of it.
    expect(html).not.toContain('navigator.platform');
  });

  it('advertises no shortcut that does nothing', () => {
    // These were in the overlay for a long time with no key handler anywhere:
    // the presets, the mode switch, the open-in-editor button and the G-chords
    // are all click-only, and ⌘↵ generate summary was never bound at all.
    const html = page();
    for (const phantom of ['G then D', 'G then P', 'Show fix', 'Find similar', 'Open in editor', '⌘1 ⌘2 ⌘3', 'Generate summary']) {
      expect(html).not.toContain(phantom);
    }
    // Explain is listed, but on the chord that reaches it — `codeVerdict.askAgent`
    // — never on the bare `E` that nothing has ever handled.
    for (const cap of ['E', '⇧F', 'F', 'O']) {
      expect(html).not.toContain(`<span class="keys-cap">${cap}</span>`);
    }
  });

  it('still opens on the plain ? key, which is what keeps help cheap', () => {
    // The bare `?` handler lives in the webview, where it can see the focused
    // element; only the editor-level shift+/ binding was capable of firing
    // from outside the document, and that is the one the chord replaced.
    const html = page();
    expect(html).toContain("ev.key !== '?'");
    expect(html).toContain('⌃⇧⌥/');
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
