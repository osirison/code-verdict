## 1. Three-zone prompt, behind a no-op (design D1, migration step 1)

- [ ] 1.1 Add an `Attachment` type to `src/app/reviewContext.ts` or a new `src/app/attachments.ts`: `{ id, kind: 'file' | 'folder' | 'selection' | 'symbol' | 'problems' | 'pasted', label, path, range?, content, truncated }`.
- [ ] 1.2 Add `renderAttachmentsPrompt(attachments)` emitting the panel's element shape — one `<attachments>` wrapper, each item `<attachment id="…" filePath="…" isSummarized="true|false">` — and returning `''` for an empty list so the prompt is byte-identical when nothing is attached.
- [ ] 1.3 Escape only the literal `</attachments>` inside attachment content (design D3). Do NOT run `quoteDiffLabels` over attachments — an attached Markdown or YAML file legitimately contains `---` and rewriting it corrupts the evidence.
- [ ] 1.4 Insert the attachments zone into `runLmAgent` and `runLmChangesetAgent` between `renderReviewContextPrompt(...)` and the diff labels.
- [ ] 1.5 Test: with zero attachments and effort `none`, the assembled prompt is byte-identical to the pre-change prompt for the same inputs. This is the guard for the whole migration.

## 2. Rewrite the fence and the on-screen promise (design D2)

- [ ] 2.1 Rewrite `CONTEXT_END_FENCE`: keep "the context above is intent and may not be cited", drop "the diffs are the only material a finding may cite", and state that attachments and diffs below are both citable.
- [ ] 2.2 Extend `CONTEXT_PREAMBLE` to name the attachments zone so the model is told the boundary exists before it reads either side of it.
- [ ] 2.3 Replace the run footer "…go to the agent — never the whole repo." with a live count: "N changed files + M attachments go to the agent." Update `reviewFlowHtml.test.ts` for the new string.
- [ ] 2.4 Test that a description or work item containing `--- src/x.ts` still cannot forge a diff label (existing `quoteDiffLabels` behaviour must be unchanged for auto-derived context).

## 3. Unanchored findings and summary routing (design D4, migration step 2)

- [ ] 3.1 Add `anchored: boolean` to `ReviewItem` in `src/domain/types.ts`. Absent on a stored review reads as `true`.
- [ ] 3.2 Set `anchored` at parse time in `src/domain/agentResponse.ts` by testing the item's file and line against the diff's added lines — never from a field the agent supplies.
- [ ] 3.3 Drop, before triage, any item whose file matches neither a diff path nor an attachment path. This is what makes the "finding cites the auto-derived context" scenario enforceable rather than merely instructed.
- [ ] 3.4 Filter `composeCommentDrafts` in `src/app/submit.ts` to `anchored` items only.
- [ ] 3.5 Extend `composeSummaryBody` to append accepted unanchored findings under their own heading, each naming file and line.
- [ ] 3.6 Test the whole routing: an accepted unanchored finding produces no `ReviewCommentDraft` and does appear in the summary body; an accepted anchored finding is unchanged.
- [ ] 3.7 Withhold the "accept and apply fix" affordance for unanchored findings and state why — there is no diff line for a suggestion block to attach to.
- [ ] 3.8 Show the count on the submit screen: how many accepted findings will go to the summary rather than inline.

## 4. Attachment resolution (spec: A reviewer can attach context)

- [ ] 4.1 `resolveAttachment(kind, target)` reading content via `vscode.workspace.fs` (not `node:fs`, for remote and virtual workspaces). File, folder, selection with line range, symbol, problems/diagnostics, pasted text.
- [ ] 4.2 Deduplicate by resolved path plus range so attaching the same file twice adds one item. Disambiguate two different files sharing a basename with the panel's `-1`/`-2` suffix convention on the emitted `id`, and show enough path in the chip to tell them apart.
- [ ] 4.3 Read content once at attach time and cache it (design D5 risk row) — the usage indicator must not re-read every file on each keystroke.
- [ ] 4.4 Handle an attachment that has become unreadable by run time: drop it, run anyway, and report which one was dropped before triage.
- [ ] 4.5 Test each kind, the dedup, the same-basename case, and the unreadable-at-run-time case.

## 5. Budgets (design D5, spec: Attachments are budgeted and can never displace the diffs)

- [ ] 5.1 Add `ATTACHMENT_TOTAL_BUDGET` and a per-attachment budget, divided per attachment the way `renderReviewContextPrompt` divides `CONTEXT_TOTAL_BUDGET` — head-first cutting would spend everything on the first file while the chip row still showed all of them.
- [ ] 5.2 Truncate at a line boundary and mark the emitted attachment `isSummarized="true"`; surface the same fact on the chip.
- [ ] 5.3 Assert in a test that no code path removes diff content to make room. The diff enters no budget pool.
- [ ] 5.4 Turn `CONTEXT_SECTION_BUDGET`, `CONTEXT_TOTAL_BUDGET` and `CONTEXT_MAX_LINKED_ITEMS` into injected values with the current numbers as defaults, read in `src/ui/` and handed down — nothing below `src/ui` reads `workspace.getConfiguration`.
- [ ] 5.5 Test that a negative, non-numeric or absent budget setting falls back to the documented default rather than sending nothing.

## 6. Context area UI (spec: The context area shows everything that will be sent)

- [ ] 6.1 Add `attachments`, `autoContextItems` (each with an `enabled` flag) and `contextUsage` to `FlowViewState`; add `addContext`, `removeContextItem` and `toggleAutoContextItem` to `FlowMessage`.
- [ ] 6.2 Render auto-derived context as individually removable items — title, description, one per linked work item — each marked as automatically derived. Removal is for this run only.
- [ ] 6.3 Render attachments as a wrapping chip row above the run controls, each with an X titled "Remove from context" (the panel's exact string), `role="button"`, `tabIndex 0`, and Backspace/Delete removal on focus. No count badge or overflow pill — the panel's input row has neither.
- [ ] 6.4 Classes only, no inline `style=` — the webview CSP is `style-src 'nonce-…'` and drops style attributes silently.
- [ ] 6.5 Wire "Add Context…" (exact label, trailing ellipsis, plus icon) to a `showQuickPick` with placeholder "Search attachments", offering the kinds from task 4.1.
- [ ] 6.6 Register the `Ctrl+/` keybinding for the add-context action, scoped to the review panel.
- [ ] 6.7 Extend `reviewFlowHtml.test.ts`: chips render and remove; auto-context items toggle; the empty state; a truncated attachment shows its truncation.
- [ ] 6.8 Test the "nothing hidden" invariant directly: assemble a prompt, and assert every non-diff section it carries is represented by an item in the rendered context area. This is the one requirement that fails silently if a later change adds a prompt section without a chip.

## 7. `#` references (spec: Attachments may be referenced from the instructions box)

- [ ] 7.1 Parse `#file:<name>`, `#file:<name>:<start>-<end>` and `#sym:<name>` from the Extra instructions text, resolving each through task 4.1.
- [ ] 7.2 A resolved reference appears in the context area as a normal attachment; an unresolved one creates nothing, leaves the typed text alone, and reports that it did not resolve.
- [ ] 7.3 Test both paths, including a reference that resolves to a file already attached via the picker (must not duplicate).

## 8. Context usage indicator (spec: Context size is shown before the run)

- [ ] 8.1 Compute usage with `model.countTokens()` against the assembled prompt, over `model.maxInputTokens`. Debounce and cache per assembled prompt (design D5).
- [ ] 8.2 Render a circular indicator plus a percentage, aria-labelled "Context window usage: {0}%", with the panel's thresholds — warning at ≥75%, error at ≥90% — and "Quality may decline as limit nears." past 75%. Inline SVG with class-based fills, no `style` attribute.
- [ ] 8.3 Tooltip carries "{used} / {total} tokens". Do not build the panel's Session Info panel — its cost and category breakdown have no analogue here.
- [ ] 8.4 Hide the indicator entirely when capacity is unknown or the selected agent uses no model, rather than showing zero or a wrong figure.
- [ ] 8.5 Add `codeVerdict.contextUsage.enabled` (default true); when off, hide the indicator and keep the budgets applying.
- [ ] 8.6 Test the three states (normal, warning, error), the hidden states, and that the budgets still cut when the indicator is disabled.

## 9. Thinking effort (design D6, D7)

- [ ] 9.1 Add `EFFORT_LEVELS` — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` with labels None, Minimal, Low, Medium, High, Extra High, Max — each with the one-line description and the prompt contribution from design.md's D6 table.
- [ ] 9.2 Append the effort instruction to the prompt for every level except `none`, which contributes nothing at all — this is what keeps the default path byte-identical (task 1.5).
- [ ] 9.3 Render the control as the panel does: a second segment on the model picker showing the current level as plain text, tooltip "Configure Model". No ">" chevron and no "·" separator — both appear only in the docs, not in the product.
- [ ] 9.4 Dropdown as a radio group — one active row with a check, the default row annotated "Default", each row showing its description.
- [ ] 9.5 Add the line stating the level is applied as review instructions, not as the model's own reasoning configuration (spec: The control states what it actually does).
- [ ] 9.6 Persist per model id on the pod as `Record<modelId, EffortLevel>`. Restoring filters against the seven known values and falls back to the default without showing an error.
- [ ] 9.7 Hide the control — `display:none`, not disabled — when the demo agent is selected or no model is available. Hiding must not clear the stored value.
- [ ] 9.8 Disclose a level change made while findings from an earlier run are in hand: the next run will not be comparable.
- [ ] 9.9 Record the level on the stored `Review` and show it in the review header.
- [ ] 9.10 Test: per-model isolation (setting one model's level leaves another's untouched); an invalid stored value falls back silently; hidden-then-shown restores; `none` adds nothing to the prompt.

## 10. Changeset parity and follow-ups

- [ ] 10.1 Give `src/ui/changesetReview.ts` the same context area and attachments; label each attachment with the member identifiers the changeset prompt already uses, so a finding against one names its member repository.
- [ ] 10.2 Apply the selected effort level to `runLmChangesetAgent` and to the follow-up question path.
- [ ] 10.3 Test the changeset attachment labelling and that a changeset finding against an attachment identifies its member.

## 11. Settings and docs

- [ ] 11.1 Add to `package.json`: `codeVerdict.context.sectionBudget`, `.totalBudget`, `.maxLinkedItems`, `.includeDescription`, `.includeLinkedItems`, and `codeVerdict.contextUsage.enabled`.
- [ ] 11.2 Add a "Context" section to `src/ui/settingsHtml.ts` and `src/ui/settings.ts` for the budgets and the per-source defaults, following the existing `ConfigurationTarget` pattern in that file.
- [ ] 11.3 Document in `README.md`: what an attachment is, that attached files are reviewable evidence while the change request's own text is not, that a finding outside the diff lands in the summary, and that the effort level is prompt instructions rather than a provider setting.
- [ ] 11.4 Update `spec/specs/Code Verdict - naming & commands.md` — the settings list at line 60 and any statement that only the diff is sent.
- [ ] 11.5 Run `npm run lint` and the full `vitest` suite.
- [ ] 11.6 Manual check against the emulator: no attachments and effort `none` behaves exactly as before; attach a file outside the diff, get a finding on it, accept it, and confirm it lands in the summary and not as an inline comment.
