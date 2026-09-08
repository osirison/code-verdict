/**
 * Finding 2, proved by attacking the directory instead of the arguments.
 *
 * The invocation builder can be made to answer truthfully whatever the
 * machine's configuration says, and `gitInvocation.adversarial.test.ts` proves
 * that. It cannot be made to answer truthfully whatever the *repository
 * directory* says: `$GIT_DIR/info/attributes` is the highest-precedence
 * attributes source git has, and no argument, environment variable or
 * `--attr-source` overrides it. So the guard is ownership, and these tests run
 * the whole loop — plant the file, watch every text file in the change turn
 * binary, open the store, watch it be discarded and rebuilt, and read the true
 * manifest back out of the rebuilt one.
 *
 * Run against a real bare repository for the same reason every other test in
 * this directory is: what is being asserted is a fact about git's attribute
 * precedence, and a recording of the safe case could never fail when the guard
 * is removed.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCacheRepository, verifyCacheRepository } from './cacheRepository';
import { planGitInvocation, runGitInvocation, type GitOperation } from './gitInvocation';
import { createLocalGitSource } from './localGitSource';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';

const gitVersion = gitExecutableVersion();

describe.skipIf(gitVersion === undefined)('the object store this extension owns', () => {
  let repo: LocalGitFixture;
  let root: string;
  let store: string;
  let stores = 0;

  beforeAll(() => {
    repo = createTwoCommitRepository({ oversizedDiffLines: 20 });
    root = mkdtempSync(join(tmpdir(), 'code-verdict-store-'));
  });

  afterAll(() => {
    repo?.cleanup();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  beforeEach(() => {
    stores += 1;
    store = join(root, `store-${String(stores)}.git`);
  });

  /** The two pinned commits, under the ref names design D3 gives acquired objects. */
  function acquire(gitDir: string): void {
    runGit(repo, ['push', gitDir, `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`, `${repo.headSha}:refs/codeverdict/${repo.headSha}`]);
  }

  async function run(gitDir: string, operation: GitOperation): Promise<string> {
    const planned = planGitInvocation(operation);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return '';
    const outcome = await runGitInvocation(planned.plan, { gitDir });
    expect(outcome.state).toBe('ok');
    return outcome.state === 'ok' ? outcome.stdout.toString('utf8') : '';
  }

  function manifestRecords(stdout: string): readonly string[] {
    return stdout.split(String.fromCharCode(0)).filter((record) => record !== '');
  }

  it('creates a store that is bare, marked, and passes its own check', async () => {
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    if (opened.state !== 'ready') return;
    expect(opened.recreated).toBe(false);
    expect(existsSync(join(store, 'objects'))).toBe(true);
    expect(existsSync(join(store, 'index'))).toBe(false);
    // Nothing but what `git init --bare` wrote: the `-c` pins every invocation
    // carries are command-line scope and must not have been persisted here,
    // because a value in this file is a value the next check would refuse.
    expect(readFileSync(join(store, 'config'), 'utf8')).not.toContain('hooksPath');
    await expect(verifyCacheRepository(store)).resolves.toEqual({ ok: true });
  });

  it('is defending against something: one line in the store turns every text file binary', async () => {
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    acquire(store);

    const clean = manifestRecords(await run(store, { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha }));
    expect(clean).toContain(`2\t1\t${repo.paths.modified}`);

    mkdirSync(join(store, 'info'), { recursive: true });
    writeFileSync(join(store, 'info', 'attributes'), '*.ts -diff\n');

    // Every TypeScript file in the change, reported exactly the way a real
    // binary file is reported, by a source whose entire purpose is to be the
    // one that can tell the difference.
    const attacked = manifestRecords(await run(store, { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha }));
    expect(attacked).toContain(`-\t-\t${repo.paths.modified}`);
    expect(attacked).not.toContain(`2\t1\t${repo.paths.modified}`);
    expect(await run(store, { kind: 'diffFile', base: repo.baseSha, head: repo.headSha, path: repo.paths.modified })).toContain('Binary files');
    // And the search goes quiet, because `-I` skips what the attribute called
    // binary: a query that matched is answered as a query that did not.
    expect(await run(store, { kind: 'searchRepository', revision: repo.headSha, query: 'RATE' })).toBe('');
  });

  it('discards a store carrying that file and answers truthfully from the rebuilt one', async () => {
    const first = await openCacheRepository(store);
    expect(first.state).toBe('ready');
    acquire(store);
    mkdirSync(join(store, 'info'), { recursive: true });
    writeFileSync(join(store, 'info', 'attributes'), '*.ts -diff\n');

    const reopened = await openCacheRepository(store);
    expect(reopened.state).toBe('ready');
    if (reopened.state !== 'ready') return;
    expect(reopened.recreated).toBe(true);
    expect(reopened.discarded?.code).toBe('attributesPresent');
    expect(existsSync(join(store, 'info', 'attributes'))).toBe(false);

    // The objects went with the directory, which is the price of the guarantee
    // and the reason `recreated` is reported: the caller fetches again.
    acquire(store);
    const rebuilt = manifestRecords(await run(store, { kind: 'changedFiles', base: repo.baseSha, head: repo.headSha }));
    expect(rebuilt).toContain(`2\t1\t${repo.paths.modified}`);
    expect(rebuilt.some((record) => record.startsWith('-\t-\t') && record.endsWith(repo.paths.modified))).toBe(false);
    // Git's own content determination still stands: the file that really is
    // binary is still reported binary.
    expect(rebuilt).toContain(`-\t-\t${repo.paths.binary}`);
  });

  it('is verified when it is opened, and not again while an attempt reads it', async () => {
    // Characterization, in the tradition of tasks 1.2 and 1.3: it records what
    // the code does, so that the paragraph above it cannot quietly overstate the
    // guarantee. `openCacheRepository` is the only caller of
    // `verifyCacheRepository`, and `objectAcquisition.acquire()` is the only
    // caller of that; `createLocalGitSource` takes a `gitDir` and checks
    // nothing. So ownership is established at acquisition, and the attempt's
    // reads for the next `maxAttemptElapsedMs` run against a directory last
    // checked before they began.
    //
    // The window is left open deliberately — see this module's header: closing
    // it means a `git config --list` child process before every read, for a
    // boundary that already needs a same-user write into this extension's own
    // storage, and it would still be a window. What this pins is that nobody
    // may describe the check as running before every use while it passes.
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    acquire(store);

    const snapshot = { repoId: 'acme/core', baseSha: repo.baseSha, headSha: repo.headSha };
    const source = createLocalGitSource({ gitDir: store, repoId: 'acme/core' });
    expect((await source.readDiff({ snapshot, path: repo.paths.modified })).state).toBe('complete');

    mkdirSync(join(store, 'info'), { recursive: true });
    writeFileSync(join(store, 'info', 'attributes'), '*.ts -diff\n');

    // The same source, the same store, the opposite answer about the same
    // TypeScript file — and `binary` is one of the states `harnessAttempt.ts`
    // closes a file on for good. No check ran in between, because there is no
    // code path that would have run one.
    expect((await source.readDiff({ snapshot, path: repo.paths.modified })).state).toBe('binary');

    // Where the check does run, and what it does when it fails.
    const reopened = await openCacheRepository(store);
    expect(reopened.state === 'ready' ? reopened.discarded?.code : undefined).toBe('attributesPresent');
  });

  it('discards a store whose configuration carries a key this extension did not write', async () => {
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    // Measured on 2026-09-11: this rewrites a validated https fetch location to
    // another host, which is where the credential header would then be sent.
    // No `-c` can remove it, because removing a key is not something `-c` does.
    writeFileSync(join(store, 'config'), '[url "http://127.0.0.1:9/"]\n\tinsteadOf = https://example.invalid/\n', { flag: 'a' });

    const check = await verifyCacheRepository(store);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.refusal.code).toBe('configurationUnexpected');
    // The reason names the rule and quotes nothing back out of the file.
    expect(check.refusal.reason).not.toContain('127.0.0.1');

    const reopened = await openCacheRepository(store);
    expect(reopened.state).toBe('ready');
    if (reopened.state !== 'ready') return;
    expect(reopened.recreated).toBe(true);
    expect(readFileSync(join(store, 'config'), 'utf8')).not.toContain('insteadOf');
  });

  it('discards a store carrying a hook, and keeps git’s own inert samples', async () => {
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    // The samples git itself writes are still there and still fine — a check
    // that refused them would refuse every store on creation.
    await expect(verifyCacheRepository(store)).resolves.toEqual({ ok: true });

    const hook = join(store, 'hooks', 'reference-transaction');
    writeFileSync(hook, '#!/bin/sh\nexit 0\n');
    chmodSync(hook, 0o755);
    const reopened = await openCacheRepository(store);
    expect(reopened.state).toBe('ready');
    if (reopened.state !== 'ready') return;
    expect(reopened.discarded?.code).toBe('hookPresent');
    expect(existsSync(hook)).toBe(false);
  });

  it('refuses a store that says it is not bare', async () => {
    const opened = await openCacheRepository(store);
    expect(opened.state).toBe('ready');
    writeFileSync(join(store, 'config'), '[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n');
    const check = await verifyCacheRepository(store);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.refusal.code).toBe('notBare');
  });

  it('never deletes a directory it did not create', async () => {
    // The safety property under the rebuild. Design D3 forbids this source from
    // touching the reviewer's own repository at all, and "discard and rebuild"
    // is a recursive delete, so the marker decides what may be discarded. A
    // directory without one is refused exactly as it was found.
    const foreign = join(root, 'someone-elses-repository');
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, 'important.txt'), 'not ours\n');

    const opened = await openCacheRepository(foreign);
    expect(opened.state).toBe('unavailable');
    expect(existsSync(join(foreign, 'important.txt'))).toBe(true);
    const check = await verifyCacheRepository(foreign);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.refusal.code).toBe('notOurs');
  });

  it('rebuilds a store whose creation was interrupted, rather than stranding it', async () => {
    // An extension host reload between `mkdir` and the end of `git init` is
    // enough to produce both of these. Neither may become a repository this
    // extension refuses for the rest of its life, which is what an unmarked
    // directory would be.
    mkdirSync(store, { recursive: true });
    const fromEmpty = await openCacheRepository(store);
    expect(fromEmpty.state).toBe('ready');
    if (fromEmpty.state === 'ready') expect(fromEmpty.recreated).toBe(false);

    // A real half-built store, produced the way one really would be: the
    // directory is made and `git init` never completes. The marker is written
    // first precisely so that what is left behind is recognisably ours.
    const halfBuilt = join(root, 'half-built.git');
    const noGit = await openCacheRepository(halfBuilt, { executable: join(tmpdir(), 'code-verdict-no-such-git') });
    expect(noGit.state).toBe('unavailable');
    expect(existsSync(join(halfBuilt, 'codeverdict-object-store'))).toBe(true);
    expect(existsSync(join(halfBuilt, 'objects'))).toBe(false);

    const finished = await openCacheRepository(halfBuilt);
    expect(finished.state).toBe('ready');
    if (finished.state !== 'ready') return;
    expect(finished.recreated).toBe(true);
    expect(finished.discarded?.code).toBe('unreadable');
    await expect(verifyCacheRepository(halfBuilt)).resolves.toEqual({ ok: true });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a location it cannot write as unavailable, and writes nothing elsewhere', async () => {
    const readOnly = join(root, 'read-only');
    mkdirSync(readOnly, { recursive: true });
    chmodSync(readOnly, 0o500);
    try {
      const opened = await openCacheRepository(join(readOnly, 'store.git'));
      expect(opened.state).toBe('unavailable');
      expect(existsSync(join(readOnly, 'store.git'))).toBe(false);
    } finally {
      chmodSync(readOnly, 0o700);
    }
  });
});
