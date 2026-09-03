import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EFFORT_LEVEL,
  EFFORT_LEVELS,
  effortForModel,
  normalizeEffortsByModel,
  setEffortForModel,
} from './effort';

describe('thinking effort', () => {
  it('defines the seven levels in product order with exact labels and prompt contributions', () => {
    expect(EFFORT_LEVELS.map(({ id, label, description, promptContribution }) => ({
      id, label, description, promptContribution,
    }))).toEqual([
      { id: 'none', label: 'None', description: 'nothing added', promptContribution: '' },
      { id: 'minimal', label: 'Minimal', description: 'answer directly; do not deliberate', promptContribution: 'answer directly; do not deliberate' },
      { id: 'low', label: 'Low', description: 'brief check before answering', promptContribution: 'brief check before answering' },
      { id: 'medium', label: 'Medium', description: 'reason through the diff before reporting', promptContribution: 'reason through the diff before reporting' },
      { id: 'high', label: 'High', description: 'reason carefully; consider alternatives before reporting', promptContribution: 'reason carefully; consider alternatives before reporting' },
      { id: 'xhigh', label: 'Extra High', description: 'exhaustive reasoning; enumerate and discard alternatives', promptContribution: 'exhaustive reasoning; enumerate and discard alternatives' },
      { id: 'max', label: 'Max', description: 'no reasoning budget; take as long as needed', promptContribution: 'no reasoning budget; take as long as needed' },
    ]);
    expect(EFFORT_LEVELS[0].promptContribution).toBe('');
  });

  it('filters invalid stored entries and defaults them without an error path', () => {
    const stored = { 'lm:a': 'high', 'lm:b': 'retired', 'lm:c': 3, '': 'low' };

    expect(normalizeEffortsByModel(stored)).toEqual({ 'lm:a': 'high' });
    expect(effortForModel(stored, 'lm:a')).toBe('high');
    expect(effortForModel(stored, 'lm:b')).toBe(DEFAULT_EFFORT_LEVEL);
    expect(effortForModel(undefined, 'lm:a')).toBe(DEFAULT_EFFORT_LEVEL);
  });

  it('keeps each model isolated when a level is changed', () => {
    const first = setEffortForModel(undefined, 'lm:a', 'high');
    const second = setEffortForModel(first, 'lm:b', 'minimal');

    expect(effortForModel(second, 'lm:a')).toBe('high');
    expect(effortForModel(second, 'lm:b')).toBe('minimal');
    expect(effortForModel(second, 'lm:c')).toBe('none');
  });
});