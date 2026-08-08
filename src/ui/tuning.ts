import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { PodStore } from '../app/pods';
import { ReviewHistory } from '../app/reviewHistory';
import type { KeyValueStore } from '../app/storage';
import { renderTuningHtml, type TuningMessage } from './tuningHtml';
import { deriveTuningState, type TuningSuggestion } from './tuningState';
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

  /** Repaint after the active pod (or its history) changes elsewhere — same contract as DashboardPanel. */
  static refreshIfOpen(): void {
    TuningPanel.current?.render();
  }

  private disposed = false;
  /**
   * Applied suggestions, snapshotted at apply time: once the criteria change,
   * re-derivation no longer produces the suggestion, but its card must stay
   * visible reading "✓ applied" (spec §10). Session-scoped on purpose — a
   * fresh panel derives from the criteria as they now are.
   */
  private applied = new Map<string, TuningSuggestion>();
  /** Ids in last-rendered order, so a card keeps its place when it flips to applied. */
  private order: string[] = [];
  private podId: string | undefined;

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
    if (pod.id !== this.podId) {
      this.podId = pod.id;
      this.applied.clear();
      this.order = [];
    }
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const history = new ReviewHistory(this.deps.globalState).list().filter(
      (review) => review.podId === pod.id && Date.parse(review.submittedAt) >= cutoff,
    );
    const agentLabel = (history.at(-1)?.agentLabel ?? pod.agentId) || 'No review agent selected';
    return { pod, view: deriveTuningState(history, pod.criteria, agentLabel) };
  }

  /** Live suggestions plus applied snapshots, each holding its last-rendered position. */
  private mergeSuggestions(derived: readonly TuningSuggestion[]): TuningSuggestion[] {
    const merged = [
      ...derived.filter((suggestion) => !this.applied.has(suggestion.id)),
      ...[...this.applied.values()].map((suggestion) => ({ ...suggestion, applied: true })),
    ];
    const arrival = new Map(merged.map((suggestion, index) => [suggestion.id, index]));
    const position = (suggestion: TuningSuggestion): number => {
      const index = this.order.indexOf(suggestion.id);
      return index >= 0 ? index : this.order.length + (arrival.get(suggestion.id) ?? 0);
    };
    merged.sort((left, right) => position(left) - position(right));
    this.order = merged.map((suggestion) => suggestion.id);
    return merged;
  }

  private render(): void {
    if (this.disposed) return;
    const state = this.state();
    if (!state) return;
    const view = { ...state.view, suggestions: this.mergeSuggestions(state.view.suggestions) };
    this.panel.webview.html = renderTuningHtml(view, crypto.randomBytes(16).toString('hex'));
  }

  private async onMessage(message: TuningMessage): Promise<void> {
    if (this.applied.has(message.suggestionId)) return;
    // Capture before state() — it re-targets this.podId when the active pod
    // changed under an open panel. Suggestion ids are pod-independent, so a
    // click rendered against pod A must never tune pod B: repaint instead.
    const renderedPodId = this.podId;
    const state = this.state();
    if (!state) return;
    if (state.pod.id !== renderedPodId) {
      this.render();
      return;
    }
    const suggestion = state.view.suggestions.find((candidate) => candidate.id === message.suggestionId);
    if (!suggestion) {
      this.render();
      return;
    }
    const criteria = { ...state.pod.criteria, categories: [...state.pod.criteria.categories] };
    if (suggestion.kind === 'category') {
      criteria.categories = criteria.categories.filter((category) => category !== suggestion.category);
    } else if (suggestion.kind === 'confidence') {
      criteria.minConfidence = suggestion.value;
    } else {
      criteria.severityFloor = 'minor';
    }
    await this.deps.podStore.upsert({ ...state.pod, criteria });
    this.applied.set(suggestion.id, suggestion);
    this.render();
  }
}
