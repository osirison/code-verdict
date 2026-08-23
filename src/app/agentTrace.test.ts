import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTrace, type AgentTraceSink } from './agentTrace';

// AgentTrace imports nothing from `vscode` — these tests prove that: no
// `vi.mock('vscode', ...)` anywhere in this file, just a plain in-memory sink.
function sink(): AgentTraceSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string): void {
      lines.push(line);
    },
  };
}

describe('AgentTrace', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Explicit UTC instant so the ISO string assertions below don't depend on the runner's timezone.
    vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('logs start with the request id, model vendor/family and an ISO start time', () => {
    const s = sink();
    new AgentTrace(s, 'req1', 'acme', 'turbo');
    expect(s.lines).toEqual(['[req1] start 2026-08-22T12:00:00.000Z vendor=acme family=turbo']);
  });

  it('logs the prompt actually sent, with its length', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.prompt('hello world');
    expect(s.lines[1]).toBe('[req1] prompt (11 chars):\nhello world');
  });

  it('accumulates fragment counts and elapsed time, returning the progress snapshot', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    vi.advanceTimersByTime(1_500);
    const p1 = trace.fragment('abc');
    expect(p1).toEqual({ requestId: 'req1', fragmentsReceived: 1, charsReceived: 3, elapsedMs: 1_500 });

    vi.advanceTimersByTime(500);
    const p2 = trace.fragment('de');
    expect(p2).toEqual({ requestId: 'req1', fragmentsReceived: 2, charsReceived: 5, elapsedMs: 2_000 });

    expect(s.lines[1]).toBe('[req1] +1500ms fragment #1 (+3 chars, 3 total)');
    expect(s.lines[2]).toBe('[req1] +2000ms fragment #2 (+2 chars, 5 total)');
  });

  it('records the raw text before JSON extraction and the parse outcome, for both success and failure', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    trace.rawText('{"a":1}', true);
    expect(s.lines[1]).toBe('[req1] raw text before JSON extraction (7 chars, parsed OK):\n{"a":1}');

    trace.rawText('nonsense', false, 'no JSON object found');
    expect(s.lines[2]).toBe('[req1] raw text before JSON extraction (8 chars, parse FAILED: no JSON object found):\nnonsense');
  });

  it('logs success with elapsed time, item count and fragment count', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.fragment('x');
    vi.advanceTimersByTime(250);
    trace.success(3);
    expect(s.lines.at(-1)).toBe('[req1] done in 250ms: 3 item(s) across 1 fragment(s)');
  });

  it('logs failure, tagging which limit was hit when a timeout caused it', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    vi.advanceTimersByTime(60_000);
    trace.failure('agent stalled: no output for 60s', 'inactivity');
    expect(s.lines.at(-1)).toBe('[req1] failed after 60000ms (inactivity limit): agent stalled: no output for 60s');

    // Non-timeout failures (bad contract, no model, network) omit the limit tag entirely.
    const s2 = sink();
    const trace2 = new AgentTrace(s2, 'req2', 'acme', 'turbo');
    trace2.failure('agent response did not match the contract: boom');
    expect(s2.lines.at(-1)).toBe('[req2] failed after 0ms: agent response did not match the contract: boom');
  });
});
