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

**An agent supplies prompt text and nothing else.** The JSON response contract, the review criteria
and the diffs are always appended by Code Verdict, after the agent's instructions. An agent file
cannot change the response shape, drop the criteria, or alter which diffs are sent — a body that
tries is simply text the model reads before the contract it must still satisfy.

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
