## Context

See proposal.md — Why for the defect. What follows is only the state of the code that shapes the approach.

**The demo agent's visibility was a constant, not a decision.** `BUILT_IN_AGENTS` in `src/app/agents.ts` was a two-element array — the default review and the demo agent — spread into the agent list by `loadAgentSelection` on every pod. There was no place to put a condition, because there was no function.

**The list is not the only thing that reads from that list.** `podSelection.reconcile` settles the stored selection against what exists right now, and pushes `The agent "X" was not found, so the default review is selected.` for any stored agent id it cannot find. Hiding an agent that a pod has stored therefore does two visible things, not one: the row disappears, and the reviewer is told their selection was lost. Only the first is wanted.

**The run block is separate from the listing.** `renderRunReview` computes `runBlocked = needsModel && s.models.length === 0`, and `modelPicker` writes the sentence beside it. Those are two different questions — whether this run can start, and what the reviewer should do about it — and only the second depends on what the picker is offering.

**The app layer does not read settings.** `agentLocations.ts` reads `codeVerdict.agentLocations` in the UI layer and hands `AgentSearchRoot[]` down; `src/app/agentDefinitions.ts` never calls `workspace.getConfiguration`. Whatever reads the new setting has to sit on that side of the line.

## Goals / Non-Goals

**Goals:**

- A reviewer on a connected forge does not see a row that invents findings, unless they asked for it.
- No reviewer loses a selection they already made, and none is told they did.
- The sample-data pod keeps a review it can actually run with no Copilot session.
- Every screen that says "no model available" says something true of the agents it is offering.

**Non-Goals:**

- Changing what the demo agent produces, or whether it neutralises the model picker once selected.
- Removing the demo agent, or re-iding it. `DEMO_AGENT_ID` is a stored value on real pods.
- Gating any other built-in agent. The default review is unconditional.

## Decisions

### D1. A function, not a constant, and the visibility is passed in rather than read

`builtInAgents(visibility: DemoAgentVisibility)` replaces `BUILT_IN_AGENTS`. Deleting the constant is the point of doing it this way: every caller that assumed the demo agent was always present becomes a compile error, so none is missed silently.

The three inputs arrive as plain data (`setting`, `selectedAgentIds`, `podReviewsSampleData`) rather than being read inside `app/agents.ts`. That keeps the app layer free of `workspace.getConfiguration`, on the `agentLocations.ts` precedent, and it is what makes the rule testable without a configuration fake.

Rejected: filtering the demo agent out at the render layer. The picker is not the only consumer of the agent list — `reconcile` reads it too, and a list that differs between the two is exactly how a "was not found" notice appears for an agent that is on screen.

### D2. Two exceptions, each closing a way the gate would otherwise lie

**A selection already made.** `selectedAgentIds` carries both the pod's stored agent id and the id the panel currently holds, because a refresh reconciles the panel's selection rather than the pod's. A picker that renders a selection missing from its own list, or that reports an agent "was not found" when this build merely chose not to list it, describes something that is not so.

**The sample-data pod.** Its change requests exist in no repository, and it is what onboarding hands someone who has no token yet. `renderRunReview` blocks the run button for every agent that needs a chat model when none is available, and the demo agent is the only one that needs none — so on a machine with no Copilot session, hiding it there leaves that pod with no review at all. Keyed on `pod.providerId === SAMPLE_DATA_PROVIDER_ID`, the pod's own question, never on the selected agent.

### D3. The no-models sentence is keyed on the rendered list, not on the setting

`modelPicker` picks its subtitle from `s.agents.some((candidate) => candidate.source === 'demo')`.

Keying it on `codeVerdict.showDemoAgent` would be wrong in both exceptions above: with the setting off, a sample-data pod and a pod that already holds the demo agent both list it, and the sentence would tell the reviewer to sign in to Copilot when a working alternative is one row away. Keying it on the list cannot drift from the list, because it is the list.

### D4. A non-boolean setting value reads as off

`typeof value === 'boolean' ? value : false`, matching the guard style the other boolean readers use. The setting reveals a debugging agent; a malformed value is a malformed setting, not a request.

### D5. The reader and the watch name the same setting through one constant

`SHOW_DEMO_AGENT_SETTING` is used by both `readShowDemoAgent` and `watchAgentSources`, which sit next to each other in `agentRefresh.ts`. A reader added without its watch is a picker that ignores the toggle until the window reloads — the two have to agree, so they name the setting once.

## Risks / Trade-offs

- [A reviewer who used the demo agent regularly finds it gone] -> It is one boolean in settings, documented in `docs/SETTINGS.md`, and a pod that already had it selected keeps it. Nobody loses a selection; they lose a row they did not select.
- [The visibility rule is spread across three inputs] -> One function decides, and it is pure. The alternative — three call sites each deciding for themselves — is how the picker and the sentence beside it come to disagree.

## Migration Plan

None. The setting is new and defaults to `false`; pods storing the demo agent are read exactly as before and keep it listed. No stored value changes, and `DEMO_AGENT_ID` is untouched.

## Open Questions

None.
