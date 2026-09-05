## Purpose

Defines what the product binds to the keyboard and what has to be true before a binding does anything: a modifier the editor does not otherwise use, the screen the action belongs to, and the reviewer not being in the middle of typing. A keystroke meant for a text box must never record, clear or move a verdict, and a reviewer working down a list of findings must not have to hold four keys to accept one.

## ADDED Requirements

### Requirement: A published shortcut carries a modifier the editor does not otherwise use

Every keyboard shortcut the extension publishes to the editor SHALL require a modifier combination that the editor does not bind by default on any supported platform. No published shortcut SHALL be a bare key, and no published shortcut SHALL be a key plus Shift alone, because both are keys a reviewer types.

The modifier combination SHALL be identical for every triage action, so the map can be learned once. Where a chosen chord does collide with an editor default, the collision SHALL be disclosed in the change record together with the conditions under which it applies.

The reviewer SHALL be able to rebind any of these shortcuts through the editor's own keyboard-shortcut settings; the extension SHALL NOT introduce a separate setting for this.

#### Scenario: The published triage map

- **WHEN** the extension's keyboard shortcuts are listed
- **THEN** accept, accept comment-only, reject, skip, next, previous, undo, the four severity jumps and keyboard help each require the same modifier combination
- **AND** that combination is one the editor leaves unbound on Windows, on Linux and on macOS
- **AND** the macOS form uses the platform's own primary modifier rather than repeating the Windows form

#### Scenario: Nothing is published on a typing key

- **WHEN** the extension's keyboard shortcuts are listed
- **THEN** no entry is a single letter, a single digit or a punctuation key
- **AND** no entry is a letter, digit or punctuation key with only Shift added

#### Scenario: The reviewer prefers different keys

- **WHEN** the reviewer rebinds a Verdict shortcut in the editor's keyboard-shortcut settings
- **THEN** their binding is what applies
- **AND** the extension offers no competing setting of its own for the same purpose

### Requirement: A shortcut is live only on the screen whose action it names

A triage shortcut SHALL do nothing unless the triage screen is showing. Keyboard help SHALL be available from any Verdict review screen, because a reviewer who is lost needs it most where the keys do least.

#### Scenario: Configuring a run

- **WHEN** the reviewer is on the run-configuration screen and presses a triage shortcut
- **THEN** nothing is recorded, nothing moves, and no screen changes

#### Scenario: A review is running

- **WHEN** a review is running and the reviewer presses a triage shortcut
- **THEN** nothing is recorded and nothing moves

#### Scenario: Writing the summary

- **WHEN** the reviewer is on the summary screen and presses a triage shortcut
- **THEN** no verdict is recorded, no verdict is cleared, and the selected finding does not change

#### Scenario: After the review is posted

- **WHEN** the review has been posted and the reviewer presses a triage shortcut
- **THEN** nothing is recorded and nothing moves

#### Scenario: Another Verdict screen

- **WHEN** the dashboard, the changeset screen, posted reviews, settings, tuning or onboarding is showing and the reviewer presses a triage shortcut
- **THEN** nothing is recorded, and the keystroke is left for the screen that is showing

#### Scenario: Help from anywhere in a review

- **WHEN** the reviewer presses the keyboard-help shortcut on any screen of a review
- **THEN** the keyboard overlay opens

### Requirement: Typing never reaches a triage action

While the reviewer's cursor is in a text field, a keystroke SHALL be delivered to that field and SHALL NOT reach any triage action. This applies to every editable on a review screen, including the extra-instructions field, the ask-the-agent field, the summary and the final note.

A shortcut that carries the published modifier SHALL still work from inside a text field, so a reviewer who is composing a note can still triage without moving their hands to the mouse.

#### Scenario: Composing the final note

- **WHEN** the reviewer types letters into the final note on the summary screen
- **THEN** the letters appear in the note
- **AND** no verdict is recorded, cleared or changed

#### Scenario: Writing extra instructions

- **WHEN** the reviewer types letters into the extra-instructions field before starting a review
- **THEN** the letters appear in the field
- **AND** no triage action runs

#### Scenario: Asking the agent about a finding

- **WHEN** the reviewer types letters into the ask field on the triage screen
- **THEN** the letters appear in the field
- **AND** the selected finding does not change and no verdict is recorded

#### Scenario: Triaging without leaving the field

- **WHEN** the reviewer's cursor is in a text field and they press a published triage shortcut
- **THEN** the triage action runs
- **AND** no character is inserted into the field

### Requirement: Plain keys remain available where they are unambiguously safe

Within a Verdict screen the product MAY continue to accept plain unmodified keys, because a reviewer working through a long list should not have to hold four keys per finding. Where it does, two conditions SHALL hold: the cursor is not in a text field, a selection control or an editable region, and — for a triage key — the triage screen is showing.

A plain key SHALL NOT be published to the editor as a shortcut. It SHALL NOT be honoured when it arrives with Control, Command or Alt held, so that a published chord is never also handled here; Shift alone is exempt, because it is what distinguishes the comment-only accept from the plain accept.

#### Scenario: Working down the list

- **WHEN** the triage screen is showing, the cursor is not in a text field, and the reviewer presses the plain accept key
- **THEN** the finding is accepted

#### Scenario: The same key inside a text field

- **WHEN** the cursor is in a text field, a selection control or an editable region on the triage screen and the reviewer presses that same plain key
- **THEN** the character is typed and no verdict is recorded

#### Scenario: The same key on another screen

- **WHEN** any screen other than triage is showing and the reviewer presses that same plain key
- **THEN** no triage action runs

#### Scenario: One action per keypress

- **WHEN** the reviewer presses the plain next-finding key once on the triage screen
- **THEN** the selection moves by exactly one finding

#### Scenario: The comment-only accept

- **WHEN** the reviewer holds Shift and presses the plain accept key on the triage screen
- **THEN** the finding is accepted comment-only, without applying a suggested fix

#### Scenario: Help from a plain key

- **WHEN** a Verdict screen is showing, the cursor is not in a text field, and the reviewer presses `?`
- **THEN** the keyboard overlay opens

### Requirement: A triage action is refused off the triage screen however it arrives

A request to record a verdict, clear a verdict, move the selection or jump to a severity SHALL be refused unless the triage screen is showing, regardless of whether it came from a keystroke, the command palette, or any other caller. Screen scoping of the keyboard map SHALL NOT be the only thing standing between an out-of-place request and the reviewer's recorded decisions.

#### Scenario: From the command palette on the wrong screen

- **WHEN** a triage command is invoked from the command palette while the summary screen is showing
- **THEN** it is refused and no verdict changes

#### Scenario: A changeset review behaves the same way

- **WHEN** a triage command reaches a changeset review on any screen but triage
- **THEN** it is refused, exactly as it is for a single change request

#### Scenario: On the triage screen

- **WHEN** a triage command is invoked while the triage screen is showing
- **THEN** it is honoured

### Requirement: The product tells the reviewer the current keys and only the keys that exist

The keyboard overlay, the status bar's keyboard segment and any fallback message SHALL show the shortcuts that are actually bound, written in the notation of the platform the reviewer is on. None of them SHALL name a shortcut that does nothing.

#### Scenario: Opening the overlay

- **WHEN** the reviewer opens the keyboard overlay
- **THEN** every shortcut it lists is one that works
- **AND** each is written with the modifier notation of the reviewer's platform

#### Scenario: The status bar segment

- **WHEN** the status bar's keyboard segment is shown
- **THEN** its label does not name a key that no longer opens the overlay
- **AND** clicking it still opens the overlay

#### Scenario: No Verdict screen is open

- **WHEN** keyboard help is invoked with no Verdict screen open
- **THEN** the message shown lists the current shortcuts, not the previous ones
