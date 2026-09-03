import { describe, expect, it } from 'vitest';
import type { ReviewItem } from '../domain/types';
import { findingFollowUpPrompt, followUpQuestion } from './findingFollowUp';

const item: ReviewItem = {
  id: 'finding', file: 'src/a.ts', anchored: true, line: 4, severity: 'major', category: 'security',
  confidence: 91, title: 'Unsafe fallback', body: 'The fallback skips validation.', code: 'return raw;',
};

describe('finding follow-ups', () => {
  it('uses the same concrete preset questions on every review surface', () => {
    expect(followUpQuestion('explain')).toContain('concrete risk');
    expect(followUpQuestion('freeform', '  Is this reachable?  ')).toBe('Is this reachable?');
  });

  it('builds the bounded prose prompt with finding and optional diff evidence', () => {
    const prompt = findingFollowUpPrompt(item, 'Is this reachable?', '@@ -3 +3 @@\n+return raw;');

    expect(prompt).toContain('Finding: Unsafe fallback');
    expect(prompt).toContain('Location: src/a.ts:4');
    expect(prompt).toContain('Surrounding diff:');
    expect(prompt).toContain('Question: Is this reachable?');
  });
});