/**
 * Summary-comment composition (spec §7): generated from the accepted set,
 * voice follows `codeVerdict.agentVoice`.
 *
 * Composition: "Reviewed with <agent>." then, when blockers were accepted,
 * "N blockers: <title> (<file>:<line>); …. Needs a fix before merge." then
 * "N smaller items posted inline." then, when some accepted item could not be
 * anchored to the diff, "M findings could not be anchored to the diff — see
 * below." then "N findings dismissed as false positives."
 *
 * The "posted inline"/"could not be anchored" pair is computed from
 * `withheldInline` — the same anchor-resolution result `composeCommentDrafts`
 * produces — never from the verdict tally alone. A caller that generates this
 * text before submitting must pass the composition it already has: reporting
 * "posted inline" for an item that anchor resolution is about to withhold is
 * exactly the false headline this function exists to never write (a real
 * incident: 5 accepted findings, all withheld for want of a current diff-line
 * match, summarized as "5 smaller items posted inline" because this function
 * only ever consulted verdicts). Blockers are named individually in their own
 * sentence regardless of anchor outcome — that list carries no "posted
 * inline" claim to get wrong — but a withheld blocker still counts toward
 * "could not be anchored": that count promises the body has a withheld
 * section worth reading, and a blocker withheld there is exactly such a
 * thing, so leaving it out would make the promise false in the other
 * direction.
 */
import type { Review, ReviewItem } from './types';
import { isReviewItemAnchored } from './types';

export type AgentVoice = 'terse' | 'explanatory' | 'blunt';

export function composeSummary(
  review: Review,
  agentLabel: string,
  voice: AgentVoice,
  withheldInline: readonly ReviewItem[] = [],
): string {
  const accepted = review.items.filter((i) => review.verdicts[i.id]?.verdict === 'accepted');
  const rejected = review.items.filter((i) => review.verdicts[i.id]?.verdict === 'rejected');
  const blockers = accepted.filter((i) => i.severity === 'blocker');
  const notPostedIds = new Set([
    ...accepted.filter((i) => !isReviewItemAnchored(i)).map((i) => i.id),
    ...withheldInline.map((i) => i.id),
  ]);
  // "Smaller" (the "posted inline" count) excludes blockers, which the
  // headline already names individually — but "could not be anchored" counts
  // every accepted item the body's withheld sections will list, blockers
  // included, so the count matches what is actually below it.
  const smallerAccepted = accepted.filter((i) => i.severity !== 'blocker');
  const smallerPosted = smallerAccepted.filter((i) => !notPostedIds.has(i.id)).length;
  const totalNotPosted = accepted.filter((i) => notPostedIds.has(i.id)).length;

  if (voice === 'blunt') {
    const parts = [
      blockers.length > 0
        ? `${blockers.length} ${plural(blockers.length, 'blocker')}. Fix before merge.`
        : 'No blockers.',
    ];
    if (smallerPosted > 0) parts.push(`${smallerPosted} inline ${plural(smallerPosted, 'comment')}.`);
    if (totalNotPosted > 0) parts.push(`${totalNotPosted} unanchored.`);
    if (rejected.length > 0)
      parts.push(`${rejected.length} ${plural(rejected.length, 'false positive')} binned.`);
    return parts.join(' ');
  }

  const parts: string[] = [`Reviewed with ${agentLabel}.`];
  if (blockers.length > 0) {
    const list = blockers
      .map((b) => `${lowerFirst(b.title)} (${shortFile(b.file)}:${b.line})`)
      .join('; ');
    parts.push(`${blockers.length} ${plural(blockers.length, 'blocker')}: ${list}. Needs a fix before merge.`);
  }
  if (smallerPosted > 0) {
    parts.push(`${smallerPosted} smaller ${plural(smallerPosted, 'item')} posted inline.`);
  }
  if (totalNotPosted > 0) {
    parts.push(`${totalNotPosted} ${plural(totalNotPosted, 'finding')} could not be anchored to the diff — see below.`);
  }
  if (rejected.length > 0) {
    parts.push(`${rejected.length} ${plural(rejected.length, 'finding')} dismissed as false positives.`);
  }

  if (voice === 'explanatory') {
    parts.push(
      'Each inline comment carries the reasoning and, where the agent proposed one, an applyable suggestion.',
    );
  }
  return parts.join(' ');
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function lowerFirst(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function shortFile(path: string): string {
  return path.split('/').pop() ?? path;
}
