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
import { manifestContainsLocation, parseAgentReviewResponse, type AgentReviewResponse, type CandidateBucket } from '../domain/agentResponse';
import type { Category, Criteria, ReviewItem, Severity } from '../domain/types';
import { filterReason } from '../domain/criteria';
import { addedLines, diffStats } from '../domain/diffHunks';
import { modelVisiblePath } from './modelVisiblePath';
import {
  ATTACHMENT_TOTAL_BUDGET,
  neutralizeAttachmentWrapperTags,
  renderAttachmentsForModel,
  type Attachment,
  type RenderedAttachments,
} from './reviewContext';

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

export interface DemoAgentOptions {
  workspaceRootLabel?: string;
  attachments?: readonly Attachment[];
  attachmentBudget?: number;
  /** Exact records prepared by a changeset-wide budget allocation. */
  renderedAttachments?: RenderedAttachments;
}

interface AttachmentLine {
  path: string;
  line: number;
  text: string;
}

function detectedAttachmentLines(rendered: RenderedAttachments): AttachmentLine[] {
  const detected = new Map<string, AttachmentLine>();
  for (const attachment of rendered.attachments) {
    const visibleLength = Math.min(
      attachment.content.length,
      attachment.visibleContentLength ?? attachment.content.length,
    );
    for (const source of attachment.evidence ?? []) {
      const visibleEnd = Math.min(source.contentEnd, visibleLength);
      if (visibleEnd <= source.contentStart) continue;
      const content = neutralizeAttachmentWrapperTags(
        attachment.content.slice(source.contentStart, visibleEnd),
      );
      const lines = source.wholeRange
        ? [{ path: source.path, line: source.range.startLine, text: content.trim() }]
        : content.split(/\r?\n/).map((text, index) => ({
            path: source.path,
            line: source.range.startLine + index,
            text: text.trim(),
          }));
      const visibleLines = lines.filter((line) => (
        line.text !== '' && manifestContainsLocation(rendered.manifest, line.path, line.line)
      ));
      if (visibleLines.length === 0) continue;
      const representative = visibleLines.reduce((best, line) => (
        hash(`${line.path}:${line.line}:${line.text}`) < hash(`${best.path}:${best.line}:${best.text}`)
          ? line
          : best
      ));
      detected.set(`${representative.path}:${representative.line}:${representative.text}`, representative);
    }
  }
  return [...detected.values()];
}

/**
 * Deterministic candidate findings for one file's added lines, given its
 * `newPath`-qualified `filePath`, the composite/head sha the seed is drawn
 * from, and the file's own unified-diff patch text. Extracted out of
 * {@link runDemoAgent}'s per-file loop (task 10.7 of
 * `add-agentic-review-harness`) so the deterministic demo participant can
 * reuse the exact same finding logic one file at a time, from just that
 * file's own patch bytes (its `readDiff` tool result) — never from a whole
 * `ChangeRequestDiff` object it was never given. `sequenceStart` is the
 * running item-sequence counter a caller already owns (kept solely for id
 * uniqueness across files, matching `runDemoAgent`'s original behavior
 * exactly); a fresh caller with no running counter may pass `0`.
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

export function runDemoAgent(
  diff: ChangeRequestDiff,
  criteria: Criteria,
  options: DemoAgentOptions = {},
): DemoAgentResult {
  const items: ReviewItem[] = [];
  const rejectedBuckets = new Map<string, CandidateBucket>();
  let sequence = 0;
  const renderedAttachments = options.renderedAttachments ?? renderAttachmentsForModel(
    options.attachments ?? [],
    options.attachmentBudget ?? ATTACHMENT_TOTAL_BUDGET,
  );

  const recordItem = (item: ReviewItem): void => {
    const reason = filterReason(item, criteria);
    if (reason === null) {
      items.push(item);
      return;
    }
    const key = `${reason}:${item.severity}:${item.category}`;
    const bucket = rejectedBuckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.confidence = Math.max(bucket.confidence, item.confidence);
      return;
    }
    rejectedBuckets.set(key, {
      severity: item.severity,
      category: item.category,
      confidence: item.confidence,
      reason,
      count: 1,
    });
  };

  for (const file of diff.files) {
    const filePath = modelVisiblePath(file.newPath, options.workspaceRootLabel);
    const fileFindings = demoFindingsForFile(diff.headSha, filePath, file.diff, sequence);
    sequence += fileFindings.length;
    for (const item of fileFindings) recordItem(item);
  }

  for (const line of detectedAttachmentLines(renderedAttachments)) {
    const seed = hash(`${line.path}:${line.line}:${line.text}`);
    const template = TEMPLATES[seed % TEMPLATES.length] as Template;
    recordItem({
      id: `dem_attachment_${seed.toString(16)}_${sequence++}`,
      file: line.path,
      anchored: false,
      line: line.line,
      severity: template.severity,
      category: template.category,
      confidence: 80 + (seed % 18),
      title: template.title(line.text),
      body: template.body,
      code: line.text,
      answers: { ...template.answers },
    });
  }

  const stats = diffStats(diff.files.map((f) => f.diff));
  const response = parseAgentReviewResponse({
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
  }, {
    diffPaths: diff.files.map((file) => modelVisiblePath(file.newPath, options.workspaceRootLabel)),
    attachmentManifest: renderedAttachments.manifest,
  }).response;
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
