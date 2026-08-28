## Context

See proposal.md — Why. The constraints that shape the approach:

- **The run is panel state today.** `ReviewFlowPanel` holds `runSteps`, `runStep`, `runError`, `runToken` and a `RunLiveness` as instance fields (`src/ui/reviewFlow.ts:225-230`), and `run()` (`:553`) awaits `runLmAgent` against them. `ChangesetReviewPanel` repeats the shape (`src/ui/changesetReview.ts:127`, `:260`).
- **Two navigations already cancel by design.** `load()` bumps `runToken` for every new ref (`src/ui/reviewFlow.ts:317`) and `route.onLeave` bumps it on every route change (`:254`). Both were written to stop a stale result landing under the wrong ref — the right instinct, the wrong mechanism.
- **`runToken` never cancels anything.** `streamText` builds its own `CancellationTokenSource` and wires it only to the inactivity and ceiling timers (`src/app/lmAgent.ts:259`); `RunAgentOptions` (`:70`) carries `onProgress`, `trace` and `timeouts` and nothing else. A "cancelled" run keeps streaming to a listener that has stopped caring.
- **One surface, one panel.** `AppSurface` owns a single `vscode.WebviewPanel` and one active route (`src/ui/appSurface.ts`); `ReviewFlowPanel.current` and `ChangesetReviewPanel.current` are singletons over it. Concurrency cannot come from more panels.
- **Two paths delete the result on purpose.** `finishRun` clears the draft key on a clean run (`src/ui/reviewFlow.ts:652`) and a successful submit clears it again (`:1183`). Both are correct about the *ledger* and wrong about the *review*: the target then re-opens on the agent picker with the outcome gone, which is what the cached-result requirement rejects.
- **`rerun` exists but is not a settings change.** `FlowMessage` carries `{ type: 'rerun' }` (`src/ui/reviewFlowHtml.ts:206`) and its handler calls `run()` directly (`src/ui/reviewFlow.ts:907`) with whatever is already selected. There is no route from a shown result back to the pickers.
- **The completion path already writes everything a background run needs.** `finishRun` (`src/ui/reviewFlow.ts:689`) writes the `SessionDraft` to `workspaceState` under `codeVerdict.draft.<repoId>!<number>`, records a `ReviewRun`, and fires `onReviewReady`. `load()` already re-enters triage from that draft (`:412-433`). Most of "persist the state" is reachable by moving that method, not by inventing storage.
- **`finishRun` reads live globals.** It calls `this.pod()` → `podStore.activePod`, and `run()` writes the selection back onto the active pod before starting. A pod switch mid-run misattributes the result.
- **Storage has a stated concurrency contract.** `src/app/storage.ts` requires `get` and `update` with no `await` between them, and explicitly forbids adding a lock. Concurrent completions writing `ReviewRunStore` and the in-flight store must respect it.
- **Nothing below `src/ui` reads `workspace.getConfiguration`** (`src/ui/agentRunOptions.ts` states the rule). The concurrency cap is a setting, so it is read in the UI layer and handed down as a number.
- **Webview CSP drops inline styles** (`style-src 'nonce-…'`, `src/ui/theme.ts`). New sidebar and pill markup uses classes.
- **Zero runtime dependencies.** No scheduler or queue library.

## Goals / Non-Goals

**Goals:**

- One run manager, one run model, consumed identically by the single-change-request and changeset surfaces.
- Panels become subscribers: they render run state and trigger transitions, they never own a run's lifetime.
- Every run carries the inputs it started with, so nothing about it can be re-read from mutable globals at completion time.
- Cancellation that actually stops the model request and frees the slot it held.
- A run's result reaching storage and the notifier on exactly one path, whether or not a panel is alive.
- One retained review per target that every screen reads, so "what did the agent say about this change request" has a single answer that does not depend on which screen asks.

**Non-Goals:**

- Resuming a `vscode.lm` stream across an extension-host restart. There is no API for it; an interrupted run is reported, not recovered.
- More than one webview panel, or a run screen per target. The surface stays single; the manager is what multiplies.
- Two concurrent runs on the same target with different agents.
- Rate-limit negotiation with Copilot. The cap is a local budget, not a response to a quota signal.
- Changing the prompt, the response contract, the triage interactions, or what the submit ledger means.
- A history of past reviews on one target. The retained review is the latest one; a diff between two runs is not part of this change.

## Decisions

### D1 — A run manager in `src/app/`, constructed once in `activate()`

`ReviewRunManager` owns a `Map<string, RunRecord>` keyed by target, plus a FIFO of queued runs. It is created in `activate()` alongside `PodStore`/`ReviewRunStore` and lives for the window's lifetime, which is precisely the lifetime a background run needs.

It stays `vscode`-free in the way the rest of `src/app` is: the injected dependencies are `KeyValueStore`s, a runner function typed against `lmAgent`'s exports, and callbacks (`onChange`, `onReviewReady`, `onRunRecorded`). The one exception is the cancellation token type, handled in D5.

*Alternative rejected:* keeping the run in the panel and reviving it on re-entry from a persisted snapshot. The `lm` stream is not serialisable, so this only moves the problem — the run still dies with the panel.

### D2 — Target keys are the keys the rest of the extension already uses

- A single change request: `crKey(repoId, crNumber)` from `src/app/postedReviews.ts`, the exact key `ReviewRunStore.byRef()` and `ReviewHistory.submittedRefs()` are keyed by.
- A changeset: `changeset:<changesetId>`, prefixed so the two spaces cannot collide.

The dashboard's `Running…` pill is then one more `ReadonlyMap<string, …>` in `DashboardDeps` (`src/ui/dashboardState.ts:53`), looked up beside `reviewRuns` and `submittedRefs` with the key the row already computes.

### D3 — Every run carries an immutable snapshot taken at trigger

`RunRecord.input` holds `podId`, `criteria`, `agent` (the full `AgentDescriptor`), `modelId`, `ref`/`members`, `diff`, `reviewContext`, `timeouts`, `agentLabel`, `startedAt`. Nothing on the completion path reads `podStore.activePod`, `workspace.getConfiguration`, or panel fields.

This is what makes the spec's attribution requirement true rather than merely intended: the pod-switch and criteria-change scenarios both reduce to "the manager never looks". `run()`'s current `pod.agentId = …; upsert(pod)` stays in the panel as a selection-persistence step performed before the trigger, not as part of the run.

*Alternative rejected:* passing a pod id and re-reading the pod at completion. That is the current bug with an extra indirection.

### D4 — Six states, one transition function

`queued → running → (succeeded | failed | cancelled)`, plus `interrupted`, which is only ever produced by the activation sweep (D8) and never by a live transition. `RunState` is a discriminated union so `succeeded` carries the response, `failed` carries the `AgentRunError` fields the run screen already renders (`message`, `requestId`, `code`), and `cancelled` carries nothing.

A `failed` record is kept in the map, not deleted, until the target is re-run or its screen acknowledges it — that is what lets `load()` show a failure that happened while the reviewer was elsewhere, which the spec requires. `succeeded` and `cancelled` need no such holding: a success has already written the retained review the target opens on (D7a), and a cancellation leaves the previous state exactly as it was, which is the whole of what it promises.

### D5 — Cancellation is threaded through `RunAgentOptions`

`RunAgentOptions` gains `cancellation?: vscode.CancellationToken`. `streamText` keeps its own `CancellationTokenSource` for the two timeout windows and subscribes the caller's token to it:

```
options?.cancellation?.onCancellationRequested(() => cancelWith('caller'))
```

`AgentTimeoutReason` gains that third value, and the `catch` block's classification (`src/app/lmAgent.ts:313-322`) branches on it: a caller cancellation raises a distinct outcome, not the `agent stalled: no output for Ns` message every cancelled token currently produces. `AgentRunError` gains a `cancelled` flag beside `timedOut` so callers can tell the two apart without string matching.

The manager holds one `CancellationTokenSource` per running record and disposes it on every terminal transition. This is the manager's single unavoidable `vscode` import; the injected runner keeps the rest of it testable with a plain fake token.

*Alternative rejected:* leaving cancellation cosmetic. With a queue in play, a cancelled-but-still-streaming run either holds its slot (defeating the queue) or releases it while still consuming quota (defeating the cap).

### D6 — The cap is a semaphore counted in the manager, the setting is read in `src/ui`

`agentRunConcurrency()` joins `agentRunTimeouts()` in `src/ui/agentRunOptions.ts`, reading `codeVerdict.agentRun.maxConcurrent` with the same "not a usable number falls back to the default" guard. `0` means unlimited, matching the two timeout settings' documented convention.

The manager takes the limit as a number on each trigger, so a setting change applies to the next trigger without a restart and without the manager reading configuration. Slot release happens in exactly one place — the terminal transition — and immediately pumps the queue.

### D7 — Headless completion: `finishRun` moves whole, into the manager

The manager reproduces both existing branches against its snapshot rather than against panel fields:

- **findings** → `createReview(...)` from the snapshot, write the record under the same `codeVerdict.draft.<repoId>!<number>` key, `ReviewRunStore.record`, `onReviewReady`, `onRunRecorded`.
- **clean** → write a `clean` record to that same key (D7a — this is where the old deletion was), `ReviewRunStore.record` with `outcome: 'clean'`, `onReviewReady` with `itemCount: 0`, `onRunRecorded`.

The panel's `finishRun` becomes a subscriber: on a `succeeded` change for the target it is showing, it reads the draft the manager just wrote and renders triage. There is one writer, so a panel that happens to be open cannot double-write.

`onRunRecorded` and `onReviewReady` are wired from `activate()` into the manager, not through `ReviewFlowDeps`/`ChangesetReviewDeps`. The panel deps keep their callbacks only for events that are still panel-owned (submit).

The draft write follows the storage contract: `get` and `update` with no `await` between them, exactly as `ReviewRunStore.record` does today.

### D7a — `SessionDraft` becomes the retained review; nothing deletes it but a newer run

The record already holds the review, the verdicts, the summary text and the note, under `codeVerdict.draft.<repoId>!<number>` in `workspaceState`. It gains what it needs to stand on its own as a result rather than as work-in-progress:

```
outcome: 'clean' | 'findings'
ranAt: string
agentId, agentLabel, modelId
submittedAt?: string
```

Three writes change:

- **Clean run.** `finishRun`'s `update(draftKey, undefined)` (`src/ui/reviewFlow.ts:652`) becomes a write of a record with `outcome: 'clean'` and no items. That is what makes the clean screen re-openable at all.
- **Successful submit.** `update(draftKey, undefined)` (`:1183`) becomes a write that clears the ledger fields (`failedKeys`, `summaryPosted`, `verdictApplied`, `threadsAccum`, `postedIndividually`, `postedCount`) and sets `submittedAt`. The ledger's job — never re-post what landed — is done by clearing those fields; deleting the record was doing more than that job required.
- **A new run that succeeds.** The manager overwrites the record wholesale (D7). Verdicts, summary and note are not merged forward: they are decisions about findings that no longer exist.

The changeset side is the same record under a different key and a different starting shape. `ChangesetDraft` (`src/ui/changesetReview.ts:44`) lives at `codeVerdict.changesetDraft.<changesetId>` and carries `submitState` where the single-CR draft carries the six ledger fields. It gains the same five result fields and the same treatment: its post-submit deletion (`:563`) becomes a ledger-clearing write with `submittedAt`, and its clean branch (`:337`) — which today writes nothing at all — gains the `clean` record write. That branch is also where the two panels currently disagree: `reviewFlow` deletes the superseded draft on a clean run and `changesetReview` leaves it on disk, so a reload after a clean changeset re-run re-enters triage on the *previous* run's findings. Writing a `clean` record fixes that on the same edit rather than leaving one panel's latent bug behind.

Records are per target, so the store grows with targets reviewed, not with runs performed. Pruning is bounded the same way: a record whose change request is no longer open is dropped on the pod poll that observes it, on the path that already fetches open change requests (`fetchPodData`).

*Alternative rejected:* a second store in `globalState` beside `ReviewRunStore`, leaving drafts alone. It splits one answer across two stores keyed differently, and every screen would have to consult both and decide which is newer.

### D7b — `load()` shows the retained review; the re-run control routes back to the pickers

`FlowScreen` gains no new value. The existing `triage`, `clean` and `done` screens each render a retained record; which one is chosen follows `outcome` and `submittedAt`:

| record | screen |
| --- | --- |
| `outcome: 'findings'`, no `submittedAt` | `triage` |
| `outcome: 'findings'`, `submittedAt` set | `done` |
| `outcome: 'clean'` | `clean` |

All three gain the same control — "Run a new review" — which sets `screen = 'agent'` with the record's `agentId`/`modelId` pre-selected and the pod's criteria as they stand. `FlowMessage` gains `{ type: 'newRun' }` for that transition; the existing `rerun` keeps its meaning (run again with the current selection, from the stale-head banner) and is no longer the only way back.

Nothing about that transition touches the record. The manager's trigger is what starts a run, and only its success overwrites (D7a), which is what makes the spec's "fails, is cancelled, or is interrupted → unchanged" scenarios hold without a single explicit restore path.

The agent screen, when it is reached this way, keeps a way back to the retained review — so a reviewer who opened the pickers to look at the settings is not stranded away from the findings.

### D7c — A re-run in flight does not hide the review it may replace

The running screen for a target that has a retained record renders that record's headline alongside the progress, and offers to go back to it. This is the one place the two states coexist, and it falls out of the manager and the store being separate: the record is still there, the run is a different object, and the screen is free to show both.

### D8 — In-flight records persist; the sweep on activation produces `interrupted`

A small store, `InFlightRunStore`, keyed the same as D2, holding `{ key, kind, refLabel, podId, startedAt }`. Written when a record enters `running`, removed on every terminal transition.

`activate()` sweeps it before anything else touches review state: every leftover entry is recorded through `ReviewRunStore.record` with a new `outcome: 'interrupted'` and its `startedAt`, then removed. `ReviewRunOutcome` becomes `'clean' | 'findings' | 'interrupted'`; the dashboard pill and the tuning scorecard both read that union and each gains the third arm — the scorecard counts an interrupted run in neither the clean nor the findings column.

It lives in `globalState`, beside `ReviewRunStore`, because the review it names is a property of the change request, not of the workspace folder the reviewer happened to have open.

*Alternative rejected:* leaving the target silently at its previous outcome. A reviewer who started a review, closed the editor and came back has no way to tell "nothing ran" from "something ran and was lost".

### D9 — Panels subscribe; `load()` routes on manager state first

`load()`'s routing becomes, in order:

1. A run record for this target in `queued` or `running` → the running screen, rendering that record's liveness, with the retained review reachable beside it (D7c).
2. A `failed` run record not yet acknowledged → the failure screen, with the retained review still reachable.
3. A retained review record → `triage`, `done` or `clean` by the table in D7b.
4. Otherwise the agent picker.

A `succeeded` run record needs no arm of its own: succeeding is what wrote the retained record, so step 3 is already showing it.

The `runToken` field and both of its bumps (`src/ui/reviewFlow.ts:254`, `:317`) are deleted. The staleness they were guarding is now handled by the manager keying on the target: a result can only be delivered to subscribers of the target it belongs to, so it cannot land under another ref. `loadSeq` stays — it guards the CR/diff fetch, which is genuinely per-navigation.

`onLeave` unsubscribes and disposes the panel's view of the run; it touches no record.

### D10 — Liveness moves into the record; the push becomes a notification

`RunLiveness` (`src/ui/runLiveness.ts`) currently owns both the counters and a direct `webview.postMessage`. The counters move into the run record — a run with no panel attached still has to count fragments, because the reviewer may open it mid-flight and expect a real elapsed and fragment count. The 250 ms `PROGRESS_PUSH_MS` throttle stays, but it now throttles the manager's `onChange` emission; the webview write moves to whichever panel is subscribed, or happens not at all.

The throttle floors **progress updates only**. A state transition — into `running`, `succeeded`, `failed`, `cancelled` — always emits immediately and resets the throttle. Applied to transitions it would drop or delay a finish that landed within 250 ms of the last fragment, and the panel watching that target would sit on a spinner after the run was over.

## Risks / Trade-offs

- **Concurrent runs multiply Copilot consumption and can hit a quota the extension cannot see.** → The cap defaults to 3 rather than unlimited, and a run that fails on a quota response fails only its own target (already true of `AgentRunError`) instead of taking siblings with it.
- **A background run whose findings arrive silently is a result nobody looks at.** → Completion always raises the review-ready notification, and the sidebar and status bar carry the active-run count, so a run in flight is visible without opening a Verdict screen.
- **Deleting `runToken` removes a guard that was doing real work.** → Its job is replaced by target keying plus explicit acknowledgement of terminal records, both of which have direct tests in tasks.md. `loadSeq`, which guards the other race, is untouched.
- **Cancellation now depends on the model provider honouring the token.** → If a provider ignores it, the slot is still released on the manager's side and the result still discarded, so the behaviour is no worse than today; the difference is that today it is *always* that bad.
- **`ReviewRunOutcome` gaining a third value touches every reader.** → It is a union in one file with two readers (dashboard pill, tuning scorecard); the compiler names both.
- **The sweep runs before the first render on activation.** → It is two `globalState` reads and one write over a list that is empty in the common case, on the same path that already constructs three stores.
- **Retained reviews accumulate in `workspaceState`.** → One record per target rather than per run, and records for change requests that are no longer open are dropped on the poll that already lists them. A reviewer working hundreds of change requests in one workspace is the case to watch; the record is bounded by findings, which the criteria already cap.
- **Keeping a submitted review on screen could read as "not yet submitted".** → `submittedAt` selects the `done` screen, which already states what was posted; it is never the triage screen.
- **A retained review can be arbitrarily old and describe a head that has moved.** → The staleness machinery is untouched and still runs on open: `isStale` compares the record's `headSha` against the branch and `markMoved` reports which findings moved, so an old record arrives labelled rather than trusted.
- **Retained reviews are per workspace folder while run outcomes are global.** → The record lives in `workspaceState` and `ReviewRunStore` in `globalState`, so a dashboard row opened from a different workspace shows the outcome but opens without the findings. That split predates this change and is not widened by it; naming it here so the next reader does not read it as new.
- **A run outlives the pod it belongs to.** → Pod *deletion* cancels that pod's runs, from `activate()`'s existing `deletePod` handler; the snapshot's `podId` is what identifies them. Pod *switching* deliberately does not: the spec requires a run triggered under one pod to finish and record against that pod, which is exactly what the D3 snapshot is for. Cancelling on a switch would make the reviewer's act of looking at another pod destroy work they had started.
- **A completed run notifies while a different pod is active.** → The notification names the run's own change request, but its open action resolves the ref against whatever pod is active. The action is guarded on the snapshot's `podId` matching the active pod, so it never opens a ref against a pod that cannot see it.

## Migration Plan

No data migration. The three persisted shapes change compatibly:

- `SessionDraft` gains fields, all optional on read. A draft written before this change has no `outcome`, `ranAt` or agent fields: it is read as `outcome: 'findings'` (it has items, or it would not have been written) with the agent and model taken from the `Review` it already carries, and an unknown `ranAt`. No migration pass is needed — the fallback is in the reader.
- `ReviewRun` gains a third `outcome` value. Existing entries hold `clean` or `findings` and stay valid; a reader that does not know `interrupted` cannot exist, because both readers are compiled in this repo.
- `InFlightRunStore` is new and starts empty. An installation that has never run it sweeps nothing.

Rollback is a revert: the new store's key is simply left unread, and a `ReviewRun` with `outcome: 'interrupted'` falls to whatever the pre-change dashboard renders for an unrecognised outcome — worth confirming that branch is a default rather than a throw before merge.
