import { describe, expect, it } from 'vitest';
import { getDebugAuthBypass } from './debugAuth';

const FLAG = { VERDICT_DEBUG_AUTH_BYPASS: '1' };

describe('getDebugAuthBypass', () => {
  it('requires BOTH the env opt-in and an Extension Development Host (mode 2)', () => {
    expect(getDebugAuthBypass(2, FLAG)).toEqual({
      enabled: true,
      providerId: 'gitlab',
      instanceUrl: 'http://127.0.0.1:8971',
      token: 'glpat-emulator',
      reason: 'development',
    });
    // vscode.ExtensionMode.Production === 1 — an inherited environment
    // must never activate the bypass in a packaged install.
    expect(getDebugAuthBypass(1, FLAG)).toBeNull();
    // ExtensionMode.Test === 3.
    expect(getDebugAuthBypass(3, FLAG)).toBeNull();
    // Development host without the flag stays off.
    expect(getDebugAuthBypass(2, {})).toBeNull();
    expect(getDebugAuthBypass(undefined, FLAG)).toBeNull();
  });

  it('allows an explicit override from the environment', () => {
    expect(
      getDebugAuthBypass(2, {
        VERDICT_DEBUG_AUTH_BYPASS: '1',
        CODE_VERDICT_DEBUG_INSTANCE_URL: 'http://127.0.0.1:9000',
        CODE_VERDICT_DEBUG_TOKEN: 'glpat-debug',
      }),
    ).toEqual({
      enabled: true,
      providerId: 'gitlab',
      instanceUrl: 'http://127.0.0.1:9000',
      token: 'glpat-debug',
      reason: 'override',
    });
  });
});
