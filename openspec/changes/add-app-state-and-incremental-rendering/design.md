## Context

See proposal.md — Why for the motivation and the measurements. What follows is only the state of the code that shapes the approach.

**The mechanism already exists and is half-adopted.** Issue #39 introduced `AppSurface` — one `WebviewPanel` for all eight panel screens, `retainContextWhenHidden: true` (`src/ui/appSurface.ts:104-109`) — and `AppRoute.postRegions`, which posts `verdict:regions` into the live document so `REGIONS_SCRIPT` (`src/ui/theme.ts:387-427`) replaces named containers' `innerHTML` and restores focus, selection and scroll. Three surfaces use it. `setHtml` marks the route not-ready and readiness is re-armed by a `verdictReady` echo, so a fallback to a full render is always available and is never load-bearing for correctness (`src/ui/appSurface.ts:22-40, 113-131`).

**The webview stack has no dependencies and a strict CSP.** `renderPage` (`src/ui/theme.ts:449-490`) emits `default-src 'none'; style-src 'nonce-…'; script-src 'nonce-…'`. Inline `style="…"` attributes are dropped silently. Every screen's tests assert against the generated HTML string (`src/ui/*Html.test.ts`).

**Listeners are already delegated.** The review flow attaches its click handlers to `document` and matches with `closest()` (`src/ui/reviewFlowHtml.ts:1278-1330`), so replacing a region's `innerHTML` does not detach anything. This is what makes region patching survivable and what the unmigrated screens must adopt.

**`src/app/` is deliberately free of `vscode`.** Only `agentDefinitions.ts` and `lmAgent.ts` import it. `ReviewRunManager` does its own pub/sub with a `Set` of listeners (`src/app/reviewRunManager.ts:287, 300-303, 627-630`) rather than `vscode.EventEmitter`, and takes storage as the `KeyValueStore` interface from `src/app/storage.ts`.

**Two hard constraints on persistence.**

1. `src/app/storage.ts:6-21` states the contract every store here obeys: read-modify-write with **no `await` between the `get` and the `update`**, because correctness rests on `Memento.get` reflecting the preceding `update` synchronously.
2. **The draft key and the retained-review key are the same key.** `recordKeyFor(target)` (`src/app/reviewRunManager.ts:252-256`) resolves to `draftKeyFor(ref)` (`src/app/retainedReview.ts:34-36`) — `codeVerdict.draft.<repoId>!<number>` — and `ChangesetDraft` sits at `codeVerdict.changesetDraft.<id>` the same way. The archived `add-background-review-runs` design D7/D7a establishes a **one-writer rule** on that key: the run manager writes the record before telling anything the run succeeded, and the panel reads it back rather than writing its own copy (`src/app/reviewRunManager.ts:548-556`). Today the panel's `persistDraft` (`src/ui/reviewFlow.ts:521-537`) is safe only because it is synchronous with the action that caused it.

**Three requirements from `background-review-runs` are invariants here, not targets.** They are not modified by this change and must survive it:
- *A completed review is cached and is what its target opens on* — including that it survives a restart.
- *A cached review is replaced only by a review that succeeds* — a failed, cancelled or interrupted re-run leaves it intact.
- *A run that could not survive a restart is reported as interrupted* — the in-flight marker is persisted, not in-memory.

## Goals / Non-Goals

**Goals:**

- One shared, freshness-tracked copy of pod data, read by every screen, provider-agnostic.
- Every screen updates in place; navigation swaps content inside one resident document.
- Preserve what the reviewer was doing across every repaint and every route change.
- Land in phases that are individually shippable and individually revertable.

**Non-Goals:**

- **No change to the provider interface.** Propagating the HTTP layer's 304 signal (`src/providers/github/http.ts:447-452`) up to the app layer so a not-modified response could skip re-derivation is a real win and is explicitly out of scope: it would put a transport concept into a provider-neutral interface. The store gets its change detection from structural equality instead.
- **No UI framework, no new runtime dependency.** See D6.
- **No change to what any screen displays.** Every existing `*Html.test.ts` assertion about content stays true.
- **No change to the retained-review requirements.** They constrain this design; they are not edited by it.
- **No cross-window state sharing.** State is per extension host, as today.
- **Not a rewrite of `reviewFlow.ts`.** Its size is a separate problem.

## Decisions

### D1 — One `AppStore` in `src/app/`, with the pub/sub shape already in the codebase

A single `AppStore` owns pod-scoped platform data. It lives in `src/app/`, imports no `vscode`, takes `KeyValueStore` and a connection factory as constructor dependencies, and exposes `subscribe(listener): Disposable`-shaped unsubscription using the same `Set<listener>` pattern as `ReviewRunManager`. It holds only the neutral domain types the provider interface returns.

*Alternative rejected — `vscode.EventEmitter`.* It disposes cleanly with `context.subscriptions` and is idiomatic, but it would be the first `vscode` import in the store layer of `src/app/`, and it makes the store untestable without the `vscode` shim that the existing app-layer tests deliberately avoid.

*Alternative rejected — a reducer/action store (Redux-shaped).* Serializable actions, a single reducer and time-travel buy nothing here: there is one writer per slice, no undo across slices, and no need to replay. It would add ceremony to every call site.

*Alternative rejected — leaving per-module caches and just adding a TTL to each.* That is the current architecture with a timer bolted on. It cannot coalesce two screens' concurrent fetches, which is the largest single win.

### D2 — Freshness window is the pod's own poll interval

`pollIntervalMs(pod)` (`src/app/pollSchedule.ts:73-85`) already computes how often a pod may be polled without exceeding `BACKGROUND_REQUESTS_PER_HOUR`, scaling with repository count. The store reuses it as its freshness window. Data younger than that window is served without a fetch; older data is served immediately and revalidated behind.

*Alternative rejected — a fixed constant (30s).* For a large pod that is below the interval `pollSchedule.ts` exists to enforce, so it would double the request rate for exactly the pods the budget protects.

### D3 — Stale-while-revalidate with single-flight, keyed by pod id

Per pod the store holds `{ data, fetchedAt, inFlight? }`. A read either returns held data (fresh: no fetch; stale: fetch started behind it) or, when nothing is held, returns the in-flight promise — starting one only if none exists. Concurrent readers therefore share one fetch. A pod switch does not invalidate the previous pod's entry, but nothing reads it until that pod is active again; entries are bounded to the pods in `PodStore`.

The `refreshSeq`/`canRender()` guards already in `dashboard.ts:100-101` and `sidebar.ts:152,169` remain: they protect against a late fetch overwriting a newer paint, which single-flight does not address.

### D4 — Change detection by structural equality on the neutral types

Before notifying, the store compares the new snapshot to the held one and drops the notification if they are equivalent. Comparison is over the neutral shapes only — change requests, work items, CI runs — with volatile fields the UI does not show (fetch timestamps) excluded from the comparison.

This generalises two throttles the codebase already hand-rolled: the run-status transition check in `src/extension.ts:143-151` (explicitly there to avoid "four platform fetches a second") and the head-SHA check in `src/ui/reviewFlow.ts:508-513`. Both move into or defer to the store.

*Alternative rejected — a monotonic revision counter bumped on every fetch.* Cheaper to compare, but it cannot tell "fetched again" from "changed", which is the entire point.

### D5 — The notifier's poll becomes the store's revalidation driver

`VerdictNotifier` currently runs the only real poll loop (`src/ui/notifier.ts:173-178, 305-383`) and fetches pod data solely to derive notification events, which are already change-detected by `NotificationCenter.observe` (`src/app/notificationCenter.ts:75-81`). It stops fetching directly: it asks the store to revalidate and consumes the result. Its self-rescheduling timer, its `polling` re-entrancy guard, and its window-focus re-poll stay where they are — the store owns caching, not scheduling.

The review flow's separate 45-second head poll (`src/ui/reviewFlow.ts:73, 234, 477`) stays as it is. It watches a different thing (the diff's head SHA) on a different cadence, and it already diffs before repainting.

### D6 — Keep string-region patching; no virtual DOM

Region patching stays the update mechanism, extended to every surface. Regions become finer-grained where per-row state matters (the posted-reviews thread list, the sidebar's active-review block) rather than one region per screen.

*Alternatives rejected — `morphdom`, `lit-html`, Preact.* Each would give true node-level diffing and remove the `innerHTML` state-loss problem outright. Against that: the webview stack is zero-dependency under a strict CSP that forbids inline styles and requires a nonce on every script; every screen's render code produces HTML strings and every `*Html.test.ts` asserts on those strings, so adopting a VDOM means rewriting the renderers *and* the test suite in the same change; and the string-region approach is already proven on the three busiest screens. The cost of keeping it — `innerHTML` discards DOM state not explicitly restored — is bounded and addressed in D8.

### D7 — A resident shell: static assets load once, the route's body is swapped

Today every route entry assigns a whole document. The shell becomes one document, assigned once per panel lifetime, containing the union of every route's CSS and bootstrap script plus an empty `#app-route` region. Navigating patches `#app-route` and the breadcrumb.

- **CSS is unioned and scoped.** Each route's CSS is emitted under a route-scoped ancestor class so two screens' rules cannot collide. Current class prefixes (`flow-`, `db-`, `pr-`) are already largely disjoint; the audit for stragglers is a task.
- **Scripts register once.** Every route's handlers are `document`-level delegated listeners keyed on `closest()` selectors, as the review flow already does (`src/ui/reviewFlowHtml.ts:1278-1330`). Handlers for a route that is not showing match nothing. The unmigrated screens' inline handlers are converted to this form.
- **`setHtml` survives as the fallback.** The shell is assigned on first paint and re-assigned when `onReload` fires (`src/ui/appSurface.ts:9-21`), which is exactly the existing not-ready path. No new "force full" signal is introduced.
- **No inline `style` attributes in any renderer.** The CSP drops them silently; every visual difference goes through a class.

*Alternative rejected — injecting each route's `<style>`/`<script>` lazily on first visit.* It keeps first paint smaller, but a nonce-bearing script node added at runtime is a CSP surface worth not opening, and it makes "has this route's script already registered" a piece of state to get wrong. The union is ~60–70 KB paid once per panel lifetime against ~40 KB paid per navigation today.

*Alternative rejected — one panel per screen.* It gets browser-native back/forward and isolation for free, and it is what `AppSurface` was built to replace. Reverting it would reopen #39.

### D8 — Per-route view state is retained in the webview and restored

`REGIONS_SCRIPT` already snapshots and restores focus, text selection and window scroll around a patch (`src/ui/theme.ts:400-426`). It gains two things:

- **Expanded/collapsed and scrolled-container state**, captured from elements carrying a stable id and an `open`/expanded data attribute, restored after the patch — the state `innerHTML` replacement would otherwise discard.
- **A per-route snapshot**, kept in the webview, taken when a route is left and reapplied when it is entered, so going back to a screen restores its scroll position and expanded sections.

The existing restraint stays: focus and selection are restored, `value` is never restored, because a re-rendered value is the panel's own state and overwriting it with a stale typed value would clobber a regenerated summary.

*Alternative rejected — the webview's `getState`/`setState` API.* It is currently unused (`acquireVsCodeApi()` is called only for `postMessage`). It persists across a webview reload, which is more than is needed, and it would be a second place route state lives beside the panel classes' own fields.

### D9 — Coalesced draft writes, guarded against the one-writer rule

`persistDraft` becomes a coalescing writer: consecutive calls within a short window collapse into one `workspaceState.update`, with a hard flush before submit, before the panel is disposed, when the panel stops being visible (`onDidChangeViewState`, already wired at `src/ui/reviewFlow.ts:267`), and when the editor window loses focus.

Two properties make this safe rather than merely faster:

- **The write is a whole-key put, not a read-modify-write.** `persistDraft` calls `update(key, {…})` with no preceding `get` (`src/ui/reviewFlow.ts:523`), so deferring it does not interleave with the `storage.ts:6-21` contract. The read-modify-write callers (`ReviewRunStore.record`, `ThreadFlags`, `PodStore`) are not coalesced and keep their synchronous pairing untouched.
- **A generation guard preserves the one-writer rule.** The draft key is also the retained-review key (see Context), and the run manager overwrites it wholesale when a re-run succeeds. A pending coalesced write must never land on top of that. The panel records the identity of the record it loaded — the run's `ranAt` plus target — and the deferred write re-reads the key and drops itself if what is stored is from a different run. The read and the update are adjacent with no `await` between them, as the contract requires. The panel additionally cancels any pending write when it observes a `succeeded` settle for its own target, which it already subscribes to.

The observable durability contract is in `specs/app-state/spec.md` — *Triage decisions are durable even though their writes are batched*. The window is an implementation detail; the flush points are not.

### D10 — Bounded memoization of the pure derivations

`parseHunks(diff)`, `diffStats(files)` and `renderMarkdown(text)` are pure and are recomputed on every render (seventeen call sites in the review flow alone), including renders caused by state that touches neither. Each gets a small LRU memo keyed on its input string, capped by entry count and total characters, in the shape of the existing `EtagCache` bounds (`src/providers/github/http.ts:205-278`) rather than a new convention.

*Alternative rejected — a `WeakMap` keyed on the input object.* The inputs are strings; a `WeakMap` cannot key on them.

*Alternative rejected — memoize the whole view-state derivation.* The view state depends on many inputs including mutable panel fields; keying it correctly is where cache bugs live. Memoizing the three genuinely pure, genuinely expensive leaves gets most of the benefit with a key that cannot be wrong.

### D11 — Four phases, each shippable on its own

1. **Cheap wins, no architecture change.** Memoize the three derivations (D10). Make `setActiveReview`/`setThreads`/`setActiveRoute`/`setPendingReview` patch the sidebar's own regions from held state instead of calling `render()`. Take `testConnection()` off the settings message tail. Coalesce `persistDraft` with its guard (D9).
2. **The store.** Introduce `AppStore` (D1–D4), move `fetchPodData` call sites behind it, replace `repaintReviewSurfaces` with subscriptions, point the notifier at it (D5).
3. **Region patching everywhere.** Migrate `changesetReview`, `changeset`, `settings`, `tuning`, `onboarding` and the sidebar; convert their inline handlers to delegated ones; make posted-review thread actions patch one thread.
4. **The resident shell.** Union the CSS and scripts, swap `#app-route`, add per-route view-state retention (D7, D8).

Phase 1 is worth shipping alone: it removes three network requests per triage click and a connection test per settings toggle. Phase 3 depends on the delegated-handler conversion, which is also what phase 4 needs, so 3 before 4 is not optional.

## Risks / Trade-offs

- **A deferred draft write clobbers a newer retained review** → the highest-severity risk in the change, because it would silently violate *A cached review is replaced only by a review that succeeds*. Mitigated by D9's generation guard plus cancel-on-settle, and by a test that starts a re-run while a coalesced write is pending and asserts the new run's result survives.
- **A crash inside the coalescing window loses the last decisions** → the window is short and every pause, navigation, visibility change, window blur, dispose and submit flushes. A reviewer who is still clicking has not yet lost anything they would notice; a reviewer who stopped has been flushed.
- **CSS or script collisions in the unioned shell** → route-scoped ancestor class per route's CSS, an audit of unprefixed selectors before the union lands, and a test that renders two routes into one document and asserts each screen's own assertions still hold.
- **`innerHTML` patching discards DOM state nothing restores** → D8 extends the snapshot/restore to expanded and container-scroll state; regions are made fine-grained where per-row state exists. Residual: any state added later in a renderer without a stable id will not be restored, which is a convention to document, not a mechanism.
- **Change detection is too coarse and suppresses a real update** → equality is over the whole neutral snapshot, so a field the UI shows can only be missed if it is excluded from comparison. Only fetch timestamps are excluded, and that exclusion is explicit rather than a deep-equal quirk.
- **Change detection is too fine and costs more than it saves** → snapshots are lists of small records; comparison is bounded by the same list sizes already sorted, filtered and mapped on every render today.
- **The shell's first paint gets larger** → ~60–70 KB assigned once per panel lifetime, and the panel is `retainContextWhenHidden` so it is rarely recreated. Measure the first-paint size in phase 4 and keep it in the test suite as a bound.
- **The store outlives a pod's relevance and holds stale data** → entries are keyed by pod id and bounded by `PodStore`'s list; a pod removed from the store drops its entry.
- **Phase 2 changes who fetches, so a fetch that used to happen no longer does** → subscriptions replace the `repaintReviewSurfaces` fan-out one surface at a time, each with a test asserting the surface still updates on the events it used to be told about.

## Migration Plan

Each phase is a separate commit series behind no flag — there is no persisted format change and no user-visible contract change to gate. Rollback is `git revert` of a phase.

The one format-adjacent concern is D9: the draft record's shape does not change, so a downgrade reads records written by the coalesced writer without any migration. The generation guard reads `ranAt`, which `add-background-review-runs` already writes (D7a).

Phase ordering is fixed by dependency: 1 is independent; 2 depends on nothing but is easiest to verify after 1 removes the noisiest fetch; 3 requires the delegated-handler conversion; 4 requires 3.

## Open Questions

- **The coalescing window in milliseconds.** Tune against real triage input; the spec constrains the flush points, not the interval, so any value that flushes correctly satisfies the requirement.
- **Whether the tuning and onboarding screens need per-route view-state retention.** Both are short and rarely returned to mid-scroll. If they do not, D8's per-route snapshot can be limited to the screens that scroll.
- **Whether the sidebar should share the resident shell's mechanism.** It is a separate `WebviewView`, not a route in the panel, so D7 does not reach it; it gets region patching in phase 3 either way. Whether its shell is worth unifying can be answered after phase 4.
