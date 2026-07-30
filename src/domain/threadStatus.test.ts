import { describe, expect, it } from 'vitest';
import type { ReviewThread, ThreadNote } from '../platform/types';
import { deriveThreadStatus, isWaitingOnYou } from './threadStatus';
import { loadSpecFixtures } from '../testing/specFixtures';

interface RawNote {
  id: number;
  author: { username: string };
  body: string;
  created_at: string;
  resolvable?: boolean;
  resolved?: boolean;
  position?: unknown;
}

interface RawDiscussion {
  id: string;
  notes: RawNote[];
  _derivedStatus: string;
}

/** Map a GitLab-shaped fixture discussion onto the neutral thread type. */
function toThread(d: RawDiscussion): ReviewThread {
  const notes: ThreadNote[] = d.notes.map((n) => ({
    id: String(n.id),
    author: n.author,
    body: n.body,
    createdAt: n.created_at,
    resolvable: n.resolvable,
    resolved: n.resolved,
  }));
  const resolvable = d.notes.filter((n) => n.resolvable);
  return {
    id: d.id,
    crRef: { repoId: '9101', number: '2841' },
    notes,
    resolved: resolvable.length > 0 && resolvable.every((n) => n.resolved),
    // `position: null` means the platform dropped the anchor; an absent
    // position field does not.
    anchorPresent: !d.notes.some((n) => n.position === null),
  };
}

const fixtures = loadSpecFixtures();
const discussions = (fixtures.discussionsResponse as { discussions: RawDiscussion[] }).discussions;

describe('deriveThreadStatus (handoff §8)', () => {
  it('reproduces every _derivedStatus annotation in the spec fixtures', () => {
    for (const d of discussions) {
      const status = deriveThreadStatus(toThread(d), { you: 'you' });
      expect(status, `discussion ${d.id}`).toBe(d._derivedStatus);
    }
  });

  it('flags a locally-conceded resolved thread as conceded, not resolved', () => {
    const resolvedThread = toThread(
      discussions.find((d) => d._derivedStatus === 'resolved') as RawDiscussion,
    );
    const status = deriveThreadStatus(resolvedThread, {
      you: 'you',
      conceded: new Set([resolvedThread.id]),
    });
    expect(status).toBe('conceded');
  });

  it('reports awaiting when the last note is yours', () => {
    const thread: ReviewThread = {
      id: 't1',
      crRef: { repoId: '1', number: '1' },
      resolved: false,
      anchorPresent: true,
      notes: [
        { id: 'n1', author: { username: 'you' }, body: 'posted', createdAt: '2026-07-30T00:00:00Z' },
      ],
    };
    expect(deriveThreadStatus(thread, { you: 'you' })).toBe('awaiting');
  });

  it('counts replied and stale — and only those — as waiting on you', () => {
    expect(isWaitingOnYou('replied')).toBe(true);
    expect(isWaitingOnYou('stale')).toBe(true);
    expect(isWaitingOnYou('awaiting')).toBe(false);
    expect(isWaitingOnYou('resolved')).toBe(false);
    expect(isWaitingOnYou('conceded')).toBe(false);
  });
});
