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
  /** "merge request" / "pull request" */
  changeRequestNoun: string;
  /** "MR" / "PR" */
  changeRequestAbbrev: string;
  /** "project" / "repository" */
  repoNoun: string;
  /** "group" / "organization" / "workspace" */
  groupNoun: string;
  /** "pipeline" / "check" */
  ciNoun: string;
  /** "!2841" / "#123" */
  formatCrRef(number: string): string;
}

export interface ConnectionConfig {
  instanceUrl: string;
  token: string;
}

export interface ScmProvider {
  /** Stable id stored in pod configuration, e.g. `gitlab`. */
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  readonly vocabulary: Vocabulary;
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

  submitReview(ref: ChangeRequestRef, submission: ReviewSubmission): Promise<SubmitResult>;

  listThreads(ref: ChangeRequestRef): Promise<ReviewThread[]>;
  resolveThread(ref: ChangeRequestRef, threadId: string, resolved: boolean): Promise<void>;
  replyToThread(ref: ChangeRequestRef, threadId: string, body: string): Promise<void>;
  approve(ref: ChangeRequestRef): Promise<void>;
}
