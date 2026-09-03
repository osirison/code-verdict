export const CONTEXT_USAGE_DEBOUNCE_MS = 250;

export interface ContextUsageRequest {
  cacheKey: string;
  prompt: string;
  totalTokens: number;
  countTokens(prompt: string): Promise<number | undefined>;
}

export interface ContextUsageResult {
  usedTokens: number;
  totalTokens: number;
}

/** Debounces changing prompts, caches settled counts, and drops stale async results. */
export class ContextUsageCounter {
  private timer?: ReturnType<typeof setTimeout>;
  private generation = 0;
  private readonly cache = new Map<string, number>();

  schedule(
    request: ContextUsageRequest,
    onResult: (result: ContextUsageResult | undefined) => void,
  ): void {
    clearTimeout(this.timer);
    const generation = ++this.generation;
    const cached = this.cache.get(request.cacheKey);
    if (cached !== undefined) {
      onResult({ usedTokens: cached, totalTokens: request.totalTokens });
      return;
    }
    this.timer = setTimeout(() => {
      void request.countTokens(request.prompt).then((usedTokens) => {
        if (generation !== this.generation) return;
        if (usedTokens === undefined || !Number.isFinite(usedTokens) || usedTokens < 0) {
          onResult(undefined);
          return;
        }
        this.cache.set(request.cacheKey, usedTokens);
        if (this.cache.size > 20) this.cache.delete(this.cache.keys().next().value as string);
        onResult({ usedTokens, totalTokens: request.totalTokens });
      }, () => {
        if (generation === this.generation) onResult(undefined);
      });
    }, CONTEXT_USAGE_DEBOUNCE_MS);
  }

  cancel(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.generation += 1;
  }
}