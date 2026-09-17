/**
 * One reader for the changeset detection inputs, so every surface —
 * dashboard, sidebar, changeset screen, combined review — detects with the
 * same trailer, the same branch-fallback switch, and the same manual groups.
 * Settings are read here in the UI layer; `detectChangesets` itself stays
 * pure and vscode-free.
 */
import * as vscode from 'vscode';
import type { ChangesetDetectionOptions } from '../app/changesets';
import { DEFAULT_TRAILER } from '../app/changesets';
import { ManualChangesetStore } from '../app/manualChangesets';
import type { KeyValueStore } from '../app/storage';

/**
 * The trailer alone. The review context resolves the same links without
 * detecting any group, so it needs neither the branch switch nor the manual
 * store — but it must read the setting through the same one reader, or a team
 * that configured `Closes` gets links in one surface and none in the other.
 */
export function changesetTrailer(): string {
  const value = vscode.workspace.getConfiguration('codeVerdict').get<unknown>('changesets.trailer');
  // `typeof`, not `?? DEFAULT_TRAILER`: `get` hands back whatever settings.json
  // holds, and every consumer of the trailer calls `.trim()` on it first
  // (`detectChangesets`, `linkedWorkItemNumbers`). A number or an object
  // therefore threw `TypeError` out of changeset detection — which runs on the
  // dashboard, the sidebar and the review context — rather than detecting
  // nothing. `escapeRegExp` in `changesets.ts` already handles a string full of
  // regex metacharacters, so only the type is checked here.
  return typeof value === 'string' ? value : DEFAULT_TRAILER;
}

export function changesetDetectionOptions(globalState: KeyValueStore, podId: string | undefined): ChangesetDetectionOptions {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  const branchDetection = config.get<unknown>('changesets.branchDetection');
  return {
    trailer: changesetTrailer(),
    // Read truthily by `detectChangesets`, so a non-boolean used to half-apply
    // in whichever direction it happened to coerce: `0` or `""` silently
    // switched the branch fallback off though it ships on.
    branchFallback: typeof branchDetection === 'boolean' ? branchDetection : true,
    manual: podId ? new ManualChangesetStore(globalState).list(podId) : [],
  };
}
