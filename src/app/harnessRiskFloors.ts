/**
 * Host risk floors from manifest facts and resolved policy (task 8.3 of
 * `add-agentic-review-harness`, design.md D10 "The host applies mandatory
 * risk floors from manifest facts and policy"), plus the configured coverage
 * rules D11's `configuredRiskCoverageSatisfied` clause reads.
 *
 * The model proposes a risk; the host computes a floor from facts it can
 * verify and takes the maximum. The floor is deterministic: the same entry,
 * policy facts, and rules always produce the same risk and the same ordered
 * reasons. Every weight lives in an injected `RiskFloorRules`/
 * `RiskCoverageRules` value — the state model (`harnessInventory.ts`) and the
 * completion gate never embed a weight, so design.md's open question ("Tune
 * host risk-floor rules and the initial high-risk path set against captured
 * large-review fixtures") can be answered by changing `DEFAULT_RISK_FLOOR_RULES`
 * alone.
 *
 * Path rules use a deliberately small glob dialect (`**`, `*`, `?`) compiled
 * to an anchored regular expression here, rather than accepting caller-
 * supplied regular expressions — an injected pattern is host configuration,
 * but keeping it non-Turing-complete removes the catastrophic-backtracking
 * class of bug from the surface entirely.
 *
 * `DEFAULT_RISK_COVERAGE_RULES` requires inspection at every risk level. That
 * is the fail-closed initial default: a review whose low-risk files were
 * classified but never read is not "complete" until a deployment explicitly
 * relaxes `requireInspection`.
 */
import type { RiskLevel } from '../domain/harnessCoverage';
import { isRiskLevel, RISK_LEVELS } from '../domain/harnessCoverage';
import type { ChangedFileEntry } from '../platform/types';

export interface PathRiskRule {
  readonly id: string;
  /** Glob over the repository-relative path: `**` any depth, `*` within a segment, `?` one character. Case-insensitive. */
  readonly pattern: string;
  readonly risk: RiskLevel;
  readonly reason: string;
}

export interface LargeChangeRule {
  /** Added + removed lines at or above which the floor applies. */
  readonly minChangedLines: number;
  readonly risk: RiskLevel;
}

export interface CategoryFloors {
  readonly binary?: RiskLevel;
  readonly deleted?: RiskLevel;
  readonly renamed?: RiskLevel;
  readonly largeChange?: LargeChangeRule;
  /** A changed path with at least one applicable `AGENTS.md` policy. */
  readonly policyGoverned?: RiskLevel;
  /** A path the host identified as part of a cross-member dependency, API, schema, or deployment contract (D10/D15). */
  readonly crossMemberContract?: RiskLevel;
}

export interface RiskFloorRules {
  readonly pathRules: readonly PathRiskRule[];
  readonly categoryFloors: CategoryFloors;
}

/** Which risk levels demand which coverage (D10 "Configured coverage rules define which risk levels require ..."). */
export interface RiskCoverageRules {
  /** Files at these levels must reach `inspected` (or an explicit terminal state) before completion. */
  readonly requireInspection: readonly RiskLevel[];
  /** Files at these levels may draw on the unvisited/high-risk reserve (D12). */
  readonly reserveEligible: readonly RiskLevel[];
  /** Findings whose primary target is at these levels get a model contradiction check. */
  readonly contradictionCheck: readonly RiskLevel[];
}

/** What the section-6 policy resolution can say about a path without this module parsing `AGENTS.md` prose. */
export interface PolicyRiskFacts {
  /** Identities of the `AGENTS.md` levels that apply, root first; empty means no policy governs the path. */
  readonly policyIds: readonly string[];
  /** A minimum the resolved policy states outright, if the caller extracted one. */
  readonly minimumRisk?: RiskLevel;
}

export interface RiskFloorReason {
  readonly ruleId: string;
  readonly risk: RiskLevel;
  readonly reason: string;
}

export interface RiskFloor {
  readonly risk: RiskLevel;
  /** Every rule that matched, in evaluation order — not just the winning one. */
  readonly reasons: readonly RiskFloorReason[];
}

export interface RiskFloorInput {
  readonly entry: ChangedFileEntry;
  readonly policy?: PolicyRiskFacts;
  readonly crossMemberContract?: boolean;
}

const RISK_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2 };

export function compareRisk(a: RiskLevel, b: RiskLevel): number {
  return RISK_RANK[a] - RISK_RANK[b];
}

export function maxRisk(first: RiskLevel, ...rest: readonly RiskLevel[]): RiskLevel {
  return rest.reduce<RiskLevel>((best, risk) => (compareRisk(risk, best) > 0 ? risk : best), first);
}

export const DEFAULT_RISK_FLOOR_RULES: RiskFloorRules = Object.freeze({
  pathRules: Object.freeze([
    { id: 'path.auth', pattern: '**/auth/**', risk: 'high', reason: 'authentication code' },
    { id: 'path.authz', pattern: '**/{authz,authorization,rbac,iam,permission*}/**', risk: 'high', reason: 'authorization or permission code' },
    { id: 'path.security', pattern: '**/{security,crypto}/**', risk: 'high', reason: 'security or cryptography code' },
    { id: 'path.secretName', pattern: '**/*{secret,credential,password}*', risk: 'high', reason: 'secret- or credential-named file' },
    { id: 'path.keyMaterial', pattern: '**/*.{pem,key,p12,pfx,jks}', risk: 'high', reason: 'key material' },
    // vocab-ok: a literal repository path pattern for CI workflow files, not reviewer-facing vocabulary
    { id: 'path.ciWorkflow', pattern: '.github/workflows/**', risk: 'high', reason: 'CI workflow definition' },
    // vocab-ok: a literal repository file name for CI configuration, not reviewer-facing vocabulary
    { id: 'path.gitlabCi', pattern: '**/.gitlab-ci.yml', risk: 'high', reason: 'CI configuration' },
    { id: 'path.infra', pattern: '**/*.{tf,tfvars,bicep}', risk: 'high', reason: 'infrastructure as code' },
    { id: 'path.container', pattern: '**/{Dockerfile,Dockerfile.*,docker-compose*.yml,docker-compose*.yaml}', risk: 'high', reason: 'container or deployment definition' },
    { id: 'path.money', pattern: '**/{payments,payment,billing,ledger}/**', risk: 'high', reason: 'payments or billing code' },
    { id: 'path.dependencyManifest', pattern: '**/{package.json,package-lock.json,yarn.lock,pnpm-lock.yaml,go.mod,go.sum,Cargo.toml,Cargo.lock,pyproject.toml,requirements*.txt,Gemfile,Gemfile.lock,*.csproj,pom.xml,build.gradle,build.gradle.kts}', risk: 'medium', reason: 'dependency manifest' },
    { id: 'path.migration', pattern: '**/{migrations,migrate}/**', risk: 'medium', reason: 'database migration' },
    { id: 'path.sql', pattern: '**/*.sql', risk: 'medium', reason: 'SQL' },
    { id: 'path.generated', pattern: '**/{generated,gen,dist,build}/**', risk: 'low', reason: 'generated or built output' },
    { id: 'path.generatedName', pattern: '**/*.{generated,min}.*', risk: 'low', reason: 'generated or minified file' },
  ] satisfies readonly PathRiskRule[]),
  categoryFloors: Object.freeze({
    binary: 'medium',
    deleted: 'medium',
    renamed: 'low',
    largeChange: Object.freeze({ minChangedLines: 400, risk: 'medium' }),
    policyGoverned: 'medium',
    crossMemberContract: 'high',
  } satisfies CategoryFloors),
});

export const DEFAULT_RISK_COVERAGE_RULES: RiskCoverageRules = Object.freeze({
  requireInspection: RISK_LEVELS,
  reserveEligible: Object.freeze(['high'] as const),
  contradictionCheck: Object.freeze(['high'] as const),
});

/** Every level, in ascending order, at or above `minimum`. */
export function risksAtLeast(minimum: RiskLevel): readonly RiskLevel[] {
  return RISK_LEVELS.filter((risk) => compareRisk(risk, minimum) >= 0);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `{a,b}` alternation is expanded first; the result is anchored and case-insensitive. */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let index = 0;
  while (index < glob.length) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 2;
        if (glob[index] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
        continue;
      }
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', index);
      if (close === -1) {
        source += '\\{';
      } else {
        const alternatives = glob
          .slice(index + 1, close)
          .split(',')
          .map((alternative) => globToRegExp(alternative).source.replace(/^\^/, '').replace(/\$$/, ''));
        source += `(?:${alternatives.join('|')})`;
        index = close;
      }
    } else {
      source += escapeRegExp(char);
    }
    index += 1;
  }
  return new RegExp(`^${source}$`, 'i');
}

const compiledRules = new WeakMap<RiskFloorRules, ReadonlyArray<{ rule: PathRiskRule; regExp: RegExp }>>();

function compile(rules: RiskFloorRules): ReadonlyArray<{ rule: PathRiskRule; regExp: RegExp }> {
  const cached = compiledRules.get(rules);
  if (cached) return cached;
  const compiled = rules.pathRules.map((rule) => ({ rule, regExp: globToRegExp(rule.pattern) }));
  compiledRules.set(rules, compiled);
  return compiled;
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * Deterministic floor: `low` unless a matched rule or category raises it.
 * Path rules are evaluated against the new path and, for a rename, the old
 * path too — moving a file out of `auth/` does not lower its floor.
 */
export function computeRiskFloor(input: RiskFloorInput, rules: RiskFloorRules = DEFAULT_RISK_FLOOR_RULES): RiskFloor {
  const { entry } = input;
  const reasons: RiskFloorReason[] = [];
  const paths = [stripLeadingSlash(entry.path)];
  if (entry.oldPath !== undefined && entry.oldPath !== entry.path) paths.push(stripLeadingSlash(entry.oldPath));
  for (const { rule, regExp } of compile(rules)) {
    if (paths.some((path) => regExp.test(path))) reasons.push({ ruleId: rule.id, risk: rule.risk, reason: rule.reason });
  }
  const floors = rules.categoryFloors;
  if (entry.binary && floors.binary !== undefined) reasons.push({ ruleId: 'category.binary', risk: floors.binary, reason: 'binary content cannot be inspected as text' });
  if (entry.kind === 'deleted' && floors.deleted !== undefined) reasons.push({ ruleId: 'category.deleted', risk: floors.deleted, reason: 'file deleted' });
  if (entry.kind === 'renamed' && floors.renamed !== undefined) reasons.push({ ruleId: 'category.renamed', risk: floors.renamed, reason: 'file renamed' });
  if (floors.largeChange !== undefined) {
    const changedLines = (entry.addedLines ?? 0) + (entry.removedLines ?? 0);
    if (changedLines >= floors.largeChange.minChangedLines) {
      reasons.push({ ruleId: 'category.largeChange', risk: floors.largeChange.risk, reason: `${changedLines} changed lines` });
    }
  }
  if (input.policy !== undefined) {
    if (input.policy.policyIds.length > 0 && floors.policyGoverned !== undefined) {
      reasons.push({ ruleId: 'category.policyGoverned', risk: floors.policyGoverned, reason: `governed by ${input.policy.policyIds.length} AGENTS.md level(s)` });
    }
    if (input.policy.minimumRisk !== undefined && isRiskLevel(input.policy.minimumRisk)) {
      reasons.push({ ruleId: 'policy.minimumRisk', risk: input.policy.minimumRisk, reason: 'minimum risk stated by resolved policy' });
    }
  }
  if (input.crossMemberContract === true && floors.crossMemberContract !== undefined) {
    reasons.push({ ruleId: 'category.crossMemberContract', risk: floors.crossMemberContract, reason: 'part of a cross-member contract' });
  }
  const risk = reasons.length === 0 ? 'low' : maxRisk('low', ...reasons.map((reason) => reason.risk));
  return Object.freeze({ risk, reasons: Object.freeze(reasons) });
}

export interface AppliedRisk {
  readonly risk: RiskLevel;
  /** True when the host floor overrode a lower (or absent) model proposal. */
  readonly raised: boolean;
  readonly floor: RiskFloor;
}

/** The model's proposal can raise risk above the floor but never lower it below; an invalid proposal counts as absent. */
export function applyRiskFloor(proposed: unknown, floor: RiskFloor): AppliedRisk {
  const proposal = isRiskLevel(proposed) ? proposed : undefined;
  const risk = proposal === undefined ? floor.risk : maxRisk(proposal, floor.risk);
  return Object.freeze({ risk, raised: proposal === undefined || compareRisk(risk, proposal) > 0, floor });
}

export function requiresInspection(risk: RiskLevel, rules: RiskCoverageRules = DEFAULT_RISK_COVERAGE_RULES): boolean {
  return rules.requireInspection.includes(risk);
}

export function isReserveEligible(risk: RiskLevel, rules: RiskCoverageRules = DEFAULT_RISK_COVERAGE_RULES): boolean {
  return rules.reserveEligible.includes(risk);
}
