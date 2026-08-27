import type { Pod } from '../domain/types';
import type { ChangeRequest, WorkItem } from '../platform/types';
import type { ManualChangesetRecord } from './manualChangesets';

export interface DetectedChangeset {
  id: string;
  name: string;
  /** Trailer groups carry the issue; branch and manual groups have none. */
  linkedIssue?: string;
  detection: 'trailer' | 'branch' | 'manual';
  detectionDetail: string;
  members: Array<ChangeRequest & { projectPath: string }>;
  pipelinesPassing: number;
  pipelinesTotal: number;
}

export interface ChangesetDetectionOptions {
  /** The trailer convention (`codeVerdict.changesets.trailer`), with or without the colon. */
  trailer?: string;
  /** Branch-name fallback (`codeVerdict.changesets.branchDetection`) — spec: "can be switched off". */
  branchFallback?: boolean;
  /** Hand-built groups for this pod — always available, never detection-only. */
  manual?: readonly ManualChangesetRecord[];
}

export const DEFAULT_TRAILER = 'Part-of:';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `Part-of` and `Part-of:` configure the same convention, and the colon is
 * optional in the description too — the spec's form is `Part-of: #1180`
 * (handoff §16), but a team writing `Part-of #1180` means the same thing and
 * silently detecting nothing is the worst way to tell them otherwise.
 */
function trailerPattern(trailer: string): RegExp {
  const key = (trailer.trim() || DEFAULT_TRAILER).replace(/:$/, '');
  return new RegExp(`^${escapeRegExp(key)}:?\\s*#(\\d+)\\s*$`, 'gim');
}

/**
 * Every work item the description links through the trailer convention, in
 * source order and deduplicated. Exported because the review context
 * (`reviewContext.ts`) resolves the same links for the agent prompt, and this
 * format's parser stays beside the convention it belongs to — an inlined
 * re-implementation of it once failed into a plausible wrong answer rather
 * than a crash, which is far more expensive than one export.
 */
export function linkedWorkItemNumbers(description: string | undefined, trailer?: string): string[] {
  const matches = [...(description ?? '').matchAll(trailerPattern(trailer?.trim() || DEFAULT_TRAILER))];
  return [...new Set(matches.flatMap((match) => (match[1] ? [match[1]] : [])))];
}

function memberKey(ref: { repoId: string; number: string }): string {
  return `${ref.repoId}!${ref.number}`;
}

function toChangeset(
  pod: Pod,
  members: ChangeRequest[],
  identity: Pick<DetectedChangeset, 'id' | 'name' | 'linkedIssue' | 'detection' | 'detectionDetail'>,
): DetectedChangeset {
  return {
    ...identity,
    members: members.map((member) => ({
      ...member,
      projectPath: pod.repos?.find((repository) => repository.id === member.ref.repoId)?.path ?? member.ref.repoId,
    })),
    pipelinesPassing: members.filter((member) => member.ci?.status === 'success').length,
    pipelinesTotal: members.length,
  };
}

/**
 * Detection runs over the pod's open change requests on refresh (handoff §16).
 * Three routes in order of preference — trailer, branch, manual — and a
 * detected group is a suggestion until the user opens it.
 */
export function detectChangesets(
  pod: Pod,
  changeRequests: readonly ChangeRequest[],
  workItems: readonly WorkItem[],
  options: ChangesetDetectionOptions = {},
): DetectedChangeset[] {
  const trailer = options.trailer?.trim() || DEFAULT_TRAILER;
  const trailerKey = trailer.replace(/:$/, '');

  const groups = new Map<string, ChangeRequest[]>();
  const claimed = new Set<string>();
  for (const changeRequest of changeRequests) {
    for (const issueNumber of linkedWorkItemNumbers(changeRequest.description, trailer)) {
      const members = groups.get(issueNumber) ?? [];
      members.push(changeRequest);
      groups.set(issueNumber, members);
    }
  }

  const detected: DetectedChangeset[] = [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([issueNumber, members]) => {
      for (const member of members) claimed.add(memberKey(member.ref));
      // Issue numbers are per-repository on GitLab — prefer a work item that
      // lives in one of the member repos over a bare number collision.
      const memberRepos = new Set(members.map((member) => member.ref.repoId));
      const issue =
        workItems.find((candidate) => candidate.number === issueNumber && memberRepos.has(candidate.repoId)) ??
        workItems.find((candidate) => candidate.number === issueNumber);
      const linkedIssue = `#${issueNumber}`;
      return toChangeset(pod, members, {
        id: `trailer:${issueNumber}`,
        name: issue?.title ?? `Changeset ${linkedIssue}`,
        linkedIssue,
        detection: 'trailer',
        detectionDetail: `${trailerKey}: ${linkedIssue} in every description`,
      });
    });

  if (options.branchFallback !== false) {
    const byBranch = new Map<string, ChangeRequest[]>();
    for (const changeRequest of changeRequests) {
      // "In order of preference": a trailer group owns its members — the
      // branch route only groups what the trailer left unclaimed.
      if (claimed.has(memberKey(changeRequest.ref)) || !changeRequest.sourceBranch) continue;
      const members = byBranch.get(changeRequest.sourceBranch) ?? [];
      members.push(changeRequest);
      byBranch.set(changeRequest.sourceBranch, members);
    }
    for (const [branch, members] of byBranch) {
      // A shared branch inside one repo is just one line of work; the signal
      // is the same name reused across projects.
      if (members.length < 2 || new Set(members.map((member) => member.ref.repoId)).size < 2) continue;
      detected.push(toChangeset(pod, members, {
        id: `branch:${branch}`,
        name: members[0]?.title ?? branch,
        detection: 'branch',
        detectionDetail: `shared branch name ${branch}`,
      }));
    }
  }

  for (const record of options.manual ?? []) {
    const wanted = new Set(record.members.map(memberKey));
    const members = changeRequests.filter((changeRequest) => wanted.has(memberKey(changeRequest.ref)));
    // Members merge or close over time; below two open ones there is no
    // "reviewed together" left to offer.
    if (members.length < 2) continue;
    detected.push(toChangeset(pod, members, {
      id: record.id,
      name: record.name,
      detection: 'manual',
      detectionDetail: 'manual selection',
    }));
  }

  return detected;
}
