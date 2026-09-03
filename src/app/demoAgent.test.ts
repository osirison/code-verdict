import { describe, expect, it } from 'vitest';
import { GitLabEmulator } from '../../emulator/engine';
import { emulatorFetch } from '../../emulator/fetch';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { addedLines } from '../domain/diffHunks';
import { toChangeRequestDiff } from './demoAgent.test-helper';
import { runDemoAgent } from './demoAgent';

async function flagshipDiff() {
  return toChangeRequestDiff(emulatorFetch(new GitLabEmulator({ seed: 1 })));
}

describe('demo agent', () => {
  it('is deterministic and anchors every item to a real added line', async () => {
    const diff = await flagshipDiff();
    const a = runDemoAgent(diff, DEFAULT_CRITERIA);
    const b = runDemoAgent(diff, DEFAULT_CRITERIA);
    expect(a.response.items.map((i) => i.id)).toEqual(b.response.items.map((i) => i.id));
    expect(a.response.headSha).toBe(diff.headSha);
    expect(a.response.items.length).toBeGreaterThan(0);

    for (const item of a.response.items) {
      const file = diff.files.find((f) => f.newPath === item.file);
      expect(file, item.file).toBeDefined();
      const lines = addedLines(file?.diff ?? '').map((l) => l.line);
      expect(lines, `${item.file}:${item.line}`).toContain(item.line);
    }
  });

  it('splits findings into items and candidate buckets by the criteria', async () => {
    const diff = await flagshipDiff();
    const strict = runDemoAgent(diff, { ...DEFAULT_CRITERIA, severityFloor: 'blocker', minConfidence: 95 });
    const loose = runDemoAgent(diff, { ...DEFAULT_CRITERIA, severityFloor: 'nit', minConfidence: 0, categories: [...DEFAULT_CRITERIA.categories, 'apiContract', 'docs', 'style'] });
    expect(strict.response.items.length).toBeLessThan(loose.response.items.length);
    const strictTotal =
      strict.response.items.length + strict.response.candidates.reduce((n, c) => n + c.count, 0);
    const looseTotal =
      loose.response.items.length + loose.response.candidates.reduce((n, c) => n + c.count, 0);
    expect(strictTotal).toBe(looseTotal);
  });

  it('emits the spec §4 progress log', async () => {
    const diff = await flagshipDiff();
    const { steps } = runDemoAgent(diff, DEFAULT_CRITERIA);
    expect(steps[0]).toContain('Resolving agent');
    expect(steps[1]).toMatch(/Indexing \d+ changed files \(\+\d+ −\d+\)/);
    expect(steps[4]).toMatch(/\d+ items ready/);
  });

  it('uses the host root qualification for every model-visible changed-file path', async () => {
    const diff = await flagshipDiff();
    const result = runDemoAgent(diff, DEFAULT_CRITERIA, { workspaceRootLabel: 'api' });
    expect(result.response.items.every((item) => item.file.startsWith('api/'))).toBe(true);
  });

  it('inspects post-budget attachment lines through manifest validation and marks them summary-only', async () => {
    const diff = await flagshipDiff();
    const result = runDemoAgent(diff, {
      ...DEFAULT_CRITERIA,
      severityFloor: 'nit',
      minConfidence: 0,
      categories: [...DEFAULT_CRITERIA.categories, 'apiContract', 'docs', 'style'],
    }, {
      attachments: [{
        id: 'schema',
        kind: 'file',
        label: 'schema.ts',
        path: 'api/config/schema.ts',
        content: 'mode: strict\nunsafe: true',
        truncated: false,
        evidence: [{
          path: 'api/config/schema.ts',
          range: { startLine: 10, endLine: 11 },
          contentStart: 0,
          contentEnd: 25,
        }],
      }],
    });

    const attachmentItem = result.response.items.find((item) => item.id.startsWith('dem_attachment_'));
    expect(attachmentItem).toMatchObject({ file: 'api/config/schema.ts', anchored: false });
    expect([10, 11]).toContain(attachmentItem?.line);
    expect(() => JSON.stringify(result.response)).not.toThrow();
  });
});
