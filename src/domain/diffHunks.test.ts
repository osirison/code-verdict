import { describe, expect, it } from 'vitest';
import { addedLines, diffStats, parseHunks } from './diffHunks';

const DIFF = [
  '@@ -60,6 +60,6 @@ export class TokenStore {',
  '   async refresh(): Promise<void> {',
  "     const res = await this.client.post('/oauth/token', this.grant)",
  '     if (!res.ok) {',
  "-      logger.error('refresh failed')",
  '+      logger.error(`refresh failed ${this.refreshToken}`)',
  '       throw new RefreshError(res.status)',
  '     }',
  '@@ -86,2 +86,3 @@ export class TokenStore {',
  '-    if (this.refreshing) return this.pending',
  '-    this.refreshing = true',
  '+    if (this.refreshing) return this.pending',
  '+    this.refreshing = true',
  '+    this.pending = this.doRefresh()',
  '',
].join('\n');

describe('parseHunks', () => {
  it('tracks old/new line numbers through mixed hunks', () => {
    const hunks = parseHunks(DIFF);
    expect(hunks).toHaveLength(2);
    const added = addedLines(DIFF);
    // The spec anchors: the logged token is new line 63; the promise fix
    // ends at new line 88.
    expect(added.map((a) => a.line)).toEqual([63, 86, 87, 88]);
    expect(added[0]?.text).toContain('refresh failed ${this.refreshToken}');
    expect(added[3]?.text).toContain('this.pending = this.doRefresh()');
  });

  it('counts stats across files', () => {
    expect(diffStats([DIFF])).toEqual({ added: 4, removed: 3 });
  });

  it('handles single-line hunks without explicit counts', () => {
    const hunks = parseHunks('@@ -5 +5 @@\n-a\n+b\n');
    expect(hunks[0]).toMatchObject({ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 });
  });
});

describe('parseHunks and diffStats — memoization (D10)', () => {
  it('returns the exact same array for a repeated diff, proving the second call did not re-parse', () => {
    const first = parseHunks(DIFF);
    const second = parseHunks(DIFF);
    // Recomputing would allocate a new array; `toBe` is decisive here in a
    // way `toEqual` is not.
    expect(second).toBe(first);
  });

  it('returns the exact same stats record for a repeated file set', () => {
    const first = diffStats([DIFF]);
    const second = diffStats([DIFF]);
    expect(second).toBe(first);
  });

  it('does not confuse two file splits whose bare-joined characters collide', () => {
    // Both arrays join, unseparated, to the same 16 characters
    // ("@@ -1 +1 @@\n+x\n") — a bare-joined key would cache one split's
    // result under the other's key. The splits are NOT equivalent: each
    // array element is parsed as its own diff, and splitting the header
    // line itself breaks it, so the second split sees no header and no
    // added line at all.
    const wholeHeader = ['@@ -1 +1 @@\n+x\n'];
    const splitHeader = ['@@ -1 +1 @', '@\n+x\n'];
    expect(wholeHeader.join('')).toBe(splitHeader.join(''));

    expect(diffStats(wholeHeader)).toEqual({ added: 1, removed: 0 });
    expect(diffStats(splitHeader)).toEqual({ added: 0, removed: 0 });
  });
});
