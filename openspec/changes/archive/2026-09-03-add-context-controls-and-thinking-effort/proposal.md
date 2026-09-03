## Why

Two gaps on the Run AI Review screen, both of which the GitHub Copilot Chat panel already has a settled answer for.

**Context is invisible and fixed.** What reaches the agent is assembled entirely by `buildReviewContext` — the change request's title, description and linked work items — capped at 4000 characters per section and 12000 overall, with no way for the reviewer to see what was included, drop what is noise, or add what is missing. A reviewer who knows the diff only makes sense against a schema file, a failing test, or a caller two directories away has nowhere to put that knowledge except the free-text "Extra instructions" box, where it arrives as prose rather than as the file.

**Thinking effort is unreachable.** Copilot's panel lets a reviewer spend more reasoning on a hard problem. Code Verdict sends every review at whatever the model does by default, and a reviewer who wants a deeper pass on a security-critical diff has no control at all.

Both are modelled on the Copilot panel because that is where the reviewer already learned these gestures.

## What Changes

### Context

- A **context area** above the run controls, holding everything that will be sent: an **"Add Context…"** button (the panel's own label and its `Ctrl+/` binding), a chip row, and a **context-usage indicator**.
- **Attachments** the reviewer adds: files, folders, a selection, symbols, problems/diagnostics, and pasted text. Each becomes a removable chip, following the panel's interaction set — an X titled "Remove from context", middle-click, and Backspace/Delete on a focused chip. File identities remain workspace-root-qualified in multi-root workspaces.
- **Auto-derived context becomes visible and controllable.** Title, description and each linked work item render as chips of their own, each individually removable for this run. What was implicit is now shown.
- **`#` references** in the Extra instructions box — `#file:<name>`, `#file:<name>:<start>-<end>`, `#sym:<name>` — resolving to the same attachments as the picker, matching the panel's syntax.
- **BREAKING (prompt contract):** attached files are **reviewable evidence**, not intent. Today `CONTEXT_END_FENCE` states "the diffs are the only material a finding may cite" and the screen promises "never the whole repo". Both become false by design: a finding may now cite an attached file. Attachments therefore move out of the CONTEXT fence into a new reviewable section, and the fence's wording changes to match. A host-generated manifest limits accepted citations to actual model-visible file paths and positive-integer line ranges; wrapper labels alone are not evidence.
- **Findings outside the diff route to the summary.** `ReviewCommentDraft` requires a `DiffAnchor` and no unanchored-comment path exists, so an accepted finding against an attached file that the diff does not touch is collected into the summary body rather than posted inline. The reviewer is told this before submitting.
- **Attachment failures remain visible.** Dropped or unreadable attachment warnings are persisted with the run and disclosed before triage, including after a background completion.
- **Context behavior is universal.** The demo agent deterministically inspects visible attachments, and changeset reviews use the latest instructions on Run with the same `#` resolution, unresolved-reference reporting, and Add Context keyboard routing as single change-request reviews.
- The three budgets (`CONTEXT_SECTION_BUDGET`, `CONTEXT_TOTAL_BUDGET`, `CONTEXT_MAX_LINKED_ITEMS`) become settings, and attachments get a budget of their own so they can never crowd out the diffs.

### Thinking effort

- A **"Thinking Effort"** control on the model picker, built as the panel builds it: a two-segment split control whose second segment shows the current level as plain text and is **hidden, not disabled**, when the level does not apply.
- The panel's exact seven levels — `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, labelled None, Minimal, Low, Medium, High, Extra High, Max — as a radio group with the default row annotated "Default".
- Persisted **per model id**, so switching models hides the control without losing the other model's level.
- **Implemented as prompt instructions, not a provider parameter, and labelled as such on screen.** Copilot's `vscode.lm` bridge forwards exactly five `modelOptions` keys (`stop`, `temperature`, `max_tokens`, `frequency_penalty`, `presence_penalty`) and reads `reasoningEffort` only from VS Code's own per-model configuration — never from a third-party extension's request. `LanguageModelThinkingPart` remains proposed API. A published extension therefore cannot set reasoning effort on a Copilot model or render its thinking; see design.md — Context.

## Capabilities

### New Capabilities
- `review-context-controls`: What context reaches every review agent and surface, how a reviewer inspects, adds to and removes from it, the budget and provenance policy for attachment evidence, and where a finding against that evidence is posted.
- `review-thinking-effort`: The effort levels a reviewer may choose, how the choice is presented and persisted, and what it is honestly claimed to do given that it cannot be sent as a provider parameter.

### Modified Capabilities
<!-- `openspec/specs/` is empty: `add-agent-and-model-pickers` (PR #53) is
     proposed but neither merged nor archived, so `review-agents` is not yet a
     published spec and cannot be modified here. This change is written to sit
     on top of it, not to contradict it. -->

## Impact

**Ordering.** Implement after `add-agent-and-model-pickers`. The Thinking Effort control attaches to the model picker that change introduces, and both edit `FlowViewState` and `renderRunReview`.

| Area | Effect |
| --- | --- |
| `src/app/reviewContext.ts` | `ReviewContext` gains attachments and per-source enable flags. The three budget constants become injected values. `CONTEXT_PREAMBLE` and `CONTEXT_END_FENCE` are rewritten: attachments are reviewable, so the fence can no longer say diffs are the only citable material. |
| New attachment module | Resolves a picker choice or a `#` reference into content, applies the per-attachment budget, emits root-qualified model-visible evidence ranges, and reports truncation or dropped content. |
| `src/app/lmAgent.ts` | The prompt gains a reviewable `<attachments>` section between the context fence and the diffs, and an effort-instruction line. `runLmChangesetAgent` takes attachments per member. |
| `src/app/demoAgent.ts` | The deterministic agent inspects the same model-visible attachment content and uses the same provenance and routing contract. |
| `src/ui/reviewFlowHtml.ts` | Context area: chips, "Add Context…", usage indicator. Model picker gains the second segment. Generated scripts gain a compilation regression gate. |
| `src/ui/reviewFlow.ts`, `src/ui/changesetReview.ts` | Attachment state, persisted warnings, active-panel keyboard routing, latest-instruction `#` resolution, and effort persistence. |
| `src/domain/agentResponse.ts` | An item may cite a host-manifested file range outside the diff; parsing validates it before changed-file anchor classification. |
| `src/app/submit.ts` | Accepted findings with no diff anchor are folded into the summary body instead of becoming `ReviewCommentDraft`s. |
| `src/domain/types.ts` | `ReviewItem` records whether its file is in the diff; `Review` records the effort level that produced it; `Pod` records effort per model id. |
| `package.json` | Budget settings, `codeVerdict.context.*` toggles, `codeVerdict.contextUsage.enabled`. |

Not affected: the provider layer and `submitReview` itself (the summary is an existing channel), the timeout and trace machinery, and every screen after triage.
