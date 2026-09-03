/**
 * The GitLab `ScmProvider` (REST v4, gitlab.com and self-hosted). All GitLab
 * knowledge lives in this directory; everything above talks to
 * `src/platform` types only.
 */
import type {
  Connection,
  ConnectionConfig,
  ProviderCapabilities,
  ScmProvider,
  Vocabulary,
  HostDescriptor,
} from '../../platform/provider';
import type {
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequest,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CommentOutcome,
  ConnectionStatus,
  CurrentHeadResult,
  DiffPage,
  DiffPageRequest,
  DiffPageResult,
  DiffSearchMatch,
  DiffSearchRequest,
  DiffSearchResult,
  FileRange,
  FileRangeRequest,
  FileRangeResult,
  IssueDetailRequest,
  IssueDetailResult,
  Repository,
  RepositorySearchRequest,
  RepositorySearchResult,
  ReviewSubmission,
  ReviewThread,
  SearchMatch,
  SourceResolution,
  SubmitProgressFn,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { bearerToken } from '../../platform/provider';
import { ScmError, isScmError, toScmError } from '../../platform/errors';
import { parseSourceInput } from './sourceInput';
import type { FetchLike } from './http';
import { GitLabHttp, encodeRepoId } from './http';
import type {
  GlCommit,
  GlCompareResult,
  GlDiscussion,
  GlGroup,
  GlIssue,
  GlMergeRequest,
  GlMergeRequestChanges,
  GlPipelineRef,
  GlProject,
  GlRepositoryFile,
  GlSearchBlob,
  GlUser,
} from './mappers';
import {
  buildCommentBody,
  buildPosition,
  isBinaryDiff,
  linesFromUnifiedDiff,
  nonSystemNotes,
  toChangeRequest,
  toChangedFileEntry,
  toChangeRequestDiff,
  toCiRun,
  toCiStatus,
  toNormalizedDetail,
  toNormalizedDetailFromIssue,
  toRepoGroup,
  toRepository,
  toReviewThread,
  toSearchMatchFromBlob,
  toWorkItem,
} from './mappers';

/** Declared review-investigation page bounds (design.md D7, task 4.3) \u2014 self-imposed, since GitLab returns each of these payloads in one call rather than paginating them itself. */
const INVESTIGATION_MANIFEST_PAGE = 100;
const INVESTIGATION_DIFF_LINE_PAGE = 200;
const INVESTIGATION_FILE_LINE_PAGE = 200;
/** Hard cap before a file's content is even decoded \u2014 checked against the metadata endpoint's own `size` field. */
const MAX_FETCHABLE_FILE_BYTES = 256 * 1024;

const CAPABILITIES: ProviderCapabilities = {
  suggestions: true,
  approvals: true,
  // REST has no equivalent, but the GraphQL mutation
  // mergeRequestUpdateReviewerState(state: REQUESTED_CHANGES) does it.
  requestChanges: true,
  threadResolution: true,
  groupHierarchy: true,
  // Batched review would use the draft-notes API — not in v1.
  batchedReview: false,
  // D7/task 4.3: manifest/diff/diff-search read the Compare API (snapshot-only,
  // no merge-request iid needed — see docs/agent-notes and repo memory for why
  // that rules out the MR-versions endpoint). Search requires GitLab Advanced
  // Search or Exact Code Search on the target instance; declared supported
  // like `approvals`/`requestChanges` above (a structural capability, not a
  // per-instance toggle) — an instance that lacks it reports `unavailable` at
  // call time instead of a silent capability lie.
  reviewInvestigation: {
    manifests: { supported: true, pageBound: { maxPageSize: INVESTIGATION_MANIFEST_PAGE } },
    diffReads: { supported: true, pageBound: { maxPageSize: INVESTIGATION_DIFF_LINE_PAGE } },
    fileReads: { supported: true, pageBound: { maxPageSize: INVESTIGATION_FILE_LINE_PAGE } },
    repositorySearch: { supported: true },
    diffSearch: { supported: true },
    changeRequestDetails: { supported: true },
    issueDetails: { supported: true },
    pagination: { maxPageSize: INVESTIGATION_MANIFEST_PAGE },
  },
};

const VOCABULARY: Vocabulary = {
  platformName: 'GitLab',
  changeRequestNoun: 'merge request',
  changeRequestNounPlural: 'merge requests',
  changeRequestAbbrev: 'MR',
  repoNoun: 'project',
  repoNounPlural: 'projects',
  groupNoun: 'group',
  ciNoun: 'pipeline',
  ciNounPlural: 'pipelines',
  workItemNoun: 'issue',
  workItemNounPlural: 'issues',
  formatCrRef: (number) => `!${number}`,
};

const HOST: HostDescriptor = {
  instanceUrlLabel: 'GitLab instance URL',
  defaultInstanceUrl: 'https://gitlab.com',
  tokenPlaceholder: 'glpat-…',
  tokenHint: 'a personal access token with `api` scope',
  sourceInputPlaceholder: 'https://gitlab.com/hve/platform/core · 9102 · group 4821',
  sourceInputHint: 'Accepts a full URL, a numeric project id, or \u201cgroup <id>\u201d.',
  sourceSamples: [
    { label: 'project URL', value: 'https://gitlab.com/hve/platform/core' },
    { label: 'project id', value: '9102' },
    { label: 'group 4821', value: 'group 4821' },
  ],
};

/** Errors after which posting the remaining comments cannot succeed. */
const ABORT_KINDS = new Set(['auth', 'insufficientScope', 'rateLimited', 'network']);

interface GlTokenInfo {
  scopes?: string[];
  expires_at?: string | null;
}

export class GitLabConnection implements Connection {
  constructor(private readonly http: GitLabHttp) {}

  async testConnection(): Promise<ConnectionStatus> {
    let user: GlUser;
    try {
      user = await this.http.get<GlUser>('/user');
    } catch (e) {
      return { ok: false, error: toScmError(e) };
    }

    let scopes: string[] | undefined;
    let tokenExpiresInDays: number | undefined;
    try {
      const token = await this.http.get<GlTokenInfo>('/personal_access_tokens/self');
      scopes = token.scopes;
      if (token.expires_at) {
        const ms = Date.parse(token.expires_at) - Date.now();
        tokenExpiresInDays = Math.max(0, Math.floor(ms / 86_400_000));
      }
    } catch {
      // OAuth tokens and older instances don't expose this — the connection
      // still counts as tested.
    }
    return { ok: true, username: user.username, scopes, tokenExpiresInDays };
  }

  async resolveSource(input: string): Promise<SourceResolution> {
    const parsed = parseSourceInput(input);
    switch (parsed.shape) {
      case 'path':
        return this.resolveByPath(parsed.path);
      case 'id': {
        const asProject = await this.tryProject(parsed.id);
        if (asProject) return { kind: 'repository', repo: asProject };
        const asGroup = await this.tryGroup(parsed.id);
        if (asGroup) return this.groupResolution(asGroup);
        return { kind: 'notVisible', id: parsed.id };
      }
      case 'groupId': {
        const group = await this.tryGroup(parsed.id);
        return group ? this.groupResolution(group) : { kind: 'notVisible', id: parsed.id };
      }
      case 'groupPath': {
        const group = await this.tryGroup(parsed.path);
        return group ? this.groupResolution(group) : { kind: 'noMatch' };
      }
      case 'invalid':
        return { kind: 'noMatch' };
    }
  }

  private async resolveByPath(path: string): Promise<SourceResolution> {
    const project = await this.tryProject(path);
    if (project) return { kind: 'repository', repo: project };
    // A pasted URL can also point at a group (spec §4).
    const group = await this.tryGroup(path);
    if (group) return this.groupResolution(group);
    return { kind: 'noMatch' };
  }

  private async tryProject(idOrPath: string): Promise<Repository | null> {
    try {
      return toRepository(await this.http.get<GlProject>(`/projects/${encodeRepoId(idOrPath)}`));
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') return null;
      throw e;
    }
  }

  private async tryGroup(idOrPath: string): Promise<GlGroup | null> {
    try {
      return await this.http.get<GlGroup>(`/groups/${encodeRepoId(idOrPath)}`);
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') return null;
      throw e;
    }
  }

  private async groupResolution(group: GlGroup): Promise<SourceResolution> {
    return {
      kind: 'group',
      group: toRepoGroup(group),
      repositories: await this.listGroupRepositories(String(group.id)),
    };
  }

  async listGroupRepositories(groupId: string): Promise<Repository[]> {
    const projects = await this.http.getAll<GlProject>(
      `/groups/${encodeRepoId(groupId)}/projects`,
      { include_subgroups: true, archived: false },
    );
    // One group-level query fills the chooser's open-MR counts — never one
    // request per project.
    const counts = new Map<string, number>();
    let countsKnown = true;
    try {
      const mrs = await this.http.getAll<{ project_id: number }>(
        `/groups/${encodeRepoId(groupId)}/merge_requests`,
        { state: 'opened', scope: 'all' },
      );
      for (const mr of mrs) {
        const key = String(mr.project_id);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } catch {
      // Counts are decoration; the chooser works without them — but a
      // failed query must read as unknown, not as a confident zero.
      countsKnown = false;
    }
    return projects.map((p) => ({
      ...toRepository(p),
      openChangeRequestCount: countsKnown ? (counts.get(String(p.id)) ?? 0) : undefined,
    }));
  }

  async getRepository(repoId: string): Promise<Repository> {
    return toRepository(await this.http.get<GlProject>(`/projects/${encodeRepoId(repoId)}`));
  }

  async listOpenChangeRequests(repoIds: readonly string[]): Promise<ChangeRequest[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        const mrs = await this.http.getAll<GlMergeRequest>(
          `/projects/${encodeRepoId(repoId)}/merge_requests`,
          { state: 'opened', scope: 'all' },
        );
        if (mrs.length === 0) return [];
        // The list endpoint omits head_pipeline (single-MR only), so CI
        // status is joined from one per-project pipelines query by SHA —
        // still never one request per MR.
        const bySha = new Map<string, GlPipelineRef>();
        try {
          const pipelines = await this.http.get<GlPipelineRef[]>(
            `/projects/${encodeRepoId(repoId)}/pipelines`,
            { per_page: 100 },
          );
          // Newest first — keep the first (latest) pipeline per SHA.
          for (const p of pipelines) {
            if (p.sha && !bySha.has(p.sha)) bySha.set(p.sha, p);
          }
        } catch {
          // CI status stays unknown; the rest of the row is unaffected.
        }
        return mrs.map((mr) => {
          const cr = toChangeRequest(mr);
          if (!cr.ci) {
            const pipeline = bySha.get(cr.headSha);
            if (pipeline) {
              cr.ci = {
                runId: String(pipeline.id),
                status: toCiStatus(pipeline.status),
                webUrl: pipeline.web_url,
              };
            }
          }
          return cr;
        });
      }),
    );
    return perRepo.flat();
  }

  async listWorkItems(repoIds: readonly string[]): Promise<WorkItem[]> {
    const perRepo = await Promise.all(
      repoIds.map((repoId) =>
        this.http.getAll<GlIssue>(`/projects/${encodeRepoId(repoId)}/issues`, {
          state: 'opened',
          scope: 'all',
        }),
      ),
    );
    return perRepo.flat().map(toWorkItem);
  }

  async listCiRuns(repoIds: readonly string[], limitPerRepo = 3): Promise<CiRun[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        const pipelines = await this.http.get<GlPipelineRef[]>(
          `/projects/${encodeRepoId(repoId)}/pipelines`,
          { per_page: limitPerRepo },
        );
        return pipelines.map((p) => toCiRun(p, repoId));
      }),
    );
    return perRepo.flat();
  }

  async getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff> {
    const changes = await this.http.get<GlMergeRequestChanges>(
      `${this.mrPath(ref)}/changes`,
    );
    return toChangeRequestDiff(ref, changes);
  }

  async submitReview(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    onProgress?: SubmitProgressFn,
  ): Promise<SubmitResult> {
    const outcomes: CommentOutcome[] = [];
    let abort: ScmError | undefined;
    // GitLab has no batched review: every comment is its own request, so the
    // whole submit is this loop and progress is worth reporting per comment.
    const total = submission.comments.length;
    onProgress?.({ stage: 'comments', posted: 0, total });

    for (const comment of submission.comments) {
      if (abort) {
        outcomes.push({ key: comment.key, ok: false, error: abort });
        continue;
      }
      try {
        const discussion = await this.http.post<{ id: string }>(`${this.mrPath(ref)}/discussions`, {
          body: buildCommentBody(comment),
          position: buildPosition(comment.anchor),
        });
        outcomes.push({ key: comment.key, ok: true, threadId: discussion.id });
      } catch (e) {
        const error = toScmError(e);
        outcomes.push({ key: comment.key, ok: false, error });
        // A stale anchor is per-comment; an auth/rate/network failure dooms
        // the rest of the batch — report, don't hammer.
        if (ABORT_KINDS.has(error.kind)) abort = error;
      }
      onProgress?.({ stage: 'comments', posted: outcomes.length, total });
    }

    const result: SubmitResult = {
      comments: outcomes,
      summaryPosted: false,
      // GitLab has no batched review: every comment is its own discussion.
      postedAsSingleReview: outcomes.length > 0 ? false : undefined,
    };
    const allOk = outcomes.every((o) => o.ok);

    if (submission.summary !== undefined && allOk) {
      onProgress?.({ stage: 'summary', posted: 0, total: 0 });
      try {
        await this.http.post(`${this.mrPath(ref)}/notes`, { body: submission.summary });
        result.summaryPosted = true;
      } catch (e) {
        result.summaryError = toScmError(e);
      }
    }

    if (submission.approve && allOk && result.summaryError === undefined) {
      try {
        await this.http.post(`${this.mrPath(ref)}/approve`);
        result.approvalApplied = true;
      } catch (e) {
        result.approvalError = toScmError(e);
      }
    }

    if (submission.requestChanges && allOk && result.summaryError === undefined) {
      try {
        await this.requestChanges(ref);
        result.requestChangesApplied = true;
      } catch (e) {
        result.requestChangesError = toScmError(e);
      }
    }
    return result;
  }

  /** No REST surface for this — GraphQL is the sanctioned equivalent. */
  private async requestChanges(ref: ChangeRequestRef): Promise<void> {
    const repo = await this.getRepository(ref.repoId);
    const data = await this.http.graphql<{
      mergeRequestUpdateReviewerState: { errors: string[] } | null;
    }>(
      `mutation($projectPath: ID!, $iid: String!) {
        mergeRequestUpdateReviewerState(
          input: { projectPath: $projectPath, iid: $iid, state: REQUESTED_CHANGES }
        ) { errors }
      }`,
      { projectPath: repo.path, iid: ref.number },
    );
    const errors = data.mergeRequestUpdateReviewerState?.errors ?? [];
    if (errors.length > 0) {
      throw new ScmError('unknown', `Request changes failed: ${errors.join('; ')}`);
    }
  }

  async listThreads(ref: ChangeRequestRef): Promise<ReviewThread[]> {
    const discussions = await this.http.getAll<GlDiscussion>(`${this.mrPath(ref)}/discussions`);
    return discussions
      .filter((d) => !d.individual_note)
      .map((d) => toReviewThread(d, ref));
  }

  async resolveThread(ref: ChangeRequestRef, threadId: string, resolved: boolean): Promise<void> {
    await this.http.put(`${this.mrPath(ref)}/discussions/${threadId}`, undefined, { resolved });
  }

  async replyToThread(ref: ChangeRequestRef, threadId: string, body: string): Promise<void> {
    await this.http.post(`${this.mrPath(ref)}/discussions/${threadId}/notes`, { body });
  }

  async approve(ref: ChangeRequestRef): Promise<void> {
    await this.http.post(`${this.mrPath(ref)}/approve`);
  }

  private mrPath(ref: ChangeRequestRef): string {
    return `/projects/${encodeRepoId(ref.repoId)}/merge_requests/${ref.number}`;
  }

  // ---- review-investigation operations (design.md D7, task 4.3) ------------
  //
  // `listChangedFiles`/`readDiff`/`searchDiff` all read the Compare API
  // (`GET /repository/compare?from=&to=`), not an MR-diff endpoint: every
  // MR-diff endpoint (`/changes`, `/diffs`, `/versions`) requires the MR
  // `iid`, but the neutral request types here carry only `snapshot`
  // (repoId+baseSha+headSha) — Compare is project+revision-scoped and fits
  // that contract exactly, and also lets a pinned read outlive the MR's
  // current diff. A 404 from Compare always means the revision pair itself
  // does not resolve (Compare has no path parameter to get wrong), so it
  // maps directly to `unavailable`, never `notFound`.

  private async compare(repoId: string, baseSha: string, headSha: string): Promise<GlCompareResult | undefined> {
    try {
      return await this.http.get<GlCompareResult>(`/projects/${encodeRepoId(repoId)}/repository/compare`, {
        from: baseSha,
        to: headSha,
        straight: true,
      });
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') return undefined;
      throw e;
    }
  }

  async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    const bound =
      CAPABILITIES.reviewInvestigation!.manifests.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const { page, nextCursor } = paginateArray(compared.diffs.map(toChangedFileEntry), request.cursor, bound);
    if (nextCursor) return { snapshot, state: 'paginated', value: page, cursor: nextCursor };
    if (compared.compare_timeout) return { snapshot, state: 'truncated', value: page };
    return { snapshot, state: 'complete', value: page };
  }

  async readDiff(request: DiffPageRequest): Promise<DiffPageResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    const file = compared.diffs.find((d) => d.new_path === request.path || d.old_path === request.path);
    if (!file) return { snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
    // GitLab docs: when `compare_timeout` is true, an individual diff's
    // content may come back empty because it exceeded limits — the same
    // "excluded, cannot retrieve" outcome as an explicit `too_large`.
    if (file.too_large || (compared.compare_timeout && file.diff === '')) return { snapshot, state: 'tooLarge' };
    if (isBinaryDiff(file.diff)) return { snapshot, state: 'binary' };
    const bound =
      CAPABILITIES.reviewInvestigation!.diffReads.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const { page, nextCursor } = paginateArray(file.diff.split('\n'), request.cursor, bound);
    const value: DiffPage = {
      path: file.new_path,
      oldPath: file.renamed_file ? file.old_path : undefined,
      isRenamed: file.renamed_file,
      patch: page.join('\n'),
      positions: [],
    };
    if (nextCursor) return { snapshot, state: 'paginated', value, cursor: nextCursor };
    return { snapshot, state: 'complete', value };
  }

  async readFile(request: FileRangeRequest): Promise<FileRangeResult> {
    const { snapshot } = request;
    const revisionSha = request.revision === 'base' ? snapshot.baseSha : snapshot.headSha;
    let file: GlRepositoryFile;
    try {
      file = await this.http.get<GlRepositoryFile>(
        `/projects/${encodeRepoId(snapshot.repoId)}/repository/files/${encodeURIComponent(request.path)}`,
        { ref: revisionSha },
      );
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') {
        // GitLab's own wording differs for a bad ref vs. a bad path; a
        // revision problem must never be retried against another revision,
        // while a path problem is just an absent file at a known revision.
        return /commit/i.test(e.message)
          ? { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${revisionSha}` }
          : { snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
      }
      throw e;
    }
    if (file.size > MAX_FETCHABLE_FILE_BYTES) return { snapshot, state: 'tooLarge', byteSize: file.size };
    const content = Buffer.from(file.content, 'base64');
    if (content.includes(0)) return { snapshot, state: 'binary', byteSize: file.size };
    const lines = content.toString('utf8').split('\n');
    const bound =
      CAPABILITIES.reviewInvestigation!.fileReads.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const start = Math.max(1, request.startLine);
    if (start > lines.length) return { snapshot, state: 'notFound', reason: 'startLine beyond file length' };
    const availableEnd = Math.min(request.endLine, lines.length);
    const boundedEnd = Math.min(availableEnd, start + bound - 1);
    const value: FileRange = {
      revision: request.revision,
      path: request.path,
      startLine: start,
      endLine: boundedEnd,
      text: lines.slice(start - 1, boundedEnd).join('\n'),
    };
    if (boundedEnd < availableEnd) return { snapshot, state: 'truncated', value, knownRemainingUnits: availableEnd - boundedEnd };
    return { snapshot, state: 'complete', value };
  }

  async searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
    const { snapshot } = request;
    const revisionSha = request.revision === 'base' ? snapshot.baseSha : snapshot.headSha;
    const bound =
      CAPABILITIES.reviewInvestigation!.repositorySearch.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const page = request.cursor ? Number(request.cursor) : 1;
    let blobs: GlSearchBlob[];
    try {
      blobs = await this.http.get<GlSearchBlob[]>(`/projects/${encodeRepoId(snapshot.repoId)}/search`, {
        scope: 'blobs',
        search: request.query,
        ref: revisionSha,
        page,
        per_page: bound,
      });
    } catch (e) {
      // scope=blobs needs GitLab Advanced Search or Exact Code Search — a
      // real per-instance/tier gap, reported as unavailable rather than an
      // opaque throw.
      if (isScmError(e) && (e.kind === 'insufficientScope' || e.kind === 'notFound')) {
        return { snapshot, state: 'unavailable', reason: 'Repository search requires GitLab Advanced Search or Exact Code Search' };
      }
      throw e;
    }
    const value: SearchMatch[] = blobs
      .filter((b) => !request.pathScope || b.path.startsWith(request.pathScope))
      .map(toSearchMatchFromBlob);
    if (blobs.length === bound) return { snapshot, state: 'paginated', value, cursor: String(page + 1) };
    return { snapshot, state: 'complete', value };
  }

  async searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    // A diff GitLab itself could not fully compute cannot be claimed exhaustively searchable.
    if (compared.compare_timeout) return { snapshot, state: 'unknown', reason: 'Diff exceeds size limits and cannot be exhaustively searched' };
    const value: DiffSearchMatch[] = [];
    for (const file of compared.diffs) {
      if (file.too_large || isBinaryDiff(file.diff)) continue;
      if (request.pathScope && !file.new_path.startsWith(request.pathScope)) continue;
      linesFromUnifiedDiff(file.diff).forEach((line, index) => {
        if (line.includes(request.query)) value.push({ position: { path: file.new_path, side: 'new', line: index + 1 }, excerpt: line.trim() });
      });
    }
    return { snapshot, state: 'complete', value };
  }

  async getChangeRequestDetails(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> {
    const { snapshot } = request;
    const path = `/projects/${encodeRepoId(snapshot.repoId)}/merge_requests/${request.number}`;
    let mr: GlMergeRequest;
    try {
      mr = await this.http.get<GlMergeRequest>(path);
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') return { snapshot, state: 'notFound', reason: `No such change request: ${request.number}` };
      throw e;
    }
    const [discussions, commits] = await Promise.all([
      this.http.getAll<GlDiscussion>(`${path}/discussions`),
      this.http.getAll<GlCommit>(`${path}/commits`),
    ]);
    const discussion = discussions.filter((d) => !d.individual_note).flatMap(nonSystemNotes);
    return { snapshot, state: 'complete', value: toNormalizedDetail(mr, discussion, commits) };
  }

  async getIssueDetails(request: IssueDetailRequest): Promise<IssueDetailResult> {
    const { snapshot } = request;
    const path = `/projects/${encodeRepoId(request.issueRepoId)}/issues/${request.issueNumber}`;
    let issue: GlIssue;
    try {
      issue = await this.http.get<GlIssue>(path);
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') {
        return { snapshot, state: 'notFound', reason: `No such issue: ${request.issueRepoId}#${request.issueNumber}` };
      }
      throw e;
    }
    const discussions = await this.http.getAll<GlDiscussion>(`${path}/discussions`);
    const discussion = discussions.filter((d) => !d.individual_note).flatMap(nonSystemNotes);
    return { snapshot, state: 'complete', value: toNormalizedDetailFromIssue(issue, discussion) };
  }

  async getCurrentHead(ref: ChangeRequestRef): Promise<CurrentHeadResult> {
    try {
      const mr = await this.http.get<GlMergeRequest>(this.mrPath(ref));
      return { repoId: ref.repoId, state: 'resolved', headSha: mr.sha };
    } catch (e) {
      if (isScmError(e) && e.kind === 'notFound') return { repoId: ref.repoId, state: 'notFound' };
      throw e;
    }
  }
}

/** In-memory pagination over an already-fully-fetched array \u2014 GitLab returns each of Compare/search/files in one call; the cursor is host-defined and never inspected by GitLab. */
function paginateArray<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { page: readonly T[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  return { page: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

export function createGitLabProvider(fetchImpl?: FetchLike): ScmProvider {
  return {
    id: 'gitlab',
    displayName: 'GitLab',
    capabilities: CAPABILITIES,
    vocabulary: VOCABULARY,
    host: HOST,
    // Self-managed and gitlab.com alike: a personal access token.
    authModesFor: () => ['token'],
    connect(config: ConnectionConfig): Connection {
      return new GitLabConnection(
        new GitLabHttp(config.instanceUrl, bearerToken(config.credential), fetchImpl),
      );
    },
  };
}

export const gitlabProvider: ScmProvider = createGitLabProvider();
