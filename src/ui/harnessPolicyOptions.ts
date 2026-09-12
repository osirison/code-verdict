/**
 * The reviewer-relevant slice of `HarnessPolicy` (task 17.1/17.2 of
 * `add-agentic-review-harness`), read here in the UI layer and handed down —
 * the same `contextOptions.ts`/`agentRunOptions.ts` precedent: `app/harnessRuntime.ts`
 * and the rest of `src/app` never reach for `workspace.getConfiguration`.
 *
 * **Funnels into `normalizeHarnessPolicy`, never re-validates.** Every
 * numeric setting below is converted to the unit `HarnessPolicy` stores
 * internally (seconds to milliseconds, megabytes to bytes) and handed to
 * `normalizeHarnessPolicy` (`../domain/harnessPolicy`), which already does
 * per-field fallback for a missing, wrong-typed, zero, negative, or absurd
 * value. `HARNESS_POLICY_SETTINGS` is the one table listing which setting
 * maps to which `HarnessPolicy` field at what multiplier — `readHarnessPolicy`
 * and `harnessPolicyOptions.test.ts`'s drift assertion both read it, so the
 * setting list and the conversion cannot quietly diverge from each other.
 *
 * **Provider page sizes are deliberately absent.** `manifestPageSize`,
 * `diffOrFileReadPageLines`, `diffOrFileReadPageBytes`, `searchResultPageMatches`,
 * and `searchResultPageBytes` are internal pagination mechanics a reviewer
 * has no basis to tune, and the provider's own declared bounds override them
 * regardless — they stay out of this table, `package.json`, and the settings
 * UI (design.md "Configurable Initial Defaults").
 *
 * **The risk-coverage rule is the one non-numeric setting.** The shipped
 * default (`DEFAULT_RISK_COVERAGE_RULES.requireInspection`, `harnessRiskFloors.ts`)
 * requires medium and above to be actually read before a review can complete
 * — `low` is deliberately left to the model, because `harnessRiskFloors.ts`'s
 * `sourceCodeFloor` already keeps real source code out of `low` regardless of
 * what the model proposes, so relaxing the requirement below "every level"
 * does not reopen the fail-closed guarantee it used to provide.
 * `requireInspectionMinRisk` exposes *which* levels that applies to, through
 * the already-existing `risksAtLeast` helper, rather than accepting an
 * arbitrary array: the setting can only ever describe "this level and every
 * level above it", which is the one shape `configuredRiskCoverageSatisfied`
 * (`harnessCompletion.ts`) was designed to accept, so a reviewer can never
 * configure an incoherent rule (say, "high" without "medium"). Its own
 * fallback is the shipped default, same discipline as every numeric field —
 * a reviewer remains free to choose `low` explicitly for full coverage.
 *
 * **This module also answers "where did each value come from".**
 * `readResolvedHarnessPolicy` at the bottom returns the same values plus the
 * origin of each one, which is what an attempt writes into the agent trace
 * before it runs (`../app/harnessPolicyTrace.ts`). It is here and nowhere else
 * because `WorkspaceConfiguration.inspect` is the only API that separates a
 * value a reviewer set from `package.json`'s declared default, and `get` —
 * which every other reader in this file uses — folds the two together by
 * design. See `suppliedValue`'s own doc comment.
 */
import * as vscode from 'vscode';
import { isRiskLevel, RISK_LEVELS, type RiskLevel } from '../domain/harnessCoverage';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { DEFAULT_RISK_COVERAGE_RULES, risksAtLeast, type RiskCoverageRules } from '../app/harnessRiskFloors';
import type { ResolvedHarnessPolicy, ResolvedHarnessSetting } from '../app/harnessPolicyTrace';

export type { RiskLevel };

export interface HarnessSettingMapping {
  /** The name after `codeVerdict.harness.` in `package.json` and settings.json. */
  readonly settingKey: string;
  readonly policyField: keyof HarnessPolicy;
  /** Multiplies the configured (human) value into the unit `HarnessPolicy` stores. */
  readonly multiplier: number;
}

/**
 * The one list of reviewer-relevant numeric harness settings. Order here is
 * the order they render in the settings panel. Every entry is exercised by
 * `harnessPolicyOptions.test.ts`'s package.json-drift assertion, so a new row
 * here without a matching `package.json` entry (or vice versa) fails a test
 * rather than silently going stale.
 */
// `as const satisfies` (not a `: readonly HarnessSettingMapping[]` annotation) so each
// `settingKey`/`policyField` keeps its literal type — an explicit array-type annotation would
// widen `settingKey` to plain `string`, which would make `HarnessNumberSettingKey` below just
// `string` and silently defeat every literal-key check that depends on it.
export const HARNESS_POLICY_SETTINGS = [
  { settingKey: 'maxElapsedSecondsPerAttempt', policyField: 'maxElapsedMsPerAttempt', multiplier: 1000 },
  { settingKey: 'maxModelTurnsPerAttempt', policyField: 'maxModelTurnsPerAttempt', multiplier: 1 },
  { settingKey: 'maxToolRequestsPerAttempt', policyField: 'maxToolRequestsPerAttempt', multiplier: 1 },
  { settingKey: 'maxPromptKilobytesPerTurn', policyField: 'maxPromptBytesPerTurn', multiplier: 1024 },
  { settingKey: 'maxEvidenceMegabytesPerAttempt', policyField: 'maxEvidenceBytesPerAttempt', multiplier: 1024 * 1024 },
  { settingKey: 'highRiskReservePercent', policyField: 'highRiskReservePercent', multiplier: 1 },
  { settingKey: 'verificationReservePercent', policyField: 'verificationReservePercent', multiplier: 1 },
  { settingKey: 'transientRetriesPerOperation', policyField: 'transientRetriesPerOperation', multiplier: 1 },
  { settingKey: 'checkpointCadenceToolCalls', policyField: 'checkpointCadenceToolCalls', multiplier: 1 },
  { settingKey: 'retainedCheckpointsPerLineage', policyField: 'retainedCheckpointsPerLineage', multiplier: 1 },
  { settingKey: 'maxActivityEventsPerAttempt', policyField: 'maxActivityEventsPerAttempt', multiplier: 1 },
  { settingKey: 'terminalAttemptHistoryCount', policyField: 'terminalAttemptHistoryCount', multiplier: 1 },
  { settingKey: 'terminalAttemptHistoryMaxAgeDays', policyField: 'terminalAttemptHistoryMaxAgeDays', multiplier: 1 },
] as const satisfies readonly HarnessSettingMapping[];

export type HarnessNumberSettingKey = (typeof HARNESS_POLICY_SETTINGS)[number]['settingKey'];

/** The one non-numeric setting's key, kept alongside the numeric table for one shared "every harness key" list. */
export const REQUIRE_INSPECTION_MIN_RISK_SETTING = 'requireInspectionMinRisk';

/**
 * The one boolean `HarnessPolicy` setting's key. Kept out of `HARNESS_POLICY_SETTINGS` deliberately:
 * that table's own `harnessPolicyToSettingValues`/`DEFAULT_HARNESS_SETTING_VALUES` and the
 * package.json drift test both assume every entry's default is a `number` — a boolean default
 * would fail that assumption rather than extend it. `normalizeHarnessPolicySettings` below reads it
 * directly by this key instead, the same one-off treatment `REQUIRE_INSPECTION_MIN_RISK_SETTING`
 * already gets for the same reason.
 */
export const SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING = 'scopeInvestigationToChangedFiles';

/** Every `codeVerdict.harness.*` key this change defines — used to assert `package.json` has no stray entry. */
export const HARNESS_SETTING_KEYS: readonly string[] = [
  ...HARNESS_POLICY_SETTINGS.map((mapping) => mapping.settingKey),
  REQUIRE_INSPECTION_MIN_RISK_SETTING,
  SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING,
];

/** Numbers only pass through their multiplier; anything else (string, boolean, missing, NaN) is handed to `normalizeHarnessPolicy` unchanged so its own per-field fallback decides. */
function convert(value: unknown, multiplier: number): unknown {
  return typeof value === 'number' && Number.isFinite(value) ? value * multiplier : value;
}

/**
 * Pure: converts raw configured values (already unit-adjusted) into a full,
 * fallback-safe `HarnessPolicy` through `normalizeHarnessPolicy` — never a
 * second validation path. `raw` is keyed by `settingKey`, exactly what
 * `readHarnessPolicy` below reads from `workspace.getConfiguration`.
 */
export function normalizeHarnessPolicySettings(raw: Partial<Record<string, unknown>>): HarnessPolicy {
  const overrides: Partial<Record<keyof HarnessPolicy, unknown>> = {};
  for (const { settingKey, policyField, multiplier } of HARNESS_POLICY_SETTINGS) {
    overrides[policyField] = convert(raw[settingKey], multiplier);
  }
  // Not a number, so not run through `convert`'s multiplier path — `normalizeHarnessPolicy`'s own
  // `configuredBoolean` is what actually falls a missing/wrong-typed value back to the default.
  overrides.scopeInvestigationToChangedFiles = raw[SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING];
  return normalizeHarnessPolicy(overrides);
}

/** The only reader for the harness policy settings; `harnessRuntime.ts` receives the normalized policy, never a raw config value. */
export function readHarnessPolicy(): HarnessPolicy {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  const raw: Record<string, unknown> = {};
  for (const { settingKey } of HARNESS_POLICY_SETTINGS) raw[settingKey] = config.get<unknown>(`harness.${settingKey}`);
  raw[SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING] = config.get<unknown>(`harness.${SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING}`);
  return normalizeHarnessPolicySettings(raw);
}

/** `HarnessPolicy` field values converted back to the units the settings (and the panel) use. */
export function harnessPolicyToSettingValues(policy: HarnessPolicy): Record<HarnessNumberSettingKey, number> {
  const values = {} as Record<HarnessNumberSettingKey, number>;
  for (const { settingKey, policyField, multiplier } of HARNESS_POLICY_SETTINGS) {
    values[settingKey] = (policy[policyField] as number) / multiplier;
  }
  return values;
}

/** Design.md's default table, in setting units — used only by tests asserting `package.json`'s defaults agree with `DEFAULT_HARNESS_POLICY`. */
export const DEFAULT_HARNESS_SETTING_VALUES: Record<HarnessNumberSettingKey, number> =
  harnessPolicyToSettingValues(DEFAULT_HARNESS_POLICY);

/** `'medium'` reproduces the shipped default (`DEFAULT_RISK_COVERAGE_RULES.requireInspection`): medium and above require inspection, with `harnessRiskFloors.ts`'s source-code floor keeping real source code out of `low` in the first place. An unusable value falls back to it, never to a weaker level. */
export function normalizeRequireInspectionMinRisk(value: unknown): RiskLevel {
  return isRiskLevel(value) ? value : 'medium';
}

export const DEFAULT_REQUIRE_INSPECTION_MIN_RISK: RiskLevel = normalizeRequireInspectionMinRisk(undefined);

/**
 * Only `requireInspection` is configurable; `reserveEligible` and
 * `contradictionCheck` stay at their shipped defaults — this change exposes
 * the one field task 17's "decision already taken" names, not the whole
 * `RiskCoverageRules` shape.
 */
export function normalizeHarnessCoverageRules(minRiskRaw: unknown): RiskCoverageRules {
  const minRisk = normalizeRequireInspectionMinRisk(minRiskRaw);
  return {
    requireInspection: risksAtLeast(minRisk),
    reserveEligible: DEFAULT_RISK_COVERAGE_RULES.reserveEligible,
    contradictionCheck: DEFAULT_RISK_COVERAGE_RULES.contradictionCheck,
  };
}

export function readHarnessCoverageRules(): RiskCoverageRules {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return normalizeHarnessCoverageRules(config.get<unknown>(`harness.${REQUIRE_INSPECTION_MIN_RISK_SETTING}`));
}

/** The raw enum value, for display in the settings panel — `readHarnessCoverageRules` above returns the derived `RiskCoverageRules` the harness actually runs on. */
export function readRequireInspectionMinRisk(): RiskLevel {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return normalizeRequireInspectionMinRisk(config.get<unknown>(`harness.${REQUIRE_INSPECTION_MIN_RISK_SETTING}`));
}

/** `risksAtLeast('low')` is exactly `RISK_LEVELS` — restated here only so a test can assert the two never quietly diverge. */
export const FULL_RISK_COVERAGE: readonly RiskLevel[] = RISK_LEVELS;

/**
 * The same values `readHarnessPolicy`/`readHarnessCoverageRules` resolve, plus **where each one
 * came from** — the record `harnessRuntime.ts` writes into the agent trace at attempt start
 * (`../app/harnessPolicyTrace.ts`).
 *
 * ## `inspect`, not `get`, and that is the whole trick
 *
 * Every `codeVerdict.harness.*` key declares a `default` in `package.json`, so `config.get` never
 * returns `undefined` in a running extension: an untouched `maxPromptKilobytesPerTurn` comes back as
 * `192`, byte-identical to what a reviewer who typed `192` gets. Provenance derived from those
 * values would report every single setting as reviewer-set and answer the reviewer's question
 * wrongly — confidently, and in a durable log. `WorkspaceConfiguration.inspect` is the only API that
 * separates the layers, so `suppliedValue` below reads it and takes the most specific *user* layer
 * (`workspaceFolderValue`, then `workspaceValue`, then `globalValue`), leaving `undefined` to mean
 * exactly one thing: nobody set this.
 *
 * Language-scoped layers (`globalLanguageValue` and friends) are ignored deliberately. None of these
 * settings is language-scoped — they configure a review run, not an editor behaviour for a file
 * type — and reading them would let a `[typescript]` block silently become the answer to "where did
 * this value come from" for a value no review ever used.
 *
 * ## The effective value still comes from `get`
 *
 * `resolveHarnessPolicySettings` takes both records and funnels `effective` — the `get` values —
 * through the existing `normalizeHarnessPolicySettings`, unchanged. `inspect` is used only to
 * classify. That keeps behaviour exactly as it was: a default contributed by another extension
 * through `configurationDefaults` still wins the way it always did, and still reads as a default
 * here, which is honest — it is one, just not ours.
 */
export function suppliedValue(config: vscode.WorkspaceConfiguration, key: string): unknown {
  const inspected = config.inspect<unknown>(key);
  if (!inspected) return undefined;
  return inspected.workspaceFolderValue ?? inspected.workspaceValue ?? inspected.globalValue;
}

/**
 * Classifies one setting from the two values already in hand — no third source of truth, and no
 * second validation path.
 *
 * `resolved` is what the attempt actually runs on, converted back into the setting's own unit
 * (`harnessPolicyToSettingValues` for the numbers, the policy field itself for the boolean, the
 * normalized enum for the risk level). So the comparison is like-for-like and needs no knowledge of
 * what `normalizeHarnessPolicy` did:
 *
 * - nothing supplied → `default`;
 * - supplied and identical to what ran → `setting`, which is the answer a reviewer who set a value
 *   equal to the default needs and could not previously get;
 * - supplied and different from what ran → `rejected`. That covers both ways normalization can
 *   discard a value — an unusable one falling back to its default, and a fractional one being
 *   floored — and the rendered line names both numbers rather than guessing which happened
 *   (`../app/harnessPolicyTrace.ts`'s `settingLine`).
 */
function classify(settingKey: string, resolved: number | boolean | string, supplied: unknown): ResolvedHarnessSetting {
  if (supplied === undefined) return { settingKey, value: resolved, origin: 'default' };
  if (supplied === resolved) return { settingKey, value: resolved, origin: 'setting' };
  return { settingKey, value: resolved, origin: 'rejected', supplied };
}

/**
 * Pure half of `readResolvedHarnessPolicy`: `effective` is what `config.get` returned (keyed by
 * `settingKey`), `supplied` is the user-layer-only view from `config.inspect`. Emits one entry per
 * key in `HARNESS_SETTING_KEYS` order — the numeric table first, in settings-panel order, then the
 * boolean, then the risk enum — so a reviewer reads the block in the order the settings UI shows
 * them.
 *
 * `requireInspectionMinRisk` is here even though the harness receives it as a derived
 * `RiskCoverageRules` through its own getter: the reviewer sets a level, so the level is what the
 * block must state. The derived rule set stays `readHarnessCoverageRules`'s job and is unaffected.
 */
export function resolveHarnessPolicySettings(
  effective: Partial<Record<string, unknown>>,
  supplied: Partial<Record<string, unknown>>,
): ResolvedHarnessPolicy {
  const policy = normalizeHarnessPolicySettings(effective);
  const inSettingUnits = harnessPolicyToSettingValues(policy);
  const settings: ResolvedHarnessSetting[] = HARNESS_POLICY_SETTINGS.map(({ settingKey }) =>
    classify(settingKey, inSettingUnits[settingKey], supplied[settingKey]),
  );
  settings.push(
    classify(
      REQUIRE_INSPECTION_MIN_RISK_SETTING,
      normalizeRequireInspectionMinRisk(effective[REQUIRE_INSPECTION_MIN_RISK_SETTING]),
      supplied[REQUIRE_INSPECTION_MIN_RISK_SETTING],
    ),
  );
  settings.push(
    classify(
      SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING,
      policy.scopeInvestigationToChangedFiles,
      supplied[SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING],
    ),
  );
  return { policy, settings };
}

/**
 * The reader production wiring hands the harness runtime (`extension.ts`), as a getter — one
 * configuration read per attempt built, producing the policy and its provenance together so the two
 * can never describe different configurations (`ResolvedHarnessPolicy`'s own doc comment).
 *
 * Supersedes `readHarnessPolicy` for the runtime; `readHarnessPolicy` stays for the settings panel,
 * which needs the values and not where they came from.
 */
export function readResolvedHarnessPolicy(): ResolvedHarnessPolicy {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  const effective: Record<string, unknown> = {};
  const supplied: Record<string, unknown> = {};
  for (const settingKey of HARNESS_SETTING_KEYS) {
    effective[settingKey] = config.get<unknown>(`harness.${settingKey}`);
    supplied[settingKey] = suppliedValue(config, `harness.${settingKey}`);
  }
  return resolveHarnessPolicySettings(effective, supplied);
}
