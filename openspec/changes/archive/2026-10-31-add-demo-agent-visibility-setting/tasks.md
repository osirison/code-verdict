## 1. The gate

- [x] 1.1 Replace `BUILT_IN_AGENTS` in `src/app/agents.ts` with `builtInAgents(visibility: DemoAgentVisibility)`. The default review is unconditional; the demo agent is included when the setting is on, when `selectedAgentIds` contains `DEMO_AGENT_ID`, or when the pod reviews sample data. Removing the constant is what makes the compiler name every caller that assumed the demo agent was always there.
- [x] 1.2 Read the setting in `src/ui/agentRefresh.ts`, not in `src/app/agents.ts` — the `agentLocations.ts` precedent: settings are read in the UI layer and handed down as plain data, so the app layer never reaches for `workspace.getConfiguration`. Anything that is not a boolean reads as `false`.
- [x] 1.3 Give `loadAgentSelection` a second parameter carrying the pod's `providerId` and stored `agentId`, and feed both that id and the persisted selection's id to `builtInAgents` — on a refresh the panel's own selection is the one about to be reconciled, and a demo agent named by either must be listed.
- [x] 1.4 Add `codeVerdict.showDemoAgent` to `package.json` `contributes.configuration` as a boolean defaulting to `false`, described as a debugging aid.

## 2. Both review surfaces pass their pod

- [x] 2.1 `src/ui/reviewFlow.ts`: pass the pod at load and on every refresh; return early from the refresh when there is no active pod, since there is then nothing to re-decide about the demo agent's visibility.
- [x] 2.2 `src/ui/changesetReview.ts`: the same, at both of its call sites.

## 3. The screen stops naming a way out it does not offer

- [x] 3.1 In `src/ui/reviewFlowHtml.ts`, key the no-models subtitle off whether the rendered agent list contains a demo agent, not off the setting — the two exceptions list it with the setting off, and a subtitle keyed on the setting would be wrong on both.
- [x] 3.2 Keep the run button disabled for every model-backed agent when no model is available, and keep naming the agent in the footer hint. Nothing about the block changes; only the sentence beside it.

## 4. The pickers react to the setting

- [x] 4.1 Add `codeVerdict.showDemoAgent` to `watchAgentSources`'s configuration watch beside `codeVerdict.agentLocations`, and name the setting from one constant shared with the reader — a reader added without its watch is a picker that ignores the toggle until the window reloads.

## 5. Tests

- [x] 5.1 `src/ui/agentRefresh.test.ts`: the demo agent is absent on an ordinary pod with the setting unset; present with it on; present with it off when the pod stores the demo agent; present with it off on the sample-data pod; absent for a non-boolean setting value on an ordinary pod.
- [x] 5.2 Assert that a pod storing the demo agent with the setting off raises no "was not found" notice from `reconcile` — the notice is the observable that would tell a reviewer their selection had been lost.
- [x] 5.3 `src/ui/reviewFlowHtml.test.ts`: with no models and no demo agent in the list, the subtitle names signing in and nothing else; with the demo agent in the list, it names picking the demo agent.
- [x] 5.4 `src/ui/reviewFlow.test.ts` and `src/ui/changesetReview.test.ts`: both panels pass their pod through on load and on refresh.

## 6. Documentation and spec

- [x] 6.1 `docs/SETTINGS.md`: an entry for `codeVerdict.showDemoAgent` stating the default, both exceptions, the non-boolean reading, and that the change applies immediately.
- [x] 6.2 This change's `specs/review-agents/spec.md` delta: add the visibility requirement, and modify "Models are selected separately from agents" so the no-models scenario stops asserting the demo agent can always be run.
