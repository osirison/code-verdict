/**
 * Palette/keybinding → FlowMessage mapping shared by the single-CR and
 * changeset review panels (handoff §6 keyboard map). Whichever panel holds
 * `verdict.reviewFocus` translates the command through the same table.
 */
import { INTERNAL_COMMANDS } from '../commands';
import { SEVERITY_ORDER } from '../domain/criteria';
import type { Severity, Verdict } from '../domain/types';
import type { FlowMessage } from './reviewFlowHtml';

export function flowCommandMessage(
  command: string,
  arg: unknown,
  selectedId: string | undefined,
): FlowMessage | undefined {
  if (command === INTERNAL_COMMANDS.jumpSeverity) {
    // `1`–`4` carry their severity as the keybinding's `args`.
    if (!SEVERITY_ORDER.includes(arg as Severity)) return undefined;
    return { type: 'jumpSeverity', severity: arg as Severity };
  }
  const simple: Record<string, FlowMessage | undefined> = {
    'codeVerdict.acceptItem': selectedId
      ? { type: 'verdict', itemId: selectedId, verdict: 'accepted' as Verdict, applyFix: true }
      : undefined,
    'codeVerdict.acceptItemApplyFix': selectedId
      ? { type: 'verdict', itemId: selectedId, verdict: 'accepted' as Verdict, applyFix: true }
      : undefined,
    // `⇧A` — accept the finding, leave the author's code alone.
    [INTERNAL_COMMANDS.acceptCommentOnly]: selectedId
      ? { type: 'verdict', itemId: selectedId, verdict: 'accepted' as Verdict, applyFix: false }
      : undefined,
    [INTERNAL_COMMANDS.undoVerdict]: selectedId
      ? { type: 'undo', itemId: selectedId }
      : undefined,
    // "Ask agent about this item" from the palette opens the deep dive on
    // the selected finding; the presets stay idempotent per item.
    'codeVerdict.askAgent': selectedId
      ? { type: 'ask', itemId: selectedId, preset: 'explain' as const }
      : undefined,
    'codeVerdict.rejectItem': selectedId
      ? { type: 'verdict', itemId: selectedId, verdict: 'rejected' as Verdict, applyFix: false }
      : undefined,
    'codeVerdict.skipItem': selectedId
      ? { type: 'verdict', itemId: selectedId, verdict: 'skipped' as Verdict, applyFix: false }
      : undefined,
    'codeVerdict.nextItem': { type: 'move', delta: 1 },
    'codeVerdict.prevItem': { type: 'move', delta: -1 },
    'codeVerdict.generateSummary': { type: 'generateSummary' },
    'codeVerdict.submitReview': { type: 'submit' },
    'codeVerdict.runReview': { type: 'run' },
  };
  return simple[command];
}
