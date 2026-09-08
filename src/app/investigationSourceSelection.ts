/**
 * Which source answers a member's investigation, and what commit its diff is
 * against — decided once, before the snapshot is built and before any model
 * work.
 *
 * **There is one source, and it is local git.** This module used to choose:
 * local git when the objects could be obtained, the forge when they could not
 * and it declared the capabilities and could serve the change, neither
 * otherwise. The choice is gone. The rule it implemented — never ask the
 * provider to compute a change, always read it from a clone, ask the provider
 * only for what is not in the repository files — has no room in it for a forge
 * that serves diffs when git is inconvenient, because a route that exists is a
 * route that gets taken. So what is left here is: obtain the objects, or refuse
 * and say why.
 *
 * Everything deleted with the choice went with it. There is no provider
 * serviceability check, because "could the forge serve this change" is not a
 * question anyone asks any more. There is no `pairEvidence`, and no
 * refused-versus-gone disambiguation: those existed to decide *which* source to
 * fall back to, and they were answered by asking the forge for a manifest at
 * the pinned pair — itself a diff computation, which is exactly what the rule
 * forbids. A fetch that fails now ends the attempt with the reason it failed,
 * and never claims the revision is gone, because nothing left is entitled to
 * say so. That is strictly the safer half of the old behaviour: a stored
 * checkpoint is never declared incompatible on an unproven claim, so a
 * reviewer's resumable work survives a fetch that merely failed.
 *
 * **Acquisition runs here, not at the first tool call** (design D5). Selecting
 * lazily means a run announces a source, records it in a snapshot a resumed
 * attempt compares against, and then discovers it does not have it. The cost is
 * a fetch before the first model turn — measured at 2.6 MB for the 207-file
 * change this whole change exists for — and it is paid once per repository.
 *
 * **The base revision is computed here too, and that is new.** The commit a
 * change request's diff is against used to arrive from the forge as
 * `merge_base_commit.sha`/`diff_refs.base_sha` and be fetched like any other
 * pinned commit. A merge base is a computation over two commits, so it is now
 * `git merge-base` over the pinned head and the branch the change request
 * targets, inside acquisition (`../localgit/objectAcquisition.ts`), and this
 * module hands the answer back for the snapshot to pin. The provider is still
 * asked which branch that is — a fact about the change request that lives in no
 * repository — and nothing else.
 *
 * **The demo pod is handed a source instead of selecting one.** Its sample
 * change exists in no repository and on no remote, and its revisions are not
 * object ids at all, so there is nothing for git to read and nothing to fetch.
 * A host that has such a pod passes the source in (`suppliedSource`), and this
 * module uses it as given: no git probe, no descriptor, no fetch. It competes
 * with nothing — a connected pod supplies no such source, and no code path
 * constructs one from a connection.
 *
 * **Nothing here branches on provider identity** (design D2, task 10.7). The
 * local path is reached by asking the connection for a descriptor and the
 * machine for a git. This module imports nothing from `src/providers/`.
 */
import type { Connection } from '../platform/provider';
import type { ChangeRequestRef, InvestigationSource, InvestigationSourceCapabilities, ObjectSourceDescriptor } from '../platform/types';
import { INVESTIGATION_CONTRACT_VERSION } from '../platform/types';
import { canonicalStringify, sha256Hex } from './contentDigest';
import { createLocalGitSource, type LocalGitSourceOptions } from '../localgit/localGitSource';
import { probeGitSupport, type GitSupport } from '../localgit/gitInvocation';
import type { AcquisitionOutcome, ObjectCache } from '../localgit/objectAcquisition';
import type { CacheLease } from '../localgit/objectCache';
import type { Limitation } from '../domain/harnessActivity';
import type { ActivityFact } from './harnessActivityLog';
import type { InvestigationSourceKind, ReviewRunInvestigationSource } from '../domain/reviewRunSnapshot';

/**
 * One limitation code for every way the investigation source could not be used
 * as intended, so a run's limitations read as one list of "what this review
 * could not do" rather than one code per cause — the cause itself is named in
 * the message.
 *
 * The caller hands these to the attempt, which reports them on its terminal
 * result and carries them into every checkpoint like any other limitation.
 */
export const PREFERRED_SOURCE_LIMITATION_CODE = 'preferredInvestigationSourceUnavailable';

/** What this member's snapshot pin is, in the neutral contract's own shape. */
export interface InvestigationSourceSelectionMember {
  readonly memberId: string;
  readonly providerId: string;
  readonly instanceUrl: string;
  readonly ref: ChangeRequestRef;
  /**
   * The pinned head, and the only revision the platform still supplies. Where
   * a change request's head points is a fact about the change request; what it
   * is against is a computation, and this module computes it.
   */
  readonly headSha: string;
}

export interface InvestigationSourceSelectionRequest {
  readonly member: InvestigationSourceSelectionMember;
  readonly connection: Connection;
  /** Whose lease holds the object store against eviction for the length of this attempt (task 7.7). */
  readonly attemptId: string;
  /**
   * Where objects are cached. Absent means this host keeps no object cache, and
   * with no supplied source either there is nothing that can read the change:
   * the member is unservable and says so.
   */
  readonly objectCache?: ObjectCache;
  /**
   * A source the host supplies rather than one acquisition builds, together
   * with the commit its reads are against.
   *
   * The demo pod, and only the demo pod. Its sample change lives in memory,
   * behind no remote and in no repository, so there is nothing to clone and its
   * `baseSha` is whatever the sample data says it is. Supplying it here rather
   * than branching in the caller keeps one seam: the same narrowing, the same
   * recorded signature, the same shape of outcome.
   */
  readonly suppliedSource?: { readonly source: InvestigationSource; readonly baseSha: string };
  /**
   * Narrows a source's own declaration the way the host's policy requires, so
   * the recorded capability signature describes the set this attempt actually
   * had rather than what the source could do unpoliced. Identity by default.
   */
  readonly narrowCapabilities?: (capabilities: InvestigationSourceCapabilities) => InvestigationSourceCapabilities;
  /** Test seams. Production passes none of the three. */
  readonly now?: () => number;
  readonly probeGit?: () => Promise<GitSupport>;
  readonly createSource?: (options: LocalGitSourceOptions) => InvestigationSource;
}

export type InvestigationSourceSelection =
  | {
      readonly outcome: 'selected';
      readonly record: ReviewRunInvestigationSource;
      /** The declaration the record signs, for a caller that composes this member's capability set. */
      readonly capabilities: InvestigationSourceCapabilities;
      /** The source itself. Always present: there is no case left where the connection is the source. */
      readonly source: InvestigationSource;
      /**
       * The commit this member's diff is against — `git merge-base` over the
       * pinned head and the branch the change request targets, computed inside
       * acquisition, or the sample data's own base for a supplied source. The
       * caller pins the snapshot to this rather than to whatever the platform
       * said.
       */
      readonly baseSha: string;
      /** Held while the attempt runs, released on every exit; present only for a local store. */
      readonly lease?: CacheLease;
      readonly limitations: readonly Limitation[];
      /** What acquisition did, for the attempt's own activity log (task 10.2). Empty when none ran. */
      readonly activity: readonly ActivityFact[];
    }
  | {
      readonly outcome: 'unservable';
      /** This module's own bounded text, naming what could not be obtained (task 9.3). */
      readonly reason: string;
      readonly limitations: readonly Limitation[];
      /** What acquisition did, for the attempt's own activity log (task 10.2). Empty when none ran. */
      readonly activity: readonly ActivityFact[];
    };

/**
 * What a member that nothing could read holds where its source would be.
 *
 * The attempt for such a member still gets built — design D5's third branch and
 * task 9.3: it ends before bootstrap with completeness `none` and the reason,
 * which is what makes "a review that cannot reach git fails honestly" a fact a
 * reviewer sees rather than a thrown error somewhere. Building it needs
 * *something* in the source position, and the two dishonest options are a
 * non-null assertion over `undefined` (a lie the type system would stop
 * enforcing) and routing back to the connection (the forge fallback this whole
 * change removes). So the member holds a source that refuses every operation in
 * the same words the refusal already used. Nothing calls it: the attempt never
 * reaches a tool dispatch. It exists so the type stays required and the
 * fallback stays impossible.
 */
export function refusingInvestigationSource(reason: string): InvestigationSource {
  const refuse = <T>(request: { snapshot: { repoId: string; baseSha: string; headSha: string } }): Promise<T> =>
    Promise.resolve({ snapshot: request.snapshot, state: 'unavailable', reason } as T);
  return {
    capabilities: {
      manifests: { supported: false },
      diffReads: { supported: false },
      fileReads: { supported: false },
      repositorySearch: { supported: false },
      diffSearch: { supported: false },
      pagination: { maxPageSize: 1 },
    },
    listChangedFiles: refuse,
    readDiff: refuse,
    readFile: refuse,
    searchRepository: refuse,
    searchDiff: refuse,
  };
}

function limitation(message: string): Limitation {
  return { code: PREFERRED_SOURCE_LIMITATION_CODE, message };
}

/**
 * Acquisition as a visible phase of run activity (task 10.2).
 *
 * It reuses `actionStarted` and the `toolCompleted`/`toolFailed` pair rather
 * than adding an event kind or a seventh `RunPhase`, matching the convention
 * `harnessAttempt.ts` already uses for a model turn (`tool: 'modelTurn'`): a
 * fact that is not a model-facing tool call still belongs on the two event
 * kinds every surface already renders. A new phase would have to be threaded
 * through the projection, the checkpoint format and the persisted parser for
 * something that happens once, before the attempt exists.
 *
 * The completion summary says how many revisions were fetched, how many were
 * already held, and how deep the history had to go, because that is the
 * difference between the slow first review of a repository and every later one
 * — the question a reviewer looking at a long pause is actually asking.
 */
const ACQUISITION_ACTION = 'Obtaining the pinned revisions for local review';
const ACQUISITION_TOOL = 'acquireObjects';

function acquisitionCompleted(memberId: string, fetched: number, alreadyPresent: number, depth: number, durationMs: number): ActivityFact {
  const held =
    fetched === 0
      ? `All ${String(alreadyPresent)} pinned revisions were already held; nothing was fetched.`
      : `Fetched ${String(fetched)} pinned revision${fetched === 1 ? '' : 's'}${alreadyPresent > 0 ? `, ${String(alreadyPresent)} already held` : ''}.`;
  return {
    kind: 'toolCompleted',
    tool: ACQUISITION_TOOL,
    target: memberId,
    summary: `${held} The commit this diff is against was found within ${String(depth)} commits of history.`,
    memberId,
    durationMs,
  };
}

function acquisitionFailed(memberId: string, reason: string, durationMs: number): ActivityFact {
  return { kind: 'toolFailed', tool: ACQUISITION_TOOL, target: memberId, reason, memberId, durationMs };
}

/**
 * The one sentence every "this change could not be read" limitation says, with
 * the cause appended in the words of whatever produced it. Written once so a
 * reviewer reading a run's limitations sees one fact stated one way, whichever
 * step it came from.
 */
function notLocalLimitation(memberId: string, reason: string): Limitation {
  return limitation(`Member ${memberId} could not be reviewed from a local object store: ${reason}`);
}

/** Content-addressed, and over the same canonical serialization every other signature in this codebase uses. */
export function investigationCapabilitySignature(capabilities: InvestigationSourceCapabilities): string {
  return sha256Hex(canonicalStringify(capabilities));
}

function record(kind: InvestigationSourceKind, capabilities: InvestigationSourceCapabilities): ReviewRunInvestigationSource {
  return { kind, contractVersion: INVESTIGATION_CONTRACT_VERSION, capabilitySignature: investigationCapabilitySignature(capabilities) };
}

/**
 * Everything local git needs, in the order it can fail, ending either with a
 * store holding the pinned head and the computed base or with a stated reason
 * it does not.
 *
 * Every failure below ends the attempt. None of them says anything about
 * whether the commits exist, and none of them is allowed to: the only thing
 * that could establish that was a forge manifest at the pinned pair, and asking
 * for one is the diff request this change exists to remove.
 */
async function attemptLocalGit(request: InvestigationSourceSelectionRequest): Promise<
  | { readonly state: 'ready'; readonly source: InvestigationSource; readonly baseSha: string; readonly lease: CacheLease; readonly limitations: readonly Limitation[]; readonly activity: readonly ActivityFact[] }
  | { readonly state: 'unservable'; readonly reason: string; readonly limitations: readonly Limitation[]; readonly activity: readonly ActivityFact[] }
> {
  const { member, connection, objectCache } = request;
  const refuse = (reason: string, activity: readonly ActivityFact[] = []) => ({
    state: 'unservable' as const,
    reason,
    limitations: [notLocalLimitation(member.memberId, reason)],
    activity,
  });

  if (!objectCache) return refuse('This host keeps no local object store.');

  const support = await (request.probeGit ?? probeGitSupport)();
  if (support.state !== 'supported') return refuse(support.reason);

  // Asked of the connection, never composed here: the fetch location, the
  // credential, the optional ref hint and the target branch are all facts about
  // the platform the provider speaks to, and this module reads none of them
  // (design D2).
  if (!connection.getObjectSource) {
    return refuse('This connection does not say where this repository’s objects can be obtained.');
  }
  const objectSource = await connection.getObjectSource(member.ref);
  if (objectSource.state !== 'available') return refuse(objectSource.reason);
  const descriptor: ObjectSourceDescriptor = objectSource.descriptor;

  const identity = { providerId: member.providerId, instanceUrl: member.instanceUrl, repoId: member.ref.repoId };
  // Everything from here to the outcome is the part that can take real time: a
  // first review of a large repository fetches history over the network before
  // the model is asked anything. Task 10.2 wants that visible, so the attempt's
  // log opens with what was being done and what it cost — otherwise the run
  // shows nothing at all and reads as a hang.
  const now = request.now ?? Date.now;
  const startedAt = now();
  const activity: ActivityFact[] = [{ kind: 'actionStarted', action: ACQUISITION_ACTION, target: member.memberId }];
  const outcome: AcquisitionOutcome = await objectCache.acquire({
    identity,
    descriptor,
    attemptId: request.attemptId,
    headCommit: member.headSha,
  });
  const durationMs = Math.max(0, now() - startedAt);

  if (outcome.state !== 'acquired') {
    return refuse(outcome.reason, [...activity, acquisitionFailed(member.memberId, outcome.reason, durationMs)]);
  }

  const limitations = outcome.recreated
    ? [limitation(`Member ${member.memberId}'s local object store failed its ownership check and was rebuilt before this review, so its objects were fetched again.`)]
    : [];
  const source = (request.createSource ?? createLocalGitSource)({ gitDir: outcome.gitDir, repoId: member.ref.repoId });
  return {
    state: 'ready',
    source,
    baseSha: outcome.baseSha,
    lease: outcome.lease,
    limitations,
    activity: [...activity, acquisitionCompleted(member.memberId, outcome.fetched.length, outcome.alreadyPresent.length, outcome.depthReached, durationMs)],
  };
}

/**
 * Select the source that serves this member, or refuse.
 *
 * Never throws for a source that cannot serve: every refusal is a returned
 * value with a reason, because the caller has to end the attempt truthfully
 * rather than surface a rejection whose text nobody wrote.
 */
export async function selectInvestigationSource(request: InvestigationSourceSelectionRequest): Promise<InvestigationSourceSelection> {
  const narrow = request.narrowCapabilities ?? ((capabilities: InvestigationSourceCapabilities) => capabilities);

  if (request.suppliedSource) {
    const { source, baseSha } = request.suppliedSource;
    const capabilities = narrow(source.capabilities);
    return { outcome: 'selected', record: record('sample', capabilities), capabilities, source, baseSha, limitations: [], activity: [] };
  }

  const attempted = await attemptLocalGit(request);
  if (attempted.state === 'unservable') {
    return {
      outcome: 'unservable',
      reason: `${attempted.reason} There is no other source to read this change from, so nothing was reviewed.`,
      limitations: attempted.limitations,
      activity: attempted.activity,
    };
  }

  const capabilities = narrow(attempted.source.capabilities);
  return {
    outcome: 'selected',
    record: record('localGit', capabilities),
    capabilities,
    source: attempted.source,
    baseSha: attempted.baseSha,
    lease: attempted.lease,
    limitations: attempted.limitations,
    activity: attempted.activity,
  };
}
