/**
 * `codeVerdict.showRunDiagnostics` must always write to its output channel and always show it —
 * the bug this file guards against ("Verdict: Show run diagnostics" opens an empty panel) survived
 * two earlier fixes because nothing in this suite pinned the *handler's* channel behavior; only
 * `harnessDiagnostics.test.ts`/`harnessDiagnosticsSource.test.ts` pinned the pure report-building
 * underneath it. Driven through the real `activate()` against a mocked `vscode`, in the same style
 * `ui/changesetReview.test.ts` already drives that panel — the mock here is the headless activation
 * probe's own stub (`docs/agent-notes/f5-extension-development-host.md`), moved into `vi.mock`.
 *
 * Lineages are seeded through the real `createHarnessRunStore`/`buildCheckpoint` pipeline, never
 * hand-typed JSON — a hand-typed `runId` mismatch between a snapshot and its activity events is
 * exactly how an earlier fixture in this same change silently failed to parse.
 */
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendActivityEvent, createActivityLog } from './app/harnessActivityLog';
import { buildCheckpoint, type CheckpointBuildInput } from './app/harnessCheckpoint';
import { createHarnessRunStore } from './app/harnessRunStore';
import { DEFAULT_CRITERIA } from './domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from './domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from './domain/harnessTools';
import type { KeyValueStore } from './app/storage';
import type { ReviewRunSnapshot } from './domain/reviewRunSnapshot';
// Named up here rather than as an inline `import()` in the mock factories below:
// `consistent-type-imports` forbids the inline form, and both eviction mocks
// need the real module's type to spread its real exports.
import type * as ObjectAcquisitionModule from './localgit/objectAcquisition';

// ---- vscode mock: the headless probe's own stub, moved into vi.mock ------------------------

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  channels: [] as Array<{ name: string; lines: string[]; shown: boolean }>,
  messages: [] as Array<[string, string]>,
  quickPickImpl: (async () => undefined) as (...args: unknown[]) => Promise<unknown>,
  // A real in-memory filesystem, keyed by `fsPath` — `codeVerdict.showRunDiagnostics`'s
  // always-write-to-disk behavior is verified against this, not against a stub that would let
  // `writeFile` vacuously "succeed" without anything to read back.
  fsFiles: new Map<string, string>(),
}));

function disposable(): { dispose(): void } {
  return { dispose() {} };
}

vi.mock('vscode', () => {
  function permissiveNamespace<T extends object>(obj: T): T {
    return new Proxy(obj, {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        return () => disposable();
      },
    }) as T;
  }

  const vscodeStub: Record<string, unknown> = {
    commands: {
      registerCommand: (id: string, fn: (...args: unknown[]) => unknown) => {
        state.handlers.set(id, fn);
        return disposable();
      },
      executeCommand: async () => undefined,
      getCommands: async () => [],
    },
    window: {
      createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
      registerWebviewViewProvider: () => disposable(),
      createOutputChannel: (name: string) => {
        const chan = {
          name,
          lines: [] as string[],
          shown: false,
          appendLine(l: string) { chan.lines.push(String(l)); },
          append(l: string) { chan.lines.push(String(l)); },
          clear() { chan.lines.length = 0; },
          show() { chan.shown = true; },
          dispose() {},
        };
        state.channels.push(chan);
        return chan;
      },
      showInformationMessage: async (msg: string) => { state.messages.push(['info', String(msg)]); return undefined; },
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showQuickPick: (...args: unknown[]) => state.quickPickImpl(...args),
      showSaveDialog: async () => undefined,
      onDidChangeActiveTextEditor: () => disposable(),
      activeTextEditor: undefined,
      visibleTextEditors: [],
      createTextEditorDecorationType: () => ({ dispose() {} }),
      tabGroups: { all: [], onDidChangeTabs: () => disposable() },
    },
    workspace: {
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d, update: async () => {}, has: () => false, inspect: () => undefined }),
      onDidChangeConfiguration: () => disposable(),
      workspaceFolders: undefined,
      onDidChangeWorkspaceFolders: () => disposable(),
      fs: {
        readFile: async () => new Uint8Array(),
        stat: async () => ({ type: 1, size: 0 }),
        createDirectory: async () => undefined,
        writeFile: async (uri: { fsPath: string }, content: Uint8Array) => {
          state.fsFiles.set(uri.fsPath, Buffer.from(content).toString('utf8'));
        },
        readDirectory: async (dir: { fsPath: string }): Promise<Array<[string, number]>> => {
          const prefix = `${dir.fsPath}/`;
          const names = new Set<string>();
          for (const path of state.fsFiles.keys()) {
            if (!path.startsWith(prefix)) continue;
            const rest = path.slice(prefix.length);
            if (!rest.includes('/')) names.add(rest);
          }
          return [...names].map((name) => [name, 1]); // FileType.File
        },
        delete: async (uri: { fsPath: string }) => {
          state.fsFiles.delete(uri.fsPath);
        },
      },
      createFileSystemWatcher: () => ({ onDidCreate: () => disposable(), onDidChange: () => disposable(), onDidDelete: () => disposable(), dispose() {} }),
      openTextDocument: async () => ({ getText: () => '' }),
      asRelativePath: (p: string) => String(p),
    },
    lm: { selectChatModels: async () => [], onDidChangeChatModels: () => disposable() },
    authentication: { getSession: async () => undefined, onDidChangeSessions: () => disposable() },
    env: { openExternal: async () => true, clipboard: { writeText: async () => {} }, appName: 'test' },
    Uri: {
      parse: (s: string) => ({ toString: () => s, fsPath: s, path: s, scheme: 'file' }),
      file: (s: string) => ({ toString: () => s, fsPath: s, path: s, scheme: 'file' }),
      joinPath: (b: unknown, ...p: string[]) => ({ toString: () => [b, ...p].join('/'), fsPath: [b, ...p].join('/'), path: [b, ...p].join('/') }),
    },
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    Disposable: class {
      dispose: () => void;
      constructor(fn?: () => void) { this.dispose = fn ?? (() => undefined); }
      static from() { return disposable(); }
    },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ThemeColor: class {},
    ThemeIcon: class {},
    MarkdownString: class { value: string; constructor(v?: string) { this.value = v ?? ''; } appendMarkdown() { return this; } },
    Range: class {}, Position: class {}, Selection: class {},
    CancellationTokenSource: class { token = { isCancellationRequested: false, onCancellationRequested: () => disposable() }; cancel() {} dispose() {} },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { One: 1, Active: -1, Beside: -2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    languages: { registerCodeLensProvider: () => disposable(), createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
    extensions: { getExtension: () => undefined, all: [] },
  };
  for (const name of ['window', 'workspace', 'commands', 'languages', 'env', 'lm', 'authentication', 'extensions']) {
    vscodeStub[name] = permissiveNamespace(vscodeStub[name] as object);
  }
  // Deliberately a plain object, never a Proxy, at this outermost level: Vitest's mock loader
  // thenable-checks a factory's return value (a `vi.mock` factory may itself be async), and a
  // catch-all Proxy that answers every property access — including `then` — with a callable value
  // gets treated as an unsettled promise and hangs `import('./extension.js')` forever. The headless
  // probe's own top-level `permissive` Proxy never hits this: `require()` is synchronous and never
  // thenable-checks its return value, which is the one respect this mock cannot just copy that
  // probe verbatim. Missing top-level members surface as an explicit error instead — add them here
  // if one shows up, never re-introduce the blanket catch-all.
  return vscodeStub;
});

// ---- fixtures: real lineages through the real store, never hand-typed JSON -----------------

function memoryStore(seed: Record<string, unknown> = {}): KeyValueStore {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
    get: <T>(key: string) => (map.has(key) ? (map.get(key) as T) : undefined),
    update: async (key, value) => { map.set(key, value); },
    keys: () => [...map.keys()],
  };
}

const POD = {
  id: 'pod-1',
  name: 'Acme pod',
  providerId: 'fixture',
  instanceUrl: 'https://example.test',
  sources: [{ kind: 'repository' as const, repoId: 'repo-1' }],
  criteria: DEFAULT_CRITERIA,
};

async function seedPod(store: KeyValueStore, overrides: Partial<typeof POD> = {}): Promise<void> {
  const pod = { ...POD, ...overrides };
  await store.update('codeVerdict.pods', [pod]);
  await store.update('codeVerdict.activePodId', pod.id);
}

function snapshotFor(lineageId: string, repoId: string, number: string): ReviewRunSnapshot {
  return {
    schemaVersion: '1',
    runId: `run-${lineageId}`,
    lineageId,
    attempt: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    targetKind: 'cr',
    members: [
      {
        memberId: 'm1',
        providerId: 'fixture',
        instanceUrl: 'https://example.test',
        ref: { repoId, number },
        baseSha: 'base1',
        headSha: 'head1',
        providerCapabilitySignature: 'sig-1',
        rootAgentsPolicy: { present: false },
        context: { autoContextEnabled: false, titleIncluded: false, descriptionIncluded: false, linkedItemIdsIncluded: [], attachments: [] },
      },
    ],
    agentId: 'built-in',
    agentInstructions: 'Review the change carefully.',
    agentInstructionsDigest: 'digest-instructions',
    personaLabel: 'Built-in reviewer',
    modelId: 'test-model',
    effort: 'none',
    effortInstructionDigest: 'digest-effort',
    criteria: DEFAULT_CRITERIA,
    extraInstructionsDigest: 'digest-extra',
    toolContractVersion: HARNESS_TOOL_CONTRACT_VERSION,
    harnessPolicyVersion: HARNESS_POLICY_VERSION,
  };
}

function checkpointInputFor(lineageId: string, occurredAt: string): CheckpointBuildInput {
  const runId = `run-${lineageId}`;
  let log = createActivityLog(runId, lineageId, 1);
  log = appendActivityEvent(log, { kind: 'actionStarted', action: 'Investigating changed files.' }, { occurredAt: '2026-01-01T00:00:30.000Z', phase: 'investigating', elapsedMs: 30_000 });
  log = appendActivityEvent(
    log,
    { kind: 'terminalResult', lifecycle: 'failed', completeness: 'none', limitations: [{ code: 'insufficientRiskCoverage', message: 'A high-risk file was classified but never inspected.' }] },
    { occurredAt: '2026-01-01T00:01:00.000Z', phase: 'persisting', elapsedMs: 60_000 },
  );
  return {
    checkpointId: `ckpt-${lineageId}`,
    runId,
    lineageId,
    attempt: 1,
    phase: 'persisting',
    reason: 'phaseBoundary',
    occurredAt,
    elapsedMs: 60_000,
    snapshotDigest: `digest-${lineageId}`,
    activityEvents: log.events,
    evidenceSources: [],
    candidates: [],
    contradicted: [],
    budget: { modelTurnsUsed: 2, toolCallsUsed: 4, evidenceBytesUsed: 64, elapsedMs: 500, highRiskReserveUsed: 1, verificationReserveUsed: 0 },
    coverage: [],
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 1 },
  };
}

const GENEROUS_RETENTION = { retainedCheckpointsPerLineage: 100, maxCheckpointBytesPerLineage: 10 * 1024 * 1024, terminalAttemptHistoryCount: 100, terminalAttemptHistoryMaxAgeDays: 3650 };

async function seedLineage(store: KeyValueStore, lineageId: string, repoId: string, number: string, occurredAt: string): Promise<void> {
  const runStore = createHarnessRunStore(store, { now: () => Date.parse(occurredAt) });
  await runStore.writeSnapshot(snapshotFor(lineageId, repoId, number));
  const built = buildCheckpoint(checkpointInputFor(lineageId, occurredAt), DEFAULT_HARNESS_POLICY);
  await runStore.writeCheckpoint(built, GENEROUS_RETENTION);
}

// ---- activation harness ----------------------------------------------------------------------

let currentSubscriptions: Array<{ dispose(): void }> = [];

/**
 * Where the object cache's root is rooted for every activation in this file.
 *
 * A path under the OS temp directory that deliberately does not exist. The real
 * `ExtensionContext` always carries a `globalStorageUri` and this stub used not
 * to, which is how an eviction pass firing after a test finished produced
 * `TypeError: Cannot read properties of undefined (reading 'fsPath')` — a real
 * defect in `extension.ts` (fixed there), but also a stub that did not look
 * like the thing it stands in for. Nothing is created here: eviction's
 * directory listing catches its own failure and reports an empty scan, so a
 * root that was never written to is read as empty and left alone.
 */
const STORAGE_ROOT = join(tmpdir(), 'code-verdict-extension-test-storage');

function uriStub(path: string): { toString(): string; fsPath: string; path: string; scheme: string } {
  return { toString: () => path, fsPath: path, path, scheme: 'file' };
}

/**
 * Copied onto the context with `defineProperties`, never spread.
 *
 * Object spread *invokes* an accessor and copies the value it returned, which
 * would turn the counting and throwing `globalStorageUri` getters the eviction
 * tests rely on into plain data properties and make those tests pass
 * vacuously — they exist precisely to record when the property is read.
 */
type ContextOverrides = Record<string, unknown>;

async function activateWith(store: KeyValueStore, overrides: ContextOverrides = {}): Promise<void> {
  const mod = await import('./extension.js');
  currentSubscriptions = [];
  const context: Record<string, unknown> = {
    subscriptions: currentSubscriptions,
    globalState: store,
    workspaceState: memoryStore(),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => disposable() },
    extensionUri: uriStub('/ext'),
    extensionPath: '/ext',
    extensionMode: 2,
    logUri: uriStub('/ext/log'),
    globalStorageUri: uriStub(STORAGE_ROOT),
  };
  Object.defineProperties(context, Object.getOwnPropertyDescriptors(overrides));
  await mod.activate(context as unknown as Parameters<typeof mod.activate>[0]);
}

function runDiagnosticsChannel(): { name: string; lines: string[]; shown: boolean } {
  const chan = state.channels.find((c) => c.name === 'Verdict: Run diagnostics');
  if (!chan) throw new Error('Verdict: Run diagnostics channel was never created');
  return chan;
}

/** Part 4's third destination: the same live channel `AgentTrace` writes request/response lines to. */
function agentTraceChannel(): { name: string; lines: string[]; shown: boolean } {
  const chan = state.channels.find((c) => c.name === 'Code Verdict: Agent Trace');
  if (!chan) throw new Error('Code Verdict: Agent Trace channel was never created');
  return chan;
}

async function invokeShowRunDiagnostics(): Promise<void> {
  const fn = state.handlers.get('codeVerdict.showRunDiagnostics');
  if (!fn) throw new Error('codeVerdict.showRunDiagnostics was never registered');
  await fn();
}

beforeEach(() => {
  vi.resetModules();
  state.handlers.clear();
  state.channels.length = 0;
  state.messages.length = 0;
  state.quickPickImpl = async () => undefined;
  state.fsFiles.clear();
});

/** The one file `writeDiagnosticsReportToDisk` wrote for the invocation under test — throws if none did, since every invocation must write exactly one. */
function writtenDiagnosticsFile(): { path: string; content: string } {
  const entries = [...state.fsFiles.entries()].filter(([path]) => path.includes('run-diagnostics'));
  if (entries.length !== 1) throw new Error(`expected exactly one diagnostics file written, found ${entries.length}: ${entries.map(([p]) => p).join(', ')}`);
  const [path, content] = entries[0] as [string, string];
  return { path, content };
}

afterEach(() => {
  for (const d of currentSubscriptions) {
    try { d.dispose(); } catch { /* best effort */ }
  }
  currentSubscriptions = [];
});

describe('activation writes a build-identity line into the Agent Trace channel', () => {
  it('names the running version at activation, before any run has happened', async () => {
    await activateWith(memoryStore());

    const chan = agentTraceChannel();
    const identityLine = chan.lines.find((l) => l.includes('activated'));
    expect(identityLine).toBeDefined();
    expect(identityLine).toContain('Code Verdict v');
    // Local time-of-day, milliseconds included, at the start of the line — Part 1's own rule,
    // applied to every line this extension writes into a trace channel, not only `AgentTrace`'s own.
    expect(identityLine).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} /);
  });
});

describe('codeVerdict.showRunDiagnostics always writes to its channel and always shows it', () => {
  it('writes a diagnostic, shown report when no pod is connected — the exact regression this suite must catch', async () => {
    await activateWith(memoryStore());
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    expect(chan.lines.length).toBeGreaterThan(0);
    expect(chan.lines.join('\n')).toContain('No pod is connected');
    expect(chan.lines.join('\n')).toContain('no pod connected');
  });

  it('writes the same not-found report into the Agent Trace channel too, clearly delimited — the "make the channel irrelevant" fix', async () => {
    await activateWith(memoryStore());
    await invokeShowRunDiagnostics();

    const diagText = runDiagnosticsChannel().lines.join('\n');
    const traceLines = agentTraceChannel().lines;
    const beginIndex = traceLines.findIndex((l) => l.includes('BEGIN Verdict: Run diagnostics report'));
    const endIndex = traceLines.findIndex((l) => l.includes('END Verdict: Run diagnostics report'));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(endIndex).toBeGreaterThan(beginIndex);
    expect(traceLines[beginIndex]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} ===== BEGIN/);
    expect(traceLines[endIndex]).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} ===== END/);
    // Same content as the dedicated channel — a third destination, never a divergent one.
    expect(traceLines.slice(beginIndex, endIndex + 1).join('\n')).toContain(diagText);
    // The notification names every place the report landed, so the user is never left guessing
    // which of several channels to check.
    expect(state.messages.some(([, msg]) => msg.includes('Code Verdict: Agent Trace') && msg.includes('Verdict: Run diagnostics'))).toBe(true);
  });

  it('always writes the same report to disk, on the not-found path — a surface the reviewer sees even when the channel does not', async () => {
    await activateWith(memoryStore());
    await invokeShowRunDiagnostics();

    const file = writtenDiagnosticsFile();
    expect(file.path).toContain('/ext/log/run-diagnostics/');
    expect(file.path).toMatch(/-not-found\.txt$/);
    // The exact same text the channel got, plus the JSON a "Save as JSON…" would otherwise be the
    // only way to get — one path, everything in it.
    expect(file.content).toContain('No pod is connected');
    expect(file.content).toContain('---- JSON ----');
    expect(file.content).toContain('"reason"');
    expect(file.content).toContain('noPodConnected');
    // The notification names the path plainly enough to copy — the one surface the user quoted
    // back to us as something they could actually see.
    expect(state.messages.some(([, msg]) => msg.includes(file.path))).toBe(true);
  });

  it('writes a diagnostic, shown report when the pod has no lineages on disk at all', async () => {
    const store = memoryStore();
    await seedPod(store);
    await activateWith(store);
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    const text = chan.lines.join('\n');
    expect(text).toContain('No run was found for the active pod.');
    expect(text).toContain('total on disk: 0');
    expect(text).toContain('matched this pod: 0');
  });

  it('writes a diagnostic, shown report naming "belongs to a different pod" when a lineage exists but for another repo', async () => {
    const store = memoryStore();
    await seedPod(store);
    await seedLineage(store, 'lineage-other', 'repo-other', '99', '2026-01-01T00:00:00.000Z');
    await activateWith(store);
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    const text = chan.lines.join('\n');
    expect(text).toContain('total on disk: 1');
    expect(text).toContain('matched this pod: 0');
    expect(text).toContain('lineage-other — belongs to a different pod\'s target');
  });

  it('writes a diagnostic, shown report naming the offered runs when the picker is dismissed', async () => {
    const store = memoryStore();
    await seedPod(store);
    await seedLineage(store, 'lineage-a', 'repo-1', '10', '2026-01-01T00:00:00.000Z');
    await seedLineage(store, 'lineage-b', 'repo-1', '11', '2026-01-02T00:00:00.000Z');
    state.quickPickImpl = async () => undefined;
    await activateWith(store);
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    const text = chan.lines.join('\n');
    expect(text).toContain('The run picker was dismissed without a choice.');
    expect(text).toContain('!10');
    expect(text).toContain('!11');
  });

  it('still resolves and shows the found report normally when exactly one candidate matches (no regression on the success path)', async () => {
    const store = memoryStore();
    await seedPod(store);
    await seedLineage(store, 'lineage-single', 'repo-1', '42', '2026-01-01T00:00:00.000Z');
    await activateWith(store);
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    const text = chan.lines.join('\n');
    expect(text).toContain('run=run-lineage-single lineage=lineage-single attempt=1');
    expect(text).toContain('lifecycle=failed completeness=none');
    expect(state.messages.some(([, msg]) => msg.includes('run diagnostics ready'))).toBe(true);
    expect(state.messages.some(([, msg]) => msg.includes('Code Verdict: Agent Trace') && msg.includes('Verdict: Run diagnostics'))).toBe(true);

    // The found path writes to disk exactly like the not-found path does — same file shape, same
    // notification convention.
    const file = writtenDiagnosticsFile();
    expect(file.path).toMatch(/-found\.txt$/);
    expect(file.content).toContain('run=run-lineage-single lineage=lineage-single attempt=1');
    expect(file.content).toContain('---- JSON ----');
    expect(file.content).toContain('"runId": "run-lineage-single"');
    expect(state.messages.some(([, msg]) => msg.includes(file.path))).toBe(true);

    // And the found report, exactly like the not-found one, is also copied into the Agent Trace
    // channel — the found and not-found branches must not diverge on this.
    const traceLines = agentTraceChannel().lines;
    const beginIndex = traceLines.findIndex((l) => l.includes('BEGIN Verdict: Run diagnostics report'));
    const endIndex = traceLines.findIndex((l) => l.includes('END Verdict: Run diagnostics report'));
    expect(beginIndex).toBeGreaterThanOrEqual(0);
    expect(traceLines.slice(beginIndex, endIndex + 1).join('\n')).toContain('run=run-lineage-single lineage=lineage-single attempt=1');
  });

  it('keeps the on-disk archive bounded rather than growing without limit', async () => {
    const store = memoryStore();
    await activateWith(store);
    for (let i = 0; i < 25; i += 1) {
      await invokeShowRunDiagnostics();
    }
    const written = [...state.fsFiles.keys()].filter((path) => path.includes('run-diagnostics'));
    expect(written.length).toBeLessThanOrEqual(20);
  });

  it('writes a diagnostic, shown report naming the failure — and the pod correctly — when resolution throws', async () => {
    const store = memoryStore();
    await seedPod(store, { providerId: 'no-such-provider' });
    await activateWith(store);
    await invokeShowRunDiagnostics();

    const chan = runDiagnosticsChannel();
    expect(chan.shown).toBe(true);
    const text = chan.lines.join('\n');
    expect(text).toContain('Unknown provider: no-such-provider');
    // The catch path must not fabricate "no pod connected" when a pod plainly is connected.
    expect(text).toContain('connected as "Acme pod" (no-such-provider @ https://example.test)');
  });
});

/**
 * The object-cache eviction timer, and the two ways it could reach the host.
 *
 * A full run of this file failed once with
 *
 *     src/extension.test.ts — TypeError: Cannot read properties of undefined (reading 'fsPath')
 *
 * and passed on retry and on every standalone run after it, so it presented as
 * a flake. It was not only a flake. `activate()` schedules a zero-delay timer
 * that runs the cache's eviction pass, and the cache was built inside that
 * callback — so `context.globalStorageUri.fsPath` was read at timer time rather
 * than at activation, and the `.catch()` on the pass covered only a rejected
 * promise, not a `createObjectCache` that throws before there is one. Between
 * them that is a synchronous exception thrown out of a timer callback with
 * nothing above it: a reported unhandled error here, and an unhandled exception
 * in the extension host during shutdown in a real window.
 *
 * Fake timers throughout, with only `setTimeout`/`clearTimeout` faked and only
 * `advanceTimersByTime(0)` used: that fires the eviction timer and nothing else,
 * inside the test, so a synchronous throw from the callback comes back out of
 * `advanceTimersByTime` where an assertion can see it. `runAllTimers` is
 * deliberately not used — it drains re-arming timers to exhaustion, and this
 * process has polling timers that would never finish.
 */
describe('the object-cache eviction timer cannot take the extension context down with it', () => {
  it('reads the storage path during activation, not when the timer fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      await activateWith(memoryStore(), {
        get globalStorageUri() {
          reads += 1;
          return uriStub(STORAGE_ROOT);
        },
      });

      // Asserted directly, as an ordering fact about the property itself, rather
      // than inferred from the eviction pass having succeeded: the read happened
      // while `activate()` was still running.
      const readsAtActivation = reads;
      expect(readsAtActivation).toBeGreaterThan(0);

      // And the delta is what the fix is: firing the timer must add no further
      // read. Against the old code this is the only read there ever was.
      vi.advanceTimersByTime(0);
      expect(reads).toBe(readsAtActivation);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not dereference a context that is gone by the time the timer fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let tornDown = false;
      await activateWith(memoryStore(), {
        get globalStorageUri() {
          // Exactly the failure that was observed, raised by the one thing that
          // can raise it: a context being torn down under a callback that is
          // still holding it.
          if (tornDown) throw new TypeError("Cannot read properties of undefined (reading 'fsPath')");
          return uriStub(STORAGE_ROOT);
        },
      });
      tornDown = true;

      expect(() => vi.advanceTimersByTime(0)).not.toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it('swallows a cache whose construction throws instead of letting the exception escape the callback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // Only `createObjectCache` is replaced; every other export stays real, so
    // the modules that share this one during activation are unaffected.
    vi.doMock('./localgit/objectAcquisition', async (importOriginal) => ({
      ...(await importOriginal<typeof ObjectAcquisitionModule>()),
      createObjectCache: () => {
        throw new Error('object cache construction failed');
      },
    }));
    try {
      await activateWith(memoryStore());

      // The path is captured and good; it is the construction that fails. There
      // is no promise to attach a `.catch()` to at that point, which is why the
      // guard has to be around the whole callback body.
      expect(() => vi.advanceTimersByTime(0)).not.toThrow();
    } finally {
      vi.doUnmock('./localgit/objectAcquisition');
      vi.useRealTimers();
    }
  });

  it('swallows an eviction pass that rejects, so nothing reaches the process as an unhandled rejection', async () => {
    // Real timers: an unhandled rejection is only ever reported a turn of the
    // event loop after the promise settles, so this one has to be let run.
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    vi.doMock('./localgit/objectAcquisition', async (importOriginal) => ({
      ...(await importOriginal<typeof ObjectAcquisitionModule>()),
      createObjectCache: () => ({
        root: STORAGE_ROOT,
        policy: {},
        evict: () => Promise.reject(new Error('eviction failed')),
        acquire: () => Promise.reject(new Error('not used')),
      }),
    }));
    try {
      await activateWith(memoryStore());
      // Two turns: one for the zero-delay timer, one for the rejection report
      // that would follow it.
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
      vi.doUnmock('./localgit/objectAcquisition');
    }
  });

  it('is still cancelled by disposal, which is what stops it running against a disposed window at all', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let reads = 0;
      await activateWith(memoryStore(), {
        get globalStorageUri() {
          reads += 1;
          return uriStub(STORAGE_ROOT);
        },
      });
      const readsAtActivation = reads;

      for (const d of currentSubscriptions) {
        try {
          d.dispose();
        } catch {
          /* best effort, as in `afterEach` */
        }
      }
      currentSubscriptions = [];

      // Nothing left to fire: the `clearTimeout` disposable is the first line of
      // defence and the two fixes above are the second, for the window in which
      // it has not run yet.
      expect(() => vi.advanceTimersByTime(0)).not.toThrow();
      expect(reads).toBe(readsAtActivation);
    } finally {
      vi.useRealTimers();
    }
  });
});
