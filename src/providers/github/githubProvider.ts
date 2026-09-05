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
  DiffAnchor,
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
  ReviewCommentDraft,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitProgressFn,
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { ScmError, toScmError } from '../../platform/errors';
import type { FetchLike } from './http';
import { EtagCache, GitHubHttp, RateBudget, hostOf, isDotCom, splitRepoId } from './http';
import { parseGitHubSourceInput } from './sourceInput';
import { isVerdictRefused } from './errors';
import {
  isBinaryCompareFile,
  isRealIssue,
  isTooLargeCompareFile,
  linesFromUnifiedDiff,
  toCiSummary,
  toChangedFileEntry,
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
  type GhContentFile,
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

/** Declared review-investigation page bounds (design.md D7, task 4.6) — self-imposed, since GitHub returns each of these payloads in one call rather than paginating them itself. */
const INVESTIGATION_MANIFEST_PAGE = 100;
const INVESTIGATION_DIFF_LINE_PAGE = 200;
const INVESTIGATION_FILE_LINE_PAGE = 200;
/** Compare caps `files` at 300 for the whole comparison (GitHub docs) — reaching it means the manifest cannot be proven complete. */
const GITHUB_COMPARE_FILES_CAP = 300;

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
  // D7/task 4.6: manifest/diff/diff-search read the Compare API
  // (`/compare/{base}...{head}`, snapshot-only — no pull-request number
  // needed, mirroring the GitLab provider's identical reasoning for using its
  // own Compare API instead of an MR/PR-scoped diff endpoint). Repository
  // search is NOT revision-pinnable on GitHub: `/search/code` only indexes
  // each repository's default branch and takes no ref/commit parameter at all
  // (docs.github.com/en/rest/search/search#search-code, "Only the default
  // branch is considered") — declared `supported: false` rather than
  // silently searching the wrong revision.
  reviewInvestigation: {
    manifests: { supported: true, pageBound: { maxPageSize: INVESTIGATION_MANIFEST_PAGE } },
    diffReads: { supported: true, pageBound: { maxPageSize: INVESTIGATION_DIFF_LINE_PAGE } },
    fileReads: { supported: true, pageBound: { maxPageSize: INVESTIGATION_FILE_LINE_PAGE } },
    repositorySearch: { supported: false },
    diffSearch: { supported: true },
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

/** In-memory pagination over an already-fully-fetched array — Compare/contents return their payload in one call; the cursor is host-defined and never inspected by GitHub. */
function paginateArray<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { page: readonly T[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  return { page: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

/** GitHub's contents API takes a literal multi-segment path, unlike GitLab's single opaque path parameter — each segment is encoded, but the separating slashes are not. */
function encodePathSegments(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

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

  // ---- review-investigation operations (design.md D7, task 4.6) -----------
  //
  // `listChangedFiles`/`readDiff`/`searchDiff` all read the Compare API
  // (`GET /repos/{owner}/{repo}/compare/{base}...{head}`), not
  // `/pulls/{n}/files`: every neutral request type here carries only
  // `snapshot` (repoId+baseSha+headSha), never the pull-request number, and
  // only Compare is revision-scoped rather than PR-scoped — the identical
  // structural reasoning the GitLab provider already documents for choosing
  // its own Compare API over an MR-scoped diff endpoint. A 404 from Compare
  // always means the revision pair itself does not resolve (Compare has no
  // path parameter to get wrong), so it maps directly to `unavailable`.

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

  async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    const files = compared.files ?? [];
    const bound =
      CAPABILITIES.reviewInvestigation!.manifests.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const { page, nextCursor } = paginateArray(files.map(toChangedFileEntry), request.cursor, bound);
    if (nextCursor) return { snapshot, state: 'paginated', value: page, cursor: nextCursor };
    // Compare shows `files` only on its first page and caps it at 300 for the
    // whole comparison — at exactly the cap a 301st file cannot be ruled out.
    if (files.length >= GITHUB_COMPARE_FILES_CAP) return { snapshot, state: 'truncated', value: page };
    return { snapshot, state: 'complete', value: page };
  }

  async readDiff(request: DiffPageRequest): Promise<DiffPageResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    const file = (compared.files ?? []).find((f) => f.filename === request.path || f.previous_filename === request.path);
    if (!file) return { snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
    if (isBinaryCompareFile(file)) return { snapshot, state: 'binary' };
    if (isTooLargeCompareFile(file)) return { snapshot, state: 'tooLarge' };
    const bound =
      CAPABILITIES.reviewInvestigation!.diffReads.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const { page, nextCursor } = paginateArray((file.patch ?? '').split('\n'), request.cursor, bound);
    const value: DiffPage = {
      path: file.filename,
      oldPath: file.status === 'renamed' ? file.previous_filename : undefined,
      isRenamed: file.status === 'renamed',
      patch: page.join('\n'),
      positions: [],
    };
    if (nextCursor) return { snapshot, state: 'paginated', value, cursor: nextCursor };
    return { snapshot, state: 'complete', value };
  }

  async readFile(request: FileRangeRequest): Promise<FileRangeResult> {
    const { snapshot } = request;
    const revisionSha = request.revision === 'base' ? snapshot.baseSha : snapshot.headSha;
    let content: GhContentFile | GhContentFile[];
    try {
      content = await this.http.get<GhContentFile | GhContentFile[]>(
        `${this.repoPath(snapshot.repoId)}/contents/${encodePathSegments(request.path)}`,
        { ref: revisionSha },
      );
    } catch (e) {
      if (toScmError(e).kind === 'notFound') {
        const message = e instanceof Error ? e.message : '';
        // Disclosed, moderate confidence: GitHub's contents endpoint is not
        // documented to distinguish a bad ref from a bad path in its 404
        // message, but a bad ref is commonly observed to read "No commit
        // found for the ref …" — the same message-sniffing technique the
        // GitLab provider uses for its own revision-vs-path disambiguation.
        return /no commit found for the ref/i.test(message)
          ? { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${revisionSha}` }
          : { snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
      }
      throw e;
    }
    if (Array.isArray(content) || content.type !== 'file') {
      return { snapshot, state: 'notFound', reason: `Not a file: ${request.path}` };
    }
    // GitHub withholds `content` once a file exceeds 1 MB under the default JSON media type (`encoding: 'none'`) — its own signal, not a locally imposed cap.
    if (content.encoding !== 'base64' || content.content === undefined) {
      return { snapshot, state: 'tooLarge', byteSize: content.size };
    }
    const decoded = Buffer.from(content.content, 'base64');
    if (decoded.includes(0)) return { snapshot, state: 'binary', byteSize: content.size };
    const lines = decoded.toString('utf8').split('\n');
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

  async searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult> {
    const { snapshot } = request;
    const compared = await this.compare(snapshot.repoId, snapshot.baseSha, snapshot.headSha);
    if (!compared) {
      return { snapshot, state: 'unavailable', reason: `Unresolvable revision: ${snapshot.baseSha}..${snapshot.headSha}` };
    }
    const files = compared.files ?? [];
    // A comparison capped at the platform's file limit cannot be claimed exhaustively searchable.
    if (files.length >= GITHUB_COMPARE_FILES_CAP) {
      return { snapshot, state: 'unknown', reason: 'Comparison exceeds the platform file cap and cannot be exhaustively searched' };
    }
    const value: DiffSearchMatch[] = [];
    for (const file of files) {
      if (isBinaryCompareFile(file) || isTooLargeCompareFile(file)) continue;
      if (request.pathScope && !file.filename.startsWith(request.pathScope)) continue;
      linesFromUnifiedDiff(file.patch ?? '').forEach((line, index) => {
        if (line.includes(request.query)) {
          value.push({ position: { path: file.filename, side: 'new', line: index + 1 }, excerpt: line.trim() });
        }
      });
    }
    return { snapshot, state: 'complete', value };
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

  async getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff> {
    const pull = await this.http.get<GhPull>(this.prPath(ref));
    const files = await this.http.getAll<GhFile>(`${this.prPath(ref)}/files`);
    return {
      ref,
      baseSha: pull.base.sha,
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
        new GitHubHttp(config.instanceUrl, bearerToken(config.credential), fetchImpl, now, etags, {
          budget,
          intent: config.intent,
        }),
        hostOf(config.instanceUrl),
      );
    },
  };
}

export const githubProvider: ScmProvider = createGitHubProvider();
