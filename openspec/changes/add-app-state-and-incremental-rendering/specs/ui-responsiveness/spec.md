## Purpose

Defines how a change in state reaches the screen: which part of the screen is redrawn, what survives the redraw, and what moving between screens costs. A reviewer working through findings should never lose their scroll position, their place in a text box, or a section they opened, and should never see a screen blank and rebuild itself because something elsewhere changed.

## ADDED Requirements

### Requirement: A state change redraws only the part of the screen it affects

When a screen is already showing, a change in state SHALL update the regions that depend on that state and SHALL NOT rebuild the whole screen. Rebuilding the whole screen is permitted only for the screen's first paint and for recovering after the editor discards the screen's contents.

#### Scenario: Recording a verdict

- **WHEN** the reviewer accepts, rejects or skips a finding
- **THEN** the finding list, the current finding and the progress indicators update
- **AND** the rest of the screen is not rebuilt

#### Scenario: Changing a setting

- **WHEN** the reviewer toggles a setting
- **THEN** only the affected control and anything that depends on it updates
- **AND** every other control keeps its current state

#### Scenario: First paint

- **WHEN** a screen is shown for the first time, or after the editor discards its contents and it must be restored
- **THEN** the screen is built in full

#### Scenario: Every screen behaves this way

- **WHEN** state changes on the dashboard, the review screen, the changeset screen, the changeset review screen, the posted-reviews screen, the settings screen, the tuning screen, the onboarding screen or the sidebar
- **THEN** that screen updates in place rather than being rebuilt

### Requirement: What the reviewer was doing survives a redraw

A redraw SHALL preserve scroll position, keyboard focus, text-selection and caret position in a focused field, and which sections are expanded or collapsed. Text the reviewer has typed and not yet committed SHALL NOT be lost or reset by a redraw.

#### Scenario: Scrolled partway through a long diff

- **WHEN** state changes while the reviewer is scrolled partway down a finding's diff
- **THEN** the diff stays at the same scroll position after the update

#### Scenario: Typing when an update arrives

- **WHEN** an update arrives while the reviewer is typing in the summary, a note or a reply
- **THEN** the text they have typed is still there, the field still has focus, and the caret is where they left it

#### Scenario: Expanded sections

- **WHEN** the reviewer has expanded a section and an unrelated part of the screen updates
- **THEN** that section is still expanded

### Requirement: Moving between screens does not rebuild the document

Navigating from one screen to another SHALL replace the screen's content within the existing document rather than loading a new one. Static presentation and behaviour shared across screens SHALL be loaded once and reused for every screen that follows.

#### Scenario: Navigating to another screen

- **WHEN** the reviewer moves from the dashboard to a review, or from a review to the changeset screen, settings, or any other screen
- **THEN** the new screen appears without the document reloading
- **AND** shared styling and behaviour are not loaded again

#### Scenario: Returning to a screen

- **WHEN** the reviewer goes back to a screen they were on
- **THEN** it is restored with the scroll position and expanded sections it had when they left

#### Scenario: Navigating repeatedly

- **WHEN** the reviewer moves back and forth between two screens several times
- **THEN** each transition costs no more than the first
- **AND** nothing accumulates that makes later transitions slower

### Requirement: An update to one screen does not disturb another

An update caused by one screen or by background activity SHALL NOT redraw a different screen unless the state that screen shows actually changed. A screen the reviewer is not looking at SHALL NOT cause work that delays the screen they are looking at.

#### Scenario: Triaging with the sidebar open

- **WHEN** the reviewer records a verdict while the sidebar is showing
- **THEN** the sidebar's active-review section updates from state it already has
- **AND** the sidebar's change-request, work-item and CI sections are neither re-fetched nor redrawn

#### Scenario: Background activity while reading

- **WHEN** background activity reports data that does not change what the current screen shows
- **THEN** the current screen does not redraw

#### Scenario: A hidden screen's data changes

- **WHEN** data changes that only a screen the reviewer is not viewing depends on
- **THEN** the visible screen is unaffected
- **AND** the hidden screen shows the change when the reviewer returns to it

### Requirement: An interaction that needs no network completes without waiting

An interaction that changes only local state SHALL update the screen without waiting on the platform, on the language model, or on re-deriving content that did not change.

#### Scenario: Moving between findings

- **WHEN** the reviewer moves to the next or previous finding
- **THEN** the screen updates immediately, with no network wait

#### Scenario: Filtering or changing severity floor

- **WHEN** the reviewer changes a filter or severity threshold
- **THEN** the list updates immediately from state already held

#### Scenario: An unchanged diff is not re-derived

- **WHEN** a redraw is caused by state unrelated to the current finding's diff or body
- **THEN** that diff and body are not parsed or rendered again

### Requirement: A screen is never blank while it waits

A screen that must wait on data before it can show its content SHALL show a loading state that names what it is waiting for, and SHALL replace it with content when the data arrives. A slower request that finishes after a newer one SHALL NOT overwrite the newer result.

#### Scenario: Opening a screen with nothing held

- **WHEN** the reviewer opens a screen whose data must be fetched
- **THEN** a loading state is shown immediately
- **AND** it is replaced by the content when the fetch lands

#### Scenario: A stale result arrives late

- **WHEN** a fetch finishes after a later fetch for the same screen has already been shown
- **THEN** the later result stays on screen
- **AND** the earlier result is discarded
