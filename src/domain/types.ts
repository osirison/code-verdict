/**
 * The product model (handoff §3), expressed over the neutral platform
 * vocabulary: `repoId` is a platform Repository id ("project" on GitLab),
 * `crNumber` a ChangeRequest number (GitLab MR iid). The agent-response
 * parser maps the spec's `projectId`/`mrIid` field names onto these.
 */
import type { Criteria as CriteriaShape } from './criteria';
import type { EffortLevel } from './effort';

export type Severity = 'nit' | 'minor' | 'major' | 'blocker';

export type Category =
  | 'security'
  | 'concurrency'
  | 'errorHandling'
  | 'performance'
  | 'craftsmanship'
  | 'apiContract'
  | 'tests'
  | 'docs'
  | 'style';

export const ALL_CATEGORIES: readonly Category[] = [
  'security',
  'concurrency',
  'errorHandling',
  'performance',
  'craftsmanship',
  'apiContract',
  'tests',
  'docs',
  'style',
];

export type Criteria = CriteriaShape;

export type PodSource =
  | { kind: 'repository'; repoId: string }
  /** Explicit selection, never "all" — a repo added to the group later must not silently join. */
  | { kind: 'group'; groupId: string; repoIds: string[] };

export interface Pod {
  id: string;
  name: string;
  providerId: string;
  instanceUrl: string;
  /**
   * How this pod was connected. Absent on pods created before the credential
   * union existed — those fall back to the provider's declared order.
   * Recorded because a host can offer both: without it, a pod onboarded with a
   * pasted token would silently authenticate as the editor's account instead,
   * which is a different identity and a different set of visible repositories.
   */
  authMode?: 'token' | 'session' | 'none';
  sources: PodSource[];
  /** Per pod, not per change request. */
  criteria: Criteria;
  /**
   * The selected agent. A value starting with `lm:` is a **pre-migration
   * model id** from before agents and models were separate things; read it
   * through `selectionFromPod` (app/podSelection.ts), never directly, and it
   * resolves to the built-in agent paired with that model.
   */
  agentId: string;
  /** The selected Copilot model. Absent on a pod saved before the split, and on a demo pod. */
  modelId?: string;
  /** Prompt-level review effort, isolated by model id. Invalid stored entries are ignored on read. */
  effortByModel?: Record<string, EffortLevel>;
  /** Repository snapshot (id/path/name) taken when sources were resolved. */
  repos?: Array<{ id: string; path: string; name: string }>;
  /** Signed-in username at connection time — drives "waiting on you". */
  username?: string;
}

export interface ReviewItem {
  id: string;
  file: string;
  /** Host-derived from diff-file membership. Omitted stored values predate attachments and read as true. */
  anchored: boolean;
  /** Anchor as reported by the agent. */
  line: number;
  endLine?: number;
  severity: Severity;
  category: Category;
  /** 0-100 */
  confidence: number;
  title: string;
  body: string;
  /** The offending hunk. */
  code: string;
  rule?: string;
  reference?: string;
  /** Required in a changeset review — which repo the finding lands in. */
  repoId?: string;
  /** Which change request the comment is posted to. */
  crNumber?: string;
  /** True when the finding only exists between repos. */
  cross?: boolean;
  spans?: Array<{ repoId: string; location: string; role: string }>;
  suggestion?: { old: string; new: string };
  answers?: Partial<Record<'explain' | 'fix' | 'similar' | 'why', string>>;
}

export function isReviewItemAnchored(item: ReviewItem): boolean {
  return item.anchored !== false;
}

export type Verdict = 'accepted' | 'rejected' | 'skipped';

export interface VerdictRecord {
  verdict: Verdict;
  applyFix: boolean;
  note?: string;
}

export interface Review {
  crNumber: string;
  repoId: string;
  agentId: string;
  /** The model that produced it. Absent on a review stored before the split, and on a demo review. */
  modelId?: string;
  /** Prompt-level effort that produced it. Absent stored values predate the control and read as `none`. */
  effort?: EffortLevel;
  criteria: Criteria;
  /** What the agent read — compare against the CR head to detect staleness. */
  headSha: string;
  items: ReviewItem[];
  verdicts: Record<string, VerdictRecord>;
  /** Generated, user-editable. */
  summary: string;
  finalNote?: string;
  submittedAt?: string;
}

export interface Changeset {
  id: string;
  podId: string;
  name: string;
  crs: Array<{ repoId: string; number: string }>;
  detection: 'trailer' | 'branch' | 'manual';
  /** e.g. "Part-of: #1180 in every description" */
  detectionDetail: string;
  linkedIssue?: string;
  mergeOrder: Array<{ number: string; repoId: string; reason: string }>;
}
