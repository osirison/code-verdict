import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import { detectChangesets } from '../app/changesets';
import { connectionForPod } from '../app/connections';
import { fetchPodData } from '../app/podQuery';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore, SecretStore } from '../app/storage';
import { diffStats } from '../domain/diffHunks';
import type { ChangesetMessage } from './changesetHtml';
import { renderChangesetHtml } from './changesetHtml';

export interface ChangesetPanelDeps {
  podStore: PodStore;
  secrets: SecretStore;
  globalState: KeyValueStore;
  openCr: (ref: { repoId: string; number: string }) => void;
  openReview: (changesetId: string) => void;
  openDashboard: () => void;
}

export class ChangesetPanel {
  static async show(deps: ChangesetPanelDeps, changesetId: string): Promise<void> {
    const panel = vscode.window.createWebviewPanel('codeVerdict.changeset', 'Verdict: Changeset', vscode.ViewColumn.One, { enableScripts: true });
    const pod = deps.podStore.activePod;
    if (!pod) return panel.dispose();
    const connection = await connectionForPod(pod, deps.secrets);
    const data = await fetchPodData(connection, pod, Date.now());
    const changeset = detectChangesets(pod, data.changeRequests, data.workItems).find((candidate) => candidate.id === changesetId);
    if (!changeset) return panel.dispose();
    const diffs = await Promise.all(changeset.members.map((member) => connection.getChangeRequestDiff(member.ref)));
    const stats = diffStats(diffs.flatMap((diff) => diff.files.map((file) => file.diff)));
    const submitted = new ReviewHistory(deps.globalState).submittedRefs();
    panel.title = `Verdict: Changeset · ${changeset.name}`;
    panel.webview.html = renderChangesetHtml({
      id: changeset.id,
      name: changeset.name,
      linkedIssue: changeset.linkedIssue,
      detectionDetail: changeset.detectionDetail,
      added: stats.added,
      removed: stats.removed,
      reviewed: changeset.members.filter((member) => submitted.has(`${member.ref.repoId}!${member.ref.number}`)).length,
      pipelinesPassing: changeset.pipelinesPassing,
      crossRepoBlockers: undefined,
      members: changeset.members.map((member) => ({
        repoId: member.ref.repoId,
        project: member.projectPath,
        refLabel: `!${member.ref.number}`,
        title: member.title,
        ciStatus: member.ci?.status,
        reviewed: submitted.has(`${member.ref.repoId}!${member.ref.number}`),
        reason: member.description?.split(/\n\s*\n/)[1]?.trim() ?? 'Member detected from the shared changeset trailer.',
      })),
    }, crypto.randomBytes(16).toString('hex'));
    panel.webview.onDidReceiveMessage((message: ChangesetMessage) => {
      if (message.type === 'openMember') deps.openCr({ repoId: message.repoId, number: message.number });
      else if (message.type === 'back') deps.openDashboard();
      else deps.openReview(message.changesetId);
    });
  }
}