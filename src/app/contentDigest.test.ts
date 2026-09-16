import { describe, expect, it } from 'vitest';
import { canonicalStringify, sha256Hex } from './contentDigest';

describe('canonicalStringify', () => {
  it('sorts object keys so construction order cannot change a digest', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe(canonicalStringify({ a: 2, b: 1 }));
  });

  it('preserves array order, which is part of what a reader saw', () => {
    expect(canonicalStringify([1, 2])).not.toBe(canonicalStringify([2, 1]));
  });

  /**
   * Raised in review on PR #66: returning `'null'` for `undefined` made the two
   * indistinguishable, so a digest could call two different values identical.
   * `harnessResume.ts` compares optional snapshot fields by passing them
   * straight in, which is exactly the top-level case.
   */
  it('distinguishes undefined from null at the top level', () => {
    expect(canonicalStringify(undefined)).not.toBe(canonicalStringify(null));
    expect(sha256Hex(canonicalStringify(undefined))).not.toBe(sha256Hex(canonicalStringify(null)));
  });

  it('distinguishes undefined from null inside an array', () => {
    expect(canonicalStringify([undefined])).not.toBe(canonicalStringify([null]));
  });

  it('drops an undefined property but keeps a null one, so the two objects differ', () => {
    expect(canonicalStringify({ a: undefined })).toBe('{}');
    expect(canonicalStringify({ a: null })).toBe('{"a":null}');
  });

  /**
   * The token has to be something no serializable value can produce, or the
   * collision it exists to prevent simply moves to whichever value produces it.
   */
  it('cannot be produced by any serializable value', () => {
    const token = canonicalStringify(undefined);
    expect(() => JSON.parse(token)).toThrow();
    for (const value of ['undefined', 0, null, true, [], {}, { undefined: 1 }]) {
      expect(canonicalStringify(value)).not.toBe(token);
    }
  });

  it('emits no control characters, since this output is persisted as evidence content', () => {
    const serialized = canonicalStringify({ a: [undefined, null, 'text'], b: undefined });
    const codePoints = [...serialized].map((character) => character.codePointAt(0) ?? 0);
    expect(codePoints.filter((code) => code < 0x20 || code === 0x7f)).toEqual([]);
  });
});
