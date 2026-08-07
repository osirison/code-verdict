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
