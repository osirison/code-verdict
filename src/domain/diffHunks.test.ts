import { describe, expect, it } from 'vitest';
import { addedLines, diffAnchorCandidates, diffStats, parseHunks } from './diffHunks';

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

describe('diffAnchorCandidates', () => {
  it('includes context and added lines on the new side, and removed lines on the old side', () => {
    const candidates = diffAnchorCandidates(DIFF);
    const newSide = candidates.filter((c) => c.side === 'new');
    const oldSide = candidates.filter((c) => c.side === 'old');

    // Every context and added line across both hunks: 6 in the first hunk
    // (3 context either side of the change, 1 addition, 2 trailing context),
    // 3 additions in the second — none of them reachable before this widened
    // the candidate universe past `addedLines`.
    expect(newSide).toHaveLength(9);
    expect(oldSide).toHaveLength(3);

    // The context line right before the change is now addressable — it was
    // never in `addedLines` at all.
    expect(newSide).toContainEqual({
      line: 62, text: '    if (!res.ok) {', side: 'new',
    });
    // The removed statement, numbered on the OLD file — a finding about this
    // deletion anchors here, not on line 63 of the new file (which is a
    // different statement entirely).
    expect(oldSide).toContainEqual({
      line: 63, text: "      logger.error('refresh failed')", side: 'old',
    });
    // The addition that replaced it shares the number 63 but is a different
    // line in a different space — proof the two are never treated as one.
    expect(newSide).toContainEqual({
      line: 63, text: '      logger.error(`refresh failed ${this.refreshToken}`)', side: 'new',
    });
  });

  it('produces nothing for a diff with no hunks', () => {
    expect(diffAnchorCandidates('no hunks here')).toEqual([]);
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

describe('line endings', () => {
  const BODY = ['@@ -1,2 +1,2 @@', '-old', '+new', ' same'];

  it('parses a diff whose lines end with a carriage return exactly as one that does not', () => {
    const lf = parseHunks(`${BODY.join('\n')}\n`);
    const crlf = parseHunks(`${BODY.join('\r\n')}\r\n`);
    expect(lf.length).toBe(1);
    expect(crlf).toEqual(lf);
  });

  it('leaves no carriage return in line text, which citation validation compares exactly', () => {
    const [hunk] = parseHunks(`${BODY.join('\r\n')}\r\n`);
    expect(hunk).toBeDefined();
    for (const line of hunk?.lines ?? []) expect(line.text).not.toContain('\r');
  });
});

