## Context

See proposal.md — Why. Three bodies of fact shape this design: what the Copilot panel actually does, what the VS Code API actually permits, and what this codebase already guarantees.

### What the Copilot panel does (verified against source, not recall)

`microsoft/vscode-copilot-chat` was archived on 2026-05-20 (HEAD `5863f5a`, "Add archive notice"); the extension now lives in `microsoft/vscode` at `extensions/copilot/`, and the panel UI has always lived at `src/vs/workbench/contrib/chat/`. Everything below was read there at commit `d6f8eda` and re-checked by a second pass.

**Context attachment.** The action is `workbench.action.chat.attachContext`, titled **"Add Context…"**, icon `Codicon.addCompact` — a plus, not a paperclip — bound to `Ctrl+/` in the chat input and placed first in the input toolbar (`MenuId.ChatInput`, group `navigation`, `order: -1`). It opens a Quick Pick with placeholder **"Search attachments"**, layered over the Anything/Symbols Quick Access providers so typing filters real files and symbols, with registered kinds injected alongside. Kinds are contributed by feature areas, sorted by `ordinal` highest-first with alphabetical ties, and each self-filters via `isEnabled(widget)` — "Image from Clipboard" appears only when the clipboard holds an image and the model has vision. Chat core registers six ("Tools…", "Instructions…", "Open Editors", "Image from Clipboard", "Screenshot Window", "Sessions…"); search adds "Search Results", "Symbols…", "Files & Folders…"; other areas add "Problems…", "Source Control…", "MCP Resources…", "Debug Session…", "Kernel Variable…".

An attached item renders as a chip (`.chat-attached-context-attachment.show-file-icons`, `role="button"`, `tabIndex 0`) in a wrapping row above the input, with an X titled **"Remove from context"**; middle-click and Backspace/Delete also remove. There is no count badge and no "N more" overflow in the input row. Implicit context gets its own chip with a leading toggle and a dashed border when disabled, governed by `chat.implicitContext.enabled` / `.suggestedContext` / `.includeActiveEditor`. Typed references use `#` — `#file:<basename>`, `#file:<basename>:<start>-<end>` for a selection, `#sym:<name>` — and tools are referenced by bare name with no namespace. Drag-and-drop shows "Attach {type} as Context"; pasting long text makes a chip named "Pasted text #{N}".

Size is surfaced by a `.chat-context-usage-widget`: a circular pie plus a percentage, aria "Context window usage: {0}%", **warning at ≥75% and error at ≥90%**, controlled by `chat.contextUsage.enabled` (default true). Clicking it opens a "Session Info" panel with "{used} / {total} tokens", a "Reserved for response" legend, a category breakdown, and "Quality may decline as limit nears." past 75%. Per-attachment truncation is disclosed as "Part of this file was not sent to the model due to context window limitations…". On the prompt side, attachments are wrapped in one `<attachments>` element, each an `<attachment id=… isSummarized="true" filePath=…>`, with duplicate names disambiguated by `-1`, `-2` suffixes.

**Thinking effort.** The control is titled **"Thinking Effort"**. Values are `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, labelled None, Minimal, Low, Medium, High, **Extra High**, Max, each with a one-line description shown on hover. It renders as a split control — `div.action-label.model-picker-split` containing `a.model-picker-name` then `a.model-picker-config`, the second segment tooltipped **"Configure Model"** and **hidden via `display:none`, not disabled**, when the model exposes no configurable property. Items are a radio group (`role="menuitemradio"`, check icon on the active row, the schema default annotated "Default"). Section headers come from the provider's schema title, with "Thinking Effort" and "Context Size" only as fallbacks — which is why the Auto model's header reads "Optimize for" instead. Changing it mid-session raises a dismissible banner: "Changing these options mid-session resets the prompt cache and may increase cost." with an info icon and a "Learn more" link. The choice is stored per model id in application-scoped storage, filtered on restore against the model's current schema so unknown or out-of-enum values are dropped.

Two details a designer would naturally copy are **not in the product**: the docs describe a ">" chevron on the second segment and a "·" separator in the label; neither exists in source — the segment renders the current level as plain text and the two segments are adjacent flex rows. A Copilot model advertising exactly one effort level shows no control at all.

### What the VS Code API permits — the hard constraint

**A published extension cannot set reasoning effort on a Copilot-backed model, and cannot render its thinking.**

- Copilot's `vscode.lm` bridge forwards exactly five `modelOptions` keys upstream: `stop`, `temperature`, `max_tokens`, `frequency_penalty`, `presence_penalty`. It reads `reasoningEffort` from one place only — VS Code's own per-model `modelConfiguration`, the user-supplied side — never from a third-party extension's request.
- `LanguageModelThinkingPart` is proposed API: introduced 2025-08-06, still unfinalized as of 2026-08-28, tracking issue open with no movement since 2025-12-11. A marketplace-published extension cannot enable proposed APIs.
- `LanguageModelChat` at the pinned 1.96 types carries `name, id, vendor, family, version, maxInputTokens`, `sendRequest` and `countTokens`. There is **no capability flag** to gate an effort control on, in stable or proposed API.
- No proposed API adds any member to the consumer-side `LanguageModelChatRequestOptions`. This was checked at both `main` and the shipped stable 1.135, so it is not an artifact of reading an unreleased branch.

Two undocumented paths exist and are deliberately not used: the bridge separately reads four undeclared underscore keys off the raw `modelOptions` object (`_enableThinking` among them), and there is a proposed `languageModelProxy` API exposing a Copilot-backed local HTTP proxy with full request-body control. Both are internals of non-API files with no compatibility promise and no observable error if they disappear. Building a shipped feature on either would be a silent-breakage liability, so the effort level is applied as prompt text instead — which is also the only option that works for BYOK models and is at least coherent for the demo agent.

`maxInputTokens` and `countTokens` **are** public and stable, so the context-usage indicator is fully implementable.

### What this codebase already guarantees

- `reviewContext.ts` caps context three ways (`CONTEXT_SECTION_BUDGET = 4_000`, `CONTEXT_TOTAL_BUDGET = 12_000`, `CONTEXT_MAX_LINKED_ITEMS = 5`), divides the total per entry rather than head-first, and escapes `^-{3,}` in author text so prose cannot forge a `--- path` diff label.
- `CONTEXT_PREAMBLE` declares context "INTENT, NOT GROUND TRUTH"; `CONTEXT_END_FENCE` declares "every line below this one is a diff, and the diffs are the only material a finding may cite". The run footer promises "N files … go to the agent — never the whole repo."
- `ReviewCommentDraft` requires `anchor: DiffAnchor` (`filePath`, `line`, `refs`). **There is no unanchored-comment path.** The summary is the only text posted without a diff position.
- Nothing below `src/ui` reads `workspace.getConfiguration`.
- The webview CSP is `style-src 'nonce-…'`; inline `style=` attributes are dropped silently.

## Goals / Non-Goals

**Goals:**

- Reuse the panel's gestures and vocabulary exactly where they fit, and diverge only where this product differs — deliberately, and noted.
- Make the prompt's intent/evidence boundary structural, so no author-written or attached text can cross it.
- Keep the diffs uncuttable: attachments compete with each other for room, never with the diff.
- Give the effort control a truthful description of its own mechanism.

**Non-Goals:**

- Images, screenshots, notebook kernel variables, MCP resources, debug sessions, terminal output, or web-page fetching. The panel offers these; a code reviewer needs files, selections, symbols, problems and pasted text.
- Rendering model thinking. Not available (see Context).
- Recursive folder attachment without limit. A folder attaches what fits its budget; how it degrades when it does not fit is left open below.
- Reproducing the panel's chip DOM. The gestures are copied; the markup is this project's own.

## Decisions

### D1 — Three prompt zones, in a fixed order, with attachments as their own zone

Today's prompt is `[instructions, contract, criteria, extraInstructions, context, ...diffs]`. Attachments cannot join the context block: the reviewer has declared them evidence, and the context block's whole purpose is to say "not evidence". So:

```
agent instructions
response contract
criteria
extra instructions
--- CONTEXT (intent, not code — this section is not reviewable)     ← unchanged role
   title / description / linked work items
--- END OF CONTEXT.                                                  ← wording changes (D2)
<attachments>                                                        ← NEW zone: reviewable
   <attachment id="…" filePath="…" isSummarized="true|false">
</attachments>
--- <diff labels and diffs>                                          ← unchanged
```

Borrowing the panel's `<attachments>` / `<attachment>` element shape gives an unambiguous, machine-checkable boundary that prose cannot imitate, which matters more here than in the panel because this product's whole safety story is that intent cannot masquerade as evidence.

Rendering the attachments zone also produces a host-owned evidence manifest (D9) from the exact post-budget content. The manifest is kept outside author-controlled content and drives finding validation; wrapper ids and labels are presentation metadata, not evidence paths.

### D2 — The fence wording changes, and so does the footer promise

`CONTEXT_END_FENCE` currently ends "the diffs are the only material a finding may cite." With reviewable attachments that is false. It becomes a statement that the context above is not citable and that the attachments and diffs below are — the *intent/evidence* boundary is preserved; only the *attachments-are-intent* claim is dropped.

The run footer's "never the whole repo" becomes a live count: "N changed files + M attachments go to the agent." The promise was that the extension does not silently upload the repository. That promise survives — the reviewer now chooses each extra file explicitly — but the sentence has to stop claiming that only the diff is sent.

*This is the change's one real risk.* It is being made because the user chose reviewable attachments over reference-only, with that trade-off stated.

### D3 — Escaping extends to attachments, and the section markers move to a form prose cannot produce

`quoteDiffLabels` rewrites `^-{3,}` so a description cannot forge a `--- path` label. An attached file is far likelier than a description to legitimately contain `---` (Markdown, YAML front matter, diffs-in-tests), so escaping every one would corrupt the evidence the reviewer attached.

Instead the boundary moves off the `---` convention for the new zone: attachments are delimited by host-generated `<attachments>` and `<attachment>` elements, and each carries a generated `id`. Before any non-host text enters the prompt, a narrow scanner recognises every wrapper-like opening or closing tag whose name is singular `attachment` or plural `attachments`, case-insensitively, with whitespace, attributes, and self-closing syntax permitted. It encodes only that match's leading `<` as `&lt;` and leaves every remaining character intact. Decoding that one entity reconstructs the source text, while variants such as `<ATTACHMENTS>`, `</ Attachments >`, `<attachment data-kind="source">`, and `</ATTACHMENT   >` cannot become structure.

Host-generated tags are not passed through this content escape. Their attribute values are XML-escaped by the host so a path, id, root label, or summary flag cannot terminate an attribute or add markup. Attachment Markdown horizontal rules and YAML `---` delimiters remain byte-for-byte unchanged. `quoteDiffLabels` continues to apply unchanged to auto-derived context, where the text is prose and can otherwise imitate a diff label.

*Alternative rejected:* matching only the exact lowercase `</attachments>` sequence. It leaves opening tags, singular tags, and harmless syntactic variants able to imitate host structure.

### D4 — Out-of-diff findings route to the summary

`ReviewCommentDraft` needs a `DiffAnchor` and no unanchored path exists. Rather than inventing one (a new provider method, implemented twice, with two more contract tests), an accepted finding whose file is not in the diff is appended to the summary body under its own heading, naming file and line.

Finding validation precedes anchor classification. A finding may proceed only when its host-normalised path is a changed-file path or a D9 manifest path; attachment citations additionally require a positive integer line inside a model-visible manifest range. Wrapper pseudo-paths never pass this gate.

`ReviewItem` gains `anchored: boolean` — set after validation by testing whether the finding's **workspace-root-qualified file** is among the diff's paths, not asserted by the agent. **File, not file-and-line.** A finding on a diff file whose line has drifted off an added line is exactly what `src/domain/anchor.ts` exists to repair (exact / moved / lost); testing the line here would mark it unanchored and silently reroute to the summary a finding that today posts inline after re-anchoring. Line placement stays entirely with the existing anchor matcher, untouched by this classification. A manifest-valid finding whose file is not changed is attachment-only and unanchored regardless of its line. `composeCommentDrafts` filters to `anchored` items; `composeSummaryBody` gains the rest. Triage marks unanchored findings, and the "apply fix" affordance is withheld for them because a suggestion block has no line to attach to.

Provider-bound draft composition repeats the anchor match against the current diff's added-line candidates. An exact match keeps the reported line; a moved match uses the resolved line; a lost match, empty candidate set, missing changed file, or empty code emits no inline draft. The accepted finding is instead named in the summary as withheld because it no longer has a current inline anchor. This submission check does not redefine or mutate `ReviewItem.anchored`; it proves only that the provider position is valid at the point of submission. Changeset members supply candidates from their own current diff so identical paths in separate repositories cannot cross-resolve.

*Alternative rejected:* posting them as inline comments anchored to the diff's first line. It puts a comment about `schema.sql` on an unrelated line of `auth.ts`, which is worse than a summary entry.

### D5 — Attachments get their own budget, and the diff is never in the pool

`CONTEXT_TOTAL_BUDGET` stays governing auto-derived context alone. A separate `ATTACHMENT_TOTAL_BUDGET` governs attachments, divided per attachment exactly as `renderReviewContextPrompt` divides its total — the same reason applies: cutting a concatenation head-first spends everything on the first file and leaves the rest with nothing while the screen still shows chips for all of them.

The diff enters no budget. If the assembled prompt exceeds `model.maxInputTokens`, attachments shrink; if that is not enough, the run proceeds and the usage indicator shows the overflow. Truncating the diff would silently invalidate the run's central promise, so it is never done.

Budgets stay character-based (as today) for truncation, while the *indicator* uses `model.countTokens()` for the real figure. Two units, deliberately: characters are cheap and synchronous, which is what a cut needs; tokens are accurate and async, which is what a gauge needs.

### D6 — Effort is a prompt suffix chosen from a table, and the UI says so

Per the constraint, the level maps to instruction text:

| level | label | prompt contribution |
| --- | --- | --- |
| `none` | None | *(nothing added)* |
| `minimal` | Minimal | answer directly; do not deliberate |
| `low` | Low | brief check before answering |
| `medium` | Medium | reason through the diff before reporting |
| `high` | High | reason carefully; consider alternatives before reporting |
| `xhigh` | Extra High | exhaustive reasoning; enumerate and discard alternatives |
| `max` | Max | no reasoning budget; take as long as needed |

`none` adding literally nothing is what makes the default path byte-identical to today's prompt — the same property `add-agent-and-model-pickers` relies on for its built-in agent, and testable the same way.

The control carries a line stating the level is applied as review instructions. Copying the panel's control shape while quietly not doing what the panel's control does would be the one genuinely dishonest option available here.

### D7 — Effort persists per model id, as the panel does

Stored as `Record<modelId, EffortLevel>` on the pod. Restoring filters against the seven known values and falls back to the default — the panel's own "filtered against the model's current schema" behaviour, which matters for the same reason: a stored value that no longer means anything must not surface as a broken control.

The control is hidden, not disabled, when the selected agent is the demo agent or no model is available — the panel's `display:none` treatment. Hiding does not clear the stored value. The demo agent's lack of model effort does not exempt it from the context contract; D11 gives it deterministic attachment inspection.

### D8 — Copy the gestures, not the chrome

Adopted verbatim because the reviewer already knows them: the label "Add Context…" with its ellipsis, `Ctrl+/`, the plus icon, the "Search attachments" placeholder, the X titled "Remove from context", Backspace/Delete on a focused chip, the wrapping chip row above the controls, the `#file:`/`#sym:` syntax, the 75%/90% warning thresholds, the levels and their labels including "Extra High", the split control with the second segment hidden when inapplicable, and the "Default" annotation.

Deliberately not adopted: the ">" chevron and "·" separator (they do not exist in the product — only in its docs); the `ordinal` registry (this product has a fixed list, not contributed kinds); the Session Info panel (its cost and category breakdown have no analogue here) — the indicator's tooltip carries "{used} / {total} tokens" instead.

Per the CSP note in Context, chips and the indicator use classes only. The usage pie is an inline SVG with class-based fills, not a `style` attribute.

### D9 — A post-budget manifest is the source of attachment evidence provenance

Attachment rendering returns both prompt text and an immutable manifest. Each manifest entry contains a host-generated workspace-root identity, an actual model-visible file path, and one or more inclusive positive-integer line ranges. Entries describe the exact content that survived budgeting:

- A file contributes the visible source-line range after truncation.
- A selection contributes only its selected source-line range.
- A folder contributes one entry per child whose content is actually sent; the folder wrapper contributes none.
- A symbol contributes the source file and range represented to the agent.
- Problems contribute the source file and range represented for each included diagnostic.
- Pasted text contributes no file provenance and cannot make a file location valid by imitating a path or manifest record.

The parser normalises a reported identity through the same root-qualified path service, requires an integer line greater than zero, and tests membership in a visible range. The manifest object is never parsed back out of prompt text, so attachment content cannot expand it. A wrapper id, folder label, changeset member label, or other pseudo-path is insufficient without an actual file entry.

*Alternative rejected:* accepting any path found in an attachment wrapper. Folder and problems wrappers can represent several files, and truncation can remove lines the wrapper originally covered.

### D10 — Path identity includes a unique workspace-root qualification

The host assigns each workspace folder a stable root label for the run, disambiguating duplicate display names when necessary. The canonical evidence identity is the tuple `(rootLabel, workspaceRelativePath)`, rendered in a single unambiguous form everywhere a reviewer or agent sees it. Context chips, prompt file paths, diff paths, attachment deduplication, manifest entries, finding normalisation, triage labels, and summary output all use that identity.

Changeset member identity remains an additional outer qualification rather than a replacement for workspace-root identity. This keeps two members or two workspace roots with the same relative path distinct through parse and submission.

*Alternative rejected:* qualifying only duplicate basenames in the chip label. That fixes display ambiguity but leaves prompt validation, deduplication, and stored findings able to collapse separate files.

### D11 — Context behavior is shared by foreground, background, demo, and changeset runs

Dropped or unreadable attachment warnings are values on the retained run result, not transient notifications. Foreground navigation shows them before triage. Background completion stores the same values and surfaces them when the reviewer opens the completed review, before triage begins.

The demo agent receives the same post-budget attachment records and manifest as a model-backed agent. It runs its deterministic finding detector over every model-visible attachment line and emits root-qualified file and line locations through the same manifest-validation and D4 routing path. The UI therefore never advertises an attachment to an agent that ignores it.

On a changeset surface, Run carries the instructions value currently in the webview rather than a value cached when HTML was rendered. The extension host resolves supported `#` references from that latest value, returns unresolved-reference reporting without deleting typed text, and updates the context representation for the run. The `Ctrl+/` command resolves the active panel identity at invocation time and routes Add Context to that changeset panel, preventing stale-panel dispatch.

### D12 — Generated webview scripts have a compilation gate

HTML regression tests extract every generated webview script and compile it with a JavaScript parser or runtime constructor without executing DOM behavior. Fixtures cover single change-request and changeset surfaces with auto-context items, attachment text and paths requiring escaping, resolved and unresolved references, retained warnings, and multi-root labels. Behavioral webview tests remain separate; this gate catches malformed interpolation and generated syntax before runtime.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| Reviewable attachments weaken the "only the diff is reviewed" guarantee that makes findings trustworthy. | The user chose this explicitly over reference-only. D3 enforces the boundary by parse-time validation rather than instruction, and D2 changes the on-screen promise rather than leaving a false one. |
| An attached file lets the agent report findings the reviewer never asked for, inflating the triage queue. | Attachments are opt-in per run and each is one gesture to remove. The triage screen marks out-of-diff findings so they can be swept. |
| Out-of-diff findings landing in the summary is a worse experience than an inline comment. | It is the only honest option the provider contract allows (D4), and the submit screen states the count before submitting so it is never a surprise. |
| The effort control looks like Copilot's but does something different. | D6 labels it. The alternative — an unlabelled lookalike — is worse, and the alternative of omitting it entirely was offered and declined. |
| Prompt-level effort may do very little on some models. | True and unavoidable; it is the only mechanism available. Recording the level on the stored review lets a reviewer judge for themselves whether it changed anything. |
| Character budgets and token counting disagree, so the indicator can read under capacity while a cut has occurred. | Two units for two jobs (D5). The chip states truncation independently of the gauge, so the reviewer is never relying on the gauge to learn a file was cut. |
| Reading attached files on every keystroke of the usage indicator is expensive. | Content is read once at attach time and cached; `countTokens` is debounced and its result cached per assembled prompt. |

## Migration Plan

1. Land the three-zone prompt (D1) with an empty attachment list. No behaviour changes: `none` effort adds nothing and zero attachments emit no `<attachments>` element, so prompts stay byte-identical. This isolates the riskiest edit behind a no-op.
2. Land `ReviewItem.anchored` and the summary routing (D4). With `anchored` file-based and task 3.3 dropping findings whose file is neither a diff path nor an attachment, nothing can yet produce an unanchored finding — every file the agent can legitimately cite is a diff path until attachments land in step 3. So the path is tested before it is reachable.
3. Land attachments, the context area and the indicator.
4. Land the effort control.
5. Stored reviews from before this change have no `anchored` field; absent reads as `true`, which is correct — every finding they hold came from a diff.
6. No rollback concern for stored pods: the effort map is additive and an older build ignores an unknown field.

## Open Questions

- Whether a folder attachment should send file contents or only a file listing when the folder exceeds the budget. Both satisfy the spec's budget scenarios; the listing is cheaper and the contents are more useful. Deferrable — it changes one branch inside the attachment resolver and no requirement, no task boundary and no other decision depends on which way it goes.
