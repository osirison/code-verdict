/**
 * The cache's directories, its lock, its leases and its eviction — tasks 7.1,
 * 7.2, 7.6, 7.7, 7.8, 7.12 and 7.13 of `add-local-git-investigation`.
 *
 * Everything here is a fact about the filesystem, so everything here uses the
 * real one under `os.tmpdir()`. The two cases that would otherwise be untestable
 * are driven by injection rather than by waiting: an injected clock moves a lock
 * past its staleness bound and a lease past the harness's maximum attempt time
 * without a test sleeping for either, and an injected byte bound makes a 2 GiB
 * policy assertable with a few kilobytes of files.
 *
 * The two crash cases are the ones worth reading. A process that is killed
 * leaves its lock file and its lease file behind, and both are recorded with a
 * process id: the tests below write records naming a process that really ran and
 * really exited, so what they assert is the recovery, not a mock of it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCacheRepository } from './cacheRepository';
import { planGitInvocation, runGitInvocation } from './gitInvocation';
import { DEFAULT_LOCAL_GIT_POLICY, normalizeLocalGitPolicy, type LocalGitPolicy } from './localGitPolicy';
import {
  acquireCacheLock,
  cacheEntryName,
  cacheEntryPaths,
  directorySizeBytes,
  evictObjectCache,
  liveLeaseCount,
  objectCacheRoot,
  prepareCacheEntry,
  readCacheEntryMetadata,
  takeCacheLease,
  writeCacheEntryMetadata,
  type RepositoryIdentity,
} from './objectCache';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';

const gitVersion = gitExecutableVersion();

const IDENTITY: RepositoryIdentity = { providerId: 'github', instanceUrl: 'https://api.github.com', repoId: 'osirison/code-verdict' };

/**
 * A process id that named a real process which has really exited.
 *
 * `spawnSync` has waited for the child and Node has reaped it by the time it
 * returns, so this id is as dead as the extension host's id is after a crash —
 * which is the condition the lock and the lease both have to recover from.
 * Inventing a large number would test the same branch through a value no
 * operating system ever issued.
 */
function pidOfAProcessThatHasExited(): number {
  const finished = spawnSync(process.execPath, ['-e', '0']);
  const pid = finished.pid;
  if (pid === undefined) throw new Error('no pid from a process that ran');
  return pid;
}

function policyWith(overrides: Partial<LocalGitPolicy>): LocalGitPolicy {
  return normalizeLocalGitPolicy({ ...DEFAULT_LOCAL_GIT_POLICY, ...overrides });
}

describe('the cache layout (tasks 7.1, 7.2)', () => {
  it('puts the cache under a directory of its own inside the storage it is given', () => {
    expect(objectCacheRoot('/storage')).toBe(join('/storage', 'object-cache'));
  });

  it('names one directory per repository identity, as hex and nothing else', () => {
    const name = cacheEntryName(IDENTITY);
    expect(name).toMatch(/^[0-9a-f]{64}$/);
    expect(cacheEntryName({ ...IDENTITY })).toBe(name);
    expect(cacheEntryName({ ...IDENTITY, providerId: 'gitlab' })).not.toBe(name);
    expect(cacheEntryName({ ...IDENTITY, instanceUrl: 'https://github.example.com/api/v3' })).not.toBe(name);
    expect(cacheEntryName({ ...IDENTITY, repoId: 'osirison/other' })).not.toBe(name);
  });

  it('cannot be made to collide by moving a character across the boundary between two of the three values', () => {
    // The reason the identity is length-prefixed before it is hashed. Joined
    // with a separator, this pair collides for any separator the two values can
    // contain — and two repositories sharing one object store is a review
    // reading another repository's code.
    expect(cacheEntryName({ providerId: 'ab', instanceUrl: 'c', repoId: 'd' })).not.toBe(
      cacheEntryName({ providerId: 'a', instanceUrl: 'bc', repoId: 'd' }),
    );
  });

  it('keeps the lock, the leases and the metadata beside the git directory rather than inside it', () => {
    // `cacheRepository.ts` discards a store carrying anything `git init --bare`
    // did not write, and a discard is a recursive delete — of the directory the
    // lock protecting that discard would have been sitting in.
    const paths = cacheEntryPaths('/cache', IDENTITY);
    expect(paths.gitDir.startsWith(paths.directory)).toBe(true);
    for (const path of [paths.lockPath, paths.metadataPath, paths.leaseDirectory]) {
      expect(path.startsWith(paths.directory)).toBe(true);
      expect(path.startsWith(paths.gitDir)).toBe(false);
    }
  });
});

describe('the cache on disk', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'code-verdict-cache-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** One entry as it would be after an acquisition: a store directory of a known size, and a record. */
  function plantEntry(identity: RepositoryIdentity, options: { readonly lastUsedAtMs: number; readonly bytes: number; readonly commits?: readonly string[] }) {
    const prepared = prepareCacheEntry(root, identity);
    if (!prepared.ok) throw new Error('could not prepare an entry');
    mkdirSync(join(prepared.paths.gitDir, 'objects', 'pack'), { recursive: true });
    writeFileSync(join(prepared.paths.gitDir, 'objects', 'pack', 'objects.pack'), Buffer.alloc(options.bytes));
    writeCacheEntryMetadata(prepared.paths, {
      identity,
      lastUsedAtMs: options.lastUsedAtMs,
      sizeBytes: options.bytes,
      commits: options.commits ?? [],
    });
    return prepared.paths;
  }

  describe('the metadata sidecar (task 7.2)', () => {
    it('records the plain identity, the last use and the measured size, and reads them back', () => {
      const paths = plantEntry(IDENTITY, { lastUsedAtMs: 1_700_000_000_000, bytes: 2048, commits: ['a'.repeat(40)] });
      const metadata = readCacheEntryMetadata(paths);
      expect(metadata?.identity).toEqual(IDENTITY);
      expect(metadata?.lastUsedAtMs).toBe(1_700_000_000_000);
      expect(metadata?.sizeBytes).toBe(2048);
      expect(metadata?.commits).toEqual(['a'.repeat(40)]);
    });

    it('carries no field that could hold a credential', () => {
      const paths = plantEntry(IDENTITY, { lastUsedAtMs: 1, bytes: 16 });
      const written = readFileSync(paths.metadataPath, 'utf8');
      expect(written).not.toMatch(/authorization|token|bearer|password|secret/i);
    });

    it('reads a torn record as no record at all, rather than as an entry last used at the beginning of time', () => {
      const paths = plantEntry(IDENTITY, { lastUsedAtMs: 1_700_000_000_000, bytes: 16 });
      writeFileSync(paths.metadataPath, '{"format":1,"identity":{"providerId":"gith');
      expect(readCacheEntryMetadata(paths)).toBeUndefined();
    });
  });

  describe('the acquisition lock (task 7.6)', () => {
    it('serializes two acquirers: the second gets it only once the first lets go', async () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const first = await acquireCacheLock(paths, policyWith({ lockWaitMs: 1000 }));
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const order: string[] = [];
      const waiter = acquireCacheLock(paths, policyWith({ lockWaitMs: 2000 })).then((result) => {
        order.push('second took it');
        return result;
      });
      order.push('first released');
      first.lock.release();

      const second = await waiter;
      expect(second.ok).toBe(true);
      expect(order).toEqual(['first released', 'second took it']);
      if (second.ok) second.lock.release();
      expect(existsSync(paths.lockPath)).toBe(false);
    });

    it('gives up after its bounded wait rather than carrying on unlocked', async () => {
      // Proceeding without the lock is the dangerous shape: `openCacheRepository`
      // rebuilds a store it does not trust by deleting the directory, and a
      // second acquirer doing that underneath a running fetch destroys it.
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const held = await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }));
      expect(held.ok).toBe(true);

      const denied = await acquireCacheLock(paths, policyWith({ lockWaitMs: 60 }));
      expect(denied).toEqual({ ok: false, reason: 'busy' });
      if (held.ok) held.lock.release();
    });

    it('is bounded by `lockWaitMs` alone: the poll never takes a cancellation token, and does not need one', async () => {
      // The waiting loop sleeps `LOCK_POLL_MS` between attempts through a
      // `setTimeout` that nothing cancels and no caller can interrupt — there is
      // no cancellation token in `AcquisitionRequest` or anywhere on the path
      // that reaches here. That is safe only if the deadline ends the loop on
      // every path, so this pins the deadline itself rather than the absence of
      // a token: the wait lasts at least as long as it was told to, and then
      // stops on its own.
      //
      // Both halves matter. Returning before `lockWaitMs` would mean it never
      // polled at all and the test above passes for the wrong reason; not
      // returning well inside the ceiling would mean something other than the
      // deadline decides when waiting ends, which is the case that would make
      // the uncancellable sleep a real hazard.
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const held = await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }));
      expect(held.ok).toBe(true);

      const startedAt = Date.now();
      const denied = await acquireCacheLock(paths, policyWith({ lockWaitMs: 120 }));
      const elapsedMs = Date.now() - startedAt;

      expect(denied).toEqual({ ok: false, reason: 'busy' });
      expect(elapsedMs).toBeGreaterThanOrEqual(120);
      // Generous, because this is a wall-clock assertion on a shared machine.
      // It is not measuring how fast the poll is; it is establishing that the
      // loop terminates by its own bound and not by the process ending.
      expect(elapsedMs).toBeLessThan(5_000);
      if (held.ok) held.lock.release();
    });

    it('is defending against something: a lock left by a process that was killed would otherwise be waited on by every later run', async () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      // Exactly what a killed extension host leaves: a fresh record — so the
      // staleness bound is nowhere near reached — naming a process that is gone.
      writeFileSync(paths.lockPath, JSON.stringify({ token: 'from-a-dead-process', pid: pidOfAProcessThatHasExited(), acquiredAtMs: Date.now() }));

      // `lockWaitMs: 0` so that waiting cannot be what made this succeed.
      const taken = await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }));
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.lock.release();
    });

    it('is defending against something: a lock file whose record was never finished would otherwise be permanent', async () => {
      // What a process killed between creating the file and writing its record
      // leaves behind: no token to release it by, no process id to check, no
      // timestamp inside. The only fact left about it is the file's own age.
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      writeFileSync(paths.lockPath, '');
      const anHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      utimesSync(paths.lockPath, anHourAgo, anHourAgo);

      const taken = await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }));
      expect(taken.ok).toBe(true);
      if (taken.ok) taken.lock.release();
    });

    it('waits out an unfinished lock file that has only just appeared, rather than assuming it is abandoned', async () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      writeFileSync(paths.lockPath, '');

      expect(await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }))).toEqual({ ok: false, reason: 'busy' });
    });

    it('takes a lock whose holder is alive but whose record is older than the longest honest acquisition', async () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const policy = policyWith({ lockWaitMs: 0, lockStaleMs: 10_000 });
      // This process is alive, so only the age can decide it.
      writeFileSync(paths.lockPath, JSON.stringify({ token: 'stale', pid: process.pid, acquiredAtMs: 1_000_000 }));

      const tooSoon = await acquireCacheLock(paths, policy, { now: () => 1_005_000 });
      expect(tooSoon).toEqual({ ok: false, reason: 'busy' });

      const stale = await acquireCacheLock(paths, policy, { now: () => 1_011_000 });
      expect(stale.ok).toBe(true);
      if (stale.ok) stale.lock.release();
    });

    it('releases only the lock that call took', async () => {
      // Otherwise a holder whose lock was stolen would, on its way out, delete
      // the lock of whoever took it next — and two holders at once is the one
      // state this file exists to make impossible.
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const first = await acquireCacheLock(paths, policyWith({ lockWaitMs: 0 }));
      expect(first.ok).toBe(true);
      rmSync(paths.lockPath, { force: true });
      writeFileSync(paths.lockPath, JSON.stringify({ token: 'somebody-else', pid: process.pid, acquiredAtMs: Date.now() }));

      if (first.ok) first.lock.release();
      expect(existsSync(paths.lockPath)).toBe(true);
      expect(JSON.parse(readFileSync(paths.lockPath, 'utf8')).token).toBe('somebody-else');
    });
  });

  describe('attempt leases (task 7.7)', () => {
    it('holds while the attempt runs and goes when it ends', () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const lease = takeCacheLease(paths, 'attempt-1');
      expect(lease).toBeDefined();
      expect(liveLeaseCount(paths, DEFAULT_LOCAL_GIT_POLICY)).toBe(1);
      lease?.refresh();
      expect(liveLeaseCount(paths, DEFAULT_LOCAL_GIT_POLICY)).toBe(1);
      lease?.release();
      expect(liveLeaseCount(paths, DEFAULT_LOCAL_GIT_POLICY)).toBe(0);
    });

    it('never puts an attempt id into a path', () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const lease = takeCacheLease(paths, '../../escaped/attempt');
      expect(lease?.path.startsWith(paths.leaseDirectory)).toBe(true);
      expect(readdirSync(paths.leaseDirectory)).toEqual([expect.stringMatching(/^[0-9a-f]{32}\.json$/)]);
      expect(readFileSync(lease?.path ?? '', 'utf8')).toContain('../../escaped/attempt');
    });

    it('stops holding once it is older than the harness’s own maximum attempt time, and tidies itself away', () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.directory, { recursive: true });
      const lease = takeCacheLease(paths, 'attempt-1', { now: () => 1_000_000 });
      expect(lease).toBeDefined();
      const policy = policyWith({ leaseStaleMs: 30_000 });
      expect(liveLeaseCount(paths, policy, { now: () => 1_020_000 })).toBe(1);
      expect(liveLeaseCount(paths, policy, { now: () => 1_040_000 })).toBe(0);
      expect(existsSync(lease?.path ?? '')).toBe(false);
    });

    it('is defending against something: a lease left by a process that was killed would pin its repository until the staleness bound', () => {
      const paths = cacheEntryPaths(root, IDENTITY);
      mkdirSync(paths.leaseDirectory, { recursive: true });
      writeFileSync(
        join(paths.leaseDirectory, 'dead.json'),
        JSON.stringify({ attemptId: 'attempt-from-a-dead-process', pid: pidOfAProcessThatHasExited(), refreshedAtMs: Date.now() }),
      );
      // Refreshed a moment ago, so nothing but the dead process id can decide it.
      expect(liveLeaseCount(paths, DEFAULT_LOCAL_GIT_POLICY)).toBe(0);
    });
  });

  describe('eviction (task 7.8)', () => {
    const OTHER: RepositoryIdentity = { ...IDENTITY, repoId: 'osirison/other' };
    const THIRD: RepositoryIdentity = { ...IDENTITY, repoId: 'osirison/third' };

    it('removes whole entries in least-recently-used order until the cache is inside its bound', async () => {
      plantEntry(IDENTITY, { lastUsedAtMs: 1_000, bytes: 4096 });
      plantEntry(OTHER, { lastUsedAtMs: 2_000, bytes: 4096 });
      const newest = plantEntry(THIRD, { lastUsedAtMs: 3_000, bytes: 4096 });

      const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 9000, entryIdleLifetimeMs: 1_000_000 }), { now: () => 3_500 });
      expect(outcome.scanned).toBe(3);
      expect(outcome.evicted).toEqual([cacheEntryPaths(root, IDENTITY).directory]);
      expect(outcome.bytesAfter).toBeLessThanOrEqual(9000);
      expect(existsSync(cacheEntryPaths(root, IDENTITY).directory)).toBe(false);
      expect(existsSync(cacheEntryPaths(root, OTHER).directory)).toBe(true);
      expect(existsSync(newest.directory)).toBe(true);
    });

    it('removes an entry nobody has used for longer than its idle lifetime even when there is room for it', async () => {
      plantEntry(IDENTITY, { lastUsedAtMs: 0, bytes: 64 });
      plantEntry(OTHER, { lastUsedAtMs: 900_000, bytes: 64 });

      const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 1024 * 1024, entryIdleLifetimeMs: 100_000 }), { now: () => 1_000_000 });
      expect(outcome.evicted).toEqual([cacheEntryPaths(root, IDENTITY).directory]);
      expect(existsSync(cacheEntryPaths(root, OTHER).directory)).toBe(true);
    });

    it('is defending against something: without the lease check the entry a review is reading from is the first one deleted', async () => {
      const oldest = plantEntry(IDENTITY, { lastUsedAtMs: 1_000, bytes: 4096 });
      plantEntry(OTHER, { lastUsedAtMs: 2_000, bytes: 4096 });
      // The least recently used entry, and therefore the first eviction would
      // reach for — with an attempt running against it right now.
      const lease = takeCacheLease(oldest, 'attempt-in-flight');
      expect(lease).toBeDefined();

      const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 1000, entryIdleLifetimeMs: 1_000_000 }), { now: () => 2_500 });
      expect(outcome.kept).toBe(1);
      expect(existsSync(oldest.directory)).toBe(true);
      expect(existsSync(cacheEntryPaths(root, OTHER).directory)).toBe(false);
      // The bound is a budget, not a guarantee: leaving a running review's
      // objects in place is the right answer even when it means staying over.
      expect(outcome.bytesAfter).toBeGreaterThan(1000);
      lease?.release();
    });

    it('skips an entry another process is acquiring into, rather than deleting the directory underneath it', async () => {
      const busy = plantEntry(IDENTITY, { lastUsedAtMs: 1_000, bytes: 4096 });
      const held = await acquireCacheLock(busy, policyWith({ lockWaitMs: 0 }));
      expect(held.ok).toBe(true);

      const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 1, entryIdleLifetimeMs: 1_000_000 }), { now: () => 2_000 });
      expect(outcome.evicted).toEqual([]);
      expect(outcome.kept).toBe(1);
      expect(existsSync(busy.gitDir)).toBe(true);
      if (held.ok) held.lock.release();
    });

    it('never deletes a directory it did not write', async () => {
      // Eviction's primitive is a recursive delete, so it acts only on a
      // directory whose name it could have produced *and* which carries a
      // record of ours. Everything else in the cache root is somebody else's.
      const foreign = join(root, 'someone-elses-directory');
      mkdirSync(foreign, { recursive: true });
      writeFileSync(join(foreign, 'important.txt'), 'not ours');
      const hexButNotOurs = join(root, 'b'.repeat(64));
      mkdirSync(hexButNotOurs, { recursive: true });
      writeFileSync(join(hexButNotOurs, 'important.txt'), 'also not ours');

      const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 1, entryIdleLifetimeMs: 1 }), { now: () => 9_000_000 });
      expect(outcome.scanned).toBe(0);
      expect(existsSync(join(foreign, 'important.txt'))).toBe(true);
      expect(existsSync(join(hexButNotOurs, 'important.txt'))).toBe(true);
    });

    it.skipIf(process.platform === 'win32')('measures its own bytes without following a link out of the cache', () => {
      // A link planted in the cache pointing at the reviewer's own repository
      // would otherwise make the size walk read that directory — and design D3's
      // promise is that nothing here reads it for any purpose, measurement
      // included.
      const elsewhere = mkdtempSync(join(tmpdir(), 'code-verdict-not-ours-'));
      writeFileSync(join(elsewhere, 'big.bin'), Buffer.alloc(64 * 1024));
      const paths = plantEntry(IDENTITY, { lastUsedAtMs: 1_000, bytes: 1024 });
      symlinkSync(elsewhere, join(paths.directory, 'link-to-somewhere-else'));

      expect(directorySizeBytes(paths.directory)).toBeLessThan(16 * 1024);
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32')('removes the link and not what it points at', async () => {
      const elsewhere = mkdtempSync(join(tmpdir(), 'code-verdict-not-ours-'));
      writeFileSync(join(elsewhere, 'precious.txt'), 'the reviewer’s own file');
      const paths = plantEntry(IDENTITY, { lastUsedAtMs: 1_000, bytes: 1024 });
      symlinkSync(elsewhere, join(paths.directory, 'link-to-somewhere-else'));

      await evictObjectCache(root, policyWith({ cacheMaxBytes: 1, entryIdleLifetimeMs: 1_000_000 }), { now: () => 2_000 });
      expect(existsSync(paths.directory)).toBe(false);
      expect(existsSync(join(elsewhere, 'precious.txt'))).toBe(true);
      rmSync(elsewhere, { recursive: true, force: true });
    });

    it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a cache location it cannot write to, and creates nothing (task 7.12)', () => {
      const readOnly = join(root, 'read-only');
      mkdirSync(readOnly, { recursive: true });
      chmodSync(readOnly, 0o500);
      try {
        expect(prepareCacheEntry(readOnly, IDENTITY).ok).toBe(false);
        expect(readdirSync(readOnly)).toEqual([]);
      } finally {
        chmodSync(readOnly, 0o700);
      }
    });
  });
});

describe.skipIf(gitVersion === undefined)('eviction never leaves a repository holding some of its pinned commits and not others (task 7.13)', () => {
  let repo: LocalGitFixture;
  let root: string;

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 20 });
  });

  afterAll(() => {
    repo?.cleanup();
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'code-verdict-evict-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** Which of the pinned commits this store can still answer for. */
  async function heldCommits(gitDir: string): Promise<readonly string[]> {
    const held: string[] = [];
    for (const commit of [repo.baseSha, repo.headSha]) {
      const planned = planGitInvocation({ kind: 'readCommitRef', commit });
      if (!planned.ok) continue;
      const outcome = await runGitInvocation(planned.plan, { gitDir });
      if (outcome.state === 'ok' && outcome.stdout.toString('utf8').trim() === commit) held.push(commit);
    }
    return held;
  }

  it('takes the whole repository or none of it', async () => {
    const prepared = prepareCacheEntry(root, IDENTITY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const opened = await openCacheRepository(prepared.paths.gitDir);
    expect(opened.state).toBe('ready');
    runGit(repo, ['push', prepared.paths.gitDir, `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`, `${repo.headSha}:refs/codeverdict/${repo.headSha}`]);
    writeCacheEntryMetadata(prepared.paths, {
      identity: IDENTITY,
      lastUsedAtMs: 1_000,
      sizeBytes: directorySizeBytes(prepared.paths.directory),
      commits: [repo.baseSha, repo.headSha],
    });
    expect(await heldCommits(prepared.paths.gitDir)).toEqual([repo.baseSha, repo.headSha]);

    // A bound of one byte: the most aggressive eviction the policy admits, and
    // the one that would tempt an implementation into reclaiming bytes by
    // deleting a pack or dropping a ref rather than the whole directory.
    const outcome = await evictObjectCache(root, policyWith({ cacheMaxBytes: 1, entryIdleLifetimeMs: 1_000_000 }), { now: () => 2_000 });
    expect(outcome.evicted).toEqual([prepared.paths.directory]);
    expect(existsSync(prepared.paths.directory)).toBe(false);
    // The state this task exists to forbid is a store that answers for one
    // pinned commit and not the other; the only two states reachable here are
    // both of them and none of it.
    expect(await heldCommits(prepared.paths.gitDir)).toEqual([]);
  });

  it('leaves every pinned commit of an entry it keeps', async () => {
    const prepared = prepareCacheEntry(root, IDENTITY);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    await openCacheRepository(prepared.paths.gitDir);
    runGit(repo, ['push', prepared.paths.gitDir, `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`, `${repo.headSha}:refs/codeverdict/${repo.headSha}`]);
    writeCacheEntryMetadata(prepared.paths, { identity: IDENTITY, lastUsedAtMs: 1_000, sizeBytes: 1, commits: [repo.baseSha, repo.headSha] });
    const lease = takeCacheLease(prepared.paths, 'attempt-in-flight');

    await evictObjectCache(root, policyWith({ cacheMaxBytes: 1, entryIdleLifetimeMs: 1 }), { now: () => 9_000_000 });
    expect(await heldCommits(prepared.paths.gitDir)).toEqual([repo.baseSha, repo.headSha]);
    lease?.release();
  });
});
