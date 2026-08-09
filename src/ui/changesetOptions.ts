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

export function changesetDetectionOptions(globalState: KeyValueStore, podId: string | undefined): ChangesetDetectionOptions {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return {
    trailer: config.get<string>('changesets.trailer', DEFAULT_TRAILER),
    branchFallback: config.get<boolean>('changesets.branchDetection', true),
    manual: podId ? new ManualChangesetStore(globalState).list(podId) : [],
  };
}
