## Why

Moving between screens costs a full document rebuild, and a single triage click costs three network requests to data the click did not change. The extension has no shared state: every surface fetches its own copy of the same pod, re-derives every view model from scratch, and repaints by replacing its entire HTML document.

**Navigation rebuilds the document.** All eight panel screens share one `WebviewPanel` (`src/ui/appSurface.ts:104`, `retainContextWhenHidden: true`), so the panel is never destroyed — but every route entry still assigns a fresh `webview.html`. For the review flow that is a ~40 KB string (18.3 KB of CSS at `src/ui/reviewFlowHtml.ts:275`, 9.5 KB of script at `:1275`, plus ~12.6 KB of shared shell from `src/ui/theme.ts`) crossing the IPC boundary, reparsed into a new DOM, with every bootstrap script re-run and all scroll position, focus and expanded/collapsed state discarded. Issue #39 introduced the fix — `AppRoute.postRegions` patching named containers (`src/ui/appSurface.ts:71-76`, `src/ui/theme.ts:387-427`) — and it works, but only three of nine surfaces use it. `changesetReview.ts`, `changeset.ts`, `settings.ts`, `tuning.ts`, `onboarding.ts` and the sidebar still full-replace on every state change, and no surface avoids the rebuild when it is the target of a navigation.

**One click fans out into unrelated network work.** `src/ui/reviewFlow.ts:1499` fires `onSidebarState` on every render; that reaches `VerdictSidebarProvider.setActiveReview` (`src/ui/sidebar.ts:71-74`), which calls `render()`, which calls `fetchPodData` (`src/ui/sidebar.ts:169`) — three live platform requests for merge-request, work-item and CI-run lists — then rebuilds the sidebar's HTML in full. Accepting a finding does not change any of that data. `src/ui/settings.ts:63` is the same shape: every settings toggle runs a live `testConnection()` before a full rebuild, because `render()` is the common tail of the message handler (`src/ui/settings.ts:162`).

**Nothing is shared or cached at the app layer.** `fetchPodData` has six independent call sites (dashboard, sidebar, changeset, changeset review, notifier poll, extension-level detection) with no result cache and no coalescing; `repaintReviewSurfaces` (`src/extension.ts:165-170`) fans one event out to four surfaces that then fetch the same pod in parallel. The only cache in the stack is HTTP-level (`EtagCache`, `src/providers/github/http.ts:233-278`), which still re-parses and re-derives on a 304. Pure derivations on the render path — `parseHunks`, `diffStats`, `renderMarkdown` — are recomputed on every one of the review flow's seventeen render call sites, including ones that touch nothing related. And every verdict, undo, note edit and answer writes the entire review blob (all findings with bodies, code and answers, plus all threads) to `workspaceState` (`src/ui/reviewFlow.ts:521-537`, ten call sites), with no coalescing.

The architecture is imperative fan-out: no `vscode.EventEmitter` exists anywhere in `src/`, and cross-surface updates are hand-wired callback props that each say "recompute everything and redraw".

## What Changes

### A shared state store at the app layer

- A single **`AppStore`** owning the observable state every surface reads: pod data, changesets, run records, connection status. Surfaces **subscribe** to slices instead of being told to `refresh()` by a hand-maintained fan-out list.
- **Read-through cache with stale-while-revalidate.** A surface that opens paints immediately from cached pod data if it is within the staleness window, then repaints once revalidation lands. Concurrent requests for the same pod **coalesce into one in-flight fetch** rather than four parallel ones.
- **Change detection before notification.** A revalidation that produces equal data notifies no subscriber, so a poll that finds nothing new causes no repaint. The store extends the discipline already applied by hand to run-status transitions (`src/extension.ts:143-151`) and the head poll (`src/ui/reviewFlow.ts:508-513`) to every subscriber.
- The **notifier's poll becomes the store's revalidation tick** instead of a seventh independent fetch of the same data.
- **Coalesced draft persistence.** Rapid triage actions collapse into one `workspaceState` write, with explicit flush points (submit, panel dispose, view-state change, window blur) so the retained-review guarantees below still hold.
- **Memoized pure derivations.** `parseHunks`, `diffStats` and `renderMarkdown` are cached on their input, so a render triggered by an unrelated state change does not re-parse a diff or re-render markdown.
- The store is **provider-agnostic**: it holds neutral domain types and calls the provider interface, never a provider-specific shape.

### Incremental rendering everywhere

- **Every surface patches regions.** `changesetReview.ts`, `changeset.ts`, `settings.ts`, `tuning.ts`, `onboarding.ts` and the sidebar adopt the `postRegions` path already proven on the review flow, dashboard and posted reviews. Full `setHtml` remains only as the first-paint and post-reload fallback it is today.
- **Navigation reuses the resident shell.** The shared panel keeps one document whose static CSS and script are loaded once; a route change swaps the body region rather than replacing the document. Moving dashboard → review → changeset → settings → back stops costing a reparse, and a return to a previous route restores its scroll position and expanded state.
- **A repaint fetches only what changed.** Accepting a finding patches the sidebar's active-review region from state the sidebar already holds — no `fetchPodData`. A settings toggle patches the toggled control — no `testConnection`.
- **Resolving a thread in posted reviews patches that thread**, instead of refetching the whole review history (`src/ui/postedReviews.ts:174`).
- No behavioural change to what any screen shows. This change is about how state reaches the pixels, not what the pixels say.

## Capabilities

### New Capabilities
- `app-state`: What state the application holds and how it stays fresh — one shared copy of platform data across every screen, its staleness and revalidation semantics, request coalescing, the rule that unchanged data notifies nobody, and how triage decisions stay durable while their writes are coalesced.
- `ui-responsiveness`: How a state change reaches the screen — a repaint touches only the region that changed, navigation does not rebuild the document, scroll position, focus and expanded state survive both, and an update to one screen never disturbs what the reviewer is doing on another.

### Modified Capabilities
<!-- None. The retained-review guarantees in `background-review-runs`
     ("A completed review is cached and is what its target opens on",
     "A cached review is replaced only by a review that succeeds",
     "A run that could not survive a restart is reported as interrupted")
     are preserved unchanged and carried into design.md as invariants the new
     store must honour. `scm-providers` says nothing about caching or fetch
     frequency, so the store claims that ground additively rather than
     modifying it. `review-agents`' per-pod selection persistence is untouched. -->

## Impact

**Ordering.** Independent of `add-context-controls-and-thinking-effort`. Both edit `FlowViewState` and the review flow render path, so whichever lands second rebases onto the first; there is no requirement-level conflict.

| Area | Effect |
| --- | --- |
| New `src/app/appStore.ts` | The store: subscriptions, cached pod data, staleness window, in-flight coalescing, change detection. |
| New `src/app/memo.ts` (or equivalent) | Input-keyed memoization used by `parseHunks`, `diffStats`, `renderMarkdown`. |
| `src/extension.ts` | Constructs the store once and injects it. `repaintReviewSurfaces` (`:165-170`) is replaced by store subscriptions; the `lastRunStatus` throttle (`:143-151`) moves into the store's change detection. |
| `src/ui/sidebar.ts` | `setActiveReview`/`setThreads`/`setActiveRoute`/`setPendingReview` patch their region from held state instead of calling `render()`; pod data arrives from the store. |
| `src/ui/settings.ts` | Connection status comes from the store; a config toggle patches its control instead of re-rendering and re-testing the connection. |
| `src/ui/changesetReview.ts`, `changeset.ts`, `tuning.ts`, `onboarding.ts` | Adopt `postRegions`; their `*Html.ts` builders gain region-level render functions. |
| `src/ui/appSurface.ts`, `src/ui/theme.ts` | Route changes patch the body region of a resident shell; per-route scroll/focus state is retained and restored. |
| `src/ui/reviewFlow.ts` | `persistDraft` becomes a coalesced write with explicit flush points; renders read memoized derivations. |
| `src/ui/postedReviews.ts` | Thread actions patch the affected thread instead of refetching history. |
| `src/ui/notifier.ts` | Poll feeds the store rather than fetching independently. |
| `src/ui/dashboard.ts`, `src/ui/dashboardState.ts`, `sidebarState.ts`, `postedReviewsState.ts`, `tuningState.ts` | Read from the store; derivations memoized on store revision. |

Not affected: the provider layer and its `EtagCache`, the agent and prompt pipeline, `submitReview`, the domain modules (`reviewState.ts`, `threadStatus.ts`) which are already pure and immutable, and what any screen displays.
