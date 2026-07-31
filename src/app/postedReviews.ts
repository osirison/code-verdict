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
  replies: Array<{ author: string; body: string; at: string }>;
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
    replies: thread.notes
      .slice(1)
      .filter((n) => n.author.username !== you)
      .map((n) => ({ author: n.author.username, body: n.body, at: n.createdAt })),
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
  const threads = (await connection.listThreads(ref))
    // Only threads this review posted. Legacy entries without thread ids
    // fall back to "threads you started" — never the whole MR's
    // discussions, which would include other reviewers' threads.
    .filter((t) =>
      ourThreadIds.size > 0 ? ourThreadIds.has(t.id) : t.notes[0]?.author.username === you,
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
  const reply = view.replies[view.replies.length - 1];
  if (!reply) return 'No author reply to answer yet — the finding stands as posted.';
  const claim = firstLine(reply.body);
  return (
    `On "@${reply.author}: ${claim}" — the concern does not remove the risk. ` +
    `The flagged line${view.file ? ` (${view.file}:${view.line ?? '?'})` : ''} still behaves as reported in the environments the review covers; ` +
    `if the mitigation the author describes is guaranteed, it belongs in code or configuration where this thread can point at it. ` +
    `Until then the recommendation stands.`
  );
}
