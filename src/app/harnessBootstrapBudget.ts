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
  withPolicyTextOmitted,
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

/** Stated once here so both the shrink call and the render-time reason (`harnessModelSeam.ts`) agree on the same wording. */
export const POLICY_TEXT_OMITTED_REASON = "Root policy text omitted: the bootstrap envelope did not fit the model's input limit even after summarizing sections and shortening tool descriptions.";

/**
 * Tries the full envelope, then three shrink tactics in order — replace
 * reopenable sections with their summaries, shorten non-normative tool
 * descriptions, then (new) drop the composed root-policy text down to
 * identity only — and fails closed with a `bootstrapOverflow` limitation
 * (D4's own term) when even the minimal authoritative envelope does not fit.
 *
 * Policy text is tried last, after both existing tactics: it is authoritative
 * instruction the repository owner wrote, worth more bootstrap space than
 * reopenable-section detail or tool-description prose, so it is the last
 * thing dropped rather than the first — but it is dropped, truthfully
 * (`withPolicyTextOmitted` marks exactly why), rather than let a large
 * `AGENTS.md`/`CLAUDE.md` sink an otherwise-fitting bootstrap outright.
 */
export async function fitBootstrapToModel(input: BootstrapBudgetInput): Promise<BootstrapFitResult> {
  if (input.maxInputTokens === undefined) {
    return { ok: true, envelope: input.envelope };
  }
  const maxInputTokens = input.maxInputTokens;

  const summarized = withSectionsSummarized(input.envelope);
  const minimal = withMinimalToolDescriptions(summarized);
  const policyTrimmed = withPolicyTextOmitted(minimal, POLICY_TEXT_OMITTED_REASON);
  const attempts: readonly BootstrapEnvelope[] = [input.envelope, summarized, minimal, policyTrimmed];

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
