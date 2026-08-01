import * as vscode from 'vscode';
import { ALL_COMMAND_IDS, COMMANDS } from './commands';
import { runDebugBootstrap } from './app/debugBootstrap';
import { PodStore } from './app/pods';
import { ReviewHistory } from './app/reviewHistory';
import { getDebugAuthBypass } from './debugAuth';
import { registerBuiltInProviders } from './registry';
import { DashboardPanel } from './ui/dashboard';
import { ChangesetPanel } from './ui/changeset';
import { ChangesetReviewPanel } from './ui/changesetReview';
import { OnboardingPanel } from './ui/onboarding';
import { PostedReviewsPanel } from './ui/postedReviews';
import type { DashboardDeps } from './ui/dashboardState';
import { ReviewFlowPanel } from './ui/reviewFlow';
import { SettingsPanel } from './ui/settings';
import { VerdictSidebarProvider, createStatusBarItem } from './ui/sidebar';
import type { SidebarActiveReview } from './ui/sidebarHtml';
import { TuningPanel } from './ui/tuning';
import { AppSurface } from './ui/appSurface';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerBuiltInProviders();
  const podStore = new PodStore(context.globalState);
  const secrets = context.secrets;
  const reviewHistory = new ReviewHistory(context.globalState);

  const flowDeps = {
    podStore,
    secrets,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    onSubmitted: () => {
      sidebar.refresh();
      void DashboardPanel.refreshIfOpen();
    },
    onSidebarState: (state?: SidebarActiveReview) => sidebar.setActiveReview(state),
  };

  const sidebar = new VerdictSidebarProvider(podStore, {
    secrets,
    openCr: (ref) => void ReviewFlowPanel.open(flowDeps, ref),
    selectFinding: (itemId) => {
      ReviewFlowPanel.selectItem(itemId);
      ChangesetReviewPanel.selectItem(itemId);
    },
    onPodChanged: () => void DashboardPanel.refreshIfOpen(),
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeVerdict.sidebar', sidebar),
    createStatusBarItem(),
    AppSurface.onDidChangeRoute((route) => sidebar.setActiveRoute(route)),
  );

  const postedDeps = {
    podStore,
    secrets,
    globalState: context.globalState,
    openReviewFlow: (ref: { repoId: string; number: string }) =>
      void ReviewFlowPanel.open(flowDeps, ref),
  };

  const dashboardDeps: DashboardDeps = {
    submittedRefs: () => reviewHistory.submittedRefs(),
    onPodChanged: () => sidebar.refresh(),
    openCr: (ref, submitted) => {
      if (submitted) {
        void PostedReviewsPanel.show(postedDeps, ref);
        return;
      }
      void ReviewFlowPanel.open(flowDeps, ref);
    },
    openChangeset: (changesetId) => void ChangesetPanel.show({
      podStore,
      secrets,
      globalState: context.globalState,
      openCr: (ref) => void ReviewFlowPanel.open(flowDeps, ref),
      openReview: (id) => void ChangesetReviewPanel.open({
        podStore,
        secrets,
        workspaceState: context.workspaceState,
        globalState: context.globalState,
        openSingle: (ref) => void ReviewFlowPanel.open(flowDeps, ref),
        openDashboard: () => void openDashboard(),
        onSubmitted: () => {
          sidebar.refresh();
          void DashboardPanel.refreshIfOpen();
        },
        onSidebarState: (state) => sidebar.setActiveReview(state),
      }, id),
      openDashboard: () => void openDashboard(),
    }, changesetId),
  };

  const openDashboard = async (): Promise<void> => {
    if (!podStore.activePod) {
      void vscode.window.showInformationMessage(
        'Verdict: connect first — run "Verdict: Sign in to GitLab".',
      );
      return;
    }
    await DashboardPanel.show(podStore, secrets, dashboardDeps);
  };

  const bootstrapFromDebugBypass = async (): Promise<void> => {
    const bypass = getDebugAuthBypass(context.extensionMode);
    if (!bypass) {
      void vscode.window.showWarningMessage('Verdict: the debug auth bypass is not enabled.');
      return;
    }
    try {
      const pod = await runDebugBootstrap(bypass, podStore, secrets);
      sidebar.refresh();
      void vscode.window.showInformationMessage(
        `Verdict: connected to ${bypass.instanceUrl} as @${pod.username ?? 'you'} — "${pod.name}" watches ${pod.repos?.length ?? 0} projects.`,
      );
      await openDashboard();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Verdict: ${message}`);
    }
  };

  const signIn = async (): Promise<void> => {
    OnboardingPanel.show({
      podStore,
      secrets,
      onComplete: () => {
        sidebar.refresh();
        void openDashboard();
      },
    });
  };

  const switchPod = async (): Promise<void> => {
    const pods = podStore.list();
    if (pods.length === 0) {
      void vscode.window.showInformationMessage('Verdict: no pods yet — sign in first.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      pods.map((p) => ({ label: p.name, description: p.instanceUrl, id: p.id })),
      { placeHolder: 'Switch pod' },
    );
    if (!picked) return;
    await podStore.setActive(picked.id);
    sidebar.refresh();
    await DashboardPanel.refreshIfOpen();
  };

  const handlers: Partial<Record<string, () => Promise<void> | void>> = {
    [COMMANDS.openDashboard]: openDashboard,
    [COMMANDS.openReview]: () => {
      // Naming doc: "Verdict: Open review" is the triage tab for the
      // active MR — Posted reviews has its own (internal) entry point.
      if (!ReviewFlowPanel.revealIfOpen()) {
        void vscode.window.showInformationMessage(
          'Verdict: no active review — open a merge request from the dashboard first.',
        );
      }
    },
    [COMMANDS.refresh]: async () => {
      sidebar.refresh();
      await DashboardPanel.refreshIfOpen();
    },
    [COMMANDS.signIn]: signIn,
    [COMMANDS.newPod]: signIn,
    [COMMANDS.switchPod]: switchPod,
    [COMMANDS.editCriteria]: () => SettingsPanel.show({ podStore, secrets }),
    [COMMANDS.selectAgent]: () => TuningPanel.show({ podStore, globalState: context.globalState }),
  };

  for (const id of ALL_COMMAND_IDS) {
    const handler =
      handlers[id] ??
      (() => {
        // Review-tab commands (A/R/S, J/K, generate, submit …) route to the
        // active review panel first.
        if (ReviewFlowPanel.handleCommand(id)) return;
        void vscode.window.showInformationMessage(
          `Verdict: "${id}" is not implemented yet — the extension is under construction.`,
        );
      });
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // Not in the palette (the naming doc's 19 commands reserve openReview
  // for triage) — the sidebar row, dashboard rows and "Track replies"
  // reach Posted reviews through this internal id.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'codeVerdict.internal.postedReviews',
      (focusRef?: { repoId: string; number: string }) =>
        void PostedReviewsPanel.show(postedDeps, focusRef),
    ),
  );

  // F5 with the debug env vars set (see .vscode/launch.json): skip
  // onboarding entirely and land on a populated dashboard. Fire and
  // forget — activation must not block on network I/O.
  if (getDebugAuthBypass(context.extensionMode)) {
    void bootstrapFromDebugBypass();
  }
}

export function deactivate(): void {}
