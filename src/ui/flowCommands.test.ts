import { describe, expect, it, vi } from 'vitest';
import { INTERNAL_COMMANDS } from '../commands';
import { isTriageOnlyMessage, routeToActiveReviewCommand } from './flowCommands';
import type { FlowMessage } from './reviewFlowHtml';

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

describe('isTriageOnlyMessage', () => {
  it('is true for exactly verdict, undo, move and jumpSeverity', () => {
    const triageOnly: FlowMessage[] = [
      { type: 'verdict', itemId: 'i1', verdict: 'accepted', applyFix: false },
      { type: 'undo', itemId: 'i1' },
      { type: 'move', delta: 1 },
      { type: 'jumpSeverity', severity: 'blocker' },
    ];
    for (const message of triageOnly) {
      expect(isTriageOnlyMessage(message)).toBe(true);
    }
  });

  it('is false for messages that are not scoped to triage', () => {
    const notTriageOnly: FlowMessage[] = [
      { type: 'select', itemId: 'i1' },
      { type: 'setMode', mode: 'queue' },
      { type: 'ask', itemId: 'i1', preset: 'explain' },
      { type: 'generateSummary' },
      { type: 'submit' },
    ];
    for (const message of notTriageOnly) {
      expect(isTriageOnlyMessage(message)).toBe(false);
    }
  });
});