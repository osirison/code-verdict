import { beforeEach, describe, expect, it, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));
const workspace = vi.hoisted(() => ({ folders: undefined as unknown[] | undefined }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => settings.values[key] }),
    get workspaceFolders() { return workspace.folders; },
  },
  Uri: {
    file: (path: string) => ({ fsPath: path, path }),
    joinPath: (base: { path: string }, ...segments: string[]) => ({
      fsPath: [base.path, ...segments].join('/'),
      path: [base.path, ...segments].join('/'),
    }),
  },
}));

import { agentSearchRoots } from './agentLocations';

const FOLDER = { name: 'acme', uri: { path: '/w/acme', fsPath: '/w/acme' } };

describe('codeVerdict.agentLocations read path', () => {
  beforeEach(() => {
    settings.values = {};
    workspace.folders = [FOLDER];
  });

  it('searches only the workspace default when the setting is absent', () => {
    expect(agentSearchRoots().map((root) => root.source)).toEqual(['workspace']);
  });

  it('adds each configured absolute location alongside the workspace default', () => {
    settings.values['agentLocations'] = ['/srv/agents', '  ', 'team/agents'];
    expect(agentSearchRoots().map((root) => root.label)).toEqual([
      '.github/agents',
      '/srv/agents',
      'team/agents',
    ]);
  });

  // A bare string in settings.json is the shape this guard exists for: `String`
  // is iterable, so `for…of` over it yields one character at a time. Without
  // `Array.isArray`, "/srv/agents" became eleven configured locations — ten of
  // them one-character relative paths resolved against the workspace folder —
  // and the settings panel listed eleven rows it would then try to read.
  it('treats a bare string as no configured location rather than one root per character', () => {
    settings.values['agentLocations'] = '/srv/agents';
    expect(agentSearchRoots().map((root) => root.source)).toEqual(['workspace']);
  });

  // The other half of the same guard, and the sharper one: a number, boolean or
  // object is not iterable at all, so `for…of` threw `TypeError` straight out of
  // `agentSearchRoots` — into agent discovery, which starts every review, and
  // into the settings panel's location scan. Neither caller catches it, so a
  // single mistyped setting took out the agent picker entirely.
  it('falls back to no configured location instead of throwing on a non-iterable value', () => {
    for (const value of [42, true, { '/srv/agents': true }, null]) {
      settings.values['agentLocations'] = value;
      expect(() => agentSearchRoots(), String(value)).not.toThrow();
      expect(agentSearchRoots().map((root) => root.source), String(value)).toEqual(['workspace']);
    }
  });

  // The per-entry guard that already existed, pinned beside the array guard so
  // the two are not confused: a well-formed array can still carry junk, and a
  // non-string entry is dropped without taking the valid entries with it.
  it('drops non-string entries from a well-formed array and keeps the valid ones', () => {
    settings.values['agentLocations'] = [7, '/srv/agents', null, { path: '/x' }];
    expect(agentSearchRoots().map((root) => root.label)).toEqual(['.github/agents', '/srv/agents']);
  });
});
