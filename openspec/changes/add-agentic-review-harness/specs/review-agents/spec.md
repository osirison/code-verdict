## MODIFIED Requirements

### Requirement: An agent is a prompt definition

A review agent SHALL be a named definition consisting of a display name, a description, an optional preferred model, and a body of reviewing instructions in natural language. An agent SHALL NOT carry executable code, tool permissions, transport configuration, evidence authority, budget policy, lifecycle policy, or completion authority.

#### Scenario: Agent supplies instructions only

- **WHEN** a review runs with an agent selected
- **THEN** the agent's instruction body and persona are immutable inputs to the universal review harness
- **AND** nothing in the agent definition changes which platform is queried, which tools are available, which evidence is citable, or how completion is decided

#### Scenario: Agent frontmatter names tools

- **WHEN** an agent definition contains arbitrary frontmatter that attempts to enable, remove, or configure tools
- **THEN** those declarations grant no tool access and do not change the host contract
- **AND** the definition is handled according to agent-definition validation without delegating authorization

#### Scenario: Agent declares a preferred model

- **WHEN** an agent definition names a preferred model and that model is available
- **THEN** selecting that agent moves the model selection to the named model
- **AND** the reviewer can still change the model afterwards, and that later choice wins

#### Scenario: Preferred model is unavailable

- **WHEN** an agent names a preferred model that is not among the available models
- **THEN** the current model selection is left unchanged
- **AND** the screen states that the agent's preferred model is unavailable, naming it

### Requirement: An agent never controls the response contract

The system SHALL own every phase contract, the active criteria, tool contracts, evidence rules, budgets, coverage rules, retry policy, and completion decision for every review run. Agent instructions SHALL NOT redefine candidate or result schemas, remove criteria, alter revision scope, make content citable, suppress required phases, or request a one-shot bypass.

#### Scenario: Agent body attempts to redefine the schema

- **WHEN** an agent's instruction body asks for a different output shape, prose instead of protocol messages, direct final findings, or omission of required criteria
- **THEN** the host still enforces the current phase contract and criteria
- **AND** a response that does not satisfy that contract enters bounded protocol repair or fails under the same policy as any other agent

#### Scenario: Agent body asks to bypass investigation

- **WHEN** an agent asks to receive all diffs in one prompt, skip the plan or verification pass, or declare its own completion
- **THEN** the host still routes the run through the universal harness
- **AND** only host-authorized evidence and a host-approved completion request can produce a complete result

#### Scenario: Ordering within the prompt

- **WHEN** the harness composes input for a model phase
- **THEN** agent instructions remain distinguishable from and subordinate to host phase contracts, criteria, tool descriptions, and evidence identifiers
- **AND** retrieved evidence is supplied under the host protocol rather than a byte-identical one-shot diff payload

#### Scenario: Harness authority is stable across agents

- **WHEN** the same immutable target and reviewer settings run with two different agent personas
- **THEN** each persona may choose a different public plan and investigation strategy
- **AND** both receive the same host tool contract, evidence constraints, lifecycle protocol, and completion conditions

### Requirement: A built-in default agent is always offered

The system SHALL provide a built-in default agent that is always present in the agent picker and cannot be removed. Its instructions SHALL remain the general-purpose review instructions the system used before agents were selectable, while its execution SHALL use the universal agentic review harness.

#### Scenario: Unconfigured workspace

- **WHEN** a reviewer who has never selected an agent opens the Run AI Review screen
- **THEN** the built-in default agent is selected
- **AND** running the review uses its established general-purpose persona through the harness

#### Scenario: Default agent is listed among discovered agents

- **WHEN** the workspace also declares its own agents
- **THEN** the built-in default agent is still listed
- **AND** it is distinguishable from workspace-declared agents

### Requirement: The demo agent is independent of the model selection

The demo agent SHALL generate its findings without calling a model. Selecting it SHALL disable or visibly neutralise the model selection, and it SHALL remain runnable when no model is available. Its run SHALL still use the universal lifecycle, activity, evidence-validation, coverage, cancellation, persistence, and completion protocol.

#### Scenario: Demo agent selected

- **WHEN** a reviewer selects the demo agent
- **THEN** the model selection is shown as not applying to this run
- **AND** running the review produces findings without contacting any model

#### Scenario: Demo review enters the harness

- **WHEN** a demo review starts for an individual target or changeset
- **THEN** it creates the same run, lineage, plan, evidence, coverage, and result projections as a model-backed review
- **AND** deterministic demo execution does not bypass host validation or completion
