## Purpose

Defines the universal host-controlled review process that plans, investigates bounded evidence, measures coverage, and decides whether a review is complete.

## ADDED Requirements

### Requirement: Every review uses the agentic harness

Every initial review and rerun SHALL execute through the same agentic review harness for every selected agent or persona and for both individual change-request and changeset targets. The system SHALL NOT provide a one-shot review bypass.

#### Scenario: Initial and repeated review

- **WHEN** a reviewer starts either an initial review or a rerun
- **THEN** the host creates a new harness attempt with the selected immutable inputs
- **AND** the same lifecycle, evidence, coverage, and completion rules apply to both

#### Scenario: Every persona uses the harness

- **WHEN** a reviewer selects the built-in agent, a discovered persona, the demo agent, or another supported agent type
- **THEN** the review executes through the same host-owned state machine
- **AND** the agent type does not bypass host authorization, evidence validation, activity, or completion checks

#### Scenario: Small review fast path

- **WHEN** the complete inventory and required evidence fit within the fast-path budgets
- **THEN** the harness may classify and inspect them with fewer turns
- **AND** it still publishes a plan, records evidence and coverage, performs verification, and requests host completion through the same protocol

### Requirement: A run starts from an immutable snapshot and isolated bootstrap

Before model work begins, the host SHALL snapshot immutable repository identity, base and head revisions, target identity, selected agent instructions and persona, criteria, model, thinking effort, context controls, and host-owned tool contracts. The bootstrap SHALL include normalized full linked-issue details; normalized full change-request metadata, title, body, commits, review discussion, labels, check summaries, and relationships; root `AGENTS.md` policy from the base revision; and references that let large sections be reopened. Full CI logs and the patch SHALL NOT be included in bootstrap.

#### Scenario: Bootstrap is assembled

- **WHEN** a harness attempt begins
- **THEN** every required bootstrap field is attributed to the immutable snapshot
- **AND** author-controlled issue, change-request, commit, and discussion content is isolated as untrusted input
- **AND** host instructions, policy, criteria, and tool contracts cannot be forged by that content

#### Scenario: A bootstrap section is too large

- **WHEN** a linked issue, discussion, commit list, or other reopenable bootstrap section exceeds its bootstrap allocation
- **THEN** the bootstrap contains a truthful summary, truncation state, and retrieval reference for the omitted content
- **AND** the full normalized section remains available through a bounded retrieval tool

#### Scenario: Mandatory bootstrap cannot fit

- **WHEN** the minimum bootstrap envelope and tool contracts exceed the selected model's input limit even after reopenable sections are replaced by references
- **THEN** the host does not claim that model investigation started
- **AND** the attempt ends with an explicit failed or incomplete result, completeness `none`, and the limiting input reported

#### Scenario: Target head changes after snapshot

- **WHEN** the provider reports a different head revision before final completion
- **THEN** the attempt cannot complete successfully
- **AND** evidence from the old head is not relabelled or reused as evidence for the new head

### Requirement: The model plans and investigates through bounded host tools

The harness SHALL let the model create and revise a public plan, classify risk, and choose investigation steps. All investigation SHALL use host-authorized, revision-pinned, paginated or otherwise bounded tools. The available tools SHALL include changed-file manifest retrieval, diff reads, base and head file-range reads, repository search, diff search, applicable nested base-revision `AGENTS.md` policy resolution, issue and change-request detail retrieval, incremental candidate-finding submission, and completion requests.

#### Scenario: Model investigates a subsystem

- **WHEN** the public plan identifies a subsystem or logical unit for investigation
- **THEN** the model chooses bounded tool calls for that unit
- **AND** the host authorizes each call against the run snapshot, budgets, and tool contract before dispatch

#### Scenario: Result has another page

- **WHEN** a manifest, diff, detail read, or search has more results than one response may contain
- **THEN** the tool returns an explicit continuation reference and completeness state
- **AND** the model can request the next bounded page without changing revisions

#### Scenario: Nested policy applies to a file

- **WHEN** the model investigates a changed file beneath one or more nested `AGENTS.md` files
- **THEN** the policy tool resolves the applicable policy chain from the base revision
- **AND** the host applies that policy to the investigation without making it citable evidence

#### Scenario: Agent instructions request another tool

- **WHEN** agent-controlled content names, enables, disables, or attempts to redefine a tool
- **THEN** the host exposes only the tools authorized by the harness contract
- **AND** the attempt records a sanitized protocol or authorization failure when repair is required

### Requirement: Review work follows explicit phases

Each attempt SHALL progress logically through snapshot, bootstrap and inventory, public planning, risk classification, bounded investigation of logical units or subsystems, checkpointing, synthesis, verification with contradiction and deduplication, host validation, and persistence. Planning, investigation, verification, and synthesis MAY be phases of the same selected model and persona; the system SHALL NOT require multiple models.

#### Scenario: Normal phased review

- **WHEN** a review proceeds without pause or failure
- **THEN** its public activity shows each required phase in causal order
- **AND** candidates remain provisional until synthesis, verification, deduplication, and host validation finish

#### Scenario: One selected model performs every model phase

- **WHEN** the host uses the selected model and persona for planning, investigation, synthesis, and verification
- **THEN** the run remains conformant without selecting additional models
- **AND** each phase still has separate budgets, activity, and completion checks

#### Scenario: Plan changes during investigation

- **WHEN** evidence changes the risk classification or reveals another logical unit
- **THEN** the model may revise the public plan
- **AND** the earlier plan and the reason for revision remain visible

### Requirement: Coverage and risk govern investigation

The host SHALL maintain a complete changed-file inventory and SHALL track classification and inspection coverage using real units. It SHALL enforce configured risk coverage, reserve resources for unvisited and high-risk files, and prevent unchanged repository content from silently expanding the primary review inventory.

#### Scenario: Inventory is classified

- **WHEN** manifest retrieval finishes
- **THEN** every changed file is classified as inspected, intentionally excluded under an explicit rule, unavailable, binary, oversized, or still unvisited
- **AND** coverage reports counts for those categories

#### Scenario: High-risk files remain unvisited

- **WHEN** a run approaches its ordinary investigation budget with required high-risk files still unvisited
- **THEN** the host uses reserved investigation budget for those files
- **AND** final verification budget remains reserved

#### Scenario: Unchanged search result is relevant

- **WHEN** repository search finds unchanged supporting code
- **THEN** the model may inspect it as corroborating context
- **AND** it does not become an unannounced primary review target or satisfy changed-file coverage

### Requirement: The host decides whether completion is valid

A model completion request SHALL be advisory. The host SHALL grant complete status only after inventory exhaustion or explicit classification, configured risk coverage, resolution of all required fetches and candidate findings, citation validation, a verification and contradiction pass, deduplication, and confirmation that the target head is unchanged.

#### Scenario: Complete review with findings

- **WHEN** the model requests completion and every completion condition passes
- **THEN** the host persists the validated deduplicated findings with completeness `complete`
- **AND** the run may succeed

#### Scenario: Complete review with no findings

- **WHEN** every completion condition passes and no candidate finding survives validation
- **THEN** the host may persist a clean review with completeness `complete`
- **AND** the coverage report remains available with the clean result

#### Scenario: Model requests completion too early

- **WHEN** the model requests completion while required inventory, fetches, candidates, citations, risk coverage, or verification remain unresolved
- **THEN** the host rejects the request with bounded actionable reasons
- **AND** the harness continues only if sufficient budget remains

#### Scenario: Complete review is impossible

- **WHEN** budget exhaustion, timeout, cancellation, provider limits, incomplete inventory, or an unavailable oversized patch prevents the completion conditions from passing
- **THEN** the result is explicitly partial or failed according to whether validated findings can be retained
- **AND** it includes a coverage and limitation report and is never described as clean

### Requirement: Budgets and retries degrade truthfully

The host SHALL enforce global, per-run, per-turn, per-tool, evidence-size, and elapsed-time budgets. It SHALL reserve budget for unvisited or high-risk files and final verification, apply bounded retries with provider `Retry-After` guidance or backoff for transient failures, and limit protocol-repair attempts. Exact numeric defaults and retention limits SHALL be configurable initial defaults rather than fixed product semantics.

#### Scenario: Provider asks the run to retry later

- **WHEN** a transient provider failure includes `Retry-After` guidance and retry budget remains
- **THEN** the host waits or pauses that dispatch according to the bounded policy
- **AND** public activity reports the wait and elapsed time without exposing provider payloads

#### Scenario: Protocol response is malformed

- **WHEN** a model response does not satisfy the current phase contract
- **THEN** the host may issue a bounded repair request
- **AND** the attempt fails or becomes partial after the repair limit rather than retrying indefinitely

#### Scenario: Budget is exhausted

- **WHEN** any hard run budget is exhausted
- **THEN** the host stops new investigation dispatch
- **AND** it proceeds only with allowed validation and persistence work or records a truthful partial or failed result

### Requirement: Changesets combine member coverage with cross-member analysis

A changeset review SHALL use one harness attempt with a manifest, minimum coverage allocation, and reserved budget for each member, plus shared investigation for cross-member behavior. One member SHALL NOT consume the allocations required to classify and inspect the others.

#### Scenario: One member has a much larger patch

- **WHEN** one changeset member is substantially larger than the others
- **THEN** every member still receives its configured minimum inventory, risk classification, investigation, and verification allocation
- **AND** the large member may use only the remaining shared budget

#### Scenario: Contract spans members

- **WHEN** evidence in one member indicates a dependency, API, schema, or deployment interaction with another member
- **THEN** the public plan may add shared cross-member investigation
- **AND** findings and citations retain the repository and revision identity of each supporting source

#### Scenario: One member is incomplete

- **WHEN** any required member inventory or risk coverage remains incomplete
- **THEN** the changeset result cannot be complete or clean
- **AND** the coverage report identifies the incomplete member separately from shared analysis
