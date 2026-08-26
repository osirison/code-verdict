import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CEILING_TIMEOUT_MS, INACTIVITY_TIMEOUT_MS } from '../app/lmAgent';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentRunTimeouts } from './agentRunOptions';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => settings.values[key] }),
  },
  window: { createOutputChannel: vi.fn(() => ({ appendLine: vi.fn() })) },
}));

describe('agentRunTimeouts', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('falls back to the shipped windows when nothing is configured', () => {
    expect(agentRunTimeouts()).toEqual({ inactivityMs: INACTIVITY_TIMEOUT_MS, ceilingMs: CEILING_TIMEOUT_MS });
  });

  it('converts the configured seconds to the milliseconds the agent takes', () => {
    settings.values = { 'agentRun.inactivitySeconds': 240, 'agentRun.ceilingSeconds': 3_600 };
    expect(agentRunTimeouts()).toEqual({ inactivityMs: 240_000, ceilingMs: 3_600_000 });
  });

  it('passes 0 straight through — it is the documented "no limit", not a missing value', () => {
    settings.values = { 'agentRun.inactivitySeconds': 0, 'agentRun.ceilingSeconds': 0 };
    expect(agentRunTimeouts()).toEqual({ inactivityMs: 0, ceilingMs: 0 });
  });

  it('ignores a value that would arm a timer firing immediately', () => {
    // A negative or non-numeric setting would otherwise cancel every run on the first tick.
    settings.values = { 'agentRun.inactivitySeconds': -30, 'agentRun.ceilingSeconds': Number.NaN };
    expect(agentRunTimeouts()).toEqual({ inactivityMs: INACTIVITY_TIMEOUT_MS, ceilingMs: CEILING_TIMEOUT_MS });
  });

  it('reads a value past the 32-bit timer range as "no limit", not as "cancel immediately"', () => {
    // setTimeout truncates its delay to a signed 32-bit int, so 10^9 seconds
    // would wrap and fire on the next tick — every run cancelled at once, and
    // the failure card blaming a window the reviewer had just widened.
    settings.values = { 'agentRun.inactivitySeconds': 1e9, 'agentRun.ceilingSeconds': 1e9 };
    expect(agentRunTimeouts()).toEqual({ inactivityMs: 0, ceilingMs: 0 });
  });
});

// package.json cannot import the constants, so agreement is enforced here —
// the same mechanism `commands.test.ts` uses for the changeset settings. A
// manifest default that drifts from the code's would ship one number in the
// settings UI and run another.
describe('the manifest contributes what this reader expects', () => {
  // Read, not imported: a JSON import would land in the esbuild bundle.
  const properties = (
    JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      contributes: { configuration: { properties: Record<string, { default?: unknown; minimum?: number }> } };
    }
  ).contributes.configuration.properties;

  it('defaults the two windows to the seconds the code ships as milliseconds', () => {
    expect(properties['codeVerdict.agentRun.inactivitySeconds']?.default).toBe(INACTIVITY_TIMEOUT_MS / 1000);
    expect(properties['codeVerdict.agentRun.ceilingSeconds']?.default).toBe(CEILING_TIMEOUT_MS / 1000);
  });

  it('floors both at 0, which is the reader\'s documented "no limit"', () => {
    expect(properties['codeVerdict.agentRun.inactivitySeconds']?.minimum).toBe(0);
    expect(properties['codeVerdict.agentRun.ceilingSeconds']?.minimum).toBe(0);
  });
});
