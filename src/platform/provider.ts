import type {
  ChangeRequest,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  ConnectionStatus,
  CurrentHeadResult,
  IssueDetailRequest,
  IssueDetailResult,
  ObjectSourceResult,
  ProviderDetailCapabilities,
  Repository,
  ReviewInvestigationCapabilities,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitResult,
  SubmitProgressFn,
  WorkItem,
} from './types';

/**
 * What a platform can do. Feature code checks these flags and degrades —
 * it never branches on a provider id.
 */
export interface ProviderCapabilities {
  /** Applyable suggestion blocks in line comments. */
  suggestions: boolean;
  approvals: boolean;
  requestChanges: boolean;
  threadResolution: boolean;
  /** Groups/orgs that can be expanded into a repository chooser. */
  groupHierarchy: boolean;
  /** Comments can be posted as one review instead of N independent threads. */
  batchedReview: boolean;
  /**
   * What this provider can answer about a change request and a linked issue —
   * the two structured detail reads, with their bounds, reported per operation
   * instead of a provider-id check (design.md D7, `add-agentic-review-harness`).
   *
   * This field used to be `reviewInvestigation` and used to declare seven
   * operations: these two plus the five revision-pinned ones. The five came
   * off every provider when local git became the only investigation source,
   * so what is left here is exactly what a forge is still asked for. A
   * provider that populates this must declare both operations honestly —
   * `supported: false` for a real gap, never a silent omission.
   */
  detailRetrieval?: ProviderDetailCapabilities;
}

/**
 * What one *member* of a review could do, which is not the same as what its
 * provider can do.
 *
 * A provider declares the two detail reads; the member's investigation source
 * declares the five pinned operations. `withSourceInvestigation`
 * (`app/harnessRuntime.ts`) composes them into `reviewInvestigation` once, and
 * the tool dispatcher, the bootstrap tool catalog and the snapshot's capability
 * signature all read that one composed value — so none of the three can
 * disagree about what a member was allowed to do.
 *
 * It extends `ProviderCapabilities` rather than replacing it because posting,
 * approvals, suggestions and thread resolution are still the provider's and are
 * still declared by it; only the investigation half is composed.
 */
export interface MemberCapabilities extends ProviderCapabilities {
  readonly reviewInvestigation?: ReviewInvestigationCapabilities;
}

/**
 * The review-investigation declaration types live in `./types.ts` — they
 * describe an investigation source, which is not a provider at all any more —
 * and are re-exported here so every existing import of them from this module
 * keeps resolving.
 */
export type {
  InvestigationOperationCapability,
  InvestigationPageBound,
  InvestigationSourceCapabilities,
  ProviderDetailCapabilities,
  ReviewInvestigationCapabilities,
} from './types';

/**
 * Platform-correct nouns and ref formatting for the chrome. Logic never
 * reads these; only UI strings do.
 */
export interface Vocabulary {
  /**
   * The platform's own name, for chrome that must name it ("Submit to
   * GitLab", "GitHub rejected the request"). Matches `ScmProvider.displayName`;
   * carried here so a renderer needs one bundle, not two.
   */
  platformName: string;
  /** "merge request" / "pull request" */
  changeRequestNoun: string;
  /**
   * "merge requests" / "pull requests". Explicit rather than `noun + 's'`:
   * English happens to work for today's four words, and encoding that
   * assumption in shared code is what a fifth provider breaks.
   */
  changeRequestNounPlural: string;
  /** "MR" / "PR" */
  changeRequestAbbrev: string;
  /** "project" / "repository" */
  repoNoun: string;
  /** "projects" / "repositories" */
  repoNounPlural: string;
  /** "group" / "organization" / "workspace" */
  groupNoun: string;
  /** "pipeline" / "check" */
  ciNoun: string;
  /** "pipelines" / "checks" */
  ciNounPlural: string;
  /**
   * What the platform calls a `WorkItem` — "issue" today on every provider,
   * "ticket" or "work item" on the trackers a fourth one would speak to. The
   * triage screen names the linked items the agent was given, and that line is
   * chrome like any other.
   */
  workItemNoun: string;
  /** "issues" / "tickets". Explicit for the same reason as the plural above. */
  workItemNounPlural: string;
  /** "!2841" / "#123" */
  formatCrRef(number: string): string;
}

/**
 * Everything onboarding needs to ask this platform's questions: what its host
 * field means, what its credential looks like, and what a source input may be.
 * Onboarding renders these; it never knows which platform it is talking to.
 */
export interface HostDescriptor {
  /** "GitLab instance URL" / "GitHub host". */
  instanceUrlLabel: string;
  /** Prefilled host, e.g. `https://gitlab.com`. */
  defaultInstanceUrl: string;
  /** Token field placeholder, e.g. `glpat-…`. */
  tokenPlaceholder: string;
  /** What the token needs, e.g. "a personal access token with `api` scope". */
  tokenHint: string;
  /** Source-input placeholder for the "add sources" step. */
  sourceInputPlaceholder: string;
  /** One line describing which source inputs are accepted. */
  sourceInputHint: string;
  /** Example chips under the source input. */
  sourceSamples: ReadonlyArray<{ label: string; value: string }>;
  /**
   * For providers that declare the `session` auth mode: the editor's account
   * provider id and the scopes to request. Declared here so the activation
   * code that calls the editor's account API needs no provider knowledge.
   */
  session?: { editorProviderId: string; scopes: readonly string[] };
}

/**
 * Vocabulary for the chrome when no pod is active, so there is no platform to
 * name. These are the neutral contract's own words — the same ones
 * `platform/types.ts` uses — not any platform's.
 */
export const NEUTRAL_VOCABULARY: Vocabulary = {
  platformName: 'your platform',
  changeRequestNoun: 'change request',
  changeRequestNounPlural: 'change requests',
  changeRequestAbbrev: 'CR',
  repoNoun: 'repository',
  repoNounPlural: 'repositories',
  groupNoun: 'group',
  ciNoun: 'run',
  ciNounPlural: 'runs',
  workItemNoun: 'work item',
  workItemNounPlural: 'work items',
  formatCrRef: (number) => `#${number}`,
};

/**
 * How a provider authenticates to a given host. Declared per host because
 * github.com and GitHub Enterprise Server are one provider with different
 * auth available — a static list would force either two provider ids or a lie.
 */
export type AuthMode =
  /** A pasted personal access token, kept in the editor's secret store. */
  | 'token'
  /** A session the editor supplies (e.g. VS Code's built-in GitHub account). */
  | 'session'
  /** No credential at all — demo providers. */
  | 'none';

/**
 * The credential itself. A discriminated union rather than a bare string
 * because recovery differs: a session token can be re-acquired silently after
 * a 401, a personal access token cannot — the user must reconnect. Collapsing
 * them loses the information needed to pick the right recovery.
 */
export type Credential =
  | { kind: 'token'; token: string }
  | { kind: 'session'; accessToken: string }
  | { kind: 'none' };

/**
 * Why this connection exists.
 *
 * Background work runs on a schedule nobody asked for; an interactive
 * connection is serving someone who is waiting. A platform that meters
 * requests may hold a reserve back from the first so the second still gets
 * through — the neutral layer states the intent and never learns what any
 * platform does with it. Providers that meter nothing ignore it.
 */
export type ConnectionIntent = 'interactive' | 'background';

export interface ConnectionConfig {
  instanceUrl: string;
  credential: Credential;
  /** Defaults to `interactive`: unstated intent must never be the cheap one. */
  intent?: ConnectionIntent;
}

/**
 * The secret itself, with no scheme attached, and an empty string when there
 * is none. A personal access token and a host-supplied session token differ
 * only in how they were obtained and how they recover from a 401; what is sent
 * is the same string either way.
 *
 * **The scheme is the caller's, and it is not one scheme per credential.**
 * This function used to be called `bearerToken` and its comment used to say
 * that both kinds "go out as `Authorization: Bearer …`". That was true of the
 * REST clients and false of git: on 2026-09-09 a review stopped because the
 * object-source descriptor had composed `Bearer <token>` for a `git fetch`,
 * and neither GitHub's nor GitLab's git transport accepts a bearer token —
 * GitHub ignores the header and git falls through to askpass. Both are HTTP
 * Basic, with a username each forge decides for itself. The name and the
 * comment are now neutral so that reading either one cannot plant that
 * assumption again; which scheme a given endpoint wants is stated where it is
 * composed, in each provider.
 */
export function credentialSecret(credential: Credential): string {
  switch (credential.kind) {
    case 'token':
      return credential.token;
    case 'session':
      return credential.accessToken;
    case 'none':
      return '';
  }
}

/**
 * An RFC 7617 `Basic` header value.
 *
 * Neutral because HTTP Basic is neutral: the encoding is the RFC's and is the
 * same everywhere. Which username belongs in the pair is not neutral at all —
 * it is a rule of the platform being talked to, differing between forges and,
 * on GitLab, between credential kinds — so it stays a parameter and every
 * caller that fills it in documents where its value comes from.
 */
export function basicAuthorizationHeaderValue(username: string, secret: string): string {
  return `Basic ${Buffer.from(`${username}:${secret}`, 'utf8').toString('base64')}`;
}

export interface ScmProvider {
  /** Stable id stored in pod configuration, e.g. `gitlab`. */
  readonly id: string;
  readonly displayName: string;
  /**
   * False for providers that exist only for demos and tests, so the provider
   * chooser offers real platforms only.
   */
  readonly demo?: boolean;
  readonly capabilities: ProviderCapabilities;
  readonly vocabulary: Vocabulary;
  readonly host: HostDescriptor;
  /**
   * Which credentials work against this host, best first. Onboarding offers
   * only what is returned here.
   */
  authModesFor(instanceUrl: string): readonly AuthMode[];
  connect(config: ConnectionConfig): Connection;
}

/**
 * Everything the product needs from a source-repo platform. List calls are
 * batched per repository — never one request per change request.
 *
 * **What a connection is no longer asked.** It used to extend
 * `Partial<InvestigationOperations>`: the five revision-pinned operations
 * (`listChangedFiles`, `readDiff`, `readFile`, `searchRepository`,
 * `searchDiff`), so a forge could serve a review's evidence when a local
 * object store could not. Every one of those is a computation over two commits
 * whose content the repository already holds, and asking a forge for it is
 * what this product measured going wrong: on a 207-file change GitHub declined
 * to render 137 diffs and returned them in the shape a binary file produces,
 * so two thirds of the change was written off as uninspectable. The rule now
 * is that git answers everything git can answer, and the provider is asked
 * only for what is not in the repository — which is what is left below: which
 * change request exists and where its head points, its title, description and
 * discussion, its labels, reviewers and checks, its linked issues, and posting
 * the review back.
 */
export interface Connection {
  testConnection(): Promise<ConnectionStatus>;

  /** Onboarding source input: full URL, bare numeric id, or "group <id>". */
  resolveSource(input: string): Promise<SourceResolution>;
  listGroupRepositories(groupId: string): Promise<Repository[]>;
  getRepository(repoId: string): Promise<Repository>;

  listOpenChangeRequests(repoIds: readonly string[]): Promise<ChangeRequest[]>;
  listWorkItems(repoIds: readonly string[]): Promise<WorkItem[]>;
  listCiRuns(repoIds: readonly string[], limitPerRepo?: number): Promise<CiRun[]>;

  /**
   * The full diff, fetched in one call. Task 15.8 removed this from the
   * harness's own review path — it fetches diffs itself, in bounded pages,
   * once it has a live `Connection` (`harnessRuntime.ts`), rather than
   * capturing one whole diff up front the way the pre-harness one-shot
   * runners did. Non-harness callers still fetch the whole diff through this
   * method directly: `ui/reviewFlow.ts` (loading the diff for display,
   * checking staleness before a rerun, and re-fetching once more at submit
   * time to anchor against the true current head), `ui/changesetReview.ts`
   * (per-member diff for the changeset triage screen) and `ui/changeset.ts`
   * (assembling every member's diff for the changeset submit/context-usage
   * path). Each provider (`gitlabProvider.ts`, `githubProvider.ts`,
   * `fixtureProvider.ts`) implements it once, unchanged by task 15.8.
   */
  getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff>;

  submitReview(
    ref: ChangeRequestRef,
    submission: ReviewSubmission,
    onProgress?: SubmitProgressFn,
  ): Promise<SubmitResult>;

  listThreads(ref: ChangeRequestRef): Promise<ReviewThread[]>;
  resolveThread(ref: ChangeRequestRef, threadId: string, resolved: boolean): Promise<void>;
  replyToThread(ref: ChangeRequestRef, threadId: string, body: string): Promise<void>;
  approve(ref: ChangeRequestRef): Promise<void>;

  /**
   * The two structured detail reads only a forge can answer (design.md D7),
   * plus the head check. None of the three is a computation over two commits:
   * a change request's title, description, discussion, labels, reviewers and
   * checks live on the platform and nowhere in the repository, a linked issue
   * lives there too, and a bare object id does not even identify the change
   * request they are about. That is why they survived the removal of the five
   * pinned operations from this interface.
   *
   * Optional until a provider's declared `detailRetrieval` capabilities and an
   * implementation land together — the host only calls one of these when the
   * capability that covers it is declared `supported`.
   */
  getChangeRequestDetails?(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult>;
  getIssueDetails?(request: IssueDetailRequest): Promise<IssueDetailResult>;
  /** Used only for the pre-completion head check (D3); never substitutes for `getChangeRequestDiff`'s own `headSha`. */
  getCurrentHead?(ref: ChangeRequestRef): Promise<CurrentHeadResult>;

  /**
   * Where the investigation source obtains this repository's objects, or a
   * stated reason there is none (`add-local-git-investigation` design.md
   * D2/D8, task 2.3).
   *
   * Takes the change-request ref, not just the repository, because the two
   * ref hints in the descriptor are composed from the change request itself:
   * the head ref for a force-pushed head no branch reaches, and the target
   * branch the merge base is computed against. Composing them is the
   * provider's job and stays inside the provider; the descriptor that comes
   * back says nothing about which platform produced it.
   *
   * **No longer optional in effect, even though the signature keeps the `?`.**
   * A provider that cannot produce a descriptor leaves the review with no way
   * to read the change at all: there is no forge fallback behind this any
   * more, so the attempt refuses with that reason rather than degrading. The
   * `?` stays only because a `Connection` implementation may legitimately
   * predate the operation.
   */
  getObjectSource?(ref: ChangeRequestRef): Promise<ObjectSourceResult>;
}
