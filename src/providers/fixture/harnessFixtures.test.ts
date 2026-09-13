import { describe, expect, it } from 'vitest';
import * as harness from './harnessFixtures';

describe('harness fixtures (task 1.3)', () => {
  it('small review has one small file', () => {
    expect(harness.SMALL_REVIEW_DIFF.files).toHaveLength(1);
  });

  it('the huge review spans more than two manifest pages', () => {
    expect(harness.HUGE_REVIEW_DIFF.files).toHaveLength(harness.HUGE_REVIEW_FILE_COUNT);
    expect(harness.HUGE_REVIEW_FILE_COUNT).toBeGreaterThan(harness.HUGE_REVIEW_PAGE_SIZE * 2);
    const paths = new Set(harness.HUGE_REVIEW_DIFF.files.map((f) => f.newPath));
    expect(paths.size).toBe(harness.HUGE_REVIEW_FILE_COUNT);
  });

  it('has a binary file and a distinct renamed file', () => {
    const [binary, renamed] = harness.BINARY_AND_RENAMED_DIFF.files;
    expect(binary?.diff).toMatch(/^Binary files /);
    expect(renamed?.isRenamed).toBe(true);
    expect(renamed?.oldPath).not.toBe(renamed?.newPath);
  });

  it('the oversized diff exceeds the single-tool-result ceiling', () => {
    const body = harness.oversizedDiffBody();
    expect(Buffer.byteLength(body, 'utf8')).toBeGreaterThan(64 * 1024);
    expect(harness.OVERSIZED_REVIEW_DIFF.files[0]?.diff.length).toBe(body.length);
  });

  it("nests AGENTS.md from the repository root to the changed file's directory", () => {
    expect(harness.NESTED_AGENTS_MD.map((f) => f.path)).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
      'src/payments/AGENTS.md',
    ]);
    expect(harness.NESTED_AGENTS_MD_CHANGED_PATH.startsWith('src/payments/')).toBe(true);
  });

  it('reports a different head on the same ref after the snapshot', () => {
    expect(harness.CHANGED_HEAD_SNAPSHOT_DIFF.ref).toEqual(harness.CHANGED_HEAD_LATER_DIFF.ref);
    expect(harness.CHANGED_HEAD_SNAPSHOT_DIFF.headSha).not.toBe(harness.CHANGED_HEAD_LATER_DIFF.headSha);
  });

  it('has a long issue description and a long discussion', () => {
    expect(harness.LONG_ISSUE.description!.length).toBeGreaterThan(2000);
    expect(harness.LONG_DISCUSSION.notes).toHaveLength(harness.LONG_DISCUSSION_NOTE_COUNT);
  });

  it('the multi-member changeset spans three distinct repositories', () => {
    expect(harness.CHANGESET_MEMBERS).toHaveLength(3);
    expect(new Set(harness.CHANGESET_MEMBERS.map((m) => m.ref.repoId)).size).toBe(3);
  });
});
