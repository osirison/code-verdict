## 1. Memoized derivations (D10)

- [x] 1.1 Add `src/domain/memo.ts`: a bounded LRU memo keyed on a string, capped by entry count and total characters, following the bounds convention in `src/providers/github/http.ts:205-278` rather than inventing a new one. No `vscode` import. (Written as `src/app/` when planned; it has to live in `src/domain/` because `diffHunks.ts` needs it and nothing in `src/domain/` imports `src/app/` — 32 files import the other way. `src/ui/` reaches `src/domain/` directly, as it already does elsewhere.)
- [x] 1.2 Memoize `parseHunks(diff)` in `src/domain/diffHunks.ts` on the diff string, and `diffStats(files)` on the concatenated per-file keys, without changing either signature.
- [x] 1.3 Memoize `renderMarkdown(text)` in `src/ui/markdown.ts` on its input.
- [x] 1.4 Tests in `src/domain/memo.test.ts`: a repeated key returns the cached value without re-invoking; the entry cap evicts least-recently-used; the character cap evicts before the entry cap when entries are large; a key never seen is computed.
- [x] 1.5 Tests: `parseHunks` and `renderMarkdown` return values equal to the unmemoized result for every existing fixture, and a second call on the same input does not re-parse (assert via a counting spy on an injected parse step or by identity of the returned object).

## 2. The sidebar stops fetching on every triage action

- [x] 2.1 Split `VerdictSidebarProvider.render()` (`src/ui/sidebar.ts:148`) into a data path that fetches and a paint path that renders from already-held state. Keep `refreshSeq`/stale-guard behaviour (`:152`) on the data path only.
- [x] 2.2 Give `sidebarHtml.ts` region render functions and stable region container ids, matching the shape of `renderPostedReviewsRegions` (`src/ui/postedReviewsHtml.ts:329`): at minimum an active-review region, a threads region and a nav region.
- [x] 2.3 Make `setActiveReview`, `setPendingReview`, `setThreads`, `setActiveRoute` and `setActiveRuns` (`src/ui/sidebar.ts:71-104`) patch their own region from held state and never call the data path.
- [x] 2.4 Convert the sidebar's inline handlers in `src/ui/sidebarHtml.ts` to `document`-level delegated listeners matching on `closest()`, in the form used at `src/ui/reviewFlowHtml.ts:1278-1330`.
- [x] 2.5 Wire a region-patch path for the `WebviewView` (it is not an `AppRoute`): reuse `REGIONS_SCRIPT` and the `verdictReady` handshake, with full `webview.html` assignment as the first-paint and reload fallback.
- [x] 2.6 Tests in `src/ui/sidebar.test.ts` (new) or `sidebarHtml.test.ts`: recording a verdict updates the active-review region and issues **zero** platform calls against a fake connection; the change-request, work-item and CI sections are byte-identical before and after; a real pod refresh still fetches and repaints everything.

## 3. Settings stops testing the connection on every toggle

- [x] 3.1 Split `SettingsPanel.render()` (`src/ui/settings.ts:55-94`) so the connection test (`:63`) and the agent-location filesystem scan (`:103-115`) run on open and on explicit re-test only, not on the message tail (`:162`).
- [x] 3.2 Convert the settings page's inline handlers to delegated listeners. This comes before the patch path: a patch replaces a region's `innerHTML`, so any handler still bound to a replaced node is lost and the control goes dead on the first patch.
- [x] 3.3 Give `settingsHtml.ts` region render functions and container ids; make each message case patch the region it affects instead of falling through to a full render.
- [x] 3.4 Tests in `src/ui/settingsHtml.test.ts` and a new `settings.test.ts`: toggling a setting issues zero platform calls and leaves the shown connection status unchanged; pressing the explicit re-test control does call `testConnection`; opening the panel still calls it once.

## 4. Coalesced draft persistence with the generation guard (D9)

- [x] 4.1 Turn `persistDraft` (`src/ui/reviewFlow.ts:521-537`) into a coalescing writer: consecutive calls collapse into one `workspaceState.update`, with `flush()` exposed for the explicit flush points. Apply the same to `changesetReview.ts`'s draft write.
- [x] 4.2 Flush before submit, on `onLeave`/dispose, on `onDidChangeViewState` when the panel stops being visible (`src/ui/reviewFlow.ts:267`), and on `vscode.window.onDidChangeWindowState` losing focus.
- [x] 4.3 **First**, make the coalesced writer stop erasing the fields the guard reads. `persistDraft` and `changesetReview`'s draft write (`src/ui/changesetReview.ts:243-253`) put a fixed set of keys and drop every `RetainedResult` field the run manager wrote — `outcome`, `ranAt`, `agentId`, `agentLabel`, `modelId`, `submittedAt`, `candidates`, `filesRead`. Carry them forward into every put from the **raw stored record** the panel holds (`this.retained.draft`), never from the normalized `readRetained` view, whose inferred fallbacks (`src/app/retainedReview.ts:229-235`) must not be written back to storage.
- [x] 4.3a Test that this is a repair, not just a prerequisite: a target with a retained review still shows its "Ran …" line (`src/ui/reviewFlow.ts:1437` -> `src/ui/reviewFlowHtml.ts:788`) after a verdict is recorded. It does not today.
- [x] 4.3b Implement the generation guard on top of 4.3: record the `ranAt` and target of the record the panel loaded; the deferred write re-reads the key and drops itself when the stored `ranAt` differs. The `get` and the `update` are adjacent with **no `await` between them**, per `src/app/storage.ts:6-21`. Without 4.3 this guard drops every write after the panel's first one.
- [x] 4.4 Cancel any pending write when the panel observes a `succeeded` settle for its own target from `ReviewRunManager`.
- [x] 4.5 Leave every read-modify-write caller alone — `ReviewRunStore.record`, `ThreadFlags`, `PodStore`, `ManualChangesetStore` keep their synchronous `get`/`update` pairing and are not coalesced.
- [x] 4.6 Tests in `src/ui/reviewFlow.test.ts`: several verdicts in a row produce one write carrying the final state; each flush point writes before the panel yields; a pending write issued while a re-run settles is dropped and the new run's retained review survives (the invariant *A cached review is replaced only by a review that succeeds*); a pending write for a target whose record was replaced by a **clean** run is also dropped.
- [x] 4.7 Test that reading back a coalesced record never yields a mixture of two actions' state.

## 5. The store (D1–D4)

- [ ] 5.1 Add `src/app/appStore.ts`: pod-keyed entries `{ data, fetchedAt, inFlight? }`, a `Set<listener>` subscription in the shape of `ReviewRunManager` (`src/app/reviewRunManager.ts:287, 300-303, 627-630`), and no `vscode` import. Constructor takes `PodStore`, a `SecretStore`, a `ReviewHistory`, a `baseSeconds: () => number` provider that `src/extension.ts` wires to the existing poll-interval setting read, and a connection factory `(pod, opts?: { intent?: ConnectionIntent }) => Promise<Connection>`. Keep this list identical to design.md D1.
- [ ] 5.2 Implement the read path: fresh entry served without a fetch and **without** a revalidation; stale entry served immediately with a revalidation started behind it; nothing held returns the in-flight promise, starting one only if none exists (single-flight per pod).
- [ ] 5.2a Coalesce within an intent, not across one: a revalidation the store starts declares `background`, a fetch a screen is waiting on declares `interactive`, and an interactive read that finds only a background fetch in flight starts its own rather than joining it. The rate floor is fixed when the connection is built (`src/providers/github/http.ts:69, 315`), so a joined fetch would charge the UI read at the background floor and lose the reserve `#50` added. A background tick may join an interactive fetch — that one is free.
- [ ] 5.3 Use `pollIntervalMs({ repoCount, submittedReviews, baseSeconds })` (`src/app/pollSchedule.ts:73-85`) as the freshness window (D2) — it takes those three inputs, **not** a pod. Supply `repoCount` from the pod's repository ids, `submittedReviews` from the injected `ReviewHistory` intersected with the held entry's change requests (the derivation at `src/ui/notifier.ts:334-338`), and `baseSeconds` from the injected provider. Do not add a new constant.
- [ ] 5.4 Implement change detection: compare the new snapshot to the held one over the neutral shapes only, excluding fetch timestamps, and skip notification when equivalent (D4).
- [ ] 5.5 Drop a pod's entry when that pod is removed from `PodStore`; never serve one pod's data for another.
- [ ] 5.6 Tests in `src/app/appStore.test.ts` against a fake connection that counts calls: three concurrent reads of one pod issue one fetch; a read inside the freshness window issues none; a read outside it returns held data synchronously and fetches behind; a revalidation returning equivalent data notifies no subscriber; one returning changed data notifies every subscriber; a failed revalidation leaves held data intact and reports the failure; switching pods does not serve the previous pod's data.

## 6. Call sites move behind the store

- [ ] 6.1 Route `src/ui/dashboard.ts:129-130` through the store, keeping the synchronous skeleton first-paint (`:119-127`) and the `refreshSeq`/`canRender` stale guard (`:100-101`).
- [ ] 6.2 Route the sidebar's data path (task 2.1), `src/ui/changeset.ts:74-75`, `src/ui/changesetReview.ts:180-181`, and `src/extension.ts:176-177, 306-307` through the store.
- [ ] 6.3 Point `VerdictNotifier.poll()` (`src/ui/notifier.ts:305-375`) at the store's revalidation instead of its own `fetchPodData`, keeping its self-rescheduling timer, `polling` re-entrancy guard and window-focus re-poll where they are (D5). Its per-review `listThreads` fan-out (`:339-352`) and last-good thread cache stay in the notifier on a connection it still obtains itself with `intent: 'background'` — threads are per change request, not pod-keyed, and the store never holds them.
- [ ] 6.3a Preserve the background rate reserve: the store's revalidation must declare `background`, which is what `src/ui/notifier.ts:329` declares today. Move the existing assertion covering that (`src/ui/notifier.test.ts:156-162`) to `appStore.test.ts` against the fake connection factory rather than deleting it.
- [ ] 6.4 Replace `repaintReviewSurfaces` (`src/extension.ts:165-170`) with store subscriptions, one surface at a time. **Keep** the `lastRunStatus` transition check (`src/extension.ts:143-151`) exactly where it is: it compares `ReviewRunManager` run-record statuses, and the store holds pod platform data only, so there is nothing for it to fold into. What changes is its cost — the repaint it gates now reads held state instead of issuing a pod fetch.
- [ ] 6.5 Leave the review flow's 45-second head poll (`src/ui/reviewFlow.ts:73, 234, 477, 505-513`) as it is — different data, different cadence, already diffs before repainting.
- [ ] 6.6 Tests: one event that previously fanned out to four surfaces now issues one set of platform calls; each surface still updates on the events it used to be told about; a poll that finds nothing new repaints nothing.

## 7. Region patching on the remaining surfaces

- [ ] 7.1 Convert the inline handlers in `changesetHtml.ts`, `tuningHtml.ts` and `onboardingHtml.ts` to `document`-level delegated listeners.
- [ ] 7.2 Migrate `src/ui/changesetReview.ts` to `postRegions`: it already shares `FlowViewState` and `renderReviewFlowHtml` with the migrated review flow, so it reuses `renderReviewFlowBody` and the `flow-body` region. Replace all eight `render()` call sites' full-replace path (`:794`) with a patch and a `setHtml` fallback.
- [ ] 7.3 Migrate `src/ui/changeset.ts`, `src/ui/tuning.ts` and `src/ui/onboarding.ts` to `postRegions` with a `setHtml` first-paint and `onReload` fallback.
- [ ] 7.4 Make posted-review thread actions patch the affected thread instead of refetching history: `resolve`, `concede` and `reply` (`src/ui/postedReviews.ts:160-176`) update that thread's state and patch `pr-detail`, rather than calling `refresh()` (`:174`).
- [ ] 7.4a Give the reply input a stable `id` alongside its `data-reply` attribute (`src/ui/postedReviewsHtml.ts:201`). It has none today, so `REGIONS_SCRIPT` cannot restore focus to it, let alone its text.
- [ ] 7.4b Make the reply field's clearing deliberate. The comment at `src/ui/postedReviewsHtml.ts:401-405` records that a successful send is blanked by the `refresh()` that follows, and that a failed send leaves the text for a retry. Task 7.4 removes that `refresh()`, so both behaviours must become explicit: a successful reply clears the panel-held draft (task 9.6), a failed one keeps it. Update that comment to state the new mechanism.
- [ ] 7.5 Leave the dashboard's client-side `verdict:regions` listener (`src/ui/dashboardHtml.ts:555`) in place. It is **not** a duplicate of `REGIONS_SCRIPT` and is not covered by it: it resets the page's own client-only filter state when `db-body` is patched, which `REGIONS_SCRIPT` never does. Add a comment saying so, so the next reader does not delete it as redundant.
- [ ] 7.6 Give the two screens that fetch on open a loading first paint, which neither has today. Add a changeset loading render to `changesetHtml.ts` in the shape of `renderDashboardLoadingHtml` (`src/ui/dashboardHtml.ts:574`), and paint `renderReviewFlowLoadingHtml` (`src/ui/reviewFlowHtml.ts:1504`) from `changesetReview.ts` the way `reviewFlow.ts:365` already does. Both are assigned with `setHtml` on route entry, before the store read in `load()` (`src/ui/changeset.ts:69-75`, `src/ui/changesetReview.ts:177-181`). The label is only what is known without a fetch — the active pod's name and the changeset id — upgraded to the changeset's name when the store already holds that pod's data. Guard with the `painted` flag pattern at `dashboard.ts:113-127` so a refresh on an already-open screen does not drop back to the skeleton.
- [ ] 7.7 Tests: for each migrated surface, a state change posts a region patch and does not assign `webview.html`; first paint and the `onReload` path still assign it; a thread action patches one thread and issues no history refetch; entering either changeset screen with nothing held paints a loading state before the fetch resolves.

## 8. The resident shell (D7)

- [ ] 8.1 Audit every screen's CSS for unprefixed selectors that would collide once unioned. Record what changed.
- [ ] 8.2 Scope each route's CSS under a route ancestor class, and add `#app-route` as the swappable body container in `renderPage` (`src/ui/theme.ts:449-490`).
- [ ] 8.3 Build the shell document once per panel lifetime: the union of every route's CSS and bootstrap script, assigned via `setHtml` on first paint and on `onReload` (`src/ui/appSurface.ts:9-21`). No new "force full" signal.
- [ ] 8.4 Make `AppSurface.activate` (`src/ui/appSurface.ts:147-158`) patch `#app-route` and the breadcrumb on a route change instead of the incoming route assigning a document.
- [ ] 8.5 Verify no renderer emits an inline `style="…"` attribute — the CSP (`default-src 'none'; style-src 'nonce-…'`) drops them silently. Add a test asserting the rendered HTML of every screen contains no `style="` attribute.
- [ ] 8.6 Tests: navigating between two routes assigns `webview.html` exactly once across both; two routes rendered into one document each still satisfy their own existing `*Html.test.ts` assertions; a webview reload reassigns the shell and restores the current route.
- [ ] 8.7 Add a first-paint size bound: assert the shell document is under a stated character budget, so a future screen cannot grow it unnoticed.

## 9. Per-route view state and in-progress text (D8)

- [ ] 9.1 Extend `REGIONS_SCRIPT` (`src/ui/theme.ts:387-427`) to snapshot and restore expanded/collapsed state and per-container scroll positions for elements carrying a stable id, alongside the focus, selection and window-scroll it already handles.

- [ ] 9.2 Keep the existing restraint in `REGIONS_SCRIPT`: restore focus and selection, never `value`. Task 9.3 is what makes that restraint safe, by making the re-rendered value current instead of stale.

- [ ] 9.3 Make the host hold every editable's in-progress text, so a re-render never paints over what the reviewer is typing (D8).
  - Commit `#summary-text`, `#final-note` and `#extra` on debounced `input` rather than `change` (`src/ui/reviewFlowHtml.ts:1394, 1396, 1302`) — `change` fires on blur, so today mid-typing text exists only in the DOM.
  - Make `setInstructions` (`src/ui/reviewFlow.ts:799-801`) `return` like `editSummary`/`setNote` instead of falling through to the tail render at `:1028`, and keep its `podStore.upsert` on blur: per keystroke it would issue one uncoalesced read-modify-write per character, which task 4.5 forbids. Apply the same to `changesetReview.ts`'s equivalent handler.
  - Give `#ask` (`src/ui/reviewFlowHtml.ts:979`) a per-finding draft and the reply inputs (`src/ui/postedReviewsHtml.ts:201`) a per-thread draft in panel state, posted the same way and rendered back into the field. The panel holds nothing for either today.
  - Clear the reply draft explicitly on a successful send and keep it on a failed one, replacing the blank-on-refresh behaviour task 7.4b removes.
  - These writes ride the coalescing writer from task 4.1, so they add no extra `workspaceState` traffic.

- [ ] 9.4 Add a per-route snapshot kept in the webview, taken on leaving a route and reapplied on entering it, so returning to a screen restores its scroll position and expanded sections.

- [ ] 9.5 Document the convention that a renderer's stateful element needs a stable id to be restored.

- [ ] 9.6 Tests in `src/ui/dashboardScript.test.ts` (jsdom, in the shape of the existing region-patch test at `:86-99`): a patch preserves scroll position, an open section and a focused field's caret; leaving and returning to a route restores its scroll and expanded sections; a patch never restores a stale field value over a regenerated one.

- [ ] 9.7 Tests for 9.3, covering both directions of the requirement: a patch arriving between keystrokes leaves the typed text, focus and caret intact in the summary field, the note field and a reply field; a `regenerate` still replaces the summary text rather than preserving what was typed; a reply that sends successfully ends empty; a reply that fails keeps its text.

## 10. Verification

- [ ] 10.1 Confirm every scenario in `specs/app-state/spec.md` and `specs/ui-responsiveness/spec.md` has a test, and list which test covers which scenario.
- [ ] 10.2 Re-run the three `background-review-runs` invariants as explicit tests against the new persistence path: a retained review survives a restart; it is replaced only by a run that succeeds; an in-flight run interrupted by a restart is still reported as interrupted. Include the case the coalescing makes reachable: a pending write held across a re-run that succeeds must not resurrect the previous run's verdicts.
- [ ] 10.3 Count platform calls for a full triage session against a fake connection — open dashboard, open a review, record ten verdicts, submit — and record the before/after numbers in the change's completion notes.
- [ ] 10.4 Run the full suite and the extension's lint/build; report failures with their output rather than summarising them.
