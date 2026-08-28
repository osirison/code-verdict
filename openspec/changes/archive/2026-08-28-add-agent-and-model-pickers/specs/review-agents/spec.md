## Purpose

Defines what a review agent is in Code Verdict, where agent definitions are found, and how a reviewer chooses an agent and a Copilot model independently before starting a review. An agent carries the reviewing instructions; a model executes them. Separating the two lets a team commit its review personas alongside its code while each reviewer still picks the model that runs them.

## ADDED Requirements

### Requirement: An agent is a prompt definition

A review agent SHALL be a named definition consisting of a display name, a description, an optional preferred model, and a body of reviewing instructions in natural language. An agent SHALL NOT carry executable code, tool permissions, or transport configuration.

#### Scenario: Agent supplies instructions only

- **WHEN** a review runs with an agent selected
- **THEN** the agent's instruction body is sent to the model as part of the review prompt
- **AND** nothing in the agent definition changes which platform is queried, which diffs are read, or how the response is transported

#### Scenario: Agent declares a preferred model

- **WHEN** an agent definition names a preferred model and that model is available
- **THEN** selecting that agent moves the model selection to the named model
- **AND** the reviewer can still change the model afterwards, and that later choice wins

#### Scenario: Preferred model is unavailable

- **WHEN** an agent names a preferred model that is not among the available models
- **THEN** the current model selection is left unchanged
- **AND** the screen states that the agent's preferred model is unavailable, naming it

### Requirement: An agent never controls the response contract

The system SHALL own the response contract, the active criteria, and the diff payload for every review run. Instructions supplied by an agent SHALL NOT be able to change the schema the response is parsed against, remove the criteria, or alter which diffs are sent.

#### Scenario: Agent body attempts to redefine the schema

- **WHEN** an agent's instruction body asks for a different output shape, a different set of fields, or prose instead of JSON
- **THEN** the system still appends its own response contract, criteria and diffs after the agent's instructions
- **AND** the response is still parsed against the system's contract
- **AND** a response that does not satisfy that contract fails the run in the same way it does for any other agent

#### Scenario: Ordering within the prompt

- **WHEN** a review prompt is composed
- **THEN** the agent's instructions appear before the response contract, the criteria and the diffs
- **AND** the contract, criteria and diffs are byte-identical to what the same run would send with the built-in default agent

### Requirement: Agents are discovered from the workspace

The system SHALL discover agent definitions from files matching the agent file pattern in the opened workspace, searching `.github/agents/` by default. Discovery SHALL be non-recursive within each searched directory and SHALL run without the reviewer configuring anything.

#### Scenario: Workspace contains agent files

- **WHEN** the opened workspace has agent definition files under `.github/agents/`
- **THEN** each one appears in the agent picker, labelled with its declared name and description
- **AND** each is marked as coming from the workspace

#### Scenario: Workspace has no agent files

- **WHEN** no agent definition files are found in any searched location
- **THEN** the agent picker still offers the built-in default agent
- **AND** the screen is usable with no warning or error

#### Scenario: Multi-root workspace

- **WHEN** the window has more than one workspace folder
- **THEN** every folder's default agent directory is searched
- **AND** an agent's origin folder is shown alongside it when two folders declare agents of the same name

#### Scenario: Agent set changes while the screen is open

- **WHEN** an agent definition file is added, edited or deleted while the Run AI Review screen is open
- **THEN** the agent picker reflects the change without the reviewer reopening the screen
- **AND** if the selected agent was deleted, the selection falls back to the built-in default agent and the screen says so

### Requirement: Additional agent locations are configurable

The system SHALL let a reviewer configure additional directories to be searched for agent definitions. A configured location SHALL be either workspace-relative or absolute. Configured locations SHALL be searched in addition to the default workspace directory, never instead of it.

#### Scenario: Adding a location

- **WHEN** a reviewer adds a directory to the configured agent locations in Settings
- **THEN** agent definitions in that directory appear in the agent picker
- **AND** they are marked as coming from that configured location rather than from the workspace

#### Scenario: Removing a location

- **WHEN** a reviewer removes a configured location
- **THEN** agents from that location no longer appear in the picker
- **AND** if the selected agent came from it, the selection falls back to the built-in default agent

#### Scenario: Location does not exist or cannot be read

- **WHEN** a configured location is missing, is a file rather than a directory, or cannot be read
- **THEN** discovery of the remaining locations still succeeds
- **AND** Settings shows that location as unreadable, naming it
- **AND** no review run is blocked by it

#### Scenario: Same agent name in two locations

- **WHEN** two searched locations declare agents with the same name
- **THEN** both appear in the picker as distinct entries
- **AND** each is distinguishable by the location it came from

### Requirement: Malformed agent definitions are reported, not fatal

The system SHALL skip an agent definition it cannot parse and SHALL continue to offer every definition it could parse. A malformed definition SHALL NOT prevent the Run AI Review screen from opening or a review from running.

#### Scenario: One file is malformed

- **WHEN** one agent definition has unreadable frontmatter, is missing a required field, or has an empty instruction body
- **THEN** it does not appear in the agent picker
- **AND** every other discovered agent does appear
- **AND** the screen reports how many definitions were skipped and offers to show which files and why

#### Scenario: Every file is malformed

- **WHEN** no discovered agent definition parses
- **THEN** the picker offers the built-in default agent
- **AND** the skipped definitions are reported the same way

### Requirement: A built-in default agent is always offered

The system SHALL provide a built-in default agent that is always present in the agent picker and cannot be removed. Its instructions SHALL be the general-purpose review instructions the system used before agents were selectable, so that a workspace with no agent definitions produces the same review it produced before.

#### Scenario: Unconfigured workspace

- **WHEN** a reviewer who has never selected an agent opens the Run AI Review screen
- **THEN** the built-in default agent is selected
- **AND** running the review sends the same instructions the system sent before this capability existed

#### Scenario: Default agent is listed among discovered agents

- **WHEN** the workspace also declares its own agents
- **THEN** the built-in default agent is still listed
- **AND** it is distinguishable from workspace-declared agents

### Requirement: Models are selected separately from agents

The Run AI Review screen SHALL present two independent selections: an agent and a model. The model list SHALL be the chat models the editor's Copilot integration reports as available. Changing one selection SHALL NOT reset the other, except where an agent declares a preferred model.

#### Scenario: Both pickers are shown

- **WHEN** a reviewer opens the Run AI Review screen
- **THEN** an agent selection and a model selection are both visible before the run starts
- **AND** each shows its current value and where that value came from

#### Scenario: Changing the model keeps the agent

- **WHEN** a reviewer changes the model
- **THEN** the agent selection is unchanged

#### Scenario: No models available

- **WHEN** the editor reports no chat models — Copilot is absent, signed out, or unavailable
- **THEN** the model selection states that no model is available and how to make one available
- **AND** starting a review with a model-backed agent is prevented, with that reason given
- **AND** the demo agent can still be run

#### Scenario: Model disappears between selection and run

- **WHEN** the selected model is no longer available at the moment the review starts
- **THEN** the run fails with a message naming the unavailable model
- **AND** the reviewer is returned to the Run AI Review screen with the selection intact

### Requirement: The demo agent is independent of the model selection

The demo agent SHALL generate its findings without calling a model. Selecting it SHALL disable or visibly neutralise the model selection, and it SHALL remain runnable when no model is available.

#### Scenario: Demo agent selected

- **WHEN** a reviewer selects the demo agent
- **THEN** the model selection is shown as not applying to this run
- **AND** running the review produces findings without contacting any model

### Requirement: Selection is persisted per pod and migrated

The system SHALL persist the selected agent and the selected model per pod, and SHALL restore both when the pod is reopened. A pod saved before this capability existed holds a single model identifier; the system SHALL read it as the built-in default agent paired with that model.

#### Scenario: Selection survives a reopen

- **WHEN** a reviewer picks an agent and a model, runs a review, and later reopens the pod
- **THEN** both selections are restored

#### Scenario: Migrating a pod saved earlier

- **WHEN** a pod holds only a model identifier from before this capability
- **THEN** the agent is read as the built-in default agent
- **AND** the model is read as that identifier
- **AND** the reviewer sees the same model they had selected, with no prompt to reconfigure

#### Scenario: Persisted agent no longer exists

- **WHEN** the persisted agent is not among the currently discovered agents
- **THEN** the selection falls back to the built-in default agent
- **AND** the screen states that the previously selected agent was not found, naming it

#### Scenario: Persisted model no longer exists

- **WHEN** the persisted model is not among the currently available models
- **THEN** the selection falls back to the first available model
- **AND** the screen states that the previously selected model was not found, naming it

### Requirement: A completed review records both selections

A stored review SHALL record which agent and which model produced it, so a reviewer reading a past review can tell what generated the findings.

#### Scenario: Reading a past review

- **WHEN** a reviewer opens a review that has already run
- **THEN** the agent name and the model name that produced it are both shown

### Requirement: Every model-backed surface uses the same pair

Changeset reviews and follow-up questions about an individual finding SHALL use the same agent and model selection as a single change-request review, and SHALL be presented with the same two pickers where a selection is offered.

#### Scenario: Changeset review

- **WHEN** a reviewer starts a changeset review
- **THEN** the same agent and model pickers are shown, with the pod's persisted selections
- **AND** the agent's instructions are composed into the changeset prompt ahead of the system's changeset contract, criteria and labelled diffs

#### Scenario: Follow-up question about a finding

- **WHEN** a reviewer asks a follow-up question about a finding
- **THEN** the question is sent to the model that is currently selected
- **AND** the agent's instructions are included, so the answer keeps the reviewing persona that produced the finding
