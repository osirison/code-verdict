/**
 * The real `ReviewHarnessFactory` (task 15.7 of `add-agentic-review-harness`,
 * the runtime cutover): turns a `RunInput` (`reviewRunManager.ts`) into a
 * live `HarnessAttempt` (`harnessAttempt.ts`), wiring every collaborator
 * built and tested in sections 1-14 into place for the first time. Nothing
 * here re-implements a dispatcher, a ledger, a budget tracker, a completion
 * gate, or a checkpoint format — this module is assembly, matching the
 * change's own "REUSE, DO NOT REINVENT" instruction.
 *
 * **Deliberately `vscode`-free**, like the rest of `src/app`: every piece
 * that actually touches the editor API (`vscode.lm`, `vscode.SecretStorage`)
 * arrives already wrapped — `connectionForPod` (`./connections.ts`) and
 * `getProvider` (`../platform/registry.ts`) are already vscode-free
 * application-layer modules (the session bridge and provider registration
 * are injected elsewhere, at activation); `discoverModel`/`countTokens`/
 * `runTurn` are injected closures production wiring (`extension.ts`) builds
 * over `./lmAgent.ts`. This module never imports `vscode` itself.
 *
 * **`ReviewHarnessFactory.create`/`.createDemo` are synchronous** (D1), but
 * assembling a `ReviewRunSnapshot` is not: resolving a pod's live
 * `Connection`, discovering the selected model's declared capability, and
 * walking each member's root `AGENTS.md` chain all need I/O. So `create`/
 * `.createDemo` return a `HarnessAttempt` whose own `run()` does all of that
 * assembly first and *then* drives `createHarnessAttempt(...).run()` —
 * exactly `HarnessAttempt`'s own contract (`{run(): Promise<...>}`), so a
 * failure anywhere in assembly (pod gone, model no longer available, a
 * connection that rejects) rejects `run()` the same way a failure inside the
 * attempt itself would, and `ReviewRunManager.executeAttempt`'s existing
 * catch-block classification settles the record as `failed` — truthfully,
 * with no fallback to the deprecated one-shot path (task 10.8).
 *
 * **One `Connection` per run, shared across every member.** `RunInput.podId`
 * names exactly one pod for the whole target (single CR or whole changeset)
 * — every member's repository lives on that same provider instance under
 * the same credential, so one `connectionForPod` call per run is correct,
 * never one per member.
 *
 * **Checkpoints actually get written.** `onCheckpoint` below does two
 * things every time the attempt reports one: tells the manager (via
 * `options.onCheckpoint`, `HarnessAttemptRunOptions`'s own reporting
 * surface — lifecycle/projection bookkeeping only) and persists a real
 * `PersistedCheckpoint` through `harnessRunStore.buildAndWriteCheckpoint`
 * (`./harnessRunStore.ts`, task 11.1/11.2's own funnel). The immutable
 * snapshot itself is written once, before the first checkpoint can fire
 * (`harnessRunStore.writeSnapshot`), so `harnessResume.ts`'s compatibility
 * checks and the activation sweep (`sweepInterruptedRuns`) have a real
 * snapshot and real checkpoints to read on the next activation — neither
 * had any production data before this pass.
 */
import { DEFAULT_HARNESS_POLICY, type HarnessPolicy } from '../domain/harnessPolicy';
import { DEFAULT_RISK_COVERAGE_RULES, type RiskCoverageRules } from './harnessRiskFloors';
import type { ChangeRequestRef } from '../platform/types';
import type { Connection, ProviderCapabilities } from '../platform/provider';
import { getProvider } from '../platform/registry';
import type { ModelDescriptor } from './agents';
import type { AttachmentWarning, RevalidatedAttachments } from './attachments';
import { createAgentsPolicyResolver, rootAgentsPolicySourceFor, type AgentsPolicyMemberRef } from './harnessAgentsPolicy';
import {
  createHarnessAttempt,
  type CheckpointInfo,
  type HarnessAttempt,
  type HarnessAttemptMemberInput,
  type HarnessAttemptOptions,
} from './harnessAttempt';
import { computeSnapshotDigest } from './harnessCheckpoint';
import { createDemoModelSeam } from './harnessDemoParticipant';
import { decideResume, ResumeIncompatibleError } from './harnessResume';
import { createLiveModelSeam } from './harnessModelSeam';
import type { HarnessRunStore } from './harnessRunStore';
import { createSynthesisVerification } from './harnessSynthesisVerification';
import type { RunAgentOptions } from './lmAgent';
import { connectionForPod } from './connections';
import type { PodStore } from './pods';
import type { Attachment, ReviewContext } from './reviewContext';
import type {
  HarnessAttemptRunOptions,
  ReviewHarnessFactory,
  RunInput,
} from './reviewRunManager';
import { buildReviewRunSnapshot, type ReviewRunSnapshotMemberInput } from './reviewRunSnapshotBuilder';
import type { SecretStore } from './storage';
import type { AttemptNumber, LineageId, RunId } from '../domain/harnessLifecycle';

export interface HarnessRuntimeDeps {
  readonly podStore: PodStore;
  readonly secrets: SecretStore;
  /** Resolves one already-selected model id to its declared capability; `undefined` when the model is no longer available. */
  readonly discoverModel: (modelId: string) => Promise<ModelDescriptor | undefined>;
  readonly countTokens: (modelId: string, text: string) => Promise<number | undefined>;
  /** One harness protocol turn — production wiring passes `runHarnessModelTurn` (`./lmAgent.ts`). */
  readonly runTurn: (modelId: string, prompt: string, options?: RunAgentOptions) => Promise<string>;
  /**
   * Re-reads filesystem-backed attachments at run start (parity with the
   * pre-harness demo/lm runners, both of which did this before executing).
   * Injected, never imported directly: `./attachments.ts` imports `vscode`
   * at module scope, and this module must stay loadable outside the
   * extension host for its own tests — production wiring
   * (`extension.ts`) passes the real `revalidateAttachments`.
   */
  readonly revalidateAttachments: (attachments: readonly Attachment[]) => Promise<RevalidatedAttachments>;
  readonly harnessRunStore: HarnessRunStore;
  /**
   * Read fresh for every attempt this factory builds (`buildHarnessAttempt`
   * reads it once per call, never caches it) — task 17.1/17.2's settings
   * reach a running extension without a reload: production wiring
   * (`extension.ts`) passes a getter over `readHarnessPolicy()`
   * (`../ui/harnessPolicyOptions.ts`), so a setting a reviewer changes
   * applies to the next attempt it builds, while an attempt already running
   * keeps the policy snapshotted into it when it started (`HARNESS_POLICY_VERSION`'s
   * own doc comment).
   */
  readonly policy?: HarnessPolicy;
  /** Same freshness contract as `policy` above; production wiring passes a getter over `readHarnessCoverageRules()`. */
  readonly riskCoverageRules?: RiskCoverageRules;
  /** Epoch milliseconds; defaults to `Date.now`. Injected for deterministic tests, matching every other clock in this change. */
  readonly now?: () => number;
}

function memberIdFor(ref: ChangeRequestRef): string {
  return `${ref.repoId}!${ref.number}`;
}

interface RawMember {
  readonly memberId: string;
  readonly ref: ChangeRequestRef;
  readonly baseSha: string;
  readonly headSha: string;
  readonly context?: ReviewContext;
  readonly attachments?: readonly Attachment[];
}

function rawMembersFrom(input: RunInput): readonly RawMember[] {
  if (input.target.kind === 'cr') {
    return [
      {
        memberId: memberIdFor(input.target.ref),
        ref: input.target.ref,
        baseSha: input.target.baseSha,
        headSha: input.target.headSha,
        context: input.target.reviewContext,
        attachments: input.target.attachments,
      },
    ];
  }
  return input.target.members.map((member) => ({
    memberId: memberIdFor(member.ref),
    ref: member.ref,
    baseSha: member.baseSha,
    headSha: member.headSha,
    context: member.context,
    attachments: member.attachments,
  }));
}

interface ResolvedPod {
  readonly connection: Connection;
  readonly capabilities: ProviderCapabilities;
  readonly providerId: string;
  readonly instanceUrl: string;
}

async function resolvePod(deps: HarnessRuntimeDeps, podId: string): Promise<ResolvedPod> {
  const pod = deps.podStore.list().find((candidate) => candidate.id === podId);
  if (!pod) throw new Error(`Verdict: the pod this review was started under no longer exists.`);
  const connection = await connectionForPod(pod, deps.secrets);
  return { connection, capabilities: getProvider(pod.providerId).capabilities, providerId: pod.providerId, instanceUrl: pod.instanceUrl };
}

/** Revalidates one member's explicit attachments (parity with the pre-harness demo/lm runners — both reported filesystem-backed drops before executing) and reports warnings through the manager's own reporting surface. */
async function revalidateMemberAttachments(
  deps: HarnessRuntimeDeps,
  members: readonly RawMember[],
  onWarnings: (warnings: readonly AttachmentWarning[]) => void,
): Promise<readonly RawMember[]> {
  const results = await Promise.all(
    members.map(async (member) => {
      if (!member.attachments || member.attachments.length === 0) return { member, warnings: [] as AttachmentWarning[] };
      const revalidated = await deps.revalidateAttachments(member.attachments);
      return { member: { ...member, attachments: revalidated.attachments }, warnings: revalidated.warnings };
    }),
  );
  const warnings = results.flatMap((result) => result.warnings);
  if (warnings.length > 0) onWarnings(warnings);
  return results.map((result) => result.member);
}

interface CandidateAssembly {
  readonly pod: ResolvedPod;
  readonly revalidatedMembers: readonly RawMember[];
  readonly snapshot: ReturnType<typeof buildReviewRunSnapshot>;
}

/**
 * Resolves every member's live `Connection` and root `AGENTS.md` identity and builds this
 * attempt's `ReviewRunSnapshot` — shared by `create`/`createDemo` (a fresh lineage at attempt 1)
 * and `resume` (the *candidate* snapshot `decideResume` below compares against a stored one, at
 * `options.identity`'s already-next attempt number in an *existing* lineage). Never writes it:
 * `create`/`createDemo` write immediately: no compatibility to check first. `resume` writes only
 * after `decideResume` accepts it — see `resume`'s own doc comment for why.
 */
async function buildCandidateAssembly(
  deps: HarnessRuntimeDeps,
  input: RunInput,
  options: HarnessAttemptRunOptions,
  demo: boolean,
): Promise<CandidateAssembly> {
  const now = deps.now ?? (() => Date.now());

  const pod = await resolvePod(deps, input.podId);
  const revalidatedMembers = await revalidateMemberAttachments(deps, rawMembersFrom(input), options.onAttachmentWarnings);

  const agentsPolicyResolver = createAgentsPolicyResolver(() => pod.connection, { capabilities: () => pod.capabilities });
  const rootPolicies = await Promise.all(
    revalidatedMembers.map(async (member): Promise<ReturnType<typeof rootAgentsPolicySourceFor>> => {
      const ref: AgentsPolicyMemberRef = { memberId: member.memberId, repoId: member.ref.repoId, baseSha: member.baseSha, headSha: member.headSha };
      const chain = await agentsPolicyResolver.resolveChain(ref, '');
      return rootAgentsPolicySourceFor(chain);
    }),
  );

  const model = demo || input.modelId === undefined ? undefined : await deps.discoverModel(input.modelId);
  if (!demo && model === undefined) {
    throw new Error(`Verdict: the selected model "${input.modelId ?? ''}" is no longer available.`);
  }

  const snapshotMembers: ReviewRunSnapshotMemberInput[] = revalidatedMembers.map((member, index) => ({
    memberId: member.memberId,
    providerId: pod.providerId,
    instanceUrl: pod.instanceUrl,
    ref: member.ref,
    baseSha: member.baseSha,
    headSha: member.headSha,
    capabilities: pod.capabilities,
    rootAgentsPolicy: rootPolicies[index]!,
    context: member.context,
    attachments: member.attachments,
  }));

  const snapshot = buildReviewRunSnapshot({
    runId: options.identity.runId,
    lineageId: options.identity.lineageId,
    attempt: options.identity.attempt,
    createdAt: new Date(now()).toISOString(),
    targetKind: input.target.kind,
    changesetId: input.target.kind === 'changeset' ? input.target.changesetId : undefined,
    members: snapshotMembers,
    agent: input.agent,
    model,
    effort: input.effort,
    criteria: input.criteria,
  });

  return { pod, revalidatedMembers, snapshot };
}

/**
 * Builds the live `HarnessAttempt` from an already-written snapshot — the second half both
 * `assembleAttempt` and `resume` share once they have one, with `resumeSeed` threaded through only
 * on the resume path.
 */
function buildHarnessAttempt(
  deps: HarnessRuntimeDeps,
  options: HarnessAttemptRunOptions,
  assembly: CandidateAssembly,
  demo: boolean,
  resumeSeed: HarnessAttemptOptions['resumeSeed'],
): HarnessAttempt {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const policy = deps.policy ?? DEFAULT_HARNESS_POLICY;
  const riskCoverageRules = deps.riskCoverageRules ?? DEFAULT_RISK_COVERAGE_RULES;
  const { pod, revalidatedMembers, snapshot } = assembly;

  const modelSeam = demo
    ? createDemoModelSeam(snapshot)
    : createLiveModelSeam({
        modelId: snapshot.modelId!,
        runTurn: (prompt) => deps.runTurn(snapshot.modelId!, prompt, {
          cancellation: options.cancellation,
          timeouts: options.timeouts,
        }),
      });

  const attemptMembers: HarnessAttemptMemberInput[] = revalidatedMembers.map((member) => ({
    memberId: member.memberId,
    connection: pod.connection,
    capabilities: pod.capabilities,
    attachments: member.attachments,
  }));

  const onCheckpoint = async (info: CheckpointInfo): Promise<void> => {
    options.onCheckpoint(info);
    await deps.harnessRunStore.buildAndWriteCheckpoint(
      {
        checkpointId: info.checkpointId,
        runId: info.runId as RunId,
        lineageId: info.lineageId as LineageId,
        attempt: info.attempt as AttemptNumber,
        phase: info.phase,
        reason: info.reason,
        occurredAt: info.occurredAt,
        elapsedMs: info.elapsedMs,
        snapshotDigest: computeSnapshotDigest(snapshot),
        activityEvents: info.activityLog.events,
        evidenceSources: info.evidenceSources,
        candidates: info.candidates,
        contradicted: info.contradicted,
        budget: info.budget,
        coverage: info.coverage,
        unresolved: info.unresolved,
      },
      policy,
    );
  };

  return createHarnessAttempt({
    snapshot,
    members: attemptMembers,
    modelSeam,
    policy,
    riskCoverageRules,
    cancellation: options.cancellation,
    clock: () => now() - startedAt,
    now: () => new Date(now()).toISOString(),
    countTokens: demo ? undefined : (text: string) => deps.countTokens(snapshot.modelId!, text),
    // Never the honest no-op default: `harnessDemoParticipant.ts`'s own doc comment says the demo
    // seam is designed to be paired with this real collaborator (it recognizes and answers its
    // contradiction-check directive) — the no-op default reports every verification pass
    // incomplete, which would make even a clean demo review unable to ever reach `complete`.
    synthesisVerification: createSynthesisVerification(),
    onCheckpoint,
    retry: {
      onEnterWaiting: () => options.onEnterWaiting?.(),
      onResuming: () => options.onResuming?.(),
    },
    resumeSeed,
  });
}

/**
 * Assembles a `ReviewRunSnapshot` and builds one `HarnessAttempt` — the async work
 * `ReviewHarnessFactory`'s own synchronous `create`/`createDemo` cannot do inline (see this file's
 * own header). A fresh lineage, always attempt 1 (`options.identity`, minted by the manager's own
 * `trigger()`): nothing to compare against, so the snapshot is written immediately.
 */
async function assembleAttempt(deps: HarnessRuntimeDeps, input: RunInput, options: HarnessAttemptRunOptions, demo: boolean): Promise<HarnessAttempt> {
  const assembly = await buildCandidateAssembly(deps, input, options, demo);
  // Written before the first checkpoint can fire — `harnessResume.ts`'s compatibility checks and
  // the activation sweep (`sweepInterruptedRuns`) both need a stored snapshot to check a checkpoint
  // against.
  await deps.harnessRunStore.writeSnapshot(assembly.snapshot);
  return buildHarnessAttempt(deps, options, assembly, demo, undefined);
}

/**
 * Task 14.6: resumes the lineage at `options.identity.lineageId` — the manager has already read
 * `runId`/`lineageId` and computed `options.identity.attempt` as one past the lineage's last
 * checkpoint (`ReviewRunManager.resumeRun`'s own doc comment). Never called for a demo run: a
 * deterministic script has nothing worth resuming, and `ReviewRunManager` never offers it one.
 *
 * Builds this attempt's *candidate* snapshot the ordinary way (`buildCandidateAssembly`, the same
 * ordinary live I/O `create` does — the reviewer's current pod, model, criteria), reads the
 * lineage's stored snapshot and last checkpoint, and asks `decideResume` whether the two agree.
 *
 * Incompatible: throws `ResumeIncompatibleError` with every failing reason — *before*
 * `writeSnapshot`, so an attempt that will not start never litters the store with a snapshot for
 * it. `ReviewRunManager.executeAttempt`'s catch block turns this into a `failed` `RunRecord`
 * carrying every reason as `limitations`; the lineage's own `resumable` offer is untouched (see
 * `ResumeIncompatibleError`'s own doc comment) — the reviewer can undo whatever changed and try
 * again, or restart as an ordinary fresh `trigger()`.
 *
 * Compatible: writes the candidate snapshot (a resume-of-a-resume needs it stored too, same
 * ordering as `create`), then builds the attempt seeded with `decideResume`'s payload and start
 * narrative (`harnessAttempt.ts`'s own `HarnessAttemptOptions.resumeSeed` doc comment covers what
 * each piece does). The lost attempt itself is not re-closed here: the activation sweep
 * (`sweepInterruptedRuns`) already closed it as `interrupted` before this ever runs, and
 * `latestCheckpoint` below reads exactly that closed checkpoint.
 */
async function assembleResumeAttempt(deps: HarnessRuntimeDeps, input: RunInput, options: HarnessAttemptRunOptions): Promise<HarnessAttempt> {
  const lineageId = options.identity.lineageId;
  const storedCheckpoint = deps.harnessRunStore.latestCheckpoint(lineageId);
  const storedSnapshot = storedCheckpoint ? deps.harnessRunStore.readSnapshot(lineageId, storedCheckpoint.attempt) : undefined;
  if (!storedCheckpoint || !storedSnapshot) {
    throw new ResumeIncompatibleError([{ code: 'noCheckpoint', message: 'No checkpoint was found for this run to resume from.' }]);
  }

  const assembly = await buildCandidateAssembly(deps, input, options, false);
  const decision = decideResume({ storedSnapshot, checkpoint: storedCheckpoint, candidateSnapshot: assembly.snapshot });
  if (decision.kind === 'incompatible') throw new ResumeIncompatibleError(decision.reasons);

  await deps.harnessRunStore.writeSnapshot(assembly.snapshot);
  return buildHarnessAttempt(deps, options, assembly, false, { payload: decision.payload, startAction: decision.startAction });
}

/** Builds the real `ReviewHarnessFactory` (D1) that `extension.ts` hands `ReviewRunManager`. */
export function createReviewHarnessFactory(deps: HarnessRuntimeDeps): ReviewHarnessFactory {
  return {
    create(input, options) {
      return { run: () => assembleAttempt(deps, input, options, false).then((attempt) => attempt.run()) };
    },
    createDemo(input, options) {
      return { run: () => assembleAttempt(deps, input, options, true).then((attempt) => attempt.run()) };
    },
    resume(input, options) {
      return { run: () => assembleResumeAttempt(deps, input, options).then((attempt) => attempt.run()) };
    },
  };
}
