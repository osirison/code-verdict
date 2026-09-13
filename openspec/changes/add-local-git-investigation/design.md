## Context

See proposal.md, Why, for the measurement. This document explains how the local source is built and
why each choice was made.

`add-agentic-review-harness` is a prerequisite. It introduces the neutral review-investigation
contract this change modifies: `InvestigationSnapshotRef` (`repoId` + `baseSha` + `headSha`), the
five revision-scoped operations `listChangedFiles`, `readDiff`, `readFile`, `searchRepository` and
`searchDiff`, the `InvestigationResult<T>` envelope with its `complete | paginated | truncated |
unavailable | binary | tooLarge | notFound | unknown` states, and the `ReviewInvestigationCapabilities`
declaration. Every request in that contract carries only the snapshot, never a change-request number.
That is deliberate and stays: a pinned read must outlive the change request's current diff.

Three facts about the existing code shape the design.

The provider layer already routes investigation through a revision-scoped comparison rather than a
change-request-scoped one. GitHub uses `GET /compare/{base}...{head}`; GitLab uses
`/repository/compare` with `straight: true`. Both chose it for the same documented reason — the
neutral request carries no change-request number.

The two providers already disagree about what `baseSha` means. GitLab reads `diff_refs.base_sha`,
which is the merge base, and then asks for a two-dot comparison from it. GitHub reads
`pull.base.sha`, the tip of the target branch, and relies on the server's three-dot comparison to
find the merge base. The neutral field's doc comment calls it "the merge-base/target commit", which
is two different commits described as one. Pinning the field to the merge base is therefore not a
new invention; it is GitHub adopting the shape GitLab already uses.

There is no process spawning anywhere in `src/` today — no module imports `node:child_process`. Review
state is not filesystem-backed either: it persists through `globalState`/`workspaceState` key-value
storage only. Writing files is not itself new — `src/app/agentTraceFile.ts` already creates a
directory, appends synchronously and rotates a 32 MB trace file from production code reached through
`src/app/lmAgent.ts`, and it is the precedent for a filesystem seam that swallows its own errors so a
review cannot fail because of one. `node:fs`, `node:path`, `node:crypto`, `node:os`, `node:net` and
`node:http` are already imported, and the extension is bundled with esbuild for `--platform=node
--target=node20`, so spawning a child process is available but entirely new. Everything below about
process construction, environment, timeouts and output bounds is therefore a first, not a change to an
existing pattern.

## Goals / Non-Goals

**Goals:**

- Produce exact, complete changed-file evidence for a change of any size from the two commit ids the
  snapshot already carries.
- Keep the data layer provider-agnostic: one neutral source contract, two implementations, no
  provider identity above the provider boundary and no forge knowledge inside the local source.
- Never enter an irreversible file state on a condition the source cannot prove.
- Leave the reviewer's own repositories untouched — no checkout, no working tree, no writes to a
  clone the reviewer owns.
- Make every git invocation argument-safe by construction rather than by careful call sites.
- Make the source that produced a run's evidence a recorded, checked property of the attempt.

**Non-Goals:**

- Cloning full history, maintaining a checkout, or exposing a general git service for other features
  (blame, log, history browsing). A later capability can add those on the same object store.
- Replacing the provider for change-request metadata, description, discussion, linked issues, checks,
  head-change detection, or posting. Those live on the forge and stay there.
- Bundling a git binary. The source uses the git already on the machine and declares itself
  unsupported when there is none.
- A reviewer-facing setting that points the source at an arbitrary local path. Source selection is a
  host decision made from measurable facts.
- Reading or writing the git repository open in the reviewer's workspace, for any purpose.
- Changing which tools the `scopeInvestigationToChangedFiles` policy withholds from the model.

## Decisions

### D1: Compute the diff locally rather than moving to the pull-request files endpoint

`GET /repos/{owner}/{repo}/pulls/{n}/files` recovers 106 of the 137 files the compare endpoint
suppressed, and still leaves 30 unreadable on the same measured change. It is a smaller version of
the same defect, not a fix: the forge still decides how much of the diff it is willing to compute,
and the answer it gives for "I declined" is still shaped exactly like "this is binary".

It also does not fit the contract. Every neutral investigation request carries `{repoId, baseSha,
headSha}` and no change-request number. Serving that endpoint would mean either adding a
change-request number to a revision-scoped request — which reintroduces the coupling the contract was
written to avoid, and makes a pinned read invalid the moment the change request's head moves — or
having the provider keep a private snapshot-to-number map, which is forge shape hidden below the
boundary rather than removed from it. The same limit exists on GitLab, whose compare response
carries `compare_timeout` for exactly this condition, so a GitHub-only endpoint change fixes one
provider and leaves the other.

The deeper reason is that the question is not the forge's to answer. A diff between two commits is a
comparison of two trees. Git computes it exactly, reports binary content from the content itself,
detects renames, and has no size cap, no rate limit and no truncation shape. Two shallow fetches of
the measured change cost 2.1 MB.

Alternative rejected: request the raw diff media type (`Accept: application/vnd.github.diff`). One
unbounded blob with no pagination, capped by GitHub at 20,000 lines / 3 MB and refused above it, and
it discards the per-file metadata the manifest needs.

Alternative rejected: page the compare endpoint harder. The 300-file cap and the patch suppression
are server-side decisions about the whole comparison; no page size changes them.

### D2: One neutral investigation-source contract, two implementations, beside the providers

The five revision-scoped operations become a named `InvestigationSource` interface defined with the
rest of the neutral contract, and they come **off** `Connection` entirely.

They were on it when this design was written: a provider that declared investigation capabilities was
one implementation and the local source was a second. That did not survive contact with the rule the
change exists to implement — never ask a forge to compute a change, always read it from a local
clone, ask the forge only for what is not in the repository files. A forge that can still answer
`readDiff` is a second route around the object store, and the fallback comes back through it the
first time a fetch is inconvenient. So there is one production implementation, the local git source,
and `providers/investigationBoundary.test.ts` fails if a provider grows one of the five back.

```text
        harness attempt / tool dispatcher
             |                          |
   InvestigationSource            Connection (provider)
   (five pinned operations)       (detail, head check, posting)
             |                          |
      git object cache            forge REST API
             |
      git child process
```

Dependency rule, not a directory rule: the local source implements the neutral contract, imports
nothing from `src/providers/`, and no provider imports it. It never learns which forge a repository
came from. GitLab gets the same fix as GitHub with no GitLab-specific work.

Detail retrieval (`getChangeRequestDetails`, `getIssueDetails`), head-change detection, checks and
posting are **not** part of this interface. They stay on `Connection`, because they are questions
about the forge, not about two commits. An attempt therefore always holds both a `Connection` and an
`InvestigationSource`, which may or may not be the same object.

The local source needs three things it cannot derive: where to fetch objects from, how to
authenticate, and which branch the change request targets. All three are forge-shaped, so the
provider supplies them as one opaque neutral descriptor through a new `Connection` operation — a
fetch URL, an optional authorization header value, an optional ref hint (D8), and the target branch's
ref. The local source validates the URL scheme, uses the header, and interprets neither ref. A
provider that cannot produce a descriptor leaves the review with nothing that can read the change,
which the selection step in D5 handles by refusing.

Alternative rejected: put local git inside the GitHub provider. It is the one place the project's
architecture rule forbids — behavior above the data layer would depend on which platform a pod
targets, and GitLab would need the identical code written twice.

Alternative rejected: give the harness a `useLocalGit` branch at each call site. That is provider
identity by another name, spread across every tool.

### D3: The extension owns the object cache; the reviewer's clone is never touched

**Never the workspace repository.** The open workspace folder is the reviewer's own repository, and
reading it is not free. Fetching into it writes objects and moves `FETCH_HEAD` in a repository
someone is working in. Its configuration can carry `diff.external`, textconv filters, hooks paths and
alternates, any of which changes what a diff says or executes code the extension did not choose. Its
`git gc` can run at any moment, concurrently with our reads. And most of the time it is not the
repository under review at all — reviewing another team's pull request has nothing to do with the
folder that happens to be open. The saving would be 2.1 MB. Rejected outright, including the weaker
form of using it as an `--reference`/alternates donor: that makes the cache silently unreadable the
day the reviewer deletes or repacks that directory.

**Layout.** One bare repository per `providerId + instanceUrl + repoId`, under the extension's own
global storage directory, in a subdirectory named by the hex SHA-256 of those three joined values —
path-safe, case-stable, and free of the separators a `repoId` contains. `git init --bare` and
`core.bare=true`: no working tree is ever created, and every answer comes from the object database by
commit id. A sibling metadata file records the plain identity, last-used time and directory size for
diagnostics and eviction. No credential is ever written into the cache, and `credential.helper` is
set empty so git cannot persist one either.

**Reachability.** Each pinned commit is fetched under its own ref, `refs/codeverdict/<sha>`. A bare
sha fetch would otherwise leave the objects dangling and eligible for pruning. The ref name is
derived from the sha, so two attempts wanting the same commit write the same value and cannot race
into a wrong state.

**Concurrency.** Two reviews of one repository share one bare repository. Reads (`diff`, `show`,
`grep`, `rev-parse`) take no lock and run concurrently — the object database is append-only and
content-addressed. Only acquisition serializes, through a per-directory lock file with a bounded
wait; a waiter whose refs already exist when the lock frees skips its own fetch.

**Bounds and eviction.** Each attempt holds a lease file in the repository directory for its
duration, refreshed as it runs, and treated as stale past the maximum attempt elapsed time. Eviction
runs at activation and after each acquisition: while total cache bytes exceed the configured bound,
delete whole repository directories in least-recently-used order, skipping any with a live lease.
Whole directories only — never individual objects, which would leave a repository that answers some
requests and not others.

Alternative rejected: a cache under workspace storage. Objects are per-repository, not per-workspace;
two windows on the same repository would fetch twice and evict each other's work.

Alternative rejected: a temporary directory per attempt. It throws away the 2.1 MB on every run and
makes a resumed attempt refetch everything.

### D4: Pin `baseSha` to the merge base and record what the field means

`ChangeRequestDiff.baseSha` becomes the merge-base commit for every provider. GitLab already returns
it: `getChangeRequestDiff` maps `diff_refs.base_sha` straight through, and its Compare call already
sends `straight: true` from that commit.

GitHub takes `merge_base_commit.sha` from the compare response — a small scalar field present
regardless of how much of the file list the response truncated, verified present for the measured
change. This costs one added request, because GitHub's `getChangeRequestDiff` does **not** read the
compare endpoint today: it reads `GET /pulls/{n}` for `pull.base.sha` and `GET /pulls/{n}/files` for
the file list, and the pull object carries no merge base at all. The provider already has a private
`compare()` helper — the one the investigation operations use — so the change is to call it for the
snapshot pair and read the merge base from the result, and to declare that field on `GhCompareResult`,
which currently declares only `files`. It stays provider-internal: no new neutral operation, and the
neutral field's doc comment (`src/platform/types.ts`, "The merge-base/target commit this diff is
against") stops describing two different commits as one.

With base pinned to the merge base, the local diff is two-dot `base..head`, which is exactly the
change request's diff and works on a shallow fetch of just those two commits. Three-dot needs the
merge base computed locally, which needs history a shallow fetch does not have — verified: `fatal: no
merge base`. GitLab's provider already sends `straight: true` from the merge base, so this aligns
GitHub to the existing shape rather than introducing a third one.

This fixes a defect that has nothing to do with local git: today, a target branch that moves while a
review is in flight silently changes what "base" meant for that review, because `pull.base.sha` is a
branch tip. A merge base does not move unless the change request itself is rebased.

**Resume compatibility.** `baseSha` is persisted in the run snapshot and compared on resume, so its
meaning changes for records already on disk. The member snapshot gains an explicit
`baseRevisionKind: 'mergeBase' | 'targetBranchTip'`. A stored snapshot without the field reads as
`targetBranchTip` — every snapshot written before this change used the target-branch tip by
construction, so absence is a fact, not an unknown. Resume compares the meaning before it compares
the sha:

- Stored kind differs and the stored sha is not byte-identical to the newly resolved merge base:
  incompatible, with a reason that says the base revision was recorded under the previous meaning.
  The existing reason text, "base revision changed from X to Y", must not be used here — it would
  tell the reviewer their target branch moved when it did not.
- Stored kind differs but the shas are byte-identical (the branch tip was the merge base, the common
  case for an unrebased change): the pair of commits the evidence was computed over is the same, so
  the checkpoint stays compatible and the new attempt records the current kind. In practice this
  rarely decides anything, because a changed investigation source (D5) is independently an
  incompatibility.

Alternative rejected: silently reinterpret the stored sha under the new meaning. It would relabel
evidence computed against one commit pair as evidence for another.

Alternative rejected: bump the snapshot schema version and let every stored checkpoint fail
compatibility. It reaches the right outcome by a blunt route and gives the reviewer an unspecific
reason for a specific change.

### D5: Choose the source once per attempt and record it in the snapshot

Selection happens per member while the immutable snapshot is built, before admission dispatch and
before any model work. There are two outcomes, not three:

1. **Local git**, if a git executable is present, the provider supplied an object-source descriptor,
   the pinned head was obtained and verified, and the merge base was computed against the target
   branch. Acquisition runs here, not at the first tool call, so a run never starts by announcing a
   source it cannot use.
2. **Nothing**: the attempt does not start. It fails before bootstrap with completeness `none` and a
   reason naming what could not be obtained. That is the same shape the harness already uses when the
   minimum bootstrap envelope does not fit.

The provider branch that used to sit between them is gone. So is the third thing selection used to
produce: the base revision arrives from acquisition now rather than from the platform.

**The one exception, and it is not a fallback.** A demo pod reviews sample data that exists in no
repository, behind no remote, with revisions that are not object ids. The host supplies its source
directly (`providers/fixture/demoInvestigationSource.ts`) and selection uses it as given, skipping
the git probe, the descriptor and the fetch. It is recorded as its own source kind, `sample`, so a
snapshot never claims a demo review read a repository. Nothing derives one from a connection and
nothing falls back to it: a connected pod is supplied none, and reads from git or refuses.

The member snapshot records `investigationSource: { kind, contractVersion, capabilitySignature }`
alongside the existing `providerCapabilitySignature`, which stays because the provider still serves
details, head checks and posting. Every evidence source records which source kind produced it, so a
limitation, diagnostic or coverage report can say truthfully where a run's evidence came from.

**A resumed attempt never mixes sources.** A different source kind on resume is an incompatibility
with its own reason. The two sources do not produce interchangeable evidence: the same file's diff
has different bytes and therefore a different digest, and — more seriously — the same change has a
different manifest. A local manifest enumerates 207 files; a provider manifest of the same change
enumerates fewer, or marks entries it cannot serve. Carrying coverage from one into the other would
either overstate or understate what was inspected.

Alternative rejected: choose the source lazily, per tool call, falling back when one fails. Coverage,
evidence digests and the completion gate would then describe a run assembled from two different
views of the change, and no report could say which.

Alternative rejected: a reviewer setting for the source. There is no reviewer-visible trade-off to
make — one source can answer the change and the other cannot, and the host can measure which.

### D6: Bound the provider fallback by detection, not by size — superseded, and why the reasoning still matters

**Superseded.** There is no provider fallback to bound: no forge answers an investigation operation,
so "can this platform serve this change" is a question nobody asks. The serviceability check, its
`pairEvidence`, and the refused-versus-gone disambiguation D8 built on it are all deleted. What
remains true, and is why this section is kept rather than cut, is the measurement and the rule about
`binary` — a state must never be entered on a guess. That rule now lives where the guess used to be
made impossible: the local source reads the content.

The rule as it stood: the provider may serve investigation for a change only when its manifest for
that change is enumerated `complete` **and** contains no entry carrying the truncation shape. That shape is a
manifest entry the platform enumerated but whose content it declined to render: on GitHub, `patch`
absent with `additions`, `deletions` and `changes` all zero; each provider maps its own equivalent.
The check runs at manifest time, before any file is classified, because that is the only point at
which "this forge cannot serve this change" is knowable for the change as a whole rather than one
file at a time.

A file-count threshold cannot work. On the measured change 69 of 207 files carried a usable patch;
the split is a function of the response's total size, which no client can predict from a file count.

**The truncation shape stops meaning binary.** `isBinaryCompareFile` tests exactly the shape a
suppressed patch produces, and `markTerminal(..., 'binary')` is irreversible, so today one guess
makes a readable source file permanently uninspectable. The provider now reports that shape as a
distinct neutral state — an entry the platform can name but cannot serve — which the harness treats
as non-terminal: the file stays classified and uninspected, and the completion gate correctly refuses
to call the run complete. The state exists at both levels, because the shape can also appear
mid-run on a later page or a re-read of a change whose manifest was clean when the run started.

**Consequence worth naming.** A genuinely binary file produces the identical shape at this layer, so
under this rule a change containing one PNG cannot use the provider fallback either. That is not a
side effect to be worked around; it is the root cause stated honestly. A source that cannot
distinguish "binary" from "declined" must not claim either, and only the local source — which reads
the content — can prove binary. The fallback is for small, all-text changes on a forge that served
them completely, which is the case the user's decision describes.

Alternative rejected: fetch the raw blob for each ambiguous entry and sniff for NUL bytes. One extra
request per file, for content the forge just declined to diff, and a NUL sniff is itself a guess. It
would recover the label without recovering the diff.

Alternative rejected: trust `changes` or a size heuristic to separate the two. Both are zero in both
cases; that is the whole problem.

### D7: Build every git invocation as a validated argument array in a sanitized environment

Paths and search queries reaching this source come from the model, and the model is steerable by
change-request text this project already treats as untrusted. No shell is involved and none is
needed: git's own options are the attack surface. Verified against a real repository —

    git diff --numstat -M <base>..<head> '--output=/tmp/pwned.txt'     -> wrote 7,842 bytes to /tmp
    git diff --numstat -M <base>..<head> -- '--output=/tmp/pwned.txt'  -> inert, treated as a path

One missing `--` turns a read into an arbitrary file write. The rules are structural, so that a call
site cannot forget one:

- Spawn with an argument array and no shell. There is no code path in this source that builds a
  command string.
- Every pathspec follows `--`. Every search pattern follows `-e`. Both are enforced by the one
  function that builds an invocation, not by each caller.
- `GIT_LITERAL_PATHSPECS=1`, so a model-supplied path beginning with `:` cannot become pathspec magic
  (`:(exclude)`, `:/`).
- Revisions are validated as full hex object ids before use, and passed as their own arguments. A
  ref name is never accepted from any caller.
- Paths are refused before git sees them: absolute paths, Windows drive-letter and UNC prefixes, any
  `..` component, a leading `-`, NUL and other control bytes, and anything that does not normalize to
  a repository-relative path. Git refuses most of these itself, but its refusal is a raw error string
  that would reach the model; the source's own refusal states a truthful, bounded reason.
- The neutral `query` is a literal. Both existing providers treat it as a substring, so
  `searchRepository` is `git grep -F -e <query>` and never a regular expression from the model.
- `searchDiff` scans the bounded diff host-side, matching both providers' precedent and producing the
  per-line `DiffPosition` the result type needs. `git diff -G` selects whole files by regular
  expression, which is neither. If it is later used as a prefilter, the literal must be regex-escaped
  and attached to the flag as `-G<pattern>` so a leading dash cannot be read as an option.

The child environment is constructed, not inherited:

- `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` point at an empty path, so no user or system git
  configuration applies. That closes `diff.external`, textconv filters, `core.fsmonitor`, aliases and
  credential helpers as ways for the machine's own configuration to change what a review sees or to
  run a command.
- The editor's own proxy configuration is applied explicitly as `-c http.proxy=…` when set, because
  ignoring global config also ignores the proxy a corporate machine depends on.
- `GIT_TERMINAL_PROMPT=0`, with askpass disabled, so a credential problem fails fast instead of
  leaving a child process waiting forever on a prompt nobody can see.
- `LC_ALL=C`, so error classification does not depend on the machine's locale.
- The authorization header from the object-source descriptor is passed as `http.extraHeader` through
  `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` — **the environment, never argv**. On
  Linux `/proc/<pid>/cmdline` is world-readable and `environ` is not. The credential is never
  embedded in the URL either, because git echoes URLs in its error text and that text is a
  model-visible channel.
- The descriptor's URL is accepted only with an `http`/`https` scheme, with the other transports
  refused (`ext::` in particular executes a command).
- Every invocation has a wall-clock timeout and a stdout byte cap, and the child is killed at either.
  `-z` (NUL-delimited) output is used where git offers it, so a path with a newline or a quote cannot
  desynchronize parsing.

Testing: the existing marker-string sink convention is extended to this source. A planted marker in a
model-supplied path, in a search query, and in the credential value must appear in no activity event,
checkpoint, diagnostic record, error reason or stored record. Two structural tests are added
alongside: no invocation is built with a shell, and every invocation that carries a pathspec contains
`--` before it.

### D8: Give every acquisition failure a truthful state, and none of them a clean review

| Condition | State | What happens |
| --- | --- | --- |
| No git executable | Local source unsupported | The attempt does not start; recorded as a limitation so the run says why |
| Network or DNS failure during fetch | Retryable acquisition failure | Bounded retry under the harness's existing backoff policy, then unsupported |
| Credentials refused by the remote | Non-retryable acquisition failure | Mapped to the existing normalized auth failure so the sign-in surface can act; the attempt does not start |
| Pinned commit not fetchable by sha after the ref-hint retry | Revision not obtainable, existence unproven | The remote may be declining fetches of unadvertised objects, or the commit may be gone; nothing left can tell. The attempt does not start, the reason names the revision and the refusal, and the stored checkpoint stays compatible |
| Pinned head confirmed gone from the remote — **unreachable**, nothing can confirm it | Revision not obtainable, head side | The head named by the snapshot no longer exists on the remote — the same condition the completion gate already treats as a stale snapshot. The attempt does not start; on resume the checkpoint is incompatible |
| Pinned base confirmed gone from the remote — **unreachable**, nothing can confirm it | Revision not obtainable, base side | Investigation cannot be pinned. The run refuses; no other commit is substituted |
| Pinned commit not fetchable and its absence not established | Revision not obtainable, existence unproven | The attempt does not start, with a reason naming the revision and that its absence was not established. The checkpoint is not declared incompatible, because a stale snapshot was not proven |
| Remote reachable but the fetched object is not the pinned sha | Hard failure | Never accepted. Verified with `rev-parse <sha>^{commit}` after every fetch |
| No object-source descriptor from the provider | Local source unsupported for that repository | The attempt does not start |
| Cache directory unwritable or disk full | Local source unsupported | Recorded; the attempt does not start |
| An invocation exceeds its timeout or output cap | Bounded non-terminal result | `truncated` or a non-terminal unavailable; repeated failures consume retry budget and become a limitation. Never a terminal file state |

**Force-pushed heads, and the ref hint.** A commit that is unreachable from any ref may still be
fetchable by bare sha (GitHub allows it; some servers disable
`uploadpack.allowAnySHA1InWant`). When the bare-sha fetch fails, the local source retries with the
optional ref hint from the object-source descriptor, as an opaque extra refspec it does not interpret,
and then verifies that the object it received is the pinned sha. This is how `refs/pull/N/head` gets
used without the neutral contract learning that such a thing exists: the forge-shaped knowledge stays
inside the provider that composed the descriptor, and the verification is by object id, so a wrong
hint cannot substitute a different commit.

**Telling a refused fetch from a commit that is gone — no longer attempted.** The two look alike
from git's side, and the only thing that could separate them was a forge manifest at the pinned pair
— which is a diff computation, and is exactly what this change removed. So nothing is entitled to
say a commit is gone, and nothing says it: a fetch that failed ends the attempt with the reason it
failed, and a stored checkpoint is never declared incompatible on an unproven claim. That is
strictly the safer half of what follows, which is kept for the reasoning rather than the outcome.

The reasoning as it stood. A server
with `uploadpack.allowAnySHA1InWant` off refuses a want for an unadvertised object without looking
the object up, so its refusal says nothing about whether the object exists; a server that allows the
fetch answers a missing object with a different error, but that text is not a contract across
servers, versions and configurations. The local source therefore does not read git's error to decide.
When the bare-sha fetch and the ref-hint retry have both failed, the host asks the provider for the
change at the same pinned pair — the D6 serviceability check it must run before using the provider
anyway. One request answers both questions:

- **A manifest for that pair comes back.** The forge computed a diff at those exact commit ids, so
  both commits exist and the fetch was refused by the remote's policy rather than aimed at a commit
  that is gone. If that manifest is `complete` with no declined entry, selection moves to the
  provider under D6, like every other fallback row. If it fails D6's bound in either way — a declined
  entry, or enumeration that is not complete — the fallback is unserviceable and no source can serve
  the member: D5's third branch applies, and the reason names both facts — the remote refused the
  fetch, and the provider cannot serve this change — never that the revision is gone.
- **The provider reports the revision not found**, from a connection that is otherwise serving that
  repository. The commit is gone from the forge too, and the head or base row applies. Which side is
  named comes from the local source, which knows which fetch failed; the provider's answer separates
  only gone from refused. The provider establishes the "otherwise serving that repository" half
  itself rather than assuming it: both forges answer the same 404 for a repository the token cannot
  see as for revisions they cannot resolve, so a manifest 404 is followed by one request for the
  repository, and only a repository that answers turns the 404 into not-found. A repository that
  does not answer makes the result unavailable, which is the row below. The extra request is on a
  failure path that has already ended the investigation, and it is made only for the manifest: a
  path-scoped read keeps answering unavailable for an unresolvable pair, because its own not-found
  state already means the path is absent from the change.
- **The provider cannot answer** — unavailable, rate-limited, an authorization failure, or no manifest
  capability at all. None of those say anything about whether the commit exists, so its absence stays
  unproven and the last row applies. There is no second existence check to use instead:
  `getCurrentHead` reports where a branch points now, and a branch that moved does not make the
  pinned commit gone.

Ambiguity resolves toward refusing, because reviewing the wrong code is worse than not reviewing.
None of this weakens verification by id: the local source still verifies every fetched object against
the pinned sha, and the probe is pinned by the same two ids, so neither path can substitute a
different commit. A fallback that changes the source kind on a resumed attempt is the incompatibility
D5 already describes, not a silent switch.

**The invariant across all of these.** No failure path may call `markTerminal` for a state the source
did not prove. An unobtainable revision, a timed-out invocation and a suppressed patch all leave the
affected file classified and uninspected, which the completion gate refuses to call complete. A run
can therefore end partial or failed, but never clean.

Two things had to change for that last sentence to be true, and both are recorded here because
neither is obvious from the state machine alone.

The gate refuses such a file **at every risk level**, not only where a coverage rule demands
inspection. Leaving it to the risk floors makes the guarantee depend on the file's extension — a
failed read of a `.ts` file is refused through the source-code floor while the identical failure on
a `.md` file is not — and a low-risk file whose diff nobody served left the gate eligible with zero
blockers. So a read that establishes nothing is recorded against the file as its own fact, exactly
as a declined read already was, and the gate blocks on it by name. The two facts stay separate
because a reviewer can act on the difference: a source that declined will decline again, while a
read that failed may succeed on the next turn, so only the second is a repairable blocker.

A terminal state **replayed from a stored checkpoint** is re-applied only where the source serving
the new attempt states the same condition. Stopping the wrong mapping at the point the guess was
made does not reach guesses already written to disk, and `binary` is the one terminal state the gate
counts as satisfied — so replaying a checkpoint from the earlier build reproduced the whole
complete-and-clean outcome on the resumed attempt. Corroboration is against the current source's own
freshly enumerated entry rather than against a marker recording which build wrote the record: every
source that answers a read with `binary` also flags `binary` on its manifest entry, so a record that
was right is still replayed and a reviewer's resumable work survives, while one the current source
will not stand behind is reopened as classified and unread.

Head-change detection stays with the provider throughout. The forge is authoritative for "has the
branch moved"; the local cache only knows what it was told to fetch.

### D9: The local source declares `repositorySearch`; the policy gate is untouched

The local source declares `repositorySearch: { supported: true }`, backed by `git grep` at an
explicit commit id. GitHub declares it unsupported because `/search/code` indexes only a repository's
default branch and takes no ref parameter, so it cannot answer for a revision at all. GitLab declares
it supported and pins it with `ref`, but the underlying feature needs Advanced Search or Exact Code
Search on the instance and reports `unavailable` at call time where that is absent. The local source
is the only one that can answer a revision-pinned search on every deployment.

This is a capability, and it is separate from `scopeInvestigationToChangedFiles`, which withholds
`fileReads` and `repositorySearch` from the model as policy. The order stays: the source declares
what it can do, then the narrowing seam turns a declared `true` into `false` for the policy.

**The default flipped, to off.** It was `true` when every unchanged-file read was a metered,
rate-limited API call and `resolvePolicy` was a chain of them per changed path. A review reads from a
bare object store now, and the two shallow fetches that store holds contain every file in the
repository at those commits — shallow is shallow in *history*, not in content. Measured on this
product's own 207-file change: 465 files present in the store, `git show <sha>:src/ui/theme.ts`
returning 753 lines for a file the change never touched. Reading one of them is a local file read, so
the cost that justified scoping does not exist while the benefit does. The setting stays for a
reviewer who wants the narrow behaviour; `true` gets exactly what the old default gave.

One guard becomes load-bearing as a result, and is tested directly for the first time: only a *diff*
read inspects a changed file. A `readFile` of a changed path spends evidence bytes and moves coverage
not at all, because a whole file says nothing about what this change did to it.

The snapshot's capability signature continues to record the effective set, so a resumed attempt
cannot silently gain a tool the original attempt did not have.

### D10: Prove the merge base before accepting it, from the shallow boundary

`git merge-base` computes over the history the store holds and cannot say which history that was. In
a shallow store it answers an *older* common ancestor — exit 0, an object id, nothing wrong on the
face of it — whenever the real merge base sits past the boundary on one side. The ladder in 11.6
deepened only when the answer was *empty*, so a wrong answer ended the search. Measured on
2026-09-11 through `createObjectCache` with the default policy, git 2.55.0, against a real
`git-http-backend` remote, on a head that is a merge commit reaching an older common ancestor in two
steps while its true merge base sits fourteen commits back:

    DEFAULT-POLICY OUTCOME {"state":"acquired","baseSha":"4dd2d4b…","depthReached":10}
    TRUE MERGE BASE = 542cc47…   ACCEPTED BASE = 4dd2d4b…

The review then reads a diff against an older commit than the change request is against, with every
commit in between presented as part of the change, and says nothing about it. That is the failure
this whole line of work exists to prevent, arriving from inside the thing that replaced the forge.

**The property.** The accepted base is the commit a full clone would report. Nothing weaker is worth
having: a base that is merely *a* common ancestor produces a diff nobody asked for.

**The rule.** A candidate is proved when no *truncation point* lies strictly above it — where a
truncation point is a commit this store walks as parentless that records parents of its own.

**Why it is sufficient.** `merge-base` returns the best common ancestor of the graph it can see, and
every edge it can see is a real edge, so its answer is always a real common ancestor. It can be the
*wrong* one only if a better common ancestor was invisible: absent from the store, or present but cut
off from one of the two tips. Both need a truncation point between a tip and that better ancestor,
and a better ancestor is not an ancestor of the candidate, so neither is that truncation point. No
truncation point above the candidate therefore means no better common ancestor exists at all, and the
best visible answer is the best answer. A store with no shallow boundary left needs none of this: its
history is the repository's history.

**Why "the answer did not change when we deepened" is not the rule.** It is evidence, not proof: a
true merge base two rungs deeper leaves the same wrong answer standing across one deepening, and the
ladder would accept it with exactly the confidence it accepts a right one.

**Reading the boundary.** A shallow graft hides a commit's parents from every traversal — `rev-list`,
`rev-parse <sha>^1`, `log --format=%P` all answer as if there were none — so no walk can tell a
truncation point from a repository's genuine root commit. The commit *object* is not grafted, and
`cat-file commit` shows its real `parent` headers. That distinction is not academic: a repository
that merged an unrelated history has a real root above the merge base, and treating it as a
truncation would refuse a review that could be proved.

**Cost.** The ladder is unchanged — 10, then x10 twice, bounded at 1000 — because the proof costs no
network. It is one local `rev-list --max-parents=0` per rung plus one `cat-file` per parentless commit
above the candidate, which on an ordinary change is none: measured, an ordinary change proves its
merge base on the first rung with the store still shallow.

**At the bound.** A candidate that cannot be proved is its own failure state (`mergeBaseUnproven`),
separate from "no common ancestor exists" (`mergeBaseNotFound`), and neither substitutes a commit.

### D11: Which pod is handed a source is the pod's question, never the agent's

The host supplies an investigation source for the one pod whose change exists in no repository
(11.10). That decision shipped keyed on the run's `demo` flag — and `demo` is set from the selected
*agent*, not the pod (`ui/reviewFlow.ts`: `agentId === DEMO_AGENT_DESCRIPTOR.id`). The demo agent is
in `BUILT_IN_AGENTS` and is offered on every pod, so choosing it on a real GitHub or GitLab change
request handed the review the built-in sample dataset. The sample registry is keyed by head sha, so a
real head matched nothing: the manifest answered notFound, every read answered unavailable, and the
run could not complete. It failed honestly rather than inventing findings, and it failed on a pod
where the demo agent used to work.

The wiring is keyed on the pod's provider instead. The demo agent then runs on a connected pod like
any other agent, against the local object store: it is a `HarnessParticipant` that reacts to tool
results, deriving its deterministic findings from the patch bytes a `readDiff` returns, so a real
diff is exactly what it wants. The alternative — offering the demo agent only on a demo pod — was
rejected because it removes a capability from reviewers to work around a wiring mistake.

The same flag also gated whether the run got an object cache at all, one line below, which is the
same bug: that is keyed on whether a source was supplied.

## Risks / Trade-offs

- [A machine without git, or with a very old git] -> Version is probed once per session and recorded;
  the source declares itself unsupported rather than failing mid-run, and the required minimum is a
  version that supports `--literal-pathspecs`, `-z` numstat and `GIT_CONFIG_GLOBAL`.
- [Ignoring global git config also ignores a corporate proxy] -> The editor's own proxy setting is
  applied explicitly per invocation; a machine that only configures its proxy in `~/.gitconfig` sees
  the fetch fail with a network reason and falls back under D5.
- [Object cache growth on a machine that reviews many repositories] -> Whole-directory LRU eviction
  under a byte bound, leases prevent evicting an active attempt, and shallow per-commit fetches keep
  each addition small.
- [Two windows or two runs racing on one cache directory] -> Reads need no lock; only acquisition
  serializes, and refs are named by the sha they contain so concurrent writers agree by construction.
- [Model-supplied strings reaching a git argument] -> One invocation builder, structural `--`/`-e`
  placement, literal pathspecs, pre-git path refusal, and marker tests over every sink.
- [The credential appears in a process listing or an error string] -> Header via environment, never
  argv and never in the URL; a marker test covers the credential value specifically.
- [Merge-base pinning invalidates checkpoints written before this change] -> `baseRevisionKind` makes
  the reason specific and truthful, and the reviewer is offered a restart rather than a silently
  reinterpreted resume.
- [The provider fallback becomes unavailable for any change containing binary content] -> Accepted
  and documented; it is the honest consequence of a forge that cannot distinguish binary from
  declined, and the local source handles those changes.
- [A first review of a large repository pays a fetch before any model work] -> Measured at 2.1 MB for
  a 207-file change; later reviews of the same repository fetch only the new commits, and acquisition
  is reported as a phase so the delay is visible rather than mysterious.
- [Shallow fetches accumulate disconnected roots in the cache] -> A diff compares two trees and needs
  no history between them, so disconnected shallow commits answer correctly; repacking happens under
  eviction, never during an attempt.

## Migration Plan

1. Extract `InvestigationSource` from the neutral contract; `Connection` satisfies it unchanged. Add
   the object-source descriptor operation and implement it for GitHub, GitLab and the fixture
   provider.
2. Add the neutral declined-content state to the investigation result contract and to the
   conformance suite. Stop mapping the truncation shape to `binary` in the GitHub mappers; map it to
   the new state. Add the harness rule that the new state is non-terminal.
3. Change `getChangeRequestDiff` on GitHub to return `merge_base_commit.sha` as `baseSha`, correct the
   neutral field's documented meaning, and add `baseRevisionKind` to the member snapshot with absence
   reading as `targetBranchTip`. Extend resume comparison with the meaning check before the sha check.
4. Implement the git process seam: invocation builder, sanitized environment, timeouts, output caps,
   argument validation, and its adversarial and marker tests. No investigation operation is wired yet.
5. Implement the object cache: layout, acquisition, ref pinning, verification, leases, locking and
   eviction.
6. Implement the five operations against the cache, running the same provider conformance suite the
   providers run, plus local-only cases (proven binary, rename detection, deleted file at base).
7. Wire source selection into the snapshot builder, record it, and extend resume compatibility with
   the source-kind check. Add the D6 serviceability check to the provider path, including its second
   use: deciding whether a refused fetch means the commit is gone or only that the remote would not
   serve it by id.
8. Extend activity, limitations and the coverage report to name the source that produced the evidence.

Rollback keeps the stored fields additive: an older build ignores `investigationSource` and
`baseRevisionKind`, and treats those checkpoints as incompatible rather than resuming them under the
wrong meaning, because the snapshot's own comparison already fails.

## Configurable Initial Defaults

Versioned policy values, not product semantics; tests inject their own.

| Policy | Initial default |
| --- | --- |
| Object cache total size | 2 GiB |
| Cache entry idle lifetime | 30 days |
| Fetch timeout per acquisition | 120 seconds |
| Timeout per read invocation (`diff`, `show`, `grep`) | 30 seconds |
| Stdout cap per invocation | 64 MiB, child killed at the cap |
| Acquisition lock wait | 60 seconds |
| Lease staleness threshold | The maximum attempt elapsed time, currently 30 minutes |
| Fetch depth, first rung | 10, on the pinned head and the target branch together |
| Merge-base depth escalation | x10, twice: 10, 100, 1000 |
| Merge-base depth bound | 1000, the same ceiling the invocation seam refuses a fetch above |
| Retries per acquisition | The harness's existing transient-failure policy |

## Open Questions

- Whether repacking the cache (`git gc`) should run on a schedule as well as under eviction. Shallow
  single-commit fetches produce small packs; whether many of them degrade read latency enough to
  matter is a measurement to take after the source is running.
- Whether a later capability should expose the object store to non-review features (history, blame).
  Nothing in this design prevents it, and nothing here assumes it.
- Whether the object-source descriptor should carry more than one ref hint for forges where a
  change request has several server-side refs. One hint covers the measured case.
