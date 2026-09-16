## ADDED Requirements

### Requirement: A resumed attempt keeps the investigation source and base-revision meaning it started with

A resumed attempt SHALL compare the recorded investigation source kind and the recorded meaning of the base revision before it compares revision identity, and SHALL refuse to resume when either differs, with a reason that names which one changed. Coverage, evidence and inspection state from one investigation source SHALL NOT be carried into an attempt served by another.

#### Scenario: The investigation source changed since the checkpoint

- **WHEN** a stored checkpoint records one investigation source kind and the new attempt would use another
- **THEN** the checkpoint is incompatible and the reason names the source change
- **AND** the reviewer is offered a fresh attempt rather than a resume across two views of the change

#### Scenario: The stored base revision means something else

- **WHEN** a stored checkpoint's base revision was recorded as a target-branch tip and the new attempt's base revision is a merge base
- **THEN** the checkpoint is incompatible and the reason states that the base revision was recorded under the earlier meaning
- **AND** the reason does not report that the target branch moved, because that is a different fact

#### Scenario: The meaning changed but the commit did not

- **WHEN** the stored base revision was recorded as a target-branch tip and is the identical commit the merge base now resolves to
- **THEN** the pair of commits the evidence was computed over is unchanged, so the base revision alone does not make the checkpoint incompatible
- **AND** the resumed attempt records the current meaning

#### Scenario: A record predates source recording

- **WHEN** a stored checkpoint carries no investigation source and no base-revision meaning
- **THEN** it is read as the provider source and a target-branch tip, the only shapes that existed before those fields
- **AND** absence is treated as that known fact, not as an unknown to be ignored
- **AND** a resumed attempt refuses it, because nothing serves investigation from a platform any more

## MODIFIED Requirements

### Requirement: A run starts from an immutable snapshot and isolated bootstrap

Before model work begins, the host SHALL snapshot immutable repository identity, base and head revisions, the meaning of the base revision, the selected investigation source and its capability signature, target identity, selected agent instructions and persona, criteria, model, thinking effort, context controls, and host-owned tool contracts. The investigation source SHALL be obtained once per member before any model work and SHALL NOT change during an attempt. There SHALL be exactly one kind of investigation source for a connected pod — a local copy of the repository — and a member whose source cannot be obtained SHALL end its attempt before bootstrap with completeness `none` and a reason naming what was unavailable, never a review served from the platform instead. The bootstrap SHALL include normalized full linked-issue details; normalized full change-request metadata, title, body, commits, review discussion, labels, check summaries, and relationships; root `AGENTS.md` policy from the base revision; and references that let large sections be reopened. Full CI logs and the patch SHALL NOT be included in bootstrap.

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

#### Scenario: An investigation source is selected

- **WHEN** the host prepares a member's snapshot and more than one source could answer investigation requests
- **THEN** it selects the source that can serve the whole change, confirms it can answer before the attempt starts, and records the chosen kind and its capability signature in the snapshot
- **AND** every piece of evidence records which source produced it

#### Scenario: No source can serve the change

- **WHEN** neither a local source nor the provider can serve investigation for a member's change
- **THEN** the attempt does not begin model work
- **AND** it ends with completeness `none` and a reason naming what could not be obtained

#### Scenario: The preferred source is unavailable

- **WHEN** the preferred investigation source cannot be prepared and another source can serve the change
- **THEN** the attempt uses the other source and records that its preferred source was unavailable, with the reason
- **AND** the run's limitations state which source produced its evidence

#### Scenario: A pinned revision cannot be obtained and its absence is unproven

- **WHEN** a pinned commit cannot be obtained by one source and no other source establishes whether the platform still holds it
- **THEN** the attempt does not begin model work, and the reason names the revision and that its absence was not established
- **AND** the checkpoint is not reported incompatible, because a stale snapshot was not proven

### Requirement: Coverage and risk govern investigation

The host SHALL maintain a complete changed-file inventory and SHALL track classification and inspection coverage using real units. It SHALL enforce configured risk coverage, reserve resources for unvisited and high-risk files, and prevent unchanged repository content from silently expanding the primary review inventory. A file SHALL enter an irreversible non-inspected state only from a condition the investigation source proved; a source that declined to serve content, timed out, exceeded a bound, or could not obtain a revision SHALL leave that file classified and uninspected, and the run SHALL NOT be reported complete while such a file remains uninspected, whatever its risk level. A non-inspected terminal state replayed from a stored checkpoint SHALL be re-applied only where the source serving the new attempt states the same condition.

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

#### Scenario: A source declines to serve a file's content

- **WHEN** a read returns the declined-content state for a changed file
- **THEN** the file stays classified and uninspected rather than being closed as binary or unavailable
- **AND** the run cannot be reported complete while it remains uninspected

#### Scenario: A read exceeds a host bound

- **WHEN** an investigation read is stopped by a time bound or an output bound
- **THEN** the result is a bounded, non-terminal state
- **AND** no file is recorded as permanently uninspectable because of it
- **AND** the run cannot be reported complete while that file remains uninspected

#### Scenario: A read establishes nothing about a file no risk rule requires

- **WHEN** a read of a changed file returns a state that establishes nothing about its content, and the file's risk does not itself require inspection
- **THEN** the run cannot be reported complete while the file remains uninspected
- **AND** the outcome is never reported clean

#### Scenario: A resumed attempt replays a terminal state the current source does not state

- **WHEN** a stored checkpoint records a changed file in a non-inspected terminal state and the source serving the new attempt does not state that condition for it
- **THEN** the file is replayed as classified and uninspected rather than terminal, keeping the classification the lost attempt established
- **AND** the resumed run cannot be reported complete over it
