/**
 * The GitLab `ScmProvider` (REST v4, gitlab.com and self-hosted). All GitLab
 * knowledge lives in this directory; everything above talks to
 * `src/platform` types only.
 */
import type {
  Connection,
  ConnectionConfig,
  Credential,
  ProviderCapabilities,
  ScmProvider,
  Vocabulary,
  HostDescriptor,
} from '../../platform/provider';
import type {
  ChangeRequest,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CommentOutcome,
  ConnectionStatus,
  CurrentHeadResult,
  IssueDetailRequest,
  IssueDetailResult,
  ObjectSourceResult,
  Repository,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitProgressFn,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { basicAuthorizationHeaderValue, credentialSecret } from '../../platform/provider';
import { isFetchableObjectSourceUrl } from '../../platform/types';
import { ScmError, isScmError, toScmError } from '../../platform/errors';
import { parseSourceInput } from './sourceInput';
import type { FetchLike } from './http';
import { GitLabHttp, encodeRepoId } from './http';
import type {
  GlCommit,
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
  nonSystemNotes,
  toChangeRequest,
  toChangeRequestDiff,
  toCiRun,
  toCiStatus,
  toNormalizedDetail,
  toNormalizedDetailFromIssue,
  toRepoGroup,
  toRepository,
  toReviewThread,
  toWorkItem,
} from './mappers';

/** Declared review-investigation page bounds (design.md D7, task 4.3) \u2014 self-imposed, since GitLab returns each of these payloads in one call rather than paginating them itself. */
const INVESTIGATION_MANIFEST_PAGE = 100;

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
  // D7: the two detail reads, and nothing else. Five more used to be declared
  // here — manifests, diff reads, file reads, repository search and diff search
  // — read from the Compare API and the repository-search endpoint. They are
  // gone with the rest of the provider investigation path: anything answerable
  // from two commits is answered by git against a local object store, so no
  // forge is asked for it. GitLab could answer a revision-pinned search where
  // GitHub could not, and it still loses the operation, because the point is
  // not which forge is better at it — it is that a second route to a diff is
  // how the fallback comes back.
  detailRetrieval: {
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

/**
 * The username GitLab wants in the Basic pair for git over HTTPS, per
 * credential kind. The token is always the password half — GitLab never reads
 * one out of the username half, which is one real difference from GitHub.
 *
 * `oauth2` is what GitLab documents for an OAuth access token
 * (`https://oauth2:<token>@gitlab.example.com/…`, docs.gitlab.com, "OAuth 2.0
 * identity provider API", read 2026-09-11), and it is required rather than
 * merely conventional on releases whose `Gitlab::Auth` reaches the OAuth check
 * with the login in hand — older releases took `oauth_access_token_check(login,
 * password)` and required exactly this value, while master today takes only the
 * password. A self-managed instance can be any release, so this is the value
 * that works on all of them.
 *
 * A personal access token deliberately does NOT use `oauth2`. GitLab's own
 * documentation says the username "can be any string value" and "must not be
 * an empty string" (docs.gitlab.com, "Personal access tokens", read
 * 2026-09-11), so any sentinel is correct — and choosing one that is not
 * `oauth2` means the request never enters the OAuth branch at all on the older
 * releases described above. What that branch does with a password that is not
 * an OAuth token is inferred from reading the chain rather than measured, and a
 * username that avoids it is a fact that needs no inference. `gitlab-ci-token`
 * is avoided for the same reason from the other direction: it is GitLab's
 * reserved login for CI job tokens.
 */
const GIT_HTTPS_USERNAME: { readonly token: string; readonly session: string } = {
  token: 'private-token',
  session: 'oauth2',
};

/**
 * The complete `Authorization` value a `git fetch` against this connection's
 * project should carry, or `undefined` when there is no credential to send.
 *
 * **The live failure this replaces.** Until 2026-09-09 this composed
 * `Bearer ${token}`, the same scheme `http.ts` uses for the REST API, and a
 * review stopped with "The object source would not authorize this fetch with
 * the credential this connection has for it." The measurement that pinned it
 * was taken against GitHub (`../github/githubProvider.ts` records the table),
 * and the diagnosis applies here for the same reason: a forge's REST API and a
 * forge's git transport are different servers with different authentication,
 * and git over HTTPS is HTTP Basic on both platforms.
 *
 * This side was not measured against a running GitLab — none was available —
 * so it is composed from GitLab's own documentation and source, cited above
 * `GIT_HTTPS_USERNAME`, and held by a real fetch through
 * `../objectSourceGitFetch.test.ts` against the rule `./fakeGitLab.ts` states.
 * That is weaker evidence than the GitHub table and is labelled as such rather
 * than dressed up.
 *
 * Unlike GitHub, the two credential kinds do not send the same value: what
 * GitLab does with the username depends on what the token is. `none` sends no
 * header at all rather than an empty pair, so that "no credential" is
 * indistinguishable from never having been asked for one.
 *
 * The `session` branch is not reachable through onboarding today —
 * `authModesFor` offers `token` only, because this provider has no editor
 * session to ask for — and it is written and tested anyway: `Credential` is a
 * union every provider answers in full, and the alternative is a provider that
 * silently sends the wrong username on the day one appears.
 */
function gitAuthorizationHeaderValue(credential: Credential): string | undefined {
  switch (credential.kind) {
    case 'token':
      return credential.token === '' ? undefined : basicAuthorizationHeaderValue(GIT_HTTPS_USERNAME.token, credential.token);
    case 'session':
      return credential.accessToken === '' ? undefined : basicAuthorizationHeaderValue(GIT_HTTPS_USERNAME.session, credential.accessToken);
    case 'none':
      return undefined;
  }
}

export class GitLabConnection implements Connection {
  constructor(
    private readonly http: GitLabHttp,
    /**
     * The pod's credential, held for one purpose only: composing the
     * `Authorization` header value in `getObjectSource`'s descriptor
     * (`add-local-git-investigation` task 2.4), so a source that fetches git
     * objects itself can authenticate as this connection does. Every API call
     * this class makes still authenticates through `http`, which holds its own
     * copy; this one never reaches a URL, a log line or an error string
     * (`src/providers/objectSourceCredential.test.ts`).
     */
    private readonly credential: Credential,
  ) {}

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

  // ---- forge-only detail retrieval (design.md D7) -------------------------
  //
  // Everything that used to sit above these two — the Compare-API manifest,
  // diff read, file read, repository search and diff search — was removed with
  // the provider investigation path. What is left is what is not in the
  // repository: the merge request's own detail, and a linked issue's.

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

  /**
   * Where a source that computes diffs itself may fetch this project's git
   * objects (`add-local-git-investigation` design.md D2/D8, task 2.4).
   *
   * The project has to be read, not composed: a GitLab `repoId` is the
   * numeric project id, and no clone URL can be built from a number. The
   * instance's own `http_url_to_repo` is the answer, with `web_url` + `.git`
   * as the fallback for a response that omits it.
   *
   * The ref hint is `refs/merge-requests/{iid}/head`: the ref GitLab keeps for
   * a merge request's head even after a force-push leaves that commit
   * unreachable from any branch. Composing it is this provider's job and it
   * stays here — the descriptor hands it over as an opaque string, and nothing
   * above the provider boundary learns that such a ref exists (design.md D8).
   *
   * Every failure answers `unavailable` rather than throwing: the caller's
   * question is "can objects be obtained", and the answer to no is that this
   * project cannot be reviewed and the reason says why. There is no forge
   * fallback behind it any more — this provider serves no investigation — so an
   * unavailable descriptor ends the attempt rather than routing it somewhere
   * else. The reason names the neutral error kind only, never GitLab's own
   * message, which is a channel a credential could ride out on.
   */
  async getObjectSource(ref: ChangeRequestRef): Promise<ObjectSourceResult> {
    let project: GlProject;
    try {
      project = await this.http.get<GlProject>(`/projects/${encodeRepoId(ref.repoId)}`);
    } catch (e) {
      return { state: 'unavailable', reason: `The project's object location could not be read (${toScmError(e).kind}).` };
    }
    const fetchUrl = project.http_url_to_repo ?? `${project.web_url}.git`;
    if (!isFetchableObjectSourceUrl(fetchUrl)) {
      return { state: 'unavailable', reason: 'The project reports no ordinary HTTP or HTTPS clone location.' };
    }
    // The branch this merge request targets, which is what the merge base is
    // computed against locally. It is a fact about the merge request rather
    // than about the repository's objects, so it is one of the few things this
    // connection is still asked for.
    let target: string | undefined;
    try {
      target = (await this.http.get<GlMergeRequest>(this.mrPath(ref))).target_branch;
    } catch {
      // Left absent rather than guessed: a default-branch fallback would look
      // right almost always and quietly review the wrong pair of commits for a
      // merge request that targets a release branch.
      target = undefined;
    }
    const authorization = gitAuthorizationHeaderValue(this.credential);
    return {
      state: 'available',
      descriptor: {
        fetchUrl,
        ...(authorization === undefined ? {} : { authorizationHeaderValue: authorization }),
        refHint: `refs/merge-requests/${ref.number}/head`,
        ...(target === undefined ? {} : { mergeTargetRef: `refs/heads/${target}` }),
      },
    };
  }
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
        new GitLabHttp(config.instanceUrl, credentialSecret(config.credential), fetchImpl),
        config.credential,
      );
    },
  };
}

export const gitlabProvider: ScmProvider = createGitLabProvider();
