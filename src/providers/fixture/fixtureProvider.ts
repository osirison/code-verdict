/**
 * An in-memory `ScmProvider` over the spec fixture data. Two jobs: the demo
 * pod ("Skip and use a demo pod" in onboarding), and an offline reference
 * implementation the provider contract suite runs against.
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
  ChangedFileEntry,
  ChangedFileKind,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  ChangeRequest,
  ChangeRequestDetailRequest,
  ChangeRequestDetailResult,
  ChangeRequestDiff,
  ChangeRequestRef,
  CiRun,
  ConnectionStatus,
  CurrentHeadResult,
  DiffPage,
  DiffPageRequest,
  DiffPageResult,
  DiffSearchMatch,
  DiffSearchRequest,
  DiffSearchResult,
  FileDiff,
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
  SubmitResult,
  WorkItem,
} from '../../platform/types';
import { ScmError } from '../../platform/errors';
// The demo data is GitLab-shaped by design (numeric ids, `!2841` refs), so it
// shares that grammar. A pure parser, not the GitLab provider itself.
import { parseSourceInput } from '../gitlab/sourceInput';
import * as data from './data';
// Task 1.3 deterministic harness fixtures — the investigation registry below
// reuses these verbatim instead of inventing new adversarial content.
import * as harnessFixtures from './harnessFixtures';

const CAPABILITIES: ProviderCapabilities = {
  suggestions: true,
  approvals: true,
  requestChanges: true,
  threadResolution: true,
  groupHierarchy: true,
  batchedReview: false,
  // D7/task 4.1: the fixture provider is the first, offline reference
  // implementation — every operation is honestly supported so the shared
  // contract suite's investigation cases (task 3.6) actually run.
  reviewInvestigation: {
    manifests: { supported: true },
    diffReads: { supported: true },
    // Small on purpose: forces the reconstructed token.ts fixture content to
    // exercise `truncated`, not just `complete`, without a huge file.
    fileReads: { supported: true, pageBound: { maxPageSize: 8 } },
    repositorySearch: { supported: true },
    diffSearch: { supported: true },
    changeRequestDetails: { supported: true },
    issueDetails: { supported: true },
    pagination: { maxPageSize: harnessFixtures.HUGE_REVIEW_PAGE_SIZE },
  },
};

const VOCABULARY: Vocabulary = {
  platformName: 'the demo data',
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
  instanceUrlLabel: 'Demo host',
  defaultInstanceUrl: 'https://demo.invalid',
  tokenPlaceholder: 'not needed',
  tokenHint: 'no credential — this provider serves built-in sample data',
  sourceInputPlaceholder: '9102 · group 4821',
  sourceInputHint: 'Sample data only.',
  sourceSamples: [{ label: 'sample project', value: '9102' }],
};

// ---- Review-investigation operations (design.md D7, task 4.1) --------------
//
// A second dataset, independent of the demo-pod content above: investigation
// operations are revision-pinned and keyed by `headSha`, never by
// change-request identity, so the demo CR 2841 can keep serving its friendly
// onboarding diff through `getChangeRequestDiff` while its investigation
// manifest/reads/search come from this registry. Every entry is built from
// the task-1.3 harness fixtures (`./harnessFixtures.ts`) or this module's own
// demo diff; nothing here is newly authored adversarial content.

interface InvestigationFile {
  entry: ChangedFileEntry;
  /** Original unified-diff hunk text, served by `readDiff`. */
  patch?: string;
  /** Deterministic reconstruction of head-revision text from `patch` (context + added lines), served by `readFile`/search. Absent for binary files. */
  lines?: readonly string[];
}

interface InvestigationScenario {
  readonly files: readonly InvestigationFile[];
  /** Paths whose diff is too large to read as a patch (`readDiff` reports `tooLarge`). */
  readonly oversizedPaths?: ReadonlySet<string>;
  /** `searchDiff` cannot state completeness against this scenario's diff. */
  readonly diffSearchUnknown?: boolean;
  /**
   * Repository content outside the diff — task 6.3's `AGENTS.md` chain reads
   * a directory that was never changed, so it cannot be represented as an
   * `InvestigationFile` (those are all diff-derived). `readFile` falls back
   * here when a path is not among the changed files.
   */
  readonly repoFiles?: readonly harnessFixtures.FixtureRepoFile[];
}

/** Keeps context and added lines, drops removed lines and hunk headers \u2014 a deterministic head-revision approximation, never invented file content. */
function linesFromUnifiedDiff(patch: string): string[] {
  const lines: string[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@') || raw.startsWith('Binary files ') || raw.startsWith('-')) continue;
    lines.push(raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw);
  }
  return lines;
}

function fileFromFileDiff(fd: FileDiff, kind: ChangedFileKind): InvestigationFile {
  const binary = fd.diff.startsWith('Binary files ');
  return {
    entry: {
      path: fd.newPath,
      oldPath: fd.isRenamed ? fd.oldPath : undefined,
      kind: fd.isRenamed ? 'renamed' : kind,
      binary,
      byteSize: binary ? 4096 : undefined,
    },
    patch: fd.diff,
    lines: binary ? undefined : linesFromUnifiedDiff(fd.diff),
  };
}

// The demo pod's own CR 2841 diff \u2014 its investigation manifest layers the
// huge/binary/renamed fixtures on top of these two real files.
const DEFAULT_INVESTIGATION_DIFF = data.DIFFS.find((d) => d.ref.repoId === '9101' && d.ref.number === '2841')!;

const INVESTIGATION_SNAPSHOTS: ReadonlyMap<string, InvestigationScenario> = new Map([
  [
    DEFAULT_INVESTIGATION_DIFF.headSha,
    {
      files: [
        ...DEFAULT_INVESTIGATION_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')),
        fileFromFileDiff(harnessFixtures.BINARY_FILE, 'added'),
        fileFromFileDiff(harnessFixtures.RENAMED_FILE, 'modified'),
      ],
    },
  ],
  [
    harnessFixtures.BINARY_AND_RENAMED_DIFF.headSha,
    { files: harnessFixtures.BINARY_AND_RENAMED_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.HUGE_REVIEW_DIFF.headSha,
    { files: harnessFixtures.HUGE_REVIEW_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha,
    {
      files: [
        {
          entry: {
            path: harnessFixtures.OVERSIZED_FILE_PATH,
            kind: 'modified',
            binary: false,
            byteSize: harnessFixtures.OVERSIZED_DIFF_BYTE_LENGTH,
          },
        },
      ],
      oversizedPaths: new Set([harnessFixtures.OVERSIZED_FILE_PATH]),
      diffSearchUnknown: true,
    },
  ],
  [
    harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA,
    { files: harnessFixtures.CHANGED_HEAD_SNAPSHOT_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.CHANGED_HEAD_LATER_SHA,
    { files: harnessFixtures.CHANGED_HEAD_LATER_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.NESTED_AGENTS_MD_DIFF.headSha,
    {
      files: harnessFixtures.NESTED_AGENTS_MD_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')),
      repoFiles: harnessFixtures.NESTED_AGENTS_MD,
    },
  ],
]);

function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { page: readonly T[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  return { page: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

function searchScenario(scenario: InvestigationScenario, query: string, pathScope?: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const file of scenario.files) {
    if (file.entry.binary || !file.lines) continue;
    if (pathScope && !file.entry.path.startsWith(pathScope)) continue;
    file.lines.forEach((line, index) => {
      if (line.includes(query)) matches.push({ path: file.entry.path, line: index + 1, excerpt: line.trim() });
    });
  }
  return matches;
}

function investigationRateLimitedError(): ScmError {
  return new ScmError('rateLimited', 'Investigation read is rate limited', { retryAfterSeconds: 30 });
}

export interface FixtureSimulation {
  /** Line-comment posts whose draft key is in this set fail with staleAnchor. */
  staleAnchorKeys?: ReadonlySet<string>;
  /** Every write fails with this error. */
  failAll?: ScmError;
  /** Every review-investigation read fails with the neutral rate-limited error (task 3.5/4.2). */
  investigationRateLimited?: boolean;
}

function crKey(ref: ChangeRequestRef): string {
  return `${ref.repoId}!${ref.number}`;
}

export class FixtureConnection implements Connection {
  /** Mutable failure injection for tests. */
  simulate: FixtureSimulation = {};

  private readonly threads = new Map<string, ReviewThread[]>();
  private threadSeq = 0;

  constructor() {
    for (const t of data.THREADS) {
      const key = crKey(t.crRef);
      const list = this.threads.get(key) ?? [];
      list.push(structuredClone(t));
      this.threads.set(key, list);
    }
  }

  async testConnection(): Promise<ConnectionStatus> {
    return { ok: true, username: 'you', scopes: ['api'], tokenExpiresInDays: 42 };
  }

  async resolveSource(input: string): Promise<SourceResolution> {
    const parsed = parseSourceInput(input);
    switch (parsed.shape) {
      case 'path': {
        const repo = data.REPOSITORIES.find((r) => r.path === parsed.path);
        return repo ? { kind: 'repository', repo } : { kind: 'noMatch' };
      }
      case 'id': {
        const repo = data.REPOSITORIES.find((r) => r.id === parsed.id);
        if (repo) return { kind: 'repository', repo };
        if (data.GROUP.id === parsed.id) {
          return { kind: 'group', group: data.GROUP, repositories: await this.listGroupRepositories(parsed.id) };
        }
        return { kind: 'notVisible', id: parsed.id };
      }
      case 'groupId': {
        if (data.GROUP.id === parsed.id) {
          return { kind: 'group', group: data.GROUP, repositories: await this.listGroupRepositories(parsed.id) };
        }
        return { kind: 'notVisible', id: parsed.id };
      }
      case 'groupPath': {
        if (data.GROUP.path === parsed.path) {
          return { kind: 'group', group: data.GROUP, repositories: await this.listGroupRepositories(data.GROUP.id) };
        }
        return { kind: 'noMatch' };
      }
      case 'invalid':
        return { kind: 'noMatch' };
    }
  }

  async listGroupRepositories(groupId: string): Promise<Repository[]> {
    if (groupId !== data.GROUP.id) throw new ScmError('notFound', `Unknown group: ${groupId}`);
    return data.REPOSITORIES.filter((r) => data.GROUP_REPO_IDS.includes(r.id));
  }

  async getRepository(repoId: string): Promise<Repository> {
    const repo = data.REPOSITORIES.find((r) => r.id === repoId);
    if (!repo) throw new ScmError('notFound', `Unknown repository: ${repoId}`);
    return repo;
  }

  async listOpenChangeRequests(repoIds: readonly string[]): Promise<ChangeRequest[]> {
    return data.CHANGE_REQUESTS.filter((cr) => repoIds.includes(cr.ref.repoId) && cr.state === 'open');
  }

  async listWorkItems(repoIds: readonly string[]): Promise<WorkItem[]> {
    return data.WORK_ITEMS.filter((wi) => repoIds.includes(wi.repoId));
  }

  async listCiRuns(repoIds: readonly string[], limitPerRepo = 3): Promise<CiRun[]> {
    const byRepo = new Map<string, CiRun[]>();
    for (const run of data.CI_RUNS) {
      if (!repoIds.includes(run.repoId)) continue;
      const list = byRepo.get(run.repoId) ?? [];
      if (list.length < limitPerRepo) list.push(run);
      byRepo.set(run.repoId, list);
    }
    return [...byRepo.values()].flat();
  }

  async getChangeRequestDiff(ref: ChangeRequestRef): Promise<ChangeRequestDiff> {
    const diff = data.DIFFS.find((d) => d.ref.repoId === ref.repoId && d.ref.number === ref.number);
    if (!diff) throw new ScmError('notFound', `No diff for ${crKey(ref)}`);
    return diff;
  }

  async submitReview(ref: ChangeRequestRef, submission: ReviewSubmission): Promise<SubmitResult> {
    if (this.simulate.failAll) throw this.simulate.failAll;

    const result: SubmitResult = { comments: [], summaryPosted: false };
    const key = crKey(ref);
    const list = this.threads.get(key) ?? [];
    this.threads.set(key, list);

    for (const comment of submission.comments) {
      if (this.simulate.staleAnchorKeys?.has(comment.key)) {
        result.comments.push({
          key: comment.key,
          ok: false,
          error: new ScmError('staleAnchor', 'Note position is invalid', { status: 400 }),
        });
        continue;
      }
      const threadId = `fixture_thread_${++this.threadSeq}`;
      list.push({
        id: threadId,
        crRef: ref,
        resolved: false,
        anchorPresent: true,
        filePath: comment.anchor.filePath,
        line: comment.anchor.line,
        notes: [
          {
            id: `note_${this.threadSeq}`,
            author: { username: 'you' },
            body: comment.body,
            createdAt: '2026-07-30T00:00:00.000Z',
            resolvable: true,
            resolved: false,
          },
        ],
      });
      result.comments.push({ key: comment.key, ok: true, threadId });
    }

    const allCommentsOk = result.comments.every((c) => c.ok);
    if (submission.summary !== undefined && allCommentsOk) {
      result.summaryPosted = true;
    }
    if (submission.approve && allCommentsOk) {
      result.approvalApplied = true;
    }
    if (submission.requestChanges && allCommentsOk) {
      result.requestChangesApplied = true;
    }
    return result;
  }

  async listThreads(ref: ChangeRequestRef): Promise<ReviewThread[]> {
    return this.threads.get(crKey(ref)) ?? [];
  }

  async resolveThread(ref: ChangeRequestRef, threadId: string, resolved: boolean): Promise<void> {
    const thread = (this.threads.get(crKey(ref)) ?? []).find((t) => t.id === threadId);
    if (!thread) throw new ScmError('notFound', `Unknown thread: ${threadId}`);
    thread.resolved = resolved;
  }

  async replyToThread(ref: ChangeRequestRef, threadId: string, body: string): Promise<void> {
    const thread = (this.threads.get(crKey(ref)) ?? []).find((t) => t.id === threadId);
    if (!thread) throw new ScmError('notFound', `Unknown thread: ${threadId}`);
    thread.notes.push({
      id: `note_reply_${++this.threadSeq}`,
      author: { username: 'you' },
      body,
      createdAt: '2026-07-30T00:00:00.000Z',
    });
  }

  async approve(_ref: ChangeRequestRef): Promise<void> {
    // No-op in the fixture.
  }

  // ---- Review-investigation operations (design.md D7, task 4.1) ------------

  async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
    if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
    const bound = CAPABILITIES.reviewInvestigation!.manifests.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const { page, nextCursor } = paginate(
      scenario.files.map((f) => f.entry),
      request.cursor,
      bound,
    );
    if (nextCursor) return { snapshot: request.snapshot, state: 'paginated', value: page, cursor: nextCursor };
    return { snapshot: request.snapshot, state: 'complete', value: page };
  }

  async readDiff(request: DiffPageRequest): Promise<DiffPageResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
    if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
    const file = scenario.files.find((f) => f.entry.path === request.path);
    if (scenario.oversizedPaths?.has(request.path)) {
      return { snapshot: request.snapshot, state: 'tooLarge', byteSize: file?.entry.byteSize };
    }
    if (!file) return { snapshot: request.snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
    if (file.entry.binary) return { snapshot: request.snapshot, state: 'binary', byteSize: file.entry.byteSize };
    const value: DiffPage = {
      path: file.entry.path,
      oldPath: file.entry.oldPath,
      isRenamed: file.entry.kind === 'renamed',
      patch: file.patch ?? '',
      positions: [],
    };
    return { snapshot: request.snapshot, state: 'complete', value };
  }

  async readFile(request: FileRangeRequest): Promise<FileRangeResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
    if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
    const file = scenario.files.find((f) => f.entry.path === request.path);
    const repoFile = !file ? scenario.repoFiles?.find((f) => f.path === request.path) : undefined;
    if (!file && !repoFile) return { snapshot: request.snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
    if (file?.entry.binary) return { snapshot: request.snapshot, state: 'binary', byteSize: file.entry.byteSize };
    const lines = file ? file.lines ?? [] : (repoFile!.content.split(/\r?\n/));
    const bound = CAPABILITIES.reviewInvestigation!.fileReads.pageBound?.maxPageSize ?? CAPABILITIES.reviewInvestigation!.pagination.maxPageSize;
    const start = Math.max(1, request.startLine);
    if (start > lines.length) return { snapshot: request.snapshot, state: 'notFound', reason: 'startLine beyond file length' };
    const availableEnd = Math.min(request.endLine, lines.length);
    const boundedEnd = Math.min(availableEnd, start + bound - 1);
    const value: FileRange = { revision: request.revision, path: request.path, startLine: start, endLine: boundedEnd, text: lines.slice(start - 1, boundedEnd).join('\n') };
    if (boundedEnd < availableEnd) {
      return { snapshot: request.snapshot, state: 'truncated', value, knownRemainingUnits: availableEnd - boundedEnd };
    }
    return { snapshot: request.snapshot, state: 'complete', value };
  }

  async searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
    if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
    return { snapshot: request.snapshot, state: 'complete', value: searchScenario(scenario, request.query, request.pathScope) };
  }

  async searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
    if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
    if (scenario.diffSearchUnknown) return { snapshot: request.snapshot, state: 'unknown', reason: 'Diff exceeds searchable size' };
    const value: DiffSearchMatch[] = searchScenario(scenario, request.query, request.pathScope).map((m) => ({
      position: { path: m.path, side: 'new', line: m.line },
      excerpt: m.excerpt,
    }));
    return { snapshot: request.snapshot, state: 'complete', value };
  }

  async getChangeRequestDetails(request: ChangeRequestDetailRequest): Promise<ChangeRequestDetailResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const cr = data.CHANGE_REQUESTS.find((c) => c.ref.repoId === request.snapshot.repoId && c.ref.number === request.number);
    if (!cr) return { snapshot: request.snapshot, state: 'notFound', reason: `No such change request: ${request.number}` };
    const discussion = data.THREADS.filter((t) => t.crRef.repoId === cr.ref.repoId && t.crRef.number === cr.ref.number).flatMap((t) => t.notes);
    const partOf = /Part-of: #(\d+)/.exec(cr.description ?? '');
    return {
      snapshot: request.snapshot,
      state: 'complete',
      value: {
        title: cr.title,
        body: cr.description,
        labels: [],
        commits: [],
        discussion,
        checkSummaries: cr.ci ? [{ name: 'pipeline', status: cr.ci.status, summary: `Pipeline ${cr.ci.runId}` }] : [],
        relationships: partOf ? [{ kind: 'partOf', ref: partOf[1]! }] : [],
        unavailableSections: ['labels', 'commits'],
      },
    };
  }

  async getIssueDetails(request: IssueDetailRequest): Promise<IssueDetailResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    const isLongIssue =
      request.issueRepoId === harnessFixtures.LONG_ISSUE.repoId && request.issueNumber === harnessFixtures.LONG_ISSUE.number;
    const workItem = isLongIssue
      ? harnessFixtures.LONG_ISSUE
      : data.WORK_ITEMS.find((w) => w.repoId === request.issueRepoId && w.number === request.issueNumber);
    if (!workItem) {
      return { snapshot: request.snapshot, state: 'notFound', reason: `No such issue: ${request.issueRepoId}#${request.issueNumber}` };
    }
    return {
      snapshot: request.snapshot,
      state: 'complete',
      value: {
        title: workItem.title,
        body: workItem.description,
        labels: [],
        commits: [],
        discussion: isLongIssue ? harnessFixtures.LONG_DISCUSSION.notes : [],
        checkSummaries: [],
        relationships: [],
        unavailableSections: isLongIssue
          ? ['labels', 'commits', 'checkSummaries', 'relationships']
          : ['labels', 'commits', 'discussion', 'checkSummaries', 'relationships'],
      },
    };
  }

  async getCurrentHead(ref: ChangeRequestRef): Promise<CurrentHeadResult> {
    if (this.simulate.investigationRateLimited) throw investigationRateLimitedError();
    // The one deliberately drifted fixture: a push landed after the snapshot.
    if (ref.repoId === harnessFixtures.CHANGED_HEAD_REF.repoId && ref.number === harnessFixtures.CHANGED_HEAD_REF.number) {
      return { repoId: ref.repoId, state: 'resolved', headSha: harnessFixtures.CHANGED_HEAD_LATER_SHA };
    }
    const cr = data.CHANGE_REQUESTS.find((c) => c.ref.repoId === ref.repoId && c.ref.number === ref.number);
    if (!cr) return { repoId: ref.repoId, state: 'notFound' };
    return { repoId: ref.repoId, state: 'resolved', headSha: cr.headSha };
  }
}

export const fixtureProvider: ScmProvider = {
  id: 'fixture',
  displayName: 'Demo pod (fixtures)',
  capabilities: CAPABILITIES,
  vocabulary: VOCABULARY,
  host: HOST,
  demo: true,
  authModesFor: () => ['none'],
  connect(_config: ConnectionConfig): Connection {
    return new FixtureConnection();
  },
};
