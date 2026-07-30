/**
 * Validation of the agent review contract (`agentReviewResponse` in
 * `spec/specs/Code Verdict - API fixtures.json`). Items missing
 * file/line/severity/category/confidence are rejected individually; a
 * response missing its envelope fields is rejected whole.
 */
import type { Category, ReviewItem, Severity } from './types';
import { ALL_CATEGORIES } from './types';
import { SEVERITY_ORDER } from './criteria';

export interface CandidateBucket {
  severity: Severity;
  category: Category;
  confidence: number;
  reason: 'belowSeverityFloor' | 'belowConfidence' | 'categoryOff';
  count: number;
}

export interface AgentReviewStats {
  filesRead: number;
  linesAdded: number;
  linesRemoved: number;
  durationMs: number;
}

export interface AgentReviewResponse {
  schemaVersion: string;
  agentId: string;
  agentLabel: string;
  headSha: string;
  stats?: AgentReviewStats;
  items: ReviewItem[];
  /** Findings the agent produced that fell below the criteria — power the clean-bill screen. */
  candidates: CandidateBucket[];
}

export interface RejectedItem {
  index: number;
  reason: string;
}

export class AgentResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentResponseError';
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const SEVERITIES = new Set<string>(SEVERITY_ORDER);
const CATEGORIES = new Set<string>(ALL_CATEGORIES);
const CANDIDATE_REASONS = new Set<string>(['belowSeverityFloor', 'belowConfidence', 'categoryOff']);

function itemRejection(raw: Record<string, unknown>): string | null {
  if (typeof raw.file !== 'string' || raw.file === '') return 'missing file';
  if (typeof raw.line !== 'number' || !Number.isFinite(raw.line)) return 'missing line';
  if (typeof raw.severity !== 'string' || !SEVERITIES.has(raw.severity)) {
    return `invalid severity: ${String(raw.severity)}`;
  }
  if (typeof raw.category !== 'string' || !CATEGORIES.has(raw.category)) {
    return `invalid category: ${String(raw.category)}`;
  }
  if (typeof raw.confidence !== 'number' || raw.confidence < 0 || raw.confidence > 100) {
    return `invalid confidence: ${String(raw.confidence)}`;
  }
  return null;
}

function toItem(raw: Record<string, unknown>, index: number): ReviewItem {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const suggestion = isRecord(raw.suggestion)
    ? { old: str(raw.suggestion.old) ?? '', new: str(raw.suggestion.new) ?? '' }
    : undefined;
  const spans = Array.isArray(raw.spans)
    ? raw.spans.filter(isRecord).map((s) => ({
        repoId: str(s.projectId) ?? str(s.repoId) ?? '',
        location: str(s.location) ?? '',
        role: str(s.role) ?? '',
      }))
    : undefined;
  const answers = isRecord(raw.answers)
    ? Object.fromEntries(
        (['explain', 'fix', 'similar', 'why'] as const)
          .map((k) => [k, str(raw.answers && (raw.answers as Record<string, unknown>)[k])])
          .filter(([, v]) => v !== undefined),
      )
    : undefined;

  return {
    id: str(raw.id) ?? `itm_generated_${index}`,
    file: raw.file as string,
    line: raw.line as number,
    endLine: typeof raw.endLine === 'number' ? raw.endLine : undefined,
    severity: raw.severity as Severity,
    category: raw.category as Category,
    confidence: raw.confidence as number,
    title: str(raw.title) ?? '(untitled finding)',
    body: str(raw.body) ?? '',
    code: str(raw.code) ?? '',
    rule: str(raw.rule),
    reference: str(raw.reference),
    repoId: str(raw.projectId) ?? str(raw.repoId),
    crNumber: str(raw.mrIid) ?? str(raw.crNumber),
    cross: raw.cross === true ? true : undefined,
    spans,
    suggestion,
    answers,
  };
}

export function parseAgentReviewResponse(rawInput: unknown): {
  response: AgentReviewResponse;
  rejected: RejectedItem[];
} {
  if (!isRecord(rawInput)) throw new AgentResponseError('agent response is not an object');
  const raw = rawInput;

  if (raw.schemaVersion !== '1') {
    throw new AgentResponseError(`unsupported schemaVersion: ${String(raw.schemaVersion)}`);
  }
  if (typeof raw.headSha !== 'string' || raw.headSha === '') {
    throw new AgentResponseError('agent response missing headSha — staleness detection depends on it');
  }
  if (!Array.isArray(raw.items)) throw new AgentResponseError('agent response missing items[]');

  const items: ReviewItem[] = [];
  const rejected: RejectedItem[] = [];
  raw.items.forEach((entry, index) => {
    if (!isRecord(entry)) {
      rejected.push({ index, reason: 'item is not an object' });
      return;
    }
    const rejection = itemRejection(entry);
    if (rejection !== null) {
      rejected.push({ index, reason: rejection });
      return;
    }
    items.push(toItem(entry, index));
  });

  const candidates: CandidateBucket[] = Array.isArray(raw.candidates)
    ? raw.candidates.filter(isRecord).flatMap((c) => {
        const ok =
          typeof c.severity === 'string' &&
          SEVERITIES.has(c.severity) &&
          typeof c.category === 'string' &&
          CATEGORIES.has(c.category) &&
          typeof c.confidence === 'number' &&
          typeof c.reason === 'string' &&
          CANDIDATE_REASONS.has(c.reason) &&
          typeof c.count === 'number';
        return ok
          ? [
              {
                severity: c.severity as Severity,
                category: c.category as Category,
                confidence: c.confidence as number,
                reason: c.reason as CandidateBucket['reason'],
                count: c.count as number,
              },
            ]
          : [];
      })
    : [];

  const finite = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const stats = isRecord(raw.stats)
    ? {
        filesRead: finite(raw.stats.filesRead),
        linesAdded: finite(raw.stats.linesAdded),
        linesRemoved: finite(raw.stats.linesRemoved),
        durationMs: finite(raw.stats.durationMs),
      }
    : undefined;

  return {
    response: {
      schemaVersion: raw.schemaVersion,
      agentId: typeof raw.agentId === 'string' ? raw.agentId : 'unknown-agent',
      agentLabel: typeof raw.agentLabel === 'string' ? raw.agentLabel : 'Unknown agent',
      headSha: raw.headSha,
      stats,
      items,
      candidates,
    },
    rejected,
  };
}
