import { describe, expect, it } from 'vitest';
import type { ChangedFileEntry } from '../platform/types';
import {
  applyRiskFloor,
  compareRisk,
  computeRiskFloor,
  DEFAULT_RISK_COVERAGE_RULES,
  DEFAULT_RISK_FLOOR_RULES,
  globToRegExp,
  isReserveEligible,
  maxRisk,
  requiresInspection,
  risksAtLeast,
  type RiskFloorRules,
} from './harnessRiskFloors';

function entry(path: string, overrides: Partial<ChangedFileEntry> = {}): ChangedFileEntry {
  return { path, kind: 'modified', binary: false, addedLines: 2, removedLines: 1, ...overrides };
}

describe('glob compilation', () => {
  it.each([
    ['**/auth/**', 'src/auth/token.ts', true],
    ['**/auth/**', 'auth/token.ts', true],
    ['**/auth/**', 'src/author/x.ts', false],
    ['**/*.{pem,key}', 'certs/server.pem', true],
    ['**/*.{pem,key}', 'certs/server.pem.md', false],
    ['.github/workflows/**', '.github/workflows/ci.yml', true],
    ['.github/workflows/**', 'other/.github/workflows/ci.yml', false],
    ['**/*{secret,credential}*', 'config/prodSecrets.json', true],
    ['**/{Dockerfile,Dockerfile.*}', 'deploy/Dockerfile.prod', true],
    ['**/package.json', 'PACKAGE.JSON', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['src/*.ts', 'src/nested/a.ts', false],
  ])('%s vs %s -> %s', (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });

  it('escapes regular-expression metacharacters in literal segments', () => {
    expect(globToRegExp('a+b(c).ts').test('a+b(c).ts')).toBe(true);
    expect(globToRegExp('a+b(c).ts').test('aab(c)xts')).toBe(false);
  });
});

describe('risk ordering', () => {
  it('orders low < medium < high and picks the maximum', () => {
    expect(compareRisk('low', 'high')).toBeLessThan(0);
    expect(compareRisk('high', 'high')).toBe(0);
    expect(maxRisk('low', 'medium', 'low')).toBe('medium');
    expect(maxRisk('high')).toBe('high');
    expect(risksAtLeast('medium')).toEqual(['medium', 'high']);
  });
});

describe('host risk floors from manifest facts and policy (task 8.3)', () => {
  it('is low for an unremarkable source file with no matching rule', () => {
    expect(computeRiskFloor({ entry: entry('src/util/format.ts') })).toEqual({ risk: 'low', reasons: [] });
  });

  it('raises sensitive paths to high and records the matching rule', () => {
    const floor = computeRiskFloor({ entry: entry('src/auth/token.ts') });
    expect(floor.risk).toBe('high');
    expect(floor.reasons.map((reason) => reason.ruleId)).toEqual(['path.auth']);
  });

  it('treats dependency manifests as medium and generated output as an explicit low tag', () => {
    expect(computeRiskFloor({ entry: entry('package-lock.json') }).risk).toBe('medium');
    const generated = computeRiskFloor({ entry: entry('src/generated/module0001.ts') });
    expect(generated.risk).toBe('low');
    expect(generated.reasons.map((reason) => reason.ruleId)).toEqual(['path.generated']);
  });

  it('applies category floors for binary, deleted, renamed, and large changes', () => {
    expect(computeRiskFloor({ entry: entry('assets/logo.png', { binary: true }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.binary' }] });
    expect(computeRiskFloor({ entry: entry('src/old.ts', { kind: 'deleted' }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.deleted' }] });
    expect(computeRiskFloor({ entry: entry('src/new.ts', { kind: 'renamed', oldPath: 'src/legacy.ts' }) })).toMatchObject({ risk: 'low', reasons: [{ ruleId: 'category.renamed' }] });
    expect(computeRiskFloor({ entry: entry('src/big.ts', { addedLines: 300, removedLines: 100 }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.largeChange', reason: '400 changed lines' }] });
    expect(computeRiskFloor({ entry: entry('src/notbig.ts', { addedLines: 300, removedLines: 99 }) }).reasons).toEqual([]);
  });

  it('keeps the old path in scope for a rename out of a sensitive directory', () => {
    const floor = computeRiskFloor({ entry: entry('src/util/tokenStore.ts', { kind: 'renamed', oldPath: 'src/auth/tokenStore.ts' }) });
    expect(floor.risk).toBe('high');
    expect(floor.reasons.map((reason) => reason.ruleId)).toEqual(['path.auth', 'category.renamed']);
  });

  it('raises policy-governed paths and honours a stated policy minimum', () => {
    const governed = computeRiskFloor({ entry: entry('src/payments/charge.ts'), policy: { policyIds: ['AGENTS.md', 'src/AGENTS.md', 'src/payments/AGENTS.md'] } });
    expect(governed.risk).toBe('high'); // path.money wins over policyGoverned=medium
    expect(governed.reasons.map((reason) => reason.ruleId)).toEqual(['path.money', 'category.policyGoverned']);

    const stated = computeRiskFloor({ entry: entry('docs/readme.md'), policy: { policyIds: ['AGENTS.md'], minimumRisk: 'high' } });
    expect(stated.risk).toBe('high');
    expect(stated.reasons.map((reason) => reason.ruleId)).toEqual(['category.policyGoverned', 'policy.minimumRisk']);

    expect(computeRiskFloor({ entry: entry('docs/readme.md'), policy: { policyIds: [] } })).toEqual({ risk: 'low', reasons: [] });
  });

  it('raises a cross-member contract to high', () => {
    expect(computeRiskFloor({ entry: entry('src/schema/order.ts'), crossMemberContract: true })).toMatchObject({ risk: 'high', reasons: [{ ruleId: 'category.crossMemberContract' }] });
  });

  it('is deterministic: identical inputs produce identical floors', () => {
    const input = { entry: entry('src/auth/x.ts', { binary: true }), policy: { policyIds: ['AGENTS.md'] }, crossMemberContract: true };
    expect(computeRiskFloor(input)).toEqual(computeRiskFloor(input));
    expect(computeRiskFloor(input).reasons.map((reason) => reason.ruleId)).toEqual([
      'path.auth',
      'category.binary',
      'category.policyGoverned',
      'category.crossMemberContract',
    ]);
  });

  it('takes injected weights without any change to the state model', () => {
    const rules: RiskFloorRules = {
      pathRules: [{ id: 'custom.docs', pattern: 'docs/**', risk: 'high', reason: 'docs are contractual here' }],
      categoryFloors: { binary: 'high' },
    };
    expect(computeRiskFloor({ entry: entry('docs/api.md') }, rules).risk).toBe('high');
    expect(computeRiskFloor({ entry: entry('src/auth/token.ts') }, rules).risk).toBe('low');
    expect(computeRiskFloor({ entry: entry('a.bin', { binary: true }) }, rules).risk).toBe('high');
    expect(computeRiskFloor({ entry: entry('src/old.ts', { kind: 'deleted' }) }, rules).reasons).toEqual([]);
  });

  it('ignores leading slashes when matching', () => {
    expect(computeRiskFloor({ entry: entry('/src/auth/token.ts') }).risk).toBe('high');
  });
});

describe('applying the floor to a model proposal', () => {
  const floor = computeRiskFloor({ entry: entry('package.json') }); // medium

  it('never lets a proposal lower risk below the floor', () => {
    expect(applyRiskFloor('low', floor)).toMatchObject({ risk: 'medium', raised: true });
  });

  it('lets a proposal raise risk above the floor', () => {
    expect(applyRiskFloor('high', floor)).toMatchObject({ risk: 'high', raised: false });
  });

  it('uses the floor when the proposal is absent or garbage', () => {
    expect(applyRiskFloor(undefined, floor)).toMatchObject({ risk: 'medium', raised: true });
    expect(applyRiskFloor('critical', floor)).toMatchObject({ risk: 'medium', raised: true });
    expect(applyRiskFloor(42, floor)).toMatchObject({ risk: 'medium', raised: true });
  });

  it('reports an exact match as not raised', () => {
    expect(applyRiskFloor('medium', floor)).toMatchObject({ risk: 'medium', raised: false });
  });
});

describe('configured coverage rules', () => {
  it('requires inspection at every level by default and reserves only for high', () => {
    expect(DEFAULT_RISK_COVERAGE_RULES.requireInspection).toEqual(['low', 'medium', 'high']);
    expect(requiresInspection('low')).toBe(true);
    expect(isReserveEligible('high')).toBe(true);
    expect(isReserveEligible('medium')).toBe(false);
  });

  it('honours relaxed injected rules', () => {
    const rules = { requireInspection: ['medium', 'high'], reserveEligible: ['medium', 'high'], contradictionCheck: ['high'] } as const;
    expect(requiresInspection('low', rules)).toBe(false);
    expect(isReserveEligible('medium', rules)).toBe(true);
  });

  it('exposes the default rule table as frozen configuration', () => {
    expect(Object.isFrozen(DEFAULT_RISK_FLOOR_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RISK_FLOOR_RULES.pathRules)).toBe(true);
    expect(Object.isFrozen(DEFAULT_RISK_COVERAGE_RULES)).toBe(true);
  });
});
