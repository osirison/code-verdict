## Why

Large change requests can exceed a model's input limits, while the current one-shot review path cannot prove that every changed area was inspected or distinguish a complete clean review from an incomplete response. Every review needs one host-controlled, resumable harness that lets the model investigate bounded evidence and shows reviewers truthful public progress without exposing private chain-of-thought.

## What Changes

- Route every initial review and rerun, for individual change requests and changesets and for every agent or persona type, through one agentic review state machine. Small reviews use a fast path through the same harness; no one-shot bypass remains.
- Snapshot immutable repository identity and base/head revisions, then build an isolated bootstrap from normalized issue and change-request details, base-revision policy, selected review inputs, criteria, context controls, and host-owned tool contracts. Keep oversized bootstrap sections reopenable through retrieval tools and report truthful partial or failed outcomes when even bootstrap cannot fit.
- Let the model publish a plan and investigate through revision-pinned, authorized, paginated or bounded tools for manifests, diffs, base/head file ranges, searches, nested policy, issue and change-request details, candidate findings, and completion requests.
- Add a host-owned immutable evidence ledger with source identifiers and digests. Only exact evidence returned to the model may support findings; intent and repository policy remain non-citable, while explicit citable attachments from `add-context-controls-and-thinking-effort` enter the same ledger.
- Make the host own authorization, budgets, retries, checkpoints, coverage, citation resolution, candidate validation, verification, deduplication, and the final completion decision. Incomplete inventory, unresolved work, budget or provider limits, timeout, cancellation, and oversized unavailable content cannot produce a clean result.
- Add an ordered, typed, sanitized activity protocol for public plans, plan revisions, actions, tool summaries, coverage, checkpoints, lifecycle changes, and results. Project current action and truthful progress consistently into the active review, sidebar, dashboard, status bar, and retained run details without retaining prompts, model fragments, secrets, hidden reasoning, or full tool payloads.
- Expand run lifecycle and persistence to cover queued, planning, investigating, verifying, completing, waiting, paused, resuming, cancelling, cancelled, succeeded, failed, and interrupted states, with result completeness tracked separately as none, partial, or complete. Resume after restart creates a compatible new attempt and never claims to reconnect to a lost stream.
- Give changesets per-member minimum coverage and budgets plus shared cross-member analysis, while preserving one active run per target, global concurrency, cancellation, retained reviews, posting, trace separation, and context controls where compatible.
- **BREAKING**: Replace the byte-identical one-shot prompt and diff-payload compatibility assumption in `review-agents` with a universal tool-driven harness contract. Built-in and discovered agents retain their reviewing instructions and persona, but cannot select tools, bypass host policy, or redefine completion.

## Capabilities

### New Capabilities

- `agentic-review-harness`: Universal phased orchestration, bounded investigation tools, coverage and completion rules, budgets and retries, and changeset execution
- `review-evidence-ledger`: Immutable evidence identity, trust boundaries, citation validation, attachment integration, and finding eligibility
- `review-run-activity`: Ordered sanitized activity events, public rationale and plan history, truthful progress, and consistent UI projections

### Modified Capabilities

- `background-review-runs`: Expand lifecycle, completeness, cancellation, checkpoint persistence, interruption, compatible resume, attempt lineage, and retained-review replacement behavior
- `review-agents`: Route every persona through the host harness, keep tool authorization out of agent definitions, and replace one-shot prompt compatibility with harness-level compatibility
- `scm-providers`: Add capabilities for changed-file manifests, revision-pinned reads and searches, normalized detail retrieval, pagination, and explicit unavailable, truncated, and binary states

## Impact

The change affects review-run domain models and orchestration, model invocation and tool dispatch, evidence and citation validation, provider APIs and implementations, workspace persistence, active and retained review projections, sidebar/dashboard/status-bar presentation, and conformance, lifecycle, restart, security, and large-review tests.

Implementation depends on `add-context-controls-and-thinking-effort`: its context selection, thinking effort, and explicit citable attachments become immutable run inputs and evidence sources. This change does not alter that proposal, but supersedes its assumption that diffs are always sent in full by making diff access bounded and retrieval-driven when required. Numeric budgets, retry counts, timeouts, and retention limits remain configurable initial defaults rather than product semantics.
