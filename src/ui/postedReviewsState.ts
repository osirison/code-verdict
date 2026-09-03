/**
 * Posted-reviews view-state derivation — pure (no `vscode` import) so tests
 * can drive the exact pipeline the panel renders, the way `dashboardState.ts`
 * already does for the dashboard.
 */
import { crKey, type PostedReviewView } from '../app/postedReviews';
import type { PostedThreadView } from '../app/postedReviews';
import { isWaitingOnYou } from '../domain/threadStatus';
import type { ChangeRequest } from '../platform/types';
import type { PostedRow } from './postedReviewsHtml';

/** Everything a row knows before the open-change-request list is joined in. */
export interface PostedRowSource {
  view: PostedReviewView;
  refLabel: string;
  project: string;
  age: string;
}

function refMatches(row: { view: PostedReviewView }, repoId: string, number: string): boolean {
  return row.view.repoId === repoId && row.view.crNumber === number;
}

/**
 * Join the submitted-review history against the open change requests the
 * panel already fetches for the row titles. Absence from that batched list
 * is the archive signal: history is append-only, so a review whose change
 * request has merged or closed would otherwise sit in the list forever.
 *
 * This is the rule `notifier.ts` already scopes reply polling with — "merged
 * and closed ones leave the live set" — applied to the one surface that
 * missed it, from a list call that is already in flight. No per-entry fetch,
 * no `getChangeRequest` on the contract, no batching the architecture forbids.
 *
 * Derived, never persisted: a reopened change request rejoins the live set
 * and un-archives itself on the next refresh, which a stored flag could not.
 *
 * Known limitation: both HTTP clients' `getAll` caps at `maxPages = 10`, so a
 * repository past 1000 open change requests truncates the list and a
 * still-open review reads as archived. The notifier carries the identical
 * exposure. The mitigation is the design rather than a fix — the header
 * always shows the archived count, so a wrongly-archived review is one click
 * away, never gone.
 */
export function buildPostedRows(
  sources: readonly PostedRowSource[],
  openChangeRequests: readonly ChangeRequest[],
): PostedRow[] {
  return sources.map((source) => {
    // One lookup feeds both outputs — the title the row shows and the flag.
    const cr = openChangeRequests.find((c) =>
      refMatches(source, c.ref.repoId, c.ref.number),
    );
    return {
      view: source.view,
      refLabel: source.refLabel,
      title: cr?.title ?? source.refLabel,
      project: source.project,
      age: source.age,
      archived: cr === undefined,
    };
  });
}

/** The rows the list renders: active only, unless the filter is on. */
export function visiblePostedRows(
  rows: readonly PostedRow[],
  showArchived: boolean,
): PostedRow[] {
  return showArchived ? [...rows] : rows.filter((row) => !row.archived);
}

/** What the filter would reveal — the header shows it even while it is off. */
export function countArchived(rows: readonly PostedRow[]): number {
  return rows.filter((row) => row.archived).length;
}

/**
 * The header's "N on you". The panel hands it the *visible* rows: a thread
 * still open on a change request that has merged or closed is not work the
 * reviewer can act on, so counting it would inflate the badge with exactly
 * the unreachable work this change hides from the list.
 */
export function countWaitingOnYou(rows: readonly PostedRow[]): number {
  return rows.reduce((total, row) => total + row.view.counts.you, 0);
}

/**
 * Resolve the selection against the rows actually on screen. Selection is a
 * ref, not an index, so it survives the filter flipping — but an archived
 * selection is not in the visible set while the filter is off, and neither is
 * a review that has since left the history, so both fall back to the first
 * visible row rather than leaving the detail panel pointing at a row the list
 * does not show. The panel and the renderer both call this: a disagreement
 * here would send a resolve/reply to a different review than the one drawn.
 */
export function selectedPostedRow(
  rows: readonly PostedRow[],
  selectedRef?: { repoId: string; number: string },
): PostedRow | undefined {
  const found = selectedRef
    ? rows.find((row) => refMatches(row, selectedRef.repoId, selectedRef.number))
    : undefined;
  return found ?? rows[0];
}

/**
 * Composite key for a thread's in-progress reply text (issue #46 task 9.3),
 * scoped to the review the thread belongs to rather than the bare thread id:
 * `ThreadFlags` (app/postedReviews.ts) already treats thread ids as
 * review-scoped, never assumed globally unique across change requests — a
 * draft map keyed on the id alone would reintroduce exactly the collision
 * that keying was added to avoid, for a field that outlives a single render.
 */
export function replyDraftKey(repoId: string, crNumber: string, threadId: string): string {
  return `${crKey(repoId, crNumber)}:${threadId}`;
}

/**
 * The same counting rule `buildPostedReview` (app/postedReviews.ts) applies
 * after a real fetch — duplicated rather than shared, because a local patch
 * exists specifically to avoid the fetch that function needs (task 7.4).
 * Kept in lockstep so a patched row's badge and breakdown never disagree with
 * what a real refresh would compute for the same thread statuses.
 */
function deriveThreadCounts(threads: readonly PostedThreadView[]): PostedReviewView['counts'] {
  const counts = { you: 0, author: 0, closed: 0 };
  for (const t of threads) {
    if (t.status === 'resolved' || t.status === 'conceded') counts.closed += 1;
    else if (isWaitingOnYou(t.status)) counts.you += 1;
    else counts.author += 1;
  }
  return counts;
}

/**
 * Replace one thread's view inside `rows`, in place of a history refetch
 * (task 7.4): `resolve`/`concede`/`reply` used to call `refresh()`, which
 * re-ran `buildPostedReview` over every submitted review just to reflect one
 * thread changing. This is now the only place that local copy is updated.
 * Matched on repoId+crNumber as well as threadId, for the same reason
 * `replyDraftKey` is — every other row, and every other thread on the
 * matching row, comes back unchanged (by reference, so an unrelated render
 * never treats them as changed).
 */
export function patchThreadInRows(
  rows: readonly PostedRow[],
  repoId: string,
  crNumber: string,
  threadId: string,
  updater: (thread: PostedThreadView) => PostedThreadView,
): PostedRow[] {
  return rows.map((row) => {
    if (row.view.repoId !== repoId || row.view.crNumber !== crNumber) return row;
    const threads = row.view.threads.map((t) => (t.threadId === threadId ? updater(t) : t));
    return { ...row, view: { ...row.view, threads, counts: deriveThreadCounts(threads) } };
  });
}

/**
 * After "Resolve thread" / "Re-open thread" succeeds on the platform (task
 * 7.4): no fetch follows, so the new status is derived from what the panel
 * already holds instead of from a fresh `listThreads`.
 */
export function resolveThreadView(
  thread: PostedThreadView,
  resolved: boolean,
  you: string,
): PostedThreadView {
  if (resolved) {
    return { ...thread, status: 'resolved', closedBy: `resolved by @${you}` };
  }
  // Reopening: recompute from the conversation's last note, the same rule
  // `deriveThreadStatus` (domain/threadStatus.ts) applies once `resolved` is
  // false. A thread whose anchor was ALSO lost before it got resolved would
  // read 'stale' again on a real fetch — this local patch has no anchor data
  // to check, so it falls back to the last-note rule, and the next real
  // refresh (⟳, or reopening this screen) corrects the label if that guess
  // was wrong. That needs a force-push *and* a prior resolve to even arise.
  const last = thread.replies.at(-1);
  return { ...thread, status: last && !last.yours ? 'replied' : 'awaiting', closedBy: undefined };
}

/**
 * After "Concede — they're right" succeeds (task 7.4) — mirrors the status
 * and label `toThreadView` (app/postedReviews.ts) assigns a conceded thread
 * on a real fetch.
 */
export function concedeThreadView(thread: PostedThreadView): PostedThreadView {
  return { ...thread, status: 'conceded', closedBy: 'conceded — they were right' };
}

/**
 * After a reply posts successfully (task 7.4): appends the note locally and
 * puts the thread back to "awaiting author" — you just spoke last — unless
 * the anchor is already lost, which a reply cannot fix and which
 * `deriveThreadStatus` checks ahead of the last-note rule.
 */
export function replyThreadView(
  thread: PostedThreadView,
  author: string,
  body: string,
  at: string,
): PostedThreadView {
  return {
    ...thread,
    replies: [...thread.replies, { author, body, at, yours: true }],
    status: thread.status === 'stale' ? 'stale' : 'awaiting',
  };
}
