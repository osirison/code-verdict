import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { setVerdict } from '../domain/reviewState';
import type { Pod, Review } from '../domain/types';
import type { Connection, ConnectionIntent } from '../platform/provider';
import { registerProvider, clearProviders } from '../platform/registry';
import type { ScmProvider } from '../platform/provider';
import type { ChangeRequest } from '../platform/types';
import { AppStore } from './appStore';
import { PodStore } from './pods';
import { draftKeyFor, retainedFromRun } from './retainedReview';
import type { ReviewHistory } from './reviewHistory';
import type { KeyValueStore, SecretStore } from './storage';

function memoryStore(): KeyValueStore {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => map.get(key) as T | undefined,
    update: async (key, value) => {
      map.set(key, value);
    },
  };
}

function podOf(id: string, repoIds: string[] = ['r1']): Pod {
  return {
    id,
    name: `Pod ${id}`,
    providerId: 'github',
    instanceUrl: 'https://github.example',
    sources: repoIds.map((repoId) => ({ kind: 'repository' as const, repoId })),
    criteria: DEFAULT_CRITERIA,
    agentId: '',
  };
}

function cr(number: string, over: Partial<ChangeRequest> = {}): ChangeRequest {
  return {
    ref: { repoId: 'r1', number },
    title: `CR ${number}`,
    state: 'open',
    sourceBranch: 'feat',
    targetBranch: 'main',
    author: { username: 'ana' },
    reviewers: [],
    webUrl: `https://github.example/cr/${number}`,
    updatedAt: '2026-09-01T00:00:00Z',
    headSha: 'abc',
    ...over,
  };
}

/** A fetch held open until the test releases it. */
function gate(): { promise: Promise<void>; open(): void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/**
 * The fake connection counts what the store spends: connections built (one
 * per flight, with the declared intent) and list calls issued. `gate` holds
 * every list call open so tests can observe the in-flight window.
 */
interface World {
  intents: Array<ConnectionIntent | undefined>;
  connections: number;
  listCalls: number;
  crs: ChangeRequest[];
  failWith?: Error;
  gate?: Promise<void>;
}

function makeWorld(): World {
  return { intents: [], connections: 0, listCalls: 0, crs: [cr('1')] };
}

function connectionFactory(world: World) {
  return async (_pod: Pod, opts?: { intent?: ConnectionIntent }): Promise<Connection> => {
    world.connections += 1;
    world.intents.push(opts?.intent);
    if (world.failWith) throw world.failWith;
    return {
      listOpenChangeRequests: async () => {
        world.listCalls += 1;
        if (world.gate) await world.gate;
        return [...world.crs];
      },
      listWorkItems: async () => {
        if (world.gate) await world.gate;
        return [];
      },
      listCiRuns: async () => {
        if (world.gate) await world.gate;
        return [];
      },
    } as unknown as Connection;
  };
}

const T0 = 1_000_000;

interface StoreOptions {
  pods?: Pod[];
  baseSeconds?: number;
  reviews?: Array<{ podId: string; repoId: string; crNumber: string }>;
}

async function storeFor(world: World, opts: StoreOptions = {}) {
  const podStore = new PodStore(memoryStore());
  const pods = opts.pods ?? [podOf('a')];
  for (const pod of pods) await podStore.upsert(pod);
  const clock = { t: T0 };
  const store = new AppStore({
    podStore,
    secrets: {} as unknown as SecretStore,
    reviewHistory: { list: () => opts.reviews ?? [] } as unknown as ReviewHistory,
    baseSeconds: () => opts.baseSeconds ?? 60,
    connectionFor: connectionFactory(world),
    now: () => clock.t,
  });
  return { store, podStore, clock, pods };
}

// One repository costs 4 requests a poll, so at the 60s default base the
// earned interval (12s) is under the base and the window is exactly 60s.
const WINDOW_MS = 60_000;

describe('one fetch is shared by everyone who needs it', () => {
  it('three concurrent reads of one pod issue one fetch', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    const held = gate();
    world.gate = held.promise;

    const r1 = store.read(pods[0]!);
    const r2 = store.read(pods[0]!);
    const r3 = store.read(pods[0]!);
    // Nothing is held yet, so every reader waits — on the same flight.
    expect(r1.data).toBeUndefined();
    expect(r2.fetch).toBe(r1.fetch);
    expect(r3.fetch).toBe(r1.fetch);

    held.open();
    const data = await r1.fetch!;
    expect(data.changeRequests.map((c) => c.ref.number)).toEqual(['1']);
    expect(world.connections).toBe(1);
    expect(world.listCalls).toBe(1);
  });

  it('a read inside the freshness window issues no fetch and no revalidation', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    clock.t += WINDOW_MS - 1;
    const again = store.read(pods[0]!);
    expect(again.data?.changeRequests).toHaveLength(1);
    expect(again.fetch).toBeUndefined();
    expect(world.connections).toBe(1);
  });

  it('a read outside the window returns held data synchronously and fetches behind', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    clock.t += WINDOW_MS;
    world.crs = [cr('1'), cr('2')];
    const read = store.read(pods[0]!);
    // The reviewer sees the held snapshot at once — one CR, not a spinner.
    expect(read.data?.changeRequests).toHaveLength(1);
    expect(read.fetch).toBeDefined();
    await read.fetch;
    expect(world.connections).toBe(2);
    // The waiting first read was interactive; the fetch behind held data is
    // the store's own revalidation and must declare background, or it would
    // spend the reserve the background floor keeps (task 6.3a).
    expect(world.intents).toEqual(['interactive', 'background']);
    expect(store.peek('a')?.changeRequests).toHaveLength(2);
  });

  it('a second stale read joins the revalidation already running', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    clock.t += WINDOW_MS;
    const held = gate();
    world.gate = held.promise;
    const r1 = store.read(pods[0]!);
    const r2 = store.read(pods[0]!);
    expect(r2.fetch).toBe(r1.fetch);
    held.open();
    await r1.fetch;
    expect(world.connections).toBe(2);
  });
});

describe('the freshness window is the pod\'s own poll interval (D2)', () => {
  it('scales with the submitted-review fan-out, counting only this pod\'s still-open reviews', async () => {
    const world = makeWorld();
    // 20 open CRs, each with a submitted review: fan-out 4 + 20 = 24 requests,
    // an earned interval of 72s. The 5 reviews below that belong to another
    // pod or to a CR no longer open cost no thread query, so counting them
    // (87s) or using a fixed 60s constant would both fail the probes below.
    world.crs = Array.from({ length: 20 }, (_, i) => cr(String(i + 1)));
    const reviews = [
      ...Array.from({ length: 20 }, (_, i) => ({ podId: 'a', repoId: 'r1', crNumber: String(i + 1) })),
      ...Array.from({ length: 3 }, (_, i) => ({ podId: 'other', repoId: 'r1', crNumber: String(i + 1) })),
      { podId: 'a', repoId: 'r1', crNumber: '900' },
      { podId: 'a', repoId: 'r2', crNumber: '1' },
    ];
    const { store, pods, clock } = await storeFor(world, { reviews });
    await store.read(pods[0]!).fetch;

    clock.t += 72_000 - 1;
    expect(store.read(pods[0]!).fetch).toBeUndefined();
    clock.t += 2;
    expect(store.read(pods[0]!).fetch).toBeDefined();
  });

  it('respects the injected base setting as the floor', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world, { baseSeconds: 120 });
    await store.read(pods[0]!).fetch;

    clock.t += 120_000 - 1;
    expect(store.read(pods[0]!).fetch).toBeUndefined();
    clock.t += 2;
    expect(store.read(pods[0]!).fetch).toBeDefined();
  });
});

describe('data that has not changed notifies nobody (D4)', () => {
  it('a revalidation returning equivalent data notifies no subscriber', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    const listener = vi.fn();
    store.subscribe(listener);

    clock.t += WINDOW_MS;
    // The same snapshot in a hostile shape: keys inserted in a different
    // order, an optional field present-but-undefined. A JSON.stringify
    // comparison would call this a change; structural equality must not.
    world.crs = [
      {
        draft: undefined,
        headSha: 'abc',
        updatedAt: '2026-09-01T00:00:00Z',
        webUrl: 'https://github.example/cr/1',
        reviewers: [],
        author: { username: 'ana' },
        targetBranch: 'main',
        sourceBranch: 'feat',
        state: 'open',
        title: 'CR 1',
        ref: { number: '1', repoId: 'r1' },
      },
    ];
    await store.read(pods[0]!).fetch;
    expect(listener).not.toHaveBeenCalled();

    // The fetch still happened, so freshness reset: an equivalent result
    // that failed to install would leave every later read stale forever.
    clock.t += WINDOW_MS - 1;
    expect(store.read(pods[0]!).fetch).toBeUndefined();
    expect(world.connections).toBe(2);
  });

  it('a revalidation returning changed data notifies every subscriber', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    const first = vi.fn();
    const second = vi.fn();
    store.subscribe(first);
    store.subscribe(second);

    clock.t += WINDOW_MS;
    world.crs = [cr('1'), cr('2')];
    await store.read(pods[0]!).fetch;
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(first.mock.calls[0]?.[0].changeRequests).toHaveLength(2);
  });

  it('an unsubscribed listener hears nothing more', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    const listener = vi.fn();
    store.subscribe(listener).dispose();

    clock.t += WINDOW_MS;
    world.crs = [cr('1'), cr('2')];
    await store.read(pods[0]!).fetch;
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('a failed fetch is survivable', () => {
  it('a failed revalidation leaves held data intact and reports the failure', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    const listener = vi.fn();
    store.subscribe(listener);

    clock.t += WINDOW_MS;
    world.failWith = new Error('rate limited');
    const read = store.read(pods[0]!);
    expect(read.data?.changeRequests).toHaveLength(1);
    await expect(read.fetch).rejects.toThrow('rate limited');
    // What was on screen stays on screen; nobody repaints over it.
    expect(store.peek('a')?.changeRequests).toHaveLength(1);
    expect(listener).not.toHaveBeenCalled();

    // The rejected flight must not stay in the slot: the next read retries
    // instead of being handed the same dead promise.
    world.failWith = undefined;
    world.crs = [cr('1'), cr('2')];
    const retry = store.read(pods[0]!);
    expect(retry.fetch).toBeDefined();
    await retry.fetch;
    expect(world.connections).toBe(3);
    expect(store.peek('a')?.changeRequests).toHaveLength(2);
  });

  it('a failed first fetch does not poison later readers', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    world.failWith = new Error('offline');
    const first = store.read(pods[0]!);
    await expect(first.fetch).rejects.toThrow('offline');

    world.failWith = undefined;
    const second = store.read(pods[0]!);
    expect(second.fetch).not.toBe(first.fetch);
    const data = await second.fetch!;
    expect(data.changeRequests).toHaveLength(1);
    expect(world.connections).toBe(2);
  });
});

describe('coalescing stays within an intent (D3)', () => {
  it('the store\'s revalidation declares itself background so the provider can hold a reserve', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    // This fetch runs for a poll nobody is standing in front of. It must not
    // be what spends the last requests before the user opens a review.
    await store.revalidate(pods[0]!);
    expect(world.intents).toEqual(['background']);
  });

  it('an interactive read starts its own fetch rather than joining a background one', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    const held = gate();
    world.gate = held.promise;

    const tick = store.revalidate(pods[0]!);
    // Joining would charge this read at the background floor — refused at 50
    // remaining where an interactive fetch is served down to 5.
    const read = store.read(pods[0]!);
    expect(read.fetch).not.toBe(tick);
    held.open();
    await Promise.all([tick, read.fetch]);
    expect(world.connections).toBe(2);
    expect(world.intents).toEqual(['background', 'interactive']);
    expect(store.peek('a')).toBeDefined();
  });

  it('a background tick joins an interactive fetch — that one is free', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    const held = gate();
    world.gate = held.promise;

    const read = store.read(pods[0]!);
    const tick = store.revalidate(pods[0]!);
    expect(tick).toBe(read.fetch);
    held.open();
    await tick;
    expect(world.connections).toBe(1);
    expect(world.intents).toEqual(['interactive']);
  });

  it('two background ticks share one flight', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    const held = gate();
    world.gate = held.promise;

    const t1 = store.revalidate(pods[0]!);
    const t2 = store.revalidate(pods[0]!);
    expect(t2).toBe(t1);
    held.open();
    await t1;
    expect(world.connections).toBe(1);
  });

  it('a revalidation inside the freshness window returns held data without a fetch', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    clock.t += 10_000;
    const data = await store.revalidate(pods[0]!);
    expect(data).toBe(store.peek('a'));
    expect(world.connections).toBe(1);
  });
});

describe('held data never carries a stale pod', () => {
  it('a read inside the freshness window reflects a pod renamed since the fetch', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    // A rename, or a username filled in after the first connection. Nothing
    // is re-fetched, and view builders read data.pod.* for both.
    const renamed = { ...pods[0]!, name: 'Renamed', username: 'someone' };
    clock.t += WINDOW_MS - 1;

    const read = store.read(renamed);
    expect(read.fetch).toBeUndefined();
    expect(world.connections).toBe(1);
    expect(read.data?.pod.name).toBe('Renamed');
    expect(read.data?.pod.username).toBe('someone');
  });

  it('revalidate on fresh held data reflects the rename too', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;

    const renamed = { ...pods[0]!, name: 'Renamed' };
    clock.t += WINDOW_MS - 1;
    const data = await store.revalidate(renamed);

    expect(world.connections).toBe(1);
    expect(data.pod.name).toBe('Renamed');
  });

  it('overlaying the pod does not disturb what change detection compares', async () => {
    const world = makeWorld();
    const { store, pods, clock } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    // Subscribed after the first fetch: that one legitimately notifies, and
    // what is under test is everything after it.
    const seen: number[] = [];
    store.subscribe((data) => seen.push(data.changeRequests.length));

    // A renamed pod whose platform data is unchanged must still notify
    // nobody — the pod is configuration, not part of the snapshot compared.
    store.read({ ...pods[0]!, name: 'Renamed' });
    clock.t += WINDOW_MS;
    await store.revalidate({ ...pods[0]!, name: 'Renamed' });

    expect(seen).toHaveLength(0);
  });
});

describe('entries are pod-keyed and bounded to PodStore (task 5.5)', () => {
  it('switching pods does not serve the previous pod\'s data', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world, { pods: [podOf('a'), podOf('b', ['r2'])] });
    await store.read(pods[0]!).fetch;

    const read = store.read(pods[1]!);
    // Pod b has never been fetched: pod a's data must not stand in for it.
    expect(read.data).toBeUndefined();
    const data = await read.fetch!;
    expect(data.pod.id).toBe('b');
    expect(store.peek('a')?.pod.id).toBe('a');
    expect(store.peek('b')?.pod.id).toBe('b');
    expect(world.connections).toBe(2);
  });

  it('forget() drops an entry on demand, for a pod id that will be reused', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    expect(store.peek('a')).toBeDefined();

    store.forget('a');
    expect(store.peek('a')).toBeUndefined();
  });

  it('a removed pod\'s entry is dropped', async () => {
    const world = makeWorld();
    const { store, podStore, pods } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    expect(store.peek('a')).toBeDefined();

    await podStore.remove('a');
    // Re-created under the same id, the pod must start empty — held data for
    // a deleted pod is exactly what must never be served.
    expect(store.peek('a')).toBeUndefined();
    const read = store.read(pods[0]!);
    expect(read.data).toBeUndefined();
    await read.fetch;
    expect(world.connections).toBe(2);
  });
});

describe('freshness applies to platform data, not to review results', () => {
  it('forget() drops the pod\'s held platform data but leaves every retained verdict, summary edit and note intact', async () => {
    const world = makeWorld();
    const { store, pods } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    expect(store.peek('a')).toBeDefined();

    // A retained review lives in its own store (workspaceState, keyed by
    // draftKeyFor) — never in AppStore's entries — because it is not platform
    // data (design D1): seeded here the way a finished run and a triage
    // session actually leave one behind — a verdict recorded, the summary
    // edited, and a closing note written.
    const ref = { repoId: 'r1', number: '1' };
    const baseReview: Review = {
      repoId: ref.repoId,
      crNumber: ref.number,
      agentId: 'demo',
      criteria: DEFAULT_CRITERIA,
      headSha: 'abc',
      items: [
        {
          id: 'itm_1',
          anchored: true,
          file: 'src/a.ts',
          line: 1,
          severity: 'major',
          category: 'security',
          confidence: 90,
          title: 'Finding 1',
          body: 'Body',
          code: 'const a = 1;',
        },
      ],
      verdicts: {},
      summary: '',
    };
    const reviewed = setVerdict(baseReview, 'itm_1', 'accepted', false);
    const workspaceState = memoryStore();
    const draft = {
      ...retainedFromRun({ review: reviewed, ranAt: '2026-08-01T00:00:00Z', agentId: 'demo', agentLabel: 'Demo agent' }),
      review: reviewed,
      summaryText: 'Looks fine, one blocker fixed.',
      finalNote: 'Left a note for the author.',
    };
    await workspaceState.update(draftKeyFor(ref), draft);

    // The event under test: held platform data for the pod is dropped.
    store.forget('a');
    expect(store.peek('a')).toBeUndefined();

    // Every field the triage session produced is exactly where it was —
    // nothing here is derived from, or expires with, the platform data that
    // was just cleared.
    const survived = workspaceState.get<typeof draft>(draftKeyFor(ref));
    expect(survived?.review.verdicts['itm_1']?.verdict).toBe('accepted');
    expect(survived?.summaryText).toBe('Looks fine, one blocker fixed.');
    expect(survived?.finalNote).toBe('Left a note for the author.');
  });
});

describe('a stale result arriving late never overwrites a newer one', () => {
  it('a slow background revalidation landing after a forced refresh is discarded', async () => {
    const world = makeWorld();
    const { store, clock, pods } = await storeFor(world);
    await store.read(pods[0]!).fetch;
    clock.t += WINDOW_MS;

    // A stale read starts a background revalidation, held open at the gate.
    const slow = gate();
    world.gate = slow.promise;
    const stale = store.read(pods[0]!);
    expect(stale.data).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The reviewer presses ⟳ before it lands: a newer interactive fetch
    // starts (it must not join the background flight — D3) and completes.
    world.gate = undefined;
    clock.t += 1_000;
    world.crs = [cr('2', { title: 'The newer result' })];
    await store.forceRefresh(pods[0]!);
    expect(store.peek('a')?.changeRequests[0]?.title).toBe('The newer result');

    // Now the slow flight lands, carrying the older snapshot.
    world.crs = [cr('1', { title: 'The stale result' })];
    slow.open();
    await stale.fetch?.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The later result stays; the earlier one is discarded (its start time
    // predates the installed fetch), and a fresh read serves the newer copy
    // without fetching again.
    expect(store.peek('a')?.changeRequests[0]?.title).toBe('The newer result');
    const after = store.read(pods[0]!);
    expect(after.fetch).toBeUndefined();
    expect(after.data?.changeRequests[0]?.title).toBe('The newer result');
  });
});

describe('held state is provider-agnostic', () => {
  it('pods of two providers read the same store the same way, and hold only the neutral shape', async () => {
    const podA = podOf('a');
    const podB = { ...podOf('b', ['r2']), providerId: 'gitlab' };
    const podStore = new PodStore(memoryStore());
    await podStore.upsert(podA);
    await podStore.upsert(podB);
    let connections = 0;
    const store = new AppStore({
      podStore,
      secrets: {} as unknown as SecretStore,
      reviewHistory: { list: () => [] } as unknown as ReviewHistory,
      baseSeconds: () => 60,
      // The factory is the only place a provider is resolved; the store
      // itself never looks at `providerId` (and, per the ESLint boundary in
      // eslint.config.mjs, could not import a concrete provider if it tried).
      connectionFor: async (pod: Pod) => {
        connections += 1;
        return {
          listOpenChangeRequests: async () => [
            cr('1', { title: `Served for ${pod.providerId}` }),
          ],
          listWorkItems: async () => [],
          listCiRuns: async () => [],
        } as unknown as Connection;
      },
      now: () => T0,
    });

    const dataA = await store.read(podA).fetch!;
    const dataB = await store.read(podB).fetch!;

    // Each pod got its own provider's data through the identical read path.
    expect(dataA.changeRequests[0]?.title).toBe('Served for github');
    expect(dataB.changeRequests[0]?.title).toBe('Served for gitlab');
    // Both are served from held state under the same freshness rules.
    expect(store.read(podA).fetch).toBeUndefined();
    expect(store.read(podB).fetch).toBeUndefined();
    expect(connections).toBe(2);
    // What is held is exactly the neutral PodData shape — no provider field
    // beyond the pod's own configuration reaches the held state.
    for (const held of [store.peek('a')!, store.peek('b')!]) {
      expect(Object.keys(held).sort()).toEqual(['changeRequests', 'ciRuns', 'fetchedAt', 'pod', 'workItems']);
    }
  });

  it('adding a provider needs no change here: a store built with no injected connectionFor serves it through connectionForPod → the registry', async () => {
    // The test above fakes `connectionFor` itself, which proves the store
    // never branches on `providerId` but not that the store needs no change
    // to serve a provider it did not exist alongside. This one takes the
    // store's real, unmodified default path: `deps.connectionFor` is left
    // unset, so the store falls back to `connectionForPod(pod, secrets,
    // opts)`, which resolves the provider from the registry at read time —
    // the same thing registering a provider after activation and then
    // switching a pod to it does in the real extension.
    const NEW_PROVIDER = {
      id: 'gap5-fixture',
      displayName: 'Gap 5 Fixture',
      authModesFor: () => ['none'],
      connect: () =>
        ({
          listOpenChangeRequests: async () => [cr('1', { title: 'Served by a provider the store was never built against' })],
          listWorkItems: async () => [],
          listCiRuns: async () => [],
        }) as unknown as Connection,
    } as unknown as ScmProvider;
    registerProvider(NEW_PROVIDER);
    try {
      const podStore = new PodStore(memoryStore());
      const podOnNewProvider = { ...podOf('c'), providerId: 'gap5-fixture' };
      await podStore.upsert(podOnNewProvider);
      const store = new AppStore({
        podStore,
        secrets: {} as unknown as SecretStore,
        reviewHistory: { list: () => [] } as unknown as ReviewHistory,
        baseSeconds: () => 60,
        now: () => T0,
      });
      const listener = vi.fn();
      store.subscribe(listener);

      const data = await store.read(podOnNewProvider).fetch!;

      expect(data.changeRequests[0]?.title).toBe('Served by a provider the store was never built against');
      expect(listener).toHaveBeenCalledTimes(1);
      // Served through the unchanged read/subscribe path, same as any other
      // provider: a fresh read costs nothing and starts nothing.
      expect(store.read(podOnNewProvider).fetch).toBeUndefined();
    } finally {
      clearProviders();
    }
  });
});
