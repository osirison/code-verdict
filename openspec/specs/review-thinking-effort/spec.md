# review-thinking-effort Specification

## Purpose
Lets a reviewer spend more or less model reasoning on a review, using the same vocabulary and control shape as the Copilot panel's Thinking Effort setting. Because a published extension cannot set reasoning effort as a provider parameter on a Copilot-backed model, this capability also fixes what the control is allowed to claim it does.

## Requirements

### Requirement: A reviewer can choose a thinking effort

The system SHALL offer a thinking-effort choice before a review runs, with seven levels — none, minimal, low, medium, high, extra high, max — presented in that order as a single-choice group with exactly one active at a time. Each level SHALL carry a one-line description of what choosing it means. The level that applies when the reviewer has chosen nothing SHALL be identifiable as the default.

#### Scenario: Choosing a level

- **WHEN** a reviewer opens the effort control and selects a level
- **THEN** that level becomes the active one and the control shows it
- **AND** the previously active level is no longer active

#### Scenario: Default is marked

- **WHEN** a reviewer opens the effort control without having chosen before
- **THEN** the level that will be used is shown as active and annotated as the default

#### Scenario: Level descriptions

- **WHEN** a reviewer inspects a level
- **THEN** a one-line description of that level is available without selecting it

### Requirement: The control states what it actually does

The effort choice SHALL be applied by instructing the model in the prompt, not by setting a provider parameter, and the interface SHALL NOT imply otherwise. The system SHALL NOT claim to set a model's native reasoning setting, and SHALL NOT claim to display the model's thinking.

#### Scenario: Honest labelling

- **WHEN** a reviewer views the effort control
- **THEN** text is present stating that the level is applied as review instructions
- **AND** it does not describe itself as changing the model's own reasoning configuration

#### Scenario: Effort reaches the prompt

- **WHEN** a review runs at a level other than the default
- **THEN** the prompt carries an instruction corresponding to that level
- **AND** the response contract, the criteria and the diffs are unchanged by the choice

#### Scenario: The lowest level adds nothing

- **WHEN** a review runs at the level meaning no additional reasoning
- **THEN** no effort instruction is added to the prompt at all

#### Scenario: No thinking is fabricated

- **WHEN** a review runs at any level
- **THEN** the system does not present any part of the response as the model's reasoning trace unless the model actually emitted it as such

### Requirement: The effort choice is persisted per model

The chosen level SHALL be remembered per model, so that returning to a model restores the level last used with it, and switching models does not overwrite another model's choice.

#### Scenario: Returning to a model

- **WHEN** a reviewer sets a level for one model, switches to another, and switches back
- **THEN** the first model's level is restored

#### Scenario: Switching models does not leak the level

- **WHEN** a reviewer sets a high level on one model and switches to a model that has never been used
- **THEN** the second model starts at the default level, not the first model's level

#### Scenario: Stored level is no longer valid

- **WHEN** a stored level is not one of the seven recognised values
- **THEN** it is discarded and the default is used
- **AND** the reviewer is not shown an error for it

### Requirement: The control is hidden where it does not apply

Where the effort choice cannot affect a run, the control SHALL be hidden rather than shown in a disabled or misleading state.

#### Scenario: An agent that does not use a model

- **WHEN** the selected agent produces findings without calling a model
- **THEN** the effort control is not shown

#### Scenario: No model available

- **WHEN** no model is available to run a review
- **THEN** the effort control is not shown

#### Scenario: Hidden does not mean forgotten

- **WHEN** the control is hidden and the reviewer then selects a model-backed agent again
- **THEN** the level previously stored for the selected model is restored and shown

### Requirement: Changing the level mid-review is disclosed

Where changing the level after findings already exist would make a later run inconsistent with an earlier one, the system SHALL disclose that before the change takes effect.

#### Scenario: Changing level before a re-run

- **WHEN** a reviewer changes the effort level while holding findings from an earlier run at a different level
- **THEN** the screen states that the next run will not be comparable with the findings already in hand

#### Scenario: A stored review records its level

- **WHEN** a reviewer opens a review that has already run
- **THEN** the effort level that produced it is shown

### Requirement: Effort applies to every model-backed surface

A changeset review and a follow-up question about a finding SHALL use the same effort level as a single change-request review at the same model.

#### Scenario: Changeset review

- **WHEN** a changeset review runs
- **THEN** it carries the effort instruction for the level stored against the selected model

#### Scenario: Follow-up question

- **WHEN** a reviewer asks a follow-up question about a finding
- **THEN** the same effort level applies to the answer
