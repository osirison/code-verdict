## Purpose

Governs everything that reaches the review agent besides the diffs: what is derived automatically from the change request, what the reviewer attaches by hand, how both are shown and budgeted, and — because an attached file is reviewable evidence rather than intent — where a finding against one is posted when the diff never touched it.

## ADDED Requirements

### Requirement: The context area shows everything that will be sent

The Run AI Review screen SHALL present a context area listing every item that will reach the agent, before the run starts. Nothing SHALL be sent that is not represented there. Each item SHALL be individually removable for this run.

#### Scenario: Auto-derived context is shown as items

- **WHEN** a reviewer opens the Run AI Review screen for a change request with a description and two linked work items
- **THEN** the change request title, its description and each linked work item appear as separate, individually removable items
- **AND** each is marked as automatically derived rather than added by the reviewer

#### Scenario: Removing an auto-derived item

- **WHEN** a reviewer removes the description
- **THEN** the description is not sent on this run
- **AND** the removal applies to this run only; reopening the screen restores it

#### Scenario: Nothing hidden

- **WHEN** any content is sent to the agent that is not a diff
- **THEN** an item representing it is present in the context area

### Requirement: A reviewer can attach context

The system SHALL provide an "Add Context…" control that opens a searchable picker of attachable kinds. The control SHALL be reachable by keyboard. The picker SHALL offer at least: a file, a folder, the current editor selection, a symbol, the current problems/diagnostics, and pasted text.

#### Scenario: Attaching a file

- **WHEN** a reviewer activates "Add Context…", searches for a file and selects it
- **THEN** an item for that file appears in the context area
- **AND** its content is sent on the next run

#### Scenario: Attaching a selection

- **WHEN** a reviewer attaches the current editor selection
- **THEN** the item names the file and the line range
- **AND** only the lines in that range are sent

#### Scenario: Removing an attachment

- **WHEN** a reviewer removes an attached item
- **THEN** it is no longer listed and its content is not sent

#### Scenario: The same file attached twice

- **WHEN** a reviewer attaches a file that is already attached
- **THEN** it is not duplicated

#### Scenario: Two different files with the same name

- **WHEN** two attached files in different directories share a basename
- **THEN** both are listed and each is distinguishable
- **AND** the agent is given a path for each that identifies it unambiguously

#### Scenario: Attachment no longer readable at run time

- **WHEN** an attached file has been deleted or become unreadable by the time the run starts
- **THEN** the run proceeds without it
- **AND** the reviewer is told which attachment was dropped and why, before triage

### Requirement: Attachments may be referenced from the instructions box

The system SHALL resolve `#` references typed in the Extra instructions box into the same attachments the picker produces, supporting at least a file reference, a file-with-line-range reference and a symbol reference. A reference that resolves SHALL appear in the context area like any other attachment.

#### Scenario: A file reference resolves

- **WHEN** a reviewer types a file reference in the instructions box
- **THEN** an attachment item for that file appears in the context area
- **AND** the run sends that file's content

#### Scenario: A reference does not resolve

- **WHEN** a reference names something that cannot be found
- **THEN** no attachment is created
- **AND** the text is left in the instructions as the reviewer typed it, and the screen says it did not resolve

### Requirement: Attached files are reviewable evidence

Content the reviewer attaches SHALL be presented to the agent as material a finding may cite, distinct from the automatically derived context, which remains intent and SHALL NOT be citable. The prompt SHALL state this distinction explicitly, and the boundary between the two SHALL be unambiguous.

#### Scenario: Prompt separates intent from evidence

- **WHEN** a run carries both auto-derived context and attachments
- **THEN** the auto-derived context is fenced as intent that may not be cited
- **AND** the attachments appear in a separate section marked as reviewable
- **AND** the diffs follow, and both the attachments and the diffs are citable

#### Scenario: A finding cites an attached file

- **WHEN** the agent reports a finding against a line in an attached file
- **THEN** the finding is accepted, shown in triage, and identifies the attached file and line
- **AND** it is distinguishable in triage from a finding against the diff

#### Scenario: A finding cites the auto-derived context

- **WHEN** the agent reports a finding whose location is the change request description or a linked work item
- **THEN** the finding is rejected before triage
- **AND** it is not shown to the reviewer as a reviewable item

#### Scenario: Author text cannot forge a section boundary

- **WHEN** a change request description, a work item, or an attached file contains text that imitates a diff label or a section fence
- **THEN** the imitation is neutralised before the prompt is assembled
- **AND** the agent cannot be led to treat intent as evidence, or to report a finding against a file the run never sent

### Requirement: A finding with no diff anchor is posted in the summary

An accepted finding that cites a file the diff does not touch SHALL NOT be posted as an inline comment. It SHALL be included in the review summary instead, identifying its file and line. The reviewer SHALL be told this before submitting.

#### Scenario: Accepting an out-of-diff finding

- **WHEN** a reviewer accepts a finding against an attached file that the change request does not modify
- **THEN** no inline comment is attempted for it
- **AND** its content appears in the summary body, naming the file and line
- **AND** the submit screen states how many accepted findings will go to the summary rather than inline

#### Scenario: An attached file that the diff also touches

- **WHEN** a finding cites a line that is both in an attached file and an added line of the diff
- **THEN** it is posted as a normal inline comment

#### Scenario: Applying a fix to an out-of-diff finding

- **WHEN** an out-of-diff finding carries a suggested fix
- **THEN** the option to apply it as a posted suggestion is not offered, because there is no diff line to attach it to
- **AND** the reviewer is told why

### Requirement: Attachments are budgeted and can never displace the diffs

The system SHALL apply a size budget to attached content that is separate from and additional to the budget on auto-derived context. Exceeding it SHALL truncate attachments, never the diffs. The reviewer SHALL be told what was truncated.

#### Scenario: One large attachment

- **WHEN** an attached file exceeds the per-attachment budget
- **THEN** the sent copy is truncated at a line boundary and marked as truncated to the agent
- **AND** the item in the context area shows that only part of it was sent

#### Scenario: Many attachments together exceed the total budget

- **WHEN** the attachments together exceed the total attachment budget
- **THEN** each is reduced so that every attachment still contributes something identifiable
- **AND** no diff content is removed to make room

#### Scenario: The diffs are never cut for context

- **WHEN** context and attachments together are large
- **THEN** every changed file in the diff is still sent in full

### Requirement: Context size is shown before the run

The system SHALL show an indication of how much of the selected model's input capacity the assembled prompt will use, updating as items are added and removed, and SHALL warn as the capacity is approached. The indicator SHALL be suppressible by setting.

#### Scenario: Usage indicator

- **WHEN** a reviewer adds an attachment
- **THEN** the indicator updates to reflect the larger prompt

#### Scenario: Approaching capacity

- **WHEN** the assembled prompt reaches a high proportion of the model's input capacity
- **THEN** the indicator renders in a warning state and says quality may decline

#### Scenario: Model capacity unknown or no model selected

- **WHEN** the model's input capacity cannot be determined, or the selected agent does not use a model
- **THEN** the indicator is hidden rather than showing a wrong or zero figure

#### Scenario: Indicator disabled

- **WHEN** the reviewer has disabled the indicator by setting
- **THEN** it is not shown, and the budgets still apply

### Requirement: Budgets and auto-context sources are configurable

The per-section, total and linked-item limits on auto-derived context SHALL be settings rather than fixed values, and each auto-derived source SHALL have a persistent default for whether it is included. A value that is missing or unusable SHALL fall back to the documented default rather than sending nothing.

#### Scenario: Raising a budget

- **WHEN** a reviewer raises the per-section budget and runs a review
- **THEN** more of the description reaches the agent, up to the new value

#### Scenario: Turning a source off by default

- **WHEN** a reviewer sets linked work items to be excluded by default
- **THEN** new runs start with those items absent from the context area
- **AND** they can still be added back for a single run

#### Scenario: Unusable setting value

- **WHEN** a budget setting is negative, non-numeric or absent
- **THEN** the documented default is used for that budget
- **AND** the run is not blocked

### Requirement: Attachments apply to changeset reviews

A changeset review SHALL support the same context area and attachments. An attachment SHALL be identified to the agent with the same member labels the changeset diffs carry, so a finding against it names the member it belongs to.

#### Scenario: Attaching in a changeset review

- **WHEN** a reviewer attaches a file during a changeset review
- **THEN** it is sent with the member labels the changeset prompt uses
- **AND** a finding against it identifies which member repository it belongs to
