import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { AppStore } from '../app/appStore';
import { detectChangesets } from '../app/changesets';
import { collectCrossFindings } from '../app/changesetFindings';
import { connectionForPod } from '../app/connections';
import { ManualChangesetStore } from '../app/manualChangesets';
import { deriveMergeOrder } from '../app/mergeOrder';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import { getProvider } from '../platform/registry';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { diffStats } from '../domain/diffHunks';
import type { Review } from '../domain/types';
import type { ChangesetMessage, ChangesetViewState } from './changesetHtml';
import { renderChangesetBody, renderChangesetHtml, renderChangesetLoadingHtml } from './changesetHtml';
import { changesetDetectionOptions } from './changesetOptions';
import { AppSurface, type AppRoute } from './appSurface';

export interface ChangesetPanelDeps {
  podStore: PodStore;
  /** The shared pod-data copy (task 6.2); the member diffs stay on a direct connection. */
  appStore: AppStore;
  secrets: SecretStore;
  globalState: KeyValueStore;
  /** The combined-review triage draft lives here (`codeVerdict.changesetDraft.<id>`). */
  workspaceState: KeyValueStore;
  openCr: (ref: { repoId: string; number: string }) => void;
  openReview: (changesetId: string, selectItemId?: string) => void;
  openDashboard: () => void;
}

export class ChangesetPanel {
  private static current: ChangesetPanel | undefined;

  static async show(deps: ChangesetPanelDeps, changesetId: string): Promise<void> {
    // Re-showing an active route keeps its message handlers (AppSurface) —
    // reuse the live controller instead of stacking a second one onto them.
    const existing = ChangesetPanel.current;
    if (existing && !existing.disposed && existing.changesetId === changesetId) {
      AppSurface.reveal();
      return existing.load();
    }
    const route = AppSurface.show(`changeset:${changesetId}`, 'Verdict: Changeset', deps.openDashboard);
    const controller = new ChangesetPanel(route, deps, changesetId);
    ChangesetPanel.current = controller;
    await controller.load();
  }

  /** Pod switched or a review landed while the screen is open — repaint it. */
  static refreshIfOpen(): void {
    const panel = ChangesetPanel.current;
    if (panel && !panel.disposed) void panel.load();
  }

  private disposed = false;
  private loadSeq = 0;
  /** First load() on this instance paints the loading skeleton (task 7.6);
   * see load(). */
  private painted = false;
  /** The store subscription below — dropped with the route, or a dead
   * screen would keep repainting the panel over whatever replaced it. */
  private readonly storeWatch: { dispose(): void };

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: ChangesetPanelDeps,
    private readonly changesetId: string,
  ) {
    // Pod data now reaches this screen through the store (task 6.4): a poll
    // that moved a member's CI state or the detected grouping repaints it.
    // load() reads the store back, so the repaint costs the member diffs only.
    this.storeWatch = deps.appStore.subscribe((data) => {
      if (!this.disposed && data.pod.id === this.deps.podStore.activePod?.id) void this.load();
    });
    route.onLeave(() => {
      this.disposed = true;
      this.storeWatch.dispose();
      if (ChangesetPanel.current === this) ChangesetPanel.current = undefined;
    });
    // The document reloaded underneath this route (issue #39 follow-up) —
    // e.g. "Developer: Reload Webviews" recreates the webview from the
    // stored (possibly stale) html. `ready` was just reset, so load()'s own
    // postRegions call falls back to setHtml on its own — no separate path
    // needed here, and no need to re-fetch since the member diffs are
    // already held.
    route.onReload(() => void this.load());
    route.onMessage((message) => void this.onMessage(message as ChangesetMessage));
  }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    try {
      const pod = this.deps.podStore.activePod;
      if (!pod) return this.deps.openDashboard();
      const options = changesetDetectionOptions(this.deps.globalState, pod.id);
      // First paint on navigation (task 7.6), before the store read below —
      // the pod name and the changeset id are always known synchronously.
      // Upgraded to the real changeset name when the store already holds
      // this pod's data: detectChangesets runs over that synchronously via
      // `peek`, which — unlike `read` — never starts a fetch of its own.
      //
      // Painted unconditionally on first entry, not only when nothing is
      // held (contrast dashboard.ts's `!this.painted && !read.data`): even
      // with held pod data this screen still owes a network round for the
      // per-member diffs below, and that round is exactly what the "upgrade
      // to the real name" case exists to cover — a guard that skipped
      // painting whenever data was held would make that case unreachable.
      if (!this.painted) {
        const held = this.deps.appStore.peek(pod.id);
        const knownName = held
          ? detectChangesets(pod, held.changeRequests, held.workItems, options)
              .find((candidate) => candidate.id === this.changesetId)?.name
          : undefined;
        this.route.setHtml(renderChangesetLoadingHtml(
          pod.name,
          knownName ?? this.changesetId,
          crypto.randomBytes(16).toString('hex'),
        ));
      }
      this.painted = true;
      // The pod read goes through the store (task 6.2). The member diffs
      // below stay on a direct connection: they are per change request,
      // never pod-keyed, and the store holds pod data only.
      const read = this.deps.appStore.read(pod);
      const data = read.data ?? (await read.fetch!);
      if (this.disposed || seq !== this.loadSeq) return;
      const changeset = detectChangesets(pod, data.changeRequests, data.workItems, options)
        .find((candidate) => candidate.id === this.changesetId);
      if (!changeset) return this.deps.openDashboard();
      const connection = await connectionForPod(pod, this.deps.secrets);
      if (this.disposed || seq !== this.loadSeq) return;
      const diffs = await Promise.all(changeset.members.map((member) => connection.getChangeRequestDiff(member.ref)));
      if (this.disposed || seq !== this.loadSeq) return;
      const stats = diffStats(diffs.flatMap((diff) => diff.files.map((file) => file.diff)));
      const history = new ReviewHistory(this.deps.globalState);
      const submitted = history.submittedRefs();
      const draft = this.deps.workspaceState.get<{ review: Review }>(`codeVerdict.changesetDraft.${this.changesetId}`);
      const findings = collectCrossFindings(
        draft?.review.items,
        history.list(),
        changeset.members.map((member) => member.ref),
      );
      const projectLabel = (repoId: string): string =>
        pod.repos?.find((repository) => repository.id === repoId)?.name ?? repoId;
      const order = deriveMergeOrder(changeset.members, findings ?? []);
      this.route.panel.title = `Verdict: Changeset · ${changeset.name}`;
      const state: ChangesetViewState = {
        vocabulary: getProvider(pod.providerId).vocabulary,
        id: changeset.id,
        name: changeset.name,
        linkedIssue: changeset.linkedIssue,
        detectionDetail: changeset.detectionDetail,
        manual: changeset.detection === 'manual',
        added: stats.added,
        removed: stats.removed,
        reviewed: changeset.members.filter((member) => submitted.has(`${member.ref.repoId}!${member.ref.number}`)).length,
        pipelinesPassing: changeset.pipelinesPassing,
        crossRepoBlockers: findings?.filter((finding) => finding.severity === 'blocker').length,
        findings: findings?.map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          title: finding.title,
          confidence: finding.confidence,
          sides: finding.spans.map((span) => ({
            project: projectLabel(span.repoId),
            location: span.location,
            role: span.role,
          })),
        })),
        members: order.map(({ member, reason }) => ({
          repoId: member.ref.repoId,
          number: member.ref.number,
          project: member.projectPath,
          refLabel: `!${member.ref.number}`,
          title: member.title,
          ciStatus: member.ci?.status,
          reviewed: submitted.has(`${member.ref.repoId}!${member.ref.number}`),
          reason,
        })),
      };
      // Patch the region in place rather than replacing the whole document
      // (task 7.3) — falling back to setHtml only when the page has not yet
      // signalled ready is exactly today's always-full-render behaviour.
      if (!this.route.postRegions({ 'cs-body': renderChangesetBody(state) })) {
        this.route.setHtml(renderChangesetHtml(state, crypto.randomBytes(16).toString('hex')));
      }
    } catch (error) {
      if (this.disposed || seq !== this.loadSeq) return;
      void vscode.window.showErrorMessage(`Verdict: ${error instanceof Error ? error.message : String(error)}`);
      this.deps.openDashboard();
    }
  }

  private async onMessage(message: ChangesetMessage): Promise<void> {
    switch (message.type) {
      case 'openMember':
        return this.deps.openCr({ repoId: message.repoId, number: message.number });
      case 'openFinding':
        return this.deps.openReview(message.changesetId, message.itemId);
      case 'reviewTogether':
        return this.deps.openReview(message.changesetId);
      case 'removeChangeset':
        return this.removeManual();
      case 'back':
        return this.deps.openDashboard();
    }
  }

  private async removeManual(): Promise<void> {
    const pod = this.deps.podStore.activePod;
    if (!pod) return;
    const vocabulary = getProvider(pod.providerId).vocabulary;
    const picked = await vscode.window.showWarningMessage(
      `Remove this changeset? The ${vocabulary.changeRequestNounPlural} stay open — only the grouping goes away.`,
      { modal: true },
      'Remove',
    );
    if (picked !== 'Remove') return;
    await new ManualChangesetStore(this.deps.globalState).remove(pod.id, this.changesetId);
    this.deps.openDashboard();
  }
}
