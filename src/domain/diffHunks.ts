/**
 * Unified-diff hunk parsing — shared by the demo agent (anchor selection)
 * and, later, the in-diff triage mode (issue #10).
 */
import { Memo, memoize } from './memo';

export interface HunkLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  oldLine?: number;
  newLine?: number;
  /**
   * 1-based index of this line inside the patch text itself, counting every
   * physical line including the `@@` headers and the metadata lines the parse
   * skips. `oldLine`/`newLine` say where a line sits in the *file*; this says
   * where it sits in the *patch*, which is the only coordinate a caller
   * holding the patch string can slice by.
   *
   * Added for `../app/harnessSynthesisVerification.ts`'s evidence excerpt: it
   * must cut a window of the exact patch bytes around a citation's file lines,
   * and a citation's range is in file lines. Without this, that module would
   * have to re-walk the patch with its own copy of the header regex and the
   * skip rules below — two parsers that could disagree about which line is
   * which. Optional so every existing `HunkLine` literal (the UI's fixtures)
   * stays valid unchanged; it is always set by `parseHunks` itself.
   */
  patchLine?: number;
}

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: HunkLine[];
}

const HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

/**
 * Memoized on the diff string (D10): the review flow calls this on every
 * render of the selected file, and most renders are triggered by state that
 * changed nothing about the diff itself. Returns the SAME `Hunk[]` on a
 * cache hit rather than a copy — safe because every caller only reads it
 * (`.flatMap`, `.filter`, `.map`); none mutates a hunk, a line, or the array
 * itself. Do not push, splice, sort or assign into a returned value — it may
 * be shared with another caller and with the next call for this same diff.
 */
export const parseHunks: (diff: string) => Hunk[] = memoize(parseHunksUncached);

function parseHunksUncached(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  // Split on either ending. `HEADER` is anchored at both ends, so a diff whose
  // lines end `\r\n` left a trailing `\r` on the header line, the match failed,
  // and every hunk in the file was silently dropped — no anchors, no line
  // numbers, an empty result indistinguishable from a diff with no hunks. The
  // same trailing `\r` would otherwise be baked into `HunkLine.text`, which
  // matters here because citation validation compares exact content.
  // `patchLine` counts every physical line of this split, including the ones
  // the body of the loop skips (metadata, `\ No newline`, blanks), because it
  // is a position in the patch string, not a position in `hunk.lines`. A
  // caller slicing the patch by these numbers must see the same line count
  // this split produces — it does: `\r\n` and `\n` are both one separator
  // here and one `\n` there, so the two agree line for line.
  let patchLine = 0;
  for (const raw of diff.split(/\r?\n/)) {
    patchLine += 1;
    const header = raw.match(HEADER);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        header: raw,
        lines: [],
      };
      oldLine = current.oldStart;
      newLine = current.newStart;
      hunks.push(current);
      continue;
    }
    if (!current || raw === '') continue;
    // "\ No newline at end of file" is metadata, not a context line —
    // counting it would shift every anchor after it by one.
    if (raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      current.lines.push({ kind: 'add', text: raw.slice(1), newLine, patchLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldLine, patchLine });
      oldLine += 1;
    } else {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine, patchLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

/** Added lines with their new-side line numbers — anchor candidates. */
export function addedLines(diff: string): Array<{ line: number; text: string }> {
  return parseHunks(diff).flatMap((h) =>
    h.lines
      .filter((l) => l.kind === 'add' && l.newLine !== undefined)
      .map((l) => ({ line: l.newLine as number, text: l.text })),
  );
}

/**
 * Every line a finding can legitimately anchor to in this diff: additions and
 * unchanged context, numbered on the new (resulting) file — the space every
 * `ReviewItem.line` is recorded in — plus removed lines, numbered on the old
 * file, for a finding that is about a deletion rather than a line that still
 * exists. Supersedes `addedLines` as the anchor candidate universe: an
 * addition is not the only line a comment can land on, GitHub accepts a
 * comment on any line inside a diff hunk on either side, and a finding whose
 * flagged statement sits on a context line (very common in a hunk that
 * rewrites only part of a function) was previously unable to anchor at all,
 * however exactly its recorded line and code matched the file.
 */
export function diffAnchorCandidates(
  diff: string,
): Array<{ line: number; text: string; side: 'old' | 'new' }> {
  const candidates: Array<{ line: number; text: string; side: 'old' | 'new' }> = [];
  for (const hunk of parseHunks(diff)) {
    for (const l of hunk.lines) {
      if ((l.kind === 'add' || l.kind === 'context') && l.newLine !== undefined) {
        candidates.push({ line: l.newLine, text: l.text, side: 'new' });
      } else if (l.kind === 'del' && l.oldLine !== undefined) {
        candidates.push({ line: l.oldLine, text: l.text, side: 'old' });
      }
    }
  }
  return candidates;
}

/**
 * Length-prefixes each diff before joining, so two different splits of the
 * same characters across files can never share a key — a bare join would
 * let `['a', 'bc']` and `['ab', 'c']` collide.
 */
function statsKey(diffs: string[]): string {
  return diffs.map((diff) => `${diff.length}:${diff}`).join('');
}

const statsCache = new Memo<{ added: number; removed: number }>();

/**
 * Memoized on the concatenated per-file keys (D10), for the same reason
 * `parseHunks` is: called on every render of a changeset or review-flow
 * summary line. Returns the SAME record on a cache hit; safe because every
 * caller only reads `.added`/`.removed`, never assigns into it.
 */
export function diffStats(diffs: string[]): { added: number; removed: number } {
  const key = statsKey(diffs);
  const cached = statsCache.get(key);
  if (cached !== undefined) return cached;
  let added = 0;
  let removed = 0;
  for (const diff of diffs) {
    for (const h of parseHunks(diff)) {
      for (const l of h.lines) {
        if (l.kind === 'add') added += 1;
        else if (l.kind === 'del') removed += 1;
      }
    }
  }
  const result = { added, removed };
  statsCache.set(key, result);
  return result;
}
