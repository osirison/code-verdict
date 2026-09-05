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
  /** Provider-authored body, used for neutral conventions such as changeset trailers. */
  description?: string;
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
  /** Provider-authored body. Absent when the item has none — a title alone is not what a change is for. */
  description?: string;
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
  /**
   * The merge-base/target commit this diff is against. Neutral and provider-
   * read (unlike `anchorRefs`): every provider already resolves this SHA
   * while building the diff (GitLab's `diff_refs.base_sha`, GitHub's
   * `pull.base.sha`), and the harness's review-investigation tools (design.md
   * D7, `add-agentic-review-harness`) need it up front to pin every
   * `InvestigationSnapshotRef` — there is no separate neutral "resolve the
   * base" operation to call later.
   */
  baseSha: string;
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

/**
 * What a submit is doing right now. Submitting is the longest operation in the
 * product — one round trip per comment on the per-comment path, plus the
 * summary and the verdict — and without this the UI can only sit silent until
 * it finishes (#42). Providers report it best-effort; a caller that does not
 * pass a callback costs nothing.
 */
export interface SubmitProgress {
  stage: 'comments' | 'summary' | 'verdict';
  /** Comments finished so far. Zero for the summary and verdict stages. */
  posted: number;
  /** Comments in this submit — the retry remainder, not the whole review. */
  total: number;
}

export type SubmitProgressFn = (progress: SubmitProgress) => void;

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
  /**
   * Whether one review carried every comment, as `asSingleThread` asked. Only
   * the provider knows: a platform with a batched path can still fall back to
   * posting comments one at a time, and the UI must not claim otherwise.
   * `undefined` when the submit posted no comments, and so says nothing.
   */
  postedAsSingleReview?: boolean;
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

/**
 * Review-investigation contracts (design.md D7, `add-agentic-review-harness`,
 * task 3.2). Neutral shapes only — no GitLab/GitHub payload appears here, per
 * "Capabilities, not `if (gitlab)`" and "Anchors are opaque" in
 * docs/ARCHITECTURE.md. Every request pins an explicit repository and
 * revision; every result echoes that pin back so a caller can prove the
 * provider answered the exact requested revision instead of a branch tip
 * (task 3.7).
 */

/** Opaque continuation token for one bounded investigation operation; never inspected or built by neutral code. */
export type InvestigationCursor = string;

/** The immutable repository + base/head pair every investigation request and result is pinned to. */
export interface InvestigationSnapshotRef {
  repoId: string;
  baseSha: string;
  headSha: string;
}

/** Which side of an `InvestigationSnapshotRef` a single-revision read or search applies to. */
export type PinnedRevision = 'base' | 'head';

export type InvestigationState =
  | 'complete'
  | 'paginated'
  | 'truncated'
  | 'unavailable'
  | 'binary'
  | 'tooLarge'
  | 'notFound'
  | 'unknown';

interface InvestigationResultBase {
  snapshot: InvestigationSnapshotRef;
}

/**
 * The common bounded result envelope every investigation operation returns
 * (D7). `value` exists only on the states that can carry content; the other
 * states have no `value` field to populate, so unavailable content can never
 * be mistaken for an empty successful payload (task 3.4).
 */
export type InvestigationResult<T> =
  | (InvestigationResultBase & { state: 'complete'; value: T })
  | (InvestigationResultBase & { state: 'paginated'; value: T; cursor: InvestigationCursor })
  | (InvestigationResultBase & { state: 'truncated'; value: T; knownRemainingUnits?: number })
  | (InvestigationResultBase & { state: 'unavailable'; reason?: string })
  | (InvestigationResultBase & { state: 'binary'; byteSize?: number })
  | (InvestigationResultBase & { state: 'tooLarge'; byteSize?: number })
  | (InvestigationResultBase & { state: 'notFound'; reason?: string })
  | (InvestigationResultBase & { state: 'unknown'; reason?: string });

/** Narrows to the states that carry content, without a caller special-casing every state. */
export function investigationResultValue<T>(result: InvestigationResult<T>): T | undefined {
  switch (result.state) {
    case 'complete':
    case 'paginated':
    case 'truncated':
      return result.value;
    default:
      return undefined;
  }
}

// ---- Changed-file manifest --------------------------------------------------

export type ChangedFileKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** Enough metadata to classify a changed file without its content. */
export interface ChangedFileEntry {
  path: string;
  /** Present when `kind` is `'renamed'`. */
  oldPath?: string;
  kind: ChangedFileKind;
  binary: boolean;
  addedLines?: number;
  removedLines?: number;
  byteSize?: number;
}

export interface ChangedFileManifestRequest {
  snapshot: InvestigationSnapshotRef;
  cursor?: InvestigationCursor;
}

export type ChangedFileManifestResult = InvestigationResult<readonly ChangedFileEntry[]>;

// ---- Bounded diff pages ------------------------------------------------------

/** Where a line sits inside the immutable diff — provider-neutral, unlike `AnchorRefs`. */
export interface DiffPosition {
  path: string;
  oldPath?: string;
  side: 'old' | 'new';
  line: number;
  endLine?: number;
}

export interface DiffPageRequest {
  snapshot: InvestigationSnapshotRef;
  path: string;
  cursor?: InvestigationCursor;
}

export interface DiffPage {
  path: string;
  oldPath?: string;
  isRenamed?: boolean;
  /** Unified-diff hunk text for this bounded page, in the same format as `FileDiff.diff`. */
  patch: string;
  /** Positions inside `patch` a citation can anchor to, independent of any provider's `AnchorRefs`. */
  positions: readonly DiffPosition[];
}

export type DiffPageResult = InvestigationResult<DiffPage>;

// ---- Base/head file ranges ---------------------------------------------------

export interface FileRangeRequest {
  snapshot: InvestigationSnapshotRef;
  revision: PinnedRevision;
  path: string;
  startLine: number;
  endLine: number;
}

export interface FileRange {
  revision: PinnedRevision;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export type FileRangeResult = InvestigationResult<FileRange>;

// ---- Search matches -----------------------------------------------------------

export interface RepositorySearchRequest {
  snapshot: InvestigationSnapshotRef;
  revision: PinnedRevision;
  query: string;
  pathScope?: string;
  cursor?: InvestigationCursor;
}

export interface SearchMatch {
  path: string;
  line: number;
  excerpt: string;
}

export type RepositorySearchResult = InvestigationResult<readonly SearchMatch[]>;

export interface DiffSearchRequest {
  snapshot: InvestigationSnapshotRef;
  query: string;
  pathScope?: string;
  cursor?: InvestigationCursor;
}

export interface DiffSearchMatch {
  position: DiffPosition;
  excerpt: string;
}

export type DiffSearchResult = InvestigationResult<readonly DiffSearchMatch[]>;

// ---- Normalized details ---------------------------------------------------------

export type DetailSection = 'metadata' | 'commits' | 'discussion' | 'labels' | 'checkSummaries' | 'relationships';

export interface NormalizedCommit {
  sha: string;
  message: string;
  author: string;
}

export interface NormalizedCheckSummary {
  name: string;
  status: CiStatus;
  summary?: string;
}

export interface NormalizedRelationship {
  kind: string;
  ref: string;
}

/**
 * Full normalized detail shared by change-request and linked-issue retrieval
 * (D4/D6); excludes patch content and full CI logs by construction — neither
 * field exists here to populate.
 */
export interface NormalizedDetail {
  title: string;
  body?: string;
  labels: readonly string[];
  commits: readonly NormalizedCommit[];
  discussion: readonly ThreadNote[];
  checkSummaries: readonly NormalizedCheckSummary[];
  relationships: readonly NormalizedRelationship[];
  /** Sections this response could not populate; absence from here is never a silent drop. */
  unavailableSections: readonly DetailSection[];
}

export interface ChangeRequestDetailRequest {
  snapshot: InvestigationSnapshotRef;
  /** Repo-scoped CR number — `snapshot` alone does not identify which change request. */
  number: string;
  section?: DetailSection;
  cursor?: InvestigationCursor;
}

export type ChangeRequestDetailResult = InvestigationResult<NormalizedDetail>;

export interface IssueDetailRequest {
  /** The pinning run's own snapshot — linked-issue content is fetched as of this snapshot, even though an issue has no revision itself. */
  snapshot: InvestigationSnapshotRef;
  /** The linked issue's own identity, which may be a different repository than `snapshot.repoId`. */
  issueRepoId: string;
  issueNumber: string;
  section?: DetailSection;
  cursor?: InvestigationCursor;
}

export type IssueDetailResult = InvestigationResult<NormalizedDetail>;

// ---- Current head -------------------------------------------------------------

export type CurrentHeadState = 'resolved' | 'unavailable' | 'notFound';

export interface CurrentHeadResult {
  repoId: string;
  state: CurrentHeadState;
  /** Present only when `state` is `'resolved'`. */
  headSha?: string;
}
