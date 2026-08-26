/**
 * Posted-reviews view-state derivation — pure (no `vscode` import) so tests
 * can drive the exact pipeline the panel renders, the way `dashboardState.ts`
 * already does for the dashboard.
 */
import type { PostedReviewView } from '../app/postedReviews';
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
