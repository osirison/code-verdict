/**
 * The real synthesis/verification collaborator (task 10.6 of
 * `add-agentic-review-harness`, design.md D9, spec `agentic-review-harness`
 * "The host decides whether completion is valid"). `harnessAttempt.ts`
 * injects `SynthesisVerificationRunner`; this module is the first honest
 * implementation of it. Nothing here duplicates a validation, budget,
 * ledger, or activity concern another module already owns — see the
 * "REUSE, DO NOT REINVENT" note in each section below.
 *
 * Two strictly separated stages, matching D9's own order:
 *
 * 1. **Deterministic grouping and deduplication** (`deduplicateFindings`) —
 *    pure, synchronous, no model, no clock, no randomness. Candidates group
 *    by *primary location* and *semantic claim* (both defined below); two
 *    candidates in the same group collapse to one finding under the
 *    documented merge rule. The whole computation sorts its inputs before
 *    doing anything order-sensitive, so the result never depends on the
 *    order `findings` arrived in — proven by a shuffled-input test in the
 *    companion `.test.ts`.
 *
 * 2. **Model contradiction checks** (`runContradictionChecks`) — for every
 *    surviving finding, asks the *same* injected `HarnessModelSeam` (task
 *    10.4's "one model, many phases" seam, never a second model) to
 *    challenge the claim against the *exact* cited primary evidence: bytes
 *    fetched from the ledger by `sourceId` and verified against the
 *    finding's own recorded `digest` (`EvidenceLedger.get`, never a re-read
 *    by path — D8's rejected alternative). A finding the model contradicts
 *    is excluded from the surviving set but recorded in `contradicted` with
 *    a bounded public reason, never silently dropped. Host citation
 *    revalidation (`revalidateFindings`) still runs afterward in
 *    `harnessAttempt.ts`'s `runSynthesisVerification` — this module never
 *    reimplements that. **Primary evidence only**, unchanged by the excerpt
 *    work below: D9 defines this pass as challenging the claim against the
 *    cited *primary*, a merged finding's supporting set is an unbounded union
 *    of the other group members' citations (`mergeGroup`) that no per-call
 *    budget could carry, and each would need its own line anchoring into its
 *    own payload. A claim that only supporting evidence could refute is out of
 *    this pass's scope, not silently half-checked inside it.
 *
 * **No dedicated protocol message for a contradiction verdict.** The
 * committed model protocol (task 10.1, `../domain/harnessProtocol.ts`) has
 * no message kind for "here is my verdict on candidate X" — it is a fixed,
 * already-shipped union this task does not reopen. `harnessAttempt.ts`
 * documents exactly this kind of gap for the risk-proposal channel ("out of
 * this pass's scope... reported as a gap, not invented here"); the
 * contradiction pass cannot take that path, though, because unlike a risk
 * proposal it is a completion clause (`contradictionPassComplete`) that
 * cannot simply be dropped. So this module defines the one genuinely new,
 * narrow, bounded, fail-closed request/response shape D9 actually needs:
 * - The *request* reuses the existing `HarnessModelSeam.askModel`'s
 *   `repairInstruction` parameter — the one already-threaded per-call free
 *   text channel every fake (real or demo) already implements — to carry a
 *   directive naming the candidate id, its primary location, and the exact
 *   evidence bytes (see `buildContradictionDirective`). This is not
 *   "protocol repair": it reuses that field's shape (an optional string handed
 *   to the same seam), not its meaning.
 * - The *response* is a single small JSON object
 *   `{candidateId, contradicted, reason?}`, parsed by `parseContradictionVerdict`
 *   with the same fail-closed discipline `../domain/harnessProtocol.ts` uses
 *   (bounded length, no best-effort coercion, echo-the-id binding) but its
 *   own schema — there is no existing verdict schema anywhere in this
 *   codebase to reuse.
 *
 * **The evidence a verdict is asked about is a window, not a prefix.** The
 * directive used to carry `exactContent.slice(0, 4_000)`, which for any page
 * longer than that showed the model the *start* of the page no matter where
 * the finding pointed. A finding citing lines past the cut was judged on bytes
 * that did not contain it, and a `contradicted: true` answer to that question
 * removed a validated finding — a silent false negative on the last gate
 * before a reviewer. `selectEvidenceExcerpt` now cuts the excerpt around the
 * cited lines (see its note for how file lines map into a patch), and when it
 * cannot do that honestly — the citation is unlocatable, or the cited lines
 * alone are larger than the budget — the check is *skipped*: no model call,
 * the finding kept, an entry in `unverified`, and the stage incomplete. An
 * unchecked finding is reported as unchecked; it is never checked on the wrong
 * bytes, and it is never silently dropped either.
 *
 * **What "incomplete" costs, and who sees it.** `contradictionPassComplete:
 * false` fails that clause in `../app/harnessCompletion.ts`, which adds the
 * `contradictionPending` blocker and classifies the run `partialFindings`
 * rather than `completeFindings`. It does not block delivery: findings still
 * reach the reviewer, labeled partial. That aggregate flag alone would not say
 * *which* finding went unchecked, so each `unverified` entry also becomes its
 * own public `toolFailed` activity event in `harnessAttempt.ts`, exactly as
 * each `contradicted` entry does. Deliberately not extended to the checkpoint
 * and persistence shapes: those record what a finding *is*, and an unverified
 * finding is an ordinary surviving finding whose pass did not conclude — the
 * completion clause and the activity trail are where that belongs.
 *
 * **Malformed-verdict repair budget.** A shared allowance across the whole
 * contradiction stage, reusing `HarnessPolicy.protocolRepairsPerPhase`
 * (never a new magic number) rather than a separate per-finding budget —
 * the whole stage runs inside one `verifying` phase, so "per phase"
 * semantics already fit. Once the allowance is exhausted (or cancellation
 * lands mid-stage), the affected finding's verdict cannot be confirmed: it
 * is kept in the surviving set (a verification-machinery failure is not
 * grounds to discard an already-validated finding) but the stage as a whole
 * is `contradictionPassComplete: false` — the completion gate
 * (`../app/harnessCompletion.ts`) refuses a complete verdict regardless, so
 * an unconfirmed finding can never reach the user silently labeled
 * "complete".
 *
 * **Flag semantics** (feeding `harnessAttempt.ts`'s `VerificationPasses`):
 * - `deduplicationComplete`: stage 1 ran to completion. It is synchronous,
 *   so cancellation can only ever catch it *before* it starts (checked once,
 *   up front) — once started it always finishes.
 * - `contradictionPassComplete`: every surviving (post-dedup) finding
 *   received a parseable, id-matching verdict, with no cancellation, no
 *   unresolvable evidence mismatch, and no citation whose bytes could not
 *   honestly be put in front of the model, along the way.
 * - `finalVerificationComplete`: the whole pipeline (both stages) reached
 *   its end without being skipped; equal to `contradictionPassComplete`
 *   once dedup has run, since dedup cannot itself fail once started.
 *
 * **Documented gap:** `RiskCoverageRules.contradictionCheck`
 * (`./harnessRiskFloors.ts`) is D10 investigation-coverage configuration —
 * which risk levels of *files* require a contradiction check as part of
 * per-file coverage during investigation — a distinct concept from D9's
 * verification-stage pass over *findings* this module implements. It stays
 * unconsumed here; wiring it would require `SynthesisVerificationInput` to
 * carry per-file risk, which is not part of task 10.6's brief ("for each
 * surviving finding... challenge the claim" — every finding, not a
 * risk-gated subset) and would silently narrow the D9 pass this module is
 * scoped to implement.
 *
 * **Documented interaction with `CandidateTracker`:** a finding this module
 * deduplicates away or contradicts stays `accepted` in the tracker (this
 * module has no tracker access — `SynthesisVerificationInput` does not, and
 * should not, expose it). If a later candidate submission during the same
 * `verifying` phase makes `harnessAttempt.ts` rerun this collaborator
 * (`passesStale`), `candidateTracker.triageFindings()` will hand back the
 * same absorbed/contradicted candidates again as fresh input. Both stages
 * are idempotent and deterministic, so they simply reach the same
 * conclusion again — harmless, if slightly redundant work.
 */
import type { AgentCancellationToken, ModelTurnTiming } from './lmAgent';
import type { HarnessModelSeam, SynthesisVerificationInput, SynthesisVerificationOutput, SynthesisVerificationRunner, UnverifiedFindingRecord } from './harnessAttempt';
import type { CitedEvidenceRef, ValidatedFinding } from './harnessCandidateValidation';
import { sanitizePublicText } from './harnessActivitySanitizer';
import { MAX_TURN_RAW_BYTES } from '../domain/harnessProtocol';
import type { SourceCitation } from '../domain/harnessEvidence';
import { parseHunks } from '../domain/diffHunks';
import { locationContaining } from './harnessCitations';
import { normalizeEvidencePath, type EvidenceLedger, type LedgerEvidenceSource } from './harnessEvidenceLedger';
import { SEVERITY_ORDER } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';

// ---- Stage 1: deterministic grouping and deduplication ----------------------------

/**
 * *Semantic claim* (deterministic, chosen for this task): the finding's
 * `category` (already a closed enum — canonical as-is) plus a normalized
 * `rule` (trimmed, lower-cased; empty when absent) plus a normalized title
 * (trimmed, lower-cased, internal whitespace collapsed to one space). No
 * fuzzy/stemmed matching: two titles that a human would recognize as the
 * same claim but that differ after this normalization are intentionally
 * treated as different claims — documented as a known limitation, not
 * silently "smoothed over" by a heuristic that could merge two genuinely
 * different findings.
 */
function semanticClaimKey(finding: ValidatedFinding): string {
  const category = finding.item.category;
  const rule = (finding.item.rule ?? '').trim().toLowerCase();
  const title = finding.item.title.trim().toLowerCase().replace(/\s+/g, ' ');
  // JSON-array encoding, not a space-joined template string: a space-joined
  // `${category} ${rule} ${title}` is ambiguous whenever `rule` or `title`
  // itself contains a space (rule "unused var" + title "z" would collide
  // with rule "unused" + title "var z"), which would silently merge two
  // different claims. `JSON.stringify` of the tuple is unambiguous.
  return JSON.stringify([category, rule, title]);
}

function primaryPath(finding: ValidatedFinding): string {
  return normalizeEvidencePath(finding.evidence.primary.path) ?? finding.evidence.primary.path;
}

function compareCandidateId(a: ValidatedFinding, b: ValidatedFinding): number {
  return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
}

/**
 * *Primary location* clustering: two candidates share a location cluster
 * when they name the same member and (normalized) path and their primary
 * evidence's line ranges overlap, transitively (A overlaps B and B overlaps
 * C merges all three even if A and C do not directly overlap). Clustering
 * sorts every candidate by `(memberId, path, startLine, endLine,
 * candidateId)` first and then sweeps once — the cluster a candidate lands
 * in depends only on these sorted values, never on the order `findings`
 * arrived in.
 */
function assignLocationClusters(findings: readonly ValidatedFinding[]): ReadonlyMap<string, number> {
  const sorted = [...findings].sort((a, b) => {
    if (a.memberId !== b.memberId) return a.memberId < b.memberId ? -1 : 1;
    const pathA = primaryPath(a);
    const pathB = primaryPath(b);
    if (pathA !== pathB) return pathA < pathB ? -1 : 1;
    if (a.evidence.primary.range.startLine !== b.evidence.primary.range.startLine) return a.evidence.primary.range.startLine - b.evidence.primary.range.startLine;
    if (a.evidence.primary.range.endLine !== b.evidence.primary.range.endLine) return a.evidence.primary.range.endLine - b.evidence.primary.range.endLine;
    return compareCandidateId(a, b);
  });
  const clusterOf = new Map<string, number>();
  let openMemberPath: string | undefined;
  let openEnd = -Infinity;
  let clusterIndex = -1;
  for (const finding of sorted) {
    // Same unambiguous-encoding reasoning as `semanticClaimKey`: a path may itself contain a space.
    const memberPath = JSON.stringify([finding.memberId, primaryPath(finding)]);
    const { startLine, endLine } = finding.evidence.primary.range;
    if (memberPath !== openMemberPath || startLine > openEnd) {
      clusterIndex += 1;
      openMemberPath = memberPath;
      openEnd = endLine;
    } else {
      openEnd = Math.max(openEnd, endLine);
    }
    clusterOf.set(finding.candidateId, clusterIndex);
  }
  return clusterOf;
}

function groupKey(finding: ValidatedFinding, clusterIndex: number): string {
  return JSON.stringify([finding.memberId, primaryPath(finding), clusterIndex, semanticClaimKey(finding)]);
}

function refKey(ref: CitedEvidenceRef): string {
  return JSON.stringify([ref.sourceId, ref.path, ref.range.startLine, ref.range.endLine]);
}

function toSourceCitation(ref: CitedEvidenceRef): SourceCitation {
  return { sourceId: ref.sourceId, digest: ref.digest, path: ref.path, range: ref.range };
}

/**
 * Merge rule for one group of two-or-more candidates collapsing to one
 * finding (documented per task 10.6's brief):
 * - **Representative** (which candidate id survives): the lexicographically
 *   smallest `candidateId` in the group — a total order over opaque string
 *   ids, independent of array/map iteration order.
 * - **Severity**: the highest-ranked severity in the group
 *   (`../domain/criteria.ts`'s `SEVERITY_ORDER`) — merging never under-reports
 *   how bad the worst-stated instance of this claim is.
 * - **Confidence**: the maximum confidence in the group.
 * - **Everything else about the reported item** (title, body, code, file,
 *   line/endLine, suggestion, answers, repoId, crNumber): the
 *   representative's own values, unchanged — a merge never fabricates prose
 *   by combining two candidates' text.
 * - **Primary citation / evidence.primary**: the representative's own,
 *   unchanged — this is what keeps every `revalidateFindings` invariant
 *   (digest/location binding) trivially intact after a merge.
 * - **Supporting citations**: the union of every OTHER group member's
 *   primary and supporting citations (the representative's own primary is
 *   already covered above; its own supporting citations are included too),
 *   deduplicated by `(sourceId, path, range)` and sorted by that same key
 *   for a deterministic order.
 * - **`provenance.citations`**: rebuilt from the merged primary + supporting
 *   set (never left describing only the representative's original,
 *   pre-merge evidence) so the audit trail matches what the merged finding
 *   actually rests on.
 */
function mergeGroup(group: readonly ValidatedFinding[]): ValidatedFinding {
  if (group.length === 1) return group[0] as ValidatedFinding;
  const sorted = [...group].sort(compareCandidateId);
  const representative = sorted[0] as ValidatedFinding;
  const severity = sorted.reduce((best, f) => (SEVERITY_ORDER.indexOf(f.item.severity) > SEVERITY_ORDER.indexOf(best) ? f.item.severity : best), representative.item.severity);
  const confidence = sorted.reduce((best, f) => Math.max(best, f.item.confidence), representative.item.confidence);

  const supportingByKey = new Map<string, CitedEvidenceRef>();
  for (const finding of sorted) {
    if (finding.candidateId === representative.candidateId) {
      for (const ref of finding.evidence.supporting) supportingByKey.set(refKey(ref), ref);
      continue;
    }
    supportingByKey.set(refKey(finding.evidence.primary), finding.evidence.primary);
    for (const ref of finding.evidence.supporting) supportingByKey.set(refKey(ref), ref);
  }
  supportingByKey.delete(refKey(representative.evidence.primary));
  const supporting = [...supportingByKey.values()].sort((a, b) => (refKey(a) < refKey(b) ? -1 : refKey(a) > refKey(b) ? 1 : 0));

  return {
    ...representative,
    item: { ...representative.item, severity, confidence },
    provenance: { ...representative.provenance, citations: [toSourceCitation(representative.evidence.primary), ...supporting.map(toSourceCitation)] },
    evidence: { ...representative.evidence, supporting },
  };
}

/**
 * Stage 1: pure, synchronous, deterministic. Groups `findings` by primary
 * location cluster and semantic claim, merges each group per `mergeGroup`,
 * and returns the survivors sorted by (final) `candidateId` — a second,
 * independent determinism guarantee on top of the clustering sort, so the
 * *output* order never depends on `findings`' input order either.
 */
export function deduplicateFindings(findings: readonly ValidatedFinding[]): readonly ValidatedFinding[] {
  const clusters = assignLocationClusters(findings);
  const groups = new Map<string, ValidatedFinding[]>();
  for (const finding of findings) {
    const clusterIndex = clusters.get(finding.candidateId) as number;
    const key = groupKey(finding, clusterIndex);
    const bucket = groups.get(key);
    if (bucket) bucket.push(finding);
    else groups.set(key, [finding]);
  }
  const merged = [...groups.values()].map(mergeGroup);
  return merged.sort(compareCandidateId);
}

// ---- Stage 2: model contradiction checks against exact cited evidence -------------

export const CONTRADICTION_CHECK_MARKER = 'harness-contradiction-check-v1';

/**
 * How much evidence one contradiction check shows when nothing else binds — a *quality* bound, not
 * a safety one. Four thousand characters is about a screenful of patch on either side of the
 * citation, which is what a verifier needs to answer "does this support the claim" without being
 * asked to re-read the file.
 *
 * The safety bound is `HarnessPolicy.maxPromptBytesPerTurn`, and it wins whenever it is smaller.
 * That is the division `buildBoundedContradictionDirective` enforces: the cap bounds the whole
 * directive in bytes, this constant bounds the excerpt in characters, and the smaller of the two
 * decides. Until that existed this pass assembled its own prompt text and handed it to `askModel`
 * without the ceiling ever applying — the cap was measured there, reported, and the over-cap text
 * sent regardless.
 */
const MAX_EVIDENCE_EXCERPT_CHARS = 4_000;

/**
 * The most UTF-8 bytes one UTF-16 code unit of a JavaScript string can cost. Three: a BMP
 * character outside Latin-1 encodes to three bytes, while an astral character costs four bytes
 * across *two* units. Used only to turn a byte budget into a character budget that cannot
 * overshoot it, for the one retry below.
 */
const MAX_UTF8_BYTES_PER_UNIT = 3;

/** The same measure `harnessModelSeam.ts`'s `promptByteLength` takes, spelled out here rather than imported: that module imports this one, and a cycle for a one-line function is a bad trade. */
function directiveByteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/**
 * How many lines of surrounding context the window may add on each side of
 * the cited lines, before the character budget is even consulted. A cap, not
 * a target: the expansion below stops at whichever of the two limits it meets
 * first, so a page of very short lines cannot turn "a window around the
 * citation" into "most of the page, starting nowhere near it".
 */
const MAX_EXCERPT_CONTEXT_LINES = 40;

/**
 * Ceiling on the one indexing walk below. The ledger already bounds evidence
 * by `maxEvidenceBytesPerAttempt`, so this is not the real defence — it is the
 * promise that this pass never does unbounded work on a pathological payload
 * (a minified megabyte with no newline costs one walk and one array entry;
 * a megabyte of `\n` would otherwise cost a million).
 */
const MAX_INDEXED_EVIDENCE_LINES = 200_000;

/**
 * **Why this exists at all — the failure it replaces.** Until this was
 * written, the directive below carried `content.slice(0, 4_000)`: the first
 * 4,000 characters of the evidence page, whatever the finding actually cited.
 * A diff page is routinely far longer than that, so a finding citing lines
 * near its end was judged against a prefix that *did not contain the lines
 * under judgement* — and the model could still answer `contradicted: true`,
 * which removes an otherwise validated finding. Silent false negative: a real
 * defect dropped on the last gate before a reviewer sees it, with nothing in
 * the run recording that the evidence was never shown. The excerpt is now
 * anchored on the citation, and when it cannot honestly be, the check is not
 * performed at all (see `runContradictionChecks`) rather than performed on the
 * wrong bytes.
 *
 * Anchoring is by LINE, because `evidence.primary.range` is in lines — and in
 * *file* lines, which is not the same coordinate as a line of the payload:
 * - **Diff pages** (`kind: 'diff'`, the origin of nearly every primary —
 *   `harnessCandidateValidation.ts`'s `PRIMARY_ELIGIBLE_ORIGINS` admits only
 *   `diffPage` and `attachment`): `exactContent` is the unified patch, whose
 *   physical lines include `@@` headers and `+`/`-` prefixes and whose file
 *   line numbers live only in those headers. The mapping comes from
 *   `../domain/diffHunks.ts`'s `parseHunks` (now carrying `patchLine`), never
 *   from a second hunk parser here.
 * - **Line-aligned payloads** (`source.range` present and the payload's line
 *   count equal to that range's span — a `fileRange` read, or an attachment
 *   whose single returned span is exactly its content): payload line 1 is
 *   file line `source.range.startLine`, so the offset is arithmetic. The
 *   line-count equality is checked, not assumed: an attachment can bundle
 *   several sources at character offsets the ledger does not retain, and for
 *   those there is no sound mapping.
 * - **Anything else**: no mapping, so no window — `unavailable`, not a guess.
 */
export type EvidenceExcerpt =
  /** The whole payload fits the budget: the exact bytes, entire, exactly as before this change. */
  | { readonly kind: 'whole'; readonly text: string }
  /** A contiguous slice of the exact bytes containing the cited lines. Line numbers are physical lines of the payload, 1-based. */
  | {
      readonly kind: 'window';
      readonly text: string;
      readonly firstLine: number;
      readonly lastLine: number;
      readonly totalLines: number;
      /** The diff side the cited file lines are numbered on, when the payload is a patch. */
      readonly side?: 'old' | 'new';
    }
  /** The cited bytes cannot be shown honestly. The caller must skip the check, not shrink the evidence. */
  | { readonly kind: 'unavailable'; readonly reason: string };

/** A `whole`/`window` excerpt — what `buildContradictionDirective` can actually put in front of the model. */
export type PresentableExcerpt = Exclude<EvidenceExcerpt, { kind: 'unavailable' }>;

/** Character offset of every physical line of a payload, built by one walk and reused for every slice and every length. */
interface LineIndex {
  /** `starts[i]` is the offset of 1-based line `i + 1`. */
  readonly starts: readonly number[];
  readonly length: number;
  /** Physical line count, not counting the empty segment a trailing newline leaves behind. */
  readonly lineCount: number;
}

function indexLines(content: string): LineIndex | undefined {
  const starts: number[] = [0];
  for (let i = 0; i < content.length; i += 1) {
    if (content.charCodeAt(i) !== 10) continue;
    if (starts.length >= MAX_INDEXED_EVIDENCE_LINES) return undefined;
    starts.push(i + 1);
  }
  const trailingNewline = content.length > 0 && content.charCodeAt(content.length - 1) === 10;
  return { starts, length: content.length, lineCount: starts.length - (trailingNewline ? 1 : 0) };
}

/** End offset of 1-based line `line` — the start of the next line, so the slice keeps that line's own terminator. */
function lineEnd(index: LineIndex, line: number): number {
  return line >= index.starts.length ? index.length : (index.starts[line] as number);
}

function spanChars(index: LineIndex, first: number, last: number): number {
  return lineEnd(index, last) - (index.starts[first - 1] as number);
}

interface LineSpan {
  readonly first: number;
  readonly last: number;
}

/**
 * Physical patch lines covering the cited file lines on `side`. Exact when the
 * patch materializes those lines; otherwise the two lines that bracket them —
 * a diff page's citable positions can span unchanged regions the patch never
 * prints, and bracketing shows the verifier exactly the gap the claim points
 * into. (Showing the whole payload would show that same absence, so this loses
 * nothing.) `undefined` only when no line of the patch carries a number on
 * that side at all.
 */
function anchorInPatch(content: string, range: { readonly startLine: number; readonly endLine: number }, side: 'old' | 'new'): LineSpan | undefined {
  let first: number | undefined;
  let last: number | undefined;
  let before: number | undefined;
  let after: number | undefined;
  for (const hunk of parseHunks(content)) {
    for (const line of hunk.lines) {
      const patchLine = line.patchLine;
      const fileLine = side === 'old' ? line.oldLine : line.newLine;
      if (patchLine === undefined || fileLine === undefined) continue;
      if (fileLine < range.startLine) before = patchLine;
      else if (fileLine > range.endLine) after ??= patchLine;
      else {
        first ??= patchLine;
        last = patchLine;
      }
    }
  }
  if (first !== undefined && last !== undefined) return { first, last };
  if (before !== undefined) return { first: before, last: after ?? before };
  if (after !== undefined) return { first: after, last: after };
  return undefined;
}

/** Payload lines for a citation into a payload that *is* exactly `source.range` — see the `EvidenceExcerpt` note. */
function anchorInLineAlignedPayload(index: LineIndex, source: LedgerEvidenceSource, range: { readonly startLine: number; readonly endLine: number }): LineSpan | undefined {
  const covered = source.range;
  if (!covered) return undefined;
  if (index.lineCount !== covered.endLine - covered.startLine + 1) return undefined;
  const first = range.startLine - covered.startLine + 1;
  const last = range.endLine - covered.startLine + 1;
  if (first < 1 || last < first || last > index.lineCount) return undefined;
  return { first, last };
}

/**
 * Grows `anchor` outward one line at a time, after the far side first so a
 * one-line citation ends up with context on both sides, stopping at whichever
 * limit arrives first: the character budget or `MAX_EXCERPT_CONTEXT_LINES` on
 * each side. No `…` marker is inserted — a marker inside the quoted block
 * would mean the block is no longer the exact bytes; the directive states the
 * omission in its own words instead.
 */
function expandWindow(index: LineIndex, anchor: LineSpan, maxExcerptChars: number): LineSpan {
  let first = anchor.first;
  let last = anchor.last;
  let size = spanChars(index, first, last);
  for (let step = 0; step < MAX_EXCERPT_CONTEXT_LINES; step += 1) {
    let grew = false;
    if (first > 1) {
      const next = size + (lineEnd(index, first - 1) - (index.starts[first - 2] as number));
      if (next <= maxExcerptChars) {
        first -= 1;
        size = next;
        grew = true;
      }
    }
    if (last < index.lineCount) {
      const next = size + (lineEnd(index, last + 1) - (index.starts[last] as number));
      if (next <= maxExcerptChars) {
        last += 1;
        size = next;
        grew = true;
      }
    }
    if (!grew) break;
  }
  return { first, last };
}

/**
 * Chooses the bytes of `source` the contradiction check is allowed to see for
 * `finding`. Never truncates the cited lines themselves: a payload that does
 * not fit and a citation that cannot be located both come back `unavailable`,
 * and the caller skips the check rather than asking about the wrong bytes.
 */
export function selectEvidenceExcerpt(finding: ValidatedFinding, source: LedgerEvidenceSource, maxExcerptChars: number = MAX_EVIDENCE_EXCERPT_CHARS): EvidenceExcerpt {
  const primary = finding.evidence.primary;
  const content = source.exactContent;
  if (content.length <= maxExcerptChars) return { kind: 'whole', text: content };

  const index = indexLines(content);
  if (!index) {
    return { kind: 'unavailable', reason: `Cited evidence for ${primary.path} has more than ${MAX_INDEXED_EVIDENCE_LINES} lines, past what this pass will walk to locate a citation.` };
  }

  // The side is on the returned span, not on the citation: `CitedEvidenceRef`
  // does not keep it. `locationContaining` is the same rule that accepted this
  // citation at validation time, so the span found here is the span the
  // citation was proved to sit inside — never a different one.
  const location = locationContaining(source, primary.path, primary.range);
  const sides: readonly ('old' | 'new')[] = location?.side ? [location.side] : ['new', 'old'];
  let anchor: LineSpan | undefined;
  let side: 'old' | 'new' | undefined;
  if (source.kind === 'diff') {
    for (const candidate of sides) {
      anchor = anchorInPatch(content, primary.range, candidate);
      if (anchor) {
        side = candidate;
        break;
      }
    }
  } else {
    anchor = anchorInLineAlignedPayload(index, source, primary.range);
  }
  if (!anchor) {
    return { kind: 'unavailable', reason: `Lines ${primary.range.startLine}-${primary.range.endLine} of ${primary.path} could not be located inside the exact bytes returned for this evidence, so no window around them can be shown.` };
  }

  const citedChars = spanChars(index, anchor.first, anchor.last);
  if (citedChars > maxExcerptChars) {
    return { kind: 'unavailable', reason: `The cited lines of ${primary.path} are ${citedChars} characters on their own, past the ${maxExcerptChars}-character excerpt budget, so they cannot be shown in full.` };
  }

  const window = expandWindow(index, anchor, maxExcerptChars);
  return {
    kind: 'window',
    text: content.slice(index.starts[window.first - 1] as number, lineEnd(index, window.last)),
    firstLine: window.first,
    lastLine: window.last,
    totalLines: index.lineCount,
    side,
  };
}

/**
 * Builds the bounded directive text sent as `askModel`'s `repairInstruction`
 * for one finding. Carries the candidate id (to bind the reply), the exact
 * primary evidence bytes fetched from the ledger by `sourceId` (never a
 * re-read by path), and a bounded claim summary. Every free-text fragment
 * that did not already come from a bounded/enum-typed field is sanitized
 * through the existing `sanitizePublicText` (never a second redaction
 * routine).
 *
 * The evidence paragraph tells the model *what it is looking at*, and the two
 * excerpt kinds say different things on purpose. A window must declare both
 * coordinate systems, because they differ: `lines 118-164 of 902` are physical
 * lines of the payload (patch lines, `@@` headers included), while the cited
 * `path:startLine-endLine` are file lines on one side of the diff. A verifier
 * told only "here is the evidence" would reason about line numbers that do not
 * match what it was handed.
 *
 * It also says, for a window only, that absence from the window is not
 * contradiction. Validation (`harnessCandidateValidation.ts`) guarantees a
 * finding's quoted `code` appears somewhere in the *whole* payload, not inside
 * the cited range; a window centred on the citation can legitimately exclude
 * it. Without that sentence this fix would trade the old silent false negative
 * for a new false positive — a verifier reading "the quoted text is not here"
 * off a deliberately partial view.
 */
export function buildContradictionDirective(finding: ValidatedFinding, excerpt: PresentableExcerpt): string {
  const primary = finding.evidence.primary;
  const claim = sanitizePublicText(`${finding.item.title} — ${finding.item.body}`) ?? sanitizePublicText(finding.item.title) ?? finding.item.title;
  const sideSuffix = excerpt.kind === 'window' && excerpt.side ? `, ${excerpt.side} side` : '';
  const evidenceHeader =
    excerpt.kind === 'whole'
      ? ['Cited evidence (the exact bytes already returned to you for this source; do not re-read the file):']
      : [
          'Cited evidence (a window of the exact bytes already returned to you for this source, around the cited lines; do not re-read the file):',
          `window: lines ${excerpt.firstLine}-${excerpt.lastLine} of the ${excerpt.totalLines} lines of this source's exact bytes, containing the cited file lines ${primary.path}:${primary.range.startLine}-${primary.range.endLine}${sideSuffix}.`,
          'Judge only the bytes below. The rest of this source exists and was not included, so text missing from this window is not evidence against the claim.',
        ];
  return [
    CONTRADICTION_CHECK_MARKER,
    `candidateId: ${finding.candidateId}`,
    `location: ${primary.path}:${primary.range.startLine}-${primary.range.endLine}`,
    `sourceId: ${primary.sourceId}`,
    `digest: ${primary.digest}`,
    `claim: ${claim}`,
    ...evidenceHeader,
    '"""',
    excerpt.text,
    '"""',
    'Does this exact evidence support or contradict the claim above?',
    `Reply with exactly one JSON object and nothing else: {"candidateId":"${finding.candidateId}","contradicted":<true|false>,"reason":"<required and short when contradicted>"}.`,
  ].join('\n');
}

/** The directive to send, or the reason there is no directive that both shows the cited lines and fits the cap. */
export type BoundedContradictionDirective =
  | { readonly kind: 'directive'; readonly text: string }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Builds one contradiction directive that is guaranteed to fit
 * `HarnessPolicy.maxPromptBytesPerTurn` — the same ceiling every other model-facing prompt is held
 * to — or reports that no honest one exists.
 *
 * **Who bounds what.** The prompt cap bounds the whole directive, in bytes, because that is the
 * promise the setting makes and the seam refuses to send anything over it.
 * `MAX_EVIDENCE_EXCERPT_CHARS` bounds the excerpt, in characters, because that is a judgement
 * about how much evidence a verifier needs. The smaller wins. Neither may ever truncate the cited
 * lines themselves: a check performed on bytes that do not contain the citation is the silent
 * false negative `selectEvidenceExcerpt`'s note describes, so when the citation will not fit the
 * answer is `unavailable` and the caller records the finding unverified.
 *
 * **Why it measures rather than computes.** The overhead — candidate id, location, digest, claim,
 * the window header's own two coordinate systems — is text, and its length depends on the finding.
 * So the excerpt is chosen, the directive built, and the real bytes counted; if it does not fit,
 * the exact overhead is now known (built bytes minus excerpt bytes) and the excerpt is re-chosen
 * against the room that actually remains, converted from bytes to characters at the worst case a
 * UTF-8 encoding can cost. Three passes is one more than the arithmetic needs, and they are there
 * because the window header's own digits change length as the window moves.
 */
export function buildBoundedContradictionDirective(finding: ValidatedFinding, source: LedgerEvidenceSource, maxPromptBytes: number): BoundedContradictionDirective {
  let charBudget = MAX_EVIDENCE_EXCERPT_CHARS;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (charBudget < 1) break;
    const excerpt = selectEvidenceExcerpt(finding, source, charBudget);
    if (excerpt.kind === 'unavailable') return { kind: 'unavailable', reason: excerpt.reason };
    const text = buildContradictionDirective(finding, excerpt);
    const bytes = directiveByteLength(text);
    if (bytes <= maxPromptBytes) return { kind: 'directive', text };
    const room = maxPromptBytes - (bytes - directiveByteLength(excerpt.text));
    if (room <= 0) {
      return {
        kind: 'unavailable',
        reason: `The contradiction check's own framing for this finding needs ${bytes - directiveByteLength(excerpt.text)} bytes, at or over the ${maxPromptBytes}-byte per-turn prompt cap, so no evidence could be shown with it.`,
      };
    }
    charBudget = Math.floor(room / MAX_UTF8_BYTES_PER_UNIT);
  }
  return { kind: 'unavailable', reason: `No excerpt of ${finding.evidence.primary.path} containing the cited lines fits the ${maxPromptBytes}-byte per-turn prompt cap alongside this check's own framing.` };
}

export interface ContradictionVerdict {
  readonly contradicted: boolean;
  readonly reason?: string;
}

function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const attempts: string[] = [trimmed];
  const fenced = /^```[a-zA-Z]*\n?([\s\S]*?)\n?```$/.exec(trimmed);
  if (fenced) attempts.push((fenced[1] ?? '').trim());
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) attempts.push(trimmed.slice(start, end + 1));
  for (const attempt of attempts) {
    try {
      return JSON.parse(attempt) as unknown;
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * Fail-closed parse of one verdict response: wrong shape, a missing or
 * non-matching `candidateId` (the binding that stops a reply about one
 * finding being applied to another), or a non-boolean `contradicted`
 * all return `undefined` — never a best-effort guess. Bounded by
 * `MAX_TURN_RAW_BYTES` (reused from `../domain/harnessProtocol.ts`, not a
 * new limit) before anything is even parsed.
 */
export function parseContradictionVerdict(raw: string, expectedCandidateId: string): ContradictionVerdict | undefined {
  if (new TextEncoder().encode(raw).length > MAX_TURN_RAW_BYTES) return undefined;
  const value = extractJsonObject(raw);
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.candidateId !== expectedCandidateId) return undefined;
  if (typeof record.contradicted !== 'boolean') return undefined;
  if (!record.contradicted) return { contradicted: false };
  const reason = sanitizePublicText(record.reason) ?? 'The model found the cited evidence does not support this claim.';
  return { contradicted: true, reason };
}

export interface ContradictedFindingRecord {
  readonly candidateId: string;
  readonly reason: string;
}

export interface ContradictionCheckContext {
  readonly modelSeam: HarnessModelSeam;
  readonly ledger: EvidenceLedger;
  readonly policy: HarnessPolicy;
  readonly cancellation?: AgentCancellationToken;
  /** Forwarded straight from `SynthesisVerificationInput`'s own field of the same name — see its comment there. */
  readonly onModelTurnTiming?: (timing: ModelTurnTiming) => void;
}

export interface ContradictionCheckResult {
  /** Survivors: findings the model did not contradict, plus any finding whose verdict could not be confirmed (kept conservatively; see this module's header). */
  readonly findings: readonly ValidatedFinding[];
  readonly contradicted: readonly ContradictedFindingRecord[];
  /**
   * Survivors whose check did not happen or did not conclude, each with why —
   * the per-finding half of `complete: false`. Without this the only trace of
   * an unchecked finding is one aggregate flag for the whole stage, and the
   * finding itself reaches the reviewer looking exactly like a checked one.
   *
   * Every entry is also in `findings`: not being checked is never grounds to
   * drop an already-validated finding.
   */
  readonly unverified: readonly UnverifiedFindingRecord[];
  /** False if cancellation, an evidence mismatch, an unshowable excerpt, or an exhausted repair allowance left any finding unconfirmed. */
  readonly complete: boolean;
}

function isCancelled(cancellation: AgentCancellationToken | undefined): boolean {
  return cancellation?.isCancellationRequested === true;
}

/**
 * Stage 2: for every surviving (post-dedup) finding, in deterministic
 * `candidateId` order, fetches its exact primary evidence from the ledger by
 * `sourceId`, verifies the digest still matches, and asks the same model
 * seam to challenge the claim. A shared repair allowance
 * (`policy.protocolRepairsPerPhase`) covers the whole stage's malformed or
 * mis-bound responses, never a per-finding budget.
 */
export async function runContradictionChecks(findings: readonly ValidatedFinding[], context: ContradictionCheckContext): Promise<ContradictionCheckResult> {
  const maxRepairs = Math.max(0, context.policy.protocolRepairsPerPhase);
  let repairsUsed = 0;
  let complete = true;
  const survivors: ValidatedFinding[] = [];
  const contradicted: ContradictedFindingRecord[] = [];
  const unverified: UnverifiedFindingRecord[] = [];
  const ordered = [...findings].sort(compareCandidateId);

  async function askOnce(finding: ValidatedFinding, directive: string): Promise<string | undefined> {
    try {
      return await context.modelSeam.askModel({
        phase: 'verifying',
        repairInstruction: directive,
        toolResults: [],
        onTiming: context.onModelTurnTiming,
      });
    } catch {
      return undefined;
    }
  }

  for (let index = 0; index < ordered.length; index += 1) {
    const finding = ordered[index] as ValidatedFinding;
    if (isCancelled(context.cancellation)) {
      complete = false;
      survivors.push(...ordered.slice(index));
      break;
    }
    const source = context.ledger.get(finding.evidence.primary.sourceId);
    if (!source || source.digest !== finding.evidence.primary.digest) {
      complete = false;
      contradicted.push({ candidateId: finding.candidateId, reason: 'Cited evidence no longer resolves to the exact bytes originally returned to the model.' });
      continue;
    }

    // The whole directive is built and measured before a single turn is spent, against the same
    // per-turn prompt cap every other model-facing prompt is held to. A directive that cannot both
    // show the cited lines and fit the cap ends the finding's check here: no `askModel` call, no
    // draw on the shared repair allowance (nothing malformed happened — the question was never
    // asked), the finding kept, the stage incomplete. Asking anyway on whatever bytes happened to
    // fit is the exact failure `selectEvidenceExcerpt`'s note describes; asking anyway on a prompt
    // over the cap is the failure `buildBoundedContradictionDirective`'s note describes.
    const directive = buildBoundedContradictionDirective(finding, source, context.policy.maxPromptBytesPerTurn);
    if (directive.kind === 'unavailable') {
      complete = false;
      unverified.push({ candidateId: finding.candidateId, reason: `Contradiction check not performed. ${directive.reason}` });
      survivors.push(finding);
      continue;
    }

    let raw = await askOnce(finding, directive.text);
    let verdict = raw !== undefined ? parseContradictionVerdict(raw, finding.candidateId) : undefined;
    while (verdict === undefined && repairsUsed < maxRepairs && !isCancelled(context.cancellation)) {
      repairsUsed += 1;
      raw = await askOnce(finding, directive.text);
      verdict = raw !== undefined ? parseContradictionVerdict(raw, finding.candidateId) : undefined;
    }

    if (verdict === undefined) {
      complete = false;
      unverified.push({ candidateId: finding.candidateId, reason: 'Contradiction check did not conclude: no usable verdict came back within the shared repair allowance.' });
      survivors.push(finding);
      continue;
    }
    if (verdict.contradicted) {
      contradicted.push({ candidateId: finding.candidateId, reason: verdict.reason ?? 'The model found the cited evidence does not support this claim.' });
    } else {
      survivors.push(finding);
    }
  }

  return { findings: survivors.sort(compareCandidateId), contradicted, unverified, complete };
}

// ---- Adapter: the injected `SynthesisVerificationRunner` --------------------------

/**
 * Wires both stages into the exact seam `harnessAttempt.ts` already defines
 * and injects. Never the default: `harnessAttempt.ts`'s own
 * `defaultSynthesisVerification` (an honest no-op reporting every pass
 * incomplete) remains what `createHarnessAttempt` falls back to when no
 * `synthesisVerification` option is supplied — this stays an opt-in
 * collaborator a caller passes explicitly, exactly like the test file's own
 * `passthroughVerification`/`verificationThatAsksModel` fakes.
 */
export function createSynthesisVerification(): SynthesisVerificationRunner {
  return async (input: SynthesisVerificationInput): Promise<SynthesisVerificationOutput> => {
    if (isCancelled(input.cancellation)) {
      return Object.freeze({ findings: input.findings, contradictionPassComplete: false, deduplicationComplete: false, finalVerificationComplete: false });
    }
    const deduped = deduplicateFindings(input.findings);
    const policy = input.policy ?? DEFAULT_HARNESS_POLICY;
    const contradictionResult = await runContradictionChecks(deduped, {
      modelSeam: input.modelSeam,
      ledger: input.ledger,
      policy,
      cancellation: input.cancellation,
      onModelTurnTiming: input.onModelTurnTiming,
    });
    return Object.freeze({
      findings: contradictionResult.findings,
      contradicted: contradictionResult.contradicted,
      unverified: contradictionResult.unverified,
      deduplicationComplete: true,
      contradictionPassComplete: contradictionResult.complete,
      finalVerificationComplete: contradictionResult.complete,
    });
  };
}
