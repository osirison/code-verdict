/**
 * Copilot agent integration via `vscode.lm` (spec §5): discovery lists the
 * user's chat models next to the demo agent; a run sends criteria, extra
 * instructions, explicitly attached evidence and changed-file diffs, then
 * expects the agentReviewResponse contract back.
 */
import * as vscode from 'vscode';
import { AgentResponseError } from '../domain/agentResponse';
import type { Criteria } from '../domain/types';
import { effortPrompt, type EffortLevel } from '../domain/effort';
import type { ChangeRequestDiff } from '../platform/types';
import { BUILTIN_AGENT_ID, type AgentDescriptor, type ModelDescriptor } from './agents';
import { modelVisiblePath } from './modelVisiblePath';
import { AgentTrace, type AgentProgressCallback, type AgentTimeoutReason, type AgentTraceSink } from './agentTrace';
import { createTraceFileSink } from './agentTraceFile';
import { changesetHeadSha, type ChangesetAgentMember } from './combinedAgent';
import {
  ATTACHMENT_TOTAL_BUDGET,
  DEFAULT_CONTEXT_BUDGETS,
  renderAttachmentsPrompt,
  renderReviewContextPrompt,
  type Attachment,
  type ContextBudgets,
  type ReviewContext,
  type ReviewContextEntry,
} from './reviewContext';

export type { AgentProgressCallback, AgentRunProgress, AgentTraceSink } from './agentTrace';

const LM_PREFIX = 'lm:';

const BUILTIN_ATTACHMENT_INSTRUCTIONS = 'You are a code review agent. Review ONLY the attachments and diffs below.';

function promptAgentInstructions(agent: AgentDescriptor, hasAttachments: boolean): string {
  return agent.id === BUILTIN_AGENT_ID && hasAttachments
    ? BUILTIN_ATTACHMENT_INSTRUCTIONS
    : agent.instructions;
}

// Issue #36 opened this: a flat total-duration timeout cancels a review that
// is still actively streaming. The fix then added an inactivity window but
// kept an absolute ceiling beside it, and the ceiling reproduced the very
// bug the issue was about, ten minutes later — a run streaming healthily the
// whole time was still cancelled, and the panel blamed
// `copilot.request.timeout`. A wall-clock bound cannot tell a productive run
// from a hung one, so neither limit is one any more:
//
// - FIRST OUTPUT: how long the request may take to produce its first part of
//   any kind. This exists because "not started" and "stopped" are different
//   conditions and the inactivity window used to be forced to bound both: a
//   live run on a 204-file change sent a 207KB prompt (under the model's
//   token limit — the input guard below accepted it), the model spent longer
//   than 90s ingesting it before the first token, and the inactivity window
//   killed a healthy request having seen zero fragments. Retrying — the
//   standing answer to a flaky endpoint — cannot fix that: the same prompt
//   needs the same ingestion time every attempt, so the kill is
//   deterministic. Time-to-first-token grows with prompt size; the gap
//   between fragments does not, which is why this is a separate window
//   (300s, sized to the largest prompt the token guard admits) and not a
//   raised inactivity number. Once the first part arrives this window is
//   done and can never fire again.
// - INACTIVITY: reset on every fragment, and armed only once the first one
//   has arrived — before that, FIRST OUTPUT above owns the clock. A model
//   that keeps producing output keeps the request alive no matter how long
//   the run takes overall. The issue's own worked example is a model that
//   streams one fragment every ~60s; 90s gives that pattern real margin (not
//   a knife's-edge tie) while still recovering a genuinely stuck request in
//   reasonable time.
// - CEILING: a checkpoint, not a kill. On expiry it asks one question — did
//   anything arrive during this window? If yes it re-arms for another full
//   window; only a window that passed with no output at all cancels. So it
//   bounds a run that has gone quiet over a long horizon and never a run
//   that is still producing. With every window at its default the ceiling
//   never fires first, which is intended: it is the bound that is left when
//   a caller turns the other two off for a model that thinks in
//   multi-minute silences.
//
// All three are settings — `codeVerdict.agentRun.*`, read in the UI layer and
// handed down as `RunAgentOptions.timeouts`, because nothing below `src/ui`
// reads `workspace.getConfiguration`. Zero disables a window entirely: a
// firstOutput of 0 means nothing bounds the wait for the first token except
// the ceiling (and the caller's own cancellation) — it does NOT fall back to
// the inactivity number, which stays unarmed until output exists for it to
// measure gaps between.
export const FIRST_OUTPUT_TIMEOUT_MS = 300_000;
export const INACTIVITY_TIMEOUT_MS = 90_000;
export const CEILING_TIMEOUT_MS = 10 * 60_000;

/** All three windows in milliseconds; `<= 0` disables that one. */
export interface AgentRunTimeouts {
  firstOutputMs: number;
  inactivityMs: number;
  ceilingMs: number;
}

export const DEFAULT_AGENT_RUN_TIMEOUTS: AgentRunTimeouts = {
  firstOutputMs: FIRST_OUTPUT_TIMEOUT_MS,
  inactivityMs: INACTIVITY_TIMEOUT_MS,
  ceilingMs: CEILING_TIMEOUT_MS,
};

// Reused across runs so we don't spawn a new "Code Verdict: Agent Trace"
// output channel on every review — VS Code shows one entry per channel in
// the output picker and there's no API to replace/dispose the old one from
// here.
let defaultChannel: vscode.OutputChannel | undefined;
/**
 * Set once at activation (`installAgentTraceFile`) to tee every trace line to a file that is
 * written synchronously. VS Code's own capture of the output channel is buffered and lands minutes
 * late — a run whose loop needed diagnosing had a captured file ninety minutes stale — so the panel
 * stays the place to glance at and this is the place to actually read a live or hung run from.
 */
let teedSink: AgentTraceSink | undefined;
function defaultTraceSink(): AgentTraceSink {
  return teedSink ?? liveTraceChannel();
}

/**
 * The output channel by itself, never the tee — the sink raw payloads are allowed to reach.
 *
 * `AgentTrace.debugRawPrompt`/`debugRawResponse`/`debugRawPart` write the full, unredacted prompt
 * and reply, and are exempt from redaction because they were documented as live-only. They were
 * not: `defaultTraceSink()` above returns the teed file sink once `installAgentTraceFile` has run,
 * so every raw payload was being written to `agent-trace.log` with `appendFileSync` while the line
 * itself said "never persisted". One reviewer's log held 113 full prompts and 111 full model
 * responses, 20 MB. This function is the composition point that makes the documented contract true
 * — it is the only place that knows which of the two sinks is the live one, and `AgentTrace` takes
 * it as a separate constructor argument so the raw methods cannot reach the durable sink even by
 * accident.
 */
function liveTraceChannel(): vscode.OutputChannel {
  defaultChannel ??= vscode.window.createOutputChannel('Code Verdict: Agent Trace');
  return defaultChannel;
}

/**
 * Points the shared trace sink at `dir`, teeing to `agent-trace.log` alongside the output channel.
 * Returns the file path so the caller can tell the reviewer where it is. Called once, at
 * activation; calling it again re-points the tee rather than adding a second one.
 */
export function installAgentTraceFile(dir: string): string {
  const sink = createTraceFileSink({ dir, inner: liveTraceChannel() });
  teedSink = sink;
  return sink.filePath;
}

/**
 * The same shared "Code Verdict: Agent Trace" channel `streamText` writes every request/response
 * trace line to, exposed so `extension.ts` can write into it too — the run-diagnostics report copy
 * (`codeVerdict.showRunDiagnostics`, "make the channel irrelevant" fix) and the build-identity line
 * at activation. Reuses `defaultTraceSink` exactly: calling this before any model call has run
 * creates the channel early (so it appears in the Output picker immediately, not only after the
 * first review), and calling it after a model call has run returns the very same channel instance
 * — never a second "Code Verdict: Agent Trace" entry.
 */
export function sharedAgentTraceSink(): AgentTraceSink {
  return defaultTraceSink();
}

/**
 * Options for `runFollowUpPrompt`/`runHarnessModelTurn`, both thin callers
 * of `streamText`. Task 15.8 removed `runLmAgent`/`runLmChangesetAgent` —
 * the one-shot runners that used to also take this options shape and read
 * its attachment/budget/workspace-root fields to assemble a request. Those
 * fields had no other reader, so they left with the runners; what remains
 * is exactly what `streamText` and `runFollowUpPrompt` themselves read.
 */
export interface RunAgentOptions {
  /** Called once per streamed fragment so a caller can show a "still alive" indicator without polling. */
  onProgress?: AgentProgressCallback;
  /** Overrides the default output-channel sink — tests inject a plain in-memory one instead of touching `vscode`. */
  trace?: AgentTraceSink;
  /** The configured windows. Omitted falls back to the defaults above, which is what an unconfigured caller wants. */
  timeouts?: AgentRunTimeouts;
  /**
   * The caller's own stop signal, linked to the internal source below. Without
   * it a caller could only stop *listening* — the request kept streaming, spent
   * its tokens, and the answer was dropped on arrival. That was tolerable while
   * a run belonged to the panel that started it; with runs holding a slot in a
   * concurrency budget it is not, because a run nobody is waiting for would
   * still keep the next one out.
   */
  cancellation?: AgentCancellationToken;
  /** Prompt-level review instruction. `none` contributes no prompt bytes. Read by `runFollowUpPrompt` only. */
  effort?: EffortLevel;
  /** Deterministic injection point for `streamText`'s own duration measurements — matching every other module's clock pattern (never a bare `Date.now()` read inline). Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Fires exactly once per `streamText` call, on every exit path: a normal reply, an empty reply,
   * a downstream parse never attempted at this layer, AND a thrown transport failure (timeout,
   * cancellation, an unavailable model, a malformed-contract error). `outcome` tells the two apart.
   * Earlier this fired only on the success path, on the theory that `harnessAttempt.ts`'s own
   * `toolFailed` fact already recorded a failed turn with its own reason — but that fact never
   * carried a duration, so a model call that died mid-stream (a 90s stall, a 10-minute ceiling)
   * contributed nothing to `modelWaitMs` and its wall-clock time silently misattributed to host
   * time in the diagnostics report. Firing here too, with `replyBytes` counting whatever text had
   * already streamed in before the failure, closes that gap. Metadata only: a duration, an outcome
   * tag and two byte counts, never the prompt or reply text.
   */
  onTiming?: (timing: ModelTurnTiming) => void;
}

/** What `RunAgentOptions.onTiming` reports for one raw model call — metadata only, see that field's own comment. */
export interface ModelTurnTiming {
  readonly durationMs: number;
  readonly promptBytes: number;
  readonly replyBytes: number;
  /** `'failed'` covers every thrown transport failure (timeout, cancellation, no model, bad contract) — never set for an empty reply, which is a `'completed'` turn that a downstream parser rejects, not a transport failure. */
  readonly outcome: 'completed' | 'failed';
}

export interface AssembleReviewPromptOptions {
  attachments?: readonly Attachment[];
  contextBudgets?: ContextBudgets;
  attachmentBudget?: number;
  /** Exact rendered zone reused by execution so its manifest cannot drift from this prompt. */
  attachmentPrompt?: string;
  effort?: EffortLevel;
  workspaceRootLabel?: string;
}

/**
 * The one piece of `vscode.CancellationToken` this module uses. Declared
 * structurally rather than imported as a type so a caller can hand in a real
 * one and a test can hand in an object literal — `vscode.CancellationToken`
 * satisfies it.
 */
export interface AgentCancellationToken {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * The Copilot chat models available to this session. These are *models*, not
 * agents: what runs a review, not what the review is. The id format is
 * unchanged from when each of these was itself listed as an agent, so
 * `AgentTrace`'s vendor/family split and every pod holding an `lm:` value
 * keep working.
 */
export async function discoverModels(): Promise<ModelDescriptor[]> {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({
      id: `${LM_PREFIX}${m.vendor}/${m.family}`,
      label: m.name,
      description: `${m.vendor} · ${m.family}`,
      vendor: m.vendor,
      family: m.family,
      maxInputTokens: m.maxInputTokens > 0 ? m.maxInputTokens : undefined,
    }));
  } catch {
    // No Copilot in this session (e.g. emulator-only debugging).
    return [];
  }
}

/** Count an already assembled prompt without issuing a chat request. */
export async function countPromptTokens(modelId: string, prompt: string): Promise<number | undefined> {
  const [vendor, family] = modelId.slice(LM_PREFIX.length).split('/');
  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  return model ? model.countTokens(prompt) : undefined;
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly requestId: string,
    readonly timedOut: boolean,
    /** Set when the request was cancelled — which limit ran out, or `'caller'`. */
    readonly timeoutReason?: AgentTimeoutReason,
    /**
     * The reviewer stopped it. Kept separate from `timedOut` because the two
     * mean opposite things to whoever reads the result: a timeout is a failure
     * to report and offer a retry for, a cancellation is the outcome that was
     * asked for. Both arrive here as a cancelled token, so without this flag
     * the only way to tell them apart is the message text.
     */
    readonly cancelled: boolean = false,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

/**
 * The exact single-review prompt. Task 15.8 removed `runLmAgent`, the
 * one-shot execution this prompt used to feed straight to `runPrompt` —
 * nothing shipped reached it any more (the harness builds its own bootstrap
 * envelope, `harnessModelSeam.ts`). This builder survives because
 * `ui/reviewFlow.ts`'s pre-run context-usage estimate still calls it to show
 * a token count before the reviewer starts a run — never to execute one.
 */
export function assembleReviewPrompt(
  agent: AgentDescriptor,
  diff: ChangeRequestDiff,
  criteria: Criteria,
  context?: ReviewContext,
  options: AssembleReviewPromptOptions = {},
): string {
  const attachmentPrompt = options.attachmentPrompt
    ?? renderAttachmentsPrompt(options.attachments ?? [], options.attachmentBudget ?? ATTACHMENT_TOTAL_BUDGET);
  return [
    // Element zero is the ONLY agent-controlled part of this array. Everything
    // after it is built here, from these inputs, exactly as it was before
    // agents were selectable — which is what makes it impossible for an agent
    // body to displace the contract, drop the criteria, or change the diffs.
    // The built-in agent's instructions are the literal that used to sit here.
    promptAgentInstructions(agent, attachmentPrompt !== ''),
    `Respond with a single JSON object matching this contract: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": "${diff.headSha}", "items": [{ "id", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "suggestion"?: {"old","new"} }], "candidates": [] }`,
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    effortPrompt(options.effort),
    renderReviewContextPrompt(context ? [{ context }] : [], options.contextBudgets ?? DEFAULT_CONTEXT_BUDGETS),
    attachmentPrompt,
    ...diff.files.map((f) => `--- ${modelVisiblePath(f.newPath, options.workspaceRootLabel)}\n${f.diff}`),
  ].filter((part) => part !== '').join('\n\n');
}

/**
 * The context blocks the changeset prompt carries, each labelled with the same
 * identifiers the member's diffs carry below it. Exported because the triage
 * screen asks `reviewContextTruncatedForPrompt` whether this prompt was cut,
 * and the total budget counts the labels too — answering that against a set
 * relabelled for the screen would report on a prompt that was never sent.
 */
export function changesetContextEntries(members: readonly ChangesetAgentMember[]): ReviewContextEntry[] {
  return members.flatMap((member) => (member.context
    // vocab-ok: the agent prompt's wire format — the same labels the response parser reads back
    ? [{ context: member.context, label: `for projectId=${member.ref.repoId} mrIid=${member.ref.number}` }]
    : []));
}

/** Member-labelled attachment zone, using the same wire identifiers as each changeset diff. */
export function renderChangesetAttachmentsPrompt(
  members: readonly ChangesetAgentMember[],
  totalBudget = ATTACHMENT_TOTAL_BUDGET,
): string {
  const labelled = members.flatMap((member) => (member.attachments ?? []).map((attachment) => ({
    ...attachment,
    id: `projectId=${member.ref.repoId} mrIid=${member.ref.number} attachment=${attachment.id}`,
    // vocab-ok: the agent prompt's wire format — the member path label parallels the diff label below
    path: `projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${attachment.path}`,
  })));
  return renderAttachmentsPrompt(labelled, totalBudget);
}

export interface AssembleChangesetReviewPromptOptions {
  contextBudgets?: ContextBudgets;
  attachmentBudget?: number;
  effort?: EffortLevel;
  attachmentPrompt?: string;
}

export function assembleChangesetReviewPrompt(
  agent: AgentDescriptor,
  members: readonly ChangesetAgentMember[],
  criteria: Criteria,
  options: AssembleChangesetReviewPromptOptions = {},
): string {
  const headSha = changesetHeadSha(members);
  const contract = '{ "id", "projectId", "mrIid", "file", "line", "severity": "nit|minor|major|blocker", "category": "security|concurrency|errorHandling|performance|craftsmanship|apiContract|tests|docs|style", "confidence": 0-100, "title", "body", "code", "cross"?: true, "spans"?: [{"projectId","location","role"}], "suggestion"?: {"old","new"} }';
  const attachmentPrompt = options.attachmentPrompt
    ?? renderChangesetAttachmentsPrompt(members, options.attachmentBudget ?? ATTACHMENT_TOTAL_BUDGET);
  return [
    promptAgentInstructions(agent, attachmentPrompt !== ''),
    'Review this changeset as one distributed unit. Review ONLY the member-labelled diffs and attachments below.',
    'Find both normal per-repository issues and failures that exist only between repositories. A cross-repository item must set cross=true and name both sides in spans[].',
    `Respond with one JSON object: { "schemaVersion": "1", "agentId": string, "agentLabel": string, "headSha": ${JSON.stringify(headSha)}, "items": [${contract}], "candidates": [] }`,
    'Every item must use the exact projectId and mrIid labels supplied below. Its file and line must identify an added line in that member diff or a line in that member attachment.',
    `Criteria: severity floor ${criteria.severityFloor}, min confidence ${criteria.minConfidence}, categories ${criteria.categories.join(', ')}.`,
    criteria.extraInstructions ? `Extra instructions: ${criteria.extraInstructions}` : '',
    effortPrompt(options.effort),
    renderReviewContextPrompt(changesetContextEntries(members), options.contextBudgets ?? DEFAULT_CONTEXT_BUDGETS),
    attachmentPrompt,
    ...members.flatMap((member) => member.diff.files.map((file) => [
      // vocab-ok: the agent prompt's wire format — the provider-neutral response parser reads this member label
      `--- projectId=${member.ref.repoId} mrIid=${member.ref.number} project=${member.projectPath} file=${modelVisiblePath(file.newPath, member.workspaceRootLabel)}`,
      file.diff,
    ].join('\n'))),
  ].filter((part) => part !== '').join('\n\n');
}

/**
 * A follow-up question about one finding (#37). Unlike a review run this
 * expects prose, not the JSON contract, so it shares the streaming, timeout
 * and trace machinery through `streamText` and skips the parse entirely.
 */
export async function runFollowUpPrompt(
  agent: AgentDescriptor,
  modelId: string,
  prompt: string,
  options?: RunAgentOptions,
): Promise<string> {
  // The agent's instructions lead here too, so the answer keeps the persona
  // that produced the finding being asked about. An agent with no
  // instructions contributes nothing and the prompt is what it always was.
  const withPersona = [agent.instructions, effortPrompt(options?.effort), prompt]
    .filter((part) => part !== '')
    .join('\n\n');
  return streamText(modelId, withPersona, options, (text) => text.trim());
}

/**
 * One harness protocol turn (task 15.7 of `add-agentic-review-harness`,
 * `./harnessModelSeam.ts`'s `createLiveModelSeam`): `prompt` already carries
 * the full bootstrap envelope, persona, criteria, tool schemas, protocol
 * contract, prior tool results, and any repair instruction — this function
 * adds nothing to it and reuses `streamText`'s existing streaming path,
 * cancellation, timeout windows, and tracing exactly as `runFollowUpPrompt`
 * does, returning the model's raw reply text for
 * `../domain/harnessProtocol.ts`'s `parseModelTurn` to parse. `runFollowUpPrompt`
 * is the follow-up-question path and stays untouched by this addition (task
 * 10.2's second clause: follow-up questions are not review-harness concerns).
 * Task 15.8 removed `runPrompt`, the one-shot review path that used to sit
 * beside this one — nothing shipped reached it once `runLmAgent`/
 * `runLmChangesetAgent` were removed with it.
 *
 * A missing or refusing model, a timeout, or a cancellation surfaces as the
 * same `AgentRunError` `streamText` always throws — never swallowed here,
 * so `harnessAttempt.ts`'s turn loop (and, above it, `ReviewRunManager`'s
 * `executeAttempt` catch block) sees a genuine rejection and fails the
 * attempt truthfully rather than falling back to anything.
 */
export async function runHarnessModelTurn(
  modelId: string,
  prompt: string,
  options?: RunAgentOptions,
): Promise<string> {
  return streamText(modelId, prompt, options, (text) => text);
}

/**
 * `codeVerdict.trace.rawPayloads` — off by default, read fresh on every call (never cached at
 * activation) so a reviewer's toggle takes effect on the very next request. Local to this module:
 * nothing downstream of `streamText` (`harnessModelSeam.ts`, `harnessAttempt.ts`, and everything
 * that persists) reads this setting, imports it, or receives a callback gated by it — the only
 * three places raw prompt/response/part text ever reaches a sink are
 * `AgentTrace.debugRawPrompt`/`debugRawResponse`/`debugRawPart`, all called only from here.
 *
 * What this setting does NOT mean, stated because it used to be documented as meaning it: turning
 * it on does not keep the payload out of every file. It keeps it out of `agent-trace.log`, which
 * this extension writes itself, synchronously, and rotates at 32 MB — the copy that was found
 * holding 113 full prompts and 111 full model responses. The live output channel it does reach is
 * captured by VS Code into VS Code's own log directory, which nothing here controls. The honest
 * statement is "not written by Code Verdict, buffered into VS Code's channel capture like every
 * other output-channel line", and that is what `package.json`'s own description now says.
 */
function rawPayloadTracingEnabled(): boolean {
  return vscode.workspace.getConfiguration('codeVerdict').get<boolean>('trace.rawPayloads', false);
}

/**
 * The response-stream fix (see this file's own `streamText` header). The VS Code typings say
 * `response.text` "is equivalent to filtering everything except for text parts from
 * `LanguageModelChatResponse.stream`" — so a part this runtime does not classify as a
 * `LanguageModelTextPart` never reaches `.text` at all, with no error and no fragment. Reading
 * `.stream` directly and extracting text ourselves means that classification is no longer the
 * single point of failure: `instanceof` is tried first (the fast, unambiguous path when the part
 * really is the same class this module imported), but a part that is conceptually a text part
 * and merely fails `instanceof` — the exact cross-module-boundary failure the hypothesis names —
 * still yields its text via the duck-typed `value`/`text` string check below. `typeof
 * vscode.LanguageModelTextPart === 'function'` guards a test double whose mocked `vscode` module
 * omits the class entirely; without it, `instanceof` on a non-constructor throws and turns a
 * clean "no text" classification into a spurious transport failure.
 */
function textFromPart(part: unknown): string | undefined {
  if (typeof part === 'string') return part;
  if (typeof vscode.LanguageModelTextPart === 'function' && part instanceof vscode.LanguageModelTextPart) {
    return part.value;
  }
  if (part !== null && typeof part === 'object') {
    const candidate = part as { value?: unknown; text?: unknown };
    if (typeof candidate.value === 'string') return candidate.value;
    if (typeof candidate.text === 'string') return candidate.text;
  }
  return undefined;
}

/**
 * What `AgentTrace.nonTextPart`/`nonTextResponse` log for a part `textFromPart` above could not
 * resolve to text — metadata only, per this change's own content rule: a constructor name plus
 * that part's own (never nested) property names, never a property's value. Reused for every part
 * that arrives with no text, whether the overall turn still succeeds on other parts' text or ends
 * up empty; see `streamText`'s own loop for why this is called unconditionally rather than only
 * on the failure path — "never silently discard a part" applies regardless of the outcome.
 */
function partDescriptor(part: unknown): string {
  if (part === null) return 'null';
  const kind = typeof part;
  if (kind !== 'object' && kind !== 'function') return kind;
  const ctorName = (part as { constructor?: { name?: string } }).constructor?.name || 'Object';
  const keys = Object.keys(part as object);
  return keys.length > 0 ? `${ctorName}{${keys.join(',')}}` : ctorName;
}

/**
 * Stream one prompt and hand the collected text to `finish`, which runs INSIDE
 * the try so a parse failure is classified and traced exactly like a transport
 * failure. Everything about timeouts, cancellation and tracing lives here once.
 *
 * **The empty-response fix.** A stream that ends having yielded no fragments at all used to reach
 * `finish` exactly like a real reply — `trace.response(text, true)` even logged it as "parsed OK".
 * Zero bytes back is never a valid turn: this now traces it as `emptyResponse` (naming the model,
 * the prompt size, and how long it took) rather than a success, and — for a caller wired through
 * `../domain/harnessProtocol.ts`'s `parseModelTurn` (`runHarnessModelTurn`'s only production
 * caller) — the empty text still flows on to `finish` and back to that caller, which is *itself*
 * the seam already built to fail every unparseable turn through the harness's existing bounded
 * protocol-repair loop (`../app/harnessTurn.ts`) rather than killing the whole attempt on the
 * model's very first empty reply. `parseModelTurn` now classifies an empty turn with its own
 * distinct `emptyResponse` reason (never the generic "no JSON found"), so the cause survives
 * every repair attempt and, once repairs are exhausted, becomes the attempt's own recorded
 * limitation (`harnessAttempt.ts`'s `runPhaseLoop`) — never silently absorbed into an unrelated
 * coverage complaint.
 *
 * **The response-stream fix.** Every review failing with a 0-byte, 0-fragment, near-instant
 * response, across every model tried, pointed at `response.text` itself rather than any one
 * vendor: the VS Code typings define it as "filtering everything except for text parts" out of
 * `response.stream`, and "the `unknown`-type is used as a placeholder for future parts" on that
 * same stream. A part this runtime cannot classify as text — a reasoning part, a future part
 * type, or a genuine text part that fails `instanceof` across a module boundary — never reaches
 * `.text`, with no exception thrown. This function now reads `.stream` directly and classifies
 * each part itself (`textFromPart`, `instanceof` first, then a duck-typed `value`/`text` check
 * that survives the module-boundary failure `.text` cannot). Three previously-collapsed cases are
 * now distinct in the trace: `trace.emptyResponse` when the stream yielded no parts at all,
 * `trace.nonTextResponse` when it yielded parts but none carried text (naming every part type
 * seen), and — unchanged, and already distinct before this fix — a downstream protocol-parse
 * failure on non-empty text (`../domain/harnessProtocol.ts`'s `noJson`/`invalidEnvelope` etc.),
 * which this function never touches; `finish` here is either `runHarnessModelTurn`'s identity or
 * `runFollowUpPrompt`'s `.trim()`, neither of which parses anything. A part that carries no text
 * is never silently dropped even when the turn overall succeeds on other parts' text:
 * `trace.nonTextPart` logs it immediately, every time, metadata only.
 */
async function streamText<T>(
  modelId: string,
  prompt: string,
  options: RunAgentOptions | undefined,
  finish: (text: string) => T,
): Promise<T> {
  const [vendor, family] = modelId.slice(LM_PREFIX.length).split('/');
  const requestId = Math.random().toString(16).slice(2, 8);
  // `clockNow` is resolved before `AgentTrace` is built and passed straight in, so the trace's own
  // elapsed-time math and every line's leading time-of-day share the exact same clock this
  // function's own duration tracking (`startedAtMs`, `reportTiming`) uses — never two independent
  // readings of "now" that could drift apart under a caller's injected test clock.
  const clockNow = options?.now ?? Date.now;
  // Two sinks, and which is which is decided only here. The durable one is the tee that reaches
  // `agent-trace.log`; the live one is the output channel alone, and it is the only place
  // `AgentTrace`'s three `debugRaw*` methods write (see `liveTraceChannel` above for the 20 MB of
  // prompts and replies that were on disk before this split). A caller that injects its own sink
  // — only tests do; production never sets `RunAgentOptions.trace` — is injecting an in-memory
  // sink that writes to no file, so it is the live sink as well as the durable one.
  const injected = options?.trace;
  const trace = new AgentTrace(
    injected ?? defaultTraceSink(),
    requestId,
    vendor ?? '',
    family ?? '',
    clockNow,
    injected ?? liveTraceChannel(),
  );
  const promptBytes = trace.prompt(prompt);
  if (rawPayloadTracingEnabled()) trace.debugRawPrompt(prompt);
  const startedAtMs = clockNow();

  // Declared here, not inside the try, so a transport failure mid-stream can still report how
  // many bytes had already arrived — `reportTiming('failed')` reads whatever `text` holds at the
  // moment of the throw, never fabricating a full reply for a call that never finished one.
  let text = '';
  // `reported` makes "exactly once" (see `RunAgentOptions.onTiming`'s own comment) a guarantee,
  // not an accident of every current `finish` callback being a trivial identity/`.trim()` that
  // cannot itself throw: `finish` runs inside the same try this reports from (a deliberate,
  // pre-existing design — see this function's own header — so a caller's own parse failure is
  // classified and traced exactly like a transport failure), and without this guard a future
  // `finish` that threw would fall into the catch below and fire a second, contradictory 'failed'
  // report for a call that had already reported 'completed'.
  let reported = false;
  const reportTiming = (outcome: 'completed' | 'failed') => {
    if (reported) return;
    reported = true;
    options?.onTiming?.({
      durationMs: clockNow() - startedAtMs,
      promptBytes,
      replyBytes: Buffer.byteLength(text, 'utf8'),
      outcome,
    });
  };

  const models = await vscode.lm.selectChatModels({ vendor, family });
  const model = models[0];
  if (!model) {
    const message = `Model ${modelId} is no longer available`;
    trace.failure(message);
    reportTiming('failed');
    throw new AgentRunError(message, requestId, false);
  }

  // Every turn, not just the first. `fitBootstrapToModel` sizes the *bootstrap envelope* once, at
  // the start of an attempt; a turn's prompt is that envelope plus the previous turn's tool
  // results, which grow. While a single tool result was capped at 64 KB that gap was theoretical.
  // It is not any more: a read now returns a whole file, so one turn can carry hundreds of
  // kilobytes the bootstrap check never saw. An oversized request is not reliably an error — the
  // failure this whole harness spent days chasing was a model returning zero bytes, no exception,
  // in 3ms — so this refuses the send with a named reason rather than letting it come back empty
  // and be misdiagnosed as anything else. Not retryable: the same prompt will not fit next time.
  if (model.maxInputTokens > 0) {
    let promptTokens: number | undefined;
    try {
      promptTokens = await model.countTokens(prompt);
    } catch {
      // A tokenizer that cannot answer must not fail the turn on its own — the send below is
      // still the more informative outcome, whatever it returns.
      promptTokens = undefined;
    }
    if (promptTokens !== undefined && promptTokens > model.maxInputTokens) {
      const message = `This turn's prompt is about ${promptTokens} tokens, over ${modelId}'s ${model.maxInputTokens}-token input limit`;
      trace.failure(message);
      reportTiming('failed');
      throw new AgentRunError(message, requestId, false);
    }
  }

  const timeouts = options?.timeouts ?? DEFAULT_AGENT_RUN_TIMEOUTS;
  const tokenSource = new vscode.CancellationTokenSource();
  let timeoutReason: AgentTimeoutReason | undefined;
  /** `ms <= 0` is the setting's documented "no limit" — arm nothing at all. */
  const schedule = (ms: number, onExpiry: () => void): ReturnType<typeof setTimeout> | undefined =>
    ms > 0 ? setTimeout(onExpiry, ms) : undefined;
  const cancelWith = (reason: AgentTimeoutReason) => {
    timeoutReason = reason;
    tokenSource.cancel();
  };

  // The ceiling re-arms itself for as long as output keeps arriving, so its
  // handle is reassigned rather than fixed; `finally` clears whichever one is
  // pending at the end.
  let producedThisCeiling = false;
  let ceiling: ReturnType<typeof setTimeout> | undefined;
  const armCeiling = () => {
    producedThisCeiling = false;
    ceiling = schedule(timeouts.ceilingMs, () => {
      if (producedThisCeiling) {
        armCeiling();
        return;
      }
      cancelWith('ceiling');
    });
  };
  armCeiling();

  // Armed once, before the send, and cleared for good by the first part of any kind. The
  // inactivity window starts unarmed on purpose: it measures the gap between fragments, and
  // before the first fragment there is no gap to measure — there is a request still ingesting its
  // prompt, whose legitimate silence grows with prompt size (the 207KB-prompt failure this
  // separation comes from is described at `FIRST_OUTPUT_TIMEOUT_MS`). Arming inactivity here
  // instead, as this code used to, made 90s the bound on time-to-first-token and killed a healthy
  // large-prompt request that had produced zero fragments.
  let firstOutput = schedule(timeouts.firstOutputMs, () => cancelWith('firstOutput'));
  let inactivity: ReturnType<typeof setTimeout> | undefined;
  // The caller's signal joins the same source the three windows use, so there is
  // one way to stop a request and one place that classifies why it stopped.
  // Checked first as well as subscribed: a token that was already cancelled
  // before the run started fires no event, and would otherwise stream to
  // completion for a caller that had already given up.
  const callerCancel = options?.cancellation;
  const callerSubscription = callerCancel?.onCancellationRequested(() => cancelWith('caller'));
  if (callerCancel?.isCancellationRequested) cancelWith('caller');

  const onFragment = () => {
    producedThisCeiling = true;
    clearTimeout(firstOutput);
    firstOutput = undefined;
    clearTimeout(inactivity);
    inactivity = schedule(timeouts.inactivityMs, () => cancelWith('inactivity'));
  };

  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User(prompt)],
      {},
      tokenSource.token,
    );
    // `partsSeen`/`partDescriptors` classify the response independently of whether text was
    // ultimately extracted — the three-case distinction below (see this function's own header)
    // needs to know not just "was the reply empty" but "did anything arrive at all".
    let partsSeen = 0;
    const partDescriptors: string[] = [];
    for await (const part of response.stream) {
      partsSeen += 1;
      // Any part arriving is activity — a reasoning or tool-call part keeps a run alive exactly
      // like a text fragment does, not only the parts this runtime happens to recognize as text.
      onFragment();
      const extracted = textFromPart(part);
      if (extracted === undefined) {
        const descriptor = partDescriptor(part);
        partDescriptors.push(descriptor);
        // Metadata only, logged unconditionally — "never silently discard a part".
        trace.nonTextPart(partsSeen, descriptor);
        if (rawPayloadTracingEnabled()) trace.debugRawPart(partsSeen, part);
        continue;
      }
      if (extracted.length === 0) {
        // A genuine text part — `textFromPart` classified it fine — that happened to carry zero
        // characters (a real streamed delta some providers do send). Never an unrecognized part,
        // so no `nonTextPart`/`debugRawPart` line, but still named below: without this, a turn
        // made entirely of these would leave `partDescriptors` empty even though `partsSeen > 0`,
        // and the case-2 summary would falsely claim "yielded 0 part(s)" while a `fragment #1 (+0
        // chars)` line sits right above it in the same trace — the exact kind of lie this whole
        // fix exists to prevent. (`#1` and not `#N`: `AgentTrace.fragment` now logs only the first
        // fragment and any that follows a stall, so a turn made of empty text parts leaves exactly
        // one such line, not one per part.)
        partDescriptors.push(partDescriptor(part));
      }
      text += extracted;
      const progress = trace.fragment(extracted);
      options?.onProgress?.(progress);
    }
    const elapsedMs = clockNow() - startedAtMs;
    if (text.length === 0) {
      // Never "parsed OK", never absorbed silently — see this function's own header. Two distinct
      // cases collapsed into one before this fix: nothing arrived at all, or something arrived
      // that this runtime could not read as text. `partsSeen`, not `partDescriptors.length`, is
      // the count passed on: every part that contributed to a zero-length result is described in
      // `partDescriptors`, but the count itself must stay right even where that list is empty.
      if (partsSeen === 0) {
        trace.emptyResponse(promptBytes, elapsedMs);
      } else {
        trace.nonTextResponse(promptBytes, elapsedMs, partsSeen, partDescriptors);
      }
    } else {
      trace.received(text);
      if (rawPayloadTracingEnabled()) trace.debugRawResponse(text);
    }
    trace.done();
    reportTiming('completed');
    return finish(text);
  } catch (e) {
    if (tokenSource.token.isCancellationRequested) {
      if (timeoutReason === 'caller') {
        // Not a failure: the reviewer asked for this. Reported as its own
        // outcome so the caller does not offer to lengthen a window that had
        // nothing to do with it.
        const message = 'run cancelled';
        trace.failure(message, 'caller');
        reportTiming('failed');
        throw new AgentRunError(message, requestId, false, 'caller', true);
      }
      // Three limits, three sentences: which window ran out tells the reviewer
      // which condition actually happened — a request that never began
      // answering is not a stall, and saying "stalled" for it (as this code
      // did when the inactivity window bounded both) sends the reviewer at
      // the wrong knob.
      const message =
        timeoutReason === 'ceiling'
          ? `agent produced nothing for a full ${timeouts.ceilingMs / 1000}s run window`
          : timeoutReason === 'firstOutput'
            ? `agent never started answering: no output at all within ${timeouts.firstOutputMs / 1000}s of the request`
            : `agent stalled: no output for ${timeouts.inactivityMs / 1000}s`;
      trace.failure(message, timeoutReason);
      reportTiming('failed');
      throw new AgentRunError(message, requestId, true, timeoutReason);
    }
    if (e instanceof AgentResponseError || e instanceof SyntaxError) {
      const message = `agent response did not match the contract: ${e.message}`;
      // The thrown `AgentRunError` keeps `e.message` verbatim (existing, tested behaviour: the
      // reviewer-facing failure card). The trace sink does not: a `SyntaxError` from `JSON.parse`
      // quotes a fragment of the model's own output in its own message, so the sink gets a fixed
      // classification instead. Neither surviving `finish` callback below parses JSON — this
      // branch is defensive, kept because it is shared, generic response-classification logic
      // in `streamText` rather than something specific to the one-shot contract task 15.8 removed.
      trace.failure(e instanceof SyntaxError ? 'agent response did not match the contract: malformed JSON' : message);
      reportTiming('failed');
      throw new AgentRunError(message, requestId, false);
    }
    const message = e instanceof Error ? e.message : String(e);
    trace.failure(message);
    reportTiming('failed');
    throw new AgentRunError(message, requestId, false);
  } finally {
    clearTimeout(ceiling);
    clearTimeout(firstOutput);
    clearTimeout(inactivity);
    callerSubscription?.dispose();
    tokenSource.dispose();
  }
}
