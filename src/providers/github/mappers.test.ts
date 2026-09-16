/**
 * `linesFromUnifiedDiff` is the fixture-only helper `fakeGitHub.ts` uses to
 * fabricate a file-content response from a patch string. Real
 * `githubProvider.ts` never calls it — actual file content goes through
 * `localGitSource.ts`'s hunk-aware `locatedDiffLines` — but the fixture
 * fake still owes it correct behaviour, because a future fixture patch
 * carrying a real file header would otherwise leak `diff --git`/`index`/
 * `+++`/no-newline-marker lines into fabricated file content.
 */
import { describe, expect, it } from 'vitest';
import { linesFromUnifiedDiff } from './mappers';

describe('linesFromUnifiedDiff', () => {
  it('keeps context and added lines, and drops the hunk header', () => {
    const patch = ['@@ -1,2 +1,3 @@', ' unchanged line', '-removed line', '+added line'].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['unchanged line', 'added line']);
  });

  it('drops the file-level diff --git and index metadata lines', () => {
    const patch = [
      'diff --git a/src/util.ts b/src/util.ts',
      'index 0abc123..1def456 100644',
      '--- a/src/util.ts',
      '+++ b/src/util.ts',
      '@@ -1,1 +1,1 @@',
      '-old content',
      '+new content',
    ].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['new content']);
  });

  it('drops the no-newline-at-end-of-file marker', () => {
    const patch = ['@@ -1,1 +1,1 @@', '-old content', '+new content', '\\ No newline at end of file'].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['new content']);
  });

  it('never mangles a +++ file header into fabricated content', () => {
    const patch = ['--- a/src/util.ts', '+++ b/src/util.ts', '@@ -1,1 +1,1 @@', ' same content'].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['same content']);
  });

  it('preserves a genuine added line that starts with ++', () => {
    const patch = ['@@ -1,1 +1,2 @@', ' context', '+++ b/something'].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['context', '++ b/something']);
  });

  it('still drops no-newline marker after hunks', () => {
    const patch = ['@@ -1,1 +1,2 @@', ' context', '+added', '\\ No newline at end of file'].join('\n');
    expect(linesFromUnifiedDiff(patch)).toEqual(['context', 'added']);
  });
});
