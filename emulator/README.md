# GitLab emulator

A stateful, in-memory GitLab (the REST v4 + GraphQL slice Code Verdict uses) with deterministic,
seeded test data. Two ways to consume one engine:

- **HTTP server** — for debugging the extension against something live and mutable.
- **In-process fetch adapter** (`emulator/fetch.ts`) — the provider contract suite runs against
  the emulator in unit tests, which is what keeps it honest.

It is dev tooling: never bundled into the extension (`.vscodeignore` excludes it) and never
imported by `src/` product code.

## Debugging the extension against it

```sh
npm run emulator                     # http://127.0.0.1:8971, seed 1, scenario happy
npm run emulator -- --port 9000 --seed 7 --scenario empty-pod
```

Or press F5 with the **Run Extension + GitLab emulator** launch configuration, which starts the
server first.

In onboarding, connect with:

| Field | Value |
| --- | --- |
| Instance URL | `http://127.0.0.1:8971` |
| Token | `glpat-emulator` (valid, `api` scope) |

Special tokens: `glpat-expired` → every call 401s (reconnect branch); `glpat-readonly` → GETs
work, writes 403 `insufficient_scope` (onboarding step-1 branch). Any other `glpat-*` token is
accepted as valid.

The generated world contains the `hve/platform` group (id 4821, five projects, two of them
empty), `hve/web/console` outside the group, the spec's flagship MR `!2841` with the token.ts
diff, an already-reviewed MR `!2833` with one discussion per thread status
(awaiting/replied/resolved/stale), a 4-MR changeset carrying `Part-of: #1180`, plus seeded filler
MRs, issues and pipelines. Same seed → same world.

## Scenarios

| Scenario | What it exercises |
| --- | --- |
| `happy` | Everything populated (default) |
| `empty-pod` | Projects exist, nothing open — dashboard empty state |
| `token-expired` | Every call 401 — submit-failure / reconnect branch |
| `insufficient-scope` | Writes 403 — onboarding token-scope branch |
| `rate-limited` | Every call 429 with `Retry-After: 38` |
| `stale-anchor` | Every discussion POST 400s "Note position is invalid" |

Switch live without restarting: `POST /_emulator/reset {"scenario": "empty-pod", "seed": 2}`.

## Control API (drive failure branches while debugging)

No auth required on `/_emulator/*`.

```sh
# Inspect the world and the last 25 requests
curl -s localhost:8971/_emulator/state | jq

# New commits land on an MR mid-triage — previously read diff_refs now 400
curl -s -X POST localhost:8971/_emulator/mrs/9101/2841/push

# Force-push: additionally drops anchors of posted discussions (position: null → stale threads)
curl -s -X POST localhost:8971/_emulator/mrs/9101/2841/push -d '{"force": true}'

# The author replies on your newest open thread (posted-reviews "replied" status)
curl -s -X POST localhost:8971/_emulator/mrs/9101/2833/reply -d '{"body": "Fair point, fixing."}'

# Fail the Nth line-comment POST of the next submit (status 401 for the auth branch,
# default 400 for stale-anchor; partial-failure recovery testing)
curl -s -X POST localhost:8971/_emulator/fail-submit -d '{"failAt": 2, "status": 401}'

# Toggle rate limiting on/off
curl -s -X POST localhost:8971/_emulator/rate-limit -d '{"enabled": true}'

# Regenerate the world
curl -s -X POST localhost:8971/_emulator/reset -d '{"seed": 42, "scenario": "happy"}'
```

State written through the API is observable: posted discussions appear in `GET .../discussions`,
the summary note in `/_emulator/state` (per-MR `notes` count), approvals in `approved_by`, and
the GraphQL request-changes mutation in `reviewer_state`.

## Fidelity notes

- The MR **list** endpoint deliberately omits `head_pipeline`/`changes_count`/`diff_refs` —
  they are single-MR-endpoint fields in real GitLab, and depending on them in list responses is
  a bug the emulator is designed to catch.
- Discussion POSTs validate `position.head_sha` against the MR's current head and answer
  GitLab's literal `400 (Bad request) "Note position is invalid"` on mismatch.
- List endpoints paginate with `x-next-page` / `x-total-pages` (`per_page` capped at 100).
- Auth accepts `Authorization: Bearer` and `PRIVATE-TOKEN`.
