import { describe, expect, it, vi } from 'vitest';
import { Memo, memoize } from './memo';

describe('Memo', () => {
  it('returns a key never seen by computing it', () => {
    const cache = new Memo<number>();
    cache.set('a', 1);
    expect(cache.get('a')).toBe(1);
  });

  it('evicts the least recently used entry, not the first inserted', () => {
    const cache = new Memo<number>(2, 100, 100);
    cache.set('a', 1);
    cache.set('b', 2);
    // Reading 'a' is what makes it the recent one.
    cache.get('a');
    cache.set('c', 3);

    expect(cache.get('a')).toBe(1);
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe(3);
    expect(cache.size).toBe(2);
  });

  it('evicts on the character cap before the entry cap is reached, when entries are large', () => {
    // Entry cap of 10 would hold all three; the character cap of 8, over
    // three 4-character keys, evicts before the entry cap ever binds.
    const cache = new Memo<number>(10, 8, 8);
    cache.set('aaaa', 1);
    cache.set('bbbb', 2);
    cache.set('cccc', 3);

    expect(cache.get('aaaa')).toBeUndefined();
    expect(cache.size).toBe(2);
    expect(cache.get('bbbb')).toBe(2);
    expect(cache.get('cccc')).toBe(3);
  });

  it('declines an oversized entry rather than evicting the rest to hold it', () => {
    // Weighed by the KEY's length: 'small' is 5 chars, under the 6-char cap;
    // 'waytoolong' is 10, over it.
    const cache = new Memo<number>(8, 6, 100);
    cache.set('small', 1);
    cache.set('waytoolong', 2);

    expect(cache.get('waytoolong')).toBeUndefined();
    expect(cache.get('small')).toBe(1);
  });

  it('gives back the bytes a deleted entry held, so the cap does not ratchet shut', () => {
    const cache = new Memo<number>(8, 8, 8);
    cache.set('aaaa', 1);
    cache.set('bbbb', 2);
    cache.delete('aaaa');
    cache.set('cccc', 3);

    expect(cache.get('bbbb')).toBe(2);
    expect(cache.get('cccc')).toBe(3);
  });
});

describe('memoize', () => {
  it('returns the cached value for a repeated key without re-invoking the function', () => {
    const fn = vi.fn((input: string) => input.toUpperCase());
    const memoized = memoize(fn);

    expect(memoized('a')).toBe('A');
    expect(memoized('a')).toBe('A');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('computes a key it has not seen', () => {
    const fn = vi.fn((input: string) => input.toUpperCase());
    const memoized = memoize(fn);

    expect(memoized('a')).toBe('A');
    expect(memoized('b')).toBe('B');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
