import { deriveStats, repoIdsOf, repoLabel, type PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import { getProvider, tryGetProvider } from '../platform/registry';
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import type { SidebarViewState } from './sidebarHtml';
import { repoCountOf } from './vocab';

export function toSidebarViewState(data: PodData, pods: readonly Pod[]): SidebarViewState {
  const pod = data.pod;
  const vocabulary = getProvider(pod.providerId).vocabulary;
  return {
    vocabulary,
    podName: pod.name,
    podMeta: repoCountOf(vocabulary, repoIdsOf(pod).length),
    pods: pods.map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      // A pod in the switcher names its own provider's nouns, not the active one's.
      meta: repoCountOf(
        tryGetProvider(candidate.providerId)?.vocabulary ?? NEUTRAL_VOCABULARY,
        repoIdsOf(candidate).length,
      ),
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