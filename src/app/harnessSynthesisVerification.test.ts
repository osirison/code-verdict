import { describe, expect, it } from 'vitest';
import {
  buildContradictionDirective,
  CONTRADICTION_CHECK_MARKER,
  createSynthesisVerification,
  deduplicateFindings,
  parseContradictionVerdict,
  runContradictionChecks,
  type ContradictionCheckContext,
} from './harnessSynthesisVerification';
import { validateCandidate, type ValidatedFinding } from './harnessCandidateValidation';
import { createEvidenceLedger, type EvidenceLedger, type EvidenceLedgerMember, type LedgerEvidenceSource } from './harnessEvidenceLedger';
import type { HarnessModelSeam, SynthesisVerificationInput } from './harnessAttempt';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import type { AgentCancellationToken } from './lmAgent';
import type { DiffPageResult, InvestigationSnapshotRef } from '../platform/types';

// ---- Fixtures -----------------------------------------------------------------------

const IDENTITY = { runId: 'run-1', lineageId: 'lineage-1', attempt: 1 };
const M1: EvidenceLedgerMember = { memberId: 'm1', repositoryId: 'repo-1', baseSha: 'base-1', headSha: 'head-1', changeRequestNumber: '1' };
const SNAP: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };
const NOW = '2026-09-03T10:00:00.000Z';

function testPolicy(overrides: Partial<HarnessPolicy> = {}): HarnessPolicy {
  return normalizeHarnessPolicy({
    maxElapsedMsPerAttempt: 10_000_000,
    maxModelTurnsPerAttempt: 200,
    maxToolRequestsPerAttempt: 200,
    maxToolRequestsPerTurn: 50,
    maxToolResultBytes: 1_000_000,
    maxEvidenceBytesPerAttempt: 10_000_000,
    manifestPageSize: 1000,
    diffOrFileReadPageLines: 1000,
    protocolRepairsPerPhase: 2,
    checkpointCadenceToolCalls: 1000,
    ...overrides,
  });
}

function diffPage(path: string, patch: string, endLine: number): DiffPageResult {
  return { state: 'complete', snapshot: SNAP, value: { path, patch, positions: [{ path, side: 'new', line: 1, endLine }] } };
}

function makeLedger(): EvidenceLedger {
  return createEvidenceLedger(IDENTITY, [M1]);
}

function registerDiff(ledger: EvidenceLedger, path: string, patch: string, endLine = 5): LedgerEvidenceSource {
  const outcome = ledger.registerDiffPage('m1', diffPage(path, patch, endLine));
  if (!outcome.ok) throw new Error(`failed to register diff: ${outcome.message}`);
  return outcome.source;
}

function candidateRaw(overrides: Record<string, unknown>, source: LedgerEvidenceSource, path: string, startLine = 1, endLine = 5): Record<string, unknown> {
  return {
    candidateId: 'cand-default',
    memberId: 'm1',
    file: path,
    line: startLine,
    endLine,
    severity: 'minor',
    category: 'errorHandling',
    confidence: 90,
    title: 'A default title',
    body: 'A default body.',
    citations: { primary: { sourceId: source.sourceId, digest: source.digest, path, range: { startLine, endLine } } },
    ...overrides,
  };
}

function accept(ledger: EvidenceLedger, raw: Record<string, unknown>): ValidatedFinding {
  const outcome = validateCandidate(raw, { ledger, criteria: DEFAULT_CRITERIA, now: NOW });
  if (outcome.state !== 'accepted') throw new Error(`expected accepted, got ${outcome.state}: ${JSON.stringify(outcome.reasons)}`);
  return outcome.finding;
}

// ---- Stage 1: deduplicateFindings ----------------------------------------------------

describe('deduplicateFindings (task 10.6, stage 1)', () => {
  it('merges two candidates at overlapping primary locations with the same semantic claim into one finding', () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/a.ts', '@@ -1,5 +1,5 @@\n+line one\n+line two\n+line three\n+line four\n+line five');
    const a = accept(ledger, candidateRaw({ candidateId: 'cand-b', severity: 'minor', confidence: 75, title: 'Missing null check', category: 'errorHandling' }, source, 'src/a.ts', 1, 3));
    const b = accept(ledger, candidateRaw({ candidateId: 'cand-a', severity: 'major', confidence: 90, title: 'missing   NULL check', category: 'errorHandling' }, source, 'src/a.ts', 2, 4));

    const result = deduplicateFindings([a, b]);

    expect(result).toHaveLength(1);
    const merged = result[0] as ValidatedFinding;
    // Representative: lexicographically smallest candidateId.
    expect(merged.candidateId).toBe('cand-a');
    // Severity: the higher of the two survives.
    expect(merged.item.severity).toBe('major');
    // Confidence: the maximum of the two survives.
    expect(merged.item.confidence).toBe(90);
    // The representative's own primary citation/location is untouched.
    expect(merged.evidence.primary.range).toEqual({ startLine: 2, endLine: 4 });
    // The absorbed candidate's primary citation becomes a supporting citation.
    expect(merged.evidence.supporting.some((ref) => ref.sourceId === b.evidence.primary.sourceId && ref.range.startLine === 1 && ref.range.endLine === 3)).toBe(true);
    // provenance.citations reflects the merged evidence set (primary + supporting).
    expect(merged.provenance.citations).toHaveLength(1 + merged.evidence.supporting.length);
  });

  it('keeps two candidates separate when their locations overlap but the semantic claim differs', () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/b.ts', '@@ -1,5 +1,5 @@\n+line one\n+line two\n+line three\n+line four\n+line five');
    const a = accept(ledger, candidateRaw({ candidateId: 'cand-x', title: 'Missing null check', category: 'errorHandling' }, source, 'src/b.ts', 1, 3));
    const b = accept(ledger, candidateRaw({ candidateId: 'cand-y', title: 'Hardcoded secret value', category: 'security' }, source, 'src/b.ts', 1, 3));

    const result = deduplicateFindings([a, b]);

    expect(result.map((f) => f.candidateId).sort()).toEqual(['cand-x', 'cand-y']);
  });

  it('keeps two candidates separate when the semantic claim matches but locations do not overlap', () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/c.ts', '@@ -1,5 +1,5 @@\n+line one\n+line two\n+line three\n+line four\n+line five');
    const a = accept(ledger, candidateRaw({ candidateId: 'cand-p', title: 'Missing null check', category: 'errorHandling' }, source, 'src/c.ts', 1, 1));
    const b = accept(ledger, candidateRaw({ candidateId: 'cand-q', title: 'Missing null check', category: 'errorHandling' }, source, 'src/c.ts', 5, 5));

    const result = deduplicateFindings([a, b]);

    expect(result.map((f) => f.candidateId).sort()).toEqual(['cand-p', 'cand-q']);
  });

  it('is genuinely deterministic: a shuffled input order produces an identical result', () => {
    const ledger = makeLedger();
    const source = registerDiff(
      ledger,
      'src/d.ts',
      '@@ -1,10 +1,10 @@\n+one\n+two\n+three\n+four\n+five\n+six\n+seven\n+eight\n+nine\n+ten',
      10,
    );
    const findings = [
      accept(ledger, candidateRaw({ candidateId: 'cand-1', title: 'Missing null check', category: 'errorHandling', severity: 'minor', confidence: 70 }, source, 'src/d.ts', 1, 2)),
      accept(ledger, candidateRaw({ candidateId: 'cand-2', title: 'missing null check', category: 'errorHandling', severity: 'blocker', confidence: 95 }, source, 'src/d.ts', 2, 3)),
      accept(ledger, candidateRaw({ candidateId: 'cand-3', title: 'Hardcoded secret', category: 'security', severity: 'major', confidence: 80 }, source, 'src/d.ts', 5, 5)),
      accept(ledger, candidateRaw({ candidateId: 'cand-4', title: 'Unrelated at a far location', category: 'performance', severity: 'minor', confidence: 75 }, source, 'src/d.ts', 9, 9)),
    ];

    const forward = deduplicateFindings(findings);
    // A fixed, non-trivial shuffle (reverse, then swap the middle pair) — not just a rotation.
    const shuffled = [findings[3], findings[1], findings[0], findings[2]] as ValidatedFinding[];
    const fromShuffled = deduplicateFindings(shuffled);

    expect(fromShuffled.map((f) => f.candidateId)).toEqual(forward.map((f) => f.candidateId));
    expect(fromShuffled.map((f) => f.item.severity)).toEqual(forward.map((f) => f.item.severity));
    expect(fromShuffled.map((f) => f.item.confidence)).toEqual(forward.map((f) => f.item.confidence));
    expect(fromShuffled.map((f) => f.evidence.supporting.length)).toEqual(forward.map((f) => f.evidence.supporting.length));
    // Two distinct surviving findings: the merged errorHandling claim (cand-1+cand-2) and the two standalone ones.
    expect(forward).toHaveLength(3);
    expect(forward.map((f) => f.candidateId)).toEqual(['cand-1', 'cand-3', 'cand-4']);
  });

  it('passes a single candidate through unchanged (no group to merge)', () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/e.ts', '@@ -1,1 +1,1 @@\n+only line');
    const a = accept(ledger, candidateRaw({ candidateId: 'cand-solo' }, source, 'src/e.ts', 1, 1));

    const result = deduplicateFindings([a]);

    expect(result).toEqual([a]);
  });

  it('handles zero findings', () => {
    expect(deduplicateFindings([])).toEqual([]);
  });
});

// ---- Stage 2: runContradictionChecks -------------------------------------------------

function scriptedSeam(respond: (repairInstruction: string | undefined) => string, modelId = 'test-model'): HarnessModelSeam & { calls: number } {
  const seam = {
    modelId,
    calls: 0,
    async askModel({ repairInstruction }: { repairInstruction: string | undefined }) {
      seam.calls += 1;
      return respond(repairInstruction);
    },
  };
  return seam;
}

function verdictJson(candidateId: string, contradicted: boolean, reason?: string): string {
  return JSON.stringify({ candidateId, contradicted, ...(reason !== undefined ? { reason } : {}) });
}

function extractCandidateId(repairInstruction: string | undefined): string {
  const match = /^candidateId: (.+)$/m.exec(repairInstruction ?? '');
  if (!match) throw new Error('no candidateId in directive');
  return match[1] as string;
}

describe('buildContradictionDirective / parseContradictionVerdict', () => {
  it('the directive names the candidate and carries the exact ledger bytes, not a re-read by path', () => {
    const ledger = makeLedger();
    const patch = '@@ -1,1 +1,1 @@\n+const secret = "abc123";';
    const source = registerDiff(ledger, 'src/f.ts', patch);
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-evidence', title: 'Hardcoded secret', category: 'security' }, source, 'src/f.ts', 1, 1));

    const directive = buildContradictionDirective(finding, source);

    expect(directive.startsWith(CONTRADICTION_CHECK_MARKER)).toBe(true);
    expect(directive).toContain('candidateId: cand-evidence');
    expect(directive).toContain(`sourceId: ${source.sourceId}`);
    expect(directive).toContain(`digest: ${source.digest}`);
    // The exact bytes the ledger stored for this source, verbatim.
    expect(directive).toContain(patch);
  });

  it('rejects a verdict whose candidateId does not match (binding), a non-boolean contradicted, and garbage text', () => {
    expect(parseContradictionVerdict(verdictJson('other-id', false), 'cand-1')).toBeUndefined();
    expect(parseContradictionVerdict(JSON.stringify({ candidateId: 'cand-1', contradicted: 'yes' }), 'cand-1')).toBeUndefined();
    expect(parseContradictionVerdict('not json at all', 'cand-1')).toBeUndefined();
  });

  it('accepts a well-formed verdict, sanitizing the reason when contradicted', () => {
    const ok = parseContradictionVerdict(verdictJson('cand-1', true, 'The evidence shows the opposite.'), 'cand-1');
    expect(ok).toEqual({ contradicted: true, reason: 'The evidence shows the opposite.' });
    const clean = parseContradictionVerdict(verdictJson('cand-1', false), 'cand-1');
    expect(clean).toEqual({ contradicted: false });
  });
});

describe('runContradictionChecks (task 10.6, stage 2)', () => {
  function context(seam: HarnessModelSeam, ledger: EvidenceLedger, overrides: Partial<ContradictionCheckContext> = {}): ContradictionCheckContext {
    return { modelSeam: seam, ledger, policy: testPolicy(), ...overrides };
  }

  it('a contradicted finding is excluded from survivors and recorded with a bounded public reason', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/g.ts', '@@ -1,1 +1,1 @@\n+return unsanitized(input);');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-contra', title: 'Unsanitized input reaches a sink' }, source, 'src/g.ts', 1, 1));
    const seam = scriptedSeam((repair) => verdictJson(extractCandidateId(repair), true, 'The value is sanitized two lines above the citation.'));

    const result = await runContradictionChecks([finding], context(seam, ledger));

    expect(result.findings).toHaveLength(0);
    expect(result.contradicted).toEqual([{ candidateId: 'cand-contra', reason: 'The value is sanitized two lines above the citation.' }]);
    expect(result.complete).toBe(true);
  });

  it('a non-contradicted finding survives untouched, and the stage reports complete', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/h.ts', '@@ -1,1 +1,1 @@\n+return safe(input);');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-safe' }, source, 'src/h.ts', 1, 1));
    const seam = scriptedSeam((repair) => verdictJson(extractCandidateId(repair), false));

    const result = await runContradictionChecks([finding], context(seam, ledger));

    expect(result.findings).toEqual([finding]);
    expect(result.contradicted).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it('zero findings makes zero model calls and reports complete', async () => {
    const ledger = makeLedger();
    const seam = scriptedSeam(() => {
      throw new Error('should never be called for zero findings');
    });

    const result = await runContradictionChecks([], context(seam, ledger));

    expect(result).toEqual({ findings: [], contradicted: [], complete: true });
    expect(seam.calls).toBe(0);
  });

  it('an exhausted repair allowance leaves the finding unconfirmed: kept, but the stage is incomplete', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/i.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-malformed' }, source, 'src/i.ts', 1, 1));
    const seam = scriptedSeam(() => 'not parseable as a verdict at all');

    const result = await runContradictionChecks([finding], context(seam, ledger, { policy: testPolicy({ protocolRepairsPerPhase: 2 }) }));

    expect(result.findings).toEqual([finding]);
    expect(result.contradicted).toEqual([]);
    expect(result.complete).toBe(false);
    // Exactly 1 + maxRepairs asks for this one finding.
    expect(seam.calls).toBe(3);
  });

  it('a shared repair allowance across findings: a malformed response on one finding does not grant extra retries to the next', async () => {
    const ledger = makeLedger();
    const source1 = registerDiff(ledger, 'src/j.ts', '@@ -1,1 +1,1 @@\n+first();');
    const source2 = registerDiff(ledger, 'src/k.ts', '@@ -1,1 +1,1 @@\n+second();');
    const findingA = accept(ledger, candidateRaw({ candidateId: 'cand-a1' }, source1, 'src/j.ts', 1, 1));
    const findingB = accept(ledger, candidateRaw({ candidateId: 'cand-a2' }, source2, 'src/k.ts', 1, 1));
    // cand-a1 always malformed (consumes the whole 1-repair allowance); cand-a2 also always malformed.
    const seam = scriptedSeam(() => 'garbage');

    const result = await runContradictionChecks([findingA, findingB], context(seam, ledger, { policy: testPolicy({ protocolRepairsPerPhase: 1 }) }));

    expect(result.complete).toBe(false);
    expect(result.findings.map((f) => f.candidateId).sort()).toEqual(['cand-a1', 'cand-a2']);
    // cand-a1: 1 initial + 1 repair = 2 asks, exhausting the shared allowance; cand-a2 then gets only its own 1 initial ask (no repair left).
    expect(seam.calls).toBe(3);
  });

  it('evidence that no longer matches its recorded digest is treated as an unresolvable mismatch: excluded and recorded, stage incomplete', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/l.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-tamper' }, source, 'src/l.ts', 1, 1));
    const tampered: ValidatedFinding = { ...finding, evidence: { ...finding.evidence, primary: { ...finding.evidence.primary, digest: '0'.repeat(64) } } };
    const seam = scriptedSeam(() => {
      throw new Error('should never ask the model when the digest cannot be verified');
    });

    const result = await runContradictionChecks([tampered], context(seam, ledger));

    expect(result.findings).toEqual([]);
    expect(result.contradicted).toHaveLength(1);
    expect(result.contradicted[0]?.candidateId).toBe('cand-tamper');
    expect(result.complete).toBe(false);
    expect(seam.calls).toBe(0);
  });

  it('cancellation stops the stage and keeps every not-yet-checked finding unconfirmed rather than dropping it', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/m.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const findingA = accept(ledger, candidateRaw({ candidateId: 'cand-c1' }, source, 'src/m.ts', 1, 1));
    const findingB = accept(ledger, candidateRaw({ candidateId: 'cand-c2' }, source, 'src/m.ts', 1, 1));
    let cancelled = false;
    const cancellation: AgentCancellationToken = {
      get isCancellationRequested() {
        return cancelled;
      },
      onCancellationRequested: () => ({ dispose() {} }),
    };
    const seam = scriptedSeam((repair) => {
      cancelled = true; // cancel as soon as the first ask happens
      return verdictJson(extractCandidateId(repair), false);
    });

    const result = await runContradictionChecks([findingA, findingB], context(seam, ledger, { cancellation }));

    expect(result.complete).toBe(false);
    // findingA already got a (valid) answer before cancellation landed; findingB is cancelled before its own ask.
    expect(result.findings.map((f) => f.candidateId).sort()).toEqual(['cand-c1', 'cand-c2']);
    expect(seam.calls).toBe(1);
  });

  it('the deterministic ask order follows sorted candidateId, independent of input order', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/n.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const findingB = accept(ledger, candidateRaw({ candidateId: 'cand-zzz' }, source, 'src/n.ts', 1, 1));
    const findingA = accept(ledger, candidateRaw({ candidateId: 'cand-aaa' }, source, 'src/n.ts', 1, 1));
    const seen: string[] = [];
    const seam = scriptedSeam((repair) => {
      seen.push(extractCandidateId(repair));
      return verdictJson(extractCandidateId(repair), false);
    });

    await runContradictionChecks([findingB, findingA], context(seam, ledger));

    expect(seen).toEqual(['cand-aaa', 'cand-zzz']);
  });
});

// ---- Adapter: createSynthesisVerification --------------------------------------------

describe('createSynthesisVerification (the injected SynthesisVerificationRunner)', () => {
  function input(overrides: Partial<SynthesisVerificationInput>, ledger: EvidenceLedger, seam: HarnessModelSeam): SynthesisVerificationInput {
    return {
      modelSeam: seam,
      ledger,
      findings: [],
      dispatch: async () => {
        throw new Error('dispatch should not be called by this adapter in these tests');
      },
      policy: testPolicy(),
      elapsedMs: () => 0,
      ...overrides,
    };
  }

  it('runs both stages and reports every pass complete when nothing is contradicted', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/o.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-p1' }, source, 'src/o.ts', 1, 1));
    const seam = scriptedSeam((repair) => verdictJson(extractCandidateId(repair), false));
    const runner = createSynthesisVerification();

    const output = await runner(input({ findings: [finding] }, ledger, seam));

    expect(output.findings).toEqual([finding]);
    expect(output.deduplicationComplete).toBe(true);
    expect(output.contradictionPassComplete).toBe(true);
    expect(output.finalVerificationComplete).toBe(true);
    expect(output.contradicted).toEqual([]);
  });

  it('a contradicted finding is removed from output.findings and appears in output.contradicted, but every pass still reports complete (the stage ran fully)', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/p.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-p2' }, source, 'src/p.ts', 1, 1));
    const seam = scriptedSeam((repair) => verdictJson(extractCandidateId(repair), true, 'Contradicted by context two lines up.'));
    const runner = createSynthesisVerification();

    const output = await runner(input({ findings: [finding] }, ledger, seam));

    expect(output.findings).toEqual([]);
    expect(output.contradicted).toEqual([{ candidateId: 'cand-p2', reason: 'Contradicted by context two lines up.' }]);
    expect(output.contradictionPassComplete).toBe(true);
    expect(output.deduplicationComplete).toBe(true);
  });

  it('runs zero model calls and reports every pass complete for a clean (zero-finding) input', async () => {
    const ledger = makeLedger();
    const seam = scriptedSeam(() => {
      throw new Error('should never be called with zero findings');
    });
    const runner = createSynthesisVerification();

    const output = await runner(input({ findings: [] }, ledger, seam));

    expect(output.findings).toEqual([]);
    expect(output.deduplicationComplete).toBe(true);
    expect(output.contradictionPassComplete).toBe(true);
    expect(output.finalVerificationComplete).toBe(true);
    expect(seam.calls).toBe(0);
  });

  it('cancellation before the collaborator starts skips both stages entirely: every flag stays false, findings pass through unchanged', async () => {
    const ledger = makeLedger();
    const source = registerDiff(ledger, 'src/q.ts', '@@ -1,1 +1,1 @@\n+doSomething();');
    const finding = accept(ledger, candidateRaw({ candidateId: 'cand-p3' }, source, 'src/q.ts', 1, 1));
    const seam = scriptedSeam(() => {
      throw new Error('should never be called once cancelled');
    });
    const cancellation: AgentCancellationToken = { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) };
    const runner = createSynthesisVerification();

    const output = await runner(input({ findings: [finding], cancellation }, ledger, seam));

    expect(output.findings).toEqual([finding]);
    expect(output.deduplicationComplete).toBe(false);
    expect(output.contradictionPassComplete).toBe(false);
    expect(output.finalVerificationComplete).toBe(false);
    expect(seam.calls).toBe(0);
  });
});
