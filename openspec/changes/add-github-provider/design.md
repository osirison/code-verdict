## Context

See proposal.md — Why. The relevant state is that the abstraction already exists and is sound:
`src/platform/` holds the neutral types, `ScmProvider`/`Connection`, `ProviderCapabilities`,
`Vocabulary` and `ScmError`; `src/registry.ts` is the only place a concrete provider is imported and
ESLint enforces that; `src/platform/contract/providerContract.ts` is a conformance suite the fixture
and GitLab providers already pass.

Every GitHub concept maps onto the existing neutral types without adding one — repository,
organization, pull request, issue, check run, review thread. The contract needs exactly one change
(authentication shape). Everything else in this design is about the four places GitLab-shaped
assumptions escaped past the contract, and about the GitHub module itself.

**API facts below were verified against the live GitHub API during design**, not recalled:

| Fact | How it was verified |
| --- | --- |
| Thread resolution is GraphQL-only (`resolveReviewThread`, `unresolveReviewThread`) | Mutation list introspection — no REST equivalent exists |
| `PullRequestReviewThread` exposes `isOutdated`, `isResolved`, `viewerCanResolve`, `path`, `line`, `diffSide` | Type introspection |
| A review comment carries `commit_id`, `path`, `line`, `side`, `start_line`, `start_side`, `position`, `original_line`, `diff_hunk`, `pull_request_review_id` | Real payload from an existing PR |
| Pull request list items carry `number`, `state`, `draft`, `head.sha`, `updated_at`, `requested_reviewers` | Real payload |
| Checks come from `/commits/{sha}/check-runs` with `status` + `conclusion` + `html_url` | Real payload |
| Rate limits are per-resource with separate `core` and `graphql` buckets, reported via `X-RateLimit-Remaining` / `X-RateLimit-Reset` | `/rate_limit` response and headers |

## Goals / Non-Goals

**Goals:**

- Prove the abstraction by adding GitHub without touching `src/domain/**` or the review, triage,
  changeset and notification logic. If any of those needs a change, that is a leak to fix in place,
  not to work around.
- Make each of the four leaks structurally impossible to reintroduce, using the enforcement style
  this repo already uses — a failing test or a lint rule, not a convention in a document.
- Keep `SubmitResult`'s per-comment outcomes honest on GitHub, whose batched review endpoint is
  all-or-nothing.

**Non-Goals:**

- Dynamic or third-party provider plugins. The registry stays a module-global map populated at
  activation; providers are compiled in.
- A GitHub App installation flow. The auth model is designed to accept a third mode later without
  a contract change, but only session and token are implemented here.
- Cross-provider changesets, and any change to merge coordination (still out of scope per handoff
  §16).

## Decisions

### 1. `ConnectionConfig` carries a credential; the provider declares which modes a host supports

`ConnectionConfig` becomes `{ instanceUrl, credential }` where `credential` is a discriminated union
of `{ kind: 'token', token }` and `{ kind: 'session', accessToken }`, and `ScmProvider` gains
`authModesFor(instanceUrl): readonly AuthMode[]`. GitHub returns `['session', 'token']` for
github.com hosts and `['token']` for anything else; GitLab returns `['token']`; the fixture provider
returns `['none']`.

*Why not keep `{ instanceUrl, token }` and put the session's access token in `token`?* Because
onboarding has to decide **before connecting** whether to prompt for a pasted token, and because the
lifecycles differ: a session token can be silently re-acquired from the editor after a 401, a
personal access token cannot — the user must be sent to reconnect. Collapsing them loses the
information needed to pick the right recovery on an `auth` error.

*Why a per-host method rather than a static list?* github.com and GitHub Enterprise Server are the
same provider with different auth availability. A static list would force either two provider ids or
a lie.

**Secret storage** becomes provider-scoped: `tokenSecretKey(providerId, instanceUrl)`. Existing
GitLab pods have secrets under the old instance-only key, so the read path falls back to the old key
and rewrites under the new one on first successful read. Session-authenticated pods store no secret
at all — `connectionForPod` must not treat a missing secret as an error when the pod's mode is
session.

### 2. Source-input grammar moves into the providers

`src/platform/sourceInput.ts` currently encodes GitLab's `/-/` path separator, its `groups/` URL
prefix, its `group <id>` shorthand and its numeric project ids. It moves to
`src/providers/gitlab/sourceInput.ts` unchanged. `Connection.resolveSource` already takes the raw
string, so no contract change is needed — the parsing simply stops being neutral code.

GitHub's grammar is different in kind, not just in detail:

| Input | Result |
| --- | --- |
| `https://github.com/owner/repo`, with or without a trailing `/pull/123`, `/tree/...`, `.git` | repository `owner/repo` |
| `owner/repo` | repository |
| `https://github.com/orgs/acme`, or a bare `acme` that resolves to an organization | organization plus its visible repositories |
| anything else | no match |

**`Repository.id` for GitHub is `owner/repo`, not the numeric node id.** Every REST path is
`/repos/{owner}/{repo}`, so a numeric id would cost a lookup on every call. `Repository.id` is
already documented as an opaque provider-scoped string, so this is within contract. The trade-off is
that renaming or transferring a repository changes its id where GitLab's numeric id would not;
GitHub redirects renamed repositories, and the pod stores `path` alongside `id`, so the failure mode
is recoverable rather than silent.

**GitHub returns 404 for both "does not exist" and "you cannot see it".** The two cannot be
distinguished from the response. Decision: a well-formed GitHub reference that 404s resolves to
`notVisible`, and only unparseable input resolves to `noMatch`. This biases toward telling the user
to check their token's access — which is the actionable case — and, either way, nothing is ever
silently added to a pod. This is a deliberate semantic difference from GitLab, which can tell the
two apart.

### 3. Vocabulary reaches renderers through state, and a test keeps it there

The HTML renderers are pure functions over a state object and are tested with plain state literals.
They must not import the provider registry — that would couple pure rendering to module-global state
and break those tests. Instead the state builders that already exist (`ui/sidebarState.ts` reads
`vocabulary` today) carry a `vocabulary` field into every state object the renderers receive, and the
renderers read nouns from it.

`Vocabulary` gains explicit plural forms (`changeRequestNounPlural`, `repoNounPlural`) rather than
appending `"s"` at call sites — English happens to work for these four words, but encoding that
assumption in shared code is the kind of thing a fifth provider breaks.

**Enforcement:** `src/ui/vocabulary.test.ts` parses every file under `src/ui/` and `src/app/` with
the TypeScript compiler API and walks string and template literals only, failing on a banned noun
list (`merge request`, `pull request`, `MR`, `PR`, `GitLab`, `GitHub`, and the platform-specific
container nouns). Comments and identifiers are not scanned, so `mergeOrder.ts` and doc comments do
not false-positive. An inline `// vocab-ok: <reason>` on the preceding line is the escape hatch, and
it must carry a reason.

*Why the AST and not a grep?* A grep over these files matches doc comments, type names and the word
"project" in unrelated prose, which produces a test everyone learns to suppress. Scanning literals
only is the difference between a rule that holds and a rule that gets an ever-growing ignore list.
The TypeScript compiler is already a dependency, so this costs nothing.

**Static strings that cannot vary per pod** — the extension description, `viewsWelcome`, the
`instanceUrl` setting description, and the two palette titles `Verdict: Submit review to GitLab` and
`Verdict: Sign in to GitLab` — are retitled to neutral wording, since `contributes.commands` titles
are fixed at package time. `src/commands.test.ts` locks the set of 19 titles, so it and
`spec/specs/Code Verdict - naming & commands.md` change together with `package.json`.

### 4. Onboarding is driven by the provider's declared host step

`ScmProvider` gains a `host` descriptor — display label, default instance URL, and the example text
for the source-input prompt. This replaces the hardcoded
`https://gitlab.com/hve/platform/core · 9102 · group 4821` placeholder at `src/extension.ts:311`
and the `https://gitlab.com` default on the `codeVerdict.instanceUrl` setting. `signInFlow.ts` gains
a provider-choice step ahead of the host step, skipped when only one non-demo provider is registered
so the single-provider experience does not regress.

`src/app/debugBootstrap.ts` currently calls `getProvider('gitlab')` with a literal. It reads the
provider id from the debug bypass configuration instead. This is debug-only and low-risk, but it is
the one remaining hardcoded provider id outside the registry.

### 5. The GitHub module uses REST for everything except what only GraphQL can do

`src/providers/github/http.ts` mirrors `src/providers/gitlab/http.ts`: a thin client over an
injected `FetchLike` seam so tests need no network, with `Link`-header pagination and error
normalization. It exposes both a REST method and a GraphQL method, because verification showed
thread resolution has **no REST equivalent** — `resolveReviewThread` and `unresolveReviewThread`
exist only as GraphQL mutations, and `isOutdated` / `isResolved` / `viewerCanResolve` are fields on
the GraphQL `PullRequestReviewThread` type.

So the split is:

| Operation | API |
| --- | --- |
| repositories, org repositories, pull requests, issues, diffs, check runs, posting reviews and comments, replies | REST |
| listing review threads with resolution and outdated state; resolving and unresolving | GraphQL |

`isOutdated` maps directly onto the neutral `ReviewThread.anchorPresent` (inverted) — the same signal
GitLab derives from `position: null` after a force-push.

Rate limiting is tracked per bucket, because `core` and `graphql` are verified to be separate
resources with independent counters. Secondary rate limits arrive as a `Retry-After` header and map
onto `ScmError('rateLimited', …, { retryAfterSeconds })`, the field that already exists.

No SDK is added. GraphQL is one POST with a query string, which does not justify a dependency in a
bundled extension.

### 6. Anchors: GitHub's opaque payload is the head commit id

`AnchorRefs` for GitHub is `{ commitId }`, taken from the diff's head SHA, and comments are posted
with `path`, `line`, `side` and — for multi-line findings — `start_line` and `start_side`. All of
these were verified present on real review-comment payloads. This is exactly what `AnchorRefs` being
declared opaque was for: GitLab needs a `diff_refs` triple, GitHub needs one commit id, and nothing
above the platform layer knows the difference.

### 7. Batched review is attempted as one review, with a per-comment fallback

This is the decision that matters most, because it is where GitHub's API and the neutral contract
disagree.

`POST /repos/{owner}/{repo}/pulls/{n}/reviews` posts the whole review at once — body, comments array,
and an `event` of `COMMENT`, `APPROVE` or `REQUEST_CHANGES`. That is what `batchedReview: true`
means, and it produces the right artifact: one review on the pull request rather than N loose
comments. But it is **all-or-nothing** — one comment with an unacceptable position rejects the entire
request — while `SubmitResult` promises an outcome per comment so the app can retry only the
remainder.

Decision: two-phase submit inside the provider.

1. Attempt the batched review. On success, every comment is reported successful and the summary is
   reported posted. This is the normal path.
2. If the batch is rejected for a position-related reason, fall back to posting each comment
   individually to the review-comments endpoint, recording a real per-comment outcome, and then post
   the summary and the approve/request-changes decision as a review carrying no comments — so a
   partial comment failure never silently drops the verdict.
3. If the batch is rejected for a non-position reason (auth, rate limit, not found), do not fall
   back. Nothing was attempted, so the normalized error is raised rather than returned, which is
   what the contract specifies.

*Alternative rejected:* always post comments individually. It gives per-comment outcomes for free,
but produces N separate review comments instead of one review, loses the approve/request-changes
coupling, and multiplies rate-limit consumption by the number of findings. The artifact the user sees
on the pull request is part of the product, not an implementation detail.

*Alternative rejected:* declare `batchedReview: false` for GitHub. It would be a lie — GitHub does
support batched review — and it would degrade the UI for no reason.

Two GitHub-specific outcomes worth naming: a user cannot approve their own pull request, and cannot
request changes on it either; both are reported through the existing `approvalError` /
`requestChangesError` fields rather than failing the comment set.

### 8. Capabilities GitHub declares

`suggestions: true` (GitHub renders ```` ```suggestion ```` blocks and offers "Commit suggestion"),
`approvals: true`, `requestChanges: true`, `threadResolution: true` (via GraphQL, per decision 5),
`groupHierarchy: true` (organizations), `batchedReview: true` (per decision 7). Each is declared true
only because the corresponding operation is implemented and covered by the conformance suite — the
spec requires flags to be honest, and the emulator is what keeps them honest.

### 9. `fakeGitHub` mirrors `fakeGitLab`

The GitHub emulator implements the same `FetchLike` seam, serves REST and GraphQL responses shaped
like the verified payloads above, and supports a failing mode where the second comment write fails
with a position error — which is what `makeFailingConnection` in the conformance harness needs, and
what exercises the decision-7 fallback path.

## Risks / Trade-offs

**The vocabulary test produces false positives and gets suppressed** → Scan string and template
literals only via the TypeScript AST, never comments or identifiers, and require a reason on every
`// vocab-ok` escape. A rule with a growing ignore list is worse than no rule, because it reads as
enforcement while enforcing nothing.

**The batched-review fallback path is the one that only runs when something is already wrong**, so it
is the path most likely to be broken in production → It is not an edge case in the test suite:
`makeFailingConnection` in the shared conformance harness drives it on every run, and the GitHub
emulator's failing mode is built specifically to reach it.

**Secret-key migration silently logs existing GitLab users out** → The read path falls back to the
old instance-only key before concluding a token is missing, and rewrites under the provider-scoped
key on first successful read. A test covers reading a secret written under the old key.

**GitHub's 404 ambiguity mislabels a genuinely nonexistent repository as `notVisible`** → Accepted
deliberately (decision 2). Both branches refuse to add the source, so the failure is a slightly
misleading message, never a wrong pod.

**The two command retitles change a published product surface** → The extension is at 0.0.1 and not
yet on the Marketplace. Doing the retitle now, before issue #16 packaging, is the reason this change
should land before #16 rather than after.

**Separate `core` and `graphql` rate-limit buckets mean a client that tracks one number will
mispredict** → Verified as a real behavior of the API, so the client tracks buckets separately from
the start rather than discovering it under load.

**Scope creep from "make it generic" into re-architecting the platform layer** → The contract changes
in exactly one place (`ConnectionConfig` plus the two provider declarations it implies). Any other
proposed contract change during implementation is a signal that something is being designed for a
provider that does not exist yet.

## Migration Plan

The work is staged so the build is green and GitLab keeps working at every step. No user-visible
behavior changes until stage 4.

1. **Neutralize, with GitLab still the only real provider.** Vocabulary into state objects and
   renderers; the vocabulary test; GitLab's source grammar moved into its own module; the
   `ConnectionConfig` credential union and provider-scoped secret keys with old-key fallback; the
   host descriptor and provider choice in onboarding; `debugBootstrap` reading its provider id. The
   full suite, the GitLab contract test and the GitLab emulator test all stay green — that is the
   check that this stage changed no behavior.
2. **Build the GitHub module against its emulator**, unregistered. It exists but the product cannot
   reach it; the conformance suite runs against it.
3. **Register it** in `src/registry.ts` and verify onboarding end to end against a real repository.
4. **Update the product surface**: `package.json` description, titles, `viewsWelcome` and setting
   default; `src/commands.test.ts`; `spec/specs/Code Verdict - naming & commands.md`;
   `docs/ARCHITECTURE.md`.

**Rollback:** stages 1 and 2 are independently revertable and user-invisible. After stage 3, removing
`githubProvider` from the registry disables GitHub while leaving every neutralization in place;
existing GitHub pods would then report an unregistered provider, which the spec already requires to
be reported rather than silently redirected.

## Open Questions

- Whether to add GitHub App installation auth as a third mode. Deferrable: decision 1 makes
  `authModesFor` return a list, so a third mode is an addition to that list and a new onboarding
  branch, changing neither the specs nor the task breakdown.
- Whether repositories still using the older commit-status API rather than check runs need a second
  CI source. Deferrable and entirely internal to the GitHub provider — `CiRun` is already neutral, so
  this is a question about where the provider reads from, not about any contract.
