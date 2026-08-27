/**
 * One reader for the agent-run timeout settings, on the `changesetOptions.ts`
 * precedent: the setting is read here in the UI layer and handed down, so
 * `app/lmAgent.ts` never reaches for `workspace.getConfiguration` and stays
 * unit-testable against plain numbers.
 *
 * Every surface that starts an `lm:` request goes through this — the review
 * run, the changeset run and a follow-up question — because a reviewer who
 * lengthened the window for a slow model expects it lengthened everywhere,
 * not only on the screen they happened to change it from.
 */
import * as vscode from 'vscode';
import { DEFAULT_AGENT_RUN_TIMEOUTS, type AgentRunTimeouts } from '../app/lmAgent';

/**
 * `setTimeout` stores its delay in a signed 32-bit int: anything past this
 * wraps and the timer fires on the next tick instead of in 25 days. A reviewer
 * types a huge number to mean "never", so that is what it is read as — the
 * settings' own "0 removes this limit" — rather than the opposite.
 */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Settings are seconds (what a person configures); the agent takes
 * milliseconds. A negative or non-finite value would arm a timer that fires
 * immediately, so anything that is not a usable number falls back to the
 * default rather than cancelling every run on the first tick.
 */
function windowMs(value: number | undefined, fallbackMs: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallbackMs;
  const ms = value * 1000;
  return ms > MAX_TIMER_MS ? 0 : ms;
}

export function agentRunTimeouts(): AgentRunTimeouts {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return {
    inactivityMs: windowMs(config.get<number>('agentRun.inactivitySeconds'), DEFAULT_AGENT_RUN_TIMEOUTS.inactivityMs),
    ceilingMs: windowMs(config.get<number>('agentRun.ceilingSeconds'), DEFAULT_AGENT_RUN_TIMEOUTS.ceilingMs),
  };
}
