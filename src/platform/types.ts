/**
 * The neutral SCM vocabulary. Nothing in this file may be shaped like one
 * platform's API: GitLab, GitHub and Bitbucket concepts are mapped onto
 * these types inside their provider modules (see docs/ARCHITECTURE.md).
 */
import type { ScmError } from './errors';

export interface UserRef {
  username: string;
  name?: string;
}

/** A repository (GitLab "project", GitHub/Bitbucket "repository"). */
export interface Repository {
  /** Provider-scoped id, always a string (GitLab numeric ids are stringified). */
  id: string;
  /** Full path, e.g. `hve/platform/core`. */
  path: string;
  name: string;
  webUrl: string;
  /** Open change-request count, when the provider returns it cheaply. */
  openChangeRequestCount?: number;
}

/** A repository container (GitLab "group", GitHub "organization", Bitbucket "workspace"). */
export interface RepoGroup {
  id: string;
  path: string;
  name: string;
}

/** Identifies one change request within a provider connection. */
export interface ChangeRequestRef {
  repoId: string;
  /** Repo-scoped number: GitLab `iid`, GitHub PR number. */
  number: string;
}

export type CiStatus = 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'none';

/** A merge request / pull request. */
export interface ChangeRequest {
  ref: ChangeRequestRef;
  title: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  author: UserRef;
  reviewers: UserRef[];
  webUrl: string;
  updatedAt: string;
  /** Head commit at fetch time — staleness detection compares against this. */
  headSha: string;
  changedFileCount?: number;
  ci?: { runId: string; status: CiStatus; webUrl?: string };
  draft?: boolean;
}

/** An issue / work item, as the dashboard lists them. */
export interface WorkItem {
  id: string;
  repoId: string;
  number: string;
  title: string;
  state: 'open' | 'closed';
  assignee?: UserRef;
  milestone?: string;
  updatedAt: string;
  webUrl: string;
}

/** A CI pipeline / workflow run. */
export interface CiRun {
  id: string;
  repoId: string;
  status: CiStatus;
  webUrl?: string;
  ref?: string;
  failedJobName?: string;
  createdAt?: string;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** Unified diff hunks for this file. */
  diff: string;
  isNew?: boolean;
  isDeleted?: boolean;
  isRenamed?: boolean;
}

/**
 * Provider-opaque anchoring payload: whatever the provider needs to
 * round-trip a positioned comment (GitLab `diff_refs`, GitHub
 * `commit_id`+`side`, …). Produced by `getChangeRequestDiff`, consumed by
 * `submitReview`. The platform layer never inspects it.
 */
export type AnchorRefs = unknown;

export interface ChangeRequestDiff {
  ref: ChangeRequestRef;
  headSha: string;
  files: FileDiff[];
  anchorRefs: AnchorRefs;
}

/** Where a review comment lands in the diff. */
export interface DiffAnchor {
  filePath: string;
  /** Old path when the file was renamed. */
  oldPath?: string;
  line: number;
  endLine?: number;
  side?: 'old' | 'new';
  refs: AnchorRefs;
}

/** One line comment to post. The provider renders `suggestion` in its own syntax. */
export interface ReviewCommentDraft {
  /** Caller correlation key (the review item id) — echoed in the outcome. */
  key: string;
  /** Markdown body, without the suggestion block. */
  body: string;
  anchor: DiffAnchor;
  suggestion?: { old: string; new: string };
  /** Attribution line rendered after the suggestion block. */
  footer?: string;
}

export interface ReviewSubmission {
  comments: ReviewCommentDraft[];
  /** Summary note posted after the line comments succeed. */
  summary?: string;
  requestChanges?: boolean;
  approve?: boolean;
  /** Post the comments as a single review/thread where the platform supports it. */
  asSingleThread?: boolean;
}

export interface CommentOutcome {
  key: string;
  ok: boolean;
  threadId?: string;
  error?: ScmError;
}

/**
 * Per-comment outcomes so callers retry only the remainder — required for
 * draft survival on 401 and for changeset partial failure. `submitReview`
 * only throws when nothing was attempted (e.g. auth failed up front).
 */
export interface SubmitResult {
  comments: CommentOutcome[];
  summaryPosted: boolean;
  summaryError?: ScmError;
  approvalApplied?: boolean;
  approvalError?: ScmError;
  /** Distinct from approval — requesting changes is its opposite. */
  requestChangesApplied?: boolean;
  requestChangesError?: ScmError;
}

export interface ThreadNote {
  id: string;
  author: UserRef;
  body: string;
  createdAt: string;
  resolvable?: boolean;
  resolved?: boolean;
  resolvedBy?: UserRef;
  resolvedAt?: string;
}

/** A posted review discussion, as reply polling sees it. */
export interface ReviewThread {
  id: string;
  crRef: ChangeRequestRef;
  notes: ThreadNote[];
  resolved: boolean;
  /**
   * False when the platform dropped the diff anchor (GitLab returns
   * `position: null` after a force-push) — the `stale` thread status.
   */
  anchorPresent: boolean;
  filePath?: string;
  line?: number;
}

export interface ConnectionStatus {
  ok: boolean;
  username?: string;
  scopes?: string[];
  tokenExpiresInDays?: number;
  error?: ScmError;
}

export type SourceResolution =
  | { kind: 'repository'; repo: Repository }
  | { kind: 'group'; group: RepoGroup; repositories: Repository[] }
  /** A syntactically valid id the token cannot see. Never silently added. */
  | { kind: 'notVisible'; id: string }
  | { kind: 'noMatch' };
