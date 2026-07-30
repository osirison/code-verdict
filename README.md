# Code Verdict

> Judge the AI's review, then ship it to GitLab.

A VS Code extension that turns an AI code review into a human decision: point a Copilot review
agent at a GitLab merge request, triage every finding as **Accepted / Rejected / Skipped**, then
submit inline comments and a summary back to GitLab in one click.

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
