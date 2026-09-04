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
import type { RunProjection } from '../domain/harnessActivity';
import type { ActivityEntry, DashboardRow, DashboardViewState, RowScope } from './dashboardHtml';
import { cap, repoCountOf, runLifecycleLabel } from './vocab';

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
 * "prev: …" — the earlier recorded outcome on this same target, shown
 * alongside a live pill so a reviewer never has to wonder whether the row
 * that used to say "8 findings" still has that review, or whether the
 * rerun in progress already erased it (task 14.4). `undefined` when there
 * is nothing earlier to report — a first-ever run on this target has no
 * "prev" to distinguish itself from.
 */
function retainedSummary(submitted: boolean, run: ReviewRun | undefined): string | undefined {
  if (submitted) return 'prev: submitted';
  if (run?.outcome === 'clean') return 'prev: no findings';
  if (run?.outcome === 'findings') return `prev: ${run.findingCount} finding${run.findingCount === 1 ? '' : 's'}`;
  return undefined;
}

/** Every `Limitation`'s message, one line for a `title=""` tooltip — never truncated, since a tooltip has no fixed-width column to break. */
function limitationsTitle(limitations: readonly { message: string }[] | undefined): string | undefined {
  return limitations && limitations.length > 0 ? limitations.map((l) => l.message).join(' ') : undefined;
}

/**
 * Precedence, strictly: happening now (task 14.4: the live `RunProjection`'s
 * own lifecycle, verbatim off `runLifecycleLabel` — the same shared label
 * every other surface renders, D14) > submitted (it is on the platform) >
 * clean (the agent ran and found nothing) > partial (validated findings, but
 * short of complete — D11) > findings waiting for triage > interrupted >
 * never run. Only the second of those is a `ReviewHistory` entry; the rest
 * come from the run store, which is why a clean run used to read "not run"
 * forever.
 *
 * A run in flight outranks every recorded outcome because it is about to
 * replace one: showing last week's verdict on a row whose review is running
 * says the wrong thing about what the reviewer is waiting for. It never
 * *hides* that verdict, though — `retainedSummary` above rides alongside the
 * live pill as `.note`, so a complete retained review a rerun might replace
 * stays visible and distinct from the rerun itself, exactly the row task
 * 14.4 asks for (never conflated with the rerun's own current status).
 *
 * Labels are sized for the 104px "AI review" column: at 11px mono a pill fits
 * about eleven characters inside its 8px padding, so "N findings" and "no
 * findings" fit and "N findings ready" would not — a lifecycle label like
 * "Investigating" instead truncates on its own line (`.pill-cell .pill`) the
 * same way a long repository name already does in `.cell-repo`, rather than
 * being shortened or re-worded away from `runLifecycleLabel`'s own spelling.
 */
function aiPill(
  submitted: boolean,
  run: ReviewRun | undefined,
  projection: RunProjection | undefined,
): DashboardRow['ai'] {
  if (projection) {
    return { label: runLifecycleLabel(projection.lifecycle), cls: 'pill-agent', note: retainedSummary(submitted, run) };
  }
  if (submitted) return { label: 'submitted', cls: 'pill-agent' };
  if (run?.outcome === 'clean') return { label: 'no findings', cls: 'pill-ok' };
  // Neither reviewed nor unreviewed: something ran and was lost with the
  // window. Said plainly, because the alternative — falling through to the
  // finding count — reports a confident "0 findings" about a run that never
  // produced one. A stored checkpoint's own integrity reasons (task 12.7)
  // ride the same tooltip a partial result's limitations use below — visible
  // on hover, but this pill stays a passive status indicator, never a
  // button: task 14.6's actual resume-from-checkpoint control (as well as
  // restart) lives on the review flow panel this row already opens
  // (`runControlsRow`/`interruptedPriorNotice` in `reviewFlowHtml.ts`),
  // where the manager's current transition validity — not a snapshot taken
  // here at dashboard-render time — decides what is legal to offer.
  if (run?.outcome === 'interrupted') {
    return { label: 'interrupted', cls: 'pill', title: limitationsTitle(run.resumeReasons) };
  }
  // A partial result is never folded into the plain "N findings" pill below
  // (D11: "no surface presents the run as a complete or clean review") —
  // its own label, and its own tooltip naming why it stopped short.
  if (run?.outcome === 'partial') {
    return { label: `${run.findingCount} partial`, cls: 'pill-warn', title: limitationsTitle(run.limitations) };
  }
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
   * whatever the last run concluded, and it clears on its own. Task 14.4
   * (design.md D14): the run's own `RunProjection`, not a dashboard-local
   * `'running' | 'queued'` re-derivation — the same projection the active
   * review screen and the sidebar render from.
   */
  activeRuns?: () => ReadonlyMap<string, RunProjection>;
  /** Row click: submitted rows open Posted reviews, others Run review (§2). */
  openCr?: (ref: { repoId: string; number: string }, submitted: boolean) => void;
  openChangeset?: (changesetId: string) => void;
  /** The band's "+ new" — the manual detection route (handoff §16). */
  createChangeset?: () => void;
  /** Trailer/branch settings + manual groups, read at render time. */
  changesetOptions?: () => ChangesetDetectionOptions;
  /** Notify sibling views after the dashboard changes the active pod. */
  onPodChanged?: () => void;
  /**
   * Drop retained reviews for change requests that have closed. Hung off this
   * refresh because it is the one that already knows which are still open, for
   * exactly the repositories the answer is valid for.
   */
  pruneRetained?: (repoIds: readonly string[], openRefs: readonly { repoId: string; number: string }[]) => void;
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
  /**
   * Targets with a review in flight or waiting for a slot, keyed the same
   * way. Task 14.4 (design.md D14): the same `RunProjection` the active
   * review screen and the sidebar already render from — never a
   * dashboard-local `'running' | 'queued'` re-derivation, which used to
   * report every phase of a run as the same "running…" pill.
   */
  activeRuns: ReadonlyMap<string, RunProjection> = new Map(),
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
