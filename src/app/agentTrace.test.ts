import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTrace, type AgentTraceSink } from './agentTrace';
import { sha256Hex } from './contentDigest';

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

  it('logs the prompt as a byte count and digest, never the text itself (task 15.6, design.md D13)', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.prompt('hello world');
    expect(s.lines[1]).toBe(`[req1] prompt (11 bytes, sha256=${sha256Hex('hello world')})`);
    expect(s.lines[1]).not.toContain('hello world');
  });

  it('the prompt digest is byte-accurate for multi-byte UTF-8 text, not a UTF-16 code-unit count', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    const text = 'café 日本語';
    // 8 UTF-16 code units, but more UTF-8 bytes (é and each CJK character take more than one byte)
    // — proves the byte count is real, not `.length` relabelled.
    expect(text.length).toBe(8);
    expect(Buffer.byteLength(text, 'utf8')).toBeGreaterThan(text.length);
    trace.prompt(text);
    expect(s.lines[1]).toBe(`[req1] prompt (${Buffer.byteLength(text, 'utf8')} bytes, sha256=${sha256Hex(text)})`);
  });

  it('two different prompts produce two different digest lines — the digest is still useful for telling them apart', () => {
    const s1 = sink();
    new AgentTrace(s1, 'req1', 'acme', 'turbo').prompt('prompt one');
    const s2 = sink();
    new AgentTrace(s2, 'req2', 'acme', 'turbo').prompt('prompt two');
    expect(s1.lines[1]).not.toBe(s2.lines[1]);

    // And a repeated identical prompt digests identically — the property a developer actually
    // uses a digest for: confirming a retry sent byte-identical content.
    const s3 = sink();
    new AgentTrace(s3, 'req3', 'acme', 'turbo').prompt('prompt one');
    const withoutRequestId = (line: string) => line.replace(/^\[[^\]]+]\s*/, '');
    expect(withoutRequestId(s3.lines[1] as string)).toBe(withoutRequestId(s1.lines[1] as string));
  });

  it('accumulates fragment counts and elapsed time, returning the progress snapshot — never logs a fragment\'s own text', () => {
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
    expect(s.lines[1]).not.toContain('abc');
    expect(s.lines[2]).not.toContain('de');
  });

  it('records the response as a byte count, digest and parse outcome, for both success and failure — never the text itself', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    trace.response('{"a":1}', true);
    expect(s.lines[1]).toBe(`[req1] response (7 bytes, sha256=${sha256Hex('{"a":1}')}), parsed OK`);

    trace.response('nonsense', false, 'no JSON object found');
    expect(s.lines[2]).toBe(`[req1] response (8 bytes, sha256=${sha256Hex('nonsense')}), parse FAILED: no JSON object found`);

    expect(s.lines[1]).not.toContain('{"a":1}');
    expect(s.lines[2]).not.toContain('nonsense');
  });

  it('bounds and redacts a long or secret-shaped parse-failure detail through the shared sanitizer, rather than forwarding it verbatim', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.response('x', false, `Bearer sk-live-abcdefghijklmnop ${'padding '.repeat(60)}`);
    const line = s.lines[1] as string;
    expect(line).toContain('parse FAILED:');
    expect(line).not.toContain('sk-live-abcdefghijklmnop');
    expect(line).toContain('[REDACTED]');
    expect(line.length).toBeLessThan(400);
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

  it('redacts a secret embedded in a failure message before it reaches the sink', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.failure('request failed: token=abcd1234efgh5678');
    const line = s.lines.at(-1) as string;
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('abcd1234efgh5678');
  });
});

describe('AgentTrace (task 15.6, design.md D13): the marker test — no secret, raw prompt, or raw model fragment ever reaches the sink', () => {
  it('walks every line the sink received across a full request lifecycle and finds none of the planted prohibited markers', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    // Marker 1: a full "raw prompt" — far longer than any legitimate metadata field, and never
    // meant to reach the sink at all now that `prompt()` emits size+digest only.
    const PROMPT_MARKER = 'MARKER_RAW_PROMPT_7f3a2b1c';
    const rawPrompt = `${'You are a code review agent. '.repeat(50)}${PROMPT_MARKER}`;
    trace.prompt(rawPrompt);

    // Marker 2: a streamed fragment of the model's own output — `fragment()` must never log the
    // fragment text, only its length.
    const FRAGMENT_MARKER = 'MARKER_MODEL_FRAGMENT_9c1d4e2a';
    trace.fragment(`{"schemaVersion":"1","title":"${FRAGMENT_MARKER}"}`);

    // Marker 3: the full raw response text collected before JSON extraction — a parse failure is
    // exactly the path issue #35 used to dump this on.
    const RESPONSE_MARKER = 'MARKER_RAW_RESPONSE_5e8b3f1d';
    const rawResponse = `Sure, here is my review: ${RESPONSE_MARKER}, no JSON here.`;
    trace.response(rawResponse, false, 'no JSON object found');

    // Marker 4: a secret embedded in a failure message — must be redacted, not merely present.
    // Same standalone `Bearer <token>` shape `harnessCheckpoint.test.ts`'s own marker test uses.
    const SECRET_MARKER = 'MARKER_SECRET_3a9f2b7c';
    trace.failure(`request failed: Bearer sk-live-${SECRET_MARKER}1234567890abcd`);

    // Marker 5: a raw model fragment smuggled as a parse-failure `detail` (the shape a caller
    // could produce by forwarding a raw parser message) — the shared sanitizer bounds/redacts it,
    // but it is never expected to *equal* raw content; plant it past the 240-char sanitizer bound
    // so its survival would prove the length bound was not applied, the same technique
    // `harnessCheckpoint.test.ts`'s marker test uses.
    const DETAIL_MARKER = 'MARKER_PARSE_DETAIL_BLOB_2d6a1c9e';
    const longDetail = `${'Unexpected token, raw content: '.repeat(20)}${DETAIL_MARKER}`;
    trace.response('some other response text', false, longDetail);

    const serialized = s.lines.join('\n');

    expect(serialized).not.toContain(PROMPT_MARKER);
    expect(serialized).not.toContain(rawPrompt);
    expect(serialized).not.toContain(FRAGMENT_MARKER);
    expect(serialized).not.toContain(RESPONSE_MARKER);
    expect(serialized).not.toContain(rawResponse);
    expect(serialized).not.toContain(SECRET_MARKER);
    expect(serialized).not.toContain('sk-live-');
    expect(serialized).not.toContain(DETAIL_MARKER);

    // Every line stays a bounded metadata line — proof this is structural (size+digest+outcome),
    // not merely that these five particular markers happened not to match a redaction pattern.
    for (const line of s.lines) expect(line.length).toBeLessThan(500);
  });
});
