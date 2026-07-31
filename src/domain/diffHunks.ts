/**
 * Unified-diff hunk parsing — shared by the demo agent (anchor selection)
 * and, later, the in-diff triage mode (issue #10).
 */
export interface HunkLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  oldLine?: number;
  newLine?: number;
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

export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const raw of diff.split('\n')) {
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
      current.lines.push({ kind: 'add', text: raw.slice(1), newLine });
      newLine += 1;
    } else if (raw.startsWith('-')) {
      current.lines.push({ kind: 'del', text: raw.slice(1), oldLine });
      oldLine += 1;
    } else {
      current.lines.push({ kind: 'context', text: raw.slice(1), oldLine, newLine });
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

export function diffStats(diffs: string[]): { added: number; removed: number } {
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
  return { added, removed };
}
