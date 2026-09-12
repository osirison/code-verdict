/**
 * Where a finding's code sits *now* (handoff §6).
 *
 * One matcher serves three callers that used to guess separately: re-anchoring
 * after a force-push, marking which items went stale, and pointing the in-diff
 * editor decoration at a real line. All of them ask the same question — "the
 * agent read this text at line N; is it still there, and if not, where did it
 * go?" — so the answer lives here rather than in three UI layers.
 */

/**
 * A line of a candidate haystack: the file on disk, or one line the diff
 * makes addressable. `side` names which half of the diff the line's number
 * belongs to — 'new' (the default, and the only side `documentCandidates`
 * ever produces) for an added or context line, numbered in the file that
 * results; 'old' for a removed line, numbered in the file that preceded it.
 * The two are different numbering spaces over the same text — see
 * `resolveAnchor` for why they are never searched together.
 */
export interface AnchorCandidate {
  line: number;
  text: string;
  side?: 'old' | 'new';
}

export type AnchorState =
  /** The code is exactly where the agent read it. */
  | 'exact'
  /** The code still exists, but on a different line. */
  | 'moved'
  /** The code is gone — the author rewrote or deleted it. */
  | 'lost';

export interface AnchorResolution {
  state: AnchorState;
  /** The line the finding should now point at; the original when `lost`. */
  line: number;
  /** Which side `line` is numbered on. Absent when `state` is `lost`. */
  side?: 'old' | 'new';
}

/**
 * Comparison is whitespace-insensitive at the edges only: re-indentation is
 * not a moved anchor, but a changed statement is a lost one.
 */
function same(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Search one side's candidates only. `anchor.line` is always in the caller's
 * own space for that pass — pass 1 in `resolveAnchor` searches it against the
 * new side (where a `ReviewItem.line` is always recorded), pass 2 against the
 * old side. Mixing the two spaces in one nearest-match search would be
 * meaningless — old-side line 60 and new-side line 60 do not describe the
 * same place in the file — and a coincidental old-side hit closer in number
 * than the true new-side one would win the wrong match.
 */
function resolveOnSide(
  candidates: readonly AnchorCandidate[],
  anchor: { line: number; code: string },
): AnchorResolution | undefined {
  const code = anchor.code;
  const exact = candidates.find((c) => c.line === anchor.line && same(c.text, code));
  if (exact) return { state: 'exact', line: anchor.line, side: exact.side };
  let best: AnchorCandidate | undefined;
  for (const candidate of candidates) {
    if (!same(candidate.text, code)) continue;
    if (
      !best ||
      Math.abs(candidate.line - anchor.line) < Math.abs(best.line - anchor.line)
    ) {
      best = candidate;
    }
  }
  return best ? { state: 'moved', line: best.line, side: best.side } : undefined;
}

/**
 * Resolve one finding against the current text.
 *
 * When the code appears more than once (a repeated `return null;`), the match
 * nearest the original line wins — a finding drifts by a few lines far more
 * often than it teleports across the file.
 *
 * Two passes, never merged: every finding's recorded line is new-side
 * numbering, so the new side (additions and context — the code as it reads
 * today) is searched first. Only when nothing there matches does the old
 * side (removed lines) get a look, for the finding that is *about* a
 * deletion — the code it flags exists only in the file as it was. A finding
 * still exactly or nearly where it was read is therefore always resolved on
 * the new side, never on an old-side line that happens to share its number.
 */
export function resolveAnchor(
  candidates: readonly AnchorCandidate[],
  anchor: { line: number; code: string },
): AnchorResolution {
  if (anchor.code.trim() === '') return { state: 'lost', line: anchor.line };
  const newSide = candidates.filter((c) => (c.side ?? 'new') === 'new');
  const oldSide = candidates.filter((c) => c.side === 'old');
  return (
    resolveOnSide(newSide, anchor) ??
    resolveOnSide(oldSide, anchor) ?? { state: 'lost', line: anchor.line }
  );
}

/** The whole document as candidates — `text.split('\n')` with 1-based numbers. */
export function documentCandidates(text: string): AnchorCandidate[] {
  return text.split('\n').map((line, index) => ({ line: index + 1, text: line }));
}

/**
 * Which items no longer sit where the agent read them. Callers pass the
 * haystack per file, so this works for both a fetched diff and an open editor.
 */
export function movedAnchors<T extends { id: string; file: string; line: number; code: string }>(
  items: readonly T[],
  candidatesFor: (file: string) => readonly AnchorCandidate[] | undefined,
): Set<string> {
  const moved = new Set<string>();
  for (const item of items) {
    const candidates = candidatesFor(item.file);
    // No haystack for the file means the file left the diff entirely — the
    // anchor cannot be honoured, so the item counts as moved.
    if (!candidates) {
      moved.add(item.id);
      continue;
    }
    if (resolveAnchor(candidates, item).state !== 'exact') moved.add(item.id);
  }
  return moved;
}
