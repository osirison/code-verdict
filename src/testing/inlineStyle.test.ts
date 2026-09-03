import { describe, expect, it } from 'vitest';
import { INLINE_STYLE_ATTRIBUTE } from './inlineStyle';

/**
 * Eighteen assertions across five screens rest on this one regex, so its own
 * blind spots are theirs. It was double-quote-only until review pointed out
 * that a single-quoted attribute is just as valid HTML and just as silently
 * dropped by the CSP — a screen that reintroduced the bug in that form would
 * have passed every one of them.
 */
describe('the inline-style matcher', () => {
  it('catches a double-quoted attribute', () => {
    expect('<span class="bar" style="width:5%"></span>').toMatch(INLINE_STYLE_ATTRIBUTE);
  });

  it('catches a single-quoted attribute — the case the old matcher missed', () => {
    expect("<span class='bar' style='width:5%'></span>").toMatch(INLINE_STYLE_ATTRIBUTE);
  });

  it('catches whitespace around the equals, which HTML also allows', () => {
    expect('<span style = "width:5%"></span>').toMatch(INLINE_STYLE_ATTRIBUTE);
  });

  it('passes markup that styles itself through a class', () => {
    expect('<span class="bar w-5"></span>').not.toMatch(INLINE_STYLE_ATTRIBUTE);
  });

  it('does not fire on the word appearing outside a tag', () => {
    // A comment or prose mentioning style="…" is not an attribute, and every
    // renderer here carries comments that say exactly that.
    expect('the CSP drops style="width:5%" silently').not.toMatch(INLINE_STYLE_ATTRIBUTE);
  });
});
