/**
 * Bounded LRU memo for a pure, string-keyed derivation (D10).
 *
 * `parseHunks`, `diffStats` (`./diffHunks`) and `renderMarkdown`
 * (`../ui/markdown`) are pure and recomputed on every render — seventeen call
 * sites in the review flow alone — including renders caused by state that
 * touches neither the diff nor the prose. Each wraps its own `Memo` here
 * rather than recomputing.
 *
 * Bounded the way `EtagCache` is (`src/providers/github/http.ts:205-278`):
 * eviction is least-recently-used, because a render re-derives the same
 * handful of keys — the diff of the file currently open, the markdown of the
 * finding currently shown — far more often than it sees a new one, and both
 * an entry-count cap and a total-character cap apply, because either one
 * alone can be wrong: a cap on count alone lets a handful of huge diffs
 * exhaust memory, and a cap on characters alone lets thousands of tiny ones
 * exhaust the `Map`.
 *
 * Weighed by the KEY's length, not the stored value's. `EtagCache` weighs by
 * its value because its value is the response body it exists to hold. Here
 * the value varies by caller — an array of hunks, a `{ added, removed }`
 * record, an HTML string — and is not reliably measurable in characters, but
 * every caller already paid to build the key (the diff text, the markdown
 * source) before calling in, so its length is on hand and is a fair proxy
 * for the cost the memo is saving: a longer diff produces more hunks and
 * lines to hold onto.
 *
 * This module is imported from `src/domain/` (`./diffHunks`), which does not
 * import `src/app/` anywhere today — every existing import between the two
 * runs the other way, app depending on domain — so the implementation lives
 * here rather than in `src/app/memo.ts`. `src/app/memo.ts` re-exports it for
 * callers at or above the app layer.
 */
export class Memo<V> {
  private readonly entries = new Map<string, V>();
  private chars = 0;

  constructor(
    private readonly maxEntries = 200,
    private readonly maxEntryChars = 2 * 1024 * 1024,
    private readonly maxTotalChars = 16 * 1024 * 1024,
  ) {}

  /** `undefined` always means "not cached" — a derivation that legitimately produced `undefined` would be recomputed every time, but none of the three this backs ever does. */
  get(key: string): V | undefined {
    const value = this.entries.get(key);
    if (value === undefined) return undefined;
    // Reinsert so the `Map`'s iteration order — insertion order — keeps
    // tracking recency: the first key is always the least recently used.
    this.entries.delete(key);
    this.entries.set(key, value);
    return value;
  }

  set(key: string, value: V): void {
    this.delete(key);
    // Left uncached rather than allowed to evict everything else to hold it —
    // it keeps paying full price, which is only this one derivation.
    if (key.length > this.maxEntryChars) return;
    this.entries.set(key, value);
    this.chars += key.length;
    while (this.entries.size > this.maxEntries || this.chars > this.maxTotalChars) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true || oldest.value === undefined) break;
      this.delete(oldest.value);
    }
  }

  delete(key: string): void {
    if (!this.entries.has(key)) return;
    this.chars -= key.length;
    this.entries.delete(key);
  }

  get size(): number {
    return this.entries.size;
  }
}

/**
 * Wraps a pure, string-keyed function with a `Memo`: a key already seen
 * returns the cached value without calling `fn` again, and a key not seen is
 * computed and stored. Each call site gets its own `cache` — sharing one
 * across unrelated derivations would let one caller's key collide with
 * another's.
 */
export function memoize<V>(fn: (input: string) => V, cache: Memo<V> = new Memo<V>()): (input: string) => V {
  return (input: string): V => {
    const cached = cache.get(input);
    if (cached !== undefined) return cached;
    const value = fn(input);
    cache.set(input, value);
    return value;
  };
}
