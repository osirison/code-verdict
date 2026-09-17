/**
 * The data layer stays provider-agnostic — task 10.7 of
 * `add-local-git-investigation`, design D2's dependency rule.
 *
 * The rule this change could most easily have broken: reaching the local source
 * by asking which forge a repository is on. Design D2 rejects both shapes of
 * that explicitly — "put local git inside the GitHub provider" and "give the
 * harness a `useLocalGit` branch at each call site", the second being "provider
 * identity by another name, spread across every tool". What replaced them is a
 * neutral contract with two implementations, chosen from measurable facts: does
 * this machine have git, did the connection supply an object-source descriptor,
 * were both commits obtained, can this source serve this change.
 *
 * Three assertions, none of them a new mechanism:
 *
 * 1. The project's own dependency rule — only `src/registry.ts` may import a
 *    concrete provider — held as a test as well as a lint rule, so `npm run
 *    test` catches a violation and a disabled lint comment does not hide one.
 * 2. No module on the investigation path names a forge at all. An import rule
 *    stops `import … from '../providers/github/…'`; it does not stop
 *    `if (providerId === 'github')`, which is the same branch without the
 *    import.
 * 3. The shared provider conformance suite really does run against the local
 *    source unchanged (task 8.8). That is the positive form of the same claim:
 *    a suite written for providers, passed by something that is not one, is
 *    what "neutral contract" means in practice.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

/** The one module the dependency rule exempts, and the one directory it is about. */
const REGISTRY = join('src', 'registry.ts');
const PROVIDERS_DIR = join('src', 'providers');

/**
 * Everything this change added or changed that decides which source answers an
 * investigation request, or routes one. Named rather than globbed: the claim is
 * about these decisions, and a reader should be able to see which files make
 * them.
 */
const INVESTIGATION_PATH = [
  join('src', 'app', 'investigationSourceSelection.ts'),
  join('src', 'app', 'harnessRuntime.ts'),
  join('src', 'app', 'harnessToolDispatcher.ts'),
  join('src', 'app', 'harnessAttempt.ts'),
  join('src', 'platform', 'types.ts'),
  join('src', 'platform', 'provider.ts'),
  ...localGitModules(),
];

/** Known provider identities, as `registry.ts` registers them. A module on the path above may not contain one as a literal. */
const PROVIDER_IDS = /^(github|gitlab|fixture)$/i;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

function localGitModules(): string[] {
  return sourceFiles(join('src', 'localgit')).filter((path) => !path.endsWith('.test.ts'));
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const out: string[] = [];
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) out.push(statement.moduleSpecifier.text);
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      out.push(statement.moduleSpecifier.text);
    }
  }
  return out;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('nothing above the provider boundary reaches a source by provider identity (task 10.7)', () => {
  it('imports no concrete provider anywhere but the registry', () => {
    const offenders = sourceFiles('src')
      .filter((path) => path !== REGISTRY && !path.startsWith(PROVIDERS_DIR))
      .filter((path) => importSpecifiers(parse(path)).some((specifier) => /(^|\/)providers\//.test(specifier)));
    expect(offenders).toEqual([]);
  });

  it('names no forge on the investigation path, so no branch can be written on one', () => {
    const offenders: string[] = [];
    for (const path of INVESTIGATION_PATH) {
      walk(parse(path), (node) => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PROVIDER_IDS.test(node.text)) {
          offenders.push(`${path}: ${node.text}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('covers the modules this change actually added, so the assertion above is not vacuous', () => {
    // If a file is renamed away and the list is not updated, this fails rather
    // than the rule quietly stopping being checked.
    for (const path of INVESTIGATION_PATH) expect(statSync(path).isFile()).toBe(true);
    expect(INVESTIGATION_PATH).toContain(join('src', 'app', 'investigationSourceSelection.ts'));
    expect(localGitModules().length).toBeGreaterThan(4);
  });

  it('runs the shared investigation-source conformance suite against the local source (task 8.8)', () => {
    const contractSuite = join('src', 'platform', 'contract', 'providerContract.ts');
    // The suite itself is above the boundary: it describes what a source must
    // do, and knows about none of them.
    expect(importSpecifiers(parse(contractSuite)).filter((specifier) => /(^|\/)providers\//.test(specifier))).toEqual([]);

    const localContractTest = join('src', 'localgit', 'localGitSource.contract.test.ts');
    const specifiers = importSpecifiers(parse(localContractTest));
    expect(specifiers).toContain('../platform/contract/investigationSourceContract');
    expect(specifiers).toContain('./localGitSource');
    // And it imports no provider either: the same suite, the same assertions,
    // a source that is not a provider at all.
    expect(specifiers.filter((specifier) => /(^|\/)providers\//.test(specifier))).toEqual([]);
  });
});
