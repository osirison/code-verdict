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

The system SHALL provide an "Add Context…" control that opens a searchable picker of attachable kinds. The control SHALL be reachable by keyboard. The picker SHALL offer at least: a file, a folder, the current editor selection, a symbol, the current problems/diagnostics, and pasted text. If an attachment is dropped or unreadable at run time, the system SHALL persist the warning with the run and disclose it before triage, including when the run completes in the background.

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
- **AND** a warning naming the dropped attachment and reason is persisted with the run
- **AND** the warning is shown before the reviewer enters triage

#### Scenario: Unreadable attachment on background completion

- **WHEN** a background review completes after dropping an unreadable attachment
- **THEN** its completion state retains the warning naming the attachment and reason
- **AND** opening the completed review shows the warning before triage

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

- **WHEN** a change request description, a work item, or an attachment contains a case, whitespace, or attribute variant of an opening or closing `<attachment>` or `<attachments>` wrapper-like tag
- **THEN** only the leading `<` of the imitation is encoded before the prompt is assembled, retaining the rest of the source text
- **AND** the agent cannot be led to treat intent as evidence, or to report a finding against a file the run never sent

#### Scenario: Wrapper-tag variants are neutralised

- **WHEN** non-host content contains variants such as `<ATTACHMENTS>`, `</ Attachments >`, `<attachment data-kind="source">`, or `</ATTACHMENT   >`
- **THEN** every wrapper-like variant is neutralised regardless of case, whitespace, attributes, or singular/plural form
- **AND** host-generated wrapper tags remain structural and their generated attribute values remain escaped

#### Scenario: Markdown and YAML separators remain evidence

- **WHEN** an attachment contains an ordinary Markdown horizontal rule or YAML `---` delimiter
- **THEN** that delimiter is sent unchanged
- **AND** only wrapper-like attachment tags in the attachment content are neutralised

### Requirement: Attachment evidence has host-verified provenance

For each run, the system SHALL generate an evidence manifest from the exact post-budget attachment content visible to the model. The manifest SHALL enumerate workspace-root-qualified actual file paths and inclusive positive-integer line ranges represented by file, selection, folder-child, symbol, and problems attachments. Each included folder child SHALL have its own entry. Wrapper labels and other pseudo-paths SHALL NOT count as evidence provenance. A finding against attachment evidence SHALL be accepted only when its host-normalised file identity appears in the manifest and its reported line is a positive integer within a model-visible range. Attachment content SHALL NOT be able to create or modify manifest entries.

#### Scenario: Manifest follows model-visible content

- **WHEN** a run sends a file, a selection, a folder with two included children, a symbol, and problems from a source file
- **THEN** the host-generated manifest enumerates the actual model-visible file path and range for the file, selection, each folder child, symbol source, and problems source
- **AND** content removed by attachment budgeting is absent from the valid ranges

#### Scenario: Wrapper pseudo-path is insufficient

- **WHEN** a finding cites an attachment wrapper label or pseudo-path that is not an actual file entry in the manifest
- **THEN** the finding is rejected before triage

#### Scenario: Finding line is outside visible evidence

- **WHEN** a finding reports a non-integer, zero, negative, or out-of-range line for an attached file
- **THEN** the finding is rejected before triage

#### Scenario: Attachment content imitates provenance

- **WHEN** attachment content contains text that resembles a manifest entry or host-generated attribute
- **THEN** the host-generated manifest is unchanged
- **AND** the imitated path and range do not become valid evidence

### Requirement: Path identity is workspace-root qualified

Every attachment file identity SHALL include its workspace-root qualification consistently in the context area, prompt, evidence manifest, deduplication, finding validation, and triage. The system SHALL use a host-generated unique root label when display names alone would collide.

#### Scenario: Same relative path in two workspace roots

- **WHEN** a multi-root workspace contains the same relative file path under two different roots and both files are attached
- **THEN** both context items and prompt paths carry distinct workspace-root-qualified identities
- **AND** findings, deduplication, manifest validation, and triage preserve the correct root identity

#### Scenario: Colliding workspace-root display names

- **WHEN** two workspace roots have the same display name
- **THEN** the host assigns distinct stable root labels for the run
- **AND** no file identity becomes ambiguous

### Requirement: A finding with no diff anchor is posted in the summary

An accepted finding that cites a file the diff does not touch SHALL NOT be posted as an inline comment. It SHALL be included in the review summary instead, identifying its workspace-root-qualified file and line. Anchor classification SHALL depend on changed-file membership, not on whether the reported line is currently an added line. A finding on a changed file SHALL continue through the existing anchor matcher for line drift. The reviewer SHALL be told before submitting which accepted attachment-only findings will be routed to the summary.

#### Scenario: Accepting an out-of-diff finding

- **WHEN** a reviewer accepts a finding against an attached file that the change request does not modify
- **THEN** no inline comment is attempted for it
- **AND** its content appears in the summary body, naming the file and line
- **AND** the submit screen states how many accepted findings will go to the summary rather than inline

#### Scenario: An attached file that the diff also touches

- **WHEN** a manifest-valid finding cites an attached file that the diff also touches but its reported line is not currently an added line
- **THEN** the finding remains eligible for an inline comment because its file is changed
- **AND** the reported line goes through the existing anchor matcher for exact, moved, or lost resolution

#### Scenario: A changed-file finding has no current added-line match

- **WHEN** an accepted finding cites a changed file but its code does not match any current added line
- **THEN** no invalid inline comment is sent to the provider
- **AND** the finding remains classified as anchored by changed-file membership
- **AND** the review summary names the finding and states that it was withheld from inline submission

#### Scenario: A changed-file finding moved to another added line

- **WHEN** an accepted finding's code moved from its reported line to another current added line in the same changed file
- **THEN** the inline comment uses the resolved current line
- **AND** the finding remains classified as anchored by changed-file membership

#### Scenario: Attachment-only finding routes to summary

- **WHEN** a manifest-valid finding cites an attached file that is not a changed file
- **THEN** it is classified as unanchored regardless of its reported line
- **AND** accepting it routes it to the summary only

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

A changeset review SHALL support the same context area, attachment behavior, latest Extra instructions, `#` reference resolution and unresolved-reference reporting, and Add Context keyboard command routing as a single change-request review. An attachment SHALL be identified to the agent with the same member and workspace-root-qualified path identities the changeset diffs carry, so a finding against it names the member it belongs to.

#### Scenario: Attaching in a changeset review

- **WHEN** a reviewer attaches a file during a changeset review
- **THEN** it is sent with the member labels the changeset prompt uses
- **AND** a finding against it identifies which member repository it belongs to

#### Scenario: Latest changeset instructions are used on Run

- **WHEN** a reviewer edits Extra instructions and immediately activates Run on a changeset review
- **THEN** the run uses the latest instructions text rather than a previously rendered value
- **AND** any supported `#` references in that text are resolved for that run

#### Scenario: Unresolved changeset reference is reported

- **WHEN** the latest changeset instructions contain a `#` reference that cannot be resolved
- **THEN** no attachment is created for it and the typed text remains unchanged
- **AND** the changeset screen reports that the reference did not resolve

#### Scenario: Changeset Add Context keyboard routing

- **WHEN** the changeset review panel is active and the reviewer invokes the Add Context keyboard command
- **THEN** the command opens the attachment picker for that changeset review
- **AND** it does not route to a stale or different review panel

### Requirement: Every runnable review agent inspects visible attachments

Every agent offered on a context-enabled review surface SHALL inspect the attachments represented in that surface under the same model-visible evidence and provenance contract. A deterministic agent SHALL process attachment content deterministically rather than ignore it or imply unsupported context.

#### Scenario: Demo agent receives attachment evidence

- **WHEN** a reviewer runs the demo agent with an attachment visible in the context area
- **THEN** the demo agent deterministically inspects the attachment content that the run represents as sent
- **AND** any finding it produces against that content uses the same manifest validation and inline-or-summary routing as other agents

### Requirement: Generated context webview scripts compile

The system SHALL generate syntactically valid webview scripts for every supported context state on both single change-request and changeset review surfaces.

#### Scenario: Representative generated scripts compile

- **WHEN** webview HTML is generated with auto-context items, attachments, resolved and unresolved references, warnings, and multi-root-qualified paths
- **THEN** each generated script compiles without a JavaScript syntax error
- **AND** the result holds for both single change-request and changeset review HTML
