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
import type { Connection, MemberCapabilities, ProviderCapabilities } from '../platform/provider';
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
import { createLiveModelSeam, type EnforcedPrompt } from './harnessModelSeam';
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
import type { ReviewRunInvestigationSource } from '../domain/reviewRunSnapshot';
import { refusingInvestigationSource, selectInvestigationSource, type InvestigationSourceSelection } from './investigationSourceSelection';
import type { ObjectCache } from '../localgit/objectAcquisition';
import type { CacheLease } from '../localgit/objectCache';
import type { InvestigationSource, InvestigationSourceCapabilities } from '../platform/types';
import type { Limitation } from '../domain/harnessActivity';
import type { ActivityFact } from './harnessActivityLog';
import type { SecretStore } from './storage';
import type { AttemptNumber, LineageId, RunId } from '../domain/harnessLifecycle';

export interface HarnessRuntimeDeps {
  readonly podStore: PodStore;
  readonly secrets: SecretStore;
  /** Resolves one already-selected model id to its declared capability; `undefined` when the model is no longer available. */
  readonly discoverModel: (modelId: string) => Promise<ModelDescriptor | undefined>;
  readonly countTokens: (modelId: string, text: string) => Promise<number | undefined>;
  /**
   * One harness protocol turn — production wiring passes `runHarnessModelTurn` (`./lmAgent.ts`).
   *
   * `prompt` is an `EnforcedPrompt`, not a `string`, and that is the whole per-turn byte ceiling:
   * only `harnessModelSeam.ts`'s `sealPrompt` mints one, so a path that assembles model-facing
   * text and tries to send it from here fails to compile rather than quietly bypassing the cap.
   * An implementation still declares `prompt: string` if it likes — a function that accepts every
   * string accepts an enforced one — so only *callers* are constrained, which is the direction
   * that matters.
   */
  readonly runTurn: (modelId: string, prompt: EnforcedPrompt, options?: RunAgentOptions) => Promise<string>;
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
  /**
   * Where this extension keeps the bare object stores the local investigation
   * source reads from (`add-local-git-investigation` design D3). Production
   * wiring (`extension.ts`) passes one built over the extension's own global
   * storage directory.
   *
   * Optional, and absent means exactly one thing: this host keeps no object
   * cache, so there is nothing that can read a change and every member of every
   * run refuses with that reason. It is not a degraded mode — the provider
   * fallback it used to name is gone.
   */
  readonly objectCache?: ObjectCache;
  /**
   * A source the host supplies for a pod whose change exists in no repository,
   * instead of one acquisition builds.
   *
   * In production there is exactly one such pod — the demo pod, whose sample
   * change lives in memory, behind no remote, with revisions that are not object
   * ids at all — so the wiring in `extension.ts` answers with the sample source
   * (`providers/fixture/demoInvestigationSource.ts`) for a pod on the sample
   * data provider and `undefined` for every other. It takes the pod rather than
   * being a bare factory precisely so that decision is made once, at the wiring
   * point, and is testable there: `extension.test.ts` asserts a connected pod
   * gets nothing.
   *
   * **The pod decides this, never the agent.** `demo` is on the parameter too,
   * and reading it here is the bug this seam already shipped once: `demo` is set
   * from the selected agent, so keying on it handed the built-in sample dataset
   * to a review of a real GitHub or GitLab change request the moment someone
   * picked the demo agent — and the sample registry is keyed by head sha, so a
   * real head matched nothing and the run could not complete. Whether a change
   * exists in a repository is a fact about the pod.
   *
   * It is injected rather than imported because ESLint permits `src/providers/**`
   * to be named in exactly one module (`src/registry.ts`) and this is not it.
   *
   * **It is not a second source to choose between.** Nothing derives one from a
   * connection, nothing falls back to it, and a member it does not answer for
   * goes to local git or refuses. The other caller is the harness's own test
   * suite, which drives the real runtime without a real object store — a test is
   * the host in that arrangement, and supplying a source is the host's to do.
   */
  readonly investigationSource?: (pod: { readonly providerId: string; readonly demo: boolean }) => InvestigationSource | undefined;
  /** Epoch milliseconds; defaults to `Date.now`. Injected for deterministic tests, matching every other clock in this change. */
  readonly now?: () => number;
}

function memberIdFor(ref: ChangeRequestRef): string {
  return `${ref.repoId}!${ref.number}`;
}

/**
 * Applies `HarnessPolicy.scopeInvestigationToChangedFiles` to an investigation
 * source's own declaration — the one place a reviewer's "keep this review on
 * the merge request" setting becomes a capability fact.
 *
 * Computed once and threaded to every downstream consumer of a member's
 * capabilities (the snapshot's `providerCapabilitySignature`, the dispatcher's
 * `capabilityUnavailable`, and the bootstrap tool-catalog/protocol-contract
 * filter in `harnessAttempt.ts`) so all three agree without a second gate
 * anywhere. Withholds exactly `fileReads` and `repositorySearch` — the two
 * operations that can reach content outside the change (D7's
 * `readFile`/`searchRepository`); `resolvePolicy` loses availability too, but
 * only as `toolCapabilityAvailable`'s existing "rides on `fileReads`" rule
 * already dictates, never a second check here. `readDiff`/`searchDiff` are
 * untouched: both are bounded to the change's own diff content by
 * construction, never repository-wide, so scoping has nothing to remove from
 * them.
 *
 * It takes a source declaration and nothing else. It used to take a provider's,
 * and briefly took a source kind alongside it so the default answer could
 * differ by who was answering. Both are gone with the provider investigation
 * path: there is one kind of thing reading a member's files, so there is one
 * answer, and the setting is a plain boolean again.
 */
function scopeInvestigationCapabilities(
  investigation: InvestigationSourceCapabilities,
  policy: HarnessPolicy,
): InvestigationSourceCapabilities {
  if (!policy.scopeInvestigationToChangedFiles) return investigation;
  return {
    ...investigation,
    fileReads: { ...investigation.fileReads, supported: false },
    repositorySearch: { ...investigation.repositorySearch, supported: false },
  };
}

/**
 * The capability declaration for one member: what its source says it can do,
 * plus what its connection says it can do, in one object.
 *
 * Each operation is declared by whoever answers it, which is the only
 * composition that can be true: the five pinned operations come from the
 * selected source, and change-request details, issue details and their page
 * bound stay with the provider, because those questions are about a change
 * request and no object store can answer one (design D2). Nothing else in the
 * provider's capabilities is touched — posting, approvals and thread resolution
 * are still the provider's, and still declared by it.
 *
 * This runs for every member now. It used to run only for a member whose
 * investigation came from somewhere other than its connection, and a
 * provider-served member kept the connection's declaration whole; there is no
 * provider-served member any more.
 */
function withSourceInvestigation(capabilities: ProviderCapabilities, source: InvestigationSourceCapabilities): MemberCapabilities {
  const detail = capabilities.detailRetrieval;
  return {
    ...capabilities,
    reviewInvestigation: {
      changeRequestDetails: detail?.changeRequestDetails ?? { supported: false },
      issueDetails: detail?.issueDetails ?? { supported: false },
      pagination: detail?.pagination ?? source.pagination,
      manifests: source.manifests,
      diffReads: source.diffReads,
      fileReads: source.fileReads,
      repositorySearch: source.repositorySearch,
      diffSearch: source.diffSearch,
    },
  };
}

/**
 * A member whose source could not be obtained still needs *some* capability
 * record: the snapshot signs one, and the attempt that ends before bootstrap
 * still writes a snapshot. It declares no investigation at all, which is the
 * honest statement — nothing read this change.
 */
function unservedCapabilities(capabilities: ProviderCapabilities): MemberCapabilities {
  return capabilities;
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

/** What source selection settled for one member, in the shapes the two halves below need. */
interface MemberSourceSelection {
  readonly memberId: string;
  /** The capability set this member's attempt actually has, source composed in. */
  readonly capabilities: MemberCapabilities;
  /** Always present — a member nothing could read holds a source that refuses (`refusingInvestigationSource`). */
  readonly source?: InvestigationSource;
  /** What the snapshot records about the source — carried alongside it so the snapshot loop states nothing twice. */
  readonly record?: ReviewRunInvestigationSource;
  readonly lease?: CacheLease;
  /** Set when no source can serve this member (design D5's third branch, task 9.3). */
  readonly unservable?: Extract<InvestigationSourceSelection, { outcome: 'unservable' }>;
}

interface CandidateAssembly {
  readonly pod: ResolvedPod;
  readonly revalidatedMembers: readonly RawMember[];
  readonly snapshot: ReturnType<typeof buildReviewRunSnapshot>;
  readonly selections: readonly MemberSourceSelection[];
  /** Every limitation selection produced, for the attempt to report (task 9.1, design D8). */
  readonly selectionLimitations: readonly Limitation[];
  /** What acquisition did, replayed into the attempt's own activity log (task 10.2). */
  readonly selectionActivity: readonly ActivityFact[];
}

/**
 * Release every object-store lease this assembly took (task 7.7).
 *
 * Called on every exit an attempt can have, including the ones that never start
 * it: a lease is a claim on a cache directory that eviction honours for the
 * whole staleness window, so one left behind by an attempt that refused to
 * start would hold disk against every later review for half an hour.
 */
function releaseSelectionLeases(selections: readonly MemberSourceSelection[]): void {
  for (const selection of selections) selection.lease?.release();
}

/**
 * The member that no source could serve, if any — the first one, because one is
 * enough to stop the attempt and naming all of them would make the reason a
 * list nobody reads. A changeset with two unservable members is still a run
 * that does not start.
 */
function firstUnservable(selections: readonly MemberSourceSelection[]): MemberSourceSelection | undefined {
  return selections.find((selection) => selection.unservable !== undefined);
}

/**
 * Resolves every member's live `Connection` and root `AGENTS.md` identity and builds this
 * attempt's `ReviewRunSnapshot` — shared by `create`/`createDemo` (a fresh lineage at attempt 1)
 * and `resume` (the *candidate* snapshot `decideResume` below compares against a stored one, at
 * `options.identity`'s already-next attempt number in an *existing* lineage). Never writes it:
 * `create`/`createDemo` write immediately: no compatibility to check first. `resume` writes only
 * after `decideResume` accepts it — see `resume`'s own doc comment for why.
 *
 * `policy` is passed in, already resolved by the caller, rather than read again from `deps.policy`
 * here: `deps.policy` is a live getter in production (a settings-panel edit must reach the next
 * attempt without a reload, `HarnessRuntimeDeps.policy`'s own doc comment), so reading it a second
 * time in the same attempt build could observe a different value mid-assembly than
 * `buildHarnessAttempt` does — `harnessRuntime.test.ts`'s "reads deps.policy... exactly once per
 * attempt built" test is exactly this hazard, caught early.
 */
async function buildCandidateAssembly(
  deps: HarnessRuntimeDeps,
  input: RunInput,
  options: HarnessAttemptRunOptions,
  demo: boolean,
  policy: HarnessPolicy,
): Promise<CandidateAssembly> {
  const now = deps.now ?? (() => Date.now());

  const pod = await resolvePod(deps, input.podId);
  const revalidatedMembers = await revalidateMemberAttachments(deps, rawMembersFrom(input), options.onAttachmentWarnings);

  const model = demo || input.modelId === undefined ? undefined : await deps.discoverModel(input.modelId);
  if (!demo && model === undefined) {
    throw new Error(`Verdict: the selected model "${input.modelId ?? ''}" is no longer available.`);
  }

  // Source selection, once per member, before the snapshot is built and before
  // any model work — design D5, task 9.1. Acquisition runs inside it (task 9.2),
  // so by the time a snapshot records a source, that source has already answered
  // for this exact head, and the commit its diff is against was computed from
  // the objects rather than taken from the platform's word for it.
  //
  // Sequential rather than concurrent: acquisition serializes per repository
  // anyway (task 7.6's lock), and two members of a changeset racing for the same
  // cache directory would spend the wait for no gain.
  //
  // A pod whose change exists in no repository is handed its source instead. The
  // sample change it reviews lives in memory, behind no remote, and its
  // revisions are not object ids, so there is nothing to clone; the host
  // supplies the source and the base its sample data declares, and selection
  // skips straight past git. Which pods those are is the host's answer, not this
  // module's, and it is not the same question as which agent is running.
  const selections: MemberSourceSelection[] = [];
  const selectionLimitations: Limitation[] = [];
  const selectionActivity: ActivityFact[] = [];
  const snapshotMembers: ReviewRunSnapshotMemberInput[] = [];
  const selected = new Map<string, { readonly source: InvestigationSource; readonly capabilities: InvestigationSourceCapabilities }>();
  // Asked once for the pod, not once per member: whether a pod's change exists
  // in a repository at all is a fact about the pod.
  const supplied = deps.investigationSource?.({ providerId: pod.providerId, demo });
  const baseShaByMemberId = new Map<string, string>();
  for (const member of revalidatedMembers) {
    const selection = await selectInvestigationSource({
      member: {
        memberId: member.memberId,
        providerId: pod.providerId,
        instanceUrl: pod.instanceUrl,
        ref: member.ref,
        headSha: member.headSha,
      },
      connection: pod.connection,
      // The attempt this lease belongs to, not the run: a second attempt in the
      // same lineage takes its own lease and releases its own.
      attemptId: `${options.identity.runId}:${String(options.identity.attempt)}`,
      // Gated on whether a source was supplied, not on whether this is a demo
      // run: a demo *agent* on a connected pod is supplied nothing and needs the
      // object store like any other agent. Only a pod whose change is in no
      // repository has nothing to fetch.
      ...(supplied ? {} : { objectCache: deps.objectCache }),
      ...(supplied ? { suppliedSource: { source: supplied, baseSha: member.baseSha } } : {}),
      narrowCapabilities: (capabilities) => scopeInvestigationCapabilities(capabilities, policy),
    });
    selectionLimitations.push(...selection.limitations);
    selectionActivity.push(...selection.activity);
    if (selection.outcome === 'unservable') {
      selections.push({
        memberId: member.memberId,
        capabilities: unservedCapabilities(pod.capabilities),
        source: refusingInvestigationSource(selection.reason),
        unservable: selection,
      });
    } else {
      selections.push({
        memberId: member.memberId,
        capabilities: withSourceInvestigation(pod.capabilities, selection.capabilities),
        source: selection.source,
        record: selection.record,
        ...(selection.lease ? { lease: selection.lease } : {}),
      });
      selected.set(member.memberId, { source: selection.source, capabilities: selection.capabilities });
      baseShaByMemberId.set(member.memberId, selection.baseSha);
    }
  }

  // Root `AGENTS.md` identity is a fixed, bounded, host-initiated read (one per member, never
  // model-choosable) that belongs to assembling authoritative context, not to the investigation a
  // reviewer might scope to the merge request — so it resolves against the source's own declared
  // capabilities, never the narrowed ones the model is gated on. Deliberate:
  // `scopeInvestigationToChangedFiles` narrows what the *model* can go read, not this one-shot host
  // fact-gathering step.
  //
  // It runs *after* selection now, and it has to: the file it reads is in the repository at the
  // base revision, the source that can read it is the one selection just obtained, and the base
  // revision is the merge base selection just computed. Before this change it ran first, against
  // `Connection.readFile`, which is exactly the forge request the rule removes.
  const agentsPolicyResolver = createAgentsPolicyResolver(
    (member) => selected.get(member.memberId)?.source,
    // The source's own declaration, not the narrowed one: this read is the
    // host's, not the model's, and a reviewer who turns scoping on must not
    // silently lose the root policy identity the snapshot records.
    { capabilities: (member) => selected.get(member.memberId)?.source.capabilities },
  );
  const rootPolicies = await Promise.all(
    revalidatedMembers.map(async (member): Promise<ReturnType<typeof rootAgentsPolicySourceFor>> => {
      const ref: AgentsPolicyMemberRef = {
        memberId: member.memberId,
        repoId: member.ref.repoId,
        baseSha: baseShaByMemberId.get(member.memberId) ?? member.baseSha,
        headSha: member.headSha,
      };
      const chain = await agentsPolicyResolver.resolveChain(ref, '');
      return rootAgentsPolicySourceFor(chain);
    }),
  );

  for (const [index, member] of revalidatedMembers.entries()) {
    const selection = selections[index]!;
    snapshotMembers.push({
      memberId: member.memberId,
      providerId: pod.providerId,
      instanceUrl: pod.instanceUrl,
      ref: member.ref,
      // The locally computed merge base wherever there was one to compute. A member
      // whose source could not be obtained keeps the value the host arrived with, so the
      // snapshot still identifies the change it failed to read.
      baseSha: baseShaByMemberId.get(member.memberId) ?? member.baseSha,
      headSha: member.headSha,
      // What this member actually had, so the recorded signature and the
      // dispatcher's own capability gate can never describe different sets.
      capabilities: selection.capabilities,
      ...(selection.record ? { investigationSource: selection.record } : {}),
      rootAgentsPolicy: rootPolicies[index]!,
      context: member.context,
      attachments: member.attachments,
    });
  }

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

  // The pod's own capabilities go back unchanged: there is nothing left to narrow at
  // the pod level, because the investigation half of a member's declaration comes from
  // its source and the policy is applied there. Per-member capabilities live on
  // `selections`, and every member has a source or has nothing.
  return { pod, revalidatedMembers, snapshot, selections, selectionLimitations, selectionActivity };
}

/**
 * Builds the live `HarnessAttempt` from an already-written snapshot — the second half both
 * `assembleAttempt` and `resume` share once they have one, with `resumeSeed` threaded through only
 * on the resume path. `policy` is the same already-resolved value `buildCandidateAssembly` used for
 * this attempt (see its own doc comment for why it is not read a second time from `deps.policy`
 * here).
 */
function buildHarnessAttempt(
  deps: HarnessRuntimeDeps,
  options: HarnessAttemptRunOptions,
  assembly: CandidateAssembly,
  demo: boolean,
  resumeSeed: HarnessAttemptOptions['resumeSeed'],
  policy: HarnessPolicy,
): HarnessAttempt {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const riskCoverageRules = deps.riskCoverageRules ?? DEFAULT_RISK_COVERAGE_RULES;
  const { pod, revalidatedMembers, snapshot } = assembly;

  const modelSeam = demo
    ? createDemoModelSeam(snapshot)
    : createLiveModelSeam({
        modelId: snapshot.modelId!,
        // The same value the parser is handed, so the cap the contract states is the cap enforced.
        policy,
        runTurn: (prompt, onTiming) => deps.runTurn(snapshot.modelId!, prompt, {
          cancellation: options.cancellation,
          timeouts: options.timeouts,
          onTiming,
        }),
      });

  const selectionsByMemberId = new Map(assembly.selections.map((selection) => [selection.memberId, selection] as const));
  const attemptMembers: HarnessAttemptMemberInput[] = revalidatedMembers.map((member) => {
    const selection = selectionsByMemberId.get(member.memberId);
    return {
      memberId: member.memberId,
      connection: pod.connection,
      // The selected source's composed set, never the pod's raw one: the
      // dispatcher gates each operation on this, and a member reading its diffs
      // from a local store must be gated on what that store declares.
      capabilities: selection?.capabilities ?? pod.capabilities,
      // Every selection carries one, including a member nothing could read: that
      // member's attempt still gets built so it can end before bootstrap with
      // completeness `none` and a reason, and what it holds here refuses every
      // operation in those same words (`refusingInvestigationSource`). Routing it
      // back to the connection instead is the forge fallback this change removed.
      investigationSource: selection!.source!,
      attachments: member.attachments,
    };
  });
  const unservable = firstUnservable(assembly.selections);

  const onCheckpoint = async (info: CheckpointInfo): Promise<void> => {
    options.onCheckpoint(info);
    // Task 7.7: a lease goes stale after the harness's own maximum attempt
    // elapsed time, and eviction deletes the whole directory of any entry whose
    // leases have. A checkpoint is the attempt's own regular heartbeat, so it is
    // where the claim is renewed — no timer of this module's own, and nothing to
    // clear if the attempt dies between two of them.
    for (const selection of assembly.selections) selection.lease?.refresh();
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
    // Design D5's third branch (task 9.3): no source can serve this member, so
    // the attempt ends before bootstrap with completeness `none` and this
    // reason — never a clean review of a change nothing could read.
    ...(unservable
      ? {
          preflightFailure: {
            code: 'noInvestigationSource',
            message: `Member ${unservable.memberId} could not be reviewed: ${unservable.unservable!.reason}`,
          },
        }
      : {}),
    limitations: assembly.selectionLimitations,
    // Task 10.2: what obtaining the objects did, replayed as this attempt's
    // first activity so a first review of a large repository shows a fetch
    // rather than an unexplained pause before the first model turn.
    preludeActivity: assembly.selectionActivity,
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
  // Read exactly once for this attempt build (task 17.1/17.2's freshness contract) and threaded
  // through both halves below, never re-read from `deps.policy` a second time — see
  // `buildCandidateAssembly`'s own doc comment.
  const policy = deps.policy ?? DEFAULT_HARNESS_POLICY;
  const assembly = await buildCandidateAssembly(deps, input, options, demo, policy);
  try {
    // Written before the first checkpoint can fire — `harnessResume.ts`'s compatibility checks and
    // the activation sweep (`sweepInterruptedRuns`) both need a stored snapshot to check a checkpoint
    // against. Written for an attempt that will end before bootstrap too (task 9.3): that attempt
    // still writes a terminal checkpoint, and a checkpoint without its snapshot is unreadable.
    await deps.harnessRunStore.writeSnapshot(assembly.snapshot);
    return releasingLeases(buildHarnessAttempt(deps, options, assembly, demo, undefined, policy), assembly);
  } catch (error) {
    // Nothing will run, so nothing needs the object stores held.
    releaseSelectionLeases(assembly.selections);
    throw error;
  }
}

/**
 * Every exit from a built attempt releases its object-store leases — the one
 * that returns a result, and the one that throws. Wrapping `run()` rather than
 * asking every caller to remember is the point: an unreleased lease is invisible
 * until a cache fills up weeks later.
 */
function releasingLeases(attempt: HarnessAttempt, assembly: CandidateAssembly): HarnessAttempt {
  return {
    run: async () => {
      try {
        return await attempt.run();
      } finally {
        releaseSelectionLeases(assembly.selections);
      }
    },
  };
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

  // Read exactly once for this attempt build, same discipline as `assembleAttempt`.
  const policy = deps.policy ?? DEFAULT_HARNESS_POLICY;
  const assembly = await buildCandidateAssembly(deps, input, options, false, policy);

  // Task 9.10, and the reason this refuses here rather than starting an attempt
  // that ends before bootstrap the way a fresh one does: an attempt in this
  // lineage writes a terminal checkpoint at the next attempt number, and that
  // checkpoint — carrying no plan, no coverage and no findings — is what a
  // later resume would read instead of the one being protected. So a member no
  // source can serve refuses *before* `writeSnapshot`: nothing is written, the
  // stored checkpoint stays exactly as it was, and the reviewer is told why.
  //
  // The checkpoint is never declared incompatible on this path, and that is a
  // deliberate narrowing. Design D8 had one refusal that did declare it — the
  // platform reporting the pinned revisions not found — and the only way to
  // establish that was to ask the forge for a manifest at the pinned pair,
  // which is the diff request this change removed. Nothing left is entitled to
  // say a commit is gone, so nothing says it: a fetch that failed ends the
  // attempt and leaves the stored checkpoint exactly as it was. Undo whatever
  // changed, or wait for the network, and the reviewer's work is still there.
  const unservable = firstUnservable(assembly.selections);
  if (unservable) {
    releaseSelectionLeases(assembly.selections);
    throw new Error(`Member ${unservable.memberId} could not be reviewed: ${unservable.unservable!.reason}`);
  }

  const decision = decideResume({ storedSnapshot, checkpoint: storedCheckpoint, candidateSnapshot: assembly.snapshot });
  if (decision.kind === 'incompatible') {
    releaseSelectionLeases(assembly.selections);
    throw new ResumeIncompatibleError(decision.reasons);
  }

  try {
    await deps.harnessRunStore.writeSnapshot(assembly.snapshot);
    return releasingLeases(buildHarnessAttempt(deps, options, assembly, false, { payload: decision.payload, startAction: decision.startAction }, policy), assembly);
  } catch (error) {
    releaseSelectionLeases(assembly.selections);
    throw error;
  }
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
