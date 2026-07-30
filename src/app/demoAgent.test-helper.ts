import type { EmulatorFetch } from '../../emulator/fetch';
import type { ChangeRequestDiff } from '../platform/types';

/** Fetch the flagship MR's diff through the raw emulator API (no provider import). */
export async function toChangeRequestDiff(fetchImpl: EmulatorFetch): Promise<ChangeRequestDiff> {
  const res = await fetchImpl('https://x/api/v4/projects/9101/merge_requests/2841/changes', {
    headers: { authorization: 'Bearer glpat-emulator' },
  });
  const body = (await res.json()) as {
    diff_refs: { head_sha: string };
    changes: Array<{ old_path: string; new_path: string; diff: string }>;
  };
  return {
    ref: { repoId: '9101', number: '2841' },
    headSha: body.diff_refs.head_sha,
    files: body.changes.map((c) => ({ oldPath: c.old_path, newPath: c.new_path, diff: c.diff })),
    anchorRefs: body.diff_refs,
  };
}
