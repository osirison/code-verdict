## ADDED Requirements

### Requirement: The demo agent is offered only where it is asked for or needed

The demo agent SHALL NOT be listed in the agent picker by default. It SHALL be listed when `codeVerdict.showDemoAgent` is enabled, when the selection the screen is about to reconcile already names it, or when the pod under review is the sample-data pod. A value for that setting that is not a boolean SHALL be read as disabled. A change to the setting SHALL re-scan the pickers on an open screen without a reload. The built-in default agent SHALL be listed regardless of this setting.

#### Scenario: Ordinary pod with the setting off

- **WHEN** a reviewer opens the Run AI Review screen on a pod connected to a real forge, with `codeVerdict.showDemoAgent` unset or `false`, and no stored selection naming the demo agent
- **THEN** the agent picker does not list the demo agent
- **AND** the built-in default agent is still listed, along with every discovered agent

#### Scenario: The setting is enabled

- **WHEN** `codeVerdict.showDemoAgent` is `true`
- **THEN** the demo agent is listed in the agent picker on every pod
- **AND** it is distinguishable from the built-in default agent and from workspace-declared agents

#### Scenario: The pod already has the demo agent selected

- **WHEN** a pod holds the demo agent as its selected agent and the setting is off
- **THEN** the demo agent is listed and stays selected
- **AND** no notice says the selected agent was not found, because it was not removed from the reviewer's pod — only from the default listing

#### Scenario: The sample-data pod

- **WHEN** a reviewer opens the Run AI Review screen on the sample-data pod with the setting off
- **THEN** the demo agent is listed
- **AND** it is listed because it is the only agent that reviews sample data without a chat model, so hiding it would leave that pod with no review it can run

#### Scenario: The setting holds a value that is not a boolean

- **WHEN** `codeVerdict.showDemoAgent` holds a number, a string or an object
- **THEN** it is read as disabled, the value the setting ships with
- **AND** the two exceptions above still list the demo agent on their own

#### Scenario: The setting is changed while a review screen is open

- **WHEN** a reviewer changes `codeVerdict.showDemoAgent` with the Run AI Review screen open
- **THEN** the agent picker re-scans and the demo agent appears or disappears without a window reload
- **AND** the reviewer's other selections are unaffected

## MODIFIED Requirements

### Requirement: Models are selected separately from agents

The Run AI Review screen SHALL present two independent selections: an agent and a model. The model list SHALL be the chat models the editor's Copilot integration reports as available. Changing one selection SHALL NOT reset the other, except where an agent declares a preferred model. When no model is available, the screen SHALL describe the way forward from the agents it is actually offering, and SHALL NOT name one it is not.

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
- **AND** starting a review with a model-backed agent is prevented, with that reason given and the agent named
- **AND** the only alternative it names is one the agent picker beside it is actually listing

#### Scenario: No models available and the demo agent is not offered

- **WHEN** the editor reports no chat models on a pod whose agent picker does not list the demo agent — the ordinary case, with `codeVerdict.showDemoAgent` off
- **THEN** the model selection states that every agent offered on this screen needs a model, and that signing in to Copilot is how to get one
- **AND** no review can be started from that screen, because every agent it offers is model-backed
- **AND** the demo agent is not named as a way out, because the picker beside it does not list it

#### Scenario: No models available and the demo agent is offered

- **WHEN** the editor reports no chat models on a pod whose agent picker does list the demo agent — the setting is on, the pod already has it selected, or it is the sample-data pod
- **THEN** the model selection names selecting the demo agent as the alternative to signing in to Copilot
- **AND** starting a review with a model-backed agent is still prevented, with that reason given
- **AND** selecting the demo agent allows the review to start, because it calls no model

#### Scenario: Model disappears between selection and run

- **WHEN** the selected model is no longer available at the moment the review starts
- **THEN** the run fails with a message naming the unavailable model
- **AND** the reviewer is returned to the Run AI Review screen with the selection intact
