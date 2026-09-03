## Context

See proposal.md, Why. The published `background-review-runs` capability already makes `ReviewRunManager` the target-keyed owner of admission, FIFO concurrency, cancellation, immutable inputs, retained-review writes, notifications, and subscriber updates. The current manager injects one model runner and one demo runner; each returns a final `AgentReviewResponse` from a complete diff already captured in `RunInput`.

The current neutral `Connection` contract exposes one whole-diff operation. GitLab, GitHub, and fixture providers implement that contract below `src/platform/`, and code above the provider layer cannot branch on provider identity. The harness must preserve that dependency direction while adding manifest, pinned read, search, detail, and completeness contracts.

`add-context-controls-and-thinking-effort` is an implementation prerequisite. It defines reviewer-selected context, prompt-level thinking effort, and explicit attachments as citable evidence, while auto-derived change-request context remains non-citable intent. Its current design assumes every diff is placed in one prompt and cannot be cut. This change preserves the trust distinction but replaces the delivery mechanism: the complete changed-file manifest is mandatory, while diff bodies are retrieved in bounded pages under coverage control.

The stable `vscode.lm` surface can stream model text and accept cancellation, but a stream cannot be reattached after extension-host restart. Resume must therefore start a new model attempt from a compatible checkpoint. The existing `AgentTrace` writes prompt and response content to an output channel; that is incompatible with the new requirement never to expose or persist raw prompts or model fragments and must become metadata-only.

The design uses text diagrams to match the repository's existing architecture documents.

## Goals / Non-Goals

**Goals:**

- Extend the existing run manager rather than create another target, concurrency, retention, or notification owner.
- Give one selected model and persona enough host-controlled tools to plan and investigate arbitrarily large reviews in bounded units.
- Make complete, partial, clean, failed, cancelled, and interrupted outcomes mechanically distinguishable.
- Make every finding reproducible from exact model-visible evidence bound to immutable revisions.
- Publish useful coding-agent-style plans, actions, and progress without retaining private chain-of-thought or raw model traffic.
- Preserve provider neutrality, existing retained reviews, posting behavior, context controls, trace separation, and one-active-run-per-target semantics.

**Non-Goals:**

- Reconnecting to a model or provider stream lost when the extension host stops.
- Requiring separate planner, investigator, verifier, or synthesizer models.
- Letting agent files contribute executable tools, permissions, budgets, or transport settings.
- Treating repository-wide search as permission to report unrelated defects in unchanged files.
- Fetching full CI logs automatically. A later capability can add an explicit bounded log tool.
- Persisting a replayable transcript of prompts, responses, or complete tool payloads.
- Defining immutable product limits. Numeric values below are versioned initial policy defaults.

## Decisions

### D1: Extend the run manager with one harness attempt engine per admitted run

`ReviewRunManager` remains the only owner of target admission, global concurrency, cancellation, retained-review replacement, and result notifications. Its injected `ReviewRunners` abstraction becomes an injected `ReviewHarnessFactory`. Each admitted run creates a `HarnessAttempt` that owns phase transitions, model turns, tool dispatch, evidence, coverage, checkpoints, and completion evaluation.

```text
active review / sidebar / dashboard / status bar / retained details
                              |
                       RunProjection
                              |
                     ReviewRunManager
              admission, queue, cancellation,
              attempt lineage, final persistence
                              |
                       HarnessAttempt
         phase machine, plan, budgets, coverage, completion
                 /             |                \
        ModelProtocol   HarnessToolDispatcher   CheckpointStore
                              |
            EvidenceLedger + Provider Connection
```

The manager persists and emits the attempt's sanitized projection, but does not absorb investigation logic. This preserves its current responsibility boundary and keeps one code path for individual and changeset targets.

The demo agent implements the same `HarnessParticipant` protocol with deterministic plan, tool, candidate, and completion messages. It does not call a model, but no separate lifecycle or completion path remains.

Alternative rejected: replace `ReviewRunManager` with a new orchestrator. That would duplicate target keys, queue semantics, cancellation, retained-review writes, and notification ordering before deleting established behavior.

Alternative rejected: keep `ReviewRunners.lm` as a compatibility fast path for small diffs. Two execution paths would need separate security, evidence, activity, and completion proofs, which violates the universal-harness requirement.

### D2: Separate run identity, lineage, attempt, lifecycle, and completeness

The persisted model has four independent identities or states:

- `runId` identifies the target-level invocation shown to the reviewer.
- `lineageId` identifies an original attempt and any checkpoint-based resumes.
- `attempt` is a monotonically increasing number within a lineage.
- `lifecycle` is the execution state; `completeness` is `none`, `partial`, or `complete`.

The canonical lifecycle is:

```text
queued -> planning -> investigating -> verifying -> completing -> succeeded
             |             |              |             |
             +-------------+--------------+-------------+-> cancelling -> cancelled
                           |
                           +-> waiting -> resuming -> prior active phase
                           +-> paused  -> resuming -> prior active phase

planning / investigating / verifying / completing -> failed
any persisted nonterminal attempt lost on restart -> interrupted
```

`running` remains a compatibility projection for compact consumers and means any active phase from planning through completing. `waiting` represents a host-controlled transient condition such as `Retry-After`; `paused` represents a durable stop that requires policy or reviewer action. Long waits release an execution slot and re-enter the FIFO in original admission order when eligible. One-active-run-per-target remains enforced while waiting or paused.

Terminal lifecycle does not infer completeness. A run can fail with validated partial findings, succeed with a complete clean result, or be cancelled with no result. Only `succeeded + complete` may replace a complete retained review.

Alternative rejected: encode partial as another lifecycle state. Cancellation, failure, and success can each coexist with partial evidence, so a single state union would be ambiguous and produce invalid UI transitions.

### D3: Capture a versioned immutable snapshot before bootstrap

`RunInput` becomes a versioned `ReviewRunSnapshot` containing:

- Immutable provider, host, repository, target, and changeset-member identities
- Base and head SHAs for every member
- Selected agent identifier, resolved instructions, persona label, and content digest
- Model identifier and capability metadata
- Thinking-effort level and rendered instruction digest
- Criteria and extra-instruction digest
- Context-control selections, auto-context enablement, explicit attachment content digests, and member ownership
- Root base-revision `AGENTS.md` source identity or explicit absence
- Provider investigation capability signature
- Host tool-contract and harness-policy versions

The snapshot is created before admission dispatch and never reads mutable pod, picker, workspace, branch, or agent-file state again. A pre-completion head check uses the provider and fails the completion gate when any member head changed.

Alternative rejected: re-resolve agent, model, context, or policy at each turn. That makes a resumed or long-running review depend on unrelated edits made after trigger and allows evidence and policy to drift inside one result.

### D4: Use a minimal bootstrap envelope with reopenable sections

Bootstrap has a fixed authoritative envelope and a collection of reopenable content sections. The fixed envelope contains the snapshot identity and SHAs, selected persona, criteria, thinking effort, context-control declaration, trust and citation rules, root policy, public-activity contract, current budget summary, and host tool schemas.

Reopenable sections contain normalized full linked-issue details and normalized full change-request details: metadata, title, body, commits, review discussion, labels, check summaries, and relationships. They exclude the patch and full CI logs. Each section has an identifier, digest, complete/truncated state, and retrieval cursor. Large sections contribute a bounded summary and retrieval reference to bootstrap; the exact details remain available through host tools.

The bootstrap builder counts tokens against the selected model. It first replaces reopenable content with references, then shortens non-normative descriptions without removing field identities or trust boundaries. If the minimum authoritative envelope still exceeds the input limit, no model request is made. The run fails with completeness `none`, a bootstrap-overflow limitation, and no claim of investigation.

All author-controlled text is wrapped as untrusted data with explicit source type and boundary. Model-visible host contracts never share a delimiter or authority channel with issue, change-request, commit, discussion, file, diff, or attachment content.

Alternative rejected: truncate the assembled bootstrap by bytes. A blind cut can remove source identity, a closing trust boundary, required tool schema, or completion rules and cannot truthfully say what survived.

### D5: Drive the harness through a typed model protocol

Each model turn returns a bounded protocol message rather than a final free-form review. The host accepts a discriminated union of:

- Public plan creation with stable plan-item identifiers
- Public plan revision referencing prior plan items and a concise public rationale
- Plan-item state changes
- Bounded tool requests
- Incremental candidate-finding submissions
- Checkpoint suggestion
- Completion request

One turn may include a bounded batch of compatible messages. The host validates the envelope before acting, dispatches only authorized operations, and returns sanitized result envelopes. Invalid messages consume a protocol-repair allowance. Raw model text is neither activity nor evidence and is discarded after parsing and metadata-only diagnostics.

The plan is public operational intent, not hidden reasoning. A plan item describes a subsystem or bounded task, such as "Inspect authorization changes". Public rationale describes why visible work changed, such as "A schema consumer was found in another member". The protocol never asks the model to reveal private chain-of-thought.

Alternative rejected: parse progress and findings from prose. Prose cannot safely distinguish public rationale, tool intent, evidence citations, and final findings, and it makes protocol repair nondeterministic.

Alternative rejected: mandate a planner model and a verifier model. The selected model and persona can perform separate phases. Deployments may later choose multiple models behind the same phase contract without changing product semantics.

### D6: Authorize a fixed host tool catalog

The initial tool catalog is host-owned and versioned:

| Tool | Required request scope | Result purpose |
| ------ | ------------------------ | ---------------- |
| `listChangedFiles` | Member, base/head, cursor | Complete changed-file inventory and metadata |
| `readDiff` | Member, path, base/head, bounded range or cursor | Exact changed evidence and inline anchors |
| `readFile` | Member, explicit base or head SHA, path, bounded line range | Revision-pinned supporting source |
| `searchRepository` | Member, explicit base or head SHA, query, path scope, cursor | Bounded unchanged or changed source discovery |
| `searchDiff` | Member, base/head, query, path scope, cursor | Bounded discovery inside changed content |
| `resolvePolicy` | Member, changed path | Applicable root-to-leaf base-revision `AGENTS.md` chain |
| `getChangeRequestDetails` | Member, section, cursor | Reopen normalized target details |
| `getIssueDetails` | Member, issue identity, section, cursor | Reopen normalized linked-issue details |
| `submitCandidateFinding` | Candidate plus source citations | Incremental schema and evidence validation |
| `requestCompletion` | Claimed coverage and unresolved-work summary | Advisory request evaluated by the host gate |

Every request passes path normalization, target membership, exact revision, capability, pagination, budget, cancellation, and phase checks before dispatch. A common result envelope reports `complete`, `paginated`, `truncated`, `unavailable`, `binary`, `tooLarge`, or `notFound`, plus continuation, real units, and sanitized error metadata where applicable.

Agent frontmatter remains prompt metadata only. It cannot add, remove, rename, configure, or grant a tool. The host may withhold a tool because the provider lacks a declared capability, but that limitation is visible before planning and affects completion truthfully.

Alternative rejected: expose arbitrary agent-declared tools. Agent files are repository-controlled untrusted input; treating frontmatter as authorization would let the reviewed repository expand network, file, and data access.

Alternative rejected: give the model a shell or unrestricted workspace search. Neither is revision-pinned or provider-neutral, and both exceed the minimum authority needed for review.

### D7: Extend provider contracts with explicit investigation capabilities

`ProviderCapabilities` gains a structured `reviewInvestigation` declaration rather than a collection of provider-id checks. It reports support and limits for manifests, diff reads, base/head file reads, repository search, diff search, issue details, change-request details, and pagination.

`Connection` gains neutral methods corresponding to provider-backed tools. Common request types always carry repository identity and explicit base/head or single revision. Common result types always carry snapshot identity, completeness, and normalized unavailable states. The existing whole-diff operation remains temporarily for migration and non-harness callers, then is removed from review execution.

GitLab, GitHub, and fixture providers implement the same conformance suite. A provider that cannot guarantee a capability declares it unavailable; neutral code never substitutes current branch data or infers completeness from a short response. Existing `ScmError.rateLimited` metadata supplies `Retry-After` or reset guidance to the dispatcher.

Root and nested `AGENTS.md` resolution uses repeated provider `readFile` operations at the base SHA. The host walks repository-root to changed-file directory, records explicit absence, merges policy in order, and caches by member/base/path. Policy is authoritative instruction but remains non-citable.

Alternative rejected: download a platform-specific review bundle. A monolithic bundle recreates the context-limit problem, prevents bounded retries, and pushes GitHub/GitLab shapes above the provider layer.

### D8: Record exact model-visible evidence in an immutable ledger

The in-memory ledger is append-only for an attempt. An evidence source contains:

```typescript
interface EvidenceSource {
  sourceId: string;
  digest: string;
  kind: 'diff' | 'file' | 'searchExcerpt' | 'attachment' | 'detail';
  repositoryId: string;
  baseSha: string;
  headSha: string;
  revision?: 'base' | 'head';
  path?: string;
  range?: { startLine: number; endLine: number };
  completeness: 'complete' | 'paginated' | 'truncated';
  citable: boolean;
  exactContent: string;
}
```

`sourceId` is stable inside the lineage and identifies one immutable payload; `digest` verifies the exact bytes. A resume may import a persisted source only when its exact content is retained and its digest and snapshot still match. Otherwise the new attempt refetches it and records a new source linked to the prior metadata. Findings store source identifier, digest, and location so validation never resolves against a later read by path alone.

Only exact evidence returned to the model is eligible. Bootstrap summaries, omitted pages, unavailable ranges, intent, and `AGENTS.md` policy cannot support findings. Explicit citable attachments from the context-controls change enter as `attachment` sources bound to their snapshot digest. Other repository reads are citable only as supporting source.

Diff evidence can establish a changed line as an inline primary target. Unchanged base/head evidence may corroborate behavior involving changed code but cannot become an unannounced primary target. An explicit attachment may be a primary out-of-diff target and follows the upstream summary-routing rule.

Alternative rejected: validate citations by refetching path and line at completion. A refetch proves what the host can see later, not what the model saw, and can silently validate a hallucination against changed content.

### D9: Validate candidate findings when submitted and again at completion

`submitCandidateFinding` validates schema, member identity, source identifiers, digests, locations, citable status, revision compatibility, primary-target eligibility, severity, confidence, and category. It returns accepted, repairable, or rejected with bounded public reasons. Accepted candidates retain provenance but remain provisional.

Synthesis groups candidates by primary location and semantic claim. Verification asks the same selected model/persona to challenge each claim against cited sources and search for contradiction. The host then reruns citation validation, applies deterministic deduplication, and records validation outcomes. An unresolved candidate, fetch, repair, or contradiction blocks complete status.

The existing parsing boundary moves from "parse one final JSON object" to "parse one protocol message". Existing criteria filtering remains a host operation after validation, not a model-controlled choice.

Alternative rejected: collect all findings only in the final response. Incremental validation discovers bad citations while investigation budget remains and gives checkpoints useful provisional state.

### D10: Treat coverage as inventory state, not model confidence

Coverage is computed per manifest member and per changed file. Each file moves through explicit states:

```text
unvisited -> classified -> inspected
                       -> excluded-by-policy
                       -> unavailable
                       -> binary
                       -> oversized
```

Classification records risk, logical unit, applicable policy identity, and the reason for any non-inspected terminal classification. Inspection requires model-visible diff evidence or an explicit non-text handling decision. Repository search does not add files to the changed inventory and cannot satisfy changed-file inspection.

The model proposes risk and logical units. The host applies mandatory risk floors from manifest facts and policy, such as sensitive paths, dependency manifests, permission changes, generated files, binary files, and cross-member contracts. Configured coverage rules define which risk levels require full diff inspection, supporting reads, and contradiction checks.

Progress denominators come only from complete inventories or explicit plan-item counts. Before manifest exhaustion, the UI shows known units and indeterminate inventory progress. After exhaustion, it may show files classified out of total and required files inspected out of required total. Percentages never estimate remaining model time.

Alternative rejected: use token consumption or model turn count as progress. Both measure cost, not review coverage, and neither has a truthful completion denominator.

### D11: Make completion a deterministic host gate

The model's `requestCompletion` message triggers this predicate:

```text
headUnchanged
AND inventoryCompleteForEveryMember
AND everyFileClassified
AND configuredRiskCoverageSatisfied
AND unresolvedFetches = 0
AND unresolvedCandidates = 0
AND everyRetainedCitationValid
AND contradictionPassComplete
AND deduplicationComplete
AND finalVerificationComplete
```

If the predicate passes, zero validated findings produces a complete clean review and one or more produces a complete findings review. If it fails and validated findings remain, the run persists a partial result plus coverage and limitation report. If it fails with no retainable finding, the run fails with completeness `none`. Cancellation may preserve already validated findings only as partial and never replace a complete retained review.

Unavailable oversized patches, incomplete provider inventories, exhausted budgets, timeouts, provider limits, and changed heads are named completion blockers. A repairable early completion request returns bounded missing conditions when enough reserved budget remains; otherwise the run finalizes truthfully.

Alternative rejected: trust the model's assertion that review is complete. The model cannot know about provider truncation, stale head, unresolved host candidates, or budget reserves unless the host evaluates them.

### D12: Enforce hierarchical budgets with reserved capacity and bounded retry

A versioned `HarnessPolicy` contains global concurrency plus per-run, phase, turn, tool, evidence, elapsed-time, retry, and persistence limits. Dispatch atomically reserves from the narrowest applicable budgets before work starts and reconciles actual usage afterwards. Cancellation prevents new reservations and propagates to active work.

At admission, investigation budget is partitioned into ordinary work, unvisited/high-risk reserve, and final-verification reserve. Ordinary planning cannot consume reserves. Once the ordinary pool is exhausted, only qualifying high-risk coverage and finalization operations continue.

Transient network, rate-limit, and provider failures use bounded retry. Provider `Retry-After` or reset metadata takes precedence; otherwise exponential backoff with jitter applies under the elapsed-time budget. Protocol repair has a separate limit and never retries tool side effects. `submitCandidateFinding` and read tools are idempotent by request identifier.

A long backoff moves the run to `waiting`, checkpoints it, and releases its global execution slot. When eligible, it returns through `resuming` without losing target ownership or queue fairness. Budget exhaustion emits a limitation and proceeds only to allowed validation and persistence work.

Alternative rejected: one token budget shared by all work. It permits early low-risk exploration to consume the resources needed for untouched high-risk files and verification.

### D13: Persist sanitized checkpoints, not live sessions

`HarnessRunStore` uses bounded workspace storage and records:

- Snapshot and policy versions, run and lineage identifiers, attempt number, and lifecycle
- Current public plan and plan revision history
- Compact sanitized activity and current projection
- Checkpoint phase and continuation metadata
- Evidence metadata, source identifiers, digests, and only exact excerpts required by retained citations or checkpoint compatibility
- Candidate and validated findings with validation state
- Budget consumption, reserves, inventory, coverage, retries, and unresolved-work counts

It never records raw prompts, raw model fragments, hidden reasoning, secrets, full tool arguments, full output blobs, cancellation handles, model stream handles, or provider clients. `AgentTrace` remains a separate diagnostic channel but records only request identifiers, model identity, phase, byte/token counts, timings, digests, error codes, and redacted summaries.

Activation closes every persisted nonterminal attempt as `interrupted` before rendering. Resume creates a new attempt in the same lineage only when checkpoint version, digest integrity, repository identity, head SHA, model, resolved agent instructions, criteria, effort, context controls, policy, provider capabilities, and required evidence are compatible. The UI lists every incompatibility and offers restart. No code path labels the new request as a reconnected stream.

Compaction preserves terminal transitions, plan revisions, failures, checkpoints, coverage changes, and result events. It may coalesce routine repeated tool-progress events while keeping aggregate counts and first/last timestamps. If eviction removes data required to validate citations or resume, the checkpoint becomes incompatible rather than silently weaker.

Alternative rejected: serialize the full model conversation. It retains prohibited content, grows without a practical bound, and still cannot recreate an external stream or guarantee provider state.

### D14: Derive every surface from one run projection

The activity reducer produces `RunProjection` with lifecycle, completeness, phase, current public action, sanitized target, elapsed time, progress mode, progress units, coverage summary, active plan item, attention state, latest checkpoint, limitations, and result summary.

`ReviewRunManager.subscribe` continues as the fan-out. The active review panel renders full plan and activity. Sidebar and status bar render compact current action and truthful determinate or indeterminate progress. Dashboard rows render target state and coverage summary. Retained/completed details render plan history, compact activity, coverage, limitations, lineage, attempts, and result completeness. All surfaces use provider vocabulary supplied by their existing state builders.

Routine plan, tool, coverage, and checkpoint events repaint but do not notify. Complete, partial, failed, cancelled, interrupted, and reviewer-attention states use the existing notification owner with outcome-specific text. State transitions bypass progress throttling; high-frequency elapsed or token counters may be throttled without delaying terminal events.

Activity event storage is an ordered typed union with common `runId`, `lineageId`, `attempt`, `sequence`, `occurredAt`, `phase`, and `elapsedMs`. Event payloads cover plan created/revised, plan-item state, public rationale, phase/action start, tool completion/failure summary, coverage, checkpoint, waiting, pause, resume, cancellation, partial result, and terminal result. Plan revisions append and stable plan-item identifiers survive edits.

Alternative rejected: let each screen translate internal manager state independently. The current compact screens already need different subsets; separate translation would make percentages, current action, and partial status disagree.

### D15: Allocate changeset work per member before shared analysis

A changeset snapshot contains one member snapshot per repository and one shared lineage. Manifest exhaustion, head stability, coverage, evidence identity, and completion are evaluated per member, then aggregated. Every member receives minimum model turns, tool calls, evidence bytes, and high-risk reserve before the shared pool is available.

The public plan contains member-scoped logical units plus optional shared units. Shared cross-member investigation can cite sources from several members, but each source retains its own repository and base/head identity. A finding chooses one changed or explicit-attachment primary target and may carry supporting spans in other members. One incomplete member prevents a complete or clean changeset result.

Alternative rejected: concatenate members and apply one global budget in trigger order. The first large member can starve later members while the UI still claims the changeset was reviewed as one unit.

### D16: Preserve retained reviews and posting while versioning legacy provenance

Existing retained reviews, triage drafts, submitted reviews, one-active-run-per-target rules, and posting contracts remain. New partial findings are stored beside, not over, the last complete retained review and cannot be submitted as a complete review. A later complete harness result replaces the retained review through the existing write-before-notify path.

Historical successful reviews without harness fields are read as complete under `legacy-one-shot` protocol provenance. The UI does not invent plan, evidence, or coverage data for them and states that detailed harness coverage is unavailable. This preserves the result the reviewer already accepted without claiming it passed the new completion gate.

The context-controls attachment rule remains: an explicit out-of-diff attachment finding can be validated but routes to the summary; an attachment that is also a changed diff path can anchor inline. Thinking effort, criteria, agent, model, and context controls are snapshot inputs for every initial review and rerun.

Alternative rejected: demote all historical reviews to partial. That would rewrite past user-visible outcomes and retained-review precedence even though no new evidence can improve or invalidate them retroactively.

## Risks / Trade-offs

- [Provider APIs cannot guarantee complete manifests on every platform] -> Providers report explicit incomplete states; the host returns partial or failed rather than clean and conformance tests cover limits.
- [Tool-driven reviews make more model and provider requests than one-shot reviews] -> Small reviews use the same state machine with batched bounded reads; caches, pagination, conditional provider requests, and hierarchical budgets limit cost.
- [Public activity can accidentally expose model text or source content] -> Activity accepts only typed sanitized payloads, diagnostic trace becomes metadata-only, and tests inject secrets and raw fragments to verify omission.
- [A model can loop on tools or repeatedly repair malformed protocol] -> Per-turn, per-tool, per-run, elapsed, retry, and repair limits stop dispatch and produce a truthful limitation.
- [Checkpoint persistence can exceed workspace storage] -> Exact numeric bounds, event compaction, terminal retention, and compatibility invalidation keep storage bounded without weakening evidence silently.
- [Resume can look like continuity even though the model starts over] -> Attempt boundaries are public, the old attempt is interrupted, and resume language says "new attempt from checkpoint" rather than "reconnected".
- [Risk classification can miss a sensitive file] -> Host risk floors use manifest and policy facts, every file still receives a classification, and reserves protect unvisited/high-risk work.
- [Unchanged repository search can expand scope without limit] -> Search is bounded and revision-pinned; unchanged evidence corroborates changed behavior but cannot become an unselected primary target.
- [Cancellation may not stop a provider or model immediately] -> Dispatch stops synchronously, the slot is released, host cancellation propagates, late results are ignored, and sanitized prior activity remains.
- [Legacy and harness results have different assurance] -> Protocol provenance is visible and no coverage is fabricated for legacy results.
- [Provider conformance work is broad] -> Neutral request/result fixtures and one shared contract suite are completed before UI migration, keeping platform differences below `src/platform/`.

## Migration Plan

1. Implement additive domain types, activity reduction, evidence metadata, policy objects, and bounded workspace persistence. Existing records deserialize with `legacy-one-shot` provenance and no fabricated activity.
2. Extend neutral provider capabilities and `Connection` with manifest, pinned reads, searches, and normalized detail retrieval. Implement fixture, GitLab, and GitHub contracts and conformance tests before harness activation.
3. Implement the harness engine, typed model protocol, tool dispatcher, evidence ledger, coverage tracker, completion gate, retries, checkpoints, and deterministic demo participant behind manager injection. During development, tests may inject the old runner only as a fixture; no shipped runtime setting exposes a bypass.
4. Integrate `add-context-controls-and-thinking-effort`: snapshot its controls, register explicit attachments as citable sources, preserve intent as non-citable, and remove the byte-identical prompt compatibility assertion that the universal harness supersedes.
5. Replace `ReviewRunManager` one-shot execution with harness attempts for individual reviews, reruns, changesets, built-in and discovered agents, and the demo agent. Preserve one-active-run-per-target admission, global FIFO concurrency, cancellation, write-before-notify ordering, and retained-review precedence.
6. Add shared activity projections to the active review, sidebar, dashboard, status bar, retained run details, and notification policy. Remove fixed fake step logs and fragment-count progress from user-facing state.
7. Convert diagnostic tracing to metadata-only output and add redaction tests. Remove raw prompt and raw response writes before enabling the harness.
8. On first activation after upgrade, mark legacy nonterminal records interrupted. Offer checkpoint resume only for new harness records that pass compatibility; legacy interrupted runs offer restart.
9. Run unit, protocol, provider conformance, lifecycle, persistence, restart, adversarial trust-boundary, large-review, changeset fairness, UI projection, integration, lint, build, and manual emulator validation.

Rollback keeps additive stored fields and legacy provenance readable. An older build ignores harness-only activity and checkpoint records, while complete retained reviews and triage drafts keep their existing keys. Partial harness results are stored separately and therefore cannot overwrite a retained complete review during rollback.

## Configurable Initial Defaults

These values initialize `HarnessPolicy` and bounded persistence. They are configuration, not normative product semantics; tests use injected policies and provider limits may lower page sizes.

| Policy | Initial default |
| -------- | ----------------- |
| Global active-run concurrency | Preserve current default of 3; 0 remains unlimited |
| Maximum elapsed time per attempt | 30 minutes |
| Maximum model turns per attempt | 64 |
| Maximum tool requests per attempt | 256 |
| Maximum tool requests in one model turn | 8 |
| Maximum exact content returned by one tool result | 64 KiB |
| Maximum in-memory evidence content per attempt | 8 MiB |
| Manifest page size | 100 files |
| Diff or file-read page | 400 lines and 64 KiB, whichever comes first |
| Search result page | 50 matches and 64 KiB, whichever comes first |
| Transient retries per operation | 3 after the initial attempt |
| Protocol repairs per phase | 2 |
| Backoff without provider guidance | Exponential from 1 second, capped at 30 seconds, with jitter |
| Unvisited/high-risk investigation reserve | 20 percent of model turns, tool calls, and evidence bytes |
| Final verification reserve | 15 percent of model turns, tool calls, and evidence bytes |
| Changeset minimum per member | 1 model turn, 4 tool calls, and 128 KiB evidence before shared allocation |
| Checkpoint cadence | Every phase boundary and every 10 completed tool calls |
| Retained checkpoints per lineage | 3 |
| Sanitized activity per attempt | 1,000 events or 1 MiB, whichever comes first |
| Persisted checkpoint data per lineage | 8 MiB |
| Terminal attempt history per target | 5 attempts or 30 days, whichever removes an attempt first |

The settings surface exposes reviewer-relevant run time, request, evidence, and retention limits. Internal page sizes and compaction thresholds remain injected policy values so provider conformance tests and future platform limits can override them without changing requirements.

## Open Questions

- Tune host risk-floor rules and the initial high-risk path set against captured large-review fixtures. The requirement that every file is classified and configured high-risk coverage is enforced does not depend on the initial rule weights.
- Choose whether retained activity shows full plan snapshots or a compact revision diff after usability testing. Both preserve ordered revisions and stable plan-item identifiers.
- Calibrate provider-specific page sizes below the neutral maxima after measuring GitLab and GitHub API behavior. Providers must still report the actual bound and completeness state.
