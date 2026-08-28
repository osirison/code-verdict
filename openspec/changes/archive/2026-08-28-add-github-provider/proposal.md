## Why

Code Verdict must review pull requests on GitHub as well as merge requests on GitLab. The
generic architecture for this already exists — `src/platform/` defines a neutral SCM contract
(`ScmProvider`, `Connection`, `ProviderCapabilities`, `Vocabulary`, `ScmError`), `src/registry.ts`
is the single wiring point, an ESLint `no-restricted-imports` rule enforces the dependency
direction, and `src/platform/contract/providerContract.ts` is a reusable conformance suite. The
problem is not that the abstraction is missing; it is that GitLab was the only implementation, so
GitLab-shaped assumptions leaked past the contract in four places and now block a second provider:

1. **Vocabulary is not rendered.** `Vocabulary` exists and is used in four call sites
   (`ui/sidebarState.ts`, `ui/notifier.ts`, `ui/postedReviews.ts`, `extension.ts`), but the webview
   renderers still hardcode "merge request", "MR", "project" and "Submit review to GitLab" —
   `ui/reviewFlowHtml.ts:721`, `ui/dashboardHtml.ts:333`, `ui/sidebarHtml.ts:368`,
   `ui/changesetHtml.ts:138`, `ui/postedReviewsHtml.ts:152` and others.
2. **Source parsing is GitLab-shaped but lives in neutral territory.**
   `src/platform/sourceInput.ts` encodes GitLab's `/-/` path separator, its `groups/` URL prefix and
   its numeric project ids. GitHub has none of those.
3. **Auth assumes one shape.** `ConnectionConfig` is `{ instanceUrl, token }` and
   `app/connections.ts` reads the secret at `tokenSecretKey(pod.instanceUrl)`. A GitHub pod
   authenticated through the VS Code built-in GitHub session has no stored token at all.
4. **Onboarding assumes GitLab.** `signInFlow.ts` offers "Use a GitLab instance" with no provider
   choice; the `codeVerdict.instanceUrl` setting defaults to `https://gitlab.com`; the extension
   description, `viewsWelcome` and two palette command titles name GitLab.

Doing this now, before Marketplace packaging (issue #16), means the published product surface —
command titles, settings, walkthrough — is neutral from its first release instead of being renamed
after users have it installed.

## What Changes

- **Vocabulary reaches the chrome.** Every user-visible platform noun is rendered from the active
  pod's `Vocabulary` rather than a literal. A test fails the build when a platform noun appears in
  `src/ui` or `src/app` outside a vocabulary lookup, matching how `src/commands.test.ts` already
  locks the palette and how ESLint already locks the dependency direction.
- **Source resolution becomes provider-owned.** GitLab's URL/id grammar moves into
  `src/providers/gitlab/`; each provider parses the input shapes it recognises. `Connection.resolveSource`
  already takes the raw string, so the platform contract itself is unchanged.
- **`ConnectionConfig` carries a provider-chosen auth mode**, so a provider can declare that it
  authenticates by PAT, by a host-supplied session, or both. The secret key becomes provider-scoped.
- **Onboarding gains a provider choice** as its first step, with the instance URL and auth step
  driven by the chosen provider's declaration rather than by a GitLab-shaped default.
- **A GitHub provider module** — `src/providers/github/` — implementing `ScmProvider`/`Connection`
  against GitHub's REST and GraphQL APIs, with its own error mapping into the existing `ScmError`
  taxonomy, a `fakeGitHub` emulator, and a harness that passes `describeProviderContract`.
- **BREAKING (product surface, pre-1.0):** the palette titles `Verdict: Submit review to GitLab` and
  `Verdict: Sign in to GitLab` are retitled to neutral wording. `package.json`
  `contributes.commands` titles are static strings and `src/commands.test.ts` locks the set of 19,
  so the retitle also updates `spec/specs/Code Verdict - naming & commands.md`.

### Assumptions recorded, not asked

- **GitHub auth:** the VS Code built-in `vscode.authentication` GitHub session is the default for
  `github.com`; a personal access token is the path for GitHub Enterprise Server and for users who
  decline the session.
- **GitHub Enterprise Server** is supported through the existing `instanceUrl` model, the same way
  self-hosted GitLab already is.
- **One pod targets one provider.** `Pod` already carries `providerId` and `instanceUrl`. A
  changeset spanning GitHub and GitLab repositories is a non-goal here.
- **Bitbucket is not implemented** by this change. It is the test of the work: adding it later must
  mean writing one provider module and nothing else.

## Capabilities

### New Capabilities

- `scm-providers`: the provider-neutral contract the whole product sits on — how providers are
  registered and selected, how the UI degrades from capability flags instead of provider ids, how
  platform nouns are rendered from vocabulary, how a provider owns its own source-input grammar and
  auth mode, and what a new provider must satisfy to be considered added.
- `scm-providers/github`: the GitHub provider's required behavior — the change requests, diffs,
  batched reviews, review threads and CI runs it must produce, its capability and vocabulary
  declarations, and how GitHub failures map onto the neutral error taxonomy.

### Modified Capabilities

None. `openspec/specs/` is empty; this change establishes the first capability specs.

## Impact

**New code:** `src/providers/github/` (provider, HTTP client covering REST and GraphQL, mappers,
error mapping, `fakeGitHub` emulator, contract-test harness).

**Changed code:**
- `src/platform/provider.ts` — `ConnectionConfig` gains an auth mode; `ScmProvider` declares which
  modes it supports and what its instance URL means.
- `src/platform/sourceInput.ts` — GitLab grammar moves out to `src/providers/gitlab/`.
- `src/app/connections.ts`, `src/app/storage.ts` — provider-scoped secret keys, session auth.
- `src/registry.ts` — registers `githubProvider`.
- `src/signInFlow.ts`, `src/ui/onboarding.ts`, `src/ui/onboardingHtml.ts` — provider choice step.
- `src/ui/*Html.ts`, `src/ui/reviewFlow.ts`, `src/ui/changeset*.ts`, `src/extension.ts` — vocabulary
  instead of literals.
- `src/app/debugBootstrap.ts` — hardcodes `getProvider('gitlab')`; debug-only, made explicit.
- `package.json` — description, two command titles, `viewsWelcome`, `instanceUrl` setting.
- `docs/ARCHITECTURE.md`, `spec/specs/Code Verdict - naming & commands.md`.

**Dependencies:** none added. GitHub's GraphQL calls go through the same injected `fetch` seam the
GitLab client already uses, so no SDK enters the bundle.

**Not affected:** `src/domain/**` and the review, triage, changeset and notification logic. If any
of them needs a change to accommodate GitHub, that is a leak and belongs in this change's scope, not
in a workaround.
