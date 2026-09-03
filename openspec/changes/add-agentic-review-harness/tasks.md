## 1. Dependency And Baseline

- [x] 1.1 Land or otherwise make `add-context-controls-and-thinking-effort` available before harness integration; verify its context selections, attachment evidence metadata, thinking effort, and out-of-diff summary routing tests pass unchanged.
- [x] 1.2 Add characterization tests around `ReviewRunManager` for one-active-run-per-target admission, FIFO global concurrency, immediate slot release on cancellation, write-before-notify completion, retained-review survival, and headless notification before changing its runner interface.
- [x] 1.3 Add fixture data for a small review, a paginated huge review, binary and renamed files, an unavailable oversized diff, nested `AGENTS.md`, a changed head, long issue/discussion details, and a multi-member changeset.
- [x] 1.4 Record the current legacy persisted shapes for run history, in-flight records, retained reviews, and triage drafts as migration fixtures.

## 2. Domain Models And Policy

- [x] 2.1 Add versioned run, lineage, and attempt identifiers plus canonical lifecycle and independent `none | partial | complete` result completeness types under `src/domain/`.
- [x] 2.2 Define `ReviewRunSnapshot` and member snapshot types for immutable provider/repository identity, base/head SHAs, agent/persona digest, model, thinking effort, criteria, context controls, attachments, policy, tool-contract version, and provider capability signature.
- [x] 2.3 Define typed public plan, stable plan-item identifiers, plan revisions, plan-item states, sanitized activity events, limitations, attention state, and `RunProjection` types.
- [x] 2.4 Define changed-file inventory, risk classification, inspection state, per-member coverage, unresolved work, budget consumption, and completion-decision types.
- [x] 2.5 Define evidence source metadata, source citations, candidate validation states, validated finding provenance, and protocol provenance including `legacy-one-shot`.
- [x] 2.6 Add `HarnessPolicy` with the design's injectable initial limits, reserve percentages, retries, protocol repairs, checkpoint cadence, and retention bounds; validate unusable values by falling back to documented defaults.
- [x] 2.7 Add serialization and migration tests proving unknown or malformed persisted enum values fail closed and legacy successful reviews remain readable without fabricated plan, evidence, or coverage.

## 3. Neutral Provider Contracts

- [x] 3.1 Extend `ProviderCapabilities` in `src/platform/provider.ts` with structured review-investigation support and declared bounds for manifests, pinned reads, searches, details, and pagination.
- [x] 3.2 Add neutral request and result types in `src/platform/types.ts` for snapshot identity, cursors, changed-file manifests, bounded diff pages, base/head file ranges, search matches, normalized details, and common completeness states.
- [x] 3.3 Extend `Connection` with manifest, diff-read, revision-pinned file-read, repository-search, diff-search, change-request-detail, linked-issue-detail, and current-head operations; require explicit repository and revision identity on every request.
- [x] 3.4 Normalize complete, paginated, truncated, unavailable, binary, too-large, not-found, and unknown-completeness results without representing unavailable content as an empty successful payload.
- [x] 3.5 Carry retryability and provider `Retry-After` or reset guidance through the existing neutral error taxonomy without exposing platform payloads.
- [x] 3.6 Extend `src/platform/contract/providerContract.ts` with reusable manifest pagination, immutable revision, range bound, binary, truncation, empty-complete, unavailable capability, detail normalization, search, and rate-limit cases.
- [x] 3.7 Add a conformance assertion that no investigation caller branches on provider identity or substitutes an unpinned branch tip for a requested SHA.

## 4. Provider Implementations

- [x] 4.1 Implement every investigation operation in `src/providers/fixture/fixtureProvider.ts` first, using deterministic cursors and all explicit result states needed by harness tests.
- [x] 4.2 Make `src/providers/fixture/fixture.contract.test.ts` pass the expanded shared provider suite, including the huge, binary, renamed, stale-revision, and rate-limited fixtures.
- [x] 4.3 Extend `src/providers/gitlab/gitlabProvider.ts`, mappers, and HTTP helpers with manifest, pinned diff/file reads, bounded searches, normalized details, current-head checks, and honest capability declarations.
- [x] 4.4 Extend `src/providers/gitlab/fakeGitLab.ts` and GitLab tests with platform pagination, truncation, binary, missing revision, linked issues, discussion, check-summary, and `Retry-After` behavior.
- [x] 4.5 Make `src/providers/gitlab/gitlab.contract.test.ts` and emulator tests pass the expanded conformance suite without leaking GitLab payload shapes above the provider.
- [x] 4.6 Extend `src/providers/github/githubProvider.ts`, mappers, and HTTP helpers with manifest, pinned diff/file reads, bounded searches, normalized details, current-head checks, and honest capability declarations.
- [x] 4.7 Extend `src/providers/github/fakeGitHub.ts` and GitHub tests with platform pagination and limits, binary files, missing revisions, linked issues, reviews, check summaries without full logs, and rate-limit reset behavior.
- [x] 4.8 Make `src/providers/github/github.contract.test.ts` and emulator tests pass the expanded conformance suite while preserving existing ETag and rate-budget behavior.

## 5. Sanitized Activity Protocol

- [x] 5.1 Create an activity module under `src/app/` with the ordered typed union and common run, lineage, attempt, sequence, timestamp, phase, and elapsed fields from `review-run-activity`.
- [x] 5.2 Implement an append-only activity builder that assigns monotonic sequence values, deduplicates event identifiers, and preserves attempt boundaries after resume.
- [x] 5.3 Implement public plan creation, revision, and plan-item transition events with stable item identifiers and retained prior revisions.
- [x] 5.4 Implement the pure activity reducer that derives one `RunProjection` for lifecycle, completeness, current action, sanitized target, elapsed time, progress mode, coverage, attention, checkpoint, limitations, and result.
- [x] 5.5 Add an allowlist sanitizer for public rationale, tool targets, completion/failure summaries, and error metadata; reject raw prompts, model fragments, secrets, full arguments, and full output payloads.
- [x] 5.6 Test out-of-order and duplicate events, plan revision history, stable identifiers, partial results, attempt boundaries, determinate units, indeterminate waits, secret redaction, and terminal events bypassing progress throttling.

## 6. Snapshot, Bootstrap, And Policy Resolution

- [x] 6.1 Replace the mutable run-input payload with a snapshot builder that resolves and hashes every agent, model, effort, criteria, context-control, attachment, provider-capability, repository, and revision input before dispatch.
- [x] 6.2 Add normalized bootstrap section models for full linked-issue and change-request metadata, title, body, commits, review discussion, labels, check summaries, and relationships, excluding patches and full CI logs.
- [x] 6.3 Implement base-revision root and nested `AGENTS.md` resolution from repository root to each changed path, with explicit absence, ordered policy composition, per-base/path caching, and non-citable classification.
- [x] 6.4 Implement a bootstrap builder that isolates every author-controlled section as untrusted data and keeps host instructions, policy, criteria, tool schemas, evidence rules, and completion rules structurally authoritative.
- [x] 6.5 Make large detail sections reopenable through stable section references, digests, truncation state, and bounded detail-tool cursors rather than blind concatenation.
- [x] 6.6 Count bootstrap tokens for the selected model, replace reopenable sections before shortening non-normative host descriptions, and fail with completeness `none` when the minimum authoritative envelope still cannot fit.
- [x] 6.7 Add adversarial tests for forged tool names, policy markers, evidence identifiers, section boundaries, diff labels, attachment delimiters, and mandatory-envelope overflow.

## 7. Evidence Ledger And Candidate Validation

- [x] 7.1 Create an append-only in-memory evidence ledger that assigns stable source identifiers and cryptographic digests to the exact content returned to the model.
- [x] 7.2 Bind every source to run, lineage, attempt, repository, base/head, revision, origin, path/range/page, completeness, trust, and citable status; reject cross-head or cross-member aliasing.
- [x] 7.3 Register exact diff pages, file ranges, search excerpts, detail pages, and explicit context-control attachments only after they are included in a model-visible result.
- [x] 7.4 Mark auto-derived intent and every `AGENTS.md` policy source non-citable; mark changed diff evidence citable; mark reviewer-selected attachments citable under upstream summary-routing rules.
- [x] 7.5 Implement citation resolution against source identifier, digest, and exact returned range instead of refetching by path at validation time.
- [x] 7.6 Implement incremental candidate validation for schema, criteria, member identity, citation, revision, location, citable status, and primary-target eligibility with accepted, repairable, and rejected outcomes.
- [x] 7.7 Enforce that unchanged repository evidence can corroborate a changed primary target but cannot become an unrelated primary finding unless it is an explicit citable attachment.
- [x] 7.8 Revalidate citations after synthesis and verification, and keep unresolved candidates out of triage while blocking complete status.
- [x] 7.9 Test omitted ranges, fabricated source identifiers, changed digests, intent/policy citations, another head, unchanged surprise findings, changed-line inline anchors, out-of-diff attachment summary routing, and resume evidence reuse.

## 8. Coverage, Budgets, And Completion

- [x] 8.1 Implement per-member manifest accumulation that does not expose a total denominator until enumeration is explicitly complete.
- [x] 8.2 Implement changed-file transitions through unvisited, classified, inspected, policy-excluded, unavailable, binary, and oversized states with public reasons and real counts.
- [x] 8.3 Implement host risk floors from manifest facts and resolved policy, with injected path/category weights that can be tuned without changing the state model.
- [x] 8.4 Implement hierarchical global, run, phase, turn, tool, evidence, and elapsed-time budgets with atomic reservations and actual-use reconciliation.
- [x] 8.5 Partition and enforce ordinary investigation, unvisited/high-risk, and final-verification reserves so earlier work cannot consume protected capacity.
- [x] 8.6 Implement per-member minimum turns, tool calls, evidence bytes, and risk reserves before changeset members may consume shared budget.
- [x] 8.7 Implement the deterministic completion gate for stable head, complete inventories, classifications, configured risk coverage, no unresolved fetches/candidates, valid citations, contradiction pass, deduplication, and final verification.
- [x] 8.8 Map completion-gate outcomes to complete findings, complete clean, partial findings with limitations, or failed/none without ever treating incomplete no-findings as clean.
- [x] 8.9 Test early completion requests, incomplete inventory, high-risk reserve use, exhausted ordinary and hard budgets, unavailable oversized patches, provider limits, timeout, changed head, unresolved candidates, complete clean, and complete findings.

## 9. Host Tool Dispatcher And Retry Policy

- [ ] 9.1 Create the versioned host tool catalog for manifest, diff, base/head file ranges, repository search, diff search, policy resolution, issue details, change-request details, candidate submission, and completion requests.
- [ ] 9.2 Validate every tool request for allowed tool, phase, target/member, normalized path, immutable revision, cursor provenance, bounds, provider capability, budget, and cancellation before dispatch.
- [ ] 9.3 Implement common bounded result envelopes with source identifiers, digests, real units, continuation, and explicit complete, paginated, truncated, unavailable, binary, too-large, and not-found states.
- [ ] 9.4 Connect provider-backed handlers to the neutral `Connection` operations and host-backed candidate/completion handlers without importing concrete providers.
- [ ] 9.5 Implement bounded transient retries using provider guidance first and exponential jittered backoff otherwise; never retry a non-idempotent side effect implicitly.
- [ ] 9.6 Move long retry delays to waiting with checkpoint and slot release, then through resuming with original queue fairness and one-active-run-per-target ownership preserved.
- [ ] 9.7 Propagate cancellation to active model and provider work, stop new reservations synchronously, ignore late results, and emit cancelling/cancelled activity before releasing retained state.
- [ ] 9.8 Test path traversal, forged cursor, unauthorized member, stale revision, unavailable capability, page bounds, retry exhaustion, `Retry-After`, cancellation during dispatch/backoff, and late completion.

## 10. Model Protocol And Harness Engine

- [ ] 10.1 Define and parse the bounded model protocol for plan creation/revision, plan-item transitions, public rationale, tool requests, candidate submissions, checkpoint suggestions, and completion requests.
- [ ] 10.2 Replace raw final-response parsing in the review path with phase-specific typed turns and bounded protocol repair; keep follow-up questions outside the review harness unless separately specified.
- [ ] 10.3 Implement `HarnessAttempt` phase transitions for bootstrap/inventory, planning, risk classification, logical-unit investigation, checkpoint, synthesis, verification/contradiction/deduplication, host validation, and persistence.
- [ ] 10.4 Reuse the selected model and persona across planning, investigation, synthesis, and verification by default, preserving phase-specific contracts and budgets without requiring another model.
- [ ] 10.5 Implement the small-review fast path as fewer turns through the same plan, evidence, coverage, verification, completion, activity, and persistence machinery.
- [ ] 10.6 Implement deterministic synthesis grouping and deduplication by primary location and semantic claim, followed by model contradiction checks against exact cited evidence.
- [ ] 10.7 Implement a deterministic demo participant that emits the same protocol and uses the same tools, evidence, coverage, completion, activity, cancellation, and persistence path without a model request.
- [ ] 10.8 Ensure built-in, discovered, demo, individual, changeset, initial, and rerun entry points can invoke only the universal harness in shipped runtime wiring.
- [ ] 10.9 Test malformed protocol and repair limits, plan revision, same-model phases, fast-path invariants, candidate flow, contradiction, deduplication, demo parity, and absence of a one-shot bypass.

## 11. Checkpoint Persistence And Resume

- [ ] 11.1 Create a bounded `HarnessRunStore` over workspace storage for snapshots, projected plans/status, sanitized activity, checkpoints, evidence metadata/digests, required exact excerpts, candidates/findings, budgets, coverage, retries, and lineage.
- [ ] 11.2 Implement checkpoint writes at every phase boundary and configured tool cadence without serializing clients, streams, cancellation handles, prompts, model fragments, secrets, full arguments, full outputs, or hidden reasoning.
- [ ] 11.3 Implement activity compaction that preserves plan revisions, lifecycle and terminal events, failures, checkpoints, coverage changes, and results while coalescing only routine repeated progress.
- [ ] 11.4 Enforce per-attempt activity, per-lineage checkpoint data, checkpoint count, terminal-attempt count, and retention-age bounds from `HarnessPolicy`.
- [ ] 11.5 Implement checkpoint integrity and resume compatibility checks for versions, digests, repository/head, model, resolved agent instructions, criteria, effort, context controls, policy, provider capabilities, and required exact evidence.
- [ ] 11.6 Resume compatible work as a new attempt in the same lineage, explicitly interrupt the lost attempt, and refetch rather than claim unavailable exact evidence remains model-visible.
- [ ] 11.7 Reject incompatible resume with all reasons and offer a fresh restart without mixing revisions, attempts, or evidence.
- [ ] 11.8 Add restart, compaction, eviction, corruption, compatible resume, each incompatibility dimension, no-reconnect wording, and no-prohibited-content persistence tests.

## 12. Run Manager And Retained Results

- [ ] 12.1 Replace `ReviewRunners` in `src/app/reviewRunManager.ts` with harness-attempt injection while retaining target keys, one-active-run admission, FIFO concurrency, and the manager's single completion owner.
- [ ] 12.2 Expand `RunRecord` and active queries to canonical lifecycle, completeness, lineage, attempt, projection, checkpoint, limitations, and partial result while retaining a compact `running` compatibility projection.
- [ ] 12.3 Route queued, planning, investigating, verifying, completing, waiting, paused, resuming, cancelling, cancelled, succeeded, failed, and interrupted transitions through one validated manager transition path.
- [ ] 12.4 Preserve immediate slot release and cancellation propagation for queued, active, waiting, and paused attempts; ensure late model/provider work cannot settle an already terminal attempt.
- [ ] 12.5 Update `ReviewRunStore`, `InFlightRunStore`, and retained-review models so only `succeeded + complete` replaces a complete retained review and partial results remain separately reachable and explicitly incomplete.
- [ ] 12.6 Preserve write-before-notify ordering for complete and partial persistence, headless completion, failure, cancellation, and interruption.
- [ ] 12.7 Update activation interruption sweep to close unattached nonterminal attempts, retain prior complete reviews, and offer resume only through checkpoint compatibility.
- [ ] 12.8 Test concurrency while a run waits, pause/resume/cancel, partial after failure/cancellation, complete replacement, partial non-replacement, interruption, compatible resume, incompatible restart, pod deletion, and pod/selection changes mid-run.

## 13. Changeset Harness

- [ ] 13.1 Build one changeset snapshot with immutable member identities and base/head SHAs, member-owned context/attachments, and a shared lineage.
- [ ] 13.2 Scope manifest, diff, file, search, policy, detail, evidence, and candidate operations to an explicit member while preserving common host authorization.
- [ ] 13.3 Build member-scoped plan items and shared cross-member plan items, retaining stable identifiers when evidence adds or revises shared work.
- [ ] 13.4 Enforce per-member inventory exhaustion, risk coverage, minimum budgets, head stability, and limitations before evaluating shared completion.
- [ ] 13.5 Validate cross-member findings with one changed or explicit-attachment primary target and revision-bound supporting spans from other members.
- [ ] 13.6 Test a dominant large member, a rate-limited member, an incomplete member, cross-member API/schema evidence, mixed head changes, member attachment routing, and a complete clean changeset.

## 14. UI Projections And Controls

- [ ] 14.1 Replace fixed running steps and fragment-count user progress in the active review with the shared `RunProjection`, public plan, plan revisions, current action, elapsed time, coverage, limitations, checkpoint, and completeness.
- [ ] 14.2 Add full ordered sanitized activity and attempt lineage to retained/completed run details, including legacy provenance without fabricated activity or coverage.
- [ ] 14.3 Update `src/ui/sidebarState.ts`, `sidebar.ts`, and `sidebarHtml.ts` to show the same lifecycle/current action, truthful progress mode, elapsed time, attention state, and cancel navigation from compact projection data.
- [ ] 14.4 Update `src/ui/dashboardState.ts`, `dashboard.ts`, and `dashboardHtml.ts` to show target-level phase, completeness, real coverage, partial limitations, and retained complete review separately from an active or partial rerun.
- [ ] 14.5 Update status-bar state and rendering to show active-run count plus concise current action and determinate units only when a denominator exists; show indeterminate elapsed waits otherwise.
- [ ] 14.6 Add pause, resume-from-checkpoint, restart, and cancel controls only in lifecycle states where the manager accepts them, with incompatible resume reasons visible.
- [ ] 14.7 Update notification handling so routine activity never raises a notification and terminal or reviewer-attention notifications distinguish complete, partial, failed, cancelled, and interrupted results.
- [ ] 14.8 Add pure renderer and page-script tests proving active review, sidebar, dashboard, status bar, and retained details cannot contradict the same projection and that long labels do not break compact layouts.

## 15. Context, Agents, Trace, And Wiring Migration

- [ ] 15.1 Snapshot every context-control and thinking-effort input from `add-context-controls-and-thinking-effort` for both individual and changeset runs, including explicit attachment content digests and member ownership.
- [ ] 15.2 Register explicit attachments as citable ledger sources only when returned to the model; keep auto-derived title, body, issue, and discussion content as non-citable intent.
- [ ] 15.3 Preserve out-of-diff attachment findings in summary routing and changed-file attachment findings in inline anchor routing after citation validation.
- [ ] 15.4 Update agent-definition parsing and tests so arbitrary tool frontmatter grants nothing while existing name, description, preferred model, and instruction behavior remains.
- [ ] 15.5 Replace the `review-agents` byte-identical one-shot prompt test with harness-authority, common-tool-contract, evidence, phase, and completion parity tests across personas.
- [ ] 15.6 Convert `src/app/agentTrace.ts` and `lmAgent.ts` diagnostics to metadata-only request identifiers, model/phase, timings, sizes, digests, and redacted errors; remove raw prompt and raw model-fragment output.
- [ ] 15.7 Update `src/extension.ts` wiring to construct the provider-backed tool dispatcher, harness factory, bounded store, activity fan-out, resume compatibility services, and notifier while preserving existing dependency direction.
- [ ] 15.8 Remove whole-diff capture from `RunInput`, remove shipped one-shot review execution, and retain `getChangeRequestDiff` only for non-harness callers until all callers are migrated.

## 16. Security, Reliability, And Large-Review Tests

- [ ] 16.1 Add adversarial end-to-end tests proving issue, change-request, commit, discussion, repository, policy, and attachment text cannot forge host instructions, tools, source identifiers, citable status, or completion.
- [ ] 16.2 Add a large-review integration test whose manifest and evidence exceed model input limits, proving paginated investigation, reopenable bootstrap, real coverage, reserved verification, and complete or explicit partial outcome.
- [ ] 16.3 Add provider-limit tests proving incomplete inventory, truncated search, unavailable oversized diff, binary content, and unknown completeness cannot yield a clean result.
- [ ] 16.4 Add persistence inspection tests proving no raw prompt, model fragment, secret, hidden reasoning, full tool argument, or full tool-output blob enters activity, trace, checkpoints, retained details, or workspace storage.
- [ ] 16.5 Add lifecycle race tests for cancellation during model streaming, provider reads, retry waits, checkpoint writes, and final persistence, including providers that ignore cancellation and late responses.
- [ ] 16.6 Add multi-run integration tests proving global concurrency, one run per target, waiting-slot release, queue fairness, target isolation, and unchanged retained-review behavior across individual and changeset runs.
- [ ] 16.7 Add completion mutation tests that independently remove each required predicate and prove complete/clean status is rejected.
- [ ] 16.8 Add restart tests proving interrupted attempts never claim reconnection, compatible resume increments attempt in the same lineage, and a changed head or input forces restart.

## 17. Settings, Documentation, And Validation

- [ ] 17.1 Add reviewer-relevant harness budget, elapsed-time, retry, reserve, checkpoint, activity, and retention settings to `package.json`, with the design defaults and validation that unusable values fall back safely.
- [ ] 17.2 Add settings UI for reviewer-relevant policy values without exposing provider-specific page sizes or allowing settings to weaken citation, revision, or completion invariants.
- [ ] 17.3 Update `README.md` with the universal harness, public activity versus private reasoning boundary, complete/partial semantics, cancellation, checkpoint resume, attachment evidence, and legacy review provenance.
- [ ] 17.4 Update `docs/ARCHITECTURE.md` with the harness attempt layer, host tool dispatcher, evidence ledger, provider investigation contracts, one shared run projection, and metadata-only trace.
- [ ] 17.5 Update provider documentation and `spec/specs/Code Verdict - naming & commands.md` for new settings, lifecycle labels, progress language, partial outcomes, and resume/restart controls.
- [ ] 17.6 Run the expanded provider conformance suites and all focused harness, evidence, coverage, persistence, lifecycle, changeset, activity, and UI tests.
- [ ] 17.7 Run `npm run lint`, the complete Vitest suite, `npm run build`, and the repository's Markdown validation; resolve only failures caused by this change.
- [ ] 17.8 Run `openspec validate add-agentic-review-harness --json` and confirm every artifact and delta is valid before implementation is marked complete.
- [ ] 17.9 Manually validate in the emulator: a small fast-path review, a paginated huge review, public plan revision, truthful indeterminate and determinate progress, cancellation, partial outcome, complete clean outcome, changeset fairness, restart, compatible resume, and incompatible changed-head restart.
