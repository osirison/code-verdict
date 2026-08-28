## Why

The Run AI Review screen has one picker, and it conflates two different things. `discoverLmAgents()` turns every Copilot chat model into an "agent" (`lm:<vendor>/<family>`), so choosing "Claude Sonnet 4.5" is the only way to choose a reviewer — there is no way to say *what kind of review* to run, only *which model* runs the one review prompt that is hardcoded in `runLmAgent`. A reviewer who wants a security-focused pass and a craftsmanship pass has to edit `extraInstructions` by hand between runs, and cannot share either pass with the team.

Splitting the picker gives the reviewer both axes: an **agent** that carries the reviewing instructions, and a **model** that executes them. Agents live as prompt files in the repository, so a team commits its review personas the same way it commits lint rules.

## What Changes

- The Run AI Review screen shows two pickers instead of one: **Agent** and **Model**. Both the single change-request review and the changeset review use the same pair.
- An **agent** becomes a prompt file — YAML frontmatter (`name`, `description`, optional `model`) plus a markdown body used as the reviewing instructions. Code Verdict discovers `*.agent.md` files in the opened workspace, starting at `.github/agents/`.
- Settings gain a list of **additional agent locations** — extra directories, workspace-relative or absolute, scanned for the same file format. This lets a reviewer keep personal agents outside the repository.
- An agent supplies **prompt text only**. It never controls the response contract: Code Verdict always appends its own JSON schema, the criteria and the diffs to whatever the agent file says. An agent file that tries to redefine the contract is ignored on that point, and the run still parses.
- The **model** picker lists Copilot chat models discovered through `vscode.lm.selectChatModels()` — the same set the single picker lists today, now labelled as models rather than agents.
- A **built-in default agent** covers the reviewer who has written no agent files. It carries the instructions `runLmAgent` hardcodes today, so an untouched workspace behaves exactly as it does now.
- The demo agent stays available and is unaffected by the model picker — it generates findings from the diff without calling a model. Its stored id is unchanged, so an existing demo pod is not migrated at all.
- **BREAKING** (persistence, not API): `Pod.agentId` and `Review.agentId` today hold a model id. They become an agent id plus a model id. Stored pods are migrated: an existing `lm:<vendor>/<family>` value is read as *default agent + that model*, so no reviewer loses their selection.
- The `codeVerdict.agent` setting is redescribed and joined by `codeVerdict.agentLocations`. No `codeVerdict.model` setting is added — the model is stored per pod.

## Capabilities

### New Capabilities
- `review-agents`: What a review agent is, where agent files are discovered, how an agent and a Copilot model are selected on the Run AI Review screen, how the two combine into a prompt, and how the selection is persisted and migrated.

### Modified Capabilities
<!-- openspec/specs/ is empty — this project has no published specs yet, so
     nothing existing changes at the spec level. -->

## Impact

| Area | Effect |
| --- | --- |
| `src/app/agents.ts` | `AgentDescriptor` gains a prompt body and a third `source` (`workspace` agent files); a separate model descriptor type appears. |
| `src/app/lmAgent.ts` | `discoverLmAgents()` becomes model discovery. `runLmAgent`/`runLmChangesetAgent`/`runFollowUpPrompt` take an agent and a model id instead of one id, and compose the agent body into the prompt ahead of the contract. |
| New agent-discovery module | Reads and parses `*.agent.md` from `.github/agents/` and the configured locations. |
| `src/ui/reviewFlowHtml.ts`, `src/ui/reviewFlow.ts` | Two pickers, two `select*` messages, two fields in `FlowViewState`. The lede "Agents come from your Copilot workspace" no longer holds. |
| `src/ui/changesetReview.ts` | Same screen, same pair of selections. |
| `src/ui/settingsHtml.ts`, `src/ui/settings.ts` | A section for agent locations: list, add, remove. |
| `src/domain/types.ts` | `Pod` and `Review` carry an agent id and a model id. |
| `src/app/storage.ts` | Migration for pods holding a bare `lm:` id. |
| `package.json` | `codeVerdict.agent` redescribed; `codeVerdict.agentLocations` added. |
| `spec/specs/Code Verdict - naming & commands.md` | The `codeVerdict.selectAgent` row and the settings list are both out of date. No new command. |

Not affected: the provider layer, the response contract in `src/domain/agentResponse.ts`, the timeout and trace machinery in `src/app/agentTrace.ts`, and every screen after the run starts.
