/**
 * One object-store directory, and the guarantee that it is still the one this
 * extension created — design D3, and the half of it no argument can enforce.
 *
 * **The measurement.** `$GIT_DIR/info/attributes` holding one line, `*.ts
 * -diff`, makes every ordinary TypeScript file in a change answer `Binary files
 * a/… and b/… differ` from a patch read and `-\t-` from the manifest, and
 * makes `git grep -I` skip the file entirely. Measured on 2026-09-11 against a
 * bare repository holding two commits of one text file. That is the
 * everything-is-binary state this whole change exists to remove, arriving from
 * the machine instead of from the forge — and it is worse arriving here, because
 * the local source is the one that is supposed to be able to prove binary from
 * content rather than guess it.
 *
 * **Why the invocation builder cannot close it.** `commonArguments` pins every
 * configuration key measured to change an answer, and a command-line `-c` does
 * beat `$GIT_DIR/config`. Attributes are not configuration.
 * `$GIT_DIR/info/attributes` is the highest-precedence attributes source git
 * has, and on the same day `-c core.attributesFile=/dev/null`,
 * `--attr-source=<empty tree>` and `GIT_ATTR_SOURCE` were each measured leaving
 * it in force, exactly as gitattributes(5) says they will. Configuration has a
 * residue of its own as well: `-c` overrides the keys we can name, and a config
 * file can introduce one nobody named. `url.<base>.insteadOf` is the one that
 * matters — measured, it rewrote a validated `https` fetch location to a
 * different `http` host, which is where the credential header would then have
 * been sent.
 *
 * **So the directory is owned rather than argued with.** This extension creates
 * it, writes nothing into it but a marker and whatever `git init --bare` and
 * `git fetch` put there, and checks that it still looks like that: our marker,
 * no attributes file, no hook that is not one of git's own inert samples, and a
 * configuration carrying only the keys `git init --bare` writes. Anything else
 * and the entry is not trusted. It is deleted whole and rebuilt — the same
 * primitive eviction already uses (design D3, "whole directories only") — which
 * costs one shallow refetch and cannot leave a repository answering some
 * requests and not others.
 *
 * **When the check actually runs, since a comment that overstates a guarantee is
 * how the next person builds on sand.** `openCacheRepository` is the only caller
 * of `verifyCacheRepository` in this change, and the only caller of
 * `openCacheRepository` is `objectAcquisition.acquire()`. So the directory is
 * verified once per acquisition, immediately after it is created, and at no
 * other time. `createLocalGitSource` takes a `gitDir` and verifies nothing: every
 * read an attempt makes afterwards — half an hour of them, `maxAttemptElapsedMs`
 * — runs against a directory last checked before the attempt began. A write that
 * lands inside that window stays in force for the whole attempt.
 *
 * That window is left open deliberately, not overlooked. Closing it means
 * verifying before every read, which is a `git config --list` child process per
 * read — hundreds of extra spawns per review — spent on a boundary this file has
 * already scoped out two paragraphs down: anything that can write here can
 * replace this extension's bundle. And it would still be a window, just a
 * shorter one; nothing can verify a directory and read it in the same syscall.
 *
 * The realistic non-adversarial cause of the same window is eviction: it deletes
 * whole repository directories, and an attempt whose lease goes stale past
 * `maxAttemptElapsedMs` can have its store deleted while it is still reading.
 * That case is handled where it surfaces rather than by re-verifying — the local
 * source answers a pinned revision it can no longer resolve with `unknown`,
 * which leaves the file re-readable and the run honestly incomplete
 * (`localGitSource.ts`, design D8's closing invariant) — and it is the only one
 * of these that happens without a second party.
 *
 * **Severity, stated plainly.** Every one of those attacks needs a same-user
 * write into this extension's own storage directory. Nothing the model sends can
 * reach it: paths and queries are refused before git sees them, and no operation
 * in this source writes a file anywhere. Nothing in a change request can reach it
 * either. Anything that *can* write there can already replace this extension's
 * bundle, so this is not a boundary that keeps an attacker out. It is closed
 * because the cache is a directory we create and can therefore make promises
 * about, and because the failure it produces — a review that looks clean having
 * read a fraction of the code — is precisely the one this change exists to make
 * impossible, whether it arrives from a forge, from a directory some other tool
 * wrote into, or from a later bug of our own.
 *
 * Task 7.1 builds the rest of the cache on top of this: where the directory
 * lives, how it is named from `providerId + instanceUrl + repoId`, leases and
 * eviction. What is here is the ownership check those all depend on.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { planGitInvocation, runGitInvocation, type GitProcessContext, type GitRunner } from './gitInvocation';

/**
 * The file that says a directory is ours.
 *
 * It exists so that nothing here ever deletes a directory this extension did not
 * create. A repository directory that fails its checks is discarded and rebuilt,
 * and "discard" is a recursive delete; without a marker, one wrong path from a
 * caller — the reviewer's own clone, say, which design D3 forbids touching at
 * all — would be destroyed by a routine that believed it was tidying its own
 * cache. A directory with no marker is refused and left exactly as it was.
 */
const MARKER_FILE = 'codeverdict-object-store';
const MARKER_CONTENT = 'code-verdict object store, format 1\n';

/**
 * The keys `git init --bare` writes, and nothing else.
 *
 * An allowlist rather than a list of dangerous keys, because the dangerous ones
 * cannot be enumerated: `url.<base>.insteadOf` rewrites a fetch location,
 * `core.hooksPath` runs a program, `core.bigFileThreshold` decides what is
 * binary, and the next one will be something nobody has thought of. What this
 * extension writes is a short, knowable list; everything outside it is a fact
 * about the directory that we did not put there.
 *
 * `git config --list` lowercases section and key names — measured,
 * `core.bigFileThreshold` comes back as `core.bigfilethreshold` — so these are
 * compared in lower case. Subsection names keep their case, which does not
 * matter here: no key with a subsection is admitted.
 *
 * The platform-dependent entries are listed because git writes them itself:
 * `ignorecase` and `symlinks` on Windows, `precomposeunicode` on macOS.
 */
const ALLOWED_CONFIGURATION_KEYS: ReadonlySet<string> = new Set([
  'core.repositoryformatversion',
  'core.filemode',
  'core.bare',
  'core.ignorecase',
  'core.precomposeunicode',
  'core.symlinks',
  'core.logallrefupdates',
]);

/**
 * `extensions.*` declares the repository's on-disk format — `objectformat` for
 * a SHA-256 repository, `refstorage` for a reftable one. A future git that
 * writes one of these at `init` time would otherwise make every directory it
 * creates fail its own check on the next run, and refusing a format declaration
 * is refusing to read the repository we just made. They name a format; they
 * cannot name a program or a location.
 */
const ALLOWED_CONFIGURATION_PREFIX = 'extensions.';

/** Git's own hook samples are inert: they are not executable and git never runs a `.sample`. */
const HOOK_SAMPLE_SUFFIX = '.sample';

export type CacheRepositoryRefusalCode =
  | 'notOurs'
  | 'attributesPresent'
  | 'hookPresent'
  | 'configurationUnexpected'
  | 'notBare'
  | 'unreadable';

/**
 * Why a directory was not used.
 *
 * Bounded text of this module's own, naming the guarantee that failed and never
 * quoting a key, a value or a path back — the same rule `GitRefusal` states for
 * the invocation builder, for the same reason: a tampered directory's contents
 * are text somebody else wrote, and a reason travels into activity, limitations
 * and stored records.
 */
export interface CacheRepositoryRefusal {
  readonly code: CacheRepositoryRefusalCode;
  readonly reason: string;
}

export type CacheRepositoryCheck = { readonly ok: true } | { readonly ok: false; readonly refusal: CacheRepositoryRefusal };

export type OpenedCacheRepository =
  | {
      readonly state: 'ready';
      readonly gitDir: string;
      /**
       * True when the directory failed its checks and was rebuilt. The objects
       * went with it, so a caller that was holding a fetched commit has to fetch
       * it again, and it is worth recording as a limitation: a review that
       * refetches because its cache was tampered with should say so.
       */
      readonly recreated: boolean;
      /** What the discarded directory failed on, when one was discarded. */
      readonly discarded?: CacheRepositoryRefusal;
    }
  | { readonly state: 'unavailable'; readonly reason: string };

function refuse(code: CacheRepositoryRefusalCode, reason: string): CacheRepositoryCheck {
  return { ok: false, refusal: { code, reason } };
}

function isMarked(gitDir: string): boolean {
  try {
    return readFileSync(join(gitDir, MARKER_FILE), 'utf8') === MARKER_CONTENT;
  } catch {
    return false;
  }
}

/**
 * Read the repository's own configuration through the one seam that runs git.
 *
 * Not parsed from the file by hand: `git config --list --local` is the authority
 * on what that file declares, including the shapes a hand-written parser gets
 * wrong — a value continued across lines, a quoted value holding a comment
 * character, a key with no value at all. Framing measured on 2026-09-11:
 * `<key>` newline `<value>` NUL per entry, and a valueless key as `<key>` NUL.
 */
async function readOwnConfiguration(
  gitDir: string,
  context: Omit<GitProcessContext, 'gitDir'>,
  run: GitRunner,
): Promise<{ ok: true; entries: ReadonlyArray<{ key: string; value: string | undefined }> } | { ok: false }> {
  const planned = planGitInvocation({ kind: 'listRepositoryConfig' });
  if (!planned.ok) return { ok: false };
  const outcome = await run(planned.plan, { ...context, gitDir });
  if (outcome.state !== 'ok') return { ok: false };
  const entries: Array<{ key: string; value: string | undefined }> = [];
  for (const record of outcome.stdout.toString('utf8').split(String.fromCharCode(0))) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    if (newline === -1) entries.push({ key: record.toLowerCase(), value: undefined });
    else entries.push({ key: record.slice(0, newline).toLowerCase(), value: record.slice(newline + 1) });
  }
  return { ok: true, entries };
}

/**
 * Whether a directory is still the object store this extension created.
 *
 * Ordered cheapest first, and by what a failure means: a directory that is not
 * ours is a different situation from one that is ours and has been written into.
 */
export async function verifyCacheRepository(
  gitDir: string,
  context: Omit<GitProcessContext, 'gitDir'> = {},
  run: GitRunner = runGitInvocation,
): Promise<CacheRepositoryCheck> {
  try {
    if (!isMarked(gitDir)) {
      return refuse('notOurs', 'That object store was not created by this extension, so it was not used.');
    }
    if (existsSync(join(gitDir, 'info', 'attributes'))) {
      // The one that flips every text file to binary. Absence is the rule
      // rather than emptiness, because this extension never writes this file at
      // all, so anything here — even zero bytes — is something we did not do.
      return refuse('attributesPresent', 'That object store carries a git attributes file this extension did not write.');
    }
    const hooks = join(gitDir, 'hooks');
    if (existsSync(hooks)) {
      for (const entry of readdirSync(hooks)) {
        if (entry.endsWith(HOOK_SAMPLE_SUFFIX)) continue;
        // Measured: a `reference-transaction` hook in this directory ran three
        // times during one `git fetch`. Every invocation pins `core.hooksPath`
        // away from it, so this is the second lock — and, unlike the pin, it
        // also tells us the directory has been written into.
        return refuse('hookPresent', 'That object store carries a git hook this extension did not write.');
      }
    }
    const configuration = await readOwnConfiguration(gitDir, context, run);
    if (!configuration.ok) {
      return refuse('unreadable', 'That object store’s own configuration could not be read.');
    }
    for (const entry of configuration.entries) {
      if (ALLOWED_CONFIGURATION_KEYS.has(entry.key)) continue;
      if (entry.key.startsWith(ALLOWED_CONFIGURATION_PREFIX)) continue;
      return refuse('configurationUnexpected', 'That object store’s configuration carries settings this extension did not write.');
    }
    const bare = configuration.entries.find((entry) => entry.key === 'core.bare');
    if (bare?.value !== 'true') {
      // A store that is not bare has a work tree, and design D3's guarantee is
      // that nothing is ever checked out.
      return refuse('notBare', 'That object store is not a bare repository.');
    }
    return { ok: true };
  } catch {
    // A directory that cannot be read cannot be vouched for. Design D8 gives
    // this its own row: the local source is unsupported and selection moves on.
    return refuse('unreadable', 'That object store could not be read.');
  }
}

async function createCacheRepository(
  gitDir: string,
  context: Omit<GitProcessContext, 'gitDir'>,
  run: GitRunner,
  recreated: boolean,
  discarded?: CacheRepositoryRefusal,
): Promise<OpenedCacheRepository> {
  const unavailable = { state: 'unavailable', reason: 'An object store could not be created for this repository.' } as const;
  const planned = planGitInvocation({ kind: 'initBare' });
  if (!planned.ok) return unavailable;
  try {
    mkdirSync(gitDir, { recursive: true });
    // The marker goes down before `git init`, not after, so that a creation
    // interrupted partway leaves a directory that is recognisably ours and can
    // be discarded and rebuilt. Written the other way round, a crash between
    // the two — the extension host being reloaded is enough — would leave a
    // half-built store with no marker, which every later run would classify as
    // somebody else's and refuse for good. `git init --bare` does not require
    // an empty directory, so nothing about this order costs anything.
    writeFileSync(join(gitDir, MARKER_FILE), MARKER_CONTENT);
  } catch {
    return unavailable;
  }
  const outcome = await run(planned.plan, { ...context, gitDir });
  if (outcome.state !== 'ok') return unavailable;
  // Checked immediately, not assumed: a machine whose git writes something we
  // do not expect at `init` time should say so once, here, rather than at the
  // first read of every review it ever runs.
  const verified = await verifyCacheRepository(gitDir, context, run);
  if (!verified.ok) return { state: 'unavailable', reason: verified.refusal.reason };
  return discarded === undefined ? { state: 'ready', gitDir, recreated } : { state: 'ready', gitDir, recreated, discarded };
}

/**
 * Get a usable object store at `gitDir`, creating it if it is absent and
 * rebuilding it if it is not the one we left.
 *
 * This is the only entry point a caller needs, and it is deliberately the one
 * that also *acts* on a failed check. A verification that only reported would
 * leave every caller to decide what to do about a tampered directory, and the
 * decision is not theirs to vary: the objects in it are content-addressed and
 * refetchable, so discarding costs a shallow fetch and keeps the guarantee
 * absolute. The one thing that is never discarded is a directory with no marker
 * — that is somebody else's, and it is refused untouched.
 */
export async function openCacheRepository(
  gitDir: string,
  context: Omit<GitProcessContext, 'gitDir'> = {},
  run: GitRunner = runGitInvocation,
): Promise<OpenedCacheRepository> {
  let present: boolean;
  try {
    // An empty directory is treated as an absent one: it holds nothing that
    // could belong to anyone, and it is what an interrupted creation leaves
    // behind if it got as far as the directory and no further. Refusing it as
    // unmarked would strand this repository on every later run.
    present = existsSync(gitDir) && readdirSync(gitDir).length > 0;
  } catch {
    return { state: 'unavailable', reason: 'An object store could not be created for this repository.' };
  }
  if (!present) return createCacheRepository(gitDir, context, run, false);

  const verified = await verifyCacheRepository(gitDir, context, run);
  if (verified.ok) return { state: 'ready', gitDir, recreated: false };
  if (verified.refusal.code === 'notOurs') return { state: 'unavailable', reason: verified.refusal.reason };
  try {
    rmSync(gitDir, { recursive: true, force: true });
  } catch {
    return { state: 'unavailable', reason: verified.refusal.reason };
  }
  return createCacheRepository(gitDir, context, run, true, verified.refusal);
}
