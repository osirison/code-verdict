## ADDED Requirements

### Requirement: A change request's base revision is the merge base, computed from the repository

The commit a change request's diff is against SHALL be its merge base, and SHALL be computed from the repository's own objects rather than reported by a platform. A review SHALL state which meaning a recorded base revision carries, and SHALL NOT reinterpret a base revision recorded under one meaning as the other.

#### Scenario: The target branch moves during a review

- **WHEN** commits land on the target branch after a review has snapshotted its base revision
- **THEN** the recorded base revision does not change, because the merge base did not
- **AND** evidence already computed against that base stays valid for the same change request

#### Scenario: A base revision was recorded under the earlier meaning

- **WHEN** a stored record carries a base revision written before the merge base became the recorded base
- **THEN** it is read as a target-branch tip, because every record written before that point used one by construction
- **AND** it is compared under that meaning rather than assumed to be a merge base

#### Scenario: The merge base cannot be computed

- **WHEN** the history obtained for the pinned head and the target branch contains no common ancestor within the bound the review will fetch
- **THEN** the review refuses with a reason naming the depth that was reached
- **AND** it does not substitute the target branch tip and describe it as the merge base

#### Scenario: The platform is asked only which branch the change targets

- **WHEN** a review needs the commit a change request's diff is against
- **THEN** the platform is asked for the branch the change request targets, which lives in no repository
- **AND** the commit itself is computed locally from that branch and the pinned head

### Requirement: A provider supplies a neutral object-source descriptor

A provider SHALL expose an operation that returns, for an authorized repository, a neutral descriptor sufficient for a non-provider source to obtain that repository's git objects and to compute the commit a change request's diff is against: a fetch location, an optional credential value, an optional opaque ref hint for revisions not reachable by object id alone, and the ref of the branch the change request targets. The descriptor SHALL carry no platform-specific structure a caller must interpret, and a provider that cannot produce one SHALL say so explicitly.

#### Scenario: A descriptor is requested for an authorized repository

- **WHEN** a caller requests an object-source descriptor for a repository the connection is authorized for
- **THEN** the provider returns a fetch location and, where authentication is required, a credential value
- **AND** the descriptor's shape is the same for every platform

#### Scenario: The descriptor names the branch the change targets

- **WHEN** a descriptor is produced for a change request
- **THEN** it carries the ref of the branch that change request is to be merged into, as the platform names it
- **AND** the caller passes it through to git without interpreting it, and computes the merge base itself

#### Scenario: A revision may need a platform-specific ref

- **WHEN** a platform exposes change-request revisions under a server-side ref that an object id fetch may not reach
- **THEN** the provider may include that ref as an opaque hint in the descriptor
- **AND** the caller uses it without interpreting it, and verifies the obtained object against the pinned id

#### Scenario: No descriptor can be produced

- **WHEN** the connection cannot produce a fetch location or credential for a repository
- **THEN** the operation reports the descriptor as unavailable with a stated reason
- **AND** the caller treats the repository as one it cannot obtain objects for

## MODIFIED Requirements

### Requirement: Providers declare only what is not in the repository

A provider SHALL NOT answer any operation that can be computed from two commits: changed-file manifests, diff reads, file reads, repository search and diff search SHALL be answered by an investigation source reading a local copy of the repository, never by a platform. A provider SHALL declare whether and how it supports normalized change-request and issue detail retrieval, and their pagination. Review behavior SHALL decide from these declarations rather than provider identity.

#### Scenario: A review needs the changed files of a change request

- **WHEN** a run starts against any provider
- **THEN** the changed files, their diffs, their contents and any search over them come from a local copy of the repository
- **AND** no request is made to the platform to compute or enumerate them

#### Scenario: A review needs a change request's own detail

- **WHEN** a run needs the title, description, discussion, labels, reviewers or checks of a change request, or of a linked issue
- **THEN** the provider answers, because none of it is in the repository
- **AND** the declaration says per operation whether it can

#### Scenario: Required capability is unavailable

- **WHEN** a provider cannot supply a required detail capability
- **THEN** it declares that limitation explicitly
- **AND** the harness degrades to a partial or failed outcome rather than silently using an unpinned or provider-specific fallback

### Requirement: An investigation source exposes a complete changed-file manifest

A manifest operation SHALL enumerate changed files for the immutable base and head pair with stable repository-relative paths and enough metadata to classify additions, modifications, deletions, renames, binary content, and known size or line-change bounds. Pagination SHALL preserve one snapshot and SHALL state whether enumeration is complete. A manifest entry SHALL be labelled binary only from a determination actually made about the file's content. An entry the platform enumerated but whose content it declined to render SHALL carry a distinct declined-content state that is neither binary nor a complete reading of that file.

#### Scenario: Manifest spans pages

- **WHEN** a change request contains more files than one provider response allows
- **THEN** each page carries a continuation reference bound to the same base and head
- **AND** the final page states that enumeration is complete

#### Scenario: Manifest is truncated by the platform

- **WHEN** the source cannot enumerate every changed file because of a bound it declared
- **THEN** the operation returns an explicit incomplete or truncated manifest state and the known counts
- **AND** the known subset is not represented as the complete inventory

#### Scenario: Manifest includes binary and renamed files

- **WHEN** a change includes binary content and a rename
- **THEN** the manifest labels the binary state and old and new paths explicitly
- **AND** neither entry is silently omitted because textual diff content is unavailable

#### Scenario: The platform enumerates a file but declines its content

- **WHEN** a manifest entry arrives with no rendered content and no line counts, the shape a platform produces when it declined to compute that file's diff
- **THEN** the entry carries the declined-content state
- **AND** it is not labelled binary, because the platform never determined that the content is binary

#### Scenario: A declined entry cannot be resolved by guessing

- **WHEN** a provider cannot distinguish a file whose content is binary from one the platform declined to render
- **THEN** it reports the declined-content state rather than choosing between them
- **AND** no irreversible classification is derived from the ambiguity

### Requirement: Result states are explicit and neutral

Every manifest, read, search, and detail result SHALL distinguish complete, paginated, truncated, unavailable, binary, too-large, not-found, and declined-content outcomes where applicable. The declined-content state SHALL be non-terminal: it records that the platform did not serve this content, never that the content cannot be read. A changed-file manifest SHALL report a base and head pair the platform cannot resolve as the not-found state, and SHALL do so only where the repository itself still answers; where it does not, the result SHALL be unavailable, because nothing was established about the revisions. A path-scoped read SHALL report such a pair as unavailable, because its own not-found state states that the path is absent from the change. Normalized failures SHALL retain retryability and `Retry-After` guidance without exposing platform-specific error payloads.

#### Scenario: Rate-limited investigation read

- **WHEN** the platform rate-limits an investigation operation
- **THEN** the provider returns the neutral rate-limited failure with retry guidance when supplied
- **AND** the harness can apply its bounded retry policy without inspecting provider-specific fields

#### Scenario: Empty complete result

- **WHEN** an authorized search completes exhaustively with no matches
- **THEN** the response explicitly identifies a complete empty result
- **AND** it remains distinguishable from unavailable, truncated, and not-found states

#### Scenario: A pinned revision the platform no longer holds

- **WHEN** a changed-file manifest request names a base and head pair the platform cannot resolve, from a connection that is otherwise serving that repository
- **THEN** the result is the not-found state for the requested revisions
- **AND** it stays distinguishable from unavailable, rate-limited and unauthorized failures, which say nothing about whether a revision exists

#### Scenario: An unresolvable pair on a repository that does not answer either

- **WHEN** a changed-file manifest request names an unresolvable base and head pair and the repository itself cannot be read
- **THEN** the result is unavailable, naming that nothing was established about those revisions
- **AND** no caller may treat it as evidence that the platform no longer holds them

#### Scenario: A path-scoped read of an unresolvable pair

- **WHEN** a diff or file read names a base and head pair the platform cannot resolve
- **THEN** the result is unavailable rather than not-found
- **AND** the not-found state on such a read keeps its own meaning, that the requested path is absent from the change

#### Scenario: Provider response omits completeness

- **WHEN** an implementation cannot determine whether a platform response is complete
- **THEN** it reports unknown or unavailable completeness under the neutral contract
- **AND** callers do not assume completeness

#### Scenario: A declined read arrives mid-run

- **WHEN** a diff read for a file returns the platform's declined-content shape after a run has already started
- **THEN** the result carries the declined-content state
- **AND** the file remains readable by another source rather than being closed as binary
