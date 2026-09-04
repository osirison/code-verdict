# Code Verdict — naming, commands, and UI strings

## The name

**Marketplace / package name:** `Code Verdict`
**Spoken and in-product name:** `Verdict`
**Publisher-qualified id:** `<publisher>.code-verdict`

Why the split: "Verdict" alone competes in search with legal apps and generic tooling, so the long
name carries discovery. Inside the editor the user already knows which extension they're in, so the
short name carries the chrome — it stays terse in a 36px tab and a 26px status bar.

Rules:

- Never "CodeVerdict" (one word) or "code verdict" (lowercase) in user-facing copy.
- Never "Code Verdict:" as a command prefix — too long in the palette. Always `Verdict:`.
- The agent is never called Verdict. Verdict is the plugin; the reviewer is the Copilot agent the
  user selected (e.g. `HVE Core / PR Review`). Keep that attribution visible — it's what makes the
  findings trustworthy.
- The tagline used in the marketplace listing and step 1 of onboarding:
  *Judge the AI's review, then ship it to your code platform.*
- Command titles name no platform. `package.json` titles are fixed at package time, so they cannot
  vary per pod the way vocabulary-rendered chrome does — the palette must read correctly whether the
  active pod watches GitLab or GitHub. `src/commands.test.ts` fails the build if a platform name
  appears in any static product-surface string.

## Command palette

All commands use the `Verdict:` prefix, sentence case after the colon, verb first.

| Command title | Command id | Notes |
| --- | --- | --- |
| Verdict: Run review | `codeVerdict.runReview` | Runs the selected agent on the active MR |
| Verdict: Open dashboard | `codeVerdict.openDashboard` | Pod dashboard in an editor tab |
| Verdict: Open review | `codeVerdict.openReview` | Triage tab for the active MR |
| Verdict: Next item | `codeVerdict.nextItem` | Queue and diff modes |
| Verdict: Previous item | `codeVerdict.prevItem` | |
| Verdict: Accept item | `codeVerdict.acceptItem` | `A` when the review tab has focus |
| Verdict: Accept item and apply fix | `codeVerdict.acceptItemApplyFix` | Only when the agent proposed a diff |
| Verdict: Reject item | `codeVerdict.rejectItem` | `R` |
| Verdict: Skip item | `codeVerdict.skipItem` | `S` |
| Verdict: Ask agent about this item | `codeVerdict.askAgent` | `⌘↩` / `Ctrl+Enter` |
| Verdict: Generate summary | `codeVerdict.generateSummary` | Enabled once every item is triaged |
| Verdict: Submit review | `codeVerdict.submitReview` | |
| Verdict: Select review agent | `codeVerdict.selectAgent` | Opens the tuning panel; the agent and model pickers are on the run screen |
| Verdict: Edit review criteria | `codeVerdict.editCriteria` | Severity floor, categories, confidence |
| Verdict: New pod | `codeVerdict.newPod` | |
| Verdict: Switch pod | `codeVerdict.switchPod` | Quick pick |
| Verdict: Delete pod | `codeVerdict.deletePod` | Quick pick, then a modal confirm |
| Verdict: Add project to pod | `codeVerdict.addProject` | Accepts URL, project id, or group id |
| Verdict: Refresh | `codeVerdict.refresh` | Re-fetch MRs, issues, pipelines |
| Verdict: Sign in | `codeVerdict.signIn` | |
| Verdict: Show API trace | `codeVerdict.showApiTrace` | Reveals the API log; says which setting turns tracing on when it is off |

Keybindings are scoped with `when: verdict.reviewFocus` so `A` / `R` / `S` never steal typing
elsewhere. Nothing is bound by default outside that context.

### Internal commands

Not in the palette — reached from a control, a keybinding, or a status-bar segment.

| Id | Reached from |
| --- | --- |
| `codeVerdict.internal.postedReviews` | Sidebar row, dashboard rows, "Track replies" |
| `codeVerdict.internal.acceptCommentOnly` | `⇧A` |
| `codeVerdict.internal.undoVerdict` | `U` |
| `codeVerdict.internal.jumpSeverity` | `1`–`4` |
| `codeVerdict.internal.keyboardHelp` | `?`, and the status bar's `? keys` |
| `codeVerdict.internal.showNotifications` | The status bar's `🔔 n` |
| `codeVerdict.internal.cancelRun` | The ✕ on a sidebar run row |
| `codeVerdict.internal.showActiveRuns` | The status bar's running-review segment — lists what is in flight, cancels one from the pick |

## Settings namespace

`codeVerdict.instanceUrl`, `codeVerdict.agent`, `codeVerdict.agentLocations`, `codeVerdict.severityFloor`,
`codeVerdict.categories`, `codeVerdict.minConfidence`, `codeVerdict.extraInstructions`,
`codeVerdict.autoAdvance`, `codeVerdict.context.sectionBudget`, `codeVerdict.context.totalBudget`,
`codeVerdict.context.maxLinkedItems`, `codeVerdict.context.includeTitle`,
`codeVerdict.context.includeDescription`, `codeVerdict.context.includeLinkedItems`,
`codeVerdict.contextUsage.enabled`, `codeVerdict.notifications.quietMode`, `codeVerdict.trace.api`,
`codeVerdict.pods`, `codeVerdict.agentRun.inactivitySeconds`,
`codeVerdict.agentRun.ceilingSeconds`, `codeVerdict.agentRun.maxConcurrent`,
`codeVerdict.harness.maxElapsedSecondsPerAttempt`, `codeVerdict.harness.maxModelTurnsPerAttempt`,
`codeVerdict.harness.maxToolRequestsPerAttempt`, `codeVerdict.harness.maxEvidenceMegabytesPerAttempt`,
`codeVerdict.harness.highRiskReservePercent`, `codeVerdict.harness.verificationReservePercent`,
`codeVerdict.harness.transientRetriesPerOperation`, `codeVerdict.harness.checkpointCadenceToolCalls`,
`codeVerdict.harness.retainedCheckpointsPerLineage`, `codeVerdict.harness.maxActivityEventsPerAttempt`,
`codeVerdict.harness.terminalAttemptHistoryCount`, `codeVerdict.harness.terminalAttemptHistoryMaxAgeDays`,
`codeVerdict.harness.requireInspectionMinRisk`.

The three `agentRun` settings share one convention: `0` removes that limit. For the two windows
that means "never time out on this"; for `maxConcurrent` it means "run as many reviews at once as
are triggered".

Every `harness.*` setting bounds one review attempt: how long it may run, how many model turns and
tool calls it may use, how much evidence it may hold, how much of that is held back for high-risk
files and final verification, how many times a failed step retries, how often it checkpoints, and
how much history is kept. A missing or unusable value falls back to its own documented default, never
to zero. `requireInspectionMinRisk` is the one non-numeric setting — `low / medium / high` — and its
default, `low`, requires every changed file to actually be read, not just classified, before a review
can complete.

The access token is never a setting — it lives in the VS Code secret store.

## Context and evidence wording

An attachment is a file, folder, selection, symbol, Problems snapshot, or pasted text that the
reviewer explicitly adds to a run. Change request titles, descriptions, and linked work items are
intent and cannot be cited as findings. Attachments and changed-file diffs are reviewable evidence.
An accepted finding against an attached file outside the diff goes to the summary, not an inline
comment.

Never state that only the diff is sent or that the whole repository is never sent. Use the live run
footer: `N changed files + M attachments go to the agent.` Thinking Effort is applied as review
instructions in the prompt, not as the model provider's native reasoning setting.

## Review run wording

Lifecycle labels are the same word everywhere a run's state is shown — the active review screen, the
sidebar's active-run list, and the status bar — never a shortened or reworded copy on any one screen:
`Queued / Planning / Investigating / Verifying / Completing / Waiting / Paused / Resuming /
Cancelling / Cancelled / Succeeded / Failed / Interrupted`.

A result's completeness is reported separately from its lifecycle and never implied by it. The
dashboard's Verdict column shows one of: the live lifecycle label while a review is running,
`submitted`, `no findings` (clean and complete), `N partial` (stopped early, findings kept — always
with a reason on hover), `interrupted`, `N finding(s)`, or `not run`. `N partial` never appears as a
plain finding count; a partial result is always named as partial.

Progress is a real count ("N of M") only once a full inventory exists; before that, or with nothing
to count, progress is elapsed time — never a percentage guessed from an incomplete inventory.

Cancelling a run shows `Cancel`. A run that stopped early with findings already kept offers `Use N
partial findings`. Reviving an interrupted review is never called "resume" where the reviewer can see
it — the control reads `Start new attempt from checkpoint`, and when the checkpoint cannot back one
it instead lists the reasons why, with a plain restart offered in its place. A review from before
this harness shipped is labeled a legacy review and states plainly that it has no plan, activity, or
coverage detail, rather than showing none of those and letting the reviewer assume there was nothing
to record.

## UI strings as shipped

- Activity bar tooltip: `Verdict`
- Sidebar view title: `VERDICT`
- Sidebar nav row: `Pod dashboard`
- Editor tabs: `Verdict: Dashboard` · `Verdict: Setup` · `Verdict: Run review · !2841` ·
  `Verdict: Review · !2841`
- Status bar: `◈ Verdict: !2841 · 5 left`, or `◈ Verdict: no active review`
- Onboarding step 1 heading: `Welcome to Code Verdict`
- Notification titles stay MR-first, not brand-first: `Review ready · 8 items on !2841`
  (the source is already obvious from the icon)
- A review that stopped short of complete but kept validated findings:
  `Review failed · 3 findings kept as partial · !2841`, or `Review cancelled · 3 findings kept as
  partial · !2841`. Never "Review ready" for a result that stopped short of complete.
- Attempts closed by an editor restart: `2 reviews interrupted by the restart`

## Category vocabulary

Review criteria categories, in the order they appear in the UI: Security, Concurrency,
Error handling, Performance, Craftsmanship, API contract, Tests, Docs & comments, Style.
Severity floor uses `nit / minor / major / blocker`. Triage verdicts are always
`Accepted / Rejected / Skipped` — capitalised, never "approved" or "dismissed", so the words match
the buttons, the summary, and the docs.
