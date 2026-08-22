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
  ChangeRequest,
  ChangeRequestRef,
  CiRun,
  CiStatus,
  FileDiff,
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
  base: { ref: string };
  user: GhUser | null;
  requested_reviewers?: GhUser[] | null;
  html_url: string;
  updated_at: string;
  changed_files?: number;
}

export interface GhIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
  assignee?: GhUser | null;
  milestone?: { title: string } | null;
  updated_at: string;
  html_url: string;
  /** Present only when the "issue" is really a pull request. */
  pull_request?: unknown;
}

export interface GhCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion?: string | null;
  html_url?: string | null;
  started_at?: string | null;
}

export interface GhFile {
  filename: string;
  previous_filename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  patch?: string;
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

/** A check run's own state. `neutral` and `skipped` do not block, so they read as success. */
export function toCiStatus(run: Pick<GhCheckRun, 'status' | 'conclusion'>): CiStatus {
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

/** A pull request's overall CI: the worst state among its check runs. */
export function aggregateCiStatus(runs: readonly GhCheckRun[]): CiStatus {
  if (runs.length === 0) return 'none';
  const statuses = runs.map(toCiStatus);
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.includes('pending')) return 'pending';
  if (statuses.includes('canceled')) return 'canceled';
  return statuses.every((s) => s === 'success') ? 'success' : 'none';
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
    state: issue.state,
    assignee: issue.assignee ? toUserRef(issue.assignee) : undefined,
    milestone: issue.milestone?.title,
    updatedAt: issue.updated_at,
    webUrl: issue.html_url,
  };
}

export function toCiRun(repoId: string, run: GhCheckRun): CiRun {
  const status = toCiStatus(run);
  return {
    id: String(run.id),
    repoId,
    status,
    webUrl: run.html_url ?? undefined,
    ref: run.name,
    failedJobName: status === 'failed' ? run.name : undefined,
    createdAt: run.started_at ?? undefined,
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
