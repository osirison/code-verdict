/**
 * A minimal, fully-conforming fake `Connection` that declares
 * `reviewInvestigation` capabilities, so the reusable manifest pagination,
 * immutable revision, range bound, binary, truncation, empty-complete,
 * unavailable capability, detail normalization, search, and rate-limit
 * conformance cases in `providerContract.ts` (tasks 3.6/3.7) actually run and
 * pass at least once, instead of staying dead code until section 4 wires a
 * real provider.
 */
import { ScmError } from '../errors';
import type {
  Connection,
  ProviderCapabilities,
} from '../provider';
import type {
  ChangeRequest,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  ConnectionStatus,
  FileRangeRequest,
  FileRangeResult,
  IssueDetailRequest,
  IssueDetailResult,
  Repository,
  RepositorySearchRequest,
  RepositorySearchResult,
  ReviewSubmission,
  ReviewThread,
  SourceResolution,
  SubmitResult,
  WorkItem,
} from '../types';
import { describeProviderContract, type ProviderContractHarness } from './providerContract';

const REPO_ID = 'inv-repo';
const CR_REF: ChangeRequestRef = { repoId: REPO_ID, number: '1' };
const HEAD_SHA = 'head-1';
const BASE_SHA = 'base-1';
const CHANGED_FILE = 'src/a.ts';
const BINARY_FILE = 'assets/logo.png';
const PRIOR_REVISION = { baseSha: 'base-0', headSha: 'head-0' };
const FILE_LINES = ['export function a() {', '  // TODO: refine', '  return 1;', '}', '', '// trailing'];
const PRIOR_FILE_LINES = ['export function a() {', '  return 0;', '}'];
const FILE_READ_BOUND = 5;

const CAPABILITIES: ProviderCapabilities = {
  suggestions: false,
  approvals: false,
  requestChanges: false,
  threadResolution: false,
  groupHierarchy: false,
  batchedReview: false,
  reviewInvestigation: {
    manifests: { supported: true },
    diffReads: { supported: false },
    fileReads: { supported: true, pageBound: { maxPageSize: FILE_READ_BOUND } },
    repositorySearch: { supported: true },
    diffSearch: { supported: false },
    changeRequestDetails: { supported: true },
    issueDetails: { supported: false },
    pagination: { maxPageSize: 100 },
  },
};

function baseConnectionMethods(): Pick<
  Connection,
  | 'testConnection'
  | 'resolveSource'
  | 'listGroupRepositories'
  | 'getRepository'
  | 'listOpenChangeRequests'
  | 'listWorkItems'
  | 'listCiRuns'
  | 'getChangeRequestDiff'
  | 'submitReview'
  | 'listThreads'
  | 'resolveThread'
  | 'replyToThread'
  | 'approve'
> {
  return {
    async testConnection(): Promise<ConnectionStatus> {
      return { ok: true, username: 'inv-user' };
    },
    async resolveSource(input: string): Promise<SourceResolution> {
      if (input === 'inv/repo') {
        return { kind: 'repository', repo: { id: REPO_ID, path: 'inv/repo', name: 'repo', webUrl: 'https://inv.invalid/repo' } };
      }
      if (input === '999999') return { kind: 'notVisible', id: input };
      return { kind: 'noMatch' };
    },
    async listGroupRepositories(): Promise<Repository[]> {
      return [];
    },
    async getRepository(repoId: string): Promise<Repository> {
      return { id: repoId, path: 'inv/repo', name: 'repo', webUrl: 'https://inv.invalid/repo' };
    },
    async listOpenChangeRequests(): Promise<ChangeRequest[]> {
      return [
        {
          ref: CR_REF,
          title: 'Add feature',
          state: 'open',
          sourceBranch: 'feature',
          targetBranch: 'main',
          author: { username: 'dev' },
          reviewers: [],
          webUrl: 'https://inv.invalid/repo/1',
          updatedAt: new Date().toISOString(),
          headSha: HEAD_SHA,
        },
      ];
    },
    async listWorkItems(): Promise<WorkItem[]> {
      return [];
    },
    async listCiRuns(): Promise<CiRun[]> {
      return [];
    },
    async getChangeRequestDiff(): Promise<ChangeRequestDiff> {
      return {
        ref: CR_REF,
        headSha: HEAD_SHA,
        files: [{ oldPath: CHANGED_FILE, newPath: CHANGED_FILE, diff: '@@ -1,3 +1,4 @@\n+  // TODO: refine\n' }],
        anchorRefs: {},
      };
    },
    async submitReview(_ref, submission: ReviewSubmission): Promise<SubmitResult> {
      return { comments: submission.comments.map((c) => ({ key: c.key, ok: true })), summaryPosted: true };
    },
    async listThreads(): Promise<ReviewThread[]> {
      return [
        {
          id: 't1',
          crRef: CR_REF,
          resolved: false,
          anchorPresent: true,
          notes: [{ id: 'n1', author: { username: 'dev' }, body: 'note', createdAt: new Date().toISOString() }],
        },
      ];
    },
    async resolveThread(): Promise<void> {},
    async replyToThread(): Promise<void> {},
    async approve(): Promise<void> {},
  };
}

function readFileLines(headSha: string): readonly string[] {
  return headSha === PRIOR_REVISION.headSha ? PRIOR_FILE_LINES : FILE_LINES;
}

function makeConnection(): Connection {
  return {
    ...baseConnectionMethods(),

    async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
      if (!request.cursor) {
        return {
          snapshot: request.snapshot,
          state: 'paginated',
          value: [{ path: CHANGED_FILE, kind: 'modified', binary: false }],
          cursor: 'page-2',
        };
      }
      return { snapshot: request.snapshot, state: 'complete', value: [{ path: BINARY_FILE, kind: 'added', binary: true }] };
    },

    async readFile(request: FileRangeRequest): Promise<FileRangeResult> {
      if (request.path === BINARY_FILE) return { snapshot: request.snapshot, state: 'binary', byteSize: 4096 };
      const lines = readFileLines(request.snapshot.headSha);
      const start = request.startLine;
      const end = Math.min(request.endLine, lines.length, start + FILE_READ_BOUND - 1);
      const text = lines.slice(start - 1, end).join('\n');
      if (request.endLine > end) {
        return {
          snapshot: request.snapshot,
          state: 'truncated',
          value: { revision: request.revision, path: request.path, startLine: start, endLine: end, text },
          knownRemainingUnits: request.endLine - end,
        };
      }
      return {
        snapshot: request.snapshot,
        state: 'complete',
        value: { revision: request.revision, path: request.path, startLine: start, endLine: end, text },
      };
    },

    async searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
      if (request.query === 'TODO') {
        return { snapshot: request.snapshot, state: 'complete', value: [{ path: CHANGED_FILE, line: 2, excerpt: '// TODO: refine' }] };
      }
      return { snapshot: request.snapshot, state: 'complete', value: [] };
    },

    async getChangeRequestDetails(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> {
      return {
        snapshot: request.snapshot,
        state: 'complete',
        value: {
          title: 'Add feature',
          labels: [],
          commits: [],
          discussion: [],
          checkSummaries: [],
          relationships: [],
          unavailableSections: ['discussion'],
        },
      };
    },
  };
}

function makeRateLimitedInvestigationConnection(): Connection {
  return {
    ...baseConnectionMethods(),
    async readFile(): Promise<FileRangeResult> {
      throw new ScmError('rateLimited', 'rate limited', { retryAfterSeconds: 30 });
    },
    // Declared for type completeness; unused by the rate-limit case itself.
    async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
      return { snapshot: request.snapshot, state: 'complete', value: [] };
    },
    async searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
      return { snapshot: request.snapshot, state: 'complete', value: [] };
    },
    async getChangeRequestDetails(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> {
      return { snapshot: request.snapshot, state: 'unavailable' };
    },
    async getIssueDetails(request: IssueDetailRequest): Promise<IssueDetailResult> {
      return { snapshot: request.snapshot, state: 'unavailable' };
    },
  };
}

describeProviderContract('in-memory review-investigation fake (tasks 3.6/3.7 self-check)', {
  capabilities: CAPABILITIES,
  makeConnection: async () => makeConnection(),
  makeRateLimitedInvestigationConnection: async () => makeRateLimitedInvestigationConnection(),
  inputs: {
    repository: 'inv/repo',
    notVisible: '999999',
    noMatch: 'not-a-thing',
  },
  expected: { repoId: REPO_ID, repoPath: 'inv/repo' },
  crRef: CR_REF,
  anchor: { filePath: CHANGED_FILE, line: 2 },
  investigation: {
    baseSha: BASE_SHA,
    changedFilePath: CHANGED_FILE,
    binaryFilePath: BINARY_FILE,
    priorRevision: PRIOR_REVISION,
    noMatchQuery: 'ZZZ_NO_MATCH_ZZZ',
    matchQuery: 'TODO',
  },
} satisfies ProviderContractHarness);
