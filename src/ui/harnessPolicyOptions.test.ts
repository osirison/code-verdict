import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCompletion, type CompletionEvaluationInput } from '../app/harnessCompletion';
import { createChangedFileInventory } from '../app/harnessInventory';
import { DEFAULT_RISK_COVERAGE_RULES } from '../app/harnessRiskFloors';
import { DEFAULT_HARNESS_POLICY } from '../domain/harnessPolicy';
import type { ChangedFileEntry, InvestigationSnapshotRef } from '../platform/types';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => settings.values[key] }),
  },
}));

import {
  DEFAULT_HARNESS_SETTING_VALUES,
  DEFAULT_REQUIRE_INSPECTION_MIN_RISK,
  FULL_RISK_COVERAGE,
  HARNESS_POLICY_SETTINGS,
  HARNESS_SETTING_KEYS,
  normalizeHarnessCoverageRules,
  normalizeHarnessPolicySettings,
  readHarnessCoverageRules,
  readHarnessPolicy,
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
});

describe('the risk-coverage setting — reuses risksAtLeast, cannot express an incoherent rule', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('falls back to the shipped fail-closed default (every level requires inspection) for any unusable value', () => {
    for (const bad of [undefined, null, 42, 'nonsense', ['high'], {}, '']) {
      const rules = normalizeHarnessCoverageRules(bad);
      expect(rules.requireInspection).toEqual(DEFAULT_RISK_COVERAGE_RULES.requireInspection);
      expect(rules.requireInspection).toEqual(FULL_RISK_COVERAGE);
    }
    expect(DEFAULT_REQUIRE_INSPECTION_MIN_RISK).toBe('low');
  });

  it('never changes reserveEligible or contradictionCheck — only requireInspection is configurable', () => {
    const rules = normalizeHarnessCoverageRules('high');
    expect(rules.reserveEligible).toEqual(DEFAULT_RISK_COVERAGE_RULES.reserveEligible);
    expect(rules.contradictionCheck).toEqual(DEFAULT_RISK_COVERAGE_RULES.contradictionCheck);
  });

  it('an explicit reviewer choice narrows which levels require inspection, monotonically', () => {
    expect(normalizeHarnessCoverageRules('low').requireInspection).toEqual(['low', 'medium', 'high']);
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

  it('a garbage requireInspectionMinRisk setting still requires a low-risk file to be inspected before completion', () => {
    settings.values['harness.requireInspectionMinRisk'] = 'not-a-real-risk-level';
    const rules = readHarnessCoverageRules();
    expect(rules.requireInspection).toEqual(DEFAULT_RISK_COVERAGE_RULES.requireInspection);

    const inventory = createChangedFileInventory([{ memberId: 'm1', snapshot: SNAPSHOT }]);
    inventory.acceptManifestPage('m1', { snapshot: SNAPSHOT, state: 'complete', value: [entry('a')] });
    inventory.classify('m1', 'a', { risk: 'low' });
    // Deliberately never `markInspected` — this is the fail-closed default's whole point.
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
