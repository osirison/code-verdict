## Purpose

Defines the state the extension holds on behalf of every screen: one shared, freshness-tracked copy of the platform data a pod is made of, rather than a separate copy fetched by each screen that needs it. It sets out when that data is re-fetched, what happens when two screens want it at once, what happens when a re-fetch finds nothing new, and how a reviewer's triage decisions stay durable when their writes are batched.

## ADDED Requirements

### Requirement: Platform data is fetched once and shared by every screen

The system SHALL hold one shared copy of a pod's platform data — its open change requests, work items and CI runs. A fetch made to satisfy one screen SHALL satisfy every other screen that needs the same data. Two screens needing the same pod's data at the same time SHALL result in one request to the platform, not one each.

#### Scenario: Several screens want the same data at once

- **WHEN** an event causes the dashboard, the sidebar and the changeset screen to need the active pod's data at the same moment
- **THEN** exactly one set of platform requests is issued
- **AND** all three screens are served from its result

#### Scenario: A second screen opens while a fetch is in flight

- **WHEN** a screen opens while a fetch for the same pod is already in flight
- **THEN** no second fetch is started
- **AND** that screen is served by the in-flight fetch when it lands

#### Scenario: A screen opens shortly after another screen fetched

- **WHEN** a screen opens and the shared data for its pod was fetched within the freshness window
- **THEN** the screen is served from the held data
- **AND** no platform request is made

#### Scenario: Switching pods

- **WHEN** the active pod changes
- **THEN** data held for the previous pod is not shown for the new one
- **AND** the new pod's data is served under the same freshness rules — from held data when it is within the freshness window, fetched otherwise

### Requirement: A screen opens on held data and revalidates behind it

When data for a screen is already held, the system SHALL show it immediately rather than making the reviewer wait for a fresh fetch. Held data that is outside the freshness window SHALL be revalidated in the background once shown; held data inside the window SHALL NOT be. When no data is held, the system SHALL show the screen's loading state rather than a blank screen.

#### Scenario: Re-opening a screen whose data has gone stale

- **WHEN** the reviewer returns to a screen whose data is held but outside the freshness window
- **THEN** the screen shows that data immediately, without a loading state
- **AND** a revalidation is issued behind it

#### Scenario: Re-opening a screen whose data is still fresh

- **WHEN** the reviewer returns to a screen whose data is held and inside the freshness window
- **THEN** the screen shows that data immediately
- **AND** no revalidation is issued

#### Scenario: Revalidation finds newer data

- **WHEN** a background revalidation returns data that differs from what is shown
- **THEN** the screen updates to the newer data

#### Scenario: Nothing is held yet

- **WHEN** the reviewer opens a screen for a pod whose data has never been fetched
- **THEN** the screen's loading state is shown while the fetch runs
- **AND** the screen is never blank

#### Scenario: Revalidation fails

- **WHEN** a background revalidation fails
- **THEN** the data already on screen remains shown
- **AND** the failure is reported without replacing the screen's content with an error

### Requirement: Data that has not changed notifies nobody

Before notifying any screen, the system SHALL compare newly fetched data with the data it already holds. Data that is equivalent to what is held SHALL cause no notification and no repaint anywhere.

#### Scenario: A background poll finds nothing new

- **WHEN** a scheduled background poll returns data equivalent to what is held
- **THEN** no screen repaints
- **AND** no scroll position, focus or expanded section is disturbed

#### Scenario: Progress within an unchanged status

- **WHEN** a review run reports progress without its status changing
- **THEN** screens that show only the run's status do not repaint

#### Scenario: A poll finds a real change

- **WHEN** a scheduled background poll returns data that differs from what is held
- **THEN** every screen showing the affected data updates

### Requirement: An action fetches only the data it could have changed

An interaction that changes only local state SHALL NOT cause any platform request. An interaction that changes state on the platform SHALL cause a refresh only of the data that interaction could have affected.

#### Scenario: Recording a verdict on a finding

- **WHEN** the reviewer accepts, rejects or skips a finding
- **THEN** no platform request is made
- **AND** every screen that shows the review's progress reflects the new verdict

#### Scenario: Changing a setting

- **WHEN** the reviewer changes a setting on the settings screen
- **THEN** no connection test and no platform request is made
- **AND** the connection status already shown remains shown

#### Scenario: Navigating between screens

- **WHEN** the reviewer moves from one screen to another within the freshness window
- **THEN** no request is made for the pod's shared data
- **AND** the only requests made are for data belonging to a single change request, which is not shared between pods and is not held

#### Scenario: Resolving a posted thread

- **WHEN** the reviewer resolves a thread on a posted review
- **THEN** that thread's state is refreshed
- **AND** the rest of the review history is not re-fetched

### Requirement: Triage decisions are durable even though their writes are batched

The system SHALL persist a reviewer's triage decisions so that reopening the target shows every decision they made, including after the editor restarts. Consecutive decisions MAY be coalesced into a single write, and that write SHALL be flushed before submitting, before the review screen is disposed, when the review screen stops being visible, and when the editor window loses focus.

#### Scenario: Decisions made in quick succession

- **WHEN** the reviewer records several verdicts in quick succession and then leaves the screen
- **THEN** reopening the target shows every one of those verdicts

#### Scenario: A restart after triage

- **WHEN** the editor is closed and re-opened after the reviewer recorded verdicts, edited the summary or wrote a note
- **THEN** reopening the target shows all of that work

#### Scenario: A batched write is never partial

- **WHEN** persisted triage state is read back
- **THEN** it is the state as of some complete action, never a mixture of one action's state and another's

#### Scenario: Submitting

- **WHEN** the reviewer submits a review
- **THEN** the persisted state reflects every decision made up to that point before the submit begins

### Requirement: Freshness applies to platform data, not to review results

The freshness window and revalidation behaviour SHALL apply only to data fetched from the platform. A retained review, a recorded verdict and an in-flight run marker SHALL remain durably persisted, SHALL NOT expire, and SHALL NOT be discarded or re-derived because platform data went stale.

#### Scenario: Opening a target long after its review ran

- **WHEN** the reviewer opens a target whose retained review is older than the freshness window
- **THEN** that review is shown in full, with its verdicts
- **AND** no new run is started

#### Scenario: A restart with a run in flight

- **WHEN** the editor stops while a run is in flight and starts again
- **THEN** that run is still reported as interrupted against its target

#### Scenario: Clearing held platform data

- **WHEN** held platform data is dropped or expires
- **THEN** no retained review, verdict, summary text or note is lost

### Requirement: Held state is provider-agnostic

The shared state SHALL hold only the neutral domain types the provider interface returns. Adding or changing a code-platform provider SHALL NOT require any change to what state is held, how its freshness is tracked, or how screens subscribe to it.

#### Scenario: A second provider is in use

- **WHEN** a pod belongs to a provider other than the one a screen was first built against
- **THEN** that screen reads the same shared state in the same way
- **AND** no provider-specific field appears in the held state

#### Scenario: Adding a provider

- **WHEN** a new provider is registered
- **THEN** no change to the state layer is required for existing screens to serve its pods
