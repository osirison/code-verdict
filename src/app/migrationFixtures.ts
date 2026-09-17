/**
 * Snapshots of the pre-harness persisted shapes (task 1.4 of
 * `add-agentic-review-harness`), for future migration/deserialization tests
 * (task 2.7) to assert against.
 *
 * It has since become this project's one home for "what was on disk before
 * change X". The last two sections are `add-local-git-investigation`'s own
 * recordings: the member snapshot as it was persisted before that change
 * altered what `baseSha` means (task 1.5), and a checkpoint's changed-file
 * coverage as the build before it wrote one (task 10.6) — the records a
 * resumed attempt replays, including the two `binary` states that build
 * guessed at.
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

// ---- Member snapshot before local-git investigation (task 1.5 of `add-local-git-investigation`) --
// workspaceState, key `codeVerdict.harness.lineage.<lineageId>`, as `HarnessRunStore` writes it.

/**
 * A stored lineage record written by the build that is live today, kept as the
 * literal text a workspace store holds rather than as a typed value.
 *
 * **Do not give this a type, and do not add fields to it.** Two fields are
 * about to exist that this record predates: `baseRevisionKind` (task 5.4) and
 * `investigationSource` (task 9.4). Absence of each has a defined meaning —
 * `targetBranchTip` and the provider — because every snapshot written before
 * that point used the target-branch tip and the provider by construction. A
 * fixture built through `ReviewRunMemberSnapshot` would follow the type
 * wherever it goes; the first time one of the new fields became required, the
 * compiler would ask for it and the record would quietly stop being a record
 * of anything. Text cannot drift, so text is what this is, and
 * `preLocalGitLineageRecord()` parses a fresh copy per call so a test cannot
 * mutate the recording for the next one.
 *
 * `baseSha` below is `pull.base.sha` from `GET /pulls/{n}` — the tip of the
 * target branch at the moment the snapshot was built, not the merge base.
 * That is precisely the meaning task 5.4 changes and task 9.7 has to prove is
 * read correctly for records like this one.
 */
export const PRE_LOCAL_GIT_LINEAGE_KEY = 'codeVerdict.harness.lineage.lineage-pre-local-git';

// vocab-ok: recorded bytes from a real run, not text anyone reads — a stored provider id and instance URL are the record, and neutralizing them would make it a fabrication
export const PRE_LOCAL_GIT_LINEAGE_RECORD_JSON = `{
  "schemaVersion": "1",
  "runId": "run-pre-local-git",
  "lineageId": "lineage-pre-local-git",
  "snapshots": {
    "1": {
      "schemaVersion": "1",
      "runId": "run-pre-local-git",
      "lineageId": "lineage-pre-local-git",
      "attempt": 1,
      "createdAt": "2026-09-09T21:14:03.000Z",
      "targetKind": "cr",
      "members": [
        {
          "memberId": "m1",
          "providerId": "github",
          "instanceUrl": "https://github.com",
          "ref": { "repoId": "osirison/code-verdict", "number": "66" },
          "baseSha": "7c1de9a0b2f3c4d5e6f708192a3b4c5d6e7f8091",
          "headSha": "9f2c1ab4e5d6708192a3b4c5d6e7f8091a2b3c4d",
          "providerCapabilitySignature": "gh:manifests,diffReads,fileReads,diffSearch,changeRequestDetails,issueDetails",
          "rootAgentsPolicy": { "present": false },
          "context": {
            "autoContextEnabled": true,
            "titleIncluded": true,
            "descriptionIncluded": true,
            "linkedItemIdsIncluded": [],
            "attachments": []
          }
        }
      ],
      "agentId": "agent:builtin/default",
      "agentInstructions": "Review the change carefully.",
      "agentInstructionsDigest": "digest-instructions",
      "personaLabel": "Default review",
      "modelId": "lm:acme/turbo",
      "modelCapability": { "vendor": "acme", "family": "turbo", "maxInputTokens": 128000 },
      "effort": "medium",
      "effortInstructionDigest": "digest-effort",
      "criteria": {
        "severityFloor": "minor",
        "categories": ["security", "concurrency", "errorHandling", "performance", "craftsmanship", "tests"],
        "minConfidence": 70
      },
      "extraInstructionsDigest": "digest-extra",
      "toolContractVersion": "1",
      "harnessPolicyVersion": "1"
    }
  },
  "checkpoints": [],
  "terminalAttempts": []
}`;

/** A fresh parse per call, so one test's mutation cannot reach the next one's fixture. */
export function preLocalGitLineageRecord(): unknown {
  return JSON.parse(PRE_LOCAL_GIT_LINEAGE_RECORD_JSON);
}

// ---- Checkpoint coverage before local-git investigation (task 10.6 of `add-local-git-investigation`) --
// The `coverage` array inside a stored `PersistedCheckpoint`, as `HarnessRunStore` wrote it.

/**
 * The second recording of what the live build leaves on disk, and the one a
 * resumed attempt replays. Text, not a typed value, and for the same reason the
 * lineage record above is text: `ChangedFileRecord` now carries two fields this
 * predates (`contentDeclined`, `readFailed`), a typed fixture would follow the
 * type wherever it goes, and a recording that drifts with the type is a
 * recording of nothing.
 *
 * **Do not add fields to it.** Their absence is the whole point. Every record
 * here was written by the build that could not tell a file whose content is
 * binary from one the platform enumerated and declined to render, and it wrote
 * the only state it had for both.
 *
 * The two `binary` records are that build's guess, in the shape it actually
 * stored: both files are plain TypeScript, both were readable by anyone who
 * asked at those two commits, and both were closed irreversibly because the
 * compare response returned them with no patch and zero line counts — 137 of
 * 207 files on the measured change came back exactly so. `binary` is terminal,
 * and the completion gate counts a terminal `binary` as satisfied, so replaying
 * these two unchecked is enough on its own to make a resumed run report itself
 * complete and clean over source nobody read. `applyCoverageSeed` is what has
 * to refuse them, and this is what it has to refuse.
 *
 * Both are `medium` risk and neither was a choice: the host's own floors give
 * a binary-flagged entry `medium` whatever the model proposed, which is why
 * the plain-text `.md` file carries the same risk as the `.ts` one here. That
 * is a second mark of where these records came from — a file the old build
 * called binary was floored as binary too.
 *
 * The `inspected` record is here so the same fixture proves the other half:
 * replay that is skipped where it cannot be corroborated must still carry
 * forward everything that was genuinely established.
 */
export const PRE_LOCAL_GIT_CHECKPOINT_COVERAGE_JSON = `[
  {
    "memberId": "m1",
    "manifestComplete": true,
    "totalFiles": 3,
    "files": [
      {
        "path": "src/app/harnessInventory.ts",
        "memberId": "m1",
        "state": "binary",
        "risk": "medium",
        "reason": "The provider reported this file as binary."
      },
      {
        "path": "docs/notes.md",
        "memberId": "m1",
        "state": "binary",
        "risk": "medium",
        "reason": "The provider reported this file as binary."
      },
      {
        "path": "src/app/harnessCompletion.ts",
        "memberId": "m1",
        "state": "inspected",
        "risk": "medium",
        "logicalUnit": "completion gate"
      }
    ]
  }
]`;

/** A fresh parse per call, for the reason `preLocalGitLineageRecord` is. */
export function preLocalGitCheckpointCoverage(): unknown {
  return JSON.parse(PRE_LOCAL_GIT_CHECKPOINT_COVERAGE_JSON);
}
