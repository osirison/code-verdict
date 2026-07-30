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
} from '../../platform/provider';
import type {
  ChangeRequest,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CommentOutcome,
  ConnectionStatus,
  Repository,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { ScmError, isScmError, toScmError } from '../../platform/errors';
import { parseSourceInput } from '../../platform/sourceInput';
import type { FetchLike } from './http';
import { GitLabHttp, encodeRepoId } from './http';
import type {
  GlDiscussion,
  GlGroup,
  GlIssue,
  GlMergeRequest,
  GlMergeRequestChanges,
  GlPipelineRef,
  GlProject,
  GlUser,
} from './mappers';
import {
  buildCommentBody,
  buildPosition,
  toChangeRequest,
  toChangeRequestDiff,
  toCiRun,
  toCiStatus,
  toRepoGroup,
  toRepository,
  toReviewThread,
  toWorkItem,
} from './mappers';

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
};

const VOCABULARY: Vocabulary = {
  changeRequestNoun: 'merge request',
  changeRequestAbbrev: 'MR',
  repoNoun: 'project',
  groupNoun: 'group',
  ciNoun: 'pipeline',
  formatCrRef: (number) => `!${number}`,
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

  async submitReview(ref: ChangeRequestRef, submission: ReviewSubmission): Promise<SubmitResult> {
    const outcomes: CommentOutcome[] = [];
    let abort: ScmError | undefined;

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
    }

    const result: SubmitResult = { comments: outcomes, summaryPosted: false };
    const allOk = outcomes.every((o) => o.ok);

    if (submission.summary !== undefined && allOk) {
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
}

export function createGitLabProvider(fetchImpl?: FetchLike): ScmProvider {
  return {
    id: 'gitlab',
    displayName: 'GitLab',
    capabilities: CAPABILITIES,
    vocabulary: VOCABULARY,
    connect(config: ConnectionConfig): Connection {
      return new GitLabConnection(new GitLabHttp(config.instanceUrl, config.token, fetchImpl));
    },
  };
}

export const gitlabProvider: ScmProvider = createGitLabProvider();
