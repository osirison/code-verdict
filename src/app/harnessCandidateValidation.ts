/**
 * Incremental candidate-finding validation (tasks 7.6-7.8 of
 * `add-agentic-review-harness`, design.md D9/D8/D16, spec
 * `review-evidence-ledger` "Candidate submission and citation validation are
 * incremental" and "Primary findings remain scoped to changed or selected
 * evidence").
 *
 * `validateCandidate` is the host side of `submitCandidateFinding`: it takes
 * a model-supplied candidate as `unknown`, checks schema, criteria, member
 * identity, citations (through `./harnessCitations`, never by refetching),
 * revision binding, location, citable status, and primary-target
 * eligibility, and returns exactly one of `accepted | repairable | rejected`
 * with bounded public reasons. An accepted candidate becomes a
 * `ValidatedFinding`: a `ReviewItem` the existing triage/submit path already
 * understands, routed `inline` or `summary`, plus audit provenance
 * (`protocolProvenance: 'harness'`, cited source identifiers and digests,
 * the member's repository and base/head) that carries **no exact evidence
 * bytes** — retained findings persist identifiers and digests, and the
 * ledger stays the only holder of content.
 *
 * Primary-target eligibility (task 7.7) is a rule on the primary citation's
 * origin, not on the model's say-so:
 * - `diffPage`  → changed evidence; the finding is `inline` (anchored by
 *   changed-file membership, as the upstream context-controls contract
 *   defines it; the existing anchor matcher still resolves exact/moved/lost
 *   lines at submit time, so old-side positions are not rejected here).
 * - `attachment` → an explicit reviewer-selected citable attachment may be a
 *   primary target; it is `inline` only when its path is also a changed file
 *   of that member, otherwise `summary` — the upstream summary-routing rule.
 * - `fileRange`, `repositorySearch`, `diffSearch` → unchanged (or excerpt)
 *   repository evidence: valid as *supporting* citations only. As a primary
 *   they are rejected with `unchangedPrimaryTarget`, so investigation cannot
 *   quietly widen the review to a file the reviewer never selected.
 *
 * Criteria is a validation dimension here because task 7.6 lists it, but the
 * outcome keeps the bucket (`criteriaReason`) so a later clean-bill screen can
 * still count sub-threshold candidates the way `agentResponse.ts` did.
 *
 * `revalidateFindings` (task 7.8) re-runs citation resolution for retained
 * findings after synthesis/verification, or on a resumed attempt's ledger:
 * anything whose source is gone, whose digest drifted, or whose member head
 * no longer matches the current head is *invalidated* — removed from the
 * valid set and reported, never silently kept. `createCandidateTracker` is
 * the small bookkeeping D9/D11 need: unresolved candidates (repairable ones
 * still within the repair allowance, or invalidated ones) stay out of triage
 * and block complete status until they are repaired, rejected, or validated.
 */
import { filterReason, SEVERITY_ORDER, type Criteria, type FilterReason } from '../domain/criteria';
import type { SourceCitation, ValidatedFindingProvenance } from '../domain/harnessEvidence';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import { ALL_CATEGORIES, type Category, type ReviewItem, type Severity } from '../domain/types';
import { resolveCandidateCitations, type CitationResolution, type ResolvedCitation } from './harnessCitations';
import { normalizeEvidencePath, normalizeEvidenceRange, type EvidenceLedger, type EvidenceOrigin } from './harnessEvidenceLedger';

export type FindingRouting = 'inline' | 'summary';

/** The host-side candidate shape; the model protocol (section 10) parses into this. */
export interface CandidateFinding {
  readonly candidateId: string;
  readonly memberId: string;
  readonly file: string;
  readonly line: number;
  readonly endLine?: number;
  readonly severity: Severity;
  readonly category: Category;
  readonly confidence: number;
  readonly title: string;
  readonly body: string;
  /** The offending text; when present it must appear in the primary evidence. */
  readonly code?: string;
  readonly rule?: string;
  readonly reference?: string;
  readonly suggestion?: { readonly old: string; readonly new: string };
  readonly citations: { readonly primary: SourceCitation; readonly supporting?: readonly SourceCitation[] };
}

export interface ValidationReason {
  readonly code: string;
  readonly message: string;
}

export interface CitedEvidenceRef {
  readonly sourceId: string;
  readonly digest: string;
  readonly origin: EvidenceOrigin;
  readonly memberId: string;
  readonly repositoryId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly path: string;
  readonly range: { readonly startLine: number; readonly endLine: number };
}

/** Everything persisted about an accepted candidate; deliberately no `exactContent` anywhere in this shape. */
export interface ValidatedFinding {
  readonly candidateId: string;
  readonly memberId: string;
  readonly routing: FindingRouting;
  readonly item: ReviewItem;
  readonly provenance: ValidatedFindingProvenance;
  readonly evidence: {
    readonly repositoryId: string;
    readonly baseSha: string;
    readonly headSha: string;
    readonly primary: CitedEvidenceRef;
    readonly supporting: readonly CitedEvidenceRef[];
  };
}

export type CandidateValidationOutcome =
  | { readonly state: 'accepted'; readonly candidateId: string; readonly finding: ValidatedFinding; readonly reasons: readonly [] }
  | { readonly state: 'repairable'; readonly candidateId: string; readonly reasons: readonly ValidationReason[] }
  | { readonly state: 'rejected'; readonly candidateId: string; readonly reasons: readonly ValidationReason[]; readonly criteriaReason?: FilterReason };

export interface CandidateValidationContext {
  readonly ledger: EvidenceLedger;
  readonly criteria: Criteria;
  /** Changed paths per member (normalized or not); decides attachment inline-vs-summary routing. Absent means no member has changed paths known. */
  readonly changedPathsByMember?: ReadonlyMap<string, ReadonlySet<string>>;
  /** ISO timestamp recorded as `validatedAt`. */
  readonly now: string;
}

const SEVERITIES = new Set<string>(SEVERITY_ORDER);
const CATEGORIES = new Set<string>(ALL_CATEGORIES);
const PRIMARY_ELIGIBLE_ORIGINS: ReadonlySet<EvidenceOrigin> = new Set<EvidenceOrigin>(['diffPage', 'attachment']);
const MAX_TEXT_FIELD_LENGTH = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string') return undefined;
  if (required && value.trim() === '') return undefined;
  return value.length > MAX_TEXT_FIELD_LENGTH ? value.slice(0, MAX_TEXT_FIELD_LENGTH) : value;
}

/** Fail-closed schema parse of a model-supplied candidate. Returns the reasons instead of a candidate when anything is off. */
export function parseCandidateFinding(raw: unknown): { candidate: CandidateFinding } | { reasons: ValidationReason[] } {
  const reasons: ValidationReason[] = [];
  if (!isRecord(raw)) return { reasons: [{ code: 'schema', message: 'Candidate must be an object.' }] };
  const candidateId = boundedString(raw.candidateId, true);
  if (!candidateId) reasons.push({ code: 'schema', message: 'candidateId is required.' });
  const memberId = boundedString(raw.memberId, true);
  if (!memberId) reasons.push({ code: 'schema', message: 'memberId is required.' });
  const file = typeof raw.file === 'string' ? normalizeEvidencePath(raw.file) : undefined;
  if (!file) reasons.push({ code: 'schema', message: 'file must be a usable repository-relative path.' });
  const range = normalizeEvidenceRange(raw.line, raw.endLine);
  if (!range) reasons.push({ code: 'schema', message: 'line/endLine must be positive integers with endLine >= line.' });
  if (typeof raw.severity !== 'string' || !SEVERITIES.has(raw.severity)) reasons.push({ code: 'schema', message: 'severity is not a known value.' });
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) reasons.push({ code: 'schema', message: 'category is not a known value.' });
  if (typeof raw.confidence !== 'number' || !Number.isFinite(raw.confidence) || raw.confidence < 0 || raw.confidence > 100) {
    reasons.push({ code: 'schema', message: 'confidence must be a finite number from 0 to 100.' });
  }
  const title = boundedString(raw.title, true);
  if (!title) reasons.push({ code: 'schema', message: 'title is required.' });
  const body = boundedString(raw.body, false) ?? '';
  const code = boundedString(raw.code, false);
  if (raw.code !== undefined && code === undefined) reasons.push({ code: 'schema', message: 'code must be a string when present.' });
  const rule = boundedString(raw.rule, false);
  const reference = boundedString(raw.reference, false);
  let suggestion: { old: string; new: string } | undefined;
  if (raw.suggestion !== undefined) {
    if (isRecord(raw.suggestion) && typeof raw.suggestion.old === 'string' && typeof raw.suggestion.new === 'string') {
      suggestion = { old: raw.suggestion.old.slice(0, MAX_TEXT_FIELD_LENGTH), new: raw.suggestion.new.slice(0, MAX_TEXT_FIELD_LENGTH) };
    } else {
      reasons.push({ code: 'schema', message: 'suggestion must carry old and new strings.' });
    }
  }
  if (!isRecord(raw.citations) || raw.citations.primary === undefined) {
    reasons.push({ code: 'schema', message: 'citations.primary is required.' });
  } else if (raw.citations.supporting !== undefined && !Array.isArray(raw.citations.supporting)) {
    reasons.push({ code: 'schema', message: 'citations.supporting must be an array when present.' });
  }
  if (reasons.length > 0) return { reasons };
  const citations = raw.citations as Record<string, unknown>;
  return {
    candidate: {
      candidateId: candidateId as string,
      memberId: memberId as string,
      file: file as string,
      line: (range as { startLine: number }).startLine,
      endLine: raw.endLine === undefined ? undefined : (range as { endLine: number }).endLine,
      severity: raw.severity as Severity,
      category: raw.category as Category,
      confidence: raw.confidence as number,
      title: title as string,
      body,
      code,
      rule,
      reference,
      suggestion,
      // Citations stay opaque here; `resolveCitation` validates their shape and content.
      citations: { primary: citations.primary as SourceCitation, supporting: citations.supporting as SourceCitation[] | undefined },
    },
  };
}

function reasonFromResolution(prefix: string, resolution: CitationResolution): ValidationReason | undefined {
  if (resolution.ok) return undefined;
  return { code: `${prefix}:${resolution.code}`, message: resolution.message };
}

function citedRef(resolution: ResolvedCitation): CitedEvidenceRef {
  return {
    sourceId: resolution.source.sourceId,
    digest: resolution.source.digest,
    origin: resolution.source.origin,
    memberId: resolution.source.memberId,
    repositoryId: resolution.source.repositoryId,
    baseSha: resolution.source.baseSha,
    headSha: resolution.source.headSha,
    path: resolution.cited.path,
    range: resolution.cited.range,
  };
}

function toCitation(ref: CitedEvidenceRef): SourceCitation {
  return { sourceId: ref.sourceId, digest: ref.digest, path: ref.path, range: ref.range };
}

function isChangedPath(context: CandidateValidationContext, memberId: string, path: string): boolean {
  const changed = context.changedPathsByMember?.get(memberId);
  if (!changed) return false;
  for (const candidate of changed) if (normalizeEvidencePath(candidate) === path) return true;
  return false;
}

/** Routing for an accepted primary: exposed so the section-10 synthesis step can reuse it verbatim. */
export function routingForPrimary(context: CandidateValidationContext, memberId: string, origin: EvidenceOrigin, path: string): FindingRouting | undefined {
  if (origin === 'diffPage') return 'inline';
  if (origin === 'attachment') return isChangedPath(context, memberId, path) ? 'inline' : 'summary';
  return undefined;
}

export function validateCandidate(raw: unknown, context: CandidateValidationContext): CandidateValidationOutcome {
  const parsed = parseCandidateFinding(raw);
  if ('reasons' in parsed) {
    const candidateId = isRecord(raw) && typeof raw.candidateId === 'string' ? raw.candidateId : '';
    return { state: 'rejected', candidateId, reasons: parsed.reasons };
  }
  const candidate = parsed.candidate;
  const rejected: ValidationReason[] = [];
  const repairable: ValidationReason[] = [];

  const member = context.ledger.member(candidate.memberId);
  if (!member) {
    rejected.push({ code: 'unknownMember', message: `Member ${candidate.memberId} is not part of this run.` });
    return { state: 'rejected', candidateId: candidate.candidateId, reasons: rejected };
  }

  const resolved = resolveCandidateCitations(context.ledger, candidate.citations, candidate.memberId);
  const primaryReason = reasonFromResolution('primary', resolved.primary);
  if (primaryReason) (!resolved.primary.ok && resolved.primary.repairable ? repairable : rejected).push(primaryReason);
  resolved.supporting.forEach((resolution, index) => {
    const reason = reasonFromResolution(`supporting[${index}]`, resolution);
    if (reason) (!resolution.ok && resolution.repairable ? repairable : rejected).push(reason);
  });

  let routing: FindingRouting | undefined;
  if (resolved.primary.ok) {
    const primary = resolved.primary;
    // Revision binding: the ledger guarantees this, but a finding's persisted provenance must never disagree with its member.
    if (primary.source.headSha !== member.headSha || primary.source.baseSha !== member.baseSha || primary.source.repositoryId !== member.repositoryId) {
      rejected.push({ code: 'revisionMismatch', message: 'Primary evidence is bound to a different repository or revision than the candidate member.' });
    }
    const candidateRange = { startLine: candidate.line, endLine: candidate.endLine ?? candidate.line };
    if (primary.cited.path !== candidate.file) {
      rejected.push({ code: 'locationMismatch', message: `Candidate names ${candidate.file} but its primary evidence is ${primary.cited.path}.` });
    } else if (candidateRange.startLine < primary.location.range.startLine || candidateRange.endLine > primary.location.range.endLine) {
      rejected.push({ code: 'locationOutsideEvidence', message: `Lines ${candidateRange.startLine}-${candidateRange.endLine} of ${candidate.file} were not in the primary evidence returned to the model.` });
    }
    if (candidate.code !== undefined && candidate.code !== '' && !primary.source.exactContent.includes(candidate.code)) {
      rejected.push({ code: 'codeNotInEvidence', message: 'The quoted code does not appear in the primary evidence returned to the model.' });
    }
    routing = routingForPrimary(context, candidate.memberId, primary.source.origin, primary.cited.path);
    if (!routing) {
      rejected.push({
        code: 'unchangedPrimaryTarget',
        message: PRIMARY_ELIGIBLE_ORIGINS.has(primary.source.origin)
          ? 'Primary evidence is not eligible.'
          : `${primary.source.origin} evidence can corroborate a finding about changed code but cannot be its primary target.`,
      });
    }
  }

  const criteriaReason = filterReason(candidate, context.criteria);
  if (criteriaReason) rejected.push({ code: `criteria:${criteriaReason}`, message: 'Candidate falls below the run criteria.' });

  if (rejected.length > 0) return { state: 'rejected', candidateId: candidate.candidateId, reasons: [...rejected, ...repairable], criteriaReason: criteriaReason ?? undefined };
  if (repairable.length > 0) return { state: 'repairable', candidateId: candidate.candidateId, reasons: repairable };

  const primary = resolved.primary as ResolvedCitation;
  const supporting = resolved.supporting.filter((resolution): resolution is ResolvedCitation => resolution.ok).map(citedRef);
  const primaryRef = citedRef(primary);
  // 13.5/D15: a finding whose supporting evidence reaches into another member is exactly what
  // the pre-harness changeset UI already calls a "cross" finding (`combinedAgent.ts`,
  // `changesetFindings.ts`'s `collectCrossFindings` filter on `cross && spans.length >= 2`). A
  // same-member supporting citation does not qualify — only evidence that actually crosses a
  // repository boundary does.
  const crossMemberSupporting = supporting.filter((ref) => ref.memberId !== candidate.memberId);
  const spans =
    crossMemberSupporting.length > 0
      ? [
          { repoId: member.repositoryId, location: `${candidate.file}:${candidate.line}`, role: 'primary evidence' },
          ...crossMemberSupporting.map((ref) => ({ repoId: ref.repositoryId, location: `${ref.path}:${ref.range.startLine}`, role: 'supporting evidence' })),
        ]
      : undefined;
  const item: ReviewItem = {
    id: candidate.candidateId,
    file: candidate.file,
    anchored: routing === 'inline',
    line: candidate.line,
    endLine: candidate.endLine,
    severity: candidate.severity,
    category: candidate.category,
    confidence: candidate.confidence,
    title: candidate.title,
    body: candidate.body,
    code: candidate.code ?? '',
    rule: candidate.rule,
    reference: candidate.reference,
    repoId: member.repositoryId,
    crNumber: member.changeRequestNumber,
    suggestion: candidate.suggestion ? { ...candidate.suggestion } : undefined,
    ...(spans ? { cross: true, spans } : {}),
  };
  return {
    state: 'accepted',
    candidateId: candidate.candidateId,
    reasons: [],
    finding: {
      candidateId: candidate.candidateId,
      memberId: candidate.memberId,
      routing: routing as FindingRouting,
      item,
      provenance: {
        protocolProvenance: 'harness',
        citations: [toCitation(primaryRef), ...supporting.map(toCitation)],
        validatedAt: context.now,
      },
      evidence: { repositoryId: member.repositoryId, baseSha: member.baseSha, headSha: member.headSha, primary: primaryRef, supporting },
    },
  };
}

/** Domain-shaped summary for callers that only need `state` + public reasons. */
export function toCandidateValidationResult(outcome: CandidateValidationOutcome): { state: CandidateValidationOutcome['state']; reasons: readonly string[] } {
  return { state: outcome.state, reasons: outcome.reasons.map((reason) => `${reason.code}: ${reason.message}`) };
}

export interface RevalidationContext {
  readonly ledger: EvidenceLedger;
  /** Latest known head per member; a member whose head moved invalidates every finding bound to it. */
  readonly currentHeads?: ReadonlyMap<string, string>;
  readonly now: string;
}

export interface InvalidatedFinding {
  readonly finding: ValidatedFinding;
  readonly reasons: readonly ValidationReason[];
}

export interface RevalidationResult {
  readonly valid: readonly ValidatedFinding[];
  readonly invalidated: readonly InvalidatedFinding[];
}

/**
 * Re-resolves every retained citation against the ledger as it is now — after
 * synthesis/verification, or on a resumed attempt's ledger — and against the
 * current head. Never repairs: a finding either still resolves exactly or it
 * is explicitly invalidated and must be resubmitted or dropped.
 */
export function revalidateFindings(findings: readonly ValidatedFinding[], context: RevalidationContext): RevalidationResult {
  const valid: ValidatedFinding[] = [];
  const invalidated: InvalidatedFinding[] = [];
  for (const finding of findings) {
    const reasons: ValidationReason[] = [];
    const member = context.ledger.member(finding.memberId);
    if (!member) reasons.push({ code: 'unknownMember', message: `Member ${finding.memberId} is not part of this attempt.` });
    else if (member.headSha !== finding.evidence.headSha || member.baseSha !== finding.evidence.baseSha || member.repositoryId !== finding.evidence.repositoryId) {
      reasons.push({ code: 'revisionMismatch', message: 'Finding evidence is bound to a different revision than this attempt.' });
    }
    const currentHead = context.currentHeads?.get(finding.memberId);
    if (currentHead !== undefined && currentHead !== finding.evidence.headSha) {
      reasons.push({ code: 'headChanged', message: `Member ${finding.memberId} head moved from ${finding.evidence.headSha} to ${currentHead}.` });
    }
    const resolved = resolveCandidateCitations(
      context.ledger,
      { primary: toCitation(finding.evidence.primary), supporting: finding.evidence.supporting.map(toCitation) },
      finding.memberId,
    );
    const primaryReason = reasonFromResolution('primary', resolved.primary);
    if (primaryReason) reasons.push(primaryReason);
    else if (resolved.primary.ok && resolved.primary.source.digest !== finding.evidence.primary.digest) {
      reasons.push({ code: 'primary:digestMismatch', message: 'Primary evidence digest changed.' });
    }
    resolved.supporting.forEach((resolution, index) => {
      const reason = reasonFromResolution(`supporting[${index}]`, resolution);
      if (reason) reasons.push(reason);
    });
    if (reasons.length > 0) invalidated.push({ finding, reasons });
    else valid.push({ ...finding, provenance: { ...finding.provenance, validatedAt: context.now } });
  }
  return { valid, invalidated };
}

export type TrackedCandidateState = 'accepted' | 'unresolved' | 'rejected';

export interface TrackedCandidate {
  readonly candidateId: string;
  readonly state: TrackedCandidateState;
  readonly repairs: number;
  readonly reasons: readonly ValidationReason[];
  readonly finding?: ValidatedFinding;
}

export interface CandidateTracker {
  /** Records one submission (or resubmission) outcome; repair attempts beyond the allowance become rejections. */
  record(outcome: CandidateValidationOutcome): TrackedCandidate;
  /** Moves a previously accepted candidate back to unresolved after revalidation failed. */
  invalidate(candidateId: string, reasons: readonly ValidationReason[]): TrackedCandidate | undefined;
  get(candidateId: string): TrackedCandidate | undefined;
  all(): readonly TrackedCandidate[];
  /** Accepted findings only — what triage may show. */
  triageFindings(): readonly ValidatedFinding[];
  unresolvedCount(): number;
  /** D11: any unresolved candidate refuses complete status. */
  blocksCompletion(): boolean;
}

export interface CandidateTrackerOptions {
  /** Repairs allowed per candidate; defaults to the policy's protocol-repair allowance. */
  maxRepairsPerCandidate?: number;
  /**
   * Task 14.6: a resumed attempt's candidates, read straight off the prior attempt's last
   * checkpoint (`harnessResume.ts`'s `ResumePayload.candidates`) — "validated findings and their
   * validation state" is explicitly part of what a resume preserves. Loaded verbatim; unlike
   * `BudgetTracker`'s carry-forward this needs no reconstruction, since `TrackedCandidate` is
   * exactly this tracker's own state shape. An accepted candidate seeded here may still need
   * `invalidate()` if evidence re-import (`importRetainedEvidence`) could not reuse a source it
   * cites — the resume entry point's job, not this constructor's.
   */
  seed?: readonly TrackedCandidate[];
}

export function createCandidateTracker(options: CandidateTrackerOptions = {}): CandidateTracker {
  const maxRepairs = options.maxRepairsPerCandidate ?? DEFAULT_HARNESS_POLICY.protocolRepairsPerPhase;
  const tracked = new Map<string, TrackedCandidate>();

  function set(candidate: TrackedCandidate): TrackedCandidate {
    const frozen = Object.freeze(candidate);
    tracked.set(candidate.candidateId, frozen);
    return frozen;
  }

  for (const candidate of options.seed ?? []) set(candidate);

  return {
    record(outcome) {
      const previous = tracked.get(outcome.candidateId);
      const repairs = previous ? previous.repairs : 0;
      if (previous?.state === 'rejected') return previous; // a rejected candidate is closed; resubmit under a new id
      switch (outcome.state) {
        case 'accepted':
          return set({ candidateId: outcome.candidateId, state: 'accepted', repairs, reasons: [], finding: outcome.finding });
        case 'rejected':
          return set({ candidateId: outcome.candidateId, state: 'rejected', repairs, reasons: outcome.reasons });
        case 'repairable': {
          const nextRepairs = previous ? repairs + 1 : 0;
          if (nextRepairs > maxRepairs) {
            return set({
              candidateId: outcome.candidateId,
              state: 'rejected',
              repairs: nextRepairs,
              reasons: [{ code: 'repairLimit', message: `Candidate exceeded ${maxRepairs} repair attempt(s).` }, ...outcome.reasons],
            });
          }
          return set({ candidateId: outcome.candidateId, state: 'unresolved', repairs: nextRepairs, reasons: outcome.reasons });
        }
      }
    },
    invalidate(candidateId, reasons) {
      const previous = tracked.get(candidateId);
      if (!previous || previous.state !== 'accepted') return previous;
      return set({ candidateId, state: 'unresolved', repairs: previous.repairs, reasons });
    },
    get: (candidateId) => tracked.get(candidateId),
    all: () => [...tracked.values()],
    triageFindings: () => [...tracked.values()].flatMap((candidate) => (candidate.state === 'accepted' && candidate.finding ? [candidate.finding] : [])),
    unresolvedCount: () => [...tracked.values()].filter((candidate) => candidate.state === 'unresolved').length,
    blocksCompletion() {
      return this.unresolvedCount() > 0;
    },
  };
}
