/**
 * GitLab JSON → neutral platform types. Field shapes follow
 * `spec/specs/Code Verdict - API fixtures.json` and GitLab REST v4.
 */
import type {
  ChangeRequest,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CiStatus,
  DiffAnchor,
  FileDiff,
  RepoGroup,
  Repository,
  ReviewCommentDraft,
  ReviewThread,
  ThreadNote,
  UserRef,
  WorkItem,
} from '../../platform/types';
import { ScmError } from '../../platform/errors';

// ---- raw GitLab shapes (the fields we read) --------------------------------

export interface GlUser {
  username: string;
  name?: string;
}

export interface GlProject {
  id: number;
  path_with_namespace: string;
  name: string;
  web_url: string;
  open_merge_requests_count?: number;
}

export interface GlGroup {
  id: number;
  full_path: string;
  name: string;
}

export interface GlPipelineRef {
  id: number;
  status: string;
  web_url?: string;
  ref?: string;
  sha?: string;
  created_at?: string;
}

export interface GlMergeRequest {
  iid: number;
  project_id: number;
  title: string;
  description?: string;
  state: string;
  source_branch: string;
  target_branch: string;
  author: GlUser;
  reviewers?: GlUser[];
  web_url: string;
  updated_at: string;
  sha: string;
  changes_count?: string | number;
  head_pipeline?: GlPipelineRef | null;
  draft?: boolean;
}

export interface GlDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface GlChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
}

export interface GlMergeRequestChanges {
  diff_refs: GlDiffRefs;
  changes: GlChange[];
  sha?: string;
}

export interface GlIssue {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  assignees?: GlUser[];
  milestone?: { title: string } | null;
  updated_at: string;
  web_url: string;
}

export interface GlNotePosition {
  new_path?: string;
  old_path?: string;
  new_line?: number | null;
  old_line?: number | null;
  position_type?: string;
}

export interface GlNote {
  id: number;
  author: GlUser;
  body: string;
  created_at: string;
  system?: boolean;
  resolvable?: boolean;
  resolved?: boolean;
  resolved_by?: GlUser | null;
  resolved_at?: string | null;
  /** null when GitLab dropped the anchor after a force-push — the stale signal. */
  position?: GlNotePosition | null;
}

export interface GlDiscussion {
  id: string;
  individual_note: boolean;
  notes: GlNote[];
}

// ---- mappers ----------------------------------------------------------------

const toUser = (u: GlUser): UserRef => ({ username: u.username, name: u.name });

export function toRepository(p: GlProject): Repository {
  return {
    id: String(p.id),
    path: p.path_with_namespace,
    name: p.name,
    webUrl: p.web_url,
    openChangeRequestCount: p.open_merge_requests_count,
  };
}

export function toRepoGroup(g: GlGroup): RepoGroup {
  return { id: String(g.id), path: g.full_path, name: g.name };
}

export function toCiStatus(status: string | undefined): CiStatus {
  switch (status) {
    case 'success':
      return 'success';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'created':
    case 'pending':
    case 'waiting_for_resource':
    case 'preparing':
    case 'scheduled':
    case 'manual':
      return 'pending';
    case 'canceled':
    case 'skipped':
      return 'canceled';
    default:
      return 'none';
  }
}

export function toChangeRequest(mr: GlMergeRequest): ChangeRequest {
  const state = mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed';
  return {
    ref: { repoId: String(mr.project_id), number: String(mr.iid) },
    title: mr.title,
    description: mr.description,
    state,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    author: toUser(mr.author),
    reviewers: (mr.reviewers ?? []).map(toUser),
    webUrl: mr.web_url,
    updatedAt: mr.updated_at,
    headSha: mr.sha,
    changedFileCount: mr.changes_count === undefined ? undefined : Number(mr.changes_count),
    ci: mr.head_pipeline
      ? {
          runId: String(mr.head_pipeline.id),
          status: toCiStatus(mr.head_pipeline.status),
          webUrl: mr.head_pipeline.web_url,
        }
      : undefined,
    draft: mr.draft,
  };
}

export function toWorkItem(issue: GlIssue): WorkItem {
  return {
    id: String(issue.id),
    repoId: String(issue.project_id),
    number: String(issue.iid),
    title: issue.title,
    state: issue.state === 'opened' ? 'open' : 'closed',
    assignee: issue.assignees?.[0] ? toUser(issue.assignees[0]) : undefined,
    milestone: issue.milestone?.title,
    updatedAt: issue.updated_at,
    webUrl: issue.web_url,
  };
}

export function toCiRun(p: GlPipelineRef, repoId: string): CiRun {
  return {
    id: String(p.id),
    repoId,
    status: toCiStatus(p.status),
    webUrl: p.web_url,
    ref: p.ref,
    createdAt: p.created_at,
  };
}

export function toFileDiff(c: GlChange): FileDiff {
  return {
    oldPath: c.old_path,
    newPath: c.new_path,
    diff: c.diff,
    isNew: c.new_file,
    isDeleted: c.deleted_file,
    isRenamed: c.renamed_file,
  };
}

export function toChangeRequestDiff(
  ref: ChangeRequestRef,
  changes: GlMergeRequestChanges,
): ChangeRequestDiff {
  return {
    ref,
    headSha: changes.diff_refs.head_sha,
    files: changes.changes.map(toFileDiff),
    anchorRefs: changes.diff_refs,
  };
}

export function toReviewThread(d: GlDiscussion, crRef: ChangeRequestRef): ReviewThread {
  const notes: ThreadNote[] = d.notes
    .filter((n) => !n.system)
    .map((n) => ({
      id: String(n.id),
      author: toUser(n.author),
      body: n.body,
      createdAt: n.created_at,
      resolvable: n.resolvable,
      resolved: n.resolved,
      resolvedBy: n.resolved_by ? toUser(n.resolved_by) : undefined,
      resolvedAt: n.resolved_at ?? undefined,
    }));
  const resolvable = d.notes.filter((n) => n.resolvable);
  const first = d.notes[0];
  const position = first && first.position !== null ? first.position : undefined;
  return {
    id: d.id,
    crRef,
    notes,
    resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
    // A dropped anchor comes back as `position: null`, not an error (spec §14).
    anchorPresent: !d.notes.some((n) => n.position === null),
    filePath: position?.new_path ?? position?.old_path,
    line: position?.new_line ?? position?.old_line ?? undefined,
  };
}

// ---- outbound ----------------------------------------------------------------

/**
 * The comment body as posted: the app-composed markdown plus, when the item
 * carries a fix, the GitLab ```suggestion block that renders an Apply button.
 */
export function buildCommentBody(draft: ReviewCommentDraft): string {
  const parts = [draft.body];
  if (draft.suggestion) {
    // A multi-line anchor extends the replacement span below the anchored
    // line; single-line anchors keep the spec's `-0+0` form.
    const { line, endLine } = draft.anchor;
    const span = endLine !== undefined && endLine > line ? endLine - line : 0;
    parts.push(`\`\`\`suggestion:-0+${span}\n${draft.suggestion.new}\n\`\`\``);
  }
  if (draft.footer) parts.push(draft.footer);
  return parts.join('\n\n');
}

/**
 * `position` must carry the same diff_refs the agent read — if head_sha
 * moved, GitLab 400s with "Note position is invalid" (→ staleAnchor).
 */
export function buildPosition(anchor: DiffAnchor): Record<string, unknown> {
  const refs = anchor.refs as Partial<GlDiffRefs> | undefined;
  if (!refs || !refs.base_sha || !refs.head_sha || !refs.start_sha) {
    throw new ScmError('unknown', 'Anchor refs are not GitLab diff_refs — cannot position the comment');
  }
  const position: Record<string, unknown> = {
    position_type: 'text',
    base_sha: refs.base_sha,
    start_sha: refs.start_sha,
    head_sha: refs.head_sha,
    old_path: anchor.oldPath ?? anchor.filePath,
    new_path: anchor.filePath,
  };
  if (anchor.side === 'old') {
    position.old_line = anchor.line;
  } else {
    position.new_line = anchor.line;
  }
  return position;
}
