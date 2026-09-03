import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  workspace: { fs: {} },
  Uri: { joinPath: vi.fn() },
}));

import { deduplicateAttachments, type AttachmentTarget } from './attachments';
import type { Attachment, AttachmentKind } from './reviewContext';
import {
  ContextReferenceResolutionCoordinator,
  parseContextReferences,
  prepareContextReferencesForRun,
  resolveContextReferences,
  type ContextReferenceDeps,
} from './contextReferences';

function attachment(kind: AttachmentKind, path: string, range?: { startLine: number; endLine: number }): Attachment {
  return {
    id: path.split('/').at(-1) ?? path,
    kind,
    label: path,
    path,
    range,
    content: `${path} content`,
    truncated: false,
    sourceUri: `file:///${path}`,
  };
}

function deps(): ContextReferenceDeps {
  return {
    findFile: vi.fn(async (name) => name === 'auth.ts'
      ? { uri: { path: '/ws/src/auth.ts', toString: () => 'file:///ws/src/auth.ts' }, workspacePath: 'src/auth.ts' }
      : undefined),
    findSymbol: vi.fn(async (name) => name === 'verifyToken'
      ? {
          uri: { path: '/ws/src/auth.ts', toString: () => 'file:///ws/src/auth.ts' },
          workspacePath: 'src/auth.ts',
          name,
          range: { startLine: 20, endLine: 32 },
        }
      : undefined),
    resolveAttachment: vi.fn(async (kind: AttachmentKind, target: AttachmentTarget) => {
      const file = target as { workspacePath?: string; range?: { startLine: number; endLine: number } };
      return attachment(kind, file.workspacePath ?? kind, file.range);
    }),
  };
}

describe('context references', () => {
  it('parses files, inclusive ranges and symbols without changing the source text', () => {
    const text = 'Compare #file:auth.ts and #file:auth.ts:12-18 with #sym:verifyToken.';

    expect(parseContextReferences(text)).toEqual([
      { raw: '#file:auth.ts', kind: 'file', name: 'auth.ts' },
      { raw: '#file:auth.ts:12-18', kind: 'file', name: 'auth.ts', range: { startLine: 12, endLine: 18 } },
      { raw: '#sym:verifyToken', kind: 'symbol', name: 'verifyToken' },
    ]);
    expect(text).toBe('Compare #file:auth.ts and #file:auth.ts:12-18 with #sym:verifyToken.');
  });

  it('does not downgrade an invalid range into a full-file reference', () => {
    expect(parseContextReferences('Check #file:auth.ts:18-12')).toEqual([]);
  });

  it('resolves every supported form through the attachment core', async () => {
    const resolver = deps();
    const result = await resolveContextReferences(
      '#file:auth.ts #file:auth.ts:12-18 #sym:verifyToken',
      resolver,
    );

    expect(result.unresolved).toEqual([]);
    expect(result.attachments.map(({ kind, range }) => ({ kind, range }))).toEqual([
      { kind: 'file', range: undefined },
      { kind: 'selection', range: { startLine: 12, endLine: 18 } },
      { kind: 'symbol', range: { startLine: 20, endLine: 32 } },
    ]);
    expect(resolver.resolveAttachment).toHaveBeenCalledTimes(3);
  });

  it('reports unresolved references and creates no attachment for them', async () => {
    const result = await resolveContextReferences('#file:missing.ts #sym:missing', deps());

    expect(result.attachments).toEqual([]);
    expect(result.unresolved).toEqual(['#file:missing.ts', '#sym:missing']);
  });

  it('deduplicates a typed reference against the same picker attachment', async () => {
    const picked = attachment('file', 'src/auth.ts');
    const result = await resolveContextReferences('#file:auth.ts', deps());

    expect(deduplicateAttachments([picked, ...result.attachments])).toHaveLength(1);
  });

  it('reuses cached attachment content when unrelated instruction text changes', async () => {
    const resolver = deps();
    const cache = new Map();

    await resolveContextReferences('First #file:auth.ts', resolver, cache);
    await resolveContextReferences('Updated wording around #file:auth.ts', resolver, cache);

    expect(resolver.findFile).toHaveBeenCalledOnce();
    expect(resolver.resolveAttachment).toHaveBeenCalledOnce();
  });

  it('Run awaits latest reference resolution even when a debounced write already exposed the same text', async () => {
    const coordinator = new ContextReferenceResolutionCoordinator();
    let persistedInstructions = 'old instructions';
    let releaseDebouncedWrite = (): void => {};
    const debouncedWriteGate = new Promise<void>((resolve) => { releaseDebouncedWrite = resolve; });
    let appliedInstructions = '';
    let releaseResolution = (): void => {};
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    const resolutionOperation = vi.fn(async (isCurrent: () => boolean) => {
      await resolutionGate;
      if (isCurrent()) appliedInstructions = 'check #file:auth.ts';
    });
    const resolveReferences = (instructions: string) => coordinator.resolve(instructions, resolutionOperation);
    const pendingDebouncedWrite = (async () => {
      persistedInstructions = 'check #file:auth.ts';
      await debouncedWriteGate;
      await resolveReferences(persistedInstructions);
    })();

    const persist = vi.fn(async () => {});
    let runFinished = false;
    const run = prepareContextReferencesForRun(
      'check #file:auth.ts',
      persistedInstructions,
      persist,
      resolveReferences,
    ).then(() => { runFinished = true; });

    expect(persist).not.toHaveBeenCalled();
    expect(resolutionOperation).toHaveBeenCalledOnce();
    expect(runFinished).toBe(false);
    releaseDebouncedWrite();
    await Promise.resolve();
    expect(resolutionOperation).toHaveBeenCalledOnce();
    expect(runFinished).toBe(false);

    releaseResolution();
    await Promise.all([run, pendingDebouncedWrite]);
    expect(runFinished).toBe(true);
    expect(appliedInstructions).toBe('check #file:auth.ts');
  });
});