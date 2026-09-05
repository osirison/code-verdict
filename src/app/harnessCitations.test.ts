import { describe, expect, it } from 'vitest';
import { sha256Hex } from './contentDigest';
import { parseSourceCitation, resolveCandidateCitations, resolveCitation } from './harnessCitations';
import { createEvidenceLedger, type EvidenceLedger, type EvidenceLedgerMember, type LedgerEvidenceSource } from './harnessEvidenceLedger';
import type { DiffPageResult, FileRangeResult, InvestigationSnapshotRef } from '../platform/types';

const IDENTITY = { runId: 'run-1', lineageId: 'lineage-1', attempt: 1 };
const M1: EvidenceLedgerMember = { memberId: 'm1', repositoryId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
const M2: EvidenceLedgerMember = { memberId: 'm2', repositoryId: 'repo-2', baseSha: 'base-2', headSha: 'head-2' };
const SNAP1: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
const SNAP2: InvestigationSnapshotRef = { repoId: 'repo-2', baseSha: 'base-2', headSha: 'head-2' };

function diffPage(snapshot: InvestigationSnapshotRef, path = 'src/auth/token.ts'): DiffPageResult {
  return {
    state: 'complete',
    snapshot,
    value: {
      path,
      patch: '@@ -1,2 +1,3 @@\n a\n+b\n+c',
      positions: [
        { path, side: 'new', line: 2 },
        { path, side: 'new', line: 3 },
        { path, side: 'old', line: 1 },
      ],
    },
  };
}

function fileRange(snapshot: InvestigationSnapshotRef): FileRangeResult {
  return { state: 'complete', snapshot, value: { revision: 'head', path: 'src/auth/caller.ts', startLine: 10, endLine: 20, text: 'x'.repeat(11) } };
}

function setup(): { ledger: EvidenceLedger; diff: LedgerEvidenceSource; file: LedgerEvidenceSource; policy: LedgerEvidenceSource; detail: LedgerEvidenceSource } {
  const ledger = createEvidenceLedger(IDENTITY, [M1, M2]);
  const diff = ledger.registerDiffPage('m1', diffPage(SNAP1));
  const file = ledger.registerFileRange('m2', fileRange(SNAP2));
  const content = 'Never cite me.';
  const policy = ledger.registerAgentsPolicy('m1', { directory: '', state: 'present', sourceId: 'agents-policy:base-1:.', digest: sha256Hex(content), content, citable: false });
  const detail = ledger.registerChangeRequestDetail('m1', {
    state: 'complete',
    snapshot: SNAP1,
    value: { title: 't', labels: [], commits: [], discussion: [], checkSummaries: [], relationships: [], unavailableSections: [] },
  });
  if (!diff.ok || !file.ok || !policy.ok || !detail.ok) throw new Error('setup failed');
  return { ledger, diff: diff.source, file: file.source, policy: policy.source, detail: detail.source };
}

const cite = (source: LedgerEvidenceSource, path?: string, range?: { startLine: number; endLine?: number }) => ({
  sourceId: source.sourceId,
  digest: source.digest,
  path,
  range,
});

describe('resolveCitation (task 7.5)', () => {
  it('resolves by identifier, digest, and exact returned range', () => {
    const { ledger, diff } = setup();
    const resolution = resolveCitation(ledger, cite(diff, 'src/auth/token.ts', { startLine: 2 }));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.source).toBe(diff);
    expect(resolution.cited).toEqual({ path: 'src/auth/token.ts', range: { startLine: 2, endLine: 2 } });
    expect(resolution.location).toEqual({ path: 'src/auth/token.ts', range: { startLine: 2, endLine: 2 }, side: 'new' });
  });

  it('normalizes the cited path representation without resolving traversal', () => {
    const { ledger, diff } = setup();
    expect(resolveCitation(ledger, cite(diff, './src//auth/token.ts', { startLine: 3 })).ok).toBe(true);
    expect(resolveCitation(ledger, cite(diff, 'src/auth/../auth/token.ts', { startLine: 3 }))).toMatchObject({ ok: false, code: 'pathMismatch', repairable: false });
  });

  it('rejects a fabricated or foreign identifier without any path-based fallback', () => {
    const { ledger, diff } = setup();
    const forged = { ...cite(diff, 'src/auth/token.ts', { startLine: 2 }), sourceId: `ev_${'0'.repeat(32)}` };
    expect(resolveCitation(ledger, forged)).toMatchObject({ ok: false, code: 'unknownSource', repairable: false });
    const otherAttempt = createEvidenceLedger({ ...IDENTITY, attempt: 2 }, [M1, M2]);
    expect(resolveCitation(otherAttempt, cite(diff, 'src/auth/token.ts', { startLine: 2 }))).toMatchObject({ ok: false, code: 'unknownSource' });
  });

  it('rejects a digest that does not match the exact returned bytes', () => {
    const { ledger, diff } = setup();
    const drifted = { ...cite(diff, 'src/auth/token.ts', { startLine: 2 }), digest: sha256Hex('other') };
    expect(resolveCitation(ledger, drifted)).toMatchObject({ ok: false, code: 'digestMismatch', repairable: false });
  });

  it('rejects non-citable policy and detail sources even with a correct digest', () => {
    const { ledger, policy, detail } = setup();
    expect(resolveCitation(ledger, cite(policy, 'AGENTS.md', { startLine: 1 }))).toMatchObject({ ok: false, code: 'nonCitable', repairable: false });
    expect(resolveCitation(ledger, cite(detail, 'anything', { startLine: 1 }))).toMatchObject({ ok: false, code: 'nonCitable' });
  });

  it('treats a missing path or range on a real citable source as repairable, and everything else as rejected', () => {
    const { ledger, diff } = setup();
    expect(resolveCitation(ledger, cite(diff))).toMatchObject({ ok: false, code: 'pathMissing', repairable: true });
    expect(resolveCitation(ledger, cite(diff, 'src/auth/token.ts'))).toMatchObject({ ok: false, code: 'rangeMissing', repairable: true });
    expect(resolveCitation(ledger, cite(diff, 'src/other.ts', { startLine: 2 }))).toMatchObject({ ok: false, code: 'pathMismatch', repairable: false });
    expect(resolveCitation(ledger, cite(diff, 'src/auth/token.ts', { startLine: 9 }))).toMatchObject({ ok: false, code: 'rangeOutsideEvidence', repairable: false });
    expect(resolveCitation(ledger, cite(diff, 'src/auth/token.ts', { startLine: 2, endLine: 3 }))).toMatchObject({ ok: false, code: 'rangeOutsideEvidence' });
  });

  it('rejects malformed input shapes fail-closed', () => {
    const { ledger, diff } = setup();
    expect(resolveCitation(ledger, undefined)).toMatchObject({ ok: false, code: 'malformed' });
    expect(resolveCitation(ledger, 'ev_x')).toMatchObject({ ok: false, code: 'malformed' });
    expect(resolveCitation(ledger, { sourceId: 'src-1', digest: diff.digest })).toMatchObject({ ok: false, code: 'malformed' });
    expect(resolveCitation(ledger, { sourceId: diff.sourceId, digest: 'nothex' })).toMatchObject({ ok: false, code: 'malformed' });
    expect(resolveCitation(ledger, { ...cite(diff, 'src/auth/token.ts'), range: { startLine: 0 } })).toMatchObject({ ok: false, code: 'invalidRange' });
    expect(resolveCitation(ledger, { ...cite(diff, 'src/auth/token.ts'), range: { startLine: 3, endLine: 2 } })).toMatchObject({ ok: false, code: 'invalidRange' });
    expect(resolveCitation(ledger, { ...cite(diff, 'src/auth/token.ts'), range: { startLine: '2' } })).toMatchObject({ ok: false, code: 'invalidRange' });
    expect(parseSourceCitation({ sourceId: diff.sourceId, digest: diff.digest, path: 7 })).toBeUndefined();
  });

  it('enforces member ownership when asked', () => {
    const { ledger, file } = setup();
    expect(resolveCitation(ledger, cite(file, 'src/auth/caller.ts', { startLine: 12 }), { memberId: 'm1' })).toMatchObject({ ok: false, code: 'memberMismatch' });
    expect(resolveCitation(ledger, cite(file, 'src/auth/caller.ts', { startLine: 12 }), { memberId: 'm2' }).ok).toBe(true);
    expect(resolveCitation(ledger, cite(file, 'src/auth/caller.ts', { startLine: 12, endLine: 20 })).ok).toBe(true);
  });
});

describe('resolveCandidateCitations', () => {
  it('requires the primary in the candidate member and lets supporting spans come from other members', () => {
    const { ledger, diff, file } = setup();
    const set = resolveCandidateCitations(ledger, {
      primary: cite(diff, 'src/auth/token.ts', { startLine: 2 }),
      supporting: [cite(file, 'src/auth/caller.ts', { startLine: 15 })],
    }, 'm1');
    expect(set.ok).toBe(true);
    expect(set.supporting[0]?.ok && set.supporting[0].source.memberId).toBe('m2');
    const swapped = resolveCandidateCitations(ledger, { primary: cite(file, 'src/auth/caller.ts', { startLine: 15 }) }, 'm1');
    expect(swapped.ok).toBe(false);
    expect(swapped.repairable).toBe(false);
  });

  it('is repairable only when nothing was rejected outright', () => {
    const { ledger, diff, file } = setup();
    const missingRange = resolveCandidateCitations(ledger, { primary: cite(diff, 'src/auth/token.ts') }, 'm1');
    expect(missingRange).toMatchObject({ ok: false, repairable: true });
    const mixed = resolveCandidateCitations(ledger, {
      primary: cite(diff, 'src/auth/token.ts'),
      supporting: [{ ...cite(file, 'src/auth/caller.ts', { startLine: 15 }), digest: sha256Hex('drift') }],
    }, 'm1');
    expect(mixed).toMatchObject({ ok: false, repairable: false });
  });
});
