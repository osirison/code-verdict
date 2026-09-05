## 1. Refuse a triage action off the triage screen (D3)

Lands first and stands alone: it closes the summary-screen corruption without touching a single keybinding, so it is shippable and revertible on its own.

- [ ] 1.1 In `ReviewFlowPanel.onMessage` (`src/ui/reviewFlow.ts:1241-1272`), refuse `verdict`, `undo`, `move` and `jumpSeverity` unless `this.screen === 'triage'`. Refuse by returning — do not clear or rewrite `this.review`, so the retained-review invariants from `background-review-runs` are untouched.
- [ ] 1.2 The same four cases in `ChangesetReviewPanel.onMessage` (`src/ui/changesetReview.ts:901-915` and the `undo`/`move`/`jumpSeverity` cases beside it).
- [ ] 1.3 Leave `select` and `setMode` unguarded, and say why in a comment: the sidebar tree reaches a finding through `ReviewFlowPanel.selectItem`, which has its own existence check, and mode is a triage-screen control already.
- [ ] 1.4 Tests in `src/ui/reviewFlow.test.ts`: with a fully triaged review on the `summary` screen, `dispatchCommand('codeVerdict.acceptItem')` leaves every verdict as it was; the same for `undoVerdict`, `nextItem` and `jumpSeverity`, including that `selectedId` does not move. Repeat on `agent`, `running` and `done`. On `triage`, each one still works.
- [ ] 1.5 The same set in `src/ui/changesetReview.test.ts`.

## 2. A triage-screen context key (D2, host half)

- [ ] 2.1 Add `verdict.reviewTriageFocus` = `reviewFocusActive && screen === 'triage'` to `setReviewFocus` (`src/ui/reviewFlow.ts:340-352`) and to the render tail that re-publishes `verdict.reviewContextFocus` (`:1934-1937`). Both sites, for the same reason the sibling key needs both: focus and screen change independently.
- [ ] 2.2 The same two sites in `src/ui/changesetReview.ts:281-288` and `:1385-1389`.
- [ ] 2.3 Confirm both keys are still cleared on `route.onLeave` (`src/ui/reviewFlow.ts:305`) — `setReviewFocus(false)` must publish the new key as false too, not just the two existing ones.
- [ ] 2.4 Tests: entering triage publishes `verdict.reviewTriageFocus` true; a screen transition away from triage publishes it false; leaving the route publishes it false; the panel becoming inactive publishes it false.

## 3. The screen marker the webview key handler reads (D2, DOM half)

- [ ] 3.1 Emit a hidden marker carrying the current screen from `renderReviewFlowBody` (`src/ui/reviewFlowHtml.ts:1838-1856`) — e.g. `<span hidden data-flow-screen="${s.screen}"></span>` ahead of the screen's own markup. It must come from this function and not from `renderReviewFlowHtml`'s `#flow-body` wrapper (`:1874`): `postRegions({'flow-body': …})` (`src/ui/reviewFlow.ts:1944`) replaces the container's contents, so an attribute on the container itself would go stale on the first patch. This one funnel is what makes the full render, the region patch and the changeset review all carry it.
- [ ] 3.2 In the key handler (`src/ui/reviewFlowHtml.ts:1810-1823`), add the screen check after the existing `.route-flow` check: `document.querySelector('[data-flow-screen]')?.dataset.flowScreen === 'triage'`, else return.
- [ ] 3.3 Widen the text-field guard in the same handler from `ev.target instanceof HTMLTextAreaElement || ev.target instanceof HTMLInputElement` to the fuller form the overlay already uses (`src/ui/theme.ts:367`): `ev.target.closest('input, textarea, select, [contenteditable]')`. Guard the `closest` call for a non-Element target, as `theme.ts` does.
- [ ] 3.4 Tests in `src/ui/appShell.test.ts`, beside the existing negative test at `:179-188` — the repo's only test that dispatches a real key event, and currently its only one. Add the positive counterparts in jsdom over the full seven-route shell: a `keydown` of `j` with the marker reading `triage` posts exactly one `{type:'move',delta:1}`; the same key with the marker reading `summary` posts nothing; the same key with the event target inside a `textarea`, a `select` and a `[contenteditable]` posts nothing; `a` with `ctrlKey` set posts nothing (the chord belongs to the editor layer).
- [ ] 3.5 Test in `src/ui/reviewFlowHtml.test.ts`: `renderReviewFlowBody` emits the marker with the right value for every one of the seven screens, so that both the full page and the region patch carry it. Then the regression that matters: render the full page on `triage`, apply a `flow-body` patch rendered on `summary`, and assert the marker in the document now reads `summary` — this is the assertion that would have caught putting the attribute on the container.

## 4. Rebind the editor-level map (D4)

- [ ] 4.1 Rewrite `contributes.keybindings` (`package.json:396-470`). Twelve entries move to `ctrl+shift+alt+<key>` with a `mac` variant of `cmd+shift+alt+<key>`: `a` accept, `m` accept comment-only, `r` reject, `s` skip, `j` next, `k` previous, `u` undo, `1`–`4` severity, `/` keyboard help. The macOS column must use the `cmd` form — `ctrl+shift+alt+j` and `ctrl+shift+alt+r` are real macOS defaults and the `cmd` form is what avoids them.
- [ ] 4.2 `when` clauses: the eleven triage actions and `codeVerdict.askAgent` become `verdict.reviewFocus && verdict.reviewTriageFocus`. Keyboard help stays on `verdict.reviewFocus` alone. `codeVerdict.internal.addContext` keeps `verdict.reviewFocus && verdict.reviewContextFocus` and keeps `ctrl+/` / `cmd+/`; `askAgent` keeps `ctrl+enter` / `cmd+enter`.
- [ ] 4.3 No bare or Shift-only entry survives. Confirm by reading the finished array, not by trusting the diff.
- [ ] 4.4 Rewrite `src/commands.test.ts:69-115`. It asserts the exact bound key set and the `when` prefix, so it is the test that pins this change: assert the new twelve chords with their `mac` variants; assert that no entry's `key` is a single letter, single digit or bare punctuation, and that no entry is a key plus Shift alone; assert the triage entries carry `verdict.reviewTriageFocus` and that help does not.
- [ ] 4.5 Add a test asserting `codeVerdict.askAgent`'s `when` is exactly `verdict.reviewFocus && verdict.reviewTriageFocus`, matching the shape of the existing `addContext` assertion at `:103-107`.

## 5. What the product says about its own keys (D5)

- [ ] 5.1 Make `KEYS_GROUPS` (`src/ui/theme.ts:288-325`) a function of a platform flag rather than a module constant, and pass the flag through the render-options object `renderPage` already takes. The host supplies it from `process.platform === 'darwin'`; the webview must not guess.
- [ ] 5.2 Rewrite the Triage group's caps to the new chords, rendered `⌃⇧⌥A` on Windows/Linux and `⌘⇧⌥A` on macOS. Note against the accept row that the plain letters still work on the triage screen when the cursor is not in a text field — that is the whole reason the fast path was kept, and an overlay that hides it makes the change look worse than it is.
- [ ] 5.3 `src/ui/sidebar.ts:424`: the `$(keyboard) ? keys` label stays correct — the webview's bare-`?` handler is kept (design.md — D5), so `?` still opens the overlay. Leave the label and the click-through alone; add the new chord to the tooltip so the reviewer learns the form that also works from inside a text field.
- [ ] 5.4 `src/extension.ts:744-751`: the fallback information message lists `A ⇧A R S J/K 1–4 U`. Rewrite it to the current chords.
- [ ] 5.5 Update `src/ui/theme.test.ts` (the overlay assertions at `:8-64`) and `src/ui/statusBar.test.ts:97`. Add a test that the overlay renders the `⌘` form under the macOS flag and the `⌃` form otherwise.
- [ ] 5.6 Update `src/ui/reviewFlowHtml.test.ts:99-102` — it asserts the shortcut map's shape by string match and will still hold, but re-read it against the edited handler rather than assuming.

## 6. Verify against a running editor

The repo cannot prove a keybinding fires; only the Extension Development Host can. See `docs/agent-notes/f5-extension-development-host.md` before launching, and use the headless bundle load described there to separate "the extension is broken" from "the window is dying".

- [ ] 6.1 `npm run typecheck && npm run lint && npm run test` all green.
- [ ] 6.2 In the Extension Development Host, on the triage screen: `ctrl+shift+alt+a` accepts; the plain `a` also accepts; `ctrl+shift+alt+j` and plain `j` each move the selection by **exactly one** finding. Record the plain-`j` result — design.md — Open Questions asks whether it moves one or two today.
- [ ] 6.3 With the cursor in `#final-note` on the summary screen, type `arsjku1234` — the characters appear, and no verdict changes. Repeat in `#extra` on the run-configuration screen and in `#ask` on triage.
- [ ] 6.4 With the cursor in `#final-note`, press `ctrl+shift+alt+a` — it triages, and no character is inserted.
- [ ] 6.5 On the dashboard, settings and posted-reviews screens, press `a r s j k u 1 2 3 4` and each chord — nothing happens, and the keys reach the screen that is showing.
- [ ] 6.6 Check VS Code's own keyboard-shortcut editor for a conflict marker against any of the twelve chords in the test profile, and note anything it flags.
- [ ] 6.7 With text in `#ask` on the triage screen, press `ctrl+enter` once and confirm it produces **exactly one** follow-up, not two. This chord still lives at both layers with different payloads (design.md — D6); record what happens, because it decides whether that overlap needs its own change.
- [ ] 6.8 Confirm `?` still opens the overlay on a Verdict screen with the cursor outside a text field, and does not open it with the cursor inside one.

## 7. Documentation

- [ ] 7.1 `docs/ARCHITECTURE.md:200` — "Every keybinding stays scoped to `when: verdict.reviewFocus`, so single letters never steal typing elsewhere" is now wrong twice. Replace it with the two-layer rule: the editor layer publishes only modifier chords and scopes triage to the triage screen; the webview layer owns the plain keys and is the only layer that can see where the cursor is.
- [ ] 7.2 `spec/README.md` §12 — the key caps in the overlay description and the header line "shortcuts apply when the review tab has focus".
- [ ] 7.3 `spec/specs/Code Verdict - developer handoff.md:171` — "`A` accept … Bind under `when: verdict.reviewFocus`".
- [ ] 7.4 A journal entry under `~/fedora/journal/code-verdict/` on why every two- and three-key modifier family was unusable and what the two-layer split buys.

## 8. Correct the overlay's unimplemented rows (droppable)

Separate on purpose, per proposal.md — it can be cut without affecting anything above.

- [ ] 8.1 `src/ui/theme.ts:290-325` advertises eight shortcuts with no key handler anywhere: `E` explain, `F` show fix, `⇧F` find similar, `O` open in editor, `⌘1/⌘2/⌘3` mode, `G then D` dashboard, `G then P` posted reviews, and `⌘↵` generate summary. Each is click-only (`src/ui/reviewFlowHtml.ts:1763-1809`). Remove the rows.
- [ ] 8.2 Keep `⌘↩` Ask, which is real (`codeVerdict.askAgent` plus the `#ask` handler at `src/ui/reviewFlowHtml.ts:1747`), and keep the Everywhere group's palette and Esc rows.
- [ ] 8.3 Update `src/ui/theme.test.ts` — it asserts the overlay renders four groups; the Agent and Navigation groups shrink or disappear.
- [ ] 8.4 Update `spec/README.md` §12's group listing to match, so the design document and the shipped overlay agree.
