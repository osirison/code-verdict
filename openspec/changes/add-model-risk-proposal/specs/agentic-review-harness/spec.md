## MODIFIED Requirements

### Requirement: The model plans and investigates through bounded host tools

The harness SHALL let the model create and revise a public plan, propose risk and logical units for changed files, and choose investigation steps. A risk proposal SHALL be a bounded protocol message, legal while planning and investigating and limited to one per turn, naming each file by member and path. The host SHALL apply the higher of the proposal, its own deterministic floor, and the risk already recorded for the file, so a proposal can raise a file's risk and SHALL NOT lower it. A proposal SHALL NOT add a file to the changed-file inventory, and SHALL NOT change a file already inspected or in a terminal state. All investigation SHALL use host-authorized, revision-pinned, paginated or otherwise bounded tools. The available tools SHALL include changed-file manifest retrieval, diff reads, base and head file-range reads, repository search, diff search, applicable nested base-revision `AGENTS.md`/`CLAUDE.md` policy resolution, issue and change-request detail retrieval, incremental candidate-finding submission, and completion requests.

#### Scenario: Model investigates a subsystem

- **WHEN** the public plan identifies a subsystem or logical unit for investigation
- **THEN** the model chooses bounded tool calls for that unit
- **AND** the host authorizes each call against the run snapshot, budgets, and tool contract before dispatch

#### Scenario: Result has another page

- **WHEN** a manifest, diff, detail read, or search has more results than one response may contain
- **THEN** the tool returns an explicit continuation reference and completeness state
- **AND** the model can request the next bounded page without changing revisions

#### Scenario: Nested policy applies to a file

- **WHEN** the model investigates a changed file beneath one or more nested `AGENTS.md`/`CLAUDE.md` files
- **THEN** the policy tool resolves the applicable policy chain from the base revision, checking both file names at every level
- **AND** the host applies that policy to the investigation without making it citable evidence

#### Scenario: Repository policy is absent versus unavailable

- **WHEN** the host resolves a repository's root policy
- **THEN** a level where both `AGENTS.md` and `CLAUDE.md` were checked and neither exists is reported as absent
- **AND** a level where neither file could be read — no readable source, a withheld capability, or a failed read — is reported distinguishably as unavailable, with the reviewer told the principles were not read
- **AND** a level where one file was read and the other could not be is reported as present with the unread file and the reason named, and the run's limitations record that rules it carries were not applied

#### Scenario: Agent instructions request another tool

- **WHEN** agent-controlled content names, enables, disables, or attempts to redefine a tool
- **THEN** the host exposes only the tools authorized by the harness contract
- **AND** the attempt records a sanitized protocol or authorization failure when repair is required

#### Scenario: Model proposes a risk above the floor

- **WHEN** the model proposes `high` for a changed file the host's floor classified `low` and the file has not been read
- **THEN** the host records `high` as the file's risk and reports the coverage change
- **AND** the file now counts as requiring inspection before the run can complete

#### Scenario: Model proposes a risk below the floor

- **WHEN** the model proposes `low` for a changed source-code file the host's floor classified `medium`
- **THEN** the file keeps its higher recorded risk
- **AND** the proposal is not treated as an error and costs no repair

#### Scenario: Model proposes a path outside the inventory

- **WHEN** the model proposes a risk for a path that is not among the changed files of the named member, or for a member the run does not have
- **THEN** the host refuses that entry with a recorded failed activity entry and does not request a protocol repair
- **AND** the changed-file inventory is unchanged, and a path of a member the run has is remembered as one the model guessed

#### Scenario: Model raises a risk after the budget forecast

- **WHEN** the model raises a file's risk during investigation, after the host stated whether the budget can fund the required reads
- **THEN** the host recomputes that forecast, and where the raise makes the required reads unfundable states the shortfall in place of any earlier statement of it
- **AND** a turn containing only risk proposals is treated as a stop that may have left work behind, not as investigation work

#### Scenario: Resume reproduces a raised risk

- **WHEN** an attempt is resumed from a checkpoint written after the model raised a file's risk
- **THEN** the resumed attempt classifies that file at the raised risk without a new proposal
- **AND** the file's logical unit, when the model named one, is carried with it

#### Scenario: Planning turn carries no plan

- **WHEN** a planning turn contains no plan, such as a risk proposal or a rationale alone, and no plan exists yet
- **THEN** the host asks the model again, up to a fixed bound of nudged turns, before investigating
- **AND** if the bound is exhausted without a plan, the attempt records that no plan was created, as before
