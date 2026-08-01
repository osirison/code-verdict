import type { SubmittedReview } from '../app/reviewHistory';
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

export type TuningSuggestion =
  | { id: string; kind: 'category'; category: Category; title: string; body: string; action: string }
  | { id: string; kind: 'confidence'; value: number; title: string; body: string; action: string }
  | { id: string; kind: 'severity'; title: string; body: string; action: string };

export interface TuningViewState {
  agentLabel: string;
  headline: string;
  subline: string;
  categories: TuningRate[];
  confidence: TuningRate[];
  suggestions: TuningSuggestion[];
}

function rate(accepted: number, produced: number): number {
  return produced === 0 ? 0 : Math.round((accepted / produced) * 100);
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
    const accepted = matching.filter((observation) => observation.verdict === 'accepted').length;
    return {
      key: category,
      label: LABELS[category],
      accepted,
      produced: matching.length,
      rate: rate(accepted, matching.length),
      enabled: criteria.categories.includes(category),
    };
  }).sort((left, right) => right.rate - left.rate || right.produced - left.produced);
  const bands = [
    { key: '90', label: '90–100', min: 90, max: 100 },
    { key: '80', label: '80–89', min: 80, max: 89 },
    { key: '70', label: '70–79', min: 70, max: 79 },
    { key: 'below', label: 'below 70', min: 0, max: 69 },
  ];
  const confidence = bands.map((band) => {
    const matching = observations.filter((observation) => observation.confidence >= band.min && observation.confidence <= band.max);
    const accepted = matching.filter((observation) => observation.verdict === 'accepted').length;
    return { key: band.key, label: band.label, accepted, produced: matching.length, rate: rate(accepted, matching.length) };
  });
  const suggestions: TuningSuggestion[] = categories
    .filter((category) => category.enabled && category.produced > 0 && category.rate < 25)
    .map((category) => ({
      id: `category:${category.key}`,
      kind: 'category' as const,
      category: category.key as Category,
      title: `Turn off ${category.label}`,
      body: `${category.label} produced ${category.produced} findings and you accepted ${category.accepted}. That is ${category.produced - category.accepted} items of triage for ${category.accepted} useful ones.`,
      action: 'Turn off',
    }));
  if (criteria.minConfidence < 80) {
    suggestions.push({
      id: 'confidence:80', kind: 'confidence', value: 80, title: 'Raise confidence to 80%',
      body: 'Lower-confidence findings create more triage than accepted feedback. Start the next run at 80%.', action: 'Raise floor',
    });
  }
  if (criteria.severityFloor === 'nit') {
    suggestions.push({
      id: 'severity:minor', kind: 'severity', title: 'Stop reporting nits',
      body: 'Nits add review volume without changing merge decisions. Start at minor severity.', action: 'Use minor',
    });
  }
  return {
    agentLabel,
    headline: `${rate(totalAccepted, totalProduced)}% accepted`,
    subline: `${totalAccepted} of ${totalProduced} findings across ${history.length} reviews in this pod · last 30 days`,
    categories,
    confidence,
    suggestions,
  };
}