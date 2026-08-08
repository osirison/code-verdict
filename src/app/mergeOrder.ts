/**
 * Merge order "derived from what each MR reads and writes" (handoff §16).
 * The only machine-readable read/write signal is a cross-repo finding's
 * `spans`: by convention `spans[0]` is the side that changes the contract
 * (the writer) and the later spans still read it. The writer must land
 * first — merging the reader's fix before the rename exists breaks it —
 * so each span pair contributes a writer-before-reader constraint.
 *
 * Members no finding constrains keep detection order, and their reason
 * falls back to the description's second paragraph (the fixture MRs carry
 * their "declares the new TTL…" prose there). No signal → no reason line,
 * never an invented one.
 */
import type { ReviewItem } from '../domain/types';

interface MemberShape {
  ref: { repoId: string; number: string };
  description?: string;
}

export interface MergeOrderStep<M extends MemberShape> {
  member: M;
  reason?: string;
}

type CrossShape = Pick<ReviewItem, 'cross' | 'spans'>;

export function deriveMergeOrder<M extends MemberShape>(
  members: readonly M[],
  crossItems: readonly CrossShape[],
): Array<MergeOrderStep<M>> {
  const indexOfRepo = (repoId: string): number => members.findIndex((member) => member.ref.repoId === repoId);

  // writer index -> reader indexes, plus the span role that constrained each side.
  const edges = new Map<number, Set<number>>();
  const roles = new Map<number, string>();
  for (const item of crossItems) {
    if (!item.cross || !item.spans || item.spans.length < 2) continue;
    const [writerSpan, ...readerSpans] = item.spans;
    if (!writerSpan) continue;
    const writer = indexOfRepo(writerSpan.repoId);
    if (writer < 0) continue;
    if (!roles.has(writer)) roles.set(writer, writerSpan.role);
    for (const readerSpan of readerSpans) {
      const reader = indexOfRepo(readerSpan.repoId);
      if (reader < 0 || reader === writer) continue;
      if (!roles.has(reader)) roles.set(reader, readerSpan.role);
      (edges.get(writer) ?? edges.set(writer, new Set()).get(writer))?.add(reader);
    }
  }

  // Stable topological order: among the unblocked members, always take the
  // one detection listed first. A contradictory pair of findings must not
  // hide members — break the cycle by falling back to detection order.
  const remainingBlockers = members.map((_, index) =>
    [...edges.entries()].filter(([, readers]) => readers.has(index)).length,
  );
  const placed = new Set<number>();
  const order: number[] = [];
  while (order.length < members.length) {
    let next = members.findIndex((_, index) => !placed.has(index) && remainingBlockers[index] === 0);
    if (next < 0) next = members.findIndex((_, index) => !placed.has(index));
    if (next < 0) break;
    placed.add(next);
    order.push(next);
    for (const reader of edges.get(next) ?? []) {
      remainingBlockers[reader] = Math.max(0, (remainingBlockers[reader] ?? 1) - 1);
    }
  }

  return order.map((index) => {
    const member = members[index] as M;
    const reason = roles.get(index) ?? (member.description?.split(/\n\s*\n/)[1]?.trim() || undefined);
    return reason ? { member, reason } : { member };
  });
}
