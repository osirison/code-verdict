import { describe, expect, it } from 'vitest';
import {
  labelledWorkspaceRoots,
  modelVisiblePath,
  modelVisiblePathForUri,
  modelVisibleRootLabelForProject,
  providerRelativePath,
} from './modelVisiblePath';

describe('model-visible workspace paths', () => {
  it('omits a redundant root label in a single-root workspace', () => {
    const roots = [{ name: 'api', path: '/workspace/api' }];
    expect(modelVisiblePathForUri('/workspace/api/src/index.ts', 'src/index.ts', roots)).toBe('src/index.ts');
  });

  it('keeps identical relative paths distinct across roots', () => {
    const roots = [
      { name: 'api', path: '/workspace/api' },
      { name: 'web', path: '/workspace/web' },
    ];
    expect(modelVisiblePathForUri('/workspace/api/src/index.ts', 'src/index.ts', roots)).toBe('api/src/index.ts');
    expect(modelVisiblePathForUri('/workspace/web/src/index.ts', 'src/index.ts', roots)).toBe('web/src/index.ts');
  });

  it('assigns stable distinct labels when root display names collide', () => {
    const roots = [
      { name: 'repo', path: '/workspace/z/repo' },
      { name: 'repo-1', path: '/workspace/reserved' },
      { name: 'repo', path: '/workspace/a/repo' },
    ];
    const labels = labelledWorkspaceRoots(roots).map((root) => root.label);
    expect(labels).toEqual(['repo-3', 'repo-1', 'repo-2']);
    expect(new Set(labels).size).toBe(3);
  });

  it('qualifies a diff only when repository identity selects one root', () => {
    const roots = [
      { name: 'api', path: '/workspace/api' },
      { name: 'web', path: '/workspace/web' },
    ];
    expect(modelVisibleRootLabelForProject(['org/api', 'api'], roots)).toBe('api');
    expect(modelVisibleRootLabelForProject(['org/unknown'], roots)).toBeUndefined();
  });

  it('round-trips the known host root prefix for provider operations', () => {
    expect(providerRelativePath(modelVisiblePath('src/a.ts', 'api'), 'api')).toBe('src/a.ts');
    expect(providerRelativePath('other/src/a.ts', 'api')).toBe('other/src/a.ts');
  });
});