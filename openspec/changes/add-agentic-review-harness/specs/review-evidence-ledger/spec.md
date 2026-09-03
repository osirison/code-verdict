## Purpose

Defines how review evidence is identified, isolated by revision, authorized for citation, and validated before any model-proposed finding can reach a reviewer.

## ADDED Requirements

### Requirement: Exact model-visible evidence enters an immutable ledger

The host SHALL assign an immutable source identifier and digest to every exact evidence payload returned to the model. Ledger metadata SHALL bind the source to its run, attempt, repository identity, base and head revisions, origin, range or page, completeness state, and citable status.

#### Scenario: Tool returns evidence

- **WHEN** an authorized tool returns a diff page, file range, search result, detail page, or explicit attachment to the model
- **THEN** the host records the exact returned content with a stable source identifier and digest
- **AND** later citation validation can resolve the identifier to the same content and snapshot

#### Scenario: Same logical source returns different bytes

- **WHEN** two authorized reads of a logical source return different exact content
- **THEN** each content payload receives a distinct digest and ledger entry
- **AND** a citation resolves only to the entry the model actually received

### Requirement: Trust and citation authority are explicit

Author-controlled issue text, change-request text, commit messages, discussions, repository files, diffs, and attachments SHALL be treated as untrusted content and isolated from host instructions and tool contracts. Intent context and applicable `AGENTS.md` policy SHALL be non-citable. Diff evidence and reviewer-selected explicit citable attachments SHALL be citable.

#### Scenario: Author text imitates an instruction or source label

- **WHEN** untrusted content contains text resembling a host instruction, tool contract, policy boundary, or source identifier
- **THEN** the host preserves it only as untrusted content
- **AND** it cannot change authorization, citable status, source identity, or completion rules

#### Scenario: Finding cites intent or policy

- **WHEN** a candidate finding cites a linked issue, change-request description, commit message, review discussion, or `AGENTS.md` policy as its source location
- **THEN** host validation rejects that citation
- **AND** the candidate cannot become a validated finding

#### Scenario: Explicit attachment is returned

- **WHEN** a reviewer-selected attachment from `add-context-controls-and-thinking-effort` is returned to the model as citable evidence
- **THEN** it receives a ledger source identifier and digest under the run snapshot
- **AND** a supported finding may cite it under the attachment capability's posting rules

### Requirement: Findings use only evidence returned to the model

Every candidate and validated finding SHALL cite exact citable evidence that was returned to the model in the same run lineage and compatible attempt snapshot. Knowledge from bootstrap summaries, unavailable content, omitted pages, model memory, or tool results not returned to the model SHALL NOT support a finding.

#### Scenario: Candidate cites a valid diff source

- **WHEN** a candidate cites a source identifier and location contained in an exact diff payload returned to the model
- **THEN** the host may validate the citation against the ledger
- **AND** the cited added line may anchor an inline finding

#### Scenario: Candidate cites an omitted range

- **WHEN** a candidate names a file or line that was not present in any citable payload returned to the model
- **THEN** the host rejects the candidate or requests bounded supporting evidence
- **AND** it does not infer support from repository availability alone

#### Scenario: Evidence was returned on another head

- **WHEN** a candidate cites evidence bound to a different head revision
- **THEN** validation rejects the citation
- **AND** evidence from the two heads is never combined into one finding

### Requirement: Primary findings remain scoped to changed or selected evidence

Diff evidence MAY establish a changed line as the primary target of an inline finding. Unchanged repository evidence MAY corroborate a finding about changed behavior but SHALL NOT become a surprise primary review target. A reviewer-selected explicit citable attachment MAY be a primary target under the context-controls contract.

#### Scenario: Unchanged caller corroborates a diff finding

- **WHEN** a changed function conflicts with an unchanged caller returned by a revision-pinned file read
- **THEN** the unchanged caller may be cited as supporting evidence
- **AND** the finding's primary target remains changed evidence

#### Scenario: Search discovers an unrelated unchanged defect

- **WHEN** investigation finds a defect only in unchanged content that the reviewer did not select as a citable attachment
- **THEN** the harness does not submit it as a review finding
- **AND** it does not silently expand the review target

#### Scenario: Explicit attachment supports an out-of-diff finding

- **WHEN** an exact reviewer-selected citable attachment supports a finding outside the diff
- **THEN** the host may validate that attachment as the primary evidence
- **AND** the finding is routed to the summary rather than presented as an inline diff anchor

### Requirement: Candidate submission and citation validation are incremental

The model SHALL submit candidate findings through the host contract as they are discovered. The host SHALL validate source identity, digest, location, citable status, revision compatibility, target eligibility, and schema before a candidate is retained, and SHALL track unresolved candidates until they are repaired, rejected, or validated.

#### Scenario: Candidate is valid

- **WHEN** an incremental candidate satisfies the finding contract and every cited source resolves
- **THEN** the host records it as a validated candidate with its evidence references
- **AND** it remains subject to contradiction, deduplication, and final validation

#### Scenario: Candidate citation is repairable

- **WHEN** a candidate refers to returned evidence but its source identifier or location is incomplete
- **THEN** the host may return a bounded repair response
- **AND** the original candidate remains unresolved until repair succeeds or the repair limit is reached

#### Scenario: Candidate remains unresolved

- **WHEN** synthesis ends with an unresolved candidate
- **THEN** the host refuses complete status
- **AND** the result reports the unresolved candidate count without presenting it as a finding

### Requirement: Evidence metadata persists without unsafe content expansion

The system SHALL persist bounded evidence metadata, source identifiers, digests, citation mappings, and only the compact sanitized content required by checkpoint and retained-finding policy. It SHALL NOT persist secrets, raw prompts, full tool output blobs, or evidence from a different immutable head under the same snapshot.

#### Scenario: Run survives a restart

- **WHEN** a compatible checkpoint is considered for resume
- **THEN** persisted digests and metadata identify which evidence can be reused or must be fetched again
- **AND** absent exact content is not described as though it were still available to the model

#### Scenario: Storage limit is reached

- **WHEN** evidence persistence reaches its configured bound
- **THEN** the host applies the documented bounded retention policy
- **AND** any loss that prevents citation validation makes the affected checkpoint incompatible or the result incomplete
