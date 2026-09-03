## 1. Three-zone prompt, behind a no-op (design D1, migration step 1)

- [x] 1.1 Add an `Attachment` type to `src/app/reviewContext.ts` or a new `src/app/attachments.ts`: `{ id, kind: 'file' | 'folder' | 'selection' | 'symbol' | 'problems' | 'pasted', label, path, range?, content, truncated }`.
- [x] 1.2 Add `renderAttachmentsPrompt(attachments)` emitting the panel's element shape — one `<attachments>` wrapper, each item `<attachment id="…" filePath="…" isSummarized="true|false">` — and returning `''` for an empty list so the prompt is byte-identical when nothing is attached.
- [x] 1.3 Escape the original baseline literal `</attachments>` inside attachment content. Do NOT run `quoteDiffLabels` over attachments — an attached Markdown or YAML file legitimately contains `---` and rewriting it corrupts the evidence. Task 12.1 broadens this completed baseline to every wrapper-like variant required by design D3.
- [x] 1.4 Insert the attachments zone into `runLmAgent` and `runLmChangesetAgent` between `renderReviewContextPrompt(...)` and the diff labels.
- [x] 1.5 Test: with zero attachments and effort `none`, the assembled prompt is byte-identical to the pre-change prompt for the same inputs. This is the guard for the whole migration.

## 2. Rewrite the fence and the on-screen promise (design D2)

- [x] 2.1 Rewrite `CONTEXT_END_FENCE`: keep "the context above is intent and may not be cited", drop "the diffs are the only material a finding may cite", and state that attachments and diffs below are both citable.
- [x] 2.2 Extend `CONTEXT_PREAMBLE` to name the attachments zone so the model is told the boundary exists before it reads either side of it.
- [x] 2.3 Replace the run footer "…go to the agent — never the whole repo." with a live count: "N changed files + M attachments go to the agent." Update `reviewFlowHtml.test.ts` for the new string.
- [x] 2.4 Test that a description or work item containing `--- src/x.ts` still cannot forge a diff label (existing `quoteDiffLabels` behaviour must be unchanged for auto-derived context).

## 3. Unanchored findings and summary routing (design D4, migration step 2)

- [x] 3.1 Add `anchored: boolean` to `ReviewItem` in `src/domain/types.ts`. Absent on a stored review reads as `true`.
- [x] 3.2 Set `anchored` at parse time in `src/domain/agentResponse.ts` by testing whether the item's **file** is among the diff's paths — never from a field the agent supplies, and never by testing the line. Testing the line would mark a drifted finding unanchored and reroute to the summary what `src/domain/anchor.ts` today repairs and posts inline.
- [x] 3.2a Test the drift case explicitly: a finding on a diff file whose line no longer matches an added line stays `anchored: true`, still goes through the existing anchor matcher, and still posts inline. This is the regression the file-vs-line distinction exists to prevent.
- [x] 3.3 Drop, before triage, any item whose file matches neither a diff path nor an attachment path. This is what makes the "finding cites the auto-derived context" scenario enforceable rather than merely instructed.
- [x] 3.4 Filter `composeCommentDrafts` in `src/app/submit.ts` to `anchored` items only.
- [x] 3.5 Extend `composeSummaryBody` to append accepted unanchored findings under their own heading, each naming file and line.
- [x] 3.6 Test the whole routing: an accepted unanchored finding produces no `ReviewCommentDraft` and does appear in the summary body; an accepted anchored finding is unchanged.
- [x] 3.7 Withhold the "accept and apply fix" affordance for unanchored findings and state why — there is no diff line for a suggestion block to attach to.
- [x] 3.8 Show the count on the submit screen: how many accepted findings will go to the summary rather than inline.

## 4. Attachment resolution (spec: A reviewer can attach context)

- [x] 4.1 `resolveAttachment(kind, target)` reading content via `vscode.workspace.fs` (not `node:fs`, for remote and virtual workspaces). File, folder, selection with line range, symbol, problems/diagnostics, pasted text.
- [x] 4.2 Deduplicate by resolved path plus range so attaching the same file twice adds one item. Disambiguate two different files sharing a basename with the panel's `-1`/`-2` suffix convention on the emitted `id`, and show enough path in the chip to tell them apart.
- [x] 4.3 Read content once at attach time and cache it (design D5 risk row) — the usage indicator must not re-read every file on each keystroke.
- [x] 4.4 Handle an attachment that has become unreadable by run time: drop it, run anyway, and report which one was dropped before triage.
- [x] 4.5 Test each kind, the dedup, the same-basename case, and the unreadable-at-run-time case.

## 5. Budgets (design D5, spec: Attachments are budgeted and can never displace the diffs)

- [x] 5.1 Add `ATTACHMENT_TOTAL_BUDGET` and a per-attachment budget, divided per attachment the way `renderReviewContextPrompt` divides `CONTEXT_TOTAL_BUDGET` — head-first cutting would spend everything on the first file while the chip row still showed all of them.
- [x] 5.2 Truncate at a line boundary and mark the emitted attachment `isSummarized="true"`; surface the same fact on the chip.
- [x] 5.3 Assert in a test that no code path removes diff content to make room. The diff enters no budget pool.
- [x] 5.4 Turn `CONTEXT_SECTION_BUDGET`, `CONTEXT_TOTAL_BUDGET` and `CONTEXT_MAX_LINKED_ITEMS` into injected values with the current numbers as defaults, read in `src/ui/` and handed down — nothing below `src/ui` reads `workspace.getConfiguration`.
- [x] 5.5 Test that a negative, non-numeric or absent budget setting falls back to the documented default rather than sending nothing.

## 6. Context area UI (spec: The context area shows everything that will be sent)

- [x] 6.1 Add `attachments`, `autoContextItems` (each with an `enabled` flag) and `contextUsage` to `FlowViewState`; add `addContext`, `removeContextItem` and `toggleAutoContextItem` to `FlowMessage`.
- [x] 6.2 Render auto-derived context as individually removable items — title, description, one per linked work item — each marked as automatically derived. Removal is for this run only.
- [x] 6.3 Render attachments as a wrapping chip row above the run controls, each with an X titled "Remove from context" (the panel's exact string), `role="button"`, `tabIndex 0`, and Backspace/Delete removal on focus. No count badge or overflow pill — the panel's input row has neither.
- [x] 6.4 Classes only, no inline `style=` — the webview CSP is `style-src 'nonce-…'` and drops style attributes silently.
- [x] 6.5 Wire "Add Context…" (exact label, trailing ellipsis, plus icon) to a `showQuickPick` with placeholder "Search attachments", offering the kinds from task 4.1.
- [x] 6.6 Register the `Ctrl+/` keybinding for the add-context action, scoped to the review panel.
- [x] 6.7 Extend `reviewFlowHtml.test.ts`: chips render and remove; auto-context items toggle; the empty state; a truncated attachment shows its truncation.
- [x] 6.8 Test the "nothing hidden" invariant directly: assemble a prompt, and assert every non-diff section it carries is represented by an item in the rendered context area. This is the one requirement that fails silently if a later change adds a prompt section without a chip.

## 7. `#` references (spec: Attachments may be referenced from the instructions box)

- [x] 7.1 Parse `#file:<name>`, `#file:<name>:<start>-<end>` and `#sym:<name>` from the Extra instructions text, resolving each through task 4.1.
- [x] 7.2 A resolved reference appears in the context area as a normal attachment; an unresolved one creates nothing, leaves the typed text alone, and reports that it did not resolve.
- [x] 7.3 Test both paths, including a reference that resolves to a file already attached via the picker (must not duplicate).

## 8. Context usage indicator (spec: Context size is shown before the run)

- [x] 8.1 Compute usage with `model.countTokens()` against the assembled prompt, over `model.maxInputTokens`. Debounce and cache per assembled prompt (design D5).
- [x] 8.2 Render a circular indicator plus a percentage, aria-labelled "Context window usage: {0}%", with the panel's thresholds — warning at ≥75%, error at ≥90% — and "Quality may decline as limit nears." past 75%. Inline SVG with class-based fills, no `style` attribute.
- [x] 8.3 Tooltip carries "{used} / {total} tokens". Do not build the panel's Session Info panel — its cost and category breakdown have no analogue here.
- [x] 8.4 Hide the indicator entirely when capacity is unknown or the selected agent uses no model, rather than showing zero or a wrong figure.
- [x] 8.5 Add `codeVerdict.contextUsage.enabled` (default true); when off, hide the indicator and keep the budgets applying.
- [x] 8.6 Test the three states (normal, warning, error), the hidden states, and that the budgets still cut when the indicator is disabled.

## 9. Thinking effort (design D6, D7)

- [x] 9.1 Add `EFFORT_LEVELS` — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` with labels None, Minimal, Low, Medium, High, Extra High, Max — each with the one-line description and the prompt contribution from design.md's D6 table.
- [x] 9.2 Append the effort instruction to the prompt for every level except `none`, which contributes nothing at all — this is what keeps the default path byte-identical (task 1.5).
- [x] 9.3 Render the control as the panel does: a second segment on the model picker showing the current level as plain text, tooltip "Configure Model". No ">" chevron and no "·" separator — both appear only in the docs, not in the product.
- [x] 9.4 Dropdown as a radio group — one active row with a check, the default row annotated "Default", each row showing its description.
- [x] 9.5 Add the line stating the level is applied as review instructions, not as the model's own reasoning configuration (spec: The control states what it actually does).
- [x] 9.6 Persist per model id on the pod as `Record<modelId, EffortLevel>`. Restoring filters against the seven known values and falls back to the default without showing an error.
- [x] 9.7 Hide the control — `display:none`, not disabled — when the demo agent is selected or no model is available. Hiding must not clear the stored value.
- [x] 9.8 Disclose a level change made while findings from an earlier run are in hand: the next run will not be comparable.
- [x] 9.9 Record the level on the stored `Review` and show it in the review header.
- [x] 9.10 Test: per-model isolation (setting one model's level leaves another's untouched); an invalid stored value falls back silently; hidden-then-shown restores; `none` adds nothing to the prompt.

## 10. Changeset parity and follow-ups

- [x] 10.1 Give `src/ui/changesetReview.ts` the same context area and attachments; label each attachment with the member identifiers the changeset prompt already uses, so a finding against one names its member repository.
- [x] 10.2 Apply the selected effort level to `runLmChangesetAgent` and to the follow-up question path.
- [x] 10.3 Test the changeset attachment labelling and that a changeset finding against an attachment identifies its member.

## 11. Settings and docs

- [x] 11.1 Add to `package.json`: `codeVerdict.context.sectionBudget`, `.totalBudget`, `.maxLinkedItems`, `.includeTitle`, `.includeDescription`, `.includeLinkedItems`, and `codeVerdict.contextUsage.enabled`. One toggle per auto-derived source, title included — the spec requires a persistent default for each.
- [x] 11.2 Add a "Context" section to `src/ui/settingsHtml.ts` and `src/ui/settings.ts` for the budgets and the per-source defaults, following the existing `ConfigurationTarget` pattern in that file.
- [x] 11.3 Document in `README.md`: what an attachment is, that attached files are reviewable evidence while the change request's own text is not, that a finding outside the diff lands in the summary, and that the effort level is prompt instructions rather than a provider setting.
- [x] 11.4 Update `spec/specs/Code Verdict - naming & commands.md` — the settings list at line 60 and any statement that only the diff is sent.
- [x] 11.5 Run `npm run lint` and the full `vitest` suite.
- [x] 11.6 Manual check against the emulator: no attachments and effort `none` behaves exactly as before; attach a file outside the diff, get a finding on it, accept it, and confirm it lands in the summary and not as an inline comment.

## 12. Confirmed contract remediation

- [x] 12.1 Replace the exact-literal attachment escape with design D3's narrow case-insensitive wrapper-like tag scanner for opening and closing singular/plural forms, including whitespace, attributes, and self-closing variants. Encode only the leading `<`, XML-escape host-generated attribute values separately, and test representative variants plus unchanged Markdown/YAML `---` evidence.
- [x] 12.2 Define one canonical workspace-root-qualified path identity used by context chips, prompts, diff paths, attachment deduplication, manifest entries, finding normalisation, triage, and summaries. Assign stable distinct root labels when multi-root display names collide, preserve changeset member qualification, and test identical relative paths across roots and members.
- [x] 12.3 Generate an immutable evidence manifest from exact post-budget model-visible attachment content. Record actual root-qualified file paths and inclusive positive-integer ranges for files, selections, every included folder child, symbol sources, and problems sources; exclude wrapper and folder pseudo-paths, omitted content, and pasted text without file provenance. Test every attachment kind and truncation boundary.
- [x] 12.4 Validate attachment findings against the host manifest before triage: require an actual manifest path and a positive integer line inside a visible range, and reject imitated manifest records, wrapper pseudo-paths, and non-integer, zero, negative, or out-of-range lines. Keep D4 anchor classification based only on changed-file membership; test that changed-file line drift still reaches the anchor matcher while attachment-only findings route to the summary.
- [x] 12.5 Persist dropped or unreadable attachment warnings with foreground and background run results, name each attachment and reason, and disclose the retained warnings before triage when a completed review is opened. Test foreground navigation, background completion, and retained-review restoration.
- [x] 12.6 Give the demo agent the same post-budget attachment records and provenance contract as model-backed agents. Run its deterministic detector over model-visible attachment lines and test that its attachment findings pass manifest validation and use D4 inline-or-summary routing.
- [x] 12.7 Complete changeset parity: send the latest Extra instructions value on Run, resolve supported `#` references from that value, retain and report unresolved references without changing typed text, and route the Add Context keyboard command to the active changeset panel. Test immediate instruction edits, resolved and unresolved references, deduplication, and stale-panel command routing.
- [x] 12.8 Add generated-script compilation regressions for both single change-request and changeset webview HTML. Extract and compile every generated script with fixtures covering context items, escaped attachment text and paths, resolved and unresolved references, retained warnings, and multi-root labels.
- [x] 12.9 Run `npm run lint` and the full `vitest` suite after tasks 12.1-12.8, then repeat the emulator check for forged wrapper variants, manifest range rejection, changed-file line drift, background warning disclosure, demo attachments, and changeset keyboard/reference parity.
- [x] 12.10 Resolve every accepted anchored finding against its member's current added-line candidates before provider submission. Keep exact lines, repair moved lines, and withhold lost, empty, or missing candidates into a disclosed summary section without changing file-based `ReviewItem.anchored` semantics from task 3.2a.
