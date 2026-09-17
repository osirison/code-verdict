/**
 * The point of this sink is durability *during* a run, not after it: VS Code's own capture of an
 * output channel is buffered and lands minutes late, so a hung or looping review — exactly the one
 * worth reading — has no readable trace while it is happening. These tests hold it to that: the
 * line is on disk by the time `appendLine` returns, and no filesystem problem can propagate into
 * the review it is describing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceFileSink } from './agentTraceFile';

const created: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'verdict-trace-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop()!;
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Only the unwritable-directory test changes the mode; anything else is already removable.
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('createTraceFileSink', () => {
  it('has the line on disk by the time appendLine returns', () => {
    const dir = tempDir();
    const sink = createTraceFileSink({ dir });
    sink.appendLine('first');
    // Read immediately and synchronously — no await, no flush, no timer. A buffered writer fails here.
    expect(readFileSync(sink.filePath, 'utf8')).toBe('first\n');
    sink.appendLine('second');
    expect(readFileSync(sink.filePath, 'utf8')).toBe('first\nsecond\n');
  });

  it('creates the directory it was given', () => {
    const dir = join(tempDir(), 'nested', 'deeper');
    const sink = createTraceFileSink({ dir });
    sink.appendLine('line');
    expect(existsSync(sink.filePath)).toBe(true);
  });

  it('forwards every line to the output channel as well, so the panel is unchanged', () => {
    const dir = tempDir();
    const lines: string[] = [];
    const sink = createTraceFileSink({ dir, inner: { appendLine: (line) => lines.push(line) } });
    sink.appendLine('a');
    sink.appendLine('b');
    expect(lines).toEqual(['a', 'b']);
  });

  it('still forwards to the output channel when the file cannot be written', () => {
    const dir = tempDir();
    // A file where the directory should be: every write beneath it fails, on every platform.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const lines: string[] = [];
    const sink = createTraceFileSink({ dir: join(blocked, 'sub'), inner: { appendLine: (line) => lines.push(line) } });
    expect(() => sink.appendLine('survives')).not.toThrow();
    expect(lines).toEqual(['survives']);
  });

  it('rotates past its size bound and keeps exactly one previous file', () => {
    const dir = tempDir();
    const sink = createTraceFileSink({ dir, maxBytes: 64 });
    for (let i = 0; i < 12; i += 1) sink.appendLine(`line ${i} ${'x'.repeat(20)}`);
    const current = readFileSync(sink.filePath, 'utf8');
    const previous = readFileSync(`${sink.filePath}.1`, 'utf8');
    // The newest line is in the live file, an older one survives in the rotated file, and nothing
    // beyond those two generations is kept.
    expect(current).toContain('line 11');
    expect(previous.length).toBeGreaterThan(0);
    expect(existsSync(`${sink.filePath}.2`)).toBe(false);
  });

  it('names the file it writes, so a caller can point a reviewer at it', () => {
    const dir = tempDir();
    expect(createTraceFileSink({ dir }).filePath).toBe(join(dir, 'agent-trace.log'));
    expect(createTraceFileSink({ dir, fileName: 'other.log' }).filePath).toBe(join(dir, 'other.log'));
  });
});
