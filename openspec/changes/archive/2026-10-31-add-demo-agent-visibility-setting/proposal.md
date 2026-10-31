## Why

The demo agent is a debugging tool. It calls no model and derives the same findings from the diff
text every time, which makes it useful for walking the review, triage and submit screens without
spending a Copilot request, and worthless as a review of anything. Until now it was in
`BUILT_IN_AGENTS` and therefore listed in the agent picker on every pod, one row below the default
review, with nothing but its own description to say it is not a real reviewer. A reviewer who picks
it on a connected GitHub or GitLab change request gets made-up findings on real code.

`codeVerdict.showDemoAgent` (boolean, default `false`) now gates it. That leaves the spec saying two
things that are no longer true:

- `review-agents` "Scenario: No models available" ends "**AND** the demo agent can still be run".
  On an ordinary pod with the setting off there is no demo row in the picker, so there is nothing to
  run; every agent the screen offers needs a model, and the run button is disabled for all of them.
  The screen already says so — `modelPicker` picks its subtitle from whether the demo agent is in
  the agent list — but the spec still describes the old behaviour.
- Nothing in `review-agents` said when the demo agent is listed at all. The gate and its two
  exceptions have no requirement to be measured against.

## What Changes

- The demo agent is hidden from the agent picker unless one of three things holds: the setting is
  on, the selection the screen is about to reconcile already names the demo agent, or the pod under
  review is the sample-data pod.
  - **Already selected** is an exception because a picker that renders a selection missing from its
    own list, or that reports "the agent X was not found" about an agent this build simply chose not
    to list, describes something that is not so.
  - **The sample-data pod** is an exception because its change requests exist in no repository and
    it is what onboarding hands someone who has no token yet. Every model-backed agent is blocked
    there when no model is available, and the demo agent is the only one that needs none — hiding it
    would leave that pod with no review it can run.
- The no-models state on the Run AI Review screen says something different depending on whether the
  demo agent is in the list beside it: "sign in to Copilot, or pick the demo agent" when it is,
  "sign in to Copilot — every agent offered here needs a model" when it is not. It never names a way
  out the picker does not offer.
- A `showDemoAgent` value that is not a boolean reads as off, and changing the setting re-scans the
  pickers without a window reload — it is watched alongside `codeVerdict.agentLocations`.

**Not changed:** what the demo agent does once selected. It still calls no model, still neutralises
the model selection, and still runs with no model available. Only whether it is offered is new.

## Capabilities

### Modified Capabilities

- `review-agents`: the no-models state on the Run AI Review screen now depends on whether the demo
  agent is offered, and a new requirement states when it is offered at all.

## Impact

| Area | Effect |
| --- | --- |
| `src/app/agents.ts` | `BUILT_IN_AGENTS` (a constant array) becomes `builtInAgents(visibility)`, which decides the demo agent's inclusion from a `DemoAgentVisibility` the UI layer supplies. |
| `src/ui/agentRefresh.ts` | Reads `codeVerdict.showDemoAgent`, takes the pod alongside the persisted selection, and watches the setting so the pickers re-scan on a change. |
| `src/ui/reviewFlow.ts`, `src/ui/changesetReview.ts` | Both pass their pod to `loadAgentSelection`, at load and on every refresh. |
| `src/ui/reviewFlowHtml.ts` | The no-models subtitle is keyed off whether the demo agent is in the rendered agent list, not off the setting, so it stays right for the two exceptions. |
| `package.json` | `codeVerdict.showDemoAgent` added. |
| `docs/SETTINGS.md` | Entry for the new setting, including both exceptions and the non-boolean reading. |

Not affected: `DEMO_AGENT_ID` and every pod that already stores it, the demo agent's own findings,
`podSelection.reconcile`'s fallback rules, and which pod is handed an investigation source — that is
keyed on the pod's provider, never on the selected agent.
