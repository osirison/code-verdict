## ADDED Requirements

### Requirement: Providers declare review investigation capabilities

Each provider SHALL declare whether and how it supports complete changed-file manifests, revision-pinned diff and file reads, repository search, diff search, normalized issue and change-request detail retrieval, and pagination. Review behavior SHALL decide from these capabilities rather than provider identity.

#### Scenario: Provider supports the complete investigation contract

- **WHEN** a run starts against a provider that declares every required capability
- **THEN** the harness exposes the corresponding authorized tools
- **AND** every tool preserves the neutral contract and immutable snapshot

#### Scenario: Required capability is unavailable

- **WHEN** a provider cannot supply a required manifest or revision-pinned read capability
- **THEN** it declares that limitation explicitly
- **AND** the harness degrades to a partial or failed outcome rather than silently using an unpinned or provider-specific fallback

### Requirement: Providers expose a complete changed-file manifest

A provider manifest operation SHALL enumerate changed files for the immutable base and head pair with stable repository-relative paths and enough metadata to classify additions, modifications, deletions, renames, binary content, and known size or line-change bounds. Pagination SHALL preserve one snapshot and SHALL state whether enumeration is complete.

#### Scenario: Manifest spans pages

- **WHEN** a change request contains more files than one provider response allows
- **THEN** each page carries a continuation reference bound to the same base and head
- **AND** the final page states that enumeration is complete

#### Scenario: Manifest is truncated by the platform

- **WHEN** the platform cannot enumerate every changed file because of a provider limit
- **THEN** the operation returns an explicit incomplete or truncated manifest state and the known counts
- **AND** the known subset is not represented as the complete inventory

#### Scenario: Manifest includes binary and renamed files

- **WHEN** a change includes binary content and a rename
- **THEN** the manifest labels the binary state and old and new paths explicitly
- **AND** neither entry is silently omitted because textual diff content is unavailable

### Requirement: Diff and file reads are revision-pinned and bounded

Provider operations SHALL read bounded diff content for the immutable base/head pair and bounded file ranges from an explicit base or head revision. Responses SHALL identify the resolved repository, revision, path, range or page, and completeness state. The provider SHALL NOT substitute a branch tip, working tree, or current default branch for the requested revision.

#### Scenario: Read head file range

- **WHEN** the harness requests lines from a changed file at the snapshotted head revision
- **THEN** the provider returns only a bounded range from that exact revision
- **AND** the response identifies omitted ranges and whether more content is available

#### Scenario: Read base version of deleted file

- **WHEN** the harness requests a deleted file at the snapshotted base revision
- **THEN** the provider returns the requested bounded base content when available
- **AND** it does not report absence merely because the file is absent at head

#### Scenario: Requested content is binary or unavailable

- **WHEN** a requested diff or file range cannot be represented as text
- **THEN** the response explicitly reports binary, unavailable, too large, or truncated state as applicable
- **AND** it does not return an empty text payload that could be mistaken for complete content

#### Scenario: Revision no longer resolves

- **WHEN** the provider cannot resolve the exact requested base or head revision
- **THEN** it returns a normalized unavailable or stale-snapshot failure
- **AND** the harness does not retry against another revision

### Requirement: Repository and diff search are bounded by the snapshot

Providers SHALL expose bounded repository search at an explicit base or head revision and bounded search over the immutable diff. Search responses SHALL identify scope, limits, matching paths and locations, continuation state, and truncation without implying exhaustive results when the platform cannot provide them.

#### Scenario: Search head revision

- **WHEN** the harness searches for a symbol or text at the head revision
- **THEN** matches come only from that explicit revision and authorized repository
- **AND** each returned excerpt can enter the evidence ledger as exact model-visible content

#### Scenario: Search the diff

- **WHEN** the harness searches changed content
- **THEN** results are constrained to the snapshotted base/head diff
- **AND** each result retains the changed-file and diff-location identity needed for a later bounded read

#### Scenario: Search is not exhaustive

- **WHEN** provider result limits prevent exhaustive search
- **THEN** the response states that it is truncated or unavailable with any continuation reference
- **AND** the harness cannot treat absence from those results as proof of absence

### Requirement: Providers return normalized full review details through retrieval

Providers SHALL expose normalized retrieval for full linked-issue details and full change-request details including metadata, title, body, commits, review discussion, labels, check summaries, and relationships. The detail contract SHALL exclude full CI log bodies and patch content, which require separate authorized retrieval where supported.

#### Scenario: Retrieve change-request details

- **WHEN** the harness requests the snapshotted change-request details
- **THEN** the provider returns every supported normalized detail category with explicit availability and pagination state
- **AND** platform-specific payload shapes do not escape the provider boundary

#### Scenario: Retrieve linked issue

- **WHEN** the change request relates to an issue or work item visible to the connection
- **THEN** the provider returns its normalized full details through a bounded retrieval operation
- **AND** the response identifies unavailable fields rather than silently dropping them

#### Scenario: Checks have large logs

- **WHEN** a change request has checks with large execution logs
- **THEN** normalized details include check identity, state, summary, and relationships
- **AND** they do not include the full logs or consume patch retrieval budget

### Requirement: Provider result states are explicit and neutral

Every manifest, read, search, and detail result SHALL distinguish complete, paginated, truncated, unavailable, binary, too-large, and not-found outcomes where applicable. Normalized failures SHALL retain retryability and `Retry-After` guidance without exposing platform-specific error payloads.

#### Scenario: Rate-limited investigation read

- **WHEN** the platform rate-limits an investigation operation
- **THEN** the provider returns the neutral rate-limited failure with retry guidance when supplied
- **AND** the harness can apply its bounded retry policy without inspecting provider-specific fields

#### Scenario: Empty complete result

- **WHEN** an authorized search completes exhaustively with no matches
- **THEN** the response explicitly identifies a complete empty result
- **AND** it remains distinguishable from unavailable, truncated, and not-found states

#### Scenario: Provider response omits completeness

- **WHEN** an implementation cannot determine whether a platform response is complete
- **THEN** it reports unknown or unavailable completeness under the neutral contract
- **AND** callers do not assume completeness
