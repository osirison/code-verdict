# Live checks against a real GitHub instance

Neither script is part of `npm test`: both need network and a token, so they
cannot run in the suite. They exist because the emulator has twice blessed a
request shape the live API rejects — see `docs/agent-notes/` and the commits
referencing task 6.4.

Both drive `createGitHubProvider()`, not the API directly. The only raw HTTP in
`write.ts` is the independent before/after verification, which deliberately does
not go through the code under test.

## read.ts — writes nothing

```bash
GH_TOKEN="$(gh auth token)" npx esbuild scripts/live/read.ts --bundle --platform=node \
  --target=node20 --format=cjs --outfile=/tmp/read.cjs && GH_TOKEN="$(gh auth token)" node /tmp/read.cjs
```

`GH_REPO`, `GH_PR` and `GH_ORG` override the defaults. Covers `testConnection`,
every `resolveSource` branch, `listGroupRepositories`, `listOpenChangeRequests`,
`listWorkItems`, `getChangeRequestDiff`, `listThreads` and `listCiRuns`.

## write.ts — POSTS REVIEWS

`GH_REPO` and `GH_PR` are required and have no defaults, because this script
posts real reviews. **Point it at a throwaway pull request.** The pull request
needs a diff of at least two files with hunks around `src/alpha.ts:20` and
`src/beta.ts:10`, and a line outside the diff to anchor the rejection case.

```bash
GH_TOKEN="$(gh auth token)" GH_REPO=you/scratch GH_PR=1 npx esbuild scripts/live/write.ts \
  --bundle --platform=node --target=node20 --format=cjs --outfile=/tmp/write.cjs \
  && GH_TOKEN="$(gh auth token)" GH_REPO=you/scratch GH_PR=1 node /tmp/write.cjs
```

Five cases: the batched submit under a token credential and under a session
credential, the per-comment fallback, and a refused `requestChanges` and
`approve` on a self-authored pull request. Each asserts what landed by reading
it back, including that every `CommentOutcome.threadId` appears in what
`listThreads` returns.
