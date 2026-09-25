# Security Policy

## Supported versions

Code Verdict is pre-1.0 (currently `0.0.1`) with no tagged release yet. Fixes land on `main` only —
there is no older maintained version to backport a patch to.

## Reporting a vulnerability

Report privately through GitHub's private vulnerability reporting for this repository (Security tab
→ Report a vulnerability), rather than opening a public issue. Do not include exploit details in a
public issue or pull request.

Code Verdict is maintained by one person. I aim to acknowledge a report within a week and will say
so if that's not going to happen — there's no SLA beyond that.

## Scope

A connected GitLab or GitHub access token lives in the VS Code secret store, never in a setting or
on disk in plain text. Raw prompts sent to the reviewing model and its raw replies are never
persisted by the extension; the `codeVerdict.trace.rawPayloads` setting only writes them to a local
output channel for debugging, and to nowhere else the extension writes. That is not a promise that
nothing reaches disk at all: VS Code captures every output channel's contents into its own log
directory, so while the setting is on, those prompts and replies are in VS Code's logs too.
