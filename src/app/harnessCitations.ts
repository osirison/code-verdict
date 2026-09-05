/**
 * Citation resolution against the evidence ledger (task 7.5 of
 * `add-agentic-review-harness`, design.md D8/D9, spec `review-evidence-ledger`
 * "Findings use only evidence returned to the model").
 *
 * A citation resolves against three things the model was actually given —
 * the opaque `sourceId`, the `digest` of those exact bytes, and a location
 * inside the exact returned range — and never by refetching a path at
 * validation time (D8's rejected alternative: a refetch proves what the
 * host can see later, not what the model saw). The ledger is attempt-bound,
 * so an identifier minted by another attempt or another head simply does
 * not exist here and fails as `unknownSource`; there is no fallback lookup
 * by path, digest, or content.
 *
 * Outcomes are three-valued to match `CandidateValidationState`:
 * - resolved: source, digest, citable status, and location all check out.
 * - `repairable: true` failures name a real, citable source the model saw
 *   but leave the location incomplete (missing path or range) — the model
 *   can be asked to complete it (D9 "repairable").
 * - `repairable: false` failures are rejections: fabricated or foreign
 *   identifiers, digest drift, non-citable categories, a path or range the
 *   payload never contained, or malformed input. None of these can be fixed
 *   by asking for more detail without fetching new evidence.
 */
import type { SourceCitation } from '../domain/harnessEvidence';
import type { EvidenceRange } from '../domain/harnessEvidence';
import {
  isWellFormedSourceId,
  normalizeEvidencePath,
  normalizeEvidenceRange,
  type EvidenceLedger,
  type EvidenceLocation,
  type LedgerEvidenceSource,
} from './harnessEvidenceLedger';

export type CitationFailureCode =
  | 'malformed'
  | 'unknownSource'
  | 'digestMismatch'
  | 'nonCitable'
  | 'memberMismatch'
  | 'pathMissing'
  | 'rangeMissing'
  | 'invalidRange'
  | 'pathMismatch'
  | 'rangeOutsideEvidence';

export interface ResolvedCitation {
  readonly ok: true;
  readonly source: LedgerEvidenceSource;
  /** The normalized path/range the citation named, proven to sit inside `location`. */
  readonly cited: { readonly path: string; readonly range: EvidenceRange };
  /** The exact returned span that contains the cited range. */
  readonly location: EvidenceLocation;
}

export interface CitationFailure {
  readonly ok: false;
  readonly code: CitationFailureCode;
  readonly message: string;
  readonly repairable: boolean;
}

export type CitationResolution = ResolvedCitation | CitationFailure;

export interface ResolveCitationOptions {
  /** When given, the source must belong to this changeset member (a candidate's primary target must be in its own member). */
  memberId?: string;
}

function fail(code: CitationFailureCode, message: string, repairable = false): CitationFailure {
  return { ok: false, code, message, repairable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Fail-closed shape check on model-supplied input before anything is looked up. */
export function parseSourceCitation(value: unknown): SourceCitation | undefined {
  if (!isRecord(value)) return undefined;
  if (!isWellFormedSourceId(value.sourceId)) return undefined;
  if (typeof value.digest !== 'string' || !/^[0-9a-f]{64}$/.test(value.digest)) return undefined;
  if (value.path !== undefined && typeof value.path !== 'string') return undefined;
  let range: EvidenceRange | undefined;
  if (value.range !== undefined) {
    if (!isRecord(value.range)) return undefined;
    range = normalizeEvidenceRange(value.range.startLine, value.range.endLine);
    if (!range) return undefined;
  }
  return { sourceId: value.sourceId, digest: value.digest, path: value.path, range };
}

function rangeContains(outer: EvidenceRange, inner: EvidenceRange): boolean {
  return inner.startLine >= outer.startLine && inner.endLine <= outer.endLine;
}

/**
 * Resolves one citation against the ledger the model was actually served
 * from. Accepts `unknown` so the model protocol layer can hand raw parsed
 * JSON straight in; every field is validated here.
 */
export function resolveCitation(ledger: EvidenceLedger, rawCitation: unknown, options: ResolveCitationOptions = {}): CitationResolution {
  if (isRecord(rawCitation) && typeof rawCitation.range === 'object' && rawCitation.range !== null) {
    const range = rawCitation.range as Record<string, unknown>;
    if (range.startLine !== undefined && !normalizeEvidenceRange(range.startLine, range.endLine)) {
      return fail('invalidRange', 'Cited range must be positive integer lines with endLine >= startLine.');
    }
  }
  const citation = parseSourceCitation(rawCitation);
  if (!citation) return fail('malformed', 'Citation must carry a well-formed sourceId and sha256 digest.');

  const source = ledger.get(citation.sourceId);
  if (!source) return fail('unknownSource', `No evidence with identifier ${citation.sourceId} was returned to the model in this attempt.`);
  if (source.digest !== citation.digest) {
    return fail('digestMismatch', `Digest does not match the exact content returned for ${citation.sourceId}.`);
  }
  if (!source.citable) {
    return fail('nonCitable', `${source.origin} evidence is ${source.trust === 'authoritative' ? 'policy' : 'intent'} and cannot support a finding.`);
  }
  if (options.memberId !== undefined && source.memberId !== options.memberId) {
    return fail('memberMismatch', `Evidence ${citation.sourceId} belongs to member ${source.memberId}, not ${options.memberId}.`);
  }

  if (citation.path === undefined) return fail('pathMissing', 'Citation names evidence but not the file inside it.', true);
  const path = normalizeEvidencePath(citation.path);
  if (!path) return fail('pathMismatch', `Cited path is not usable: ${citation.path}`);
  if (!citation.range) return fail('rangeMissing', `Citation names ${path} but not the line range inside it.`, true);

  const samePath = source.locations.filter((location) => location.path === path);
  if (samePath.length === 0) return fail('pathMismatch', `Evidence ${citation.sourceId} did not return any content for ${path}.`);
  const location = samePath.find((candidate) => rangeContains(candidate.range, citation.range as EvidenceRange));
  if (!location) {
    return fail('rangeOutsideEvidence', `Lines ${citation.range.startLine}-${citation.range.endLine} of ${path} were not in the content returned for ${citation.sourceId}.`);
  }
  return { ok: true, source, cited: { path, range: citation.range }, location };
}

export interface CandidateCitationSet {
  readonly primary: unknown;
  readonly supporting?: readonly unknown[];
}

export interface ResolvedCandidateCitations {
  readonly primary: CitationResolution;
  readonly supporting: readonly CitationResolution[];
  /** True when every citation resolved. */
  readonly ok: boolean;
  /** True when nothing was rejected outright but at least one citation needs repair. */
  readonly repairable: boolean;
}

/**
 * Resolves a whole candidate's citation set. The primary must sit in the
 * candidate's own member; supporting spans may come from any member of the
 * run and keep their own repository/revision identity (D15).
 */
export function resolveCandidateCitations(
  ledger: EvidenceLedger,
  citations: CandidateCitationSet,
  memberId: string,
): ResolvedCandidateCitations {
  const primary = resolveCitation(ledger, citations.primary, { memberId });
  const supporting = (citations.supporting ?? []).map((citation) => resolveCitation(ledger, citation));
  const all = [primary, ...supporting];
  const ok = all.every((resolution) => resolution.ok);
  const rejected = all.some((resolution) => !resolution.ok && !resolution.repairable);
  return { primary, supporting, ok, repairable: !ok && !rejected };
}
