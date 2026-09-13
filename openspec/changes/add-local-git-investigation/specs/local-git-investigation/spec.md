## Purpose

Defines a review-investigation source that answers changed-file manifests, diffs, revision-pinned
file reads and searches by computing them locally from git objects, so that what a review can see is
decided by the content of two commits rather than by how much of a diff a forge is willing to
compute.

## ADDED Requirements

### Requirement: A local source answers only from the pinned revision pair

A local investigation source SHALL answer every manifest, diff, file-read and search request from an
object store holding the exact base and head commits named by the request, addressed by commit id.
It SHALL NOT resolve a branch, tag, symbolic name or default revision, SHALL NOT create or read a
working tree or checkout, and SHALL identify the resolved repository and revisions in every result.

#### Scenario: Manifest for the pinned pair

- **WHEN** the harness requests the changed-file manifest for a pinned base and head
- **THEN** the source enumerates every changed file by comparing those two commits
- **AND** the result names the same repository and revision pair the request carried
- **AND** the enumeration is reported complete only when the comparison itself was complete

#### Scenario: No working tree is written

- **WHEN** the source answers any request for a repository
- **THEN** no branch is checked out and no working tree exists at any point
- **AND** every answer is derived from the object store by commit id

#### Scenario: A revision that is not an object id

- **WHEN** any caller supplies a revision that is not a full object id
- **THEN** the source refuses the request with a stated reason
- **AND** it does not resolve the value as a ref, a partial id, or a default revision

### Requirement: The source is provider-neutral and obtains remote access as an opaque descriptor

The local source SHALL NOT depend on which platform a repository is hosted on. Where it needs a
remote to obtain objects from, it SHALL receive a neutral descriptor supplied by the connection,
carrying a fetch location, an optional credential value, and an optional opaque ref hint. The source
SHALL validate the descriptor's transport, use the values as given, and interpret nothing else about
them.

#### Scenario: The same source serves every platform

- **WHEN** repositories from different platforms are reviewed
- **THEN** the same local source serves all of them without platform-specific behavior
- **AND** no platform identity is required to answer any request

#### Scenario: A transport that could execute a command

- **WHEN** a descriptor names a transport other than an ordinary HTTP or HTTPS location
- **THEN** the source refuses to use it and reports the repository as unavailable to it
- **AND** no command-executing transport is ever invoked

#### Scenario: No descriptor is available

- **WHEN** the connection cannot supply an object-source descriptor for a repository
- **THEN** the local source declares itself unavailable for that repository
- **AND** it does not guess a location from the repository identifier

### Requirement: Objects are acquired and verified before a run claims the source

The source SHALL obtain both pinned commits before an attempt selects it, and SHALL verify that each
obtained object is the exact commit that was requested. An acquisition that cannot be completed or
verified SHALL make the source unavailable for that run rather than producing a partially answerable
source.

#### Scenario: Objects are already held

- **WHEN** both pinned commits are already present from an earlier review
- **THEN** the source is available with no network request
- **AND** the run records that acquisition was already satisfied

#### Scenario: Objects are obtained from the remote

- **WHEN** a pinned commit is absent
- **THEN** the source obtains that commit alone, without full history and without a checkout
- **AND** it verifies the obtained object is the requested commit before reporting success

#### Scenario: The obtained object is not the requested commit

- **WHEN** a remote returns an object other than the pinned commit
- **THEN** acquisition fails with a stated reason
- **AND** the returned object is never used to answer any request

#### Scenario: Acquisition fails

- **WHEN** the objects cannot be obtained at all
- **THEN** the source reports itself unavailable with the reason and the revision it could not obtain
- **AND** no attempt begins model work claiming this source

### Requirement: Revisions that cannot be obtained are named, never substituted

When a pinned commit is not reachable by its object id alone, the source MAY retry using the opaque
ref hint from the object-source descriptor, and SHALL then verify the obtained object against the
pinned id. The source SHALL NOT substitute any other commit, branch tip or revision, and SHALL report
which revision and which side of the pair could not be obtained. It SHALL report a refused fetch as
its own condition, distinct from a revision the remote no longer holds, and SHALL NOT report a
revision as absent on the strength of a refusal.

#### Scenario: A force-pushed head is reachable through a ref hint

- **WHEN** the pinned head cannot be obtained by object id and the descriptor carries a ref hint
- **THEN** the source retries with that hint as an opaque value it does not interpret
- **AND** it accepts the result only when the obtained object is the pinned head

#### Scenario: The ref hint resolves to a different commit

- **WHEN** a ref hint yields a commit other than the pinned one
- **THEN** acquisition fails and names the mismatch
- **AND** the review does not proceed against the substituted commit

#### Scenario: A remote refuses to serve a commit it still holds

- **WHEN** a fetch by object id is refused by the remote and the ref-hint retry fails as well
- **THEN** the source reports itself unavailable for that run, naming the revision and that the fetch
  was refused
- **AND** it does not report the revision as absent, because a refusal does not establish absence

#### Scenario: A revision cannot be obtained and nothing establishes why

- **WHEN** the pinned head cannot be obtained by any route the source has
- **THEN** the review ends with a reason naming the revision and what failed
- **AND** it does not report the revision as gone, because nothing left is in a position to establish
  that, and a stored checkpoint is never declared stale on an unproven claim

### Requirement: The object store is owned by the extension, bounded, and never the reviewer's own repository

The object store SHALL live in storage owned by the extension, one bare repository per repository
identity, and SHALL NOT read from, write to, or borrow objects from any repository in the reviewer's
workspace or elsewhere on the machine. It SHALL be bounded by a configured size, evicted whole
repositories at a time in least-recently-used order, and SHALL NOT evict a repository an attempt is
currently using.

#### Scenario: The reviewer has the repository open

- **WHEN** the repository under review is also open in the reviewer's workspace
- **THEN** the source still uses its own object store
- **AND** the reviewer's repository is neither read nor written, and its configuration does not
  affect any result

#### Scenario: Two reviews of one repository run at once

- **WHEN** two attempts investigate the same repository concurrently
- **THEN** both are served from the same object store without either corrupting or blocking the other
- **AND** a commit needed by both is obtained once

#### Scenario: The store exceeds its bound

- **WHEN** the store's total size exceeds its configured bound
- **THEN** whole repositories are removed in least-recently-used order until it is within bound
- **AND** no repository in use by an active attempt is removed
- **AND** no repository is left holding some of its pinned commits and not others

#### Scenario: The store cannot be written

- **WHEN** the store's location cannot be created or written to
- **THEN** the source declares itself unavailable with that reason
- **AND** it does not write objects anywhere else

### Requirement: Every git invocation is a validated argument array in a controlled environment

The source SHALL invoke git with an argument array and no shell. Every pathspec SHALL follow an
end-of-options separator, every search pattern SHALL follow an explicit pattern option, pathspecs
SHALL be treated literally rather than as pattern syntax, and revisions SHALL be validated as object
ids. The invocation environment SHALL be constructed rather than inherited, so that machine-level git
configuration cannot change a result or run a command, and SHALL prevent any interactive prompt.
Every invocation SHALL have a time bound and an output bound.

#### Scenario: A path that looks like an option

- **WHEN** a model-supplied path begins with a dash or otherwise resembles a git option
- **THEN** it is passed only after the end-of-options separator and can only be read as a path
- **AND** no file outside the request is read or written as a result

#### Scenario: A pattern that looks like an option

- **WHEN** a model-supplied search query begins with a dash
- **THEN** it is passed only as the value of an explicit pattern option
- **AND** it is matched literally rather than compiled as a pattern from the model

#### Scenario: An absolute or escaping path

- **WHEN** a request carries an absolute path, a drive or network prefix, a parent-directory
  component, or a control byte
- **THEN** the source refuses it before invoking git and states a bounded reason
- **AND** the reason returned is the source's own, not raw platform error text

#### Scenario: Pathspec pattern syntax

- **WHEN** a model-supplied path begins with the character git uses to introduce pathspec magic
- **THEN** it is matched as a literal path
- **AND** it cannot exclude, widen, or re-root the scope of the operation

#### Scenario: Machine configuration cannot alter a result

- **WHEN** the machine's user or system git configuration defines external diff, content filters,
  aliases, hooks or credential helpers
- **THEN** none of them apply to any invocation this source makes
- **AND** no result and no command depends on them

#### Scenario: A credential is required

- **WHEN** obtaining objects requires a credential
- **THEN** it is supplied through the invocation environment
- **AND** it never appears in a command line, in a location string, in any activity, checkpoint,
  diagnostic, error reason, or stored record

#### Scenario: An invocation would prompt

- **WHEN** git would ask for a credential or any other input interactively
- **THEN** the invocation fails promptly with a stated reason
- **AND** no process is left waiting for input

#### Scenario: An invocation exceeds its bounds

- **WHEN** an invocation exceeds its time bound or its output bound
- **THEN** the process is stopped and the operation returns a bounded, non-terminal state
- **AND** no file is recorded as permanently uninspectable because of it

### Requirement: Binary content is reported only from content that proves it

The source SHALL report a file as binary only when the comparison of its content establishes it. It
SHALL report every other condition that prevents reading a diff — size, time, output bound, or an
unobtainable revision — as a distinct state that is not binary.

#### Scenario: A genuine binary file

- **WHEN** a changed file's content cannot be compared as text
- **THEN** the manifest labels it binary from that determination
- **AND** the file is inspected as a non-text change rather than treated as a failure

#### Scenario: A very large text file

- **WHEN** a changed text file's diff exceeds the configured bounds
- **THEN** the result reports it as bounded or oversized with the known counts
- **AND** it is never reported as binary

#### Scenario: Additions, deletions and renames

- **WHEN** a change contains added, deleted, modified and renamed files
- **THEN** the manifest reports each kind, the old and new paths of a rename, and per-file line counts
- **AND** no entry is omitted because its content could not be rendered as text

### Requirement: The merge base is computed from the repository

The commit a change request's diff is against SHALL be computed by the source, from the pinned head
and the branch the change request targets, and SHALL be pinned durably in the object store once
computed. Acquisition SHALL obtain enough history for that computation, deepening progressively to a
stated bound, and SHALL report a truthful failure naming the depth reached rather than substituting
any other commit.

The computed base SHALL be the commit a complete copy of the repository would report. A candidate
the store cannot be shown to have computed over enough history SHALL NOT be accepted, because a
partial history can yield an older common ancestor with nothing to distinguish it from the right
answer.

#### Scenario: The merge base is within the history first fetched

- **WHEN** the pinned head and the target branch are fetched at the starting depth and share an
  ancestor within it
- **THEN** the source reports that commit as the base revision
- **AND** it pins it under its own reference, so a later repack cannot take it away

#### Scenario: The merge base is deeper than the history first fetched

- **WHEN** no common ancestor is present in the history fetched so far
- **THEN** the source fetches more history and asks again, up to a stated bound
- **AND** it stops early once the store holds the repository's whole history, because deepening
  further cannot add a commit

#### Scenario: The fetched history yields an older common ancestor than the true merge base

- **WHEN** the history fetched so far contains a common ancestor, and more history could still
  contain a nearer one
- **THEN** the source treats that answer as unproven, fetches more history and asks again
- **AND** it accepts an answer only once no point where the fetched history stops lies between either
  pinned revision and that answer

#### Scenario: No merge base exists within the bound

- **WHEN** the bound is reached, or the whole history is held, without a common ancestor
- **THEN** the review refuses with a reason naming the depth that was reached
- **AND** no other commit is used as the base

#### Scenario: The bound is reached with a merge base that cannot be proved

- **WHEN** the bound is reached with a candidate the fetched history is not deep enough to prove
- **THEN** the review refuses, naming what could not be established and the depth reached
- **AND** the unproven candidate is not used as the base, because reviewing the wrong comparison
  states nothing about having done so

### Requirement: Revision-pinned repository search is supported

The source SHALL declare and provide bounded repository search at an explicit base or head commit,
and bounded search over the pinned comparison. Search results SHALL carry path and location identity
sufficient for a later bounded read, and SHALL state their bound and continuation rather than imply
exhaustiveness. Declaring the capability SHALL be independent of any policy that withholds the
corresponding tool from the model.

#### Scenario: Search at a pinned revision

- **WHEN** the harness searches for text at the head or base commit
- **THEN** matches come only from that commit's content
- **AND** each excerpt can enter the evidence ledger as exact model-visible content

#### Scenario: Search results exceed the page bound

- **WHEN** more matches exist than one page may carry
- **THEN** the result states that it is bounded and carries a continuation reference
- **AND** absence from a bounded page is never reported as absence from the revision

#### Scenario: Policy withholds a supported search

- **WHEN** the configured review scope withholds repository search and file reads from the model
- **THEN** the source still declares the capability truthfully
- **AND** the tool is withheld by that policy, and the run's recorded capability signature reflects
  what the attempt actually had
