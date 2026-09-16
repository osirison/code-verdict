/**
 * The local investigation source — task group 8 of
 * `add-local-git-investigation`, design D1/D2/D7.
 *
 * This is where the change stops being plumbing and answers the five pinned
 * operations. Everything below computes its answer from two commit ids in a
 * bare object store this extension owns, through the one invocation builder
 * (`gitInvocation.ts`), and asks no forge anything.
 *
 * **The measurement the whole module exists to overturn.** On
 * `osirison/code-verdict#66` — 207 changed files, every one plain TypeScript —
 * GitHub's compare response returned 137 of them with no `patch` and zero
 * counts, the byte-identical shape a genuinely binary file produces. Those 137
 * were mapped to `binary`, `binary` is terminal, and the completion gate counts
 * a terminal `binary` as satisfied. The run reported itself complete and clean
 * having read a third of the code. Over the same two commits, `git diff
 * --numstat -z -M` returns 207 of 207 with one determination per file made from
 * the content itself.
 *
 * **Binary is git's answer, never ours, and never an inference from an absent
 * one** (task 8.6). Three places state it and all three are git's own:
 * `--numstat` writes `-\t-` for a file it could not compare as text, the patch
 * carries `Binary files a/x and b/x differ`, and a file read applies git's own
 * content test to bytes that were actually read. Nothing here reports binary
 * because an answer was missing — a missing answer is what the bounded states
 * below are for.
 *
 * **What a stop at a bound is, and why it is `unknown`.** An invocation that
 * hits its timeout or its stdout cap has said nothing about the file, and design
 * D8 requires that outcome never to become a terminal file state. The harness's
 * read switch (`harnessAttempt.ts`) is explicit about which states are terminal:
 * `binary` and `tooLarge` call `markTerminal`, and so does `unavailable` unless
 * the *harness* marked the call deferred — a flag that lives on `HostToolResult`
 * and which a source cannot set. `unknown` is the one state this source can
 * return that leaves the file classified, uninspected and re-readable, which is
 * exactly what a bound stop means. So a bound stop is `unknown` with this
 * module's own reason, and `tooLarge` is never returned at all: a local diff has
 * no size at which git declines, so a large file paginates instead of failing.
 *
 * **A revision the store cannot resolve is `unknown` too, and that is the
 * correction this module needed.** Design D8's closing invariant names three
 * things that must "leave the affected file classified and uninspected": a
 * suppressed patch, a timed-out invocation, and *an unobtainable revision*. This
 * module answered the third with `unavailable`, which the harness switch above
 * closes with `markTerminal` — irreversibly, and carried forward into every
 * resumed attempt. That is the same shape as the bug this whole change exists to
 * remove: a guess about the content turned into a terminal state.
 *
 * A pinned commit that will not resolve is a fact about the store, not about the
 * file, and every way it happens is repairable by the next acquisition: an
 * eviction interrupted partway, a directory `openCacheRepository` discarded and
 * rebuilt after a failed ownership check, an attempt whose lease went stale past
 * `maxAttemptElapsedMs` while eviction was choosing a victim. The objects are
 * content-addressed and refetchable; nothing about the file has been learned. So
 * a missing pinned revision is `unknown`. So, for the same reason, is a read that
 * failed for a path the manifest enumerated: with both commits resolvable, a diff
 * that will not render is a store missing a tree or a blob, not a path that is
 * not there, and `notFound` would report an absence nobody established.
 *
 * A request this source *refuses* is the only thing left that gets `unavailable`:
 * a revision that is not an object id, a snapshot naming a different repository,
 * a path that is not repository-relative *and* is not part of this change. Those
 * do not become answerable by trying again, and none of them is a changed file
 * the review was meant to cover.
 *
 * **Nothing is checked out and no working tree is ever created.** Every
 * invocation runs with `GIT_DIR` pointing at the bare store and reads the object
 * database by commit id.
 *
 * **One limitation, settled rather than patched.** A repository path containing
 * a control character — a newline is the realistic case — is refused before git
 * sees it by the path rule task 6.4 settled, which closes a whole class rather
 * than the members of it a NUL-framed reader happens to survive. Such a file is
 * still enumerated truthfully by the manifest, because it really did change.
 * What it is not is unreadable: a forge serves that file's patch perfectly well,
 * keyed by its path as a JSON string. So the manifest entry carries
 * `contentDeclined`, and so does every read of it — "this source enumerated the
 * file and would not serve its content", which is exactly what the state means
 * (`InvestigationResult` in `src/platform/types.ts`, design D6) and exactly what
 * happened. The refusal is this host's, so the state that records it must be one
 * that says so.
 *
 * Both alternatives were rejected, and the reasons are the point. `unavailable`,
 * which this module returned before, is a claim that the content could not be
 * obtained — a claim about the file, made for a reason belonging to the host —
 * and `harnessAttempt.ts` turns it into `markTerminal`, irreversible and carried
 * across resume. `excludedByPolicy` fails in the other direction and worse: the
 * completion gate counts it as satisfied (`harnessCompletion.ts`), so a run would
 * report itself complete and clean over changed source code nobody read, which is
 * the outcome measured at the top of this file. `contentDeclined` is terminal for
 * nothing, blocks completion through the `declinedContent` blocker with the file
 * named, and leaves the member open to the provider — which can read that path —
 * once source selection (task group 9) chooses between them.
 *
 * The cost, stated: until selection lands, a change containing such a file cannot
 * reach a complete review through this source. That is the honest end of it — a
 * named file nobody read, never a clean report over it.
 *
 * **This module imports nothing from `src/providers/`** (design D2's dependency
 * rule). The pagination helpers below are deliberate near-duplicates of the two
 * in `githubProvider.ts`/`gitlabProvider.ts`: the cursor contract has to be the
 * same one the providers use — an opaque string the harness never inspects,
 * which both of them implement as an offset — and the alternative to copying
 * thirty lines is for a non-provider source to import provider code, which is
 * the one dependency the architecture forbids.
 */
import type {
  ChangedFileEntry,
  ChangedFileKind,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  DiffPage,
  DiffPageRequest,
  DiffPageResult,
  DiffSearchMatch,
  DiffSearchRequest,
  DiffSearchResult,
  FileRange,
  FileRangeRequest,
  FileRangeResult,
  InvestigationSnapshotRef,
  InvestigationSource,
  RepositorySearchRequest,
  RepositorySearchResult,
  InvestigationSourceCapabilities,
  SearchMatch,
} from '../platform/types';
import {
  planGitInvocation,
  refusePath,
  runGitInvocation,
  type GitObjectId,
  type GitOperation,
  type GitProcessContext,
  type GitRefusal,
  type GitRunner,
} from './gitInvocation';
import { gitBoundsFromPolicy, normalizeLocalGitPolicy, type LocalGitPolicy } from './localGitPolicy';

// ---- What this source declares ------------------------------------------------

/**
 * One manifest page, in files. Matches both providers' declaration and
 * `DEFAULT_HARNESS_POLICY.manifestPageSize`, which is what the dispatcher
 * checks a declared bound against before it will run the tool at all.
 */
const MANIFEST_PAGE_FILES = 100;
/** One diff or file page, in lines, with a byte ceiling that trims it further. */
const READ_PAGE_LINES = 20_000;
const READ_PAGE_BYTES = 256 * 1024;
/**
 * One search page, in *matches*. It has to stay within
 * `DEFAULT_HARNESS_POLICY.searchResultPageMatches` (50) rather than inheriting
 * the manifest's file count — inheriting it is what made every `searchDiff`
 * dispatch an `outOfBounds` refusal on both shipped providers
 * (`src/providers/providerPageBounds.test.ts`).
 */
const SEARCH_PAGE_MATCHES = 50;

/**
 * What this source can do, declared once (task 8.7).
 *
 * `repositorySearch: { supported: true }` is the capability no forge provider
 * can offer honestly: GitHub's code search indexes a repository's default
 * branch and takes no ref at all, so its provider declares it unsupported
 * rather than search the wrong revision; GitLab's needs Advanced Search on the
 * instance. `git grep <commit>` searches the commit it is given and nothing
 * else, so the declaration is true by construction.
 *
 * The declaration is a fact about this source and is independent of any policy
 * that withholds the corresponding tool from the model. When
 * `HarnessPolicy.scopeInvestigationToChangedFiles` is on, `effectiveCapabilities`
 * in `src/app/harnessRuntime.ts` turns `fileReads` and `repositorySearch` off in
 * the *attempt's* capabilities — unchanged by this task, and the reason the
 * capability signature recorded on a run describes what that attempt actually
 * had rather than what its source could do.
 *
 * There is no field here for change-request or issue detail. Those are
 * questions about a forge — a bare object id does not even identify the change
 * request they are about (design D2) — and they are declared by the connection,
 * on `ProviderCapabilities.detailRetrieval`.
 */
export const LOCAL_GIT_INVESTIGATION_CAPABILITIES: InvestigationSourceCapabilities = Object.freeze({
  manifests: { supported: true, pageBound: { maxPageSize: MANIFEST_PAGE_FILES } },
  diffReads: { supported: true, pageBound: { maxPageSize: READ_PAGE_LINES, maxPageBytes: READ_PAGE_BYTES } },
  fileReads: { supported: true, pageBound: { maxPageSize: READ_PAGE_LINES, maxPageBytes: READ_PAGE_BYTES } },
  repositorySearch: { supported: true, pageBound: { maxPageSize: SEARCH_PAGE_MATCHES } },
  diffSearch: { supported: true, pageBound: { maxPageSize: SEARCH_PAGE_MATCHES } },
  pagination: { maxPageSize: MANIFEST_PAGE_FILES },
});

// ---- This module's own words --------------------------------------------------
//
// Every reason a caller can see is written here and quotes nothing back. Git's
// own text is a diagnostic for this process only: it is raw output in whatever
// shape that git version chose, and these reasons reach the model.

const REASONS = {
  otherRepository: 'This source was opened for a different repository than the one this request names.',
  revisionUnresolvable: 'That revision is not in this repository’s object store right now, so nothing was read at it.',
  notAFile: 'That path names a directory at this revision, not a file.',
  noSuchPath: 'There is no such path at this revision.',
  startBeyondFile: 'The requested first line is past the end of the file.',
  manifestUnreadable: 'The list of changed files could not be read for this revision pair.',
  diffUnreadable: 'This file’s diff could not be read, although both pinned revisions are in the store.',
  /** Appended to the path rule's own refusal text, which names what about the path was refused. */
  declinedPath: 'So this source did not serve this file’s content. The file did change, and a source that reads paths by name can read it.',
  boundedManifest: 'Listing the changed files stopped at this source’s own bound, so the list is not complete.',
  boundedDiff: 'Reading this file’s diff stopped at this source’s own bound, so none of it was read.',
  boundedFile: 'Reading this file stopped at this source’s own bound, so none of it was read.',
  boundedSearch: 'The search stopped at this source’s own bound, so its results are not complete.',
  searchNotRun: 'The search could not be run over this revision pair.',
} as const;

/**
 * The path rule (task 6.4) applied to a *changed file* rather than to a request:
 * would this source refuse to name this entry to git, on either side of a
 * rename?
 *
 * One function, used in the two places that must agree — the manifest, which
 * marks such an entry `contentDeclined`, and `readDiff`, which states the same
 * refusal as the reason. Computing it twice from the same rule is what keeps a
 * manifest flag and a read reason from ever describing different files.
 */
function entryPathRefusal(entry: { readonly path: string; readonly oldPath?: string }): GitRefusal | undefined {
  return refusePath(entry.path) ?? (entry.oldPath === undefined ? undefined : refusePath(entry.oldPath));
}

// ---- Options -------------------------------------------------------------------

export interface LocalGitSourceOptions {
  /**
   * The bare object store holding both pinned commits — what
   * `objectAcquisition.ts` returns from a successful acquisition. Never a
   * repository in the reviewer's workspace (design D3); this source does not
   * accept a directory from any caller that did not come through the cache.
   */
  readonly gitDir: string;
  /**
   * Which repository this store is for. Every request carries a `repoId` of its
   * own, and a request naming another repository is refused rather than
   * answered from this one: the contract says every result identifies the
   * repository it answered for, and the only way to keep that promise is to
   * refuse to answer for a repository this store is not.
   */
  readonly repoId: string;
  readonly policy?: Partial<LocalGitPolicy>;
  readonly proxyUrl?: string;
  readonly executable?: string;
  /**
   * How invocations run. Production leaves it alone. A test passes one to
   * record every invocation this source makes — a claim about *every*
   * invocation is one no test can check from results — or to stand in for a
   * child that hits a bound, which would otherwise cost the suite a real
   * timeout.
   */
  readonly run?: GitRunner;
}

// ---- Invocation outcomes, in this module's terms ---------------------------------

type Answer =
  | { readonly kind: 'ok'; readonly stdout: Buffer }
  /** The request itself is not one this source will make. Permanent; maps to `unavailable`. */
  | { readonly kind: 'refused'; readonly reason: string }
  /** The invocation stopped at a time or output bound. Says nothing; maps to `unknown`. */
  | { readonly kind: 'bounded'; readonly reason: string }
  /** Git ran and reported a failure. Ambiguous on its own — see `explainFailure`. */
  | { readonly kind: 'failed'; readonly exitCode: number };

// ---- Pagination ------------------------------------------------------------------

/** In-memory paging over an already-computed array; the cursor is an offset the harness never inspects. */
function paginateArray<T>(items: readonly T[], cursor: string | undefined, pageSize: number): { page: readonly T[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  return { page: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

/**
 * Line pager for diffs and file reads, bounded by lines *and* bytes. The line
 * bound is set high enough to return an ordinary file whole, which is what makes
 * the byte bound necessary: without it one page of a generated file would exceed
 * what a single tool result may carry and the model would receive a refusal it
 * cannot act on. Always yields at least one line, so a single line longer than
 * the byte bound still makes progress instead of paging forever over nothing.
 */
function paginateLines(
  lines: readonly string[],
  cursor: string | undefined,
  maxLines: number,
  maxBytes: number,
): { page: readonly string[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const hardEnd = Math.min(start + maxLines, lines.length);
  let bytes = 0;
  let end = start;
  while (end < hardEnd) {
    const next = Buffer.byteLength(lines[end] ?? '', 'utf8') + 1; // + the newline that rejoins it
    if (end > start && bytes + next > maxBytes) break;
    bytes += next;
    end += 1;
  }
  return { page: lines.slice(start, end), nextCursor: end < lines.length ? String(end) : undefined };
}

// ---- Parsing git's own output ------------------------------------------------------

/**
 * Git's own binary test, applied to bytes that were actually read (task 8.6).
 *
 * This is `buffer_is_binary()` from git's `xdiff-interface.c`: a NUL byte within
 * the first 8000 bytes, and nothing else. The window matters — scanning the
 * whole buffer instead would disagree with git about a file whose first NUL sits
 * at byte 10,000, and this source reporting binary for a file `git diff` calls
 * text is the same class of error as the one the whole change removes, pointed
 * the other way. Both shipped providers scan the whole buffer; this follows git.
 *
 * It is used for `readFile` alone. A changed file's binary state comes from
 * `--numstat`'s `-\t-` and from the patch's own marker line, which are git's
 * determinations rather than a repeat of its rule.
 */
const GIT_BINARY_WINDOW_BYTES = 8000;
function looksBinaryToGit(content: Buffer): boolean {
  return content.subarray(0, GIT_BINARY_WINDOW_BYTES).includes(0);
}

/**
 * A patch git refused to render as text.
 *
 * `Binary files a/x and b/x differ` is the default; `GIT binary patch`
 * introduces the literal form `--binary` would produce. Neither is ever
 * produced for a file whose content git compared as text, which is what makes
 * reading the state off the patch a determination rather than an inference.
 */
function patchIsBinary(patch: string): boolean {
  return /^(Binary files .* differ|GIT binary patch)$/m.test(patch);
}

interface NumstatRecord {
  readonly path: string;
  readonly oldPath?: string;
  readonly binary: boolean;
  readonly addedLines?: number;
  readonly removedLines?: number;
}

/**
 * `git diff --numstat -z -M`, measured on 2026-09-11:
 *
 *     1\t0\tsrc/added.ts\0
 *     -\t-\tassets/logo.png\0
 *     0\t0\t\0src/renamed-old.ts\0src/renamed-new.ts\0
 *
 * A rename writes an empty path in the record and follows it with two more
 * NUL-terminated fields. That is why this walks fields rather than splitting
 * into records: the record length is not fixed, and a path containing a newline
 * or a quote — which `-z` exists to carry safely — must not be able to move the
 * boundary.
 */
function parseNumstat(output: string): readonly NumstatRecord[] | undefined {
  const fields = output.split('\0');
  const records: NumstatRecord[] = [];
  let index = 0;
  while (index < fields.length) {
    const field = fields[index] ?? '';
    // The output ends with a NUL, so the final split field is empty.
    if (field === '') {
      index += 1;
      continue;
    }
    const firstTab = field.indexOf('\t');
    const secondTab = firstTab < 0 ? -1 : field.indexOf('\t', firstTab + 1);
    if (secondTab < 0) return undefined;
    const added = field.slice(0, firstTab);
    const removed = field.slice(firstTab + 1, secondTab);
    const inlinePath = field.slice(secondTab + 1);
    const binary = added === '-' && removed === '-';
    const counts = binary ? {} : { addedLines: Number(added), removedLines: Number(removed) };
    if (inlinePath !== '') {
      records.push({ path: inlinePath, binary, ...counts });
      index += 1;
      continue;
    }
    const oldPath = fields[index + 1];
    const newPath = fields[index + 2];
    if (oldPath === undefined || newPath === undefined || oldPath === '' || newPath === '') return undefined;
    records.push({ path: newPath, oldPath, binary, ...counts });
    index += 3;
  }
  return records;
}

/**
 * Per-file patch byte sizes, from **one** whole-pair `git diff` rather than one invocation per
 * file.
 *
 * Why the sizes are wanted at all: the harness prints them in the investigation map so a model
 * choosing eight files to read can tell, before it asks, whether those eight fit the turn's prompt
 * budget (`../domain/harnessPromptBudget.ts`). Without them the only honest answer to "how big is
 * this read" is a round trip.
 *
 * Why this shape. Measured on this product's own 245-file change on 2026-09-11: one
 * `git diff --no-ext-diff --no-textconv --no-color -M <base>..<head>` takes **38 ms** and returns
 * 4,302,015 bytes, while diffing the 245 files one at a time takes **315 ms** for exactly the same
 * total. Splitting that one output is therefore both faster and, verified file by file across all
 * 245, byte-identical to what `readDiff` itself returns for each path — zero mismatches.
 *
 * Why by index rather than by name. Section headers carry paths, and a path with a space or a
 * quote in it is rendered quoted, so reading a name back out of a header is a parser this module
 * would have to get right for cases it cannot test. It does not need one: `--numstat` and the
 * plain diff are the same command over the same immutable pair with the same options, so they walk
 * the same diff queue in the same order. The two lists are zipped positionally and the count must
 * match exactly.
 *
 * **Fails to absent, never to wrong.** A size is optional metadata; a *wrong* size would send the
 * model's budget arithmetic off silently. A refused, bounded, or failed invocation, or a section
 * count that does not match the record count, produces no sizes at all. A single header whose text
 * does not contain its record's own path costs that one file its size and nothing more — the case
 * that actually arises is a path git renders quoted (one holding a quote or a newline), which is
 * exactly the file whose size matters least. Only when *most* headers fail is the zip itself in
 * doubt rather than the paths — a misalignment fails very nearly all of them, since no two records
 * in one manifest name the same path — and then every size is dropped.
 */
const PATCH_SIZE_MISMATCH_TOLERANCE = 0.5;
const DIFF_SECTION_MARKER = 'diff --git ';

function splitPatchSizes(patch: string, records: readonly NumstatRecord[]): readonly (number | undefined)[] | undefined {
  const starts: number[] = [];
  for (let at = patch.indexOf(DIFF_SECTION_MARKER); at >= 0; at = patch.indexOf(DIFF_SECTION_MARKER, at + 1)) {
    if (at === 0 || patch.charCodeAt(at - 1) === 10) starts.push(at);
  }
  if (starts.length !== records.length) return undefined;
  const sizes: (number | undefined)[] = [];
  let unmatched = 0;
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = index + 1 < starts.length ? starts[index + 1]! : patch.length;
    // The one cross-check a positional zip can afford: this section's header line must name the
    // path `--numstat` reported in the same position. An ordinary path appears in it literally; a
    // path git renders quoted does not appear in it at all, and loses its size rather than taking
    // a guessed one.
    const headerEnd = patch.indexOf('\n', start);
    const header = patch.slice(start, headerEnd < 0 ? end : headerEnd);
    const record = records[index]!;
    if (header.includes(record.path) || (record.oldPath !== undefined && header.includes(record.oldPath))) {
      sizes.push(Buffer.byteLength(patch.slice(start, end), 'utf8'));
    } else {
      unmatched += 1;
      sizes.push(undefined);
    }
  }
  return unmatched > starts.length * PATCH_SIZE_MISMATCH_TOLERANCE ? undefined : sizes;
}

interface StatusRecord {
  readonly path: string;
  readonly kind: ChangedFileKind;
}

/**
 * `git diff --name-status -z -M`, measured the same day:
 *
 *     M\0assets/logo.png\0  A\0src/added.ts\0  D\0src/gone.ts\0
 *     R100\0src/renamed-old.ts\0src/renamed-new.ts\0
 *
 * `R` and `C` carry a similarity score and two paths; every other letter carries
 * one. `T` is a type change — a file that became a symlink — and is reported as
 * modified, because that is what happened to the path and the neutral contract
 * has no fifth kind. `C` (a copy) is reported as added: the new path did not
 * exist at the base, which is the fact a reviewer needs, and no manifest entry
 * is dropped for want of a name for it.
 */
function parseNameStatus(output: string): readonly StatusRecord[] | undefined {
  const fields = output.split('\0');
  const records: StatusRecord[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? '';
    if (status === '') {
      index += 1;
      continue;
    }
    const letter = status[0];
    const takesTwoPaths = letter === 'R' || letter === 'C';
    const first = fields[index + 1];
    if (first === undefined || first === '') return undefined;
    if (takesTwoPaths) {
      const second = fields[index + 2];
      if (second === undefined || second === '') return undefined;
      records.push({ path: second, kind: letter === 'R' ? 'renamed' : 'added' });
      index += 3;
      continue;
    }
    const kind: ChangedFileKind = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    records.push({ path: first, kind });
    index += 2;
  }
  return records;
}

/** One match record from `git grep -z`: `<rev>:<path>\0<line>\0<text>\n` (measured). */
interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly excerpt: string;
}

/**
 * Walks `git grep -z` output byte-wise rather than splitting it into lines
 * first.
 *
 * The obvious parse — split on `\n`, then on `\0` — is wrong for exactly the
 * case `-z` was chosen to survive: a repository path containing a newline sits
 * inside the first field, before the first NUL, so splitting on newlines first
 * tears one record into two. So each record is read as: bytes up to the first
 * NUL (`<rev>:<path>`), bytes up to the second (the line number), then bytes up
 * to the newline (the matching line, which cannot itself contain one, because
 * grep matches lines).
 */
function parseGrepMatches(output: string, revision: string): readonly GrepMatch[] | undefined {
  const prefix = `${revision}:`;
  const matches: GrepMatch[] = [];
  let at = 0;
  while (at < output.length) {
    const firstNul = output.indexOf('\0', at);
    if (firstNul < 0) return undefined;
    const secondNul = output.indexOf('\0', firstNul + 1);
    if (secondNul < 0) return undefined;
    const endOfLine = output.indexOf('\n', secondNul + 1);
    if (endOfLine < 0) return undefined;
    const located = output.slice(at, firstNul);
    if (!located.startsWith(prefix)) return undefined;
    const line = Number(output.slice(firstNul + 1, secondNul));
    if (!Number.isInteger(line) || line < 1) return undefined;
    matches.push({ path: located.slice(prefix.length), line, excerpt: output.slice(secondNul + 1, endOfLine) });
    at = endOfLine + 1;
  }
  return matches;
}

/**
 * Undo git's C-style quoting of a path in a patch header.
 *
 * `core.quotePath=false` is pinned in the invocation builder, and it is not
 * enough here: it stops git escaping *non-ASCII* bytes, while a double quote, a
 * backslash and any control character are C-quoted in a diff header whatever
 * that setting says. Measured on 2026-09-11 with the pin applied:
 *
 *     +++ "b/src/we\"ird.ts"            the path contains a quote
 *     +++ "b/src/two\nlines.ts"         the path contains a newline
 *     +++ b/src/café.ts                 non-ASCII, left alone by the pin
 *
 * The quotes wrap the `a/`/`b/` prefix too, which is why this runs before the
 * prefix is stripped — on a quoted header the prefix is inside the quotes and a
 * `^b/` strip finds nothing to remove.
 *
 * Without this, a `searchDiff` match inside either of the first two files came
 * back with a `path` of `"b/src/we\"ird.ts"` — a string that names no file, so
 * the read the contract promises the position is sufficient for answers "no
 * such path". The manifest never had this problem: it is `-z` framed, and `-z`
 * turns quoting off entirely. A patch has no `-z` form, so it is undone here.
 *
 * Decoding goes through bytes rather than characters because `\ooo` escapes are
 * octal *bytes*: one non-ASCII character can arrive as three of them, and
 * decoding each separately would produce three replacement characters instead
 * of the one character they spell.
 */
const C_QUOTE_ESCAPES: Readonly<Record<string, number>> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  '\\': 0x5c,
  '"': 0x22,
};

function unquoteCStylePath(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  const body = value.slice(1, -1);
  const bytes: number[] = [];
  const pushText = (text: string): void => {
    for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
  };
  let plainFrom = 0;
  let at = 0;
  while (at < body.length) {
    if (body[at] !== '\\') {
      at += 1;
      continue;
    }
    // Whole runs at a time, so a character made of two UTF-16 code units is
    // never split down the middle and re-encoded as two replacements.
    if (at > plainFrom) pushText(body.slice(plainFrom, at));
    const escaped = body[at + 1];
    if (escaped === undefined) {
      at += 1;
      plainFrom = at;
      break;
    }
    const simple = C_QUOTE_ESCAPES[escaped];
    if (simple !== undefined) {
      bytes.push(simple);
      at += 2;
    } else if (escaped >= '0' && escaped <= '7') {
      bytes.push(parseInt(body.slice(at + 1, at + 4), 8) & 0xff);
      at += 4;
    } else {
      // Not an escape git produces. Keep the character rather than drop it.
      pushText(escaped);
      at += 2;
    }
    plainFrom = at;
  }
  if (plainFrom < body.length) pushText(body.slice(plainFrom));
  return Buffer.from(bytes).toString('utf8');
}

/** One line of a unified diff, placed where it really sits in the file it belongs to. */
interface LocatedDiffLine {
  readonly path: string;
  readonly oldPath?: string;
  readonly side: 'old' | 'new';
  readonly line: number;
  readonly content: string;
}

/**
 * Reads a whole-comparison patch into lines that know where they are (task 8.5).
 *
 * Two things separate this from the providers' `linesFromUnifiedDiff`, and both
 * are only possible because the patch here is git's own complete output rather
 * than a per-file fragment a forge served.
 *
 * *Positions are real.* The hunk header `@@ -a,b +c,d @@` states the first line
 * number on each side, so a match can be reported at the line it is actually on
 * instead of at its index within a reconstructed list. A citation anchors to a
 * line number; an index is not one.
 *
 * *Only lines inside a hunk are scanned.* `diff --git a/x b/y`, `index …`,
 * `similarity index`, `rename from/to` and `Binary files a/x and b/x differ` are
 * all lines of the patch that are not lines of any file. The providers' helper
 * keeps them, so on either of them a search for `logo.png` matches the binary
 * file's own marker line and reports a hit inside a file nobody can read. Here
 * everything outside a hunk is skipped, which also means a binary file
 * contributes nothing to a search without needing a rule of its own.
 *
 * Paths come from the `---`/`+++` lines rather than from `diff --git a/x b/y`,
 * which is ambiguous for a path containing a space. `diff.noprefix=false` is
 * pinned in the invocation builder, so the `a/`/`b/` prefixes are always there.
 */
function locatedDiffLines(patch: string): readonly LocatedDiffLine[] {
  const located: LocatedDiffLine[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const raw of patch.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      oldPath = undefined;
      newPath = undefined;
      inHunk = false;
      continue;
    }
    if (raw.startsWith('--- ')) {
      const value = unquoteCStylePath(raw.slice(4));
      oldPath = value === '/dev/null' ? undefined : value.replace(/^a\//, '');
      inHunk = false;
      continue;
    }
    if (raw.startsWith('+++ ')) {
      const value = unquoteCStylePath(raw.slice(4));
      newPath = value === '/dev/null' ? undefined : value.replace(/^b\//, '');
      inHunk = false;
      continue;
    }
    if (raw.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (!header) {
        inHunk = false;
        continue;
      }
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // "\ No newline at end of file" annotates the line before it and is not a
    // line of either file, so it advances neither counter.
    if (raw.startsWith('\\')) continue;
    const marker = raw[0];
    const content = raw.slice(1);
    if (marker === '+') {
      if (newPath !== undefined) located.push({ path: newPath, oldPath, side: 'new', line: newLine, content });
      newLine += 1;
      continue;
    }
    if (marker === '-') {
      if (oldPath !== undefined) located.push({ path: newPath ?? oldPath, oldPath, side: 'old', line: oldLine, content });
      oldLine += 1;
      continue;
    }
    if (marker === ' ') {
      if (newPath !== undefined) located.push({ path: newPath, oldPath, side: 'new', line: newLine, content });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    // Anything else ends the hunk: the next file's header, or the end of the patch.
    inHunk = false;
  }
  return located;
}

// ---- The source -------------------------------------------------------------------

export function createLocalGitSource(options: LocalGitSourceOptions): InvestigationSource {
  const policy = normalizeLocalGitPolicy(options.policy ?? {});
  const run: GitRunner = options.run ?? runGitInvocation;
  const context: GitProcessContext = {
    gitDir: options.gitDir,
    bounds: gitBoundsFromPolicy(policy),
    proxyUrl: options.proxyUrl,
    executable: options.executable,
    // No credential: nothing this source runs talks to a remote. Acquisition
    // did that, under its own lock, before any of these operations existed.
  };

  async function invoke(operation: GitOperation, boundedReason: string): Promise<Answer> {
    const planned = planGitInvocation(operation);
    if (!planned.ok) return { kind: 'refused', reason: planned.refusal.reason };
    const outcome = await run(planned.plan, context);
    switch (outcome.state) {
      case 'ok':
        return { kind: 'ok', stdout: outcome.stdout };
      case 'failed':
        return { kind: 'failed', exitCode: outcome.exitCode };
      case 'timedOut':
      case 'outputCapped':
      case 'unavailable':
        return { kind: 'bounded', reason: boundedReason };
    }
  }

  /**
   * Whether a pinned commit is really in this store, asked every time it matters.
   *
   * It exists to disambiguate one exit status. `git show` and `git diff` both
   * exit 128 for a path that is not there *and* for a revision that is not
   * there, and the two need opposite answers: a missing path is `notFound`,
   * which the harness closes the file on, while a missing revision is `unknown`,
   * which leaves it re-readable — and marking a file permanently uninspectable
   * because the commit it lives in is not in the store right now is precisely
   * the failure this change exists to remove.
   *
   * The alternative is reading git's error text, which `objectAcquisition.ts`
   * refuses for the same reason this does: that wording is not a contract across
   * git versions, and it is raw platform text bound for the model. Asking is
   * cheap and unambiguous. `undefined` means the question itself could not be
   * answered — the verification hit a bound — and the caller must not conclude
   * anything from it.
   *
   * **Asked again every time, deliberately.** An earlier version remembered the
   * answer for the life of the source, and a remembered `true` outlives the store
   * it was true of: eviction deletes whole directories (design D3) and an
   * attempt's lease can go stale while it is still reading, so a store that
   * answered once can be gone by the next read. A stale `true` then sends every
   * later failure to the caller's *fallback* state — `notFound` for `readFile`,
   * an absence nobody established — instead of naming the revision. The memo
   * bought one `rev-parse` per failed read and nothing at all on the path that
   * succeeds: this runs only when git has already failed.
   */
  async function commitIsPresent(commit: GitObjectId): Promise<boolean | undefined> {
    const answer = await invoke({ kind: 'verifyCommit', revision: commit }, REASONS.revisionUnresolvable);
    if (answer.kind === 'bounded') return undefined;
    // A refusal here means the value was never an object id, which the caller
    // has already been told; either way this commit is not readable.
    return answer.kind === 'ok' && answer.stdout.toString('utf8').trim() !== '';
  }

  /**
   * Turn a `failed` invocation into the honest state, by asking about the
   * revisions rather than by reading git's complaint.
   *
   * `unavailable` is deliberately not one of the answers. A revision the store
   * cannot resolve is repairable by the next acquisition and says nothing about
   * the file, and design D8's invariant lists an unobtainable revision among the
   * conditions that must leave a file classified and uninspected — which in the
   * harness's read switch means anything except `unavailable`, `binary`,
   * `tooLarge` or `notFound`.
   */
  type ExplainedFailure =
    | { readonly state: 'notFound'; readonly reason: string }
    | { readonly state: 'unknown'; readonly reason: string };

  async function explainFailure(
    revisions: readonly GitObjectId[],
    /**
     * What it means when the revisions are all there and git still failed.
     * `notFound` only where a present revision and a failed read of one path
     * really does establish that the path is not there, which is `readFile` at
     * one revision and nothing else. `unknown` everywhere else: a search that did
     * not run has said nothing about what is in the revision, and neither has a
     * diff that would not render for a path the manifest already enumerated —
     * calling either `notFound` would report an absence nobody established.
     */
    fallback: { readonly state: 'notFound' | 'unknown'; readonly reason: string },
    boundedReason: string,
  ): Promise<ExplainedFailure> {
    for (const revision of revisions) {
      const present = await commitIsPresent(revision);
      if (present === undefined) return { state: 'unknown', reason: boundedReason };
      if (!present) return { state: 'unknown', reason: REASONS.revisionUnresolvable };
    }
    return fallback;
  }

  /**
   * Is this request one this source may answer at all?
   *
   * The repository check is the contract's "every result names the repository
   * and revision pair the request carried" turned into a refusal: this store
   * holds one repository's objects, so a request naming another one cannot be
   * answered truthfully and is not answered at all. The revisions are validated
   * by the invocation builder a moment later; nothing here duplicates that.
   */
  function refuseSnapshot(snapshot: InvestigationSnapshotRef): string | undefined {
    return snapshot.repoId === options.repoId ? undefined : REASONS.otherRepository;
  }

  // ---- The manifest, computed once per pinned pair --------------------------------
  //
  // The pair is immutable by construction — two commit ids, content-addressed,
  // in an append-only object database this attempt holds a lease on — so the
  // manifest for it cannot change while this source exists. `readDiff` needs it
  // for two things it must not guess (whether a path is binary, and what a
  // renamed file's old path was), and recomputing it per file would spend two
  // invocations per read on an answer that cannot have changed.
  //
  // Only a manifest both invocations answered in full is remembered. A stop at
  // a bound is not an answer and is never cached as one.

  type ManifestOutcome =
    | { readonly kind: 'ok'; readonly entries: readonly ChangedFileEntry[] }
    | { readonly kind: 'unavailable'; readonly reason: string }
    | { readonly kind: 'unknown'; readonly reason: string };

  /** Two, because a source serves one member; a third pair means someone re-pinned and the oldest is the one to drop. */
  const MANIFEST_MEMO_LIMIT = 2;
  const manifestMemo = new Map<string, readonly ChangedFileEntry[]>();

  async function manifestFor(snapshot: InvestigationSnapshotRef): Promise<ManifestOutcome> {
    const key = `${snapshot.baseSha}..${snapshot.headSha}`;
    const remembered = manifestMemo.get(key);
    if (remembered) return { kind: 'ok', entries: remembered };

    const base = snapshot.baseSha;
    const head = snapshot.headSha;
    const counts = await invoke({ kind: 'changedFiles', base, head }, REASONS.boundedManifest);
    if (counts.kind === 'refused') return { kind: 'unavailable', reason: counts.reason };
    if (counts.kind === 'bounded') return { kind: 'unknown', reason: counts.reason };
    if (counts.kind === 'failed') {
      const explained = await explainFailure([base, head], { state: 'unknown', reason: REASONS.manifestUnreadable }, REASONS.boundedManifest);
      return { kind: 'unknown', reason: explained.reason };
    }

    const kinds = await invoke({ kind: 'changedFileStatus', base, head }, REASONS.boundedManifest);
    if (kinds.kind === 'refused') return { kind: 'unavailable', reason: kinds.reason };
    if (kinds.kind === 'bounded') return { kind: 'unknown', reason: kinds.reason };
    if (kinds.kind === 'failed') {
      const explained = await explainFailure([base, head], { state: 'unknown', reason: REASONS.manifestUnreadable }, REASONS.boundedManifest);
      return { kind: 'unknown', reason: explained.reason };
    }

    const numstat = parseNumstat(counts.stdout.toString('utf8'));
    const statuses = kinds.kind === 'ok' ? parseNameStatus(kinds.stdout.toString('utf8')) : undefined;
    if (!numstat || !statuses) return { kind: 'unknown', reason: REASONS.manifestUnreadable };

    // A third invocation, and the cheapest of the three: one whole-pair diff, split positionally
    // for the per-file patch sizes the harness's prompt budget needs (`splitPatchSizes`). It
    // shares this function's memo, so a manifest read once costs it once for the life of the
    // attempt. A bound, a refusal or a failure here costs the sizes and nothing else — the
    // manifest is still served, exactly as it was before sizes existed.
    const whole = await invoke({ kind: 'searchDiff', base, head }, REASONS.boundedDiff);
    const patchSizes = whole.kind === 'ok' ? splitPatchSizes(whole.stdout.toString('utf8'), numstat) : undefined;

    const kindByPath = new Map(statuses.map((record) => [record.path, record.kind] as const));
    const entries: ChangedFileEntry[] = [];
    for (const [index, record] of numstat.entries()) {
      const kind = kindByPath.get(record.path);
      // Two readings of one comparison, with one set of options, over two
      // immutable commits: they cannot legitimately disagree about which paths
      // changed. If they ever do, the honest answer is that this manifest could
      // not be read — not an invented kind for the entry, and never a silently
      // dropped file, which is the shape of failure this whole change exists to
      // remove.
      if (kind === undefined) return { kind: 'unknown', reason: REASONS.manifestUnreadable };
      // A changed file whose name this source will not pass to git is enumerated
      // here — it really did change — and marked as content this source did not
      // serve, which is what `contentDeclined` means (design D6, task 3.2). The
      // flag is set at manifest time rather than at the first read of the file
      // because that is where it is knowable: the inventory copies it when the
      // file is classified, so the completion gate names the file even if the
      // model never asks for it.
      //
      // Never together with `binary`, which `ChangedFileEntry` forbids and which
      // would be the wrong answer anyway: git determined that file's content
      // from the content, the determination stands whatever its name is, and a
      // binary file has no diff for any source to serve.
      const declined = !record.binary && entryPathRefusal(record) !== undefined;
      entries.push({
        path: record.path,
        ...(record.oldPath === undefined ? {} : { oldPath: record.oldPath }),
        kind,
        // Git's own determination, and the only thing allowed to set this.
        binary: record.binary,
        ...(declined ? { contentDeclined: true } : {}),
        ...(record.addedLines === undefined ? {} : { addedLines: record.addedLines }),
        ...(record.removedLines === undefined ? {} : { removedLines: record.removedLines }),
        ...(patchSizes?.[index] === undefined ? {} : { byteSize: patchSizes[index] }),
      });
    }

    if (manifestMemo.size >= MANIFEST_MEMO_LIMIT) {
      const oldest = manifestMemo.keys().next();
      if (!oldest.done) manifestMemo.delete(oldest.value);
    }
    manifestMemo.set(key, entries);
    return { kind: 'ok', entries };
  }

  // ---- The five operations ----------------------------------------------------------

  async function listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
    const { snapshot } = request;
    const refusal = refuseSnapshot(snapshot);
    if (refusal) return { snapshot, state: 'unavailable', reason: refusal };

    const manifest = await manifestFor(snapshot);
    if (manifest.kind === 'unavailable') return { snapshot, state: 'unavailable', reason: manifest.reason };
    if (manifest.kind === 'unknown') return { snapshot, state: 'unknown', reason: manifest.reason };

    const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.manifests.pageBound?.maxPageSize ?? MANIFEST_PAGE_FILES;
    const { page, nextCursor } = paginateArray(manifest.entries, request.cursor, bound);
    if (nextCursor) return { snapshot, state: 'paginated', value: page, cursor: nextCursor };
    // There is no `truncated` here and there cannot be. A forge reports one
    // when it stopped enumerating; git compared two trees and enumerated all of
    // it, so a page that is the last page is the end of a complete enumeration.
    return { snapshot, state: 'complete', value: page };
  }

  async function readDiff(request: DiffPageRequest): Promise<DiffPageResult> {
    const { snapshot } = request;
    const refusal = refuseSnapshot(snapshot);
    if (refusal) return { snapshot, state: 'unavailable', reason: refusal };

    // The path rule decides one thing on its own — this string never becomes a
    // git argument — and that is unchanged: the only invocations below are this
    // source's own manifest commands, built from the two pinned shas and
    // carrying no pathspec at all (task 6.13's guarantee, asserted over
    // `recorded` in `localGitSource.test.ts`). What the rule cannot decide alone
    // is the *state*, and the two it has to choose between are opposites: a
    // refused path naming nothing in this change is a request this source will
    // never make (`unavailable`), while a refused path naming a file the change
    // really touched is content this source declines to serve
    // (`contentDeclined`, below). Only the manifest knows which one arrived, and
    // it is memoized per pinned pair, so in the flow that actually happens — the
    // harness lists a member's changed files before reading any of them — asking
    // costs nothing.
    const pathRefusal = refusePath(request.path);

    const manifest = await manifestFor(snapshot);
    if (manifest.kind !== 'ok') {
      // A refusal is true whatever the manifest says, so a manifest that could
      // not be read never replaces it with something weaker.
      if (pathRefusal) return { snapshot, state: 'unavailable', reason: pathRefusal.reason };
      if (manifest.kind === 'unavailable') return { snapshot, state: 'unavailable', reason: manifest.reason };
      return { snapshot, state: 'unknown', reason: manifest.reason };
    }

    // Either side of a rename names the same change, as on both providers.
    const entry = manifest.entries.find((file) => file.path === request.path || file.oldPath === request.path);
    if (!entry) {
      // A refused path that this change does not contain gets the rule's own
      // reason rather than "there is no such path" — true of the change, and
      // the wrong thing to tell a caller that sent something no read here could
      // ever answer.
      if (pathRefusal) return { snapshot, state: 'unavailable', reason: pathRefusal.reason };
      return { snapshot, state: 'notFound', reason: REASONS.noSuchPath };
    }
    if (entry.binary) return { snapshot, state: 'binary' };
    if (entry.contentDeclined === true) {
      // A file that changed and whose name this source will not pass to git —
      // the header's "One limitation, settled rather than patched". The state
      // has to be this one: `unavailable` is closed terminally and irreversibly
      // by `harnessAttempt.ts`, and it would claim the content could not be
      // obtained, when what happened is that this host would not ask for it.
      const refused = entryPathRefusal(entry);
      return { snapshot, state: 'contentDeclined', reason: `${refused ? `${refused.reason} ` : ''}${REASONS.declinedPath}` };
    }

    const answer = await invoke(
      {
        kind: 'diffFile',
        base: snapshot.baseSha,
        head: snapshot.headSha,
        path: entry.path,
        ...(entry.oldPath === undefined ? {} : { oldPath: entry.oldPath }),
      },
      REASONS.boundedDiff,
    );
    if (answer.kind === 'refused') return { snapshot, state: 'unavailable', reason: answer.reason };
    if (answer.kind === 'bounded') return { snapshot, state: 'unknown', reason: answer.reason };
    if (answer.kind === 'failed') {
      // The fallback is `unknown`, not `notFound`. Reaching this line means the
      // manifest enumerated this path a moment ago, so a failed diff of it does
      // not establish that it is absent — a store missing a tree or a blob
      // (eviction interrupted partway) fails exactly here with both commits
      // still resolvable, and `notFound` is the one non-`complete` state the
      // harness closes a file with on `readDiff`. Task 10.6's invariant, in one
      // line: no state the source did not prove.
      const explained = await explainFailure([snapshot.baseSha, snapshot.headSha], { state: 'unknown', reason: REASONS.diffUnreadable }, REASONS.boundedDiff);
      return { snapshot, state: explained.state, reason: explained.reason };
    }

    const patch = answer.stdout.toString('utf8');
    // The manifest already said so from `--numstat`; this is the same
    // determination read where the content was actually rendered, so the two
    // cannot drift apart unnoticed.
    if (patchIsBinary(patch)) return { snapshot, state: 'binary' };

    const pageBound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.diffReads.pageBound;
    const { page, nextCursor } = paginateLines(
      patch.split('\n'),
      request.cursor,
      pageBound?.maxPageSize ?? READ_PAGE_LINES,
      pageBound?.maxPageBytes ?? Number.MAX_SAFE_INTEGER,
    );
    const value: DiffPage = {
      path: entry.path,
      ...(entry.kind === 'renamed' && entry.oldPath !== undefined ? { oldPath: entry.oldPath, isRenamed: true } : {}),
      patch: page.join('\n'),
      // Empty, as on both providers. A position per line would multiply a
      // 20,000-line page by a factor the declared byte bound does not count,
      // and the page's own hunk headers already carry where its lines sit.
      //
      // That last clause was a claim about a reader that did not exist. The
      // evidence ledger took a diff page's citable spans from this field alone,
      // so an empty one meant "no line of this page may be cited", and every
      // finding a real review submitted was rejected with `pathMismatch` for the
      // very file it had just read. `../app/harnessEvidenceLedger.ts`'s
      // `diffPatchLocations` now reads the hunk headers this comment always
      // assumed someone read; leaving this empty is therefore a statement that
      // the patch speaks for itself, not that nothing here is citable.
      positions: [],
    };
    if (nextCursor) return { snapshot, state: 'paginated', value, cursor: nextCursor };
    return { snapshot, state: 'complete', value };
  }

  async function readFile(request: FileRangeRequest): Promise<FileRangeResult> {
    const { snapshot } = request;
    const refusal = refuseSnapshot(snapshot);
    if (refusal) return { snapshot, state: 'unavailable', reason: refusal };

    const revision = request.revision === 'base' ? snapshot.baseSha : snapshot.headSha;
    const answer = await invoke({ kind: 'fileAtRevision', revision, path: request.path }, REASONS.boundedFile);
    if (answer.kind === 'refused') return { snapshot, state: 'unavailable', reason: answer.reason };
    if (answer.kind === 'bounded') return { snapshot, state: 'unknown', reason: answer.reason };
    if (answer.kind === 'failed') {
      const explained = await explainFailure([revision], { state: 'notFound', reason: REASONS.noSuchPath }, REASONS.boundedFile);
      return { snapshot, state: explained.state, reason: explained.reason };
    }

    // `git show <rev>:<dir>` succeeds and prints `tree <rev>:<dir>` then a blank
    // line then the directory's entries (measured). That is not file content
    // and must not be returned as any. The prefix is compared exactly, against
    // the object name this source composed itself, so nothing is being guessed
    // from the shape of the output.
    const content = answer.stdout;
    if (content.subarray(0, Buffer.byteLength(`tree ${revision}:${request.path}\n\n`)).toString('utf8') === `tree ${revision}:${request.path}\n\n`) {
      return { snapshot, state: 'notFound', reason: REASONS.notAFile };
    }
    if (looksBinaryToGit(content)) return { snapshot, state: 'binary', byteSize: content.length };

    const lines = content.toString('utf8').split('\n');
    const start = Math.max(1, request.startLine);
    if (start > lines.length) return { snapshot, state: 'notFound', reason: REASONS.startBeyondFile };
    // At least one line: a request whose end is before its start is malformed,
    // and the useful reading of it is the line it started at, not an empty range
    // whose `endLine` sits behind its `startLine`.
    const availableEnd = Math.max(start, Math.min(request.endLine, lines.length));
    const pageBound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.fileReads.pageBound;
    const lineBound = pageBound?.maxPageSize ?? READ_PAGE_LINES;
    const lineBoundedEnd = Math.min(availableEnd, start + lineBound - 1);
    // The same pager as the diff, so one line bound and one byte bound are
    // honoured in one place rather than two that can drift.
    const { page } = paginateLines(lines, String(start - 1), lineBoundedEnd - start + 1, pageBound?.maxPageBytes ?? Number.MAX_SAFE_INTEGER);
    const boundedEnd = start - 1 + page.length;
    const value: FileRange = {
      revision: request.revision,
      path: request.path,
      startLine: start,
      endLine: boundedEnd,
      text: page.join('\n'),
    };
    if (boundedEnd < availableEnd) return { snapshot, state: 'truncated', value, knownRemainingUnits: availableEnd - boundedEnd };
    return { snapshot, state: 'complete', value };
  }

  async function searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
    const { snapshot } = request;
    const refusal = refuseSnapshot(snapshot);
    if (refusal) return { snapshot, state: 'unavailable', reason: refusal };

    const revision = request.revision === 'base' ? snapshot.baseSha : snapshot.headSha;
    // `pathScope` is filtered here and is deliberately not passed to git as a
    // pathspec. The neutral field means what it means on both providers — a
    // prefix of the path string — and a literal pathspec means something else:
    // `src/ke` matches the file `src/ke` and everything under a directory
    // `src/ke`, so as a pathspec it would answer a scope of `src/ke` with
    // nothing at all. Answering a different question quietly is worse than
    // scanning a tree that is already on local disk.
    const answer = await invoke({ kind: 'searchRepository', revision, query: request.query }, REASONS.boundedSearch);
    if (answer.kind === 'refused') return { snapshot, state: 'unavailable', reason: answer.reason };
    if (answer.kind === 'bounded') return { snapshot, state: 'unknown', reason: answer.reason };
    if (answer.kind === 'failed') {
      const explained = await explainFailure([revision], { state: 'unknown', reason: REASONS.searchNotRun }, REASONS.boundedSearch);
      return { snapshot, state: explained.state, reason: explained.reason };
    }

    const parsed = parseGrepMatches(answer.stdout.toString('utf8'), revision);
    if (!parsed) return { snapshot, state: 'unknown', reason: REASONS.boundedSearch };
    const scoped: SearchMatch[] = parsed
      .filter((match) => !request.pathScope || match.path.startsWith(request.pathScope))
      .map((match) => ({ path: match.path, line: match.line, excerpt: match.excerpt }));

    const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.repositorySearch.pageBound?.maxPageSize ?? SEARCH_PAGE_MATCHES;
    const { page, nextCursor } = paginateArray(scoped, request.cursor, bound);
    if (nextCursor) return { snapshot, state: 'paginated', value: page, cursor: nextCursor };
    return { snapshot, state: 'complete', value: page };
  }

  async function searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult> {
    const { snapshot } = request;
    const refusal = refuseSnapshot(snapshot);
    if (refusal) return { snapshot, state: 'unavailable', reason: refusal };

    // The query never reaches a git argument for this operation. `git diff -G`
    // selects whole files by a regular expression compiled from the caller's
    // string, which is neither the literal match the contract promises nor the
    // per-line position the result carries — so the diff is computed and the
    // matching happens here (design D7, task 8.5).
    const answer = await invoke({ kind: 'searchDiff', base: snapshot.baseSha, head: snapshot.headSha }, REASONS.boundedSearch);
    if (answer.kind === 'refused') return { snapshot, state: 'unavailable', reason: answer.reason };
    if (answer.kind === 'bounded') return { snapshot, state: 'unknown', reason: answer.reason };
    if (answer.kind === 'failed') {
      const explained = await explainFailure([snapshot.baseSha, snapshot.headSha], { state: 'unknown', reason: REASONS.searchNotRun }, REASONS.boundedSearch);
      return { snapshot, state: explained.state, reason: explained.reason };
    }

    const matches: DiffSearchMatch[] = [];
    for (const line of locatedDiffLines(answer.stdout.toString('utf8'))) {
      if (request.pathScope && !line.path.startsWith(request.pathScope)) continue;
      if (!line.content.includes(request.query)) continue;
      matches.push({
        position: {
          path: line.path,
          ...(line.oldPath === undefined || line.oldPath === line.path ? {} : { oldPath: line.oldPath }),
          side: line.side,
          line: line.line,
        },
        excerpt: line.content.trim(),
      });
    }

    // Scanning past the bound costs nothing once the patch is in memory, and it
    // lets the count of what was left out be exact — so a short page reads as
    // "there are more" rather than as "that is all".
    const bound = LOCAL_GIT_INVESTIGATION_CAPABILITIES.diffSearch.pageBound?.maxPageSize ?? SEARCH_PAGE_MATCHES;
    if (matches.length > bound) {
      return { snapshot, state: 'truncated', value: matches.slice(0, bound), knownRemainingUnits: matches.length - bound };
    }
    return { snapshot, state: 'complete', value: matches };
  }

  return {
    capabilities: LOCAL_GIT_INVESTIGATION_CAPABILITIES,
    listChangedFiles,
    readDiff,
    readFile,
    searchRepository,
    searchDiff,
  };
}
