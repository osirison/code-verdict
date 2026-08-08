import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PodStore } from '../app/pods';
import type { SubmittedReview } from '../app/reviewHistory';
import type { KeyValueStore } from '../app/storage';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import type { Pod } from '../domain/types';
import { deriveTuningState } from './tuningState';
import { renderTuningHtml } from './tuningHtml';

const handlers = vi.hoisted(() => ({
  message: undefined as ((message: unknown) => void) | undefined,
}));

const panel = vi.hoisted(() => ({
  title: '',
  reveal: vi.fn(),
  webview: {
    html: '',
    onDidReceiveMessage: vi.fn((handler: (message: unknown) => void) => {
      handlers.message = handler;
      return { dispose: vi.fn() };
    }),
  },
  onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
}));

vi.mock('vscode', () => ({
  ViewColumn: { One: 1 },
  window: { createWebviewPanel: vi.fn(() => panel) },
  commands: { executeCommand: vi.fn() },
}));

const history: SubmittedReview[] = [{
  repoId: '9101', crNumber: '2841', podId: 'pod', agentId: 'demo', agentLabel: 'HVE Core · PR Review',
  submittedAt: '2026-08-01T00:00:00Z', counts: { accepted: 2, rejected: 2, skipped: 0, undecided: 0 },
  threads: {}, requestedChanges: true,
  observations: [
    { category: 'security', confidence: 96, verdict: 'accepted', severity: 'major' },
    { category: 'security', confidence: 88, verdict: 'accepted', severity: 'minor' },
    { category: 'tests', confidence: 74, verdict: 'rejected', severity: 'nit' },
    { category: 'tests', confidence: 71, verdict: 'rejected', severity: 'nit' },
  ],
}];

describe('agent tuning fidelity (spec §10)', () => {
  it('derives category, confidence, and generated criteria suggestions from history', () => {
    const state = deriveTuningState(history, DEFAULT_CRITERIA, 'HVE Core · PR Review');
    expect(state.empty).toBe(false);
    expect(state.headline).toBe('50% accepted');
    expect(state.subline).toBe('2 of 4 findings across 1 review in this pod · last 30 days');
    expect(state.categories.find((category) => category.key === 'security')?.rate).toBe(100);
    expect(state.confidence.find((band) => band.label === '90–100')?.accepted).toBe(1);
    expect(state.suggestions.some((suggestion) => suggestion.kind === 'confidence')).toBe(true);
  });

  it('quotes the numbers in every suggestion body', () => {
    const state = deriveTuningState(history, DEFAULT_CRITERIA, 'HVE Core · PR Review');
    const confidence = state.suggestions.find((suggestion) => suggestion.kind === 'confidence');
    expect(confidence?.title).toBe('Raise minimum confidence to 80%');
    expect(confidence?.action).toBe('Set 80% floor');
    expect(confidence?.body).toBe(
      'Below 80% confidence you accepted 0 of 2. At 80% or above you accepted 2 of 2. The floor is currently 70%.',
    );
    const tests = state.suggestions.find((suggestion) => suggestion.id === 'category:tests');
    expect(tests?.body).toBe(
      'Tests produced 2 findings and you accepted 0. That is 2 items of triage for 0 useful ones.',
    );
  });

  it('pluralizes single-count suggestion copy', () => {
    const single: SubmittedReview[] = [{
      ...history[0]!,
      counts: { accepted: 1, rejected: 4, skipped: 0, undecided: 0 },
      observations: [
        { category: 'docs', confidence: 90, verdict: 'accepted', severity: 'minor' },
        { category: 'docs', confidence: 85, verdict: 'rejected', severity: 'minor' },
        { category: 'docs', confidence: 84, verdict: 'rejected', severity: 'minor' },
        { category: 'docs', confidence: 83, verdict: 'rejected', severity: 'minor' },
        { category: 'docs', confidence: 82, verdict: 'rejected', severity: 'minor' },
      ],
    }];
    const criteria = { ...DEFAULT_CRITERIA, categories: ['docs' as const] };
    const docs = deriveTuningState(single, criteria, 'agent').suggestions.find(
      (suggestion) => suggestion.id === 'category:docs',
    );
    expect(docs?.body).toBe(
      'Docs & comments produced 5 findings and you accepted 1. That is 4 items of triage for 1 useful one.',
    );
  });

  it('quotes nit accept rates when the floor is nit, with a generic fallback for old records', () => {
    const criteria = { ...DEFAULT_CRITERIA, severityFloor: 'nit' as const };
    const withSeverity = deriveTuningState(history, criteria, 'agent');
    const nits = withSeverity.suggestions.find((suggestion) => suggestion.kind === 'severity');
    expect(nits?.title).toBe('Stop reporting nits');
    expect(nits?.action).toBe('Raise floor to minor');
    expect(nits?.body).toBe('You accepted 0 of 2 nits — 50% of your triage. Start at minor severity.');

    const legacy = [{
      ...history[0]!,
      observations: history[0]!.observations?.map(({ severity: _severity, ...rest }) => rest),
    }];
    const fallback = deriveTuningState(legacy, criteria, 'agent').suggestions.find(
      (suggestion) => suggestion.kind === 'severity',
    );
    expect(fallback?.body).toBe('Nits add review volume without changing merge decisions. Start at minor severity.');
  });

  it('suggests nothing without observations, whatever the criteria', () => {
    const countsOnly = [{ ...history[0]!, observations: undefined }];
    const state = deriveTuningState(countsOnly, DEFAULT_CRITERIA, 'agent');
    expect(state.headline).toBe('50% accepted');
    expect(state.suggestions).toEqual([]);
  });

  it('renders the explicit empty scorecard when nothing was submitted', () => {
    const state = deriveTuningState([], DEFAULT_CRITERIA, 'No review agent selected');
    expect(state.empty).toBe(true);
    expect(state.headline).toBe('No reviews yet');
    expect(state.suggestions).toEqual([]);
    const html = renderTuningHtml(state, 'nonce123');
    expect(html).toContain('appear after your first submitted review');
    expect(html).not.toContain('Accept rate by category');
    expect(html).not.toContain('Tune the criteria');
  });

  it('renders both charts and criteria actions with a strict CSP', () => {
    const html = renderTuningHtml(
      deriveTuningState(history, DEFAULT_CRITERIA, 'HVE Core · PR Review'),
      'nonce123',
    );
    expect(html).toContain('Accept rate by category');
    expect(html).toContain('Accept rate by agent confidence');
    expect(html).toContain('Tune the criteria');
    expect(html).toContain('Security');
    expect(html).toContain('btn btn-accent');
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'applySuggestion'");
  });

  it('renders applied suggestions as a disabled "✓ applied" button', () => {
    const state = deriveTuningState(history, DEFAULT_CRITERIA, 'agent');
    const applied = state.suggestions.map((suggestion) =>
      suggestion.kind === 'confidence' ? { ...suggestion, applied: true } : suggestion,
    );
    const html = renderTuningHtml({ ...state, suggestions: applied }, 'nonce123');
    expect(html).toContain('✓ applied');
    expect(html).toContain('class="btn applied" disabled');
    expect(html).not.toContain('data-suggestion="confidence:80"');
    expect(html).toContain('data-suggestion="category:tests"');
  });
});

describe('TuningPanel apply flow', () => {
  beforeEach(() => {
    panel.webview.html = '';
  });

  function makeDeps(pods: Pod[], activeId: string, reviews: SubmittedReview[]) {
    const backing = new Map<string, unknown>([['codeVerdict.submittedReviews', reviews]]);
    const globalState: KeyValueStore = {
      get: <T,>(key: string) => backing.get(key) as T | undefined,
      update: async (key: string, value: unknown) => void backing.set(key, value),
    };
    const byId = new Map(pods.map((pod) => [pod.id, pod]));
    const upsert = vi.fn(async (pod: Pod) => void byId.set(pod.id, pod));
    const store = {
      get activePod() { return byId.get(activeId); },
      upsert,
      setActive: async (id: string) => void (activeId = id),
    };
    return { deps: { podStore: store as unknown as PodStore, globalState }, upsert, store };
  }

  function makePod(id: string): Pod {
    return {
      id, name: id, providerId: 'fixture', instanceUrl: 'fixture://demo',
      sources: [], criteria: { ...DEFAULT_CRITERIA, categories: [...DEFAULT_CRITERIA.categories] },
      agentId: 'demo', repos: [], username: 'you',
    } as unknown as Pod;
  }

  it('applies copy-on-write, pins "✓ applied", ignores re-clicks, resets on pod switch', async () => {
    const podA = makePod('pod');
    const podB = makePod('other');
    const recent = [{ ...history[0]!, submittedAt: new Date(Date.now() - 86_400_000).toISOString() }];
    const { deps, upsert, store } = makeDeps([podA, podB], 'pod', recent);
    const { TuningPanel } = await import('./tuning.js');

    TuningPanel.show(deps);
    expect(panel.webview.html).toContain('Set 80% floor');

    handlers.message?.({ type: 'applySuggestion', suggestionId: 'confidence:80' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(upsert).toHaveBeenCalledOnce();
    const upserted = upsert.mock.calls[0]![0]!;
    expect(upserted).not.toBe(podA);
    expect(upserted.criteria.minConfidence).toBe(80);
    expect(podA.criteria.minConfidence).toBe(70);
    expect(panel.webview.html).toContain('✓ applied');
    expect(panel.webview.html).toContain('Raise minimum confidence to 80%');
    // The applied card keeps its place after the still-active one above it.
    const turnOffIndex = panel.webview.html.indexOf('Turn off Tests');
    expect(turnOffIndex).toBeGreaterThan(-1);
    expect(turnOffIndex).toBeLessThan(panel.webview.html.indexOf('✓ applied'));

    handlers.message?.({ type: 'applySuggestion', suggestionId: 'confidence:80' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(upsert).toHaveBeenCalledOnce();

    await store.setActive('other');
    TuningPanel.show(deps);
    expect(panel.webview.html).not.toContain('✓ applied');
    expect(panel.webview.html).toContain('No reviews yet');
  });
});
