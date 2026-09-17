# Manual walkthrough — task 17.9

## 1. What this is

A manual checklist for the twelve scenarios task 17.9 lists: run each against a real
extension-development-host session and record pass/fail. It replaces "validate in the
emulator" with "validate against a real forge, emulator only where it genuinely applies" —
see the next section for why.

## 2. Why not the emulator

Task 17.9 says "manually validate in the emulator." That does not work for the scenarios
that require running a real agent review. Executed against a running emulator, requesting
the diff source for the emulator's own flagship MR returns:

```
getObjectSource => { "state": "unavailable",
  "reason": "The project reports a plain-HTTP clone location, which cannot carry this connection's credential." }
```

Two reasons, both structural, not a config mistake to fix:

- The extension refuses to send an `Authorization` header over plain `http:` — by design,
  with no localhost carve-out. GitLab's provider always attaches that header.
- The emulator serves REST v4 and GraphQL only. It runs no git wire protocol, so there is
  no HTTPS clone URL it could offer instead.

There is no fallback path: the GitLab provider's own contract states that an unavailable
source descriptor ends the attempt rather than routing anywhere else. Picking the demo agent
does not avoid this either — a demo agent on a connected pod still needs the object store
like any other agent; only the built-in sample dataset pod is exempt, and that is not what
these rows exercise.

**So this document runs the twelve review-running rows (1–12) against a real forge over
HTTPS**, and uses the emulator only for the failure-branch rows it is genuinely good at —
listed separately in section 5.

## 3. Setup

Do these in order before starting row 1.

### 3.1 Repository and PR

```
REPO: __________________________________________
PR:   __________________________________________
```

Requirements for a suitable PR:

- **Throwaway.** Several rows post real review comments and run a real model against it —
  do not point this at a PR anyone cares about.
- **A diff of several files**, so triage and coverage have something to show.
- **For row 2 specifically**, a PR with **more than 100 changed files** — that is the default
  manifest page size (not user-settable), so anything over it forces a second manifest page.
  The emulator cannot produce this at any seed (its seeded data tops out around 6 files).
  If no PR that large is available, row 2 is recorded as "not run," not "failed" — see that
  row.

### 3.2 Language model

The harness gets its model from VS Code's Language Model API, populated by Copilot Chat (or
another chat extension) **installed and signed in inside the Extension Development Host
window** — the window F5 opens, not your main VS Code window. The first review run shows a
permission prompt for model access; grant it. Without both of these, no row that runs a real
agent can start.

### 3.3 F5 field note

The Extension Development Host window dies intermittently on F5 — it opens and disappears
within a second, main window unaffected. **This is not a real bug: press F5 again.** It
almost always activates on retry.

Prefer **Ctrl+F5** (Run Without Debugging) over F5 for this walkthrough — same launch
configuration, but it skips the debug attach that causes the intermittent death, and
breakpoints are not needed for exercising behaviour.

### 3.4 Settings

All under `codeVerdict.harness.*`. Change only what a row below calls for, and **put every
value back to its default when you finish the walkthrough.**

| Setting | Default | Use it for | Rows |
|---|---|---|---|
| `codeVerdict.harness.maxModelTurnsPerAttempt` | 64 | Set to 2–3 to force budget exhaustion quickly | 7 |
| `codeVerdict.harness.maxToolRequestsPerAttempt` | 256 | Set to 4–8, same purpose as above (use one or the other, not both, so you know which limit tripped) | 7 |
| `codeVerdict.harness.maxElapsedSecondsPerAttempt` | 1800 | Set to 30–60 to force a timeout instead of a turn/tool-count exhaustion | 7 (alternative trigger) |
| `codeVerdict.harness.checkpointCadenceToolCalls` | 10 | Set to 1 so a checkpoint exists almost immediately — **required** before killing the dev host for restart/resume rows | 10, 11, 12 |

Two changeset-fairness numbers (minimum tool calls per member, minimum evidence bytes per
member) are not exposed as settings at all — they are fixed in policy and cannot be tuned for
row 9.

## 4. The twelve rows (real forge)

### Row 1 — Small review

- **Setup:** none.
- **Do:**
  1. Open the PR from section 3.1 in the extension.
  2. Start a review with the default agent.
  3. Let it run to completion.
- **Expect:** the phase rail moves through Queued → Planning → Investigating → Verifying →
  Completing, then lands on either the triage screen or the clean-outcome screen.
- **Watch for:** if the PR's description carries a `Part-of:` trailer, the review screen
  shows a changeset banner even though you only asked to review one PR. That is correct
  behaviour (the PR is a changeset member), not a bug — do not fail the row for it.
- [ ] pass  - [ ] fail  notes: ______

### Row 2 — Paginated huge review

- **Setup:** requires the >100-file PR from section 3.1. If none is available, skip to the
  bottom line of this row.
- **Do:**
  1. Open the large PR.
  2. Start a review.
  3. Watch the investigating phase — it should read more than one manifest page.
- **Expect:** the run investigates across a second manifest page (more than 100 changed
  files, the default page size, don't fit in one page) without stalling or erroring, and
  reaches a normal outcome (complete or partial).
- **Watch for:** nothing product-specific traced for this exact screen text — judge by
  whether investigation clearly continues past what a single small page could cover, and
  whether the run completes normally rather than silently truncating coverage.
- **If no large PR is available:** record this row as **not run**, not failed.
- [ ] pass  - [ ] fail  - [ ] not run  notes: ______

### Row 3 — Public plan revision

- **Setup:** none you can force — see below.
- **Do:**
  1. Start a review and watch the plan block while the run is investigating.
  2. If the model revises its plan during the run, note it.
- **Expect, if it happens:** the plan block's header changes to `Plan · revision K of N`, and
  a revision entry reads `Plan revised — {rationale}` (or bare `Plan revised` if the model
  gave no rationale).
- **This cannot be forced.** It only happens when the model itself decides to revise its
  plan; there is no way to script or trigger it deterministically in this walkthrough. If it
  does not happen during your session, that is not a failure — mark it **not run** and move
  on, or fold it into a longer session if you want the chance to observe it.
- **Watch for:** nothing specific traced for this row beyond the two strings above — the
  only checks are that the header and revision line match them exactly if a revision occurs.
- [ ] pass  - [ ] fail  - [ ] not run  notes: ______

### Row 4 — Truthful indeterminate progress

- **Setup:** none — watch the very start of any real review run (rows 1, 5, 7, 8, or 9 all
  pass through this state early on).
- **Do:**
  1. Start a review.
  2. Watch the progress indicator in the first moments, before coverage has a known total.
- **Expect:** an animated progress sweep with **no number anywhere in it** — labeled for
  screen readers as "progress not yet measurable."
- **Watch for:** a bar with no number looks like broken UI at a glance. It is not — the
  product deliberately withholds a percentage when it has no honest total to measure against.
  Do not fail the row because there's no number; fail it only if a fake/placeholder number
  appears instead.
- [ ] pass  - [ ] fail  notes: ______

### Row 5 — Truthful determinate progress

- **Setup:** none — watch the same run as row 4, once coverage gets a known total.
- **Do:**
  1. Continue watching the run from row 4 (or start a fresh one) into the investigating
     phase, once file counts are known.
  2. Read the progress bar and the live counts line beneath it.
- **Expect:** the bar becomes a real percentage (an SVG bar with true geometry, never an
  inline style attribute — that's expected, not a bug, since the content security policy
  forbids inline styles). The counts line reads:

  `{classified} of {total} changed files classified · {inspected} inspected · {requiredInspected} of {requiredTotal} required files inspected · {findings} findings so far · {modelTurnsUsed} model turns used`

  **If this particular PR has zero files that require inspection, the line must instead
  read exactly `no files required inspection`** in that clause.
- **Watch for — this is the sharpest check in the whole walkthrough.** If required-file count
  is zero, the line must say `no files required inspection`. It must **never** say
  `0 of 0 required files inspected`. That exact wrong phrasing was a real bug that was
  already found and fixed once — if you see it again, it's a regression, not a cosmetic
  quibble. Read this clause carefully even if the rest of the line looks fine.
- [ ] pass  - [ ] fail  notes: ______

### Row 6 — Cancellation

- **Setup:** none.
- **Do:**
  1. Start a review.
  2. While it is investigating, cancel the run.
  3. Observe what the panel does immediately after.
- **Expect:** the panel clears the run and navigates back — to the prior retained review if
  one exists for this PR, otherwise to the plain agent picker. If findings had already been
  validated before you cancelled, they're kept as a **partial** review carrying the
  limitation "The reviewer cancelled the run before completion." If nothing had been
  validated yet, no history entry is written at all.
- **Watch for — two specific things, both must hold:**
  1. There must be **no fail card** shown after a cancel. A fail card here is a bug.
  2. There must be **no "Start new attempt from checkpoint" offer** after a cancel — a
     cancelled run never carries the flag that would justify that offer. Seeing that button
     after a cancel is a bug.
- [ ] pass  - [ ] fail  notes: ______

### Row 7 — Partial outcome

- **Setup:** before starting, set one of the budget settings from section 3.4 to a tight
  value (e.g. `maxModelTurnsPerAttempt` to 2–3, or `maxToolRequestsPerAttempt` to 4–8, or
  `maxElapsedSecondsPerAttempt` to 30–60). Put it back to default after this row.
- **Do:**
  1. Start a review with the tightened budget in place.
  2. Let it run until it stops on its own.
- **Expect:** a fail card reading `Agent stopped · {message}`, where the message names the
  specific limit that was hit (for example "A run budget was exhausted." or "The attempt
  reached its elapsed-time limit."). Below that: `The run did not complete. {N} findings
  arrived before it stopped.` (or `No findings arrived before it stopped.` if none did).
  Below that, a list of up to 8 files that needed attention, followed by `and N more` if
  there were more. If a fresh attempt is offered, it says `The {N} finding(s), plan, and
  coverage carry over into a new attempt with a fresh budget.` next to a **Start new attempt
  from checkpoint** button.
- **Watch for:** the same action row also shows a button labelled **"Switch to Fast Diff
  Review."** This is a **known, already-reported bug** — no such review mode exists anywhere
  in the product, and the button actually just cancels the run rather than switching
  anything. Do not stop to investigate it or fail the row over it; just confirm it's there
  as expected (already known) and move on.
- [ ] pass  - [ ] fail  notes: ______

### Row 8 — Complete clean outcome

- **Setup:** none — use a small, clean PR from section 3.1, or reuse row 1's PR if it
  finished clean.
- **Do:**
  1. Start a review and let it run to completion with no findings above your severity/
     confidence criteria.
- **Expect:** a green check, a heading reading "No findings above your criteria," the
  model's own closing statement, and a line reading `{filesRead} files read, {N} candidate
  observations scored — none cleared the {severityFloor} floor at {minConfidence}%
  confidence.` Any candidates that were filtered out for being below the floor appear as
  buckets, not as findings.
- **Watch for:** if this PR is a changeset member, the Approve action is withheld — clicking
  what looks like approve in a changeset panel actually just routes back to the dashboard and
  approves nothing. That's intended for changesets, not a bug; don't expect an approval to
  register on a changeset member from this screen.
- [ ] pass  - [ ] fail  notes: ______

### Row 9 — Changeset fairness

- **Setup:** needs a PR that is part of a changeset (multiple PRs sharing a `Part-of:`
  trailer) with at least one member much larger than the others.
- **Do:**
  1. Start a review on the changeset.
  2. Watch the activity feed while it investigates.
- **Expect:** there is no per-member coverage number anywhere on screen — coverage is shown
  only as one aggregate figure for the whole changeset, by design. Judge fairness
  indirectly: the activity feed should show tool calls targeting files from **all**
  members, not only the largest diff. If the shared pool can't give every member its
  reserved minimum, a limitation appears reading:
  `{pool}: ordinary capacity {N} cannot give {members} members the minimum {W} each; each
  receives {P}.`
- **Watch for:** model turns are **not** split per member at all — they come from one shared
  conversation budget for the whole changeset. Do not expect or look for an even split of
  model turns across members; that split doesn't exist for turns, only for tool calls and
  evidence bytes.
- [ ] pass  - [ ] fail  notes: ______

### Row 10 — Restart

- **Setup:** none. Do this after a completed or failed run exists for the target PR.
- **Do:**
  1. With no run currently in flight for this PR, click the ordinary **Run review** button
     (not any checkpoint-resume button).
- **Expect:** a brand-new lineage, attempt 1 — the previous run's plan, coverage, and
  findings are all discarded, not carried forward.
- **Watch for:** the ordinary Run review button must carry nothing forward from the prior
  run. Only the separate "Start new attempt from checkpoint" button (rows 11/12) is allowed
  to carry anything forward. If restart shows old findings or a non-1 attempt number, that's
  a bug.
- [ ] pass  - [ ] fail  notes: ______

### Row 11 — Compatible resume

**Requires zero pushes to the PR between the crash and the click.** Do not push anything to
the branch after killing the host and before clicking resume, or you are actually running
row 12.

- **Setup:** set `codeVerdict.harness.checkpointCadenceToolCalls` to 1 (section 3.4) so a
  checkpoint is written almost immediately. Start a review, let at least one checkpoint be
  written (give it a few tool calls), then kill the Extension Development Host window to
  simulate a crash mid-run — either closing the window or force-quitting it works, since the
  extension has no graceful shutdown handler that would cancel the run cleanly on close; both
  ways just abandon the run for the next activation to find. **Do not push to the branch.**
- **Do:**
  1. Reopen the Extension Development Host (F5, or retry per section 3.3) and reopen the
     same PR.
  2. Look at the picker for an interrupted-attempt banner.
  3. Click the resume offer.
- **Expect:** the picker shows a banner reading: `An earlier attempt on this change request
  was interrupted. Its plan, findings, and coverage so far are available to carry into a new
  attempt.` On click, the activity view opens with a message of this shape: `Starting attempt
  {N} in this lineage from the checkpoint attempt {N-1} left during the {phase} phase.
  Attempt {N-1} is interrupted; this is a new attempt with its own model and tool session and
  a fresh budget/carried-forward budget.`
- **Watch for — the wording ban.** None of this product's text will ever use the words
  "resume," "reconnect," "reattach," or "continue." The button is labelled **"Start new
  attempt from checkpoint"** — never "Resume." If you see any of those banned words anywhere
  on screen for this flow, that is a bug, not a copy nitpick.
- [ ] pass  - [ ] fail  notes: ______

### Row 12 — Incompatible changed-head restart

**Same crash setup as row 11, except a push happens to the branch between the crash and the
click.** Rows 11 and 12 differ in exactly that one thing — do not run this row against a
head that never moved, or you're accidentally repeating row 11.

There are two separate mechanisms here; don't conflate them.

- **Setup:** same as row 11 up through killing the dev host (checkpoint cadence set to 1, at
  least one checkpoint written, host killed mid-run). Then, before reopening the dev host,
  **push a new commit to the PR's branch.**
- **Do:**
  1. Push a commit to the branch.
  2. Reopen the Extension Development Host and reopen the PR.
  3. If a resume offer appears, click it.
- **Expect, two distinct things:**
  1. A run's *own* completion is never blocked by its head moving *during* that same run —
     that always succeeds; it's disclosed, not rejected. If you triggered this by letting an
     original run's head move while it was still active (not this row's crash+push case), the
     completion just shows: `Member {memberId}: reviewed at {oldSha}; the branch moved to
     {newSha} during the review — inline comments will anchor to the reviewed revision.` The
     review stays pinned to its original snapshot.
  2. For *this* row — a resume-from-checkpoint attempted *after* the head already moved — the
     resume offer may still appear on screen, but clicking it must be **rejected**, with a
     reason of this shape: `Member {memberId}'s head revision changed from {oldSha} to
     {newSha}.` The reviewer then falls back to an ordinary restart (row 10's button), not a
     resumed attempt.
- **Watch for:** don't mistake outcome 1 (in-run head move, always fine, just disclosed) for
  outcome 2 (resume after head move, always rejected) — they are different mechanisms tested
  by different actions, and a checklist that conflates them will pass the wrong thing.
- [ ] pass  - [ ] fail  notes: ______

## 5. Emulator rows (failure branches)

These do not need a real git source, so the emulator's HTTP-only nature does not block them.
Start it with `npm run emulator` (or the "Run Extension + GitLab emulator" F5 configuration),
connect with instance URL `http://127.0.0.1:8971` and token `glpat-emulator`.

| Row | How | Expect |
|---|---|---|
| Submit-failure recovery | `curl -X POST localhost:8971/_emulator/fail-submit -d '{"failAt": 2, "status": 401}'`, then submit a review with multiple comments | The Nth line-comment POST fails; the product surfaces recovery rather than silently losing comments |
| Stale anchor | Open MR `!2841` and stage inline comments **before** running the push command below (the check only trips against refs read before the push): `curl -X POST localhost:8971/_emulator/mrs/9101/2841/push`, then submit | Submit reports a stale-anchor failure (GitLab's own `400 "Note position is invalid"`); a second submit taken against freshly-read post-push refs succeeds |
| Reconnect / expired credential | Connect with token `glpat-expired` | Every call 401s; the product shows the reconnect/credential branch |
| Insufficient scope | Connect with token `glpat-readonly` | GETs succeed, writes 403 `insufficient_scope`; onboarding surfaces the scope problem |
| Rate limiting | `curl -X POST localhost:8971/_emulator/rate-limit -d '{"enabled": true}'`, or run with `--scenario rate-limited` | Every call 429 with `Retry-After: 38`; the product backs off rather than hammering |
| Empty dashboard | Run with `--scenario empty-pod` | Dashboard shows an empty state, not an error, for a pod with no open MRs |

Reset between rows with `curl -X POST localhost:8971/_emulator/reset -d '{"seed": 42, "scenario": "happy"}'`.

- [ ] submit-failure recovery — pass / fail: ______
- [ ] stale anchor — pass / fail: ______
- [ ] reconnect / expired credential — pass / fail: ______
- [ ] insufficient scope — pass / fail: ______
- [ ] rate limiting — pass / fail: ______
- [ ] empty dashboard — pass / fail: ______

## 6. Results

| Row | Scenario | Result | Notes |
|---|---|---|---|
| 1 | Small review | | |
| 2 | Paginated huge review | | |
| 3 | Public plan revision | | |
| 4 | Indeterminate progress | | |
| 5 | Determinate progress | | |
| 6 | Cancellation | | |
| 7 | Partial outcome | | |
| 8 | Complete clean outcome | | |
| 9 | Changeset fairness | | |
| 10 | Restart | | |
| 11 | Compatible resume | | |
| 12 | Incompatible changed-head restart | | |
| E1 | Submit-failure recovery (emulator) | | |
| E2 | Stale anchor (emulator) | | |
| E3 | Reconnect / expired credential (emulator) | | |
| E4 | Insufficient scope (emulator) | | |
| E5 | Rate limiting (emulator) | | |
| E6 | Empty dashboard (emulator) | | |

## 7. If a row fails

Do not try to fix it mid-walkthrough. Capture enough to file a real finding, then continue
to the next row.

1. **Trace log.** `logs/Code Verdict: Agent Trace.log` in the worktree root. Note it flushes
   late — a live run can leave the file untouched for minutes, so don't read "no new lines"
   as "nothing happened."
2. **Configuration the run actually used.** In that same trace file:
   `grep 'resolved configuration' 'logs/Code Verdict: Agent Trace.log'` and
   `grep '] policy ' 'logs/Code Verdict: Agent Trace.log'` — confirms which settings actually
   reached the run (versus a shipped default, versus a rejected/invalid value silently
   replaced).
3. **The run's own checkpoint** — carries more than the log: phase, elapsed time, budget
   counters, per-file coverage, and every tool call with target and failure reason.
   ```
   cp ~/.config/Code/User/globalStorage/state.vscdb /tmp/s.vscdb
   sqlite3 /tmp/s.vscdb "select value from ItemTable where key='osirison.code-verdict';" > /tmp/verdict.json
   ```
   Keys are `codeVerdict.harness.lineage.<lineageId>`; pick the one with the latest timestamp
   mentioning the change request, then read its last checkpoint.
4. Record the row number, what was expected, what actually appeared, and the trace/checkpoint
   excerpt in the notes column of section 6. A failing row is a finding to triage afterward,
   not something to chase down before moving to the next row.

## Appendix — source references

Traced at HEAD `ab8d3a7`. Given for tracing a failing row back to source; not needed to run
the walkthrough.

- Venue decision: `src/platform/types.ts:800` (`isFetchableObjectSourceUrl`),
  `src/providers/gitlab/gitlabProvider.ts:611`, `emulator/world.ts`.
- Model prerequisite: `src/app/lmAgent.ts:240-260,725-767`, `src/extension.ts:430`.
- Sample-dataset exemption: `src/extension.ts:458`.
- Settings: `package.json:254,260,266,304`; changeset reserves in
  `src/domain/harnessPolicy.ts:145-146` (not exposed as settings).
- Row 1: phase rail `src/ui/vocab.ts:64-97`; changeset banner `src/app/changesets.ts:82`,
  `src/ui/reviewFlowHtml.ts:1022-1023`.
- Row 3: `src/ui/reviewFlowHtml.ts:1228,1487-1488`; demo participant never scripts a
  revision, `src/app/harnessDemoParticipant.ts:250`.
- Row 4: `src/ui/reviewFlowHtml.ts:1473-1480`; decision logic
  `src/app/harnessActivityProjection.ts:196-203`.
- Row 5: `src/ui/reviewFlowHtml.ts:1253-1271,1288-1295`, zero-required clause at
  `:1262-1263`.
- Row 6: `src/ui/reviewFlow.ts:1000-1005`; limitation text `src/app/harnessCompletion.ts:548`;
  resumable flag `src/app/reviewRunManager.ts:690-696`.
- Row 7: BLOCKER_MESSAGES `src/app/harnessCompletion.ts:496-518`; fail card and file list
  `src/ui/reviewFlowHtml.ts:1400-1417,1552-1566`; carry-forward offer `:1457-1461`; known
  "Switch to Fast Diff Review" bug at `:1562`, handler `:2396`.
- Row 8: `src/ui/reviewFlowHtml.ts:1687-1691,2106-2111`; approvability rule near
  `approvable = !selfAuthored && !changeset`.
- Row 9: `src/domain/harnessActivity.ts:89-95`; reserves and limitation text
  `src/app/harnessBudgets.ts:345-387,352-366,369-374`; dead `changesetMemberMinimumTurns`
  configuration, same file.
- Row 10: `src/app/reviewRunManager.ts:634-651`; interrupted sweep
  `src/app/harnessResume.ts:409-421`.
- Row 11: banner and resume-start text `src/ui/reviewFlowHtml.ts:1436-1442`;
  `src/app/harnessResume.ts:536-545`; wording ban `:44-48`.
- Row 12: in-run disclosure `src/app/harnessCompletion.ts:529-559` (commit `9a9657e`);
  resume rejection `src/app/harnessResume.ts:231-233`; end-to-end test
  `src/app/harnessRuntime.test.ts:539-569`.
- Emulator control API and scenarios: `emulator/README.md`.
- Debugging aids: `docs/agent-notes/debugging-a-harness-run.md`,
  `docs/agent-notes/f5-extension-development-host.md`.
