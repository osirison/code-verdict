## Why

A review run lives inside the panel that started it. `ReviewFlowPanel.run()` holds the whole run — steps, liveness counters, the pending `runLmAgent` promise — in instance fields, and two ordinary navigations throw it away: `load()` bumps `runToken` when the reviewer opens a different change request, and `route.onLeave` bumps it when the Verdict surface moves to any other screen. The abandoned run's result is then discarded on arrival, so the reviewer who opened the dashboard to check something else while a review ran comes back to the agent picker with nothing to show for the minutes the model spent. Worse, the `vscode.lm` request itself is never cancelled — `streamText` owns a private `CancellationTokenSource` wired only to its two timeout windows — so the tokens are spent and the answer is dropped.

The same singleton shape makes a second review impossible: `ReviewFlowPanel.current` is one panel over one `AppSurface` webview, and `runToken` is a single counter on it. Starting a review on a second change request cancels the first by construction. A reviewer working a stack of pull requests can only ever have one in flight.

## What Changes

- **A review run becomes a background job, owned by the extension, not by a panel.** A new run manager, created once during activation, holds every in-flight run. Panels subscribe to it and render what it reports; they no longer own, start, or cancel a run by existing or ceasing to exist.
- **Navigating away leaves the run running.** Opening another change request, returning to the dashboard, closing the Verdict tab, or reloading the webview unsubscribes the panel and does nothing to the run. Re-opening the change request re-attaches to the live run and shows its progress from where it is now.
- **A run finishes headlessly.** Whether or not any panel is watching, a finished run writes its draft to `workspaceState`, records the outcome in `ReviewRunStore`, and raises the review-ready notification. The reviewer finds the findings waiting in triage when they come back.
- **Several reviews run at once.** Runs are keyed by target — a change-request ref, or a changeset id — and independent targets run concurrently. A second run on a target that is already running is refused rather than silently superseding it; the screen offers Cancel instead.
- **Concurrency is capped and the overflow queues.** Runs beyond the cap sit in a `queued` state, in trigger order, and start as slots free. The cap is a setting.
- **Cancel becomes real cancellation.** `RunAgentOptions` gains a caller-supplied cancellation token that `streamText` links to its internal source, so a cancelled run stops consuming the model and frees its concurrency slot immediately. A user cancellation is reported as a cancellation, not as the timeout `streamText` currently reports for every cancelled token.
- **Running reviews are visible outside the run screen.** The sidebar lists active and queued runs with elapsed time and a cancel control; the status bar carries the count; dashboard and changeset rows show a `Running…` pill on targets with a run in flight.
- **An interrupted run is stated, not forgotten.** In-flight runs are recorded in persistent state. A `vscode.lm` stream cannot survive an extension-host restart, so on the next activation any leftover record is swept into an `interrupted` outcome the reviewer can see and re-run, rather than a target that silently reads "not run".
- **The run screen stops being the only way to trigger a review.** A review can be started for a target and left; the screen is a view onto the job.
- **A completed review is cached and is what a target opens on.** The latest completed review for a change request or changeset — findings *or* a clean verdict — is kept and is the first thing shown when that target is opened, without re-running the agent. Today a clean run deletes its record (`finishRun`, `src/ui/reviewFlow.ts:652`) and a successful submit deletes it again (`:1183`), so both land the reviewer back on the agent picker with the result gone.
- **Re-running is always offered, and never destroys the cached result first.** The result view carries a control that opens the agent and model pickers with the last-used selection, so a re-run can use different settings. The cached review stays visible and intact while the new run is in flight, and is replaced only when the new run succeeds — a re-run that fails or is cancelled leaves the previous review exactly where it was.
- **The retry ledger and the cached review separate.** The partial-failure ledger inside a draft is transient and still clears on a successful submit; the review it was attached to is not deleted with it, and a submitted review re-opens showing what was posted.

### Assumptions

Recorded rather than asked, and open to correction at review:

- **Changeset reviews are in scope.** `ChangesetReviewPanel` has the same `runToken` field, the same `onLeave` bump, and the same single-panel singleton; leaving it out would keep half of the defect and fork the run path in two.
- **The concurrency cap defaults to 3**, configurable through `codeVerdict.agentRun.maxConcurrent`, with `0` meaning no limit — the same "zero disables the window" convention `codeVerdict.agentRun.*` already uses for the two timeouts.
- **Runs are not resumed across a window reload.** The platform gives no handle to reattach to a `vscode.lm` stream after the extension host stops. Persistence covers the run's existence and its result, not the stream.
- **One run per target.** Two simultaneous runs on the same pull request with different agents is not a use case this change serves; the second is refused with the first named.
- **One cached review per target, latest wins.** A history of every review ever run on a change request is not kept; the newest replaces the previous, matching how `ReviewRunStore` already records outcomes.

## Capabilities

### New Capabilities
- `background-review-runs`: What a review run is once it is detached from a panel — its lifecycle and states, what survives navigation, the concurrency cap and queue, cancellation, headless completion and notification, how a completed review is cached and re-shown, how a re-run with different settings is offered without destroying it, and how a run that could not survive an extension-host restart is reported.

### Modified Capabilities
<!-- `openspec/specs/` is empty: this project has published no specs yet, so
     there is no existing requirement to amend. The new capability above carries
     everything. -->

## Impact

| Area | Effect |
| --- | --- |
| New `src/app/reviewRunManager.ts` (+ test twin) | Owns in-flight runs, the queue, the concurrency cap, cancellation, headless completion, and the change event panels subscribe to. Holds a snapshot of pod, criteria, agent, model, diff and review context taken at trigger. |
| `SessionDraft` → cached review record | Gains the run's outcome, when it ran, the agent and model that produced it, and whether it was submitted. Clean runs get a record where they previously got a deletion. |
| New in-flight run store | Persisted record of running targets, written at start, cleared at finish or cancel, swept on activation into `interrupted`. Follows the synchronous read-modify-write contract stated in `src/app/storage.ts`. |
| `src/app/lmAgent.ts` | `RunAgentOptions` gains a caller cancellation token; `streamText` links it to its internal `CancellationTokenSource` and distinguishes a caller cancellation from the two timeout expiries in the error it raises. |
| `src/ui/reviewFlow.ts` | `run()`, `finishRun()` and `recordRun()` move to the manager. The two `draftKey()` deletions (clean run, successful submit) become record updates, not deletions. A re-run control on the result screens re-opens the pickers without clearing the cached review. `runToken` and its bumps in `load()` and `onLeave` go. `load()` routes on manager state first: in-flight run → running screen; else draft → triage; else agent picker. `RunLiveness` is read from the manager rather than owned. |
| `src/ui/changesetReview.ts` | The same three moves, against the changeset-keyed run. `ChangesetDraft` gains the same result fields under its own key; its clean branch, which persists nothing today, starts writing one. |
| `src/ui/runLiveness.ts` | Moves under the manager's ownership (one instance per run, not one per panel); the webview push becomes a subscriber notification rather than a direct `postMessage`. |
| `src/ui/sidebar.ts`, `src/ui/sidebarHtml.ts` | An active-runs section: target label, state, elapsed, cancel. |
| `src/ui/statusBar.ts` | A running-review count segment. |
| `src/ui/dashboardState.ts`, `src/ui/dashboardHtml.ts`, `src/ui/changesetHtml.ts` | A `Running…` / `Queued` pill, fed by one extra map in `DashboardDeps` keyed the way `reviewRuns.byRef()` already is. |
| `src/app/reviewRuns.ts` | `ReviewRunOutcome` gains `interrupted` alongside `clean` and `findings`. |
| `src/extension.ts` | Constructs the manager, wires `onRunRecorded`, the notifier and the repaint fan-out into it instead of through the panels, runs the interrupted sweep on activation, and cancels a pod's runs when that pod is deleted (a pod *switch* leaves them running — the snapshot is what keeps their attribution right). |
| `package.json` | `codeVerdict.agentRun.maxConcurrent` added. |
| `spec/specs/Code Verdict - naming & commands.md` | A cancel-run command and the new setting are not in the naming doc. |

Not affected: the provider layer, the response contract in `src/domain/agentResponse.ts`, the prompt composition in `runLmAgent`/`runLmChangesetAgent`, the triage interactions themselves, what is posted on submit, and the partial-failure ledger's own semantics — a successful submit still clears the ledger, it just stops deleting the review along with it.
