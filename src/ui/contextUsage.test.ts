import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONTEXT_USAGE_DEBOUNCE_MS, ContextUsageCounter } from './contextUsage';

describe('ContextUsageCounter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('debounces changing prompts and reports only the latest count', async () => {
    const countTokens = vi.fn(async (prompt: string) => prompt.length);
    const onResult = vi.fn();
    const counter = new ContextUsageCounter();

    counter.schedule({ cacheKey: 'model\0a', prompt: 'a', totalTokens: 100, countTokens }, onResult);
    counter.schedule({ cacheKey: 'model\0latest', prompt: 'latest', totalTokens: 100, countTokens }, onResult);
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_DEBOUNCE_MS);

    expect(countTokens).toHaveBeenCalledOnce();
    expect(countTokens).toHaveBeenCalledWith('latest');
    expect(onResult).toHaveBeenCalledWith({ usedTokens: 6, totalTokens: 100 });
  });

  it('caches counts per fully assembled prompt', async () => {
    const countTokens = vi.fn(async () => 42);
    const onResult = vi.fn();
    const counter = new ContextUsageCounter();
    const request = { cacheKey: 'model\0prompt', prompt: 'prompt', totalTokens: 1_000, countTokens };

    counter.schedule(request, onResult);
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_DEBOUNCE_MS);
    counter.schedule(request, onResult);

    expect(countTokens).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenLastCalledWith({ usedTokens: 42, totalTokens: 1_000 });
  });

  it('hides usage for failed or unknown counts', async () => {
    const onResult = vi.fn();
    const counter = new ContextUsageCounter();

    counter.schedule({
      cacheKey: 'model\0unknown',
      prompt: 'unknown',
      totalTokens: 1_000,
      countTokens: async () => undefined,
    }, onResult);
    await vi.advanceTimersByTimeAsync(CONTEXT_USAGE_DEBOUNCE_MS);

    expect(onResult).toHaveBeenCalledWith(undefined);
  });
});