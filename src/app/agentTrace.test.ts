import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTrace, STALL_GAP_MS, type AgentTraceSink } from './agentTrace';
import { sha256Hex } from './contentDigest';
import { withDecodedForms } from '../testing/secretScan';

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

// Every line now leads with a local time-of-day (`HH:MM:SS.mmm`) — asserted by shape, in the tests
// below that check that directly, never by exact digits: the local rendering depends on the test
// runner's own time zone even though `vi.setSystemTime` below fixes the UTC instant. The bulk of
// this file's assertions care about everything *after* that prefix, unchanged from before this
// class grew one — `stripTime` strips it so those assertions read exactly as they did.
const TIME = String.raw`\d{2}:\d{2}:\d{2}\.\d{3}`;
const LEADING_TIME = new RegExp(`^${TIME} `);
function stripTime(line: string | undefined): string {
  return (line ?? '').replace(LEADING_TIME, '');
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

  it('logs start with the request id, model vendor/family and an ISO start time, led by the local time-of-day', () => {
    const s = sink();
    new AgentTrace(s, 'req1', 'acme', 'turbo');
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]).toMatch(LEADING_TIME);
    expect(stripTime(s.lines[0])).toBe('[req1] start 2026-08-22T12:00:00.000Z vendor=acme family=turbo');
  });

  it('logs the prompt as a byte count and digest, never the text itself (task 15.6, design.md D13)', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.prompt('hello world');
    expect(stripTime(s.lines[1])).toBe(`[req1] prompt (11 bytes, sha256=${sha256Hex('hello world')})`);
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
    expect(stripTime(s.lines[1])).toBe(`[req1] prompt (${Buffer.byteLength(text, 'utf8')} bytes, sha256=${sha256Hex(text)})`);
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
    const withoutRequestId = (line: string) => stripTime(line).replace(/^\[[^\]]+]\s*/, '');
    expect(withoutRequestId(s3.lines[1] as string)).toBe(withoutRequestId(s1.lines[1] as string));
  });

  it('accumulates fragment counts and elapsed time, returning the progress snapshot on every call — including the calls that log nothing', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    vi.advanceTimersByTime(1_500);
    const p1 = trace.fragment('abc');
    expect(p1).toEqual({ requestId: 'req1', fragmentsReceived: 1, charsReceived: 3, elapsedMs: 1_500 });

    vi.advanceTimersByTime(500);
    const p2 = trace.fragment('de');
    expect(p2).toEqual({ requestId: 'req1', fragmentsReceived: 2, charsReceived: 5, elapsedMs: 2_000 });

    // The quiet calls return exactly what a logging one does. `lmAgent.ts` hands this snapshot
    // straight to `onProgress`, so the running screen's counters must keep climbing at the stream's
    // own rate no matter how little of that rate reaches the sink.
    vi.advanceTimersByTime(250);
    const p3 = trace.fragment('fgh');
    expect(p3).toEqual({ requestId: 'req1', fragmentsReceived: 3, charsReceived: 8, elapsedMs: 2_250 });

    vi.advanceTimersByTime(STALL_GAP_MS + 1);
    const p4 = trace.fragment('STALLTEXT');
    expect(p4).toEqual({ requestId: 'req1', fragmentsReceived: 4, charsReceived: 17, elapsedMs: 2_250 + STALL_GAP_MS + 1 });

    // Neither emission path ever carries the fragment's own text — not the first-fragment line,
    // not the stall line p4 just triggered.
    expect(s.lines.join('\n')).not.toContain('abc');
    expect(s.lines.join('\n')).not.toContain('STALLTEXT');
  });

  it('logs the first fragment as the time to first token, then stays silent while the cadence is normal', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    vi.advanceTimersByTime(1_500);
    trace.fragment('abc');
    expect(stripTime(s.lines[1])).toBe('[req1] +1500ms fragment #1 (+3 chars, 3 total) — time to first token');

    // 660 more fragments at a live stream's real cadence (the measured p99 gap between fragments is
    // 191ms) add nothing at all to the sink — one line per token was 37% of a 3.7MB trace file.
    for (let i = 0; i < 660; i += 1) {
      vi.advanceTimersByTime(200);
      trace.fragment('xy');
    }
    expect(s.lines).toHaveLength(2);
  });

  it('names a gap that exceeds the stall threshold, then goes quiet again as soon as the cadence recovers', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.fragment('a');
    vi.advanceTimersByTime(200);
    trace.fragment('b');
    expect(s.lines).toHaveLength(2);

    vi.advanceTimersByTime(31_200);
    trace.fragment('c');
    expect(s.lines).toHaveLength(3);
    expect(stripTime(s.lines[2])).toBe('[req1] +31400ms fragment #3 (+1 chars, 3 total) — stall: 31200ms since fragment #2');

    // The gap is measured against the previous fragment, not the last logged one, so recovery is
    // silent again — one stall does not make every fragment after it noisy.
    for (let i = 0; i < 20; i += 1) {
      vi.advanceTimersByTime(150);
      trace.fragment('d');
    }
    expect(s.lines).toHaveLength(3);

    // A gap exactly at the threshold is not yet a stall; one millisecond past it is.
    vi.advanceTimersByTime(STALL_GAP_MS);
    trace.fragment('e');
    expect(s.lines).toHaveLength(3);
    vi.advanceTimersByTime(STALL_GAP_MS + 1);
    trace.fragment('f');
    expect(s.lines).toHaveLength(4);
    expect(stripTime(s.lines[3])).toContain(`— stall: ${STALL_GAP_MS + 1}ms since fragment #`);
  });

  it('a stalling stream costs at most one line per stall window, however pathological it gets', () => {
    // The volume problem must not come back in a different shape. The threshold is itself the rate
    // limit: a stall line needs STALL_GAP_MS of silence in front of it, so the worst case over a
    // ten-minute ceiling window is 60 lines, not one per token.
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.fragment('first');
    for (let i = 0; i < 60; i += 1) {
      vi.advanceTimersByTime(STALL_GAP_MS + 1);
      trace.fragment('slow');
      // A burst after each stall, the shape a stuttering stream actually has — 361 fragments in
      // all, and the sink sees 62 lines.
      for (let burst = 0; burst < 5; burst += 1) {
        vi.advanceTimersByTime(50);
        trace.fragment('fast');
      }
    }
    expect(s.lines).toHaveLength(1 + 1 + 60);
    trace.done();
    expect(stripTime(s.lines.at(-1))).toContain('across 361 fragment(s)');
  });

  it('records the response as a byte count, digest and parse outcome, for both success and failure — never the text itself', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');

    trace.response('{"a":1}', true);
    expect(stripTime(s.lines[1])).toBe(`[req1] response (7 bytes, sha256=${sha256Hex('{"a":1}')}), parsed OK`);

    trace.response('nonsense', false, 'no JSON object found');
    expect(stripTime(s.lines[2])).toBe(`[req1] response (8 bytes, sha256=${sha256Hex('nonsense')}), parse FAILED: no JSON object found`);

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
    expect(stripTime(s.lines.at(-1))).toBe('[req1] done in 250ms: 3 item(s) across 1 fragment(s)');
  });

  it('the closing summary still counts every fragment, including the hundreds that logged nothing', () => {
    // The totals line is the only place the full fragment count survives now, so it has to be the
    // honest one — a reviewer reading a two-line request must still be able to tell a 700-fragment
    // stream from a 3-fragment one.
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    for (let i = 0; i < 700; i += 1) {
      vi.advanceTimersByTime(100);
      trace.fragment('xy');
    }
    trace.done();
    expect(stripTime(s.lines.at(-1))).toBe('[req1] done in 70000ms across 700 fragment(s)');
    // Two lines for the whole stream: the start line and the time-to-first-token line.
    expect(s.lines).toHaveLength(3);

    const s2 = sink();
    const trace2 = new AgentTrace(s2, 'req2', 'acme', 'turbo');
    for (let i = 0; i < 700; i += 1) {
      vi.advanceTimersByTime(100);
      trace2.fragment('xy');
    }
    vi.advanceTimersByTime(250);
    trace2.success(4);
    expect(stripTime(s2.lines.at(-1))).toBe('[req2] done in 70250ms: 4 item(s) across 700 fragment(s)');
  });

  it('logs failure, tagging which limit was hit when a timeout caused it, and how much had arrived before it', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    // A stream that produced 300 fragments and then died is a different diagnosis from one that
    // never produced any, and the failure line is the only line a failed run ends on — it never
    // reaches `done`/`success`, and there are no per-fragment lines above it to read the totals off
    // any more.
    for (let i = 0; i < 300; i += 1) {
      vi.advanceTimersByTime(100);
      trace.fragment('ab');
    }
    vi.advanceTimersByTime(30_000);
    trace.failure('agent stalled: no output for 60s', 'inactivity');
    expect(stripTime(s.lines.at(-1))).toBe(
      '[req1] failed after 60000ms (inactivity limit), 300 fragment(s) and 600 chars received: agent stalled: no output for 60s',
    );

    // Non-timeout failures (bad contract, no model, network) omit the limit tag entirely, and a run
    // that produced nothing at all says so in the same place rather than staying silent about it.
    const s2 = sink();
    const trace2 = new AgentTrace(s2, 'req2', 'acme', 'turbo');
    trace2.failure('agent response did not match the contract: boom');
    expect(stripTime(s2.lines.at(-1))).toBe(
      '[req2] failed after 0ms, 0 fragment(s) and 0 chars received: agent response did not match the contract: boom',
    );
  });

  it('redacts a secret embedded in a failure message before it reaches the sink', () => {
    const s = sink();
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo');
    trace.failure('request failed: token=abcd1234efgh5678');
    const line = s.lines.at(-1) as string;
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain('abcd1234efgh5678');
  });

  it('the clock is injected: every line and every elapsed-time reading come from the constructor\'s own `now`, never a bare Date.now() read', () => {
    const s = sink();
    // A fixed instant unrelated to `vi.setSystemTime` above — proves the leading time-of-day comes
    // from this injected clock, not from a global one this class reads inline.
    const fixed = new Date();
    fixed.setHours(14, 30, 0, 500);
    let ticks = 0;
    const now = () => fixed.getTime() + ticks;
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo', now);
    expect(s.lines[0]).toMatch(/^14:30:00\.500 /);

    ticks = 2_000;
    trace.done();
    expect(s.lines[1]).toMatch(/^14:30:02\.500 \[req1] done in 2000ms across 0 fragment\(s\)$/);
  });
});

describe('AgentTrace (task 15.6, design.md D13): the marker test — no secret, raw prompt, or raw model fragment ever reaches the sink', () => {
  it('walks every line the sink received across a full request lifecycle and finds none of the planted prohibited markers', () => {
    const s = sink();
    // An injected clock, so this test can drive `fragment()` past the stall threshold without fake
    // timers — this describe block deliberately runs on the real clock.
    const base = Date.now();
    let ticks = 0;
    const trace = new AgentTrace(s, 'req1', 'acme', 'turbo', () => base + ticks);

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

    // Marker 6: a fragment that arrives after a stall. The stall line is the second place
    // `fragment()` can write, added when the per-token line was removed, and it is bound by the
    // same rule as the first: lengths and timings only, never the fragment's own text.
    const STALL_MARKER = 'MARKER_STALLED_FRAGMENT_4b7e0a3f';
    ticks = STALL_GAP_MS + 1;
    trace.fragment(`{"note":"${STALL_MARKER}"}`);

    // Marker 7: a credential that reaches the sink already encoded. A scan that searches only raw
    // bytes proves nothing about a base64'd secret — it really is absent from the text, and really
    // is present in the file — so every assertion below runs against the decoded haystack too.
    const ENCODED_MARKER = 'MARKER_ENCODED_SECRET_15_6_d40b';
    trace.failure(`Authorization: Basic ${Buffer.from(`oauth2:${ENCODED_MARKER}`, 'utf8').toString('base64')}`);

    const serialized = s.lines.join('\n');
    const decoded = withDecodedForms(serialized);
    // Keeps the decoder honest: without this, a decoder that silently returned its input would make
    // every assertion built on it vacuous.
    expect(withDecodedForms(`x ${Buffer.from(`oauth2:${ENCODED_MARKER}`, 'utf8').toString('base64')} y`)).toContain(
      ENCODED_MARKER,
    );
    expect(decoded).not.toContain(ENCODED_MARKER);

    // Both fragment-emitting paths actually fired — otherwise the absence assertions below would
    // pass for the wrong reason, by proving only that no line was written at all.
    expect(s.lines.filter((l) => l.includes('fragment #')).length).toBe(2);
    expect(serialized).toContain('time to first token');
    expect(serialized).toContain('stall: ');

    for (const haystack of [serialized, decoded]) {
      expect(haystack).not.toContain(PROMPT_MARKER);
      expect(haystack).not.toContain(rawPrompt);
      expect(haystack).not.toContain(FRAGMENT_MARKER);
      expect(haystack).not.toContain(RESPONSE_MARKER);
      expect(haystack).not.toContain(rawResponse);
      expect(haystack).not.toContain(SECRET_MARKER);
      expect(haystack).not.toContain('sk-live-');
      expect(haystack).not.toContain(DETAIL_MARKER);
      expect(haystack).not.toContain(STALL_MARKER);
    }

    // Every line stays a bounded metadata line — proof this is structural (size+digest+outcome),
    // not merely that these five particular markers happened not to match a redaction pattern.
    for (const line of s.lines) expect(line.length).toBeLessThan(500);
  });
});

/**
 * The claim this class printed on every raw line — "debug only, never persisted" — was false, and
 * measurably so: `installAgentTraceFile` (`../extension.ts`, via `lmAgent.ts`) tees the very sink
 * these methods write to into `agent-trace.log` with `appendFileSync`. One reviewer's live log held
 * 113 full prompts and 111 full model responses, 20 MB, in the VS Code logs directory, with the
 * setting on.
 *
 * Raw payloads are exempt from redaction precisely BECAUSE they were documented as live-only, so
 * the exemption was resting on a claim the code did not keep. The fix is not to reword the line: the
 * raw methods now write to a separate sink they are handed explicitly, and the caller that knows
 * which sink is the live channel is the only one that can supply it. Handed nothing, they write
 * nothing — a raw payload with nowhere live to go does not fall back to the durable sink.
 */
describe('AgentTrace: raw payloads go to the live sink only', () => {
  const PROMPT_MARKER = 'MARKER_RAW_PROMPT_LIVE_ONLY_4c1e8a';
  const RESPONSE_MARKER = 'MARKER_RAW_RESPONSE_LIVE_ONLY_9b2f7d';
  const PART_MARKER = 'MARKER_RAW_PART_LIVE_ONLY_3e6a0c';

  it('writes raw prompt, response and part text to the live sink and never to the durable one', () => {
    const durable = sink();
    const live = sink();
    const trace = new AgentTrace(durable, 'req1', 'acme', 'turbo', undefined, live);

    trace.debugRawPrompt(`the whole prompt ${PROMPT_MARKER}`);
    trace.debugRawResponse(`the whole reply ${RESPONSE_MARKER}`);
    trace.debugRawPart(0, { kind: 'reasoning', summary: PART_MARKER });

    const liveText = live.lines.join('\n');
    expect(liveText).toContain(PROMPT_MARKER);
    expect(liveText).toContain(RESPONSE_MARKER);
    expect(liveText).toContain(PART_MARKER);

    const durableText = durable.lines.join('\n');
    for (const marker of [PROMPT_MARKER, RESPONSE_MARKER, PART_MARKER]) {
      expect(durableText).not.toContain(marker);
    }
  });

  /**
   * The durable sink is not left silent about the gap. A file that simply omits the raw text reads
   * as if nothing happened; one line per request says the payload existed, that it was withheld
   * here on purpose, and where a reviewer can see it — written once, on the first raw call, not
   * once per raw line.
   */
  it('notes in the durable sink, once per request, that raw payloads were withheld from it', () => {
    const durable = sink();
    const live = sink();
    const trace = new AgentTrace(durable, 'req1', 'acme', 'turbo', undefined, live);

    trace.debugRawPrompt('a');
    trace.debugRawResponse('b');
    trace.debugRawPart(0, { x: 1 });

    const notes = durable.lines.filter((line) => line.includes('raw payloads'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('output channel');
    expect(notes[0]).toContain('[req1]');
  });

  it('writes nothing at all when no live sink was supplied, rather than falling back to the durable one', () => {
    const durable = sink();
    const trace = new AgentTrace(durable, 'req1', 'acme', 'turbo');

    trace.debugRawPrompt(`the whole prompt ${PROMPT_MARKER}`);
    trace.debugRawResponse(`the whole reply ${RESPONSE_MARKER}`);
    trace.debugRawPart(0, { kind: 'reasoning', summary: PART_MARKER });

    expect(durable.lines.join('\n')).not.toContain(PROMPT_MARKER);
    expect(durable.lines.join('\n')).not.toContain(RESPONSE_MARKER);
    expect(durable.lines.join('\n')).not.toContain(PART_MARKER);
  });

  it('never claims the payload is not persisted, which was the false half of the old wording', () => {
    const durable = sink();
    const live = sink();
    new AgentTrace(durable, 'req1', 'acme', 'turbo', undefined, live).debugRawPrompt('x');
    expect(live.lines.join('\n')).not.toContain('never persisted');
  });

  it('leaves every metadata line on the durable sink, so the file still describes the request', () => {
    const durable = sink();
    const live = sink();
    const trace = new AgentTrace(durable, 'req1', 'acme', 'turbo', undefined, live);
    trace.prompt('the prompt');
    trace.debugRawPrompt('the prompt');
    trace.done();

    expect(durable.lines.some((line) => /prompt \(\d+ bytes, sha256=[0-9a-f]{64}\)/.test(line))).toBe(true);
    expect(durable.lines.some((line) => line.includes('done in'))).toBe(true);
  });
});
