import { describe, expect, it } from 'vitest';
import type { ChangeRequest, CiRun, ReviewThread } from '../platform/types';
import {
  NOTIFICATION_EVENTS,
  defaultMode,
  deriveEvents,
  isQuietHour,
  nextDigestFlush,
  routeNotification,
  type DeriveContext,
  type NotificationPrefs,
  type NotificationSnapshot,
} from './notifications';

const prefs = (overrides?: Partial<NotificationPrefs>): NotificationPrefs => ({
  modes: {},
  quietMode: false,
  digestCadence: 'End of day',
  ...overrides,
});

describe('event definitions', () => {
  it('lists the seven events with the spec §11 defaults, in screen order', () => {
    expect(NOTIFICATION_EVENTS.map((e) => [e.key, e.defaultMode])).toEqual([
      ['agentFinished', 'Interrupt'],
      ['replyPosted', 'Interrupt'],
      ['authorPushed', 'Badge'],
      ['pipelineFailed', 'Digest'],
      ['reviewRequested', 'Interrupt'],
      ['mentioned', 'Badge'],
      ['threadStale', 'Digest'],
    ]);
  });
});

describe('routeNotification', () => {
  it('uses the configured mode, falling back to the spec default', () => {
    expect(routeNotification('agentFinished', prefs(), 12)).toBe('Interrupt');
    expect(routeNotification('threadStale', prefs(), 12)).toBe('Digest');
    expect(routeNotification('agentFinished', prefs({ modes: { agentFinished: 'Off' } }), 12)).toBe('Off');
  });

  it('demotes Interrupt to Badge during quiet hours', () => {
    expect(routeNotification('agentFinished', prefs({ quietMode: true }), 22)).toBe('Badge');
    expect(routeNotification('replyPosted', prefs({ quietMode: true }), 8)).toBe('Badge');
  });

  it('keeps blockers and direct mentions at their configured mode in quiet hours', () => {
    const p = prefs({ quietMode: true, modes: { pipelineFailed: 'Interrupt', mentioned: 'Interrupt' } });
    expect(routeNotification('pipelineFailed', p, 22)).toBe('Interrupt');
    expect(routeNotification('mentioned', p, 22)).toBe('Interrupt');
  });

  it('never touches Badge, Digest or Off in quiet hours', () => {
    const p = prefs({ quietMode: true, modes: { agentFinished: 'Digest', authorPushed: 'Badge' } });
    expect(routeNotification('agentFinished', p, 22)).toBe('Digest');
    expect(routeNotification('authorPushed', p, 22)).toBe('Badge');
  });

  it('does not demote outside the window or with quiet mode off', () => {
    expect(routeNotification('agentFinished', prefs({ quietMode: true }), 12)).toBe('Interrupt');
    expect(routeNotification('agentFinished', prefs(), 22)).toBe('Interrupt');
  });
});

describe('isQuietHour', () => {
  it('spans midnight: 18:00 through 08:59', () => {
    expect(isQuietHour(18)).toBe(true);
    expect(isQuietHour(23)).toBe(true);
    expect(isQuietHour(0)).toBe(true);
    expect(isQuietHour(8)).toBe(true);
    expect(isQuietHour(9)).toBe(false);
    expect(isQuietHour(17)).toBe(false);
  });
});

describe('nextDigestFlush', () => {
  const at = (h: number, m = 0): Date => new Date(2026, 7, 7, h, m);

  it('Hourly flushes at the top of the next hour', () => {
    expect(nextDigestFlush('Hourly', at(14, 20))).toEqual(at(15));
    expect(nextDigestFlush('Hourly', at(23, 59)).getTime()).toBe(new Date(2026, 7, 8, 0, 0).getTime());
  });

  it('Twice a day flushes at the next of 09:00 / 17:00', () => {
    expect(nextDigestFlush('Twice a day', at(7))).toEqual(at(9));
    expect(nextDigestFlush('Twice a day', at(12))).toEqual(at(17));
    expect(nextDigestFlush('Twice a day', at(18))).toEqual(new Date(2026, 7, 8, 9, 0));
  });

  it('End of day flushes at the next 17:00', () => {
    expect(nextDigestFlush('End of day', at(9))).toEqual(at(17));
    expect(nextDigestFlush('End of day', at(17))).toEqual(new Date(2026, 7, 8, 17, 0));
  });
});

// ---- deriveEvents ----------------------------------------------------------------

const cr = (overrides?: Partial<ChangeRequest>): ChangeRequest => ({
  ref: { repoId: '9101', number: '2841' },
  title: 'Refresh auth tokens before expiry',
  state: 'open',
  sourceBranch: 'feat/auth-refresh',
  targetBranch: 'main',
  author: { username: 'mira' },
  reviewers: [],
  webUrl: 'https://git.example/mr/2841',
  updatedAt: '2026-08-07T10:00:00Z',
  headSha: 'aaa111',
  ...overrides,
});

const run = (overrides?: Partial<CiRun>): CiRun => ({
  id: '90412',
  repoId: '9101',
  status: 'running',
  failedJobName: undefined,
  ...overrides,
});

const thread = (overrides?: Partial<ReviewThread>): ReviewThread => ({
  id: 'thread-1',
  crRef: { repoId: '9101', number: '2833' },
  notes: [{ id: 'n1', author: { username: 'you' }, body: 'Missing null check.', createdAt: '2026-08-06T10:00:00Z' }],
  resolved: false,
  anchorPresent: true,
  filePath: 'src/token.ts',
  ...overrides,
});

const snapshot = (overrides?: Partial<NotificationSnapshot>): NotificationSnapshot => ({
  changeRequests: [],
  ciRuns: [],
  threads: [],
  ...overrides,
});

const ctx = (overrides?: Partial<DeriveContext>): DeriveContext => ({
  you: 'you',
  submittedRefs: new Set(),
  formatRef: (n) => `!${n}`,
  ...overrides,
});

describe('deriveEvents', () => {
  it('emits reviewRequested when you newly appear as reviewer on another author\'s CR', () => {
    const events = deriveEvents(
      snapshot({ changeRequests: [cr()] }),
      snapshot({ changeRequests: [cr({ reviewers: [{ username: 'you' }] })] }),
      ctx(),
    );
    expect(events).toEqual([
      expect.objectContaining({ key: 'reviewRequested', title: 'Review requested on !2841 · @mira' }),
    ]);
  });

  it('also fires reviewRequested for a CR that is new to the snapshot', () => {
    const events = deriveEvents(
      snapshot(),
      snapshot({ changeRequests: [cr({ reviewers: [{ username: 'you' }] })] }),
      ctx(),
    );
    expect(events.map((e) => e.key)).toEqual(['reviewRequested']);
  });

  it('stays silent for your own CRs and unchanged reviewer lists', () => {
    const mine = cr({ author: { username: 'you' }, reviewers: [{ username: 'you' }] });
    const requested = cr({ reviewers: [{ username: 'you' }] });
    expect(deriveEvents(snapshot(), snapshot({ changeRequests: [mine] }), ctx())).toEqual([]);
    expect(
      deriveEvents(
        snapshot({ changeRequests: [requested] }),
        snapshot({ changeRequests: [requested] }),
        ctx(),
      ),
    ).toEqual([]);
  });

  it('emits authorPushed only for CRs with a submitted review', () => {
    const before = snapshot({ changeRequests: [cr()] });
    const after = snapshot({ changeRequests: [cr({ headSha: 'bbb222' })] });
    expect(deriveEvents(before, after, ctx())).toEqual([]);
    const events = deriveEvents(before, after, ctx({ submittedRefs: new Set(['9101!2841']) }));
    expect(events).toEqual([
      expect.objectContaining({ key: 'authorPushed', title: 'Author pushed to !2841 · after your review' }),
    ]);
  });

  it('emits pipelineFailed on transition to failed, with the spec title shape', () => {
    const events = deriveEvents(
      snapshot({ ciRuns: [run()] }),
      snapshot({ ciRuns: [run({ status: 'failed', failedJobName: 'e2e:chrome' })] }),
      ctx(),
    );
    expect(events).toEqual([
      expect.objectContaining({ key: 'pipelineFailed', title: 'Pipeline #90412 failed · e2e:chrome' }),
    ]);
  });

  it('does not repeat pipelineFailed while the run stays failed', () => {
    const failed = snapshot({ ciRuns: [run({ status: 'failed' })] });
    expect(deriveEvents(failed, failed, ctx())).toEqual([]);
  });

  it('emits replyPosted for a new note by someone else on your thread', () => {
    const before = snapshot({ threads: [thread()] });
    const after = snapshot({
      threads: [
        thread({
          notes: [
            ...thread().notes,
            { id: 'n2', author: { username: 'mira' }, body: 'Fair point — fixing, thanks @you.', createdAt: '2026-08-07T11:00:00Z' },
          ],
        }),
      ],
    });
    const events = deriveEvents(before, after, ctx());
    // The reply @-mentions too; one human event, replyPosted wins.
    expect(events).toEqual([
      expect.objectContaining({ key: 'replyPosted', title: 'Reply on !2833 · @mira' }),
    ]);
  });

  it('emits mentioned for an @-mention on a thread that is not yours', () => {
    const theirs = thread({ id: 't2', notes: [{ id: 'm1', author: { username: 'mira' }, body: 'Opening thread.', createdAt: '2026-08-06T10:00:00Z' }] });
    const after = thread({
      id: 't2',
      notes: [...theirs.notes, { id: 'm2', author: { username: 'ravi' }, body: 'Agree with @you here.', createdAt: '2026-08-07T11:00:00Z' }],
    });
    const events = deriveEvents(snapshot({ threads: [theirs] }), snapshot({ threads: [after] }), ctx());
    expect(events).toEqual([
      expect.objectContaining({ key: 'mentioned', title: 'Mentioned on !2833 · @ravi' }),
    ]);
  });

  it('does not fire mentioned when the @-handle only prefixes a longer name', () => {
    const theirs = thread({ id: 't2', notes: [{ id: 'm1', author: { username: 'mira' }, body: 'Opening.', createdAt: '2026-08-06T10:00:00Z' }] });
    const after = thread({
      id: 't2',
      notes: [...theirs.notes, { id: 'm2', author: { username: 'ravi' }, body: 'cc @youssef', createdAt: '2026-08-07T11:00:00Z' }],
    });
    expect(deriveEvents(snapshot({ threads: [theirs] }), snapshot({ threads: [after] }), ctx())).toEqual([]);
  });

  it('ignores your own notes', () => {
    const before = snapshot({ threads: [thread()] });
    const after = snapshot({
      threads: [
        thread({ notes: [...thread().notes, { id: 'n2', author: { username: 'you' }, body: 'Adding context.', createdAt: '2026-08-07T11:00:00Z' }] }),
      ],
    });
    expect(deriveEvents(before, after, ctx())).toEqual([]);
  });

  it('emits threadStale when the anchor drops, once', () => {
    const before = snapshot({ threads: [thread()] });
    const after = snapshot({ threads: [thread({ anchorPresent: false })] });
    expect(deriveEvents(before, after, ctx())).toEqual([
      expect.objectContaining({ key: 'threadStale', title: 'Thread went stale on !2833', detail: 'src/token.ts' }),
    ]);
    expect(deriveEvents(after, after, ctx())).toEqual([]);
  });
});

describe('defaultMode', () => {
  it('answers Off for unknown keys', () => {
    expect(defaultMode('nonsense' as never)).toBe('Off');
  });
});
