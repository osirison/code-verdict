import { describe, expect, it } from 'vitest';
import type { ChangedFileEntry, ChangedFileManifestResult, InvestigationSnapshotRef } from '../platform/types';
import { coverageChangedFact, createChangedFileInventory } from './harnessInventory';

const SNAPSHOT: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
const OTHER_HEAD: InvestigationSnapshotRef = { ...SNAPSHOT, headSha: 'head-2' };

function entry(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, ...overrides };
}

function complete(entries: ChangedFileEntry[], snapshot = SNAPSHOT): ChangedFileManifestResult {
  return { snapshot, state: 'complete', value: entries };
}

function paginated(entries: ChangedFileEntry[], cursor: string, snapshot = SNAPSHOT): ChangedFileManifestResult {
  return { snapshot, state: 'paginated', value: entries, cursor };
}

function inventoryWith(entries: ChangedFileEntry[]) {
  const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
  expect(inventory.acceptManifestPage('m1', complete(entries)).ok).toBe(true);
  return inventory;
}

describe('manifest accumulation (task 8.1)', () => {
  it('exposes no total denominator while a continuation is pending', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    const first = inventory.acceptManifestPage('m1', paginated([entry('a.ts'), entry('b.ts')], 'c1'));
    expect(first).toEqual({ ok: true, added: 2, duplicates: 0, enumeration: 'inProgress' });
    expect(inventory.member('m1')?.pendingCursor).toBe('c1');
    expect(inventory.counts().known).toBe(2);
    expect(inventory.counts().total).toBeUndefined();
    expect(inventory.coverage('m1')?.manifestComplete).toBe(false);
    expect(inventory.coverage('m1')?.totalFiles).toBeUndefined();
    expect(inventory.coverageProgress().total).toBeUndefined();

    const last = inventory.acceptManifestPage('m1', complete([entry('c.ts')]));
    expect(last).toEqual({ ok: true, added: 1, duplicates: 0, enumeration: 'complete' });
    expect(inventory.member('m1')?.pendingCursor).toBeUndefined();
    expect(inventory.counts().total).toBe(3);
    expect(inventory.coverage('m1')?.totalFiles).toBe(3);
    expect(inventory.everyMemberComplete()).toBe(true);
  });

  it('never loses a file across pages and is idempotent when a page is replayed', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    const page1 = paginated([entry('a.ts'), entry('b.ts')], 'c1');
    inventory.acceptManifestPage('m1', page1);
    // Redelivery of the same page (retry after a lost response) adds nothing and removes nothing.
    expect(inventory.acceptManifestPage('m1', page1)).toEqual({ ok: true, added: 0, duplicates: 2, enumeration: 'inProgress' });
    // A page repeating a known path alongside a new one only adds the new one.
    expect(inventory.acceptManifestPage('m1', complete([entry('b.ts'), entry('c.ts')]))).toEqual({
      ok: true,
      added: 1,
      duplicates: 1,
      enumeration: 'complete',
    });
    expect(inventory.member('m1')?.files.map((file) => file.path)).toEqual(['a.ts', 'b.ts', 'c.ts']);
    // Replaying the final page after completion is still accepted as a no-op.
    expect(inventory.acceptManifestPage('m1', complete([entry('b.ts'), entry('c.ts')])).ok).toBe(true);
    expect(inventory.counts().total).toBe(3);
  });

  it('refuses a page that would grow a closed enumeration', () => {
    const inventory = inventoryWith([entry('a.ts')]);
    const outcome = inventory.acceptManifestPage('m1', complete([entry('z.ts')]));
    expect(outcome).toMatchObject({ ok: false, code: 'enumerationClosed' });
    expect(inventory.counts().total).toBe(1);
  });

  it('refuses a page bound to another head or an unknown member', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    expect(inventory.acceptManifestPage('m1', complete([entry('a.ts')], OTHER_HEAD))).toMatchObject({ ok: false, code: 'snapshotMismatch' });
    expect(inventory.acceptManifestPage('m2', complete([entry('a.ts')]))).toMatchObject({ ok: false, code: 'unknownMember' });
    expect(inventory.counts().known).toBe(0);
  });

  it('records truncated enumeration as a provider limit with known counts and no denominator', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    const outcome = inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'truncated', value: [entry('a.ts')], knownRemainingUnits: 40 });
    expect(outcome).toEqual({ ok: true, added: 1, duplicates: 0, enumeration: 'truncated' });
    const member = inventory.member('m1');
    expect(member?.knownRemainingUnits).toBe(40);
    expect(member?.reason).toMatch(/could not enumerate/);
    expect(inventory.counts().known).toBe(1);
    expect(inventory.counts().total).toBeUndefined();
    expect(inventory.everyMemberComplete()).toBe(false);
    expect(inventory.acceptManifestPage('m1', complete([entry('b.ts')]))).toMatchObject({ ok: false, code: 'enumerationClosed' });
  });

  it('records an unavailable manifest without inventing an empty complete inventory, and lets a retry recover', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', paginated([entry('a.ts')], 'c1'));
    expect(inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'unavailable', reason: 'rate limited' })).toEqual({
      ok: true,
      added: 0,
      duplicates: 0,
      enumeration: 'unavailable',
    });
    expect(inventory.member('m1')?.enumeration).toBe('unavailable');
    expect(inventory.member('m1')?.files).toHaveLength(1);
    expect(inventory.counts().total).toBeUndefined();
    expect(inventory.acceptManifestPage('m1', complete([entry('b.ts')])).ok).toBe(true);
    expect(inventory.member('m1')?.enumeration).toBe('complete');
    expect(inventory.counts().total).toBe(2);
  });

  it('keeps renamed old paths, binary flags, deletions, and sizes as explicit manifest facts', () => {
    const inventory = inventoryWith([
      entry('src/auth/tokenStore.ts', { kind: 'renamed', oldPath: 'src/legacy/tokenStore.ts' }),
      entry('assets/logo.png', { binary: true, byteSize: 4096, addedLines: undefined, removedLines: undefined }),
      entry('src/old.ts', { kind: 'deleted', addedLines: 0, removedLines: 30 }),
    ]);
    expect(inventory.file('m1', 'src/auth/tokenStore.ts')).toMatchObject({ kind: 'renamed', oldPath: 'src/legacy/tokenStore.ts', state: 'unvisited' });
    expect(inventory.file('m1', 'assets/logo.png')).toMatchObject({ binary: true, byteSize: 4096, state: 'unvisited' });
    expect(inventory.file('m1', 'src/old.ts')).toMatchObject({ kind: 'deleted', removedLines: 30 });
    expect(inventory.counts().known).toBe(3);
  });

  it('refuses a manifest entry whose path escapes the repository', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    expect(inventory.acceptManifestPage('m1', complete([entry('../etc/passwd')]))).toMatchObject({ ok: false, code: 'invalidPath' });
    expect(inventory.counts().known).toBe(0);
  });

  it('normalizes a leading slash so the same file cannot be counted twice', () => {
    const inventory = inventoryWith([entry('/src/a.ts'), entry('src/a.ts')]);
    expect(inventory.counts().known).toBe(1);
    expect(inventory.file('m1', '/src/a.ts')?.path).toBe('src/a.ts');
  });

  it('scopes totals per member: one incomplete member removes the aggregate denominator', () => {
    const m2Snapshot: InvestigationSnapshotRef = { repoId: 'repo-2', baseSha: 'b', headSha: 'h' };
    const inventory = createChangedFileInventory([
      { memberId: 'm1', snapshot: SNAPSHOT },
      { memberId: 'm2', snapshot: m2Snapshot },
    ]);
    inventory.acceptManifestPage('m1', complete([entry('a.ts')]));
    expect(inventory.acceptManifestPage('m2', paginated([entry('x.ts')], 'c', m2Snapshot)).ok).toBe(true);
    expect(inventory.counts('m1').total).toBe(1);
    expect(inventory.counts('m2').total).toBeUndefined();
    expect(inventory.counts().total).toBeUndefined();
    expect(inventory.counts().known).toBe(2);
    expect(inventory.everyMemberComplete()).toBe(false);
  });

  it('rejects an empty member list and duplicate member ids', () => {
    expect(() => createChangedFileInventory([])).toThrow(/at least one member/);
    expect(() =>
      createChangedFileInventory([
        { memberId: 'm1', snapshot: SNAPSHOT },
        { memberId: 'm1', snapshot: SNAPSHOT },
      ]),
    ).toThrow(/Duplicate/);
  });
});

describe('changed-file state transitions (task 8.2)', () => {
  it('walks unvisited -> classified -> inspected and reports real counts at each step', () => {
    const inventory = inventoryWith([entry('a.ts'), entry('b.ts')]);
    expect(inventory.counts()).toMatchObject({ unvisited: 2, classified: 0, inspected: 0, known: 2, total: 2 });
    const classified = inventory.classify('m1', 'a.ts', { risk: 'high', logicalUnit: 'auth', policyId: 'policy-root' });
    expect(classified).toMatchObject({ ok: true, changed: true, file: { state: 'classified', risk: 'high', logicalUnit: 'auth', policyId: 'policy-root' } });
    expect(inventory.counts()).toMatchObject({ unvisited: 1, classified: 1 });
    expect(inventory.markInspected('m1', 'a.ts')).toMatchObject({ ok: true, changed: true, file: { state: 'inspected' } });
    expect(inventory.counts()).toMatchObject({ unvisited: 1, classified: 0, inspected: 1 });
    expect(inventory.markInspected('m1', 'a.ts')).toMatchObject({ ok: true, changed: false });
  });

  it('refuses inspection or a terminal state before classification (D10 ordering)', () => {
    const inventory = inventoryWith([entry('assets/logo.png', { binary: true })]);
    expect(inventory.markInspected('m1', 'assets/logo.png')).toMatchObject({ ok: false, code: 'notClassified' });
    expect(inventory.markTerminal('m1', 'assets/logo.png', 'binary', 'binary content')).toMatchObject({ ok: false, code: 'notClassified' });
    expect(inventory.file('m1', 'assets/logo.png')?.state).toBe('unvisited');
  });

  it('reaches every non-inspected terminal state only with a public reason', () => {
    const inventory = inventoryWith([entry('a'), entry('b'), entry('c'), entry('d')]);
    for (const path of ['a', 'b', 'c', 'd']) inventory.classify('m1', path, { risk: 'low' });
    expect(inventory.markTerminal('m1', 'a', 'excludedByPolicy', 'generated file excluded by AGENTS.md')).toMatchObject({ ok: true, file: { state: 'excludedByPolicy' } });
    expect(inventory.markTerminal('m1', 'b', 'unavailable', 'provider returned unavailable')).toMatchObject({ ok: true, file: { state: 'unavailable' } });
    expect(inventory.markTerminal('m1', 'c', 'binary', 'binary content')).toMatchObject({ ok: true, file: { state: 'binary' } });
    expect(inventory.markTerminal('m1', 'd', 'oversized', 'diff exceeds the single-result ceiling')).toMatchObject({ ok: true, file: { state: 'oversized' } });
    expect(inventory.counts()).toMatchObject({ excludedByPolicy: 1, unavailable: 1, binary: 1, oversized: 1, classified: 0, unvisited: 0, inspected: 0 });
    for (const file of inventory.member('m1')?.files ?? []) expect(file.reason).toBeTruthy();
  });

  it('refuses a terminal transition with an empty reason or an unknown state', () => {
    const inventory = inventoryWith([entry('a')]);
    inventory.classify('m1', 'a', { risk: 'low' });
    expect(inventory.markTerminal('m1', 'a', 'oversized', '   ')).toMatchObject({ ok: false, code: 'missingReason' });
    expect(inventory.markTerminal('m1', 'a', 'inspected' as never, 'x')).toMatchObject({ ok: false, code: 'invalidState' });
    expect(inventory.file('m1', 'a')?.state).toBe('classified');
  });

  it('freezes a terminal state: no further transition or reclassification', () => {
    const inventory = inventoryWith([entry('a')]);
    inventory.classify('m1', 'a', { risk: 'low' });
    inventory.markTerminal('m1', 'a', 'binary', 'binary content');
    expect(inventory.markInspected('m1', 'a')).toMatchObject({ ok: false, code: 'alreadyTerminal' });
    expect(inventory.markTerminal('m1', 'a', 'oversized', 'x')).toMatchObject({ ok: false, code: 'alreadyTerminal' });
    expect(inventory.classify('m1', 'a', { risk: 'high' })).toMatchObject({ ok: false, code: 'alreadyTerminal' });
    expect(inventory.markTerminal('m1', 'a', 'binary', 'same again')).toMatchObject({ ok: true, changed: false });
    expect(inventory.file('m1', 'a')?.state).toBe('binary');
  });

  it('allows reclassification while still classified, but not after inspection', () => {
    const inventory = inventoryWith([entry('a')]);
    inventory.classify('m1', 'a', { risk: 'low' });
    expect(inventory.classify('m1', 'a', { risk: 'high' })).toMatchObject({ ok: true, file: { risk: 'high' } });
    inventory.markInspected('m1', 'a');
    expect(inventory.classify('m1', 'a', { risk: 'low' })).toMatchObject({ ok: false, code: 'alreadyTerminal' });
  });

  it('refuses unknown paths, unknown members, and garbage risk levels', () => {
    const inventory = inventoryWith([entry('a')]);
    expect(inventory.classify('m1', 'zzz', { risk: 'low' })).toMatchObject({ ok: false, code: 'unknownPath' });
    expect(inventory.classify('m9', 'a', { risk: 'low' })).toMatchObject({ ok: false, code: 'unknownMember' });
    expect(inventory.classify('m1', 'a', { risk: 'critical' as never })).toMatchObject({ ok: false, code: 'invalidRisk' });
  });

  it('sanitizes the logical unit and reason text before storing them', () => {
    const inventory = inventoryWith([entry('a')]);
    inventory.classify('m1', 'a', { risk: 'low', logicalUnit: 'auth token=ghp_abcdefghijklmnopqrstuvwxyz0123456789' });
    expect(inventory.file('m1', 'a')?.logicalUnit).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    inventory.markTerminal('m1', 'a', 'unavailable', 'Bearer abcdefghijklmnopqrstuvwxyz failed');
    expect(inventory.file('m1', 'a')?.reason).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('exposes coverage as the domain MemberCoverage shape', () => {
    const inventory = inventoryWith([entry('a'), entry('b')]);
    inventory.classify('m1', 'a', { risk: 'high', logicalUnit: 'auth' });
    inventory.markInspected('m1', 'a');
    expect(inventory.coverage('m1')).toEqual({
      memberId: 'm1',
      manifestComplete: true,
      totalFiles: 2,
      files: [
        { path: 'a', memberId: 'm1', state: 'inspected', risk: 'high', logicalUnit: 'auth' },
        { path: 'b', memberId: 'm1', state: 'unvisited' },
      ],
    });
    expect(inventory.coverage('nope')).toBeUndefined();
  });
});

describe('coverage progress facts (section-5 integration)', () => {
  it('reports classified/inspected counts and a total only once every member is complete', () => {
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', paginated([entry('a'), entry('b')], 'c1'));
    inventory.classify('m1', 'a', { risk: 'high' });
    expect(coverageChangedFact(inventory, ['high'])).toEqual({ kind: 'coverageChanged', coverage: { classified: 1, inspected: 0 } });
    inventory.acceptManifestPage('m1', complete([entry('c')]));
    inventory.markInspected('m1', 'a');
    inventory.classify('m1', 'b', { risk: 'low' });
    inventory.markInspected('m1', 'b');
    expect(coverageChangedFact(inventory, ['high'])).toEqual({
      kind: 'coverageChanged',
      coverage: { classified: 2, inspected: 2, total: 3, requiredInspected: 1 },
    });
  });
});
