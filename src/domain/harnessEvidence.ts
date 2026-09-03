/**
 * Evidence ledger sources, citations, candidate validation, and protocol
 * provenance (task 2.5 of `add-agentic-review-harness`, design.md D8/D9/D16).
 * `EvidenceSource` mirrors D8's interface field for field.
 */

export const EVIDENCE_KINDS = ['diff', 'file', 'searchExcerpt', 'attachment', 'detail'] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_COMPLETENESS_VALUES = ['complete', 'paginated', 'truncated'] as const;

export type EvidenceCompleteness = (typeof EVIDENCE_COMPLETENESS_VALUES)[number];

export interface EvidenceRange {
  startLine: number;
  endLine: number;
}

/** Append-only for an attempt; `sourceId` is stable in the lineage, `digest` verifies the exact bytes. */
export interface EvidenceSource {
  sourceId: string;
  digest: string;
  kind: EvidenceKind;
  repositoryId: string;
  baseSha: string;
  headSha: string;
  revision?: 'base' | 'head';
  path?: string;
  range?: EvidenceRange;
  completeness: EvidenceCompleteness;
  citable: boolean;
  exactContent: string;
}

/** What a candidate or validated finding cites — resolved by identifier and digest, never refetched by path alone. */
export interface SourceCitation {
  sourceId: string;
  digest: string;
  path?: string;
  range?: EvidenceRange;
}

export const CANDIDATE_VALIDATION_STATES = ['accepted', 'repairable', 'rejected'] as const;

export type CandidateValidationState = (typeof CANDIDATE_VALIDATION_STATES)[number];

export interface CandidateValidationResult {
  state: CandidateValidationState;
  /** Bounded, public reasons — never a raw model fragment. */
  reasons: readonly string[];
}

/**
 * `harness` is a validated result of this proposal's agentic protocol;
 * `legacy-one-shot` reads a pre-harness successful review under D16 without
 * fabricating plan, evidence, or coverage for it.
 */
export const PROTOCOL_PROVENANCE_VALUES = ['harness', 'legacy-one-shot'] as const;

export type ProtocolProvenance = (typeof PROTOCOL_PROVENANCE_VALUES)[number];

export interface ValidatedFindingProvenance {
  protocolProvenance: ProtocolProvenance;
  citations: readonly SourceCitation[];
  validatedAt: string;
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (EVIDENCE_KINDS as readonly unknown[]).includes(value);
}

export function parseEvidenceKind(value: unknown): EvidenceKind | undefined {
  return isEvidenceKind(value) ? value : undefined;
}

export function isEvidenceCompleteness(value: unknown): value is EvidenceCompleteness {
  return (EVIDENCE_COMPLETENESS_VALUES as readonly unknown[]).includes(value);
}

export function parseEvidenceCompleteness(value: unknown): EvidenceCompleteness | undefined {
  return isEvidenceCompleteness(value) ? value : undefined;
}

export function isCandidateValidationState(value: unknown): value is CandidateValidationState {
  return (CANDIDATE_VALIDATION_STATES as readonly unknown[]).includes(value);
}

export function parseCandidateValidationState(value: unknown): CandidateValidationState | undefined {
  return isCandidateValidationState(value) ? value : undefined;
}

export function isProtocolProvenance(value: unknown): value is ProtocolProvenance {
  return (PROTOCOL_PROVENANCE_VALUES as readonly unknown[]).includes(value);
}

export function parseProtocolProvenance(value: unknown): ProtocolProvenance | undefined {
  return isProtocolProvenance(value) ? value : undefined;
}
