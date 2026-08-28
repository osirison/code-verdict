## Purpose

Defines what a review run is once it no longer belongs to the screen that started it: a background job with its own lifecycle, addressable by the change request or changeset it reviews, whose result is kept and re-shown rather than recomputed. A reviewer can start a review, go and do something else, start more reviews on other change requests, find every result waiting when they come back, and re-run any of them with different settings without losing what is already there.

## Requirements

### Requirement: A review run is a background job addressed by its target

A review run SHALL be identified by the target it reviews — a single change request, or a changeset — and SHALL exist independently of any screen. Its lifecycle SHALL NOT be bound to whether a screen is open, visible, or showing that target.

#### Scenario: Run outlives the screen that started it

- **WHEN** a review is running on a change request and the reviewer navigates to any other screen, closes the review tab, or reloads the editor's webviews
- **THEN** the run continues
- **AND** no model request is abandoned or discarded

#### Scenario: Returning to a running target

- **WHEN** the reviewer opens a change request that has a run in flight
- **THEN** the running screen is shown for that run, with its progress as it stands at that moment
- **AND** the agent picker is not shown, because the choice of agent and model was already made when the run started

#### Scenario: Returning to a target whose run finished while away

- **WHEN** the reviewer opens a change request whose run completed with findings while they were elsewhere
- **THEN** the triage screen is shown with those findings
- **AND** the run is not started again

### Requirement: Several reviews run at once

The system SHALL allow reviews on distinct targets to be in flight simultaneously. Starting a review on one target SHALL NOT stop, discard, or supersede a review on any other target.

#### Scenario: A second review is started while the first runs

- **WHEN** a review is running on one change request and the reviewer starts a review on a different change request
- **THEN** both runs are in flight
- **AND** each completes on its own and records its own result

#### Scenario: One run fails while others continue

- **WHEN** one in-flight run fails or times out
- **THEN** every other in-flight run is unaffected
- **AND** the failure is reported only against its own target

### Requirement: One run per target

The system SHALL allow at most one run in flight per target. A request to start a review on a target that already has a run in flight SHALL be refused rather than starting a second run or replacing the first.

#### Scenario: Re-triggering a target that is already running

- **WHEN** the reviewer asks to run a review on a target whose run is in flight
- **THEN** no second run starts
- **AND** the existing run is left untouched
- **AND** the screen shows that run's progress and offers to cancel it

#### Scenario: Running again after a run completes

- **WHEN** a target's run has completed, failed, been cancelled, or been reported interrupted
- **THEN** a new review may be started on that target
- **AND** the new run supersedes the previous run's recorded outcome

### Requirement: Concurrency is capped and the excess queues

The system SHALL limit how many runs execute at once. A run started while the limit is reached SHALL be accepted and held in a queued state, and SHALL start when a slot frees. Queued runs SHALL start in the order they were triggered. The limit SHALL be configurable, and SHALL be removable so that no limit is applied.

#### Scenario: Triggering beyond the limit

- **WHEN** the reviewer starts a review while the concurrency limit is already reached
- **THEN** the run is accepted and reported as queued, not rejected and not failed
- **AND** it starts as soon as an executing run finishes, fails, or is cancelled

#### Scenario: Queue order

- **WHEN** more than one run is queued
- **THEN** they start in the order they were triggered

#### Scenario: Limit removed

- **WHEN** the limit is configured to no limit
- **THEN** every triggered run starts immediately
- **AND** no run is ever reported as queued

#### Scenario: A queued run is cancelled

- **WHEN** the reviewer cancels a run that has not started yet
- **THEN** it is removed from the queue
- **AND** no model request is made for it
- **AND** the queue position of the runs behind it advances

### Requirement: Cancelling a run stops the work it is doing

Cancelling a run SHALL stop the underlying model request, not merely discard its result. A cancelled run SHALL release its concurrency slot immediately, SHALL record no findings, and SHALL leave the target's previously recorded outcome unchanged.

#### Scenario: Cancelling a running review

- **WHEN** the reviewer cancels a run that is streaming a response
- **THEN** the model request is cancelled
- **AND** the concurrency slot is released at once, so a queued run can start
- **AND** the target returns to a state from which a new review can be started

#### Scenario: A cancellation is reported as a cancellation

- **WHEN** a run ends because the reviewer cancelled it
- **THEN** it is reported as cancelled
- **AND** it is not reported as a timeout, a stall, or an agent failure

#### Scenario: Cancellation leaves earlier results alone

- **WHEN** a target had a recorded outcome from an earlier run and a new run on it is cancelled
- **THEN** the earlier outcome is still what the target reports
- **AND** any triage draft from that earlier run is intact

### Requirement: A run completes whether or not anyone is watching

A run that finishes SHALL record its result, persist any findings as a triage draft, and raise the review-ready notification, regardless of which screen is showing or whether any Verdict screen is open at all.

#### Scenario: Findings arrive while the reviewer is elsewhere

- **WHEN** a run returns findings and no screen is showing that target
- **THEN** the findings are saved as a triage draft for that target
- **AND** the run's outcome and finding count are recorded against that target
- **AND** the review-ready notification is raised

#### Scenario: A clean run while the reviewer is elsewhere

- **WHEN** a run returns no findings and no screen is showing that target
- **THEN** the run is recorded as a clean run against that target
- **AND** any superseded triage draft for that target is discarded

#### Scenario: A failed run while the reviewer is elsewhere

- **WHEN** a run fails and no screen is showing that target
- **THEN** the failure is held against that target with the reason it failed
- **AND** opening that target shows the failure and offers to run again

### Requirement: A run is attributed to the state it started with

Every run SHALL be executed and recorded against the pod, criteria, agent, model, diff and change context that were in effect when it was triggered. A change to any of those while the run is in flight SHALL NOT alter what that run sends, what it is recorded against, or where its findings are saved.

#### Scenario: The active pod changes mid-run

- **WHEN** the reviewer switches the active pod while a run is in flight
- **THEN** the run's result is recorded against the pod, repository and change request it was triggered for
- **AND** it is not attributed to the newly active pod

#### Scenario: The agent or criteria change mid-run

- **WHEN** the reviewer changes the selected agent, the selected model, or the review criteria while a run is in flight
- **THEN** that run still uses and reports the agent, model and criteria it started with
- **AND** the new selection applies only to runs triggered afterwards

#### Scenario: The pod behind a run is deleted

- **WHEN** the pod a run was triggered for is deleted while the run is in flight
- **THEN** the run is cancelled
- **AND** no result is recorded for a target that no longer has a pod

### Requirement: In-flight runs are visible away from the run screen

The system SHALL show which targets have a review in flight or queued from outside the run screen, including how long each has been running, and SHALL offer to cancel from there.

#### Scenario: Running reviews listed while browsing

- **WHEN** one or more runs are in flight or queued
- **THEN** each is listed with its target, its state, and its elapsed time
- **AND** each can be cancelled from that list
- **AND** the count of active runs is shown persistently, so it is visible without opening any Verdict screen

#### Scenario: Targets in a list of change requests

- **WHEN** a list of change requests or changesets is shown and one of them has a run in flight or queued
- **THEN** that row states that a review is running or queued
- **AND** the state clears from the row when the run ends

#### Scenario: No runs in flight

- **WHEN** no run is in flight or queued
- **THEN** no active-run list and no active-run count are shown

### Requirement: A completed review is cached and is what its target opens on

The system SHALL retain the most recent completed review for each target, including a review that found nothing and a review that has already been submitted. Opening a target SHALL show that retained review without running the agent again.

#### Scenario: Re-opening a target that has findings

- **WHEN** the reviewer opens a target whose most recent review returned findings
- **THEN** those findings are shown, with every verdict already recorded against them
- **AND** no model request is made

#### Scenario: Re-opening a target whose review found nothing

- **WHEN** the reviewer opens a target whose most recent review returned no findings
- **THEN** the clean result is shown, naming when it ran and which agent and model produced it
- **AND** the target is not presented as though it had never been reviewed

#### Scenario: Re-opening a target whose review was submitted

- **WHEN** the reviewer opens a target whose review has already been submitted to the platform
- **THEN** the review that was submitted is shown, stated as submitted
- **AND** the agent picker is not what the target opens on

#### Scenario: The retry ledger clears without taking the review with it

- **WHEN** a submit succeeds
- **THEN** the partial-failure ledger for that submit is cleared, so a later action cannot re-post what already landed
- **AND** the review itself is retained and is still what the target opens on

#### Scenario: The cached review survives a restart

- **WHEN** the editor is closed and re-opened
- **THEN** each target's most recent completed review is still shown when that target is opened

### Requirement: A review can always be re-run, with different settings

The system SHALL offer to run a new review from wherever a completed review is shown. That offer SHALL allow the agent, the model and the criteria to be changed before the new run starts, pre-filled with what the retained review used.

#### Scenario: Re-running from a shown result

- **WHEN** a completed review is on screen
- **THEN** a control to run a new review is available
- **AND** taking it presents the agent, model and criteria selection, pre-filled with the selection the shown review was produced with
- **AND** confirming starts a new run on that target

#### Scenario: Re-running with a different agent

- **WHEN** the reviewer changes the agent or model and starts the new run
- **THEN** the new run uses the new selection
- **AND** the retained review still records the agent and model that produced it, not the new selection

### Requirement: A cached review is replaced only by a review that succeeds

While a new run is in flight on a target that has a retained review, the retained review SHALL remain intact and reachable. It SHALL be replaced only when the new run completes successfully, and SHALL survive a run that fails, is cancelled, or is interrupted.

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

#### Scenario: A re-run succeeds

- **WHEN** a new run on a target completes
- **THEN** its result replaces the retained review for that target
- **AND** the replaced review's verdicts, summary text and notes are not carried into the new one

### Requirement: A run that could not survive a restart is reported as interrupted

A run in flight SHALL be recorded persistently while it executes. A run recorded as in flight that is no longer executing after the extension restarts SHALL be reported against its target as interrupted, distinct from a clean run, a run with findings, and a target never reviewed.

#### Scenario: The editor is closed with a run in flight

- **WHEN** the editor or the extension host stops while a run is in flight, and the extension starts again
- **THEN** that target is reported as interrupted, naming when the run started
- **AND** the target is not reported as never reviewed, clean, or still running
- **AND** the reviewer can start a new review on it

#### Scenario: A completed run leaves no interrupted marker

- **WHEN** a run finishes, fails, or is cancelled
- **THEN** its in-flight record is cleared
- **AND** a later restart reports nothing interrupted for that target

#### Scenario: Interrupted does not destroy earlier work

- **WHEN** a target is reported interrupted and it has a retained review from an earlier completed run
- **THEN** that review is intact and is still what opening the target shows
- **AND** the interruption is reported alongside it, not in place of it
