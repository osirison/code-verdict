## 1. Memoized derivations (D10)

- [ ] 1.1 Add `src/app/memo.ts`: a bounded LRU memo keyed on a string, capped by entry count and total characters, following the bounds convention in `src/providers/github/http.ts:205-278` rather than inventing a new one. No `vscode` import.
- [ ] 1.2 Memoize `parseHunks(diff)` in `src/domain/diffHunks.ts` on the diff string, and `diffStats(files)` on the concatenated per-file keys, without changing either signature.
- [ ] 1.3 Memoize `renderMarkdown(text)` in `src/ui/markdown.ts` on its input.
- [ ] 1.4 Tests in `src/app/memo.test.ts`: a repeated key returns the cached value without re-invoking; the entry cap evicts least-recently-used; the character cap evicts before the entry cap when entries are large; a key never seen is computed.
- [ ] 1.5 Tests: `parseHunks` and `renderMarkdown` return values equal to the unmemoized result for every existing fixture, and a second call on the same input does not re-parse (assert via a counting spy on an injected parse step or by identity of the returned object).

## 2. The sidebar stops fetching on every triage action

- [ ] 2.1 Split `VerdictSidebarProvider.render()` (`src/ui/sidebar.ts:148`) into a data path that fetches and a paint path that renders from already-held state. Keep `refreshSeq`/stale-guard behaviour (`:152`) on the data path only.
- [ ] 2.2 Give `sidebarHtml.ts` region render functions and stable region container ids, matching the shape of `renderPostedReviewsRegions` (`src/ui/postedReviewsHtml.ts:329`): at minimum an active-review region, a threads region and a nav region.
- [ ] 2.3 Make `setActiveReview`, `setPendingReview`, `setThreads`, `setActiveRoute` and `setActiveRuns` (`src/ui/sidebar.ts:71-104`) patch their own region from held state and never call the data path.
- [ ] 2.4 Convert the sidebar's inline handlers in `src/ui/sidebarHtml.ts` to `document`-level delegated listeners matching on `closest()`, in the form used at `src/ui/reviewFlowHtml.ts:1278-1330`.
- [ ] 2.5 Wire a region-patch path for the `WebviewView` (it is not an `AppRoute`): reuse `REGIONS_SCRIPT` and the `verdictReady` handshake, with full `webview.html` assignment as the first-paint and reload fallback.
- [ ] 2.6 Tests in `src/ui/sidebar.test.ts` (new) or `sidebarHtml.test.ts`: recording a verdict updates the active-review region and issues **zero** platform calls against a fake connection; the change-request, work-item and CI sections are byte-identical before and after; a real pod refresh still fetches and repaints everything.

## 3. Settings stops testing the connection on every toggle

- [ ] 3.1 Split `SettingsPanel.render()` (`src/ui/settings.ts:55-94`) so the connection test (`:63`) and the agent-location filesystem scan (`:103-115`) run on open and on explicit re-test only, not on the message tail (`:162`).
- [ ] 3.2 Give `settingsHtml.ts` region render functions and container ids; make each message case patch the region it affects instead of falling through to a full render.
- [ ] 3.3 Convert the settings page's inline handlers to delegated listeners.
- [ ] 3.4 Tests in `src/ui/settingsHtml.test.ts` and a new `settings.test.ts`: toggling a setting issues zero platform calls and leaves the shown connection status unchanged; pressing the explicit re-test control does call `testConnection`; opening the panel still calls it once.

## 4. Coalesced draft persistence with the generation guard (D9)

- [ ] 4.1 Turn `persistDraft` (`src/ui/reviewFlow.ts:521-537`) into a coalescing writer: consecutive calls collapse into one `workspaceState.update`, with `flush()` exposed for the explicit flush points. Apply the same to `changesetReview.ts`'s draft write.
- [ ] 4.2 Flush before submit, on `onLeave`/dispose, on `onDidChangeViewState` when the panel stops being visible (`src/ui/reviewFlow.ts:267`), and on `vscode.window.onDidChangeWindowState` losing focus.
- [ ] 4.3 Implement the generation guard: record the `ranAt` and target of the record the panel loaded; the deferred write re-reads the key and drops itself when the stored record is from a different run. The `get` and the `update` are adjacent with **no `await` between them**, per `src/app/storage.ts:6-21`.
- [ ] 4.4 Cancel any pending write when the panel observes a `succeeded` settle for its own target from `ReviewRunManager`.
- [ ] 4.5 Leave every read-modify-write caller alone — `ReviewRunStore.record`, `ThreadFlags`, `PodStore`, `ManualChangesetStore` keep their synchronous `get`/`update` pairing and are not coalesced.
- [ ] 4.6 Tests in `src/ui/reviewFlow.test.ts`: several verdicts in a row produce one write carrying the final state; each flush point writes before the panel yields; a pending write issued while a re-run settles is dropped and the new run's retained review survives (the invariant *A cached review is replaced only by a review that succeeds*); a pending write for a target whose record was replaced by a **clean** run is also dropped.
- [ ] 4.7 Test that reading back a coalesced record never yields a mixture of two actions' state.

## 5. The store (D1–D4)

- [ ] 5.1 Add `src/app/appStore.ts`: pod-keyed entries `{ data, fetchedAt, inFlight? }`, a `Set<listener>` subscription in the shape of `ReviewRunManager` (`src/app/reviewRunManager.ts:287, 300-303, 627-630`), and no `vscode` import. Constructor takes `PodStore`, a `SecretStore`, and a connection factory.
- [ ] 5.2 Implement the read path: fresh entry served without a fetch; stale entry served immediately with a revalidation started behind it; nothing held returns the in-flight promise, starting one only if none exists (single-flight per pod).
- [ ] 5.3 Use `pollIntervalMs(pod)` (`src/app/pollSchedule.ts:73-85`) as the freshness window (D2). Do not add a new constant.
- [ ] 5.4 Implement change detection: compare the new snapshot to the held one over the neutral shapes only, excluding fetch timestamps, and skip notification when equivalent (D4).
- [ ] 5.5 Drop a pod's entry when that pod is removed from `PodStore`; never serve one pod's data for another.
- [ ] 5.6 Tests in `src/app/appStore.test.ts` against a fake connection that counts calls: three concurrent reads of one pod issue one fetch; a read inside the freshness window issues none; a read outside it returns held data synchronously and fetches behind; a revalidation returning equivalent data notifies no subscriber; one returning changed data notifies every subscriber; a failed revalidation leaves held data intact and reports the failure; switching pods does not serve the previous pod's data.

## 6. Call sites move behind the store

- [ ] 6.1 Route `src/ui/dashboard.ts:129-130` through the store, keeping the synchronous skeleton first-paint (`:119-127`) and the `refreshSeq`/`canRender` stale guard (`:100-101`).
- [ ] 6.2 Route the sidebar's data path (task 2.1), `src/ui/changeset.ts:74-75`, `src/ui/changesetReview.ts:180-181`, and `src/extension.ts:176-177, 306-307` through the store.
- [ ] 6.3 Point `VerdictNotifier.poll()` (`src/ui/notifier.ts:305-375`) at the store's revalidation instead of its own `connectionForPod`/`fetchPodData`, keeping its self-rescheduling timer, `polling` re-entrancy guard and window-focus re-poll where they are (D5).
- [ ] 6.4 Replace `repaintReviewSurfaces` (`src/extension.ts:165-170`) with store subscriptions, one surface at a time. Fold the `lastRunStatus` transition throttle (`src/extension.ts:143-151`) into the store's change detection and delete the hand-rolled version.
- [ ] 6.5 Leave the review flow's 45-second head poll (`src/ui/reviewFlow.ts:73, 234, 477, 505-513`) as it is — different data, different cadence, already diffs before repainting.
- [ ] 6.6 Tests: one event that previously fanned out to four surfaces now issues one set of platform calls; each surface still updates on the events it used to be told about; a poll that finds nothing new repaints nothing.

## 7. Region patching on the remaining surfaces

- [ ] 7.1 Convert the inline handlers in `changesetHtml.ts`, `tuningHtml.ts` and `onboardingHtml.ts` to `document`-level delegated listeners.
- [ ] 7.2 Migrate `src/ui/changesetReview.ts` to `postRegions`: it already shares `FlowViewState` and `renderReviewFlowHtml` with the migrated review flow, so it reuses `renderReviewFlowBody` and the `flow-body` region. Replace all eight `render()` call sites' full-replace path (`:794`) with a patch and a `setHtml` fallback.
- [ ] 7.3 Migrate `src/ui/changeset.ts`, `src/ui/tuning.ts` and `src/ui/onboarding.ts` to `postRegions` with a `setHtml` first-paint and `onReload` fallback.
- [ ] 7.4 Make posted-review thread actions patch the affected thread instead of refetching history: `resolve`, `concede` and `reply` (`src/ui/postedReviews.ts:160-176`) update that thread's state and patch `pr-detail`, rather than calling `refresh()` (`:174`).
- [ ] 7.5 Delete the dashboard's duplicate client-side `verdict:regions` listener (`src/ui/dashboardHtml.ts:555`) now that `REGIONS_SCRIPT` covers it, or confirm it is still needed and say why in a comment.
- [ ] 7.6 Tests: for each migrated surface, a state change posts a region patch and does not assign `webview.html`; first paint and the `onReload` path still assign it; a thread action patches one thread and issues no history refetch.

## 8. The resident shell (D7)

- [ ] 8.1 Audit every screen's CSS for unprefixed selectors that would collide once unioned. Record what changed.
- [ ] 8.2 Scope each route's CSS under a route ancestor class, and add `#app-route` as the swappable body container in `renderPage` (`src/ui/theme.ts:449-490`).
- [ ] 8.3 Build the shell document once per panel lifetime: the union of every route's CSS and bootstrap script, assigned via `setHtml` on first paint and on `onReload` (`src/ui/appSurface.ts:9-21`). No new "force full" signal.
- [ ] 8.4 Make `AppSurface.activate` (`src/ui/appSurface.ts:147-158`) patch `#app-route` and the breadcrumb on a route change instead of the incoming route assigning a document.
- [ ] 8.5 Verify no renderer emits an inline `style="…"` attribute — the CSP (`default-src 'none'; style-src 'nonce-…'`) drops them silently. Add a test asserting the rendered HTML of every screen contains no `style="` attribute.
- [ ] 8.6 Tests: navigating between two routes assigns `webview.html` exactly once across both; two routes rendered into one document each still satisfy their own existing `*Html.test.ts` assertions; a webview reload reassigns the shell and restores the current route.
- [ ] 8.7 Add a first-paint size bound: assert the shell document is under a stated character budget, so a future screen cannot grow it unnoticed.

## 9. Per-route view state (D8)

- [ ] 9.1 Extend `REGIONS_SCRIPT` (`src/ui/theme.ts:387-427`) to snapshot and restore expanded/collapsed state and per-container scroll positions for elements carrying a stable id, alongside the focus, selection and window-scroll it already handles.
- [ ] 9.2 Keep the existing restraint: restore focus and selection, never `value`.
- [ ] 9.3 Add a per-route snapshot kept in the webview, taken on leaving a route and reapplied on entering it, so returning to a screen restores its scroll position and expanded sections.
- [ ] 9.4 Document the convention that a renderer's stateful element needs a stable id to be restored.
- [ ] 9.5 Tests in `src/ui/dashboardScript.test.ts` (jsdom, in the shape of the existing region-patch test at `:86-99`): a patch preserves scroll position, an open section and a focused field's caret; leaving and returning to a route restores its scroll and expanded sections; a patch never restores a stale field value over a regenerated one.

## 10. Verification

- [ ] 10.1 Confirm every scenario in `specs/app-state/spec.md` and `specs/ui-responsiveness/spec.md` has a test, and list which test covers which scenario.
- [ ] 10.2 Re-run the three `background-review-runs` invariants as explicit tests against the new persistence path: a retained review survives a restart; it is replaced only by a run that succeeds; an in-flight run interrupted by a restart is still reported as interrupted.
- [ ] 10.3 Count platform calls for a full triage session against a fake connection — open dashboard, open a review, record ten verdicts, submit — and record the before/after numbers in the change's completion notes.
- [ ] 10.4 Run the full suite and the extension's lint/build; report failures with their output rather than summarising them.
