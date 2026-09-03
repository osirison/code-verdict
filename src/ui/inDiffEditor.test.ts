import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewItem } from '../domain/types';

const FILE_TEXT = [
  'export function token(key: string) {',
  '  // audit',
  '  return cache.get(key);',
  '}',
].join('\n');

const state = vi.hoisted(() => ({
  workspaceFolders: [{ name: 'repo', uri: { path: '/repo' } }] as unknown[],
  files: new Map<string, string>(),
  /** Paths whose open is held open until the test releases them. */
  gate: new Map<string, Promise<void>>(),
}));

const editor = vi.hoisted(() => ({
  setDecorations: vi.fn(),
  revealRange: vi.fn(),
}));

const thread = vi.hoisted(() => ({
  label: '',
  canReply: true,
  collapsibleState: 0,
  dispose: vi.fn(),
}));

const createCommentThread = vi.hoisted(() =>
  vi.fn((uri: unknown, range: unknown, comments: unknown[]) => {
    thread.dispose.mockClear();
    return Object.assign(thread, { uri, range, comments });
  }),
);

const createCommentController = vi.hoisted(() =>
  vi.fn(() => ({ createCommentThread, dispose: vi.fn() })),
);

const createTextEditorDecorationType = vi.hoisted(() =>
  vi.fn((options: unknown) => ({ options, dispose: vi.fn() })),
);

const showTextDocument = vi.hoisted(() =>
  vi.fn(async (_document: unknown, _options?: unknown) => editor),
);

vi.mock('vscode', () => ({
  Uri: { joinPath: (base: { path: string }, ...parts: string[]) => ({ path: [base.path, ...parts].join('/') }) },
  Range: class {
    constructor(readonly line: number) {}
  },
  OverviewRulerLane: { Right: 7 },
  ViewColumn: { Beside: -2 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  CommentMode: { Preview: 1 },
  CommentThreadCollapsibleState: { Expanded: 1 },
  MarkdownString: class {
    constructor(readonly value: string) {}
  },
  comments: { createCommentController },
  window: { createTextEditorDecorationType, showTextDocument },
  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders;
    },
    openTextDocument: async (uri: { path: string }) => {
      await state.gate.get(uri.path);
      const text = state.files.get(uri.path);
      if (text === undefined) throw new Error(`no such file: ${uri.path}`);
      const lines = text.split('\n');
      return {
        uri,
        getText: () => text,
        lineCount: lines.length,
        lineAt: (index: number) => ({ range: { line: index + 1, text: lines[index] } }),
      };
    },
  },
}));

const ITEM: ReviewItem = {
  id: 'f1',
  title: 'Token cache is read without a lock',
  body: 'Two requests can refresh at once.',
  severity: 'blocker',
  category: 'concurrency',
  confidence: 96,
  file: 'src/auth/token.ts',
  anchored: true,
  line: 3,
  code: '  return cache.get(key);',
};

describe('InDiffEditor', () => {
  beforeEach(() => {
    state.workspaceFolders = [{ name: 'repo', uri: { path: '/repo' } }];
    state.files = new Map([['/repo/src/auth/token.ts', FILE_TEXT]]);
    state.gate = new Map();
    editor.setDecorations.mockClear();
    editor.revealRange.mockClear();
    showTextDocument.mockClear();
    createCommentThread.mockClear();
    createTextEditorDecorationType.mockClear();
  });

  it('decorates the flagged line and opens a peek thread on it', async () => {
    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    const shown = await inDiff.show({ item: ITEM, agentLabel: 'HVE Core / PR Review' });

    expect(shown).toBe(true);
    expect(inDiff.isShowing('f1')).toBe(true);
    expect(showTextDocument).toHaveBeenCalledOnce();
    // Beside the review tab, and without stealing focus from triage.
    expect(showTextDocument.mock.calls[0]?.[1]).toMatchObject({
      viewColumn: -2,
      preserveFocus: true,
    });
    // The whole-line decoration lands on the flagged line, tinted by severity.
    const applied = editor.setDecorations.mock.calls.at(-1);
    expect(applied?.[1]).toEqual([{ line: 3, text: '  return cache.get(key);' }]);
    expect(createTextEditorDecorationType.mock.calls[0]?.[0]).toMatchObject({ isWholeLine: true });
    expect(createCommentThread).toHaveBeenCalledOnce();
    expect(thread.label).toBe('BLOCKER · 96% · Undecided');
    expect(thread.canReply).toBe(false);
    expect(editor.revealRange).toHaveBeenCalledOnce();
    inDiff.dispose();
  });

  it('follows the code when commits pushed it down the file', async () => {
    state.files.set('/repo/src/auth/token.ts', ['// new header', ...FILE_TEXT.split('\n')].join('\n'));
    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    await inDiff.show({ item: ITEM, agentLabel: 'agent' });

    expect(editor.setDecorations.mock.calls.at(-1)?.[1]).toEqual([
      { line: 4, text: '  return cache.get(key);' },
    ]);
    inDiff.dispose();
  });

  it('opens the qualified root when two roots contain the same relative path', async () => {
    state.workspaceFolders = [
      { name: 'service-a', uri: { path: '/workspace/service-a' } },
      { name: 'service-b', uri: { path: '/workspace/service-b' } },
    ];
    state.files = new Map([
      ['/workspace/service-a/src/auth/token.ts', FILE_TEXT],
      ['/workspace/service-b/src/auth/token.ts', FILE_TEXT.replace('cache.get(key)', 'other.get(key)')],
    ]);
    const { locateInWorkspace } = await import('./inDiffEditor.js');

    const located = await locateInWorkspace({ ...ITEM, file: 'service-a/src/auth/token.ts' });

    expect(located?.document.uri.path).toBe('/workspace/service-a/src/auth/token.ts');
  });

  it('stays silent when the reviewed file is not in this workspace', async () => {
    state.files = new Map();
    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    const shown = await inDiff.show({ item: ITEM, agentLabel: 'agent' });

    expect(shown).toBe(false);
    expect(inDiff.isShowing('f1')).toBe(false);
    expect(showTextDocument).not.toHaveBeenCalled();
    expect(createCommentThread).not.toHaveBeenCalled();
    inDiff.dispose();
  });

  it('stays silent when a same-named file no longer holds the flagged code', async () => {
    state.files.set('/repo/src/auth/token.ts', 'export function token() { return fresh(); }');
    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    expect(await inDiff.show({ item: ITEM, agentLabel: 'agent' })).toBe(false);
    inDiff.dispose();
  });

  it('discards a slow show that a newer selection already superseded', async () => {
    const other = { ...ITEM, id: 'f2', title: 'Second finding', file: 'src/session.ts', line: 1, code: 'const session = load();' };
    state.files.set('/repo/src/session.ts', 'const session = load();\n');
    // Hold the first finding's file open until after the second one lands.
    let release = (): void => {};
    state.gate.set('/repo/src/auth/token.ts', new Promise<void>((resolve) => { release = resolve; }));

    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    const slow = inDiff.show({ item: ITEM, agentLabel: 'agent' });
    const fast = await inDiff.show({ item: other, agentLabel: 'agent' });
    release();

    expect(fast).toBe(true);
    expect(await slow).toBe(false);
    // The superseded finding never reaches the screen — the selection wins.
    expect(inDiff.isShowing('f2')).toBe(true);
    expect(inDiff.isShowing('f1')).toBe(false);
    expect(createCommentThread).toHaveBeenCalledOnce();
    expect(editor.setDecorations.mock.calls.at(-1)?.[1]).toEqual([
      { line: 1, text: 'const session = load();' },
    ]);
    inDiff.dispose();
  });

  it('carries the verdict in the thread label and clears on leaving in-diff', async () => {
    const { InDiffEditor } = await import('./inDiffEditor.js');
    const inDiff = new InDiffEditor();

    await inDiff.show({ item: ITEM, verdict: 'accepted', agentLabel: 'agent' });
    expect(thread.label).toBe('BLOCKER · 96% · Accepted');

    await inDiff.show(undefined);
    expect(thread.dispose).toHaveBeenCalledOnce();
    expect(inDiff.isShowing('f1')).toBe(false);
    // Clearing wipes the line tint rather than leaving it on a stale line.
    expect(editor.setDecorations.mock.calls.at(-1)?.[1]).toEqual([]);
    inDiff.dispose();
  });
});
