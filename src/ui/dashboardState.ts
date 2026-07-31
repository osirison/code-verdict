/**
 * Dashboard view-state derivation — pure (no `vscode` import) so tests can
 * drive the exact pipeline the panel renders.
 */
import { deriveStats, repoIdsOf, repoLabel } from '../app/podQuery';
import type { PodData } from '../app/podQuery';
import { getProvider } from '../platform/registry';
import type { ActivityEntry, DashboardViewState, RowScope } from './dashboardHtml';

export function formatAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface DashboardDeps {
  /** CR refs (repoId!number) with a submitted review — fills the AI pill. */
  submittedRefs?: () => ReadonlySet<string>;
  /** Row click: submitted rows open Posted reviews, others Run review (§2). */
  openCr?: (ref: { repoId: string; number: string }, submitted: boolean) => void;
}

export function toViewState(
  data: PodData,
  now: number,
  submittedRefs: ReadonlySet<string>,
): DashboardViewState {
  const pod = data.pod;
  const you = pod.username;
  const vocabulary = getProvider(pod.providerId).vocabulary;

  const counts = new Map<string, number>();
  const scopeCounts = { you: 0, them: 0 };
  const rows = data.changeRequests.map((cr) => {
    counts.set(cr.ref.repoId, (counts.get(cr.ref.repoId) ?? 0) + 1);
    const scope: RowScope =
      you && cr.author.username !== you && cr.reviewers.some((r) => r.username === you)
        ? 'you'
        : you && cr.author.username === you
          ? 'them'
          : 'none';
    if (scope === 'you') scopeCounts.you += 1;
    if (scope === 'them') scopeCounts.them += 1;
    const submitted = submittedRefs.has(`${cr.ref.repoId}!${cr.ref.number}`);
    return {
      repoId: cr.ref.repoId,
      number: cr.ref.number,
      refLabel: vocabulary.formatCrRef(cr.ref.number),
      title: cr.title,
      author: cr.author.username,
      branch: cr.sourceBranch,
      project: repoLabel(pod, cr.ref.repoId),
      scope,
      ai: submitted
        ? ({ label: 'submitted', cls: 'pill-agent' } as const)
        : ({ label: 'not run', cls: 'pill' } as const),
      submitted,
      ciStatus: cr.ci?.status,
      age: formatAge(cr.updatedAt, now),
    };
  });

  const activity: Array<ActivityEntry & { at: string }> = [];
  for (const run of data.ciRuns) {
    if (!run.createdAt) continue;
    if (run.status === 'failed') {
      activity.push({
        glyph: '✕',
        cls: 'bad',
        text: `Pipeline #${run.id} failed${run.failedJobName ? ` · ${run.failedJobName}` : ''}`,
        meta: `${repoLabel(pod, run.repoId)} · ${formatAge(run.createdAt, now)} ago`,
        at: run.createdAt,
      });
    } else if (run.status === 'success') {
      activity.push({
        glyph: '✓',
        cls: 'ok',
        text: `Pipeline #${run.id} passed`,
        meta: `${repoLabel(pod, run.repoId)} · ${formatAge(run.createdAt, now)} ago`,
        at: run.createdAt,
      });
    }
  }
  for (const cr of data.changeRequests.slice(0, 4)) {
    activity.push({
      glyph: '⚑',
      cls: 'warn',
      text: `@${cr.author.username} updated ${vocabulary.formatCrRef(cr.ref.number)} — ${cr.title}`,
      meta: `${cr.sourceBranch} · ${repoLabel(pod, cr.ref.repoId)} · ${formatAge(cr.updatedAt, now)} ago`,
      at: cr.updatedAt,
    });
  }
  activity.sort((a, b) => b.at.localeCompare(a.at));

  return {
    podName: pod.name,
    meta: `${repoIdsOf(pod).length} ${vocabulary.repoNoun}s · ${data.changeRequests.length} open ${vocabulary.changeRequestAbbrev}s`,
    scopeCounts,
    stats: {
      ...deriveStats(data),
      aiCoverage: { reviewed: submittedRefs.size, total: data.changeRequests.length },
    },
    fetchedAgo: `${formatAge(new Date(data.fetchedAt).toISOString(), now)} ago`,
    projects: repoIdsOf(pod).map((id) => ({
      id,
      label: repoLabel(pod, id),
      count: counts.get(id) ?? 0,
    })),
    rows,
    issues: data.workItems.slice(0, 8).map((wi) => ({
      title: wi.title,
      project: repoLabel(pod, wi.repoId),
      assignee: wi.assignee ? `@${wi.assignee.username}` : '—',
      milestone: wi.milestone ?? '—',
      age: formatAge(wi.updatedAt, now),
    })),
    activity: activity.slice(0, 5).map(({ at: _at, ...entry }) => entry),
    pipelines: [...data.ciRuns]
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, 3)
      .map((run) => ({
        id: run.id,
        status: run.status,
        job: run.failedJobName ?? run.ref ?? '',
        age: run.createdAt ? formatAge(run.createdAt, now) : '',
      })),
  };
}
