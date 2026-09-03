/**
 * GitHub payloads → the neutral platform types. Every field here was checked
 * against a real API response during design; nothing is shaped from memory.
 *
 * `Repository.id` is `owner/repo`, not the numeric node id: every REST path is
 * `/repos/{owner}/{repo}`, so a numeric id would cost a lookup per call. The
 * neutral contract declares the id an opaque provider-scoped string, so this is
 * within contract. The trade-off — a transfer changes the id where GitLab's
 * numeric id would not — is covered by GitHub's redirects and by the pod
 * storing `path` alongside `id`.
 */
import type {
  ChangedFileEntry,
  ChangedFileKind,
  ChangeRequest,
  ChangeRequestRef,
  CiRun,
  CiStatus,
  FileDiff,
  NormalizedCheckSummary,
  NormalizedCommit,
  NormalizedDetail,
  NormalizedRelationship,
  Repository,
  RepoGroup,
  ReviewThread,
  ThreadNote,
  UserRef,
  WorkItem,
} from '../../platform/types';

export interface GhUser {
  login: string;
  name?: string | null;
}

export interface GhRepo {
  full_name: string;
  name: string;
  html_url: string;
  open_issues_count?: number;
}

export interface GhOrg {
  login: string;
  name?: string | null;
}

export interface GhPull {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  merged_at?: string | null;
  draft?: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user: GhUser | null;
  requested_reviewers?: GhUser[] | null;
  html_url: string;
  updated_at: string;
  changed_files?: number;
  labels?: GhLabel[];
}

export interface GhLabel {
  name: string;
}

export interface GhIssue {
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  assignee?: GhUser | null;
  milestone?: { title: string } | null;
  updated_at: string;
  html_url: string;
  /** Present only when the "issue" is really a pull request. */
  pull_request?: unknown;
  labels?: GhLabel[];
}

/**
 * The lifecycle/outcome pair every Actions run reports: `conclusion` is null
 * until `status` reaches `completed`. Captured from
 * `GET /repos/{owner}/{repo}/actions/runs` on 2026-08-26 — an `in_progress`
 * run carries `conclusion: null`, which is why the status is read first.
 */
export interface GhRunState {
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion?: string | null;
}

/**
 * One workflow run, as the repository-wide list returns it. Only the fields
 * the neutral `CiRun` needs are declared; the live payload carries some forty
 * more (jobs_url, check_suite_id, run_attempt, …).
 *
 * `name` is deliberately absent from the mapping below: it is the *run's*
 * display name, which a workflow's `run-name:` can set to anything — one live
 * capture reads "Addressing comment on PR #332669". It is not a job name.
 */
export interface GhWorkflowRun extends GhRunState {
  id: number;
  head_branch?: string | null;
  html_url?: string | null;
  created_at?: string | null;
}

export interface GhFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
  /** Present on both `/pulls/{n}/files` and Compare `Diff Entry` payloads; absent only via hand-trimmed fixtures. */
  additions?: number;
  deletions?: number;
}

export function toUserRef(user: GhUser | null | undefined): UserRef {
  if (!user) return { username: 'unknown' };
  return user.name ? { username: user.login, name: user.name } : { username: user.login };
}

export function toRepository(repo: GhRepo): Repository {
  return {
    id: repo.full_name,
    path: repo.full_name,
    name: repo.name,
    webUrl: repo.html_url,
    // `open_issues_count` counts issues AND pull requests, so it is not the
    // open-change-request count the dashboard means. Left undefined rather
    // than reported wrong; the caller counts pulls when it needs the number.
  };
}

export function toRepoGroup(org: GhOrg): RepoGroup {
  return { id: org.login, path: org.login, name: org.name ?? org.login };
}

/** A run's own state. `neutral` and `skipped` do not block, so they read as success. */
export function toCiStatus(run: GhRunState): CiStatus {
  if (run.status !== 'completed') {
    return run.status === 'in_progress' ? 'running' : 'pending';
  }
  switch (run.conclusion) {
    case 'success':
    case 'neutral':
    case 'skipped':
      return 'success';
    case 'failure':
    case 'timed_out':
    case 'action_required':
    case 'startup_failure':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'none';
  }
}

export function toChangeRequest(
  repoId: string,
  pull: GhPull,
  ci?: { runId: string; status: CiStatus; webUrl?: string },
): ChangeRequest {
  const state: ChangeRequest['state'] =
    pull.state === 'open' ? 'open' : pull.merged_at ? 'merged' : 'closed';
  return {
    ref: { repoId, number: String(pull.number) },
    title: pull.title,
    description: pull.body ?? undefined,
    state,
    sourceBranch: pull.head.ref,
    targetBranch: pull.base.ref,
    author: toUserRef(pull.user),
    reviewers: (pull.requested_reviewers ?? []).map(toUserRef),
    webUrl: pull.html_url,
    updatedAt: pull.updated_at,
    headSha: pull.head.sha,
    changedFileCount: pull.changed_files,
    ci,
    draft: pull.draft === true,
  };
}

/** GitHub's issues endpoint returns pull requests too; those are not work items. */
export function isRealIssue(issue: GhIssue): boolean {
  return issue.pull_request === undefined;
}

export function toWorkItem(repoId: string, issue: GhIssue): WorkItem {
  return {
    id: `${repoId}#${issue.number}`,
    repoId,
    number: String(issue.number),
    title: issue.title,
    description: issue.body ?? undefined,
    state: issue.state,
    assignee: issue.assignee ? toUserRef(issue.assignee) : undefined,
    milestone: issue.milestone?.title,
    updatedAt: issue.updated_at,
    webUrl: issue.html_url,
  };
}

/**
 * A workflow run is what the neutral `CiRun` means by "a CI pipeline /
 * workflow run", and `ref` is the branch it ran on — the same field GitLab
 * fills from a pipeline's `ref`.
 *
 * `failedJobName` is left unset on purpose. The repository-wide run list names
 * the run, never the job inside it that failed; the job needs
 * `/actions/runs/{id}/jobs`, one request per run — the fan-out `listCiRuns`
 * exists to avoid. The renderers already fall back to `ref`, as they do for
 * GitLab, which never sets it either.
 */
export function toCiRun(repoId: string, run: GhWorkflowRun): CiRun {
  return {
    id: String(run.id),
    repoId,
    status: toCiStatus(run),
    webUrl: run.html_url ?? undefined,
    ref: run.head_branch ?? undefined,
    createdAt: run.created_at ?? undefined,
  };
}

export function toFileDiff(file: GhFile): FileDiff {
  const isRenamed = file.status === 'renamed';
  return {
    oldPath: isRenamed ? file.previous_filename ?? file.filename : file.filename,
    newPath: file.filename,
    // A binary or too-large file comes back with no patch; an empty diff is
    // honest there — the file is listed, with no hunks to anchor to.
    diff: file.patch ?? '',
    isNew: file.status === 'added' || undefined,
    isDeleted: file.status === 'removed' || undefined,
    isRenamed: isRenamed || undefined,
  };
}

/** What the neutral `ChangeRequest.ci` needs, however it was fetched. */
export interface CiSummary {
  runId: string;
  status: CiStatus;
  webUrl?: string;
}

/** GraphQL `statusCheckRollup` — the batched equivalent of the REST check-runs call. */
export interface GqlRollup {
  state?: string | null;
  contexts?: {
    nodes?: Array<{
      __typename?: string;
      databaseId?: number | null;
      name?: string | null;
      conclusion?: string | null;
      status?: string | null;
      permalink?: string | null;
      context?: string | null;
      state?: string | null;
      targetUrl?: string | null;
      /** CheckRun's own short output text — not a log; the Checks API keeps logs on a separate, unfetched endpoint. */
      summary?: string | null;
      /** StatusContext's equivalent of `summary`. */
      description?: string | null;
    } | null>;
  } | null;
}

export interface GqlChecksResponse {
  repository?: {
    pullRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{
        number: number;
        commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: GqlRollup | null } } | null> | null } | null;
      }>;
    };
  } | null;
}

/** The rollup enum GitHub shows on the pull request itself. */
function rollupState(state: string | null | undefined): CiStatus {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failed';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'none';
  }
}

/**
 * Pick the run worth linking to: the failing one if there is a failing one,
 * otherwise the first. `runId` falls back to the context name, because a
 * StatusContext has no numeric id.
 */
export function toCiSummary(rollup: GqlRollup | null | undefined): CiSummary | undefined {
  if (!rollup) return undefined;
  const status = rollupState(rollup.state);
  if (status === 'none') return undefined;
  const contexts = (rollup.contexts?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node != null);
  const failing = contexts.find(
    (node) => node.conclusion === 'FAILURE' || node.conclusion === 'TIMED_OUT'
      || node.conclusion === 'STARTUP_FAILURE' || node.state === 'FAILURE' || node.state === 'ERROR',
  );
  const lead = failing ?? contexts[0];
  return {
    runId: lead?.databaseId != null ? String(lead.databaseId) : lead?.name ?? lead?.context ?? 'checks',
    status,
    webUrl: lead?.permalink ?? lead?.targetUrl ?? undefined,
  };
}

/** The GraphQL review-thread shape — the only place resolution state exists. */
export interface GqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string | null;
  line?: number | null;
  resolvedBy?: { login: string } | null;
  comments: {
    nodes: Array<{
      id: string;
      /** The REST comment id, so a posted comment can be found in its thread. */
      databaseId?: number | null;
      body: string;
      createdAt: string;
      author?: { login?: string } | null;
    }>;
  };
}

export function toReviewThread(crRef: ChangeRequestRef, thread: GqlThread): ReviewThread {
  const notes: ThreadNote[] = thread.comments.nodes.map((note, index) => ({
    id: note.id,
    author: { username: note.author?.login ?? 'unknown' },
    body: note.body,
    createdAt: note.createdAt,
    // Only the first comment carries the thread's resolution state; GitHub
    // resolves threads, not individual comments.
    resolvable: index === 0,
    resolved: index === 0 ? thread.isResolved : undefined,
    resolvedBy: index === 0 && thread.resolvedBy ? { username: thread.resolvedBy.login } : undefined,
  }));
  return {
    id: thread.id,
    crRef,
    notes,
    resolved: thread.isResolved,
    // `isOutdated` is exactly the signal GitLab derives from `position: null`
    // after a force-push: the anchor no longer applies.
    anchorPresent: !thread.isOutdated,
    filePath: thread.path ?? undefined,
    line: thread.line ?? undefined,
  };
}

// ---- review-investigation (design.md D7, task 4.6) ---------------------------

/**
 * GitHub omits `patch` for a Diff Entry it cannot render as text, but does not
 * document why. `additions`/`deletions` are computed by git itself
 * (`git diff --numstat`), which reports 0 for binary content because it
 * cannot count line changes in it — a large-but-text diff still carries
 * non-zero counts even when its patch text was suppressed for size. Moderate,
 * disclosed confidence, mirroring the GitLab provider's own disclosed-
 * confidence revision/path disambiguation: GitHub's docs confirm binary
 * content has no `patch` but do not enumerate every cause of an absent one.
 */
export function isBinaryCompareFile(file: GhFile): boolean {
  return file.patch === undefined && (file.additions ?? 0) === 0 && (file.deletions ?? 0) === 0;
}

/** A patch GitHub knows the line counts for but declined to render — too large to show, not binary. */
export function isTooLargeCompareFile(file: GhFile): boolean {
  return file.patch === undefined && !isBinaryCompareFile(file);
}

function toChangedFileKind(file: GhFile): ChangedFileKind {
  if (file.status === 'renamed') return 'renamed';
  if (file.status === 'added') return 'added';
  if (file.status === 'removed') return 'deleted';
  return 'modified';
}

export function toChangedFileEntry(file: GhFile): ChangedFileEntry {
  const binary = isBinaryCompareFile(file);
  return {
    path: file.filename,
    oldPath: file.status === 'renamed' ? file.previous_filename : undefined,
    kind: toChangedFileKind(file),
    binary,
    addedLines: binary ? undefined : file.additions,
    removedLines: binary ? undefined : file.deletions,
  };
}

/**
 * `GET /repos/{owner}/{repo}/compare/{base}...{head}` — snapshot-scoped (no
 * pull-request number needed), unlike `/pulls/{n}/files`. Only `files` is
 * read; GitHub caps it at 300 entries for the whole comparison and shows it
 * only on the first page (docs.github.com/en/rest/commits/commits#compare-two-commits).
 */
export interface GhCompareResult {
  files?: GhFile[];
}

/** Keeps context and added lines, drops removed lines and hunk headers — a deterministic head-revision approximation, never invented file content (same technique as the GitLab provider; GitHub's patch format has no binary marker line to skip). */
export function linesFromUnifiedDiff(patch: string): string[] {
  const lines: string[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) continue;
    if (raw.startsWith('-')) continue;
    lines.push(raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw);
  }
  return lines;
}

export interface GhPullCommit {
  sha: string;
  commit: { message: string; author?: { name?: string } | null };
}

function toNormalizedCommit(commit: GhPullCommit): NormalizedCommit {
  return { sha: commit.sha, message: commit.commit.message, author: commit.commit.author?.name ?? 'unknown' };
}

/** Per-context status, distinct from `toCiStatus`: GraphQL's check enums are uppercase and shaped differently from the REST workflow-run enums that function reads. */
function toContextStatus(node: { conclusion?: string | null; status?: string | null; state?: string | null }): CiStatus {
  // StatusContext carries `state`; CheckRun carries `status`/`conclusion`.
  if (node.state != null) return rollupState(node.state);
  if (node.status !== 'COMPLETED') return node.status === 'IN_PROGRESS' ? 'running' : 'pending';
  switch (node.conclusion) {
    case 'SUCCESS':
    case 'NEUTRAL':
    case 'SKIPPED':
      return 'success';
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
    case 'STALE':
      return 'failed';
    case 'CANCELLED':
      return 'canceled';
    default:
      return 'none';
  }
}

/** Every check on the change request, normalized — unlike `toCiSummary`, which picks one to link to. */
export function toCheckSummariesFromRollup(rollup: GqlRollup | null | undefined): NormalizedCheckSummary[] {
  const contexts = (rollup?.contexts?.nodes ?? []).filter((node): node is NonNullable<typeof node> => node != null);
  return contexts.map((node) => ({
    name: node.name ?? node.context ?? 'check',
    status: toContextStatus(node),
    // CheckRun's short output text / StatusContext's description — never the execution log, which lives on a separate, unfetched endpoint.
    summary: node.summary ?? node.description ?? undefined,
  }));
}

/** `Part-of: #123` is this product's own changeset-linkage convention (`DEFAULT_TRAILER` in `app/changesets.ts`), not a GitHub feature — same derivation the GitLab provider applies to its own description field. */
function partOfRelationship(body: string | null | undefined): NormalizedRelationship[] {
  const match = /Part-of: #(\d+)/.exec(body ?? '');
  return match ? [{ kind: 'partOf', ref: match[1] as string }] : [];
}

export function toNormalizedDetail(
  pull: GhPull,
  commits: readonly GhPullCommit[],
  discussion: ThreadNote[],
  checkSummaries: NormalizedCheckSummary[],
): NormalizedDetail {
  return {
    title: pull.title,
    body: pull.body ?? undefined,
    labels: (pull.labels ?? []).map((label) => label.name),
    commits: commits.map(toNormalizedCommit),
    discussion,
    checkSummaries,
    relationships: partOfRelationship(pull.body),
    unavailableSections: [],
  };
}

export function toNormalizedDetailFromIssue(issue: GhIssue, discussion: ThreadNote[]): NormalizedDetail {
  return {
    title: issue.title,
    body: issue.body ?? undefined,
    labels: (issue.labels ?? []).map((label) => label.name),
    commits: [],
    discussion,
    checkSummaries: [],
    relationships: [],
    unavailableSections: ['commits', 'checkSummaries', 'relationships'],
  };
}

/** `GET /repos/{owner}/{repo}/issues/{number}/comments` — plain issue comments; issues have no review threads. */
export interface GhIssueComment {
  id: number;
  user: GhUser | null;
  body: string;
  created_at: string;
}

export function toThreadNoteFromIssueComment(comment: GhIssueComment): ThreadNote {
  return { id: String(comment.id), author: toUserRef(comment.user), body: comment.body, createdAt: comment.created_at };
}

/**
 * `GET /repos/{owner}/{repo}/contents/{path}` response for a file. GitHub
 * itself withholds `content` once the file exceeds 1 MB (`encoding: 'none'`
 * under the default JSON media type) rather than requiring a local byte cap
 * the way the GitLab provider does.
 */
export interface GhContentFile {
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  size: number;
  encoding?: string;
  content?: string;
}

