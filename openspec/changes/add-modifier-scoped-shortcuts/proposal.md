## Why

The triage keyboard map is bound at the editor level on bare, unmodified keys — `a`, `⇧a`, `r`, `s`, `j`, `k`, `u`, `1`–`4`, `⇧/` (`package.json:396-470`, fourteen entries) — and every one of them is gated only by `verdict.reviewFocus`. That context key tracks whether the review **tab** is the active tab (`src/ui/reviewFlow.ts:312-314`, set from `route.panel.active` and updated on `onDidChangeViewState`). It says nothing about where the cursor is inside the tab, and nothing about which of the review's six screens is showing. Both gaps are live.

**Typing records verdicts.** The review flow's own key handler is careful — it stands down when the event target is an `input` or `textarea`, and it refuses any event carrying Ctrl/Meta/Alt (`src/ui/reviewFlowHtml.ts:1810-1823`). The editor-level keybinding has no such guard and fires anyway. VS Code forwards a webview's keydown to the workbench and re-dispatches it for keybinding matching, so the letter reaches the text box *and* the command runs. The review screen has five editable fields — `#extra` (extra instructions), `#ask`, `#summary-text`, `#final-note` and the `#conf` slider — and typing an `a`, `r`, `s` or `u` in any of them reaches `dispatchCommand`.

**Nothing downstream refuses it.** `ReviewFlowPanel.dispatchCommand` (`src/ui/reviewFlow.ts:1709-1714`) translates the command and hands it straight to `onMessage`, and the `verdict` case (`:1241`) checks only that `this.review` exists. `this.review` is cleared in exactly two places (`:574` on load, `:1004` when a change request has no record) — never on a screen transition. So on the **summary** screen, where the reviewer is composing the final note over a fully triaged review, typing `a` overwrites the selected finding's verdict with "accepted", `u` clears it, and auto-advance moves the selection while they type. `src/ui/changesetReview.ts:901` has the identical shape. This is silent corruption of a decision the reviewer already made, not a cosmetic annoyance.

**The keys are armed on screens that have no findings.** `renderReviewFlowBody` (`src/ui/reviewFlowHtml.ts:1838-1856`) renders `agent | running | submitting | triage | clean | summary | done` all inside the same `.route-flow` container. The webview handler checks for that container but not for the screen, and the editor-level `when` clause checks neither. `j`/`k`/`1`–`4` are live on the run-configuration screen, on the running screen and on the done screen.

**A modifier is also missing.** Every published VS Code keybinding for this product is a key a reviewer types. That is the shape of the defect, independent of the focus and screen gates above.

## What Changes

### The editor-level map moves to a modifier VS Code does not use

Every currently-unmodified binding moves to `ctrl+shift+alt+<key>` on Windows and Linux, `cmd+shift+alt+<key>` on macOS. **BREAKING** for anyone with the current keys in muscle memory.

| Action | Today | Windows / Linux | macOS |
| --- | --- | --- | --- |
| Accept | `a` | `ctrl+shift+alt+a` | `cmd+shift+alt+a` |
| Accept comment-only | `⇧a` | `ctrl+shift+alt+m` | `cmd+shift+alt+m` |
| Reject | `r` | `ctrl+shift+alt+r` | `cmd+shift+alt+r` |
| Skip | `s` | `ctrl+shift+alt+s` | `cmd+shift+alt+s` |
| Next / previous | `j` / `k` | `ctrl+shift+alt+j` / `+k` | `cmd+shift+alt+j` / `+k` |
| Undo verdict | `u` | `ctrl+shift+alt+u` | `cmd+shift+alt+u` |
| Jump to severity | `1`–`4` | `ctrl+shift+alt+1`–`4` | `cmd+shift+alt+1`–`4` |
| Keyboard help | `⇧/` | `ctrl+shift+alt+/` | `cmd+shift+alt+/` |
| Add context | `ctrl+/` / `cmd+/` | unchanged | unchanged |
| Ask agent | `ctrl+enter` / `cmd+enter` | unchanged | unchanged |

`ctrl+shift+alt` is the only modifier family in which all twelve keys are unbound on all three platforms. That was checked two ways: against VS Code 1.136's published default-keybinding dumps, and by decoding the keybinding registrations in the VS Code 1.135 bundle installed on this machine. The families that lose: `alt+<key>` (`alt+s` and `alt+r` are the Selection and Run menu mnemonics on Windows and Linux; macOS Option composes `å ® ß` and the umlaut dead key; `alt+1`–`4` already switch editor tabs), `shift+alt+<key>` (`shift+alt+a` is block comment), `ctrl+<key>` (all twelve are core commands), `ctrl+alt+<key>` (VS Code's own policy forbids shipping these on Windows because AltGr produces them, and `ctrl+alt+r`/`+s`/`+/` are taken), and `ctrl+shift+<key>` (nine of the twelve are core defaults). Two-key chord prefixes were rejected: two strokes per action is worse than one chord on keys pressed in sequence.

One disclosed exception: `ctrl+shift+alt+a` is VS Code's `workbench.action.openAgentsWindow`, whose `when` clause matches only with accessibility mode enabled. An extension keybinding outranks a core default, so Verdict wins — but only while a review tab is focused. The mnemonic is worth that.

### The plain letters survive inside the review screen, correctly scoped

The webview's own handler keeps `a ⇧a r s j k u 1–4`, because it can check synchronously what the editor-level layer cannot: it already refuses when the cursor is in a text field, and it will now also refuse on any screen but triage. So the fast path stays fast for the reviewer working down the list, the four-key chord is what works from inside a text box, and neither path can steal typing. Its target guard widens from `input`/`textarea` to the fuller `input, textarea, select, [contenteditable]` form the help overlay already uses (`src/ui/theme.ts:367`).

Removing the bare editor-level bindings also removes the duplicate dispatch: today a plain `j` on the triage screen is handled by the webview **and** matched by a keybinding.

### A triage action is refused off the triage screen, whatever route it arrives by

- A new context key scopes the triage keys and `ask agent` to the triage screen, following the shape `verdict.reviewContextFocus` already uses for the agent screen (`src/ui/reviewFlow.ts:346-351`).
- The panels refuse `verdict`, `undo`, `move` and `jumpSeverity` unless the triage screen is showing — in the message handler, so a command from the palette, a stale keypress or a future caller is refused the same way a keystroke is. This is what actually closes the summary-screen corruption; the key scoping alone would leave the palette path open.

### What the product says about its own keys

The keyboard overlay, the status bar segment and the fallback message all name the old keys and are rewritten. The overlay is also corrected while it is open: it currently advertises eight shortcuts that were never implemented — `E`, `F`, `⇧F`, `O`, `⌘1/⌘2/⌘3`, `G then D`, `G then P` and `⌘↵` generate summary (`src/ui/theme.ts:290-325`; all click-only in `src/ui/reviewFlowHtml.ts:1763-1809`). Shipping a rewritten overlay that still lists them is not defensible. This correction is deliberately a separate task group so it can be dropped without affecting the rest.

## Capabilities

### New Capabilities
- `keyboard-shortcuts`: What the product binds to the keyboard, what must be true for a binding to fire — a modifier the editor does not otherwise use, the screen the action belongs to, and the cursor not being in a text field — and the rule that no keystroke reaches a triage action from a screen that has no findings on it. Also covers what the product must tell the reviewer about its own keys.

### Modified Capabilities
<!-- None. `review-context-controls` specifies that Add Context is reachable by
     keyboard and that a changeset review routes the Add Context keyboard command
     the same way a single change request does; its chord (`ctrl+/` / `cmd+/`) and
     its routing are unchanged by this change, so the requirement still holds as
     written. `ui-responsiveness` governs what survives a redraw, not what a key
     does. `background-review-runs` and `app-state` say nothing about input. -->

## Impact

| Area | Effect |
| --- | --- |
| `package.json:396-470` | Fourteen keybinding entries: twelve rebound to the `ctrl+shift+alt` family with `mac` variants, `when` clauses tightened to the triage screen for the eleven triage actions and for `askAgent`. |
| `src/ui/reviewFlow.ts`, `src/ui/changesetReview.ts` | A triage-screen context key alongside `verdict.reviewContextFocus`, set from the same two places its sibling is (`setReviewFocus` and the render tail). Screen guard on the `verdict`, `undo`, `move` and `jumpSeverity` message cases. |
| `src/ui/reviewFlowHtml.ts` | `#flow-body` carries the current screen as a data attribute, matching how `#app-route` already carries `data-route-key` (`src/ui/theme.ts:668`). The key handler reads it, and widens its text-field guard. |
| `src/ui/theme.ts` | The overlay's key groups become platform-aware (the chord renders `⌘⇧⌥A` on macOS) and lose the eight unimplemented rows. |
| `src/ui/sidebar.ts:424`, `src/extension.ts:744-751` | The status bar's `? keys` label and the no-screen fallback message name the new chords. |
| `docs/ARCHITECTURE.md:200`, `spec/README.md` §12, `spec/specs/Code Verdict - developer handoff.md:171` | Three places assert the old map or the old scoping rule. |
| Tests | `src/commands.test.ts:69-115` asserts the exact bound key set and is rewritten. `src/ui/theme.test.ts`, `src/ui/reviewFlowHtml.test.ts:99` and `src/ui/appShell.test.ts:179-188` all assert against the current map. The repo has one test that dispatches a real key event, and it is a negative one; positive coverage is added. |

**Not addressed.** Keys forwarded out of a webview carry no `isComposing` flag, so a binding can in principle fire on a keystroke an input-method editor owns. A modifier chord is unlikely to be pressed mid-composition and this change does not close that hole. On Windows international layouts `Shift+AltGr` is a real fourth shift state; VS Code ships four Windows defaults in this family itself, so the risk is judged acceptable, but it was reasoned about rather than tested on a non-US layout.
