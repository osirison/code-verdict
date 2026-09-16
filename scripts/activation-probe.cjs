// Proves `dist/extension.js` activates, without a display, a window, or a debugger.
//
// When the Extension Development Host dies on F5 the first question is always the same: is the
// extension broken, or is the window dying under it? This answers that in about a second. It loads
// the built bundle with `require('vscode')` stubbed and calls `activate()`, taking the same
// development-mode branch F5 takes.
//
//     node scripts/activation-probe.cjs            # or: npm run probe
//
// A healthy run resolves in tens of milliseconds and prints the registered counts. Treat those as
// a floor that grows, not a fixture: what matters is that `activate()` resolves rather than
// throwing or hanging, and that a command you just added shows up in the count.
//
// The trap this file exists to have solved once: a single permissive Proxy over the whole `vscode`
// object does NOT cover members of namespaces that are real objects. `window` is a real object, so
// a member it does not define is `undefined` rather than a no-op and `activate()` throws for a
// reason unrelated to what you are checking. Every namespace gets its own proxy below, and the
// whole object is wrapped as well.
//
// See docs/agent-notes/f5-extension-development-host.md for what to do with the answer.
const Module = require('node:module');
const path = require('node:path');

const disposable = () => ({ dispose() {} });
const evt = () => disposable();

// Each namespace needs its own proxy: a top-level proxy does not cover members
// of namespaces that are real objects (the trap recorded in the field note).
function ns(real = {}) {
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'symbol') return undefined;
      return (...args) => {
        if (String(prop).startsWith('onDid') || String(prop).startsWith('onWill')) return disposable();
        return disposable();
      };
    },
  });
}

const memento = {
  get: (k, d) => d,
  update: async () => {},
  keys: () => [],
  setKeysForSync: () => {},
};

const statusBarItems = [];
const commands = [];

const vscode = {
  EventEmitter: class { constructor() { this.event = evt; } fire() {} dispose() {} },
  Disposable: class { constructor(fn) { this._fn = fn; } dispose() { if (this._fn) this._fn(); } static from() { return disposable(); } },
  Uri: { file: (p) => ({ fsPath: p, path: p, scheme: 'file', toString: () => p }), parse: (p) => ({ toString: () => p }), joinPath: (b, ...r) => ({ fsPath: path.join(b.fsPath ?? '', ...r), toString: () => path.join(b.fsPath ?? '', ...r) }) },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor(v) { this.value = v; } appendMarkdown() { return this; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ViewColumn: { One: 1, Two: 2, Active: -1, Beside: -2 },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  TreeItem: class { constructor(l, s) { this.label = l; this.collapsibleState = s; } },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  LanguageModelChatMessage: { User: (v) => ({ value: v }), Assistant: (v) => ({ value: v }) },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: evt }; } cancel() {} dispose() {} },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
};

vscode.window = ns({
  createStatusBarItem: (...a) => { const i = { text: '', tooltip: '', command: undefined, show() {}, hide() {}, dispose() {} }; statusBarItems.push(i); return i; },
  createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
  registerWebviewViewProvider: () => disposable(),
  registerTreeDataProvider: () => disposable(),
  createTreeView: () => ({ dispose() {}, onDidChangeVisibility: evt, visible: false }),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showWarningMessage: async () => undefined,
  activeColorTheme: { kind: 2 },
  state: { focused: true },
  visibleTextEditors: [],
  tabGroups: ns({ all: [] }),
});

vscode.commands = ns({
  registerCommand: (id) => { commands.push(id); return disposable(); },
  registerTextEditorCommand: (id) => { commands.push(id); return disposable(); },
  executeCommand: async () => undefined,
  getCommands: async () => commands.slice(),
});

vscode.workspace = ns({
  getConfiguration: () => ({ get: (k, d) => d, update: async () => {}, has: () => false, inspect: () => undefined }),
  workspaceFolders: [],
  fs: ns({ readFile: async () => new Uint8Array(), stat: async () => ({ type: 1, size: 0 }) }),
  createFileSystemWatcher: () => ns({ dispose() {} }),
});

vscode.env = ns({ appName: 'probe', machineId: 'probe', openExternal: async () => true, clipboard: ns({ writeText: async () => {} }) });
vscode.authentication = ns({ getSession: async () => undefined });
vscode.lm = ns({ selectChatModels: async () => [] });
vscode.extensions = ns({ getExtension: () => undefined, all: [] });
vscode.languages = ns({});
vscode.debug = ns({});
vscode.tasks = ns({});
vscode.scm = ns({});
vscode.l10n = ns({ t: (s) => s });

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return origLoad.apply(this, arguments);
};

const bundlePath = path.resolve(process.argv[2] ?? 'dist/extension.js');
const subscriptions = [];
const context = {
  subscriptions,
  extensionMode: vscode.ExtensionMode.Development,
  extensionUri: vscode.Uri.file(path.dirname(bundlePath)),
  extensionPath: path.dirname(bundlePath),
  globalState: memento,
  workspaceState: memento,
  secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: evt },
  globalStorageUri: vscode.Uri.file('/tmp/probe-storage'),
  storageUri: vscode.Uri.file('/tmp/probe-storage'),
  logUri: vscode.Uri.file('/tmp/probe-logs'),
  asAbsolutePath: (p) => path.join(path.dirname(bundlePath), p),
  environmentVariableCollection: ns({}),
};

(async () => {
  const started = Date.now();
  const ext = require(bundlePath);
  await ext.activate(context);
  console.log(`activate() resolved in ${Date.now() - started}ms`);
  console.log(`commands: ${commands.length}, subscriptions: ${subscriptions.length}, statusBarItems: ${statusBarItems.length}`);
  process.exit(0);
})().catch((err) => {
  console.error('activate() THREW:', err && err.stack ? err.stack : err);
  process.exit(1);
});
