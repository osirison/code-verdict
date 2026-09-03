import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_COMMANDS } from '../commands';
import { routeToActiveReviewCommand } from './flowCommands';

describe('review command routing', () => {
  it('dispatches Add Context only to the currently active panel', () => {
    const stale = vi.fn(() => true);
    const active = vi.fn(() => true);

    expect(routeToActiveReviewCommand(INTERNAL_COMMANDS.addContext, undefined, [
      { isActive: () => false, handle: stale },
      { isActive: () => true, handle: active },
    ])).toBe(true);
    expect(stale).not.toHaveBeenCalled();
    expect(active).toHaveBeenCalledWith(INTERNAL_COMMANDS.addContext, undefined);
  });

  it('does not fall through to a stale panel when no review is active', () => {
    const stale = vi.fn(() => true);

    expect(routeToActiveReviewCommand(INTERNAL_COMMANDS.addContext, undefined, [
      { isActive: () => false, handle: stale },
    ])).toBe(false);
    expect(stale).not.toHaveBeenCalled();
  });
});