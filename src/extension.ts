import * as vscode from 'vscode';
import { ALL_COMMAND_IDS, COMMANDS, INTERNAL_COMMANDS } from './commands';
import { detectChangesets } from './app/changesets';
import { runDebugBootstrap } from './app/debugBootstrap';
import { ManualChangesetStore } from './app/manualChangesets';
import { PodStore } from './app/pods';
import { connectionForPod } from './app/connections';
import { fetchPodData, repoIdsOf } from './app/podQuery';
import type { PodSource } from './domain/types';
import { getProvider, listRealProviders } from './platform/registry';
import { repoCountOf } from './ui/vocab';
import { ReviewHistory } from './app/reviewHistory';
import { getDebugAuthBypass } from './debugAuth';
import { setSessionProvider } from './app/connections';
import { getSignInOptions, needsSignInChoice, type SignInOption } from './signInFlow';
import { registerBuiltInProviders } from './registry';
import { DashboardPanel } from './ui/dashboard';
import { ChangesetPanel } from './ui/changeset';
import { ChangesetReviewPanel } from './ui/changesetReview';
import { OnboardingPanel } from './ui/onboarding';
import { PostedReviewsPanel } from './ui/postedReviews';
import type { DashboardDeps } from './ui/dashboardState';
import { ReviewFlowPanel } from './ui/reviewFlow';
import { SettingsPanel } from './ui/settings';
import { VerdictSidebarProvider, VerdictStatusBar } from './ui/sidebar';
import type { SidebarActiveReview, SidebarPendingReview, SidebarThreads } from './ui/sidebarHtml';
import { createDemoPod } from './app/demoPod';
import { TuningPanel } from './ui/tuning';
import { AppSurface } from './ui/appSurface';
import { changesetDetectionOptions } from './ui/changesetOptions';
import { VerdictNotifier } from './ui/notifier';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerBuiltInProviders();

  // The session bridge: `connections.ts` stays vscode-free, so the editor's
  // account API is injected here. A provider that declares the 'session' mode
  // for a host gets its token from whichever account VS Code holds for it.
  setSessionProvider(async (providerId, _instanceUrl, opts = {}) => {
    const declared = getProvider(providerId).host.session;
    if (!declared) return undefined;
    try {
      const session = await vscode.authentication.getSession(
        declared.editorProviderId,
        [...declared.scopes],
        // Onboarding may prompt for an account; a later connection may not.
        { createIfNone: opts.createIfNone === true },
      );
      return session?.accessToken;
    } catch {
      // No account, or the user dismissed the prompt: fall through to the
      // provider's next declared mode rather than failing the connection here.
      return undefined;
    }
  });
  const podStore = new PodStore(context.globalState);
  const secrets = context.secrets;
  const reviewHistory = new ReviewHistory(context.globalState);

  const changesetOptions = () => changesetDetectionOptions(context.globalState, podStore.activePod?.id);

  /** One pod fetch → the detected changesets, with the current settings applied. */
  const detectForActivePod = async () => {
    const pod = podStore.activePod;
    if (!pod) return [];
    const connection = await connectionForPod(pod, secrets);
    const data = await fetchPodData(connection, pod, Date.now());
    return detectChangesets(pod, data.changeRequests, data.workItems, changesetOptions());
  };

  const flowDeps = {
    podStore,
    secrets,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    onSubmitted: () => {
      sidebar.refresh();
      void DashboardPanel.refreshIfOpen();
      ChangesetPanel.refreshIfOpen();
      TuningPanel.refreshIfOpen();
    },
    onSidebarState: (state?: SidebarActiveReview) => {
      sidebar.setActiveReview(state);
      statusBar.setActiveReview(state);
    },
    onSidebarPending: (state?: SidebarPendingReview) => sidebar.setPendingReview(state),
    onReviewReady: (info: { ref: { repoId: string; number: string }; refLabel: string; itemCount: number }) =>
      notifier.reviewReady(info),
    // §15 entry point "a member MR" — resolved after the review paints.
    changesetForCr: async (ref: { repoId: string; number: string }) => {
      const found = (await detectForActivePod()).find((changeset) =>
        changeset.members.some((member) => member.ref.repoId === ref.repoId && member.ref.number === ref.number),
      );
      return found ? { id: found.id, name: found.name, memberCount: found.members.length } : undefined;
    },
    openChangeset: (changesetId: string) => openChangeset(changesetId),
  };

  const statusBar = new VerdictStatusBar();

  const notifier = new VerdictNotifier({
    podStore,
    secrets,
    reviewHistory,
    onBadgeCount: (count) => statusBar.setNotifications(count),
    onPollPaused: (pause) => statusBar.setPollPaused(pause),
    openReview: (ref) => void ReviewFlowPanel.open(flowDeps, ref),
    openPostedReviews: (ref) => void PostedReviewsPanel.show(postedDeps, ref),
  });

  const useDemoPod = async (): Promise<void> => {
    try {
      const pod = await createDemoPod(podStore);
      sidebar.refresh();
      void vscode.window.showInformationMessage(
        `Verdict: "${pod.name}" runs on built-in sample data — connect a real platform whenever you are ready.`,
      );
      await openDashboard();
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Verdict: could not create the demo pod — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const sidebar = new VerdictSidebarProvider(podStore, {
    secrets,
    extensionUri: context.extensionUri,
    globalState: context.globalState,
    openCr: (ref) => void ReviewFlowPanel.open(flowDeps, ref),
    openChangeset: (changesetId) => openChangeset(changesetId),
    createChangeset: () => void createManualChangeset(),
    selectFinding: (itemId) => {
      ReviewFlowPanel.selectItem(itemId);
      ChangesetReviewPanel.selectItem(itemId);
    },
    selectThread: (threadId) => PostedReviewsPanel.selectThread(threadId),
    useDemoPod: () => void useDemoPod(),
    onPodChanged: () => {
      void DashboardPanel.refreshIfOpen();
      ChangesetPanel.refreshIfOpen();
      TuningPanel.refreshIfOpen();
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('codeVerdict.sidebar', sidebar),
    statusBar,
    AppSurface.onDidChangeRoute((route) => sidebar.setActiveRoute(route)),
  );

  const postedDeps = {
    podStore,
    secrets,
    globalState: context.globalState,
    openReviewFlow: (ref: { repoId: string; number: string }) =>
      void ReviewFlowPanel.open(flowDeps, ref),
    onSidebarThreads: (threads?: SidebarThreads) => sidebar.setThreads(threads),
  };

  const changesetReviewDeps = {
    podStore,
    secrets,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    openSingle: (ref: { repoId: string; number: string }) => void ReviewFlowPanel.open(flowDeps, ref),
    openDashboard: () => void openDashboard(),
    onSubmitted: () => {
      sidebar.refresh();
      void DashboardPanel.refreshIfOpen();
      ChangesetPanel.refreshIfOpen();
      TuningPanel.refreshIfOpen();
    },
    onSidebarState: (state?: SidebarActiveReview) => {
      sidebar.setActiveReview(state);
      statusBar.setActiveReview(state);
    },
    onReviewReady: (info: { label: string; itemCount: number }) =>
      notifier.reviewReady({ refLabel: info.label, itemCount: info.itemCount }),
  };

  const changesetPanelDeps = {
    podStore,
    secrets,
    globalState: context.globalState,
    workspaceState: context.workspaceState,
    openCr: (ref: { repoId: string; number: string }) => void ReviewFlowPanel.open(flowDeps, ref),
    openReview: (id: string, selectItemId?: string) => void ChangesetReviewPanel.open(changesetReviewDeps, id, selectItemId),
    openDashboard: () => void openDashboard(),
  };

  const openChangeset = (changesetId: string): void => {
    void ChangesetPanel.show(changesetPanelDeps, changesetId);
  };

  /**
   * The manual detection route (handoff §16): pick MRs from the pod — or
   * paste an MR URL, which the quick pick matches against each row's webUrl —
   * then name the group. Stored per pod; detection stays a suggestion-maker.
   */
  const createManualChangeset = async (): Promise<void> => {
    const pod = podStore.activePod;
    if (!pod) {
      void vscode.window.showInformationMessage('Verdict: connect first — run "Verdict: Sign in".');
      return;
    }
    try {
      const connection = await connectionForPod(pod, secrets);
      const data = await fetchPodData(connection, pod, Date.now());
      const vocabulary = getProvider(pod.providerId).vocabulary;
      const picked = await vscode.window.showQuickPick(
        data.changeRequests.map((cr) => ({
          label: `${vocabulary.formatCrRef(cr.ref.number)} · ${cr.title}`,
          description: pod.repos?.find((repo) => repo.id === cr.ref.repoId)?.path ?? cr.ref.repoId,
          detail: cr.webUrl,
          ref: cr.ref,
          crTitle: cr.title,
        })),
        {
          canPickMany: true,
          matchOnDetail: true,
          title: `New changeset — ${vocabulary.changeRequestNounPlural} that ship together`,
          placeHolder: `Pick two or more, or paste a ${vocabulary.changeRequestNoun} URL to find it`,
        },
      );
      if (!picked || picked.length === 0) return;
      if (picked.length < 2) {
        void vscode.window.showWarningMessage(`Verdict: a changeset needs at least two ${vocabulary.changeRequestNounPlural}.`);
        return;
      }
      const name = await vscode.window.showInputBox({
        title: 'Name the changeset',
        value: picked[0]?.crTitle ?? '',
        prompt: 'Shown on the dashboard band and the changeset screen',
      });
      if (!name?.trim()) return;
      const record = await new ManualChangesetStore(context.globalState).add(
        pod.id,
        name.trim(),
        picked.map((item) => item.ref),
      );
      sidebar.refresh();
      await DashboardPanel.refreshIfOpen();
      openChangeset(record.id);
    } catch (e) {
      void vscode.window.showErrorMessage(`Verdict: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const dashboardDeps: DashboardDeps = {
    submittedRefs: () => reviewHistory.submittedRefs(),
    onPodChanged: () => sidebar.refresh(),
    changesetOptions,
    openCr: (ref, submitted) => {
      if (submitted) {
        void PostedReviewsPanel.show(postedDeps, ref);
        return;
      }
      void ReviewFlowPanel.open(flowDeps, ref);
    },
    openChangeset,
    createChangeset: () => void createManualChangeset(),
  };

  const openDashboard = async (): Promise<void> => {
    if (!podStore.activePod) {
      void vscode.window.showInformationMessage(
        'Verdict: connect first — run "Verdict: Sign in".',
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
        `Verdict: connected to ${bypass.instanceUrl} as @${pod.username ?? 'you'} — "${pod.name}" watches ${repoCountOf(getProvider(pod.providerId).vocabulary, pod.repos?.length ?? 0)}.`,
      );
      await openDashboard();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      void vscode.window.showErrorMessage(`Verdict: ${message}`);
    }
  };

  const signIn = async (): Promise<void> => {
    const options = getSignInOptions(getDebugAuthBypass(context.extensionMode) !== null, listRealProviders());
    let chosen: SignInOption | undefined = options[0];
    if (needsSignInChoice(options)) {
      const picked = await vscode.window.showQuickPick(
        options.map((option) => ({ label: option.label, detail: option.description, option })),
        { title: 'Verdict: sign in', placeHolder: 'Which platform does this pod watch?' },
      );
      if (!picked) return;
      chosen = picked.option;
    }
    if (chosen?.flow === 'debug') {
      await bootstrapFromDebugBypass();
      return;
    }
    OnboardingPanel.show({
      podStore,
      secrets,
      providerId: chosen?.providerId,
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
    ChangesetPanel.refreshIfOpen();
    TuningPanel.refreshIfOpen();
  };

  /**
   * "Verdict: Add project to pod" — accepts a URL, a project id or a group id
   * (naming doc). Group sources store the resolved project ids, never "all",
   * so a project added to the group later cannot silently join the pod.
   */
  const addProject = async (): Promise<void> => {
    const pod = podStore.activePod;
    if (!pod) {
      void vscode.window.showInformationMessage('Verdict: no pod yet — sign in first.');
      return;
    }
    const provider = getProvider(pod.providerId);
    const input = await vscode.window.showInputBox({
      title: `Add a ${provider.vocabulary.repoNoun} to "${pod.name}"`,
      prompt: provider.host.sourceInputHint,
      placeHolder: provider.host.sourceInputPlaceholder,
    });
    if (!input?.trim()) return;
    try {
      const connection = await connectionForPod(pod, secrets);
      const resolved = await connection.resolveSource(input.trim());
      if (resolved.kind === 'noMatch' || resolved.kind === 'notVisible') {
        void vscode.window.showWarningMessage(
          resolved.kind === 'notVisible'
            ? `Verdict: ${resolved.id} is not visible with this pod's token.`
            : `Verdict: nothing matched "${input.trim()}".`,
        );
        return;
      }
      const repositories = resolved.kind === 'group' ? resolved.repositories : [resolved.repo];
      const source: PodSource =
        resolved.kind === 'group'
          ? { kind: 'group', groupId: resolved.group.id, repoIds: repositories.map((r) => r.id) }
          : { kind: 'repository', repoId: resolved.repo.id };
      const known = new Set(repoIdsOf(pod));
      const added = repositories.filter((repo) => !known.has(repo.id));
      if (added.length === 0) {
        void vscode.window.showInformationMessage(
          `Verdict: that ${provider.vocabulary.repoNoun} is already in this pod.`,
        );
        return;
      }
      // A new Pod, not a mutation: `list()` copies the array but not the pods
      // inside it, so editing this object in place would edit the store's
      // cached state behind its back.
      await podStore.upsert({
        ...pod,
        sources: [...pod.sources, source],
        repos: [
          ...(pod.repos ?? []),
          ...added.map((repo) => ({ id: repo.id, path: repo.path, name: repo.name })),
        ],
      });
      sidebar.refresh();
      await DashboardPanel.refreshIfOpen();
      void vscode.window.showInformationMessage(
        `Verdict: added ${added.length === 1 ? added[0]?.path ?? repoCountOf(provider.vocabulary, 1) : repoCountOf(provider.vocabulary, added.length)} to "${pod.name}".`,
      );
    } catch (e) {
      void vscode.window.showErrorMessage(
        `Verdict: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const handlers: Partial<Record<string, () => Promise<void> | void>> = {
    [COMMANDS.openDashboard]: openDashboard,
    [COMMANDS.addProject]: addProject,
    [COMMANDS.openReview]: () => {
      // Naming doc: "Verdict: Open review" is the triage tab for the
      // active MR — or the changeset review when that is what's running.
      if (!ReviewFlowPanel.revealIfOpen() && !ChangesetReviewPanel.revealIfOpen()) {
        void vscode.window.showInformationMessage(
          'Verdict: no active review — open a change request from the dashboard first.',
        );
      }
    },
    [COMMANDS.refresh]: async () => {
      sidebar.refresh();
      await DashboardPanel.refreshIfOpen();
      ChangesetPanel.refreshIfOpen();
      TuningPanel.refreshIfOpen();
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
        // active review panel first — single-CR or changeset, whichever holds
        // the surface.
        if (ReviewFlowPanel.handleCommand(id)) return;
        if (ChangesetReviewPanel.handleCommand(id)) return;
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
      INTERNAL_COMMANDS.postedReviews,
      (focusRef?: { repoId: string; number: string }) =>
        void PostedReviewsPanel.show(postedDeps, focusRef),
    ),
  );

  // The rest of the triage keyboard map (handoff §6: ⇧A, U, 1–4). These
  // are keys, not palette entries, so they stay out of contributes.commands
  // and route to whichever review panel currently holds verdict.reviewFocus.
  for (const id of [
    INTERNAL_COMMANDS.acceptCommentOnly,
    INTERNAL_COMMANDS.undoVerdict,
    INTERNAL_COMMANDS.jumpSeverity,
  ]) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, (arg?: unknown) => {
        if (!ReviewFlowPanel.handleCommand(id, arg)) ChangesetReviewPanel.handleCommand(id, arg);
      }),
    );
  }

  // `?` / the status bar's "? keys" — the keyboard overlay lives in whatever
  // screen the app surface shows (spec §12: "triggered by ? anywhere").
  context.subscriptions.push(
    vscode.commands.registerCommand(INTERNAL_COMMANDS.keyboardHelp, () => {
      if (!AppSurface.postToActive({ type: 'verdict:showKeys' })) {
        void vscode.window.showInformationMessage(
          'Verdict keys — A accept · ⇧A comment-only · R reject · S skip · J/K move · 1–4 severity · U undo. Open any Verdict screen for the full map.',
        );
      }
    }),
    vscode.commands.registerCommand(INTERNAL_COMMANDS.showNotifications, () =>
      void notifier.showPending(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A cadence change re-aims the pending digest flush; per-event modes
      // and quiet hours are read at delivery time and need no push.
      if (event.affectsConfiguration('codeVerdict.notifications.digestCadence')) {
        notifier.center.reschedule();
      }
    }),
    notifier,
  );
  notifier.start();

  // F5 with the debug env vars set (see .vscode/launch.json): skip
  // onboarding entirely and land on a populated dashboard. Fire and
  // forget — activation must not block on network I/O.
  if (getDebugAuthBypass(context.extensionMode)) {
    void bootstrapFromDebugBypass();
  }
}

export function deactivate(): void {}
