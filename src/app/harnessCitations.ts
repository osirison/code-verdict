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
import { parseHunks } from '../domain/diffHunks';
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
 * The exact returned span a cited range sits inside — the single rule
 * `resolveCitation` applies below, exported because a caller that already
 * holds the resolved source sometimes needs the *location* too and only the
 * location carries a diff's `side`.
 *
 * `../app/harnessSynthesisVerification.ts`'s contradiction pass is that
 * caller: to cut a window of a patch around a citation's lines it has to know
 * whether those lines are numbered on the old or the new side, and
 * `CitedEvidenceRef` does not keep `side`. Exporting this keeps "which span
 * contains this citation" a single definition — a second copy there could
 * choose a different span than the one validation accepted.
 */
export function locationContaining(source: LedgerEvidenceSource, path: string, range: EvidenceRange): EvidenceLocation | undefined {
  return source.locations.find((location) => location.path === path && rangeContains(location.range, range));
}

/**
 * One block of quotable text per hunk per side, with the unified-diff prefix
 * byte removed — the patch as the *file* reads on that side.
 *
 * A hunk's new side is its added and context lines in order; its old side is
 * its deleted and context lines in order. Nothing else in the payload is a
 * block: not the `diff --git`/`index`/`---`/`+++` header, not the `@@` line,
 * and no run that crosses from one hunk into the next. Those are the exact
 * spans the model was shown as contiguous source, which is what a verbatim
 * quote claims to be.
 */
function patchQuotableBlocks(patch: string): string[] {
  const blocks: string[] = [];
  for (const hunk of parseHunks(patch)) {
    const newSide = hunk.lines.filter((line) => line.kind !== 'del').map((line) => line.text);
    const oldSide = hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text);
    if (newSide.length > 0) blocks.push(newSide.join('\n'));
    if (oldSide.length > 0) blocks.push(oldSide.join('\n'));
  }
  return blocks;
}

/**
 * Does this quoted text really appear in the bytes the model was served?
 *
 * The check `validateCandidate` used to run was `exactContent.includes(code)`
 * for every kind of evidence, and against a *patch* that is both too strict and
 * too loose at once. Too strict: a patch's lines each carry a `+`, `-` or space
 * prefix, so a model quoting two consecutive added lines as they read in the
 * file sends `"a\nb"` while the payload holds `"+a\n+b"` — the substring test
 * fails and a correct finding is destroyed. Measured, not reasoned about: with
 * the diff-page location gap fixed (`harnessEvidenceLedger.ts`'s
 * `diffPatchLocations`), a candidate quoting two real consecutive added lines
 * of a real patch was still rejected, now with `codeNotInEvidence`. Too loose:
 * a whole-payload substring match will also happily match text that spans a
 * hunk boundary, mixes a deleted line with an added one, or sits inside the
 * `@@`/`+++` header — none of which the model was shown as contiguous code.
 *
 * So the rule for a patch is stated exactly rather than loosened: the quote
 * must be a substring of one hunk's one side, prefix bytes stripped
 * (`patchQuotableBlocks`). A partial quote of a single line still passes — the
 * model often quotes an expression, not a whole line — and a multi-line quote
 * passes only when those lines really are consecutive on one side of one hunk.
 * Every other kind of evidence (a file range, an attachment, a search excerpt)
 * is served as its own bytes, so the plain substring test is already exact for
 * it and stays.
 *
 * Edge worth knowing: `parseHunks` drops a zero-length physical line inside a
 * hunk, so a quote spanning a blank line would break if a patch ever carried
 * one. `git diff` writes a blank context line as a single space and a blank
 * added line as a bare `+`, both of which survive as an empty `text`, so this
 * does not arise on the output this host reads.
 */
export function quotedTextAppearsIn(source: LedgerEvidenceSource, quote: string): boolean {
  if (source.kind !== 'diff') return source.exactContent.includes(quote);
  return patchQuotableBlocks(source.exactContent).some((block) => block.includes(quote));
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
  // Revoked first, and with its own sentence: a revoked source has `citable: false` too, and the
  // origin/trust wording below would tell a model that its own diff read is "intent" evidence —
  // true of nothing, and unactionable. This one names the real condition and what to do about it.
  if (source.revoked === true) {
    return fail('nonCitable', `Evidence ${citation.sourceId} was fetched but never shown to you: the prompt that would have carried it was over its size cap, so the result was withheld. Nothing was spent on it — request that content again and cite what comes back.`);
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

  if (!source.locations.some((location) => location.path === path)) {
    return fail('pathMismatch', `Evidence ${citation.sourceId} did not return any content for ${path}.`);
  }
  const location = locationContaining(source, path, citation.range);
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
