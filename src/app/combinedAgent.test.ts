import { describe, expect, it } from 'vitest';
import type { Criteria } from '../domain/types';
import { changesetHeadSha, parseChangesetHeadSha, runDemoChangesetAgent, validateChangesetResponse, type ChangesetAgentMember } from './combinedAgent';

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
      ref: { repoId: '9103', number: '381' }, baseSha: 'gateway-base', headSha: 'gateway-head', anchorRefs: { head: 'gateway' },
      files: [{ oldPath: 'src/routes/session.ts', newPath: 'src/routes/session.ts', diff: '@@ -87,1 +87,2 @@\n return session\n+return { expires_at: session.expiresAt }\n' }],
    },
  },
  {
    ref: { repoId: '9210', number: '1509' },
    projectPath: 'hve/web/console',
    diff: {
      ref: { repoId: '9210', number: '1509' }, baseSha: 'console-base', headSha: 'console-head', anchorRefs: { head: 'console' },
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

  it('accepts an attachment finding only for its labelled member and marks it summary-only', () => {
    const labelledMembers: ChangesetAgentMember[] = members.map((member, index) => index === 0
      ? {
          ...member,
          attachments: [{
            id: 'schema', kind: 'file', label: 'schema.ts', path: 'config/schema.ts', content: 'unsafe: true', truncated: false,
            evidence: [{
              path: 'config/schema.ts', range: { startLine: 1, endLine: 1 }, contentStart: 0, contentEnd: 12,
            }],
          }],
        }
      : member);
    const response = {
      schemaVersion: '1',
      agentId: 'a',
      agentLabel: 'A',
      headSha: changesetHeadSha(labelledMembers),
      items: [{
        id: 'attachment', repoId: '9103', crNumber: '381', file: 'config/schema.ts', anchored: true,
        line: 1, severity: 'major' as const, category: 'security' as const, confidence: 90,
        title: 'Unsafe schema setting', body: 'The member enables an unsafe mode.', code: 'unsafe: true',
      }],
      candidates: [],
    };

    const validated = validateChangesetResponse(response, labelledMembers);
    expect(validated.items[0]).toMatchObject({
      repoId: '9103', crNumber: '381', file: 'config/schema.ts', anchored: false,
    });
    expect(() => validateChangesetResponse({
      ...response,
      items: [{ ...response.items[0]!, repoId: '9210', crNumber: '1509' }],
    }, labelledMembers)).toThrow(/outside its changeset member/);
  });

  it('generates a summary-only attachment finding for the owning changeset member', () => {
    const labelledMembers: ChangesetAgentMember[] = members.map((member, index) => index === 0
      ? {
          ...member,
          attachments: [{
            id: 'schema', kind: 'file', label: 'schema.ts', path: 'config/schema.ts', content: 'unsafe: true', truncated: false,
            evidence: [{
              path: 'config/schema.ts', range: { startLine: 8, endLine: 8 }, contentStart: 0, contentEnd: 12,
            }],
          }],
        }
      : member);

    const result = runDemoChangesetAgent(labelledMembers, criteria);
    const attachmentItem = result.response.items.find((item) => item.id.includes('dem_attachment_'));

    expect(attachmentItem).toMatchObject({
      repoId: '9103', crNumber: '381', file: 'config/schema.ts', line: 8, anchored: false,
    });
    expect(() => validateChangesetResponse(result.response, labelledMembers)).not.toThrow();
  });

  it('round-trips the composite head and drops segments that carry no separator', () => {
    expect(parseChangesetHeadSha(changesetHeadSha(members))).toEqual(
      new Map([['9103!381', 'gateway-head'], ['9210!1509', 'console-head']]),
    );

    // One malformed segment must not cost the well-formed ones their entry —
    // an empty map here reads as "every member moved" and fires a false
    // stale banner over a draft that is perfectly current.
    expect(parseChangesetHeadSha('9103!381:gateway-head|corrupted')).toEqual(
      new Map([['9103!381', 'gateway-head']]),
    );
  });
});