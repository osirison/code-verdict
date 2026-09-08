import { describe, expect, it } from 'vitest';
import {
  investigationResultValue,
  type ChangedFileManifestResult,
  type ChangeRequestDetailResult,
  type FileRangeResult,
  type InvestigationResult,
  type InvestigationSnapshotRef,
} from './types';

const SNAPSHOT: InvestigationSnapshotRef = { repoId: 'r1', baseSha: 'base-1', headSha: 'head-1' };

describe('InvestigationResult shape (task 3.2)', () => {
  it('returns the payload for complete, paginated, and truncated results', () => {
    expect(investigationResultValue<string>({ snapshot: SNAPSHOT, state: 'complete', value: 'x' })).toBe('x');
    expect(
      investigationResultValue<string>({ snapshot: SNAPSHOT, state: 'paginated', value: 'x', cursor: 'c1' }),
    ).toBe('x');
    expect(investigationResultValue<string>({ snapshot: SNAPSHOT, state: 'truncated', value: 'x' })).toBe('x');
  });

  it('never represents unavailable, binary, tooLarge, notFound, or unknown as a payload', () => {
    const noValueStates: ReadonlyArray<InvestigationResult<string>> = [
      { snapshot: SNAPSHOT, state: 'unavailable', reason: 'stale-snapshot' },
      { snapshot: SNAPSHOT, state: 'binary', byteSize: 1024 },
      { snapshot: SNAPSHOT, state: 'tooLarge', byteSize: 65537 },
      { snapshot: SNAPSHOT, state: 'notFound' },
      { snapshot: SNAPSHOT, state: 'unknown' },
    ];
    for (const result of noValueStates) {
      expect(investigationResultValue(result)).toBeUndefined();
      // No `value` key exists to be mistaken for an empty successful payload.
      expect('value' in result).toBe(false);
    }
  });
});

describe('every operation result normalizes through the same envelope (task 3.4)', () => {
  it('a manifest, a file range, and a detail result each carry the same eight states honestly', () => {
    const manifest: ChangedFileManifestResult = { snapshot: SNAPSHOT, state: 'truncated', value: [], knownRemainingUnits: 12 };
    const fileRange: FileRangeResult = { snapshot: SNAPSHOT, state: 'binary', byteSize: 2048 };
    const detail: ChangeRequestDetailResult = { snapshot: SNAPSHOT, state: 'unavailable', reason: 'rate limited' };

    expect(investigationResultValue(manifest)).toEqual([]);
    expect(manifest.state).toBe('truncated');
    expect(investigationResultValue(fileRange)).toBeUndefined();
    expect(investigationResultValue(detail)).toBeUndefined();
    // A caller cannot read `.value` off `fileRange`/`detail` without narrowing `state` first — the
    // property itself does not exist on the `binary`/`unavailable` branches of the union.
    expect('value' in fileRange).toBe(false);
    expect('value' in detail).toBe(false);
  });
});
