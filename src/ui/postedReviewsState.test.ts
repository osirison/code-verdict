/**
 * Local thread-patch derivations (issue #46 task 7.4, 9.3): `resolve`,
 * `concede` and `reply` used to call `refresh()`, which re-ran
 * `buildPostedReview` over the whole submitted-review history just to reflect
 * one thread changing. These are the pure functions that let the panel patch
 * that one thread instead — no fetch, no `vscode` import, so the exact rule
 * is testable without a connection.
 */
import { describe, expect, it } from 'vitest';
import type { PostedReviewView, PostedThreadView } from '../app/postedReviews';
import type { PostedRow } from './postedReviewsHtml';
import {
  concedeThreadView,
  patchThreadInRows,
  replyDraftKey,
  replyThreadView,
  resolveThreadView,
} from './postedReviewsState';

function thread(overrides: Partial<PostedThreadView> = {}): PostedThreadView {
  return {
    threadId: 'thread-1',
    title: 'Refresh token logged in error path',
    severity: 'major',
    file: 'src/auth/token.ts',
    line: 63,
    status: 'replied',
    yourBody: 'This logs the refresh token in cleartext.',
    replies: [
      { author: 'dana', body: 'Pushed a fix — can you re-check?', at: '2026-08-20T11:00:00.000Z', yours: false },
    ],
    ...overrides,
  };
}

function view(repoId: string, crNumber: string, threads: PostedThreadView[]): PostedReviewView {
  const counts = { you: 0, author: 0, closed: 0 };
  for (const t of threads) {
    if (t.status === 'resolved' || t.status === 'conceded') counts.closed += 1;
    else if (t.status === 'replied' || t.status === 'stale') counts.you += 1;
    else counts.author += 1;
  }
  return { repoId, crNumber, agentLabel: 'Verdict · Demo Review', submittedAt: '2026-08-20T10:00:00.000Z', threads, counts };
}

function row(repoId: string, crNumber: string, threads: PostedThreadView[]): PostedRow {
  return { view: view(repoId, crNumber, threads), refLabel: `!${crNumber}`, title: 'Add rate limiting', project: 'core', age: '2d', archived: false };
}

describe('replyDraftKey — scoped to the review, not just the thread id', () => {
  it('produces different keys for the same thread id on different change requests', () => {
    expect(replyDraftKey('9101', '2841', 't1')).not.toBe(replyDraftKey('9101', '2842', 't1'));
    expect(replyDraftKey('9101', '2841', 't1')).not.toBe(replyDraftKey('9102', '2841', 't1'));
  });

  it('is stable for the same review and thread', () => {
    expect(replyDraftKey('9101', '2841', 't1')).toBe(replyDraftKey('9101', '2841', 't1'));
  });
});

describe('patchThreadInRows — the fix for 7.4: patch, do not refetch', () => {
  it('replaces only the matching thread on the matching row, leaving every other row untouched by reference', () => {
    const untouchedRow = row('9101', '9999', [thread({ threadId: 'other-thread' })]);
    const rows: PostedRow[] = [row('9101', '2841', [thread()]), untouchedRow];

    const patched = patchThreadInRows(rows, '9101', '2841', 'thread-1', (t) => ({ ...t, status: 'resolved', closedBy: 'resolved by @you' }));

    expect(patched[1]).toBe(untouchedRow);
    expect(patched[0]?.view.threads[0]?.status).toBe('resolved');
  });

  it('leaves every other thread on the SAME row untouched — a resolve on one thread must not disturb a sibling', () => {
    const untouchedThread = thread({ threadId: 'thread-2', status: 'awaiting', replies: [] });
    const rows: PostedRow[] = [row('9101', '2841', [thread(), untouchedThread])];

    const patched = patchThreadInRows(rows, '9101', '2841', 'thread-1', (t) => ({ ...t, status: 'resolved', closedBy: 'resolved by @you' }));

    expect(patched[0]?.view.threads[1]).toBe(untouchedThread);
  });

  it('recomputes the row counts from the patched thread set, so the badge and breakdown stay in lockstep', () => {
    const rows: PostedRow[] = [row('9101', '2841', [thread({ status: 'replied' })])];
    expect(rows[0]?.view.counts).toEqual({ you: 1, author: 0, closed: 0 });

    const patched = patchThreadInRows(rows, '9101', '2841', 'thread-1', concedeThreadView);
    expect(patched[0]?.view.counts).toEqual({ you: 0, author: 0, closed: 1 });
  });

  it('is a no-op when the repoId/crNumber does not match any row — never guesses at a different review', () => {
    const rows: PostedRow[] = [row('9101', '2841', [thread()])];
    const patched = patchThreadInRows(rows, '9101', 'wrong-cr', 'thread-1', concedeThreadView);
    expect(patched).toEqual(rows);
    expect(patched[0]).toBe(rows[0]);
  });
});

describe('resolveThreadView — after "Resolve thread" / "Re-open thread" (task 7.4)', () => {
  it('resolving sets status resolved and names the resolver, matching toThreadView\'s label shape', () => {
    const patched = resolveThreadView(thread({ status: 'replied' }), true, 'kai');
    expect(patched.status).toBe('resolved');
    expect(patched.closedBy).toBe('resolved by @kai');
  });

  it('reopening a thread whose last note is the author\'s recomputes "replied"', () => {
    const patched = resolveThreadView(
      thread({ status: 'resolved', closedBy: 'resolved by @you', replies: [{ author: 'dana', body: 'reopened concern', at: '2026-08-20T12:00:00.000Z', yours: false }] }),
      false,
      'you',
    );
    expect(patched.status).toBe('replied');
    expect(patched.closedBy).toBeUndefined();
  });

  it('reopening a thread with no replies at all (only the posted comment) recomputes "awaiting" — the posted comment is yours', () => {
    const patched = resolveThreadView(thread({ status: 'resolved', replies: [] }), false, 'you');
    expect(patched.status).toBe('awaiting');
  });

  it('reopening a thread whose last note is your own recomputes "awaiting"', () => {
    const patched = resolveThreadView(
      thread({ status: 'resolved', replies: [{ author: 'you', body: 'still stands', at: '2026-08-20T12:00:00.000Z', yours: true }] }),
      false,
      'you',
    );
    expect(patched.status).toBe('awaiting');
  });
});

describe('concedeThreadView — after "Concede — they\'re right" (task 7.4)', () => {
  it('mirrors the status and label a real fetch (toThreadView) would assign', () => {
    const patched = concedeThreadView(thread({ status: 'replied' }));
    expect(patched.status).toBe('conceded');
    expect(patched.closedBy).toBe('conceded — they were right');
  });
});

describe('replyThreadView — after a reply posts successfully (task 7.4)', () => {
  it('appends the note as yours and puts the thread back to "awaiting author"', () => {
    const patched = replyThreadView(thread({ status: 'replied', replies: [] }), 'you', 'Still a concern.', '2026-08-22T09:00:00.000Z');
    expect(patched.replies).toHaveLength(1);
    expect(patched.replies[0]).toEqual({ author: 'you', body: 'Still a concern.', at: '2026-08-22T09:00:00.000Z', yours: true });
    expect(patched.status).toBe('awaiting');
  });

  it('appends without disturbing earlier replies, in order', () => {
    const original = thread({ replies: [{ author: 'dana', body: 'first', at: 't1', yours: false }] });
    const patched = replyThreadView(original, 'you', 'second', 't2');
    expect(patched.replies.map((r) => r.body)).toEqual(['first', 'second']);
    // The original is not mutated — a caller holding the old reference still
    // sees the pre-reply state.
    expect(original.replies).toHaveLength(1);
  });

  it('keeps "stale" — a reply cannot restore an anchor the platform dropped, and deriveThreadStatus checks that first', () => {
    const patched = replyThreadView(thread({ status: 'stale' }), 'you', 'Reposting since the anchor moved.', 't3');
    expect(patched.status).toBe('stale');
  });
});
