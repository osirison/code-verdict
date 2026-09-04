/**
 * Wording helpers for the renderers. The nouns themselves always come from the
 * active provider (`platform/provider.ts` `Vocabulary`); this file only shapes
 * them for the position they appear in, plus the one phrase that is not a noun
 * and still has to read the same everywhere it appears.
 */
import type { Vocabulary } from '../platform/provider';
import type { RunLifecycle } from '../domain/harnessLifecycle';

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

/**
 * `0:42`, `12:07` — a stopwatch, not a duration phrase. One spelling for
 * every surface that ticks a run's elapsed time (the active review screen
 * and the sidebar's active-run list, design.md D14: "every surface projects
 * the same current truth") — two independent formatters over the same
 * millisecond count is exactly how they could read a run's age differently.
 */
export function elapsedClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * The compact, public label for a `RunProjection.lifecycle` value (task
 * 14.1/14.3, design.md D14). One spelling shared by the active review
 * screen and the sidebar's active-run list — two label maps over the same
 * lifecycle value is exactly how the two could disagree about what a run is
 * doing right now.
 */
export function runLifecycleLabel(lifecycle: RunLifecycle): string {
  switch (lifecycle) {
    case 'queued':
      return 'Queued';
    case 'planning':
      return 'Planning';
    case 'investigating':
      return 'Investigating';
    case 'verifying':
      return 'Verifying';
    case 'completing':
      return 'Completing';
    case 'waiting':
      return 'Waiting';
    case 'paused':
      return 'Paused';
    case 'resuming':
      return 'Resuming';
    case 'cancelling':
      return 'Cancelling';
    case 'cancelled':
      return 'Cancelled';
    case 'succeeded':
      return 'Succeeded';
    case 'failed':
      return 'Failed';
    case 'interrupted':
      return 'Interrupted';
    default: {
      const exhaustive: never = lifecycle;
      return exhaustive;
    }
  }
}
