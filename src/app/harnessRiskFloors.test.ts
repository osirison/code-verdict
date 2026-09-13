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
  it('floors an unremarkable source file to medium via the source-code floor alone', () => {
    expect(computeRiskFloor({ entry: entry('src/util/format.ts') })).toEqual({
      risk: 'medium',
      reasons: [{ ruleId: 'category.sourceCode', risk: 'medium', reason: 'source code' }],
    });
  });

  it('leaves an unremarkable non-source file (docs/spec/plain-text) at low, with no matching rule', () => {
    expect(computeRiskFloor({ entry: entry('docs/readme.md') })).toEqual({ risk: 'low', reasons: [] });
  });

  it('raises sensitive paths to high and records both the matching path rule and the source-code floor', () => {
    const floor = computeRiskFloor({ entry: entry('src/auth/token.ts') });
    expect(floor.risk).toBe('high');
    expect(floor.reasons.map((reason) => reason.ruleId)).toEqual(['path.auth', 'category.sourceCode']);
  });

  it('treats dependency manifests as medium and generated output as an explicit low tag, exempt from the source-code floor', () => {
    expect(computeRiskFloor({ entry: entry('package-lock.json') }).risk).toBe('medium');
    const generated = computeRiskFloor({ entry: entry('src/generated/module0001.ts') });
    expect(generated.risk).toBe('low');
    expect(generated.reasons.map((reason) => reason.ruleId)).toEqual(['path.generated']);
  });

  it('applies category floors for binary, deleted, renamed, and large changes, isolated from the source-code floor via a non-source extension', () => {
    expect(computeRiskFloor({ entry: entry('assets/logo.png', { binary: true }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.binary' }] });
    expect(computeRiskFloor({ entry: entry('docs/old.txt', { kind: 'deleted' }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.deleted' }] });
    expect(computeRiskFloor({ entry: entry('docs/new.txt', { kind: 'renamed', oldPath: 'docs/legacy.txt' }) })).toMatchObject({ risk: 'low', reasons: [{ ruleId: 'category.renamed' }] });
    expect(computeRiskFloor({ entry: entry('docs/big.txt', { addedLines: 300, removedLines: 100 }) })).toMatchObject({ risk: 'medium', reasons: [{ ruleId: 'category.largeChange', reason: '400 changed lines' }] });
    expect(computeRiskFloor({ entry: entry('docs/notbig.txt', { addedLines: 300, removedLines: 99 }) }).reasons).toEqual([]);
  });

  it('keeps the old path in scope for a rename out of a sensitive directory', () => {
    const floor = computeRiskFloor({ entry: entry('src/util/tokenStore.ts', { kind: 'renamed', oldPath: 'src/auth/tokenStore.ts' }) });
    expect(floor.risk).toBe('high');
    expect(floor.reasons.map((reason) => reason.ruleId)).toEqual(['path.auth', 'category.renamed', 'category.sourceCode']);
  });

  it('raises policy-governed paths and honours a stated policy minimum', () => {
    const governed = computeRiskFloor({ entry: entry('src/payments/charge.ts'), policy: { policyIds: ['AGENTS.md', 'src/AGENTS.md', 'src/payments/AGENTS.md'] } });
    expect(governed.risk).toBe('high'); // path.money wins over policyGoverned=medium and the source-code floor=medium
    expect(governed.reasons.map((reason) => reason.ruleId)).toEqual(['path.money', 'category.sourceCode', 'category.policyGoverned']);

    const stated = computeRiskFloor({ entry: entry('docs/readme.md'), policy: { policyIds: ['AGENTS.md'], minimumRisk: 'high' } });
    expect(stated.risk).toBe('high');
    expect(stated.reasons.map((reason) => reason.ruleId)).toEqual(['category.policyGoverned', 'policy.minimumRisk']);

    expect(computeRiskFloor({ entry: entry('docs/readme.md'), policy: { policyIds: [] } })).toEqual({ risk: 'low', reasons: [] });
  });

  it('raises a cross-member contract to high, alongside the source-code floor', () => {
    expect(computeRiskFloor({ entry: entry('src/schema/order.ts'), crossMemberContract: true })).toMatchObject({
      risk: 'high',
      reasons: [{ ruleId: 'category.sourceCode' }, { ruleId: 'category.crossMemberContract' }],
    });
  });

  it('is deterministic: identical inputs produce identical floors', () => {
    const input = { entry: entry('src/auth/x.ts', { binary: true }), policy: { policyIds: ['AGENTS.md'] }, crossMemberContract: true };
    expect(computeRiskFloor(input)).toEqual(computeRiskFloor(input));
    expect(computeRiskFloor(input).reasons.map((reason) => reason.ruleId)).toEqual([
      'path.auth',
      'category.binary',
      'category.sourceCode',
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

  it('an injected sourceCodeFloor is honoured, extensions and exemptions alike, with no change to the state model', () => {
    const rules: RiskFloorRules = {
      pathRules: [],
      categoryFloors: {},
      sourceCodeFloor: { extensions: ['.py'], risk: 'high', exemptPatterns: ['**/vendor/**'] },
    };
    expect(computeRiskFloor({ entry: entry('service/handler.py') }, rules)).toMatchObject({ risk: 'high', reasons: [{ ruleId: 'category.sourceCode' }] });
    expect(computeRiskFloor({ entry: entry('service/handler.ts') }, rules).reasons).toEqual([]); // .ts is not in this injected list
    expect(computeRiskFloor({ entry: entry('vendor/lib/handler.py') }, rules).reasons).toEqual([]); // exempted despite the matching extension
  });

  it('absent sourceCodeFloor applies no extension-based floor at all', () => {
    const rules: RiskFloorRules = { pathRules: [], categoryFloors: {} };
    expect(computeRiskFloor({ entry: entry('src/util/format.ts') }, rules)).toEqual({ risk: 'low', reasons: [] });
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

/**
 * The hole this change closes: before `sourceCodeFloor` existed, an ordinary
 * source file had no floor at all, so a model proposing `low` for it would
 * sail straight through `applyRiskFloor` unchanged — and once
 * `requireInspection` no longer covers `low`, that file would never be
 * inspected. `computeRiskFloor` + `applyRiskFloor` + `requiresInspection`
 * chained exactly as `classifyFile`/the coverage gate chain them for real.
 */
describe('the source-code floor closes the low-risk skip hole', () => {
  it('overrides a model proposal of low for an ordinary source file, so it still requires inspection', () => {
    const floor = computeRiskFloor({ entry: entry('src/reviewSummary.ts') });
    const applied = applyRiskFloor('low', floor);
    expect(applied.risk).toBe('medium');
    expect(applied.raised).toBe(true);
    expect(requiresInspection(applied.risk)).toBe(true);
  });

  it('leaves a documentation file the model calls low unfloored, so it does not block completion', () => {
    const floor = computeRiskFloor({ entry: entry('docs/agent-notes/example.md') });
    const applied = applyRiskFloor('low', floor);
    expect(applied.risk).toBe('low');
    expect(applied.raised).toBe(false);
    expect(requiresInspection(applied.risk)).toBe(false);
  });
});

describe('configured coverage rules', () => {
  it('requires inspection at medium and above by default (low is exempt, given the source-code floor) and reserves only for high', () => {
    expect(DEFAULT_RISK_COVERAGE_RULES.requireInspection).toEqual(['medium', 'high']);
    expect(requiresInspection('low')).toBe(false);
    expect(requiresInspection('medium')).toBe(true);
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
