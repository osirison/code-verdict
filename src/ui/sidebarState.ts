import { deriveStats, repoIdsOf, repoLabel, type PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import { getProvider } from '../platform/registry';
import type { SidebarViewState } from './sidebarHtml';

export function toSidebarViewState(data: PodData, pods: readonly Pod[]): SidebarViewState {
  const pod = data.pod;
  const vocabulary = getProvider(pod.providerId).vocabulary;
  return {
    podName: pod.name,
    podMeta: `${repoIdsOf(pod).length} ${vocabulary.repoNoun}s`,
    pods: pods.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      meta: `${repoIdsOf(candidate).length} projects`,
      active: candidate.id === pod.id,
    })),
    mergeRequests: data.changeRequests.slice(0, 8).map((cr) => ({
      repoId: cr.ref.repoId,
      number: cr.ref.number,
      label: vocabulary.formatCrRef(cr.ref.number),
      title: cr.title,
      project: repoLabel(pod, cr.ref.repoId),
      waiting: pod.username !== undefined
        && cr.author.username !== pod.username
        && cr.reviewers.some((reviewer) => reviewer.username === pod.username),
    })),
    issues: data.workItems.slice(0, 6).map((issue) => ({
      label: `#${issue.number}`,
      title: issue.title,
      project: repoLabel(pod, issue.repoId),
    })),
    waitingOnYou: deriveStats(data).waitingOnYou,
  };
}