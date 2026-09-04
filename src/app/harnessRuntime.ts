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
import type { ChangeRequestRef } from '../platform/types';
import type { Connection, ProviderCapabilities } from '../platform/provider';
import { getProvider } from '../platform/registry';
import type { ModelDescriptor } from './agents';
import type { AttachmentWarning, RevalidatedAttachments } from './attachments';
import { createAgentsPolicyResolver, rootAgentsPolicySourceFor, type AgentsPolicyMemberRef } from './harnessAgentsPolicy';
import { createHarnessAttempt, type CheckpointInfo, type HarnessAttempt, type HarnessAttemptMemberInput } from './harnessAttempt';
import { computeSnapshotDigest } from './harnessCheckpoint';
import { createDemoModelSeam } from './harnessDemoParticipant';
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
  readonly policy?: HarnessPolicy;
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
        baseSha: input.target.diff.baseSha,
        headSha: input.target.diff.headSha,
        context: input.target.reviewContext,
        attachments: input.target.attachments,
      },
    ];
  }
  return input.target.members.map((member) => ({
    memberId: memberIdFor(member.ref),
    ref: member.ref,
    baseSha: member.diff.baseSha,
    headSha: member.diff.headSha,
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

/**
 * Assembles a `ReviewRunSnapshot`, resolves every member's live `Connection`
 * and root `AGENTS.md` identity, and builds one `HarnessAttempt` — the async
 * work `ReviewHarnessFactory`'s own synchronous `create`/`createDemo` cannot
 * do inline (see this file's own header).
 */
async function assembleAttempt(deps: HarnessRuntimeDeps, input: RunInput, options: HarnessAttemptRunOptions, demo: boolean): Promise<HarnessAttempt> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const policy = deps.policy ?? DEFAULT_HARNESS_POLICY;

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
    createdAt: new Date(startedAt).toISOString(),
    targetKind: input.target.kind,
    changesetId: input.target.kind === 'changeset' ? input.target.changesetId : undefined,
    members: snapshotMembers,
    agent: input.agent,
    model,
    effort: input.effort,
    criteria: input.criteria,
  });

  // Written before the first checkpoint can fire — `harnessResume.ts`'s compatibility checks and
  // the activation sweep (`sweepInterruptedRuns`) both need a stored snapshot to check a checkpoint
  // against.
  await deps.harnessRunStore.writeSnapshot(snapshot);

  const modelSeam = demo
    ? createDemoModelSeam(snapshot)
    : createLiveModelSeam({
        modelId: snapshot.modelId!,
        runTurn: (prompt) => deps.runTurn(snapshot.modelId!, prompt, {
          cancellation: options.cancellation,
          timeouts: options.timeouts,
          onProgress: options.onProgress,
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
  });
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
  };
}
