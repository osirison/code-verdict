/**
 * The vocabulary rule, enforced (see docs/ARCHITECTURE.md).
 *
 * Platform nouns in user-visible text must come from the active provider's
 * `Vocabulary`, never from a literal. This scans `src/ui` and `src/app` with
 * the TypeScript AST and inspects *string and template literals only* — not
 * comments, not identifiers, not type names — so doc comments and fields like
 * `projectLabel` do not false-positive. That precision is the point: a rule
 * with a growing ignore list reads as enforcement while enforcing nothing.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { renderDashboardHtml } from './dashboardHtml';
import { renderSidebarHtml } from './sidebarHtml';
import { renderChangesetHtml } from './changesetHtml';
import { GITHUB_VOCABULARY, GITLAB_VOCABULARY } from '../testing/specFixtures';

/** Nouns that belong to one platform. The neutral contract's own words —
 *  "change request", "repository", "run" — are deliberately absent. */
const BANNED: ReadonlyArray<{ pattern: RegExp; noun: string }> = [
  { pattern: /\bgitlab\b/i, noun: 'GitLab' },
  { pattern: /\bgithub\b/i, noun: 'GitHub' },
  { pattern: /\bbitbucket\b/i, noun: 'Bitbucket' },
  { pattern: /\bmerge requests?\b/i, noun: 'merge request' },
  { pattern: /\bpull requests?\b/i, noun: 'pull request' },
  { pattern: /\bMRs?\b/, noun: 'MR' },
  { pattern: /\bPRs?\b/, noun: 'PR' },
  { pattern: /\bprojects?\b/i, noun: 'project' },
  { pattern: /\bpipelines?\b/i, noun: 'pipeline' },
];

const SCANNED_DIRS = ['src/ui', 'src/app'];
/** Root-level modules carry user-visible strings too (extension.ts toasts). */
const SCANNED_ROOT = 'src';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    if (!entry.name.endsWith('.ts')) return [];
    // Product code only: tests name platforms on purpose.
    if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test-helper.ts')) return [];
    return [path];
  });
}

interface Offence {
  file: string;
  line: number;
  noun: string;
  text: string;
}

/** `// vocab-ok: <reason>` on the preceding line, and a reason is required. */
function excused(lines: readonly string[], lineIndex: number): boolean {
  const previous = lines[lineIndex - 1] ?? '';
  const match = previous.match(/\/\/\s*vocab-ok:\s*(\S.*)$/);
  return match !== null;
}

function scan(file: string): Offence[] {
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const offences: Offence[] = [];

  const visit = (node: ts.Node): void => {
    const isLiteral =
      ts.isStringLiteral(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node)
      || ts.isTemplateMiddle(node)
      || ts.isTemplateTail(node);
    if (isLiteral) {
      const value = (node as ts.LiteralLikeNode).text;
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
      for (const { pattern, noun } of BANNED) {
        if (pattern.test(value) && !excused(lines, line)) {
          offences.push({ file, line: line + 1, noun, text: value.trim().slice(0, 90) });
          break;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return offences;
}

describe('platform nouns come from the provider, not from literals', () => {
  it('finds no hardcoded platform noun in src/ui, src/app or the src root', () => {
    const rootFiles = readdirSync(SCANNED_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts'))
      .map((entry) => join(SCANNED_ROOT, entry.name));
    const offences = [...SCANNED_DIRS.flatMap(sourceFiles), ...rootFiles].flatMap(scan);
    const report = offences
      .map((o) => `${o.file}:${o.line} — "${o.noun}" in ${JSON.stringify(o.text)}`)
      .join('\n');
    expect(report).toBe('');
  });

  it('excuses a literal only when the escape carries a reason', () => {
    const withReason = ['// vocab-ok: the GitLab emulator is named in a debug-only path', "const x = 'GitLab';"];
    const withoutReason = ['// vocab-ok:', "const x = 'GitLab';"];
    const bare = ['// just a comment', "const x = 'GitLab';"];
    expect(excused(withReason, 1)).toBe(true);
    expect(excused(withoutReason, 1)).toBe(false);
    expect(excused(bare, 1)).toBe(false);
  });
});

describe('the same state renders each platform in its own words', () => {
  const dashboard = {
    vocabulary: GITLAB_VOCABULARY,
    podName: 'Platform squad',
    meta: '',
    scopeCounts: { you: 1, them: 0 },
    stats: { waitingOnYou: 1, aiCoverage: { reviewed: 1, total: 2 }, pipelinesFailing: 1, projectsInPod: 3 },
    fetchedLabel: '14:32',
    projects: [{ id: '9101', label: 'core', count: 1 }],
    changesets: [{ id: 'cs', name: 'Rate limiting', memberCount: 2, projectCount: 2, state: 'ready to merge', stateClass: 'pill-ok' as const }],
    rows: [{
      repoId: '9101', number: '2841', refLabel: '!2841', title: 'Rate limiting',
      author: 'dana', branch: 'feat/rate', project: 'core', scope: 'you' as const,
      ai: { label: 'not run', cls: 'pill' as const }, submitted: false,
      ciStatus: 'success' as const, age: '2h',
    }],
    issues: [],
    activity: [],
    pipelines: [{ id: '1', status: 'success' as const, job: 'ci', age: '1h' }],
  };

  it('renders the dashboard in GitLab words and the same state in GitHub words', () => {
    const gitlab = renderDashboardHtml(dashboard, 'n');
    expect(gitlab).toContain('Merge requests');
    expect(gitlab).toContain('Pipelines failing');
    expect(gitlab).toContain('Projects in pod');
    expect(gitlab).toContain('All projects');

    const github = renderDashboardHtml({ ...dashboard, vocabulary: GITHUB_VOCABULARY }, 'n');
    expect(github).toContain('Pull requests');
    expect(github).toContain('Checks failing');
    expect(github).toContain('Repositories in pod');
    expect(github).toContain('All repositories');
    expect(github).not.toContain('Merge requests');
    expect(github).not.toContain('Pipelines failing');
  });

  it('renders the sidebar empty state in each platform\'s words', () => {
    const base = {
      vocabulary: GITLAB_VOCABULARY,
      podName: 'Platform squad',
      podMeta: '3 projects',
      pods: [],
      mergeRequests: [],
      issues: [],
      waitingOnYou: 0,
    };
    expect(renderSidebarHtml(base, 'n')).toContain('No open merge requests');
    expect(renderSidebarHtml({ ...base, vocabulary: GITHUB_VOCABULARY }, 'n')).toContain('No open pull requests');
  });

  it('renders changeset readiness in each platform\'s CI noun', () => {
    const base = {
      vocabulary: GITLAB_VOCABULARY,
      id: 'cs',
      name: 'Rate limiting',
      detectionDetail: 'a shared trailer',
      added: 10,
      removed: 2,
      reviewed: 2,
      pipelinesPassing: 1,
      members: [
        { repoId: '9101', number: '2841', project: 'core', refLabel: '!2841', title: 'A', ciStatus: 'success' as const, reviewed: true },
        { repoId: '9102', number: '812', project: 'auth', refLabel: '!812', title: 'B', ciStatus: 'failed' as const, reviewed: true },
      ],
    };
    const gitlab = renderChangesetHtml(base, 'n');
    expect(gitlab).toContain('2 merge requests');
    expect(gitlab).toContain('pipelines');

    const github = renderChangesetHtml({ ...base, vocabulary: GITHUB_VOCABULARY }, 'n');
    expect(github).toContain('2 pull requests');
    expect(github).toContain('checks');
    expect(github).not.toContain('pipeline');
  });
});
