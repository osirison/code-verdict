## MODIFIED Requirements

### Requirement: Cancelling a run stops the work it is doing

Cancelling a run SHALL stop new model and tool dispatch, propagate cancellation to active host-controlled work, and release its concurrency slot immediately. A cancelled run SHALL preserve prior retained review data and its compact sanitized activity, SHALL record result completeness separately, and SHALL NOT silently promote provisional findings.

#### Scenario: Cancelling a running review

- **WHEN** the reviewer cancels a run that is streaming a model response or executing a tool
- **THEN** no new work is dispatched and cancellation is propagated to the active operation
- **AND** the concurrency slot is released at once, so a queued run can start
- **AND** the target returns to a state from which a new review can be started

#### Scenario: A cancellation is reported as a cancellation

- **WHEN** a run ends because the reviewer cancelled it
- **THEN** it transitions through cancelling to cancelled
- **AND** it is not reported as a timeout, a stall, an agent failure, or a clean review

#### Scenario: Cancellation leaves earlier results alone

- **WHEN** a target had a recorded outcome from an earlier run and a new run on it is cancelled
- **THEN** the earlier retained review is still what the target reports
- **AND** any triage draft from that earlier run is intact

#### Scenario: Cancellation follows a validated partial result

- **WHEN** cancellation occurs after some candidate findings were validated
- **THEN** the run may retain them only as an explicitly incomplete partial result under the retention policy
- **AND** they do not replace a complete retained review or become postable as a complete review

### Requirement: A run completes whether or not anyone is watching

A terminal run SHALL record its lifecycle outcome, result completeness, coverage and limitations, compact sanitized activity, and any validated findings, regardless of which screen is showing or whether any Verdict screen is open. Only a host-validated complete result MAY be recorded as clean or replace the target's retained complete review.

#### Scenario: Findings arrive while the reviewer is elsewhere

- **WHEN** a run returns complete validated findings and no screen is showing that target
- **THEN** the findings are saved as a triage draft for that target
- **AND** the run's outcome, completeness, coverage, and finding count are recorded against that target
- **AND** the review-ready notification is raised

#### Scenario: A clean run while the reviewer is elsewhere

- **WHEN** a run satisfies every host completion condition with no findings and no screen is showing that target
- **THEN** the run is recorded as a complete clean review against that target
- **AND** any superseded triage draft for that target is discarded

#### Scenario: A partial run while the reviewer is elsewhere

- **WHEN** a run ends with validated findings but incomplete coverage or another completion blocker
- **THEN** the partial findings and limitation report are retained as explicitly incomplete
- **AND** an earlier complete retained review remains intact
- **AND** the target is not reported as clean

#### Scenario: A failed run while the reviewer is elsewhere

- **WHEN** a run fails with no retainable validated findings and no screen is showing that target
- **THEN** the failure is held against that target with the reason and completeness `none`
- **AND** opening that target shows the failure and offers to run again without replacing an earlier retained review

### Requirement: A cached review is replaced only by a review that succeeds

While a new run is in flight on a target that has a retained review, the retained review SHALL remain intact and reachable. It SHALL be replaced only when the new run succeeds with result completeness `complete`, and SHALL survive a run that fails, is cancelled, is interrupted, or ends partial.

#### Scenario: A re-run is in flight

- **WHEN** a new run is running on a target that has a retained review
- **THEN** the run's progress is shown
- **AND** the retained review is still reachable from that screen and is unchanged

#### Scenario: A re-run fails

- **WHEN** a new run on a target fails or times out
- **THEN** the failure is reported
- **AND** the retained review is unchanged and is still what the target opens on

#### Scenario: A re-run is cancelled

- **WHEN** the reviewer cancels a new run on a target that has a retained review
- **THEN** the retained review is unchanged and is immediately what the target shows again

#### Scenario: A re-run is interrupted

- **WHEN** a new run is interrupted by extension restart or lost execution
- **THEN** the retained review remains unchanged and reachable
- **AND** the interrupted attempt is reported separately

#### Scenario: A re-run ends partial

- **WHEN** a new run has validated findings but does not satisfy complete status
- **THEN** those findings remain an explicitly incomplete partial result associated with the new run
- **AND** they do not replace the complete retained review

#### Scenario: A re-run succeeds

- **WHEN** a new run completes successfully with completeness `complete`
- **THEN** its result replaces the retained review for that target
- **AND** the replaced review's verdicts, summary text and notes are not carried into the new one

### Requirement: A run that could not survive a restart is reported as interrupted

A nonterminal persisted attempt that is no longer attached to live execution after extension restart SHALL be closed as interrupted. The system SHALL never claim to reconnect to its lost model or tool stream. It MAY offer resume as a new attempt in the same lineage only when checkpoint integrity, immutable repository identity and head, selected model and agent inputs, policy, criteria, thinking effort, context controls, and required persisted evidence are compatible; otherwise it SHALL offer a fresh restart.

#### Scenario: The editor is closed with a run in flight

- **WHEN** the editor or extension host stops while a run is nonterminal, and the extension starts again
- **THEN** the old attempt is reported as interrupted, naming when it started and its last checkpoint
- **AND** the target is not reported as never reviewed, clean, or still connected

#### Scenario: Compatible checkpoint can resume

- **WHEN** the last checkpoint is valid and every required immutable input and head revision still matches
- **THEN** the reviewer may resume as a new attempt with the same lineage
- **AND** activity and evidence identify the attempt boundary

#### Scenario: Head or input is incompatible

- **WHEN** the target head, model, agent inputs, context selection, policy, criteria, or required checkpoint evidence no longer matches
- **THEN** resume is unavailable with the incompatible reason stated
- **AND** the reviewer may start a fresh run without mixing evidence across snapshots

#### Scenario: A completed run leaves no interrupted marker

- **WHEN** a run finishes, fails, or is cancelled
- **THEN** its active execution record is cleared
- **AND** a later restart does not report that attempt as newly interrupted

#### Scenario: Interrupted does not destroy earlier work

- **WHEN** a target is reported interrupted and it has a retained review from an earlier completed run
- **THEN** that review is intact and is still what opening the target shows
- **AND** the interruption is reported alongside it, not in place of it

## ADDED Requirements

### Requirement: Lifecycle and result completeness are independent

The run lifecycle SHALL represent queued, planning, investigating or running, verifying, completing, waiting or paused, resuming, cancelling, cancelled, succeeded, failed, and interrupted states. Result completeness SHALL be tracked independently as `none`, `partial`, or `complete`; no lifecycle label SHALL imply completeness by itself.

#### Scenario: Successful partial result

- **WHEN** an attempt persists validated findings but cannot satisfy every completion condition
- **THEN** its lifecycle may be succeeded or otherwise terminal according to the outcome policy
- **AND** its completeness remains `partial` and it is never presented as clean

#### Scenario: Failed attempt has validated findings

- **WHEN** an attempt fails after validating some findings
- **THEN** lifecycle remains failed
- **AND** the findings may be retained only with completeness `partial`

#### Scenario: Cancelled before evidence

- **WHEN** a queued or planning attempt is cancelled before validating evidence
- **THEN** lifecycle is cancelled
- **AND** result completeness is `none`

### Requirement: Run state and checkpoints use bounded workspace persistence

The system SHALL persist compact sanitized activity, projected plan and status, checkpoint metadata, evidence metadata and digests, candidate and validated findings, budgets, coverage, and attempt lineage in bounded workspace storage. Persistence SHALL exclude raw prompts, raw model fragments, secrets, full tool arguments, full tool output blobs, and hidden reasoning.

#### Scenario: Checkpoint is written

- **WHEN** a run reaches a checkpoint boundary
- **THEN** enough compatible state is persisted to validate a later resume attempt
- **AND** the checkpoint records its snapshot identity and completeness without claiming that active streams are durable

#### Scenario: Persistence reaches its limit

- **WHEN** stored run data reaches a configurable retention or size bound
- **THEN** terminal history is compacted or evicted according to the documented policy before active checkpoint integrity is discarded
- **AND** any checkpoint made incompatible by eviction is marked unavailable for resume

#### Scenario: Persisted content is inspected

- **WHEN** workspace storage for a run is examined
- **THEN** it contains only the bounded sanitized protocol and required review metadata
- **AND** it contains no raw prompts, hidden reasoning, secrets, or complete tool payload archives
