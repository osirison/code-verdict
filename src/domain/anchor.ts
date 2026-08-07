/**
 * Where a finding's code sits *now* (handoff §6).
 *
 * One matcher serves three callers that used to guess separately: re-anchoring
 * after a force-push, marking which items went stale, and pointing the in-diff
 * editor decoration at a real line. All of them ask the same question — "the
 * agent read this text at line N; is it still there, and if not, where did it
 * go?" — so the answer lives here rather than in three UI layers.
 */

/** A line of a candidate haystack: the file on disk, or the added lines of a diff. */
export interface AnchorCandidate {
  line: number;
  text: string;
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
}

/**
 * Comparison is whitespace-insensitive at the edges only: re-indentation is
 * not a moved anchor, but a changed statement is a lost one.
 */
function same(a: string, b: string): boolean {
  return a.trim() === b.trim();
}

/**
 * Resolve one finding against the current text.
 *
 * When the code appears more than once (a repeated `return null;`), the match
 * nearest the original line wins — a finding drifts by a few lines far more
 * often than it teleports across the file.
 */
export function resolveAnchor(
  candidates: readonly AnchorCandidate[],
  anchor: { line: number; code: string },
): AnchorResolution {
  const code = anchor.code;
  if (code.trim() === '') return { state: 'lost', line: anchor.line };
  if (candidates.some((c) => c.line === anchor.line && same(c.text, code))) {
    return { state: 'exact', line: anchor.line };
  }
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
  return best ? { state: 'moved', line: best.line } : { state: 'lost', line: anchor.line };
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
