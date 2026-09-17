/**
 * The one block of lines an attempt writes into the agent trace before it runs: every
 * `codeVerdict.harness.*` value it resolved, **where each value came from**, and the other facts
 * the attempt settled during assembly (model, investigation source, pinned revisions).
 *
 * ## Why provenance, and not just the numbers
 *
 * A reviewer who changes a setting has had no way to confirm the run used it. The trace wrote
 * per-request lines — start, prompt size, fragments, done — and never stated the policy the
 * attempt resolved, so a misconfiguration and a defect looked identical from the log.
 *
 * The case that forced this: a run died on a 139 KB prompt while
 * `codeVerdict.harness.maxPromptKilobytesPerTurn` was 192. Those two numbers together are the whole
 * diagnosis — the ceiling never bound, so the model and not the budget was the limit — and reading
 * them meant grepping the user's settings file and the shipped defaults separately and then
 * reasoning about which won. `192` on its own does not answer "did my change take effect".
 * `192 (shipped default)` and `96 (settings.json)` do, immediately.
 *
 * This is the same idea `extension.ts`'s activation banner already applies to the bundle: a stale
 * build has twice been the suspect, so the build identity is written where the run is. A stale
 * *setting* is the same suspicion one layer up, and it gets the same treatment.
 *
 * ## What is in the block, and what is deliberately not
 *
 * Exactly the settable surface: the 13 numeric `HARNESS_POLICY_SETTINGS` rows, the one boolean
 * (`scopeInvestigationToChangedFiles`), and the one enum (`requireInspectionMinRisk`) — the same
 * `HARNESS_SETTING_KEYS` list `package.json` is drift-tested against (`../ui/harnessPolicyOptions.ts`).
 * The rest of `HarnessPolicy` — the provider page sizes, the backoff curve, `globalConcurrency`,
 * the per-member minimums — is absent on purpose: `harnessPolicyOptions.ts`'s own header explains
 * that those are internal mechanics a reviewer has no way to set, so a line for one of them could
 * never answer "did my change take effect" and would only push the lines that can answer it further
 * apart. The list is built from that one table, so a setting added there without a line here is not
 * possible.
 *
 * Values render in **setting units under setting names** (`maxPromptKilobytesPerTurn=96`, not
 * `maxPromptBytesPerTurn=98304`): the reviewer greps for the thing they typed into settings.json,
 * not for the field name the domain stores it under.
 *
 * ## Which sink, and why raw content rules do not apply
 *
 * The durable one — `agentTrace.ts`'s ordinary sink, teed into `agent-trace.log`
 * (`lmAgent.ts`'s `installAgentTraceFile`). D13's persistence rule bounds *model input and output*:
 * a prompt, a reply, a tool result. None of that is here. This block is the host's own resolved
 * configuration — numbers, booleans and one enum the reviewer typed themselves — and it is useless
 * in the live channel alone, because the run a reviewer needs it for is usually one they are
 * reading back after the fact.
 *
 * One value in it is nonetheless reviewer-controlled text: whatever settings.json actually held for
 * a rejected setting. `formatSuppliedValue` below is the whole answer to that — a number or boolean
 * prints verbatim, a string goes through the shared `sanitizePublicText` (redaction plus a 240-char
 * bound, `harnessActivitySanitizer.ts`), and a structured value prints only its shape. So a
 * credential pasted into a numeric setting cannot ride a "rejected" line into the file, and
 * `agentTrace.test.ts`'s marker convention covers it the same way it covers every other line.
 *
 * Pure and `vscode`-free, like the rest of `src/app`. `renderAttemptConfiguration` returns lines and
 * writes nothing; `writeAttemptConfiguration` prefixes each with the shared time-of-day
 * (`traceClock.ts`) the other two trace writers use, so a line here lines up by eye against a line
 * in the agent or API trace.
 */
import type { AgentTraceSink } from './agentTrace';
import { sanitizePublicText } from './harnessActivitySanitizer';
import { formatTimeOfDay } from './traceClock';
import type { HarnessPolicy } from '../domain/harnessPolicy';
import {
  baseRevisionKindOf,
  investigationSourceKindOf,
  type ReviewRunSnapshot,
} from '../domain/reviewRunSnapshot';

/**
 * Where one resolved value came from.
 *
 * `'default'` and `'setting'` are deliberately different facts even when the numbers are identical:
 * a reviewer chasing a stale-settings suspicion is asking whether their settings.json is being read
 * at all, and "you set 192, and 192 is also the default" answers that where a bare `192` does not.
 * That distinction is only obtainable from `WorkspaceConfiguration.inspect` — `get` folds an unset
 * key into `package.json`'s declared default and hands back a number indistinguishable from one the
 * reviewer typed (`../ui/harnessPolicyOptions.ts`'s `readResolvedHarnessPolicy`).
 *
 * `'rejected'` is the case this whole block exists for: `normalizeHarnessPolicy` replaces an
 * unusable value with the default silently, which is *precisely* the situation where someone's
 * change did not take effect, and it was invisible everywhere until now.
 */
export type HarnessSettingOrigin = 'default' | 'setting' | 'rejected';

/** One `codeVerdict.harness.*` key as this attempt resolved it, in the units and under the name the reviewer sets it by. */
export interface ResolvedHarnessSetting {
  /** The name after `codeVerdict.harness.` — what the reviewer typed, and what they will grep for. */
  readonly settingKey: string;
  /** The value the attempt actually runs on, converted back into the setting's own unit. */
  readonly value: number | boolean | string;
  readonly origin: HarnessSettingOrigin;
  /** Only ever set for `'rejected'`: the raw thing settings.json held, rendered through `formatSuppliedValue` and never printed verbatim unless it is a number or a boolean. */
  readonly supplied?: unknown;
}

/**
 * A policy and the provenance of every settable value in it, resolved together from one read.
 *
 * One object rather than two independent getters, and that is not tidiness: `deps.policy` is a live
 * getter in production so a settings edit reaches the next attempt without a reload
 * (`harnessRuntime.ts`'s own `HarnessRuntimeDeps.policy` comment), and two reads of a live getter
 * during one assembly can observe two different configurations — the exact hazard
 * `harnessRuntime.test.ts`'s "reads deps.policy... exactly once per attempt built" test was written
 * for. A block that named values the attempt was not running on would be worse than no block.
 */
export interface ResolvedHarnessPolicy {
  readonly policy: HarnessPolicy;
  readonly settings: readonly ResolvedHarnessSetting[];
}

/** What `renderAttemptConfiguration` needs; the snapshot carries every attempt fact worth stating and this module reads only identifiers and digests out of it — never `criteria`, never `agentInstructions`. */
export interface AttemptConfigurationFacts {
  readonly snapshot: ReviewRunSnapshot;
  /** Undefined when the host wired no settings reader (every test that passes a bare `policy`); the block says so rather than guessing an origin. */
  readonly settings: readonly ResolvedHarnessSetting[] | undefined;
}

/**
 * How a value settings.json actually held gets printed on a `REJECTED` line.
 *
 * Numbers and booleans print verbatim — they are the whole point of the line, and neither can carry
 * a secret. Everything else is reviewer-controlled text arriving from a JSON file this process did
 * not write:
 *
 * - A string goes through `sanitizePublicText`, the same redaction-and-bound every other public
 *   diagnostic string in this codebase crosses. A reviewer who pasted a token into a numeric
 *   setting by accident must not have it copied into a durable log by the very line reporting the
 *   mistake.
 * - An object or an array prints its shape and nothing else. There is no legitimate structured
 *   value for any of these settings, so printing the contents could only ever expose something;
 *   the shape is enough for the reviewer to recognise what they typed.
 */
export function formatSuppliedValue(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  if (typeof value === 'string') return `"${sanitizePublicText(value) ?? ''}"`;
  if (Array.isArray(value)) return `an array (${value.length} item(s))`;
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}

/** `[<runId>#<attempt>]`, on every line — `globalConcurrency` defaults to 3, so two attempts' blocks can interleave in one file and an untagged line would be unattributable. Matches `AgentTrace`'s own `[<requestId>]` shape. */
function attemptTag(snapshot: ReviewRunSnapshot): string {
  return `${snapshot.runId}#${String(snapshot.attempt)}`;
}

/**
 * One setting's line. The `policy <key>=<value>` head is identical in all three states on purpose:
 * one grep (`grep 'policy maxPromptKilobytesPerTurn='`) answers "what did this run use" whatever the
 * origin turned out to be, and the origin is the clause after it.
 *
 * The rejected clause names the supplied value and the used value and claims nothing about why.
 * `normalizeHarnessPolicy` both falls an unusable value back to its default *and* floors a
 * fractional one, so "unusable, replaced by the default" would be false for a supplied `10.5` that
 * became `10`. Stating both numbers is true in every case.
 */
function settingLine(tag: string, setting: ResolvedHarnessSetting): string {
  const head = `[${tag}] policy ${setting.settingKey}=${String(setting.value)}`;
  switch (setting.origin) {
    case 'setting':
      return `${head} (settings.json)`;
    case 'default':
      return `${head} (shipped default)`;
    case 'rejected':
      return `${head} — REJECTED: settings.json supplied ${formatSuppliedValue(setting.supplied)}, not used; the attempt runs on ${String(setting.value)}`;
  }
}

/** The counts line, so "are any of my settings being read at all" is answerable from one line before reading fifteen. Totals always sum to the surface size, which is what makes a missing line visible. */
function summaryLine(tag: string, settings: readonly ResolvedHarnessSetting[]): string {
  const count = (origin: HarnessSettingOrigin): number => settings.filter((setting) => setting.origin === origin).length;
  const rejected = count('rejected');
  const rejectedNote = rejected > 0 ? `, ${rejected} REJECTED` : '';
  return `[${tag}] policy ${settings.length} setting(s): ${count('setting')} from settings.json, ${count('default')} shipped default${rejectedNote}`;
}

/**
 * The whole block, without time prefixes — `writeAttemptConfiguration` adds those.
 *
 * The attempt's other resolved facts sit in the same block rather than somewhere else, because they
 * answer the same question. A reviewer asking "why did this run behave like that" wants the model
 * that actually answered, the source that actually served each member, and the revisions that were
 * actually pinned, next to the limits — not scattered across a file and a checkpoint. Every one of
 * them was settled during assembly and is in hand at this exact point.
 */
export function renderAttemptConfiguration(facts: AttemptConfigurationFacts): readonly string[] {
  const { snapshot, settings } = facts;
  const tag = attemptTag(snapshot);
  const lines: string[] = [`===== attempt ${tag} resolved configuration =====`];

  lines.push(
    `[${tag}] lineage=${snapshot.lineageId} target=${snapshot.targetKind}${snapshot.changesetId ? ` changeset=${snapshot.changesetId}` : ''} agent=${snapshot.agentId} effort=${snapshot.effort}`,
  );
  const capability = snapshot.modelCapability;
  lines.push(
    snapshot.modelId === undefined
      ? `[${tag}] model=(none — this agent calls no model)`
      : `[${tag}] model=${snapshot.modelId} vendor=${capability?.vendor ?? 'unknown'} family=${capability?.family ?? 'unknown'} maxInputTokens=${capability?.maxInputTokens ?? 'undeclared'}`,
  );
  lines.push(
    `[${tag}] contracts policyVersion=${snapshot.harnessPolicyVersion} toolContractVersion=${snapshot.toolContractVersion} snapshotSchema=${snapshot.schemaVersion}`,
  );

  for (const member of snapshot.members) {
    lines.push(
      `[${tag}] member ${member.memberId} source=${investigationSourceKindOf(member)} base=${member.baseSha} (${baseRevisionKindOf(member)}) head=${member.headSha}`,
    );
  }

  if (settings === undefined) {
    // Never silently omit the half of the block the reviewer came for: a file that simply stops
    // after the member lines reads as if the settings had all been defaults.
    lines.push(`[${tag}] policy: this host wired no settings reader, so no value below can be attributed to settings.json`);
  } else {
    lines.push(summaryLine(tag, settings));
    for (const setting of settings) lines.push(settingLine(tag, setting));
  }

  lines.push(`===== end resolved configuration for ${tag} =====`);
  return lines;
}

/**
 * Writes the block to the durable agent-trace sink, one line at a time, each led by the shared
 * local time-of-day — the same prefix `AgentTrace`, `apiTrace` and `extension.ts`'s activation
 * banner use, so a reviewer can line this block up against the request lines that follow it.
 *
 * Best-effort, like every other diagnostic write into a shared channel: a sink that throws must
 * never be the reason a review fails to start.
 */
export function writeAttemptConfiguration(
  sink: AgentTraceSink | undefined,
  now: () => number,
  facts: AttemptConfigurationFacts,
): void {
  if (!sink) return;
  try {
    const stamp = formatTimeOfDay(now());
    for (const line of renderAttemptConfiguration(facts)) sink.appendLine(`${stamp} ${line}`);
  } catch {
    // Never break a run over a diagnostic line.
  }
}
