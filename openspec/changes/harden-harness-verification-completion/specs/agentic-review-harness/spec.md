## MODIFIED Requirements

### Requirement: The host decides whether completion is valid

A model completion request SHALL be advisory. The host SHALL grant complete status only after inventory exhaustion or explicit classification, configured risk coverage, resolution of all required fetches and candidate findings, citation validation, a verification and contradiction pass, deduplication, and confirmation that the target head was actually checked before completion. A target head that was checked and found to have moved past the pinned snapshot SHALL NOT withhold complete status on that basis alone — a review of the pinned revision is valid regardless of what the branch did afterward — but the result SHALL disclose the move. A retained finding whose contradiction check the host has stopped retrying SHALL NOT satisfy the contradiction-pass condition: the host SHALL stop asking the model to repair it, SHALL deny a completion request as unrepairable once such findings are the only condition left, and SHALL end the attempt partial with the finding retained and a limitation naming it. A finding retired this way that a later pass on the same attempt verifies SHALL count as checked again.

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

#### Scenario: A contradiction check cannot conclude

- **WHEN** a retained finding's contradiction check has failed the same way on every attempt up to the host's retry bound, and no other completion condition remains open
- **THEN** the host denies the next completion request as unrepairable and ends the attempt
- **AND** the result is partial, the finding is retained and shown, and a limitation names the finding and why its check could not conclude
- **AND** the retained review is not replaced

#### Scenario: A retired check later concludes

- **WHEN** a finding whose check the host had stopped retrying is verified cleanly by a later pass on the same attempt
- **THEN** the finding counts as checked, its limitation is withdrawn, and the attempt may end complete

### Requirement: Budgets and retries degrade truthfully

The host SHALL enforce global, per-run, per-turn, per-tool, evidence-size, and elapsed-time budgets. It SHALL reserve budget for unvisited or high-risk files and final verification, apply bounded retries with provider `Retry-After` guidance or backoff for transient failures, and limit protocol-repair attempts. Every model call the host makes during verification, including each contradiction check, SHALL draw one model turn from the run's model-turn budget before it is made and SHALL NOT start once the elapsed-time limit is reached; a verification pass the budget stops SHALL retain the findings it did not reach, record how many it did not check and why, and SHALL NOT count them as checked or as failed. Exact numeric defaults and retention limits SHALL be configurable initial defaults rather than fixed product semantics.

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

#### Scenario: Verification calls draw on the run budget

- **WHEN** the contradiction pass asks the model about a retained finding
- **THEN** one model turn is reserved from the run's model-turn budget before the ask, with that finding's repair asks absorbed under the same reservation
- **AND** a refused reservation stops the pass with every unasked finding retained, no model call made for it, and a limitation naming how many findings were not checked

#### Scenario: The time limit is reached during verification

- **WHEN** the elapsed-time limit is reached while findings remain to be checked
- **THEN** no further check or repair ask is made
- **AND** the attempt ends partial with a timeout blocker, the unchecked findings retained, and a limitation naming how many were not checked
