/**
 * The directories searched for `*.agent.md` definitions, on the
 * `agentRunOptions.ts` precedent: the setting is read here in the UI layer
 * and handed down as plain data, so `app/agentDefinitions.ts` never reaches
 * for `workspace.getConfiguration` and stays unit-testable.
 *
 * Every workspace folder's `.github/agents` is searched without any
 * configuration. Configured locations are searched *in addition to* those,
 * never instead of them — a reviewer who adds a personal directory has not
 * asked to stop seeing the ones their team committed.
 */
import * as vscode from 'vscode';
import { DEFAULT_AGENT_DIRECTORY, type AgentSearchRoot } from '../app/agentDefinitions';

/**
 * A path-derived id segment. Deliberately not the location's index in the
 * settings array: reordering or removing an entry would then silently re-id
 * every agent under every later one, and each would come back as "the agent
 * you selected no longer exists".
 */
function rootId(prefix: string, path: string): string {
  return `${prefix}-${path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}`;
}

export function agentSearchRoots(): AgentSearchRoot[] {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const roots: AgentSearchRoot[] = folders.map((folder) => ({
    id: rootId('workspace', folder.name),
    // In a single-folder window the folder name adds nothing; in a multi-root
    // one it is the only thing telling two same-named agents apart.
    label: folders.length > 1 ? `${folder.name}/${DEFAULT_AGENT_DIRECTORY}` : DEFAULT_AGENT_DIRECTORY,
    uri: vscode.Uri.joinPath(folder.uri, DEFAULT_AGENT_DIRECTORY),
    source: 'workspace',
  }));

  const configured = vscode.workspace.getConfiguration('codeVerdict').get<string[]>('agentLocations') ?? [];
  for (const entry of configured) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const uri = resolveLocation(entry.trim(), folders);
    if (!uri) continue;
    roots.push({ id: rootId('location', entry.trim()), label: entry.trim(), uri, source: 'location' });
  }
  return roots;
}

/**
 * A configured location is absolute or workspace-relative. A relative entry
 * resolves against the first workspace folder; with no folder open there is
 * nothing to resolve it against and it is dropped rather than guessed at.
 */
function resolveLocation(entry: string, folders: readonly vscode.WorkspaceFolder[]): vscode.Uri | undefined {
  if (entry.startsWith('/') || /^[A-Za-z]:[\\/]/.test(entry)) return vscode.Uri.file(entry);
  const first = folders[0];
  return first ? vscode.Uri.joinPath(first.uri, entry) : undefined;
}
