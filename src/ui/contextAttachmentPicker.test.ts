import { beforeEach, describe, expect, it, vi } from 'vitest';

interface TestUri {
  path: string;
  toString(skipEncoding?: boolean): string;
}

function uri(path: string): TestUri {
  return { path, toString: () => `file://${path}` };
}

const state = vi.hoisted(() => ({
  workspaceFolders: [] as Array<{ name: string; uri: TestUri }>,
  globalMatches: [] as TestUri[],
  relativeMatches: new Map<string, TestUri[]>(),
}));

const findFiles = vi.hoisted(() => vi.fn(async (include: string | { base: { uri: TestUri }; pattern: string }) => (
  typeof include === 'string'
    ? state.globalMatches
    : state.relativeMatches.get(`${include.base.uri.path}\0${include.pattern}`) ?? []
)));

vi.mock('vscode', () => ({
  RelativePattern: class {
    constructor(
      readonly base: { uri: TestUri },
      readonly pattern: string,
    ) {}
  },
  workspace: {
    get workspaceFolders() { return state.workspaceFolders; },
    findFiles,
    asRelativePath: (target: TestUri) => {
      const owner = state.workspaceFolders
        .filter((folder) => target.path.startsWith(`${folder.uri.path}/`))
        .sort((left, right) => right.uri.path.length - left.uri.path.length)[0];
      return owner ? target.path.slice(owner.uri.path.length + 1) : target.path;
    },
    fs: {},
  },
  Uri: { joinPath: vi.fn(), parse: vi.fn() },
  languages: { getDiagnostics: () => [] },
  FileType: { File: 1, Directory: 2 },
  DiagnosticSeverity: {},
}));

describe('root-qualified context file references', () => {
  beforeEach(() => {
    state.workspaceFolders = [
      { name: 'api', uri: uri('/workspace/api') },
      { name: 'web', uri: uri('/workspace/web') },
    ];
    state.globalMatches = [
      uri('/workspace/api/src/shared.ts'),
      uri('/workspace/web/src/shared.ts'),
    ];
    state.relativeMatches = new Map([
      ['/workspace/api\0src/shared.ts', [uri('/workspace/api/src/shared.ts')]],
      ['/workspace/web\0src/shared.ts', [uri('/workspace/web/src/shared.ts')]],
    ]);
    findFiles.mockClear();
  });

  it.each([
    ['api/src/shared.ts', '/workspace/api', 'api/src/shared.ts'],
    ['web/src/shared.ts', '/workspace/web', 'web/src/shared.ts'],
  ])('maps %s to its labelled workspace root', async (reference, rootPath, modelPath) => {
    const { findReferenceFile } = await import('./contextAttachmentPicker.js');

    const target = await findReferenceFile(reference);

    expect(target?.uri.path).toBe(`${rootPath}/src/shared.ts`);
    expect(target?.workspacePath).toBe(modelPath);
    expect(findFiles).toHaveBeenCalledWith(
      expect.objectContaining({ base: expect.objectContaining({ uri: expect.objectContaining({ path: rootPath }) }), pattern: 'src/shared.ts' }),
      undefined,
      2,
    );
  });

  it('keeps an unqualified duplicate relative path ambiguous', async () => {
    const { findReferenceFile } = await import('./contextAttachmentPicker.js');

    expect(await findReferenceFile('src/shared.ts')).toBeUndefined();
    expect(findFiles).toHaveBeenCalledWith('**/src/shared.ts', undefined, 2);
  });
});