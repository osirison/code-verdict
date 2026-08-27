import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRunProgress } from '../app/lmAgent';
import { PROGRESS_PUSH_MS, RunLiveness } from './runLiveness';

function progress(fragmentsReceived: number, charsReceived: number, elapsedMs: number): AgentRunProgress {
  return { requestId: 'abc123', fragmentsReceived, charsReceived, elapsedMs };
}

/** Only `postMessage` is touched; the rest of `vscode.Webview` never comes into it. */
function fakeWebview(): { postMessage: ReturnType<typeof vi.fn> } {
  return { postMessage: vi.fn(async () => true) };
}

describe('RunLiveness', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing until a run starts, and nothing again once it is cleared', () => {
    const live = new RunLiveness();
    expect(live.snapshot()).toBeUndefined();
    live.start();
    expect(live.snapshot()).toBeDefined();
    live.clear();
    expect(live.snapshot()).toBeUndefined();
  });

  it('re-measures elapsed on read, so a render between two fragments is not stuck on the last one', () => {
    const live = new RunLiveness();
    live.start();
    live.record(progress(1, 10, 1_000), fakeWebview() as never);
    vi.advanceTimersByTime(30_000);
    expect(live.snapshot()?.elapsedMs).toBeGreaterThanOrEqual(30_000);
    expect(live.snapshot()?.fragmentsReceived).toBe(1);
  });

  it('pushes the first fragment at once and then no more often than the floor', () => {
    const live = new RunLiveness();
    const webview = fakeWebview();
    live.start();
    live.record(progress(1, 10, 1), webview as never);
    // Three more inside the floor: the counters keep moving, the pushes do not.
    live.record(progress(2, 20, 2), webview as never);
    live.record(progress(3, 30, 3), webview as never);
    expect(webview.postMessage).toHaveBeenCalledTimes(1);
    expect(live.snapshot()?.charsReceived).toBe(30);

    vi.advanceTimersByTime(PROGRESS_PUSH_MS);
    live.record(progress(4, 40, 4), webview as never);
    expect(webview.postMessage).toHaveBeenCalledTimes(2);
    expect(webview.postMessage).toHaveBeenLastCalledWith({
      type: 'run:progress',
      summary: '4 fragments · 40 characters',
    });
  });

  it('starts a retry from zero rather than inheriting the previous run\'s totals', () => {
    const live = new RunLiveness();
    const webview = fakeWebview();
    live.start();
    live.record(progress(7, 900, 5_000), webview as never);
    live.start();
    expect(live.snapshot()?.fragmentsReceived).toBe(0);
    expect(live.snapshot()?.charsReceived).toBe(0);
  });

  it('ignores a fragment that lands after the run was cleared', () => {
    const live = new RunLiveness();
    const webview = fakeWebview();
    live.start();
    live.clear();
    live.record(progress(1, 10, 1), webview as never);
    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(live.snapshot()).toBeUndefined();
  });
});
