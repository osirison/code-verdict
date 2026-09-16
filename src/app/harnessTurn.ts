/**
 * The phase-specific turn runner: bounded protocol repair on top of the pure
 * parser (task 10.2 of `add-agentic-review-harness`, design.md D5 rule 5,
 * spec `agentic-review-harness` "Budgets and retries degrade truthfully" —
 * "Protocol response is malformed").
 *
 * `runHarnessTurn` is the seam task 10.3's `HarnessAttempt` engine drives: it
 * takes an injected "ask the model" function (so `vscode` never appears
 * here — see `./lmAgent.ts`'s own `AgentCancellationToken`, imported
 * type-only below for the exact same reason `./harnessToolDispatcher.ts`
 * already does), the current `RunPhase`, and a repair allowance, and returns
 * either typed messages or a typed terminal failure. It never dispatches a
 * tool, submits a candidate, or touches the evidence ledger/budget
 * tracker/activity log — those stay task 10.3's job once it has a parsed
 * `ProtocolMessage` in hand. Concretely this means D12's "protocol repair
 * never retries a tool side effect" holds structurally here: there is no
 * tool call in this loop to retry.
 *
 * The loop:
 *
 * 1. Ask the model (via the injected `askModel`, with `undefined` on the
 *    first attempt and a bounded repair instruction on every retry).
 * 2. Parse the raw text with `../domain/harnessProtocol.ts`'s `parseModelTurn`,
 *    pure and synchronous.
 * 3. On success, return the typed messages plus metadata (byte count,
 *    message count) from the parser, with `repairCount` — the one piece of
 *    per-call metadata the parser cannot know about itself — added here.
 * 4. On failure, if the phase's repair allowance
 *    (`HarnessPolicy.protocolRepairsPerPhase`, default 2) is not yet
 *    exhausted, build a bounded, sanitized repair instruction with
 *    `../domain/harnessProtocol.ts`'s `buildRepairInstruction` (never the
 *    model's raw text — that string is discarded the moment it fails to
 *    parse) and ask again.
 * 5. Once the allowance is exhausted, return a typed terminal failure —
 *    never an infinite loop (D5 rule 5, spec "the attempt fails or becomes
 *    partial after the repair limit rather than retrying indefinitely").
 *
 * Cancellation is checked before every model ask and once more after it
 * resolves, mirroring `../app/harnessToolDispatcher.ts`'s own pattern for a
 * request that might settle after cancellation was requested.
 */
import type { AgentCancellationToken } from './lmAgent';
import {
  buildRepairInstruction,
  parseModelTurn,
  type ProtocolFailureReason,
  type ProtocolMessage,
  type ProtocolParseContext,
  type TurnParseFailureKind,
} from '../domain/harnessProtocol';
import type { Plan } from '../domain/harnessActivity';
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';

/**
 * Asks the model for one turn's raw text. `repairInstruction` is `undefined`
 * on the first attempt and a bounded, sanitized instruction (never the
 * model's own prior raw text) on every subsequent attempt within the repair
 * allowance. Building the *rest* of the prompt (bootstrap envelope, persona,
 * tool schemas, ...) is entirely the caller's concern — this module knows
 * nothing about prompt assembly, only about parsing what comes back.
 */
export type AskModel = (repairInstruction: string | undefined) => Promise<string>;

export interface RunHarnessTurnOptions {
  readonly phase: ProtocolParseContext['phase'];
  /** The plan as of the start of this turn; threaded straight through to `parseModelTurn`. */
  readonly previousPlan?: Plan;
  readonly policy?: HarnessPolicy;
  /** Overrides `policy.protocolRepairsPerPhase` for a focused test; production callers should leave this to the policy. */
  readonly maxRepairs?: number;
  readonly cancellation?: AgentCancellationToken;
}

export interface HarnessTurnMeta {
  readonly rawByteLength: number;
  readonly messageCount: number;
  /** How many repair instructions were issued before this outcome — not something a single `parseModelTurn` call can know, since it parses one turn in isolation. */
  readonly repairCount: number;
}

export type HarnessTurnFailureKind = TurnParseFailureKind | 'cancelled';

export type HarnessTurnOutcome =
  | { readonly ok: true; readonly messages: readonly ProtocolMessage[]; readonly meta: HarnessTurnMeta }
  | {
      readonly ok: false;
      readonly failureKind: HarnessTurnFailureKind;
      readonly reasons: readonly ProtocolFailureReason[];
      readonly repairCount: number;
      /** True once every failure is terminal because the phase's repair allowance is exhausted (D5 rule 5) — always true except for `cancelled`, which stops the loop for an unrelated reason. */
      readonly repairsExhausted: boolean;
    };

function cancelledOutcome(repairCount: number): HarnessTurnOutcome {
  return { ok: false, failureKind: 'cancelled', reasons: [{ code: 'cancelled', message: 'The attempt was cancelled before this turn completed.' }], repairCount, repairsExhausted: false };
}

/**
 * Runs one phase's model turn with bounded protocol repair. Pure orchestration
 * over `askModel` and `parseModelTurn` — no tool dispatch, no evidence, no
 * budget, no activity log. Those are task 10.3's job once this returns typed
 * messages.
 */
export async function runHarnessTurn(askModel: AskModel, options: RunHarnessTurnOptions): Promise<HarnessTurnOutcome> {
  const policy = options.policy ?? DEFAULT_HARNESS_POLICY;
  const maxRepairs = options.maxRepairs ?? policy.protocolRepairsPerPhase;
  const parseContext: ProtocolParseContext = { phase: options.phase, previousPlan: options.previousPlan, policy };

  let repairCount = 0;
  let repairInstruction: string | undefined;

  for (;;) {
    if (options.cancellation?.isCancellationRequested) return cancelledOutcome(repairCount);

    const rawText = await askModel(repairInstruction);

    if (options.cancellation?.isCancellationRequested) return cancelledOutcome(repairCount);

    const outcome = parseModelTurn(rawText, parseContext);
    if (outcome.ok) {
      return { ok: true, messages: outcome.messages, meta: { rawByteLength: outcome.meta.rawByteLength, messageCount: outcome.meta.messageCount, repairCount } };
    }

    if (repairCount >= maxRepairs) {
      return { ok: false, failureKind: outcome.failureKind, reasons: outcome.reasons, repairCount, repairsExhausted: true };
    }

    repairCount += 1;
    repairInstruction = buildRepairInstruction(outcome.failureKind, outcome.reasons);
  }
}
