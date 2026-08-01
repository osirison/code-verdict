import { describe, expect, it } from 'vitest';
import type { SubmittedReview } from '../app/reviewHistory';
import { DEFAULT_CRITERIA } from '../domain/criteria';
import { deriveTuningState } from './tuningState';
import { renderTuningHtml } from './tuningHtml';

const history: SubmittedReview[] = [{
  repoId: '9101', crNumber: '2841', podId: 'pod', agentId: 'demo', agentLabel: 'HVE Core · PR Review',
  submittedAt: '2026-08-01T00:00:00Z', counts: { accepted: 2, rejected: 2, skipped: 0, undecided: 0 },
  threads: {}, requestedChanges: true,
  observations: [
    { category: 'security', confidence: 96, verdict: 'accepted' },
    { category: 'security', confidence: 88, verdict: 'accepted' },
    { category: 'style', confidence: 74, verdict: 'rejected' },
    { category: 'style', confidence: 71, verdict: 'rejected' },
  ],
}];

describe('agent tuning fidelity (spec §10)', () => {
  it('derives category, confidence, and generated criteria suggestions from history', () => {
    const state = deriveTuningState(history, DEFAULT_CRITERIA, 'HVE Core · PR Review');
    expect(state.headline).toBe('50% accepted');
    expect(state.categories.find((category) => category.key === 'security')?.rate).toBe(100);
    expect(state.confidence.find((band) => band.label === '90–100')?.accepted).toBe(1);
    expect(state.suggestions.some((suggestion) => suggestion.kind === 'confidence')).toBe(true);
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
    expect(html).toContain(`script-src 'nonce-nonce123'`);
    expect(html).toContain("type: 'applySuggestion'");
  });
});