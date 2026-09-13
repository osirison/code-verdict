import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCompletion, type CompletionEvaluationInput } from '../app/harnessCompletion';
import { createChangedFileInventory } from '../app/harnessInventory';
import { DEFAULT_RISK_COVERAGE_RULES } from '../app/harnessRiskFloors';
import {
  renderAttemptConfiguration,
  type ResolvedHarnessPolicy,
  type ResolvedHarnessSetting,
} from '../app/harnessPolicyTrace';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { DEFAULT_HARNESS_POLICY, HARNESS_POLICY_VERSION } from '../domain/harnessPolicy';
import type { ReviewRunSnapshot } from '../domain/reviewRunSnapshot';
import type { ChangedFileEntry, InvestigationSnapshotRef } from '../platform/types';

/**
 * Two records, because the real `WorkspaceConfiguration` has two answers and the difference is the
 * whole point of the provenance reader.
 *
 * `values` is what `get` returns — in a running extension that is never `undefined` for a
 * `codeVerdict.harness.*` key, because every one of them declares a `default` in `package.json`, so
 * an untouched setting comes back as the shipped number. `userValues` is what `inspect` reports for
 * the layers a reviewer actually edits. A test that wants "the reviewer set this" must put the value
 * in both (`setUserSetting` below); a test that wants "nobody set this" leaves `userValues` empty
 * while `values` still answers, exactly as production does.
 */
const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown>, userValues: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({
      get: (key: string) => settings.values[key],
      // Only the three layers `suppliedValue` reads. The language-scoped layers a real `inspect`
      // also returns are deliberately absent: none of these settings is language-scoped, and the
      // reader ignores them.
      inspect: (key: string) => ({
        defaultValue: undefined,
        globalValue: settings.userValues[key],
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
      }),
    }),
  },
}));

import {
  DEFAULT_HARNESS_SETTING_VALUES,
  DEFAULT_REQUIRE_INSPECTION_MIN_RISK,
  FULL_RISK_COVERAGE,
  HARNESS_POLICY_SETTINGS,
  HARNESS_SETTING_KEYS,
  SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING,
  normalizeHarnessCoverageRules,
  normalizeHarnessPolicySettings,
  readHarnessCoverageRules,
  readHarnessPolicy,
  readResolvedHarnessPolicy,
} from './harnessPolicyOptions';

describe('harness policy settings — funnel into normalizeHarnessPolicy, never re-validate', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('falls back to DEFAULT_HARNESS_POLICY for every field when nothing is configured', () => {
    expect(readHarnessPolicy()).toEqual(DEFAULT_HARNESS_POLICY);
  });

  it('a hostile configuration — zero, negative, absurd, wrong-typed — falls back per field to the documented default', () => {
    const hostile: Record<string, unknown> = {
      maxElapsedSecondsPerAttempt: 0,
      maxModelTurnsPerAttempt: -5,
      maxToolRequestsPerAttempt: Number.NaN,
      maxEvidenceMegabytesPerAttempt: '8',
      highRiskReservePercent: 250,
      verificationReservePercent: -1,
      transientRetriesPerOperation: Number.POSITIVE_INFINITY,
      checkpointCadenceToolCalls: 0,
      retainedCheckpointsPerLineage: -3,
      maxActivityEventsPerAttempt: null,
      terminalAttemptHistoryCount: {},
      terminalAttemptHistoryMaxAgeDays: [],
    };
    expect(normalizeHarnessPolicySettings(hostile)).toEqual(DEFAULT_HARNESS_POLICY);
  });

  it('falls back for every field when the setting is simply absent', () => {
    expect(normalizeHarnessPolicySettings({})).toEqual(DEFAULT_HARNESS_POLICY);
  });

  it('converts configured values from their setting unit into the unit HarnessPolicy stores', () => {
    settings.values = {
      'harness.maxElapsedSecondsPerAttempt': 60,
      'harness.maxEvidenceMegabytesPerAttempt': 2,
      'harness.maxModelTurnsPerAttempt': 10,
      'harness.highRiskReservePercent': 30,
    };
    const policy = readHarnessPolicy();
    expect(policy.maxElapsedMsPerAttempt).toBe(60_000);
    expect(policy.maxEvidenceBytesPerAttempt).toBe(2 * 1024 * 1024);
    expect(policy.maxModelTurnsPerAttempt).toBe(10);
    expect(policy.highRiskReservePercent).toBe(30);
    // Every field this change does not expose stays at its shipped default.
    expect(policy.manifestPageSize).toBe(DEFAULT_HARNESS_POLICY.manifestPageSize);
    expect(policy.backoffJitter).toBe(DEFAULT_HARNESS_POLICY.backoffJitter);
  });

  it('no provider page-size field is in the exposed settings table', () => {
    const exposedFields = HARNESS_POLICY_SETTINGS.map((mapping) => mapping.policyField);
    for (const pageSizeField of [
      'manifestPageSize',
      'diffOrFileReadPageLines',
      'diffOrFileReadPageBytes',
      'searchResultPageMatches',
      'searchResultPageBytes',
    ] as const) {
      expect(exposedFields).not.toContain(pageSizeField);
    }
  });

  it('reads scopeInvestigationToChangedFiles through workspace.getConfiguration, falling back per field on a wrong-typed value', () => {
    settings.values['harness.scopeInvestigationToChangedFiles'] = false;
    expect(readHarnessPolicy().scopeInvestigationToChangedFiles).toBe(false);

    settings.values['harness.scopeInvestigationToChangedFiles'] = 'not-a-boolean';
    expect(readHarnessPolicy().scopeInvestigationToChangedFiles).toBe(DEFAULT_HARNESS_POLICY.scopeInvestigationToChangedFiles);
  });
});

describe('the risk-coverage setting — reuses risksAtLeast, cannot express an incoherent rule', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('falls back to the shipped default (medium and above require inspection) for any unusable value', () => {
    for (const bad of [undefined, null, 42, 'nonsense', ['high'], {}, '']) {
      const rules = normalizeHarnessCoverageRules(bad);
      expect(rules.requireInspection).toEqual(DEFAULT_RISK_COVERAGE_RULES.requireInspection);
      expect(rules.requireInspection).toEqual(['medium', 'high']);
    }
    expect(DEFAULT_REQUIRE_INSPECTION_MIN_RISK).toBe('medium');
  });

  it('never changes reserveEligible or contradictionCheck — only requireInspection is configurable', () => {
    const rules = normalizeHarnessCoverageRules('high');
    expect(rules.reserveEligible).toEqual(DEFAULT_RISK_COVERAGE_RULES.reserveEligible);
    expect(rules.contradictionCheck).toEqual(DEFAULT_RISK_COVERAGE_RULES.contradictionCheck);
  });

  it('an explicit reviewer choice narrows which levels require inspection, monotonically', () => {
    expect(normalizeHarnessCoverageRules('low').requireInspection).toEqual(FULL_RISK_COVERAGE);
    expect(normalizeHarnessCoverageRules('medium').requireInspection).toEqual(['medium', 'high']);
    expect(normalizeHarnessCoverageRules('high').requireInspection).toEqual(['high']);
  });

  it('reads the configured setting through workspace.getConfiguration', () => {
    settings.values = { 'harness.requireInspectionMinRisk': 'medium' };
    expect(readHarnessCoverageRules().requireInspection).toEqual(['medium', 'high']);
  });
});

const SNAPSHOT: InvestigationSnapshotRef = { repoId: 'repo-1', baseSha: 'base-1', headSha: 'head-1' };

function entry(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 1, removedLines: 1, ...overrides };
}

/** Every clause but `configuredRiskCoverageSatisfied` passing, so a failure isolates to that one clause. */
function passingExcept(inventory: ReturnType<typeof createChangedFileInventory>): CompletionEvaluationInput {
  return {
    heads: [{ memberId: 'm1', snapshotHeadSha: 'head-1', currentHead: { repoId: 'repo-1', state: 'resolved', headSha: 'head-1' } }],
    inventory,
    unresolved: { unresolvedFetches: 0, unresolvedCandidates: 0 },
    citations: { revalidated: true, invalidatedCount: 0 },
    passes: { contradictionPassComplete: true, deduplicationComplete: true, finalVerificationComplete: true },
    budget: { hardExhausted: false, timedOut: false },
  };
}

describe('a settings-driven hostile configuration never weakens the completion gate below the fail-closed default', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('a garbage requireInspectionMinRisk setting still requires a medium-risk file to be inspected before completion', () => {
    settings.values['harness.requireInspectionMinRisk'] = 'not-a-real-risk-level';
    const rules = readHarnessCoverageRules();
    expect(rules.requireInspection).toEqual(DEFAULT_RISK_COVERAGE_RULES.requireInspection);

    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    // `inventory.classify` records whatever risk it is given directly, bypassing
    // `harnessRiskFloors.ts` entirely — so the risk that matters here is chosen
    // explicitly (`medium`, what the source-code floor would have produced for
    // a real `.ts` file), not left to a garbage setting to weaken.
    inventory.classify('m1', 'a', { risk: 'medium' });
    // Deliberately never `markInspected` — this is the shipped default's whole point.
    const evaluation = evaluateCompletion({ ...passingExcept(inventory), coverageRules: rules });
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.blockers).toEqual(['insufficientRiskCoverage']);
  });

  it('an explicit reviewer choice to relax coverage is honoured — that is the setting working as designed, not an invariant broken', () => {
    settings.values['harness.requireInspectionMinRisk'] = 'high';
    const rules = readHarnessCoverageRules();
    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    inventory.classify('m1', 'a', { risk: 'low' });
    const evaluation = evaluateCompletion({ ...passingExcept(inventory), coverageRules: rules });
    expect(evaluation.eligible).toBe(true);
  });
});

// ---- package.json agreement -------------------------------------------------------

// Read, not imported: a JSON import would land in the esbuild bundle (the
// same reasoning `agentRunOptions.test.ts` and `commands.test.ts` already
// use for their own manifest-drift assertions).
const manifestProperties = (
  JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown; type?: string }> } };
  }
).contributes.configuration.properties;

describe('package.json cannot drift from DEFAULT_HARNESS_POLICY', () => {
  it('every numeric harness setting default equals the code default, converted through the same table', () => {
    for (const { settingKey, policyField, multiplier } of HARNESS_POLICY_SETTINGS) {
      const manifestDefault = manifestProperties[`codeVerdict.harness.${settingKey}`]?.default;
      expect(typeof manifestDefault).toBe('number');
      expect((manifestDefault as number) * multiplier).toBe(DEFAULT_HARNESS_POLICY[policyField]);
      expect(manifestDefault).toBe(DEFAULT_HARNESS_SETTING_VALUES[settingKey]);
    }
  });

  it('the requireInspectionMinRisk default reproduces the shipped fail-closed default', () => {
    const manifestDefault = manifestProperties['codeVerdict.harness.requireInspectionMinRisk']?.default;
    expect(manifestDefault).toBe(DEFAULT_REQUIRE_INSPECTION_MIN_RISK);
    expect(normalizeHarnessCoverageRules(manifestDefault).requireInspection).toEqual(
      DEFAULT_RISK_COVERAGE_RULES.requireInspection,
    );
  });

  it('the scopeInvestigationToChangedFiles default matches DEFAULT_HARNESS_POLICY — a review may read the repository it was cloned from unless a reviewer narrows it', () => {
    const manifestDefault = manifestProperties[`codeVerdict.harness.${SCOPE_INVESTIGATION_TO_CHANGED_FILES_SETTING}`]?.default;
    expect(manifestDefault).toBe(DEFAULT_HARNESS_POLICY.scopeInvestigationToChangedFiles);
    expect(manifestDefault).toBe(false);
  });

  it('every codeVerdict.harness.* key in package.json is one this module knows about, and vice versa', () => {
    const manifestHarnessKeys = Object.keys(manifestProperties)
      .filter((key) => key.startsWith('codeVerdict.harness.'))
      .map((key) => key.slice('codeVerdict.harness.'.length))
      .sort();
    expect(manifestHarnessKeys).toEqual([...HARNESS_SETTING_KEYS].sort());
  });

  it('no page-size setting is exposed in package.json', () => {
    for (const pageSizeKey of [
      'manifestPageSize',
      'diffOrFileReadPageLines',
      'diffOrFileReadPageBytes',
      'searchResultPageMatches',
      'searchResultPageBytes',
    ]) {
      expect(manifestProperties[`codeVerdict.harness.${pageSizeKey}`]).toBeUndefined();
    }
  });
});

/**
 * The settings table and the panel's controls are hand-kept in sync. A setting
 * in one and not the other ships either a value with no control or a control
 * writing a key nothing reads, and neither fails loudly on its own.
 */
describe('the harness settings table and the panel controls name the same settings', () => {
  it('every numeric harness setting has exactly one control, and every control has a setting', async () => {
    const { HARNESS_NUMBER_FIELDS } = await import('./settingsHtml.js');
    const settings = HARNESS_POLICY_SETTINGS.map((mapping) => mapping.settingKey).slice().sort();
    const controls = HARNESS_NUMBER_FIELDS.map((field) => field.key).slice().sort();
    expect(controls).toEqual(settings);
  });
});

// ---- Provenance: which values ran, and where each of them came from ----------------

/**
 * The block an attempt writes into the agent trace before it runs
 * (`../app/harnessPolicyTrace.ts`) is only worth anything if the origin it prints is true. This is
 * where that is established, because this is the module that reads the configuration.
 *
 * The trap these tests exist to hold shut: `config.get` folds an unset key into `package.json`'s
 * declared default, so in a running extension it returns `192` for a `maxPromptKilobytesPerTurn`
 * nobody has ever touched — indistinguishable from one a reviewer typed. Provenance derived from
 * `get` would report every setting as reviewer-set and answer "did my change take effect" wrongly,
 * in a durable log, with total confidence. `inspect` is the only API that separates the layers.
 */

/** A setting the reviewer actually put in settings.json: present in both the effective view and the user layer, exactly as the real API reports one. */
function setUserSetting(settingKey: string, value: unknown): void {
  settings.values[`harness.${settingKey}`] = value;
  settings.userValues[`harness.${settingKey}`] = value;
}

/** What `config.get` returns in a running extension for a configuration nobody has edited: every declared default, and no user layer at all. */
function shippedDefaultsOnly(): void {
  settings.values = {};
  settings.userValues = {};
  for (const settingKey of HARNESS_SETTING_KEYS) {
    settings.values[`harness.${settingKey}`] = manifestProperties[`codeVerdict.harness.${settingKey}`]?.default;
  }
}

function settingNamed(resolved: ResolvedHarnessPolicy, settingKey: string): ResolvedHarnessSetting {
  const found = resolved.settings.find((setting) => setting.settingKey === settingKey);
  expect(found, `no line for ${settingKey}`).toBeDefined();
  return found!;
}

describe('resolved harness settings carry where each value came from', () => {
  beforeEach(() => {
    settings.values = {};
    settings.userValues = {};
  });

  it('reports the shipped default as a default even though config.get hands back the very same number', () => {
    shippedDefaultsOnly();
    const resolved = readResolvedHarnessPolicy();
    for (const setting of resolved.settings) expect(setting.origin).toBe('default');
    expect(settingNamed(resolved, 'maxPromptKilobytesPerTurn').value).toBe(192);
  });

  it('distinguishes "the reviewer set it to exactly the default" from "the reviewer set nothing" — the fact a stale-settings suspicion turns on', () => {
    shippedDefaultsOnly();
    setUserSetting('maxPromptKilobytesPerTurn', 192);
    const resolved = readResolvedHarnessPolicy();
    const set = settingNamed(resolved, 'maxPromptKilobytesPerTurn');
    expect(set.origin).toBe('setting');
    expect(set.value).toBe(192);
    // The number is identical to the default's; only the origin tells them apart.
    expect(settingNamed(resolved, 'maxModelTurnsPerAttempt').origin).toBe('default');
  });

  it('reports a reviewer-set value in the reviewer’s own unit, under the reviewer’s own key', () => {
    shippedDefaultsOnly();
    setUserSetting('maxPromptKilobytesPerTurn', 96);
    setUserSetting('maxElapsedSecondsPerAttempt', 600);
    const resolved = readResolvedHarnessPolicy();
    expect(settingNamed(resolved, 'maxPromptKilobytesPerTurn')).toEqual({
      settingKey: 'maxPromptKilobytesPerTurn',
      value: 96,
      origin: 'setting',
    });
    // The policy stores bytes and milliseconds; the block states kilobytes and seconds, because that
    // is what the reviewer typed and what they will grep for.
    expect(resolved.policy.maxPromptBytesPerTurn).toBe(96 * 1024);
    expect(settingNamed(resolved, 'maxElapsedSecondsPerAttempt').value).toBe(600);
    expect(resolved.policy.maxElapsedMsPerAttempt).toBe(600_000);
  });

  it('reports a value normalization discarded as rejected, naming what was supplied and what ran instead', () => {
    shippedDefaultsOnly();
    setUserSetting('maxModelTurnsPerAttempt', -5);
    setUserSetting('retainedCheckpointsPerLineage', 0);
    setUserSetting('requireInspectionMinRisk', 'nonsense');
    setUserSetting('scopeInvestigationToChangedFiles', 'yes please');
    const resolved = readResolvedHarnessPolicy();

    expect(settingNamed(resolved, 'maxModelTurnsPerAttempt')).toEqual({
      settingKey: 'maxModelTurnsPerAttempt',
      value: 64,
      origin: 'rejected',
      supplied: -5,
    });
    expect(settingNamed(resolved, 'retainedCheckpointsPerLineage')).toEqual({
      settingKey: 'retainedCheckpointsPerLineage',
      value: 3,
      origin: 'rejected',
      supplied: 0,
    });
    expect(settingNamed(resolved, 'requireInspectionMinRisk')).toEqual({
      settingKey: 'requireInspectionMinRisk',
      value: 'medium',
      origin: 'rejected',
      supplied: 'nonsense',
    });
    expect(settingNamed(resolved, 'scopeInvestigationToChangedFiles')).toEqual({
      settingKey: 'scopeInvestigationToChangedFiles',
      value: false,
      origin: 'rejected',
      supplied: 'yes please',
    });
  });

  it('reports a fractional value as rejected too — floored, not defaulted — and the line states both numbers rather than guessing which happened', () => {
    shippedDefaultsOnly();
    setUserSetting('checkpointCadenceToolCalls', 10.5);
    const resolved = readResolvedHarnessPolicy();
    expect(settingNamed(resolved, 'checkpointCadenceToolCalls')).toEqual({
      settingKey: 'checkpointCadenceToolCalls',
      value: 10,
      origin: 'rejected',
      supplied: 10.5,
    });
    const lines = renderAttemptConfiguration({ snapshot: traceSnapshot(), settings: resolved.settings });
    expect(lines).toContain(
      '[run-doc-1#1] policy checkpointCadenceToolCalls=10 — REJECTED: settings.json supplied 10.5, not used; the attempt runs on 10',
    );
  });

  it('emits exactly one entry per codeVerdict.harness.* key, in settings-panel order — a new setting cannot be silently omitted from the block', () => {
    shippedDefaultsOnly();
    const resolved = readResolvedHarnessPolicy();
    expect(resolved.settings.map((setting) => setting.settingKey)).toEqual([...HARNESS_SETTING_KEYS]);
  });

  it('resolves the identical policy readHarnessPolicy does — provenance is added beside the funnel, never a second validation path', () => {
    shippedDefaultsOnly();
    setUserSetting('maxPromptKilobytesPerTurn', 96);
    setUserSetting('highRiskReservePercent', 250);
    expect(readResolvedHarnessPolicy().policy).toEqual(readHarnessPolicy());
  });
});

/**
 * The rendered block itself, pinned — it is the deliverable, so it is asserted whole rather than by
 * a handful of `toContain`s that would let a reordering or a dropped line through.
 */
const traceSnapshot = (): ReviewRunSnapshot => ({
  schemaVersion: '1',
  runId: 'run-doc-1',
  lineageId: 'lineage-doc-1',
  attempt: 1,
  createdAt: '2026-09-12T09:00:00.000Z',
  targetKind: 'cr',
  members: [
    {
      memberId: 'acme/widgets!42',
      providerId: 'github',
      instanceUrl: 'https://github.com',
      ref: { repoId: 'acme/widgets', number: '42' },
      baseSha: '1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d',
      baseRevisionKind: 'mergeBase',
      headSha: 'f0e9d8c7b6a5948372f0e9d8c7b6a5948372f0e9',
      investigationSource: { kind: 'localGit', contractVersion: '1', capabilitySignature: 'cap-sig' },
      providerCapabilitySignature: 'provider-sig',
      rootAgentsPolicy: { present: false },
      context: { autoContextEnabled: false, titleIncluded: false, descriptionIncluded: false, linkedItemIdsIncluded: [], attachments: [] },
    },
  ],
  agentId: 'agent:builtin/default',
  agentInstructions: 'You are a code review agent. Review ONLY the diffs below.',
  agentInstructionsDigest: 'agent-digest',
  personaLabel: 'Built-in reviewer',
  modelId: 'copilot:gpt-4o',
  modelCapability: { vendor: 'copilot', family: 'gpt-4o', maxInputTokens: 128_000 },
  effort: 'none',
  effortInstructionDigest: 'effort-digest',
  criteria: DEFAULT_CRITERIA,
  extraInstructionsDigest: 'extra-digest',
  toolContractVersion: '1',
  harnessPolicyVersion: HARNESS_POLICY_VERSION,
});

describe('the block as a reviewer reads it', () => {
  beforeEach(() => {
    settings.values = {};
    settings.userValues = {};
  });

  const HEAD = [
    '===== attempt run-doc-1#1 resolved configuration =====',
    '[run-doc-1#1] lineage=lineage-doc-1 target=cr agent=agent:builtin/default effort=none',
    '[run-doc-1#1] model=copilot:gpt-4o vendor=copilot family=gpt-4o maxInputTokens=128000',
    `[run-doc-1#1] contracts policyVersion=${HARNESS_POLICY_VERSION} toolContractVersion=1 snapshotSchema=1`,
    '[run-doc-1#1] member acme/widgets!42 source=localGit base=1a2b3c4d5e6f70819a2b3c4d5e6f70819a2b3c4d (mergeBase) head=f0e9d8c7b6a5948372f0e9d8c7b6a5948372f0e9',
  ];
  const TAIL = ['===== end resolved configuration for run-doc-1#1 ====='];

  it('a default configuration: fifteen values, every one of them shipped, nothing attributable to settings.json', () => {
    shippedDefaultsOnly();
    const lines = renderAttemptConfiguration({ snapshot: traceSnapshot(), settings: readResolvedHarnessPolicy().settings });
    expect(lines).toEqual([
      ...HEAD,
      '[run-doc-1#1] policy 15 setting(s): 0 from settings.json, 15 shipped default',
      '[run-doc-1#1] policy maxElapsedSecondsPerAttempt=1800 (shipped default)',
      '[run-doc-1#1] policy maxModelTurnsPerAttempt=64 (shipped default)',
      '[run-doc-1#1] policy maxToolRequestsPerAttempt=256 (shipped default)',
      '[run-doc-1#1] policy maxPromptKilobytesPerTurn=192 (shipped default)',
      '[run-doc-1#1] policy maxEvidenceMegabytesPerAttempt=8 (shipped default)',
      '[run-doc-1#1] policy highRiskReservePercent=20 (shipped default)',
      '[run-doc-1#1] policy verificationReservePercent=15 (shipped default)',
      '[run-doc-1#1] policy transientRetriesPerOperation=3 (shipped default)',
      '[run-doc-1#1] policy checkpointCadenceToolCalls=10 (shipped default)',
      '[run-doc-1#1] policy retainedCheckpointsPerLineage=3 (shipped default)',
      '[run-doc-1#1] policy maxActivityEventsPerAttempt=1000 (shipped default)',
      '[run-doc-1#1] policy terminalAttemptHistoryCount=5 (shipped default)',
      '[run-doc-1#1] policy terminalAttemptHistoryMaxAgeDays=30 (shipped default)',
      '[run-doc-1#1] policy requireInspectionMinRisk=medium (shipped default)',
      '[run-doc-1#1] policy scopeInvestigationToChangedFiles=false (shipped default)',
      ...TAIL,
    ]);
  });

  it('two settings changed — one taken, one discarded — and the block says which is which without the reviewer opening settings.json', () => {
    shippedDefaultsOnly();
    setUserSetting('maxPromptKilobytesPerTurn', 96);
    setUserSetting('maxModelTurnsPerAttempt', -5);
    const lines = renderAttemptConfiguration({ snapshot: traceSnapshot(), settings: readResolvedHarnessPolicy().settings });
    expect(lines).toEqual([
      ...HEAD,
      '[run-doc-1#1] policy 15 setting(s): 1 from settings.json, 13 shipped default, 1 REJECTED',
      '[run-doc-1#1] policy maxElapsedSecondsPerAttempt=1800 (shipped default)',
      '[run-doc-1#1] policy maxModelTurnsPerAttempt=64 — REJECTED: settings.json supplied -5, not used; the attempt runs on 64',
      '[run-doc-1#1] policy maxToolRequestsPerAttempt=256 (shipped default)',
      '[run-doc-1#1] policy maxPromptKilobytesPerTurn=96 (settings.json)',
      '[run-doc-1#1] policy maxEvidenceMegabytesPerAttempt=8 (shipped default)',
      '[run-doc-1#1] policy highRiskReservePercent=20 (shipped default)',
      '[run-doc-1#1] policy verificationReservePercent=15 (shipped default)',
      '[run-doc-1#1] policy transientRetriesPerOperation=3 (shipped default)',
      '[run-doc-1#1] policy checkpointCadenceToolCalls=10 (shipped default)',
      '[run-doc-1#1] policy retainedCheckpointsPerLineage=3 (shipped default)',
      '[run-doc-1#1] policy maxActivityEventsPerAttempt=1000 (shipped default)',
      '[run-doc-1#1] policy terminalAttemptHistoryCount=5 (shipped default)',
      '[run-doc-1#1] policy terminalAttemptHistoryMaxAgeDays=30 (shipped default)',
      '[run-doc-1#1] policy requireInspectionMinRisk=medium (shipped default)',
      '[run-doc-1#1] policy scopeInvestigationToChangedFiles=false (shipped default)',
      ...TAIL,
    ]);
  });
});
