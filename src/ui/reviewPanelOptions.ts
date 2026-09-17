/**
 * Settings the two triage screens share, on the `agentRunOptions.ts` /
 * `changesetOptions.ts` precedent: read once here in the UI layer rather than
 * inline in each panel.
 *
 * `reviewFlow.ts` and `changesetReview.ts` render the same triage keyboard over
 * different targets, so a setting either of them honours has to be honoured by
 * both in the same way. Two inline `getConfiguration` reads are two places for
 * that agreement to drift — and they had already drifted in the way that
 * matters here: both cast the raw value straight to `boolean`, so neither
 * validated it.
 */
import * as vscode from 'vscode';

/** Matches `package.json`: after a verdict, move to the next undecided item. */
export const DEFAULT_AUTO_ADVANCE = true;

/**
 * Whether a verdict advances the selection.
 *
 * `typeof`, not the two-argument `get(key, true)` both panels used: that
 * default only applies to a missing key, so anything else in settings.json
 * reached the `if` and was read truthily. `0`, `""` and `null` therefore
 * stopped the cursor advancing — the opposite of the shipped default — from a
 * value that is not a boolean at all, and the reviewer had no way to tell that
 * from having switched it off deliberately.
 */
export function readAutoAdvance(): boolean {
  const value = vscode.workspace.getConfiguration('codeVerdict').get<unknown>('autoAdvance');
  return typeof value === 'boolean' ? value : DEFAULT_AUTO_ADVANCE;
}
