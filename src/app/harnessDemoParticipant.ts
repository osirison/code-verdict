/**
 * The deterministic demo participant (task 10.7 of
 * `add-agentic-review-harness`, design.md D1 "The demo agent implements the
 * same `HarnessParticipant` protocol with deterministic plan, tool,
 * candidate, and completion messages. It does not call a model, but no
 * separate lifecycle or completion path remains.", spec
 * `agentic-review-harness` "Every persona uses the harness").
 *
 * `createDemoModelSeam` builds a `HarnessModelSeam`
 * (`./harnessAttempt.ts`) — the exact same injection point a real model
 * fills. There is no separate demo code path anywhere else in this module:
 * the returned seam is driven through `createHarnessAttempt` exactly like a
 * real model's seam would be, so it goes through the identical protocol
 * parser (`../domain/harnessProtocol.ts`), tool dispatcher
 * (`./harnessToolDispatcher.ts`), evidence ledger, coverage tracker,
 * completion gate (`./harnessCompletion.ts`), activity log, cancellation
 * handling, and persistence hooks a real attempt uses. It never imports
 * `./demoAgent.ts`'s `runDemoAgent`/`runDemoChangesetAgent` (the legacy
 * one-shot demo path) or `../domain/agentResponse.ts` — reusing those would
 * reintroduce exactly the one-shot bypass this task must not have. What it
 * does reuse is `./demoAgent.ts`'s `demoFindingsForFile`: the same
 * deterministic hash/template logic that already produces recognizable demo
 * findings, extracted (task 10.7) so it can be driven one file at a time.
 *
 * **What the factory may see, and what it may not.** `createDemoModelSeam`
 * receives the same `ReviewRunSnapshot` a real model's bootstrap envelope is
 * built from — member identity (`memberId`/`repoId`/`baseSha`/`headSha`),
 * persona, criteria — because a real production `askModel` implementation
 * would be constructed with exactly that context closed over it too
 * (`HarnessModelSeam`'s own docs: "Building the *rest* of the prompt...
 * is entirely the caller's concern"). It must NOT, and does not, receive the
 * changed-file list or any diff content out of band: those arrive only
 * through the seam's own `listChangedFiles`/`readDiff` tool results, exactly
 * as a real model would discover them turn by turn. Anchors for
 * `demoFindingsForFile` come only from the patch text inside a `readDiff`
 * `HostToolResult` — the same bytes the ledger stored — never from a
 * separately-fetched `ChangeRequestDiff`.
 *
 * **State machine, not a script.** Unlike `harnessAttempt.test.ts`'s fixed
 * `scriptedModelSeam` (a flat list of pre-written turns), this seam reacts
 * to `toolResults` at every call, because it does not know in advance how
 * many members or files there are, how many manifest pages a member needs,
 * or what a `readDiff` will return. Every turn keeps the class of dispatch
 * request it made in the SAME batch's *last* position, so the following
 * call's `toolResults[toolResults.length - 1]` is always that request's own
 * result — the one correlation rule the whole `investigating`-phase state
 * machine relies on; earlier entries in the same batch (e.g. a prior file's
 * `candidateSubmission` acks) are never inspected.
 *
 * **Contradiction-check directive detection.** Task 10.6's
 * `./harnessSynthesisVerification.ts` collaborator, when it is the injected
 * `synthesisVerification`, asks this same seam per surviving finding via
 * `askModel`'s `repairInstruction` — see that module's header for why no
 * dedicated protocol message exists for this. This seam recognizes such a
 * call by `CONTRADICTION_CHECK_MARKER` (a stable, exported single source of
 * truth in that module) and answers with a deterministic, non-contradicting
 * verdict for the named candidate — the demo review never manufactures a
 * contradiction. Any other `repairInstruction` arriving (a real protocol
 * repair) would mean this seam emitted an invalid turn, which is a bug in
 * this module, not a condition to recover from: it throws.
 *
 * **Fails closed on anything unscripted.** Every branch that is not one of
 * the specific states this state machine models throws rather than
 * guessing. This is deliberate: it is what makes "the demo attempt makes
 * zero model requests" a *provable* property in the parity test (a scripted
 * twin seam that throws on any call it was not scripted for), and it turns
 * any drift between this module's assumptions and the harness's actual
 * turn-loop behavior into an immediate, loud test failure instead of a
 * silently wrong demo review.
 */
import { filterReason } from '../domain/criteria';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { ReviewItem } from '../domain/types';
import type { HarnessModelSeam } from './harnessAttempt';
import { demoFindingsForFile } from './demoAgent';
import { CONTRADICTION_CHECK_MARKER } from './harnessSynthesisVerification';
import type { HostToolResult } from './harnessToolDispatcher';

export const DEMO_PARTICIPANT_MODEL_ID = 'verdict.demo-participant';

interface MemberProgress {
  readonly memberId: string;
  readonly repoId: string;
  readonly baseSha: string;
  readonly headSha: string;
  manifestCursor?: string;
  manifestDone: boolean;
  files: string[];
}

function fail(message: string): never {
  throw new Error(`Demo participant: ${message}`);
}

function toolRequestListChangedFiles(member: MemberProgress): unknown {
  return {
    kind: 'toolRequest',
    tool: 'listChangedFiles',
    memberId: member.memberId,
    request: {
      snapshot: { repoId: member.repoId, baseSha: member.baseSha, headSha: member.headSha },
      ...(member.manifestCursor !== undefined ? { cursor: member.manifestCursor } : {}),
    },
  };
}

function toolRequestReadDiff(member: MemberProgress, path: string): unknown {
  return {
    kind: 'toolRequest',
    tool: 'readDiff',
    memberId: member.memberId,
    request: { snapshot: { repoId: member.repoId, baseSha: member.baseSha, headSha: member.headSha }, path },
  };
}

function candidateSubmissionRaw(memberId: string, item: ReviewItem, sourceId: string, digest: string): unknown {
  return {
    kind: 'candidateSubmission',
    candidate: {
      candidateId: `${memberId}_${item.id}`,
      memberId,
      file: item.file,
      line: item.line,
      endLine: item.endLine,
      severity: item.severity,
      category: item.category,
      confidence: item.confidence,
      title: item.title,
      body: item.body,
      code: item.code,
      suggestion: item.suggestion,
      citations: { primary: { sourceId, digest, path: item.file, range: { startLine: item.line, endLine: item.endLine ?? item.line } } },
    },
  };
}

function messagesJson(entries: readonly unknown[]): string {
  return JSON.stringify({ messages: entries });
}

/** Extracts the `candidateId: <id>` line 10.6's `buildContradictionDirective` always writes — the one piece of the directive this seam needs to echo back. */
function extractDirectiveCandidateId(directive: string): string {
  const match = /^candidateId: (.+)$/m.exec(directive);
  if (!match) fail(`received a contradiction-check directive with no candidateId line: ${directive.slice(0, 200)}`);
  return match[1] as string;
}

function verdictJson(candidateId: string): string {
  return JSON.stringify({ candidateId, contradicted: false });
}

/**
 * Builds one `HarnessModelSeam` for one harness attempt. Every mutable field
 * below is private to the closure this call returns — a fresh call is
 * required per attempt, exactly like a real model's own per-attempt
 * conversation state would be.
 */
export function createDemoModelSeam(snapshot: ReviewRunSnapshot): HarnessModelSeam {
  const criteria = snapshot.criteria;
  const members: MemberProgress[] = snapshot.members.map((member) => ({
    memberId: member.memberId,
    repoId: member.ref.repoId,
    baseSha: member.baseSha,
    headSha: member.headSha,
    manifestDone: false,
    files: [],
  }));
  const memberById = new Map(members.map((member) => [member.memberId, member] as const));

  let planEmitted = false;
  let awaitingManifestFor: string[] = [];
  let fileQueueBuilt = false;
  let fileQueue: Array<{ memberId: string; path: string }> = [];
  let pendingRead: { memberId: string; path: string } | undefined;
  let investigatingStopped = false;
  let completionRequested = false;

  function investigatingStep(toolResults: readonly HostToolResult[]): string {
    const outMessages: unknown[] = [];

    if (awaitingManifestFor.length > 0) {
      if (toolResults.length !== awaitingManifestFor.length) {
        fail(`expected ${awaitingManifestFor.length} listChangedFiles result(s), got ${toolResults.length}.`);
      }
      awaitingManifestFor.forEach((memberId, index) => {
        const member = memberById.get(memberId) ?? fail(`unknown member ${memberId} in a pending manifest request.`);
        const result = toolResults[index] as HostToolResult;
        if (result.state === 'complete' || result.state === 'paginated' || result.state === 'truncated') {
          if (result.content.tool !== 'listChangedFiles') fail(`expected a listChangedFiles result for member ${memberId}, got tool "${result.content.tool}".`);
          for (const entry of result.content.entries) member.files.push(entry.path);
          if (result.state === 'paginated') member.manifestCursor = result.cursor;
          else member.manifestDone = true;
        } else {
          // unavailable/notFound/unknown/refused: nothing more to page for this member.
          member.manifestDone = true;
        }
      });
      awaitingManifestFor = [];
    } else if (pendingRead !== undefined) {
      const { memberId, path } = pendingRead;
      pendingRead = undefined;
      const result = toolResults[toolResults.length - 1];
      if (!result) fail(`expected a readDiff result for ${memberId}:${path}, got no tool results.`);
      if (result.state === 'complete' || result.state === 'paginated' || result.state === 'truncated') {
        if (result.content.tool !== 'readDiff') fail(`expected a readDiff result for ${memberId}:${path}, got tool "${result.content.tool}".`);
        if (result.sourceId === undefined || result.digest === undefined) fail(`readDiff result for ${memberId}:${path} carries no sourceId/digest.`);
        const member = memberById.get(memberId) ?? fail(`unknown member ${memberId} resolving a pending readDiff.`);
        const findings = demoFindingsForFile(member.headSha, path, result.content.patch, 0);
        for (const item of findings) {
          if (filterReason(item, criteria) !== null) continue;
          outMessages.push(candidateSubmissionRaw(memberId, item, result.sourceId, result.digest));
        }
      }
      // unavailable/binary/tooLarge/notFound/unknown: nothing to submit for this file; move on.
    }

    const needManifest = members.filter((member) => !member.manifestDone);
    if (needManifest.length > 0) {
      awaitingManifestFor = needManifest.map((member) => member.memberId);
      for (const member of needManifest) outMessages.push(toolRequestListChangedFiles(member));
      return messagesJson(outMessages);
    }

    if (!fileQueueBuilt) {
      fileQueue = members.flatMap((member) => member.files.map((path) => ({ memberId: member.memberId, path })));
      fileQueueBuilt = true;
    }

    const next = fileQueue.shift();
    if (next) {
      pendingRead = next;
      const member = memberById.get(next.memberId) ?? fail(`unknown member ${next.memberId} queued for reading.`);
      outMessages.push(toolRequestReadDiff(member, next.path));
      return messagesJson(outMessages);
    }

    if (outMessages.length > 0) return messagesJson(outMessages);
    if (investigatingStopped) fail('was asked for another investigating turn after already signaling it was done.');
    investigatingStopped = true;
    return messagesJson([{ kind: 'publicRationale', rationale: 'Investigation is complete; every changed file has been read.' }]);
  }

  return {
    modelId: snapshot.modelId ?? DEMO_PARTICIPANT_MODEL_ID,

    async askModel({ phase, repairInstruction, toolResults }) {
      if (phase === 'planning') {
        if (repairInstruction !== undefined) fail(`received an unexpected repair instruction during planning: ${repairInstruction}`);
        if (planEmitted) fail('was asked for another planning turn after already publishing a plan.');
        planEmitted = true;
        return messagesJson([{ kind: 'planCreated', items: [{ id: 'p1', description: `Investigate the changed files across ${members.length} member(s).` }] }]);
      }
      if (phase === 'investigating') {
        if (repairInstruction !== undefined) fail(`received an unexpected repair instruction during investigating: ${repairInstruction}`);
        return investigatingStep(toolResults);
      }
      if (phase === 'verifying') {
        if (repairInstruction !== undefined) {
          if (!repairInstruction.startsWith(CONTRADICTION_CHECK_MARKER)) fail(`received an unexpected repair instruction during verifying: ${repairInstruction.slice(0, 200)}`);
          return verdictJson(extractDirectiveCandidateId(repairInstruction));
        }
        if (completionRequested) fail('was asked for another verifying turn after already requesting completion.');
        completionRequested = true;
        return messagesJson([{ kind: 'completionRequest', rationale: 'Investigation and verification are complete.' }]);
      }
      fail(`was asked for a model turn during phase "${phase}", which never gives the model a turn.`);
    },
  };
}
