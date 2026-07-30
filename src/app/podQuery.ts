/**
 * One query per pod (handoff §9/§12): change requests, work items and CI
 * runs fetched in a single batched pass. Every dashboard number derives
 * from this one result — never from a second, contradicting source.
 */
import type { Connection } from '../platform/provider';
import type { ChangeRequest, CiRun, WorkItem } from '../platform/types';
import type { Pod } from '../domain/types';

export interface PodData {
  pod: Pod;
  changeRequests: ChangeRequest[];
  workItems: WorkItem[];
  ciRuns: CiRun[];
  fetchedAt: number;
}

export interface PodStats {
  waitingOnYou: number;
  /** Reviewed / total open — reviewed stays 0 until the review store lands. */
  aiCoverage: { reviewed: number; total: number };
  pipelinesFailing: number;
  projectsInPod: number;
}

export function repoIdsOf(pod: Pod): string[] {
  const ids = pod.sources.flatMap((s) => (s.kind === 'repository' ? [s.repoId] : s.repoIds));
  return [...new Set(ids)];
}

export function repoLabel(pod: Pod, repoId: string): string {
  const repo = pod.repos?.find((r) => r.id === repoId);
  return repo?.name ?? repo?.path ?? repoId;
}

export async function fetchPodData(connection: Connection, pod: Pod, now: number): Promise<PodData> {
  const repoIds = repoIdsOf(pod);
  const [changeRequests, workItems, ciRuns] = await Promise.all([
    connection.listOpenChangeRequests(repoIds),
    connection.listWorkItems(repoIds),
    connection.listCiRuns(repoIds, 3),
  ]);
  changeRequests.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  workItems.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { pod, changeRequests, workItems, ciRuns, fetchedAt: now };
}

export function deriveStats(data: PodData): PodStats {
  const you = data.pod.username;
  // Until posted-review thread tracking lands (issue #12), "waiting on you"
  // approximates to: open CRs naming you a reviewer that you did not author.
  const waitingOnYou = you
    ? data.changeRequests.filter(
        (cr) => cr.author.username !== you && cr.reviewers.some((r) => r.username === you),
      ).length
    : 0;
  return {
    waitingOnYou,
    aiCoverage: { reviewed: 0, total: data.changeRequests.length },
    pipelinesFailing: data.changeRequests.filter((cr) => cr.ci?.status === 'failed').length,
    projectsInPod: repoIdsOf(data.pod).length,
  };
}
