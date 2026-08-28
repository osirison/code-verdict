## Context

See proposal.md — Why. The constraints that shape the approach:

- **`vscode.lm` exposes chat models only.** `@types/vscode` is pinned at `~1.96.0` (`engines.vscode: ^1.96.0`). Its `lm` namespace has `selectChatModels`, `onDidChangeChatModels`, `registerTool`, `tools`, `invokeTool`. There is no public API to enumerate or invoke a Copilot custom agent and capture its output. So "run the user's own agent" is only implementable as *the agent definition supplies instructions; a chat model executes them* — which is the execution model chosen for this change.
- **`onDidChangeChatModels` exists**, so the model list can be kept live without polling.
- **Nothing below `src/ui` reads `workspace.getConfiguration`.** `src/ui/agentRunOptions.ts` states this rule and `src/ui/changesetOptions.ts` is the precedent: the UI layer reads the setting and hands plain values down. Agent locations must follow it.
- **Zero runtime dependencies.** `dependencies` is `@vscode/codicons` alone. Adding a YAML parser for frontmatter would be the first real one.
- **Webview CSP is `style-src 'nonce-…'`** (`src/ui/theme.ts:484`). An inline `style="…"` attribute is dropped silently. New picker markup must use classes, not inline styles.
- **Two callers share the screen.** `src/ui/reviewFlow.ts` (single change request) and `src/ui/changesetReview.ts` (changeset) each hold their own `agents`/`agentId` and both render through `src/ui/reviewFlowHtml.ts`. Whatever shape the selection takes has to land in both.
- **`Pod.agentId` is the persisted field.** `codeVerdict.agent` is declared in `package.json` but read nowhere in `src/`; the live value is `Pod.agentId` (`src/domain/types.ts:57`), mirrored onto `Review.agentId` (`:102`).

## Goals / Non-Goals

**Goals:**

- One discovery module and one selection shape, consumed identically by the two review surfaces.
- Prompt composition where the system's contract is structurally impossible for an agent body to displace.
- Migration that costs an existing reviewer nothing — no prompt, no reconfiguration, no lost selection.
- Discovery failures that degrade to "fewer agents", never to "screen will not open".

**Non-Goals:**

- Executing Copilot custom agents through any Copilot API. Not available; see Context.
- Any transport other than `vscode.lm` — no shelling out, no HTTP endpoints, no secrets for agents.
- Editing agent definitions inside Code Verdict. Agents are files; the editor edits files.
- Per-agent criteria. Criteria stay per pod, as they are today.
- Recursive directory walking, glob patterns, or agent inheritance.

## Decisions

### D1 — Agent identity: `agent:<origin>/<name>`, model identity keeps `lm:<vendor>/<family>`

Two namespaces, so a stored value is self-describing and migration is a prefix test.

- Agents: `agent:builtin/default`, `agent:workspace/<folder-name>/<relative-path>`, `agent:location/<slugified-location-path>/<relative-path>`. Path rather than declared name, because two files may declare the same `name` and the spec requires them to stay distinct entries. The location's own path, not its index in the setting, so reordering or removing an entry does not silently re-id every agent under it.
- The demo agent keeps its stored literal `verdict.demo-agent` (`src/app/demoAgent.ts:17`). It is the one id that predates this scheme and is already persisted in pods; re-iding it would strand every demo pod for the sake of consistency nobody reads.
- Models: unchanged `lm:<vendor>/<family>`, so `AgentTrace`'s vendor/family split and every existing trace line keep working untouched.

*Alternative rejected:* one flat id space with a discriminator field. It makes the migration test a field lookup on data that does not have the field yet.

### D2 — Prompt composition is a fixed template with one substitution slot

`runLmAgent` today builds an array and joins it. It keeps doing exactly that; the agent body becomes element zero, and the contract, criteria and diffs are built by the same code as today from the same inputs.

```
[ agent.instructions,            ← the only agent-controlled element
  'Respond with a single JSON object matching this contract: …',
  'Criteria: severity floor …',
  criteria.extraInstructions,
  renderReviewContextPrompt(…),
  ...diffs ].join('\n\n')
```

The agent supplies a string that is concatenated ahead of the rest. It is never interpolated into the contract line, never parsed for directives, and never consulted about what follows it. `runFollowUpPrompt` composes the same way — instructions, then the prebuilt follow-up prompt — which is what makes a follow-up answer keep the persona that produced the finding. The spec's "byte-identical" scenario is then a test that composes the same run twice — once with the built-in agent, once with a workspace agent — and asserts the two prompts agree from the contract line onward.

*Alternative rejected:* a `system` message via `LanguageModelChatMessage`. `vscode.lm` at 1.96 routes what an extension sends as user turns; keeping one message keeps the trace one block and the failure modes identical to today.

The built-in default agent's instructions are the string `runLmAgent` hardcodes today — `'You are a code review agent. Review ONLY the diffs below.'` — moved into a constant. That is what makes "an untouched workspace behaves as before" a mechanical fact rather than a claim.

### D3 — Frontmatter parsing is hand-rolled, flat, and strict

The agent file format:

```markdown
---
name: Security Reviewer
description: Reads for injection, authz and secret handling.
model: copilot/gpt-5        # optional
---

<instruction body — everything after the closing fence>
```

Parse rule: the file must open with `---`, the block ends at the next line that is exactly `---`, and each line inside is `key: value` where `value` is the rest of the line, trimmed, with surrounding quotes stripped. No nesting, no lists, no anchors, no multi-line scalars. `name` and `description` are required; a non-empty body is required; unknown keys are ignored.

*Alternative rejected:* `js-yaml`. It would be this project's first non-codicon runtime dependency, and full YAML on files that arrive from a repository is more surface than a four-field header needs. The strict subset also makes "malformed" a precise, testable condition rather than a parser's judgment.

`tools:` in a `.github/agents/*.agent.md` file (as in this repo's own `.github/agents/openspec.agent.md`) falls under "unknown keys are ignored" — Code Verdict grants no tools, and D2 means the body cannot grant itself any.

### D4 — Discovery lives in `src/app/`, settings are read in `src/ui/`

New `src/app/agentDefinitions.ts` exports `discoverAgents(roots: AgentSearchRoot[]): Promise<AgentDiscovery>`, where `AgentSearchRoot` is `{ id, label, fsPath }` — plain data, no `vscode` config access. It returns both the parsed agents and the skipped ones (`{ fsPath, reason }`), because the spec requires the skip count to be reportable.

New `src/ui/agentLocations.ts` — modelled on `agentRunOptions.ts` — reads `codeVerdict.agentLocations`, resolves workspace-relative entries against each workspace folder, prepends every folder's `.github/agents`, and hands the resulting roots down. This is the only file that knows the setting exists.

Directory reads use `vscode.workspace.fs`, not `node:fs`, so remote and virtual workspaces work.

### D5 — Live updates: one watcher, one event, one re-render

- `vscode.workspace.createFileSystemWatcher` over `**/*.agent.md` for workspace roots; configured absolute locations get a watcher on their own pattern. Create/change/delete each trigger re-discovery.
- `vscode.lm.onDidChangeChatModels` triggers model re-discovery.
- `vscode.workspace.onDidChangeConfiguration` filtered to `codeVerdict.agentLocations` triggers both root recomputation and re-discovery.

All three funnel into one `refreshAgents()` on the panel that re-runs discovery, reconciles the selection (D6) and re-renders. Watchers are disposed with the panel.

*Trade-off:* a watcher per configured location is a handle per location. The setting is a short human-maintained list, so the count stays small; if it ever does not, the fix is a debounce, not a different mechanism.

### D6 — Selection reconciliation is one function, run after every discovery

```
reconcile(persisted, discovered) → { agentId, modelId, notices[] }
```

Rules, in order: an agent id that is not among `discovered.agents` falls back to the built-in default and emits a notice naming what was lost; a model id that is not among `discovered.models` falls back to the first available model and emits a notice; an empty model list leaves the model unset and marks model-backed agents unrunnable. Pure function over plain data, so every fallback scenario in the spec is a unit test with no `vscode` in it.

Notices render as a dismissible line on the Run AI Review screen. They are not `showWarningMessage` toasts: the screen the reviewer is looking at is where the stale selection is.

### D7 — Migration reads forward, writes on next save

`Pod.agentId: string` becomes `Pod.agentId: string` (agent) plus `Pod.modelId?: string`. A reader that finds `agentId` starting with `lm:` and no `modelId` treats it as `{ agent: builtin default, model: that value }`. The literal `verdict.demo-agent` needs no mapping at all — D1 leaves it as the demo agent's id — so a demo pod reads as `{ agent: 'verdict.demo-agent', model: undefined }` by passing straight through.

The rewrite happens on the next natural save — `pod.agentId = …` already runs at run start (`reviewFlow.ts:545`, `changesetReview.ts:258`). No migration pass over stored pods, no version stamp, and a pod that is never opened again is never touched.

`Review.agentId` gains `Review.modelId?`. Stored reviews are read the same way, and the review header shows the model as "unknown" only for a pre-migration demo review, which never had one.

*Alternative rejected:* a versioned storage migration run at activation. It would touch every stored pod at once to change two fields that the forward read already handles for free.

### D8 — `FlowViewState` carries two lists and two ids

`agents`/`agentId`/`agentOpen` are joined by `models`/`modelId`/`modelOpen`; `FlowMessage` gains `selectModel` and `toggleModelOpen` beside the existing `selectAgent`/`toggleAgentOpen`. The existing `.agent-select` markup is duplicated into a second block with the same classes, so the CSS is written once. `AgentDescriptor.source` becomes `'demo' | 'builtin' | 'workspace' | 'location'`; models get their own `ModelDescriptor` rather than reusing `AgentDescriptor`, so `source: 'copilot'` disappears from the agent type entirely and the compiler finds every place that assumed a model was an agent.

The lede "Agents come from your Copilot workspace" is replaced — it is now false in both halves.

Per the CSP note in Context, the two new blocks use classes only. The pre-existing inline `style=` in `catPill` is out of scope here.

## Risks / Trade-offs

| Risk | Mitigation |
| --- | --- |
| An agent body tries to steer the model off the response contract, producing an unparseable run. | D2 puts the contract after the body; the parse failure path already exists and reports `agent response did not match the contract`. The failure is visible and attributable, not silent. |
| A repository ships a hostile `.agent.md` that instructs the model to ignore the diffs and emit fabricated findings. | Findings are a proposal a human triages before anything is posted — the product's whole shape. Discovery is disclosed on screen (the agent's origin is shown), and the built-in default is one click away. Worth stating in docs rather than engineering against. |
| The hand-rolled parser rejects a file a reviewer believes is valid YAML. | The skipped-definitions report names the file and the reason. The accepted subset is documented next to the setting. |
| Two pickers where there was one crowds the screen. | The model picker collapses to a single line when only one model is available, and is neutralised entirely for the demo agent. |
| A watcher per configured location. | Small list by construction; debounce if it grows. |
| `Pod.modelId` is optional forever, so every reader must handle its absence. | Reads go through one accessor that applies D7's forward read, so absence is handled in one place rather than at each call site. |

## Migration Plan

1. Ship the forward read (D7) and the built-in default agent (D2) together. At this point a reviewer who has never seen an agent file gets byte-identical prompts and their existing model selection, restored under a new name.
2. Ship discovery, the second picker and the settings section. Agent files that do not exist yet cost nothing.
3. No rollback step is needed for storage: a pod written by the new code (`agentId: 'agent:…'`, `modelId: 'lm:…'`) read by the old code fails the old code's own guard — `this.agents.some((a) => a.id === pod.agentId)` (`reviewFlow.ts:393`) — and falls back to the demo agent. The reviewer reselects a model; nothing is corrupted.
4. `codeVerdict.agent` stays declared, redescribed as the agent id, and stays unread by `src/` as it is today. Removing it is a separate decision from this change. No matching `codeVerdict.model` is added: the model lives in `Pod.modelId`, and a second declared-but-unread key would deliberately reproduce the wart.
