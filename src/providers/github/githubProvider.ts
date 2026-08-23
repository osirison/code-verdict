/**
 * The GitHub provider: REST for everything except what only GraphQL can do
 * (review-thread resolution and outdated state). See docs/ARCHITECTURE.md.
 */
import type {
  AuthMode,
  Connection,
  ConnectionConfig,
  HostDescriptor,
  ProviderCapabilities,
  ScmProvider,
  Vocabulary,
} from '../../platform/provider';
import { bearerToken } from '../../platform/provider';
import type {
  ChangeRequest,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  CommentOutcome,
  ConnectionStatus,
  DiffAnchor,
  Repository,
  ReviewCommentDraft,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import type { ScmError } from '../../platform/errors';
import { toScmError } from '../../platform/errors';
import type { FetchLike } from './http';
import { GitHubHttp, hostOf, isDotCom, splitRepoId } from './http';
import { parseGitHubSourceInput } from './sourceInput';
import { isVerdictRefused } from './errors';
import {
  isRealIssue,
  toCiSummary,
  toChangeRequest,
  toCiRun,
  toFileDiff,
  toRepoGroup,
  toRepository,
  toReviewThread,
  toWorkItem,
  type GhCheckRun,
  type GhFile,
  type GhIssue,
  type GhOrg,
  type GhPull,
  type GhRepo,
  type GqlChecksResponse,
  type GqlThread,
  type CiSummary,
} from './mappers';

const CAPABILITIES: ProviderCapabilities = {
  // ```suggestion blocks render as an applyable "Commit suggestion".
  suggestions: true,
  approvals: true,
  requestChanges: true,
  // GraphQL resolveReviewThread / unresolveReviewThread — no REST equivalent.
  threadResolution: true,
  groupHierarchy: true,
  // POST /pulls/{n}/reviews carries the whole review at once.
  batchedReview: true,
};

const VOCABULARY: Vocabulary = {
  platformName: 'GitHub',
  changeRequestNoun: 'pull request',
  changeRequestNounPlural: 'pull requests',
  changeRequestAbbrev: 'PR',
  repoNoun: 'repository',
  repoNounPlural: 'repositories',
  groupNoun: 'organization',
  ciNoun: 'check',
  ciNounPlural: 'checks',
  formatCrRef: (number) => `#${number}`,
};

const HOST: HostDescriptor = {
  instanceUrlLabel: 'GitHub host',
  defaultInstanceUrl: 'https://github.com',
  tokenPlaceholder: 'ghp_… / github_pat_…',
  tokenHint: 'a personal access token with `repo` scope',
  sourceInputPlaceholder: 'https://github.com/acme/core · acme/core · acme',
  sourceInputHint: 'Accepts a repository URL, an owner/repo path, or an organization.',
  sourceSamples: [
    { label: 'repository URL', value: 'https://github.com/acme/core' },
    { label: 'owner/repo', value: 'acme/core' },
    { label: 'organization', value: 'acme' },
  ],
  session: { editorProviderId: 'github', scopes: ['repo', 'read:org'] },
};

/** Errors after which posting the remaining comments cannot succeed. */
const ABORT_KINDS = new Set(['auth', 'insufficientScope', 'rateLimited', 'network']);

/** GitHub renders a suggestion from a fenced block, same syntax as GitLab. */
function buildCommentBody(comment: ReviewCommentDraft): string {
  const parts = [comment.body];
  if (comment.suggestion) {
    parts.push(['```suggestion', comment.suggestion.new, '```'].join('\n'));
  }
  if (comment.footer) parts.push(comment.footer);
  return parts.join('\n\n');
}

interface GitHubAnchorRefs {
  commitId: string;
}

/**
 * Where a comment lands. `commit_id` is deliberately NOT included: GitHub
 * documents it as a top-level parameter of the review endpoint, and the
 * `comments[]` items accept only path/position/body/line/side/start_line/
 * start_side. The single-comment endpoint is the one that takes it per comment,
 * so that path adds it explicitly.
 */
function anchorPayload(anchor: DiffAnchor): Record<string, unknown> {
  const side = anchor.side === 'old' ? 'LEFT' : 'RIGHT';
  const payload: Record<string, unknown> = {
    path: anchor.filePath,
    line: anchor.endLine ?? anchor.line,
    side,
  };
  if (anchor.endLine !== undefined && anchor.endLine !== anchor.line) {
    payload.start_line = Math.min(anchor.line, anchor.endLine);
    payload.start_side = side;
  }
  return payload;
}

function commitIdOf(anchor: DiffAnchor | undefined): string | undefined {
  return (anchor?.refs as GitHubAnchorRefs | undefined)?.commitId;
}

type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * GitHub requires a review body for REQUEST_CHANGES and COMMENT (it is optional
 * only for APPROVE). A verdict-only review — the changeset retry, and the
 * fallback's "the summary is withheld but the verdict must still land" path —
 * has no summary to send, so it carries a minimal one rather than 422ing and
 * dropping the verdict entirely.
 */
const VERDICT_BODY: Record<ReviewEvent, string> = {
  APPROVE: 'Approved.',
  REQUEST_CHANGES: 'Changes requested — see the inline comments.',
  COMMENT: 'See the inline comments.',
};

/** A summary the user actually wrote. Cleared or whitespace is not one. */
function hasSummary(summary: string | undefined): boolean {
  return summary !== undefined && summary.trim() !== '';
}

function reviewBody(event: ReviewEvent, summary: string | undefined): string | undefined {
  if (hasSummary(summary)) return summary;
  return event === 'APPROVE' ? undefined : VERDICT_BODY[event];
}

/**
 * The verdict half of a `SubmitResult`, for a verdict GitHub would not take.
 * `COMMENT` carries no verdict, so it contributes nothing.
 */
function verdictFailure(event: ReviewEvent, error: ScmError): Partial<SubmitResult> {
  if (event === 'APPROVE') return { approvalApplied: false, approvalError: error };
  if (event === 'REQUEST_CHANGES') return { requestChangesApplied: false, requestChangesError: error };
  return {};
}

/**
 * One query per repository for the check state of every open pull request.
 *
 * This exists because the contract says list calls are batched per repository,
 * never one request per change request — and GitHub's REST check-runs endpoint
 * is per-ref, so the REST version cost 1 + N requests per repo and burned the
 * hourly rate limit on a 60s poll. `statusCheckRollup` is the same aggregate
 * GitHub shows on the PR itself.
 */
const CHECKS_QUERY = `
query($owner: String!, $repo: String!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequests(states: OPEN, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number
        commits(last: 1) {
          nodes {
            commit {
              statusCheckRollup {
                state
                contexts(first: 20) {
                  nodes {
                    __typename
                    ... on CheckRun { databaseId name conclusion status permalink }
                    ... on StatusContext { context state targetUrl }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line
          resolvedBy { login }
          comments(first: 100) { nodes { id databaseId body createdAt author { login } } }
        }
      }
    }
  }
}`;

export class GitHubConnection implements Connection {
  constructor(
    private readonly http: GitHubHttp,
    /** The connected instance's host, for validating pasted source URLs. */
    private readonly instanceHost: string,
  ) {}

  private repoPath(repoId: string): string {
    const { owner, repo } = splitRepoId(repoId);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private prPath(ref: ChangeRequestRef): string {
    return `${this.repoPath(ref.repoId)}/pulls/${encodeURIComponent(ref.number)}`;
  }

  async testConnection(): Promise<ConnectionStatus> {
    try {
      const user = await this.http.get<{ login: string; name?: string | null }>('/user');
      return { ok: true, username: user.login };
    } catch (e) {
      return { ok: false, error: toScmError(e) };
    }
  }

  async resolveSource(input: string): Promise<SourceResolution> {
    // Host-checked: a URL for another platform or host must not resolve
    // against this instance just because its path happens to fit.
    const parsed = parseGitHubSourceInput(input, this.instanceHost);
    switch (parsed.shape) {
      case 'repo': {
        const repoId = `${parsed.owner}/${parsed.repo}`;
        try {
          return { kind: 'repository', repo: await this.getRepository(repoId) };
        } catch (e) {
          // GitHub answers 404 for "absent" and "invisible" alike. A
          // well-formed reference is reported notVisible: that is the
          // actionable message, and either way nothing is added to the pod.
          if (toScmError(e).kind === 'notFound') return { kind: 'notVisible', id: repoId };
          throw e;
        }
      }
      case 'org':
      case 'orgCandidate': {
        try {
          const org = await this.http.get<GhOrg>(`/orgs/${encodeURIComponent(parsed.org)}`);
          return {
            kind: 'group',
            group: toRepoGroup(org),
            repositories: await this.listGroupRepositories(parsed.org),
          };
        } catch (e) {
          if (toScmError(e).kind !== 'notFound') throw e;
          // An explicit /orgs/ URL that 404s is invisible; a bare name might
          // simply not be an organization at all.
          return parsed.shape === 'org' ? { kind: 'notVisible', id: parsed.org } : { kind: 'noMatch' };
        }
      }
      case 'invalid':
        return { kind: 'noMatch' };
    }
  }

  async listGroupRepositories(groupId: string): Promise<Repository[]> {
    const repos = await this.http.getAll<GhRepo>(`/orgs/${encodeURIComponent(groupId)}/repos`, {
      type: 'all',
      sort: 'full_name',
    });
    return repos.map(toRepository);
  }

  async getRepository(repoId: string): Promise<Repository> {
    return toRepository(await this.http.get<GhRepo>(this.repoPath(repoId)));
  }

  async listOpenChangeRequests(repoIds: readonly string[]): Promise<ChangeRequest[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        // Two requests per repository, whatever the pull-request count: the
        // REST list, and one GraphQL query for every rollup. Never one per PR.
        const [pulls, checks] = await Promise.all([
          this.http.getAll<GhPull>(`${this.repoPath(repoId)}/pulls`, {
            state: 'open',
            sort: 'updated',
            direction: 'desc',
          }),
          this.checksByPullNumber(repoId),
        ]);
        return pulls.map((pull) => toChangeRequest(repoId, pull, checks.get(pull.number)));
      }),
    );
    return perRepo.flat();
  }

  /** Every open pull request's check state for one repository, in one query. */
  private async checksByPullNumber(repoId: string): Promise<Map<number, CiSummary>> {
    const { owner, repo } = splitRepoId(repoId);
    const byNumber = new Map<number, CiSummary>();
    let cursor: string | null = null;

    try {
      for (let page = 0; page < 10; page += 1) {
        const data: GqlChecksResponse = await this.http.graphql(CHECKS_QUERY, { owner, repo, cursor });
        const pulls = data.repository?.pullRequests;
        if (!pulls) break;
        for (const node of pulls.nodes) {
          const rollup = node.commits?.nodes?.[0]?.commit?.statusCheckRollup;
          const summary = toCiSummary(rollup);
          if (summary) byNumber.set(node.number, summary);
        }
        if (!pulls.pageInfo.hasNextPage) break;
        cursor = pulls.pageInfo.endCursor;
      }
    } catch {
      // Checks are decoration on the list — a repository whose checks cannot be
      // read (or a token without the scope) must still list its pull requests.
    }
    return byNumber;
  }

  async listWorkItems(repoIds: readonly string[]): Promise<WorkItem[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        const issues = await this.http.getAll<GhIssue>(`${this.repoPath(repoId)}/issues`, {
          state: 'open',
          sort: 'updated',
          direction: 'desc',
        });
        // The issues endpoint returns pull requests too; those are not work items.
        return issues.filter(isRealIssue).map((issue) => toWorkItem(repoId, issue));
      }),
    );
    return perRepo.flat();
  }

  async listCiRuns(repoIds: readonly string[], limitPerRepo = 20): Promise<CiRun[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        try {
          const commits = await this.http.get<Array<{ sha: string }>>(
            `${this.repoPath(repoId)}/commits`,
            { per_page: Math.min(limitPerRepo, 30) },
          );
          const runs = await Promise.all(
            commits.slice(0, limitPerRepo).map(async (commit) => {
              const payload = await this.http.get<{ check_runs?: GhCheckRun[] }>(
                `${this.repoPath(repoId)}/commits/${encodeURIComponent(commit.sha)}/check-runs`,
                { per_page: 100 },
              );
              return (payload.check_runs ?? []).map((run) => toCiRun(repoId, run));
            }),
          );
          return runs.flat().slice(0, limitPerRepo);
        } catch {
          return [] as CiRun[];
        }
      }),
    );
    return perRepo.flat();
  }

  async getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff> {
    const pull = await this.http.get<GhPull>(this.prPath(ref));
    const files = await this.http.getAll<GhFile>(`${this.prPath(ref)}/files`);
    return {
      ref,
      headSha: pull.head.sha,
      files: files.map(toFileDiff),
      // Opaque to the platform layer: GitHub needs one commit id where GitLab
      // needs a diff_refs triple.
      anchorRefs: { commitId: pull.head.sha } satisfies GitHubAnchorRefs,
    };
  }

  /**
   * Two-phase, and this is the design's central decision.
   *
   * GitHub's batched review endpoint is all-or-nothing: one bad position
   * rejects the whole POST. The neutral contract promises an outcome per
   * comment. So: try the batch (the normal path, and the one that produces the
   * right artifact — a single review on the pull request); on a
   * *position-related* rejection fall back to posting comments individually for
   * real per-comment outcomes, then post the summary and verdict as a
   * comment-free review so a partial comment failure never drops the verdict.
   * On a non-position rejection nothing was attempted, so the normalized error
   * is thrown rather than returned — which is what the contract specifies.
   */
  async submitReview(ref: ChangeRequestRef, submission: ReviewSubmission): Promise<SubmitResult> {
    // approve wins over requestChanges: GitHub has one event, and reporting
    // both as applied would claim a verdict that was never sent.
    const event: ReviewEvent = submission.approve
      ? 'APPROVE'
      : submission.requestChanges
        ? 'REQUEST_CHANGES'
        : 'COMMENT';

    // Comments with no summary and no verdict are not a review — they are
    // comments to add. This is the shape `submit.ts` retries with once the
    // summary has already been posted; creating a second bodiless COMMENT
    // review for it would 422, because GitHub requires a body for that event.
    if (event === 'COMMENT' && !hasSummary(submission.summary)) {
      return this.submitCommentByComment(ref, submission, event);
    }

    try {
      return await this.submitAsOneReview(ref, submission, event);
    } catch (e) {
      const error = toScmError(e);
      // GitHub refused the verdict, not the review — an author cannot approve
      // or request changes on their own pull request. The comments and the
      // summary are still valid, so re-send the identical review as a plain
      // COMMENT and report the verdict through its own field. Throwing here
      // would lose the whole review to a refusal of one field (task 5.7).
      if (isVerdictRefused(error)) {
        // Same guard as above: a bodiless COMMENT review is a 422, so a
        // submission with no summary posts its comments standalone instead.
        const downgraded = hasSummary(submission.summary)
          ? await this.submitAsOneReview(ref, submission, 'COMMENT')
          : await this.submitCommentByComment(ref, submission, 'COMMENT');
        return { ...downgraded, ...verdictFailure(event, error) };
      }
      if (error.kind !== 'staleAnchor') throw error;
      return this.submitCommentByComment(ref, submission, event);
    }
  }

  private async submitAsOneReview(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    event: ReviewEvent,
  ): Promise<SubmitResult> {
    const comments = submission.comments.map((comment) => ({
      ...anchorPayload(comment.anchor),
      body: buildCommentBody(comment),
    }));
    if (comments.length === 0 && submission.summary === undefined && event === 'COMMENT') {
      return { comments: [], summaryPosted: false };
    }

    const review = await this.http.post<{ id: number }>(`${this.prPath(ref)}/reviews`, {
      event,
      body: reviewBody(event, submission.summary),
      comments,
      commit_id: commitIdOf(submission.comments[0]?.anchor),
    });

    const threadIds = await this.threadIdsForReview(ref, review?.id, submission.comments.length);

    return {
      comments: submission.comments.map((comment, index) => ({
        key: comment.key,
        ok: true,
        threadId: threadIds[index],
      })),
      // Only the user's own summary counts as posted. A verdict-only review
      // carries canned text because GitHub demands a body — reporting that as
      // "your summary landed" would be a lie the UI then repeats.
      summaryPosted: hasSummary(submission.summary),
      // Reported from the event actually sent, never from the request flags —
      // only one verdict goes out, so only one may be reported applied.
      approvalApplied: event === 'APPROVE' ? true : undefined,
      requestChangesApplied: event === 'REQUEST_CHANGES' ? true : undefined,
    };
  }

  private async submitCommentByComment(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    event: ReviewEvent,
  ): Promise<SubmitResult> {
    const outcomes: CommentOutcome[] = [];
    let abort: ScmError | undefined;

    for (const comment of submission.comments) {
      if (abort) {
        outcomes.push({ key: comment.key, ok: false, error: abort });
        continue;
      }
      try {
        const posted = await this.http.post<{ id: number }>(`${this.prPath(ref)}/comments`, {
          ...anchorPayload(comment.anchor),
          // Required per comment on this endpoint, unlike the review endpoint.
          commit_id: commitIdOf(comment.anchor),
          body: buildCommentBody(comment),
        });
        outcomes.push({ key: comment.key, ok: true, threadId: String(posted.id) });
      } catch (e) {
        const error = toScmError(e);
        outcomes.push({ key: comment.key, ok: false, error });
        if (ABORT_KINDS.has(error.kind)) abort = error;
      }
    }

    // The REST ids just collected are not thread ids; resolve them before
    // they are stored, or the Posted reviews panel matches nothing later.
    if (outcomes.some((outcome) => outcome.ok)) {
      const byCommentId = await this.threadIdsByCommentId(ref);
      for (const outcome of outcomes) {
        const commentId = outcome.threadId === undefined ? undefined : Number(outcome.threadId);
        outcome.threadId = commentId !== undefined && Number.isFinite(commentId)
          ? byCommentId.get(commentId)
          : undefined;
      }
    }

    const result: SubmitResult = { comments: outcomes, summaryPosted: false };
    const allOk = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
    const summaryToPost = hasSummary(submission.summary) && allOk;

    // The summary is withheld over an incomplete review, but the verdict is
    // not: a request for changes still has to land.
    const needsVerdictReview = event !== 'COMMENT';
    if (summaryToPost || needsVerdictReview) {
      try {
        await this.http.post(`${this.prPath(ref)}/reviews`, {
          event,
          // Withholding the summary must not mean sending no body at all:
          // GitHub rejects a bodiless COMMENT/REQUEST_CHANGES review, which
          // would drop the very verdict this call exists to land.
          body: reviewBody(event, summaryToPost ? submission.summary : undefined),
        });
        if (summaryToPost) result.summaryPosted = true;
        if (event === 'APPROVE') result.approvalApplied = true;
        if (event === 'REQUEST_CHANGES') result.requestChangesApplied = true;
      } catch (e) {
        const error = toScmError(e);
        if (summaryToPost) result.summaryError = error;
        // GitHub refuses to let an author approve or request changes on their
        // own pull request. That is a verdict outcome, never a comment failure.
        if (event === 'APPROVE') result.approvalError = error;
        if (event === 'REQUEST_CHANGES') result.requestChangesError = error;
      }
    }
    return result;
  }

  /**
   * Thread ids for the comments a batched review just created, in the order
   * they were submitted. GitHub returns them from the review's own comments
   * endpoint in creation order, which is the order they were sent.
   */
  private async threadIdsForReview(
    ref: ChangeRequestRef,
    reviewId: number | undefined,
    expected: number,
  ): Promise<Array<string | undefined>> {
    if (reviewId === undefined || expected === 0) return [];
    try {
      const posted = await this.http.getAll<{ id: number }>(
        `${this.prPath(ref)}/reviews/${reviewId}/comments`,
      );
      const byCommentId = await this.threadIdsByCommentId(ref);
      return posted.slice(0, expected).map((comment) => byCommentId.get(comment.id));
    } catch {
      // Degraded, never wrong: an absent thread id makes the panel fall back to
      // "threads you started" rather than matching against a bogus id.
      return [];
    }
  }

  /**
   * Map each posted REST comment id to the GraphQL review-thread id it landed
   * in.
   *
   * `CommentOutcome.threadId` is stored by the app and later compared against
   * what `listThreads` returns (see the invariant on `ThreadFlags` in
   * `app/postedReviews.ts`). On GitHub those are different identifier spaces:
   * posting returns a REST comment id, while threads are GraphQL nodes. Handing
   * back the REST id would store an id that matches nothing, and the Posted
   * reviews panel would show the review with zero threads.
   */
  private async threadIdsByCommentId(ref: ChangeRequestRef): Promise<Map<number, string>> {
    const byCommentId = new Map<number, string>();
    try {
      for (const thread of await this.fetchThreads(ref)) {
        for (const note of thread.comments.nodes) {
          if (note.databaseId != null) byCommentId.set(note.databaseId, thread.id);
        }
      }
    } catch {
      // Best effort: an unresolved id is stored as absent, and the panel falls
      // back to "threads you started" — degraded, never wrong.
    }
    return byCommentId;
  }

  private async fetchThreads(ref: ChangeRequestRef): Promise<GqlThread[]> {
    const { owner, repo } = splitRepoId(ref.repoId);
    const all: GqlThread[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < 10; page += 1) {
      const data: {
        repository?: {
          pullRequest?: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: GqlThread[];
            };
          } | null;
        } | null;
      } = await this.http.graphql(THREADS_QUERY, {
        owner,
        repo,
        number: Number(ref.number),
        cursor,
      });
      const reviewThreads = data.repository?.pullRequest?.reviewThreads;
      if (!reviewThreads) break;
      all.push(...reviewThreads.nodes);
      if (!reviewThreads.pageInfo.hasNextPage) break;
      cursor = reviewThreads.pageInfo.endCursor;
    }
    return all;
  }

  async listThreads(ref: ChangeRequestRef): Promise<ReviewThread[]> {
    return (await this.fetchThreads(ref)).map((node) => toReviewThread(ref, node));
  }

  async resolveThread(_ref: ChangeRequestRef, threadId: string, resolved: boolean): Promise<void> {
    const mutation = resolved ? 'resolveReviewThread' : 'unresolveReviewThread';
    await this.http.graphql(
      `mutation($threadId: ID!) { ${mutation}(input: { threadId: $threadId }) { thread { id isResolved } } }`,
      { threadId },
    );
  }

  async replyToThread(_ref: ChangeRequestRef, threadId: string, body: string): Promise<void> {
    // Thread ids are GraphQL node ids, so the reply goes the same way — a REST
    // reply would need the numeric comment id, which is a different identifier.
    await this.http.graphql(
      `mutation($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment { id }
        }
      }`,
      { threadId, body },
    );
  }

  async approve(ref: ChangeRequestRef): Promise<void> {
    await this.http.post(`${this.prPath(ref)}/reviews`, { event: 'APPROVE' });
  }
}

export function createGitHubProvider(fetchImpl?: FetchLike, now?: () => number): ScmProvider {
  return {
    id: 'github',
    displayName: 'GitHub',
    capabilities: CAPABILITIES,
    vocabulary: VOCABULARY,
    host: HOST,
    /**
     * github.com can use the editor's account; an enterprise host has no such
     * session, so it is token only. One provider, two hosts, different auth —
     * which is why this is a method and not a static list.
     */
    authModesFor(instanceUrl: string): readonly AuthMode[] {
      return isDotCom(instanceUrl) ? ['session', 'token'] : ['token'];
    },
    connect(config: ConnectionConfig): Connection {
      return new GitHubConnection(
        new GitHubHttp(config.instanceUrl, bearerToken(config.credential), fetchImpl, now),
        hostOf(config.instanceUrl),
      );
    },
  };
}

export const githubProvider: ScmProvider = createGitHubProvider();
