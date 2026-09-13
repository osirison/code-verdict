## 1. Baseline And Characterization

- [x] 1.1 Land `add-agentic-review-harness` first: it defines `InvestigationSnapshotRef`, the five operations on `Connection` (`listChangedFiles`, `readDiff`, `readFile`, `searchRepository`, `searchDiff`), the `InvestigationResult<T>` envelope in `src/platform/types.ts`, and `ReviewInvestigationCapabilities` in `src/platform/provider.ts`. Confirm its suite passes unchanged before starting here.
- [x] 1.2 Add a characterization test over `isBinaryCompareFile` in `src/providers/github/mappers.ts` that records today's behavior: an entry with `patch === undefined` and zero `additions`/`deletions` is reported binary. It is the regression this change removes, and the test is rewritten in 3.3 rather than deleted.
- [x] 1.3 Add a characterization test over `harnessAttempt.ts`'s read-result switch (the `case 'binary'` arm that calls `inventory.markTerminal(memberId, path, 'binary', …)`) proving a `binary` result closes a file irreversibly today.
- [x] 1.4 Add fixtures for the shapes this change turns on: a GitHub compare response whose entries carry no `patch` and zero counts, a two-commit local repository with an added, a deleted, a modified, a renamed and a genuinely binary file, and a text file whose diff exceeds the read bound.
- [x] 1.5 Record the current persisted member-snapshot shape (with `providerCapabilitySignature` and `baseSha`, without `investigationSource` or `baseRevisionKind`) as a migration fixture, so 9.7 can prove absence is read as the pre-change meaning.

## 2. Neutral Contract: Investigation Source And Object-Source Descriptor

- [x] 2.1 Extract an `InvestigationSource` interface beside the five request/result types (declared in `src/platform/types.ts`, wired onto `Connection` in `src/platform/provider.ts`) carrying exactly `listChangedFiles`, `readDiff`, `readFile`, `searchRepository` and `searchDiff`, plus a declared `ReviewInvestigationCapabilities`. Note that all five are **optional** on `Connection` today (`listChangedFiles?(…)`), so a provider does not structurally satisfy an interface whose members are required: decide once here whether `InvestigationSource` keeps them optional or whether a narrowing helper turns a `Connection` into one, and record the choice. No provider changes as a result.
- [x] 2.2 Keep `getChangeRequestDetails`, `getIssueDetails`, `getCurrentHead`, checks and posting off `InvestigationSource`. Add a test that fails if any of them is added to it.
- [x] 2.3 Add a neutral object-source descriptor type — fetch location, optional credential value, optional opaque ref hint — and an optional `Connection` operation returning it or an explicit unavailable reason. Nothing in the type may require a caller to know which platform produced it.
- [x] 2.4 Implement the descriptor on GitHub (`src/providers/github/githubProvider.ts`), GitLab (`src/providers/gitlab/gitlabProvider.ts`) and the fixture provider (`src/providers/fixture/fixtureProvider.ts`). GitHub's ref hint is `refs/pull/{n}/head`; GitLab's is `refs/merge-requests/{iid}/head`. The forge-shaped knowledge stays inside each provider.
- [x] 2.5 Add a conformance case to `src/platform/contract/providerContract.ts` requiring every provider either to return a descriptor with an `http`/`https` fetch location or to report it unavailable with a reason — never to return a descriptor a caller must interpret.
- [x] 2.6 Add a test that the credential value in a descriptor never appears in any provider log, activity event or error string.

## 3. The Declined-Content State

- [x] 3.1 Add a declined-content state to `InvestigationState` and to the `InvestigationResult<T>` union in `src/platform/types.ts`, for an entry the platform enumerated but whose content it would not render. Document it as non-terminal at the point of definition.
- [x] 3.2 Add the same state to the changed-file manifest entry type, so a manifest can carry it per file rather than only per result.
- [x] 3.3 Replace `isBinaryCompareFile` in `src/providers/github/mappers.ts`: the `patch === undefined` + zero-counts shape maps to declined-content, and `binary` is produced only where GitHub actually states it. Update `toChangedFileEntry` and the two call sites in `githubProvider.ts` (the `readDiff` early return and the `searchDiff` skip) to carry the new state. Rewrite the 1.2 characterization test to assert the new mapping.
- [x] 3.4 Map GitLab's equivalent — a compare entry with `compare_timeout` or an entry marked `too_large` with no diff body — to the same neutral state in `src/providers/gitlab/mappers.ts`.
- [x] 3.5 Make the declined-content state non-terminal in `harnessAttempt.ts`'s read-result switch: the file stays classified and uninspected, and `markTerminal` is not called. Rewrite the 1.3 characterization test against the new behavior.
- [x] 3.6 Add a completion-gate test proving a run with one declined-content file cannot be reported complete, and that its coverage names the file as uninspected.
- [x] 3.7 Extend `src/platform/contract/providerContract.ts` with a conformance case for the new state, and add it to the fixture provider so harness tests can produce it deterministically.

## 4. Provider Serviceability

- [x] 4.1 Add a provider serviceability check that runs at manifest time: a provider may serve investigation for a change only when the manifest is enumerated `complete` and no entry carries declined-content. Put it above the provider boundary, keyed on the neutral manifest result, so it works for every provider.
- [x] 4.2 Wire the check into source selection (9.1): a provider that cannot serve a change is not selectable for it, and the reason names the condition.
- [x] 4.3 Test the honest consequence: a change containing one genuinely binary file, served by a provider that cannot distinguish binary from declined, is unserviceable by that provider. This is the documented trade-off in design D6, not a bug to route around.
- [x] 4.4 Test that the capability declaration itself stays unchanged when a single change is unserviceable — declarations describe the provider, not one change.

## 5. Base Revision Pinned To The Merge Base

- [x] 5.1 Change GitHub's `getChangeRequestDiff` (`src/providers/github/githubProvider.ts`) to report `baseSha` as the merge base. It currently reads `pull.base.sha` from `GET /pulls/{n}` and never calls the compare endpoint, so this adds one call through the provider's existing private `compare()` helper and requires `merge_base_commit` to be declared on `GhCompareResult` in `src/providers/github/mappers.ts`, which today declares only `files`.
- [x] 5.2 Leave GitLab's `getChangeRequestDiff` alone — `toChangeRequestDiff` already maps `diff_refs.base_sha`, the merge base — and add a test pinning that as intentional rather than incidental.
- [x] 5.3 Correct the doc comment on the neutral `baseSha` field in `src/platform/types.ts` ("The merge-base/target commit this diff is against") to name one commit: the merge base.
- [x] 5.4 Add `baseRevisionKind: 'mergeBase' | 'targetBranchTip'` to the member snapshot in `src/domain/reviewRunSnapshot.ts`, with absence on a stored record reading as `targetBranchTip`.
- [x] 5.5 Add a contract test that a merge base does not move when the target branch does: two `getChangeRequestDiff` calls across a target-branch advance return the same `baseSha`.
- [x] 5.6 Extend `fakeGitHub.ts` with a compare response carrying `merge_base_commit`, and `fakeGitLab.ts` where its fixture needs the matching shape.

## 6. The Git Process Seam

- [x] 6.1 Create a git invocation module with one builder that every call site must go through. It spawns with an argument array and never a shell string, and there is no code path in it that concatenates a command.
- [x] 6.2 Enforce placement structurally in the builder, not at call sites: every pathspec is emitted after `--`, every search pattern after `-e`. A caller supplies paths and patterns as typed fields; it cannot position them itself.
- [x] 6.3 Validate revisions as full hex object ids before they reach an argument. Reject ref names, abbreviated ids and anything else, from every caller.
- [x] 6.4 Refuse paths before git sees them: absolute paths, Windows drive-letter and UNC prefixes, any `..` component, a leading `-`, NUL and other control bytes, and anything that does not normalize to a repository-relative path. The refusal reason is the source's own bounded text, never raw git error output.
- [x] 6.5 Construct the child environment rather than inheriting it: `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM` pointing at an empty path, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0` with askpass disabled, `LC_ALL=C`, and `credential.helper` set empty.
- [x] 6.6 Pass the descriptor's credential as `http.extraHeader` through `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` in the environment. It never enters argv and never enters a URL.
- [x] 6.7 Apply the editor's own proxy setting explicitly as `-c http.proxy=…` when one is configured, since ignoring global config also ignores the machine's proxy.
- [x] 6.8 Give every invocation a wall-clock timeout and a stdout byte cap, killing the child at either, and returning a bounded non-terminal result. Use `-z` output wherever git offers it so a path containing a newline or a quote cannot desynchronize parsing.
- [x] 6.9 Probe the git version once per session and record it. Declare the source unsupported when git is absent or older than the minimum that supports `--literal-pathspecs`, `-z` numstat and `GIT_CONFIG_GLOBAL`.
- [x] 6.10 Adversarial test — argument injection: a path of `--output=<tmp>/pwned.txt` passed through `readDiff` writes no file. The test fails if the builder emits it before `--`.
- [x] 6.11 Adversarial test — pattern injection: a search query beginning with `-` is matched literally and never parsed as an option, and `searchRepository` uses `git grep -F -e <query>` so a model-supplied string is never compiled as a regular expression.
- [x] 6.12 Adversarial test — pathspec magic: a path beginning with `:` (`:(exclude)…`, `:/…`) matches literally and cannot widen, exclude or re-root the operation.
- [x] 6.13 Adversarial test — path refusal: absolute, `..`-escaping, drive-prefixed and control-byte paths are refused by the source before git is invoked, and the returned reason is the source's own text.
- [x] 6.14 Structural test: no invocation in this module is built with a shell. Assert over the module's own source that it imports no shell-executing entry point and passes an array everywhere.
- [x] 6.15 Structural test: every invocation carrying a pathspec contains `--` before it, and every invocation carrying a pattern contains `-e` before it. Drive it over the builder's output for all five operations, not over hand-written argument lists.
- [x] 6.16 Marker-string sink test: plant a distinct marker in a model-supplied path, in a search query and in the credential value, then assert none appears in any activity event, checkpoint, diagnostic record, error reason or stored record. Extend the existing marker convention rather than inventing a second one.
- [x] 6.17 Test that machine configuration cannot change a result: with `diff.external`, a textconv filter, an alias and a credential helper defined in the ambient config, every invocation produces the same output as with none of them.
- [x] 6.18 Test that an invocation which would prompt fails promptly with a stated reason and leaves no process waiting.
- [x] 6.19 Validate the descriptor's fetch location inside the local source before any fetch: accept `http` and `https` only, and refuse every other transport — `ext::` in particular runs a command of the remote's choosing. A refused transport makes the source unavailable for that repository with a stated reason. Test each refused scheme, including `ext::`, `file`, `ssh` and `git`.

## 7. The Object Cache

- [x] 7.1 Create the cache under the extension's own global storage directory, one bare repository per `providerId + instanceUrl + repoId`, in a subdirectory named by the hex SHA-256 of those three values joined. Initialize with `git init --bare` and `core.bare=true`.
- [x] 7.2 Write a sibling metadata file per entry recording the plain identity, last-used time and directory size, for diagnostics and eviction.
- [x] 7.3 Implement acquisition: fetch each pinned commit to depth 1 under its own ref `refs/codeverdict/<sha>`, so the objects are reachable and not prunable, and two attempts wanting the same commit write the same ref value.
- [x] 7.4 Verify every fetched object with `rev-parse <sha>^{commit}` before reporting acquisition successful. A remote that returns a different object is a hard failure and its object is never used.
- [x] 7.5 Implement the ref-hint retry: when a bare-sha fetch fails, retry with the descriptor's opaque ref hint as an extra refspec, then verify against the pinned sha. A hint that yields another commit fails with a named mismatch.
- [x] 7.6 Serialize acquisition per directory with a lock file and a bounded wait. Reads take no lock. A waiter whose refs already exist when the lock frees skips its own fetch.
- [x] 7.7 Implement per-attempt lease files in the repository directory, refreshed while the attempt runs, treated as stale past `maxAttemptElapsedMs` (currently 30 minutes, `src/domain/harnessPolicy.ts`).
- [x] 7.8 Implement eviction at activation and after each acquisition: while total cache bytes exceed the configured bound, delete whole repository directories in least-recently-used order, skipping any with a live lease. Never delete individual objects.
- [x] 7.9 Add the configurable defaults as injectable policy values, not constants at call sites: cache bound 2 GiB, entry idle lifetime 30 days, fetch timeout 120 s, read timeout 30 s, stdout cap 64 MiB, lock wait 60 s, fetch depth 1.
- [x] 7.10 Test that the reviewer's workspace repository is never read, written, fetched into, or used as an alternates donor, including when the repository under review is the open workspace folder.
- [x] 7.11 Test concurrency: two attempts on one repository are both served, the shared commit is fetched once, and neither corrupts nor blocks the other.
- [x] 7.12 Test that an unwritable or full cache location makes the source declare itself unavailable with that reason and write nothing anywhere else.
- [x] 7.13 Test that eviction never leaves a repository holding some of its pinned commits and not others.

## 8. The Local Source's Five Operations

- [x] 8.1 Implement `listChangedFiles` as `git diff --numstat -z -M <base>..<head>` over the cache, reporting added, deleted, modified and renamed kinds, old and new paths for a rename, and per-file line counts.
- [x] 8.2 Implement `readDiff` as a bounded per-file diff at the pinned pair, paginating through the same cursor contract the providers use.
- [x] 8.3 Implement `readFile` as `git show <sha>:<path>` at an explicitly requested base or head commit, bounded to a line range.
- [x] 8.4 Implement `searchRepository` as `git grep -F -e <query>` at an explicit commit id, returning path and location identity sufficient for a later bounded read, with a stated bound and continuation.
- [x] 8.5 Implement `searchDiff` by scanning the bounded diff host-side to produce per-line positions. Do not use `git diff -G`, which selects whole files by regular expression and produces neither the positions nor the literal matching the contract requires.
- [x] 8.6 Report binary only from git's own content determination, and report a size, time or output-bound stop as a distinct bounded state that is never binary.
- [x] 8.7 Declare `repositorySearch: { supported: true }` on the local source, and test that the declaration is independent of `scopeInvestigationToChangedFiles` — the policy still withholds the tool, and `effectiveCapabilities` in `src/app/harnessRuntime.ts` is unchanged.
- [x] 8.8 Run the shared provider conformance suite in `src/platform/contract/providerContract.ts` against the local source, unchanged.
- [x] 8.9 Add local-only conformance cases the providers cannot satisfy: a proven binary file, a detected rename, a deleted file read at base, and a 200-plus-file manifest that enumerates every entry with no declined-content state anywhere.

## 9. Source Selection, Snapshot And Resume

- [x] 9.1 Select the investigation source once per member while the immutable snapshot is built, before admission dispatch and before any model work: local git when git is present, a descriptor was supplied, and both commits were obtained and verified; otherwise the provider when it declares the capabilities and can serve the change (4.1); otherwise neither.
- [x] 9.2 Run acquisition inside selection, not at the first tool call, so a run never announces a source it turns out not to have.
- [x] 9.3 When neither source can serve a member, end the attempt before bootstrap with completeness `none` and a reason naming what could not be obtained, matching the shape the harness already uses when the minimum bootstrap envelope does not fit.
- [x] 9.4 Record `investigationSource: { kind, contractVersion, capabilitySignature }` on the member snapshot alongside the existing `providerCapabilitySignature`, which stays because the provider still serves details, head checks and posting.
- [x] 9.5 Extend resume comparison in `src/app/harnessResume.ts`: compare `baseRevisionKind` before `baseSha`, and compare `investigationSource.kind`. A differing source kind is incompatible with its own reason. A differing base-revision meaning with a non-identical sha is incompatible with a reason that says the base was recorded under the previous meaning — not the existing "base revision changed from X to Y" text, which would report a target-branch move that did not happen.
- [x] 9.6 Handle the byte-identical case: a stored `targetBranchTip` sha equal to the newly resolved merge base leaves the checkpoint compatible on that field alone, and the resumed attempt records the current kind.
- [x] 9.7 Test with the 1.5 migration fixture that a stored snapshot lacking both new fields reads as `targetBranchTip` and provider source, and is compared under those meanings.
- [x] 9.8 Test that evidence, coverage and inspection state are never carried across a source-kind change on resume.
- [x] 9.9 When acquisition fails because a pinned commit could not be fetched, decide the case with the provider rather than with git's error text: run the serviceability check (4.1) for the same pinned pair and read its outcome — a served manifest means both commits exist and the fetch was refused, a not-found means the commit is gone, and any other failure or a missing manifest capability leaves the absence unproven. Do not use `getCurrentHead` for this: a branch that moved does not prove the pinned commit is gone.
- [x] 9.10 Test the outcomes of 9.9: a refused fetch over a servable change selects the provider and records the limitation; a refused fetch over a change the provider cannot serve — a declined-content entry, or enumeration that is not complete — ends the attempt with a reason naming both the refusal and the unserviceable provider, and never that the revision is gone; a confirmed-absent head ends the attempt and makes the checkpoint incompatible; an unproven absence ends the attempt and leaves the checkpoint compatible.

## 10. Reporting And Verification

- [x] 10.1 Record the producing source on every evidence entry, so a coverage report, a limitation or a diagnostic can state truthfully where a run's evidence came from.
- [x] 10.2 Report acquisition as a visible phase in run activity, so a first review of a large repository shows a fetch rather than an unexplained delay.
- [x] 10.3 Record a limitation when the preferred source was unavailable, naming the reason: no git, no descriptor, credentials refused, unwritable cache, a fetch the remote refused for a commit it still holds, or an unobtainable revision.
- [x] 10.4 Map each acquisition failure to the state design D8 assigns it, and test the table row by row: missing git, network failure, refused credentials, a sha fetch refused while the forge still serves the commit, a head confirmed gone from the remote, a base confirmed gone from the remote, a revision whose absence could not be established, wrong object returned, missing descriptor, unwritable cache, and an invocation over its bounds.
- [x] 10.5 Add an assurance test over the measured change's shape: a 207-file all-text manifest is served complete by the local source with zero files reported binary, and the same manifest through the provider path reports the change unserviceable rather than binary.
- [x] 10.6 Add a test that no failure path in this change calls `markTerminal` for a state the source did not prove, so a run may end partial or failed but never clean.
- [x] 10.7 Confirm no code above the provider boundary branches on provider identity to reach the local source, reusing the existing conformance assertion that forbids it.

## 11. The Provider Stops Serving Investigation

The reviewer's rule, in their words: "NEVER request for diff from the provider, ALWAYS clone the
repository locally and identify the changes. Ask the Provider ONLY for DATA that does not exist in
the repo files." It supersedes the fallback this change's own sections 4 and 9 built. What follows is
what that cost.

- [x] 11.1 Take the five revision-pinned operations off `Connection` and off every provider — GitHub, GitLab and the fixture. Delete `asInvestigationSource`, which existed only to turn a connection into a source. Add a tripwire (`src/providers/investigationBoundary.test.ts`) that fails if any shipped connection defines one of the five again.
- [x] 11.2 Split the capability declaration: `InvestigationSourceCapabilities` (the five, plus pagination) is declared by a source, `ProviderDetailCapabilities` (the two detail reads, plus pagination) by a provider, and `ReviewInvestigationCapabilities` is the member-effective composition of both. `withSourceInvestigation` is the one composer and runs for every member.
- [x] 11.3 Delete the provider serviceability check and its tests. "Could the forge serve this change" is not a question anyone asks once no forge serves one. A source that declines a file's content now flows to the completion gate, which already refuses to call such a run complete.
- [x] 11.4 Reduce source selection to local-git-or-refuse. Delete `pairEvidence` and the refused-versus-gone disambiguation (task 9.9): both were answered by asking a forge for a manifest at the pinned pair, which is the diff request the rule forbids. A fetch that fails ends the attempt with a truthful reason and leaves a stored checkpoint compatible, because nothing left can prove a commit is gone.
- [x] 11.5 Compute the merge base with `git merge-base` over the pinned head and the branch the change request targets, replacing the forge's `merge_base_commit.sha`. Add `mergeTargetRef` to the object-source descriptor; both real providers compose it from the change request. Pin the computed base under its own `refs/codeverdict/<sha>` so a later repack cannot take it.
- [x] 11.6 Fetch the head and the target branch in one invocation at a starting depth of 10, escalating x10 to a bound of 1000, stopping early once the store is no longer shallow. Report the depth reached in run activity and in the refusal. A store that already holds the head fetches only the target branch.
- [x] 11.7 Make `investigationSource` required on `DispatcherMember` and `HarnessAttemptMemberInput`, and delete the `?? member.connection` fallback in `dispatchTargetFor` — the last second route around the object store. A member nothing could read holds a source that refuses every operation in the words of the refusal.
- [x] 11.8 Read `AGENTS.md` through the member's investigation source instead of `Connection.readFile`. It is a file in the repository at the base revision. Move the root-policy resolve after source selection, which is also what makes it read the locally computed base.
- [x] 11.9 Default `scopeInvestigationToChangedFiles` to `false`, and make it a plain boolean again. Every read is local; the metered call the setting protected does not exist. Add the test that only a diff read inspects a changed file — near-moot while the setting was on, load-bearing now.
- [x] 11.10 Give the demo pod its own source (`providers/fixture/demoInvestigationSource.ts`), supplied by the host rather than selected, recorded as the `sample` source kind. Its sample change exists in no repository and its revisions are not object ids, so there is nothing for git to read.
- [x] 11.11 Split the conformance suite: `investigationSourceContract.ts` for the five operations, run against the local git source and the sample source; `providerContract.ts` keeps sign-in, resolution, diffs, threads, posting and the object-source descriptor.
- [x] 11.12 Delete what the removal orphaned: the compare-entry manifest mappers on both providers, their tests, the emulator's compare/files/search routes, and the page-bound suite's provider half (retargeted at the two sources).

## 12. What The Review Of This Change Found

- [x] 12.1 Prove the merge base before accepting it (design D10). `git merge-base` in a shallow store returns an older common ancestor with exit 0 and an object id, and the ladder deepened only on an *empty* answer, so the wrong one ended the search. A candidate is now accepted only when no truncation point lies above it, read from `rev-list --max-parents=0` and `cat-file commit`; the bound reached without a proof is its own failure state and substitutes nothing. Tested against a real `git-http-backend` remote on the shape that produces it, asserting against a real full clone.
- [x] 12.2 Key the host-supplied investigation source on the pod's provider rather than on the run's `demo` flag, which is set from the selected agent (design D11) — the demo agent on a connected pod was being handed the sample dataset. Gate the object cache on whether a source was supplied, for the same reason, one line below. The test that asserted the old behaviour is rewritten, and the shape is read out of `extension.ts` so the restated copy cannot drift from it.
- [x] 12.3 Restore the three provider-contract cases that survived the provider ceasing to serve investigation: change-request details normalized with named unavailable sections, an undeclared detail operation withheld or reported unavailable, and a rate-limited detail read surfaced as the neutral retryable error. Five of the eight deleted cases read a diff, a file or a search at a pinned pair and had nothing left to ask; these three did.
- [x] 12.4 Correct the comments a later task invalidated: `scopeInvestigationToChangedFiles` no longer defaults to `true` (two assurance tests), an unavailable object-source descriptor no longer means the provider serves investigation instead (both providers and the shared contract), and `registry.ts` names the dependency it actually feeds.
- [x] 12.5 Decide what a valid deepening schedule is in one place, because the loop and the lock disagreed about it. `mergeBaseDepthFactor: 1` multiplies a depth into itself, so the acquisition loop's `depth >= mergeBaseMaxDepth` exit never came — measured, 13 identical depth-10 fetches at a real remote, an unbounded run of network round trips — while `lockStaleFor` refused to count a rung for a factor that could not deepen and derived a stale-lock threshold of one rung for a ladder with no end. `depthLadder` in `localGitPolicy.ts` is now the only definition of the schedule; `lockStaleFor` takes its length and the loop walks its rungs, so the loop is bounded by a finite array built before the first fetch rather than by arithmetic. `normalizeLocalGitPolicy` rejects a factor that cannot deepen and a depth the invocation seam will not plan, at the point a policy is built. `MAX_FETCH_DEPTH` is exported from `gitInvocation.ts` and read by both fetch operations and by the policy, so the bound really is one value; a policy bound above it now ends the review at the depth this will fetch instead of as `requestRefused` quoting the fetch planner's rule.
