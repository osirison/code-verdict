import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { fs: {} },
  Uri: { joinPath: vi.fn() },
}));

import {
  deduplicateAttachments,
  inclusiveAttachmentRange,
  revalidateAttachments,
  resolveAttachment,
  type AttachmentResolverDeps,
} from './attachments';
import { manifestContainsLocation } from '../domain/agentResponse';
import { changesetMemberForAttachment } from './combinedAgent';
import { workspaceRootForProject } from './modelVisiblePath';
import { attachmentEvidenceManifest } from './reviewContext';

function resolverDeps(
  files: Record<string, string>,
  directories: Record<string, Array<[string, number]>> = {},
): AttachmentResolverDeps {
  return {
    fs: {
      readFile: vi.fn(async (uri) => {
        const content = files[uri.toString()];
        if (content === undefined) throw new Error('ENOENT');
        return new TextEncoder().encode(content);
      }),
      readDirectory: vi.fn(async (uri) => {
        const entries = directories[uri.toString()];
        if (!entries) throw new Error('ENOENT');
        return entries;
      }),
      stat: vi.fn(async (uri) => ({ size: files[uri.toString()]?.length ?? 0 })),
    },
    joinPath: (base, ...parts) => ({
      path: `${base.path}/${parts.join('/')}`,
      toString: () => `${base.toString()}/${parts.join('/')}`,
    }),
    parseUri: (value) => ({ path: value.replace(/^mem:/, ''), toString: () => value }),
    getDiagnostics: () => [],
    fileType: { file: 1, directory: 2 },
  };
}

function uri(path: string) {
  return { path, toString: () => `mem:${path}` };
}

describe('resolveAttachment', () => {
  it('reads a file once at attach time and keeps the cached content', async () => {
    const fileUri = uri('/workspace/src/schema.ts');
    const deps = resolverDeps({ [fileUri.toString()]: 'export const schema = 1;\n' });

    const attachment = await resolveAttachment('file', { uri: fileUri, workspacePath: 'src/schema.ts' }, deps);

    expect(attachment).toMatchObject({
      kind: 'file',
      id: 'schema.ts',
      label: 'src/schema.ts',
      path: 'src/schema.ts',
      content: 'export const schema = 1;\n',
      truncated: false,
      evidence: [{ path: 'src/schema.ts', range: { startLine: 1, endLine: 2 } }],
    });
    expect(deps.fs.readFile).toHaveBeenCalledTimes(1);

    expect(attachment.content).toBe('export const schema = 1;\n');
    expect(deps.fs.readFile).toHaveBeenCalledTimes(1);
  });

  it('resolves a selection to only its inclusive line range', async () => {
    const fileUri = uri('/workspace/src/service.ts');
    const deps = resolverDeps({ [fileUri.toString()]: 'one\ntwo\nthree\nfour\n' });

    const attachment = await resolveAttachment('selection', {
      uri: fileUri,
      workspacePath: 'src/service.ts',
      range: { startLine: 2, endLine: 3 },
    }, deps);

    expect(attachment).toMatchObject({
      kind: 'selection',
      label: 'src/service.ts:2-3',
      range: { startLine: 2, endLine: 3 },
      content: 'two\nthree',
      evidence: [{ path: 'src/service.ts', range: { startLine: 2, endLine: 3 } }],
    });
  });

  it('resolves a symbol to its named source range', async () => {
    const fileUri = uri('/workspace/src/service.ts');
    const deps = resolverDeps({ [fileUri.toString()]: 'before\nexport function run() {}\nafter' });

    const attachment = await resolveAttachment('symbol', {
      uri: fileUri,
      workspacePath: 'src/service.ts',
      range: { startLine: 2, endLine: 2 },
      name: 'run',
    }, deps);

    expect(attachment).toMatchObject({
      kind: 'symbol',
      id: 'run',
      label: 'run (src/service.ts:2-2)',
      content: 'export function run() {}',
      evidence: [{ path: 'src/service.ts', range: { startLine: 2, endLine: 2 } }],
    });
  });

  it.each(['file', 'symbol'] as const)(
    'assigns a resolved %s reference to the uniquely mapped member in a single-root workspace',
    async (kind) => {
      const fileUri = uri('/workspace/repo-a/src/service.ts');
      const deps = resolverDeps({ [fileUri.toString()]: 'export function run() {}' });
      const target = kind === 'symbol'
        ? { uri: fileUri, workspacePath: 'src/service.ts', range: { startLine: 1, endLine: 1 }, name: 'run' }
        : { uri: fileUri, workspacePath: 'src/service.ts' };
      const attachment = await resolveAttachment(kind, target, deps);
      const roots = [{ name: 'repo-a', path: '/workspace/repo-a', sourceUri: 'mem:/workspace/repo-a' }];
      const members = [
        {
          ref: { repoId: 'repo-a', number: '1' },
          workspaceRootSourceUri: workspaceRootForProject(['org/repo-a', 'repo-a'], roots)?.sourceUri,
        },
        {
          ref: { repoId: 'repo-b', number: '2' },
          workspaceRootSourceUri: workspaceRootForProject(['org/repo-b', 'repo-b'], roots)?.sourceUri,
        },
      ];

      expect(attachment.path).toBe('src/service.ts');
      expect(changesetMemberForAttachment(members, attachment)?.ref).toEqual({ repoId: 'repo-a', number: '1' });
    },
  );

  it('leaves attachment ownership unresolved when members truly share one root', () => {
    const attachment = { sourceUri: 'mem:/workspace/shared/src/service.ts' };
    const members = [
      { ref: { repoId: 'repo-a', number: '1' }, workspaceRootSourceUri: 'mem:/workspace/shared' },
      { ref: { repoId: 'repo-b', number: '2' }, workspaceRootSourceUri: 'mem:/workspace/shared' },
    ];

    expect(changesetMemberForAttachment(members, attachment)).toBeUndefined();
  });

  it('formats current diagnostics deterministically without reading files', async () => {
    const deps = resolverDeps({});
    deps.getDiagnostics = () => [{
      workspacePath: 'src/z.ts',
      range: { startLine: 8, endLine: 8 },
      severity: 'error',
      source: 'ts',
      code: 2322,
      message: 'Type mismatch',
    }, {
      workspacePath: 'src/a.ts',
      range: { startLine: 2, endLine: 3 },
      severity: 'warning',
      message: 'Unused value',
    }];

    const attachment = await resolveAttachment('problems', {}, deps);

    expect(attachment.content.split('\n')).toEqual([
      'src/a.ts:2-3 [warning]: Unused value',
      'src/z.ts:8-8 [error] ts 2322: Type mismatch',
    ]);
    expect(attachment.evidence).toMatchObject([
      { path: 'src/a.ts', range: { startLine: 2, endLine: 3 }, wholeRange: true },
      { path: 'src/z.ts', range: { startLine: 8, endLine: 8 }, wholeRange: true },
    ]);
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  it('converts an end-exclusive multi-line diagnostic to an exact evidence manifest', async () => {
    const deps = resolverDeps({});
    deps.getDiagnostics = () => [{
      workspacePath: 'src/a.ts',
      range: inclusiveAttachmentRange({ line: 1 }, { line: 3, character: 0 }),
      severity: 'warning',
      message: 'Spans two lines',
    }];

    const attachment = await resolveAttachment('problems', {}, deps);
    const manifest = attachmentEvidenceManifest([attachment]);

    expect(manifest).toEqual([{ path: 'src/a.ts', ranges: [{ startLine: 2, endLine: 3 }] }]);
    expect(manifestContainsLocation(manifest, 'src/a.ts', 3)).toBe(true);
    expect(manifestContainsLocation(manifest, 'src/a.ts', 4)).toBe(false);
  });

  it('caches pasted text without touching the filesystem', async () => {
    const deps = resolverDeps({});
    const attachment = await resolveAttachment('pasted', { text: 'request log\nline two', label: 'Failure log' }, deps);
    expect(attachment).toMatchObject({ kind: 'pasted', label: 'Failure log', content: 'request log\nline two' });
    expect(attachment.path).toMatch(/^pasted:[0-9a-f]{8}$/);
    expect(attachment.evidence).toBeUndefined();
    expect(deps.fs.readFile).not.toHaveBeenCalled();
  });

  it('chooses folder files in sorted order within depth, file, and byte bounds', async () => {
    const folderUri = uri('/workspace/src');
    const files = {
      'mem:/workspace/src/a.ts': 'A\n',
      'mem:/workspace/src/z.ts': 'Z\n',
      'mem:/workspace/src/nested/b.ts': 'B\n',
    };
    const directories = {
      'mem:/workspace/src': [['z.ts', 1], ['nested', 2], ['a.ts', 1]] as Array<[string, number]>,
      'mem:/workspace/src/nested': [['b.ts', 1]] as Array<[string, number]>,
    };
    const deps = resolverDeps(files, directories);

    const attachment = await resolveAttachment('folder', {
      uri: folderUri,
      workspacePath: 'src',
      maxDepth: 1,
      maxFiles: 2,
      contentBudget: 180,
    }, deps);

    expect(attachment.content).toContain('--- src/a.ts\nA');
    expect(attachment.content).toContain('--- src/nested/b.ts\nB');
    expect(attachment.content).not.toContain('--- src/z.ts');
    expect(attachment.content).toContain('Folder attachment truncated');
    expect(attachment.evidence).toMatchObject([
      { path: 'src/a.ts', range: { startLine: 1, endLine: 2 } },
      { path: 'src/nested/b.ts', range: { startLine: 1, endLine: 2 } },
    ]);
    expect(attachment.truncated).toBe(true);
    expect(deps.fs.readFile).toHaveBeenCalledTimes(2);
    expect(attachment.content.length).toBeLessThanOrEqual(180);
  });

  it('bounds directory traversal and falls back from invalid limits', async () => {
    const root = uri('/workspace/root');
    const directories = {
      'mem:/workspace/root': [['a', 2], ['b', 2], ['c', 2]] as Array<[string, number]>,
      'mem:/workspace/root/a': [] as Array<[string, number]>,
      'mem:/workspace/root/b': [] as Array<[string, number]>,
      'mem:/workspace/root/c': [] as Array<[string, number]>,
    };
    const deps = resolverDeps({}, directories);

    const attachment = await resolveAttachment('folder', {
      uri: root,
      workspacePath: 'root',
      maxDepth: Number.NaN,
      maxFiles: Number.NaN,
      maxDirectories: 2,
      contentBudget: 100,
    }, deps);

    expect(deps.fs.readDirectory).toHaveBeenCalledTimes(2);
    expect(attachment.truncated).toBe(true);
    expect(attachment.content).toContain('Folder attachment truncated');
    expect(attachment.content.length).toBeLessThanOrEqual(100);
  });
});

describe('deduplicateAttachments', () => {
  it('deduplicates the same canonical file and range while retaining distinct ranges', async () => {
    const fileUri = uri('/workspace/src/a.ts');
    const deps = resolverDeps({ [fileUri.toString()]: 'one\ntwo\nthree' });
    const first = await resolveAttachment('selection', {
      uri: fileUri, workspacePath: 'src/a.ts', range: { startLine: 1, endLine: 1 },
    }, deps);
    const duplicate = { ...first, content: 'must not replace the cached first copy' };
    const secondRange = await resolveAttachment('selection', {
      uri: fileUri, workspacePath: 'src/a.ts', range: { startLine: 2, endLine: 2 },
    }, deps);

    const attachments = deduplicateAttachments([first, duplicate, secondRange]);

    expect(attachments).toHaveLength(2);
    expect(attachments[0]?.content).toBe('one');
    expect(attachments.map((attachment) => attachment.range)).toEqual([
      { startLine: 1, endLine: 1 },
      { startLine: 2, endLine: 2 },
    ]);
  });

  it('assigns deterministic suffixes and distinguishing labels to the same basename', async () => {
    const alpha = uri('/workspace/a/index.ts');
    const beta = uri('/workspace/b/index.ts');
    const deps = resolverDeps({ [alpha.toString()]: 'alpha', [beta.toString()]: 'beta' });
    const betaAttachment = await resolveAttachment('file', { uri: beta, workspacePath: 'b/index.ts' }, deps);
    const alphaAttachment = await resolveAttachment('file', { uri: alpha, workspacePath: 'a/index.ts' }, deps);

    const attachments = deduplicateAttachments([betaAttachment, alphaAttachment]);

    expect(attachments.map((attachment) => attachment.id)).toEqual(['index.ts-2', 'index.ts-1']);
    expect(attachments.map((attachment) => attachment.label)).toEqual([
      'b/index.ts',
      'a/index.ts',
    ]);
  });
});

describe('revalidateAttachments', () => {
  it('drops an unreadable filesystem attachment and returns a structured warning', async () => {
    const fileUri = uri('/workspace/src/schema.ts');
    const files = { [fileUri.toString()]: 'cached schema' };
    const deps = resolverDeps(files);
    const file = await resolveAttachment('file', { uri: fileUri, workspacePath: 'src/schema.ts' }, deps);
    const pasted = await resolveAttachment('pasted', { text: 'always readable' }, deps);
    delete files[fileUri.toString()];

    const result = await revalidateAttachments([file, pasted], deps);

    expect(result.attachments).toEqual([pasted]);
    expect(result.warnings).toEqual([{
      code: 'attachment-unreadable',
      attachmentId: 'schema.ts',
      label: 'src/schema.ts',
      path: 'src/schema.ts',
      reason: 'ENOENT',
    }]);
  });
});