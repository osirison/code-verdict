import { describe, expect, it } from 'vitest';
import { sha256Hex } from './contentDigest';
import {
  createCandidateTracker,
  parseCandidateFinding,
  revalidateFindings,
  toCandidateValidationResult,
  validateCandidate,
  type CandidateValidationContext,
  type ValidatedFinding,
} from './harnessCandidateValidation';
import {
  createEvidenceLedger,
  toRetainedEvidenceRecord,
  type EvidenceLedger,
  type EvidenceLedgerMember,
  type LedgerEvidenceSource,
} from './harnessEvidenceLedger';
import type { Attachment } from './reviewContext';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { DiffPageResult, FileRangeResult, InvestigationSnapshotRef } from '../platform/types';

const IDENTITY = { runId: 'run-1', lineageId: 'lineage-1', attempt: 1 };
const M1: EvidenceLedgerMember = { memberId: 'm1', repositoryId: 'repo-1', baseSha: 'base-1', headSha: 'head-1', changeRequestNumber: '2841' };
const M2: EvidenceLedgerMember = { memberId: 'm2', repositoryId: 'repo-2', baseSha: 'base-2', headSha: 'head-2', changeRequestNumber: '77' };
const SNAP1: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
const SNAP2: InvestigationSnapshotRef = { repoId: 'repo-2', baseSha: 'base-2', headSha: 'head-2' };
const NOW = '2026-09-03T10:00:00.000Z';
const PATCH = '@@ -10,3 +10,4 @@\n const token = read();\n+const expiry = token.expires_at;\n+if (!expiry) throw new Error("no expiry");\n return token;';

function diffPage(snapshot = SNAP1, path = 'src/auth/token.ts'): DiffPageResult {
  return {
    state: 'complete',
    snapshot,
    value: {
      path,
      patch: PATCH,
      positions: [
        { path, side: 'new', line: 11 },
        { path, side: 'new', line: 12 },
        { path, side: 'old', line: 10 },
      ],
    },
  };
}

function fileRange(snapshot = SNAP2, path = 'src/api/session.ts'): FileRangeResult {
  return { state: 'complete', snapshot, value: { revision: 'head', path, startLine: 40, endLine: 45, text: 'const expiry = data.expiry;\nreturn expiry;' } };
}

function attachment(path = 'config/schema.ts'): Attachment {
  const content = 'export const schema = {\n  expiry: "number",\n};';
  return {
    id: 'att-1',
    kind: 'file',
    label: 'schema.ts',
    path,
    content,
    truncated: false,
    evidence: [{ path, range: { startLine: 1, endLine: 3 }, contentStart: 0, contentEnd: content.length }],
  };
}

interface Fixture {
  ledger: EvidenceLedger;
  diff: LedgerEvidenceSource;
  file: LedgerEvidenceSource;
  attachment: LedgerEvidenceSource;
  context: CandidateValidationContext;
}

function setup(options: { changedPaths?: string[] } = {}): Fixture {
  const ledger = createEvidenceLedger(IDENTITY, [M1, M2]);
  const diff = ledger.registerDiffPage('m1', diffPage());
  const file = ledger.registerFileRange('m2', fileRange());
  const att = ledger.registerAttachment('m1', attachment(), sha256Hex(attachment().content));
  if (!diff.ok || !file.ok || !att.ok) throw new Error('setup failed');
  const changed = new Map<string, ReadonlySet<string>>([['m1', new Set(options.changedPaths ?? ['src/auth/token.ts'])]]);
  return {
    ledger,
    diff: diff.source,
    file: file.source,
    attachment: att.source,
    context: { ledger, criteria: DEFAULT_CRITERIA, changedPathsByMember: changed, now: NOW },
  };
}

const cite = (source: LedgerEvidenceSource, path: string, startLine: number, endLine?: number) => ({
  sourceId: source.sourceId,
  digest: source.digest,
  path,
  range: { startLine, endLine },
});

function candidate(fixture: Fixture, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    candidateId: 'cand-1',
    memberId: 'm1',
    file: 'src/auth/token.ts',
    line: 12,
    severity: 'major',
    category: 'errorHandling',
    confidence: 90,
    title: 'Throws on missing expiry',
    body: 'A token without expiry aborts the request.',
    code: 'throw new Error("no expiry")',
    citations: { primary: cite(fixture.diff, 'src/auth/token.ts', 12) },
    ...overrides,
  };
}

function accepted(fixture: Fixture, overrides: Record<string, unknown> = {}): ValidatedFinding {
  const outcome = validateCandidate(candidate(fixture, overrides), fixture.context);
  if (outcome.state !== 'accepted') throw new Error(`expected accepted, got ${outcome.state}: ${JSON.stringify(outcome.reasons)}`);
  return outcome.finding;
}

describe('validateCandidate (task 7.6)', () => {
  it('accepts a candidate whose diff citation resolves and converts it to an inline finding with harness provenance', () => {
    const fixture = setup();
    const finding = accepted(fixture);
    expect(finding.routing).toBe('inline');
    expect(finding.item).toMatchObject({
      id: 'cand-1',
      file: 'src/auth/token.ts',
      anchored: true,
      line: 12,
      severity: 'major',
      category: 'errorHandling',
      confidence: 90,
      repoId: 'repo-1',
      crNumber: '2841',
      code: 'throw new Error("no expiry")',
    });
    expect(finding.provenance).toEqual({
      protocolProvenance: 'harness',
      citations: [{ sourceId: fixture.diff.sourceId, digest: fixture.diff.digest, path: 'src/auth/token.ts', range: { startLine: 12, endLine: 12 } }],
      validatedAt: NOW,
    });
    expect(finding.evidence).toMatchObject({ repositoryId: 'repo-1', baseSha: 'base-1', headSha: 'head-1', primary: { origin: 'diffPage' }, supporting: [] });
    expect(JSON.stringify(finding)).not.toContain('expires_at'); // no exact evidence bytes leave the ledger
    expect(JSON.stringify(finding)).not.toContain('exactContent');
  });

  it('carries supporting spans from another member with their own repository and revision identity', () => {
    const fixture = setup();
    const finding = accepted(fixture, {
      line: 11,
      citations: { primary: cite(fixture.diff, 'src/auth/token.ts', 11), supporting: [cite(fixture.file, 'src/api/session.ts', 41)] },
      code: undefined,
    });
    expect(finding.evidence.supporting).toEqual([
      expect.objectContaining({ sourceId: fixture.file.sourceId, memberId: 'm2', repositoryId: 'repo-2', headSha: 'head-2', origin: 'fileRange', path: 'src/api/session.ts', range: { startLine: 41, endLine: 41 } }),
    ]);
    expect(finding.provenance.citations).toHaveLength(2);
  });

  it('rejects schema failures fail-closed and reports each of them', () => {
    const fixture = setup();
    const outcome = validateCandidate(candidate(fixture, { line: 0, severity: 'urgent', category: 'vibes', confidence: Number.NaN, title: '' }), fixture.context);
    expect(outcome.state).toBe('rejected');
    expect(outcome.reasons.map((reason) => reason.code)).toEqual(['schema', 'schema', 'schema', 'schema', 'schema']);
    expect(validateCandidate(null, fixture.context)).toMatchObject({ state: 'rejected', candidateId: '' });
    expect(validateCandidate(candidate(fixture, { citations: undefined }), fixture.context)).toMatchObject({ state: 'rejected' });
    expect(parseCandidateFinding(candidate(fixture, { suggestion: 'not-an-object' }))).toMatchObject({ reasons: [{ code: 'schema' }] });
    expect(parseCandidateFinding(candidate(fixture, { code: 42 }))).toMatchObject({ reasons: [{ code: 'schema' }] });
  });

  it('rejects an unknown member before touching citations', () => {
    const fixture = setup();
    expect(validateCandidate(candidate(fixture, { memberId: 'm9' }), fixture.context)).toMatchObject({ state: 'rejected', reasons: [{ code: 'unknownMember' }] });
  });

  it('rejects a location outside the cited evidence and a file that differs from the citation', () => {
    const fixture = setup();
    expect(validateCandidate(candidate(fixture, { line: 13, citations: { primary: cite(fixture.diff, 'src/auth/token.ts', 12) } }), fixture.context))
      .toMatchObject({ state: 'rejected', reasons: [{ code: 'locationOutsideEvidence' }] });
    expect(validateCandidate(candidate(fixture, { file: 'src/auth/other.ts' }), fixture.context))
      .toMatchObject({ state: 'rejected', reasons: [{ code: 'locationMismatch' }] });
  });

  it('rejects quoted code that does not appear in the primary evidence', () => {
    const fixture = setup();
    expect(validateCandidate(candidate(fixture, { code: 'eval(userInput)' }), fixture.context)).toMatchObject({ state: 'rejected', reasons: [{ code: 'codeNotInEvidence' }] });
  });

  it('applies criteria as a host filter and keeps the bucket', () => {
    const fixture = setup();
    const below = validateCandidate(candidate(fixture, { confidence: 10 }), fixture.context);
    expect(below).toMatchObject({ state: 'rejected', criteriaReason: 'belowConfidence', reasons: [{ code: 'criteria:belowConfidence' }] });
    const offCategory = validateCandidate(candidate(fixture, { category: 'style' }), fixture.context);
    expect(offCategory).toMatchObject({ state: 'rejected', criteriaReason: 'categoryOff' });
    expect(toCandidateValidationResult(offCategory)).toEqual({ state: 'rejected', reasons: ['criteria:categoryOff: Candidate falls below the run criteria.'] });
  });

  it('returns repairable when the only problems are incomplete locations on real citable evidence', () => {
    const fixture = setup();
    const outcome = validateCandidate(candidate(fixture, { citations: { primary: { sourceId: fixture.diff.sourceId, digest: fixture.diff.digest, path: 'src/auth/token.ts' } } }), fixture.context);
    expect(outcome).toMatchObject({ state: 'repairable', reasons: [{ code: 'primary:rangeMissing' }] });
    const mixed = validateCandidate(candidate(fixture, {
      citations: {
        primary: cite(fixture.diff, 'src/auth/token.ts', 12),
        supporting: [{ sourceId: fixture.file.sourceId, digest: fixture.file.digest }],
      },
    }), fixture.context);
    expect(mixed).toMatchObject({ state: 'repairable', reasons: [{ code: 'supporting[0]:pathMissing' }] });
  });

  it('rejects when any citation is rejected, even if another is only repairable', () => {
    const fixture = setup();
    const outcome = validateCandidate(candidate(fixture, {
      citations: {
        primary: { sourceId: fixture.diff.sourceId, digest: fixture.diff.digest, path: 'src/auth/token.ts' },
        supporting: [{ ...cite(fixture.file, 'src/api/session.ts', 41), digest: sha256Hex('drift') }],
      },
    }), fixture.context);
    expect(outcome.state).toBe('rejected');
    expect(outcome.reasons.map((reason) => reason.code)).toEqual(['supporting[0]:digestMismatch', 'primary:rangeMissing']);
  });
});

describe('primary-target eligibility (task 7.7)', () => {
  it('lets unchanged repository evidence corroborate but not become the primary target', () => {
    const fixture = setup();
    const asPrimary = validateCandidate(candidate(fixture, {
      memberId: 'm2',
      file: 'src/api/session.ts',
      line: 41,
      code: undefined,
      citations: { primary: cite(fixture.file, 'src/api/session.ts', 41) },
    }), fixture.context);
    expect(asPrimary).toMatchObject({ state: 'rejected', reasons: [{ code: 'unchangedPrimaryTarget' }] });
    const asSupport = accepted(fixture, { citations: { primary: cite(fixture.diff, 'src/auth/token.ts', 12), supporting: [cite(fixture.file, 'src/api/session.ts', 41)] } });
    expect(asSupport.evidence.supporting[0]?.origin).toBe('fileRange');
  });

  it('rejects search excerpts as a primary target', () => {
    const fixture = setup();
    const search = fixture.ledger.registerRepositorySearch('m1', { snapshot: SNAP1, revision: 'head', query: 'expiry' }, {
      state: 'complete',
      snapshot: SNAP1,
      value: [{ path: 'src/legacy/expiry.ts', line: 5, excerpt: 'expiry = null' }],
    });
    if (!search.ok) throw new Error(search.message);
    const outcome = validateCandidate(candidate(fixture, { file: 'src/legacy/expiry.ts', line: 5, code: undefined, citations: { primary: cite(search.source, 'src/legacy/expiry.ts', 5) } }), fixture.context);
    expect(outcome).toMatchObject({ state: 'rejected', reasons: [{ code: 'unchangedPrimaryTarget' }] });
  });

  it('accepts an explicit attachment as primary, routing to the summary when its file is not changed', () => {
    const fixture = setup();
    const finding = accepted(fixture, {
      file: 'config/schema.ts',
      line: 2,
      code: 'expiry: "number"',
      citations: { primary: cite(fixture.attachment, 'config/schema.ts', 2) },
    });
    expect(finding.routing).toBe('summary');
    expect(finding.item.anchored).toBe(false);
    expect(finding.evidence.primary.origin).toBe('attachment');
  });

  it('routes an attachment inline when the same path is also a changed file of that member', () => {
    const fixture = setup({ changedPaths: ['src/auth/token.ts', './config//schema.ts'] });
    const finding = accepted(fixture, {
      file: 'config/schema.ts',
      line: 2,
      code: undefined,
      citations: { primary: cite(fixture.attachment, 'config/schema.ts', 2) },
    });
    expect(finding.routing).toBe('inline');
    expect(finding.item.anchored).toBe(true);
  });

  it('never routes an attachment inline when no changed paths are known', () => {
    const fixture = setup();
    const context = { ...fixture.context, changedPathsByMember: undefined };
    const outcome = validateCandidate(candidate(fixture, { file: 'config/schema.ts', line: 1, code: undefined, citations: { primary: cite(fixture.attachment, 'config/schema.ts', 1) } }), context);
    expect(outcome).toMatchObject({ state: 'accepted', finding: { routing: 'summary' } });
  });
});

describe('revalidation and unresolved tracking (task 7.8)', () => {
  it('keeps findings whose citations still resolve and refreshes validatedAt', () => {
    const fixture = setup();
    const finding = accepted(fixture);
    const result = revalidateFindings([finding], { ledger: fixture.ledger, now: '2026-09-03T11:00:00.000Z' });
    expect(result.invalidated).toEqual([]);
    expect(result.valid[0]?.provenance.validatedAt).toBe('2026-09-03T11:00:00.000Z');
  });

  it('invalidates a finding when its member head moved', () => {
    const fixture = setup();
    const finding = accepted(fixture);
    const result = revalidateFindings([finding], { ledger: fixture.ledger, currentHeads: new Map([['m1', 'head-2']]), now: NOW });
    expect(result.valid).toEqual([]);
    expect(result.invalidated[0]?.reasons).toEqual([{ code: 'headChanged', message: expect.stringContaining('head-2') }]);
  });

  it('invalidates a finding whose evidence is absent from a resumed ledger, and re-validates once the exact source is imported', () => {
    const fixture = setup();
    const finding = accepted(fixture, { citations: { primary: cite(fixture.diff, 'src/auth/token.ts', 12), supporting: [cite(fixture.file, 'src/api/session.ts', 41)] } });
    const resumed = createEvidenceLedger({ ...IDENTITY, attempt: 2 }, [M1, M2]);
    const missing = revalidateFindings([finding], { ledger: resumed, now: NOW });
    expect(missing.invalidated[0]?.reasons.map((reason) => reason.code)).toEqual(['primary:unknownSource', 'supporting[0]:unknownSource']);

    expect(resumed.importRetainedSource(toRetainedEvidenceRecord(fixture.diff, { includeExactContent: true })).ok).toBe(true);
    expect(resumed.importRetainedSource(toRetainedEvidenceRecord(fixture.file, { includeExactContent: true })).ok).toBe(true);
    const restored = revalidateFindings([finding], { ledger: resumed, now: NOW });
    expect(restored.invalidated).toEqual([]);
    expect(restored.valid).toHaveLength(1);
  });

  it('invalidates a finding whose retained digest no longer matches the ledger source', () => {
    const fixture = setup();
    const finding = accepted(fixture);
    const tampered: ValidatedFinding = {
      ...finding,
      evidence: { ...finding.evidence, primary: { ...finding.evidence.primary, digest: sha256Hex('other bytes') } },
    };
    const result = revalidateFindings([tampered], { ledger: fixture.ledger, now: NOW });
    expect(result.invalidated[0]?.reasons[0]?.code).toBe('primary:digestMismatch');
  });

  it('tracks unresolved candidates out of triage and blocks completion until resolved or rejected', () => {
    const fixture = setup();
    const tracker = createCandidateTracker({ maxRepairsPerCandidate: 1 });
    const repairable = validateCandidate(candidate(fixture, { citations: { primary: { sourceId: fixture.diff.sourceId, digest: fixture.diff.digest, path: 'src/auth/token.ts' } } }), fixture.context);
    expect(tracker.record(repairable)).toMatchObject({ state: 'unresolved', repairs: 0 });
    expect(tracker.blocksCompletion()).toBe(true);
    expect(tracker.triageFindings()).toEqual([]);

    expect(tracker.record(repairable)).toMatchObject({ state: 'unresolved', repairs: 1 });
    expect(tracker.record(repairable)).toMatchObject({ state: 'rejected', repairs: 2, reasons: [{ code: 'repairLimit' }, { code: 'primary:rangeMissing' }] });
    expect(tracker.blocksCompletion()).toBe(false);
    expect(tracker.record(validateCandidate(candidate(fixture), fixture.context)).state).toBe('rejected'); // closed ids stay closed

    const good = validateCandidate(candidate(fixture, { candidateId: 'cand-2' }), fixture.context);
    expect(tracker.record(good).state).toBe('accepted');
    expect(tracker.triageFindings().map((finding) => finding.candidateId)).toEqual(['cand-2']);
    expect(tracker.blocksCompletion()).toBe(false);

    tracker.invalidate('cand-2', [{ code: 'headChanged', message: 'moved' }]);
    expect(tracker.get('cand-2')).toMatchObject({ state: 'unresolved' });
    expect(tracker.triageFindings()).toEqual([]);
    expect(tracker.unresolvedCount()).toBe(1);
    expect(tracker.blocksCompletion()).toBe(true);
    expect(tracker.invalidate('nope', [])).toBeUndefined();
    expect(Object.isFrozen(tracker.all()[0])).toBe(true);
  });

  it('a repaired resubmission that succeeds clears the unresolved state', () => {
    const fixture = setup();
    const tracker = createCandidateTracker();
    tracker.record(validateCandidate(candidate(fixture, { citations: { primary: { sourceId: fixture.diff.sourceId, digest: fixture.diff.digest } } }), fixture.context));
    expect(tracker.blocksCompletion()).toBe(true);
    tracker.record(validateCandidate(candidate(fixture), fixture.context));
    expect(tracker.blocksCompletion()).toBe(false);
    expect(tracker.triageFindings()).toHaveLength(1);
  });
});
