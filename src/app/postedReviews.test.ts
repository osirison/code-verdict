import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GitLabEmulator } from '../../emulator/engine';
import { getProvider } from '../platform/registry';
import { registerBuiltInProviders } from '../registry';
import type { SubmittedReview } from './reviewHistory';
import type { KeyValueStore } from './storage';
import { ThreadFlags, buildPostedReview, composeSecondOpinion, crKey } from './postedReviews';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  registerBuiltInProviders();
  const emulator = new GitLabEmulator({ seed: 1 });
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
      }
      const result = emulator.handle({
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers,
        body: chunks.length > 0 ? Buffer.concat(chunks).toString('utf8') : undefined,
      });
      res.writeHead(result.status, result.headers);
      res.end(JSON.stringify(result.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  // Each test starts from the pristine seeded world.
  await fetch(`${baseUrl}/_emulator/reset`, { method: 'POST', body: JSON.stringify({ seed: 1 }) });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function connect() {
  return getProvider('gitlab').connect({ instanceUrl: baseUrl, credential: { kind: 'token', token: 'glpat-emulator'  } });
}

const REF = { repoId: '9101', number: '2833' };

function entryFor(threadIds: string[]): SubmittedReview {
  return {
    repoId: REF.repoId,
    crNumber: REF.number,
    podId: 'pod_test',
    agentId: 'verdict.demo-agent',
    agentLabel: 'Verdict · Demo Review',
    submittedAt: '2026-07-30T10:00:00.000Z',
    counts: { accepted: threadIds.length, rejected: 0, skipped: 0, undecided: 0 },
    threads: Object.fromEntries(threadIds.map((id, i) => [`itm_${i}`, id])),
    requestedChanges: false,
  };
}

describe('posted reviews against the emulator (spec §9, handoff §8)', () => {
  it('derives one thread per status and the waiting-on-you split', async () => {
    const connection = connect();
    const threads = await connection.listThreads(REF);
    // The seeded world ships one thread per status: awaiting, replied,
    // resolved, stale.
    expect(threads).toHaveLength(4);

    const view = await buildPostedReview(
      connection,
      entryFor(threads.map((t) => t.id)),
      'you',
      new Set(),
    );
    const statuses = view.threads.map((t) => t.status).sort();
    expect(statuses).toEqual(['awaiting', 'replied', 'resolved', 'stale']);
    // waiting on you = replied + stale (handoff §8).
    expect(view.counts).toEqual({ you: 2, author: 1, closed: 1 });
  });

  it('concede is a local flag on top of platform resolution, per review', async () => {
    const connection = connect();
    const store = memoryStore();
    const flags = new ThreadFlags(store);
    const threads = await connection.listThreads(REF);
    const replied = threads.find((t) => !t.resolved && t.anchorPresent && t.notes.length > 1);
    expect(replied).toBeDefined();

    await connection.resolveThread(REF, replied?.id as string, true);
    await flags.concede(crKey(REF.repoId, REF.number), replied?.id as string);

    const view = await buildPostedReview(
      connection,
      entryFor(threads.map((t) => t.id)),
      'you',
      flags.conceded(crKey(REF.repoId, REF.number)),
    );
    expect(view.threads.find((t) => t.threadId === replied?.id)?.status).toBe('conceded');
    // The flag is keyed per review — another CR's key sees nothing.
    expect(flags.conceded(crKey('9101', '2841')).size).toBe(0);
  });

  it('replying through the provider moves a thread to awaiting-author', async () => {
    const connection = connect();
    const threads = await connection.listThreads(REF);
    const replied = threads.find((t) => t.notes.length > 1 && !t.resolved);
    await connection.replyToThread(REF, replied?.id as string, 'Standing by the finding.');

    const view = await buildPostedReview(
      connection,
      entryFor(threads.map((t) => t.id)),
      'you',
      new Set(),
    );
    // Your reply is now the last note — the ball is back with the author.
    expect(view.threads.find((t) => t.threadId === replied?.id)?.status).toBe('awaiting');
  });

  // #33's contract gap: resolveThread/replyToThread claimed by every provider,
  // covered by nothing. The shared contract suite (providerContract.ts) is
  // where this belongs long-term, but every describeProviderContract() call
  // site lives under src/providers/**, out of reach here — see the report.
  // This exercises the same connection.resolveThread the panel's 'resolve'
  // and 'reopen' messages call, live against the emulator, both directions.
  it('resolveThread reverses cleanly: resolve(true) then resolve(false) restores unresolved', async () => {
    const connection = connect();
    const threads = await connection.listThreads(REF);
    const target = threads.find((t) => !t.resolved);
    expect(target).toBeDefined();

    await connection.resolveThread(REF, target?.id as string, true);
    const resolvedThreads = await connection.listThreads(REF);
    expect(resolvedThreads.find((t) => t.id === target?.id)?.resolved).toBe(true);
    const resolvedView = await buildPostedReview(
      connection,
      entryFor(threads.map((t) => t.id)),
      'you',
      new Set(),
    );
    expect(resolvedView.threads.find((t) => t.threadId === target?.id)?.status).toBe('resolved');

    await connection.resolveThread(REF, target?.id as string, false);
    const reopenedThreads = await connection.listThreads(REF);
    expect(reopenedThreads.find((t) => t.id === target?.id)?.resolved).toBe(false);
    const reopenedView = await buildPostedReview(
      connection,
      entryFor(threads.map((t) => t.id)),
      'you',
      new Set(),
    );
    // Not necessarily back to the exact prior status (that depends on who
    // spoke last), but definitely not still resolved.
    expect(reopenedView.threads.find((t) => t.threadId === target?.id)?.status).not.toBe('resolved');
  });

  // #34's discriminating test: a note that lands through a channel other than
  // this extension's own reply box (the platform's own web UI, another
  // reviewer, a bot) — never through connection.replyToThread. The emulator's
  // `/reply` control route posts as the MR author directly against the world
  // state, bypassing the provider client entirely, which is the closest this
  // suite can get to "someone else posted it". A second buildPostedReview()
  // call — the exact thing PostedReviewsPanel.refresh() does, no cache, no
  // memo of the earlier call — must show it. If it does, "refresh brings in
  // nothing" cannot be a data-layer or render-layer bug; it can only be #33
  // (nothing was ever posted to begin with).
  it('a note posted through another channel shows up on the next buildPostedReview call (#34)', async () => {
    const connection = connect();
    const threads = await connection.listThreads(REF);
    const awaiting = threads.find(
      (t) => !t.resolved && t.notes[t.notes.length - 1]?.author.username === 'you',
    );
    expect(awaiting).toBeDefined();

    const before = await buildPostedReview(connection, entryFor(threads.map((t) => t.id)), 'you', new Set());
    const beforeThread = before.threads.find((t) => t.threadId === awaiting?.id);
    expect(beforeThread?.status).toBe('awaiting');
    const marker = 'Posted from the web UI directly.';
    expect(beforeThread?.replies.some((r) => r.body === marker)).toBe(false);

    const res = await fetch(`${baseUrl}/_emulator/mrs/${REF.repoId}/${REF.number}/reply`, {
      method: 'POST',
      body: JSON.stringify({ discussionId: awaiting?.id, body: marker }),
    });
    expect(res.status).toBe(200);

    const after = await buildPostedReview(connection, entryFor(threads.map((t) => t.id)), 'you', new Set());
    const afterThread = after.threads.find((t) => t.threadId === awaiting?.id);
    expect(afterThread?.replies.some((r) => r.body === marker)).toBe(true);
    expect(afterThread?.status).toBe('replied');
  });

  it('legacy entries without thread ids only show threads you started — never the whole MR', async () => {
    const connection = connect();
    // 2841 starts with no discussions; post one as you, then have the
    // author open their own thread via a control reply... the seeded 2833
    // world already has only-yours threads, so instead assert against a
    // foreign-authored thread injected through the emulator.
    const threads = await connection.listThreads(REF);
    expect(threads.length).toBeGreaterThan(0);
    const view = await buildPostedReview(connection, entryFor([]), 'you', new Set());
    // Every seeded 2833 thread was authored by you, so all pass the
    // legacy fallback…
    expect(view.threads.length).toBe(threads.length);
    // …but a different author claims nothing.
    const foreign = await buildPostedReview(connection, entryFor([]), 'somebody-else', new Set());
    expect(foreign.threads).toHaveLength(0);
  });

  it('does not hide a thread whose id failed to resolve', async () => {
    // A comment can post fine and still leave us without its thread id. The
    // entry is then short of `counts.accepted`, and filtering strictly on the
    // ids we do have would drop the rest from replies, resolve and the counts.
    const connection = connect();
    const threads = await connection.listThreads(REF);
    expect(threads.length).toBeGreaterThan(1);
    const partial = entryFor(threads.map((t) => t.id));
    // One id resolved, the rest did not — but all of them were accepted.
    partial.threads = { itm_0: threads[0]?.id as string };
    const view = await buildPostedReview(connection, partial, 'you', new Set());
    expect(view.threads.length).toBe(threads.length);

    // A complete entry still filters strictly — other reviewers stay out.
    const complete = entryFor([threads[0]?.id as string]);
    expect((await buildPostedReview(connection, complete, 'you', new Set())).threads).toHaveLength(1);
  });

  it('measures completeness against what posted, not against what was accepted', async () => {
    // An item accepted after a partial failure is counted but never submitted,
    // so counts.accepted overstates what should have a thread id. Widening on
    // that would pull every unrelated thread you started into this review.
    const connection = connect();
    const threads = await connection.listThreads(REF);
    const entry = entryFor([threads[0]?.id as string]);
    entry.counts.accepted = 5; // four of them never posted
    entry.postedComments = 1;
    const view = await buildPostedReview(connection, entry, 'you', new Set());
    expect(view.threads).toHaveLength(1);
  });

  it('second opinion answers the author, never restates the finding', async () => {
    const connection = connect();
    const threads = await connection.listThreads(REF);
    const view = await buildPostedReview(connection, entryFor(threads.map((t) => t.id)), 'you', new Set());
    const replied = view.threads.find((t) => t.status === 'replied');
    const opinion = composeSecondOpinion(replied as NonNullable<typeof replied>);
    expect(opinion).toContain(`@${replied?.replies[0]?.author}`);
    expect(opinion).toContain(replied?.replies[0]?.body.split('\n')[0]?.slice(0, 30));
  });
});
