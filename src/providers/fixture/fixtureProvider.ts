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
  Repository,
  ReviewSubmission,
  ReviewThread,
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
  // D7: the two detail reads. The five revision-pinned operations this used to
  // declare moved to `./demoInvestigationSource.ts` with their dataset, when
  // the provider stopped being an investigation source at all.
  detailRetrieval: {
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

export interface FixtureSimulation {
  /** Line-comment posts whose draft key is in this set fail with staleAnchor. */
  staleAnchorKeys?: ReadonlySet<string>;
  /** Every write fails with this error. */
  failAll?: ScmError;
  /**
   * Every *detail* read fails with the neutral rate-limited error — the two
   * structured detail retrievals and the head check, which is all this
   * connection is asked for now. The manifest, diff, file and search reads it
   * used to cover moved to `./demoInvestigationSource.ts` with the rest of
   * investigation, and carry their own flag there.
   */
  investigationRateLimited?: boolean;
}

function investigationRateLimitedError(): ScmError {
  return new ScmError('rateLimited', 'Detail read is rate limited', { retryAfterSeconds: 30 });
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

  /**
   * There is no object source, stated rather than left unimplemented
   * (`add-local-git-investigation` task 2.4).
   *
   * This provider's content is built in memory from `./data.ts` and
   * `./harnessFixtures.ts`; `demo.invalid` is a reserved name that resolves
   * nowhere, and no commit here exists in any repository. Returning a
   * descriptor pointing at it would be a lie that a demo pod pays for with a
   * network fetch at source-selection time — the one moment nothing should be
   * waiting on a remote.
   *
   * Implementing it as an explicit refusal is also what keeps the contract
   * suite's unavailable branch exercised: GitHub and GitLab both answer with a
   * descriptor, so without this the "or reports it unavailable with a reason"
   * half of task 2.5's conformance case would never run against anything.
   */
  async getObjectSource(_ref: ChangeRequestRef): Promise<ObjectSourceResult> {
    return {
      state: 'unavailable',
      reason: 'This provider serves built-in sample data from memory; its revisions exist in no repository to fetch from.',
    };
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
