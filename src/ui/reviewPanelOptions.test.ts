import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string, fallback?: unknown) => (key in settings.values ? settings.values[key] : fallback),
    }),
  },
}));

import { DEFAULT_AUTO_ADVANCE, readAutoAdvance } from './reviewPanelOptions';

describe('codeVerdict.autoAdvance read path', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('advances when unset, matching the manifest default, and honours an explicit false', () => {
    expect(DEFAULT_AUTO_ADVANCE).toBe(true);
    expect(readAutoAdvance()).toBe(true);
    settings.values['autoAdvance'] = false;
    expect(readAutoAdvance()).toBe(false);
  });

  // Both panels used to read this with `get<boolean>('autoAdvance', true)` and
  // put the result straight in an `if`. That default only covers a missing key,
  // so every other value was read truthily — and the falsy non-booleans are the
  // damaging half: `0`, `""` and `null` stopped the cursor advancing after every
  // verdict, which is the opposite of the shipped default and looks exactly like
  // having switched the setting off on purpose.
  it('reads a falsy non-boolean as the shipped on rather than silently stopping the cursor', () => {
    for (const bad of [0, '', null, Number.NaN]) {
      settings.values['autoAdvance'] = bad;
      expect(readAutoAdvance(), String(bad)).toBe(true);
    }
  });

  // The other direction, asserted separately so "true" is never mistaken for
  // proof: a truthy non-boolean must land on the default because it is the
  // default, not because `Boolean(value)` happened to agree with it.
  it('reads a truthy non-boolean as the shipped default too, not as a value it coerced', () => {
    for (const bad of ['false', 'off', 1, {}, []]) {
      settings.values['autoAdvance'] = bad;
      expect(readAutoAdvance(), String(bad)).toBe(DEFAULT_AUTO_ADVANCE);
    }
  });
});
