# Code Verdict — architecture

The product spec lives in [`spec/`](../spec/README.md). This document covers the one decision that
shapes the whole codebase: **the data layer is provider-agnostic.** GitLab is the primary
integration, but GitHub, Bitbucket/Atlassian and any other source-repo platform must be addable by
writing a single new provider module, with no changes above the data layer.

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
│ providers/   gitlab/ (primary) · fixture/ (demo, tests) │
│              later: github/, bitbucket/, …              │
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

UI strings still say "merge request" and "!2841" when the pod points at GitLab — each provider
exposes a `Vocabulary` (nouns + ref formatting such as `!2841` vs `#123`) that the chrome renders.
The *logic* never branches on provider identity.

## Provider contract

`src/platform/provider.ts` defines two interfaces:

- **`ScmProvider`** — static identity: `id`, `displayName`, `capabilities`, `vocabulary`, and
  `connect(config, secrets)` returning a `Connection`.
- **`Connection`** — everything the product needs from a platform: `testConnection`,
  `resolveSource` (URL / repo id / group id — the onboarding rules in handoff §4),
  `listGroupRepositories`, `listOpenChangeRequests` (batched per repository, never per CR),
  `getChangeRequestDiff`, `submitReview`, `listThreads`, `resolveThread`, `replyToThread`,
  `approve`.

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
2. Map errors onto the `ScmError` taxonomy; declare honest `capabilities` and a `Vocabulary`.
3. Make the shared **provider contract test suite** (`src/platform/contract`) pass against it.
4. Register it in `src/registry.ts`.

Nothing else changes. If step 4 is not the only edit outside the new directory, the abstraction
has leaked — fix the leak, not the caller.

## Testing strategy

- **Unit** (vitest): pure logic — thread-status derivation, summary composition, source-string
  parsing, criteria filtering.
- **Contract**: one reusable suite run against every provider; the fixture provider keeps it
  honest offline, the GitLab provider runs it against a fake `fetch` serving
  `spec/specs/Code Verdict - API fixtures.json`.
- **Extension host** (later): smoke tests via `@vscode/test-electron`.
