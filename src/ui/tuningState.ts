import type { SubmittedObservation, SubmittedReview } from '../app/reviewHistory';
import type { Criteria } from '../domain/criteria';
import { ALL_CATEGORIES, type Category } from '../domain/types';

const LABELS: Record<Category, string> = {
  security: 'Security', concurrency: 'Concurrency', errorHandling: 'Error handling',
  performance: 'Performance', craftsmanship: 'Craftsmanship', apiContract: 'API contract',
  tests: 'Tests', docs: 'Docs & comments', style: 'Style',
};

export interface TuningRate {
  key: string;
  label: string;
  accepted: number;
  produced: number;
  rate: number;
  enabled?: boolean;
}

interface TuningSuggestionBase {
  id: string;
  title: string;
  body: string;
  action: string;
  /** Set by the panel, never by derivation — an applied card stays visible with a disabled "✓ applied" button. */
  applied?: boolean;
}

export type TuningSuggestion =
  | (TuningSuggestionBase & { kind: 'category'; category: Category })
  | (TuningSuggestionBase & { kind: 'confidence'; value: number })
  | (TuningSuggestionBase & { kind: 'severity' });

export interface TuningViewState {
  agentLabel: string;
  headline: string;
  subline: string;
  /** Nothing submitted in the window — render the explicit empty scorecard instead of 0-of-0 charts. */
  empty: boolean;
  /** False for histories whose records predate per-finding observations — "no evidence", not "all healthy". */
  hasObservations: boolean;
  categories: TuningRate[];
  confidence: TuningRate[];
  suggestions: TuningSuggestion[];
}

function rate(accepted: number, produced: number): number {
  return produced === 0 ? 0 : Math.round((accepted / produced) * 100);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function acceptedCount(observations: readonly SubmittedObservation[]): number {
  return observations.filter((observation) => observation.verdict === 'accepted').length;
}

function deriveSuggestions(
  observations: readonly SubmittedObservation[],
  categories: readonly TuningRate[],
  criteria: Criteria,
): TuningSuggestion[] {
  // Every suggestion quotes the history it derives from — with no observations
  // there is no evidence to change anything, however the criteria are set.
  if (observations.length === 0) return [];
  const suggestions: TuningSuggestion[] = categories
    .filter((category) => category.enabled && category.produced > 0 && category.rate < 25)
    .map((category) => ({
      id: `category:${category.key}`,
      kind: 'category' as const,
      category: category.key as Category,
      title: `Turn off ${category.label}`,
      body: `${category.label} produced ${plural(category.produced, 'finding')} and you accepted ${category.accepted}. That is ${plural(category.produced - category.accepted, 'item')} of triage for ${category.accepted} useful one${category.accepted === 1 ? '' : 's'}.`,
      action: `Turn off ${category.label}`,
    }));
  if (criteria.minConfidence < 80) {
    const below = observations.filter((observation) => observation.confidence < 80);
    const above = observations.filter((observation) => observation.confidence >= 80);
    const parts = [
      below.length > 0 ? `Below 80% confidence you accepted ${acceptedCount(below)} of ${below.length}.` : '',
      above.length > 0 ? `At 80% or above you accepted ${acceptedCount(above)} of ${above.length}.` : '',
      `The floor is currently ${criteria.minConfidence}%.`,
    ];
    suggestions.push({
      id: 'confidence:80', kind: 'confidence', value: 80,
      title: 'Raise minimum confidence to 80%',
      body: parts.filter(Boolean).join(' '),
      action: 'Set 80% floor',
    });
  }
  if (criteria.severityFloor === 'nit') {
    // Share of triage over severity-bearing records only — legacy observations
    // without the field can never be nits, so counting them dilutes the share.
    const withSeverity = observations.filter((observation) => observation.severity !== undefined);
    const nits = withSeverity.filter((observation) => observation.severity === 'nit');
    const share = rate(nits.length, withSeverity.length);
    suggestions.push({
      id: 'severity:minor', kind: 'severity',
      title: 'Stop reporting nits',
      body: nits.length > 0
        ? `You accepted ${acceptedCount(nits)} of ${plural(nits.length, 'nit')}${share > 0 ? ` — ${share}% of your triage` : ''}. Start at minor severity.`
        : 'Nits add review volume without changing merge decisions. Start at minor severity.',
      action: 'Raise floor to minor',
    });
  }
  return suggestions;
}

export function deriveTuningState(
  history: readonly SubmittedReview[],
  criteria: Criteria,
  agentLabel: string,
): TuningViewState {
  const observations = history.flatMap((review) => review.observations ?? []);
  const totalProduced = history.reduce((sum, review) => sum + review.counts.accepted + review.counts.rejected + review.counts.skipped, 0);
  const totalAccepted = history.reduce((sum, review) => sum + review.counts.accepted, 0);
  const categories = ALL_CATEGORIES.map((category) => {
    const matching = observations.filter((observation) => observation.category === category);
    const accepted = acceptedCount(matching);
    return {
      key: category,
      label: LABELS[category],
      accepted,
      produced: matching.length,
      rate: rate(accepted, matching.length),
      enabled: criteria.categories.includes(category),
    };
  }).sort((left, right) => right.rate - left.rate || right.produced - left.produced);
  // Half-open bands: the validator allows any finite confidence in [0,100],
  // so closed integer ranges would drop fractional values like 89.5 entirely.
  const bands = [
    { key: '90', label: '90–100', min: 90, max: Infinity },
    { key: '80', label: '80–89', min: 80, max: 90 },
    { key: '70', label: '70–79', min: 70, max: 80 },
    { key: 'below', label: 'below 70', min: -Infinity, max: 70 },
  ];
  const confidence = bands.map((band) => {
    const matching = observations.filter((observation) => observation.confidence >= band.min && observation.confidence < band.max);
    const accepted = acceptedCount(matching);
    return { key: band.key, label: band.label, accepted, produced: matching.length, rate: rate(accepted, matching.length) };
  });
  const empty = history.length === 0;
  return {
    agentLabel,
    headline: empty ? 'No reviews yet' : `${rate(totalAccepted, totalProduced)}% accepted`,
    subline: empty
      ? 'Nothing has been submitted from this pod in the last 30 days.'
      : `${totalAccepted} of ${plural(totalProduced, 'finding')} across ${plural(history.length, 'review')} in this pod · last 30 days`,
    empty,
    hasObservations: observations.length > 0,
    categories,
    confidence,
    suggestions: deriveSuggestions(observations, categories, criteria),
  };
}
