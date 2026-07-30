import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { repoIdsOf } from '../app/podQuery';
import { COMMANDS } from '../commands';

interface NavRow {
  label: string;
  icon: string;
  command?: string;
  description?: string;
}

export class VerdictSidebarProvider implements vscode.TreeDataProvider<NavRow> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly podStore: PodStore) {}

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(row: NavRow): vscode.TreeItem {
    const item = new vscode.TreeItem(row.label);
    item.iconPath = new vscode.ThemeIcon(row.icon);
    item.description = row.description;
    if (row.command) {
      item.command = { command: row.command, title: row.label };
    }
    return item;
  }

  getChildren(): NavRow[] {
    const pod = this.podStore.activePod;
    // No pod → empty tree, which is what lets the contributed viewsWelcome
    // ("Sign in to GitLab") render. Nav rows appear once connected, per
    // the spec's onboarding sidebar behaviour.
    if (!pod) return [];
    const rows: NavRow[] = [
      {
        label: pod.name,
        icon: 'organization',
        description: `${repoIdsOf(pod).length} projects`,
        command: COMMANDS.switchPod,
      },
    ];
    rows.push(
      { label: 'Pod dashboard', icon: 'dashboard', command: COMMANDS.openDashboard },
      { label: 'Posted reviews', icon: 'comment-discussion', command: COMMANDS.openReview },
      { label: 'Agent tuning', icon: 'graph', command: COMMANDS.selectAgent },
      { label: 'Settings', icon: 'gear', command: COMMANDS.editCriteria },
    );
    return rows;
  }
}

export function createStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  item.text = '$(verified) Verdict: no active review';
  item.tooltip = 'Code Verdict — open the pod dashboard';
  item.command = COMMANDS.openDashboard;
  item.show();
  return item;
}
