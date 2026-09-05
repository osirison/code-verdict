## Context

See proposal.md — Why for the defect and its evidence. What follows is only the state of the code and of the platform that shapes the approach.

**Two layers bind the same keys, and only one of them can see what the other can.** The editor layer is `contributes.keybindings` (`package.json:396-470`) → a command → `routeToActiveReviewCommand` (`src/ui/flowCommands.ts:18-24`) → `flowCommandMessage` → `panel.dispatchCommand`. The webview layer is a single delegated `document` keydown listener (`src/ui/reviewFlowHtml.ts:1810-1823`) → `post(...)` → `route.onMessage`. Both converge on the *same* `FlowMessage` shapes, which is why the fix can move work between them freely. The webview layer runs inside the document and can therefore read `ev.target` and the DOM synchronously. The editor layer runs in the extension host and can read only context keys.

**There is no context key for focus inside a webview.** `inputFocus` and `textInputFocus` stay false for a focused webview, and `activeWebviewPanelId` follows which editor is active, not where the caret is. The extension host learns about focus inside its own webview only by being told, over `postMessage`. That is the constraint that decides D1.

**The scoping mechanism already exists, once.** `verdict.reviewContextFocus` is `reviewFocusActive && screen === 'agent'`, set in `setReviewFocus` and again on the render tail (`src/ui/reviewFlow.ts:340-352, 1934-1937`; `src/ui/changesetReview.ts:281-288, 1385-1389`). It is set twice because focus and screen change independently, and both have to re-publish. This change adds a sibling, not a new mechanism.

**The DOM already carries route identity but not screen identity.** `renderPage` stamps `data-route-key` on `#app-route` (`src/ui/theme.ts:668`) and `REGIONS_SCRIPT` reads it for per-route scroll state. `#flow-body` (`src/ui/reviewFlowHtml.ts:1874`) carries nothing, so the key handler can tell it is on the review route but not which of the seven screens `renderReviewFlowBody` produced.

**The webview stack has no dependencies and a strict CSP** (`default-src 'none'`, nonce'd style and script). Inline `style="…"` is dropped silently. Every screen's tests assert against the generated HTML string.

**Two constraints on the panels, from `background-review-runs`, are invariants here rather than targets.** A completed review is cached and is what its target opens on; a cached review is replaced only by a review that succeeds. The screen guard added in D3 must refuse a *write*, not discard a record.

## Goals / Non-Goals

**Goals:**

- No keystroke a reviewer types can reach a triage action, on any screen, from any field.
- The chord is the same everywhere, learnable in one line, and unbound in VS Code on all three platforms.
- The fast single-key loop survives, at the only layer that can make it safe.
- The corruption path is closed at the message handler, so it does not depend on any key layer being correct.

**Non-Goals:**

- **No new setting.** VS Code's own keyboard-shortcut editor already rebinds any of this; a `codeVerdict.*` key that duplicates it is a second source of truth for the same fact.
- **No focus-tracking context key.** See D1 — it is unnecessary once the editor layer carries a modifier, and it would introduce a race for no gain.
- **No chord prefixes** (`ctrl+k v <key>`). Two strokes per action on keys pressed in sequence is worse than one chord, and both plausible prefixes are complete bindings already.
- **No change to what a triage action does.** Only to when it is allowed to happen.
- **No IME composition guard.** Named in the proposal's Impact as not addressed.
- **Not a redesign of the map's semantics.** `a` still accepts; only what it takes to press it changes.

## Decisions

### D1. The modifier removes the need for a focus-tracking context key

The obvious fix for "typing records verdicts" is a `verdict.reviewTyping` context key: the webview posts `focusin`/`focusout` to the host, the host calls `setContext`, and every `when` clause becomes `… && !verdict.reviewTyping`. That is the only mechanism available — `preventDefault()` inside the webview cannot stop the forwarded copy, because the host re-dispatches a synthetic event without consulting it.

**Rejected, because the modifier makes it unnecessary.** Once no editor-level binding is a key a reviewer can type, there is nothing for a typing gate to suppress: `ctrl+shift+alt+a` inside a textarea inserts no character, so firing the command there is correct and is in fact the behaviour the spec asks for ("Triaging without leaving the field"). The gate would only add a webview → host → context-key round trip that races the first keystroke after a focus change, for a case that no longer exists.

The webview layer keeps its own check, which is not a race: `ev.target` is read synchronously in the same event.

### D2. Screen scoping is a context key on the host and a data attribute in the DOM

Two layers need the same fact, and neither can read the other's.

- **Host:** `verdict.reviewTriageFocus` = `reviewFocusActive && screen === 'triage'`, published from the same two call sites as `verdict.reviewContextFocus` and in the same style. The eleven triage bindings and `askAgent` gate on `verdict.reviewFocus && verdict.reviewTriageFocus`; keyboard help stays on `verdict.reviewFocus` alone, because a lost reviewer needs it on the screens where nothing else works.
- **DOM:** the marker cannot go on `#flow-body`. `postRegions({'flow-body': …})` (`src/ui/reviewFlow.ts:1944`) replaces that element's *contents*, not the element, so an attribute written by the full page render would go stale on the first patch and the plain keys would stay armed after leaving triage. The marker therefore has to be part of the region's own markup. `renderReviewFlowBody` (`src/ui/reviewFlowHtml.ts:1838-1856`) is the single funnel both the full render and the patch go through, so it emits a hidden marker element carrying the screen, and the key handler reads it with a `querySelector`. This follows the spirit of `data-route-key` on `#app-route` (`src/ui/theme.ts:668`) — identity stamped in the DOM for a delegated listener to read — while respecting that a region patch owns the inside of its container and nothing else.

A hidden marker rather than a wrapper element around the body: the seven screens have their own top-level layout and adding a `<div>` between `#flow-body` and them would put a new box in the middle of every screen's CSS. A `hidden` sibling has no layout at all.

Alternative considered: extend `REGIONS_SCRIPT` to accept attributes alongside region HTML, so the patch could set `data-screen` on `#flow-body` directly. Rejected — it widens a mechanism nine surfaces depend on to serve one screen's key handler.

### D3. The corruption is closed at the message handler, not at the key layer

`verdict`, `undo`, `move` and `jumpSeverity` are refused in `onMessage` unless `screen === 'triage'`, in both `ReviewFlowPanel` (`src/ui/reviewFlow.ts:1241-1272`) and `ChangesetReviewPanel` (`src/ui/changesetReview.ts:901-915`).

This is not redundant with D2. D2 stops the keystroke; D3 stops everything else that can reach the same code — the command palette entries for `acceptItem`/`rejectItem`/`nextItem`/`prevItem`, which are palette-visible and carry no screen condition, and any future caller. It also means the guarantee is testable without simulating a keypress.

The guard refuses rather than clears: `this.review` is left exactly as it was, so the retained-review invariants hold untouched.

`select` and `setMode` are deliberately not guarded — the sidebar's tree selects a finding through `ReviewFlowPanel.selectItem`, which has its own existence check, and mode is a triage-screen-only control already.

### D4. `ctrl+shift+alt` / `cmd+shift+alt`, chosen by elimination and verified twice

Recorded here because the reasoning is the deliverable, not the conclusion. Verified against VS Code 1.136's published default-keybinding dumps for Windows, Linux and macOS, and independently by decoding the keybinding registrations in the VS Code 1.135 bundle installed on this machine. Both methods produced the same free list.

| Family | Why it fails |
| --- | --- |
| bare / Shift-only | The defect. |
| `alt+<key>` | `alt+s` and `alt+r` are the Selection and Run menu mnemonics on Windows and Linux, and an extension binding wins silently, removing keyboard access to a menu. macOS Option composes `å ® ß` and the `u` umlaut dead key. `alt+1`–`4` are already `openEditorAtIndex1..4`. |
| `shift+alt+<key>` | `shift+alt+a` is Toggle Block Comment; `shift+alt+1` moves an editor group. Option+Shift still composes on macOS. |
| `ctrl+<key>` | All twelve keys are core defaults, and `ctrl+k` is the busiest chord prefix in the product. |
| `ctrl+alt+<key>` | VS Code's own guidance is that it ships no `ctrl+alt+<key>` defaults on Windows because AltGr produces them. `ctrl+alt+r`, `+s` and `+/` are taken regardless. |
| `ctrl+shift+<key>` | Nine of the twelve are core defaults — Save As, Delete Line, Refactor, Output, Replace. Three keys instead of four and no layout hazard at all, so this is the runner-up if the freedom requirement is ever relaxed. |
| chord prefix | Two strokes per action on keys pressed in sequence; both plausible prefixes are already complete bindings. |
| modifier + F-key | Hazard-free but has no mnemonic relationship to the actions, for a map used constantly. |

`ctrl+shift+alt` holds only arrows, page keys, Enter, backquote and the letters `a`, `c`, `g`, `i`, `l`, `o` — plus macOS-only `ctrl+shift+alt+j` and `+r`, which the `cmd` form on macOS avoids. Every key this map needs is free on all three platforms except `a`.

`ctrl+shift+alt+a` is `workbench.action.openAgentsWindow`, whose `when` matches only with accessibility mode on. An extension keybinding registers above every core default, so Verdict wins while `verdict.reviewFocus` is true and only then. Accepted for the mnemonic; `ctrl+shift+alt+y` is the zero-collision alternative if that judgement is revisited. Accept-comment-only takes `m` because the mnemonic choice, `c`, is `copyRelativeFilePath` on Linux and macOS.

### D5. The overlay learns the platform from the host

The overlay's key caps are a module constant (`src/ui/theme.ts:288-325`) and now have to render `⌃⇧⌥A` or `⌘⇧⌥A` depending on the platform. The webview cannot be trusted to work this out — the CSP permits script but `navigator.platform` is deprecated and the extension host already knows the answer from `process.platform`.

`KEYS_GROUPS` becomes a function of a platform flag, passed through the existing render-options object that `renderPage` already takes. No new plumbing.

The overlay's own bare-`?` handler (`KEYS_SCRIPT`, `src/ui/theme.ts:346-372`) **stays**, for the same reason the plain triage keys stay: it runs inside the document, on the capture phase, already refuses when the target is an `input`, `textarea`, `select` or editable region, and fires only when a Verdict webview holds focus. It is the editor-level `shift+/` binding that was capable of firing from outside the webview, and that is the one the chord replaces. So `?` continues to open the overlay, and `ctrl+shift+alt+/` is what works from a text field.

### D6. Removing the bare editor bindings also removes a duplicate dispatch

Today a plain `j` on the triage screen is handled by the webview handler *and* matched by the `j` keybinding, because the forwarded copy is re-dispatched without regard to the webview having handled it. Removing the bare bindings makes the webview the sole handler of plain triage keys and the editor layer the sole handler of the triage chords — the webview handler already bails on any event carrying Ctrl/Meta/Alt, so the two cannot both fire. The spec's "One action per keypress" scenario exists to hold this.

One overlap survives and is out of scope: `ctrl+enter` exists at both layers, as `codeVerdict.askAgent` and as the `#ask` handler (`src/ui/reviewFlowHtml.ts:1747-1761`), and the two send *different* payloads — the command asks with the `explain` preset on the selected finding, the DOM handler asks freeform with the typed text. Whether that produces one ask or two today is unknown; task 6.7 checks it manually. It is left alone here because reconciling the two payloads is a change to what asking does, not to when a key fires.

## Risks / Trade-offs

- **Four keys per accept is a real cost** → the plain-key path inside the webview is what keeps the triage loop fast; the chord is the path for a reviewer whose cursor is in a text box. If the plain-key path is ever removed, this scheme becomes worse than the runner-up and the choice should be reopened.
- **`ctrl+shift+alt+a` shadows `openAgentsWindow` for accessibility-mode users** → scoped to a focused Verdict review tab; disclosed in the proposal and in the overlay's own notes if the overlay carries notes.
- **Windows international layouts: `Shift+AltGr` is a genuine fourth shift state** (`Shift+AltGr+A` is `Ą` on Polish Programmers) → mitigated by the fact that VS Code ships `ctrl+shift+alt+a`, `+g`, `+l` and `+o` as Windows defaults itself, so the family is one Microsoft treats as shippable. Reasoned, not observed on a non-US layout.
- **VS Code churn** → the Browser, Sessions and agent-window bindings crowding this space are new in 1.135–1.136 and are the most likely to move. `src/commands.test.ts` asserts the exact bound set, which turns a future collision into a deliberate decision rather than a silent one.
- **Third-party extensions were not audited** → a reviewer may already have another extension on one of these chords. VS Code resolves it by registration order and surfaces it in the keyboard-shortcut editor; rebinding is the reviewer's, and is why D-Non-Goals refuses a competing setting.
- **Breaking muscle memory** → unavoidable and requested. The overlay, the status bar and the release notes are the mitigation; the plain keys still working on the triage screen means the change is invisible to a reviewer who never types mid-triage.
- **The screen marker must live inside the patched region, not on its container** → put on `#flow-body` it would survive the full render and go stale on every patch, leaving the plain keys armed after the reviewer leaves triage. Emitting it from `renderReviewFlowBody` is what makes both paths carry it; task 3.5 pins it for all seven screens.

## Migration Plan

No data migration, no persisted state, no provider contract touched. The change is a keybinding table, two context keys, four guarded message cases and the documentation that describes them.

Rollback is reverting the commit: nothing written to `workspaceState` changes shape, so a downgrade finds exactly the drafts and retained reviews it left.

Land order is the task order: the guard first (it stands alone and closes the corruption without any key change), then the scoping, then the rebinding, then what the product says about itself. Each group is independently revertible.

## Open Questions

- Whether VS Code's forwarding of webview keydowns produces an observably doubled action today for `move` (a plain `j` advancing two findings rather than one). This does not change the design — removing the bare editor bindings resolves it either way — but the manual check in task 6 should record which it was, because the answer tells us whether other single-key extensions in this workspace are affected too.
