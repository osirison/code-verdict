/**
 * Notification derivation and routing (handoff §11, spec §13) as pure
 * functions over neutral snapshot data. Event detection is a diff of two
 * consecutive polls — the engine holds the snapshots, this module holds
 * the rules. Titles are CR-first ("Review ready · 8 items on !2841"),
 * never brand-first: the source is already obvious from the icon.
 */
import type { ChangeRequest, ChangeRequestRef, CiRun, ReviewThread } from '../platform/types';

export type NotificationEventKey =
  | 'agentFinished'
  | 'replyPosted'
  | 'authorPushed'
  | 'pipelineFailed'
  | 'reviewRequested'
  | 'mentioned'
  | 'threadStale';

export type NotificationMode = 'Interrupt' | 'Badge' | 'Digest' | 'Off';

export type DigestCadence = 'Hourly' | 'Twice a day' | 'End of day';

export interface NotificationEventDef {
  key: NotificationEventKey;
  label: string;
  hint: string;
  /** Spec §11 default delivery mode. */
  defaultMode: NotificationMode;
}

/**
 * The seven events, in the order the settings screen lists them. package.json
 * must contribute `codeVerdict.notifications.events.<key>` with exactly these
 * defaults — enforced by commands.test.ts, the same way the 21 commands are.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDef[] = [
  { key: 'agentFinished', label: 'Agent finished a review', hint: 'Review results are ready to triage.', defaultMode: 'Interrupt' },
  { key: 'replyPosted', label: 'Reply on a comment you posted', hint: 'An author replied to your review.', defaultMode: 'Interrupt' },
  { key: 'authorPushed', label: 'Author pushed a fix', hint: 'The code changed after review.', defaultMode: 'Badge' },
  { key: 'pipelineFailed', label: 'CI run failed', hint: 'A watched CI run needs attention.', defaultMode: 'Digest' },
  { key: 'reviewRequested', label: 'Review requested from you', hint: 'A change request is waiting on you.', defaultMode: 'Interrupt' },
  { key: 'mentioned', label: 'You were mentioned', hint: 'A discussion mentioned your username.', defaultMode: 'Badge' },
  { key: 'threadStale', label: 'A posted thread went stale', hint: 'New commits moved a reviewed line.', defaultMode: 'Digest' },
];

export const NOTIFICATION_MODES: readonly NotificationMode[] = ['Interrupt', 'Badge', 'Digest', 'Off'];

export const DIGEST_CADENCES: readonly DigestCadence[] = ['Hourly', 'Twice a day', 'End of day'];

export interface NotificationPrefs {
  modes: Partial<Record<NotificationEventKey, NotificationMode>>;
  quietMode: boolean;
  digestCadence: DigestCadence;
}

/** Handoff §11 default window — a fixed span until quiet hours grow settings. */
export const QUIET_HOURS = { startHour: 18, endHour: 9 } as const;

/**
 * Events that keep their configured mode during quiet hours: "demote
 * everything except blockers and direct mentions" (handoff §11) — pipeline
 * failures are the blocker-class event, mentions are the direct ones.
 */
const QUIET_EXEMPT: ReadonlySet<NotificationEventKey> = new Set(['pipelineFailed', 'mentioned']);

export function isQuietHour(hour: number): boolean {
  // The window spans midnight: 18:00 through 08:59.
  return hour >= QUIET_HOURS.startHour || hour < QUIET_HOURS.endHour;
}

export function defaultMode(key: NotificationEventKey): NotificationMode {
  return NOTIFICATION_EVENTS.find((event) => event.key === key)?.defaultMode ?? 'Off';
}

/**
 * The delivery mode an event actually gets right now: the configured
 * per-event mode, with Interrupt demoted to Badge inside quiet hours for
 * everything but the exempt events. Badge/Digest/Off are never promoted
 * or demoted.
 */
export function routeNotification(
  key: NotificationEventKey,
  prefs: NotificationPrefs,
  hour: number,
): NotificationMode {
  const mode = prefs.modes[key] ?? defaultMode(key);
  if (mode === 'Interrupt' && prefs.quietMode && isQuietHour(hour) && !QUIET_EXEMPT.has(key)) {
    return 'Badge';
  }
  return mode;
}

/**
 * When the digest queue flushes. The spec fixes the cadences but not the
 * clock times, so: Hourly — the top of the next hour; Twice a day — the
 * next of 09:00 / 17:00; End of day — the next 17:00.
 */
export function nextDigestFlush(cadence: DigestCadence, now: Date): Date {
  const at = (base: Date, hour: number, dayOffset = 0): Date =>
    new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
  if (cadence === 'Hourly') {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours() + 1, 0, 0, 0);
  }
  const hours = cadence === 'Twice a day' ? [9, 17] : [17];
  for (const hour of hours) {
    const candidate = at(now, hour);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  return at(now, hours[0] ?? 17, 1);
}

/** One deliverable notification, however it was detected. */
export interface VerdictNotification {
  key: NotificationEventKey;
  /** CR-first title, e.g. "Review ready · 8 items on !2841" (spec §13). */
  title: string;
  /** The rich toast's 11.5px detail line / the quick-pick description. */
  detail?: string;
  /** Jump target for review-shaped events. */
  crRef?: ChangeRequestRef;
  /** Jump target when there is no review surface (pipelines). */
  webUrl?: string;
}

/** What one poll of a pod sees — the engine diffs consecutive ones. */
export interface NotificationSnapshot {
  /** Epoch ms of the poll — gates notes on threads the diff has never seen. */
  fetchedAt: number;
  changeRequests: ChangeRequest[];
  ciRuns: CiRun[];
  /** Threads of this pod's submitted reviews — all `listThreads` reaches. */
  threads: ReviewThread[];
}

export interface DeriveContext {
  /** The signed-in username — their own notes never notify. */
  you?: string;
  /** `${repoId}!${number}` keys of CRs this user has submitted reviews on. */
  submittedRefs: ReadonlySet<string>;
  /** Provider vocabulary — "!2841" on GitLab, "#123" elsewhere. */
  formatRef(number: string): string;
  /** Provider vocabulary — "pipeline" on GitLab, "check" on GitHub. */
  ciNoun?: string;
}

const refKey = (ref: ChangeRequestRef): string => `${ref.repoId}!${ref.number}`;

/**
 * A word-bounded, case-insensitive `@you` — `mail@you.com` and `@youssef`
 * are not mentions of `you`; `@You` is (platforms match handles
 * case-insensitively).
 */
function mentions(body: string, you: string): boolean {
  const escaped = you.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w-])@${escaped}(?=$|[^\\w-])`, 'i').test(body);
}

const excerpt = (body: string): string =>
  body.length > 90 ? `${body.slice(0, 87)}…` : body;

/**
 * Every polled event, derived from two consecutive snapshots. Only
 * transitions notify — a pipeline that was already red or a thread that was
 * already stale in `prev` stays silent, and the caller must not pass a
 * first poll here (a fresh baseline emits nothing, or startup would toast
 * the whole backlog).
 */
export function deriveEvents(
  prev: NotificationSnapshot,
  next: NotificationSnapshot,
  ctx: DeriveContext,
): VerdictNotification[] {
  return [
    ...deriveChangeRequestEvents(prev.changeRequests, next.changeRequests, ctx),
    ...deriveCiEvents(prev.ciRuns, next.ciRuns, ctx.ciNoun ?? 'CI run'),
    ...deriveThreadEvents(prev.threads, next.threads, ctx, prev.fetchedAt),
  ];
}

function deriveChangeRequestEvents(
  prev: ChangeRequest[],
  next: ChangeRequest[],
  ctx: DeriveContext,
): VerdictNotification[] {
  const events: VerdictNotification[] = [];
  const before = new Map(prev.map((cr) => [refKey(cr.ref), cr]));
  for (const cr of next) {
    const was = before.get(refKey(cr.ref));
    const ref = ctx.formatRef(cr.ref.number);
    if (
      ctx.you &&
      cr.author.username !== ctx.you &&
      cr.reviewers.some((r) => r.username === ctx.you) &&
      !was?.reviewers.some((r) => r.username === ctx.you)
    ) {
      events.push({
        key: 'reviewRequested',
        title: `Review requested on ${ref} · @${cr.author.username}`,
        detail: cr.title,
        crRef: cr.ref,
        webUrl: cr.webUrl,
      });
    }
    // "Author pushed a fix" is scoped to CRs that carry a posted review —
    // mid-triage pushes already have their own staleness banner.
    if (was && was.headSha !== cr.headSha && ctx.submittedRefs.has(refKey(cr.ref))) {
      events.push({
        key: 'authorPushed',
        title: `Author pushed to ${ref} · after your review`,
        detail: cr.title,
        crRef: cr.ref,
        webUrl: cr.webUrl,
      });
    }
  }
  return events;
}

function deriveCiEvents(prev: CiRun[], next: CiRun[], ciNoun: string): VerdictNotification[] {
  const before = new Map(prev.map((run) => [run.id, run]));
  const noun = ciNoun.charAt(0).toUpperCase() + ciNoun.slice(1);
  return next
    .filter((run) => run.status === 'failed' && before.get(run.id)?.status !== 'failed')
    .map((run) => ({
      key: 'pipelineFailed' as const,
      title: `${noun} #${run.id} failed${run.failedJobName ? ` · ${run.failedJobName}` : ''}`,
      detail: run.ref,
      webUrl: run.webUrl,
    }));
}

function deriveThreadEvents(
  prev: ReviewThread[],
  next: ReviewThread[],
  ctx: DeriveContext,
  sinceMs: number,
): VerdictNotification[] {
  const events: VerdictNotification[] = [];
  const before = new Map(prev.map((thread) => [thread.id, thread]));
  for (const thread of next) {
    const was = before.get(thread.id);
    const ref = ctx.formatRef(thread.crRef.number);
    if (was && was.anchorPresent && !thread.anchorPresent) {
      events.push({
        key: 'threadStale',
        title: `Thread went stale on ${ref}`,
        detail: thread.filePath ?? 'anchor dropped by new commits',
        crRef: thread.crRef,
      });
    }
    if (!ctx.you) continue;
    // Known threads diff by note id. A thread the diff has never seen gates
    // by note time instead — its backlog predates us, and treating it as
    // all-new would flood interrupts (e.g. right after a dropped
    // `listThreads` poll re-fills the snapshot).
    const seen = new Set(was?.notes.map((note) => note.id));
    const fresh = thread.notes.filter(
      (note) =>
        note.author.username !== ctx.you &&
        (was ? !seen.has(note.id) : Date.parse(note.createdAt) > sinceMs),
    );
    const yours = thread.notes[0]?.author.username === ctx.you;
    for (const note of fresh) {
      // A reply that also @-mentions is one human event, not two — the
      // more specific replyPosted wins on your own threads.
      if (yours) {
        events.push({
          key: 'replyPosted',
          title: `Reply on ${ref} · @${note.author.username}`,
          detail: excerpt(note.body),
          crRef: thread.crRef,
        });
      } else if (mentions(note.body, ctx.you)) {
        events.push({
          key: 'mentioned',
          title: `Mentioned on ${ref} · @${note.author.username}`,
          detail: excerpt(note.body),
          crRef: thread.crRef,
        });
      }
    }
  }
  return events;
}
