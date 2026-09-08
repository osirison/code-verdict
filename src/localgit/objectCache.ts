/**
 * The object cache's layout on disk, and the two files that keep two processes
 * out of each other's way — tasks 7.1, 7.2, 7.6, 7.7, 7.8 and 7.13 of
 * `add-local-git-investigation`, design D3.
 *
 * Nothing in this module runs git. It owns directories, a metadata sidecar, a
 * lock and a set of leases; `objectAcquisition.ts` is what fetches into the
 * repository these paths describe. Splitting it that way keeps the answer to
 * "could this touch the reviewer's own repository?" readable: every path this
 * file produces is composed from the cache root and a hex digest, and there is
 * no input that reaches it from a model, a change request or a forge.
 *
 * ## The layout
 *
 *     <globalStorage>/object-cache/
 *       <64 hex>/                      one repository identity
 *         repository.git/              the bare store (cacheRepository.ts owns what is inside it)
 *         entry.json                   identity, last use, measured size (task 7.2)
 *         acquire.lock                 held only while acquiring (task 7.6)
 *         leases/<digest>.json         one per running attempt (task 7.7)
 *
 * The lock, the leases and the metadata sit *beside* the git directory rather
 * than inside it, and that is not tidiness. `cacheRepository.ts` discards a
 * store that is not exactly what `git init --bare` left — anything we wrote into
 * `$GIT_DIR` ourselves would have to be added to that allowlist, which is the
 * check's whole value — and a discard is a recursive delete, which would take
 * the lock protecting the discard with it.
 *
 * ## Why whole directories are the only unit
 *
 * Design D3: "Whole directories only — never individual objects, which would
 * leave a repository that answers some requests and not others." Task 7.13 is
 * the test of it. Deleting one pack to reclaim bytes is how a cache ends up
 * holding a change's base and not its head, and the review that follows reports
 * a file as unreadable that is sitting on the forge in plain text — the exact
 * shape of failure this change exists to remove.
 */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, type Dirent } from 'node:fs';
import { join } from 'node:path';
import type { LocalGitPolicy } from './localGitPolicy';

/** The plain identity of one repository, as the host knows it. Never a path, never a URL to fetch from. */
export interface RepositoryIdentity {
  readonly providerId: string;
  readonly instanceUrl: string;
  readonly repoId: string;
}

const CACHE_DIRECTORY = 'object-cache';
const REPOSITORY_DIRECTORY = 'repository.git';
const METADATA_FILE = 'entry.json';
const LOCK_FILE = 'acquire.lock';
const LEASE_DIRECTORY = 'leases';
/** Bumped only if the meaning of a field changes; an entry written by a newer format is not ours to read. */
const METADATA_FORMAT = 1;
/** How often a waiter re-tries the lock. Short enough that a released lock is picked up promptly, long enough not to spin. */
const LOCK_POLL_MS = 25;

/** `<root>/object-cache`, so the host and this module cannot disagree about where the cache is. */
export function objectCacheRoot(globalStorageDirectory: string): string {
  return join(globalStorageDirectory, CACHE_DIRECTORY);
}

/**
 * The directory name for one repository identity: the hex SHA-256 of the three
 * values that identify it (design D3, task 7.1).
 *
 * Length-prefixed before hashing rather than joined with a separator. A
 * separator needs an assumption about what the three values can contain — that
 * no `repoId` holds the separator byte — and a `repoId` is whatever a forge
 * calls a repository. Two identities hashing to one directory would mean two
 * repositories sharing an object store and a review reading the wrong code, so
 * the encoding is injective by construction instead of by assumption.
 *
 * Hex of a digest rather than the identity itself because a `repoId` contains
 * the separators a path cannot (`owner/repo`), differs only by case on some
 * forges and not others, and is unbounded; hex is path-safe, case-stable and
 * fixed-length on every filesystem.
 */
export function cacheEntryName(identity: RepositoryIdentity): string {
  const parts = [identity.providerId, identity.instanceUrl, identity.repoId];
  const encoded = parts.map((part) => `${String(Buffer.byteLength(part, 'utf8'))}:${part}`).join('');
  return createHash('sha256').update(encoded, 'utf8').digest('hex');
}

export interface CacheEntryPaths {
  readonly directory: string;
  readonly gitDir: string;
  readonly metadataPath: string;
  readonly lockPath: string;
  readonly leaseDirectory: string;
}

export function cacheEntryPaths(root: string, identity: RepositoryIdentity): CacheEntryPaths {
  return entryPathsAt(join(root, cacheEntryName(identity)));
}

function entryPathsAt(directory: string): CacheEntryPaths {
  return {
    directory,
    gitDir: join(directory, REPOSITORY_DIRECTORY),
    metadataPath: join(directory, METADATA_FILE),
    lockPath: join(directory, LOCK_FILE),
    leaseDirectory: join(directory, LEASE_DIRECTORY),
  };
}

// ---- The metadata sidecar (task 7.2) ---------------------------------------------

/**
 * What one entry is, in plain terms, for diagnostics and for eviction.
 *
 * The identity is recorded in the clear because the directory name is a digest:
 * without this file, a reviewer or a diagnostic looking at the cache sees 64 hex
 * characters and can say nothing about what they are looking at, and eviction's
 * own report could not name what it removed.
 *
 * **No credential is ever written here**, and there is no field that could carry
 * one. The authorization value from an object-source descriptor is a secret that
 * lives in one child process's environment for the length of a fetch (design D7);
 * a cache directory outlives the run.
 */
export interface CacheEntryMetadata {
  readonly format: number;
  readonly identity: RepositoryIdentity;
  /** Wall clock of the last acquisition that used this entry — the key eviction orders by. */
  readonly lastUsedAtMs: number;
  /** The last measured size of the directory. Diagnostics only: eviction measures for itself. */
  readonly sizeBytes: number;
  /** The pinned commits this entry is known to hold, most recent acquisition last. Diagnostics only. */
  readonly commits: readonly string[];
}

export function readCacheEntryMetadata(paths: CacheEntryPaths): CacheEntryMetadata | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.metadataPath, 'utf8'));
  } catch {
    // Absent, or half-written by a process that died mid-rename on a filesystem
    // that does not give us the atomic rename below. Either way it is not a
    // record, and a caller rewrites it rather than trusting a fragment.
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (record.format !== METADATA_FORMAT) return undefined;
  const identity = record.identity;
  if (typeof identity !== 'object' || identity === null) return undefined;
  const { providerId, instanceUrl, repoId } = identity as Record<string, unknown>;
  if (typeof providerId !== 'string' || typeof instanceUrl !== 'string' || typeof repoId !== 'string') return undefined;
  const commits = Array.isArray(record.commits) ? record.commits.filter((value): value is string => typeof value === 'string') : [];
  return {
    format: METADATA_FORMAT,
    identity: { providerId, instanceUrl, repoId },
    lastUsedAtMs: typeof record.lastUsedAtMs === 'number' && Number.isFinite(record.lastUsedAtMs) ? record.lastUsedAtMs : 0,
    sizeBytes: typeof record.sizeBytes === 'number' && Number.isFinite(record.sizeBytes) ? record.sizeBytes : 0,
    commits,
  };
}

/**
 * Replace the metadata file, atomically where the filesystem allows it.
 *
 * Written to a sibling and renamed rather than written in place: a crash during
 * a plain write leaves a truncated JSON file, and a truncated file would make
 * eviction read `lastUsedAtMs` as absent and evict an entry that was in daily
 * use. The rename makes the observable states "the old record" and "the new
 * record" with nothing in between.
 */
export function writeCacheEntryMetadata(paths: CacheEntryPaths, metadata: Omit<CacheEntryMetadata, 'format'>): void {
  const temporary = `${paths.metadataPath}.${String(process.pid)}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ format: METADATA_FORMAT, ...metadata }, undefined, 2)}\n`, 'utf8');
    renameSync(temporary, paths.metadataPath);
  } catch {
    try {
      rmSync(temporary, { force: true });
    } catch {
      // The temporary file is the only thing that could be left behind, and the
      // next write replaces it. A cache that cannot record its own metadata is
      // reported by the acquisition that tried, not by throwing from here.
    }
  }
}

// ---- The acquisition lock (task 7.6) ---------------------------------------------

interface LockRecord {
  readonly token: string;
  readonly pid: number;
  readonly acquiredAtMs: number;
}

export interface CacheLock {
  /** Releases the lock, and only the lock this call took. Safe to call twice. */
  release(): void;
}

export type CacheLockResult = { readonly ok: true; readonly lock: CacheLock } | { readonly ok: false; readonly reason: 'busy' | 'unwritable' };

/**
 * Whether a process id still names a running process on this machine.
 *
 * Signal `0` performs the permission and existence checks without delivering
 * anything. `ESRCH` is the only answer that means "gone": `EPERM` means the
 * process exists and belongs to somebody else, which is still a live holder.
 *
 * This is the whole of crash recovery's fast path. Without it, a lock left by a
 * process that was killed would be waited out by every run for `lockStaleMs`,
 * and the first review after a crash would fail on a bounded wait rather than
 * proceed. A reused process id is the failure mode in the other direction, and
 * it is the safe one: we wait out the staleness bound instead of stealing a lock
 * that might be live.
 *
 * Meaningful because the cache is in this machine's own storage, so the only
 * processes that can hold a lock are processes on this machine.
 */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(lockPath: string): LockRecord | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const record = parsed as Record<string, unknown>;
    if (typeof record.token !== 'string') return undefined;
    return {
      token: record.token,
      pid: typeof record.pid === 'number' ? record.pid : 0,
      acquiredAtMs: typeof record.acquiredAtMs === 'number' ? record.acquiredAtMs : 0,
    };
  } catch {
    return undefined;
  }
}

/** When an unreadable lock file was last written; the beginning of time when it cannot be asked, so that it is judged stale. */
function lockFileAgeAnchor(lockPath: string): number {
  try {
    return lstatSync(lockPath).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Take the entry's acquisition lock, waiting up to `lockWaitMs` for it.
 *
 * `wx` — create-and-fail-if-exists — is the whole mutual exclusion. It is one
 * syscall with `O_EXCL`, so two processes racing to create the file cannot both
 * win, which no read-then-write sequence can promise.
 *
 * **What is serialized, and what deliberately is not.** Reads take no lock at
 * all (design D3): the object database is append-only and content-addressed, and
 * two `git diff`s over the same store cannot disturb each other. This lock
 * exists for two things a second process must not do underneath the first — a
 * fetch of the same commit, which would double the network cost task 7.11
 * measures, and `openCacheRepository`'s discard-and-rebuild, which is a
 * recursive delete of the directory a running fetch is writing into.
 *
 * **A lock is never proceeded past.** A waiter that times out fails; it does not
 * carry on unlocked. The rebuild above is why: an unlocked waiter that decided
 * the store looked wrong would delete it while the holder was fetching into it.
 *
 * **Crash recovery.** A process that is killed leaves its file behind, and a
 * lock file nobody will ever delete is a cache directory nobody can ever use
 * again. Three independent ways out: the holder's process id is not alive
 * (checked first — a killed extension host is recovered from on the next run,
 * not `lockStaleMs` later), the record is older than the longest an honest
 * acquisition can hold it, or — for a file whose record cannot be read at all,
 * which is what a process killed mid-write leaves — the file itself is older
 * than that bound.
 *
 * **Stealing, and the window it leaves.** A stale lock is removed by renaming it
 * to a unique name, so that if two waiters both judge it stale, only one of them
 * renames the file that was there and the other's rename fails — and the `wx`
 * create afterwards is still what decides. The residual race is a holder that
 * releases and a new holder that creates between our read and our rename, whose
 * fresh lock we would then remove. It is left rather than closed because the
 * cost of losing it is bounded and small: two acquisitions fetching the same
 * commit at once, which git itself makes safe — it locks refs and packs
 * individually, and every ref is named after the object it holds, so two writers
 * agree by construction (design D3). Correctness never rested on this file; it
 * is here so the common case fetches once.
 */
export async function acquireCacheLock(
  paths: CacheEntryPaths,
  policy: Pick<LocalGitPolicy, 'lockWaitMs' | 'lockStaleMs'>,
  options: { readonly now?: () => number } = {},
): Promise<CacheLockResult> {
  const now = options.now ?? Date.now;
  const token = createHash('sha256').update(`${String(process.pid)}:${String(now())}:${Math.random().toString(36)}`).digest('hex').slice(0, 32);
  const deadline = now() + policy.lockWaitMs;

  const tryCreate = (): CacheLockResult | undefined => {
    let handle: number;
    try {
      handle = openSync(paths.lockPath, 'wx');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined;
      return { ok: false, reason: 'unwritable' };
    }
    try {
      writeFileSync(handle, JSON.stringify({ token, pid: process.pid, acquiredAtMs: now() }));
    } catch {
      // The file exists and is ours but empty. Nobody can read a token out of
      // it, so nobody — including this holder — will ever unlink it by token;
      // what clears it is the age check below, which is why that check does not
      // depend on the record being readable.
    } finally {
      closeSync(handle);
    }
    let released = false;
    return {
      ok: true,
      lock: {
        release: () => {
          if (released) return;
          released = true;
          // Only ever removes *this* lock. A release that unlinked whatever file
          // was there could delete a lock taken by someone else after ours was
          // stolen, and two holders is the one state this file exists to make
          // impossible.
          const current = readLock(paths.lockPath);
          if (current?.token !== token) return;
          try {
            unlinkSync(paths.lockPath);
          } catch {
            // Already gone — the usual cause is eviction having deleted the
            // whole entry directory while holding this very lock.
          }
        },
      },
    };
  };

  for (;;) {
    const created = tryCreate();
    if (created) return created;

    const current = readLock(paths.lockPath);
    // A lock nobody can read is the crash this file is most exposed to: a
    // process killed between creating the file and writing its record leaves
    // one with no process id and no timestamp in it, and a rule that only
    // judged records it could parse would leave that entry locked for good.
    // The filesystem's own modification time is the fact that is there for
    // every file, readable or not, so it is what decides this case.
    const stale =
      current === undefined ? now() - lockFileAgeAnchor(paths.lockPath) > policy.lockStaleMs : !isProcessAlive(current.pid) || now() - current.acquiredAtMs > policy.lockStaleMs;
    if (stale) {
      const stolen = `${paths.lockPath}.${token.slice(0, 8)}.stale`;
      try {
        renameSync(paths.lockPath, stolen);
        rmSync(stolen, { force: true });
      } catch {
        // Another waiter got there first; fall through and compete for the
        // create like any other waiter.
      }
      const afterSteal = tryCreate();
      if (afterSteal) return afterSteal;
    }

    if (now() >= deadline) return { ok: false, reason: 'busy' };
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

// ---- Attempt leases (task 7.7) ---------------------------------------------------

interface LeaseRecord {
  readonly attemptId: string;
  readonly pid: number;
  readonly refreshedAtMs: number;
}

export interface CacheLease {
  readonly path: string;
  /** Called as the attempt runs, so a long review does not age out of its own lease. */
  refresh(): void;
  release(): void;
}

/**
 * The lease file's name is a digest of the attempt id, never the id itself.
 *
 * An attempt id is a value from the run store, not from a model, so this is not
 * a filter on hostile input — it is a filter on the day some caller composes an
 * id containing a path separator and the lease lands somewhere nobody meant. The
 * id itself is recorded inside the file, where it can be read for diagnostics
 * without ever having been part of a path.
 */
function leaseFileName(attemptId: string): string {
  return `${createHash('sha256').update(attemptId, 'utf8').digest('hex').slice(0, 32)}.json`;
}

/**
 * Hold this entry against eviction for the length of one attempt (task 7.7).
 *
 * A lease is a claim, not a lock: several attempts hold one at once, they do not
 * exclude each other, and eviction is the only reader. Refreshing is what keeps
 * it live — an attempt that runs longer than `leaseStaleMs` without refreshing
 * is, by the harness's own bound, not running any more.
 */
export function takeCacheLease(
  paths: CacheEntryPaths,
  attemptId: string,
  options: { readonly now?: () => number } = {},
): CacheLease | undefined {
  const now = options.now ?? Date.now;
  const path = join(paths.leaseDirectory, leaseFileName(attemptId));
  const write = (): void => {
    writeFileSync(path, JSON.stringify({ attemptId, pid: process.pid, refreshedAtMs: now() }));
  };
  try {
    mkdirSync(paths.leaseDirectory, { recursive: true });
    write();
  } catch {
    // A lease that cannot be written is reported by the caller as a cache that
    // cannot be written to (task 7.12), not swallowed here: without one, an
    // attempt could be evicted out from under itself mid-review.
    return undefined;
  }
  return {
    path,
    refresh: () => {
      try {
        write();
      } catch {
        // The entry was evicted, or the disk filled. Refreshing is best-effort
        // by nature — the attempt's own reads are what fail if its objects went
        // away, and they report that truthfully.
      }
    },
    release: () => {
      try {
        rmSync(path, { force: true });
      } catch {
        // Gone with the directory, or never written.
      }
    },
  };
}

/** How many attempts are holding this entry right now. Stale lease files are removed as they are found. */
export function liveLeaseCount(paths: CacheEntryPaths, policy: Pick<LocalGitPolicy, 'leaseStaleMs'>, options: { readonly now?: () => number } = {}): number {
  const now = options.now ?? Date.now;
  let live = 0;
  let names: string[];
  try {
    names = readdirSync(paths.leaseDirectory);
  } catch {
    return 0;
  }
  for (const name of names) {
    const path = join(paths.leaseDirectory, name);
    let record: LeaseRecord | undefined;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof parsed === 'object' && parsed !== null) {
        const value = parsed as Record<string, unknown>;
        if (typeof value.attemptId === 'string' && typeof value.refreshedAtMs === 'number') {
          record = { attemptId: value.attemptId, pid: typeof value.pid === 'number' ? value.pid : 0, refreshedAtMs: value.refreshedAtMs };
        }
      }
    } catch {
      record = undefined;
    }
    // The same two questions the lock asks, for the same reason: an attempt
    // whose process is gone is not running, whatever its file says, and a
    // review cannot outlive the harness's own maximum attempt time.
    const expired = record === undefined || now() - record.refreshedAtMs > policy.leaseStaleMs || !isProcessAlive(record.pid);
    if (!expired) {
      live += 1;
      continue;
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // Leaving it costs nothing: it is already judged stale and will be judged
      // stale again next time.
    }
  }
  return live;
}

// ---- Eviction (tasks 7.8, 7.13) --------------------------------------------------

/**
 * Bytes under a directory, without following a single symbolic link.
 *
 * `lstat`, and links are counted as their own small selves rather than
 * descended into. A symlink planted in the cache pointing at the reviewer's
 * repository would otherwise make this walk read that directory — and design
 * D3's promise is that nothing here reads the reviewer's repository for any
 * purpose, measurement included. `rmSync` removes a link rather than what it
 * points at, so the same planted link cannot turn eviction into a delete of
 * somebody else's files either.
 */
export function directorySizeBytes(directory: string): number {
  let total = 0;
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    let stats;
    try {
      stats = lstatSync(path);
    } catch {
      continue;
    }
    if (stats.isSymbolicLink()) {
      total += stats.size;
      continue;
    }
    if (stats.isDirectory()) {
      total += directorySizeBytes(path);
      continue;
    }
    total += stats.size;
  }
  return total;
}

export interface EvictionCandidate {
  readonly paths: CacheEntryPaths;
  readonly metadata: CacheEntryMetadata;
  readonly sizeBytes: number;
}

export interface EvictionOutcome {
  readonly scanned: number;
  /** Entry directory names removed, in the order they were removed. */
  readonly evicted: readonly string[];
  /**
   * Entries eviction wanted to remove and did not: an attempt was holding a
   * lease, another process was acquiring into it, or the delete itself failed.
   * All three leave the cache over its bound, which is the honest outcome — a
   * byte bound is a budget, and the alternative is deleting the objects a
   * running review is reading.
   */
  readonly kept: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/** A directory in the cache root that this extension wrote: a digest-shaped name and a metadata record of ours. */
const ENTRY_NAME = /^[0-9a-f]{64}$/;

function listEntries(root: string): EvictionCandidate[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const candidates: EvictionCandidate[] = [];
  for (const name of names) {
    // Two independent facts before anything here will delete a directory: its
    // name is one this module could have produced, and it carries a metadata
    // record in our format. A directory that fails either is somebody else's
    // and is left exactly as it is — the same rule `cacheRepository.ts` applies
    // with its marker file, and for the same reason: eviction's primitive is a
    // recursive delete.
    if (!ENTRY_NAME.test(name)) continue;
    const paths = entryPathsAt(join(root, name));
    const metadata = readCacheEntryMetadata(paths);
    if (!metadata) continue;
    candidates.push({ paths, metadata, sizeBytes: directorySizeBytes(paths.directory) });
  }
  return candidates;
}

/**
 * Delete one whole entry, if nothing is using it.
 *
 * The entry's own lock is taken first, without waiting: an entry another process
 * is acquiring into is skipped rather than deleted underneath it, and a
 * lease-check-then-delete without the lock is a race — the lease arrives between
 * the check and the `rm`. Leases are re-read after the lock is held, so an
 * attempt that started while we were deciding is still seen.
 *
 * The metadata goes first and the directory second, so that a delete interrupted
 * between them can never leave a record claiming an entry holds commits whose
 * objects have gone. What is left in that case is a directory with no record;
 * `prepareCacheEntry` writes it a fresh one the next time that repository is
 * used, and `openCacheRepository` rebuilds whatever is left of the store. The
 * cost is a refetch, and never a store answering for some of its pinned commits
 * and not the others.
 */
async function evictEntry(candidate: EvictionCandidate, policy: LocalGitPolicy, now: () => number): Promise<boolean> {
  const locked = await acquireCacheLock(candidate.paths, { lockWaitMs: 0, lockStaleMs: policy.lockStaleMs }, { now });
  if (!locked.ok) return false;
  try {
    if (liveLeaseCount(candidate.paths, policy, { now }) > 0) return false;
    try {
      rmSync(candidate.paths.metadataPath, { force: true });
      rmSync(candidate.paths.directory, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  } finally {
    locked.lock.release();
  }
}

/**
 * Bring the cache back inside its bounds (task 7.8).
 *
 * Two bounds, both from policy. An entry nobody has used for
 * `entryIdleLifetimeMs` goes whether or not the cache is over its byte bound —
 * a repository reviewed once a year should not be kept because there happens to
 * be room. Then, while the total is over `cacheMaxBytes`, whole entries go in
 * least-recently-used order.
 *
 * An entry an attempt holds a lease on is never evicted, and if every remaining
 * entry is leased the cache is left over its bound. That is the honest outcome:
 * the alternative is deleting the objects a running review is reading, and a
 * byte bound is a budget, not a guarantee.
 */
export async function evictObjectCache(
  root: string,
  policy: LocalGitPolicy,
  options: { readonly now?: () => number } = {},
): Promise<EvictionOutcome> {
  const now = options.now ?? Date.now;
  const candidates = listEntries(root);
  const bytesBefore = candidates.reduce((total, entry) => total + entry.sizeBytes, 0);
  const evicted: string[] = [];
  let kept = 0;
  let total = bytesBefore;

  const remove = async (candidate: EvictionCandidate): Promise<void> => {
    if (await evictEntry(candidate, policy, now)) {
      evicted.push(candidate.paths.directory);
      total -= candidate.sizeBytes;
      return;
    }
    kept += 1;
  };

  const remaining: EvictionCandidate[] = [];
  for (const candidate of candidates) {
    if (now() - candidate.metadata.lastUsedAtMs > policy.entryIdleLifetimeMs) {
      await remove(candidate);
      continue;
    }
    remaining.push(candidate);
  }

  remaining.sort((left, right) => left.metadata.lastUsedAtMs - right.metadata.lastUsedAtMs);
  for (const candidate of remaining) {
    if (total <= policy.cacheMaxBytes) break;
    await remove(candidate);
  }

  return { scanned: candidates.length, evicted, kept, bytesBefore, bytesAfter: total };
}

/**
 * Create the directories one entry needs, and say so plainly when the location
 * cannot be written (task 7.12).
 *
 * Nothing is written anywhere else when this fails. There is no second location
 * to fall back to — a cache somewhere the extension does not own is the thing
 * design D3 refuses — so the answer is that the source is unavailable for this
 * repository, with the reason, and selection moves to the provider.
 *
 * **The record is written here, before anything is fetched, and not only when an
 * acquisition succeeds.** Eviction acts on a directory only when it carries a
 * record of ours, so a directory created without one would be invisible to it
 * forever: an acquisition that creates the store and then fails — a remote that
 * refuses the commit, a fetch that times out — would leave a repository nothing
 * ever measures and nothing ever removes. Writing it up front makes "a directory
 * we created" and "a directory eviction can see" the same set. A record that is
 * already there is left alone, because it carries the last-used time.
 */
export function prepareCacheEntry(
  root: string,
  identity: RepositoryIdentity,
  options: { readonly now?: () => number } = {},
): { readonly ok: true; readonly paths: CacheEntryPaths } | { readonly ok: false } {
  const now = options.now ?? Date.now;
  const paths = cacheEntryPaths(root, identity);
  try {
    mkdirSync(paths.leaseDirectory, { recursive: true });
  } catch {
    return { ok: false };
  }
  if (readCacheEntryMetadata(paths) === undefined) {
    writeCacheEntryMetadata(paths, { identity, lastUsedAtMs: now(), sizeBytes: 0, commits: [] });
  }
  return { ok: true, paths };
}

/** Whether a directory under the cache root exists at all — used by tests and diagnostics, never a precondition for writing. */
export function cacheEntryExists(root: string, identity: RepositoryIdentity): boolean {
  return existsSync(cacheEntryPaths(root, identity).directory);
}
