/**
 * Agent definitions on disk: `*.agent.md` files with a small YAML-ish header
 * and a markdown body that becomes the reviewing instructions
 * (spec: review-agents).
 *
 * The header parser is hand-rolled and deliberately strict. This project's
 * only runtime dependency is `@vscode/codicons`, and a full YAML parser run
 * over files that arrive from a repository is far more surface than a
 * four-field header needs. The accepted subset is documented on
 * `parseAgentFile` and in the README; anything outside it makes the file
 * *skipped*, never fatal — one unparseable agent must not stop the Run AI
 * Review screen from opening.
 *
 * Nothing here reads `workspace.getConfiguration`: the roots to search arrive
 * as plain data from `ui/agentLocations.ts`, on the `agentRunOptions.ts`
 * precedent.
 */
import * as vscode from 'vscode';
import type { AgentDescriptor, AgentSource } from './agents';

/** A directory to search. `uri` rather than a path so remote and virtual workspaces work. */
export interface AgentSearchRoot {
  /** Stable, path-derived id segment. Never an index into the settings array — reordering must not re-id every agent under it. */
  id: string;
  /** Shown in the picker as the agent's origin. */
  label: string;
  uri: vscode.Uri;
  source: Extract<AgentSource, 'workspace' | 'location'>;
}

export interface SkippedDefinition {
  /** Displayed to the reviewer, so it must identify the file. */
  path: string;
  reason: string;
}

export interface AgentDiscovery {
  agents: AgentDescriptor[];
  skipped: SkippedDefinition[];
}

export const AGENT_FILE_SUFFIX = '.agent.md';

/** The directory searched in every workspace folder without any configuration. */
// vocab-ok: an editor convention path, not a platform noun — the same folder VS Code reads custom agents from, whichever platform hosts the repository
export const DEFAULT_AGENT_DIRECTORY = '.github/agents';

/**
 * The accepted header, in full:
 *
 * - the file opens with a line that is exactly `---`;
 * - the header ends at the next line that is exactly `---`;
 * - every line between is `key: value`, where the value is the rest of the
 *   line, trimmed, with one pair of surrounding quotes removed;
 * - a line that is not `key: value` is ignored rather than rejected, which is
 *   what lets a `tools:` list written for another tool sit in the file
 *   harmlessly;
 * - `name` and `description` are required, as is a non-empty body;
 * - every other key is ignored.
 *
 * No nesting, no multi-line scalars, no anchors. A file that needs them is
 * not a Code Verdict agent.
 */
export function parseAgentFile(
  text: string,
  id: string,
  origin: string,
  source: AgentSearchRoot['source'],
): { agent: AgentDescriptor } | { reason: string } {
  // Tolerate a BOM and CRLF: both arrive routinely from a repository and
  // neither is the author making a mistake.
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return { reason: 'no `---` header on the first line' };

  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) return { reason: 'the `---` header is never closed' };

  const header = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    const [, key, value] = match ?? [];
    if (key === undefined || value === undefined) continue; // a list item or a comment — not ours to read
    header.set(key.toLowerCase(), unquote(value.trim()));
  }

  const name = header.get('name');
  const description = header.get('description');
  if (!name) return { reason: 'no `name` in the header' };
  if (!description) return { reason: 'no `description` in the header' };

  const instructions = lines.slice(end + 1).join('\n').trim();
  if (instructions === '') return { reason: 'the instruction body is empty' };

  const model = header.get('model');
  return {
    agent: {
      id,
      label: name,
      description,
      source,
      instructions,
      // A file may name the model either way round. `lm:` is how this
      // extension ids a model; `vendor/family` is how a person writes one.
      preferredModelId: model ? (model.startsWith('lm:') ? model : `lm:${model}`) : undefined,
      origin,
    },
  };
}

/** Strips one matching pair of surrounding quotes — the only quoting the subset supports. */
function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
  return quoted?.[1] ?? value;
}

/**
 * Every agent definition under `roots`, non-recursively. A root that cannot be
 * read contributes a skip and nothing else — the remaining roots are still
 * searched, because losing every agent because one configured directory was
 * renamed is the worse failure.
 */
export async function discoverAgents(roots: readonly AgentSearchRoot[]): Promise<AgentDiscovery> {
  const agents: AgentDescriptor[] = [];
  const skipped: SkippedDefinition[] = [];

  for (const root of roots) {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(root.uri);
    } catch {
      // Missing, a file rather than a directory, or unreadable. The default
      // `.github/agents` is absent from most workspaces, so this is the
      // ordinary case and not worth reporting for a root nobody configured.
      if (root.source === 'location') {
        skipped.push({ path: root.label, reason: 'the location could not be read' });
      }
      continue;
    }

    const files = entries
      .filter(([name, type]) => type === vscode.FileType.File && name.endsWith(AGENT_FILE_SUFFIX))
      // Directory order is filesystem order; sort so the picker is stable
      // between sessions and two runs list the same agents in the same order.
      .map(([name]) => name)
      .sort();

    for (const name of files) {
      const uri = vscode.Uri.joinPath(root.uri, name);
      let text: string;
      try {
        text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
      } catch {
        skipped.push({ path: `${root.label}/${name}`, reason: 'the file could not be read' });
        continue;
      }
      const parsed = parseAgentFile(text, `agent:${root.id}/${name}`, root.label, root.source);
      if ('reason' in parsed) {
        skipped.push({ path: `${root.label}/${name}`, reason: parsed.reason });
        continue;
      }
      agents.push(parsed.agent);
    }
  }

  return { agents, skipped };
}
