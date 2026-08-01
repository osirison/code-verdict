import type { Pod } from '../domain/types';
import type { ChangeRequest, WorkItem } from '../platform/types';

export interface DetectedChangeset {
  id: string;
  name: string;
  linkedIssue: string;
  detection: 'trailer';
  detectionDetail: string;
  members: Array<ChangeRequest & { projectPath: string }>;
  pipelinesPassing: number;
  pipelinesTotal: number;
}

const PART_OF = /^Part-of:\s*#(\d+)\s*$/gim;

export function detectChangesets(
  pod: Pod,
  changeRequests: readonly ChangeRequest[],
  workItems: readonly WorkItem[],
): DetectedChangeset[] {
  const groups = new Map<string, ChangeRequest[]>();
  for (const changeRequest of changeRequests) {
    const matches = [...(changeRequest.description ?? '').matchAll(PART_OF)];
    const issueNumbers = new Set(matches.flatMap((match) => match[1] ? [match[1]] : []));
    for (const issueNumber of issueNumbers) {
      const members = groups.get(issueNumber) ?? [];
      members.push(changeRequest);
      groups.set(issueNumber, members);
    }
  }

  return [...groups.entries()]
    .filter(([, members]) => members.length > 1)
    .map(([issueNumber, members]) => {
      const issue = workItems.find((candidate) => candidate.number === issueNumber);
      const linkedIssue = `#${issueNumber}`;
      return {
        id: `trailer:${issueNumber}`,
        name: issue?.title ?? `Changeset ${linkedIssue}`,
        linkedIssue,
        detection: 'trailer' as const,
        detectionDetail: `Part-of: ${linkedIssue} in every description`,
        members: members.map((member) => ({
          ...member,
          projectPath: pod.repos?.find((repository) => repository.id === member.ref.repoId)?.path ?? member.ref.repoId,
        })),
        pipelinesPassing: members.filter((member) => member.ci?.status === 'success').length,
        pipelinesTotal: members.length,
      };
    });
}