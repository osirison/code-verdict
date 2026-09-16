/**
 * The one place this project runs git — task group 6 of
 * `add-local-git-investigation`, design.md D7.
 *
 * **Why this module is shaped like a builder instead of a helper.** The paths
 * and search queries that reach the local investigation source are supplied by
 * the model, and the model is steerable by change-request text this project
 * already treats as untrusted. No shell is involved and none is needed: git's
 * own options are the attack surface. Measured against a real two-commit
 * repository on 2026-09-10, repeated here on 2026-09-11:
 *
 *     git diff --numstat -M <base>..<head> '--output=/tmp/pwned.txt'
 *         -> exit 0, 31 bytes written to /tmp/pwned.txt
 *     git diff --numstat -M <base>..<head> -- '--output=/tmp/pwned.txt'
 *         -> exit 0, no file, the value read as a path that matches nothing
 *
 *     git grep -F '-v' <head>          (query in the pattern position)
 *         -> '-v' parsed as invert-match, <head> parsed as the pattern,
 *            every line of every file printed
 *     git grep -F -e '-v' <head> --    (query after -e)
 *         -> exit 1, no output
 *
 * One missing `--` turns a read into an arbitrary file write; one missing `-e`
 * turns a search into a dump of the whole tree. A rule that every future call
 * site has to remember is not a rule, so the rule here is structural:
 *
 * - A caller describes an operation (`GitOperation`) with paths, queries and
 *   revisions as typed fields. It never positions an argument, because it never
 *   supplies an argument list.
 * - `planGitInvocation` validates every field and lays the arguments out. It is
 *   the only producer of a `GitInvocationPlan`, and `GitInvocationPlan` is a
 *   class with a private field whose value is not exported — so no object
 *   literal outside this file can be typed as one. `runGitInvocation` accepts
 *   nothing else. The unsafe call cannot be written, not merely discouraged.
 * - There is no shell anywhere: `spawn` with an argument array, no `exec`, no
 *   `shell: true`. `gitInvocation.structural.test.ts` asserts that over this
 *   module's own syntax tree, and over every other module in `src/`.
 *
 * The only string composition in this file happens over values that have
 * already passed `isFullObjectId` — which admits nothing but lowercase hex — or
 * over constants. Nothing model-supplied is ever concatenated into an argument.
 */
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isFetchableObjectSourceUrl } from '../platform/types';

// ---- What a caller may ask for ------------------------------------------------
//
// One variant per thing this project runs. Five of them are the five neutral
// investigation operations (`InvestigationOperations` in
// `../platform/types.ts`); the rest are the object-store operations design D3
// needs. Adding another one means adding it here, which is the point: a later
// group that wants to run git has to come through this file, and the structural
// test fails if it spawns its own.

/** A full hex object id — never a ref name, never an abbreviation (task 6.3). */
export type GitObjectId = string;

export type GitOperation =
  /** `git --version`, for the once-per-session support probe (task 6.9). */
  | { readonly kind: 'version' }
  /** Create the per-repository bare object store (design D3; used by task 7.1). */
  | { readonly kind: 'initBare' }
  /**
   * Read back a repository's own configuration — the keys in `$GIT_DIR/config`
   * and nothing else.
   *
   * `cacheRepository.ts` uses it to check that a cache directory carries only
   * settings this extension wrote. That check exists because the repository's
   * own config is the one configuration surface the environment cannot close:
   * `-c` beats it for every key we can name (see `commonArguments`), and this
   * is how the keys nobody thought to name are found instead of guessed at.
   *
   * Measured on 2026-09-11: `--list --local` reports the file's own keys, does
   * not report the `-c` overrides this seam adds, and does **not** expand an
   * `include.path` into the keys it pulls in — while those keys do take effect.
   * So an include is visible as one key and has to be refused as one, which is
   * why the allowlist over there admits no `include`.
   */
  | { readonly kind: 'listRepositoryConfig' }
  /**
   * Prove an object id names a commit that is actually present. Every
   * acquisition ends with this (design D3, task 7.4): a remote that answered
   * with a different object must never be believed.
   */
  | { readonly kind: 'verifyCommit'; readonly revision: GitObjectId }
  /**
   * Read what the local ref for a pinned commit currently points at, or nothing
   * if there is no such ref (task 7.3).
   *
   * Presence in the cache is two facts, not one: the object is there, and it is
   * reachable from the ref named after it. `verifyCommit` answers the first;
   * this answers the second. A dangling object is prunable, so an acquisition
   * that checked only the object could skip a fetch for a commit that is about
   * to disappear.
   *
   * The caller supplies an object id and never a ref name — the name is derived
   * here by `localRefForCommit`, from a value that has already passed the hex
   * validator. There is deliberately no operation in this module that reads a
   * ref a caller named.
   */
  | { readonly kind: 'readCommitRef'; readonly commit: GitObjectId }
  /**
   * Remove that ref again, for the one case that produces a ref which lies: a
   * ref-hint fetch (design D8) writes `refs/codeverdict/<pinned>` from whatever
   * the hint resolved to on the remote, which the verification afterwards may
   * find is a different commit. Leaving it would keep the wrong commit's objects
   * reachable under the pinned commit's name.
   */
  | { readonly kind: 'deleteCommitRef'; readonly commit: GitObjectId }
  /**
   * Pin a commit this store already holds under its own
   * `refs/codeverdict/<sha>`, with no network involved.
   *
   * One caller: the merge base, once git has computed it. It arrives reachable
   * only from the target branch's fetched ref, which the next attempt's fetch
   * will move — so without a ref of its own the commit a review is pinned to
   * would be one `git gc` away from gone. Pinning it makes the base exactly as
   * durable as the head, under the same naming rule, and makes the ordinary
   * "is this commit held" check answer for it too.
   */
  | { readonly kind: 'writeCommitRef'; readonly commit: GitObjectId }
  /**
   * Obtain one pinned commit, and — when the caller is computing a merge base —
   * the ref that change request targets, in the same round trip.
   *
   * `refHint` replaces the bare object id in the commit's refspec on the retry
   * design D8 describes; the object that arrives is verified by id afterwards,
   * which is what makes an opaque hint safe. `targetRef` is the same kind of
   * value: a ref name the provider composed, passed through verbatim, never
   * parsed here, and validated by the same rule as the hint.
   *
   * **Both refspecs go in one invocation on purpose.** A merge base needs
   * history on both sides, so the two are always wanted together and at the
   * same depth; issuing them separately would pay two network round trips for
   * one question, measured at 1.6-2.9 s each against a real remote, and would
   * let the two sides end up at different shallow boundaries.
   */
  | {
      readonly kind: 'fetchCommit';
      readonly fetchUrl: string;
      readonly commit: GitObjectId;
      readonly depth: number;
      readonly refHint?: string;
      readonly targetRef?: string;
    }
  /**
   * Where two revisions' histories meet — the merge base a change request's
   * diff is actually against (task 2 of the local-investigation follow-up).
   *
   * This replaces asking the forge for it. GitHub reported it as
   * `merge_base_commit.sha` on the compare response and GitLab as
   * `diff_refs.base_sha`; both are the forge computing something git computes
   * exactly, from objects this extension already holds. Exits non-zero with no
   * output when the two have no common ancestor *within the history that was
   * fetched*, which is why the caller deepens and asks again rather than
   * concluding anything from one failure.
   *
   * **A non-empty answer is not a right answer either.** This computes over the
   * history the store holds, and it cannot say which of the two it computed
   * over: a shallow store returns an older common ancestor, with exit 0 and an
   * object id, when the real merge base sits past the shallow boundary.
   * Measured on 2026-09-11, git 2.55.0, against a `git-http-backend` remote,
   * through `createObjectCache` with the default policy, on a head that is a
   * merge commit reaching an older common ancestor in two steps while its true
   * merge base sits fourteen commits back:
   *
   *     DEFAULT-POLICY OUTCOME {"state":"acquired","baseSha":"4dd2d4b…","depthReached":10}
   *     TRUE MERGE BASE = 542cc47…   ACCEPTED BASE = 4dd2d4b…
   *
   * So the caller proves the answer before accepting it, with
   * `parentlessCommitsAbove` and `readCommitObject` below —
   * `objectAcquisition.ts` states the rule and why it is sufficient.
   */
  | { readonly kind: 'mergeBase'; readonly left: GitObjectId; readonly right: string }
  /**
   * Whether this store still has a shallow boundary at all.
   *
   * The stop condition for deepening. Measured on 2026-09-11 against a
   * 131-commit repository: a fetch at `--depth=160` and one at `--depth=640`
   * both returned the entire history and the same 3.41 MB, and afterwards
   * `rev-parse --is-shallow-repository` answered `false` for both. So once it
   * answers `false`, a further deepening cannot add a commit, and a merge base
   * that is still missing is missing from the whole history rather than from
   * the part that was fetched — a different fact, which deserves a different
   * reason.
   */
  | { readonly kind: 'isShallow' }
  /**
   * Which commits *above* a candidate merge base this store sees as having no
   * parents — the frontier the merge-base proof is read off
   * (`objectAcquisition.ts`'s own note on why a non-empty merge base is not
   * evidence).
   *
   * `--max-parents=0` over the two tips, excluding everything the candidate
   * reaches, so what comes back is exactly the commits whose history stops
   * somewhere a better common ancestor could be hiding. In a store fetched
   * deeply enough it is empty, which is the answer that proves the candidate.
   *
   * It reports a shallow graft and a genuine root identically, because from
   * the walk's point of view they are identical — both have no parents. Which
   * one a frontier commit is is `readCommitObject`'s question, and it has to
   * be asked: a repository that merged an unrelated history has a real root
   * above the merge base, and refusing every review of one would be refusing a
   * review that could be proven.
   */
  | { readonly kind: 'parentlessCommitsAbove'; readonly head: GitObjectId; readonly candidate: GitObjectId }
  /**
   * One commit's own object bytes, for the single question this seam cannot
   * answer any other way: does this commit *record* parents?
   *
   * A shallow graft hides a commit's parents from every traversal — `rev-list`,
   * `rev-parse <sha>^1`, `log --format=%P` all answer as if there were none —
   * so no walk can tell a truncation point from a real root commit. The object
   * itself is not grafted: measured on 2026-09-11, git 2.55.0, in a store
   * fetched at `--depth=10`, `cat-file commit <boundary>` printed a `parent`
   * header for the boundary commit and none for the repository's real root.
   *
   * That distinction is what keeps the merge-base proof from refusing a review
   * it could have proven.
   */
  | { readonly kind: 'readCommitObject'; readonly commit: GitObjectId }
  /**
   * The change request's target branch alone, at a depth — the rung a second
   * review of the same repository runs.
   *
   * The head is a commit id: once it is in the store it is in the store, and
   * asking for it again costs a round trip and a pack for an object that cannot
   * have changed. The target branch is a *name*, and where it points is exactly
   * what a merge base is computed against, so it has to be re-read every time.
   * Separating the two is what keeps "the first review of a repository is slow
   * and every later one is not" true.
   */
  | { readonly kind: 'fetchMergeTarget'; readonly fetchUrl: string; readonly targetRef: string; readonly depth: number }
  /**
   * What the change request's target branch points at in this store, or
   * nothing.
   *
   * A sibling of `readCommitRef` rather than a use of `verifyCommit`, and the
   * distinction matters: `verifyCommit` refuses anything that is not a full hex
   * object id, which is the revision rule this whole seam exists to enforce, so
   * it cannot be handed a ref name. This reads the one ref this module itself
   * names (`LOCAL_MERGE_TARGET_REF`) and resolves it to a commit id; there is
   * still no operation here that reads a ref a caller chose.
   *
   * Exit 1 with empty output is the answer "not there", not a failed
   * invocation, exactly as `readCommitRef` treats it.
   */
  | { readonly kind: 'readMergeTargetRef' }
  /**
   * `listChangedFiles`, half one: per-file line counts, and git's own binary
   * determination (task 8.1).
   *
   * Measured framing on 2026-09-11, `--numstat -z -M` over a real pair:
   *
   *     1\t0\tsrc/added.ts\0                      an ordinary file
   *     -\t-\tassets/logo.png\0                   git says this content is binary
   *     0\t0\t\0src/renamed-old.ts\0src/renamed-new.ts\0   a rename: empty path, then both
   *
   * The `-\t-` is the whole reason this operation exists in this shape: it is
   * git's own answer about the content, which is the only answer this change
   * permits anyone to report as binary.
   */
  | {
      readonly kind: 'changedFiles';
      readonly base: GitObjectId;
      readonly head: GitObjectId;
      readonly paths?: readonly string[];
    }
  /**
   * `listChangedFiles`, half two: which kind of change each path underwent
   * (task 8.1).
   *
   * `--numstat` above cannot answer this. Measured, it reports `1\t0\t<path>`
   * for an added file and `0\t1\t<path>` for a deleted one — the same shape a
   * modified file produces when every line of it was added or removed, so
   * reading a kind out of the counts would be a guess, and this whole change
   * exists to stop guessing. `--name-status -z -M` states it: `A\0<path>\0`,
   * `D\0<path>\0`, `M\0<path>\0`, `R100\0<old>\0<new>\0`.
   *
   * It is a second invocation rather than `--numstat --name-status` on one,
   * because the combined form concatenates two differently framed record
   * streams into one `-z` output with nothing separating them — two
   * invocations of the same immutable pair cost a few milliseconds and parse
   * unambiguously.
   */
  | {
      readonly kind: 'changedFileStatus';
      readonly base: GitObjectId;
      readonly head: GitObjectId;
      readonly paths?: readonly string[];
    }
  /**
   * `readDiff`: one file's patch at the pinned pair (task 8.2).
   *
   * `oldPath` is supplied for a file the manifest reported as renamed, and it
   * is not decoration. Rename detection is a comparison between a deletion and
   * an addition, so `-M` can only see one when both sides are inside the diff
   * — and a pathspec of just the new path leaves the deletion outside it.
   * Measured on 2026-09-11 against a 100%-identical rename:
   *
   *     git diff -M <base>..<head> -- src/renamed-new.ts
   *         -> diff --git a/src/renamed-new.ts b/src/renamed-new.ts
   *            new file mode 100644
   *            @@ -0,0 +1 @@ … the whole file as an addition
   *
   *     git diff -M <base>..<head> -- src/renamed-old.ts src/renamed-new.ts
   *         -> diff --git a/src/renamed-old.ts b/src/renamed-new.ts
   *            similarity index 100%
   *            rename from src/renamed-old.ts
   *            rename to src/renamed-new.ts
   *
   * The first patch is not wrong about the bytes and is wrong about the change:
   * a reviewer reading it sees a new file to review rather than a move of code
   * that was already reviewed. Both paths are refused by `refusePath` before
   * either reaches an argument, and both land after `--`.
   */
  | {
      readonly kind: 'diffFile';
      readonly base: GitObjectId;
      readonly head: GitObjectId;
      readonly path: string;
      readonly oldPath?: string;
    }
  /**
   * `searchDiff`: the bounded diff the host then scans itself (task 8.5).
   *
   * There is deliberately no `query` field. Design D7 settles that the neutral
   * query is matched host-side for this operation — `git diff -G` selects whole
   * files by regular expression, which is neither the literal matching the
   * contract promises nor the per-line `DiffPosition` the result carries — so
   * the model's string never reaches a git argument here at all. The structural
   * test asserts that absence rather than trusting this comment.
   */
  | {
      readonly kind: 'searchDiff';
      readonly base: GitObjectId;
      readonly head: GitObjectId;
      readonly paths?: readonly string[];
    }
  /** `readFile`: one path's content at one pinned commit (task 8.3). */
  | { readonly kind: 'fileAtRevision'; readonly revision: GitObjectId; readonly path: string }
  /** `searchRepository`: a literal search at one pinned commit (task 8.4). */
  | {
      readonly kind: 'searchRepository';
      readonly revision: GitObjectId;
      readonly query: string;
      readonly paths?: readonly string[];
    };

export type GitOperationKind = GitOperation['kind'];

/**
 * Which bound applies. A fetch talks to a remote and is allowed two minutes; a
 * read is local work over an object database and is allowed thirty seconds
 * (design.md, "Configurable Initial Defaults").
 */
export type GitTimeBound = 'read' | 'fetch';

// ---- The refusals ---------------------------------------------------------------

export type GitRefusalCode =
  | 'revisionNotObjectId'
  | 'pathNotRepositoryRelative'
  | 'pathTooLong'
  | 'queryEmpty'
  | 'queryTooLong'
  | 'queryControlBytes'
  | 'fetchUrlTransport'
  | 'refHintUnsafe'
  | 'depthOutOfRange';

/**
 * Why an operation was refused before git ran (task 6.4).
 *
 * `reason` is this module's own bounded text and it never quotes the offending
 * value. Two reasons for that. Git's own refusal is a raw error string in
 * whatever shape that git version chose, and it reaches the model as a tool
 * result — the source has to state its own truth instead. And the value is
 * model-supplied and unbounded, so echoing it would walk it into every record
 * that later carries this reason, which is exactly what the marker-string
 * convention exists to prevent. The model already knows what it sent; what it
 * does not know is the rule, so the rule is what the reason names.
 */
export interface GitRefusal {
  readonly code: GitRefusalCode;
  readonly reason: string;
}

/**
 * The validated argument list for one invocation.
 *
 * Exported as a **type only**: the class value below is not exported and the
 * `#validated` field cannot be produced structurally, so the sole way to hold
 * one of these is to have called `planGitInvocation` and had every field pass
 * validation. That is what makes `runGitInvocation(unvalidatedArgs)` unwritable
 * rather than merely discouraged.
 *
 * **Unforgeable was not the same as unchangeable.** Construction was closed —
 * `tsc` rejects an object literal, a same-shape class, and a class carrying its
 * own private field — but until this file froze them, the arrays a plan held
 * were ordinary mutable arrays behind a `readonly` type, and `readonly` is a
 * compile-time promise that one cast retracts. Measured on 2026-09-11 against
 * the real builder:
 *
 *     (plan.args as string[]).splice(1, 0, `--output=${target}`);
 *     await runGitInvocation(plan, context);
 *         -> state: 'ok', and the file was written
 *
 * No `any`, nothing eslint reports, and the argument landed in front of the
 * `--` that task 6.2 exists to put it behind. `successExitCodes` was the same
 * shape of hole with a different end: `(plan.successExitCodes as number[]).push(128)`
 * turns a failed invocation into an `ok` one carrying whatever the child
 * managed to write. So both arrays are copied and frozen here, and the plan
 * itself is frozen so no property of it can be redefined. A cast now throws at
 * the line that made the mistake, and a swallowed throw changes nothing.
 *
 * `isPlan` closes the other half. The private field is a *compile-time*
 * guarantee, and this extension ships as bundled JavaScript where no compiler
 * is left: `runGitInvocation(anything as unknown as GitInvocationPlan, …)` is
 * one cast away in TypeScript and free in JavaScript. The brand check is the
 * runtime half of the same promise, and `#validated in value` is the one form
 * of it nothing outside this class can satisfy — not an object literal, not
 * `Object.create(prototype)`.
 *
 * Freezing and the brand answer different mistakes: freezing stops a real plan
 * from being changed after it was validated; the brand stops a thing that was
 * never validated from being run. Re-deriving the arguments at execution and
 * comparing was considered and dropped — with the plan frozen and branded, both
 * sides of that comparison come from the same immutable object, so it can only
 * ever be a slower way of agreeing with itself.
 */
class GitInvocationPlanValue {
  readonly #validated = true;

  readonly kind: GitOperationKind;
  /**
   * The operation's own arguments. The full command line also carries the
   * repository-independent prefix `gitProcessArguments` adds; the tests drive
   * that composed list, not this one, so an argument that only appears in the
   * prefix cannot escape them.
   */
  readonly args: readonly string[];
  readonly timeBound: GitTimeBound;
  /** False only for `version`, which answers without a repository. */
  readonly needsRepository: boolean;
  /**
   * Exit statuses that mean the invocation did its job. `git grep` answers
   * "no match" with exit 1 — measured, `git grep -F -e zzz <sha> --` exits 1
   * on a repository where the string is absent — so classifying every nonzero
   * status as failure would turn every empty search into an error and hand
   * group 8 a corrupted distinction between "nothing matched" and "the search
   * did not run".
   */
  readonly successExitCodes: readonly number[];

  constructor(
    kind: GitOperationKind,
    args: readonly string[],
    timeBound: GitTimeBound,
    needsRepository: boolean,
    successExitCodes: readonly number[],
  ) {
    this.kind = kind;
    // Copied before freezing, not frozen in place: freezing the caller's array
    // would leave a plan whose contents another holder of that same array could
    // still not change, but would also reach back and freeze something this
    // class does not own. A copy owes nothing to where it came from.
    this.args = Object.freeze([...args]);
    this.timeBound = timeBound;
    this.needsRepository = needsRepository;
    this.successExitCodes = Object.freeze([...successExitCodes]);
    Object.freeze(this);
  }

  /**
   * Whether a value really came from `planGitInvocation`.
   *
   * `#validated in value` is an existence test on a private field, which only
   * code inside this class body can write and nothing outside it can produce.
   * A plain object with the right shape fails it, and so does an object made
   * from this prototype.
   */
  static isPlan(value: unknown): value is GitInvocationPlanValue {
    return typeof value === 'object' && value !== null && #validated in value;
  }
}
export type GitInvocationPlan = GitInvocationPlanValue;

export type GitInvocationPlanResult =
  | { readonly ok: true; readonly plan: GitInvocationPlan }
  | { readonly ok: false; readonly refusal: GitRefusal };

// ---- Validation ------------------------------------------------------------------

/**
 * A full object id, lowercase hex, SHA-1 (40) or SHA-256 (64).
 *
 * Uppercase is refused as well as short forms. Git would resolve `ABCD…` and an
 * abbreviation happily, and that is the problem: a pinned read has to be over
 * the exact commit the snapshot named, and `refs/codeverdict/<sha>` (design D3)
 * is derived from this string, so two spellings of one commit would write two
 * refs and a case-insensitive filesystem would collide them.
 *
 * Scoped to this seam on purpose. The fixture provider's harness fixtures use
 * revision *names* — `small-base-1`, `huge-base-1` — and they stay valid: the
 * fixture provider reports no object source at all, so the local source is
 * never selected for a fixture pod and no fixture revision ever reaches here.
 */
export function isFullObjectId(revision: string): boolean {
  return /^[0-9a-f]{40}$/.test(revision) || /^[0-9a-f]{64}$/.test(revision);
}

/**
 * Path bounds. 4 KiB is past any real repository path and well under the point
 * where the operating system refuses the invocation: a 300,000-byte argument
 * was measured returning `E2BIG` from `spawn`, which is a raw errno reaching a
 * caller that asked a perfectly ordinary question.
 */
const MAX_PATH_BYTES = 4096;
/** The same ceiling for a query, for the same measured reason. */
const MAX_QUERY_BYTES = 4096;

const byteLength = (value: string): number => Buffer.byteLength(value, 'utf8');

/**
 * True when the value carries a byte that cannot travel through an argument
 * safely. Written as a code-point scan rather than a regular-expression
 * character class because a literal control-character escape in a source file
 * of this project has been observed to round-trip through the editing tool as a
 * raw byte, and a source file containing a raw NUL is one git itself reports as
 * binary (docs/agent-notes/write-tool-control-char-regex.md).
 */
function hasControlBytes(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Refuse a model-supplied path before git sees it (task 6.4).
 *
 * Every rule here has a reason of its own:
 *
 * - A leading `-` is read as an option when a `--` is ever missed. The `--` is
 *   structural in this module, so this is the second lock on the same door.
 * - An absolute path, a drive letter (`C:…`) or a UNC prefix (`\\host\share`)
 *   names something outside the repository. Git refuses most of these itself,
 *   but its refusal is raw error text bound for the model.
 * - Any `..` component escapes the root; any `.` component and any empty
 *   component (`a//b`, a trailing slash) mean the caller sent something that is
 *   not the repository-relative path git stores in its index, and normalizing it
 *   silently would answer a question nobody asked.
 * - A backslash anywhere is refused rather than sorted out: git's own index
 *   paths are always `/`-separated, so a backslash is never necessary, while on
 *   Windows it is both a separator and half of the UNC form. Refusing the
 *   character removes the whole class. The cost is a repository containing a
 *   file whose name really has a backslash in it, which is unreachable through
 *   this source and reported honestly rather than mishandled.
 * - A NUL byte cannot survive the system call at all: `spawn` throws
 *   `ERR_INVALID_ARG_VALUE: The argument 'args[2]' must be a string without null
 *   bytes` (measured), and an uncaught TypeError from Node is precisely the raw
 *   platform text this refusal exists to replace. Other control bytes are
 *   refused with it because they desynchronize any line-framed reading of git's
 *   output that is not `-z`.
 *
 * A leading `:` is deliberately **not** refused. Task 6.12 requires such a path
 * to be matched literally rather than rejected, and `GIT_LITERAL_PATHSPECS=1`
 * plus `--literal-pathspecs` is what makes it literal — verified by running the
 * real thing, not by reading the variable back.
 */
export function refusePath(path: string): GitRefusal | undefined {
  if (path === '') {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path is required, and an empty path names nothing.' };
  }
  if (byteLength(path) > MAX_PATH_BYTES) {
    return {
      code: 'pathTooLong',
      reason: `A file path must be at most ${String(MAX_PATH_BYTES)} bytes.`,
    };
  }
  if (hasControlBytes(path)) {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path must not contain control characters.' };
  }
  if (path.startsWith('-')) {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path must not begin with a dash.' };
  }
  if (path.includes('\\')) {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path must use forward slashes and must not contain a backslash.' };
  }
  if (path.startsWith('/')) {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path must be relative to the repository root, not absolute.' };
  }
  if (/^[A-Za-z]:/.test(path)) {
    return { code: 'pathNotRepositoryRelative', reason: 'A file path must be relative to the repository root and must not carry a drive letter.' };
  }
  for (const segment of path.split('/')) {
    if (segment === '') {
      return { code: 'pathNotRepositoryRelative', reason: 'A file path must not contain an empty path component.' };
    }
    if (segment === '.' || segment === '..') {
      return { code: 'pathNotRepositoryRelative', reason: 'A file path must not contain a "." or ".." component.' };
    }
  }
  return undefined;
}

/** Refuse a model-supplied search query before git sees it (tasks 6.4, 6.11). */
export function refuseQuery(query: string): GitRefusal | undefined {
  if (query.trim() === '') {
    return { code: 'queryEmpty', reason: 'A search needs a query, and an empty query matches everything.' };
  }
  if (byteLength(query) > MAX_QUERY_BYTES) {
    return { code: 'queryTooLong', reason: `A search query must be at most ${String(MAX_QUERY_BYTES)} bytes.` };
  }
  if (hasControlBytes(query)) {
    return { code: 'queryControlBytes', reason: 'A search query must not contain control characters.' };
  }
  return undefined;
}

function refuseRevision(revision: string): GitRefusal | undefined {
  if (isFullObjectId(revision)) return undefined;
  return {
    code: 'revisionNotObjectId',
    reason: 'A revision must be a full lowercase hexadecimal object id; ref names and abbreviated ids are not resolved.',
  };
}

/**
 * The opaque ref hint from an object-source descriptor (design D2/D8).
 *
 * The consumer must not interpret it — that is the whole point of the hint, and
 * requiring it to start with `refs/` would be interpreting it — but it does land
 * in an argument, so it is bounded the same way a path is. The colon matters
 * most: the hint is composed into `+<hint>:<local ref>`, and a colon inside it
 * would split the refspec somewhere else entirely. Whitespace and control bytes
 * go for the reasons above. A leading dash cannot reach option parsing, because
 * the composed argument always begins with `+`.
 */
function refuseRefHint(refHint: string): GitRefusal | undefined {
  if (refHint === '' || byteLength(refHint) > MAX_PATH_BYTES) {
    return { code: 'refHintUnsafe', reason: 'A ref hint must be a non-empty value of at most 4096 bytes.' };
  }
  if (hasControlBytes(refHint) || /\s/.test(refHint) || refHint.includes(':')) {
    return { code: 'refHintUnsafe', reason: 'A ref hint must not contain whitespace, control characters or a colon.' };
  }
  return undefined;
}

/**
 * The local ref every acquired commit is written under (design D3).
 *
 * Named from the object id, so two attempts wanting the same commit write the
 * same ref with the same value and cannot race into disagreement, and so the
 * fetched objects are reachable rather than dangling and prunable.
 */
export function localRefForCommit(commit: GitObjectId): string {
  return `refs/codeverdict/${commit}`;
}

/**
 * The one local ref the change request's target branch is fetched into.
 *
 * A fixed name, not one derived from the branch: a store holds one repository,
 * a merge base is computed under the acquisition lock immediately after the
 * fetch that wrote this, and the commit the merge base resolves to is pinned
 * under its own `refs/codeverdict/<sha>` straight afterwards. So nothing reads
 * this ref outside the window in which it was just written, and two attempts
 * that disagree about where the branch points cannot make each other read the
 * wrong one.
 */
export const LOCAL_MERGE_TARGET_REF = 'refs/codeverdict/merge-target';

/**
 * The deepest `--depth` this seam will run, and therefore the deepest any
 * caller's schedule may reach.
 *
 * A value rather than a literal because it is read in three places — both fetch
 * operations below, and `localGitPolicy.ts`, whose `mergeBaseMaxDepth` is the
 * same bound expressed as policy. It used to be a literal in each of them, and
 * the policy's own comment claimed it was "one value and not two that can
 * drift" while being the third copy.
 *
 * The number itself is the ladder's bound from design D10's schedule (10, 100,
 * 1000). Above it, a deepening buys nothing measurable: on a 131-commit
 * repository `--depth=160` and `--depth=640` both returned the whole history
 * and the same 3.41 MB, and the shallow-boundary check stops the ladder there
 * anyway.
 */
export const MAX_FETCH_DEPTH = 1000;

// ---- The builder --------------------------------------------------------------------

/**
 * Arguments shared by every invocation, and the reason each one is here.
 *
 * `--literal-pathspecs` doubles the `GIT_LITERAL_PATHSPECS=1` in the
 * environment. Both were verified to defeat pathspec magic on their own; two
 * locks on one door is right for the one guard whose failure silently *widens*
 * an operation rather than breaking it — measured, `-- ':(exclude)src/kept.ts'`
 * excludes a file from the manifest without the guard and matches nothing with
 * it, and `-- ':/'` re-roots the operation the same way.
 *
 * `credential.helper=` (empty) removes every helper a machine might otherwise
 * offer, so a fetch can only use the header this module puts in the environment.
 * `core.askPass=` closes the other end of the same door.
 *
 * `core.quotePath=false` keeps non-ASCII paths as themselves in the outputs that
 * are not `-z` framed, instead of git's octal escapes.
 *
 * `gc.auto=0` stops a fetch from launching a background repack we neither
 * bounded nor waited for.
 *
 * **The repository's own configuration is read by every invocation, and the
 * environment cannot close it.** `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` at
 * `/dev/null` close the machine's user and system files. `$GIT_DIR/config` —
 * the config inside the cache repository this seam runs against — has no such
 * switch, and it is read every time. A command-line `-c` does beat it
 * (measured), so each key below is one that config could otherwise set, pinned
 * to the answer git gives with no configuration at all. Every one was measured
 * on 2026-09-11 against a bare repository holding two commits of one ordinary
 * TypeScript file, with the setting written into that repository's own config:
 *
 * - `core.hooksPath=/dev/null` — a `reference-transaction` hook planted in the
 *   repository's own `hooks/` ran three times during a single `git fetch`: code
 *   of the directory's choosing, executed by a ref update. With the pin it did
 *   not run and the fetch was otherwise unchanged. `/dev/null` is not a
 *   directory, so no hook path under it can ever resolve.
 * - `core.bigFileThreshold=512m`, which is git's own default — with `1` there,
 *   every file came back as `Binary files a/a.ts and b/a.ts differ`, and
 *   `--numstat` answered `-\t-`. That is the everything-is-binary state this
 *   whole change exists to remove, arriving from inside the cache rather than
 *   from the forge.
 * - `core.attributesFile=/dev/null` — the config key that named the hostile
 *   textconv driver in the measurement recorded above `DIFF_ARGUMENTS`. It is
 *   the config half of the attributes surface. The other half,
 *   `$GIT_DIR/info/attributes`, cannot be neutralized by any argument and is
 *   closed by owning the directory instead (`cacheRepository.ts`).
 * - `diff.noprefix=false` — with `true`, the patch header came back as
 *   `diff --git a.ts a.ts` and `--- a.ts`, which is not what a reader expecting
 *   `a/`/`b/` prefixes parses.
 * - `grep.column=false` — with `true`, `git grep -z` emitted an extra
 *   NUL-separated column field per match, desynchronizing exactly the framing
 *   task 6.8 chose `-z` to protect.
 *
 * Only keys measured to change an answer are pinned; a guess that has never
 * been run is not a guard. What `-c` cannot reach at all — `info/attributes`,
 * and any key nobody thought to name, `url.<base>.insteadOf` being the one that
 * matters (measured: it rewrote a validated `https` fetch location to another
 * `http` host, which would carry the credential header there) — is closed by
 * owning the cache directory rather than by arguments.
 */
function commonArguments(context: GitProcessContext): readonly string[] {
  const args = [
    '--literal-pathspecs',
    '-c',
    'credential.helper=',
    '-c',
    'core.askPass=',
    '-c',
    'core.quotePath=false',
    '-c',
    'gc.auto=0',
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'core.attributesFile=/dev/null',
    '-c',
    'core.bigFileThreshold=512m',
    '-c',
    'diff.noprefix=false',
    '-c',
    'grep.column=false',
  ];
  if (context.proxyUrl !== undefined && context.proxyUrl !== '') {
    // Task 6.7: ignoring the machine's global git configuration also ignores
    // the proxy a corporate machine depends on, so the editor's own setting is
    // reapplied explicitly. It is emitted as the value half of `-c`, so the
    // argument always begins with `http.proxy=` and can never be read as an
    // option however the setting is spelled.
    args.push('-c', `http.proxy=${context.proxyUrl}`);
  }
  return args;
}

/**
 * Diff arguments every diff-shaped operation shares.
 *
 * `--no-ext-diff` is not redundant beside the sanitized environment; it is the
 * inner lock. Measured on 2026-09-11 with `diff.external = /bin/echo EXTERNAL`
 * in an applied global config, `git diff` prints the external program's output
 * in place of the patch — machine configuration executing a command of its own
 * choosing and replacing the review's evidence with the result. The environment
 * already closes that, and this closes it again for the day someone edits the
 * environment. It closes the same key inside the cache repository's own config,
 * where the environment reaches nothing at all (measured there too).
 *
 * `--no-textconv` was missing, and the gap it left was measured rather than
 * imagined. Git enables textconv for `git diff` by default, and the sanitized
 * environment does not cover it: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`
 * close the machine's files, but `$GIT_DIR/config` — the config inside our own
 * cache repository — is read by every invocation. With
 *
 *     [core] attributesFile = <scratch>/attrs      # holding `*.ts diff=hostile`
 *     [diff "hostile"] textconv = <scratch>/hostile.sh
 *
 * appended to a bare repository's own config on 2026-09-11, the `diffFile`
 * arguments as they stood returned `state: 'ok'` with **empty stdout**: both
 * revisions of a file that really had changed converted to the same text, so
 * the change read as no change at all, and the review would have recorded an
 * unmodified file as inspected. The script also ran, twice, once per side. With
 * `--no-textconv` the same invocation returns the true patch and the script
 * does not run. An empty diff is the worst shape this class of failure can
 * take — nothing about it looks broken.
 */
const DIFF_ARGUMENTS = ['--no-ext-diff', '--no-textconv', '--no-color', '-M'] as const;


function planDiff(base: string, head: string, paths: readonly string[]): readonly string[] {
  // The one string composition over revisions in this file, and it is safe by
  // construction: both halves have passed `isFullObjectId`, which admits
  // nothing but lowercase hex.
  return ['diff', ...DIFF_ARGUMENTS, `${base}..${head}`, '--', ...paths];
}

/**
 * Validate one operation and lay out its arguments (tasks 6.1, 6.2, 6.3, 6.4).
 *
 * Every pathspec is emitted after `--` and every search pattern after `-e`,
 * here, once, for all callers. A caller that wanted to place a path itself has
 * no way to express that: it hands over typed fields and receives a plan.
 */
export function planGitInvocation(operation: GitOperation): GitInvocationPlanResult {
  const refuse = (refusal: GitRefusal): GitInvocationPlanResult => ({ ok: false, refusal });
  const plan = (
    args: readonly string[],
    timeBound: GitTimeBound = 'read',
    options: { needsRepository?: boolean; successExitCodes?: readonly number[] } = {},
  ): GitInvocationPlanResult => ({
    ok: true,
    plan: new GitInvocationPlanValue(
      operation.kind,
      args,
      timeBound,
      options.needsRepository ?? true,
      options.successExitCodes ?? [0],
    ),
  });

  /** Every path in one operation, refused as a set so the first bad one decides. */
  const checkPaths = (paths: readonly string[]): GitRefusal | undefined => {
    for (const path of paths) {
      const refusal = refusePath(path);
      if (refusal) return refusal;
    }
    return undefined;
  };

  switch (operation.kind) {
    case 'version':
      return plan(['--version'], 'read', { needsRepository: false });

    case 'initBare':
      // `--initial-branch` is named rather than left to configuration: the
      // default branch name is a config value, and configuration is exactly
      // what this seam refuses to read. Nothing is ever committed to it.
      return plan(['init', '--bare', '--quiet', '--initial-branch=main']);

    case 'listRepositoryConfig':
      // `--no-includes` states what the measurement showed anyway: this is the
      // file's own keys, never an expansion of them. `-z` for the reason every
      // other read here uses it — a config value may contain a newline, and
      // this output is parsed. Framing measured: `<key>\n<value>\0` per entry,
      // and a key with no value as `<key>\0`. A repository with no config file
      // at all exits 128, which is the honest answer to "show me what this
      // directory declares" for a directory that declares nothing.
      return plan(['config', '--list', '--local', '--no-includes', '-z']);

    case 'verifyCommit': {
      const refusal = refuseRevision(operation.revision);
      if (refusal) return refuse(refusal);
      // `--end-of-options` is to a revision what `--` is to a pathspec. The
      // revision has already passed the hex validator, so nothing can be hiding
      // in it; this is the structural half of the same rule, stated where a
      // future edit to the validator would otherwise remove the only guard.
      return plan(['rev-parse', '--verify', '--quiet', '--end-of-options', `${operation.revision}^{commit}`]);
    }

    case 'readCommitRef': {
      const refusal = refuseRevision(operation.commit);
      if (refusal) return refuse(refusal);
      // Exit 1 is `rev-parse --verify --quiet`'s answer for a ref that is not
      // there, and "not there" is the answer the caller asked for rather than a
      // failed invocation — the same distinction `git grep`'s exit 1 gets below.
      // An absent ref is then empty stdout, not an error to explain.
      return plan(['rev-parse', '--verify', '--quiet', '--end-of-options', localRefForCommit(operation.commit)], 'read', {
        successExitCodes: [0, 1],
      });
    }

    case 'deleteCommitRef': {
      const refusal = refuseRevision(operation.commit);
      if (refusal) return refuse(refusal);
      // `--no-deref` so the ref itself is removed rather than whatever it might
      // point through; nothing in this cache ever creates a symbolic ref, and
      // this states that rather than relying on it.
      return plan(['update-ref', '--no-deref', '-d', localRefForCommit(operation.commit)]);
    }

    case 'writeCommitRef': {
      const refusal = refuseRevision(operation.commit);
      if (refusal) return refuse(refusal);
      // The value is the commit's own id and the name is derived from it, so
      // this ref can only ever say the true thing about itself.
      return plan(['update-ref', '--no-deref', '--end-of-options', localRefForCommit(operation.commit), operation.commit]);
    }

    case 'fetchCommit': {
      const revisionRefusal = refuseRevision(operation.commit);
      if (revisionRefusal) return refuse(revisionRefusal);
      if (!Number.isInteger(operation.depth) || operation.depth < 1 || operation.depth > MAX_FETCH_DEPTH) {
        return refuse({ code: 'depthOutOfRange', reason: `A fetch depth must be a whole number between 1 and ${String(MAX_FETCH_DEPTH)}.` });
      }
      // Task 6.19: the transport is validated here, before any fetch, by the
      // same predicate the providers apply when they compose a descriptor. A
      // descriptor is only as trustworthy as whatever produced it, and `ext::`
      // runs a command of the remote's choosing.
      if (!isFetchableObjectSourceUrl(operation.fetchUrl)) {
        return refuse({
          code: 'fetchUrlTransport',
          reason: 'Objects can only be fetched from an http or https location that carries no credentials of its own.',
        });
      }
      let source = operation.commit;
      if (operation.refHint !== undefined) {
        const hintRefusal = refuseRefHint(operation.refHint);
        if (hintRefusal) return refuse(hintRefusal);
        source = operation.refHint;
      }
      const refspecs = [`+${source}:${localRefForCommit(operation.commit)}`];
      if (operation.targetRef !== undefined) {
        // Same rule as the hint, and for the same reason: this value was
        // composed by a provider from platform-shaped knowledge, it is never
        // parsed here, and a colon or whitespace in it would let it become a
        // second refspec rather than the source half of this one.
        const targetRefusal = refuseRefHint(operation.targetRef);
        if (targetRefusal) return refuse(targetRefusal);
        refspecs.push(`+${operation.targetRef}:${LOCAL_MERGE_TARGET_REF}`);
      }
      return plan(
        [
          // A second lock under the URL check: even if a redirect or a future
          // edit produced some other transport, only these two are permitted to
          // run at all.
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.http.allow=always',
          '-c',
          'protocol.https.allow=always',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--quiet',
          `--depth=${String(operation.depth)}`,
          operation.fetchUrl,
          ...refspecs,
        ],
        'fetch',
      );
    }

    case 'fetchMergeTarget': {
      if (!Number.isInteger(operation.depth) || operation.depth < 1 || operation.depth > MAX_FETCH_DEPTH) {
        return refuse({ code: 'depthOutOfRange', reason: `A fetch depth must be a whole number between 1 and ${String(MAX_FETCH_DEPTH)}.` });
      }
      if (!isFetchableObjectSourceUrl(operation.fetchUrl)) {
        return refuse({
          code: 'fetchUrlTransport',
          reason: 'Objects can only be fetched from an http or https location that carries no credentials of its own.',
        });
      }
      const targetRefusal = refuseRefHint(operation.targetRef);
      if (targetRefusal) return refuse(targetRefusal);
      return plan(
        [
          '-c',
          'protocol.allow=never',
          '-c',
          'protocol.http.allow=always',
          '-c',
          'protocol.https.allow=always',
          'fetch',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-recurse-submodules',
          '--quiet',
          `--depth=${String(operation.depth)}`,
          operation.fetchUrl,
          `+${operation.targetRef}:${LOCAL_MERGE_TARGET_REF}`,
        ],
        'fetch',
      );
    }

    case 'mergeBase': {
      const revisionRefusal = refuseRevision(operation.left);
      if (revisionRefusal) return refuse(revisionRefusal);
      // The right side is a local ref this module names, never a caller's
      // string: `LOCAL_MERGE_TARGET_REF` is the only value acquisition passes,
      // and the check below is what keeps that true if a future caller forgets.
      if (operation.right !== LOCAL_MERGE_TARGET_REF && refuseRevision(operation.right)) {
        return refuse({ code: 'revisionNotObjectId', reason: 'A merge base is computed between a full object id and this extension’s own target reference, nothing else.' });
      }
      return plan(['merge-base', '--end-of-options', operation.left, operation.right], 'read');
    }

    case 'isShallow':
      return plan(['rev-parse', '--is-shallow-repository'], 'read');

    case 'parentlessCommitsAbove': {
      const revisionRefusal = refuseRevision(operation.head) ?? refuseRevision(operation.candidate);
      if (revisionRefusal) return refuse(revisionRefusal);
      // `^<id>` rather than `--not <id>`: `--end-of-options` stops option
      // parsing, and `--not` is an option, so it would arrive as a revision
      // and fail. `^` is part of the revision grammar and still excludes —
      // measured on 2026-09-11 against a store fetched at `--depth=10`, the
      // two forms returned the same commit.
      //
      // The right-hand tip is this module's own ref, exactly as `mergeBase`
      // takes it: the caller names an object id and never a ref.
      return plan(['rev-list', '--max-parents=0', '--end-of-options', operation.head, LOCAL_MERGE_TARGET_REF, `^${operation.candidate}`], 'read');
    }

    case 'readCommitObject': {
      const revisionRefusal = refuseRevision(operation.commit);
      if (revisionRefusal) return refuse(revisionRefusal);
      return plan(['cat-file', 'commit', '--end-of-options', operation.commit], 'read');
    }

    case 'readMergeTargetRef':
      return plan(['rev-parse', '--verify', '--quiet', '--end-of-options', `${LOCAL_MERGE_TARGET_REF}^{commit}`], 'read', {
        successExitCodes: [0, 1],
      });

    case 'changedFiles': {
      const revisionRefusal = refuseRevision(operation.base) ?? refuseRevision(operation.head);
      if (revisionRefusal) return refuse(revisionRefusal);
      const paths = operation.paths ?? [];
      const pathRefusal = checkPaths(paths);
      if (pathRefusal) return refuse(pathRefusal);
      // `-z` because a path containing a newline or a quote must not be able to
      // desynchronize parsing (task 6.8). Framing measured:
      // `1\t1\tsrc/kept.ts\0`, one NUL-terminated record per file.
      return plan(['diff', '--numstat', '-z', ...DIFF_ARGUMENTS, `${operation.base}..${operation.head}`, '--', ...paths]);
    }

    case 'changedFileStatus': {
      const revisionRefusal = refuseRevision(operation.base) ?? refuseRevision(operation.head);
      if (revisionRefusal) return refuse(revisionRefusal);
      const paths = operation.paths ?? [];
      const pathRefusal = checkPaths(paths);
      if (pathRefusal) return refuse(pathRefusal);
      // `-z` for the same reason as `--numstat` above, and it matters more
      // here: without it git quotes a path containing a quote or a newline and
      // the record boundary becomes a guess.
      return plan(['diff', '--name-status', '-z', ...DIFF_ARGUMENTS, `${operation.base}..${operation.head}`, '--', ...paths]);
    }

    case 'diffFile': {
      const revisionRefusal = refuseRevision(operation.base) ?? refuseRevision(operation.head);
      if (revisionRefusal) return refuse(revisionRefusal);
      // Both paths go through the same refusal. `oldPath` reaches here from
      // this source's own manifest rather than from a model, but a validator
      // that trusts its caller is one edit away from not being a validator.
      const pathRefusal = refusePath(operation.path) ?? (operation.oldPath === undefined ? undefined : refusePath(operation.oldPath));
      if (pathRefusal) return refuse(pathRefusal);
      const paths = operation.oldPath === undefined ? [operation.path] : [operation.oldPath, operation.path];
      return plan(planDiff(operation.base, operation.head, paths));
    }

    case 'searchDiff': {
      const revisionRefusal = refuseRevision(operation.base) ?? refuseRevision(operation.head);
      if (revisionRefusal) return refuse(revisionRefusal);
      const paths = operation.paths ?? [];
      const pathRefusal = checkPaths(paths);
      if (pathRefusal) return refuse(pathRefusal);
      return plan(planDiff(operation.base, operation.head, paths));
    }

    case 'fileAtRevision': {
      const revisionRefusal = refuseRevision(operation.revision);
      if (revisionRefusal) return refuse(revisionRefusal);
      const pathRefusal = refusePath(operation.path);
      if (pathRefusal) return refuse(pathRefusal);
      // `<rev>:<path>` is an object name, not a pathspec, so `--` cannot protect
      // it and neither can literal pathspecs. What protects it is that the
      // composed argument always begins with a hex object id, so it can never
      // be read as an option, and that the path has already been refused if it
      // was absolute, escaping, or anything but repository-relative. Verified
      // under the production environment: a path of `:weird` produces
      // `fatal: path ':weird' does not exist in '<sha>'` and reads nothing else.
      return plan(['show', '--no-ext-diff', '--no-textconv', `${operation.revision}:${operation.path}`]);
    }

    case 'searchRepository': {
      const revisionRefusal = refuseRevision(operation.revision);
      if (revisionRefusal) return refuse(revisionRefusal);
      const queryRefusal = refuseQuery(operation.query);
      if (queryRefusal) return refuse(queryRefusal);
      const paths = operation.paths ?? [];
      const pathRefusal = checkPaths(paths);
      if (pathRefusal) return refuse(pathRefusal);
      // `-F` is not only about option parsing. Without it the model's string is
      // compiled as a POSIX basic regular expression, so it silently answers a
      // different question: measured, a query of `A = 2.` matches nothing as a
      // literal and matches `export const A = 2;` as a pattern, which is
      // content the model did not ask for entering the evidence ledger as
      // though it had. A crafted pattern is also unbounded work inside the
      // child, which is a second reason not to compile one from untrusted text.
      //
      // `-e` puts the query in the value position of an explicit option, `-I`
      // keeps binary content out of excerpts, and `-z` frames the output as
      // `<rev>:<path>\0<line>\0<text>\n`.
      //
      // `--no-textconv` is git's documented default for `grep`, and it is
      // written out so this seam depends on the flag rather than on the
      // default. Measured on 2026-09-11 against a repository whose config named
      // a textconv driver: `git grep --textconv` searched the driver's output
      // and matched text that is in no file, while the default and the explicit
      // flag both searched the content. A search answering from a filter is the
      // same failure `--no-textconv` closes for `diff`, one operation over.
      return plan(
        [
          'grep',
          '--no-color',
          '--no-textconv',
          '-I',
          '-n',
          '-z',
          '-F',
          '-e',
          operation.query,
          operation.revision,
          '--',
          ...paths,
        ],
        'read',
        // Exit 1 is `git grep`'s answer for "no match" — measured — and an empty
        // result is a successful search, not a failed invocation.
        { successExitCodes: [0, 1] },
      );
    }
  }
}

// ---- The process ---------------------------------------------------------------------

/**
 * Everything an invocation needs that is not part of the operation itself.
 *
 * `credentialHeaderValue` is the `authorizationHeaderValue` from an
 * `ObjectSourceDescriptor`. It is a secret and it never enters `args`.
 */
export interface GitProcessContext {
  /**
   * The git directory to run against — a bare repository in production
   * (design D3). Passed as `GIT_DIR` rather than relied on through the working
   * directory, so git performs no repository discovery at all and an invocation
   * cannot walk up into whatever directory happens to contain the cache.
   */
  readonly gitDir?: string;
  /** Working directory for the child; defaults to the system temporary directory. */
  readonly cwd?: string;
  /**
   * The complete `Authorization` header value for the remote, carried into the
   * child through the environment and nowhere else (task 6.6).
   */
  readonly credentialHeaderValue?: string;
  /**
   * The editor's own `http.proxy` setting, when one is configured (task 6.7).
   * Read at the wiring site rather than here: this module stays free of editor
   * APIs so that every test of it runs against real git without one.
   */
  readonly proxyUrl?: string;
  readonly bounds?: Partial<GitInvocationBounds>;
  /** Defaults to `git` on `PATH`. */
  readonly executable?: string;
  /**
   * Where `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` point. Overridable only so a
   * test can prove the machine's configuration is being ignored by pointing
   * this at a hostile file and watching nothing change.
   */
  readonly emptyConfigPath?: string;
}

export interface GitInvocationBounds {
  readonly readTimeoutMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

/**
 * design.md, "Configurable Initial Defaults". Task 7.9 turns these into
 * injected policy values; they are defaults here, not constants at a call site,
 * and every one of them is overridable through `GitProcessContext.bounds`.
 */
export const DEFAULT_GIT_BOUNDS: GitInvocationBounds = {
  readTimeoutMs: 30_000,
  fetchTimeoutMs: 120_000,
  maxStdoutBytes: 64 * 1024 * 1024,
  /**
   * Ours, not the design's: git's diagnostics are a few lines, and a child that
   * loops writing to stderr must not be able to grow this process's memory
   * without bound while we wait for it.
   */
  maxStderrBytes: 64 * 1024,
};

/**
 * `/dev/null` is git's own documented way to read no configuration at all
 * ("Can be set to /dev/null to skip reading configuration files"). It is used
 * rather than a path under the temporary directory because a path we merely
 * expect to be absent is a file any local user can create, and creating it
 * would hand them `diff.external` inside our child.
 */
const EMPTY_CONFIG_PATH = '/dev/null';

/**
 * The child's environment, constructed rather than inherited (task 6.5).
 *
 * The threat is not exotic. A machine with `diff.external` configured runs a
 * program of its own choosing in place of computing a diff (measured: with
 * `diff.external = /bin/echo EXTERNAL`, `git diff` printed the echo's output
 * instead of the patch). A textconv filter is worse, because `--no-ext-diff`
 * does not stop it: with `core.attributesFile` pointing at a file that assigns
 * `diff=hostile` to `*.ts`, the same diff came back with every line replaced by
 * a temporary file path — evidence quietly corrupted rather than obviously
 * broken. A credential helper would answer an authentication challenge with
 * something the reviewer never chose.
 *
 * So nothing is inherited except what git needs to run: `PATH`, and on Windows
 * the few variables the C runtime and git's own helpers require. `HOME` is
 * deliberately absent — it is the path by which `~/.gitconfig` would be found —
 * and `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` close the same door explicitly,
 * including the XDG location `HOME` alone would not cover.
 */
export function gitProcessEnvironment(context: GitProcessContext): Record<string, string> {
  const emptyConfig = context.emptyConfigPath ?? EMPTY_CONFIG_PATH;
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_CONFIG_SYSTEM: emptyConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    /** The system-wide gitattributes file is a second content-filter channel. */
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
    /**
     * A prompt in a child of an extension host is a process nobody can see and
     * nobody can answer. With prompts disabled a credential problem fails in
     * milliseconds instead: measured against a local server answering 401, git
     * exited 128 in 16 ms with "could not read Username … terminal prompts
     * disabled". The askpass variables are emptied for the same reason — git
     * consults them before it considers the terminal.
     */
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    SSH_ASKPASS: '',
    /** So classification of git's own text does not depend on the machine's locale. */
    LC_ALL: 'C',
    LANG: 'C',
  };
  if (context.gitDir !== undefined) env.GIT_DIR = context.gitDir;
  if (process.platform === 'win32') {
    // Git for Windows and the C runtime need these to start at all; none of
    // them is a configuration channel. `HOMEDRIVE`/`HOMEPATH` are excluded
    // precisely because they are one — they are how git derives `HOME` there.
    for (const name of ['SystemRoot', 'SYSTEMROOT', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)']) {
      const value = process.env[name];
      if (value !== undefined) env[name] = value;
    }
  }
  if (context.credentialHeaderValue !== undefined && context.credentialHeaderValue !== '') {
    /**
     * Task 6.6. The credential goes in as `http.extraHeader` through the
     * environment, and never into `args` or a URL. On Linux
     * `/proc/<pid>/cmdline` is world-readable while `environ` is not, so argv is
     * a process listing away from every account on the machine; and git echoes
     * URLs back in its own error text, which is a channel that reaches the
     * model. Verified end to end against a local server: the request arrived
     * carrying the header while the argument list carried nothing of it.
     *
     * The value is whatever the descriptor composed and is never inspected
     * here. It read `Bearer …` when that verification was taken and reads
     * `Basic …` since 2026-09-09, because neither forge's git transport accepts
     * a bearer token; which scheme it is makes no difference to this file, and
     * the providers are where that is decided and recorded.
     */
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: ${context.credentialHeaderValue}`;
  }
  return env;
}

/**
 * The complete argument list the child is started with — the shared prefix
 * followed by the plan's own arguments.
 *
 * Exported because it is what actually runs. A structural test that asserted
 * `--` placement over `plan.args` alone would be asserting over something the
 * process never sees; the prefix is composed here so both the runner and the
 * tests read the same list.
 */
export function gitProcessArguments(plan: GitInvocationPlan, context: GitProcessContext): readonly string[] {
  if (!plan.needsRepository) return [...plan.args];
  return [...commonArguments(context), ...plan.args];
}

/**
 * What one invocation produced.
 *
 * `timedOut` and `outputCapped` are bounded, non-terminal outcomes by
 * construction: they say the invocation stopped, never anything about the
 * content. Design D8's invariant is that no failure path here may become an
 * irreversible file state — a file whose diff hit a bound stays classified and
 * uninspected, which the completion gate already refuses to call complete.
 *
 * `stderrExcerpt` is a diagnostic for this process and never a model-visible
 * reason: it is raw git text, in whatever shape that git version chose, which
 * is the thing every refusal reason in this module exists to replace.
 */
export type GitInvocationOutcome =
  | { readonly state: 'ok'; readonly stdout: Buffer; readonly exitCode: number; readonly stderrExcerpt: string; readonly durationMs: number }
  | { readonly state: 'failed'; readonly exitCode: number; readonly reason: string; readonly stderrExcerpt: string; readonly durationMs: number }
  | { readonly state: 'timedOut'; readonly reason: string; readonly limitMs: number; readonly durationMs: number }
  | { readonly state: 'outputCapped'; readonly reason: string; readonly capBytes: number; readonly durationMs: number }
  | { readonly state: 'unavailable'; readonly reason: string; readonly durationMs: number };

/**
 * Stop a git invocation and everything it started.
 *
 * Killing the child alone is not enough, and this is measured rather than
 * assumed: after `SIGKILL` on a `git fetch` blocked on a server that never
 * answered, `git-remote-http` was still running, orphaned, holding the socket
 * open — a process left waiting, which is exactly what task 6.18 forbids. Git
 * runs its transport as a child, so the child is started in its own process
 * group and the whole group is signalled.
 *
 * Windows has no process groups in this sense; there `child.kill()` is all Node
 * offers without shelling out to `taskkill`, and shelling out is the one thing
 * this module does not do. That branch is unexercised here and stated rather
 * than pretended.
 */
function killProcessTree(child: { pid?: number; kill(signal?: NodeJS.Signals): boolean }): void {
  const { pid } = child;
  if (pid !== undefined && process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // The group is already gone, or the platform refused; fall through to the
      // child itself rather than leaving it running.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Already exited between the decision and the signal.
  }
}

/**
 * Run a validated plan (tasks 6.1, 6.8).
 *
 * There is no overload taking an argument list: `GitInvocationPlan` is
 * unforgeable outside this module, so every invocation this project makes has
 * been through `planGitInvocation`. The first thing this function does is check
 * that at runtime as well, because the type that says so is erased before any
 * of this ships.
 */
export async function runGitInvocation(plan: GitInvocationPlan, context: GitProcessContext): Promise<GitInvocationOutcome> {
  if (!GitInvocationPlanValue.isPlan(plan)) {
    // Unreachable from type-checked code and one cast away from anywhere else.
    // Nothing validated these arguments, so nothing runs, and the answer is
    // this module's own words rather than a thrown error a caller would have to
    // know to catch.
    return { state: 'unavailable', reason: 'The git operation was not one this extension planned.', durationMs: 0 };
  }
  const bounds = { ...DEFAULT_GIT_BOUNDS, ...context.bounds };
  const limitMs = plan.timeBound === 'fetch' ? bounds.fetchTimeoutMs : bounds.readTimeoutMs;
  const args = gitProcessArguments(plan, context);
  const started = Date.now();

  return new Promise<GitInvocationOutcome>((resolve) => {
    let settled = false;
    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    let child: ReturnType<typeof spawn> | undefined;

    const elapsed = (): number => Date.now() - started;
    const stderrExcerpt = (): string => Buffer.concat(stderr).toString('utf8').trim();

    // The clock starts before the process does, so that a machine slow enough
    // to take seconds creating a child spends them inside the bound rather than
    // beside it.
    const timer = setTimeout(() => {
      if (child) killProcessTree(child);
      finish({
        state: 'timedOut',
        reason: `The git operation was stopped after ${String(limitMs)} ms.`,
        limitMs,
        durationMs: elapsed(),
      });
    }, limitMs);

    const finish = (outcome: GitInvocationOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    try {
      child = spawn(context.executable ?? 'git', [...args], {
        cwd: context.cwd ?? tmpdir(),
        env: gitProcessEnvironment(context),
        // stdin is closed rather than inherited: anything that still tries to
        // read input gets end-of-file at once instead of blocking on a terminal
        // this process may not even have.
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      // `spawn` throws synchronously for an argument this module should have
      // refused first — a NUL byte produces `ERR_INVALID_ARG_VALUE` — so
      // reaching here is a bug in validation, not a condition to explain to a
      // model. It is still answered with this module's own words.
      finish({ state: 'unavailable', reason: 'The git process could not be started.', durationMs: elapsed() });
      return;
    }

    // Narrowed once here rather than asserted at four call sites: `spawn`'s
    // return type does not carry which stdio was requested, so the pipes are
    // nullable to the type checker even though `stdio` above asks for both. A
    // child whose pipes really were absent could never be read, so it is
    // answered like any other process that could not be run.
    const gitProcess = child;
    const { stdout: stdoutStream, stderr: stderrStream } = gitProcess;
    if (!stdoutStream || !stderrStream) {
      killProcessTree(gitProcess);
      finish({ state: 'unavailable', reason: 'The git process could not be started.', durationMs: elapsed() });
      return;
    }

    stdoutStream.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > bounds.maxStdoutBytes) {
        killProcessTree(gitProcess);
        finish({
          state: 'outputCapped',
          reason: `The git operation produced more than ${String(bounds.maxStdoutBytes)} bytes and was stopped.`,
          capBytes: bounds.maxStdoutBytes,
          durationMs: elapsed(),
        });
        return;
      }
      stdout.push(chunk);
    });
    stderrStream.on('data', (chunk: Buffer) => {
      if (stderrBytes >= bounds.maxStderrBytes) return;
      stderrBytes += chunk.length;
      stderr.push(chunk);
    });

    gitProcess.on('error', () => {
      // No git on the machine at all lands here as ENOENT. Design D8 gives that
      // its own row: the source declares itself unsupported and selection moves
      // on, so the reason has to be a fact about this host and not an errno.
      finish({ state: 'unavailable', reason: 'The git executable could not be run on this machine.', durationMs: elapsed() });
    });

    gitProcess.on('close', (code) => {
      const exitCode = code ?? -1;
      if (plan.successExitCodes.includes(exitCode)) {
        finish({ state: 'ok', stdout: Buffer.concat(stdout), exitCode, stderrExcerpt: stderrExcerpt(), durationMs: elapsed() });
        return;
      }
      finish({
        state: 'failed',
        exitCode,
        reason: `The git operation did not complete (exit status ${String(exitCode)}).`,
        stderrExcerpt: stderrExcerpt(),
        durationMs: elapsed(),
      });
    });
  });
}

/**
 * The shape of "run this plan", so a module that runs git can take it as a
 * dependency instead of reaching for the function.
 *
 * `runGitInvocation` is the only production value this type ever holds. It
 * exists because the object cache's guarantees are about *every* invocation it
 * makes — that each one carries a `GIT_DIR` under the cache root, and that none
 * of them touches a repository the reviewer owns — and a claim about every
 * invocation is one no test can check by inspecting results.
 *
 * Substituting one is not a way around this seam: what a runner receives is a
 * `GitInvocationPlan`, which nothing outside this module can construct, so an
 * injected runner can observe a plan or decline to run it and cannot invent one.
 */
export type GitRunner = (plan: GitInvocationPlan, context: GitProcessContext) => Promise<GitInvocationOutcome>;

// ---- The support probe -----------------------------------------------------------------

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly raw: string;
}

/**
 * The floor, and what sets it (task 6.9).
 *
 * `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` arrived in git **2.32.0** (June
 * 2021), and without them this seam cannot keep the machine's own configuration
 * out of a review — which is not a degradation to accept quietly, so an older
 * git makes the source unsupported rather than unsafe. Everything else it needs
 * is older: `GIT_CONFIG_COUNT` is 2.31, `--no-write-fetch-head` 2.29,
 * `protocol.allow` 2.12, `--end-of-options` 2.24, `--literal-pathspecs` 1.9 and
 * `-z` numstat older still. So the config variables alone decide the number.
 */
export const MINIMUM_GIT_VERSION: GitVersion = { major: 2, minor: 32, patch: 0, raw: '2.32.0' };

export type GitSupport =
  | { readonly state: 'supported'; readonly version: GitVersion }
  | { readonly state: 'unsupported'; readonly reason: string; readonly version?: GitVersion };

/**
 * `git version 2.55.0`, and the shapes other builds add after it — Apple's
 * `git version 2.39.3 (Apple Git-145)`, Windows' `git version 2.44.0.windows.1`.
 * Only the leading three numbers are read; anything a vendor appends is theirs.
 */
export function parseGitVersion(output: string): GitVersion | undefined {
  // `String.match` rather than `RegExp.exec`, so that the word `exec` does not
  // appear as a call anywhere in this module: task 6.14's structural test reads
  // call names off the syntax tree, and a rule with an exception for "but that
  // one is a regular expression" is a rule with a hole in it.
  const match = output.match(/git version (\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return undefined;
  const [, major = '0', minor = '0', patch = '0'] = match;
  return { major: Number(major), minor: Number(minor), patch: Number(patch), raw: `${major}.${minor}.${patch}` };
}

/**
 * Exported so the floor is a checkable fact rather than a number inside a
 * probe: a test can ask about a version this machine does not have.
 */
export function meetsMinimumGitVersion(version: GitVersion): boolean {
  if (version.major !== MINIMUM_GIT_VERSION.major) return version.major > MINIMUM_GIT_VERSION.major;
  if (version.minor !== MINIMUM_GIT_VERSION.minor) return version.minor > MINIMUM_GIT_VERSION.minor;
  return version.patch >= MINIMUM_GIT_VERSION.patch;
}

let probed: Promise<GitSupport> | undefined;

/**
 * Ask the machine once per session whether it can serve this source at all
 * (task 6.9).
 *
 * Once, because the answer cannot change while the editor is running and
 * because the alternative — discovering there is no git at the first tool call
 * — is a run that announced a source it does not have. Design D5 puts this
 * before any model work for exactly that reason.
 */
export async function probeGitSupport(context: GitProcessContext = {}): Promise<GitSupport> {
  probed ??= (async (): Promise<GitSupport> => {
    const planned = planGitInvocation({ kind: 'version' });
    // Unreachable: `version` validates nothing. Answered rather than asserted,
    // because a probe that threw would fail a review over a missing git.
    if (!planned.ok) return { state: 'unsupported', reason: planned.refusal.reason };
    const outcome = await runGitInvocation(planned.plan, context);
    if (outcome.state !== 'ok') {
      return { state: 'unsupported', reason: 'No usable git executable was found on this machine.' };
    }
    const version = parseGitVersion(outcome.stdout.toString('utf8'));
    if (!version) {
      return { state: 'unsupported', reason: 'The installed git did not report a version this source can read.' };
    }
    if (!meetsMinimumGitVersion(version)) {
      return {
        state: 'unsupported',
        reason: `The installed git is ${version.raw}; ${MINIMUM_GIT_VERSION.raw} or newer is required to keep this machine's own git configuration out of a review.`,
        version,
      };
    }
    return { state: 'supported', version };
  })();
  return probed;
}

/**
 * Forget the session's answer. Test-only, and the reason it exists at all: the
 * probe is memoized per process, and vitest runs every file for one repository
 * in the same process, so a test that wants to see the probe run again would
 * otherwise be reading another test's answer.
 */
export function resetGitSupportProbe(): void {
  probed = undefined;
}
