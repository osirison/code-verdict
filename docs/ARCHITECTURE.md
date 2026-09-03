# Code Verdict — architecture

The product spec lives in [`spec/`](../spec/README.md). This document covers the one decision that
shapes the whole codebase: **the data layer is provider-agnostic.** GitLab and GitHub are both
implemented; Bitbucket/Atlassian and any other source-repo platform must be addable by writing a
single new provider module, with no changes above the data layer.

Adding GitHub was the test of that claim, and it held: `src/domain/**` and the review, triage,
changeset and notification logic were not touched. The contract itself changed in exactly one place
(`ConnectionConfig` gaining a credential union). Everything else was closing four leaks that had
gone unnoticed while GitLab was the only implementation — see "What leaked, and what now stops it".

## Layers

```
┌─────────────────────────────────────────────────────────┐
│ ui/          webviews, sidebar tree, status bar, toasts │
├─────────────────────────────────────────────────────────┤
│ app/         screen state machine, pod query scheduler, │
│              persistence (globalState / workspaceState /│
│              SecretStorage), agent runner (vscode.lm)   │
├─────────────────────────────────────────────────────────┤
│ domain/      product model: Pod, Criteria, ReviewItem,  │
│              Review, Verdict, Changeset, thread status  │
├─────────────────────────────────────────────────────────┤
│ platform/    the neutral SCM contract: types, provider  │
│              interface, capabilities, error taxonomy    │
├─────────────────────────────────────────────────────────┤
│ providers/   gitlab/ · github/ · fixture/ (demo, tests) │
│              later: bitbucket/, …                       │
└─────────────────────────────────────────────────────────┘
```

**Dependency rule:** arrows point down only. `providers/*` implement `platform` interfaces;
nothing outside `src/providers` may import a concrete provider except `src/registry.ts`, which
wires implementations into the provider registry at activation. This is enforced by an ESLint
`no-restricted-imports` rule, not convention.

## Neutral vocabulary

The spec is written in GitLab words. The code is not. The platform layer names concepts by what
they are, and each provider maps its own nouns onto them:

| Platform type    | GitLab            | GitHub           | Bitbucket        |
| ---------------- | ----------------- | ---------------- | ---------------- |
| `Repository`     | project           | repository       | repository       |
| `RepoGroup`      | group             | organization     | workspace/project|
| `ChangeRequest`  | merge request     | pull request     | pull request     |
| `WorkItem`       | issue             | issue            | issue            |
| `CiRun`          | pipeline          | check run / run  | pipeline         |
| `ReviewThread`   | discussion        | review thread    | comment thread   |

UI strings still say "merge request" and "!2841" when the pod points at GitLab, and "pull request"
and "#123" when it points at GitHub. Each provider exposes a `Vocabulary` — `platformName`, singular
and plural nouns for change requests, repositories, CI and work items, plus `formatCrRef` — and the
chrome renders from it. The *logic* never branches on provider identity.

Renderers are pure functions over a state object, so they take `vocabulary` **as part of that
state**; they never import the registry, which would couple pure rendering to module-global state
and break the renderer tests. The state builders (`ui/sidebarState.ts`, `ui/dashboardState.ts`, the
panel classes) look the vocabulary up once and pass it down. `NEUTRAL_VOCABULARY` covers the chrome
before any pod exists — the neutral contract's own words, "change request" and "repository", because
with no pod there is no platform to name.

Plurals are explicit fields, not `noun + "s"`. English happens to work for today's nouns; encoding
that assumption in shared code is what a fifth provider breaks.

### The rule is a test, not a paragraph

`src/ui/vocabulary.test.ts` parses `src/ui`, `src/app` and the `src` root with the TypeScript AST and
inspects **string and template literals only** — never comments, identifiers or type names, so
`mergeOrder.ts` and doc comments do not false-positive. A banned noun in a literal fails the build.
The escape is `// vocab-ok: <reason>` on the preceding line and it **requires a reason**; there are
three in the codebase (a provider id default, the registry's wiring imports, and "log pipeline" as
ordinary English in demo copy).

Precision is the point. A rule that needs a growing ignore list reads as enforcement while enforcing
nothing — which is exactly how these nouns leaked into ~40 sites in the first place.

Static strings that cannot vary per pod — the extension description, `viewsWelcome`, setting
descriptions, and the palette titles — must name no platform at all. `src/commands.test.ts` enforces
that half.

## Provider contract

`src/platform/provider.ts` defines two interfaces:

- **`ScmProvider`** — static identity: `id`, `displayName`, `capabilities`, `vocabulary`, `host`,
  `authModesFor(instanceUrl)`, and `connect(config)` returning a `Connection`. The config carries an
  optional `intent` — whether someone is waiting on this connection — which a metered platform may
  use to reserve budget and an unmetered one ignores.
- **`Connection`** — everything the product needs from a platform: `testConnection`,
  `resolveSource` (URL / repo id / group id — the onboarding rules in handoff §4),
  `listGroupRepositories`, `listOpenChangeRequests`, `listWorkItems`, `listCiRuns` (each batched
  per repository — never one request per change request, per commit or per run),
  `getChangeRequestDiff`, `submitReview`, `listThreads`, `resolveThread`, `replyToThread`,
  `approve`.

A `Connection` is cheap and short-lived — `connectionForPod` builds a fresh one for every poll, so
it must never be the owner of anything that has to outlive a poll. What does have to outlive one
belongs to the provider: `createGitHubProvider` owns the ETag cache for exactly that reason.

### Conditional requests are how the budget is kept

Batching cuts how many requests a poll issues. Conditional requests cut how many it is *charged
for*, which is the number that runs out. GitHub does not count a 304 against the primary rate limit
when the request carried an `Authorization` header, so every REST GET sends `If-None-Match` when the
client has a validator for that exact URL, query string included, and a 304 replays the remembered
body. Rate-limit headers are read on the 304 path too — they are as true there as on a 200. A 304
whose remembered body is gone re-asks unconditionally rather than answering with nothing; emptying
the dashboard is worse than spending one request. The exemption is authorization-gated, and GitLab
grants no equivalent (measured: a GitLab 304 still increments `ratelimit-observed`), so this is a
GitHub-provider concern and not a platform-wide one.

### The client stops before the wall

Batching and conditional requests both reduce spending. Neither of them decides when to stop, and
the third failure is the one the user actually hit: the client parsed `x-ratelimit-remaining` on
every response, read it back nowhere, and drove into the limit anyway.

`RateBudget` is what the readings now feed. It lives in the `createGitHubProvider` closure for the
same reason the ETag cache does — a `Connection` is rebuilt every poll, and a budget the client
forgets each minute cannot stop anything. It is keyed by account and split by bucket: two tokens on
one host hold independent budgets, and `core` and `graphql` are independent counters.

A bucket at or below its floor refuses the next request outright, as a `rateLimited` `ScmError`
carrying the reset — the same shape the 403 it replaces would have produced, so nothing above the
provider can tell them apart. The floor differs by **intent**: a background connection stops with
50 requests still standing, an interactive one at 5. That reserve is the point. One interactive flow
— open a change request, read its files, submit — costs at most a dozen requests, so 50 is two or
three whole flows kept back from the poll, at a cost of 1% of the hourly budget.

`ConnectionIntent` is a neutral field on `ConnectionConfig`, set only by the notifier and defaulting
to `interactive`; providers that meter nothing ignore it. Unstated intent is never the cheap one.

### The poll's cadence is derived, not fixed

One poll costs four requests per repository plus one per submitted review still open. A fixed 60s
interval is therefore two different settings wearing one number: right for a five-repository pod,
and 4,800 requests an hour for a twenty-repository one. `src/app/pollSchedule.ts` derives the
interval from that fan-out against a background allowance of 1,200 requests an hour — a quarter of
the authenticated budget in the worst case where nothing is cached, and near zero once validators
are held. `codeVerdict.notifications.pollIntervalSeconds` sets the *floor*, not the interval.

Two things are tied to that derived interval and must move with it. The **focus poll** is the one
path the schedule does not bound, so its gap is a quarter of the earned interval rather than a flat
15s — at a flat 15s an hour of Alt-Tab on a twenty-repository pod issues around 19,000 requests
against an allowance of 1,200. And `NotificationCenter` re-baselines silently across a gap it reads
as a pod waking up; its default 10 minutes is narrower than the interval a pod of more than fifty
repositories earns, so the notifier widens that window to fit. Left alone, such a pod would poll
forever, pay for every poll, and derive no event at all.

A `rateLimited` poll is the one failure with a known duration, so it is the one that changes the
cadence: the notifier stands down until the reported reset plus a small margin, and resumes on its
own. Every other failure keeps the ordinary interval — a network blip is not a reason to go quiet
for an hour. The user is told once per exhaustion (the flag clears only on a poll that succeeds, so
a refused resume attempt does not toast again) and the status bar carries the state for as long as
it lasts.

### Capabilities, not `if (gitlab)`

`ProviderCapabilities` declares what a platform can do — `suggestions`, `approvals`,
`requestChanges`, `threadResolution`, `groupHierarchy`, `batchedReview`. The UI degrades per flag
(e.g. a provider without suggestion blocks posts the fix as a fenced diff instead and hides
"Accept & apply"). Feature code checks flags; it never checks provider ids.

### Anchors are opaque

A `DiffAnchor` carries `{ filePath, line, endLine? }` plus an `anchorRefs` payload the platform
layer treats as opaque — GitLab's `diff_refs` triple, GitHub's `commit_id`+`side`, whatever the
provider needs to round-trip a positioned comment. `getChangeRequestDiff` produces it,
`submitReview` consumes it, and staleness is detected by comparing the recorded head against the
current one through the provider. No GitLab-shaped field appears in a neutral type.

### Errors are normalized

Providers map their HTTP reality onto one `ScmError` taxonomy which the five spec failure branches
key off: `auth` (reconnect), `insufficientScope` (onboarding step 1), `staleAnchor` (re-anchor
before posting — never retry blindly), `rateLimited` (carries retry-after), `notFound`, `network`,
`unknown`. GitLab's `400 "Note position is invalid"` and a future GitHub `422 outdated diff` land
in the same `staleAnchor` bucket.

### Submit is a batch with partial-failure reporting

`submitReview` takes the whole accepted set (line comments + summary + approve/request-changes
options) and reports **per-comment outcomes**. Nothing above the platform layer re-posts blindly:
on partial failure the app retries only the remainder. This is also what makes changeset submit
across N change requests (handoff §16) implementable without provider knowledge upstream.

## Commands: the specified 19, plus internal ids

`contributes.commands` carries **exactly** the 19 palette entries in
`spec/specs/Code Verdict - naming & commands.md` — `src/commands.test.ts` fails the build if that
set drifts. Anything else the UI needs (the `⇧A` / `U` / `1`–`4` / `?` triage keys, the Posted
reviews entry point, comment-thread actions) is an **internal id** in `INTERNAL_COMMANDS`
(`codeVerdict.internal.*`): registered at runtime, reachable from keybindings and menus, invisible
in the palette. Never repurpose a specified command for a screen it does not name — the palette is
part of the product surface, not a convenience registry.

Every keybinding stays scoped to `when: verdict.reviewFocus`, so single letters never steal typing
elsewhere.

## The sidebar is a state machine

`renderSidebarHtml` picks exactly one shell, in this precedence: **setup → threads → triage →
pending → lists**. Feature panels publish their slice through a dep callback
(`onSetupState`, `onSidebarThreads`, `onSidebarState`, `onSidebarPending`) and clear it on
`route.onLeave`; the sidebar itself never reaches into a panel. Evaluate precedence once, in the
renderer — two screens each deciding "am I visible?" is how state flapping starts.

Spec §9 forbids triage counters and filter pills in the threads state; there is a test for it.

## Chrome glyphs are codicons; content glyphs are not

Nav rows, the toolbar and other chrome use codicons (issue #6). A webview gets no icon font for
free: `media/codicons/` is populated from `@vscode/codicons` by `scripts/copy-codicons.mjs` at
build time, `localResourceRoots` admits it, and `renderPage`'s `codicons` option widens `style-src`
and `font-src` to the webview's `cspSource`. Without that option the CSP stays font-free.

Glyphs the spec names in prose stay as written characters — the ✓/✕/⤼ verdict marks, the ▾ file
caret, ⚠, and the ○/✓ setup marks. They are content the spec dictates, not chrome.

## Every webview style goes in the nonce'd `<style>` block

`renderPage` emits `style-src 'nonce-…'`, and a nonce covers `<style>` elements only — never a
`style="…"` attribute. An inline style on any element is therefore dropped silently: no console
error, no visual hint, the rule simply never applies. It cost issue #45, where the loading
skeleton's bars rendered at zero size because their dimensions were attributes.

So every rule lives in the page's CSS block behind a class, including one-off layout tweaks. There
is no attribute-shaped escape hatch: `style="--item-sev:…"` is blocked exactly like any other
inline style, custom property or not. A value that genuinely varies per element needs either a
fixed set of classes, or a rule emitted into the same nonce'd `<style>` block and matched on a
data attribute.

## A stateful element needs a stable id to survive a patch

A region patch replaces a container's `innerHTML`, which rebuilds every element inside it in its
default state. `REGIONS_SCRIPT` (`src/ui/theme.ts`) puts back what the reviewer was standing in —
focus and caret, `<details>` open/closed state, and per-container `scrollTop`/`scrollLeft` — but
it can only match an element to its rebuilt self **by id**. A stateful element without a stable id
is silently not restored: no error, the section just closes or the pane jumps to the top on the
next patch. So when a renderer adds an element that holds DOM-side state, give it an id that is
stable across renders (not derived from list position). Expansion state the panel already holds
and re-renders (the codebase norm — `expandedThreadId`, `agentOpen`, …) needs nothing; the rule is
for state that lives only in the DOM, where disclosure must be a `<details id="…">`.

Two deliberate limits. `value` is never restored: the host holds every editable's in-progress
text and re-renders it current (design D8, task 9.3), so a restored value could only ever be a
stale one clobbering a regenerated summary. And view state is per route: the page keeps a bounded,
route-keyed snapshot (saved when a navigation patch leaves a route, reapplied on return), so one
screen's scroll and open sections never land on another's.

## The status bar shows only what is Verdict's

Spec §14 is drawn from a prototype that mocks the whole VS Code window, so its `⎇ branch` and
`✕ 1 ⚠ 0` segments belong to the editor's own git and problems indicators. Verdict contributes the
three the spec names as its own — review state, agent, and the keys hint — plus two that answer a
question only Verdict can answer: the 🔔 badge count, and whether background polling is paused and
until when. Both hide when there is nothing to say. Duplicating a native indicator is a bug, not
fidelity; a Verdict state the user can sit in for an hour with no way to check on it is also a bug.

## Anchoring: one matcher, three callers

`src/domain/anchor.ts` answers "the agent read this code at line N — is it still there?" for
re-anchoring after a push, for marking which findings went stale, and for placing in-diff editor
decorations. Matching is trim-insensitive (re-indentation is not a move) and, when the code repeats,
the occurrence nearest the original line wins. Findings whose code is gone come back as `lost`
rather than being silently re-pointed — a comment posted on a guessed line is worse than none.

Polling the head during triage never swaps the diff the agent read: comment positions must keep
carrying those refs until the reviewer explicitly re-anchors.

## Adding a provider — the checklist

1. Create `src/providers/<name>/` implementing `ScmProvider` + `Connection`.
2. Map errors onto the `ScmError` taxonomy; declare honest `capabilities`, a `Vocabulary`, a
   `HostDescriptor` and `authModesFor(instanceUrl)`.
3. Own your platform's **source-input grammar** inside the module. `resolveSource` takes the raw
   string, so no neutral code parses platform-specific URL shapes or id formats. GitLab's `/-/`
   separator, `groups/` prefix and numeric ids live in `providers/gitlab/sourceInput.ts`; GitHub's
   `owner/repo` and org forms live in `providers/github/sourceInput.ts`.
4. Write a `fake<Name>.ts` emulator over the same injected `FetchLike` seam, including a failing
   mode, so the tests need no network.
5. Make the shared **provider contract test suite** (`src/platform/contract`) pass against it,
   including `makeFailingConnection`. That suite passing *is* the definition of "provider added".
6. Register it in `src/registry.ts`.

Nothing else changes. If step 6 is not the only edit outside the new directory, the abstraction
has leaked — fix the leak, not the caller.

### When the platform's API and the contract disagree

They will. GitHub's batched review endpoint is all-or-nothing — one bad comment position rejects the
whole POST — while `SubmitResult` promises an outcome per comment. The provider absorbs the
mismatch; it does not push it upward and it does not lie about its capabilities:

1. Try the batch. This is the normal path and it produces the right artifact — one review on the
   pull request, not N loose comments.
2. On a **position-related** rejection, fall back to posting each comment individually for real
   per-comment outcomes, then post the summary and the approve/request-changes verdict as a
   comment-free review. A partial comment failure withholds the summary but never drops the verdict.
3. On a non-position rejection (auth, rate limit), nothing was attempted — throw the normalized
   error rather than returning a result of failures, which is what the contract specifies.

Declaring `batchedReview: false` would have been easier and would have been a lie. Always posting
individually would have been easier and would have produced the wrong artifact on the pull request.

The fallback only runs when something is already wrong, which makes it the path most likely to rot.
`makeFailingConnection` in the shared harness drives it on every test run for exactly that reason.

## What leaked, and what now stops it

Four things escaped the contract while GitLab was the only implementation. Each now has a mechanism,
not a convention:

| Leak | Mechanism |
| --- | --- |
| ~40 hardcoded nouns in user-visible strings | `src/ui/vocabulary.test.ts` (AST literal scan) |
| GitLab's URL grammar sitting in `platform/` | grammar owned by the provider; ESLint dependency rule |
| `{ instanceUrl, token }` assuming one auth shape | `Credential` union + `authModesFor` per host |
| Onboarding and the palette naming GitLab | `HostDescriptor` + `src/commands.test.ts` neutrality test |

### Credentials

`ConnectionConfig` carries a `Credential` union (`token` / `session` / `none`) rather than a bare
string, because recovery differs: a session token can be re-acquired silently after a 401, a personal
access token cannot — the user must reconnect. `authModesFor(instanceUrl)` is a method, not a static
list, because github.com and GitHub Enterprise Server are one provider with different auth available.

Secrets are keyed `codeVerdict.token.<providerId>.<host>` so two providers on one host cannot
overwrite each other. `readToken` falls back to the pre-provider key once and rewrites under the
scoped one, so existing pods are not silently signed out.

`app/connections.ts` stays free of `vscode`: the editor's account API is injected at activation via
`setSessionProvider`, and each provider declares its own `host.session.editorProviderId` and scopes.

## Testing strategy

- **Unit** (vitest): pure logic — thread-status derivation, summary composition, source-string
  parsing, criteria filtering.
- **Contract**: one reusable suite run against every provider. The fixture provider keeps it honest
  offline; the GitLab provider runs it against a fake `fetch` serving
  `spec/specs/Code Verdict - API fixtures.json`; the GitHub provider runs it against `fakeGitHub.ts`,
  whose payload shapes were captured from the live API rather than written from memory.
- **Enforcement**: `src/ui/vocabulary.test.ts` (no hardcoded platform nouns), `src/commands.test.ts`
  (the palette set, and no platform named in any static product-surface string), and the ESLint
  `no-restricted-imports` rule (only `src/registry.ts` imports a concrete provider).
- **Page behaviour** (jsdom): a test that asserts against a rendered HTML *string* cannot tell a
  wired control from a dead one — which is how the dashboard's ⟳ button came to be reported broken
  while every dashboard test passed. `src/ui/dashboardScript.test.ts` executes the real page script
  instead: construct `new JSDOM(renderX(...), { runScripts: 'dangerously', beforeParse })`, stub
  `acquireVsCodeApi` in `beforeParse`, dispatch the event, assert on what was posted. Two mechanics
  matter. Construct `JSDOM` by hand under the normal `node` environment — vitest's `jsdom`
  environment hands back a document whose scripts never ran, and switching the global `environment`
  in `vitest.config.ts` drags every other test file into a DOM it does not need. And pass a
  `VirtualConsole` that drops `jsdomError`: `REGIONS_SCRIPT` ends by restoring scroll, and jsdom
  does not implement `window.scrollTo`. A test that needs to *observe* scroll instead installs its
  own `window.scrollTo` double in `beforeParse` and redefines `scrollX`/`scrollY` over it
  (`dashboardScript.test.ts`), asserting on what was set and read back — never on layout, which
  jsdom does not do. Issue #43 tracks generalising this into a harness.
- **Extension host** (later): smoke tests via `@vscode/test-electron`.
