# Code Verdict settings reference

Every setting the extension contributes, what it actually does, and when you would change it. All
45 live under `codeVerdict.*` in VS Code settings.

Sizing a review is covered separately in [REVIEW-BUDGETS.md](REVIEW-BUDGETS.md) — this page keeps
the budget entries to one line each and links there.

## Read this first

### Seven settings were removed, and the extension deletes them from your settings.json

These seven were declared as settings and read by nothing. Changing them never had any effect, so
removing them changes no behaviour — it only stops the settings UI offering a control that does
nothing. If you have any of them in a `settings.json`, the real control is in the second column.

| removed setting | where the real control is |
| --- | --- |
| `codeVerdict.severityFloor` | Run review screen, stored per pod |
| `codeVerdict.categories` | Run review screen, stored per pod |
| `codeVerdict.minConfidence` | Run review screen, stored per pod |
| `codeVerdict.extraInstructions` | Run review screen, stored per pod |
| `codeVerdict.agent` | the agent picker, stored per pod |
| `codeVerdict.pods` | the extension UI — pod data was never in `settings.json`; it is in VS Code's global storage, and editing this key did nothing |
| `codeVerdict.shareAcceptRejectRates` | nowhere — nothing was ever shared. The settings panel showed a toggle for it, wrote the value back, and no code path read it. The toggle is gone; the "Data & privacy" paragraph beside it stays, because that part was always true |

**Nothing of yours is lost.** None of the seven had a reader, and your pods are in global storage,
not in settings, so the `codeVerdict.pods` line in particular could never have held them.

**You do not have to clean them up.** Leaving a removed key in `settings.json` gets you an
"Unknown Configuration Setting" warning from VS Code, on a key you were told was a setting, so the
extension removes them for you. What it does, exactly:

- On every activation it looks for those seven keys in your user settings, your workspace settings,
  and each workspace folder's settings, and deletes any it finds. Only those seven names, never a
  `codeVerdict.*` pattern — a pattern would delete a key from a newer version this build has not
  heard of.
- It checks before it writes, so a `settings.json` that is already clean is never touched and you
  are told nothing. That is also why it runs every time rather than once: a stale key can arrive
  later, in a workspace file you open next month or a profile synced from another machine.
- When it does remove something you get one notification — `Verdict: Removed 2 settings this
  version no longer has: codeVerdict.severityFloor, codeVerdict.pods` — never one per key. The
  count is per key **per scope**, so a key removed from both user and workspace settings counts
  twice while being named once. Each removal is also written as a line in the "Code Verdict: Agent
  Trace" output channel, which is the durable record.
- If a scope cannot be written — a read-only settings file, for instance — that one is skipped and
  the reason is written to the same channel. Nothing here can fail or delay the extension starting.

### Raising a run limit after a run has stopped does not help it

A review runs as one bounded attempt with a fixed allowance of turns, tool calls, evidence and
time. The allowance is fixed when the attempt starts. If an attempt stopped because it ran out,
raising the limit afterwards changes nothing about that attempt — you have to start a new one.
Pick the numbers before you start: [REVIEW-BUDGETS.md](REVIEW-BUDGETS.md).

### When a change takes effect

| settings | takes effect |
| --- | --- |
| `notifications.*`, `trace.api`, `trace.rawPayloads`, `agentLocations`, `showDemoAgent`, `contextUsage.enabled`, `autoAdvance`, `agentVoice`, `changesets.*` | immediately — no reload, no new run |
| all `harness.*`, all `agentRun.*` | on the next review you start; a review already running keeps the limits it started with |
| all `context.*` (the six budget and include settings) | the next time you **open** a review screen — an already-open screen keeps the values it read when it opened |
| `instanceUrl` | only when you create a new pod |

The `context.*` row is the one that surprises people. Changing a context budget and immediately
pressing Run on the screen that is already open uses the old value.

---

## Connecting to a forge

### `codeVerdict.instanceUrl`

Default: `""`

Pre-fills the address box when you set up a new pod, and only for the first registered provider
(GitLab). Empty uses that provider's default host. Each pod stores its own URL once created, so
changing this does not move an existing pod, and picking GitHub during setup ignores it.

Anything that is not a string — a number, an object — is treated as unset, so the box is pre-filled
with the provider's default host. Before this was checked, such a value stopped the setup screen
opening at all rather than showing up in the box.

The access token is never a setting — it is kept in the VS Code secret store.

### `codeVerdict.agentLocations`

Default: `[]`

Extra folders searched for `*.agent.md` agent definitions. Entries are absolute, or relative to the
first workspace folder — a relative entry is dropped when no folder is open. Each workspace folder's
`.github/agents` is always searched as well, never replaced. The agent picker re-scans as soon as
you change this.

A value that is not an array is read as no extra folders. Writing a single path as a bare string
(`"codeVerdict.agentLocations": "/srv/agents"`) does **not** work — it must be a list of one. Inside
a well-formed array, an entry that is not a string, or is blank, is skipped and the rest are kept.
Either way the workspace folders' own agent directories are still searched.

Add a folder when you keep personal or shared agents outside the repository.

---

## Which agent reviews, and how it sounds

What gets reviewed and how strictly — the severity floor, the categories, the confidence threshold
and any extra instructions — is not settable here. All four are stored per pod and set on the Run
review screen; the settings that used to shadow them are in the removed list above.

### `codeVerdict.showDemoAgent`

Default: `false`

Debugging only. Adds the "Verdict · Demo Review" agent to the agent picker. That agent calls no
model — it makes up findings from the diff text, the same findings every time. It is useful for
trying out the review, triage and submit screens without spending a Copilot request, and worthless
as an actual review.

Two cases show it whether this is on or off:

- **A pod that already has it selected.** It stays in the list and stays selected, rather than being
  silently switched to the default review with a notice saying the agent was not found.
- **The sample-data demo pod.** It is the only agent that can review sample data without a chat
  model, so hiding it there would leave that pod with no review anyone could run.

With no Copilot model available, the model picker's wording follows the list rather than this
setting: it offers picking the demo agent only when the agent picker beside it is actually showing
one, and otherwise says that every agent offered needs a model.

Anything other than `true` or `false` reads as off. The picker re-scans as soon as you change this
— no reload, and an open review screen updates in place.

### `codeVerdict.agentVoice`

Default: `"terse"` — one of `terse`, `explanatory`, `blunt`.

Wording of the generated summary comment, not the inline findings.

- `terse` — plain sentences: "Reviewed with X. 2 blockers: … Needs a fix before merge."
- `explanatory` — the same, plus a sentence noting each inline comment carries the reasoning and any
  suggestion.
- `blunt` — clipped fragments: "2 blockers. Fix before merge. 5 inline comments."

Read when the summary is composed, so a change applies to the next summary you generate.

---

## Context sent to the model

These control the auto-derived context — the change request's title, description and linked work
items — assembled before a review starts. All six are read when a review screen opens. A budget that
is not a positive number falls back to its default; fractions round down. A toggle that is not true
or false falls back the same way.

### `codeVerdict.context.sectionBudget`

Default: `4000`

Most **characters** (not tokens) taken from any one section. A long description is cut to this
before anything else is considered.

### `codeVerdict.context.totalBudget`

Default: `12000`

Most characters of auto-derived context in total, across all sections. Attachments and diffs have
their own separate limits and are not counted here.

On a changeset the total is split evenly between the change requests in the prompt, so five members
get a fifth of it each. That is deliberate — a single shared pool let the first member's description
consume it all and left the rest with nothing.

### `codeVerdict.context.maxLinkedItems`

Default: `5`

Most linked work items pulled in as context.

### `codeVerdict.context.includeTitle`

Default: `true`

Whether the title toggle starts on for a new review. It can still be turned off for a single run.

### `codeVerdict.context.includeDescription`

Default: `true`

Whether the description toggle starts on for a new review. Can still be turned off per run.

### `codeVerdict.context.includeLinkedItems`

Default: `true`

Whether linked work items start included. Individual items can still be removed or restored per run.

### `codeVerdict.contextUsage.enabled`

Default: `true`

Shows the estimated context-window usage of the selected model before you press Run. Hiding it
changes nothing about what is sent — the budgets above still apply. Open review screens react to
this immediately.

---

## Run limits

Short entries. The reasoning, the sizing table and the arithmetic are in
[REVIEW-BUDGETS.md](REVIEW-BUDGETS.md). Prefix each name below with `codeVerdict.` for the full key.

| setting | default | what it bounds |
| --- | --- | --- |
| `harness.maxElapsedSecondsPerAttempt` | `1800` (30 minutes) | wall-clock time for one attempt |
| `harness.maxModelTurnsPerAttempt` | `64` | back-and-forth turns with the model |
| `harness.maxToolRequestsPerAttempt` | `256` | total tool calls — reads, diffs, searches |
| `harness.maxPromptKilobytesPerTurn` | `192` (KB) | size of one assembled prompt, framing and content together |
| `harness.maxEvidenceMegabytesPerAttempt` | `8` (MB) | cited evidence the attempt holds at once |
| `harness.highRiskReservePercent` | `20` | share of turns, calls and evidence held back for high-risk files the model did not pick |
| `harness.verificationReservePercent` | `15` | share held back for the final verification pass |

Four things worth knowing before you touch these:

- **The two reserves are subtracted before investigation starts.** With the defaults, ordinary
  investigation may spend 65% of each pool — 167 of the 256 tool calls, not 256. It cannot dip into
  a reserve when it runs short.
- **Units are easy to misread.** Seconds, kilobytes and megabytes respectively; the two reserves are
  percentages, 0–100.
- **A bad value falls back on its own.** Each field is checked separately: one unusable value uses
  its own default and leaves the rest of your settings alone. Whole-number fields round fractions
  down. The two reserve percentages are the one exception — if they add up to more than 100, both
  go back to 20 and 15 together, even if you only mistyped one of them.
- **You can confirm a dial took effect.** Each attempt writes its resolved limits into the agent
  trace, naming for every one whether your configured value was used or rejected.

Lower `maxPromptKilobytesPerTurn` to about `128` for a small local model that stalls on large
prompts, and raise `maxModelTurnsPerAttempt` alongside it — the same files then take more turns.

---

## Limits that are not settings

Some things that bound a review are fixed in code. If you are looking for a dial for one of these,
there is not one.

| limit | fixed value |
| --- | --- |
| changed files per manifest page | 100 |
| tool calls per model turn | 8 |
| per-changeset-member floor | 4 tool calls and 128 KB evidence each; model turns are not reserved per member |
| activity log size cap | 1 MB per attempt, alongside the settable event count |
| checkpoint size cap | 8 MB per review, alongside the settable checkpoint count |
| quiet hours window | 18:00–08:59 local time |
| digest flush times | top of the hour / 09:00 and 17:00 / 17:00 |
| background poll allowance | 1,200 requests per hour, 4 requests per repository per poll |
| retry backoff | 1 s doubling to 30 s, with jitter; a server's own requested wait wins |
| protocol repairs | 2 per phase |
| diff and file-read page size | 20,000 lines or 256 KB, whichever is reached first |
| search result page size | 50 matches or 64 KB, whichever is reached first |

Three of these are page sizes a provider may declare for itself: the changed-file list, diff and
file reads, and search. A provider asking for smaller pages than the table gets them. A provider
asking for larger ones is not granted them — every call to that tool is refused instead, so the tool
stops working for the review. Every other row is fixed whatever the provider declares.

The per-member floor matters on a changeset: each member gets four tool calls and 128 KB of evidence
of its own before any member draws on the shared pool. Model turns are not split this way — one
conversation covers the whole changeset — so no member has turns reserved for it. The floor is also
not a guarantee: if the ordinary lane is too small to give every member four calls, each gets an
equal smaller share and the review records that it happened.

---

## Run behaviour and recovery

### `codeVerdict.harness.requireInspectionMinRisk`

Default: `"medium"` — one of `low`, `medium`, `high`.

The lowest risk level that must actually be **read**, not merely classified, before a review may
call itself complete. At `medium`, every changed file classified medium or high must be opened;
low-risk files — documentation, specifications, generated output — count as covered without being
read. Real source code is never classified low, whatever the model proposes.

Set it to `high` and medium-risk files count as covered without being opened too — useful on a large
but low-stakes change. Set it to `low` and every changed file must be opened, whatever its risk.
See [REVIEW-BUDGETS.md](REVIEW-BUDGETS.md).

### `codeVerdict.harness.scopeInvestigationToChangedFiles`

Default: `false`

**This does not switch off your repository's coding rules, whatever the settings UI implies.** The
description shown in VS Code says the `AGENTS.md` policy lookup is withheld and the model is left
with "only the change's own diffs and details". Your root `AGENTS.md` and `CLAUDE.md` are read and
sent to the model whichever way this is set — the extension reads those two files itself before the
review starts, not through anything this setting withholds.

What it does do: keeps the review to the files the change actually touched. Turning it on takes
three things away from the model — reading an unchanged file, searching the repository, and looking
up further `AGENTS.md` files deeper in the tree, which needs the same permission as reading a file.
Diff reads and diff searches stay available either way.

Off by default because reviews read from a local copy of the repository: looking at an unchanged
file to corroborate a finding costs a local file read and nothing else. Turn it on for a smaller
prompt and a review that cannot look outside the change.
See [REVIEW-BUDGETS.md](REVIEW-BUDGETS.md).

### `codeVerdict.harness.transientRetriesPerOperation`

Default: `3`

How many times one tool call or model turn is retried after a temporary failure — a network blip, a
rate limit — before it gives up. `0` means one try and no retry.

The wait between retries is not settable: it doubles from 1 second up to 30 seconds, with a small
random offset. A server that asks for a specific wait gets it, whether that is longer or shorter
than the 1-to-30-second pattern would have been.

Raise it if reviews fail on errors that would have cleared a moment later.

### `codeVerdict.harness.checkpointCadenceToolCalls`

Default: `10`

How many completed tool calls pass between checkpoints inside a phase. This is **in addition to**
the checkpoint always taken at every phase boundary, so lowering it only adds checkpoints, it never
removes the boundary ones.

Lower it to resume closer to where a long review was interrupted, at the cost of more writes.

### `codeVerdict.harness.retainedCheckpointsPerLineage`

Default: `3`

How many checkpoints are kept for one review's resume history. A fixed 8 MB cap per review applies
as well, so raising this does not guarantee you get that many back — whichever limit is reached
first prunes.

### `codeVerdict.harness.maxActivityEventsPerAttempt`

Default: `1000`

How many activity-log entries — plan updates, coverage progress, checkpoints — one attempt may hold.
Nothing is deleted when the limit is reached. A run of routine "tool finished" entries for the same
tool is folded into one entry that says how many there were and when the run started and ended; plan
updates, checkpoints and the rest are never folded. A fixed 1 MB cap does the same thing, and
whichever is reached first causes the folding.

If folding is not enough — the entries that cannot be folded exceed the limit on their own — the
checkpoint is still written but marked unusable for resuming. Raise this on a long review if you
want each tool call listed individually, or if resumes are failing for this reason.

### `codeVerdict.harness.terminalAttemptHistoryCount`

Default: `5`

How many finished attempts are kept per change request or changeset before the oldest is pruned.

### `codeVerdict.harness.terminalAttemptHistoryMaxAgeDays`

Default: `30`

How many days a finished attempt's history is kept regardless of the count above. Both rules apply
— whichever prunes first wins — so raising only one of them may not keep an old attempt.

---

## Model call timeouts and concurrency

The three windows below are separate on purpose and do not substitute for each other. `0` turns a
window off. A value so large it cannot be timed (above roughly 2,147,483 seconds, about 25 days) is
read as "no limit" rather than as a timer that fires immediately. A negative value, or anything that
is not a number, falls back to that window's default rather than to `0`.

### `codeVerdict.agentRun.firstOutputSeconds`

Default: `300`

How long the model may take to produce its **first** output after a request is sent. A large review
sends a large prompt, and reading it before the first token legitimately takes longer than any later
gap. `0` leaves the ceiling below as the only bound on a slow start — it does not fall back to the
inactivity window.

Raise it for a local model that has timed out producing nothing at all.

### `codeVerdict.agentRun.inactivitySeconds`

Default: `90`

Gives up when the model has started answering but nothing further has arrived for this long. The
clock starts at the first output and restarts on every fragment, so a run that keeps streaming is
never cut off however long it takes overall.

### `codeVerdict.agentRun.ceilingSeconds`

Default: `600`

A long-horizon check. Every time this many seconds pass, the run is checked once: output arrived
during that window and it continues, nothing arrived at all and it is cancelled. It never stops a
run that is still producing. With the other two at their defaults this never fires first; it is what
remains when you set them to `0`.

### `codeVerdict.agentRun.maxConcurrent`

Default: `3`

How many reviews may run at once. Reviews beyond this queue and start as earlier ones finish —
triggering one never refuses or cancels another. Each running review costs a separate model request
against your Copilot allowance.

`0` removes the limit. A value that is not a usable count — negative, or not a number — falls back
to `3`, **not** to unlimited, so a mistyped digit cannot start twenty model requests. Fractions
round down.

---

## Notifications

### The four delivery styles

Every event setting below takes one of these.

| mode | what happens |
| --- | --- |
| `Interrupt` | a VS Code notification right away; choosing "Later" on it moves the item to the badge |
| `Badge` | counted on the status bar bell, listed when you click it, cleared when you have seen the list |
| `Digest` | queued and delivered in one batch at the next flush time |
| `Off` | dropped; nothing is recorded |

The four names are case-sensitive. Anything else — `interrupt`, a typo, a number — falls back to
that one event's own default from the table below, and every other event keeps what you configured.
It does **not** fall back to `Off`, which is what a typo used to produce: an event you had set
louder went silent instead.

### `codeVerdict.notifications.quietMode`

Default: `false`

During quiet hours, demotes `Interrupt` to `Badge` for every event except CI failures and direct
mentions. `Badge`, `Digest` and `Off` are never changed.

The window is fixed at 18:00–08:59 local time and is not configurable. Anything that is not `true`
or `false` reads as off.

### `codeVerdict.notifications.events.*`

One setting per event; each takes one of the four modes above. These seven have no description in
the VS Code settings UI, which is why they are spelled out here. Prefix each with `codeVerdict.` for
the full key.

| setting | default | fires when |
| --- | --- | --- |
| `notifications.events.agentFinished` | `Interrupt` | a review finished — including failed, cancelled and partial outcomes |
| `notifications.events.replyPosted` | `Interrupt` | someone replied to a comment you posted |
| `notifications.events.authorPushed` | `Badge` | the author pushed after your review |
| `notifications.events.pipelineFailed` | `Digest` | a watched CI run failed |
| `notifications.events.reviewRequested` | `Interrupt` | a change request is waiting on you |
| `notifications.events.mentioned` | `Badge` | a discussion mentioned your username |
| `notifications.events.threadStale` | `Digest` | new commits moved a line you had reviewed |

`pipelineFailed` and `mentioned` are the two exempt from quiet-hours demotion.

### `codeVerdict.notifications.digestCadence`

Default: `"End of day"` — one of `Hourly`, `Twice a day`, `End of day`.

When queued digest items are delivered. The clock times are fixed: `Hourly` flushes at the top of
the next hour, `Twice a day` at the next 09:00 or 17:00, `End of day` at the next 17:00. Changing
this re-aims the pending flush straight away.

The three names are case-sensitive; anything else reads as `End of day`, and the settings panel
shows `End of day` selected to match.

### `codeVerdict.notifications.pollIntervalSeconds`

Default: `60`, accepted range 30–900.

**A floor, not the interval.** One background check costs four requests per watched repository plus
one per review waiting on replies, so the actual gap grows with the size of the pod to stay inside
the hourly request budget. A twenty-repository pod earns a much longer gap than 60 seconds whatever
you set here, and the gap is capped at 900 seconds.

Raising it slows background checks. Lowering it below what the pod costs does nothing.

---

## Changesets

### `codeVerdict.changesets.trailer`

Default: `"Part-of:"`

The commit-message or description trailer that marks change requests as belonging to one changeset.
The trailing colon is optional — `Part-of` and `Part-of:` behave the same. Trailer detection takes
precedence over branch-name matching.

A value that is not a string reads as `Part-of:`. Regex metacharacters in a trailer are matched
literally, so a trailer like `Part-of (v2):` looks for exactly that text.

Change it if your team already uses a different trailer.

### `codeVerdict.changesets.branchDetection`

Default: `true`

Suggests a changeset when change requests across repositories share a source branch name. Only a
fallback — a trailer match always wins.

Anything that is not `true` or `false` reads as on — the shipped default — rather than being taken
for a "falsy" off.

Switch it off if reused branch names (`fix`, `main-sync`) produce noise.

---

## Privacy and diagnostics

Nothing is ever shared with anyone else. The "Data & privacy" section of the settings panel lists
what the selected agent and model receive; nothing reaches your forge until you press Submit, and
rejected findings and their rationale never leave the machine. There is no telemetry setting because
there is no telemetry.

### `codeVerdict.trace.api`

Default: `false`

Logs every API request — method, full URL, status, elapsed time, remaining rate limit, and the full
request and response body — to the "Verdict: API" output channel, each line led by the local time.

Credentials are removed: request headers are never logged at all, a token carried in a URL is
replaced before the line is written, and credential-shaped text inside a body is redacted. A body
too large for one write says how many bytes were left out rather than cutting silently.

Only a literal `true` turns it on. Any other value — `1`, `"yes"`, an object — leaves it off, so a
mistyped value cannot start logging request and response bodies into a channel VS Code copies into
its own log directory.

Takes effect on the next request; no reload needed.

### `codeVerdict.trace.rawPayloads`

Default: `false`

Debugging only. Writes the full, unredacted prompt sent to the model and the full text it replies
with to the "Code Verdict: Agent Trace" output channel.

**This is not the same as "nothing reaches disk."** It keeps raw text out of everything Code Verdict
itself writes — the activity log, checkpoints, retained review details, run diagnostics, and the
`agent-trace.log` file — whether it is on or off. But VS Code captures every output channel into its
own log directory, so while this is on, those prompts and replies are in VS Code's logs.

Only a literal `true` turns it on, for the same reason as `trace.api` above.

Read fresh on every request, so toggling it applies to the very next one.

### `codeVerdict.autoAdvance`

Default: `true`

After you decide a finding, move to the next undecided one instead of staying put. Turn it off to
review your own verdict before moving on. Both the single change-request screen and the changeset
screen read the same value, so they never disagree.

Anything that is not `true` or `false` reads as on — the shipped default. It is not taken for a
"falsy" off, which would have looked exactly like switching it off deliberately.

Read at the moment you record a verdict, so a change applies to the very next one.

---

## Appendix — where each group is read (maintainers)

| settings | module |
| --- | --- |
| `harness.*` | `src/ui/harnessPolicyOptions.ts`, normalized in `src/domain/harnessPolicy.ts` |
| `context.*`, `contextUsage.enabled` | `src/ui/contextOptions.ts` |
| `agentRun.*` | `src/ui/agentRunOptions.ts` |
| `notifications.*` | `src/ui/notifier.ts`, routed in `src/domain/notifications.ts`, digest flush in `src/app/notificationCenter.ts`, poll gap in `src/app/pollSchedule.ts` |
| `changesets.*` | `src/ui/changesetOptions.ts` |
| `agentLocations` | `src/ui/agentLocations.ts` |
| `showDemoAgent` | `src/ui/agentRefresh.ts`, applied in `src/app/agents.ts` |
| `instanceUrl` | `src/ui/onboarding.ts` |
| `agentVoice` | `src/ui/reviewFlow.ts`, `src/ui/changesetReview.ts`, composed in `src/domain/summary.ts` |
| `autoAdvance` | `src/ui/reviewPanelOptions.ts`, used by both `src/ui/reviewFlow.ts` and `src/ui/changesetReview.ts` |
| `trace.api` | `src/extension.ts` |
| `trace.rawPayloads` | `src/app/lmAgent.ts` |
| the seven removed keys | no reader, ever; swept out of `settings.json` by `src/ui/settingsMigration.ts`, called from `src/extension.ts` at activation |

Every setting above resolves an unusable value to its own declared default. Each is validated by
type where it is read, not by trusting `get`'s two-argument default — that default only covers a key
that is absent, so any other value in `settings.json` reaches the code that uses it.
