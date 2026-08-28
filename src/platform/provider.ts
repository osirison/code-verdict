import type {
  ChangeRequest,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  ConnectionStatus,
  Repository,
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
}

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
 * The bearer value for a credential. Both a personal access token and a
 * host-supplied session token go out as `Authorization: Bearer …`; only how
 * they were obtained, and how they recover from a 401, differ.
 */
export function bearerToken(credential: Credential): string {
  switch (credential.kind) {
    case 'token':
      return credential.token;
    case 'session':
      return credential.accessToken;
    case 'none':
      return '';
  }
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
}
