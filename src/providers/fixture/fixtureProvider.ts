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
} from '../../platform/provider';
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
} from '../../platform/types';
import { ScmError } from '../../platform/errors';
import { parseSourceInput } from '../../platform/sourceInput';
import * as data from './data';

const CAPABILITIES: ProviderCapabilities = {
  suggestions: true,
  approvals: true,
  requestChanges: true,
  threadResolution: true,
  groupHierarchy: true,
  batchedReview: false,
};

const VOCABULARY: Vocabulary = {
  changeRequestNoun: 'merge request',
  changeRequestAbbrev: 'MR',
  repoNoun: 'project',
  groupNoun: 'group',
  ciNoun: 'pipeline',
  formatCrRef: (number) => `!${number}`,
};

export interface FixtureSimulation {
  /** Line-comment posts whose draft key is in this set fail with staleAnchor. */
  staleAnchorKeys?: ReadonlySet<string>;
  /** Every write fails with this error. */
  failAll?: ScmError;
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
    if ((submission.approve || submission.requestChanges) && allCommentsOk) {
      result.approvalApplied = true;
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
}

export const fixtureProvider: ScmProvider = {
  id: 'fixture',
  displayName: 'Demo pod (fixtures)',
  capabilities: CAPABILITIES,
  vocabulary: VOCABULARY,
  connect(_config: ConnectionConfig): Connection {
    return new FixtureConnection();
  },
};
