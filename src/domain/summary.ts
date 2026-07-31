/**
 * Summary-comment composition (spec §7): generated from the accepted set,
 * voice follows `codeVerdict.agentVoice`.
 *
 * Composition: "Reviewed with <agent>." then, when blockers were accepted,
 * "N blockers: <title> (<file>:<line>); …. Needs a fix before merge." then
 * "N smaller items posted inline." then "N findings dismissed as false
 * positives."
 */
import type { Review } from './types';

export type AgentVoice = 'terse' | 'explanatory' | 'blunt';

export function composeSummary(review: Review, agentLabel: string, voice: AgentVoice): string {
  const accepted = review.items.filter((i) => review.verdicts[i.id]?.verdict === 'accepted');
  const rejected = review.items.filter((i) => review.verdicts[i.id]?.verdict === 'rejected');
  const blockers = accepted.filter((i) => i.severity === 'blocker');
  const smaller = accepted.length - blockers.length;

  if (voice === 'blunt') {
    const parts = [
      blockers.length > 0
        ? `${blockers.length} ${plural(blockers.length, 'blocker')}. Fix before merge.`
        : 'No blockers.',
    ];
    if (smaller > 0) parts.push(`${smaller} inline ${plural(smaller, 'comment')}.`);
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
  if (smaller > 0) {
    parts.push(`${smaller} smaller ${plural(smaller, 'item')} posted inline.`);
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
