import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTACHMENT_TRUNCATION_MARKER, budgetAttachments, DEFAULT_CONTEXT_BUDGETS } from '../app/reviewContext';

const settings = vi.hoisted(() => ({ values: {} as Record<string, unknown> }));

vi.mock('vscode', () => ({
  workspace: {
    getConfiguration: () => ({ get: (key: string) => settings.values[key] }),
  },
}));

import { normalizeContextBudgets, readContextBudgets, readContextUsageEnabled } from './contextOptions';
import {
  contextSourceEnabledByDefault,
  DEFAULT_CONTEXT_SOURCE_DEFAULTS,
  normalizeContextSourceDefaults,
  readContextSourceDefaults,
} from './contextOptions';

describe('context budget settings', () => {
  beforeEach(() => {
    settings.values = {};
  });

  it('falls back for absent values', () => {
    expect(readContextBudgets()).toEqual(DEFAULT_CONTEXT_BUDGETS);
  });

  it('falls back for negative, non-numeric, non-finite, and zero values', () => {
    expect(normalizeContextBudgets({
      sectionBudget: -1,
      totalBudget: '12000',
      maxLinkedItems: Number.NaN,
    })).toEqual(DEFAULT_CONTEXT_BUDGETS);
    expect(normalizeContextBudgets({ sectionBudget: 0, totalBudget: Number.POSITIVE_INFINITY })).toEqual(
      DEFAULT_CONTEXT_BUDGETS,
    );
  });

  it('reads positive configured values as whole character and item counts', () => {
    settings.values = {
      'context.sectionBudget': 8_000.9,
      'context.totalBudget': 20_000,
      'context.maxLinkedItems': 9.8,
    };
    expect(readContextBudgets()).toEqual({ sectionBudget: 8_000, totalBudget: 20_000, maxLinkedItems: 9 });
  });

  it('includes every auto-derived source by default and honours explicit exclusions', () => {
    expect(readContextSourceDefaults()).toEqual(DEFAULT_CONTEXT_SOURCE_DEFAULTS);
    settings.values = {
      'context.includeTitle': false,
      'context.includeDescription': false,
      'context.includeLinkedItems': false,
    };
    const defaults = readContextSourceDefaults();
    expect(defaults).toEqual({ includeTitle: false, includeDescription: false, includeLinkedItems: false });
    expect(contextSourceEnabledByDefault('title', defaults)).toBe(false);
    expect(contextSourceEnabledByDefault('description', defaults)).toBe(false);
    expect(contextSourceEnabledByDefault('linkedItem', defaults)).toBe(false);
  });

  it('falls back when an auto-context or usage setting is not boolean', () => {
    expect(normalizeContextSourceDefaults({ includeTitle: 'false' })).toEqual(DEFAULT_CONTEXT_SOURCE_DEFAULTS);
    settings.values['contextUsage.enabled'] = 'false';
    expect(readContextUsageEnabled()).toBe(true);
  });

  it('enables context usage by default and honours an explicit disable', () => {
    expect(readContextUsageEnabled()).toBe(true);
    settings.values['contextUsage.enabled'] = false;
    expect(readContextUsageEnabled()).toBe(false);
  });

  it('keeps attachment budgets active when the indicator is disabled', () => {
    settings.values['contextUsage.enabled'] = false;
    const [attachment] = budgetAttachments([{
      id: 'large',
      kind: 'file',
      label: 'large.txt',
      path: 'large.txt',
      content: `first\n${'x'.repeat(200)}`,
      truncated: false,
    }], 80);

    expect(readContextUsageEnabled()).toBe(false);
    expect(attachment?.truncated).toBe(true);
    expect(attachment?.content).toContain(ATTACHMENT_TRUNCATION_MARKER);
  });
});