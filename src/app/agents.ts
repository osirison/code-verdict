/**
 * Agents and models are two different things, and this file is where that
 * split lives (spec: review-agents).
 *
 * An **agent** is a reviewing persona: a name, a description and a body of
 * instructions. It comes from a `*.agent.md` file in the workspace, from a
 * location the reviewer configured, or from the two built-ins below. It says
 * *what kind of review to run*.
 *
 * A **model** is a Copilot chat model discovered through `vscode.lm`
 * (`lmAgent.ts`). It says *what executes the instructions*.
 *
 * Until this split every chat model was itself an "agent", which left no way
 * to ask for a security pass rather than a craftsmanship one — only a way to
 * pick which model ran the single hardcoded prompt. `ModelDescriptor` is
 * deliberately a separate type rather than an `AgentDescriptor` with a
 * different `source`, so the compiler finds every place that conflated them.
 */
import { DEMO_AGENT_ID, DEMO_AGENT_LABEL } from './demoAgent';

/**
 * Where an agent came from. Shown in the picker because two agents may
 * legitimately declare the same `name` and the reviewer has to tell them
 * apart — see `origin`.
 */
export type AgentSource = 'demo' | 'builtin' | 'workspace' | 'location';

export interface AgentDescriptor {
  id: string;
  label: string;
  description: string;
  source: AgentSource;
  /**
   * The reviewing instructions, sent as the first element of the prompt and
   * nothing more. An agent never controls the response contract, the criteria
   * or the diffs — `lmAgent.ts` appends those itself, after this string.
   * Empty for the demo agent, which calls no model.
   */
  instructions: string;
  /** From the file's optional `model:` key. Applied on selection if available. */
  preferredModelId?: string;
  /** Human-readable source for the picker row: a workspace folder or a configured location. */
  origin?: string;
}

/** A Copilot chat model. Ids stay `lm:<vendor>/<family>` so `AgentTrace`'s split is untouched. */
export interface ModelDescriptor {
  id: string;
  label: string;
  description: string;
  vendor: string;
  family: string;
}

/**
 * The instructions `runLmAgent` used to hardcode, lifted out verbatim. This
 * is what makes "a workspace with no agent files reviews exactly as it did
 * before" a mechanical fact rather than a claim: the built-in agent puts this
 * string where the literal used to sit, and the rest of the prompt is built
 * by the same code from the same inputs.
 */
export const BUILTIN_AGENT_INSTRUCTIONS = 'You are a code review agent. Review ONLY the diffs below.';

export const BUILTIN_AGENT_ID = 'agent:builtin/default';

export const BUILTIN_AGENT_DESCRIPTOR: AgentDescriptor = {
  id: BUILTIN_AGENT_ID,
  label: 'Default review',
  description: 'The general-purpose review Code Verdict ships with — used when no agent file is selected.',
  source: 'builtin',
  instructions: BUILTIN_AGENT_INSTRUCTIONS,
};

/**
 * The demo agent keeps the id it has always been stored under. It predates
 * the `agent:` scheme and is already persisted in pods; re-iding it for
 * consistency would strand every demo pod on the next read.
 */
export const DEMO_AGENT_DESCRIPTOR: AgentDescriptor = {
  id: DEMO_AGENT_ID,
  label: DEMO_AGENT_LABEL,
  description: 'Deterministic findings generated from the diff — for the demo pod and emulator debugging.',
  source: 'demo',
  instructions: '',
};

/** Always offered, in this order, before anything discovered on disk. */
export const BUILT_IN_AGENTS: readonly AgentDescriptor[] = [BUILTIN_AGENT_DESCRIPTOR, DEMO_AGENT_DESCRIPTOR];

/** The demo agent produces findings without a model; every other agent needs one. */
export function agentNeedsModel(agent: AgentDescriptor | undefined): boolean {
  return agent !== undefined && agent.source !== 'demo';
}
