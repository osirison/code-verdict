/**
 * The removal of the seven settings this extension used to declare, swept on
 * every activation rather than once behind a stored flag.
 *
 * This is the only thing in the codebase that writes to the user's settings
 * without being asked, so the tests are about what it must never do as much as
 * what it does: never a key outside the list, never a write against a scope
 * that holds nothing, never an exception that reaches activation.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Scope = 'global' | 'workspace' | 'folder';

interface Stored {
  globalValue?: unknown;
  workspaceValue?: unknown;
  workspaceFolderValue?: unknown;
}

const world = vi.hoisted(() => ({
  /** Section-scoped store: `values[key]` per scope, exactly what `inspect` reports. */
  values: {} as Record<string, { globalValue?: unknown; workspaceValue?: unknown }>,
  /** Per-folder-uri store for the resource-scoped handle. */
  folderValues: {} as Record<string, Record<string, unknown>>,
  folders: [] as Array<{ uri: { fsPath: string } }>,
  /** Every `update` this run attempted, in order: key, target, value. */
  updates: [] as Array<{ key: string; target: number; value: unknown; resource?: string }>,
  /** Targets whose `update` throws, standing in for a read-only scope or a VS Code that refuses an undeclared key. */
  failingTargets: new Set<number>(),
  /** `ConfigurationTarget`, hoisted with the rest so the `vi.mock` factory can hand it back. */
  TARGET: { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const,
}));

const TARGET = world.TARGET;

vi.mock('vscode', () => ({
  ConfigurationTarget: world.TARGET,
  workspace: {
    get workspaceFolders() {
      return world.folders.length > 0 ? world.folders : undefined;
    },
    getConfiguration: (_section: string, resource?: { fsPath: string }) => ({
      inspect: (key: string): Stored | undefined => {
        if (resource) {
          const value = world.folderValues[resource.fsPath]?.[key];
          return value === undefined ? undefined : { workspaceFolderValue: value };
        }
        return world.values[key];
      },
      update: (key: string, value: unknown, target: number) => {
        world.updates.push({ key, target, value, resource: resource?.fsPath });
        if (world.failingTargets.has(target)) return Promise.reject(new Error(`scope ${target} is read-only`));
        if (resource) delete world.folderValues[resource.fsPath]?.[key];
        else if (target === world.TARGET.Global) delete world.values[key]?.globalValue;
        else delete world.values[key]?.workspaceValue;
        return Promise.resolve();
      },
    }),
  },
}));

import { removeDeadSettings, REMOVED_SETTING_KEYS } from './settingsMigration';

function sinks(): { notify: string[]; trace: string[]; notify_: (m: string) => void; trace_: (l: string) => void } {
  const notify: string[] = [];
  const trace: string[] = [];
  return { notify, trace, notify_: (m) => void notify.push(m), trace_: (l) => void trace.push(l) };
}

async function sweep(): Promise<{ notify: string[]; trace: string[]; removed: Array<{ key: string; scope: string }> }> {
  const s = sinks();
  const report = await removeDeadSettings({ notify: s.notify_, trace: s.trace_ });
  return { notify: s.notify, trace: s.trace, removed: report.removed };
}

function seed(key: string, scope: Scope, value: unknown = 'x'): void {
  if (scope === 'folder') {
    world.folders = [{ uri: { fsPath: '/w/one' } }];
    world.folderValues['/w/one'] = { ...(world.folderValues['/w/one'] ?? {}), [key]: value };
    return;
  }
  world.values[key] = {
    ...(world.values[key] ?? {}),
    ...(scope === 'global' ? { globalValue: value } : { workspaceValue: value }),
  };
}

beforeEach(() => {
  world.values = {};
  world.folderValues = {};
  world.folders = [];
  world.updates = [];
  world.failingTargets = new Set();
});

describe('the seven keys the migration is allowed to touch', () => {
  it('is exactly the seven that were removed from the manifest, in no other form than a literal list', () => {
    expect([...REMOVED_SETTING_KEYS].sort()).toEqual([
      'agent',
      'categories',
      'extraInstructions',
      'minConfidence',
      'pods',
      'severityFloor',
      'shareAcceptRejectRates',
    ]);
  });

  // package.json cannot import this module, so the agreement is enforced here —
  // the same mechanism `commands.test.ts` uses to pin the contributed commands.
  // A key that is both declared and on this list would be stripped out of the
  // user's settings on every activation while the settings UI still offered it,
  // so the write and the warning would chase each other forever.
  it('names no key package.json still declares, which would strip a live setting on every activation', () => {
    const pkg = JSON.parse(
      readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'),
    ) as { contributes: { configuration: { properties: Record<string, unknown> } } };
    const declared = Object.keys(pkg.contributes.configuration.properties);
    for (const key of REMOVED_SETTING_KEYS) expect(declared, key).not.toContain(`codeVerdict.${key}`);
  });

  // The rule that keeps this from being data loss. A prefix or pattern sweep
  // over `codeVerdict.*` would delete a key this extension never declared — one
  // a future version adds and this build has not heard of, above all — so the
  // migration must leave every unlisted key alone even when it sits in the same
  // section, in the same scope, beside one it is removing.
  it('leaves an unlisted codeVerdict key untouched even when it sits beside one being removed', async () => {
    seed('severityFloor', 'global');
    seed('harness.maxModelTurnsPerAttempt', 'global', 64);
    seed('somethingAFutureVersionAdds', 'global', true);

    await sweep();

    expect(world.updates.map((u) => u.key)).toEqual(['severityFloor']);
    expect(world.values['harness.maxModelTurnsPerAttempt']?.globalValue).toBe(64);
    expect(world.values['somethingAFutureVersionAdds']?.globalValue).toBe(true);
  });
});

describe('removing the dead settings from every scope', () => {
  it('removes a key from user, workspace and workspace-folder settings alike, naming each scope', async () => {
    seed('agent', 'global');
    seed('agent', 'workspace');
    seed('agent', 'folder');

    const { removed } = await sweep();

    expect(removed).toEqual([
      { key: 'agent', scope: 'user' },
      { key: 'agent', scope: 'workspace' },
      { key: 'agent', scope: 'workspace folder' },
    ]);
    expect(world.updates.map((u) => u.target)).toEqual([TARGET.Global, TARGET.Workspace, TARGET.WorkspaceFolder]);
    // `undefined` is what removes a key; any other value would leave it in the
    // file with new contents rather than taking it out.
    for (const update of world.updates) expect(update.value).toBeUndefined();
  });

  // The inspect gate. `update(key, undefined, target)` against a scope holding
  // nothing is a write nobody asked for, and against `Workspace` with no
  // workspace open it throws — so an already-clean configuration has to make no
  // write at all. This is also what makes running the sweep on every activation
  // free, which is why there is no stored "already migrated" flag to go stale.
  it('issues no write at all for a key that is not present, in any scope', async () => {
    await sweep();
    expect(world.updates).toEqual([]);
  });

  it('is idempotent: the second sweep of the same configuration writes nothing and says nothing', async () => {
    seed('pods', 'global', [{ id: 'pod-1' }]);
    const first = await sweep();
    expect(first.removed).toHaveLength(1);

    world.updates = [];
    const second = await sweep();

    expect(second.removed).toEqual([]);
    expect(world.updates).toEqual([]);
    expect(second.notify).toEqual([]);
  });

  it('sweeps every workspace folder, not only the first', async () => {
    world.folders = [{ uri: { fsPath: '/w/one' } }, { uri: { fsPath: '/w/two' } }];
    world.folderValues['/w/one'] = { categories: ['security'] };
    world.folderValues['/w/two'] = { categories: ['tests'] };

    await sweep();

    expect(world.updates.map((u) => u.resource)).toEqual(['/w/one', '/w/two']);
  });
});

describe('a settings cleanup that cannot fail activation', () => {
  // The whole point of the per-write try/catch. A read-only scope, a settings
  // file the editor cannot write, and — inferred, since this suite mocks
  // `vscode` — a VS Code build that refuses `update()` on a key no longer in
  // the manifest all surface the same way: this scope is skipped and the rest
  // still run. A rejection reaching `activate()` would be a settings cleanup
  // that stopped the extension starting.
  it('skips a scope whose write throws, still removing the same key from the scopes that work', async () => {
    world.failingTargets.add(TARGET.Global);
    seed('minConfidence', 'global', 70);
    seed('minConfidence', 'workspace', 70);

    const { removed, trace } = await sweep();

    expect(removed).toEqual([{ key: 'minConfidence', scope: 'workspace' }]);
    expect(trace.some((line) => line.includes('could not remove codeVerdict.minConfidence from user settings'))).toBe(true);
  });

  it('does not reject when every single write throws', async () => {
    world.failingTargets.add(TARGET.Global);
    for (const key of REMOVED_SETTING_KEYS) seed(key, 'global');

    await expect(sweep()).resolves.toMatchObject({ removed: [] });
  });
});

describe('what the user is told', () => {
  // `notifier.runsInterrupted`'s rule — silent when the activation sweep did
  // nothing, one summary when it did. One toast per key would be seven toasts
  // on the one activation that cleans a fully-configured profile.
  it('says nothing at all when there was nothing to remove', async () => {
    const { notify } = await sweep();
    expect(notify).toEqual([]);
  });

  it('summarizes in a single message naming the fully-qualified keys, never one message per key or per scope', async () => {
    seed('severityFloor', 'global');
    seed('severityFloor', 'workspace');
    seed('shareAcceptRejectRates', 'global');

    const { notify } = await sweep();

    expect(notify).toHaveLength(1);
    expect(notify[0]).toContain('Removed 3 settings');
    expect(notify[0]).toContain('codeVerdict.severityFloor');
    expect(notify[0]).toContain('codeVerdict.shareAcceptRejectRates');
    // The key is named once however many scopes held it — the count already
    // carries the scope multiplicity.
    expect(notify[0]!.match(/codeVerdict\.severityFloor/g)).toHaveLength(1);
  });

  it('leaves a durable line per removal in the trace channel, which the summary toast cannot', async () => {
    seed('extraInstructions', 'global');
    const { trace } = await sweep();
    expect(trace).toEqual(['removed codeVerdict.extraInstructions from user settings']);
  });
});
