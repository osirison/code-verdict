/**
 * The demo agent's deterministic per-file finding templates.
 *
 * Task 15.8 removed `runDemoAgent`, the one-shot demo runner that used to
 * live here (nothing shipped reached it any more — the harness demo
 * participant, task 10.7, is what runs demo reviews now). `demoFindingsForFile`
 * survives: it is the one piece of that runner's logic the harness demo
 * participant (`harnessDemoParticipant.ts`) reuses, one file's patch bytes at
 * a time, from a real `readDiff` tool result rather than a whole
 * `ChangeRequestDiff` object it is never given.
 */
import type { Category, ReviewItem, Severity } from '../domain/types';
import { addedLines } from '../domain/diffHunks';

export const DEMO_AGENT_ID = 'verdict.demo-agent';
export const DEMO_AGENT_LABEL = 'Verdict · Demo Review';

interface Template {
  category: Category;
  severity: Severity;
  title: (snippet: string) => string;
  body: string;
  suggest?: (line: string) => string;
  answers: { explain: string; fix: string; similar: string; why: string };
}

const TEMPLATES: Template[] = [
  {
    category: 'security',
    severity: 'blocker',
    title: () => 'Sensitive value reaches the log sink',
    body: 'Interpolated state lands in retained logs. Redact it, or log an opaque id instead.',
    suggest: (line) => line.replace(/\$\{[^}]+\}/, '<redacted>'),
    answers: {
      // vocab-ok: "log pipeline" is ordinary English in demo finding copy, not the CI noun
      explain: 'The log pipeline ships to a retained index; anything interpolated here is stored in plain text.',
      fix: 'Log the opaque id, never the value. The suggestion is line-accurate.',
      similar: 'Grep for logger.error interpolations across this repository.',
      why: 'Matched rule secrets/no-credential-logging on an interpolated template literal.',
    },
  },
  {
    category: 'concurrency',
    severity: 'major',
    title: () => 'Shared state mutated across an await boundary',
    body: 'Two callers can interleave between read and write. Hold the in-flight promise instead of a boolean guard.',
    answers: {
      explain: 'The guard is read and written in separate microtasks; both callers can observe the stale value.',
      fix: 'Assign the promise before the first await and return it to subsequent callers.',
      similar: 'The same guard shape appears wherever a boolean flag protects an async section.',
      why: 'Interleaving detected across await points on shared mutable state.',
    },
  },
  {
    category: 'errorHandling',
    severity: 'major',
    title: () => 'Failure path swallows the original error',
    body: 'The catch block rethrows without the cause. Attach the original error so operators can trace it.',
    answers: {
      explain: 'The stack that reaches the log starts here, not at the failing call.',
      fix: 'Rethrow with { cause } or log the original before mapping it.',
      similar: 'Check the sibling handlers in this module for the same pattern.',
      why: 'A catch parameter is never referenced by the raised error.',
    },
  },
  {
    category: 'performance',
    severity: 'minor',
    title: (s) => `Per-call work that can be hoisted${s ? '' : ''}`,
    body: 'This runs on every invocation but depends on nothing in scope. Hoist it to module level.',
    answers: {
      explain: 'The allocation shows up under load; it is invariant across calls.',
      fix: 'Move the construction next to the imports.',
      similar: 'Look for the same construction inside other hot paths.',
      why: 'Invariant expression detected inside a frequently-called function.',
    },
  },
  {
    category: 'tests',
    severity: 'minor',
    title: () => 'New branch has no covering test',
    body: 'The added conditional is untested. One case for the new branch keeps the regression door shut.',
    answers: {
      explain: 'Coverage on this file dropped with this change; the new branch is the gap.',
      fix: 'Add a case that drives the new condition both ways.',
      similar: 'The spec file next to this module has a harness you can extend.',
      why: 'New conditional branches with no corresponding assertions in the diff.',
    },
  },
  {
    category: 'craftsmanship',
    severity: 'nit',
    title: () => 'Naming drifts from the surrounding module',
    body: 'Neighbouring code spells this concept differently. Align the name to keep grep honest.',
    answers: {
      explain: 'Two spellings for one concept doubles every future search.',
      fix: 'Rename to match the dominant spelling in this module.',
      similar: 'Check exports of this module for the established term.',
      why: 'Lexical drift against the module vocabulary.',
    },
  },
];

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic candidate findings for one file's added lines, given its
 * `newPath`-qualified `filePath`, the composite/head sha the seed is drawn
 * from, and the file's own unified-diff patch text. `sequenceStart` is the
 * running item-sequence counter a caller already owns (kept solely for id
 * uniqueness across files); a fresh caller with no running counter may pass
 * `0`.
 */
export function demoFindingsForFile(headSha: string, filePath: string, patch: string, sequenceStart: number): ReviewItem[] {
  const anchors = addedLines(patch);
  if (anchors.length === 0) return [];
  // Deterministic per file: which anchors get findings, and which template.
  const seed = hash(`${headSha}:${filePath}`);
  const take = Math.min(anchors.length, 1 + (seed % 2));
  const used = new Set<number>();
  const items: ReviewItem[] = [];
  let sequence = sequenceStart;
  for (let i = 0; i < take; i++) {
    // Distinct anchors per file — step patterns can collide when the
    // anchor count divides the stride.
    let index = (seed + i * 7) % anchors.length;
    while (used.has(index)) index = (index + 1) % anchors.length;
    used.add(index);
    const anchor = anchors[index];
    if (!anchor) continue;
    const template = TEMPLATES[(seed + i) % TEMPLATES.length] as Template;
    // Unsigned shift — a signed one goes negative for high hashes and
    // drags every confidence under the floor.
    const confidence = 58 + ((seed >>> (4 + i)) % 40);
    const snippet = anchor.text.trim();
    items.push({
      id: `dem_${hash(`${filePath}:${anchor.line}`).toString(16)}_${sequence++}`,
      file: filePath,
      anchored: true,
      line: anchor.line,
      severity: template.severity,
      category: template.category,
      confidence,
      title: template.title(snippet),
      body: template.body,
      code: snippet,
      suggestion:
        template.suggest && template.suggest(snippet) !== snippet
          ? { old: snippet, new: template.suggest(snippet) }
          : undefined,
      answers: { ...template.answers },
    });
  }
  return items;
}
