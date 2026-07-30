import { describe, expect, it } from 'vitest';
import type { Criteria } from './criteria';
import { filterReason, meetsCriteria, severityAtLeast } from './criteria';

const criteria: Criteria = {
  severityFloor: 'minor',
  categories: ['security', 'concurrency', 'errorHandling', 'performance', 'craftsmanship', 'tests'],
  minConfidence: 70,
  extraInstructions: '',
};

describe('criteria filtering', () => {
  it('orders severities nit < minor < major < blocker', () => {
    expect(severityAtLeast('blocker', 'minor')).toBe(true);
    expect(severityAtLeast('minor', 'minor')).toBe(true);
    expect(severityAtLeast('nit', 'minor')).toBe(false);
  });

  it('reproduces the fixture candidate buckets', () => {
    // "4 nits below the severity floor"
    expect(filterReason({ severity: 'nit', category: 'style', confidence: 62 }, criteria)).toBe(
      'belowSeverityFloor',
    );
    // "19 observations below 70% confidence"
    expect(
      filterReason({ severity: 'minor', category: 'concurrency', confidence: 51 }, criteria),
    ).toBe('belowConfidence');
  });

  it('rejects categories that are switched off', () => {
    expect(filterReason({ severity: 'major', category: 'style', confidence: 95 }, criteria)).toBe(
      'categoryOff',
    );
  });

  it('passes an item meeting all three gates', () => {
    expect(meetsCriteria({ severity: 'blocker', category: 'security', confidence: 96 }, criteria)).toBe(
      true,
    );
  });
});
