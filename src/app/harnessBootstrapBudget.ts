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
  withUntrustedContentCapped,
  type BootstrapEnvelope,
  type UntrustedContentCaps,
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
export const POLICY_TEXT_OMITTED_REASON = "Root policy text omitted: the bootstrap envelope did not fit the model's input limit even after capping untrusted content, summarizing sections, and shortening tool descriptions.";

/**
 * The canonical shrink ladder, most-disposable-first, shared by every caller that must fit this
 * envelope against *some* limit: the token-based loop directly below, and the per-turn byte-cap
 * retry in `../app/harnessAttempt.ts`'s `runBootstrap` (the incident fix — the framing byte
 * ceiling is a separate, often tighter budget than a model's own input-token limit, and it used to
 * have no shrink step of its own at all). One list means the two budgets can never disagree about
 * what gets dropped first.
 *
 * Order, cheapest-to-precious: cap the untrusted PR/MR content (commits, body) while leaving it
 * structured; collapse every reopenable section to its bare-counts summary; drop non-normative
 * tool-description prose; and only last, drop the repository owner's own authoritative policy
 * text. See `../domain/harnessBootstrap.ts`'s doc comments on each tactic for why each is ordered
 * where it is (in particular: capping must run before summarizing, because summarizing already
 * destroys the commit list and body this tactic would otherwise cap).
 */
export function bootstrapShrinkAttempts(envelope: BootstrapEnvelope, caps?: UntrustedContentCaps): readonly BootstrapEnvelope[] {
  const capped = withUntrustedContentCapped(envelope, caps);
  const summarized = withSectionsSummarized(capped);
  const minimal = withMinimalToolDescriptions(summarized);
  const policyTrimmed = withPolicyTextOmitted(minimal, POLICY_TEXT_OMITTED_REASON);
  return [envelope, capped, summarized, minimal, policyTrimmed];
}

/**
 * Tries the full envelope, then the four shrink tactics of `bootstrapShrinkAttempts` in order —
 * cap untrusted content, replace reopenable sections with their summaries, shorten non-normative
 * tool descriptions, then drop the composed root-policy text down to identity only — and fails
 * closed with a `bootstrapOverflow` limitation (D4's own term) when even the minimal authoritative
 * envelope does not fit.
 *
 * Policy text is tried last, after every other tactic: it is authoritative instruction the
 * repository owner wrote, worth more bootstrap space than untrusted-section detail or
 * tool-description prose, so it is the last thing dropped rather than the first — but it is
 * dropped, truthfully (`withPolicyTextOmitted` marks exactly why), rather than let a large
 * `AGENTS.md`/`CLAUDE.md` sink an otherwise-fitting bootstrap outright.
 */
export async function fitBootstrapToModel(input: BootstrapBudgetInput): Promise<BootstrapFitResult> {
  if (input.maxInputTokens === undefined) {
    return { ok: true, envelope: input.envelope };
  }
  const maxInputTokens = input.maxInputTokens;

  const attempts = bootstrapShrinkAttempts(input.envelope);

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
