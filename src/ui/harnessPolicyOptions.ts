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
 * requires every risk level to be actually read before a review can complete
 * — the fail-closed default this change does not relax. `requireInspectionMinRisk`
 * exposes *which* levels that applies to, through the already-existing
 * `risksAtLeast` helper, rather than accepting an arbitrary array: the
 * setting can only ever describe "this level and every level above it",
 * which is the one shape `configuredRiskCoverageSatisfied` (`harnessCompletion.ts`)
 * was designed to accept, so a reviewer can never configure an incoherent
 * rule (say, "high" without "medium"). Its own fallback is the fail-closed
 * default, same discipline as every numeric field.
 */
import * as vscode from 'vscode';
import { isRiskLevel, RISK_LEVELS, type RiskLevel } from '../domain/harnessCoverage';
import { DEFAULT_HARNESS_POLICY, normalizeHarnessPolicy, type HarnessPolicy } from '../domain/harnessPolicy';
import { DEFAULT_RISK_COVERAGE_RULES, risksAtLeast, type RiskCoverageRules } from '../app/harnessRiskFloors';

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

/** Every `codeVerdict.harness.*` key this change defines — used to assert `package.json` has no stray entry. */
export const HARNESS_SETTING_KEYS: readonly string[] = [
  ...HARNESS_POLICY_SETTINGS.map((mapping) => mapping.settingKey),
  REQUIRE_INSPECTION_MIN_RISK_SETTING,
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
  return normalizeHarnessPolicy(overrides);
}

/** The only reader for the harness policy settings; `harnessRuntime.ts` receives the normalized policy, never a raw config value. */
export function readHarnessPolicy(): HarnessPolicy {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  const raw: Record<string, unknown> = {};
  for (const { settingKey } of HARNESS_POLICY_SETTINGS) raw[settingKey] = config.get<unknown>(`harness.${settingKey}`);
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

/** `'low'` reproduces the shipped fail-closed default: every risk level requires inspection. An unusable value falls back to it, never to a weaker level. */
export function normalizeRequireInspectionMinRisk(value: unknown): RiskLevel {
  return isRiskLevel(value) ? value : 'low';
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
