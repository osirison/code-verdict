## Purpose

Defines how Code Verdict talks to any source-repository platform through one neutral contract, so
that supporting a new platform means adding one provider and changing nothing above the data layer.

## ADDED Requirements

### Requirement: Platform access is mediated by the provider registry

The product SHALL reach a source-repository platform only through a registered provider selected by
the pod's provider id. No behavior outside a provider module SHALL depend on which platform a pod
targets, except through the declared capability flags and vocabulary defined below.

#### Scenario: A pod resolves to its provider

- **WHEN** the product needs platform data for a pod
- **THEN** it obtains a connection from the provider registered under that pod's provider id
- **AND** the same call path serves every provider without platform-specific branching

#### Scenario: An unregistered provider id is reported, not guessed

- **WHEN** a stored pod names a provider id that is not registered
- **THEN** the product reports that the provider is unavailable and leaves the pod intact
- **AND** it does not silently fall back to a different provider

### Requirement: Features degrade from capability flags, never from provider identity

Every feature whose availability depends on the platform SHALL decide from the provider's declared
capability flags. Comparing a provider id to a literal to decide behavior SHALL NOT occur outside a
provider module.

#### Scenario: A platform without applyable suggestions

- **WHEN** the active provider declares that it does not support suggestion blocks
- **THEN** an accepted fix is posted as a plain fenced diff in the comment body
- **AND** the "Accept & apply" affordance is hidden rather than failing at submit time

#### Scenario: A platform without thread resolution

- **WHEN** the active provider declares that it cannot resolve threads
- **THEN** the resolve action is absent from posted-review threads
- **AND** thread status is still reported from the notes the platform does return

#### Scenario: A platform without group hierarchy

- **WHEN** the active provider declares no group hierarchy
- **THEN** onboarding accepts repository inputs only and does not offer a group chooser

### Requirement: Platform nouns are rendered from the active provider's vocabulary

Every user-visible noun, abbreviation and change-request reference SHALL be rendered from the active
provider's vocabulary. A hardcoded platform noun SHALL NOT appear in user-visible text outside a
provider module, and the build SHALL fail when one is introduced.

#### Scenario: The same screen on two platforms

- **WHEN** the active pod targets GitLab
- **THEN** the review, dashboard, sidebar, changeset and posted-review screens say "merge request",
  "project" and render a change-request reference as `!2841`
- **WHEN** the active pod targets GitHub
- **THEN** the same screens say "pull request", "repository" and render the reference as `#123`

#### Scenario: A new hardcoded noun is rejected

- **WHEN** a change introduces a literal platform noun into user-visible text outside a provider
  module
- **THEN** the test suite fails and names the offending location

#### Scenario: Static product surface stays neutral

- **WHEN** a command title, extension description, welcome text or setting description is shown
- **THEN** its wording names no specific platform, because it cannot be varied per pod at runtime

### Requirement: A provider owns its source-input grammar

Each provider SHALL interpret the onboarding source input — platform URL, repository identifier, or
group identifier — according to its own platform's grammar. Neutral code SHALL NOT parse
platform-specific URL shapes or identifier formats.

#### Scenario: Platform-specific URL forms resolve

- **WHEN** a user pastes a repository URL for the active provider's platform
- **THEN** that provider resolves it to a repository regardless of the platform's own path
  conventions
- **AND** a URL form belonging to a different platform is not silently accepted

#### Scenario: A valid but invisible identifier is never added

- **WHEN** the input is a well-formed identifier the token cannot see
- **THEN** the result is reported as not visible
- **AND** no source is added to the pod

#### Scenario: Unrecognised input is rejected

- **WHEN** the input matches no shape the provider recognises
- **THEN** the result is reported as no match and no source is added

### Requirement: A provider declares how it authenticates

Each provider SHALL declare which authentication modes it supports and what its instance URL means.
Onboarding SHALL present only the modes the chosen provider declares, and stored credentials SHALL
be scoped so that two providers pointing at the same host do not share or overwrite each other's
credentials.

#### Scenario: A provider that authenticates by host-supplied session

- **WHEN** the chosen provider declares that the editor can supply an authenticated session for the
  entered host
- **THEN** onboarding offers that session as the default path and does not require a pasted token
- **AND** the connection succeeds with no token stored

#### Scenario: A provider that authenticates by access token

- **WHEN** the chosen provider declares token authentication for the entered host
- **THEN** onboarding asks for a token, stores it in the editor's secret store, and never writes it
  to settings

#### Scenario: Two providers on one host do not collide

- **WHEN** two pods with different provider ids are connected to the same host
- **THEN** each pod's credential is stored and retrieved independently

### Requirement: Onboarding begins with a provider choice

Onboarding SHALL let the user choose which platform a pod targets before asking for a host or
credential, and the subsequent steps SHALL be driven by the chosen provider's declarations.

#### Scenario: Choosing a platform

- **WHEN** a user starts sign-in
- **THEN** every registered provider suitable for real use is offered by its display name
- **AND** the host prompt, its example text and the credential step come from the chosen provider

#### Scenario: One provider registered

- **WHEN** only one provider suitable for real use is registered
- **THEN** onboarding proceeds directly to that provider's host step without an empty choice

### Requirement: Platform failures are normalized before leaving the provider

Providers SHALL map every platform failure onto the neutral error taxonomy — authentication,
insufficient scope, stale anchor, rate limited, not found, network, unknown — so that recovery
behavior is identical across platforms. Callers SHALL NOT inspect platform-specific error payloads.

#### Scenario: Expired credential during submit

- **WHEN** a platform rejects a submit because the credential is invalid or expired
- **THEN** the failure is reported as an authentication error
- **AND** the triage draft survives so the user can reconnect and post the remainder

#### Scenario: A comment anchor the platform no longer accepts

- **WHEN** a platform rejects a line comment because its diff position is no longer valid
- **THEN** the failure is reported as a stale anchor for that comment only
- **AND** the comment is re-anchored before any retry, never retried unchanged

#### Scenario: Rate limiting

- **WHEN** a platform reports that the client is rate limited
- **THEN** the failure is reported as rate limited, carrying the platform's retry delay when it
  supplies one

### Requirement: Review submission reports per-comment outcomes

Submitting a review SHALL take the whole accepted set at once and report the outcome of each comment
individually, so that a partial failure is retried only for the parts that failed. Submission SHALL
raise an error instead of a result only when nothing was attempted.

#### Scenario: Some comments land and some do not

- **WHEN** a submit posts several line comments and one is rejected
- **THEN** the result marks the posted comments as successful and the rejected one as failed with
  its normalized error
- **AND** the summary is withheld rather than posted over an incomplete review

#### Scenario: Nothing could be attempted

- **WHEN** authentication fails before any comment is posted
- **THEN** submission raises the normalized error rather than returning a result of failures

### Requirement: A provider is added only when it passes the conformance suite

Adding a provider SHALL mean implementing the neutral contract and passing the shared provider
conformance suite, including its partial-failure case. No change above the data layer SHALL be
required to add a provider, beyond registering it.

#### Scenario: A new provider is introduced

- **WHEN** a provider module is added and registered
- **THEN** it passes the shared conformance suite against its own emulator
- **AND** no file outside its own directory and the registry wiring point is modified to make the
  product work with it

#### Scenario: The dependency direction is enforced

- **WHEN** code outside the registry wiring point imports a concrete provider module
- **THEN** the lint step fails
