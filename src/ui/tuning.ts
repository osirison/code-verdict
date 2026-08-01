import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore } from '../app/storage';
import type { Category } from '../domain/types';
import { renderTuningHtml, type TuningMessage } from './tuningHtml';
import { deriveTuningState } from './tuningState';
import { AppSurface, type AppRoute } from './appSurface';
import { COMMANDS } from '../commands';

export interface TuningPanelDeps {
  podStore: PodStore;
  globalState: KeyValueStore;
}

export class TuningPanel {
  private static current: TuningPanel | undefined;

  static show(deps: TuningPanelDeps): void {
    if (TuningPanel.current) {
      AppSurface.reveal();
      TuningPanel.current.render();
      return;
    }
    const route = AppSurface.show('tuning', 'Verdict: Agent tuning', () => void vscode.commands.executeCommand(COMMANDS.openDashboard));
    TuningPanel.current = new TuningPanel(route, deps);
    TuningPanel.current.render();
  }

  private disposed = false;

  private constructor(
    private readonly route: AppRoute,
    private readonly deps: TuningPanelDeps,
  ) {
    route.onLeave(() => {
      this.disposed = true;
      if (TuningPanel.current === this) TuningPanel.current = undefined;
    });
    route.onMessage((message) => void this.onMessage(message as TuningMessage));
  }

  private get panel(): vscode.WebviewPanel { return this.route.panel; }

  private state() {
    const pod = this.deps.podStore.activePod;
    if (!pod) return undefined;
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const history = new ReviewHistory(this.deps.globalState).list().filter(
      (review) => review.podId === pod.id && Date.parse(review.submittedAt) >= cutoff,
    );
    const agentLabel = (history.at(-1)?.agentLabel ?? pod.agentId) || 'No review agent selected';
    return { pod, view: deriveTuningState(history, pod.criteria, agentLabel) };
  }

  private render(): void {
    if (this.disposed) return;
    const state = this.state();
    if (!state) return;
    this.panel.webview.html = renderTuningHtml(state.view, crypto.randomBytes(16).toString('hex'));
  }

  private async onMessage(message: TuningMessage): Promise<void> {
    const state = this.state();
    if (!state) return;
    const suggestion = state.view.suggestions.find((candidate) => candidate.id === message.suggestionId);
    if (!suggestion) return;
    if (suggestion.kind === 'category') {
      state.pod.criteria.categories = state.pod.criteria.categories.filter(
        (category: Category) => category !== suggestion.category,
      );
    } else if (suggestion.kind === 'confidence') {
      state.pod.criteria.minConfidence = suggestion.value;
    } else {
      state.pod.criteria.severityFloor = 'minor';
    }
    await this.deps.podStore.upsert(state.pod);
    this.render();
  }
}