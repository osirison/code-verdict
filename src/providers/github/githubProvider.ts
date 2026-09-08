/**
 * The GitHub provider: REST for everything except what only GraphQL can do
 * (review-thread resolution and outdated state). See docs/ARCHITECTURE.md.
 */
import type {
  AuthMode,
  Connection,
  ConnectionConfig,
  Credential,
  HostDescriptor,
  ProviderCapabilities,
  ScmProvider,
  Vocabulary,
} from '../../platform/provider';
import { basicAuthorizationHeaderValue, credentialSecret } from '../../platform/provider';
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
  DiffAnchor,
  IssueDetailRequest,
  IssueDetailResult,
  ObjectSourceResult,
  Repository,
  ReviewCommentDraft,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitProgressFn,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { isFetchableObjectSourceUrl } from '../../platform/types';
import { ScmError, toScmError } from '../../platform/errors';
import type { FetchLike } from './http';
import { EtagCache, GitHubHttp, RateBudget, hostOf, isDotCom, splitRepoId } from './http';
import { parseGitHubSourceInput } from './sourceInput';
import { isVerdictRefused } from './errors';
import {
  isRealIssue,
  toCiSummary,
  toChangeRequest,
  toCheckSummariesFromRollup,
  toCiRun,
  toFileDiff,
  toNormalizedDetail,
  toNormalizedDetailFromIssue,
  toRepoGroup,
  toRepository,
  toReviewThread,
  toThreadNoteFromIssueComment,
  toWorkItem,
  type GhCompareResult,
  type GhFile,
  type GhIssue,
  type GhIssueComment,
  type GhOrg,
  type GhPull,
  type GhPullCommit,
  type GhRepo,
  type GhWorkflowRun,
  type GqlChecksResponse,
  type GqlRollup,
  type GqlThread,
  type CiSummary,
} from './mappers';

/** The declared page bound for detail retrieval — self-imposed, since GitHub returns a pull request's detail in one call rather than paginating it. */
const INVESTIGATION_MANIFEST_PAGE = 100;

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
  // D7: the two detail reads, and nothing else. This declaration used to carry
  // five more — manifests, diff reads, file reads, repository search and diff
  // search — all read from the Compare API. They are gone, because this
  // provider is no longer an investigation source at all: everything answerable
  // from two commits is answered by git, locally, and what the Compare API
  // actually answered for a 207-file change was 137 files it declined to render
  // in the byte-identical shape a binary file produces. Repository search was
  // already declared `supported: false` here — `/search/code` indexes only a
  // repository's default branch and takes no ref — which is the same gap from
  // the other end: a forge cannot answer a revision-pinned question about the
  // repository's own content.
  detailRetrieval: {
    changeRequestDetails: { supported: true },
    issueDetails: { supported: true },
    pagination: { maxPageSize: INVESTIGATION_MANIFEST_PAGE },
  },
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
  workItemNoun: 'issue',
  workItemNounPlural: 'issues',
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
  const reported = asVerdictError(error);
  if (event === 'APPROVE') return { approvalApplied: false, approvalError: reported };
  if (event === 'REQUEST_CHANGES') return { requestChangesApplied: false, requestChangesError: reported };
  return {};
}

/**
 * A refusal is terminal, so it must not reach the caller as a generic 422 they
 * will retry forever. Anything else passes through unchanged.
 */
function asVerdictError(error: ScmError): ScmError {
  return isVerdictRefused(error)
    ? new ScmError('verdictRefused', error.message, { status: error.status })
    : error;
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

/** The same rollup shape as `CHECKS_QUERY`, scoped to one pull request — used by `getChangeRequestDetails` (task 4.6), which needs every check, not just the one worth linking to. */
const PR_ROLLUP_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              state
              contexts(first: 20) {
                nodes {
                  __typename
                  ... on CheckRun { databaseId name conclusion status permalink summary }
                  ... on StatusContext { context state targetUrl description }
                }
              }
            }
          }
        }
      }
    }
  }
}`;




/**
 * The username GitHub wants in the Basic pair for git over HTTPS. The token is
 * the password half; this is the other one, and it is a fixed sentinel rather
 * than anybody's login.
 */
const GIT_HTTPS_USERNAME = 'x-access-token';

/**
 * The complete `Authorization` value a `git fetch` against this connection's
 * repository should carry, or `undefined` when there is no credential to send.
 *
 * **The live failure this replaces.** Until 2026-09-09 this composed
 * `Bearer ${token}`, the same scheme `http.ts` uses for the REST API. A review
 * of `osirison/code-verdict!66` stopped with "A local object store could not
 * serve this change (The object source would not authorize this fetch with the
 * credential this connection has for it.)": GitHub's git-over-HTTPS smart
 * protocol does not accept a bearer token, so it ignored the header, git fell
 * through to askpass, and prompting is disabled by design D7 — the fetch died
 * at the challenge without ever asking for an object.
 *
 * **Measured, 2026-09-09**, against `https://github.com/osirison/code-verdict.git`
 * with a real `gho_` token, fetching a bare commit id with the value supplied
 * as `http.extraHeader` exactly as the invocation supplies it:
 *
 *     Authorization: Bearer <token>                        -> exit 128, askpass fallthrough
 *     Authorization: Basic base64("x-access-token:<token>") -> exit 0, fetch succeeds
 *     Authorization: Basic base64("<token>:x-oauth-basic")  -> exit 0, fetch succeeds
 *
 * **Why the first of the two working forms.** It is the one GitHub documents
 * for HTTPS git access — `git clone https://x-access-token:TOKEN@github.com/owner/repo.git`
 * (docs.github.com, "Authenticating as a GitHub App installation", read
 * 2026-09-11) — while `x-oauth-basic` is the older OAuth-only spelling. And it
 * puts the secret in the password half of the pair: the username half is the
 * half that gets echoed into diagnostics and proxy logs when a `user@host` URL
 * is reconstructed anywhere, and a secret is better off in the half nothing
 * treats as a name.
 *
 * Both credential kinds send the same form. GitHub authenticates a personal
 * access token and an editor session token identically here; only how they were
 * obtained and how they recover from a 401 differ, which is the distinction
 * `Credential` exists for and not one this header knows about.
 *
 * A connection with no credential gets no header at all, rather than one with
 * an empty token in it: `Basic base64("x-access-token:")` is a credential a
 * remote can reject in its own way, and "no credential" must be
 * indistinguishable from never having been asked for one.
 */
function gitAuthorizationHeaderValue(credential: Credential): string | undefined {
  const secret = credentialSecret(credential);
  return secret === '' ? undefined : basicAuthorizationHeaderValue(GIT_HTTPS_USERNAME, secret);
}

export class GitHubConnection implements Connection {
  constructor(
    private readonly http: GitHubHttp,
    /** The connected instance's host, for validating pasted source URLs. */
    private readonly instanceHost: string,
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

  private repoPath(repoId: string): string {
    const { owner, repo } = splitRepoId(repoId);
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  private prPath(ref: ChangeRequestRef): string {
    return `${this.repoPath(ref.repoId)}/pulls/${encodeURIComponent(ref.number)}`;
  }

  // ---- the Compare API, for the merge base only ---------------------------
  //
  // `GET /repos/{owner}/{repo}/compare/{base}...{head}` used to back five
  // review-investigation operations here. All five are gone; what is left is
  // `getChangeRequestDiff`'s read of `merge_base_commit.sha`, which is a
  // scalar field the response carries regardless of how much of its file list
  // it truncated. The truncation is exactly why the file list is no longer
  // read: on the measured 207-file change this endpoint returned 137 ordinary
  // TypeScript files with `patch` absent and every count zero.

  private async compare(repoId: string, baseSha: string, headSha: string): Promise<GhCompareResult | undefined> {
    try {
      return await this.http.get<GhCompareResult>(
        `${this.repoPath(repoId)}/compare/${encodeURIComponent(baseSha)}...${encodeURIComponent(headSha)}`,
      );
    } catch (e) {
      if (toScmError(e).kind === 'notFound') return undefined;
      throw e;
    }
  }

  private async checkRollupForPull(ref: ChangeRequestRef): Promise<GqlRollup | null | undefined> {
    const { owner, repo } = splitRepoId(ref.repoId);
    try {
      const data = await this.http.graphql<{
        repository?: {
          pullRequest?: { commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: GqlRollup | null } } | null> } } | null;
        } | null;
      }>(PR_ROLLUP_QUERY, { owner, repo, number: Number(ref.number) });
      return data.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
    } catch {
      // Checks are decoration on the detail; a repository whose checks cannot be read must still return the rest.
      return undefined;
    }
  }

  async getChangeRequestDetails(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> {
    const { snapshot } = request;
    const ref: ChangeRequestRef = { repoId: snapshot.repoId, number: request.number };
    let pull: GhPull;
    try {
      pull = await this.http.get<GhPull>(this.prPath(ref));
    } catch (e) {
      if (toScmError(e).kind === 'notFound') {
        return { snapshot, state: 'notFound', reason: `No such change request: ${request.number}` };
      }
      throw e;
    }
    const [commits, threads, rollup] = await Promise.all([
      this.http.getAll<GhPullCommit>(`${this.prPath(ref)}/commits`),
      this.fetchThreads(ref),
      this.checkRollupForPull(ref),
    ]);
    const discussion = threads.flatMap((thread) => toReviewThread(ref, thread).notes);
    return {
      snapshot,
      state: 'complete',
      value: toNormalizedDetail(pull, commits, discussion, toCheckSummariesFromRollup(rollup)),
    };
  }

  async getIssueDetails(request: IssueDetailRequest): Promise<IssueDetailResult> {
    const { snapshot } = request;
    const issuePath = `${this.repoPath(request.issueRepoId)}/issues/${encodeURIComponent(request.issueNumber)}`;
    let issue: GhIssue;
    try {
      issue = await this.http.get<GhIssue>(issuePath);
    } catch (e) {
      if (toScmError(e).kind === 'notFound') {
        return { snapshot, state: 'notFound', reason: `No such issue: ${request.issueRepoId}#${request.issueNumber}` };
      }
      throw e;
    }
    const comments = await this.http.getAll<GhIssueComment>(`${issuePath}/comments`);
    return { snapshot, state: 'complete', value: toNormalizedDetailFromIssue(issue, comments.map(toThreadNoteFromIssueComment)) };
  }

  async getCurrentHead(ref: ChangeRequestRef): Promise<CurrentHeadResult> {
    try {
      const pull = await this.http.get<GhPull>(this.prPath(ref));
      return { repoId: ref.repoId, state: 'resolved', headSha: pull.head.sha };
    } catch (e) {
      if (toScmError(e).kind === 'notFound') return { repoId: ref.repoId, state: 'notFound' };
      throw e;
    }
  }

  /**
   * Where a source that computes diffs itself may fetch this repository's git
   * objects (`add-local-git-investigation` design.md D2/D8, task 2.4).
   *
   * The location comes from GitHub's own `clone_url` rather than being
   * composed from the host and the repository id. Composing it would be a
   * guess that happens to be right today for both github.com and an
   * enterprise host, and a guess about where to send a credential is not one
   * worth making; `html_url` + `.git` is the fallback for a response that
   * omits the field, which is the same value by GitHub's own construction.
   * The request is a conditional GET like every other, so repeating it across
   * members of one changeset costs nothing against the rate limit.
   *
   * The ref hint is `refs/pull/{n}/head`: the ref GitHub keeps for a pull
   * request's head even after a force-push leaves that commit unreachable
   * from any branch. Composing it is this provider's job and it stays here —
   * the descriptor hands it over as an opaque string, and nothing above the
   * provider boundary learns that such a ref exists (design.md D8).
   *
   * Every failure answers `unavailable` rather than throwing: the caller's
   * question is "can objects be obtained", and the answer to no is that this
   * repository cannot be reviewed and the reason says why. There is no forge
   * fallback behind it any more — this provider serves no investigation — so
   * an unavailable descriptor ends the attempt rather than routing it
   * somewhere else. The reason names the neutral error kind only, never
   * GitHub's own message, which is a channel a credential could ride out on.
   */
  async getObjectSource(ref: ChangeRequestRef): Promise<ObjectSourceResult> {
    let repo: GhRepo;
    try {
      repo = await this.http.get<GhRepo>(this.repoPath(ref.repoId));
    } catch (e) {
      return { state: 'unavailable', reason: `The repository's object location could not be read (${toScmError(e).kind}).` };
    }
    const fetchUrl = repo.clone_url ?? `${repo.html_url}.git`;
    if (!isFetchableObjectSourceUrl(fetchUrl)) {
      return { state: 'unavailable', reason: 'The repository reports no ordinary HTTP or HTTPS clone location.' };
    }
    // The branch this pull request targets, which is what the merge base is
    // computed against locally. It is a fact about the pull request and lives
    // nowhere in the repository's own objects, so it is exactly the kind of
    // thing this connection is still asked for — and one request answers it,
    // against the endpoint that already exists here.
    let target: string | undefined;
    try {
      target = (await this.http.get<GhPull>(this.prPath(ref))).base.ref;
    } catch {
      // Left absent rather than guessed. A default-branch fallback would look
      // right almost always and quietly review the wrong pair of commits for a
      // pull request that targets a release branch.
      target = undefined;
    }
    const authorization = gitAuthorizationHeaderValue(this.credential);
    return {
      state: 'available',
      descriptor: {
        fetchUrl,
        ...(authorization === undefined ? {} : { authorizationHeaderValue: authorization }),
        refHint: `refs/pull/${ref.number}/head`,
        ...(target === undefined ? {} : { mergeTargetRef: `refs/heads/${target}` }),
      },
    };
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

  /**
   * One request per repository, whatever the run count.
   *
   * The REST check-runs endpoint is per-ref, so reading checks this way cost
   * a commit list plus one request per commit — 21 requests per repository on
   * the old default — and the 60s notifier poll spent the hourly budget on it.
   * `/actions/runs` is the repository-wide list: newest first, every branch,
   * exactly what GitLab's `/pipelines` returns and what the neutral `CiRun`
   * already calls "a CI pipeline / workflow run".
   *
   * What that costs, stated plainly: this now reports Actions runs only. A
   * repository whose checks come from a third-party integration alone reports
   * none where the per-commit version reported that integration's check runs.
   * The alternative — a GraphQL walk of the default branch's `checkSuites` —
   * is also one request but covers one branch, and its payload could not be
   * captured live for the fake the way this one was.
   *
   * `limitPerRepo` defaults to 3, matching every other implementation and the
   * only caller (`fetchPodData`); 20 was a per-repository default nothing
   * asked for.
   */
  async listCiRuns(repoIds: readonly string[], limitPerRepo = 3): Promise<CiRun[]> {
    const perRepo = await Promise.all(
      repoIds.map(async (repoId) => {
        try {
          const payload = await this.http.get<{ workflow_runs?: GhWorkflowRun[] }>(
            `${this.repoPath(repoId)}/actions/runs`,
            { per_page: limitPerRepo },
          );
          return (payload.workflow_runs ?? []).map((run) => toCiRun(repoId, run));
        } catch {
          // CI is decoration on the dashboard, and Actions can be disabled per
          // repository (or instance-wide on GHES) — one repository that cannot
          // answer must not empty the pod's whole run list.
          return [] as CiRun[];
        }
      }),
    );
    return perRepo.flat();
  }

  /**
   * `baseSha` is the merge base, and getting it costs the third request below
   * (`add-local-git-investigation` task 5.1, design.md D4).
   *
   * It used to be `pull.base.sha`, which is the *current tip of the target
   * branch*. A commit landing on `main` while a review is in flight silently
   * changed what "base" meant for that review: a resumed attempt compared
   * against a different commit than the one it started from, and evidence
   * already cited was relabelled as evidence against a pair of commits it was
   * never computed over. The merge base does not move unless the change
   * request itself is rebased.
   *
   * The file list below never had this problem — `/pulls/{n}/files` has always
   * returned the merge-base-to-head diff. Only the reported base disagreed
   * with the files it was supposed to describe.
   *
   * `GET /pulls/{n}` carries no merge base at all, so this reads the Compare
   * API through the same private helper the investigation operations use. One
   * added request per call; the response is a 304 from the second call onward
   * (`GitHubHttp` sends every GET conditionally), which GitHub does not charge
   * against the rate limit.
   *
   * A comparison that does not resolve, or resolves without a merge base,
   * throws. Falling back to `pull.base.sha` would be the original defect with
   * a new name — a target-branch tip reported as a merge base, undetectably.
   */
  async getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff> {
    const pull = await this.http.get<GhPull>(this.prPath(ref));
    const files = await this.http.getAll<GhFile>(`${this.prPath(ref)}/files`);
    const compared = await this.compare(ref.repoId, pull.base.sha, pull.head.sha);
    if (!compared) {
      throw new ScmError('notFound', `Cannot determine the base revision: comparing ${pull.base.sha}...${pull.head.sha} in ${ref.repoId} resolved to nothing.`);
    }
    const mergeBase = compared.merge_base_commit?.sha;
    if (mergeBase === undefined || mergeBase === '') {
      throw new ScmError('unknown', `Cannot determine the base revision: the comparison of ${pull.base.sha}...${pull.head.sha} in ${ref.repoId} carried no merge base.`);
    }
    return {
      ref,
      baseSha: mergeBase,
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
  async submitReview(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    onProgress?: SubmitProgressFn,
  ): Promise<SubmitResult> {
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
    // Announced once, here, rather than in each path: the batch may reject and
    // hand over to the per-comment fallback, and two openings both claiming
    // "0 of N" read as a stall rather than a start.
    onProgress?.({ stage: 'comments', posted: 0, total: submission.comments.length });

    if (event === 'COMMENT' && !hasSummary(submission.summary)) {
      return this.submitCommentByComment(ref, submission, event, onProgress);
    }

    try {
      return await this.submitAsOneReview(ref, submission, event, onProgress);
    } catch (e) {
      const error = toScmError(e);
      // GitHub refused the verdict, not the review — an author cannot approve
      // or request changes on their own pull request. The comments and the
      // summary are still valid, so re-send the identical review as a plain
      // COMMENT and report the verdict through its own field. Throwing here
      // would lose the whole review to a refusal of one field (task 5.7).
      if (isVerdictRefused(error)) {
        return { ...(await this.submitDowngraded(ref, submission, onProgress)), ...verdictFailure(event, error) };
      }
      if (error.kind !== 'staleAnchor') throw error;
      return this.submitCommentByComment(ref, submission, event, onProgress);
    }
  }

  /**
   * The review minus its refused verdict. It needs the same stale-anchor
   * fallback the primary path has: a submission can carry both a refused
   * verdict and a moved line, and without this the second 422 escapes
   * `submitReview` and loses everything the downgrade exists to save.
   */
  private async submitDowngraded(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    onProgress?: SubmitProgressFn,
  ): Promise<SubmitResult> {
    // A bodiless COMMENT review is itself a 422, so a submission with no
    // summary posts its comments standalone instead.
    if (!hasSummary(submission.summary)) {
      return this.submitCommentByComment(ref, submission, 'COMMENT', onProgress);
    }
    try {
      return await this.submitAsOneReview(ref, submission, 'COMMENT', onProgress);
    } catch (e) {
      const error = toScmError(e);
      // Anything else means nothing was posted, so this throws and the caller
      // keeps its draft to retry. Returning the refusal instead would report an
      // empty submit as a success, and would carry *this* error rather than the
      // refusal anyway — `asVerdictError` rewrites only refusals.
      if (error.kind !== 'staleAnchor') throw error;
      return this.submitCommentByComment(ref, submission, 'COMMENT', onProgress);
    }
  }

  private async submitAsOneReview(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    event: ReviewEvent,
    _onProgress?: SubmitProgressFn,
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
      // Only a review that actually carried comments is one. A verdict-only
      // review — what a retry sends once the comments already landed — says
      // nothing about how they were posted.
      postedAsSingleReview: submission.comments.length > 0 ? true : undefined,
    };
  }

  private async submitCommentByComment(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    event: ReviewEvent,
    onProgress?: SubmitProgressFn,
  ): Promise<SubmitResult> {
    const outcomes: CommentOutcome[] = [];
    let abort: ScmError | undefined;
    // This is the slow path — one round trip per comment — so it is the one
    // that reports where it has got to. The opening 0/N came from
    // submitReview, which cannot know yet whether this path will be taken.
    const total = submission.comments.length;

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
      onProgress?.({ stage: 'comments', posted: outcomes.length, total });
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

    const result: SubmitResult = {
      comments: outcomes,
      summaryPosted: false,
      // Whatever else happens below, these comments were posted one at a time.
      postedAsSingleReview: outcomes.length > 0 ? false : undefined,
    };
    const allOk = outcomes.length > 0 && outcomes.every((outcome) => outcome.ok);
    const summaryToPost = hasSummary(submission.summary) && allOk;

    // The summary is withheld over an incomplete review, but the verdict is
    // not: a request for changes still has to land.
    const needsVerdictReview = event !== 'COMMENT';
    if (summaryToPost || needsVerdictReview) {
      onProgress?.({ stage: needsVerdictReview ? 'verdict' : 'summary', posted: 0, total: 0 });
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
        Object.assign(result, verdictFailure(event, error));
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
    try {
      await this.http.post(`${this.prPath(ref)}/reviews`, { event: 'APPROVE' });
    } catch (e) {
      // Same refusal `submitReview` already classifies — an author cannot
      // approve their own pull request. Left as a bare 422 it reached the UI
      // as a generic error, which is not what it is.
      throw asVerdictError(toScmError(e));
    }
  }
}

export function createGitHubProvider(fetchImpl?: FetchLike, now?: () => number): ScmProvider {
  // Both of these live here, not inside the client, because `connectionForPod`
  // builds a fresh `Connection` for every notifier poll (src/app/connections.ts).
  // State owned by `GitHubHttp` would therefore be empty every 60 seconds:
  // the etag cache cold on exactly the poll a 304 exists to make free, and the
  // observed rate budget re-learned from zero on every poll, which is why
  // `rateState` could be parsed on every response and still stop nothing. The
  // provider is the longest-lived object that is still provider-scoped, so
  // both outlive the connections without the app layer learning that GitHub
  // charges differently for a 304 or meters anything at all.
  const etags = new EtagCache();
  const budget = new RateBudget();
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
        new GitHubHttp(config.instanceUrl, credentialSecret(config.credential), fetchImpl, now, etags, {
          budget,
          intent: config.intent,
        }),
        hostOf(config.instanceUrl),
        config.credential,
      );
    },
  };
}

export const githubProvider: ScmProvider = createGitHubProvider();
