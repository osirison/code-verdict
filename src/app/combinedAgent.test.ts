import { describe, expect, it } from 'vitest';
import type { Criteria } from '../domain/types';
import { runDemoChangesetAgent, validateChangesetResponse, type ChangesetAgentMember } from './combinedAgent';

const criteria: Criteria = {
  severityFloor: 'nit',
  minConfidence: 0,
  categories: ['security', 'concurrency', 'errorHandling', 'performance', 'craftsmanship', 'apiContract', 'tests', 'docs', 'style'],
  extraInstructions: '',
};

const members: ChangesetAgentMember[] = [
  {
    ref: { repoId: '9103', number: '381' },
    projectPath: 'hve/platform/api-gateway',
    diff: {
      ref: { repoId: '9103', number: '381' }, headSha: 'gateway-head', anchorRefs: { head: 'gateway' },
      files: [{ oldPath: 'src/routes/session.ts', newPath: 'src/routes/session.ts', diff: '@@ -87,1 +87,2 @@\n return session\n+return { expires_at: session.expiresAt }\n' }],
    },
  },
  {
    ref: { repoId: '9210', number: '1509' },
    projectPath: 'hve/web/console',
    diff: {
      ref: { repoId: '9210', number: '1509' }, headSha: 'console-head', anchorRefs: { head: 'console' },
      files: [{ oldPath: 'src/api/session.ts', newPath: 'src/api/session.ts', diff: '@@ -40,1 +40,2 @@\n const data = await load()\n+const expiry = data.expiry\n' }],
    },
  },
];

describe('combined changeset agent', () => {
  it('routes every item to a member and emits the seeded cross-repository mismatch', () => {
    const result = runDemoChangesetAgent(members, criteria);
    const cross = result.response.items.find((item) => item.cross);

    expect(result.response.items.every((item) => item.repoId && item.crNumber)).toBe(true);
    expect(new Set(result.response.items.map((item) => item.id)).size).toBe(result.response.items.length);
    expect(cross).toMatchObject({ repoId: '9210', crNumber: '1509', line: 41, category: 'apiContract' });
    expect(cross?.spans).toHaveLength(2);
    expect(() => validateChangesetResponse(result.response, members)).not.toThrow();
  });

  it('rejects an item routed to an unknown merge request', () => {
    const result = runDemoChangesetAgent(members, criteria);
    result.response.items[0] = { ...result.response.items[0]!, repoId: '9999', crNumber: '1' };

    expect(() => validateChangesetResponse(result.response, members)).toThrow(/unknown changeset member/);
  });
});