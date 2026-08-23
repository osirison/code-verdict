import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { ChangeRequestDiff } from '../platform/types';
import type { AgentTraceSink } from './agentTrace';
import type { ChangesetAgentMember } from './combinedAgent';

/**
 * Minimal fake of the two vscode.lm pieces `lmAgent.ts` touches:
 * `CancellationTokenSource` (with a working `onCancellationRequested` so a
 * fake stream can react to cancellation without needing an eternity to
 * "notice") and `lm.selectChatModels` returning one fake model whose
 * `sendRequest` is controlled per test.
 */
interface FakeToken {
  isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

const FakeCancellationTokenSource = vi.hoisted(() =>
  class {
    private listeners: Array<() => void> = [];
    token: FakeToken = {
      isCancellationRequested: false,
      onCancellationRequested: (listener: () => void) => {
        this.listeners.push(listener);
        return { dispose: () => {} };
      },
    };
    cancel(): void {
      if (this.token.isCancellationRequested) return;
      this.token.isCancellationRequested = true;
      for (const listener of [...this.listeners]) listener();
    }
    dispose(): void {}
  },
);

const sendRequest = vi.hoisted(() => vi.fn());
const selectChatModels = vi.hoisted(() => vi.fn(async () => [{ sendRequest }]));
const createOutputChannel = vi.hoisted(() => vi.fn(() => ({ appendLine: vi.fn() })));

vi.mock('vscode', () => ({
  CancellationTokenSource: FakeCancellationTokenSource,
  LanguageModelChatMessage: { User: (content: string) => ({ role: 'user', content }) },
  lm: { selectChatModels },
  window: { createOutputChannel },
}));

interface Step {
  delayMs: number;
  text: string;
}

/** Resolves `false` after `ms`, or `true` as soon as `token` is cancelled — whichever comes first. */
function raceCancellation(ms: number, token: FakeToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(false);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/** A fake `LanguageModelChatResponse` whose `.text` yields `steps` at the given delays, honouring cancellation like the real API does. */
function fragmentStream(token: FakeToken, steps: readonly Step[]): { text: AsyncIterable<string> } {
  return {
    text: {
      [Symbol.asyncIterator]() {
        let index = 0;
        return {
          async next(): Promise<IteratorResult<string>> {
            const step = steps[index];
            if (!step) return { value: undefined, done: true };
            index += 1;
            const cancelled = await raceCancellation(step.delayMs, token);
            if (cancelled) throw new Error('Canceled by test fake');
            return { value: step.text, done: false };
          },
        };
      },
    },
  };
}

function fakeSink(): AgentTraceSink & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    appendLine(line: string): void {
      lines.push(line);
    },
  };
}

/** Attaches both handlers immediately (before any fake-timer advancing) so a rejection never becomes an unhandled one. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error) => ({ ok: false as const, error }),
  );
}

describe('runPrompt timeouts (issue #36)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendRequest.mockReset();
    selectChatModels.mockClear();
    selectChatModels.mockImplementation(async () => [{ sendRequest }]);
    createOutputChannel.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a steadily streaming request alive well past the old flat 90s cutoff', async () => {
    const { runPrompt } = await import('./lmAgent.js');
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [
        // The issue's own worked example: one fragment every 60s. Three of them run to 180s —
        // well past the old flat 90s cutoff — and each 60s gap must NOT trip the 90s inactivity
        // window (it would if inactivity were also 60s: the reset timer and the next fragment's
        // arrival would land on the exact same tick, and the reset timer — registered first —
        // would win the tie and kill the request. 90s leaves real margin instead of a knife edge).
        { delayMs: 60_000, text: '{"schemaVersion":"1","agentId":"a","agentLabel":"b",' },
        { delayMs: 60_000, text: '"headSha":"abc","items":[]' },
        { delayMs: 60_000, text: '}' },
      ]),
    );
    const promise = runPrompt('lm:acme/turbo', 'the prompt', { trace: fakeSink() });
    await vi.advanceTimersByTimeAsync(200_000);
    const response = await promise;
    expect(response.headSha).toBe('abc');
    expect(response.items).toEqual([]);
  });

  it('cancels a stalled stream after the inactivity window and says it stalled', async () => {
    const { runPrompt, AgentRunError } = await import('./lmAgent.js');
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [
        { delayMs: 10_000, text: 'partial' },
        { delayMs: 24 * 60 * 60 * 1000, text: 'never arrives' },
      ]),
    );
    const sink = fakeSink();
    const outcome = await (async () => {
      const p = settle(runPrompt('lm:acme/turbo', 'the prompt', { trace: sink }));
      // Last fragment at 10s resets the 90s inactivity window to fire at 100s; nothing else arrives.
      await vi.advanceTimersByTimeAsync(150_000);
      return p;
    })();

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(AgentRunError);
    const err = outcome.error as InstanceType<typeof AgentRunError>;
    expect(err.timedOut).toBe(true);
    expect(err.timeoutReason).toBe('inactivity');
    expect(err.message).toMatch(/stalled/);
    expect(sink.lines.some((l) => l.includes('failed after') && l.includes('(inactivity limit)') && l.includes('stalled'))).toBe(true);
  });

  it('fires the absolute ceiling even while fragments keep arriving, and says it exceeded the overall limit', async () => {
    const { runPrompt, AgentRunError } = await import('./lmAgent.js');
    // A fragment every 65s never trips the 90s inactivity window, but 11 of them run past 600s —
    // the ceiling, which is not reset by activity. 65s doesn't divide 600s evenly (585s, 650s
    // straddle it), so the ceiling fires cleanly mid-wait instead of tying with a fragment.
    const steps: Step[] = Array.from({ length: 11 }, () => ({ delayMs: 65_000, text: 'x' }));
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) => fragmentStream(token, steps));
    const sink = fakeSink();
    const p = settle(runPrompt('lm:acme/turbo', 'the prompt', { trace: sink }));
    await vi.advanceTimersByTimeAsync(700_000);
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(AgentRunError);
    const err = outcome.error as InstanceType<typeof AgentRunError>;
    expect(err.timedOut).toBe(true);
    expect(err.timeoutReason).toBe('ceiling');
    expect(err.message).toMatch(/exceeded/);
    expect(sink.lines.some((l) => l.includes('failed after') && l.includes('(ceiling limit)') && l.includes('exceeded'))).toBe(true);
  });

  it('reports a missing model without treating it as a timeout', async () => {
    const { runPrompt, AgentRunError } = await import('./lmAgent.js');
    selectChatModels.mockResolvedValueOnce([]);
    const outcome = await settle(runPrompt('lm:acme/turbo', 'the prompt', { trace: fakeSink() }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(AgentRunError);
    const err = outcome.error as InstanceType<typeof AgentRunError>;
    expect(err.timedOut).toBe(false);
    expect(err.message).toMatch(/no longer available/);
  });
});

describe('agent trace (issue #35)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendRequest.mockReset();
    selectChatModels.mockClear();
    selectChatModels.mockImplementation(async () => [{ sendRequest }]);
    createOutputChannel.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('records the request start, the prompt, each fragment and a successful outcome; calls onProgress per fragment', async () => {
    const { runPrompt } = await import('./lmAgent.js');
    const chunks = ['{"schemaVersion":"1","agentId":"a","agentLabel":"b","headSha":"abc",', '"items":[]}'];
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(
        token,
        chunks.map((text) => ({ delayMs: 10, text })),
      ),
    );
    const sink = fakeSink();
    const progress: Array<{ fragmentsReceived: number; charsReceived: number }> = [];
    const promise = runPrompt('lm:acme/turbo', 'REVIEW THIS DIFF', {
      trace: sink,
      onProgress: (p) => progress.push({ fragmentsReceived: p.fragmentsReceived, charsReceived: p.charsReceived }),
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;

    expect(sink.lines[0]).toMatch(/^\[\w+] start .* vendor=acme family=turbo$/);
    expect(sink.lines.some((l) => l.includes('prompt (') && l.includes('REVIEW THIS DIFF'))).toBe(true);
    expect(sink.lines.some((l) => l.includes('fragment #1'))).toBe(true);
    expect(sink.lines.some((l) => l.includes('fragment #2'))).toBe(true);
    expect(sink.lines.some((l) => l.includes('parsed OK'))).toBe(true);
    expect(sink.lines.some((l) => l.includes('done in') && l.includes('0 item(s)'))).toBe(true);

    expect(progress.map((p) => p.fragmentsReceived)).toEqual([1, 2]);
    expect(progress[1]?.charsReceived).toBe(chunks.reduce((total, chunk) => total + chunk.length, 0));
  });

  it('captures the raw text and parse outcome when JSON extraction fails, instead of discarding it', async () => {
    const { runPrompt, AgentRunError } = await import('./lmAgent.js');
    const rawReply = 'Sure, here is my review: nothing to report.';
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [{ delayMs: 10, text: rawReply }]),
    );
    const sink = fakeSink();
    const p = settle(runPrompt('lm:acme/turbo', 'the prompt', { trace: sink }));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(AgentRunError);
    const err = outcome.error as InstanceType<typeof AgentRunError>;
    expect(err.timedOut).toBe(false);
    expect(err.message).toMatch(/did not match the contract/);

    const rawLine = sink.lines.find((l) => l.includes('raw text before JSON extraction'));
    expect(rawLine).toBeDefined();
    expect(rawLine).toContain('parse FAILED: no JSON object found');
    expect(rawLine).toContain(rawReply);
    expect(sink.lines.some((l) => l.includes('failed after') && l.includes('did not match the contract'))).toBe(true);
  });

  it('captures the raw text and parse outcome when the extracted JSON is malformed', async () => {
    const { runPrompt } = await import('./lmAgent.js');
    const rawReply = 'Result: {schemaVersion: 1, items: []} thanks';
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [{ delayMs: 10, text: rawReply }]),
    );
    const sink = fakeSink();
    const p = settle(runPrompt('lm:acme/turbo', 'the prompt', { trace: sink }));
    await vi.advanceTimersByTimeAsync(1_000);
    const outcome = await p;

    expect(outcome.ok).toBe(false);
    const rawLine = sink.lines.find((l) => l.includes('raw text before JSON extraction'));
    expect(rawLine).toBeDefined();
    expect(rawLine).toContain('parse FAILED:');
    expect(rawLine).toContain(rawReply);
  });

  it('defaults to an output-channel sink backed by vscode.window.createOutputChannel when none is injected', async () => {
    const { runPrompt } = await import('./lmAgent.js');
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [{ delayMs: 10, text: '{"schemaVersion":"1","agentId":"a","agentLabel":"b","headSha":"abc","items":[]}' }]),
    );
    const promise = runPrompt('lm:acme/turbo', 'the prompt');
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(createOutputChannel).toHaveBeenCalledWith('Code Verdict: Agent Trace');
  });
});

describe('runLmAgent / runLmChangesetAgent forward options to runPrompt', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendRequest.mockReset();
    selectChatModels.mockClear();
    selectChatModels.mockImplementation(async () => [{ sendRequest }]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const diff: ChangeRequestDiff = {
    ref: { repoId: 'repo1', number: '42' },
    headSha: 'h1',
    files: [{ oldPath: 'a.ts', newPath: 'a.ts', diff: '@@ -1 +1 @@\n-old\n+new' }],
    anchorRefs: undefined,
  };

  it('runLmAgent passes onProgress and trace through unchanged', async () => {
    const { runLmAgent } = await import('./lmAgent.js');
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [{ delayMs: 10, text: '{"schemaVersion":"1","agentId":"a","agentLabel":"b","headSha":"h1","items":[]}' }]),
    );
    const sink = fakeSink();
    const progress = vi.fn();
    const promise = runLmAgent('lm:acme/turbo', diff, DEFAULT_CRITERIA, { trace: sink, onProgress: progress });
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(progress).toHaveBeenCalled();
    expect(sink.lines.some((l) => l.includes('prompt ('))).toBe(true);
  });

  it('runLmChangesetAgent passes onProgress and trace through unchanged', async () => {
    const { runLmChangesetAgent } = await import('./lmAgent.js');
    sendRequest.mockImplementation(async (_messages: unknown, _options: unknown, token: FakeToken) =>
      fragmentStream(token, [{ delayMs: 10, text: '{"schemaVersion":"1","agentId":"a","agentLabel":"b","headSha":"h1","items":[]}' }]),
    );
    const members: ChangesetAgentMember[] = [{ ref: { repoId: 'repo1', number: '42' }, projectPath: 'org/repo1', diff }];
    const sink = fakeSink();
    const progress = vi.fn();
    const promise = runLmChangesetAgent('lm:acme/turbo', members, DEFAULT_CRITERIA, { trace: sink, onProgress: progress });
    await vi.advanceTimersByTimeAsync(1_000);
    await promise;
    expect(progress).toHaveBeenCalled();
    expect(sink.lines.some((l) => l.includes('prompt ('))).toBe(true);
  });
});
