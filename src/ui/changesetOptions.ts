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
  return vscode.workspace.getConfiguration('codeVerdict').get<string>('changesets.trailer', DEFAULT_TRAILER);
}

export function changesetDetectionOptions(globalState: KeyValueStore, podId: string | undefined): ChangesetDetectionOptions {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return {
    trailer: changesetTrailer(),
    branchFallback: config.get<boolean>('changesets.branchDetection', true),
    manual: podId ? new ManualChangesetStore(globalState).list(podId) : [],
  };
}
