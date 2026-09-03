/**
 * Fits the bootstrap envelope to the selected model's input limit (task 6.6
 * of `add-agentic-review-harness`, design.md D4/D14).
 *
 * Reuses the existing token estimator rather than adding a bespoke one:
 * `countTokens` here is the same shape as `lmAgent.ts`'s `countPromptTokens`
 * (itself `vscode.lm`'s own `LanguageModelChat.countTokens`) and
 * `src/ui/contextUsage.ts`'s injected counter — production wiring passes
 * `(text) => countPromptTokens(modelId, text)`.
 *
 * This module's only model-facing capability is `countTokens`; it has no
 * parameter, import, or code path that can send a model request. That is
 * what makes "fail before model invocation" structural rather than a
 * runtime check: an overflowing envelope is reported as `ok: false` and
 * nothing here is even capable of dispatching a turn.
 */
import {
  estimateEnvelopeLength,
  withMinimalToolDescriptions,
  withSectionsSummarized,
  type BootstrapEnvelope,
} from '../domain/harnessBootstrap';
import type { Limitation } from '../domain/harnessActivity';

export interface BootstrapBudgetInput {
  envelope: BootstrapEnvelope;
  /** Absent for the demo agent, which calls no model — there is nothing to fit against, so the envelope always fits. */
  maxInputTokens?: number;
  /** Counts tokens for the given rendered text against the selected model; `undefined` when the model itself could not be asked. */
  countTokens: (text: string) => Promise<number | undefined>;
}

export type BootstrapFitResult =
  | { ok: true; envelope: BootstrapEnvelope; usedTokens?: number }
  /** `completeness` is always `'none'` here: the model was never invoked, so nothing was validated (design.md D4). */
  | { ok: false; completeness: 'none'; limitation: Limitation; usedTokens?: number };

/** Canonical rendering used only for counting — the real (section 10) model transport defines its own serialization. */
function renderForCounting(envelope: BootstrapEnvelope): string {
  return JSON.stringify(envelope);
}

/**
 * Tries the full envelope, then D4's two shrink tactics in order — replace
 * reopenable sections with their summaries, then shorten non-normative tool
 * descriptions — and fails closed with a `bootstrapOverflow` limitation
 * (D4's own term) when even the minimal authoritative envelope does not fit.
 */
export async function fitBootstrapToModel(input: BootstrapBudgetInput): Promise<BootstrapFitResult> {
  if (input.maxInputTokens === undefined) {
    return { ok: true, envelope: input.envelope };
  }
  const maxInputTokens = input.maxInputTokens;

  const summarized = withSectionsSummarized(input.envelope);
  const minimal = withMinimalToolDescriptions(summarized);
  const attempts: readonly BootstrapEnvelope[] = [input.envelope, summarized, minimal];

  let lastUsedTokens: number | undefined;
  for (const attempt of attempts) {
    const usedTokens = await input.countTokens(renderForCounting(attempt));
    if (usedTokens === undefined) continue; // cannot claim a fit that was never actually measured
    lastUsedTokens = usedTokens;
    if (usedTokens <= maxInputTokens) {
      return { ok: true, envelope: attempt, usedTokens };
    }
  }

  return {
    ok: false,
    completeness: 'none',
    usedTokens: lastUsedTokens,
    limitation: {
      code: 'bootstrapOverflow',
      message: lastUsedTokens === undefined
        ? 'Could not determine whether the bootstrap envelope fits the selected model.'
        : `The minimum bootstrap envelope needs about ${lastUsedTokens} tokens, over the model's ${maxInputTokens}-token input limit.`,
    },
  };
}

/** Exposed for callers that only want to log/compare sizes without counting tokens (e.g. diagnostics). */
export { estimateEnvelopeLength };
