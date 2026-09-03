## Purpose

Defines the sanitized ordered activity protocol that exposes a review's public plan, current work, lifecycle, coverage, and result consistently across product surfaces.

## ADDED Requirements

### Requirement: Activity is typed, ordered, and attributable

Every public activity event SHALL carry a stable run identifier, lineage identifier, attempt number, monotonic sequence, event time, and event type. Plan items SHALL have stable identifiers across plan revisions within a lineage. Consumers SHALL order events by protocol sequence rather than arrival time.

#### Scenario: Events arrive out of transport order

- **WHEN** a consumer receives two activity events in an order that differs from their sequence values
- **THEN** it projects them in protocol sequence
- **AND** a duplicate event does not create duplicate activity

#### Scenario: Resume creates another attempt

- **WHEN** an interrupted run resumes from a compatible checkpoint
- **THEN** activity keeps the same lineage identifier and uses a new attempt number
- **AND** its new events cannot be confused with events from the lost attempt

### Requirement: Public plans and revisions remain visible

The protocol SHALL represent plan creation, plan revision, concise public rationale, stable plan-item identity, and plan-item states including pending, active, completed, skipped, blocked, and failed. A revision SHALL append history rather than silently overwrite the prior plan.

#### Scenario: Plan is created

- **WHEN** planning produces the first investigation plan
- **THEN** a plan-created event lists stable plan-item identifiers and public descriptions
- **AND** later state events refer to those identifiers

#### Scenario: Evidence changes the plan

- **WHEN** investigation adds, removes, reorders, splits, or blocks planned work
- **THEN** a plan-revised event records the new projection and a concise public reason
- **AND** the previous revision remains available in retained activity

### Requirement: Activity exposes public reasoning without private chain-of-thought

Activity SHALL report concise coding-agent-style rationale, current phase, current action, sanitized tool target, elapsed duration, tool completion or failure summary, coverage changes, checkpoints, waits, pauses, resumes, cancellation, partial outcomes, and final results. It SHALL NOT expose or persist private chain-of-thought, raw prompts, raw model fragments, secrets, full tool arguments, full tool outputs, or hidden reasoning.

#### Scenario: Tool call starts and finishes

- **WHEN** the harness dispatches and completes a tool call
- **THEN** activity names the public action and a sanitized target such as a repository path, logical unit, or result page
- **AND** completion reports bounded outcome metadata without the full arguments or output blob

#### Scenario: Model explains a plan change

- **WHEN** the model supplies internal reasoning and a public rationale for revising the plan
- **THEN** only the concise public rationale enters activity
- **AND** raw reasoning and model fragments are discarded from the public and retained protocol

#### Scenario: Tool data contains a secret

- **WHEN** tool arguments, output, or provider failures contain credentials or secret-like content
- **THEN** activity redacts or omits that content
- **AND** the event still states the operation's truthful public outcome

### Requirement: The protocol covers lifecycle and result transitions

The protocol SHALL represent queued, planning, investigating or running, verifying, completing, waiting or paused, resuming, cancelling, cancelled, succeeded, failed, and interrupted transitions. It SHALL also represent checkpoint, pause, resume, cancel, partial-result, and final-result events with result completeness `none`, `partial`, or `complete` where applicable.

#### Scenario: Run pauses for provider retry

- **WHEN** a bounded retry policy enters a wait
- **THEN** activity reports waiting or paused state, the public reason, and elapsed duration
- **AND** a later transition reports resuming before more work is dispatched

#### Scenario: Cancellation is requested

- **WHEN** the reviewer cancels a queued, running, waiting, or paused attempt
- **THEN** activity records cancelling before cancelled
- **AND** the terminal event states the result completeness independently of lifecycle state

#### Scenario: Attempt is lost on restart

- **WHEN** persisted activity describes nonterminal work that is no longer attached to live execution
- **THEN** an interrupted event closes that attempt
- **AND** no event claims that the lost stream reconnected

### Requirement: Progress is based on real work units

Determinate progress SHALL be shown only when the host has a real denominator, such as changed files classified or required files inspected. Open-ended model, provider, queue, backoff, and cancellation waits SHALL use an indeterminate state with elapsed time. Coverage units and limitations SHALL remain truthful after plan revision or partial completion.

#### Scenario: Manifest denominator is known

- **WHEN** the complete manifest contains 20 changed files and 5 have been classified
- **THEN** the classification projection may show 5 of 20 and 25 percent
- **AND** it names classification rather than implying that 25 percent of reasoning time is complete

#### Scenario: Model response is pending

- **WHEN** the harness is waiting for a model response with no measurable completion denominator
- **THEN** progress is indeterminate and elapsed time continues
- **AND** no fabricated percentage is shown

#### Scenario: Inventory proves incomplete

- **WHEN** a provider limit prevents the full manifest denominator from being known
- **THEN** the projection reports known counts and the incomplete-inventory limitation
- **AND** it does not derive a completion percentage from the known subset

### Requirement: Every review surface projects the same current truth

The active review UI, sidebar, dashboard, status bar, and retained or completed run details SHALL derive current action, lifecycle, elapsed time, completeness, coverage, and attention state from the same activity and status projection. Compact surfaces MAY omit detail but SHALL NOT contradict the full view.

#### Scenario: Run changes phase while another screen is open

- **WHEN** an active run moves from investigating to verifying
- **THEN** every visible surface updates to verifying from the same projected state
- **AND** opening the retained run details shows the ordered activity that caused that state

#### Scenario: Compact surface has limited space

- **WHEN** the status bar or sidebar cannot show the full current action
- **THEN** it shows a concise consistent state and truthful progress mode
- **AND** navigation reaches the detailed activity without inventing another status

#### Scenario: Partial findings are retained

- **WHEN** a run ends with validated findings and completeness `partial`
- **THEN** every result surface labels them incomplete
- **AND** no surface presents the run as a complete or clean review

### Requirement: Notifications are reserved for terminal or attention states

Routine planning, investigation, tool, coverage, and checkpoint events SHALL update activity without raising user notifications. Terminal states and states that require reviewer attention SHALL notify according to existing notification policy.

#### Scenario: Routine tool progress

- **WHEN** a tool page completes and investigation continues normally
- **THEN** activity and visible progress update
- **AND** no toast or review-ready notification is raised

#### Scenario: Review becomes ready

- **WHEN** a run reaches a terminal result that is ready for review
- **THEN** the existing result notification policy applies
- **AND** the notification distinguishes complete, partial, failed, and cancelled outcomes

#### Scenario: Input is required

- **WHEN** a paused run cannot continue without reviewer action
- **THEN** the attention state is visible consistently
- **AND** a notification may identify the required action without exposing private activity
