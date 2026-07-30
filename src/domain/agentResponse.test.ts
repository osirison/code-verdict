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
      ],
    });
    expect(response.items).toHaveLength(1);
    expect(rejected.map((r) => r.index)).toEqual([1, 2, 3, 4]);
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
