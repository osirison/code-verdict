## Why

Review investigation currently asks the forge for the diff. For a large change the forge declines
to compute one, and the answer it returns is indistinguishable from a real binary file, so the host
writes off source files it could have read.

Measured against `osirison/code-verdict#66` (207 changed files, all text) on 2026-09-10:

| source | files with a usable diff | classified binary |
| --- | --- | --- |
| GitHub compare API (today's path) | 69 of 207 | **137** |
| GitHub pull-request files API | 175 of 207 | 30 |
| local git over the same two commits | **207 of 207** | **0** |

Every one of those 137 files is ordinary TypeScript. GitHub returns them with `patch: null`,
`additions: 0`, `deletions: 0`, `changes: 0` — its truncation shape — and `isBinaryCompareFile`
reads that as binary. `markTerminal(..., 'binary')` is irreversible, so two thirds of the change
became permanently uninspectable and the run could never reach complete coverage no matter how much
budget it was given. In the live run those files also cost 93 of 285 tool calls, because the model
kept drawing them.

The forge is the wrong authority for this question. A diff between two commits is a local
computation over content the forge already gave us the identity of, and git answers it exactly,
without truncation, size caps, rate limits or a guess about what is binary.

## What Changes

- Add a neutral local-git investigation source that answers changed-file manifests, diff reads,
  revision-pinned file reads and searches by running git against a local object store, pinned to
  the `{repoId, baseSha, headSha}` snapshot the investigation contract already carries.
- Obtain objects by fetching the two pinned commits into a per-repository cache owned by the
  extension. **No branch is checked out and no working tree is written**: git answers `diff`,
  `show` and `grep` from the object database by commit id, so nothing in the reviewer's open
  repository changes. Two shallow fetches of the measured change cost 2.1 MB.
- Make local git **the** source of investigation evidence, and keep the provider as the source of
  change-request metadata, discussion, checks and posting — the things that genuinely live on the
  forge. The five revision-pinned operations come off `Connection` and off every provider: a forge
  that can still be asked for a diff is a second route around the object store, and a route that
  exists is a route that gets taken.
- **BREAKING**: stop mapping the forge's diff-truncation shape to `binary`. A file the forge
  declined to render is not a binary file, and a terminal state must never be entered on a guess.
  The mapping is gone entirely along with the manifest it fed: nothing asks a forge to enumerate a
  change.
- **BREAKING**: there is no provider investigation fallback. A review that cannot reach git ends
  before bootstrap with completeness `none` and a reason naming what was unavailable — never a
  degraded review, and never a clean review of nothing.
- Compute the merge base locally with `git merge-base`, from the pinned head and the branch the
  change request targets. The forge is asked which branch that is — a fact about the change request
  that lives in no repository — and for nothing else about the base.
- Let the local source declare `repositorySearch` supported and actually answer it at a pinned
  revision, which no forge provider can do on every deployment. GitHub declares it unsupported —
  `/search/code` indexes only a repository's default branch and takes no ref parameter. GitLab
  declares it supported and pins it with `ref`, but the underlying feature needs Advanced Search or
  Exact Code Search on the instance and returns `unavailable` at call time where that is absent.

## Capabilities

### New Capabilities

- `local-git-investigation`: revision-pinned manifests, diffs, file reads and searches computed
  locally; object acquisition and cache ownership; argument-safe command construction

### Modified Capabilities

- `scm-providers`: investigation becomes a fallback bounded by what the forge can actually serve;
  the truncation shape maps to a truthful non-terminal state rather than `binary`
- `agentic-review-harness`: evidence may be served by a non-provider investigation source, chosen
  per attempt and recorded in the snapshot so a resumed attempt knows which source produced its
  evidence

## Open Questions

1. **Merge-base semantics — resolved, and computed locally.** A pull request's diff is a three-dot
   (merge-base) diff. `baseSha` used to be `pull.base.sha`, the tip of the target branch, with the
   forge resolving the merge base server-side; it briefly became the forge's own
   `merge_base_commit.sha`. It is now `git merge-base` over the pinned head and the branch the
   change request targets, computed in the object store, because a merge base is a computation over
   two commits and the rule is that git answers everything git can answer.

   The depths are measured. Two revisions at depth 1 cannot produce a merge base at all (verified,
   2.49 MB, `git merge-base` reports none). Depth 10 finds it in one round trip for 2.62 MB.
   Starting at 1 and deepening to 10 costs 3.16 MB — more than asking for 10 outright — because the
   second pack re-sends what the first held. So acquisition starts at depth 10 and multiplies by 10
   twice (10, 100, 1000) before refusing with the depth it reached; it stops early once the store
   holds the repository's whole history, since deepening further cannot add a commit.

   This also fixes a real defect independent of all this: a moving target branch used to silently
   change what "base" meant for a review already in flight. The cost is that `baseSha` is persisted
   in checkpoints and compared on resume, so its meaning changes for existing runs.

2. **Cache ownership and eviction — resolved in design.md, D3.** Where the object cache lives, how
   it is bounded, and what happens when two reviews of the same repository run concurrently. The
   answer: one bare repository per repository identity under the extension's own global storage,
   never the reviewer's clone; reads take no lock, only acquisition serializes; whole-directory LRU
   eviction under a byte bound, skipping any repository an active attempt holds a lease on.
3. **Repositories with no reachable remote — resolved in design.md, D8.** Fetching a bare commit id
   works against GitHub (verified), but a force-pushed head that is unreachable from any ref may need
   `refs/pull/N/head`, which is forge-shaped knowledge the investigation contract deliberately does
   not carry. The answer: the provider composes that ref into the object-source descriptor as an
   opaque hint, the local source retries with it without interpreting it, and verifies the obtained
   object against the pinned id, so the contract stays neutral and a wrong hint cannot substitute a
   different commit. Where that retry also fails, the forge decides which case it is: a commit it can
   still serve was refused by the remote's fetch policy, and the review falls back to the provider
   under the same serviceability bound as any other fallback; a commit it no longer has, and a probe
   it cannot answer, both refuse.

## Command construction is a security boundary

Paths and search patterns reaching this source are model-supplied, and the model is steerable by
change-request text this project already treats as untrusted. Git's own options are the attack
surface — no shell is needed.

Demonstrated against a real repository on 2026-09-10:

    git diff --numstat -M <base>..<head> '--output=/tmp/pwned.txt'     -> wrote 7,842 bytes to /tmp
    git diff --numstat -M <base>..<head> -- '--output=/tmp/pwned.txt'  -> inert, treated as a path

A single missing `--` turns a file read into an arbitrary file write anywhere the extension can
write. `git grep` behaves the same way: a pattern must follow `-e`, or a leading `-` is parsed as
an option.

Required, and each needs a test that fails without it:

- Spawn with an argument array, never a shell string.
- `--` before every pathspec; `-e` before every pattern.
- Reject absolute paths and any path escaping the repository root — git refuses these itself
  (verified), but the source must refuse them first so the reason reaching the model is truthful
  rather than a raw git error.
- Extend the existing marker-string sink tests to this source: nothing model-supplied may reach
  activity, checkpoints, diagnostics or storage.
