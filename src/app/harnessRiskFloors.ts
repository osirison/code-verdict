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
 * `DEFAULT_RISK_COVERAGE_RULES` requires inspection at medium and above, not
 * every level. Requiring literally every level (including `low`) forced a
 * model to either read purely informational content (docs, specs, changelogs)
 * it had already correctly judged low-stakes, or refuse to — and a refusal
 * failed the whole review with zero findings (real runs hit this against
 * `*.md`/`*.yaml` proposal files). Relaxing the requirement to `low` is only
 * safe because `sourceCodeFloor` below makes `low` mean something narrower
 * than "whatever the model felt like proposing": a changed file whose
 * extension names a general-purpose or scripting language is floored to
 * `medium` by the host, regardless of the model's proposal, unless it also
 * matches an explicit generated/build-output exemption. So a model cannot
 * launder real source code through a low-risk label to skip inspecting it —
 * the fail-closed guarantee moves from "every level requires inspection" to
 * "every level a model could plausibly mis-rate requires inspection," with
 * the floor closing the gap the coverage relaxation opens.
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

/**
 * A host floor keyed on file extension rather than path: "is this file
 * source code" is a question about what a file *is*, not where it lives.
 * Deliberately a small, documented list rather than an attempt to enumerate
 * every language a changeset could contain — an unlisted extension simply
 * falls through to whatever the model or another rule decides, the same as
 * today. `exemptPatterns` (same glob dialect as `PathRiskRule.pattern`) lets
 * a path that matches an extension still opt out — generated or built
 * output (`dist/`, `*.min.js`, ...) is still literally source-shaped text,
 * but nothing a reviewer authored, so it is exempted here exactly as
 * `DEFAULT_RISK_FLOOR_RULES.pathRules`' own `path.generated`/
 * `path.generatedName` entries already tag it.
 */
export interface SourceCodeFloor {
  /** Case-insensitive, dot-prefixed extensions, e.g. `.ts`. */
  readonly extensions: readonly string[];
  readonly risk: RiskLevel;
  readonly exemptPatterns?: readonly string[];
}

export interface RiskFloorRules {
  readonly pathRules: readonly PathRiskRule[];
  readonly categoryFloors: CategoryFloors;
  /** Absent means no extension-based source-code floor at all (used by tests exercising only path/category rules). */
  readonly sourceCodeFloor?: SourceCodeFloor;
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

/**
 * Shared verbatim between `path.generated`/`path.generatedName` below and
 * `DEFAULT_SOURCE_CODE_FLOOR.exemptPatterns` — one place naming "this is
 * generated or built output," so the two can never quietly drift apart.
 */
const GENERATED_OUTPUT_PATTERNS: readonly string[] = ['**/{generated,gen,dist,build}/**', '**/*.{generated,min}.*'];

/**
 * A small, explicit list of general-purpose and scripting-language
 * extensions — the languages where risk hides in logic rather than markup.
 * Deliberately excludes documentation/specification/plain-text formats
 * (`.md`, `.txt`, `.yml`/`.yaml`, licences, changelogs) and data/markup
 * formats (`.json`, `.html`, `.css`) — those stay at whatever risk the model
 * or another floor rule assigns, per design. Not exhaustive by construction;
 * an unlisted language falls through unfloored exactly as before this rule
 * existed.
 */
export const DEFAULT_SOURCE_CODE_FLOOR: SourceCodeFloor = Object.freeze({
  extensions: Object.freeze([
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
    '.py', '.go', '.rb', '.java', '.kt', '.kts',
    '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.rs',
    '.php', '.swift', '.scala', '.sh', '.bash', '.ps1',
  ]),
  risk: 'medium',
  exemptPatterns: Object.freeze([...GENERATED_OUTPUT_PATTERNS]),
} satisfies SourceCodeFloor);

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
    { id: 'path.generated', pattern: GENERATED_OUTPUT_PATTERNS[0]!, risk: 'low', reason: 'generated or built output' },
    { id: 'path.generatedName', pattern: GENERATED_OUTPUT_PATTERNS[1]!, risk: 'low', reason: 'generated or minified file' },
  ] satisfies readonly PathRiskRule[]),
  categoryFloors: Object.freeze({
    binary: 'medium',
    deleted: 'medium',
    renamed: 'low',
    largeChange: Object.freeze({ minChangedLines: 400, risk: 'medium' }),
    policyGoverned: 'medium',
    crossMemberContract: 'high',
  } satisfies CategoryFloors),
  sourceCodeFloor: DEFAULT_SOURCE_CODE_FLOOR,
});

/**
 * Requires inspection at `medium` and above, not every level. `low` is safe
 * to leave to the model's own judgement only because `DEFAULT_RISK_FLOOR_RULES.
 * sourceCodeFloor` above already keeps real source code out of `low` — see
 * this file's header for the full reasoning.
 */
export const DEFAULT_RISK_COVERAGE_RULES: RiskCoverageRules = Object.freeze({
  requireInspection: Object.freeze(risksAtLeast('medium')),
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

const compiledExemptPatterns = new WeakMap<SourceCodeFloor, readonly RegExp[]>();

function compileExemptPatterns(floor: SourceCodeFloor): readonly RegExp[] {
  const cached = compiledExemptPatterns.get(floor);
  if (cached) return cached;
  const compiled = (floor.exemptPatterns ?? []).map((pattern) => globToRegExp(pattern));
  compiledExemptPatterns.set(floor, compiled);
  return compiled;
}

function hasSourceCodeExtension(path: string, extensions: readonly string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((extension) => lower.endsWith(extension.toLowerCase()));
}

/** True when at least one of `paths` both names a listed extension and matches no exemption. */
function isFlooredAsSourceCode(paths: readonly string[], floor: SourceCodeFloor): boolean {
  const exemptions = compileExemptPatterns(floor);
  return paths.some((path) => hasSourceCodeExtension(path, floor.extensions) && !exemptions.some((regExp) => regExp.test(path)));
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
  if (rules.sourceCodeFloor !== undefined && isFlooredAsSourceCode(paths, rules.sourceCodeFloor)) {
    reasons.push({ ruleId: 'category.sourceCode', risk: rules.sourceCodeFloor.risk, reason: 'source code' });
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
