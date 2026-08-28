# scm-providers/github Specification

## Purpose

Defines what the GitHub provider must deliver through the neutral SCM contract, so pull requests on
github.com and GitHub Enterprise Server are reviewed by the same product behavior as GitLab merge
requests.

## Requirements

### Requirement: The GitHub provider declares its capabilities and vocabulary

The GitHub provider SHALL declare the capability flags its platform genuinely supports and a
vocabulary matching GitHub's own nouns and reference format. Declared flags SHALL be honest: a flag
SHALL NOT be set true unless the corresponding operation succeeds against GitHub.

#### Scenario: GitHub vocabulary reaches the chrome

- **WHEN** the active pod targets GitHub
- **THEN** change requests are called "pull request" (abbreviated "PR"), containers are
  "repository" and "organization", CI is called "check"
- **AND** a change-request reference is rendered as `#123`

#### Scenario: A capability GitHub lacks is declared false

- **WHEN** an operation cannot be performed against GitHub with the granted credential
- **THEN** the corresponding capability flag is false and the product hides that affordance rather
  than failing at use time

### Requirement: GitHub source inputs resolve to repositories and organizations

The GitHub provider SHALL resolve the source-input forms GitHub users actually paste — repository
web URLs, `owner/repo` paths, organization URLs and organization names — into a repository or an
organization with its repositories, on both github.com and GitHub Enterprise Server hosts.

#### Scenario: A repository URL

- **WHEN** the user enters a GitHub repository web URL, with or without a trailing path segment such
  as a pull-request or tree path
- **THEN** the provider resolves it to that repository, identified consistently for later calls

#### Scenario: An owner and repository path

- **WHEN** the user enters `owner/repo`
- **THEN** the provider resolves it to that repository

#### Scenario: An organization

- **WHEN** the user enters an organization URL or name and the credential can see it
- **THEN** the provider returns the organization together with the repositories the credential can
  see, for explicit selection
- **AND** repositories added to that organization later do not join the pod on their own

#### Scenario: Visible-shaped but inaccessible

- **WHEN** the input is a well-formed GitHub repository or organization reference the credential
  cannot see
- **THEN** the provider reports it as not visible and adds nothing

### Requirement: The GitHub provider lists open pull requests batched per repository

The provider SHALL return open pull requests for a set of repositories using requests batched per
repository, never one request per pull request, and SHALL include for each one the fields the
dashboard and staleness detection depend on.

#### Scenario: Listing across a pod's repositories

- **WHEN** open pull requests are requested for several repositories
- **THEN** every returned item carries its repository, number, title, state, source and target
  branch, author, reviewers, web URL, last-updated time and head commit
- **AND** draft pull requests are marked as drafts

#### Scenario: Pagination

- **WHEN** a repository has more open pull requests than one page returns
- **THEN** the provider returns all of them

#### Scenario: Check status

- **WHEN** a pull request has checks
- **THEN** its CI status is reported through the neutral status values, with a link to the run where
  GitHub supplies one

### Requirement: GitHub diffs produce anchors that round-trip into posted comments

The provider SHALL return a pull request's changed files as unified diff hunks together with the
head commit and an opaque anchoring payload, and SHALL accept that payload back when posting line
comments so that a comment lands on the intended file and line.

#### Scenario: Comment lands where the diff said

- **WHEN** a review comment is anchored to a file and line taken from the returned diff and then
  submitted
- **THEN** the comment appears on that file and line in the pull request

#### Scenario: Renamed, added and deleted files

- **WHEN** a pull request renames, adds or deletes files
- **THEN** the diff marks each accordingly and carries both old and new paths for renames

#### Scenario: Head moved since the diff was fetched

- **WHEN** the author pushes after the diff was fetched and a comment is submitted against the old
  anchor
- **THEN** the rejection is reported as a stale anchor for that comment, not as a general failure

### Requirement: GitHub review submission posts one review with per-comment outcomes

The provider SHALL post an accepted review as a single GitHub review carrying its line comments,
its summary and its approve or request-changes decision, and SHALL report the outcome of each
comment individually. Where a comment cannot be included, the provider SHALL still report that
comment's own outcome rather than failing the whole submission.

#### Scenario: A full review posts once

- **WHEN** a review with several line comments and a summary is submitted
- **THEN** it appears on the pull request as one review rather than as separate independent comments
- **AND** each submitted comment is reported as successful with its thread identifier

#### Scenario: Approval and request-changes

- **WHEN** the review carries an approve decision
- **THEN** the pull request records an approval
- **WHEN** the review carries a request-changes decision
- **THEN** the pull request records changes requested, and the two outcomes are reported separately

#### Scenario: Suggested fixes

- **WHEN** an accepted item carries a suggested replacement
- **THEN** the comment renders it as a GitHub suggestion the author can apply from the pull request

#### Scenario: Partial failure

- **WHEN** one comment is rejected and the others are accepted
- **THEN** the accepted comments are reported successful, the rejected one is reported with its
  normalized error, and the summary is withheld

### Requirement: The GitHub provider reads and acts on review threads

The provider SHALL return the review threads on a pull request with their notes, resolution state
and whether the diff anchor is still present, and SHALL support replying to a thread and setting its
resolution state.

#### Scenario: Reading threads for reply polling

- **WHEN** threads are requested for a pull request
- **THEN** each returned thread carries its identifier, its notes with author, body and creation
  time, its resolved state and whether its anchor is still present

#### Scenario: An outdated thread

- **WHEN** a thread's diff anchor no longer applies after a force-push or rebase
- **THEN** the thread is returned with its anchor reported as absent, so the product shows it as
  stale rather than dropping it

#### Scenario: Replying and resolving

- **WHEN** a reply is posted to a thread
- **THEN** it appears in that thread rather than as a new top-level comment
- **WHEN** a thread is marked resolved or unresolved
- **THEN** the pull request reflects that state

### Requirement: The GitHub provider authenticates by session or token

The provider SHALL support authenticating to github.com with a session supplied by the editor and to
any GitHub host with a personal access token, and SHALL report the signed-in identity and any
missing permission as a scope failure rather than a generic error.

#### Scenario: Signing in to github.com

- **WHEN** a user connects a github.com pod and accepts the editor's GitHub session
- **THEN** the connection succeeds without a pasted token and reports the signed-in username

#### Scenario: Signing in to GitHub Enterprise Server

- **WHEN** a user enters an enterprise host and a personal access token
- **THEN** the connection succeeds against that host and reports the signed-in username

#### Scenario: A credential missing a required permission

- **WHEN** the credential cannot perform an operation the pod needs because it lacks permission
- **THEN** the failure is reported as insufficient scope, naming what is missing, rather than as an
  unknown error

### Requirement: GitHub failures map onto the neutral error taxonomy

The provider SHALL translate GitHub's failure responses into the neutral error kinds, including
GitHub's rejection of an outdated comment position as a stale anchor and both its primary and
secondary rate limiting as rate limited, carrying the retry delay GitHub supplies.

#### Scenario: Rejected comment position

- **WHEN** GitHub rejects a line comment because its position is outdated or invalid
- **THEN** the provider reports a stale-anchor error for that comment

#### Scenario: Rate limiting

- **WHEN** GitHub reports that the primary or secondary rate limit is exhausted
- **THEN** the provider reports a rate-limited error carrying the retry delay when GitHub supplies
  one

#### Scenario: Invalid credential

- **WHEN** GitHub rejects a request because the credential is invalid or expired
- **THEN** the provider reports an authentication error

### Requirement: The GitHub provider passes the shared conformance suite

The GitHub provider SHALL pass the shared provider conformance suite, including its partial-failure
case, against a local emulator that reproduces GitHub's request and response shapes without network
access.

#### Scenario: Conformance in the test suite

- **WHEN** the test suite runs
- **THEN** the GitHub provider passes every case of the shared conformance suite
- **AND** those tests make no network request
