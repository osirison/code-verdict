import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore } from '../app/storage';
import type { Category } from '../domain/types';
import { renderTuningHtml, type TuningMessage } from './tuningHtml';
import { deriveTuningState } from './tuningState';

export interface TuningPanelDeps {
  podStore: PodStore;
  globalState: KeyValueStore;
}

export class TuningPanel {
  private static current: TuningPanel | undefined;

  static show(deps: TuningPanelDeps): void {
    if (TuningPanel.current) {
      TuningPanel.current.panel.reveal();
      TuningPanel.current.render();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codeVerdict.tuning',
      'Verdict: Agent tuning',
      vscode.ViewColumn.One,
      { enableScripts: true },
    );
    TuningPanel.current = new TuningPanel(panel, deps);
    TuningPanel.current.render();
  }

  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: TuningPanelDeps,
  ) {
    panel.onDidDispose(() => {
      this.disposed = true;
      if (TuningPanel.current === this) TuningPanel.current = undefined;
    });
    panel.webview.onDidReceiveMessage((message: TuningMessage) => void this.onMessage(message));
  }

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