# Code Verdict

> Judge the AI's review, then ship it to GitLab.

A VS Code extension that turns an AI code review into a human decision: point a review
agent at a GitLab merge request, triage every finding as **Accepted / Rejected / Skipped**, then
submit inline comments and a summary back to GitLab in one click.

## Agents and models

A review needs two choices, and they are separate things:

- an **agent** — *what kind of review to run*, and
- a **model** — *what executes it*, one of the Copilot chat models this session offers.

Both are picked on the Run AI Review screen. The extension ships a default agent, so a workspace
that defines none reviews exactly as it always did.

### Context and thinking effort

An attachment is a file, folder, editor selection, symbol, Problems snapshot, or pasted text that
you explicitly add to one review run. The context area shows attachments alongside the
automatically derived change request title, description, and linked work items, and lets you remove
or restore each item before running the review.

The evidence boundary is strict. Automatically derived change request text is intent that helps the
agent interpret the change, but a finding cannot cite it. Attachments and changed-file diffs are
reviewable evidence. An accepted finding against an attached file outside the diff is included in
the review summary with its file and line instead of being posted as an inline comment.

Thinking Effort adds review instructions to the prompt. It does not change the provider's native
reasoning setting or expose a model reasoning trace. The selected level is remembered per model.

Auto-derived context defaults to 4,000 characters per section, 12,000 characters total, and five
linked work items. Configure those limits with `codeVerdict.context.sectionBudget`,
`codeVerdict.context.totalBudget`, and `codeVerdict.context.maxLinkedItems`. New reviews include the
title, description, and linked work items by default; use `codeVerdict.context.includeTitle`,
`codeVerdict.context.includeDescription`, and `codeVerdict.context.includeLinkedItems` to change
those starting choices. `codeVerdict.contextUsage.enabled` controls the usage indicator and defaults
to `true`; context and attachment budgets continue to apply when it is off. The indicator estimates
the size of the old single-prompt request, not the bounded pages the harness actually sends (see
"How a review runs" below) — treat it as an approximation, not an exact count.

### Writing an agent

An agent is a `*.agent.md` file. Every workspace folder's `.github/agents` directory is searched
automatically; add more directories under **Settings → Agents** (or `codeVerdict.agentLocations`).

```markdown
---
name: Security Reviewer
description: Reads for injection, authz and secret handling.
model: copilot/gpt-5          # optional; applied when you select the agent
---

Focus on authentication and authorisation boundaries. Treat any user-controlled
value reaching a query, a path, or a shell as a finding worth reporting.
```

The header is a deliberately small subset of YAML: the file opens with `---`, the header ends at
the next `---`, and each line between is `key: value`. `name` and `description` are required, as is
a non-empty body. Nesting and multi-line values are not supported; a `tools:` list written for
another tool is ignored rather than rejected. A file that cannot be parsed is skipped and reported
on the run screen — it never stops the screen from opening.

**An agent supplies prompt text and nothing else.** The JSON response contract, the review criteria,
selected context, attachments, and diffs are assembled by Code Verdict after the agent's
instructions. An agent file cannot change the response shape, drop the criteria, or alter which
attachments or diffs are sent. A body that tries is text the model reads before the contract it
must still satisfy.

## How a review runs

Every review — a first run, a rerun, one change request, or a changeset — goes through the same
harness: the same plan, the same bounded tools, the same completion checks. A small review needs
fewer steps to satisfy them; it never skips one.

The model works from a list of every changed file, then reads diffs, file ranges, and repository
content in bounded pages, each pinned to the exact commit under review — never an unbounded diff or
an open-ended search. A finding can anchor to a changed line or an attachment; anything else the
model reads can support a finding about changed code but cannot become an unrelated one by itself.

What is visible while a review runs is the model's plan, plan revisions with a short reason, which
file or tool it is working on, a live list of every tool call it has made — the tool, the file or
query, and how it came back, including a failed one, bounded so a long-running review does not turn
the screen into a wall of text — and how much of the change has been covered. What is never visible,
never logged, and never stored is the prompts sent to the model, its raw output, or any hidden
reasoning. A separate diagnostic channel, "Code Verdict: Agent Trace", records only the size and a
digest of what was sent and received — never the text itself.

Every changed file is classified by risk; at medium risk or above, it must actually be read before
the review can finish, not just classified. A file classified low can be skipped — but real source
code is never allowed to carry a low classification, regardless of what the reviewing model proposes,
so what can actually be skipped is documentation, specifications, and similar plain-text content.
`codeVerdict.harness.requireInspectionMinRisk` (default `medium`) raises or lowers that threshold.

Finding nothing is only reported as a clean review once the review has actually finished; stopping
early is never shown as clean. A review that stops before finishing keeps only what it already
validated: with findings, that is a partial result, shown as such and naming the files it did not
reach; with none, there is nothing to keep. A partial result never replaces a complete review already
held for the same change request — both stay visible. Cancelling produces the same outcome as any
other early stop: whatever was already validated is kept, and nothing further is attempted.

An interrupted review — one still running when the editor closed or crashed — is not picked back up.
What is offered instead is a new attempt from the last checkpoint: the plan, findings, and coverage
recorded before the interruption carry forward, but nothing about the model's earlier connection
does. If the change request, model, agent, or criteria changed underneath it, that new attempt is
refused with its reasons, and a plain restart — a fresh run with no history to carry forward — is
offered in its place.

A review completed before this feature shipped is shown as before, but carries no plan, activity, or
coverage detail, because none was ever recorded for it — it is labeled a legacy review rather than
presented as though the harness had produced it.

Investigation limits — attempt length, tool-call and turn ceilings, evidence held at once, checkpoint
frequency, and how much history is kept — are configurable under `codeVerdict.harness.*` in Settings.

**Status: under construction.** The build is tracked in
[issues](https://github.com/osirison/code-verdict/issues) across three milestones
(Foundation → Review core → Ship).

- Product spec: [`spec/README.md`](spec/README.md) and [`spec/specs/`](spec/specs/)
- Architecture (provider-agnostic data layer): [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)

## Development

```sh
npm install
npm run build      # bundle to dist/extension.js
npm run typecheck
npm run lint
npm test
```

Launch the extension: open this folder in VS Code and press F5.
