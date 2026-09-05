/**
 * GitLab JSON → neutral platform types. Field shapes follow
 * `spec/specs/Code Verdict - API fixtures.json` and GitLab REST v4.
 */
import type {
  ChangedFileEntry,
  ChangedFileKind,
  ChangeRequest,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CiStatus,
  DiffAnchor,
  FileDiff,
  NormalizedDetail,
  RepoGroup,
  Repository,
  ReviewCommentDraft,
  ReviewThread,
  SearchMatch,
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
  labels?: string[];
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
  description?: string | null;
  state: string;
  assignees?: GlUser[];
  milestone?: { title: string } | null;
  updated_at: string;
  web_url: string;
  labels?: string[];
}

/** One diff entry from `/repository/compare`, `/changes`, or a merge-request diff version — same shape across all three. */
export interface GlCompareDiff {
  old_path: string;
  new_path: string;
  diff: string;
  new_file?: boolean;
  deleted_file?: boolean;
  renamed_file?: boolean;
  /** File diff was excluded because it exceeds platform size limits — never an empty successful payload. */
  too_large?: boolean;
}

/** `GET /projects/:id/repository/compare` — snapshot-scoped (no merge-request iid needed), unlike the MR diff endpoints. */
export interface GlCompareResult {
  diffs: GlCompareDiff[];
  commits: GlCommit[];
  /** True when the comparison exceeded size limits — `diffs` may be incomplete and individual `diff` strings may be empty. */
  compare_timeout?: boolean;
  compare_same_ref?: boolean;
}

export interface GlCommit {
  id: string;
  short_id: string;
  title: string;
  message: string;
  author_name: string;
}

/** `GET /projects/:id/repository/files/:file_path` — content is always base64, regardless of `encoding`'s literal value. */
export interface GlRepositoryFile {
  file_name: string;
  file_path: string;
  size: number;
  encoding: string;
  content: string;
  content_sha256: string;
  ref: string;
  blob_id: string;
  commit_id: string;
  last_commit_id: string;
}

/** One `scope=blobs` result from `GET /projects/:id/search`. */
export interface GlSearchBlob {
  basename: string;
  data: string;
  path: string;
  filename: string;
  ref: string;
  startline: number;
  project_id: number;
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
    description: issue.description ?? undefined,
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
    baseSha: changes.diff_refs.base_sha,
    headSha: changes.diff_refs.head_sha,
    files: changes.changes.map(toFileDiff),
    anchorRefs: changes.diff_refs,
  };
}

/** Shared by MR/issue discussion mapping (`toReviewThread` below and investigation detail retrieval). */
export function toThreadNote(n: GlNote): ThreadNote {
  return {
    id: String(n.id),
    author: toUser(n.author),
    body: n.body,
    createdAt: n.created_at,
    resolvable: n.resolvable,
    resolved: n.resolved,
    resolvedBy: n.resolved_by ? toUser(n.resolved_by) : undefined,
    resolvedAt: n.resolved_at ?? undefined,
  };
}

/** Notes from a discussion that belong in model/UI-visible history \u2014 system notes (e.g. "changed target branch") are noise, not review content. */
export function nonSystemNotes(d: GlDiscussion): ThreadNote[] {
  return d.notes.filter((n) => !n.system).map(toThreadNote);
}

export function toReviewThread(d: GlDiscussion, crRef: ChangeRequestRef): ReviewThread {
  const notes = nonSystemNotes(d);
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

// ---- review-investigation (design.md D7, task 4.3) --------------------------

/** Git's own placeholder for content that cannot be rendered as text \u2014 identical across `/compare`, `/changes`, and MR diff versions since all three are generated by Gitaly. */
export function isBinaryDiff(diff: string): boolean {
  return diff.startsWith('Binary files ');
}

/** Keeps context and added lines, drops removed lines and hunk headers \u2014 a deterministic head-revision approximation, never invented file content. */
export function linesFromUnifiedDiff(diff: string): string[] {
  const lines: string[] = [];
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('@@') || isBinaryDiff(raw) || raw.startsWith('-')) continue;
    lines.push(raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw);
  }
  return lines;
}

function toChangedFileKind(d: GlCompareDiff): ChangedFileKind {
  if (d.renamed_file) return 'renamed';
  if (d.new_file) return 'added';
  if (d.deleted_file) return 'deleted';
  return 'modified';
}

/** Additions/removals from unified-diff `+`/`-` lines, excluding the `+++`/`---` file headers. */
function countDiffLines(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

export function toChangedFileEntry(d: GlCompareDiff): ChangedFileEntry {
  const binary = isBinaryDiff(d.diff);
  const { added, removed } = binary ? { added: 0, removed: 0 } : countDiffLines(d.diff);
  return {
    path: d.new_path,
    oldPath: d.renamed_file ? d.old_path : undefined,
    kind: toChangedFileKind(d),
    binary,
    addedLines: binary ? undefined : added,
    removedLines: binary ? undefined : removed,
  };
}

/** Shared by change-request and linked-issue detail retrieval; each caller supplies what it has and marks the rest `unavailableSections`. */
function normalizedDetail(base: {
  title: string;
  body?: string;
  labels?: string[];
  commits?: GlCommit[];
  discussion: ThreadNote[];
  checkSummary?: { name: string; status: CiStatus; summary?: string };
  relationships?: Array<{ kind: string; ref: string }>;
  unavailableSections: NormalizedDetail['unavailableSections'];
}): NormalizedDetail {
  return {
    title: base.title,
    body: base.body,
    labels: base.labels ?? [],
    commits: (base.commits ?? []).map((c) => ({ sha: c.id, message: c.message, author: c.author_name })),
    discussion: base.discussion,
    checkSummaries: base.checkSummary ? [base.checkSummary] : [],
    relationships: base.relationships ?? [],
    unavailableSections: base.unavailableSections,
  };
}

/** `Part-of: #123` is the neutral changeset-linkage convention this product writes into descriptions (see `changesets.ts`), not a GitLab-specific field. */
function partOfRelationship(description: string | undefined): Array<{ kind: string; ref: string }> {
  const match = /Part-of: #(\d+)/.exec(description ?? '');
  return match ? [{ kind: 'partOf', ref: match[1] as string }] : [];
}

export function toNormalizedDetail(mr: GlMergeRequest, discussion: ThreadNote[], commits: GlCommit[]): NormalizedDetail {
  return normalizedDetail({
    title: mr.title,
    body: mr.description,
    labels: mr.labels,
    commits,
    discussion,
    checkSummary: mr.head_pipeline
      ? { name: 'pipeline', status: toCiStatus(mr.head_pipeline.status), summary: `Pipeline ${mr.head_pipeline.id}` }
      : undefined,
    relationships: partOfRelationship(mr.description),
    unavailableSections: [],
  });
}

export function toNormalizedDetailFromIssue(issue: GlIssue, discussion: ThreadNote[]): NormalizedDetail {
  return normalizedDetail({
    title: issue.title,
    body: issue.description ?? undefined,
    labels: issue.labels,
    discussion,
    unavailableSections: ['commits', 'checkSummaries', 'relationships'],
  });
}

export function toSearchMatchFromBlob(blob: GlSearchBlob): SearchMatch {
  const firstLine = blob.data.split('\n')[0] ?? '';
  return { path: blob.path, line: blob.startline, excerpt: firstLine.trim() };
}
