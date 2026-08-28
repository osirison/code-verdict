## 1. Split the types: an agent is not a model

- [ ] 1.1 In `src/app/agents.ts`, redefine `AgentDescriptor` as `{ id, label, description, source: 'demo' | 'builtin' | 'workspace' | 'location', instructions: string, preferredModelId?: string, origin?: string }`. Add `ModelDescriptor` as `{ id, label, description, vendor, family }`. Remove `source: 'copilot'` from the agent type so the compiler flags every place that treated a model as an agent.
- [ ] 1.2 Add `BUILTIN_AGENT_DESCRIPTOR` (id `agent:builtin/default`) whose `instructions` is the string `runLmAgent` hardcodes today — `'You are a code review agent. Review ONLY the diffs below.'` — lifted out of `src/app/lmAgent.ts` into a named constant.
- [ ] 1.3 Leave `DEMO_AGENT_ID` at its stored literal `verdict.demo-agent` (`src/app/demoAgent.ts:17`). Re-iding it would strand every pod that already holds that value; give it `source: 'demo'` and empty `instructions` instead.
- [ ] 1.4 In `src/domain/types.ts`, add `modelId?: string` to `Pod` and to `Review`, and document on `Pod.agentId` that a value starting with `lm:` is a pre-migration model id.

## 2. Forward read and migration (design D7)

- [ ] 2.1 Add a `selectionFromPod(pod)` accessor returning `{ agentId, modelId }`: `agentId` starting with `lm:` and no `modelId` reads as `{ agent: builtin, model: that value }`; the literal `verdict.demo-agent` reads as `{ agent: 'verdict.demo-agent', model: undefined }` and is left alone; anything else passes through. Every read of `pod.agentId` goes through it.
- [ ] 2.2 Unit-test the accessor against three stored shapes: a pre-migration `lm:vendor/family` pod, a pre-migration demo pod holding the literal `verdict.demo-agent` (assert it still selects the demo agent and raises no notice), and a post-migration pod. Assert no stored pod is mutated by reading.
- [ ] 2.3 Write `pod.agentId` and `pod.modelId` at run start in `src/ui/reviewFlow.ts:545` and `src/ui/changesetReview.ts:258` — the existing save point, no separate migration pass.

## 3. Model discovery (spec: Models are selected separately from agents)

- [ ] 3.1 Rename `discoverLmAgents()` in `src/app/lmAgent.ts` to `discoverModels()` returning `ModelDescriptor[]`, keeping the `lm:<vendor>/<family>` id format so `AgentTrace`'s vendor/family split is untouched. Keep the existing catch that returns `[]` when Copilot is absent.
- [ ] 3.2 Update the two call sites (`src/ui/reviewFlow.ts:389`, `src/ui/changesetReview.ts:187`) to load models into a new `models` field instead of merging them into `agents`.
- [ ] 3.3 Test: no Copilot in session → empty model list, no throw, screen still renders.

## 4. Prompt composition (design D2, spec: An agent never controls the response contract)

- [ ] 4.1 Change `runLmAgent`, `runLmChangesetAgent` and `runFollowUpPrompt` in `src/app/lmAgent.ts` to take `(agent: AgentDescriptor, modelId: string, …)` in place of a single `agentId`. `streamText` selects the model from `modelId`; the agent is never consulted about transport. `runFollowUpPrompt` prepends `agent.instructions` to the prompt it is handed, so the follow-up keeps the persona that produced the finding.
- [ ] 4.2 Put `agent.instructions` as element zero of the existing joined array, ahead of the contract line, criteria, review context and diffs. Leave every other element built exactly as it is today.
- [ ] 4.3 Test the spec's byte-identical scenario: compose the same run with the built-in agent and with a workspace agent whose body asks for a different output shape; assert the two prompts agree from the contract line onward, and that the second still parses a contract-shaped response.
- [ ] 4.4 Test that a response not matching the contract still fails through the existing `AgentResponseError` path with the same message, whichever agent was selected.

## 5. Agent discovery (spec: Agents are discovered from the workspace, Additional agent locations, Malformed definitions)

- [ ] 5.1 New `src/app/agentDefinitions.ts`: `parseAgentFile(text, id, origin)` implementing design D3's strict flat frontmatter — opens with `---`, closes at the next bare `---`, `key: value` per line, quotes stripped, unknown keys ignored. Require `name`, `description` and a non-empty body; return either a descriptor or a skip reason.
- [ ] 5.2 Unit-test the parser: valid file; missing opening fence; unterminated block; missing `name`; missing `description`; empty body; a `tools:` list present and ignored; a `model:` value carried into `preferredModelId`.
- [ ] 5.3 In the same module, `discoverAgents(roots: AgentSearchRoot[])` reading `*.agent.md` non-recursively from each root via `vscode.workspace.fs`, returning `{ agents, skipped: Array<{ fsPath, reason }> }`. Ids are `agent:<root.id>/<relative-path>`. No `workspace.getConfiguration` in this file.
- [ ] 5.4 Test discovery: a root with two valid and one malformed file yields two agents and one skip; a missing root, a root that is a file, and an unreadable root each yield a skip without failing the others.
- [ ] 5.5 New `src/ui/agentLocations.ts` on the `agentRunOptions.ts` precedent: read `codeVerdict.agentLocations`, resolve workspace-relative entries against each workspace folder, prepend every folder's `.github/agents`, and return `AgentSearchRoot[]`. This is the only file that knows the setting exists.
- [ ] 5.6 Test multi-root: two workspace folders each declaring an agent of the same `name` produce two distinct entries whose origins differ.

## 6. Two pickers on the Run AI Review screen (spec: Models are selected separately, The demo agent is independent)

- [ ] 6.1 In `src/ui/reviewFlowHtml.ts`, add `models`, `modelId`, `modelOpen` and a `selectionNotices: string[]` to `FlowViewState`; add `selectModel` and `toggleModelOpen` to `FlowMessage`.
- [ ] 6.2 Render a second `.agent-select` block for the model beneath the agent block, reusing the existing classes. No inline `style=` attributes — the webview CSP is `style-src 'nonce-…'` (`src/ui/theme.ts:484`) and drops them silently.
- [ ] 6.3 Replace the lede "Agents come from your Copilot workspace" and the menu heading "Copilot agents in this workspace" with text true of both pickers. Show each agent's origin (built-in, workspace folder, or configured location) in its row.
- [ ] 6.4 Render `selectionNotices` as a dismissible line on the screen, not as `showWarningMessage`.
- [ ] 6.5 Demo agent selected → model block renders as not applying to this run and the run starts without a model. No models available → model block states that and the run button is disabled for model-backed agents with that reason shown.
- [ ] 6.6 Extend `src/ui/reviewFlowHtml.test.ts`: both pickers render; the demo-agent neutralised state; the empty-model state; the skipped-definitions report line; origin shown when two agents share a name.

## 7. Wire both review surfaces (spec: Every model-backed surface uses the same pair)

- [ ] 7.1 In `src/ui/reviewFlow.ts`, hold `agents`, `agentId`, `models`, `modelId`; load agents from `discoverAgents(agentSearchRoots())` alongside the existing model load; handle `selectModel`/`toggleModelOpen`; pass agent and model to `runLmAgent`.
- [ ] 7.2 Route the follow-up question path (`reviewFlow.ts:958–971`) through the same pair, passing the selected agent so 4.1 can prepend its instructions ahead of `followUpPrompt(item, question, hunk)`. The `startsWith('lm:')` guard at `:958` becomes a check on the selected model, not the agent. Test that a workspace agent's instructions appear in the follow-up prompt and the built-in agent's do not change today's prompt.
- [ ] 7.3 Do the same in `src/ui/changesetReview.ts` for `runLmChangesetAgent`.
- [ ] 7.4 Record `agentId` and `modelId` on the stored `Review` and show both in the review header; a pre-migration demo review shows the model as unknown.

## 8. Reconciliation and live updates (design D5, D6)

- [ ] 8.1 Pure `reconcile(persisted, discovered)` → `{ agentId, modelId, notices }`: unknown agent falls back to the built-in default with a notice naming it; unknown model falls back to the first available with a notice; empty model list leaves the model unset. No `vscode` import.
- [ ] 8.2 Unit-test each fallback branch, including the deleted-selected-agent and deleted-configured-location cases from the spec.
- [ ] 8.3 One `refreshAgents()` per panel fed by three sources: a `**/*.agent.md` file-system watcher, `vscode.lm.onDidChangeChatModels`, and `onDidChangeConfiguration` filtered to `codeVerdict.agentLocations`. It re-discovers, reconciles, re-renders. Dispose watchers with the panel.
- [ ] 8.4 Test that editing an agent file while the screen is open updates the picker, and that deleting the selected agent falls back with a notice.
- [ ] 8.5 Handle the model disappearing between selection and run: fail with a message naming the model and return to the Run AI Review screen with the selection intact.

## 9. Settings: agent locations

- [ ] 9.1 Add `codeVerdict.agentLocations` (array of strings) to `package.json` `configuration`; redescribe `codeVerdict.agent` as the agent id rather than "Id of the Copilot workspace agent". Do not add a `codeVerdict.model` setting — the model lives in `Pod.modelId`, and a second declared-but-unread key would repeat the existing `codeVerdict.agent` wart.
- [ ] 9.2 Add an "Agents" section to `src/ui/settingsHtml.ts` and `SettingsViewState`: list configured locations with their status (readable / unreadable / not found) and the count of agents found in each; `addAgentLocation` and `removeAgentLocation` messages.
- [ ] 9.3 Handle both messages in `src/ui/settings.ts` via `config.update`, following the existing `ConfigurationTarget` pattern in that file. Adding a location uses `showOpenDialog` in folder mode.
- [ ] 9.4 Extend `src/ui/settingsHtml.test.ts`: locations render with status; an unreadable location is named and does not hide the others.

## 10. Docs and closeout

- [ ] 10.1 Update `spec/specs/Code Verdict - naming & commands.md` line 45: `codeVerdict.selectAgent` is described as "Lists Copilot workspace agents" but already opens the Tuning panel (`src/extension.ts:511`), and neither fact survives this change — describe what it does. No new command is added. Add `codeVerdict.agentLocations` to the settings list at line 60.
- [ ] 10.2 Document the agent file format — the accepted frontmatter subset, that the body is instructions only, and that the JSON response contract is always supplied by Code Verdict — in `README.md` beside the existing Copilot section.
- [ ] 10.3 Run `npm run lint` and the full `vitest` suite; fix fallout from the `AgentDescriptor` split.
- [ ] 10.4 Manual check against the emulator: no agent files → identical behaviour to before; one workspace agent → it appears, runs, and its instructions show in the agent trace ahead of the contract.
