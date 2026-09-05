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
 *    reimplements that.
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
 *   received a parseable, id-matching verdict, with no cancellation and no
 *   unresolvable evidence mismatch along the way.
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
import type { AgentCancellationToken } from './lmAgent';
import type { HarnessModelSeam, SynthesisVerificationInput, SynthesisVerificationOutput, SynthesisVerificationRunner } from './harnessAttempt';
import type { CitedEvidenceRef, ValidatedFinding } from './harnessCandidateValidation';
import { sanitizePublicText } from './harnessActivitySanitizer';
import { MAX_TURN_RAW_BYTES } from '../domain/harnessProtocol';
import type { SourceCitation } from '../domain/harnessEvidence';
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

const MAX_EVIDENCE_EXCERPT_CHARS = 4_000;

function truncatedExcerpt(content: string): string {
  return content.length > MAX_EVIDENCE_EXCERPT_CHARS ? `${content.slice(0, MAX_EVIDENCE_EXCERPT_CHARS)}…` : content;
}

/**
 * Builds the bounded directive text sent as `askModel`'s `repairInstruction`
 * for one finding. Carries the candidate id (to bind the reply), the exact
 * primary evidence bytes fetched from the ledger by `sourceId` (never a
 * re-read by path), and a bounded claim summary. Every free-text fragment
 * that did not already come from a bounded/enum-typed field is sanitized
 * through the existing `sanitizePublicText` (never a second redaction
 * routine).
 */
export function buildContradictionDirective(finding: ValidatedFinding, source: LedgerEvidenceSource): string {
  const primary = finding.evidence.primary;
  const claim = sanitizePublicText(`${finding.item.title} — ${finding.item.body}`) ?? sanitizePublicText(finding.item.title) ?? finding.item.title;
  return [
    CONTRADICTION_CHECK_MARKER,
    `candidateId: ${finding.candidateId}`,
    `location: ${primary.path}:${primary.range.startLine}-${primary.range.endLine}`,
    `sourceId: ${primary.sourceId}`,
    `digest: ${primary.digest}`,
    `claim: ${claim}`,
    'Cited evidence (the exact bytes already returned to you for this source; do not re-read the file):',
    '"""',
    truncatedExcerpt(source.exactContent),
    '"""',
    'Does this exact evidence support or contradict the claim above?',
    `Reply with exactly one JSON object and nothing else: {"candidateId":"${finding.candidateId}","contradicted":<true|false>,"reason":"<required and short when contradicted>"}.`,
  ].join('\n');
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
}

export interface ContradictionCheckResult {
  /** Survivors: findings the model did not contradict, plus any finding whose verdict could not be confirmed (kept conservatively; see this module's header). */
  readonly findings: readonly ValidatedFinding[];
  readonly contradicted: readonly ContradictedFindingRecord[];
  /** False if cancellation, an evidence mismatch, or an exhausted repair allowance left any finding unconfirmed. */
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
  const ordered = [...findings].sort(compareCandidateId);

  async function askOnce(finding: ValidatedFinding, source: LedgerEvidenceSource): Promise<string | undefined> {
    try {
      return await context.modelSeam.askModel({ phase: 'verifying', repairInstruction: buildContradictionDirective(finding, source), toolResults: [] });
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

    let raw = await askOnce(finding, source);
    let verdict = raw !== undefined ? parseContradictionVerdict(raw, finding.candidateId) : undefined;
    while (verdict === undefined && repairsUsed < maxRepairs && !isCancelled(context.cancellation)) {
      repairsUsed += 1;
      raw = await askOnce(finding, source);
      verdict = raw !== undefined ? parseContradictionVerdict(raw, finding.candidateId) : undefined;
    }

    if (verdict === undefined) {
      complete = false;
      survivors.push(finding);
      continue;
    }
    if (verdict.contradicted) {
      contradicted.push({ candidateId: finding.candidateId, reason: verdict.reason ?? 'The model found the cited evidence does not support this claim.' });
    } else {
      survivors.push(finding);
    }
  }

  return { findings: survivors.sort(compareCandidateId), contradicted, complete };
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
    });
    return Object.freeze({
      findings: contradictionResult.findings,
      contradicted: contradictionResult.contradicted,
      deduplicationComplete: true,
      contradictionPassComplete: contradictionResult.complete,
      finalVerificationComplete: contradictionResult.complete,
    });
  };
}
