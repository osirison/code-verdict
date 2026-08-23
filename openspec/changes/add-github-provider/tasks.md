## 1. Vocabulary reaches the chrome

- [x] 1.1 Add `changeRequestNounPlural` and `repoNounPlural` to `Vocabulary` in `src/platform/provider.ts`; fill them in on the GitLab and fixture providers.
- [x] 1.2 Carry a `vocabulary` field into the state objects the renderers already receive — extend `src/ui/dashboardState.ts`, `src/ui/tuningState.ts`, the changeset state in `src/ui/changeset.ts` / `src/ui/changesetReview.ts`, and the review-flow state in `src/ui/reviewFlow.ts`, following the pattern `src/ui/sidebarState.ts` already uses. Renderers must not import the provider registry.
- [x] 1.3 Replace hardcoded platform nouns with vocabulary lookups in `src/ui/reviewFlowHtml.ts`, `src/ui/dashboardHtml.ts`, `src/ui/sidebarHtml.ts`, `src/ui/changesetHtml.ts`, `src/ui/postedReviewsHtml.ts`, `src/ui/onboardingHtml.ts`, `src/ui/settingsHtml.ts`.
- [x] 1.4 Replace hardcoded platform nouns in non-renderer user-visible strings: `src/extension.ts` (lines around 91, 178, 196–202, 242, 367), `src/ui/changeset.ts:154`, `src/app/combinedAgent.ts:118`, `src/ui/changesetReview.ts` (258, 446, 490), `src/domain/notifications.ts` (39, 41).
- [x] 1.5 Write `src/ui/vocabulary.test.ts`: parse every file under `src/ui/` and `src/app/` with the TypeScript compiler API, walk string and template literals only, and fail on the banned noun list. Support a `// vocab-ok: <reason>` escape on the preceding line that requires a reason.
- [x] 1.6 Update the renderer tests (`dashboardHtml.test.ts`, `sidebarHtml.test.ts`, `reviewFlowHtml.test.ts`, `changesetHtml.test.ts`, `settingsHtml.test.ts`) for the new state shape, and add a case asserting the same state renders GitLab and GitHub nouns from different vocabularies.

## 2. Provider-owned source grammar

- [x] 2.1 Move `src/platform/sourceInput.ts` and its test to `src/providers/gitlab/sourceInput.ts`, unchanged; update `src/providers/gitlab/gitlabProvider.ts` to import from the new location.
- [x] 2.2 Confirm nothing outside `src/providers/gitlab/` still imports the source parser; the ESLint dependency rule should catch any that do.

## 3. Provider-declared auth and host

- [x] 3.1 In `src/platform/provider.ts`, replace `ConnectionConfig.token` with a `credential` discriminated union (`token` / `session` / `none`), add an `AuthMode` type, and add `authModesFor(instanceUrl): readonly AuthMode[]` to `ScmProvider`.
- [x] 3.2 Add a `host` descriptor to `ScmProvider` — display label, default instance URL, and source-input example text.
- [x] 3.3 Implement `authModesFor` and `host` on the GitLab and fixture providers; GitLab returns token-only, the fixture returns none.
- [x] 3.4 Make the secret key provider-scoped in `src/app/storage.ts` — `tokenSecretKey(providerId, instanceUrl)` — with a read fallback to the old instance-only key that rewrites under the new key on first successful read. Add a test that reads a secret written under the old key.
- [x] 3.5 Update `src/app/connections.ts` to build the credential from the pod's auth mode, acquiring a session where the provider declares one, and to treat a missing secret as an error only for token mode.
- [x] 3.6 Add a provider-choice step to `src/signInFlow.ts` ahead of the host step, skipped when only one non-demo provider is registered; drive the host prompt, its example text and the credential step from the chosen provider's declarations.
- [x] 3.7 Replace the hardcoded source-input placeholder at `src/extension.ts:311` with the active provider's example text.
- [x] 3.8 Make `src/app/debugBootstrap.ts` read its provider id from the debug bypass configuration instead of the `'gitlab'` literal.
- [x] 3.9 Run the full suite plus the GitLab contract and emulator tests — they must be green with no behavior change before stage 4 begins.

## 4. GitHub HTTP client and emulator

- [x] 4.1 Write `src/providers/github/http.ts`: the injected `FetchLike` seam, `Link`-header pagination, REST and GraphQL methods, and per-bucket rate-limit tracking for `core` and `graphql`.
- [x] 4.2 Write `src/providers/github/errors.ts` mapping GitHub failures onto `ScmError` — invalid or expired credential to `auth`, missing permission to `insufficientScope`, rejected comment position to `staleAnchor`, primary and secondary rate limits to `rateLimited` carrying `Retry-After`, 404 to `notFound`.
- [x] 4.3 Write `src/providers/github/fakeGitHub.ts` serving REST and GraphQL responses in the verified payload shapes, with a failing mode where the second comment write fails with a position error.

## 5. GitHub provider

- [x] 5.1 Write `src/providers/github/mappers.ts` translating GitHub payloads into the neutral types — `Repository` keyed by `owner/repo`, `ChangeRequest` from the pull-request payload including `draft` and `head.sha`, `WorkItem` from issues excluding pull requests, `CiRun` from check runs.
- [x] 5.2 Implement `resolveSource` for the GitHub grammar — repository URL with or without a trailing path, `owner/repo`, organization URL or name — resolving a well-formed but 404ing reference to `notVisible` and unparseable input to `noMatch`.
- [x] 5.3 Implement `listGroupRepositories`, `getRepository`, `listOpenChangeRequests`, `listWorkItems` and `listCiRuns`, batched per repository and paginating fully.
- [x] 5.4 Implement `getChangeRequestDiff` returning unified hunks, the head SHA, rename/add/delete flags, and `{ commitId }` as the opaque `anchorRefs`.
- [x] 5.5 Implement `submitReview` phase one: one batched review carrying comments, summary and the approve or request-changes event, rendering suggested fixes as GitHub suggestion blocks.
- [x] 5.6 Implement `submitReview` phase two: on a position-related batch rejection, post each comment individually for real per-comment outcomes, then post the summary and verdict as a comment-free review. On a non-position rejection, raise the normalized error instead of returning a result.
- [x] 5.7 Report GitHub's refusal to let an author approve or request changes on their own pull request through `approvalError` / `requestChangesError`, never as a comment failure.
- [x] 5.8 Implement `listThreads` over GraphQL, mapping `isOutdated` to `anchorPresent: false` and carrying notes, resolution state, path and line.
- [x] 5.9 Implement `resolveThread` via the `resolveReviewThread` / `unresolveReviewThread` mutations, `replyToThread` as a reply within the thread, and `approve`.
- [x] 5.10 Implement `testConnection` reporting the signed-in username, and declare capabilities and vocabulary — pull request / PR / repository / organization / check, `#123` ref formatting, and all six capability flags true.
- [x] 5.11 Implement `authModesFor` returning session and token for github.com hosts and token only for GitHub Enterprise Server, plus the `host` descriptor.

## 6. Conformance and wiring

- [x] 6.1 Write `src/providers/github/github.contract.test.ts` with a harness including `makeFailingConnection`, and make every case of `describeProviderContract` pass against the emulator with no network access.
- [x] 6.2 Write `src/providers/github/github.emulator.test.ts` covering the batched-review path, the per-comment fallback path, pagination, and the error mappings.
- [x] 6.3 Register `githubProvider` in `src/registry.ts`.
- [ ] 6.4 Verify onboarding end to end against a real GitHub repository and a real organization — session auth on github.com, token auth on an enterprise host — then run a review and confirm the posted result is one review with its comments anchored correctly.
  - **Read paths — done**, live against `api.github.com`: testConnection, all four resolveSource branches, listGroupRepositories, listOpenChangeRequests, listWorkItems with PRs filtered, getChangeRequestDiff with anchorRefs, listThreads over GraphQL, listCiRuns.
  - **Write paths — done** (2026-08-23), live against a throwaway pull request, driving `createGitHubProvider()` rather than the API directly. Five cases, all passing:
    1. Batched submit, token credential — exactly one new review, both comments anchored at the submitted path/line, every `CommentOutcome.threadId` present in what `listThreads` returns.
    2. The same submit through the `{ kind: 'session' }` credential arm, which leaves only `vscode.authentication.getSession` itself unexercised.
    3. One valid anchor plus one line outside the diff — the batch is rejected, the per-comment fallback engages, the good comment lands with a real GraphQL thread id and the bad one reports `staleAnchor`.
    4. and 5. `requestChanges` and `approve` on a self-authored pull request — GitHub refuses both; the comments and summary still land and the verdict surfaces as `requestChangesError` / `approvalError` (task 5.7).
  - Cases 3–5 each failed on the first live run and are fixed in `9f23a29`; the emulator had been blessing request shapes the live API rejects.
  - Both checks are reproducible: `scripts/live/read.ts` (writes nothing) and `scripts/live/write.ts` (requires `GH_REPO` / `GH_PR`, no defaults). See `scripts/live/README.md`.
  - **Still open** — the two legs that need a human or hardware:
    - the VS Code Extension Development Host and the editor's GitHub session (`getSession` consent cannot be automated);
    - token auth against a GitHub Enterprise Server instance — none is available here. `authModesFor` and the GHES `/api/v3` + `/api/graphql` base-URL derivation are unit-covered only.
  - **Decision (2026-08-23, user):** leave 6.4 open indefinitely rather than scoping GHES out. The task text stands as written, and the change is not archivable until a GHES instance exists to run it against. #16 packaging proceeds with 6.4 outstanding — do not re-propose narrowing this task.

## 7. Product surface and docs

- [x] 7.1 Retitle the two GitLab-named palette commands in `package.json` to neutral wording, and update the extension `description`, `viewsWelcome` contents, and the `codeVerdict.instanceUrl` default and description.
- [x] 7.2 Update `src/commands.test.ts` to the new locked title set.
- [x] 7.3 Update `spec/specs/Code Verdict - naming & commands.md` to match the retitled commands.
- [x] 7.4 Update `docs/ARCHITECTURE.md`: GitHub as an implemented provider, the credential and host declarations, provider-owned source grammar, the vocabulary enforcement test, and the batched-review fallback in the "Adding a provider" guidance.
- [x] 7.5 Run lint, the full test suite and a packaged build; confirm the ESLint dependency rule and the vocabulary test both fail when deliberately violated.
