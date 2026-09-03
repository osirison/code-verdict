/**
 * The matcher behind every "this screen emits no inline style" assertion.
 *
 * The webview CSP is `style-src 'nonce-…'`, which admits a nonce-bearing
 * `<style>` element and nothing else. An inline `style` attribute needs
 * `'unsafe-inline'`, so the browser drops it — silently, with nothing logged
 * and nothing thrown. That is what made issue #45 survive as long as it did:
 * the progress bars were sized by an attribute that never applied, so they
 * showed no progress and no error either.
 *
 * Quote-agnostic on purpose. HTML accepts single quotes for attribute values,
 * and the CSP drops `style='…'` exactly as it drops `style="…"` — a matcher
 * that only knew about double quotes would pass a screen that had reintroduced
 * the bug, which is the one thing this assertion exists to prevent.
 */
export const INLINE_STYLE_ATTRIBUTE = /<[^>]+\sstyle\s*=\s*["']/;
