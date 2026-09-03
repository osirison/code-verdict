/**
 * One shared, freshness-tracked copy of each pod's platform data (design
 * D1–D4): every screen reads this store instead of fetching its own copy, so
 * two screens needing one pod's data cost one platform fetch, not one each.
 *
 * Stale-while-revalidate, single-flight per pod: a read is served from held
 * data when any is held — immediately, never behind a fetch — and a fetch
 * runs behind it only when that data has outlived the pod's own poll
 * interval (D2). Subscribers hear about a fetch only when it changed
 * something (D4); a poll that found nothing new repaints nothing.
 *
 * No `vscode` import, like the rest of `src/app/` — which is why the poll
 * interval's base arrives as an injected read instead of a configuration
 * lookup, and the clock is injectable the way `ReviewRunManager`'s is.
 */
import type { Connection, ConnectionIntent } from '../platform/provider';
import type { Pod } from '../domain/types';
import { connectionForPod } from './connections';
import { fetchPodData, repoIdsOf } from './podQuery';
import type { PodData } from './podQuery';
import { pollIntervalMs } from './pollSchedule';
import type { PodStore } from './pods';
import type { ReviewHistory } from './reviewHistory';
import type { SecretStore } from './storage';

export interface AppStoreDeps {
  podStore: PodStore;
  secrets: SecretStore;
  reviewHistory: ReviewHistory;
  /**
   * The poll-interval setting, injected as a read so the value is current on
   * every freshness check and this file makes no `vscode` configuration read
   * of its own. `extension.ts` wires it to the existing setting.
   */
  baseSeconds: () => number;
  /**
   * Defaults to `connectionForPod` with the injected secrets — the same
   * builder every fetch call site uses today. Tests inject a factory that
   * counts calls and records intents instead.
   */
  connectionFor?: (pod: Pod, opts?: { intent?: ConnectionIntent }) => Promise<Connection>;
  /** Injectable clock, as in `ReviewRunManager`. */
  now?: () => number;
}

/** What a read hands back. At least one of the two fields is present. */
export interface AppStoreRead {
  /** Held snapshot, absent only when this pod has never been fetched. */
  data?: PodData;
  /**
   * The fetch backing this read: the interactive fetch the caller must await
   * when `data` is absent, or the background revalidation running behind
   * stale data. Absent when the held data is fresh — a fresh read costs
   * nothing and starts nothing.
   */
  fetch?: Promise<PodData>;
}

/**
 * The flight carries its intent because single-flight coalesces within an
 * intent, not across one (D3): the rate floor is fixed when the connection is
 * built, so which floor a joiner is charged at is decided by which flight it
 * joins.
 */
interface Flight {
  intent: ConnectionIntent;
  promise: Promise<PodData>;
}

/**
 * `data` and `fetchedAt` are set together; `fetchedAt` is the start time of
 * the fetch that produced `data`, matching how `fetchPodData` is stamped at
 * its call sites today.
 */
interface Entry {
  data?: PodData;
  fetchedAt?: number;
  inFlight?: Flight;
}

export class AppStore {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(data: PodData) => void>();
  private readonly connectionFor: (
    pod: Pod,
    opts?: { intent?: ConnectionIntent },
  ) => Promise<Connection>;

  constructor(private readonly deps: AppStoreDeps) {
    this.connectionFor = deps.connectionFor ?? ((pod, opts) => connectionForPod(pod, deps.secrets, opts));
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  subscribe(listener: (data: PodData) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Held snapshot without fetching — synchronous, never starts anything. */
  peek(podId: string): PodData | undefined {
    this.prune();
    return this.entries.get(podId)?.data;
  }

  /**
   * The read path (D3), for a caller with a screen behind it. Synchronous on
   * purpose: held data is returned without a microtask so a paint from it can
   * never lose a race with the fetch running behind it.
   */
  read(pod: Pod): AppStoreRead {
    this.prune();
    const entry = this.entryFor(pod.id);
    if (entry.data !== undefined && entry.fetchedAt !== undefined) {
      if (this.now() - entry.fetchedAt < this.freshnessMs(pod, entry.data)) {
        return { data: entry.data };
      }
      // Stale: serve what is held, revalidate behind it. The reader is not
      // waiting on the fetch, so the intent carve-out below does not apply
      // and a flight of either intent is joined rather than doubled.
      const flight = entry.inFlight ?? this.startFlight(pod, entry, 'background');
      return { data: entry.data, fetch: flight.promise };
    }
    // Nothing held: the caller is waiting, so the fetch is interactive. It
    // joins only an interactive flight — joining a background one would
    // charge this read at the background floor and refuse it at 50 remaining
    // where an interactive fetch is served down to 5, spending the reserve
    // that floor exists to keep (D3). The superseded background flight keeps
    // running; its landing still installs, and its cleanup is identity-guarded
    // below so it cannot clear this flight's slot.
    const flight =
      entry.inFlight?.intent === 'interactive'
        ? entry.inFlight
        : this.startFlight(pod, entry, 'interactive');
    return { fetch: flight.promise };
  }

  /**
   * An explicit demand for fresh data — the dashboard's ⟳ button. It ignores
   * the freshness window on purpose.
   *
   * `read()` would serve held data and fetch nothing inside the window, which
   * makes the button do nothing. That exact experience was reported as a bug
   * once already and fixed in #47: a reviewer who presses refresh and sees no
   * change concludes the button is broken, and they are right to. A window
   * that exists to stop *background* work spending the request budget has no
   * business suppressing work a person asked for.
   *
   * It still joins an in-flight interactive fetch, so holding the button down
   * cannot fan out into a request per click.
   */
  forceRefresh(pod: Pod): Promise<PodData> {
    this.prune();
    const entry = this.entryFor(pod.id);
    const flight =
      entry.inFlight?.intent === 'interactive'
        ? entry.inFlight
        : this.startFlight(pod, entry, 'interactive');
    return flight.promise;
  }

  /**
   * The background driver's read (D5): what the notifier's poll calls. Fresh
   * data is returned without a fetch — the freshness window and the poll
   * interval are the same number, so a tick landing just after a screen's
   * fetch would otherwise pay twice for one answer. A flight of either intent
   * is joined: a background tick joining an interactive fetch is free,
   * because that fetch already spends to the lower floor.
   */
  revalidate(pod: Pod): Promise<PodData> {
    this.prune();
    const entry = this.entryFor(pod.id);
    if (entry.inFlight) return entry.inFlight.promise;
    if (
      entry.data !== undefined
      && entry.fetchedAt !== undefined
      && this.now() - entry.fetchedAt < this.freshnessMs(pod, entry.data)
    ) {
      return Promise.resolve(entry.data);
    }
    return this.startFlight(pod, entry, 'background').promise;
  }

  private entryFor(podId: string): Entry {
    let entry = this.entries.get(podId);
    if (!entry) {
      entry = {};
      this.entries.set(podId, entry);
    }
    return entry;
  }

  /**
   * Entries are bounded to the pods in `PodStore` (task 5.5). `PodStore` has
   * no removal event, so the bound is enforced on access: a removed pod's
   * data must not survive to be served to a pod re-created under its id.
   */
  private prune(): void {
    if (this.entries.size === 0) return;
    const live = new Set(this.deps.podStore.list().map((p) => p.id));
    for (const id of [...this.entries.keys()]) {
      if (!live.has(id)) this.entries.delete(id);
    }
  }

  /**
   * The freshness window is the pod's own poll interval (D2): the interval
   * `pollSchedule.ts` derives to keep this pod's fan-out inside the hourly
   * allowance. A fixed constant here would double the request rate for
   * exactly the pods that allowance protects. `submittedReviews` is the
   * notifier's derivation — submitted reviews whose change requests are still
   * open, per the held snapshot — because each costs a thread query per poll.
   */
  private freshnessMs(pod: Pod, held: PodData): number {
    const openRefs = new Set(held.changeRequests.map((cr) => `${cr.ref.repoId}!${cr.ref.number}`));
    const submittedReviews = this.deps.reviewHistory
      .list()
      .filter((review) => review.podId === pod.id && openRefs.has(`${review.repoId}!${review.crNumber}`)).length;
    return pollIntervalMs({
      repoCount: repoIdsOf(pod).length,
      submittedReviews,
      baseSeconds: this.deps.baseSeconds(),
    });
  }

  private startFlight(pod: Pod, entry: Entry, intent: ConnectionIntent): Flight {
    const startedAt = this.now();
    const flight = { intent } as Flight;
    // The slot is taken before the fetch starts: a factory that throws
    // synchronously runs the `finally` below during this call, and the
    // identity guard only clears a slot that was actually claimed — assigned
    // after, a flight already dead on arrival would sit in the slot forever.
    entry.inFlight = flight;
    flight.promise = (async () => {
      try {
        const connection = await this.connectionFor(pod, { intent });
        const data = await fetchPodData(connection, pod, startedAt);
        this.install(entry, data, startedAt);
        return data;
      } finally {
        // Identity-guarded on both paths out. On rejection: the slot must be
        // cleared and the held data kept, or one failed fetch poisons every
        // future reader with the same rejected promise. On success after
        // being superseded: an interactive flight replaced this one in the
        // slot, and clearing that would let the next reader start a
        // duplicate the replacement exists to absorb.
        if (entry.inFlight === flight) entry.inFlight = undefined;
      }
    })();
    // A revalidation behind a stale read is routinely ignored by its caller;
    // its rejection must not surface as an unhandled one. Awaiters that do
    // hold the promise still see the error — `revalidate` rejects so the
    // notifier's rate-limit standdown keeps receiving the `ScmError`.
    flight.promise.catch(() => undefined);
    return flight;
  }

  private install(entry: Entry, data: PodData, startedAt: number): void {
    // A superseded flight can land after the flight that replaced it; an
    // older result must not overwrite a newer one.
    if (entry.fetchedAt !== undefined && startedAt < entry.fetchedAt) return;
    const changed = entry.data === undefined || !snapshotsEqual(entry.data, data);
    // Installed even when equivalent: the fetch happened, so freshness
    // resets. Keeping the old entry would leave `fetchedAt` in the past and
    // every read after the first staleness would fetch forever.
    entry.data = data;
    entry.fetchedAt = startedAt;
    if (!changed) return; // D4: data that has not changed notifies nobody.
    for (const listener of [...this.listeners]) listener(data);
  }
}

/**
 * Change detection (D4) over the neutral shapes only. `fetchedAt` is the one
 * excluded field — it differs on every fetch and the UI never shows it — and
 * `pod` is configuration, not platform data. Everything inside the three
 * lists is compared structurally rather than via `JSON.stringify`, because
 * provider mappers set optional fields conditionally and key insertion order
 * is not part of what "changed" means; and rather than a hand-listed field
 * comparator, because a field added to the neutral types later must be
 * compared by default, not remembered — a missed field here silently
 * suppresses a real update, the risk design.md names.
 */
function snapshotsEqual(held: PodData, next: PodData): boolean {
  return (
    structurallyEqual(held.changeRequests, next.changeRequests)
    && structurallyEqual(held.workItems, next.workItems)
    && structurallyEqual(held.ciRuns, next.ciRuns)
  );
}

function structurallyEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => structurallyEqual(item, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    // A provider that sets an optional field to `undefined` and one that
    // omits it produced the same snapshot.
    return [...keys].every((key) =>
      structurallyEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }
  return false;
}
