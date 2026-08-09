/**
 * What the changeset screen's "findings that only exist between these repos"
 * section shows, and where it comes from:
 *
 * - While a triage draft exists, its full item list — every cross finding the
 *   combined run produced, whatever its verdict. An empty result here is a
 *   real claim: the run read every diff and found no cross-repo failure.
 * - After submit clears the draft, the per-member history snapshots. Those
 *   only hold *accepted* items, and records written before issue #15 carry no
 *   span data at all — so an empty collection is silence, not a claim, and
 *   callers get `undefined` rather than a false "found nothing".
 */
import type { ReviewItem, Severity } from '../domain/types';
import type { SubmittedReview } from './reviewHistory';

export interface CrossFindingSource {
  id: string;
  severity: Severity;
  title: string;
  confidence?: number;
  spans: Array<{ repoId: string; location: string; role: string }>;
}

interface CrossCarrier {
  id: string;
  severity: Severity;
  title: string;
  confidence?: number;
  cross?: boolean;
  spans?: Array<{ repoId: string; location: string; role: string }>;
}

function fromItems(items: readonly CrossCarrier[]): CrossFindingSource[] {
  return items.flatMap((item) =>
    item.cross && item.spans && item.spans.length >= 2
      ? [{ id: item.id, severity: item.severity, title: item.title, confidence: item.confidence, spans: item.spans }]
      : [],
  );
}

export function collectCrossFindings(
  draftItems: readonly ReviewItem[] | undefined,
  history: readonly SubmittedReview[],
  memberRefs: ReadonlyArray<{ repoId: string; number: string }>,
): CrossFindingSource[] | undefined {
  if (draftItems) return fromItems(draftItems);
  const memberKeys = new Set(memberRefs.map((ref) => `${ref.repoId}!${ref.number}`));
  const submitted = history
    .filter((record) => memberKeys.has(`${record.repoId}!${record.crNumber}`))
    .flatMap((record) => fromItems(record.items ?? []));
  return submitted.length > 0 ? submitted : undefined;
}
