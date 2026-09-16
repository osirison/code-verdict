/**
 * Two rules about the git seam that no behavioural test can hold — tasks 6.14
 * and 6.15 of `add-local-git-investigation`.
 *
 * A behavioural test proves what today's builder does. These prove what the
 * module is *allowed to be*, so the next change to it cannot quietly reopen the
 * hole: no shell anywhere, and `--`/`-e` in front of everything a caller
 * supplied, for every operation the builder can produce rather than for a list
 * of argument arrays someone typed out.
 *
 * The shell rule is read off the syntax tree rather than matched with a regular
 * expression, because the obvious defeats are all textual. `import { exec as
 * spawn }` passes any check that looks at the local name; `import * as cp` then
 * `cp.exec(…)` passes any check that looks at the import list; a helper module
 * that shells out passes both. So the assertions below read the *imported*
 * name, not the local one; forbid namespace and dynamic forms outright; and
 * hold the module to an allowlist of what it may import at all.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { gitProcessArguments, planGitInvocation, type GitOperation } from './gitInvocation';

const SEAM = 'src/localgit/gitInvocation.ts';
/**
 * The two-commit repository builder (task 1.4). It spawns git as well, and it
 * is test-only: nothing but a `*.test.ts` file imports it, which the last test
 * in this file checks rather than assumes.
 */
const TEST_ONLY_FIXTURE = 'src/testing/localGitRepository.ts';

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Production modules: tests name and use whatever they are testing. */
function productionFiles(): string[] {
  return sourceFiles('src').filter((path) => !path.endsWith('.test.ts'));
}

function parse(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
}

interface ImportFacts {
  readonly specifier: string;
  /** The name as the *exported* module spells it, so an alias cannot hide it. */
  readonly importedNames: readonly string[];
  readonly hasNamespaceImport: boolean;
  readonly hasDefaultImport: boolean;
}

function importsOf(source: ts.SourceFile): ImportFacts[] {
  const facts: ImportFacts[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    const names: string[] = [];
    let hasNamespaceImport = false;
    if (clause?.namedBindings) {
      if (ts.isNamespaceImport(clause.namedBindings)) hasNamespaceImport = true;
      else for (const element of clause.namedBindings.elements) names.push((element.propertyName ?? element.name).text);
    }
    facts.push({
      specifier: statement.moduleSpecifier.text,
      importedNames: names,
      hasNamespaceImport,
      hasDefaultImport: clause?.name !== undefined,
    });
  }
  return facts;
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

describe('no invocation in this module is built with a shell (task 6.14)', () => {
  const source = parse(SEAM);

  it('imports the process primitive by its real name, with no alias, namespace or default form', () => {
    const processImports = importsOf(source).filter((entry) => entry.specifier.includes('child_process'));
    expect(processImports).toHaveLength(1);
    const [only] = processImports;
    expect(only?.specifier).toBe('node:child_process');
    // The *exported* names, so `import { exec as spawn }` fails here rather
    // than passing as "it only imports spawn".
    expect(only?.importedNames).toEqual(['spawn']);
    expect(only?.hasNamespaceImport).toBe(false);
    expect(only?.hasDefaultImport).toBe(false);
  });

  it('imports nothing else that could execute anything', () => {
    // An allowlist rather than a denylist: a helper module that shells out is
    // the defeat a denylist cannot see, and adding an import here should be a
    // decision someone makes on purpose.
    const allowed = new Set(['node:child_process', 'node:os', '../platform/types']);
    for (const entry of importsOf(source)) expect(allowed.has(entry.specifier)).toBe(true);
  });

  it('contains no dynamic import and no require, which are the two ways around an import list', () => {
    let dynamicImports = 0;
    let requires = 0;
    walk(source, (node) => {
      if (!ts.isCallExpression(node)) return;
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) dynamicImports += 1;
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') requires += 1;
    });
    expect(dynamicImports).toBe(0);
    expect(requires).toBe(0);
  });

  it('names no shell-executing function and passes no shell option', () => {
    const forbiddenCalls = new Set(['exec', 'execSync', 'execFile', 'execFileSync', 'spawnSync', 'fork']);
    const offences: string[] = [];
    walk(source, (node) => {
      if (ts.isCallExpression(node)) {
        const callee = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : ts.isIdentifier(node.expression) ? node.expression.text : '';
        if (forbiddenCalls.has(callee)) offences.push(`calls ${callee}`);
      }
      // `shell: true` on an otherwise perfect `spawn` call is the whole hole,
      // reopened in one word. No property by that name may exist in this file.
      if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === 'shell') offences.push('passes a shell option');
      if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'shell') offences.push('passes a shell option');
    });
    expect(offences).toEqual([]);
  });

  it('passes an argument array to every spawn, never a composed string', () => {
    const secondArguments: ts.SyntaxKind[] = [];
    walk(source, (node) => {
      if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || node.expression.text !== 'spawn') return;
      const second = node.arguments[1];
      secondArguments.push(second?.kind ?? ts.SyntaxKind.Unknown);
    });
    // Non-vacuity: there is a spawn to check.
    expect(secondArguments.length).toBeGreaterThan(0);
    for (const kind of secondArguments) expect(kind).toBe(ts.SyntaxKind.ArrayLiteralExpression);
  });

  it('is the only production module in the project that starts a process at all', () => {
    const spawners = productionFiles().filter((path) => importsOf(parse(path)).some((entry) => entry.specifier.includes('child_process')));
    expect(spawners.sort()).toEqual([SEAM, TEST_ONLY_FIXTURE].sort());
  });

  it('and the other one is reached only from tests', () => {
    const importers = productionFiles()
      .filter((path) => path !== TEST_ONLY_FIXTURE)
      .filter((path) => importsOf(parse(path)).some((entry) => entry.specifier.includes('localGitRepository')));
    expect(importers).toEqual([]);
  });
});

describe('every invocation places what the caller supplied after the separator (task 6.15)', () => {
  const BASE = '4a48144a31f4129d1b927ea1383424668fc5290c';
  const HEAD = '13e93bc982dbb8072d2f5f6fdb47e7654914399e';
  const PATHS = ['src/kept.ts', '-looks-like-an-option.ts', ':(exclude)src/kept.ts'];
  const QUERY = '--output=/tmp/pwned.txt';

  /**
   * The five neutral investigation operations, each named as the contract names
   * it, driven through the builder rather than through a hand-written argument
   * list. `readFile` produces an object name instead of a pathspec, which is why
   * it declares its path differently: `--` cannot protect a `<rev>:<path>`
   * argument, and what protects that one is that it always begins with a
   * validated object id.
   *
   * Two operations appear twice, because one contract operation is answered by
   * more than one invocation: `listChangedFiles` needs the counts *and* the
   * kinds, and `readDiff` carries a second pathspec when the file it is reading
   * was renamed. Both extra forms carry a path, so both belong to this rule.
   */
  const operations: ReadonlyArray<{
    contractOperation: string;
    operation: GitOperation;
    pathspecs: readonly string[];
    objectNames?: readonly string[];
    pattern?: string;
  }> = [
    {
      contractOperation: 'listChangedFiles',
      operation: { kind: 'changedFiles', base: BASE, head: HEAD, paths: PATHS.slice(0, 1) },
      pathspecs: PATHS.slice(0, 1),
    },
    {
      contractOperation: 'listChangedFiles (the kinds half)',
      operation: { kind: 'changedFileStatus', base: BASE, head: HEAD, paths: PATHS.slice(0, 1) },
      pathspecs: PATHS.slice(0, 1),
    },
    {
      contractOperation: 'readDiff',
      operation: { kind: 'diffFile', base: BASE, head: HEAD, path: 'src/kept.ts' },
      pathspecs: ['src/kept.ts'],
    },
    {
      contractOperation: 'readDiff (a renamed file, both of its paths)',
      operation: { kind: 'diffFile', base: BASE, head: HEAD, path: 'src/renamed-new.ts', oldPath: 'src/renamed-old.ts' },
      pathspecs: ['src/renamed-old.ts', 'src/renamed-new.ts'],
    },
    {
      contractOperation: 'readFile',
      operation: { kind: 'fileAtRevision', revision: HEAD, path: 'src/kept.ts' },
      pathspecs: [],
      objectNames: [`${HEAD}:src/kept.ts`],
    },
    {
      contractOperation: 'searchRepository',
      operation: { kind: 'searchRepository', revision: HEAD, query: QUERY, paths: ['src/kept.ts'] },
      pathspecs: ['src/kept.ts'],
      pattern: QUERY,
    },
    {
      contractOperation: 'searchDiff',
      operation: { kind: 'searchDiff', base: BASE, head: HEAD, paths: ['src/kept.ts'] },
      pathspecs: ['src/kept.ts'],
    },
  ];

  it.each(operations)('$contractOperation puts every pathspec after -- and every pattern after -e', ({ operation, pathspecs, objectNames, pattern }) => {
    const result = planGitInvocation(operation);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const args = gitProcessArguments(result.plan, { gitDir: '/cache/abc.git', proxyUrl: 'http://proxy.corp:3128' });

    for (const pathspec of pathspecs) {
      const separator = args.indexOf('--');
      expect(separator).toBeGreaterThan(0);
      expect(args.indexOf(pathspec)).toBeGreaterThan(separator);
    }
    for (const objectName of objectNames ?? []) {
      expect(args).toContain(objectName);
      expect(objectName.startsWith(HEAD)).toBe(true);
    }
    if (pattern === undefined) {
      expect(args).not.toContain('-e');
    } else {
      expect(args[args.indexOf(pattern) - 1]).toBe('-e');
      expect(args).toContain('-F');
    }
  });

  it('places every pathspec after the separator for each of the awkward path shapes a model can send', () => {
    for (const path of PATHS.slice(1)) {
      const result = planGitInvocation({ kind: 'changedFiles', base: BASE, head: HEAD, paths: [path] });
      if (!result.ok) {
        // A leading dash is refused outright — an even stronger outcome than
        // placement, and the reason the first lock exists.
        expect(result.refusal.code).toBe('pathNotRepositoryRelative');
        continue;
      }
      const args = gitProcessArguments(result.plan, {});
      // The separator's own presence is asserted before anything is compared
      // against its index: `indexOf` answers -1 for an argument that is not
      // there, and every real index beats -1, so a comparison alone would pass
      // most loudly exactly when the separator had been removed.
      const separator = args.indexOf('--');
      expect(separator).toBeGreaterThan(0);
      expect(args.indexOf(path)).toBeGreaterThan(separator);
    }
  });

  it('emits the separator even when there is no path to place after it', () => {
    // So a later caller that adds a path cannot land in an invocation that
    // never had one, where the separator would have to be remembered.
    const result = planGitInvocation({ kind: 'changedFiles', base: BASE, head: HEAD });
    expect(result.ok).toBe(true);
    if (result.ok) expect(gitProcessArguments(result.plan, {}).at(-1)).toBe('--');
  });
});
