## 1. Cancellation reaches the model request

- [x] 1.1 Add `cancellation?: vscode.CancellationToken` to `RunAgentOptions` in `src/app/lmAgent.ts` and subscribe it to `streamText`'s existing `CancellationTokenSource` (D5).
- [x] 1.2 Add `'caller'` to `AgentTimeoutReason` and branch the `catch` classification on it, so a caller cancellation no longer reports the inactivity-stall message.
- [x] 1.3 Add a `cancelled` flag to `AgentRunError` beside `timedOut`, and leave `requestId` and the trace lines as they are.
- [x] 1.4 Tests in `src/app/lmAgent.test.ts`: a cancelled caller token ends the stream and raises `cancelled` (not `timedOut`); the two timeout windows still raise `timedOut` with their existing reasons; a token that is never cancelled changes nothing.

## 2. The retained-review record

- [x] 2.1 Extend `SessionDraft` with `outcome`, `ranAt`, `agentId`, `agentLabel`, `modelId` and `submittedAt`, all optional on read (D7a). Move the type out of `src/ui/reviewFlow.ts` into `src/app/` so the manager and both panels share one declaration. Give `ChangesetDraft` (`src/ui/changesetReview.ts:44`) the same five fields under its own key.
- [x] 2.2 Write the reader that fills in the pre-change shape: no `outcome` reads as `findings`, agent and model come from the carried `Review`, `ranAt` unknown. Test it against a literal of the old shape.
- [x] 2.3 Replace the clean-run deletion (`src/ui/reviewFlow.ts:652`) with a `clean` record write.
- [x] 2.3a Make the changeset clean branch (`src/ui/changesetReview.ts:337`) write a `clean` record too — today it persists nothing, so a reload after a clean re-run re-enters triage on the previous run's findings. Cover that case with a test.
- [x] 2.4 Replace both post-submit deletions (`src/ui/reviewFlow.ts:1183` and `src/ui/changesetReview.ts:563`) with a write that clears only the ledger fields (`failedKeys`, `summaryPosted`, `verdictApplied`, `threadsAccum`, `postedIndividually`, `postedCount`) and sets `submittedAt`.
- [x] 2.5 Tests: a clean run leaves a re-openable record; a successful submit leaves a record with `submittedAt` and an empty ledger; a retry after a partial failure still refuses to re-post what landed.

## 3. The run manager

- [x] 3.1 Create `src/app/reviewRunManager.ts`: `RunRecord` (immutable input snapshot per D3 + `RunState` per D4), the target-keyed map, and the FIFO queue. The snapshot covers all three run kinds — single CR, changeset, and the demo agent — so which runner executes is part of the input, not a branch the panel keeps.
- [x] 3.2 Implement `trigger(input, limit)`: refuse a target that is already `queued` or `running` and return the existing record; otherwise admit, and either start or queue against the limit (`0` = unlimited).
- [x] 3.3 Implement the transition function and slot release: every terminal transition disposes the run's `CancellationTokenSource`, releases its slot, and pumps the queue in trigger order.
- [x] 3.4 Implement `cancel(key)` for both a running record (cancel the token) and a queued one (drop it without ever making a request).
- [x] 3.5 Implement headless completion (D7): findings → build the `Review` from the snapshot and write the retained record; clean → write the clean record; both → `ReviewRunStore.record`, `onReviewReady`, `onRunRecorded`. Follow the `src/app/storage.ts` contract — `get` and `update` with no `await` between them.
- [x] 3.6 Implement `cancelForPod(podId)`, used when a pod is deleted.
- [x] 3.7 Move the liveness counters into the record and make `onChange` the throttled emission (D10), keeping `PROGRESS_PUSH_MS` as the floor for **progress only**: every state transition emits immediately and resets the throttle. Test that a finish landing within 250 ms of a fragment still reaches the subscriber at once.
- [x] 3.8 Move the demo-agent branch (`runDemoAgent` plus its 320 ms step walker, `src/ui/reviewFlow.ts:565-577`) into the manager as state emissions rather than panel `render()` calls, so a demo run survives navigation like any other. Test that navigating away mid-walk still finishes it.
- [x] 3.9 Tests in `src/app/reviewRunManager.test.ts`, against an injected fake runner and in-memory stores:
  - a finish with no subscriber writes the retained record and records the run;
  - a clean finish with no subscriber writes a clean record;
  - a second trigger on a running target is refused and the first is untouched;
  - two triggers on different targets both run;
  - cancelling a running run frees a slot and starts the queued one;
  - cancelling a queued run makes no request and advances the ones behind it;
  - a failed run frees its slot and leaves the retained record intact;
  - a pod switch between trigger and finish does not change what the result is recorded against;
  - `limit: 0` never queues.

## 4. In-flight persistence and the interrupted sweep

- [x] 4.1 Add `InFlightRunStore` (`globalState`, keyed as D2) written on entry to `running` and removed on every terminal transition.
- [x] 4.2 Add `'interrupted'` to `ReviewRunOutcome` in `src/app/reviewRuns.ts`; follow the compiler to the dashboard pill and the tuning scorecard and give each its third arm (an interrupted run counts as neither clean nor findings).
- [x] 4.3 Write the activation sweep: every leftover entry becomes a recorded `interrupted` run carrying its `startedAt`, then is removed.
- [x] 4.4 Tests: a leftover entry sweeps to `interrupted` and clears; a completed run leaves nothing to sweep; the sweep does not touch the target's retained review.

## 5. Panels become subscribers

- [x] 5.1 Delete `runToken` and both bumps from `src/ui/reviewFlow.ts` (`:254`, `:317`); leave `loadSeq` alone. Do the same in `src/ui/changesetReview.ts` (`:145`, and the `cancel` case at `:393`).
- [x] 5.2 Move `run()`, `finishRun()` and `recordRun()` out of both panels, demo branch included; `run()` becomes a trigger call carrying the snapshot, with the selection still persisted to the pod before triggering.
- [x] 5.3 Subscribe each panel to the manager for its current target, and unsubscribe in `onLeave` without touching the record.
- [x] 5.4 Rewrite `load()`'s routing to the four ordered arms in D9, including the retained-record table in D7b.
- [x] 5.5 Add `{ type: 'newRun' }` to `FlowMessage` and the "Run a new review" control to the `triage`, `clean` and `done` screens; it opens the pickers pre-selected from the record and keeps a way back to the review (D7b). Leave the existing `rerun` message as it is.
- [x] 5.6 Render the retained review beside a run in flight on the running screen, with a control back to it (D7c).
- [x] 5.7 Confirm the staleness path still runs on open against a retained record (`isStale`, `markMoved`) — an old record must arrive labelled.
- [x] 5.8 Tests in `src/ui/reviewFlowHtml.test.ts` and the panel tests: each of the three retained-record shapes renders its screen and carries the control; the running screen renders both; no new markup uses an inline `style=` attribute (webview CSP).

## 6. Concurrency setting

- [x] 6.1 Add `codeVerdict.agentRun.maxConcurrent` to `package.json`, described with the `0` = no limit convention the two timeout settings already use.
- [x] 6.2 Add `agentRunConcurrency()` to `src/ui/agentRunOptions.ts` with the same non-usable-value guard as `windowMs`, and test it (unset, `0`, negative, non-numeric, large).

## 7. Visibility outside the run screen

- [x] 7.1 Sidebar: an active-runs section listing target, state, elapsed and a cancel control, fed by the manager's `onChange`.
- [x] 7.2 Status bar: a running-review count segment, hidden at zero the way the bell already is.
- [x] 7.3 Dashboard and changeset rows: a `Running…` / `Queued` pill from one extra map in `DashboardDeps`, keyed as `reviewRuns` already is.
- [x] 7.4 Tests: the section and pills appear and clear with the manager's state; nothing is rendered at zero active runs.

## 8. Wiring, retention and verification

- [x] 8.1 Construct the manager in `activate()`, wire `onRunRecorded`, `onReviewReady` and the `repaintReviewSurfaces` fan-out into it rather than through the panel deps, and run the sweep before the first render.
- [x] 8.2 Cancel a pod's runs from the existing `deletePod` handler.
- [x] 8.3 Drop retained records for change requests that are no longer open, on the poll that already lists them (`fetchPodData`).
- [x] 8.4 Update `spec/specs/Code Verdict - naming & commands.md` with the cancel-run command and the new setting.
- [x] 8.5 Run `npm run typecheck`, `npm run lint` and `npm test`, and report the output.
- [ ] 8.6 Manual pass in the Extension Development Host (see `docs/agent-notes/f5-extension-development-host.md`): start a review, navigate to the dashboard, start a second review on another change request, confirm both finish and both notify; re-open each and confirm the findings are there; cancel one mid-run and confirm the queued one starts; close and re-open the window with a run in flight and confirm the target reads interrupted; re-run one with a different agent and confirm the previous review stayed put until the new one landed.
