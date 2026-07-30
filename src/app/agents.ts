/**
 * Agent descriptors. Agents are whatever the user has (spec §5) — Copilot
 * models discovered via vscode.lm (see lmAgent.ts) plus the built-in demo
 * agent that makes the flow drivable against the emulator.
 */
export interface AgentDescriptor {
  id: string;
  label: string;
  description: string;
  source: 'demo' | 'copilot';
}

import { DEMO_AGENT_ID, DEMO_AGENT_LABEL } from './demoAgent';

export const DEMO_AGENT_DESCRIPTOR: AgentDescriptor = {
  id: DEMO_AGENT_ID,
  label: DEMO_AGENT_LABEL,
  description: 'Deterministic findings generated from the diff — for the demo pod and emulator debugging.',
  source: 'demo',
};
