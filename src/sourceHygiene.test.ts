/**
 * A raw control byte in a source file is invisible in an editor, makes `grep`
 * silently return nothing, and makes git treat the file as binary so the diff
 * disappears from review. Two separate passes of the agentic-harness work
 * wrote one by accident (a NUL meant as a cache-key separator, and a control
 * character class written into a regex literal), and neither was caught by
 * the type checker, the linter, or any test — so this checks the bytes.
 *
 * Tabs, newlines, and carriage returns are the only control characters a
 * source file has any reason to contain.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'emulator'];
const ALLOWED = new Set([0x09, 0x0a, 0x0d]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

describe('source hygiene', () => {
  it('has no raw control bytes in any TypeScript source', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const path of sourceFiles(root)) {
        const bytes = readFileSync(path);
        for (let i = 0; i < bytes.length; i += 1) {
          const byte = bytes[i] as number;
          if ((byte < 0x20 || byte === 0x7f) && !ALLOWED.has(byte)) {
            const line = bytes.subarray(0, i).toString('utf8').split('\n').length;
            offenders.push(`${path}:${line} contains byte 0x${byte.toString(16).padStart(2, '0')}`);
            break;
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
