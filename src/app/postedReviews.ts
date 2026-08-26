/**
 * Posted-review tracking (spec §9, handoff §8): join the local review
 * history with the platform's live discussions, derive per-thread status,
 * and keep the local-only flags (conceded) keyed per review — never shared
 * between reviews.
 */
import type { Connection } from '../platform/provider';
import type { ReviewThread } from '../platform/types';
import type { Severity } from '../domain/types';
import type { ThreadStatus } from '../domain/threadStatus';
import { deriveThreadStatus, isWaitingOnYou } from '../domain/threadStatus';
import type { SubmittedReview } from './reviewHistory';
import type { KeyValueStore } from './storage';

export interface PostedThreadView {
  threadId: string;
  itemId?: string;
  title: string;
  severity?: Severity;
  file?: string;
  line?: number;
  status: ThreadStatus;
  yourBody: string;
  /**
   * Every note after the posted comment, in order, whoever wrote it. `yours`
   * tags the ones you wrote rather than dropping them: filtering them out
   * here discarded your own replies before the renderer could show them, and
   * on a change request you authored yourself every reply is yours, so the
   * thread rendered frozen at the posted comment however much was said.
   */
  replies: Array<{ author: string; body: string; at: string; yours: boolean }>;
  closedBy?: string;
}

export interface PostedReviewView {
  repoId: string;
  crNumber: string;
  agentLabel: string;
  submittedAt: string;
  threads: PostedThreadView[];
  counts: { you: number; author: number; closed: number };
}

export function crKey(repoId: string, crNumber: string): string {
  return `${repoId}!${crNumber}`;
}

/**
 * Local-only thread flags, keyed `<crRef>` → set of thread ids. Thread ids
 * are what the platform returned when this review posted its comments and
 * map 1:1 to item ids through the history entry — equivalent to the
 * handoff's `<crRef>:<itemId>` keying, and directly comparable against the
 * ids reply-polling returns. A provider with unstable thread ids would
 * need a translation layer here (none of the current ones do).
 */
export class ThreadFlags {
  private static readonly KEY = 'codeVerdict.threadFlags';

  constructor(private readonly store: KeyValueStore) {}

  conceded(refKey: string): Set<string> {
    const all = this.store.get<Record<string, string[]>>(ThreadFlags.KEY) ?? {};
    return new Set(all[refKey] ?? []);
  }

  async concede(refKey: string, threadId: string): Promise<void> {
    const all = { ...(this.store.get<Record<string, string[]>>(ThreadFlags.KEY) ?? {}) };
    const set = new Set(all[refKey] ?? []);
    set.add(threadId);
    all[refKey] = [...set];
    await this.store.update(ThreadFlags.KEY, all);
  }

  async unconcede(refKey: string, threadId: string): Promise<void> {
    const all = { ...(this.store.get<Record<string, string[]>>(ThreadFlags.KEY) ?? {}) };
    all[refKey] = (all[refKey] ?? []).filter((id) => id !== threadId);
    await this.store.update(ThreadFlags.KEY, all);
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? text;
  return line.replace(/\*\*/g, '').slice(0, 120);
}

export function toThreadView(
  thread: ReviewThread,
  entry: SubmittedReview,
  you: string,
  conceded: ReadonlySet<string>,
): PostedThreadView {
  const itemId = Object.entries(entry.threads).find(([, tid]) => tid === thread.id)?.[0];
  const item = entry.items?.find((i) => i.id === itemId);
  const first = thread.notes[0];
  const status = deriveThreadStatus(thread, { you, conceded });
  const resolvedNote = thread.notes.find((n) => n.resolved && n.resolvedBy);
  return {
    threadId: thread.id,
    itemId,
    title: item?.title ?? firstLine(first?.body ?? '(comment)'),
    severity: item?.severity,
    file: item?.file ?? thread.filePath,
    line: item?.line ?? thread.line,
    status,
    yourBody: first?.body ?? '',
    // Tagged, never filtered: `threadRow` renders `yourBody` plus one block
    // per reply and nothing else, so a note excluded here reaches no screen
    // at all — fetched, mapped and thrown away. The reader still has to be
    // able to tell the two apart, which is what `yours` is for.
    replies: thread.notes.slice(1).map((n) => ({
      author: n.author.username,
      body: n.body,
      at: n.createdAt,
      yours: n.author.username === you,
    })),
    // The POC shows "fixed in <sha> · @user"; the fixing commit is not
    // derivable from discussions alone, so the closed line names the
    // resolver (conceded threads say so explicitly).
    closedBy:
      status === 'conceded'
        ? 'conceded — they were right'
        : resolvedNote?.resolvedBy
          ? `resolved by @${resolvedNote.resolvedBy.username}`
          : undefined,
  };
}

export async function buildPostedReview(
  connection: Connection,
  entry: SubmittedReview,
  you: string,
  conceded: ReadonlySet<string>,
): Promise<PostedReviewView> {
  const ref = { repoId: entry.repoId, number: entry.crNumber };
  const ourThreadIds = new Set(Object.values(entry.threads));
  // A comment can post fine and still leave us without its thread id, so the
  // stored map can be short of what posted. Filtering strictly on the ids we
  // do have would then hide real threads from replies, resolve and the counts
  // — permanently. Short or empty, widen to "threads you started".
  //
  // Compare against what POSTED, not against `counts.accepted`: an item
  // accepted after a partial failure is counted but never submitted, which
  // would make the entry look permanently short and pull in every unrelated
  // thread you started on this change request. Older records have no such
  // count, so they keep the approximation.
  const expected = entry.postedComments ?? entry.counts.accepted;
  // `size > 0` keeps the legacy shape intact: an entry with no ids at all
  // records accepted: 0 too, and must still reach the fallback.
  const complete = ourThreadIds.size > 0 && ourThreadIds.size >= expected;
  const threads = (await connection.listThreads(ref))
    // Only threads this review posted. Entries with no thread ids at all —
    // legacy records, and submits whose resolution failed outright — fall
    // back to "threads you started", never the whole CR's discussions, which
    // would include other reviewers' threads.
    .filter((t) =>
      ourThreadIds.has(t.id) || (!complete && t.notes[0]?.author.username === you),
    )
    .map((t) => toThreadView(t, entry, you, conceded));

  const counts = { you: 0, author: 0, closed: 0 };
  for (const t of threads) {
    if (t.status === 'resolved' || t.status === 'conceded') counts.closed += 1;
    else if (isWaitingOnYou(t.status)) counts.you += 1;
    else counts.author += 1;
  }
  return {
    repoId: entry.repoId,
    crNumber: entry.crNumber,
    agentLabel: entry.agentLabel,
    submittedAt: entry.submittedAt,
    threads,
    counts,
  };
}

/**
 * A second opinion must answer the author's actual argument, not restate
 * the finding (spec §9).
 */
export function composeSecondOpinion(view: PostedThreadView): string {
  // `replies` carries your own notes now, so the newest one is often yours —
  // and the composed text rebuts whatever it is handed. Answering your own
  // note would have the agent argue against the reviewer it is seconding, so
  // walk back to the last note somebody else wrote. A thread where every
  // reply is yours has no counter-argument on the table yet, which is what
  // the existing fallback already says.
  let reply: PostedThreadView['replies'][number] | undefined;
  for (let i = view.replies.length - 1; i >= 0; i -= 1) {
    const candidate = view.replies[i];
    if (candidate && !candidate.yours) {
      reply = candidate;
      break;
    }
  }
  if (!reply) return 'No author reply to answer yet — the finding stands as posted.';
  const claim = firstLine(reply.body);
  return (
    `On "@${reply.author}: ${claim}" — the concern does not remove the risk. ` +
    `The flagged line${view.file ? ` (${view.file}:${view.line ?? '?'})` : ''} still behaves as reported in the environments the review covers; ` +
    `if the mitigation the author describes is guaranteed, it belongs in code or configuration where this thread can point at it. ` +
    `Until then the recommendation stands.`
  );
}
