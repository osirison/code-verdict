/**
 * Submitted-review history (globalState): powers the dashboard's
 * "submitted" pill and AI-coverage stat now, posted-review tracking
 * (issue #12) and agent tuning (issue #13) next.
 */
import type { VerdictCounts } from '../domain/reviewState';
import type { KeyValueStore } from './storage';

export interface SubmittedReview {
  repoId: string;
  crNumber: string;
  podId: string;
  agentId: string;
  agentLabel: string;
  submittedAt: string;
  counts: VerdictCounts;
  /** itemId → discussion/thread id, for reply polling. */
  threads: Record<string, string>;
  requestedChanges: boolean;
}

const KEY = 'codeVerdict.submittedReviews';

export class ReviewHistory {
  constructor(private readonly store: KeyValueStore) {}

  list(): SubmittedReview[] {
    return [...(this.store.get<SubmittedReview[]>(KEY) ?? [])];
  }

  async add(entry: SubmittedReview): Promise<void> {
    const all = this.list().filter(
      (r) => !(r.repoId === entry.repoId && r.crNumber === entry.crNumber),
    );
    all.push(entry);
    await this.store.update(KEY, all);
  }

  submittedRefs(): Set<string> {
    return new Set(this.list().map((r) => `${r.repoId}!${r.crNumber}`));
  }
}
