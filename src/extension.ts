import * as vscode from 'vscode';
import { ALL_COMMAND_IDS, COMMANDS, INTERNAL_COMMANDS } from './commands';
import { AppStore } from './app/appStore';
import { detectChangesets } from './app/changesets';
import { runDebugBootstrap } from './app/debugBootstrap';
import { ManualChangesetStore } from './app/manualChangesets';
import { PodStore } from './app/pods';
import { connectionForPod } from './app/connections';
import { deleteTokenIfUnused } from './app/storage';
import { repoIdsOf } from './app/podQuery';
import type { PodSource } from './domain/types';
import { getProvider, listRealProviders, tryGetProvider } from './platform/registry';
import { repoCountOf } from './ui/vocab';
import { ReviewHistory } from './app/reviewHistory';
import { ReviewRunStore } from './app/reviewRuns';
import { ReviewRunManager, sweepInterruptedRuns, type RunInput, type RunnerOptions } from './app/reviewRunManager';
import { pruneClosedRetained } from './app/retainedReview';
import { runDemoAgent } from './app/demoAgent';
import { runDemoChangesetAgent } from './app/combinedAgent';
import { runLmAgent, runLmChangesetAgent } from './app/lmAgent';
import { getDebugAuthBypass } from './debugAuth';
import { setSessionProvider } from './app/connections';
import { setApiTraceSink } from './app/apiTrace';
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
import { readPollIntervalSeconds, VerdictNotifier } from './ui/notifier';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerBuiltInProviders();

  // `registerBuiltInProviders` built the providers over a traced fetch; this
  // is where those lines go. The channel is created whether or not tracing is
  // on, so "Verdict: Show API trace" always has something to reveal — the
  // setting switches the sink, and with no sink the wrapper is inert.
  const apiTraceChannel = vscode.window.createOutputChannel('Verdict: API');
  const apiTracingEnabled = (): boolean =>
    vscode.workspace.getConfiguration('codeVerdict').get<boolean>('trace.api', false);
  const applyApiTraceSetting = (): void => {
    setApiTraceSink(apiTracingEnabled() ? apiTraceChannel : undefined);
  };
  applyApiTraceSetting();
  context.subscriptions.push(
    apiTraceChannel,
    // The sink is module state in `apiTrace.ts` and outlives the channel it
    // points at; drop it with the channel rather than leave a disposed one wired.
    new vscode.Disposable(() => setApiTraceSink(undefined)),
  );

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
  const reviewRuns = new ReviewRunStore(context.globalState);

  /**
   * One shared, freshness-tracked copy of each pod's platform data (design
   * D1–D5). Every screen reads this instead of fetching its own copy, and the
   * notifier's poll drives its revalidation. The poll-interval setting is
   * injected as a read so the store stays `vscode`-free and picks up a
   * changed setting on the next freshness check, not the next window.
   */
  const appStore = new AppStore({
    podStore,
    secrets,
    reviewHistory,
    baseSeconds: () => readPollIntervalSeconds(),
  });

  // Before anything paints. A `vscode.lm` stream cannot be reattached after the
  // extension host stops, so whatever was running when the last window closed is
  // gone; recording it as interrupted is how the change request avoids reading
  // exactly as it would have if no review had ever been started on it.
  void sweepInterruptedRuns(context.globalState);

  /**
   * The last status seen per run, so a progress emission — four a second on a
   * streaming run — cannot be mistaken for a state change.
   */
  const lastRunStatus = new Map<string, string>();

  /**
   * Runs live here, for the window's lifetime — not on the panel that started
   * them. Constructed before any panel so a review triggered from one screen is
   * still running when the reviewer is on another.
   */
  const runManager = new ReviewRunManager({
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    runners: {
      lm: (input: RunInput, options: RunnerOptions) =>
        input.target.kind === 'cr'
          ? runLmAgent(
              input.agent,
              input.modelId ?? '',
              input.target.diff,
              input.criteria,
              input.target.reviewContext,
              options,
            )
          : runLmChangesetAgent(input.agent, input.modelId ?? '', input.target.members, input.criteria, options),
      demo: (input: RunInput) =>
        input.target.kind === 'cr'
          ? runDemoAgent(input.target.diff, input.criteria)
          : runDemoChangesetAgent(
              input.target.members,
              input.criteria,
              tryGetProvider(podStore.list().find((pod) => pod.id === input.podId)?.providerId ?? '')?.vocabulary,
            ),
    },
    onChange: (record) => {
      // The run list and the status-bar count read live run state, so one
      // fan-out keeps them from drifting apart. Both are cheap: local state,
      // rendered into a webview.
      const active = runManager.active();
      sidebar.setActiveRuns(
        active.map((run) => ({
          key: run.key,
          label: run.input.refLabel,
          state: run.status === 'queued' ? ('queued' as const) : ('running' as const),
          elapsedMs: Date.now() - (run.startedAt ?? run.queuedAt),
        })),
      );
      statusBar.setActiveRuns(active.filter((run) => run.status === 'running').length);

      // The dashboard is NOT cheap: `refreshIfOpen` refetches the whole pod.
      // Progress arrives at the 250 ms floor, so refreshing on every emission
      // would issue four platform fetches a second per streaming run — worse
      // than the burst the notifier's focus throttle exists to prevent. Only a
      // status change moves a row's pill, so only a status change refreshes.
      const previous = lastRunStatus.get(record.key);
      if (previous === record.status) return;
      lastRunStatus.set(record.key, record.status);
      if (record.status !== 'queued' && record.status !== 'running') lastRunStatus.delete(record.key);
      void DashboardPanel.refreshIfOpen();
    },
    onRunRecorded: () => repaintReviewSurfaces(),
    onReviewReady: (info) => notifier.reviewReady(info),
  });

  const changesetOptions = () => changesetDetectionOptions(context.globalState, podStore.activePod?.id);

  /**
   * Every surface that reads review state, repainted. A submit and a finished
   * run are different events (a clean run posts nothing), but both change
   * exactly these four views, so they share one fan-out rather than drifting.
   *
   * What this fan-out no longer does is fetch (task 6.4): pod data reaches
   * every surface through its own `appStore` subscription, so these calls
   * repaint from the held copy — one shared revalidation at most, where each
   * used to issue its own pod fetch. The fan-out itself must stay, because
   * the events it carries are local — run records and review history — and
   * the store holds pod platform data only, so it can never announce them.
   */
  const repaintReviewSurfaces = (): void => {
    sidebar.refresh();
    void DashboardPanel.refreshIfOpen();
    ChangesetPanel.refreshIfOpen();
    TuningPanel.refreshIfOpen();
  };

  /** One shared pod read → the detected changesets, with the current settings applied. */
  const detectForActivePod = async () => {
    const pod = podStore.activePod;
    if (!pod) return [];
    const read = appStore.read(pod);
    const data = read.data ?? (await read.fetch!);
    return detectChangesets(pod, data.changeRequests, data.workItems, changesetOptions());
  };

  const flowDeps = {
    podStore,
    secrets,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    runs: runManager,
    onSubmitted: () => repaintReviewSurfaces(),
    onSidebarState: (state?: SidebarActiveReview) => {
      sidebar.setActiveReview(state);
      statusBar.setActiveReview(state);
    },
    onSidebarPending: (state?: SidebarPendingReview) => sidebar.setPendingReview(state),
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
    appStore,
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
    appStore,
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
    cancelRun: (key) => runManager.cancel(key),
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
    appStore,
    secrets,
    workspaceState: context.workspaceState,
    globalState: context.globalState,
    runs: runManager,
    openSingle: (ref: { repoId: string; number: string }) => void ReviewFlowPanel.open(flowDeps, ref),
    openDashboard: () => void openDashboard(),
    onSubmitted: () => repaintReviewSurfaces(),
    onSidebarState: (state?: SidebarActiveReview) => {
      sidebar.setActiveReview(state);
      statusBar.setActiveReview(state);
    },
  };

  const changesetPanelDeps = {
    podStore,
    appStore,
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
      const read = appStore.read(pod);
      const data = read.data ?? (await read.fetch!);
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
    reviewRuns: () => reviewRuns.byRef(),
    activeRuns: () =>
      new Map(
        runManager
          .active()
          .map((record) => [record.key, record.status === 'queued' ? ('queued' as const) : ('running' as const)]),
      ),
    onPodChanged: () => sidebar.refresh(),
    pruneRetained: (repoIds, openRefs) =>
      void pruneClosedRetained(context.workspaceState, repoIds, openRefs),
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
    await DashboardPanel.show(podStore, appStore, dashboardDeps);
  };

  /**
   * What is running, and a way to stop one. A quick pick rather than a screen:
   * the reviewer reaches this from the status bar while working on something
   * else, and the whole question is "what is going, and do I still want it".
   */
  const showActiveRuns = async (): Promise<void> => {
    const active = runManager.active();
    if (active.length === 0) {
      void vscode.window.showInformationMessage('Verdict: no reviews are running.');
      return;
    }
    const picked = await vscode.window.showQuickPick(
      active.map((record) => ({
        label: record.input.refLabel,
        description: record.status === 'queued'
          ? 'queued — waiting for a free slot'
          : `running for ${Math.round((Date.now() - (record.startedAt ?? record.queuedAt)) / 1000)}s`,
        detail: record.input.agentLabel,
        key: record.key,
      })),
      { title: 'Verdict: reviews running', placeHolder: 'Pick one to cancel it' },
    );
    if (picked) runManager.cancel(picked.key);
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
   * "Verdict: Delete pod". `podId` arrives from the sidebar's per-row control;
   * from the palette it is absent and the pod is picked here. The dispatch
   * loop types every handler as `() => …`, so the parameter is invisible to
   * that Record — `executeCommand` still forwards it at runtime.
   */
  const deletePod = async (podId?: string): Promise<void> => {
    const pods = podStore.list();
    if (pods.length === 0) {
      void vscode.window.showInformationMessage('Verdict: no pods to delete.');
      return;
    }
    let chosenId = podId;
    if (chosenId === undefined) {
      const picked = await vscode.window.showQuickPick(
        pods.map((p) => ({ label: p.name, description: p.instanceUrl, id: p.id })),
        { placeHolder: 'Delete pod' },
      );
      if (!picked) return;
      chosenId = picked.id;
    }
    const target = pods.find((p) => p.id === chosenId);
    // A sidebar row can outlive its pod by one repaint — deleting twice is a
    // no-op here rather than a confirmation prompt for nothing.
    if (!target) return;

    // Modal: this destroys local state and the token behind it, and a toast
    // that can be missed is not consent.
    const confirmed = await vscode.window.showWarningMessage(
      `Delete the pod "${target.name}"? Its saved changeset groups go with it. Reviews you already submitted stay in your history.`,
      { modal: true },
      'Delete',
    );
    if (confirmed !== 'Delete') return;

    // Its runs have nowhere to land: the pod that named the target is gone.
    // A pod *switch* deliberately does not do this — a run keeps the pod it was
    // triggered under, which is what the snapshot in `RunInput` is for.
    runManager.cancelForPod(target.id);
    await podStore.remove(target.id);
    // Drop the store's held copy now (task 5.5). The store bounds its entries
    // to PodStore on access, but with no pod left nothing below would ever
    // read it again — and the demo and debug pods are re-created under fixed
    // ids, which must start empty, never on a deleted pod's data.
    appStore.forget(target.id);
    // Keyed by pod id and naming repositories only that pod resolved: orphaned
    // the moment it goes.
    await new ManualChangesetStore(context.globalState).removePod(target.id);
    // Tokens are keyed provider + host, never per pod (storage.ts), so this
    // drops the secret only when no surviving pod reads the same one.
    await deleteTokenIfUnused(secrets, target, podStore.list());
    // Review history is deliberately KEPT. Those entries record reviews
    // actually posted to the platform — they outlive a local pod, they still
    // back the posted-review screen and the tuning scorecard, and deleting a
    // pod must not rewrite what the team can already see on the server.

    sidebar.refresh();
    await DashboardPanel.refreshIfOpen();
    ChangesetPanel.refreshIfOpen();
    TuningPanel.refreshIfOpen();
    void vscode.window.showInformationMessage(
      podStore.list().length === 0
        ? `Verdict: deleted "${target.name}". No pods left — run "Verdict: Sign in" to make one.`
        : `Verdict: deleted "${target.name}".`,
    );
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
    [COMMANDS.deletePod]: deletePod,
    [COMMANDS.editCriteria]: () => SettingsPanel.show({ podStore, secrets }),
    [COMMANDS.selectAgent]: () => TuningPanel.show({ podStore, globalState: context.globalState }),
    [COMMANDS.showApiTrace]: () => {
      // `true` keeps focus where it was: this is a diagnostic to glance at,
      // usually while something else is failing.
      apiTraceChannel.show(true);
      if (!apiTracingEnabled()) {
        void vscode.window.showInformationMessage(
          'Verdict: API tracing is off — switch on "codeVerdict.trace.api" and the next request appears here.',
        );
      }
    },
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

  // Not in the palette (the naming doc's 21 commands reserve openReview
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
    vscode.commands.registerCommand(INTERNAL_COMMANDS.cancelRun, (key?: string) => {
      if (typeof key === 'string') runManager.cancel(key);
    }),
    // The status bar's running-review segment: list what is in flight, and let
    // one be cancelled from the pick. Reachable with no Verdict screen open,
    // which is the state a background run is most likely to be in.
    vscode.commands.registerCommand(INTERNAL_COMMANDS.showActiveRuns, () => void showActiveRuns()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A cadence change re-aims the pending digest flush; per-event modes
      // and quiet hours are read at delivery time and need no push.
      if (event.affectsConfiguration('codeVerdict.notifications.digestCadence')) {
        notifier.center.reschedule();
      }
      // Toggling tracing takes effect on the next request, not the next
      // window: the wrapper reads the sink per call.
      if (event.affectsConfiguration('codeVerdict.trace.api')) applyApiTraceSetting();
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
