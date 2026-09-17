# Sizing a review: the budget dials

Every review runs as one bounded *attempt*. The attempt has a fixed allowance of model turns, tool
calls, evidence bytes and wall-clock time, and it stops when any of them runs out — reporting what
it covered rather than pretending it finished.

The defaults are sized for an ordinary change. A large one needs them raised, and **raising them
after the run has stopped is too late**: the attempt is over. This page is how to pick the numbers
before you start.

## The one thing that surprises people

You do not get to spend the whole allowance on reading files. Every pool is split into three lanes
before investigation begins:

| lane | share | what may spend it |
| --- | --- | --- |
| ordinary | 65% | the model's own investigation — reading diffs, searching, submitting |
| high-risk reserve | 20% | files the model did not choose but the host judged high-risk |
| verification reserve | 15% | the final pass that checks findings before you see them |

The shares come from `codeVerdict.harness.highRiskReservePercent` (20) and
`verificationReservePercent` (15); ordinary is whatever is left.

So with the default 256 tool calls, investigation may spend **167**, not 256. The reserves are not
a safety margin the review can dip into when it runs short — a medium-risk file may not draw on the
high-risk lane at all.

This is what makes a large change fail in a way that looks like it should have worked. A 206-file
change needs about 210 reads before a single finding is written. Against 167, full coverage is not
tight — it is arithmetically impossible, and the review will stop with calls apparently "remaining"
that it was never allowed to touch.

## Sizing by changed-file count

Read the file count from the change request before you start.

| changed files | `maxToolRequestsPerAttempt` | `maxModelTurnsPerAttempt` | `maxElapsedSecondsPerAttempt` |
| --- | --- | --- | --- |
| up to 120 | 256 (default) | 64 (default) | 1800 (default) |
| 120–160 | 340 | 70 | 2400 |
| 160–220 | 460 | 80 | 3000 |
| 220–300 | 620 | 100 | 4200 |
| 300–400 | 820 | 130 | 5400 |
| over 400 | review in pieces instead | | |

The defaults hold further than people expect — up to roughly 120 changed files. Past that they stop
being tight and start being impossible.

The rule behind the table, if your change does not fit a row:

```
ordinary calls needed = files × 1.3 + 8
tool calls            = ordinary calls ÷ 0.65
model turns           = (ordinary calls ÷ 8 + 15) ÷ 0.65
```

`× 1.3` assumes most files are read once and some are re-read or searched — small changes get
re-read more, large ones rarely twice. The `+ 8` is bootstrap. `÷ 0.65` converts what investigation
needs into a total that survives the reserve split. `÷ 8` is the per-turn tool cap, and `+ 15` leaves
turns for planning, submitting findings and asking to finish.

Round up. An attempt that stops one call short of coverage wastes everything it already spent.

## Prefer smaller reviews to bigger budgets

The budget is per attempt, so splitting a branch into two change requests of 100 files each works
with the defaults and finishes sooner than one 200-file attempt with the dials raised. It also gives
better findings: the model holds a smaller change in view, and evidence stays citable for longer.

Raise the dials when the change genuinely cannot be split — a generated migration, a dependency bump
that touches everything, a rename across a package.

## The other dials, and when they are the real answer

### `requireInspectionMinRisk` (default `medium`)

The lowest risk level that must actually be *read*, not merely classified, before a review may call
itself complete. At `medium` — the default — nearly every source file in a change must be read, which
is what makes coverage expensive on a large change.

Setting it to `high` lets a large review finish honestly having read the files that matter most and
classified the rest. That is a real trade, not a trick: you are choosing to accept a complete review
of the risky files over an incomplete review of everything. Prefer it to raising budgets when the
change is large but mostly low-stakes — a bulk rename, a formatting sweep, a lockfile.

### `maxEvidenceMegabytesPerAttempt` (default 8)

How much cited content the attempt holds at once. Raise it when a large change makes the run stop on
evidence rather than on calls. Symptom: reads start being refused while tool calls remain.

The arithmetic behind it changed when reviews started reading from a local copy of the repository
rather than from the forge. A review now holds every file in the repository at both pinned commits —
a shallow fetch is shallow in *history*, not in content — so a model may read a file the change
never touched for the cost of a local file read. That is the point: a finding can be corroborated
against the code that calls the changed function. It also means this pool, not a rate limit, is what
stops a review that wanders. Two things follow:

- Reading unchanged files spends evidence bytes like any other read. A review that corroborates
  widely on a large change may stop on evidence where it used to stop on calls.
- Only a *diff* read counts as inspecting a changed file (`readDiff`). Reading a changed file whole
  with `readFile` spends the bytes and moves coverage not at all, because a whole file says nothing
  about what this change did to it.

### `codeVerdict.harness.scopeInvestigationToChangedFiles` (default off)

Turn it on to withhold `readFile`, `searchRepository` and the `AGENTS.md` policy lookup that rides on
the same capability, leaving the model only the change's own diffs and details. It was on by default
while every unchanged-file read was a metered API call to a forge; that cost is gone, so it is off.

What turning it on buys, measured on this project's own small-review scenario: 86,620 prompt bytes
against 91,786 unscoped — about 6% — because three fewer tools are described to the model on every
turn. What it costs is a review that cannot look outside the change to check itself.

### `highRiskReservePercent` / `verificationReservePercent` (20 / 15)

You can widen the ordinary lane by shrinking these instead of raising the total. Usually don't. The
verification reserve pays for checking findings against their cited bytes before they reach you, and
a review that spends it on reading has nothing left to verify with — which is how a run produces more
findings and worse ones.

### `codeVerdict.harness.maxPromptKilobytesPerTurn` (default 192)

The cap on one prompt — everything in it. This is the only dial here that bounds a single model
call rather than a whole attempt, and it is the one to reach for when a review stalls instead of
running out.

The problem it fixes, measured on one 40-call review of a 207-file change: the prompt swung between
55 KB and 426 KB. It is rebuilt every turn rather than accumulated, so its size is decided entirely
by how much content the previous turn's tool calls returned — eight files at the measured 17.5 KB
average is 140 KB of diff in one prompt, on top of everything else. Two runs on a local model died
of it: 287 KB produced no output at all in 300 seconds, while the same model answered 57-150 KB
prompts in 90-280 seconds. Copilot absorbed 262 KB in 48 seconds.

**Two numbers, and the setting is only one of them.**

| | what it is | who sees it |
| --- | --- | --- |
| the cap | this setting, on the whole assembled prompt | enforced on every prompt sent, without exception |
| the content allowance | the cap minus everything else in that turn's prompt | told to the model |

"Without exception" is literal: every prompt a model is handed passes one check, including the
single-purpose prompt that asks the model to challenge a finding against its cited evidence. A
prompt that cannot be made to fit is not sent at all, and the run says so rather than quietly
sending it.

The second is not a fixed fraction of the first. The smallest prompt in the measured review was
55 KB with zero bytes of tool results in it — 27 KB of that the change-request description alone —
and the investigation map grows as files are read. So the allowance is computed at assembly from
the real bytes of that turn, and the prompt names both figures and says which is which. Telling a
model it may request 192 KB would over-promise by at least 55 KB on every large turn.

**What the model gets, and what happens when it over-asks.** The investigation map prints each
unread file's exact diff size beside its churn (`not read src/app/harnessAttempt.ts +2102/-38
126KB`), so a legal set of eight is pickable without a round trip. If it asks for more anyway, its
requests are served in its own order until the next result would not fit, and the rest come back
named, unspent, and re-requestable — no wasted turn and no silent truncation. A file whose diff
alone is bigger than the whole allowance is refused terminally, with its size and the cap in the
refusal, and counts against coverage like any other file the review could not read.

A search or a file read has no size anyone can know before it runs, so the turn reserves the most
its page can return (`searchResultPageBytes`, `diffOrFileReadPageBytes`) and defers it when that
will not fit — except on a turn nothing has touched yet, where the whole allowance is in front of
it and it goes straight out. The alternative was to send it whenever a single byte was left and
drop the result at assembly if it overshot, which spends a provider call and a slice of the
evidence budget on bytes the model never sees. The cost of reserving instead: one extra round trip
for a search asked for at the end of a full turn.

A result costs the prompt more than its own content — its envelope, and the map line flipping from
`not read` to `read` — and findings the model submits in the same turn cost more still. Both are
charged before a read is served: the overhead is measured from the turn's own previous result
rather than guessed, and a turn that sends eight findings alongside a read holds room back for
them. Measured on a two-file review at a 120,000-byte cap, a read anywhere in the 455 bytes above
the true fit used to be fetched and then dropped; eight findings sharing a turn widened that to
1,370.

**Choosing a value.** The default optimises for the measured shape rather than for the weakest
model, and the two genuinely conflict: "survivable on a local model" is 150 KB by the measurements,
while one full turn of eight 15 KB files on a 55 KB floor needs 176 KB. 192 KB takes the second and
sits a third below the 287 KB that produced nothing.

| your model | value |
| --- | --- |
| Copilot, or any hosted model | 192 (default); higher buys nothing measured |
| a small local model that stalls on large prompts | 128 |
| a local model that has timed out with no output at all | 96, and raise `agentRun.firstOutputSeconds` |

Lowering it does not lose coverage — it spends more turns on the same files — so raise
`maxModelTurnsPerAttempt` alongside it on a large change.

Two conditions are reported rather than absorbed. `promptBudgetOverrun` means the assembled prompt
had to have whole results dropped to fit, which is an accounting miss on our side and costs the
model evidence it had already paid for. `promptBudgetNoRoom` means this review's own framing does
not fit the cap at all — a very large change-request description against a low setting — so no turn
has room for any evidence; the run says so before the first turn instead of reading nothing for
forty of them.

A dropped result also never counts as inspected. The file goes back to unread, its evidence stops
being citable, and the review reports itself incomplete about it — a read the model was not shown
is not a read. When the drop proves the file cannot fit any turn (a provider whose manifest
under-reported the diff it then served), the file is closed as oversized with its measured size in
the reason, so the model is not sent back to fetch it again.

### `maxElapsedSecondsPerAttempt` (default 1800)

Raise it alongside turns and calls. A bigger call budget that times out at 30 minutes has not helped.

### Timeouts, which are not budgets

`agentRun.firstOutputSeconds` (300) bounds how long the model may take to *begin* answering; a very
large prompt legitimately takes longer to ingest. `agentRun.inactivitySeconds` (90) bounds silence
*after* answering has started. They are separate on purpose — a stall mid-answer is usually worth
retrying, a slow start is not a fault.

## What a "small" review means

A small review is not a mode you select. It is what happens when the whole changed-file list fits in
one manifest page and its bytes fit the ordinary evidence lane without touching a reserve
(`isSmallReview`, `src/app/harnessAttempt.ts`). The same phases run either way — just fewer times.

## Reading the stop report

When an attempt stops short it says which pool ran out and how much was left:

```
modelTurns: 81% of 64 used; 12 remaining.
modelTurns: ordinary budget exhausted; only high-risk coverage and verification may continue.
```

"12 remaining" against an exhausted ordinary lane means the remaining turns are reserve the
investigation could not legally spend. That is the signature of a change too large for its budget,
not of a run that gave up early.
