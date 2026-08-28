/**
 * Wording helpers for the renderers. The nouns themselves always come from the
 * active provider (`platform/provider.ts` `Vocabulary`); this file only shapes
 * them for the position they appear in, plus the one phrase that is not a noun
 * and still has to read the same everywhere it appears.
 */
import type { Vocabulary } from '../platform/provider';

export type { Vocabulary };

/** Sentence-case a noun for a heading: "merge requests" → "Merge requests". */
export function cap(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** `1 merge request` / `3 merge requests` — the count decides the form. */
export function countOf(vocabulary: Vocabulary, count: number): string {
  return `${count} ${count === 1 ? vocabulary.changeRequestNoun : vocabulary.changeRequestNounPlural}`;
}

/** `1 project` / `4 projects`. */
export function repoCountOf(vocabulary: Vocabulary, count: number): string {
  return `${count} ${count === 1 ? vocabulary.repoNoun : vocabulary.repoNounPlural}`;
}

/**
 * "under a minute" / "about 12 minutes" / "about an hour" — a wait, rounded to
 * what a person would say. `undefined` when the platform reported no wait: a
 * made-up number is worse than none, because the user schedules around it.
 *
 * One spelling, because two surfaces show the same wait — the dashboard's
 * load failure and the status bar's paused segment — and two roundings of one
 * number read as two different facts.
 */
export function approxDelay(seconds: number | undefined): string | undefined {
  if (seconds === undefined || !Number.isFinite(seconds)) return undefined;
  if (seconds <= 90) return 'under a minute';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  return hours === 1 ? 'about an hour' : `about ${hours} hours`;
}
