/**
 * The neutral SCM vocabulary. Nothing in this file may be shaped like one
 * platform's API: GitLab, GitHub and Bitbucket concepts are mapped onto
 * these types inside their provider modules (see docs/ARCHITECTURE.md).
 */
import type { ScmError } from './errors';

export interface UserRef {
  username: string;
  name?: string;
}

/** A repository (GitLab "project", GitHub/Bitbucket "repository"). */
export interface Repository {
  /** Provider-scoped id, always a string (GitLab numeric ids are stringified). */
  id: string;
  /** Full path, e.g. `hve/platform/core`. */
  path: string;
  name: string;
  webUrl: string;
  /** Open change-request count, when the provider returns it cheaply. */
  openChangeRequestCount?: number;
}

/** A repository container (GitLab "group", GitHub "organization", Bitbucket "workspace"). */
export interface RepoGroup {
  id: string;
  path: string;
  name: string;
}

/** Identifies one change request within a provider connection. */
export interface ChangeRequestRef {
  repoId: string;
  /** Repo-scoped number: GitLab `iid`, GitHub PR number. */
  number: string;
}

export type CiStatus = 'success' | 'failed' | 'running' | 'pending' | 'canceled' | 'none';

/** A merge request / pull request. */
export interface ChangeRequest {
  ref: ChangeRequestRef;
  title: string;
  /** Provider-authored body, used for neutral conventions such as changeset trailers. */
  description?: string;
  state: 'open' | 'merged' | 'closed';
  sourceBranch: string;
  targetBranch: string;
  author: UserRef;
  reviewers: UserRef[];
  webUrl: string;
  updatedAt: string;
  /** Head commit at fetch time — staleness detection compares against this. */
  headSha: string;
  changedFileCount?: number;
  ci?: { runId: string; status: CiStatus; webUrl?: string };
  draft?: boolean;
}

/** An issue / work item, as the dashboard lists them. */
export interface WorkItem {
  id: string;
  repoId: string;
  number: string;
  title: string;
  /** Provider-authored body. Absent when the item has none — a title alone is not what a change is for. */
  description?: string;
  state: 'open' | 'closed';
  assignee?: UserRef;
  milestone?: string;
  updatedAt: string;
  webUrl: string;
}

/** A CI pipeline / workflow run. */
export interface CiRun {
  id: string;
  repoId: string;
  status: CiStatus;
  webUrl?: string;
  ref?: string;
  failedJobName?: string;
  createdAt?: string;
}

export interface FileDiff {
  oldPath: string;
  newPath: string;
  /** Unified diff hunks for this file. */
  diff: string;
  isNew?: boolean;
  isDeleted?: boolean;
  isRenamed?: boolean;
}

/**
 * Provider-opaque anchoring payload: whatever the provider needs to
 * round-trip a positioned comment (GitLab `diff_refs`, GitHub
 * `commit_id`+`side`, …). Produced by `getChangeRequestDiff`, consumed by
 * `submitReview`. The platform layer never inspects it.
 */
export type AnchorRefs = unknown;

export interface ChangeRequestDiff {
  ref: ChangeRequestRef;
  /**
   * The **merge base** of this change request: the commit its diff is
   * actually against. One commit, not a choice of two — the earlier wording
   * here ("the merge-base/target commit") named two different commits as if
   * they were interchangeable, and they are not. The tip of the target branch
   * moves whenever anything lands on it; the merge base moves only when the
   * change request itself is rebased. GitLab reports it as
   * `diff_refs.base_sha`, GitHub as the compare response's
   * `merge_base_commit.sha` (`add-local-git-investigation` design.md D4).
   *
   * A provider that cannot determine the merge base fails with a stated
   * reason. It never substitutes the target-branch tip: a caller cannot tell
   * the two apart from the value, and the substitution silently changes what
   * every piece of evidence pinned to it was computed against.
   *
   * Neutral and provider-read (unlike `anchorRefs`), because the harness's
   * review-investigation tools (design.md D7, `add-agentic-review-harness`)
   * need it up front to pin every `InvestigationSnapshotRef` — there is no
   * separate neutral "resolve the base" operation to call later.
   */
  baseSha: string;
  headSha: string;
  files: FileDiff[];
  anchorRefs: AnchorRefs;
}

/** Where a review comment lands in the diff. */
export interface DiffAnchor {
  filePath: string;
  /** Old path when the file was renamed. */
  oldPath?: string;
  line: number;
  endLine?: number;
  side?: 'old' | 'new';
  /**
   * `line`'s paired old-file line number, present only when this anchor is
   * an unchanged context line. GitLab's position API requires both
   * coordinates for a context line (`gitlab/mappers.ts#buildPosition`);
   * GitHub takes a single coordinate per side and ignores this field.
   */
  oldLine?: number;
  refs: AnchorRefs;
}

/** One line comment to post. The provider renders `suggestion` in its own syntax. */
export interface ReviewCommentDraft {
  /** Caller correlation key (the review item id) — echoed in the outcome. */
  key: string;
  /** Markdown body, without the suggestion block. */
  body: string;
  anchor: DiffAnchor;
  suggestion?: { old: string; new: string };
  /** Attribution line rendered after the suggestion block. */
  footer?: string;
}

export interface ReviewSubmission {
  comments: ReviewCommentDraft[];
  /** Summary note posted after the line comments succeed. */
  summary?: string;
  requestChanges?: boolean;
  approve?: boolean;
  /** Post the comments as a single review/thread where the platform supports it. */
  asSingleThread?: boolean;
}

/**
 * What a submit is doing right now. Submitting is the longest operation in the
 * product — one round trip per comment on the per-comment path, plus the
 * summary and the verdict — and without this the UI can only sit silent until
 * it finishes (#42). Providers report it best-effort; a caller that does not
 * pass a callback costs nothing.
 */
export interface SubmitProgress {
  stage: 'comments' | 'summary' | 'verdict';
  /** Comments finished so far. Zero for the summary and verdict stages. */
  posted: number;
  /** Comments in this submit — the retry remainder, not the whole review. */
  total: number;
}

export type SubmitProgressFn = (progress: SubmitProgress) => void;

export interface CommentOutcome {
  key: string;
  ok: boolean;
  threadId?: string;
  error?: ScmError;
}

/**
 * Per-comment outcomes so callers retry only the remainder — required for
 * draft survival on 401 and for changeset partial failure. `submitReview`
 * only throws when nothing was attempted (e.g. auth failed up front).
 */
export interface SubmitResult {
  comments: CommentOutcome[];
  summaryPosted: boolean;
  summaryError?: ScmError;
  approvalApplied?: boolean;
  approvalError?: ScmError;
  /** Distinct from approval — requesting changes is its opposite. */
  requestChangesApplied?: boolean;
  requestChangesError?: ScmError;
  /**
   * Whether one review carried every comment, as `asSingleThread` asked. Only
   * the provider knows: a platform with a batched path can still fall back to
   * posting comments one at a time, and the UI must not claim otherwise.
   * `undefined` when the submit posted no comments, and so says nothing.
   */
  postedAsSingleReview?: boolean;
}

export interface ThreadNote {
  id: string;
  author: UserRef;
  body: string;
  createdAt: string;
  resolvable?: boolean;
  resolved?: boolean;
  resolvedBy?: UserRef;
  resolvedAt?: string;
}

/** A posted review discussion, as reply polling sees it. */
export interface ReviewThread {
  id: string;
  crRef: ChangeRequestRef;
  notes: ThreadNote[];
  resolved: boolean;
  /**
   * False when the platform dropped the diff anchor (GitLab returns
   * `position: null` after a force-push) — the `stale` thread status.
   */
  anchorPresent: boolean;
  filePath?: string;
  line?: number;
}

export interface ConnectionStatus {
  ok: boolean;
  username?: string;
  scopes?: string[];
  tokenExpiresInDays?: number;
  error?: ScmError;
}

export type SourceResolution =
  | { kind: 'repository'; repo: Repository }
  | { kind: 'group'; group: RepoGroup; repositories: Repository[] }
  /** A syntactically valid id the token cannot see. Never silently added. */
  | { kind: 'notVisible'; id: string }
  | { kind: 'noMatch' };

/**
 * Review-investigation contracts (design.md D7, `add-agentic-review-harness`,
 * task 3.2). Neutral shapes only — no GitLab/GitHub payload appears here, per
 * "Capabilities, not `if (gitlab)`" and "Anchors are opaque" in
 * docs/ARCHITECTURE.md. Every request pins an explicit repository and
 * revision; every result echoes that pin back so a caller can prove the
 * provider answered the exact requested revision instead of a branch tip
 * (task 3.7).
 */

/** Opaque continuation token for one bounded investigation operation; never inspected or built by neutral code. */
export type InvestigationCursor = string;

/** The immutable repository + base/head pair every investigation request and result is pinned to. */
export interface InvestigationSnapshotRef {
  repoId: string;
  baseSha: string;
  headSha: string;
}

/** Which side of an `InvestigationSnapshotRef` a single-revision read or search applies to. */
export type PinnedRevision = 'base' | 'head';

/**
 * The same request shape with the revision pin taken off — what a *caller of the host* supplies,
 * as opposed to what reaches a provider. The pin is not optional anywhere: it is added back, from
 * the member the request names, by `../app/harnessToolDispatcher.ts` immediately before the
 * provider call, so every request still reaches the source pinned to exactly one repository and
 * one base/head pair.
 *
 * **Why the split exists.** The model used to fill in `snapshot` itself — repoId, baseSha, headSha
 * copied out of the prompt into every request — and the dispatcher compared its copy against the
 * member's. A live run refused 87 of 319 tool results, 27%, every one of them a mis-transcribed
 * 40-character head sha: two characters dropped mid-string in one case, and in another the head
 * sha's prefix spliced onto the base sha's tail, which is not a typo but two identifiers merged
 * into one. Two earlier incidents of the same class are recorded in `harnessToolDispatcher.ts`'s
 * own refusal comment. Asking for the transcription was the defect; the host already held the
 * authoritative values, which is how it could compare them at all.
 *
 * The constraint keeps this from being applied to a shape that was never pinned.
 */
export type Unpinned<T extends { snapshot: InvestigationSnapshotRef }> = Omit<T, 'snapshot'>;

export type InvestigationState =
  | 'complete'
  | 'paginated'
  | 'truncated'
  | 'unavailable'
  | 'binary'
  | 'tooLarge'
  | 'notFound'
  | 'contentDeclined'
  | 'unknown';

interface InvestigationResultBase {
  snapshot: InvestigationSnapshotRef;
}

/**
 * The common bounded result envelope every investigation operation returns
 * (D7). `value` exists only on the states that can carry content; the other
 * states have no `value` field to populate, so unavailable content can never
 * be mistaken for an empty successful payload (task 3.4).
 *
 * `contentDeclined` is NON-TERMINAL, and is the one state here that says
 * something about the source rather than about the content
 * (`add-local-git-investigation` task 3.1, design.md D6). It means: the
 * platform enumerated this entry and would not render its content. It does
 * NOT mean the content cannot be read — another source reading the same two
 * commits reads it exactly. Nothing may derive an irreversible file state
 * from it, and no caller may treat it as a complete reading of that file.
 *
 * It exists because the alternative was measured and is worse. Against
 * `osirison/code-verdict#66` — 207 changed files, every one plain TypeScript
 * — GitHub's compare response returned 137 of them with the patch key absent
 * and `additions`/`deletions`/`changes` all zero, the byte-identical shape a
 * genuinely binary file produces. Mapped to `binary`, those 137 readable
 * source files were closed by `markTerminal`, which is irreversible; the
 * completion gate then counted `binary` as satisfied, because content that is
 * genuinely not text cannot be read by anyone. The run ended complete and
 * clean over source nobody had read. A state that says only "the platform did
 * not serve this" is what makes that outcome impossible.
 */
export type InvestigationResult<T> =
  | (InvestigationResultBase & { state: 'complete'; value: T })
  | (InvestigationResultBase & { state: 'paginated'; value: T; cursor: InvestigationCursor })
  | (InvestigationResultBase & { state: 'truncated'; value: T; knownRemainingUnits?: number })
  | (InvestigationResultBase & { state: 'unavailable'; reason?: string })
  | (InvestigationResultBase & { state: 'binary'; byteSize?: number })
  | (InvestigationResultBase & { state: 'tooLarge'; byteSize?: number })
  | (InvestigationResultBase & { state: 'notFound'; reason?: string })
  | (InvestigationResultBase & { state: 'contentDeclined'; reason?: string })
  | (InvestigationResultBase & { state: 'unknown'; reason?: string });

/** Narrows to the states that carry content, without a caller special-casing every state. */
export function investigationResultValue<T>(result: InvestigationResult<T>): T | undefined {
  switch (result.state) {
    case 'complete':
    case 'paginated':
    case 'truncated':
      return result.value;
    default:
      return undefined;
  }
}

// ---- Changed-file manifest --------------------------------------------------

export type ChangedFileKind = 'added' | 'modified' | 'deleted' | 'renamed';

/** Enough metadata to classify a changed file without its content. */
export interface ChangedFileEntry {
  path: string;
  /** Present when `kind` is `'renamed'`. */
  oldPath?: string;
  kind: ChangedFileKind;
  /** Only from a determination the platform actually made about this file's content — never inferred from an absent diff. */
  binary: boolean;
  /**
   * The per-entry form of the `contentDeclined` result state (task 3.2): the
   * platform enumerated this file and would not render its content, so its
   * diff was never served and its line counts are unknown. Carried on the
   * entry as well as on the result because a manifest is where the condition
   * is first knowable for the change as a whole (design.md D6), before any
   * file is read.
   *
   * Absent means the pre-change meaning, which is also the ordinary one: the
   * platform served this file's content, or made a determination about it.
   * Never `true` together with `binary` — a source that cannot tell the two
   * apart reports this one, and lets a source that can read the content
   * decide (design.md D6, "A declined entry cannot be resolved by guessing").
   */
  contentDeclined?: boolean;
  addedLines?: number;
  removedLines?: number;
  /**
   * Size of this file's *diff*, in bytes — what a `readDiff` of this path actually returns, not
   * the size of the file itself.
   *
   * Optional, and absent means unknown rather than zero: a platform that does not report it simply
   * does not, and nothing infers a size from the line counts. Two things read it. `isSmallReview`
   * (`../app/harnessAttempt.ts`) sums it to decide whether a whole change fits the ordinary
   * evidence lane, and the harness's per-turn prompt budget prints it to the model so a set of
   * reads can be chosen that fits one prompt (`../domain/harnessPromptBudget.ts`). Both treat an
   * absent value as "not known", never as "empty".
   */
  byteSize?: number;
}

export interface ChangedFileManifestRequest {
  snapshot: InvestigationSnapshotRef;
  cursor?: InvestigationCursor;
}

export type ChangedFileManifestResult = InvestigationResult<readonly ChangedFileEntry[]>;

// ---- Bounded diff pages ------------------------------------------------------

/** Where a line sits inside the immutable diff — provider-neutral, unlike `AnchorRefs`. */
export interface DiffPosition {
  path: string;
  oldPath?: string;
  side: 'old' | 'new';
  line: number;
  endLine?: number;
}

export interface DiffPageRequest {
  snapshot: InvestigationSnapshotRef;
  path: string;
  cursor?: InvestigationCursor;
}

export interface DiffPage {
  path: string;
  oldPath?: string;
  isRenamed?: boolean;
  /** Unified-diff hunk text for this bounded page, in the same format as `FileDiff.diff`. */
  patch: string;
  /** Positions inside `patch` a citation can anchor to, independent of any provider's `AnchorRefs`. */
  positions: readonly DiffPosition[];
}

export type DiffPageResult = InvestigationResult<DiffPage>;

// ---- Base/head file ranges ---------------------------------------------------

export interface FileRangeRequest {
  snapshot: InvestigationSnapshotRef;
  revision: PinnedRevision;
  path: string;
  startLine: number;
  endLine: number;
}

export interface FileRange {
  revision: PinnedRevision;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
}

export type FileRangeResult = InvestigationResult<FileRange>;

// ---- Search matches -----------------------------------------------------------

export interface RepositorySearchRequest {
  snapshot: InvestigationSnapshotRef;
  revision: PinnedRevision;
  query: string;
  pathScope?: string;
  cursor?: InvestigationCursor;
}

export interface SearchMatch {
  path: string;
  line: number;
  excerpt: string;
}

export type RepositorySearchResult = InvestigationResult<readonly SearchMatch[]>;

export interface DiffSearchRequest {
  snapshot: InvestigationSnapshotRef;
  query: string;
  pathScope?: string;
  cursor?: InvestigationCursor;
}

export interface DiffSearchMatch {
  position: DiffPosition;
  excerpt: string;
}

export type DiffSearchResult = InvestigationResult<readonly DiffSearchMatch[]>;

// ---- What an investigation source declares it can do ----------------------------
//
// These three types lived in `./provider.ts` until
// `add-local-git-investigation` task 2.1, back when a provider was the only
// thing that could answer an investigation request. They are neutral contract
// types like every other type in this file, and the local git source declares
// the same shape without being a provider at all, so they belong beside the
// operations they describe. `./provider.ts` re-exports all three, so every
// existing `import … from './provider'` still resolves — moving them was not
// worth a rename at ten call sites.

/** A page-size ceiling a source declares for one review-investigation operation. */
export interface InvestigationPageBound {
  readonly maxPageSize: number;
  /**
   * Byte ceiling for one page, where `maxPageSize` counts units (lines, files, matches) whose
   * individual size the source cannot predict. Both bounds apply and a page ends at whichever
   * is reached first, so a unit count generous enough to return an ordinary file whole cannot
   * produce a result larger than the attempt's `maxToolResultBytes` — which the budget refuses
   * outright, and a refusal the model cannot act on is what turns a review into a loop.
   *
   * Absent means the operation's units are inherently small (a manifest entry, a search match)
   * and the unit bound alone is sufficient.
   */
  readonly maxPageBytes?: number;
}

/** Whether a source supports one review-investigation operation, and its declared bound. */
export interface InvestigationOperationCapability {
  readonly supported: boolean;
  /** Overrides `ReviewInvestigationCapabilities.pagination` for this operation; absent defers to it. */
  readonly pageBound?: InvestigationPageBound;
}

/**
 * D7: what an investigation *source* can do — the five revision-pinned
 * operations and nothing else. The harness decides from this declaration,
 * never from `ScmProvider.id`: a source that cannot guarantee an operation
 * sets `supported: false` rather than omitting the key, so the harness can
 * degrade to a partial/failed outcome truthfully instead of guessing.
 *
 * **Why the two forge-only detail reads are no longer in here.** This
 * interface used to carry `changeRequestDetails` and `issueDetails` as well,
 * because a provider was one of the two things that could answer
 * investigation, so one declaration described both halves. A provider is no
 * longer an investigation source at all: the reviewer's rule is that anything
 * git can answer is answered by git, always, and a forge is asked only for
 * what is not in the repository. So the five operations are declared by the
 * source that reads the object store, the two detail reads are declared by
 * the connection that reads the forge (`ProviderDetailCapabilities` below),
 * and neither declaration can claim the other's half any more.
 */
export interface InvestigationSourceCapabilities {
  readonly manifests: InvestigationOperationCapability;
  readonly diffReads: InvestigationOperationCapability;
  readonly fileReads: InvestigationOperationCapability;
  readonly repositorySearch: InvestigationOperationCapability;
  readonly diffSearch: InvestigationOperationCapability;
  /** Shared default when an operation above does not declare its own `pageBound`. */
  readonly pagination: InvestigationPageBound;
}

/**
 * What a *provider* declares about the two reads only a forge can answer: the
 * change request's own detail (title, description, discussion, labels, checks)
 * and a linked issue's. Neither is in the repository, and a bare object id
 * does not even identify the change request they are about, so no object store
 * can answer either one — which is exactly why these two survived the removal
 * of the provider as an investigation source.
 */
export interface ProviderDetailCapabilities {
  readonly changeRequestDetails: InvestigationOperationCapability;
  readonly issueDetails: InvestigationOperationCapability;
  /** Shared default when an operation above does not declare its own `pageBound`. */
  readonly pagination: InvestigationPageBound;
}

/**
 * What one *member* of a review could actually do, composed from the two
 * declarations above by `withSourceInvestigation` (`app/harnessRuntime.ts`)
 * and read by the tool dispatcher's capability gate.
 *
 * It stays one object because the gate asks one question per tool — is this
 * operation supported for this member — and splitting the answer across two
 * records would make every call site decide which half a tool belongs to.
 * Composing it is the only place that decision is made, and it is made once.
 */
export interface ReviewInvestigationCapabilities extends InvestigationSourceCapabilities, ProviderDetailCapabilities {}

// ---- The investigation source ---------------------------------------------------

/**
 * The five revision-pinned operations, named once, as one interface
 * (`add-local-git-investigation` design.md D2, task 2.1).
 *
 * `Connection` used to carry them too, as `Partial<InvestigationOperations>`,
 * so that a forge could serve investigation when a local object store could
 * not. It no longer does. The reviewer's rule is absolute: never ask the
 * provider to compute a change, always read it from a local clone, and ask the
 * provider only for what is not in the repository files. A forge that can
 * still be asked for a diff is a second route around the object store, and a
 * second route is how the fallback comes back. So these five are implemented
 * by investigation sources only, `investigationSource.test.ts` fails if a
 * `Connection` grows one of them back, and there is nothing left for a caller
 * to choose between.
 *
 * Nothing else may join this list either. The operations here are answerable
 * from two commits and nothing else, which is exactly why a source that is not
 * a forge can answer them. `getChangeRequestDetails`, `getIssueDetails`,
 * `getCurrentHead`, checks and posting are questions about the forge — a local
 * object store cannot answer any of them, and a bare object id does not even
 * identify the change request they are about. They stay on `Connection`, and
 * the same test fails if one of them is added here.
 */
export interface InvestigationOperations {
  listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult>;
  readDiff(request: DiffPageRequest): Promise<DiffPageResult>;
  readFile(request: FileRangeRequest): Promise<FileRangeResult>;
  searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult>;
  searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult>;
}

/**
 * The same five names as data, so a test can assert the membership of
 * `InvestigationOperations` at runtime instead of only in a type a human has
 * to re-read. `as const satisfies` (not a `: readonly …[]` annotation) keeps
 * each entry's literal type, which is what makes `InvestigationOperationName`
 * a union of five names rather than plain `string`, and what makes the
 * exhaustiveness alias below able to fail.
 */
export const INVESTIGATION_OPERATION_NAMES = [
  'listChangedFiles',
  'readDiff',
  'readFile',
  'searchRepository',
  'searchDiff',
] as const satisfies readonly (keyof InvestigationOperations)[];

export type InvestigationOperationName = (typeof INVESTIGATION_OPERATION_NAMES)[number];

type AssertNever<T extends never> = T;

/**
 * Compile-time proof the list above is exhaustive. `satisfies` already stops a
 * name that is not an operation; this stops an operation that is not named —
 * add a sixth member to `InvestigationOperations` without listing it and the
 * type argument violates its own `extends never` constraint, so this file
 * stops compiling. Exported only because an unused local type is a lint error;
 * nothing consumes it.
 */
export type EveryInvestigationOperationIsNamed = AssertNever<
  Exclude<keyof InvestigationOperations, InvestigationOperationName>
>;

/**
 * Something that can answer the five pinned operations, together with its own
 * honest declaration of what it supports (design.md D2).
 *
 * **One production implementation, and that is the point.** The local git
 * source, reading a bare object store this extension owns. A `Connection` used
 * to be a second implementation, reached through an `asInvestigationSource`
 * helper that filled in whichever of the five a provider had no honest
 * revision-pinned answer for; both the helper and that second implementation
 * are gone, because a review that can reach a forge for a diff will eventually
 * reach it. The only other implementation is the sample source a demo pod is
 * handed (`providers/fixture/demoInvestigationSource.ts`), which reads
 * built-in sample data that exists in no repository and on no forge — it is
 * supplied by the host for that one pod, never selected in competition with
 * git.
 *
 * **Why every member is required.** An all-optional interface is satisfied by
 * `{}`, so holding an `InvestigationSource` would guarantee nothing and every
 * consumer would keep the `?.` call plus the undefined branch this interface
 * exists to remove. Required members make the type mean one thing: all five
 * are callable. What is *supported* is a separate question, and `capabilities`
 * is the honest answer to it.
 */
export interface InvestigationSource extends InvestigationOperations {
  readonly capabilities: InvestigationSourceCapabilities;
}

/**
 * The version of the contract above — the five operations, their request and
 * result shapes, and the state union `InvestigationResult` carries.
 *
 * Recorded on a member snapshot beside the selected source's kind (task 9.4,
 * `ReviewRunInvestigationSource`), so a stored record says which shape of
 * evidence it was written against rather than leaving a later reader to infer
 * it from the fields that happen to be present. It changes only when the
 * contract itself changes in a way a stored record cannot be read under —
 * adding a state to the union is such a change, because a record written before
 * it never had that state available to mean anything.
 *
 * Separate from `HARNESS_TOOL_CONTRACT_VERSION`, which versions the tool
 * catalog the *model* is given. This one versions what a source answers.
 */
export const INVESTIGATION_CONTRACT_VERSION = '1';

// ---- Where a source obtains objects ---------------------------------------------

/**
 * Everything a non-forge investigation source needs to obtain a repository's
 * objects for itself, and nothing that says which platform produced it
 * (design.md D2/D8, task 2.3).
 *
 * The neutral layer never learns what any of these values mean. It fetches
 * from `fetchUrl`, sends `authorizationHeaderValue` if present, passes
 * `refHint` through as an extra refspec if the first attempt fails, and
 * interprets none of the three. That opacity is the whole point: a forge
 * composes its own pull-request or merge-request ref name — `refs/pull/{n}/head`
 * on GitHub, `refs/merge-requests/{iid}/head` on GitLab — and the consumer
 * must never learn that such a thing exists, or the contract has grown a forge
 * shape again. Verification is by object id after the fetch, so a wrong hint
 * cannot substitute a different commit.
 */
export interface ObjectSourceDescriptor {
  /**
   * Where objects are fetched from. A complete, absolute location a consumer
   * uses as given — never a template to fill in and never a bare identifier.
   * The producer guarantees an `http`/`https` location (the provider contract
   * suite asserts it); a consumer still refuses anything else, because a
   * transport like `ext::` runs a command of the remote's choosing.
   */
  readonly fetchUrl: string;
  /**
   * The complete value of the `Authorization` header the fetch should carry
   * (`Bearer …`, `Basic …`), composed by whoever knows what the remote
   * accepts. Opaque here on purpose: which scheme a platform's git endpoint
   * wants is a fact about that platform, and keeping it a single uninspected
   * string means it can be corrected without touching this contract.
   *
   * Absent when the remote needs no credential. It is a secret: it never
   * enters a URL, a command line, an activity event, a checkpoint, a
   * diagnostic record, an error reason or any stored record
   * (`src/providers/objectSourceCredential.test.ts`, extended to the git
   * invocation sinks by task 6.16).
   */
  readonly authorizationHeaderValue?: string;
  /**
   * An opaque extra ref to try when the pinned commit cannot be obtained by
   * object id alone — a force-pushed head that is unreachable from any branch.
   * Passed through verbatim, never parsed, never composed by the consumer.
   */
  readonly refHint?: string;
  /**
   * The ref for the branch this change request is to be merged into, as the
   * platform names it — `refs/heads/main` on both forges today. Opaque in
   * exactly the way `refHint` is: passed through verbatim, never parsed, never
   * composed by the consumer.
   *
   * **What it replaced.** The commit a change request's diff is against used to
   * arrive as a number from the forge — GitHub's `merge_base_commit.sha`,
   * GitLab's `diff_refs.base_sha` — and the local source fetched it like any
   * other pinned commit. A merge base is a computation over two commits, so
   * under the rule that git answers everything git can answer, the forge is
   * asked only for the thing that is genuinely its own: which branch this
   * change request targets. `git merge-base` does the rest, locally, against a
   * store this extension owns.
   *
   * Absent means the platform could not say, and a review that cannot compute
   * the commit its diff is against does not start. There is no forge fallback
   * behind it any more, and inventing one — the target branch's tip, say —
   * would silently review a different pair of commits than the change request
   * describes.
   */
  readonly mergeTargetRef?: string;
}

/**
 * A descriptor, or a stated reason there is none. Never a third answer: a
 * caller that cannot obtain objects must be told why, in the source's own
 * words, because that reason is what the run reports as a limitation
 * (design.md D8, task 10.3) instead of an unexplained fallback.
 */
export type ObjectSourceResult =
  | { state: 'available'; descriptor: ObjectSourceDescriptor }
  | { state: 'unavailable'; reason: string };

/**
 * Whether a fetch location is one a consumer may use at all: an absolute
 * `http`/`https` URL carrying no credential of its own.
 *
 * Shared rather than written twice. A producer calls it before returning a
 * descriptor, so the provider contract suite's "an `http`/`https` location or
 * an explicit unavailable reason" case passes by construction rather than by
 * luck; a consumer calls it again before fetching, because a descriptor is
 * only as trustworthy as the thing that made it and `ext::` runs a command of
 * the remote's choosing (design.md D7, task 6.19).
 *
 * Userinfo is refused for a second reason: a credential belongs in the
 * descriptor's own header value, never in a URL. Git echoes URLs in its error
 * text, and that text is a model-visible channel.
 */
export function isFetchableObjectSourceUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return parsed.username === '' && parsed.password === '' && parsed.host !== '';
}

// ---- Normalized details ---------------------------------------------------------

export type DetailSection = 'metadata' | 'commits' | 'discussion' | 'labels' | 'checkSummaries' | 'relationships';

export interface NormalizedCommit {
  sha: string;
  message: string;
  author: string;
}

export interface NormalizedCheckSummary {
  name: string;
  status: CiStatus;
  summary?: string;
}

export interface NormalizedRelationship {
  kind: string;
  ref: string;
}

/**
 * Full normalized detail shared by change-request and linked-issue retrieval
 * (D4/D6); excludes patch content and full CI logs by construction — neither
 * field exists here to populate.
 */
export interface NormalizedDetail {
  title: string;
  body?: string;
  labels: readonly string[];
  commits: readonly NormalizedCommit[];
  discussion: readonly ThreadNote[];
  checkSummaries: readonly NormalizedCheckSummary[];
  relationships: readonly NormalizedRelationship[];
  /** Sections this response could not populate; absence from here is never a silent drop. */
  unavailableSections: readonly DetailSection[];
}

export interface ChangeRequestDetailRequest {
  snapshot: InvestigationSnapshotRef;
  /** Repo-scoped CR number — `snapshot` alone does not identify which change request. */
  number: string;
  section?: DetailSection;
  cursor?: InvestigationCursor;
}

export type ChangeRequestDetailResult = InvestigationResult<NormalizedDetail>;

export interface IssueDetailRequest {
  /** The pinning run's own snapshot — linked-issue content is fetched as of this snapshot, even though an issue has no revision itself. */
  snapshot: InvestigationSnapshotRef;
  /** The linked issue's own identity, which may be a different repository than `snapshot.repoId`. */
  issueRepoId: string;
  issueNumber: string;
  section?: DetailSection;
  cursor?: InvestigationCursor;
}

export type IssueDetailResult = InvestigationResult<NormalizedDetail>;

// ---- Current head -------------------------------------------------------------

export type CurrentHeadState = 'resolved' | 'unavailable' | 'notFound';

export interface CurrentHeadResult {
  repoId: string;
  state: CurrentHeadState;
  /** Present only when `state` is `'resolved'`. */
  headSha?: string;
}
