/**
 * The demo review agent: deterministic findings generated from the actual
 * diff, so the whole review flow can be driven against the emulator with
 * no Copilot dependency. Every anchor lands on a real added line, which
 * means submits pass the emulator's (and GitLab's) position validation.
 *
 * The extension never ships its own prompt as the only option (spec §5) —
 * this agent exists for the demo pod and F5 debugging; real Copilot agents
 * are discovered alongside it.
 */
import type { ChangeRequestDiff } from '../platform/types';
import type { AgentReviewResponse, CandidateBucket } from '../domain/agentResponse';
import type { Category, Criteria, ReviewItem, Severity } from '../domain/types';
import { filterReason } from '../domain/criteria';
import { addedLines, diffStats } from '../domain/diffHunks';

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

export interface DemoAgentResult {
  response: AgentReviewResponse;
  /** Spec §4 progress log lines, in order. */
  steps: string[];
}

export function runDemoAgent(diff: ChangeRequestDiff, criteria: Criteria): DemoAgentResult {
  const items: ReviewItem[] = [];
  const rejectedBuckets = new Map<string, CandidateBucket>();
  let sequence = 0;

  for (const file of diff.files) {
    const anchors = addedLines(file.diff);
    if (anchors.length === 0) continue;
    // Deterministic per file: which anchors get findings, and which template.
    const seed = hash(`${diff.headSha}:${file.newPath}`);
    const take = Math.min(anchors.length, 1 + (seed % 2));
    const used = new Set<number>();
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
      const item: ReviewItem = {
        id: `dem_${hash(`${file.newPath}:${anchor.line}`).toString(16)}_${sequence++}`,
        file: file.newPath,
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
      };
      const reason = filterReason(item, criteria);
      if (reason === null) {
        items.push(item);
      } else {
        const key = `${reason}:${item.severity}:${item.category}`;
        const bucket = rejectedBuckets.get(key);
        if (bucket) {
          bucket.count += 1;
          // The clean screen reads this as "highest scored N%".
          bucket.confidence = Math.max(bucket.confidence, item.confidence);
        } else
          rejectedBuckets.set(key, {
            severity: item.severity,
            category: item.category,
            confidence: item.confidence,
            reason,
            count: 1,
          });
      }
    }
  }

  const stats = diffStats(diff.files.map((f) => f.diff));
  const response: AgentReviewResponse = {
    schemaVersion: '1',
    agentId: DEMO_AGENT_ID,
    agentLabel: DEMO_AGENT_LABEL,
    headSha: diff.headSha,
    stats: {
      filesRead: diff.files.length,
      linesAdded: stats.added,
      linesRemoved: stats.removed,
      durationMs: 1800,
    },
    items,
    candidates: [...rejectedBuckets.values()],
  };
  return {
    response,
    steps: [
      'Resolving agent from Copilot workspace…',
      `Indexing ${diff.files.length} changed files (+${stats.added} −${stats.removed})…`,
      'Cross-referencing module history…',
      'Scoring findings against your criteria…',
      `${items.length} items ready`,
    ],
  };
}
