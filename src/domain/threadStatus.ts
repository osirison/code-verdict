/**
 * Thread status derivation (handoff §8) as a pure function over neutral
 * `ReviewThread` data. Status is keyed per `<crRef>:<itemId>` by the caller
 * — never shared between reviews.
 */
import type { ReviewThread } from '../platform/types';

export type ThreadStatus = 'awaiting' | 'replied' | 'resolved' | 'conceded' | 'stale';

export interface ThreadStatusContext {
  /** The signed-in username — "your" notes are theirs. */
  you: string;
  /** Threads locally flagged "conceded — they're right". */
  conceded?: ReadonlySet<string>;
}

export function deriveThreadStatus(thread: ReviewThread, ctx: ThreadStatusContext): ThreadStatus {
  if (thread.resolved) {
    return ctx.conceded?.has(thread.id) ? 'conceded' : 'resolved';
  }
  // GitLab dropped the anchor (position: null after a force-push / rebase).
  if (!thread.anchorPresent) return 'stale';

  const last = thread.notes[thread.notes.length - 1];
  if (last && last.author.username !== ctx.you) return 'replied';
  return 'awaiting';
}

/** `replied` + `stale` — drives the sidebar badge and the dashboard stat. */
export function isWaitingOnYou(status: ThreadStatus): boolean {
  return status === 'replied' || status === 'stale';
}
