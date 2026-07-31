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
