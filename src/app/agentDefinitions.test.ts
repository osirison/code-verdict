import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_AGENT_DESCRIPTOR, BUILTIN_AGENT_ID } from './agents';
import { reconcile } from './podSelection';

/**
 * `discoverAgents` is the only part of this module that touches vscode, and
 * only for `workspace.fs` and `Uri.joinPath`. The fake below is an in-memory
 * filesystem: a path that is absent throws the way `workspace.fs` does.
 */
const files = vi.hoisted(() => new Map<string, string>());
const dirs = vi.hoisted(() => new Map<string, Array<[string, number]>>());

vi.mock('vscode', () => ({
  FileType: { File: 1, Directory: 2 },
  Uri: {
    joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }),
    file: (path: string) => ({ path }),
  },
  workspace: {
    fs: {
      readDirectory: async (uri: { path: string }) => {
        const entry = dirs.get(uri.path);
        if (!entry) throw new Error('ENOENT');
        return entry;
      },
      readFile: async (uri: { path: string }) => {
        const text = files.get(uri.path);
        if (text === undefined) throw new Error('ENOENT');
        return new TextEncoder().encode(text);
      },
    },
  },
}));

import { discoverAgents, parseAgentFile } from './agentDefinitions';

const VALID = `---
name: Security Reviewer
description: Reads for injection, authz and secret handling.
---

Look hard at authentication boundaries.`;

describe('parseAgentFile accepts the documented subset', () => {
  const parse = (text: string) => parseAgentFile(text, 'agent:ws/x.agent.md', '.github/agents', 'workspace');

  it('parses a valid file', () => {
    const result = parse(VALID);
    expect(result).toMatchObject({
      agent: {
        label: 'Security Reviewer',
        description: 'Reads for injection, authz and secret handling.',
        instructions: 'Look hard at authentication boundaries.',
        source: 'workspace',
        origin: '.github/agents',
      },
    });
  });

  it('rejects a file with no opening fence', () => {
    expect(parse('name: X\n\nbody')).toEqual({ reason: 'no `---` header on the first line' });
  });

  it('rejects a header that is never closed', () => {
    expect(parse('---\nname: X\ndescription: Y\n\nbody')).toEqual({ reason: 'the `---` header is never closed' });
  });

  it('rejects a missing name', () => {
    expect(parse('---\ndescription: Y\n---\n\nbody')).toEqual({ reason: 'no `name` in the header' });
  });

  it('rejects a missing description', () => {
    expect(parse('---\nname: X\n---\n\nbody')).toEqual({ reason: 'no `description` in the header' });
  });

  it('rejects an empty instruction body', () => {
    expect(parse('---\nname: X\ndescription: Y\n---\n\n   \n')).toEqual({ reason: 'the instruction body is empty' });
  });

  it('ignores a tools list written for another tool', () => {
    // The subset has no lists; a `tools:` block must be harmless, not fatal —
    // this repo's own .github/agents file carries one.
    const result = parse('---\nname: X\ndescription: Y\ntools:\n  - "execute"\n  - "read"\n---\n\nbody');
    expect(result).toHaveProperty('agent');
    expect((result as { agent: { instructions: string } }).agent.instructions).toBe('body');
  });

  it('strips one pair of surrounding quotes', () => {
    const result = parse('---\nname: "Quoted Name"\ndescription: \'single\'\n---\n\nbody');
    expect(result).toMatchObject({ agent: { label: 'Quoted Name', description: 'single' } });
  });

  it('carries `model:` into preferredModelId, prefixing a bare vendor/family', () => {
    const bare = parse('---\nname: X\ndescription: Y\nmodel: copilot/gpt-5\n---\n\nbody');
    expect(bare).toMatchObject({ agent: { preferredModelId: 'lm:copilot/gpt-5' } });
    const prefixed = parse('---\nname: X\ndescription: Y\nmodel: lm:copilot/gpt-5\n---\n\nbody');
    expect(prefixed).toMatchObject({ agent: { preferredModelId: 'lm:copilot/gpt-5' } });
  });

  it('tolerates CRLF and a BOM', () => {
    const result = parse('﻿---\r\nname: X\r\ndescription: Y\r\n---\r\n\r\nbody');
    expect(result).toMatchObject({ agent: { label: 'X', instructions: 'body' } });
  });
});

describe('discoverAgents', () => {
  beforeEach(() => { files.clear(); dirs.clear(); });

  const root = (id: string, path: string, source: 'workspace' | 'location' = 'workspace') =>
    ({ id, label: path, uri: { path } as never, source });

  it('yields the valid agents and one skip for the malformed one', () => {
    dirs.set('/ws/.github/agents', [['a.agent.md', 1], ['b.agent.md', 1], ['bad.agent.md', 1], ['README.md', 1]]);
    files.set('/ws/.github/agents/a.agent.md', VALID);
    files.set('/ws/.github/agents/b.agent.md', VALID.replace('Security Reviewer', 'Perf Reviewer'));
    files.set('/ws/.github/agents/bad.agent.md', 'no header at all');

    return discoverAgents([root('ws', '/ws/.github/agents')]).then((result) => {
      expect(result.agents.map((a) => a.label)).toEqual(['Security Reviewer', 'Perf Reviewer']);
      expect(result.skipped).toEqual([
        { path: '/ws/.github/agents/bad.agent.md', reason: 'no `---` header on the first line' },
      ]);
    });
  });

  it('ignores files that are not *.agent.md', async () => {
    dirs.set('/ws/a', [['notes.md', 1], ['x.agent.md', 1]]);
    files.set('/ws/a/x.agent.md', VALID);
    const result = await discoverAgents([root('ws', '/ws/a')]);
    expect(result.agents).toHaveLength(1);
  });

  it('does not descend into subdirectories', async () => {
    dirs.set('/ws/a', [['nested', 2], ['x.agent.md', 1]]);
    dirs.set('/ws/a/nested', [['deep.agent.md', 1]]);
    files.set('/ws/a/x.agent.md', VALID);
    files.set('/ws/a/nested/deep.agent.md', VALID);
    const result = await discoverAgents([root('ws', '/ws/a')]);
    expect(result.agents).toHaveLength(1);
  });

  it('an unreadable configured location is reported and does not stop the others', async () => {
    dirs.set('/ws/ok', [['x.agent.md', 1]]);
    files.set('/ws/ok/x.agent.md', VALID);
    const result = await discoverAgents([
      root('gone', '/nowhere', 'location'),
      root('ok', '/ws/ok', 'location'),
    ]);
    expect(result.agents).toHaveLength(1);
    expect(result.skipped).toEqual([{ path: '/nowhere', reason: 'the location could not be read' }]);
  });

  it('a missing default workspace folder is silent — most workspaces have none', async () => {
    const result = await discoverAgents([root('ws', '/ws/.github/agents')]);
    expect(result).toEqual({ agents: [], skipped: [] });
  });

  it('two folders declaring the same agent name yield two distinct entries', async () => {
    dirs.set('/one/.github/agents', [['sec.agent.md', 1]]);
    dirs.set('/two/.github/agents', [['sec.agent.md', 1]]);
    files.set('/one/.github/agents/sec.agent.md', VALID);
    files.set('/two/.github/agents/sec.agent.md', VALID);
    const result = await discoverAgents([
      root('workspace-one', '/one/.github/agents'),
      root('workspace-two', '/two/.github/agents'),
    ]);
    expect(result.agents).toHaveLength(2);
    // Same declared name; the ids and the origins are what tell them apart.
    expect(result.agents[0]?.label).toBe(result.agents[1]?.label);
    expect(result.agents[0]?.id).not.toBe(result.agents[1]?.id);
    expect(result.agents[0]?.origin).not.toBe(result.agents[1]?.origin);
  });

  it('lists agents in a stable order rather than filesystem order', async () => {
    dirs.set('/ws/a', [['z.agent.md', 1], ['a.agent.md', 1]]);
    files.set('/ws/a/z.agent.md', VALID.replace('Security Reviewer', 'Zed'));
    files.set('/ws/a/a.agent.md', VALID.replace('Security Reviewer', 'Alpha'));
    const result = await discoverAgents([root('ws', '/ws/a')]);
    expect(result.agents.map((a) => a.label)).toEqual(['Alpha', 'Zed']);
  });
});

describe('re-discovery after the filesystem changes (spec: Agent set changes while the screen is open)', () => {
  beforeEach(() => { files.clear(); dirs.clear(); });

  const root = { id: 'ws', label: '/ws/a', uri: { path: '/ws/a' } as never, source: 'workspace' as const };

  /**
   * `refreshAgents` on the panel is discovery followed by `reconcile`. The
   * event plumbing that triggers it (a file-system watcher,
   * `onDidChangeChatModels`, a settings change) is not exercised here — that
   * is the manual check — but the behaviour those events produce is.
   */
  it('picks up an edited agent file', async () => {
    dirs.set('/ws/a', [['sec.agent.md', 1]]);
    files.set('/ws/a/sec.agent.md', VALID);
    expect((await discoverAgents([root])).agents[0]?.label).toBe('Security Reviewer');

    files.set('/ws/a/sec.agent.md', VALID.replace('Security Reviewer', 'Renamed'));
    expect((await discoverAgents([root])).agents[0]?.label).toBe('Renamed');
  });

  it('deleting the selected agent falls back to the built-in one with a notice', async () => {

    dirs.set('/ws/a', [['sec.agent.md', 1]]);
    files.set('/ws/a/sec.agent.md', VALID);
    const first = await discoverAgents([root]);
    const selected = first.agents[0]!.id;

    dirs.set('/ws/a', []);
    const second = await discoverAgents([root]);
    const settled = reconcile(
      { agentId: selected, modelId: 'lm:copilot/gpt-5' },
      { agents: [BUILTIN_AGENT_DESCRIPTOR, ...second.agents], models: [
        { id: 'lm:copilot/gpt-5', label: 'GPT-5', description: '', vendor: 'copilot', family: 'gpt-5' },
      ] },
    );
    expect(settled.agentId).toBe(BUILTIN_AGENT_ID);
    expect(settled.notices.join(' ')).toContain(selected);
    // The model survives an agent that did not.
    expect(settled.modelId).toBe('lm:copilot/gpt-5');
  });

  it('a newly added agent file appears', async () => {
    dirs.set('/ws/a', []);
    expect((await discoverAgents([root])).agents).toHaveLength(0);
    dirs.set('/ws/a', [['new.agent.md', 1]]);
    files.set('/ws/a/new.agent.md', VALID);
    expect((await discoverAgents([root])).agents).toHaveLength(1);
  });
});

describe('the real agent file committed in this repository', () => {
  it('parses under the strict subset — tools list, quoted description and all', () => {
    // The realistic input: a file written for VS Code's own custom-agent
    // format, carrying keys this parser does not read. If the subset were too
    // strict to accept it, the format would be wrong, not the file.
    const text = readFileSync(join(process.cwd(), '.github/agents/openspec.agent.md'), 'utf8');
    const result = parseAgentFile(text, 'agent:ws/openspec.agent.md', '.github/agents', 'workspace');
    expect(result).toHaveProperty('agent');
    const { agent } = result as { agent: { label: string; description: string; instructions: string } };
    expect(agent.label).toBe('OpenSpec');
    expect(agent.description).toContain('Manages OpenSpec changes');
    // The body starts after the header, and the header's own keys are not in it.
    expect(agent.instructions).toContain('# OpenSpec Agent');
    expect(agent.instructions.startsWith('name:')).toBe(false);
  });
});
