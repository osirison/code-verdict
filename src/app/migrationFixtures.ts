/**
 * Snapshots of the pre-harness persisted shapes (task 1.4 of
 * `add-agentic-review-harness`), for future migration/deserialization tests
 * (task 2.7) to assert against. Not consumed anywhere yet.
 */
import type { InFlightRun } from './reviewRunManager';
import type { ReviewRun } from './reviewRuns';
import type { ChangesetDraft, SessionDraft } from './retainedReview';
import type { ChangesetSubmitState } from './changesetSubmit';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Review } from '../domain/types';

// ---- Run history (`ReviewRunStore`, globalState key `codeVerdict.reviewRuns`) --

export const LEGACY_RUN_HISTORY: ReviewRun[] = [
  { repoId: 'repo-1', crNumber: '2841', outcome: 'findings', findingCount: 1, agentLabel: 'Default review', ranAt: '2026-07-28T09:41:12.000Z' },
  { repoId: 'repo-1', crNumber: '2842', outcome: 'clean', findingCount: 0, agentLabel: 'Default review', ranAt: '2026-07-28T09:50:00.000Z' },
  // `agentLabel: ''` is what `sweepInterruptedRuns` actually writes — the sweep never learns one.
  { repoId: 'repo-1', crNumber: '2843', outcome: 'interrupted', findingCount: 0, agentLabel: '', ranAt: '2026-07-28T09:55:00.000Z' },
];

// ---- In-flight record (`InFlightRunStore`, globalState key `codeVerdict.inFlightRuns`) --

export const LEGACY_IN_FLIGHT_RUN: InFlightRun = {
  key: 'repo-1!2844',
  podId: 'pod-a',
  refLabel: '!2844',
  repoId: 'repo-1',
  crNumber: '2844',
  startedAt: '2026-07-28T10:00:00.000Z',
};

// ---- Retained reviews / triage drafts (workspaceState, `codeVerdict.draft.<repoId>!<number>`) --

const LEGACY_REVIEW: Review = {
  crNumber: '2841',
  repoId: 'repo-1',
  agentId: 'builtin-default',
  modelId: 'lm:acme/turbo',
  effort: 'none',
  criteria: DEFAULT_CRITERIA,
  headSha: 'legacy-head-1',
  items: [
    {
      id: 'i0',
      file: 'src/auth/token.ts',
      anchored: true,
      line: 63,
      severity: 'major',
      category: 'security',
      confidence: 90,
      title: 'Refresh token logged in error path',
      body: 'The refresh token is interpolated directly into the log message.',
      code: 'logger.error(`refresh failed ${this.refreshToken}`)',
    },
  ],
  verdicts: {},
  summary: 'One blocking finding in the token refresh path.',
};

/** Unsubmitted findings, mid-triage, with a partial-submit ledger from a prior failed attempt. */
export const LEGACY_RETAINED_TRIAGE_DRAFT: SessionDraft = {
  review: LEGACY_REVIEW,
  threads: {},
  summaryText: '',
  finalNote: '',
  outcome: 'findings',
  ranAt: '2026-07-28T09:41:12.000Z',
  agentId: 'builtin-default',
  agentLabel: 'Default review',
  modelId: 'lm:acme/turbo',
  candidates: [],
  filesRead: 9,
  failedKeys: ['i0'],
  postedCount: 0,
};

/** The same review, fully posted — the ledger a successful submit clears. */
export const LEGACY_RETAINED_SUBMITTED: SessionDraft = {
  review: { ...LEGACY_REVIEW, submittedAt: '2026-07-28T10:00:00.000Z' },
  threads: { i0: [{ label: 'you', text: 'Refresh token logged in error path' }] },
  summaryText: 'One blocking finding, posted.',
  finalNote: '',
  outcome: 'findings',
  ranAt: '2026-07-28T09:41:12.000Z',
  agentId: 'builtin-default',
  agentLabel: 'Default review',
  modelId: 'lm:acme/turbo',
  candidates: [],
  filesRead: 9,
  submittedAt: '2026-07-28T10:00:00.000Z',
};

/** A clean run stored as a review with no items, per `retainedFromRun`. */
export const LEGACY_RETAINED_CLEAN: SessionDraft = {
  review: { ...LEGACY_REVIEW, crNumber: '2842', items: [], summary: 'No findings above the configured criteria.' },
  threads: {},
  summaryText: '',
  finalNote: '',
  outcome: 'clean',
  ranAt: '2026-07-28T09:50:00.000Z',
  agentId: 'builtin-default',
  agentLabel: 'Default review',
  modelId: 'lm:acme/turbo',
  candidates: [],
  filesRead: 4,
};

/**
 * The oldest readable shape: written before `RetainedResult` existed, so it
 * carries only what `retainedFromRun` always wrote and nothing this change
 * adds. `readRetained` falls back to `'findings'` and to the review's own
 * `agentId`/`modelId` for exactly this record.
 */
export const LEGACY_RETAINED_PRE_RESULT_FIELDS: SessionDraft = {
  review: LEGACY_REVIEW,
  threads: {},
  summaryText: '',
  finalNote: '',
};

// ---- Changeset draft (workspaceState, `codeVerdict.changesetDraft.<changesetId>`) --

const LEGACY_CHANGESET_SUBMIT_STATE: ChangesetSubmitState = {
  postedCommentKeys: ['i0'],
  summaryRefs: ['repo-1!2841'],
  requestChangesRefs: [],
  threadIds: { i0: 'thread-1' },
};

export const LEGACY_CHANGESET_DRAFT: ChangesetDraft = {
  review: { ...LEGACY_REVIEW, repoId: 'changeset', crNumber: 'cs-legacy-1' },
  threads: {},
  summaryText: '',
  finalNote: '',
  outcome: 'findings',
  ranAt: '2026-07-28T09:41:12.000Z',
  agentId: 'builtin-default',
  agentLabel: 'Default review',
  candidates: [],
  submitState: LEGACY_CHANGESET_SUBMIT_STATE,
};
