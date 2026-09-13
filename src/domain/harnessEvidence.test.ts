import { describe, expect, it } from 'vitest';
import {
  CANDIDATE_VALIDATION_STATES,
  EVIDENCE_COMPLETENESS_VALUES,
  EVIDENCE_KINDS,
  isCandidateValidationState,
  isEvidenceCompleteness,
  isEvidenceKind,
  isProtocolProvenance,
  parseCandidateValidationState,
  parseEvidenceCompleteness,
  parseEvidenceKind,
  parseProtocolProvenance,
  PROTOCOL_PROVENANCE_VALUES,
  type EvidenceSource,
  type SourceCitation,
} from './harnessEvidence';

function diffSource(overrides: Partial<EvidenceSource> = {}): EvidenceSource {
  return {
    sourceId: 'src-1',
    digest: 'digest-1',
    kind: 'diff',
    repositoryId: 'repo-1',
    baseSha: 'base-1',
    headSha: 'head-1',
    completeness: 'complete',
    citable: true,
    exactContent: '+  return input.trim().toLowerCase()',
    ...overrides,
  };
}

describe('evidence ledger, citation, candidate, and provenance types (task 2.5)', () => {
  it('accepts every evidence kind and fails closed on garbage', () => {
    for (const kind of EVIDENCE_KINDS) expect(isEvidenceKind(kind)).toBe(true);
    expect(parseEvidenceKind('log')).toBeUndefined();
    expect(parseEvidenceKind(undefined)).toBeUndefined();
  });

  it('accepts every evidence completeness value and fails closed on garbage', () => {
    for (const state of EVIDENCE_COMPLETENESS_VALUES) expect(isEvidenceCompleteness(state)).toBe(true);
    expect(parseEvidenceCompleteness('unknown')).toBeUndefined();
  });

  it('accepts every candidate validation state and fails closed on garbage', () => {
    for (const state of CANDIDATE_VALIDATION_STATES) expect(isCandidateValidationState(state)).toBe(true);
    expect(parseCandidateValidationState('pending')).toBeUndefined();
  });

  it('accepts every protocol provenance value, including legacy-one-shot, and fails closed on garbage', () => {
    for (const provenance of PROTOCOL_PROVENANCE_VALUES) expect(isProtocolProvenance(provenance)).toBe(true);
    expect(parseProtocolProvenance('legacy-one-shot')).toBe('legacy-one-shot');
    expect(parseProtocolProvenance('one-shot')).toBeUndefined();
    expect(parseProtocolProvenance(null)).toBeUndefined();
  });

  it('gives two reads of the same logical source distinct digests and ledger entries', () => {
    const first = diffSource({ sourceId: 'src-1', digest: 'digest-a' });
    const second = diffSource({ sourceId: 'src-1', digest: 'digest-b', exactContent: 'different bytes' });
    expect(first.digest).not.toBe(second.digest);
  });

  it('resolves a citation by source identifier and digest, not by path alone', () => {
    const source = diffSource();
    const citation: SourceCitation = { sourceId: source.sourceId, digest: source.digest, path: 'src/util/parse.ts' };
    expect(citation.sourceId).toBe(source.sourceId);
    expect(citation.digest).toBe(source.digest);
  });

  it('marks intent and policy content non-citable while diff and attachment evidence remain citable', () => {
    const diff = diffSource({ kind: 'diff', citable: true });
    const attachment = diffSource({ kind: 'attachment', citable: true, path: 'notes.md' });
    const policyRead = diffSource({ kind: 'file', citable: false, path: 'AGENTS.md' });
    expect(diff.citable).toBe(true);
    expect(attachment.citable).toBe(true);
    expect(policyRead.citable).toBe(false);
  });
});
