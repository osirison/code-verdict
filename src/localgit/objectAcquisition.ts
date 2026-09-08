/**
 * Getting the two pinned commits into the cache, and proving they are the ones
 * that arrived — tasks 7.3, 7.4, 7.5, 7.8, 7.11 and 7.12 of
 * `add-local-git-investigation`, design D3 and D8.
 *
 * **Nothing here is checked out, and nothing here reads the reviewer's
 * repository.** Every invocation runs with `GIT_DIR` pointing at a bare
 * directory under this extension's own storage, composed by `objectCache.ts`
 * from a digest of the repository identity. There is no input to that path from
 * a model, a change request or a forge, no code path that accepts a directory
 * from a caller, and no alternates donor anywhere — design D3 rejects even the
 * weak form of borrowing objects from a clone the reviewer owns, because it
 * makes the cache silently unreadable the day that clone is repacked or
 * deleted.
 *
 * **Two facts make a commit present**, and both are checked before a fetch is
 * skipped and again after every fetch (task 7.4): the object is in the database
 * and is a commit, and the ref named after it points at it. Objects alone are
 * not enough — a fetch that left them dangling leaves them prunable, so a later
 * `git gc` could take away a commit an earlier acquisition reported as held. The
 * ref is named from the object id (`refs/codeverdict/<sha>`, design D3), so two
 * attempts wanting the same commit write the same name with the same value and
 * cannot race into disagreement.
 *
 * **The ref hint is used without being understood** (design D8, task 7.5). When
 * a fetch by object id fails and the descriptor carries a hint, the fetch is
 * retried with the hint in the source position of the same refspec. This module
 * never parses it, never composes one, and does not know that
 * `refs/pull/<n>/head` is a thing — that knowledge stays inside the provider
 * that built the descriptor. What makes accepting an opaque value safe is that
 * the object which arrives is checked against the pinned id afterwards: a hint
 * pointing somewhere else fails with a named mismatch and its ref is removed,
 * rather than substituting a different commit into the review.
 *
 * **A merge base is proved before it is accepted, never just read.** `git
 * merge-base` computes over the history this store holds and cannot say which
 * history that was: in a shallow store it answers an *older* common ancestor —
 * exit 0, an object id, nothing wrong on the face of it — when the real merge
 * base sits past the shallow boundary. Measured on 2026-09-11 through
 * `createObjectCache` with the default policy, git 2.55.0, against a real
 * `git-http-backend` remote:
 *
 *     DEFAULT-POLICY OUTCOME {"state":"acquired","baseSha":"4dd2d4b…","depthReached":10}
 *     TRUE MERGE BASE = 542cc47…   ACCEPTED BASE = 4dd2d4b…
 *
 * The review then reads a diff against an older commit than the change request
 * is against, with every commit in between showing up as part of the change,
 * and no error anywhere. `mergeBaseIsProven` below is what stops that; the
 * property it establishes is that the accepted base is the one a full clone
 * would report, and the rule and its sufficiency are written out there.
 *
 * **A refusal is never reported as an absence.** Git cannot tell us which one it
 * is — a server with `uploadpack.allowAnySHA1InWant` off refuses a want for an
 * unadvertised object without ever looking the object up, and the wording of
 * that refusal is not a contract across servers, versions and configurations.
 * Measured on 2026-09-11 against `git-http-backend`, the same fetch of the same
 * unadvertised commit is refused under protocol v0 ("Server does not allow
 * request for unadvertised object") and served under protocol v2, from one
 * server with one configuration. So this module reports "could not be fetched"
 * and stops; deciding whether the commit is gone is task 9.9's job, and it asks
 * the provider rather than git's error text.
 */
import type { ObjectSourceDescriptor } from '../platform/types';
import { openCacheRepository } from './cacheRepository';
import {
  LOCAL_MERGE_TARGET_REF,
  planGitInvocation,
  runGitInvocation,
  type GitInvocationOutcome,
  type GitObjectId,
  type GitOperation,
  type GitProcessContext,
  type GitRunner,
} from './gitInvocation';
import { depthLadder, gitBoundsFromPolicy, normalizeLocalGitPolicy, type LocalGitPolicy } from './localGitPolicy';
import {
  acquireCacheLock,
  directorySizeBytes,
  evictObjectCache,
  prepareCacheEntry,
  readCacheEntryMetadata,
  takeCacheLease,
  writeCacheEntryMetadata,
  type CacheLease,
  type EvictionOutcome,
  type RepositoryIdentity,
} from './objectCache';

export interface ObjectCacheOptions {
  /** The cache root — `objectCacheRoot(context.globalStorageUri.fsPath)` in production. */
  readonly root: string;
  /** Overrides for any of the injected bounds; anything omitted takes its documented default. */
  readonly policy?: Partial<LocalGitPolicy>;
  /** The editor's own proxy setting, applied explicitly because global git configuration is ignored (task 6.7). */
  readonly proxyUrl?: string;
  /** Defaults to `git` on `PATH`; a test pins a specific build with it. */
  readonly executable?: string;
  readonly now?: () => number;
  /**
   * How invocations are run. Production leaves it alone; a test passes one to
   * record what actually ran — task 7.10's claim is about *every* invocation
   * this module makes, which no test can check by looking at results — or to
   * stand in for a remote that never answers, which would otherwise cost the
   * suite a real timeout.
   */
  readonly run?: GitRunner;
}

export interface AcquisitionRequest {
  readonly identity: RepositoryIdentity;
  /** Where to fetch from, what to authenticate with, and the two opaque refs — all used, none interpreted. */
  readonly descriptor: ObjectSourceDescriptor;
  /** Whose lease holds this entry against eviction for the length of the attempt. */
  readonly attemptId: string;
  /**
   * The pinned head. A full hex object id; anything else is refused before git
   * runs.
   *
   * There is no pinned base to pass any more. The base used to arrive here as a
   * second commit id, computed by the forge — GitHub's `merge_base_commit.sha`,
   * GitLab's `diff_refs.base_sha` — and fetched exactly like the head. It is
   * computed here now, by `git merge-base` over the head and the target branch
   * named in the descriptor, because a merge base is a fact about two commits
   * and the rule is that git answers everything git can answer.
   */
  readonly headCommit: GitObjectId;
}

export type AcquisitionUnavailableCode =
  /** The cache location could not be created or written to (task 7.12). */
  | 'cacheUnwritable'
  /**
   * The object source would not authorize the fetch (design D8's credentials
   * row). Its own code because it is the one acquisition failure a reviewer can
   * actually act on, and because nothing was learned about the pinned commits:
   * the transport never got as far as asking for one.
   */
  | 'credentialsRefused'
  /** Another attempt held the acquisition lock for longer than the bounded wait. */
  | 'lockBusy'
  /** The object store itself could not be opened or vouched for (`cacheRepository.ts`). */
  | 'storeUnusable'
  /** The descriptor was refused before any fetch — a transport that is not http/https, an unusable hint, a bad depth. */
  | 'requestRefused';

export type AcquisitionFailureCode =
  /**
   * The remote did not serve the commit. Deliberately says nothing about whether
   * it still exists: design D8 gives "refused" and "gone" different states, and
   * only the provider can tell them apart (task 9.9).
   */
  | 'fetchFailed'
  /** A fetch reported success and the pinned object was still not present afterwards. Never accepted. */
  | 'wrongObject'
  /** The ref hint resolved to a different commit (task 7.5). Its ref is removed and the review does not proceed. */
  | 'hintMismatch'
  /**
   * The head arrived and the change request's target branch did not, so there
   * is nothing to compute a merge base against. Its own code because the head
   * is fine and the reviewer's problem is a different one.
   */
  | 'targetRefUnfetchable'
  /**
   * Head and target branch are both held, and git found no common ancestor
   * between them anywhere in the history that was fetched, at the deepest
   * fetch this is allowed to ask for.
   */
  | 'mergeBaseNotFound'
  /**
   * A candidate merge base was found and could not be proved to be the one a
   * full clone would report, at the deepest fetch this is allowed to ask for.
   *
   * Its own code because it is a different fact from `mergeBaseNotFound`, and
   * the difference is the whole point: there *is* a common ancestor here, and
   * this module will not hand over one it cannot show is the right one. A
   * review against the wrong base reads a diff nobody asked for and says
   * nothing about it, which is the failure the proof exists to prevent.
   */
  | 'mergeBaseUnproven'
  /**
   * The descriptor named no target branch at all, so no merge base can be
   * computed and there is no forge to ask for one instead.
   */
  | 'noMergeTarget';

export type AcquisitionOutcome =
  | {
      readonly state: 'acquired';
      readonly gitDir: string;
      /** Held until the attempt ends; `release()` on the way out, `refresh()` while it runs. */
      readonly lease: CacheLease;
      /**
       * The merge base, computed here by git and pinned under its own ref
       * (`writeCommitRef`) so it is as durable as the head. This is the commit
       * every investigation read in the attempt is scoped against, and it came
       * from the object store rather than from a platform's JSON.
       */
      readonly baseSha: GitObjectId;
      /** How deep the fetch had to go before the merge base was in the history — reported so a slow first review says why. */
      readonly depthReached: number;
      readonly fetched: readonly GitObjectId[];
      readonly alreadyPresent: readonly GitObjectId[];
      /** True when the store failed its ownership check and was rebuilt — worth recording as a limitation. */
      readonly recreated: boolean;
    }
  | { readonly state: 'unavailable'; readonly code: AcquisitionUnavailableCode; readonly reason: string }
  | {
      readonly state: 'commitUnobtainable';
      readonly code: AcquisitionFailureCode;
      readonly commit: GitObjectId;
      readonly reason: string;
      /**
       * Git's own text, for this process's diagnostics only. It is never a
       * model-visible reason and never a stored record: it is raw output in
       * whatever shape that git version chose, which is the thing every reason
       * in this module exists to replace.
       */
      readonly diagnostic?: string;
    };

export interface ObjectCache {
  readonly root: string;
  readonly policy: LocalGitPolicy;
  acquire(request: AcquisitionRequest): Promise<AcquisitionOutcome>;
  evict(): Promise<EvictionOutcome>;
}

/** This module's own words, never git's. Each one names the rule or the fact, and quotes nothing back. */
const REASONS = {
  cacheUnwritable: 'The object cache location could not be created or written to, so objects were not obtained for this repository.',
  credentialsRefused: 'The object source would not authorize this fetch with the credential this connection has for it.',
  lockBusy: 'Another review is still obtaining objects for this repository, and the wait for it timed out.',
  requestRefused: 'Objects could not be requested for this repository: the object source was not one this extension will fetch from.',

  fetchFailed: 'That revision could not be obtained from this repository’s object source.',
  wrongObject: 'The object source answered with something other than the revision this review is pinned to, so it was not used.',
  hintMismatch: 'The object source’s alternate reference resolved to a different revision than the one this review is pinned to, so it was not used.',
  targetRefUnfetchable: 'The branch this change request is to be merged into could not be obtained from this repository’s object source, so the commit its diff is against could not be computed.',
  noMergeTarget: 'This connection does not say which branch this change request is to be merged into, so the commit its diff is against could not be computed.',
} as const;

/** What an object id looks like coming back from `rev-parse`: sha-1 or sha-256, lowercase hex. */
const OBJECT_ID = /^[0-9a-f]{40,64}$/;

/** How many pinned commits an entry's record keeps. Diagnostics, not an inventory — the refs in the store are that. */
const RECORDED_COMMITS = 50;

/**
 * The one thing this module reads git's own text to decide, and why that is not
 * the rule it breaks elsewhere.
 *
 * The rule this module states at the top is that a *refusal to serve an object*
 * must never be read out of git's error text, because that wording belongs to
 * the server and varies by server, version and protocol. Authorization is a
 * different question with a different author: the text below is git's and
 * curl's own, produced by the transport before any server-specific message is
 * involved, and it is stable because the environment this module constructs
 * fixes the locale (`LC_ALL=C`) and forbids prompting.
 *
 * Measured on 2026-09-11, git 2.55.0, against a local HTTP server, with the
 * exact environment `gitProcessEnvironment` builds and with the credential
 * supplied as `http.extraHeader` exactly as `fetchCommit` supplies it:
 *
 *     401 -> fatal: could not read Username for 'http://…': terminal prompts disabled   (exit 128)
 *     403 -> fatal: unable to access 'http://…': The requested URL returned error: 403  (exit 128)
 *
 * The 401 line is what a rejected credential produces here rather than
 * "Authentication failed", because with prompting disabled git gives up at the
 * challenge instead of retrying interactively; the third pattern covers the
 * machine where an askpass does answer.
 *
 * **403 is deliberately not matched**, even though it is an authorization
 * status. A forge that declines to serve an object nobody advertised answers
 * 403 as well — that is the refusal task 7.5's ref-hint retry exists for, and
 * the fake in `objectAcquisition.test.ts` answers it exactly that way — and git
 * reports both with the same "The requested URL returned error: 403" line.
 * Matching it would turn a retryable, well-understood refusal into a credential
 * problem and skip the retry that recovers from it. `objectAcquisition.test.ts`
 * asserts that boundary in both directions.
 *
 * Nothing is matched loosely: an unmatched failure stays the generic "could not
 * be obtained", because claiming a credential problem that is not one sends the
 * reviewer to reconnect an account that was never the issue.
 *
 * The matched text is never echoed. The reason returned is this module's own.
 */
const CREDENTIAL_REFUSAL_PATTERNS: readonly RegExp[] = [
  /could not read username for/i,
  /could not read password for/i,
  /authentication failed/i,
  /returned error: 401\b/,
];

function isCredentialRefusal(stderrExcerpt: string): boolean {
  return CREDENTIAL_REFUSAL_PATTERNS.some((pattern) => pattern.test(stderrExcerpt));
}

export function createObjectCache(options: ObjectCacheOptions): ObjectCache {
  const policy = normalizeLocalGitPolicy(options.policy ?? {});
  const now = options.now ?? Date.now;
  const run: GitRunner = options.run ?? runGitInvocation;
  const bounds = gitBoundsFromPolicy(policy);

  /**
   * The context every invocation runs with.
   *
   * The credential is passed only where there is a remote to send it to. A
   * `rev-parse` against a local object database has nobody to authenticate to,
   * and putting a secret into a child's environment that has no use for it
   * widens the window it exists in for nothing.
   */
  const contextFor = (gitDir: string, credentialHeaderValue?: string): GitProcessContext => ({
    gitDir,
    bounds,
    proxyUrl: options.proxyUrl,
    executable: options.executable,
    ...(credentialHeaderValue === undefined ? {} : { credentialHeaderValue }),
  });

  const invoke = async (operation: GitOperation, context: GitProcessContext): Promise<GitInvocationOutcome | { readonly state: 'refused'; readonly reason: string }> => {
    const planned = planGitInvocation(operation);
    if (!planned.ok) return { state: 'refused', reason: planned.refusal.reason };
    return run(planned.plan, context);
  };

  /**
   * Is this commit held, in the only sense that counts? (Tasks 7.3, 7.4.)
   *
   * The ref points at it *and* the object is present and is a commit. Either
   * alone is a weaker claim: a ref can be made to point at anything by a fetch
   * whose source was a name rather than an id, and an object with no ref is one
   * repack away from being gone.
   */
  const isHeld = async (gitDir: string, commit: GitObjectId): Promise<boolean> => {
    const ref = await invoke({ kind: 'readCommitRef', commit }, contextFor(gitDir));
    if (ref.state !== 'ok' || ref.stdout.toString('utf8').trim() !== commit) return false;
    const object = await invoke({ kind: 'verifyCommit', revision: commit }, contextFor(gitDir));
    return object.state === 'ok' && object.stdout.toString('utf8').trim() === commit;
  };

  /**
   * What the change request's target branch points at in this store right now,
   * or nothing.
   *
   * Read as "does the ref resolve to a commit", not "does the ref exist": a
   * fetch that wrote the ref and a fetch that failed after writing part of a
   * refspec set are told apart by whether there is a commit on the other end.
   *
   * The commit id itself is returned rather than a yes/no because the merge-base
   * proof needs it: a candidate that *is* one of the two pinned revisions is
   * proved by being it, and asking for this ref a second time to find that out
   * would be a second invocation for an answer already in hand.
   */
  const targetRefCommit = async (gitDir: string): Promise<GitObjectId | undefined> => {
    const resolved = await invoke({ kind: 'readMergeTargetRef' }, contextFor(gitDir));
    if (resolved.state !== 'ok') return undefined;
    const commit = resolved.stdout.toString('utf8').trim();
    return OBJECT_ID.test(commit) ? commit : undefined;
  };

  /**
   * Has this store run out of history to deepen into?
   *
   * `rev-parse --is-shallow-repository` prints `false` once no shallow boundary
   * is left, and at that point another fetch cannot add a commit — measured on
   * 2026-09-11 against a 131-commit repository, where `--depth=160` and
   * `--depth=640` returned identical bytes and both left the store unshallow.
   * So a merge base still missing here is missing from the repository's whole
   * history, which is a different fact from "not in the part we fetched" and
   * gets a different reason.
   */
  const stillShallow = async (gitDir: string): Promise<boolean> => {
    const answer = await invoke({ kind: 'isShallow' }, contextFor(gitDir));
    // An invocation that did not answer is treated as still shallow: the cost
    // of guessing wrong that way is one more fetch, and the cost of guessing
    // the other way is refusing a review whose merge base the next step would
    // have found.
    return answer.state !== 'ok' || answer.stdout.toString('utf8').trim() !== 'false';
  };

  /**
   * Does this commit record parents of its own?
   *
   * The one question about a commit that no traversal can answer in a shallow
   * store. A graft hides a commit's parents from `rev-list`, from
   * `rev-parse <sha>^1` and from `log --format=%P` alike, so a truncation point
   * and a repository's genuine root commit look identical to every walk. The
   * object is not grafted, and says which one this is.
   *
   * An invocation that did not answer counts as recording parents — the
   * conservative direction here, because that answer only ever makes a merge
   * base *unproven*, and the cost of being wrong that way is a deeper fetch
   * rather than a review against the wrong commit.
   */
  const recordsParents = async (gitDir: string, commit: GitObjectId): Promise<boolean> => {
    const object = await invoke({ kind: 'readCommitObject', commit }, contextFor(gitDir));
    if (object.state !== 'ok') return true;
    const text = object.stdout.toString('utf8');
    // The header ends at the first blank line; everything after it is the commit
    // message, where a line beginning "parent " is someone's prose.
    const header = text.split('\n\n')[0] ?? '';
    return header.split('\n').some((line) => line.startsWith('parent '));
  };

  /**
   * Is this candidate the merge base a *full clone* would report?
   *
   * That is the property, and nothing weaker will do: a base that is merely a
   * common ancestor puts every commit between it and the real one into the
   * review's diff, silently.
   *
   * **The rule.** A candidate is proved when no *truncation point* lies strictly
   * above it — where a truncation point is a commit this store walks as
   * parentless that records parents of its own.
   *
   * **Why that is sufficient.** `git merge-base` returns the best common
   * ancestor of the graph it can see, and every edge it can see is a real edge,
   * so its answer is always a real common ancestor. It can only be the *wrong*
   * one if a better common ancestor was invisible to it — either absent from the
   * store, or present but cut off from one of the two tips. Both cases need a
   * truncation point between a tip and that better ancestor, and a better
   * ancestor is by definition not an ancestor of the candidate, so that
   * truncation point is not an ancestor of the candidate either. No truncation
   * point above the candidate therefore means no better common ancestor exists
   * anywhere, visible or not — so the best visible answer is the best answer.
   *
   * **Why "the answer did not change when we deepened" is not the rule.** It is
   * evidence and it is not proof: a true merge base two rungs deeper leaves the
   * same wrong answer standing across one deepening, and the ladder would accept
   * it with exactly the confidence it accepts a right one. The frontier check
   * costs one local `rev-list` per rung and answers the question instead of
   * polling it.
   *
   * A store with no shallow boundary left needs none of this: its history is the
   * repository's history, so any answer over it is the full-clone answer.
   */
  const mergeBaseIsProven = async (gitDir: string, head: GitObjectId, target: GitObjectId, candidate: GitObjectId): Promise<boolean> => {
    // A candidate that is one of the two pinned revisions is proved by being it,
    // whatever the boundary looks like. `merge-base` answering `head` means the
    // head is an ancestor of the target, and every edge this store can see is a
    // real edge, so it is an ancestor of it in the repository too — and nothing
    // can beat one of the two inputs, because every common ancestor of the pair
    // is an ancestor of both. The frontier check would ask for history *above*
    // such a candidate, which is history the answer does not depend on.
    if (candidate === head || candidate === target) return true;
    if (!(await stillShallow(gitDir))) return true;
    const frontier = await invoke({ kind: 'parentlessCommitsAbove', head, candidate }, contextFor(gitDir));
    // Unreadable is unproven, for the same reason `recordsParents` fails that
    // way: the only cost is another rung, and the alternative is accepting a
    // base nothing checked.
    if (frontier.state !== 'ok') return false;
    const commits = frontier.stdout
      .toString('utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => OBJECT_ID.test(line));
    for (const commit of commits) {
      // A genuine root commit above the candidate is not a truncation and is not
      // rare — a repository that merged an unrelated history has one — so it must
      // not refuse a review that can be proved.
      if (await recordsParents(gitDir, commit)) return false;
    }
    return true;
  };

  const acquireUnderLock = async (gitDir: string, request: AcquisitionRequest, recreated: boolean, lease: CacheLease): Promise<AcquisitionOutcome> => {
    const fetched: GitObjectId[] = [];
    const alreadyPresent: GitObjectId[] = [];
    const credential = request.descriptor.authorizationHeaderValue;
    const head = request.headCommit;
    const targetRef = request.descriptor.mergeTargetRef;

    const fetchOnce = async (depth: number, refHint?: string): Promise<GitInvocationOutcome | { readonly state: 'refused'; readonly reason: string }> =>
      invoke(
        {
          kind: 'fetchCommit',
          fetchUrl: request.descriptor.fetchUrl,
          commit: head,
          depth,
          ...(refHint === undefined ? {} : { refHint }),
          ...(targetRef === undefined || targetRef === '' ? {} : { targetRef }),
        },
        contextFor(gitDir, credential),
      );

    /**
     * The target branch alone, for a store that already holds the pinned head —
     * **on the first rung only**.
     *
     * Task 7.6's waiter, kept true under local merge-base computation: whoever
     * held the lock before us may have fetched exactly the commit we wanted, and
     * a commit id cannot have changed since. The branch still has to be
     * re-fetched — it is a name, and where it points now is the whole question —
     * but asking for the head again would pay a round trip for an object already
     * in the store, which is the difference between a slow second review and a
     * fast one.
     *
     * It stops being safe the moment the ladder escalates, and the failure is
     * quiet: a store holding the head at depth 10 from an earlier attempt, a
     * change request since retargeted so its merge base sits 40 commits back,
     * and a ladder that deepens only the branch reaches the ancestor on one side
     * and never on the other. It would then refuse at the bound with a reason
     * claiming no ancestor exists "on either side", which would be false — the
     * head side was never deepened past what it already had. So escalation uses
     * the combined fetch, and both sides deepen together.
     */
    const fetchTargetOnly = async (depth: number): Promise<GitInvocationOutcome | { readonly state: 'refused'; readonly reason: string }> =>
      invoke(
        { kind: 'fetchMergeTarget', fetchUrl: request.descriptor.fetchUrl, targetRef: targetRef ?? '', depth },
        contextFor(gitDir, credential),
      );

    const discardRef = async (commit: GitObjectId): Promise<void> => {
      await invoke({ kind: 'deleteCommitRef', commit }, contextFor(gitDir));
    };

    // Refused with the seam's own words rather than this module's: what is
    // wrong with a value that is not a full object id is the revision rule, not
    // the fetch location, and `REASONS.requestRefused` would name the wrong
    // rule to whoever reads the reason.
    const revision = planGitInvocation({ kind: 'verifyCommit', revision: head });
    if (!revision.ok) {
      return { state: 'unavailable', code: 'requestRefused', reason: revision.refusal.reason };
    }
    // No target branch means no merge base and — since this change removed the
    // forge fallback — no other way to learn what the diff is against. Said
    // before any network work, because nothing a fetch returns could fix it.
    if (targetRef === undefined || targetRef === '') {
      return { state: 'commitUnobtainable', code: 'noMergeTarget', commit: head, reason: REASONS.noMergeTarget };
    }

    /**
     * One rung of the ladder: fetch the head and the target branch at `depth`,
     * retrying the head through the descriptor's opaque hint exactly as design
     * D8 describes when the bare object id is refused.
     *
     * Both refspecs travel in one invocation (`gitInvocation.ts`'s own note on
     * `fetchCommit`), so a rung is one network round trip, and what arrived is
     * read back from the store afterwards rather than inferred from the exit
     * code — a fetch can leave one refspec applied and fail on the other.
     */
    const fetchRung = async (depth: number, headHeld: boolean): Promise<AcquisitionOutcome | 'fetched' | 'fetchedByHint'> => {
      if (headHeld) {
        const targetOnly = await fetchTargetOnly(depth);
        if (targetOnly.state === 'refused') {
          return { state: 'unavailable', code: 'requestRefused', reason: targetOnly.reason };
        }
        if (targetOnly.state === 'ok') return 'fetched';
        if (targetOnly.state === 'failed' && isCredentialRefusal(targetOnly.stderrExcerpt)) {
          return { state: 'unavailable', code: 'credentialsRefused', reason: REASONS.credentialsRefused };
        }
        return { state: 'commitUnobtainable', code: 'targetRefUnfetchable', commit: head, reason: REASONS.targetRefUnfetchable };
      }
      const byObjectId = await fetchOnce(depth);
      if (byObjectId.state === 'refused') {
        return { state: 'unavailable', code: 'requestRefused', reason: byObjectId.reason };
      }
      if (byObjectId.state === 'ok') return 'fetched';

      // Checked before the ref-hint retry, not after: a source that would not
      // authorize this fetch will not authorize the same fetch with another
      // refspec on it, and the retry would be one more request to a server that
      // has already said no. Design D8 calls this a non-retryable failure.
      if (byObjectId.state === 'failed' && isCredentialRefusal(byObjectId.stderrExcerpt)) {
        return { state: 'unavailable', code: 'credentialsRefused', reason: REASONS.credentialsRefused };
      }

      const refHint = request.descriptor.refHint;
      if (refHint !== undefined && refHint !== '') {
        const byHint = await fetchOnce(depth, refHint);
        if (byHint.state === 'refused') {
          return { state: 'unavailable', code: 'requestRefused', reason: byHint.reason };
        }
        if (byHint.state === 'ok') return 'fetchedByHint';
      }

      // Attributed from the store, not from git's text. If the head is held
      // after all this, what failed was the target branch, and saying "the
      // pinned revision could not be obtained" would send a reviewer looking at
      // the wrong thing. Neither answer is read out of stderr, for the reason
      // this module's header states.
      if (await isHeld(gitDir, head)) {
        return { state: 'commitUnobtainable', code: 'targetRefUnfetchable', commit: head, reason: REASONS.targetRefUnfetchable };
      }
      return {
        state: 'commitUnobtainable',
        code: 'fetchFailed',
        commit: head,
        reason: REASONS.fetchFailed,
        ...('stderrExcerpt' in byObjectId && byObjectId.stderrExcerpt !== '' ? { diagnostic: byObjectId.stderrExcerpt } : {}),
      };
    };

    const headAlreadyPresent = await isHeld(gitDir, head);
    /**
     * Every depth this ladder will ask for, built once before the first fetch.
     *
     * The loop used to compute the next rung itself, from the same three policy
     * fields `lockStaleFor` counts rungs over. Two derivations of one schedule,
     * and they disagreed: `lockStaleFor` refused to count a rung for a factor
     * that could not deepen, the loop multiplied by it anyway, and with
     * `mergeBaseDepthFactor: 1` the loop ran 13 identical depth-10 fetches at a
     * real remote — an unbounded run of network round trips — under a lock whose
     * staleness threshold had been derived for a single rung. Now there is one
     * schedule, `depthLadder` builds it, and both read the same array.
     *
     * It is also what bounds this loop, and it bounds it structurally rather
     * than arithmetically: the loop advances one index per iteration and returns
     * when the array has no next rung, so the number of fetches it can make is
     * the length of a finite array that was built before any of them ran. A
     * separate rung counter beside it would restate that length and could never
     * fire; this cannot be made not to terminate by any policy, including one
     * built by hand without passing through `normalizeLocalGitPolicy`.
     */
    const ladder = depthLadder(policy.fetchDepth, policy.mergeBaseDepthFactor, policy.mergeBaseMaxDepth);
    let rung = 0;
    let depth = ladder[0];
    let depthReached = depth;
    let base: GitObjectId | undefined;
    /** Whether the last rung found a candidate it could not prove — which reason the bound reports. */
    let unproven = false;

    // The ladder. Each rung fetches at one depth, asks git for the merge base,
    // and proves the answer before taking it; a rung that cannot find one, or
    // cannot prove the one it found, steps to the next rung and asks again,
    // until the schedule runs out. The loop is bounded twice over: by the
    // schedule having a last rung, and by the store running out of shallow
    // boundary to deepen into.
    //
    // The schedule is unchanged by the proof — 10, then x10 twice, bounded at
    // 1000 — and the reasoning behind it still holds, because the proof costs no
    // network at all. It is one local `rev-list` per rung, plus one `cat-file`
    // per parentless commit above the candidate, which on an ordinary change is
    // none: measured on 2026-09-11 against a 34-commit remote, an ordinary
    // change proved its merge base on the first rung with the store still
    // shallow, so the common case pays a local read and no extra round trip.
    for (;;) {
      // Task 7.6's waiter: whoever held the lock before us may have fetched
      // exactly what we wanted. The target branch still has to be re-fetched,
      // because unlike a commit id it is a moving name and the merge base has
      // to be computed against where it points now.
      const outcome = await fetchRung(depth, headAlreadyPresent && rung === 0);
      if (outcome !== 'fetched' && outcome !== 'fetchedByHint') return outcome;
      depthReached = depth;

      if (!(await isHeld(gitDir, head))) {
        // A fetch that succeeded without leaving the pinned object behind.
        //
        // Through the hint, that is the case task 7.5 exists for: the hint
        // resolved on the remote and gave us something, and it was not what
        // this review is pinned to. The ref it wrote carries the pinned
        // commit's name, so it is removed before anything can read it.
        //
        // By object id, it should be unreachable — git verifies the ids of what
        // it receives — and design D8 still gives it a row, because "the
        // fetched object is not the pinned sha" is the one failure that must
        // never be accepted quietly.
        await discardRef(head);
        return outcome === 'fetchedByHint'
          ? { state: 'commitUnobtainable', code: 'hintMismatch', commit: head, reason: REASONS.hintMismatch }
          : { state: 'commitUnobtainable', code: 'wrongObject', commit: head, reason: REASONS.wrongObject };
      }
      const target = await targetRefCommit(gitDir);
      if (target === undefined) {
        return { state: 'commitUnobtainable', code: 'targetRefUnfetchable', commit: head, reason: REASONS.targetRefUnfetchable };
      }

      const computed = await invoke({ kind: 'mergeBase', left: head, right: LOCAL_MERGE_TARGET_REF }, contextFor(gitDir));
      const candidate = computed.state === 'ok' ? computed.stdout.toString('utf8').trim() : '';
      if (OBJECT_ID.test(candidate)) {
        // Proved, not read. An answer this store can produce and cannot stand
        // behind is the one failure mode that looks exactly like success.
        if (await mergeBaseIsProven(gitDir, head, target, candidate)) {
          base = candidate;
          break;
        }
        unproven = true;
      } else {
        unproven = false;
        // No answer at all, and no history left to look in: the two really have
        // no common ancestor. A different fact from an answer that could not be
        // proved, and it gets a different reason.
        if (!(await stillShallow(gitDir))) {
          return {
            state: 'commitUnobtainable',
            code: 'mergeBaseNotFound',
            commit: head,
            reason: `This revision and the branch it is to be merged into have no common ancestor anywhere in this repository’s history, so there is no commit for its diff to be against.`,
          };
        }
      }
      // The last rung of the schedule, which is the deepest history this will
      // fetch. Read off the ladder rather than compared against
      // `mergeBaseMaxDepth`, so the depth the reason names is the depth that was
      // actually asked for.
      const next = ladder[rung + 1];
      if (next === undefined) {
        return unproven
          ? {
              state: 'commitUnobtainable',
              code: 'mergeBaseUnproven',
              commit: head,
              reason: `The commit this revision’s diff is against could not be established: a candidate was found, and ${String(depth)} commits of history — as deep as this review will fetch — was not enough to show it is the one a full copy of this repository would report. A review against the wrong one would read a different change than this one, so none was made.`,
            }
          : {
              state: 'commitUnobtainable',
              code: 'mergeBaseNotFound',
              commit: head,
              reason: `The commit this revision’s diff is against was not found within ${String(depth)} commits of history on either side, which is as deep as this review will fetch.`,
            };
      }
      rung += 1;
      depth = next;
    }

    // Pinned under its own ref before anything reads it: it arrived reachable
    // only from the target branch, which the next attempt's fetch will move.
    // Asked first whether it was already pinned, so the activity line can say
    // truthfully how much of this review's history was already held.
    const baseAlreadyPresent = await isHeld(gitDir, base);
    const pinned = await invoke({ kind: 'writeCommitRef', commit: base }, contextFor(gitDir));
    if (pinned.state !== 'ok' || !(await isHeld(gitDir, base))) {
      return { state: 'commitUnobtainable', code: 'wrongObject', commit: base, reason: REASONS.wrongObject };
    }

    if (headAlreadyPresent) alreadyPresent.push(head);
    else fetched.push(head);
    if (base !== head) (baseAlreadyPresent ? alreadyPresent : fetched).push(base);

    return { state: 'acquired', gitDir, lease, baseSha: base, depthReached, fetched, alreadyPresent, recreated };
  };

  const evict = (): Promise<EvictionOutcome> => evictObjectCache(options.root, policy, { now });

  return {
    root: options.root,
    policy,
    evict,
    async acquire(request: AcquisitionRequest): Promise<AcquisitionOutcome> {
      const prepared = prepareCacheEntry(options.root, request.identity, { now });
      if (!prepared.ok) return { state: 'unavailable', code: 'cacheUnwritable', reason: REASONS.cacheUnwritable };
      const paths = prepared.paths;

      // The lease goes down before the lock, not after: eviction skips a leased
      // entry, and the window this closes is a run that waits on the lock while
      // another process's eviction removes the very directory it is waiting for.
      const lease = takeCacheLease(paths, request.attemptId, { now });
      if (!lease) return { state: 'unavailable', code: 'cacheUnwritable', reason: REASONS.cacheUnwritable };

      let outcome: AcquisitionOutcome;
      const locked = await acquireCacheLock(paths, policy, { now });
      if (!locked.ok) {
        lease.release();
        return locked.reason === 'busy'
          ? { state: 'unavailable', code: 'lockBusy', reason: REASONS.lockBusy }
          : { state: 'unavailable', code: 'cacheUnwritable', reason: REASONS.cacheUnwritable };
      }
      try {
        const opened = await openCacheRepository(paths.gitDir, contextFor(paths.gitDir), run);
        outcome =
          opened.state === 'ready'
            ? await acquireUnderLock(opened.gitDir, request, opened.recreated, lease)
            : { state: 'unavailable', code: 'storeUnusable', reason: opened.reason };
      } finally {
        locked.lock.release();
      }

      if (outcome.state === 'acquired') {
        // The identity and the size are taken from this request and this
        // directory rather than merged with what was there, so a record that was
        // truncated or lost is corrected here as well as at `prepareCacheEntry`.
        // The commit list is the one field that accumulates, and it is bounded:
        // it is a diagnostic — "what has this entry been asked for lately" — not
        // an inventory of the store, which the refs themselves are, so a
        // repository reviewed a thousand times keeps the last of them instead of
        // growing a record without end.
        const previous = readCacheEntryMetadata(paths);
        const commits = [...new Set([...(previous?.commits ?? []), ...outcome.fetched, ...outcome.alreadyPresent])].slice(-RECORDED_COMMITS);
        writeCacheEntryMetadata(paths, {
          identity: request.identity,
          lastUsedAtMs: now(),
          sizeBytes: directorySizeBytes(paths.directory),
          commits,
        });
      } else {
        lease.release();
      }

      // Task 7.8: after every acquisition as well as at activation. This entry
      // cannot be the one removed — the lease taken above is live, and eviction
      // skips a leased entry — so a review never evicts the objects it just
      // obtained.
      await evict();
      return outcome;
    },
  };
}
