/**
 * The record a finished review leaves behind, and what a screen reads it back
 * as.
 *
 * This started life as a *draft* — work in progress, deleted once it was no
 * longer in progress. Two paths deleted it: a clean run (nothing to triage) and
 * a successful submit (nothing left to post). Both were right about the retry
 * ledger they were clearing and wrong about the review it was attached to: the
 * change request then re-opened on the agent picker, with no way to see what
 * the agent had said, short of paying for another run.
 *
 * So the record outlives the triage it started as. It is deleted by exactly one
 * thing — a newer run on the same target that succeeded — which is what makes
 * "a re-run that fails or is cancelled leaves the previous review exactly where
 * it was" true without a restore path anywhere.
 *
 * Both review surfaces store the same shape under their own key: single change
 * requests at `codeVerdict.draft.<repoId>!<number>`, changesets at
 * `codeVerdict.changesetDraft.<changesetId>`. They differ only in their ledger
 * — six fields against one — so the result fields live here once.
 */
import { crKey } from './postedReviews';
import type { KeyValueStore } from './storage';
import type { ChangesetSubmitState } from './changesetSubmit';
import type { AttachmentWarning } from './attachments';
import type { CandidateBucket } from '../domain/agentResponse';
import type { ActivityEvent, Limitation } from '../domain/harnessActivity';
import { normalizeEffortLevel } from '../domain/effort';
import type { AttemptNumber, LineageId, ResultCompleteness } from '../domain/harnessLifecycle';
import type { ProtocolProvenance } from '../domain/harnessEvidence';
import { isReviewItemAnchored, type Review } from '../domain/types';

/**
 * Where a single change request's record lives. Exported rather than left as a
 * private method on the panel: the run manager writes the record a panel later
 * reads, and a key computed in two places is a completion that lands where
 * nothing looks for it.
 */
export function draftKeyFor(ref: { repoId: string; number: string }): string {
  return `codeVerdict.draft.${ref.repoId}!${ref.number}`;
}

/** The changeset equivalent, under its own prefix. */
export function changesetDraftKeyFor(changesetId: string): string {
  return `codeVerdict.changesetDraft.${changesetId}`;
}

/**
 * Where a single change request's *partial* result lives (task 12.5,
 * design.md D16, spec `background-review-runs` "A cached review is replaced
 * only by a review that succeeds": "those findings remain an explicitly
 * incomplete partial result associated with the new run... they do not
 * replace the complete retained review").
 *
 * A deliberately separate key, never the draft key above: a partial must
 * stay reachable on its own without ever being mistaken for — or silently
 * merged into — the target's retained complete review. Same repo!number
 * addressing as `draftKeyFor`, under its own prefix.
 */
export function partialDraftKeyFor(ref: { repoId: string; number: string }): string {
  return `codeVerdict.partial.${ref.repoId}!${ref.number}`;
}

/** The changeset equivalent of `partialDraftKeyFor`. */
export function changesetPartialDraftKeyFor(changesetId: string): string {
  return `codeVerdict.changesetPartial.${changesetId}`;
}

const DRAFT_PREFIX = 'codeVerdict.draft.';

/**
 * Drop retained reviews for change requests that are no longer open.
 *
 * Records are per target, so the store grows with change requests reviewed
 * rather than with runs performed — but a long-lived workspace still
 * accumulates one per change request that ever got a review, and a merged
 * change request is never going to be re-opened to read it.
 *
 * Scoped to the repositories the caller just listed. A key belonging to a
 * repository this poll did not cover is left alone: absence from *these*
 * results says nothing about whether it is open, and deleting on that would let
 * one pod's refresh quietly destroy another's reviews.
 *
 * Changeset records are never pruned here. A changeset is derived locally, not
 * fetched, so "no longer open" has no answer this function could read.
 */
export async function pruneClosedRetained(
  store: KeyValueStore,
  repoIds: readonly string[],
  openRefs: readonly { repoId: string; number: string }[],
): Promise<number> {
  const keys = store.keys?.();
  if (!keys) return 0;
  const covered = new Set(repoIds);
  const open = new Set(openRefs.map((ref) => `${ref.repoId}!${ref.number}`));
  let dropped = 0;
  for (const key of keys) {
    if (!key.startsWith(DRAFT_PREFIX)) continue;
    const ref = key.slice(DRAFT_PREFIX.length);
    const repoId = ref.slice(0, ref.lastIndexOf('!'));
    if (repoId === '' || !covered.has(repoId) || open.has(ref)) continue;
    await store.update(key, undefined);
    dropped += 1;
  }
  return dropped;
}

/**
 * The target a run belongs to, as one string. `crKey` is the key
 * `ReviewRunStore.byRef()` and `ReviewHistory.submittedRefs()` already use, so
 * a dashboard row that knows whether a review was submitted also knows, with
 * the same lookup, whether one is running.
 */
export function runKeyForCr(ref: { repoId: string; number: string }): string {
  return crKey(ref.repoId, ref.number);
}

/** Prefixed so a changeset id can never collide with a `repoId!number`. */
export function runKeyForChangeset(changesetId: string): string {
  return `changeset:${changesetId}`;
}

/**
 * `clean` means the agent ran and returned nothing. It is a result, not an
 * absence of one, and it is stored as a `Review` with no items so staleness,
 * agent attribution and the head it read all survive the same way they do for
 * findings.
 */
export type RetainedOutcome = 'clean' | 'findings';

/** What a finished run stamps onto the record it writes. */
export interface RetainedResult {
  /**
   * Absent on a record written before the results were retained. Such a record
   * is always findings: the only writer that could produce one deleted the key
   * on a clean run rather than writing to it.
   */
  outcome?: RetainedOutcome;
  /** ISO. Absent on a pre-change record, which recorded no time. */
  ranAt?: string;
  /**
   * Denormalised from the `Review` so the record can name its agent even when
   * the agent's file is gone — the same reason `ReviewRun` carries a label.
   */
  agentId?: string;
  agentLabel?: string;
  modelId?: string;
  /** Set by a successful submit. Selects the done screen over triage. */
  submittedAt?: string;
  /**
   * What the agent saw and filtered out. Kept because it is the whole content
   * of the clean screen — "no findings above your criteria" plus what sat just
   * below them — and it lives on the `AgentReviewResponse`, which is not
   * stored. Without it a re-opened clean run renders an empty page that says
   * less than the run it is reporting.
   */
  candidates?: CandidateBucket[];
  /** The run's own file count, for the same reason: it is on the response, not the review. */
  filesRead?: number;
  /** Filesystem-backed context omitted when its run-start revalidation failed. */
  attachmentWarnings?: readonly AttachmentWarning[];
  /**
   * Task 12.5 (design.md D11/D16): independent result completeness, exactly
   * `HarnessAttemptResult.outcome.completeness`. Absent on every record
   * written before this field existed (the main draft key's whole history, and
   * `legacy-one-shot` reviews generally) — `readRetained` defaults an absent
   * value to `'complete'` there, matching D16's "historical successful
   * reviews... are read as complete". A record written under
   * `partialDraftKeyFor`/`changesetPartialDraftKeyFor` always sets this
   * explicitly to `'partial'`; nothing in this module ever defaults *that*
   * key's absence to `'complete'` (see `readRetained`'s own `options.partial`
   * parameter) — an unmarked record is never mistaken for a finished review.
   */
  completeness?: ResultCompleteness;
  /** The attempt's own `CompletionOutcome.limitations` — why this result did not reach `complete`. `[]`/absent for an ordinary complete record. */
  limitations?: readonly Limitation[];
  /**
   * Task 14.2 (design.md D16): set only when the writer actually knows this
   * result came from a real harness attempt (`HarnessAttemptResult.plan`
   * present — see `reviewRunManager.ts`'s two `retainedFromRun` call sites).
   * Left absent otherwise, never written as `'legacy-one-shot'` from an
   * inference: `readRetained` below is the one place an absent value is
   * read as legacy, so a fact and a guess can never be confused in storage.
   */
  protocolProvenance?: ProtocolProvenance;
  /** Stable across a checkpoint-based resume of the run that produced this result (D2). Absent for a legacy record, which predates the concept. */
  lineageId?: LineageId;
  /** Monotonic within `lineageId`. Greater than 1 only once a prior attempt in this lineage closed as `interrupted` (D2/D13). */
  attempt?: AttemptNumber;
  /**
   * The full ordered sanitized activity from the attempt that produced this
   * result (task 14.2, design.md D14) — the same typed union every other
   * surface reads, never a second retained-details shape. `planHistory`
   * (`./harnessActivityPlan`) and `reduceActivity` (`./harnessActivityProjection`)
   * both read straight off this array, so retained details cannot derive a
   * plan or a coverage figure that disagrees with what the live screen showed
   * while the run was still in progress. Absent (never `[]` written as if it
   * were a real empty activity) for a legacy record, which has none.
   */
  activity?: readonly ActivityEvent[];
}

/**
 * The result fields a panel's own draft write must carry forward, taken from
 * the RAW stored record — never from the normalized `readRetained` view, whose
 * inferred fallbacks (`outcome ?? 'findings'`, the agent id off the review)
 * exist only in the reader and must not be materialized into storage, where a
 * later reader could no longer tell a recorded fact from a guess.
 *
 * This exists because the panels' draft writes are whole-key puts over the
 * same key the run manager writes: a put that lists only the triage fields
 * erases every field above — which is how the first verdict on a target used
 * to silently delete its "Ran …" line, and why the generation guard
 * (`draftWriter.ts`) reads a `ranAt` that must still be there to read.
 */
export function carryRetainedResult(raw: RetainedResult | undefined): RetainedResult {
  return {
    outcome: raw?.outcome,
    ranAt: raw?.ranAt,
    agentId: raw?.agentId,
    agentLabel: raw?.agentLabel,
    modelId: raw?.modelId,
    submittedAt: raw?.submittedAt,
    candidates: raw?.candidates,
    filesRead: raw?.filesRead,
    attachmentWarnings: raw?.attachmentWarnings,
    completeness: raw?.completeness,
    limitations: raw?.limitations,
    protocolProvenance: raw?.protocolProvenance,
    lineageId: raw?.lineageId,
    attempt: raw?.attempt,
    activity: raw?.activity,
  };
}

/**
 * What both surfaces store, before either adds its ledger. A run that has just
 * finished writes exactly this — it has produced a review and nothing has been
 * posted yet — which is why the two panels and the run manager can share one
 * writer.
 */
export interface RetainedRecord extends RetainedResult {
  review: Review;
  threads: Record<string, Array<{ label: string; text: string }>>;
  summaryText: string;
  finalNote: string;
}

/** The single-change-request record: the result, plus the six-field retry ledger. */
export interface SessionDraft extends RetainedRecord {
  /** Partial-failure ledger — must survive reloads so a retry never re-posts what already landed (spec §7). */
  failedKeys?: string[];
  summaryPosted?: boolean;
  verdictApplied?: boolean;
  /** itemId → thread id for comments that already landed, across attempts. */
  threadsAccum?: Record<string, string>;
  /** Sticky: once any comment posted on its own, the review is not one review. */
  postedIndividually?: boolean;
  /** Comments already posted, so a retry does not lose the running total. */
  postedCount?: number;
}

/** The changeset record: the same result, with the changeset's own ledger. */
export interface ChangesetDraft extends RetainedRecord {
  submitState?: ChangesetSubmitState;
}

/** Merge UI-owned edits into the latest retained result without dropping run metadata. */
export function mergeRetainedDraft<D extends RetainedRecord>(
  current: D | undefined,
  edited: D,
): D {
  return { ...current, ...edited };
}

/**
 * Build the record a finished run leaves behind. One writer for both surfaces
 * and for the run manager, so a clean run and a run with findings cannot drift
 * into storing different things about themselves.
 *
 * A clean run is stored the same way as any other, as a review with no items:
 * that keeps the head it read, the agent that read it and the candidates it
 * filtered, all of which the clean screen shows and none of which survive if
 * the record is a deletion.
 */
export function retainedFromRun(input: {
  review: Review;
  ranAt: string;
  agentId: string;
  agentLabel: string;
  modelId?: string;
  candidates?: CandidateBucket[];
  filesRead?: number;
  attachmentWarnings?: readonly AttachmentWarning[];
  /** Defaults to `'complete'` — every existing caller (a finished, retained-review-replacing run) is complete by construction; a partial write (task 12.5) passes `'partial'` explicitly. */
  completeness?: ResultCompleteness;
  limitations?: readonly Limitation[];
  /** Task 14.2: set only when the caller knows this came from a real harness attempt — see `RetainedResult.protocolProvenance`'s own doc comment. */
  protocolProvenance?: ProtocolProvenance;
  lineageId?: LineageId;
  attempt?: AttemptNumber;
  activity?: readonly ActivityEvent[];
}): RetainedRecord {
  return {
    review: input.review,
    threads: {},
    summaryText: '',
    finalNote: '',
    outcome: input.review.items.length === 0 ? 'clean' : 'findings',
    ranAt: input.ranAt,
    agentId: input.agentId,
    agentLabel: input.agentLabel,
    modelId: input.modelId,
    candidates: input.candidates,
    filesRead: input.filesRead,
    attachmentWarnings: input.attachmentWarnings,
    completeness: input.completeness ?? 'complete',
    limitations: input.limitations,
    protocolProvenance: input.protocolProvenance,
    lineageId: input.lineageId,
    attempt: input.attempt,
    activity: input.activity,
  };
}

/** A record read back with every optional filled in from what it does carry. */
export interface RetainedReview<D extends RetainedRecord> {
  draft: D;
  outcome: RetainedOutcome;
  /** Absent only for a pre-change record, which stored no time. */
  ranAt?: string;
  agentId: string;
  /** Absent when the record predates the field; the screen resolves it from the agent list instead. */
  agentLabel?: string;
  modelId?: string;
  submittedAt?: string;
  candidates: CandidateBucket[];
  filesRead?: number;
  attachmentWarnings: readonly AttachmentWarning[];
  /**
   * Task 12.5: never left ambiguous with a complete review. `readRetained`'s
   * default (an absent value reads as `'complete'`) matches D16 for the main
   * draft key, whose entire pre-this-change history is complete reviews by
   * construction. A caller reading the *partial* key
   * (`partialDraftKeyFor`/`changesetPartialDraftKeyFor`) passes
   * `{ partial: true }` so an absent value there instead reads as `'partial'`
   * — the direction that can never overstate completeness — rather than
   * silently borrowing the main key's default.
   */
  completeness: ResultCompleteness;
  limitations: readonly Limitation[];
  /**
   * Task 14.2 (design.md D16): defaults to `'legacy-one-shot'` when the raw
   * record carries no value — every record written before this field
   * existed predates the harness protocol, and this is the one place that
   * inference is allowed to happen (never in storage; see
   * `RetainedResult.protocolProvenance`).
   */
  protocolProvenance: ProtocolProvenance;
  /** Absent exactly when `protocolProvenance` is `'legacy-one-shot'` — a legacy record has no lineage to report. */
  lineageId?: LineageId;
  attempt?: AttemptNumber;
  /** `[]` for a legacy record — never fabricated activity for a review the harness never produced. */
  activity: readonly ActivityEvent[];
}

/**
 * Read a stored record, filling in the pre-change shape rather than migrating
 * it. A record written before the result fields existed carries its agent and
 * model on the `Review` it holds, so nothing about it is actually missing —
 * only differently placed.
 *
 * `options.partial` marks the caller as reading the separate partial key
 * (task 12.5) rather than the main draft key — the only thing this changes
 * is the default `completeness` for a record that (should never happen, but
 * fails closed rather than assumed) omits it. Every partial record this
 * module's own writer produces always sets `completeness` explicitly; this
 * default exists only so a partial slot can never be misread as a complete
 * review through a mere absent field.
 */
export function readRetained<D extends RetainedRecord>(
  raw: D | undefined,
  options: { partial?: boolean } = {},
): RetainedReview<D> | undefined {
  if (!raw?.review) return undefined;
  const draft = {
    ...raw,
    attachmentWarnings: raw.attachmentWarnings ?? [],
    review: {
      ...raw.review,
      effort: normalizeEffortLevel(raw.review.effort),
      items: raw.review.items.map((item) => ({ ...item, anchored: isReviewItemAnchored(item) })),
    },
  } as D;
  return {
    draft,
    outcome: raw.outcome ?? 'findings',
    ranAt: raw.ranAt,
    agentId: raw.agentId ?? raw.review.agentId,
    agentLabel: raw.agentLabel,
    modelId: raw.modelId ?? raw.review.modelId,
    submittedAt: raw.submittedAt,
    candidates: raw.candidates ?? [],
    filesRead: raw.filesRead,
    attachmentWarnings: raw.attachmentWarnings ?? [],
    completeness: raw.completeness ?? (options.partial ? 'partial' : 'complete'),
    limitations: raw.limitations ?? [],
    protocolProvenance: raw.protocolProvenance ?? 'legacy-one-shot',
    lineageId: raw.lineageId,
    attempt: raw.attempt,
    activity: raw.activity ?? [],
  };
}

/**
 * Which screen a retained record opens on. `clean` and `done` are terminal
 * views of a finished review; `triage` is the only one with work left in it.
 */
export function screenForRetained(
  retained: { outcome: RetainedOutcome; submittedAt?: string },
): 'triage' | 'clean' | 'done' {
  if (retained.outcome === 'clean') return 'clean';
  return retained.submittedAt ? 'done' : 'triage';
}

/**
 * The ledger fields a successful submit clears. Split out because clearing them
 * is the whole of what the old `update(key, undefined)` was entitled to do:
 * nothing may be re-posted, and everything else about the review stays.
 */
export function clearSubmitLedger(draft: SessionDraft, submittedAt: string): SessionDraft {
  return {
    ...draft,
    failedKeys: undefined,
    summaryPosted: undefined,
    verdictApplied: undefined,
    threadsAccum: undefined,
    postedIndividually: undefined,
    postedCount: undefined,
    submittedAt,
  };
}

/** The changeset equivalent: one ledger field instead of six. */
export function clearChangesetSubmitLedger(draft: ChangesetDraft, submittedAt: string): ChangesetDraft {
  return { ...draft, submitState: undefined, submittedAt };
}
