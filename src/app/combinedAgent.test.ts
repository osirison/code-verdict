import { describe, expect, it } from 'vitest';
import { changesetHeadSha, parseChangesetHeadSha, type ChangesetAgentMember } from './combinedAgent';

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
