import { describe, expect, it } from 'vitest';
import { getDebugAuthBypass } from './debugAuth';

describe('getDebugAuthBypass', () => {
  it('returns emulator credentials in development mode', () => {
    expect(getDebugAuthBypass(1)).toEqual({
      enabled: true,
      instanceUrl: 'http://127.0.0.1:8971',
      token: 'glpat-emulator',
      reason: 'development',
    });
  });

  it('returns null outside development mode', () => {
    expect(getDebugAuthBypass(2)).toBeNull();
  });

  it('allows an explicit override from the environment', () => {
    expect(
      getDebugAuthBypass(undefined, {
        VERDICT_DEBUG_AUTH_BYPASS: '1',
        CODE_VERDICT_DEBUG_INSTANCE_URL: 'http://127.0.0.1:9000',
        CODE_VERDICT_DEBUG_TOKEN: 'glpat-debug',
      }),
    ).toEqual({
      enabled: true,
      instanceUrl: 'http://127.0.0.1:9000',
      token: 'glpat-debug',
      reason: 'override',
    });
  });
});
