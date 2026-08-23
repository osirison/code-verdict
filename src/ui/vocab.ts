/**
 * Vocabulary helpers for the renderers. The nouns themselves always come from
 * the active provider (`platform/provider.ts` `Vocabulary`); this file only
 * shapes them for the position they appear in.
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
