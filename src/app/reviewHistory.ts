/**
 * Submitted-review history (globalState): powers the dashboard's
 * "submitted" pill and AI-coverage stat now, posted-review tracking
 * (issue #12) and agent tuning (issue #13) next.
 */
import type { VerdictCounts } from '../domain/reviewState';
import type { Category, Severity, Verdict } from '../domain/types';
import type { KeyValueStore } from './storage';

export interface SubmittedItemSnapshot {
  id: string;
  title: string;
  severity: Severity;
  file: string;
  line: number;
  /**
   * Cross-repo findings keep their spans so the changeset screen can show
   * them after submit clears the draft. Records from before issue #15 omit
   * all three — treat absence as "not cross", never as "unknown".
   */
  cross?: boolean;
  spans?: Array<{ repoId: string; location: string; role: string }>;
  confidence?: number;
}

export interface SubmittedObservation {
  category: Category;
  confidence: number;
  verdict: Verdict;
  /** Absent on records written before the tuning scorecard quoted nit rates. */
  severity?: Severity;
}

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
  /**
   * How many comments actually posted. `counts.accepted` is not the same
   * number — an item accepted after a partial failure is counted but never
   * submitted — and posted-review filtering needs the exact one to tell
   * "some thread ids failed to resolve" from "these were never posted".
   * Absent on records written before this was tracked.
   */
  postedComments?: number;
  /** Accepted-item snapshot — posted-review rows need titles/severities offline. */
  items?: SubmittedItemSnapshot[];
  /** All decisions, used for category/confidence tuning. Older records may omit it. */
  observations?: SubmittedObservation[];
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
