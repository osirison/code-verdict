import { describe, expect, it } from 'vitest';
import { AgentResponseError, parseAgentReviewResponse } from './agentResponse';
import { loadSpecFixtures } from '../testing/specFixtures';

const fixtures = loadSpecFixtures();
const reference = fixtures.agentReviewResponse as Record<string, unknown>;

describe('parseAgentReviewResponse', () => {
  it('accepts the reference payload unchanged', () => {
    const { response, rejected } = parseAgentReviewResponse(reference);
    expect(rejected).toEqual([]);
    expect(response.agentId).toBe('hve-core.pr-review');
    expect(response.headSha).toBe('4f19c2a7b1d3e9f0c5a8b2d4e6f7a9c1b3d5e7f9');
    expect(response.items).toHaveLength(3);
    expect(response.candidates).toHaveLength(2);

    const blocker = response.items[0];
    expect(blocker?.id).toBe('itm_01H9Z4');
    expect(blocker?.anchored).toBe(true);
    expect(blocker?.severity).toBe('blocker');
    expect(blocker?.category).toBe('security');
    expect(blocker?.confidence).toBe(96);
    expect(blocker?.suggestion?.new).toBe("logger.error('refresh failed', { tokenId: this.tokenId })");
    expect(blocker?.answers?.why).toContain('secrets/no-credential-logging');
  });

  it('maps the spec cross-repo item onto neutral field names', () => {
    const cross = fixtures.crossRepoItem as Record<string, unknown>;
    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [cross],
    });
    expect(rejected).toEqual([]);
    const item = response.items[0];
    expect(item?.cross).toBe(true);
    expect(item?.repoId).toBe('9103');
    expect(item?.crNumber).toBe('381');
    expect(item?.spans?.map((s) => s.repoId)).toEqual(['9103', '9210']);
  });

  it('rejects items missing file/line/severity/category/confidence individually', () => {
    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [
        { file: 'a.ts', line: 1, severity: 'major', category: 'tests', confidence: 80, title: 'ok' },
        { line: 2, severity: 'major', category: 'tests', confidence: 80 },
        { file: 'b.ts', line: 3, severity: 'catastrophic', category: 'tests', confidence: 80 },
        { file: 'c.ts', line: 4, severity: 'minor', category: 'vibes', confidence: 80 },
        { file: 'd.ts', line: 5, severity: 'minor', category: 'tests', confidence: 180 },
        { file: 'e.ts', line: 6, severity: 'minor', category: 'tests', confidence: NaN },
      ],
    });
    expect(response.items).toHaveLength(1);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4, 5]);
  });

  it('derives anchoring from supplied file paths and rejects files outside the supplied evidence', () => {
    const item = (file: string, anchored?: boolean) => ({
      file,
      line: 999,
      severity: 'major',
      category: 'tests',
      confidence: 80,
      title: file,
      anchored,
    });
    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [item('src/diff.ts', false), item('docs/evidence.md', true), item('description', true)],
    }, {
      diffPaths: ['src/diff.ts'],
      attachmentManifest: [{ path: 'docs/evidence.md', ranges: [{ startLine: 900, endLine: 1_000 }] }],
    });

    expect(response.items.map(({ file, anchored }) => ({ file, anchored }))).toEqual([
      { file: 'src/diff.ts', anchored: true },
      { file: 'docs/evidence.md', anchored: false },
    ]);
    expect(rejected).toEqual([
      { index: 2, reason: 'file was not supplied as diff or attachment: description' },
    ]);
  });

  it('requires attachment findings to name an actual manifested path and visible positive integer line', () => {
    const item = (file: string, line: number) => ({
      file,
      line,
      severity: 'major',
      category: 'tests',
      confidence: 80,
      title: `${file}:${line}`,
    });
    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [
        item('root/docs/evidence.md', 10),
        item('root/docs/evidence.md', 12),
        item('attachment:docs', 10),
        item('root/docs/imitated.md', 10),
        item('root/docs/evidence.md', 0),
        item('root/docs/evidence.md', -1),
        item('root/docs/evidence.md', 10.5),
      ],
    }, {
      diffPaths: [],
      attachmentManifest: [{ path: 'root/docs/evidence.md', ranges: [{ startLine: 10, endLine: 11 }] }],
    });

    expect(response.items.map((entry) => `${entry.file}:${entry.line}`)).toEqual(['root/docs/evidence.md:10']);
    expect(rejected).toHaveLength(6);
    expect(rejected[0]?.reason).toContain('outside model-visible attachment evidence');
    expect(rejected.slice(1, 3).every((entry) => entry.reason.includes('not supplied'))).toBe(true);
    expect(rejected.slice(3).every((entry) => entry.reason.includes('invalid line'))).toBe(true);
  });

  it('keeps a positive changed-file line anchored even when it drifted outside added lines', () => {
    const { response, rejected } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [{
        file: 'root/src/diff.ts', line: 9_999, severity: 'major', category: 'tests', confidence: 80,
      }],
    }, { diffPaths: ['root/src/diff.ts'], attachmentManifest: [] });

    expect(rejected).toEqual([]);
    expect(response.items[0]).toMatchObject({ file: 'root/src/diff.ts', line: 9_999, anchored: true });
  });

  it('drops candidate buckets with unknown reasons and non-finite stats', () => {
    const { response } = parseAgentReviewResponse({
      schemaVersion: '1',
      headSha: 'abc123',
      items: [],
      candidates: [
        { severity: 'nit', category: 'style', confidence: 60, reason: 'belowSeverityFloor', count: 4 },
        { severity: 'nit', category: 'style', confidence: 60, reason: 'vibesOff', count: 2 },
      ],
      stats: { filesRead: '9', linesAdded: Infinity, linesRemoved: 91, durationMs: null },
    });
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]?.reason).toBe('belowSeverityFloor');
    expect(response.stats).toEqual({ filesRead: 0, linesAdded: 0, linesRemoved: 91, durationMs: 0 });
  });

  it('rejects a response without headSha outright', () => {
    expect(() =>
      parseAgentReviewResponse({ schemaVersion: '1', items: [] }),
    ).toThrow(AgentResponseError);
  });

  it('rejects an unsupported schemaVersion', () => {
    expect(() =>
      parseAgentReviewResponse({ schemaVersion: '2', headSha: 'x', items: [] }),
    ).toThrow(AgentResponseError);
  });
});
