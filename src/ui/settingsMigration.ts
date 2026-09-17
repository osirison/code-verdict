/**
 * The per-activation cleanup of settings this extension used to declare and no
 * longer does. ("Per-activation", not "one-time" — see the last section below
 * for why there is no stored flag.)
 *
 * Seven keys were declared in `package.json` and read by nothing: the four
 * review criteria and the agent id, whose real controls are the Run review
 * screen and the agent picker (both stored per pod); `codeVerdict.pods`, which
 * named a key that only ever existed in `context.globalState`, so editing it in
 * settings.json did nothing at all; and `codeVerdict.shareAcceptRejectRates`,
 * which the settings panel rendered and wrote while no consumer read it.
 * Removing them from the manifest is what makes them dead — it is also what
 * makes every copy left in a user's settings.json an unknown-setting warning,
 * on a key they were told was a setting. So they are removed from the user's
 * settings too.
 *
 * Nothing is lost by this. None of the seven had a reader, and pod data was
 * never in settings.json in the first place: `PodStore` (`app/pods.ts`) is
 * constructed over `context.globalState` and its own header says so, so the
 * pods the user actually has are untouched by anything here.
 *
 * ## Why a sweep and not a stored "already migrated" flag
 *
 * A flag records that *this profile* has been cleaned, which is not the
 * question. A stale key can arrive later — in a workspace `.vscode/settings.json`
 * opened for the first time next month, or synced in from another machine — and
 * a once-only migration would never look again. Inspecting per activation and
 * writing only where a value is actually present is idempotent for free: a
 * cleaned configuration produces zero writes and says nothing.
 */
import * as vscode from 'vscode';

/**
 * Exactly the seven keys this extension declared and then removed, unqualified
 * (the `codeVerdict` section supplies the prefix, as every reader in this layer
 * does).
 *
 * A literal list, never a prefix or a pattern. A pattern over `codeVerdict.*`
 * would delete a key this extension never declared — a setting contributed by
 * something else, or one a future version adds and an older one has not heard
 * of — and deleting a stranger's setting is not a cleanup, it is data loss.
 * `categories` here is `codeVerdict.categories`; the marketplace `categories`
 * field at the top of `package.json` is not in this section and is not touched.
 */
export const REMOVED_SETTING_KEYS: readonly string[] = [
  'severityFloor',
  'categories',
  'minConfidence',
  'extraInstructions',
  'agent',
  'pods',
  'shareAcceptRejectRates',
];

/** One removed value: which key, and which scope it was written in. */
export interface RemovedSetting {
  key: string;
  scope: 'user' | 'workspace' | 'workspace folder';
}

export interface SettingsMigrationReport {
  removed: RemovedSetting[];
}

/**
 * Where the migration says what it did. Injected so the tests drive a fake, and
 * so the call site keeps the toast/channel choice rather than this module
 * reaching for `vscode.window` itself.
 */
export interface SettingsMigrationSinks {
  /** A one-line summary the user sees; called only when something was removed. */
  notify(message: string): void;
  /** The durable record — the same Agent Trace channel activation's build-identity banner writes to. */
  trace(line: string): void;
}

/**
 * A scope's value has to be *inspected* before it is written.
 *
 * `update(key, undefined, target)` against a scope that holds nothing is a
 * write nobody asked for — and against `Workspace` with no workspace open it
 * throws. Reading `inspect()` first means an already-clean configuration makes
 * no write at all, which is what makes running this on every activation free.
 */
function inspectValue(
  config: vscode.WorkspaceConfiguration,
  key: string,
): { global: boolean; workspace: boolean; folder: boolean } {
  const inspected = config.inspect(key);
  return {
    global: inspected?.globalValue !== undefined,
    workspace: inspected?.workspaceValue !== undefined,
    folder: inspected?.workspaceFolderValue !== undefined,
  };
}

/**
 * Remove one key from one scope, reporting whether it was there.
 *
 * Every write is its own try/catch. A read-only scope, a settings file the
 * editor cannot write, and — inferred, not confirmed here, because this suite
 * mocks `vscode` — a VS Code build that refuses `update()` on a key no longer
 * declared in the manifest all land in the same place: skip this one, carry on
 * with the rest. Nothing about a leftover key is worth failing an activation
 * over.
 */
async function removeFrom(
  config: vscode.WorkspaceConfiguration,
  key: string,
  target: vscode.ConfigurationTarget,
  scope: RemovedSetting['scope'],
  sinks: SettingsMigrationSinks,
): Promise<RemovedSetting | undefined> {
  try {
    await config.update(key, undefined, target);
    return { key, scope };
  } catch (error) {
    sinks.trace(
      `could not remove codeVerdict.${key} from ${scope} settings: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/**
 * Sweep every scope for the seven keys and remove the ones that are there.
 *
 * Resolves to what it removed. Never rejects: the per-write catch above covers
 * the writes, and the whole call is wrapped at its `activate()` call site as
 * well, so a failure anywhere here cannot be what stops the extension starting.
 */
export async function removeDeadSettings(sinks: SettingsMigrationSinks): Promise<SettingsMigrationReport> {
  const removed: RemovedSetting[] = [];
  const config = vscode.workspace.getConfiguration('codeVerdict');
  // Folder scope is only visible on a resource-scoped configuration, so each
  // folder gets its own `getConfiguration(section, folder.uri)` — the
  // section-only handle above reports `workspaceFolderValue` for none of them.
  const folders = vscode.workspace.workspaceFolders ?? [];

  for (const key of REMOVED_SETTING_KEYS) {
    const present = inspectValue(config, key);
    if (present.global) {
      const entry = await removeFrom(config, key, vscode.ConfigurationTarget.Global, 'user', sinks);
      if (entry) removed.push(entry);
    }
    if (present.workspace) {
      const entry = await removeFrom(config, key, vscode.ConfigurationTarget.Workspace, 'workspace', sinks);
      if (entry) removed.push(entry);
    }
    for (const folder of folders) {
      const folderConfig = vscode.workspace.getConfiguration('codeVerdict', folder.uri);
      if (!inspectValue(folderConfig, key).folder) continue;
      const entry = await removeFrom(
        folderConfig,
        key,
        vscode.ConfigurationTarget.WorkspaceFolder,
        'workspace folder',
        sinks,
      );
      if (entry) removed.push(entry);
    }
  }

  if (removed.length > 0) {
    // `notifier.runsInterrupted`'s rule, applied to the other thing activation
    // does behind the user's back: silent when it did nothing, one summary line
    // when it did — never one message per key, and never a toast on every
    // activation once the configuration is already clean.
    const names = [...new Set(removed.map((entry) => `codeVerdict.${entry.key}`))].join(', ');
    sinks.notify(
      `Removed ${removed.length} setting${removed.length === 1 ? '' : 's'} this version no longer has: ${names}`,
    );
    for (const entry of removed) sinks.trace(`removed codeVerdict.${entry.key} from ${entry.scope} settings`);
  }
  return { removed };
}
