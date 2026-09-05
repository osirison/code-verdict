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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendActivityEvent, createActivityLog } from './app/harnessActivityLog';
import { buildCheckpoint, type CheckpointBuildInput } from './app/harnessCheckpoint';
import { createHarnessRunStore } from './app/harnessRunStore';
import { DEFAULT_CRITERIA } from './domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from './domain/harnessPolicy';
import { HARNESS_TOOL_CONTRACT_VERSION } from './domain/harnessTools';
import type { KeyValueStore } from './app/storage';
import type { ReviewRunSnapshot } from './domain/reviewRunSnapshot';

// ---- vscode mock: the headless probe's own stub, moved into vi.mock ------------------------

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  channels: [] as Array<{ name: string; lines: string[]; shown: boolean }>,
  messages: [] as Array<[string, string]>,
  quickPickImpl: (async () => undefined) as (...args: unknown[]) => Promise<unknown>,
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
      fs: { readFile: async () => new Uint8Array(), stat: async () => ({ type: 1, size: 0 }), readDirectory: async () => [], writeFile: async () => undefined },
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

async function activateWith(store: KeyValueStore): Promise<void> {
  const mod = await import('./extension.js');
  currentSubscriptions = [];
  const context = {
    subscriptions: currentSubscriptions,
    globalState: store,
    workspaceState: memoryStore(),
    secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, onDidChange: () => disposable() },
    extensionUri: { toString: () => '/ext', fsPath: '/ext', path: '/ext', scheme: 'file' },
    extensionPath: '/ext',
    extensionMode: 2,
  };
  await mod.activate(context as unknown as Parameters<typeof mod.activate>[0]);
}

function runDiagnosticsChannel(): { name: string; lines: string[]; shown: boolean } {
  const chan = state.channels.find((c) => c.name === 'Verdict: Run diagnostics');
  if (!chan) throw new Error('Verdict: Run diagnostics channel was never created');
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
});

afterEach(() => {
  for (const d of currentSubscriptions) {
    try { d.dispose(); } catch { /* best effort */ }
  }
  currentSubscriptions = [];
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
