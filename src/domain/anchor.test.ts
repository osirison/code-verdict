import { describe, expect, it } from 'vitest';
import { documentCandidates, movedAnchors, resolveAnchor } from './anchor';

const FILE = ['const a = 1;', '', 'function token() {', '  return cache.get(key);', '}'].join('\n');

describe('resolveAnchor', () => {
  it('reports the anchor as exact when the code is still on its line', () => {
    const result = resolveAnchor(documentCandidates(FILE), {
      line: 4,
      code: '  return cache.get(key);',
    });
    expect(result).toEqual({ state: 'exact', line: 4 });
  });

  it('ignores surrounding whitespace so re-indentation is not a moved anchor', () => {
    const result = resolveAnchor(documentCandidates(FILE), {
      line: 4,
      code: 'return cache.get(key);',
    });
    expect(result.state).toBe('exact');
  });

  it('follows the code to its new line when commits shifted it', () => {
    const shifted = ['// audit log', '// added upstream', ...FILE.split('\n')].join('\n');
    const result = resolveAnchor(documentCandidates(shifted), {
      line: 4,
      code: '  return cache.get(key);',
    });
    expect(result).toEqual({ state: 'moved', line: 6 });
  });

  it('picks the occurrence nearest the original line when the code repeats', () => {
    const repeated = ['return null;', 'a();', 'b();', 'c();', 'return null;'].join('\n');
    const result = resolveAnchor(documentCandidates(repeated), { line: 4, code: 'return null;' });
    expect(result).toEqual({ state: 'moved', line: 5 });
  });

  it('reports lost when the author rewrote the flagged statement', () => {
    const rewritten = FILE.replace('return cache.get(key);', 'return await cache.fetch(key);');
    const result = resolveAnchor(documentCandidates(rewritten), {
      line: 4,
      code: '  return cache.get(key);',
    });
    expect(result).toEqual({ state: 'lost', line: 4 });
  });

  it('never matches on empty code — a blank anchor would match every blank line', () => {
    expect(resolveAnchor(documentCandidates(FILE), { line: 2, code: '   ' })).toEqual({
      state: 'lost',
      line: 2,
    });
  });
});

describe('resolveAnchor — sides (mandate A: widen past added-only)', () => {
  // A hunk that rewrote the middle of a function: one context line either
  // side of the change, one removed statement, one added statement.
  const CANDIDATES = [
    { line: 40, text: 'function handle(req) {', side: 'new' as const },
    { line: 41, text: '  const id = req.params.id;', side: 'new' as const },
    { line: 42, text: '  return store.get(id, token);', side: 'new' as const },
    { line: 43, text: '}', side: 'new' as const },
    { line: 41, text: '  return store.get(id);', side: 'old' as const },
  ];

  it('anchors exactly on a context line — never reachable through added lines alone', () => {
    const result = resolveAnchor(CANDIDATES, { line: 40, code: 'function handle(req) {' });
    expect(result).toEqual({ state: 'exact', line: 40, side: 'new' });
  });

  it('drift-matches a context line that shifted, still on the new side', () => {
    const shifted = CANDIDATES.map((c) => (c.side === 'new' ? { ...c, line: c.line + 2 } : c));
    const result = resolveAnchor(shifted, { line: 43, code: '}' });
    expect(result).toEqual({ state: 'moved', line: 45, side: 'new' });
  });

  it('anchors a finding about a deletion onto the old side, side LEFT', () => {
    const result = resolveAnchor(CANDIDATES, { line: 41, code: '  return store.get(id);' });
    // The new side has no match for this exact text (the rewrite dropped the
    // token argument), so the old-side deletion — the removed line's own
    // number — is what the finding is about.
    expect(result).toEqual({ state: 'exact', line: 41, side: 'old' });
  });

  it('drift-matches a deletion that moved on the old side, once the new side has no match', () => {
    const shiftedOld = CANDIDATES.map((c) => (c.side === 'old' ? { ...c, line: c.line + 3 } : c));
    const result = resolveAnchor(shiftedOld, { line: 41, code: '  return store.get(id);' });
    expect(result).toEqual({ state: 'moved', line: 44, side: 'old' });
  });

  it('never lets an old-side line win over a real new-side match, however close its number', () => {
    // A deleted line numbered exactly where the finding's new-side code also
    // matches, nearer in number than the true new-side line would ever be
    // negative distance from — the new-side pass must still win outright,
    // the old side never even consulted.
    const withCloserGhost = [
      ...CANDIDATES,
      { line: 42, text: '  return store.get(id, token);', side: 'old' as const },
    ];
    const result = resolveAnchor(withCloserGhost, { line: 42, code: '  return store.get(id, token);' });
    expect(result).toEqual({ state: 'exact', line: 42, side: 'new' });
  });

  it('reports lost, not old-side, when neither side has the code at all', () => {
    const result = resolveAnchor(CANDIDATES, { line: 41, code: 'somethingElseEntirely();' });
    expect(result).toEqual({ state: 'lost', line: 41 });
  });
});

describe('movedAnchors', () => {
  const items = [
    { id: 'f1', file: 'src/a.ts', line: 4, code: '  return cache.get(key);' },
    { id: 'f2', file: 'src/a.ts', line: 1, code: 'const a = 1;' },
    { id: 'f3', file: 'src/gone.ts', line: 9, code: 'whatever();' },
  ];

  it('collects the items that no longer sit where the agent read them', () => {
    const candidates = documentCandidates(['// new header', ...FILE.split('\n')].join('\n'));
    const moved = movedAnchors(items, (file) => (file === 'src/a.ts' ? candidates : undefined));
    // f1 and f2 both shifted by the new header; f3's file left the diff.
    expect([...moved].sort()).toEqual(['f1', 'f2', 'f3']);
  });

  it('is empty when nothing moved', () => {
    const candidates = documentCandidates(FILE);
    const moved = movedAnchors(items.slice(0, 2), () => candidates);
    expect(moved.size).toBe(0);
  });
});
