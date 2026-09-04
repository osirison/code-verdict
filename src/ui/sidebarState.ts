import { deriveStats, repoIdsOf, repoLabel, type PodData } from '../app/podQuery';
import type { Pod } from '../domain/types';
import { getProvider, tryGetProvider } from '../platform/registry';
import { NEUTRAL_VOCABULARY } from '../platform/provider';
import type { RunRecord } from '../app/reviewRunManager';
import type { SidebarActiveRun, SidebarViewState } from './sidebarHtml';
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
      // Carried, not discarded (issue #40): a row with nothing to open is not
      // a fix. No `formatIssueRef` exists on `Vocabulary` — GitLab and GitHub
      // both use `#` today, so the literal stays until a platform disagrees.
      repoId: issue.repoId,
      number: issue.number,
      webUrl: issue.webUrl,
      label: `#${issue.number}`,
      title: issue.title,
      project: repoLabel(pod, issue.repoId),
    })),
    waitingOnYou: deriveStats(data).waitingOnYou,
  };
}

/**
 * The sidebar's compact active-run list, straight off each record's own
 * `RunProjection` (task 14.3, design.md D14) — never a second, sidebar-local
 * read of `RunRecord`. Every field here is copied, not recomputed: the
 * lifecycle, current action, elapsed time, and progress mode/units are
 * exactly what the active review screen itself renders from, so the two
 * surfaces cannot describe the same run differently.
 */
export function toSidebarActiveRuns(records: readonly RunRecord[]): SidebarActiveRun[] {
  return records.map((record) => ({
    key: record.key,
    label: record.input.refLabel,
    lifecycle: record.projection.lifecycle,
    currentAction: record.projection.currentAction,
    elapsedMs: record.projection.elapsedMs,
    progressMode: record.projection.progressMode,
    progressUnits: record.projection.progressUnits,
    attention: record.projection.attention,
  }));
}