/**
 * Dashboard view-state derivation — pure (no `vscode` import) so tests can
 * drive the exact pipeline the panel renders.
 */
import { deriveStats, repoIdsOf, repoLabel } from '../app/podQuery';
import type { PodData } from '../app/podQuery';
import { detectChangesets } from '../app/changesets';
import type { ChangesetDetectionOptions } from '../app/changesets';
import type { ReviewRun } from '../app/reviewRuns';
import { getProvider } from '../platform/registry';
import type { ActivityEntry, DashboardRow, DashboardViewState, RowScope } from './dashboardHtml';
import { cap, repoCountOf } from './vocab';

export function formatAge(iso: string, now: number): string {
  const ms = now - Date.parse(iso);
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/**
 * The refresh button's label. It used to be `formatAge(data.fetchedAt, now)`,
 * with `fetchedAt` stamped at fetch time and `now` a few milliseconds later
 * at render time — so it read "0m ago" permanently and never moved, which is
 * half of why ⟳ looked dead. A wall-clock stamp cannot go stale that way, and
 * needs no client-side timer: a region patch replaces the whole header, so an
 * interval ticking the age would have to be re-armed after every repaint.
 */
export function formatClock(at: number): string {
  const when = new Date(at);
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
}

/**
 * Precedence, strictly: happening now > submitted (it is on the platform) >
 * clean (the agent ran and found nothing) > findings waiting for triage >
 * interrupted > never run. Only the second of those is a `ReviewHistory`
 * entry; the rest come from the run store, which is why a clean run used to
 * read "not run" forever.
 *
 * A run in flight outranks every recorded outcome because it is about to
 * replace one: showing last week's verdict on a row whose review is running
 * says the wrong thing about what the reviewer is waiting for.
 *
 * Labels are sized for the 104px "AI review" column: at 11px mono a pill fits
 * about eleven characters inside its 8px padding, so "N findings" and "no
 * findings" fit and "N findings ready" would not.
 */
function aiPill(
  submitted: boolean,
  run: ReviewRun | undefined,
  active: 'running' | 'queued' | undefined,
): DashboardRow['ai'] {
  if (active) return { label: active === 'queued' ? 'queued' : 'running…', cls: 'pill-agent' };
  if (submitted) return { label: 'submitted', cls: 'pill-agent' };
  if (run?.outcome === 'clean') return { label: 'no findings', cls: 'pill-ok' };
  // Neither reviewed nor unreviewed: something ran and was lost with the
  // window. Said plainly, because the alternative — falling through to the
  // finding count — reports a confident "0 findings" about a run that never
  // produced one.
  if (run?.outcome === 'interrupted') return { label: 'interrupted', cls: 'pill' };
  if (run) return { label: `${run.findingCount} finding${run.findingCount === 1 ? '' : 's'}`, cls: 'pill-warn' };
  return { label: 'not run', cls: 'pill' };
}

export interface DashboardDeps {
  /** CR refs (repoId!number) with a submitted review — fills the AI pill. */
  submittedRefs?: () => ReadonlySet<string>;
  /**
   * Latest review run per CR ref (repoId!number), submitted or not. Separate
   * from `submittedRefs` on purpose: a clean run is a real outcome to show
   * and is never a submitted review.
   */
  reviewRuns?: () => ReadonlyMap<string, ReviewRun>;
  /**
   * Which of those refs has a review in flight right now. Read separately from
   * `reviewRuns` because it is live state, not a recorded outcome: it outranks
   * whatever the last run concluded, and it clears on its own.
   */
  activeRuns?: () => ReadonlyMap<string, 'running' | 'queued'>;
  /** Row click: submitted rows open Posted reviews, others Run review (§2). */
  openCr?: (ref: { repoId: string; number: string }, submitted: boolean) => void;
  openChangeset?: (changesetId: string) => void;
  /** The band's "+ new" — the manual detection route (handoff §16). */
  createChangeset?: () => void;
  /** Trailer/branch settings + manual groups, read at render time. */
  changesetOptions?: () => ChangesetDetectionOptions;
  /** Notify sibling views after the dashboard changes the active pod. */
  onPodChanged?: () => void;
}

export interface DashboardPodOption {
  id: string;
  name: string;
  meta: string;
}

export interface PodDataWithOptions extends PodData {
  podOptions?: DashboardPodOption[];
}

export function toViewState(
  data: PodDataWithOptions,
  now: number,
  submittedRefs: ReadonlySet<string>,
  changesetOptions?: ChangesetDetectionOptions,
  reviewRuns: ReadonlyMap<string, ReviewRun> = new Map(),
  /** Targets with a review in flight or waiting for a slot, keyed the same way. */
  activeRuns: ReadonlyMap<string, 'running' | 'queued'> = new Map(),
): DashboardViewState {
  const pod = data.pod;
  const you = pod.username;
  const vocabulary = getProvider(pod.providerId).vocabulary;
  const changesets = detectChangesets(pod, data.changeRequests, data.workItems, changesetOptions);

  const counts = new Map<string, number>();
  const scopeCounts = { you: 0, them: 0 };
  // Counted off the rows, like scopeCounts: `submittedRefs` is every entry
  // ever written — other pods, and change requests that have since closed —
  // while `total` is only this pod's open ones, so using its size made the
  // numerator outrun the denominator (a "12/9 reviewed" stat).
  let reviewedRows = 0;
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
    const refKey = `${cr.ref.repoId}!${cr.ref.number}`;
    const submitted = submittedRefs.has(refKey);
    const run = reviewRuns.get(refKey);
    // "Reviewed" is "the agent has run on it", which a clean run satisfies —
    // it is exactly the row set whose pill is not "not run".
    if (submitted || run) reviewedRows += 1;
    return {
      repoId: cr.ref.repoId,
      number: cr.ref.number,
      refLabel: vocabulary.formatCrRef(cr.ref.number),
      title: cr.title,
      author: cr.author.username,
      branch: cr.sourceBranch,
      project: repoLabel(pod, cr.ref.repoId),
      scope,
      ai: aiPill(submitted, run, activeRuns.get(refKey)),
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
        text: `${cap(vocabulary.ciNoun)} #${run.id} failed${run.failedJobName ? ` · ${run.failedJobName}` : ''}`,
        meta: `${repoLabel(pod, run.repoId)} · ${formatAge(run.createdAt, now)} ago`,
        at: run.createdAt,
      });
    } else if (run.status === 'success') {
      activity.push({
        glyph: '✓',
        cls: 'ok',
        text: `${cap(vocabulary.ciNoun)} #${run.id} passed`,
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
    vocabulary,
    podName: pod.name,
    meta: `${repoCountOf(vocabulary, repoIdsOf(pod).length)} · ${data.changeRequests.length} open ${vocabulary.changeRequestAbbrev}s`,
    podOptions: data.podOptions?.map((p) => ({
      id: p.id,
      name: p.name,
      active: p.id === pod.id,
      meta: p.meta,
    })),
    scopeCounts,
    stats: {
      ...deriveStats(data),
      aiCoverage: { reviewed: reviewedRows, total: data.changeRequests.length },
    },
    fetchedLabel: formatClock(data.fetchedAt),
    projects: repoIdsOf(pod).map((id) => ({
      id,
      label: repoLabel(pod, id),
      count: counts.get(id) ?? 0,
    })),
    changesets: changesets.map((changeset) => {
      const blocked = changeset.members.filter((member) => member.ci?.status === 'failed').length;
      const toReview = changeset.members.filter((member) => !submittedRefs.has(`${member.ref.repoId}!${member.ref.number}`)).length;
      return {
        id: changeset.id,
        name: changeset.name,
        memberCount: changeset.members.length,
        projectCount: new Set(changeset.members.map((member) => member.ref.repoId)).size,
        state: blocked > 0 ? `${blocked} blocked` : toReview > 0 ? `${toReview} to review` : 'ready to merge',
        stateClass: blocked > 0 ? 'pill-bad' as const : toReview > 0 ? 'pill-warn' as const : 'pill-ok' as const,
      };
    }),
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
