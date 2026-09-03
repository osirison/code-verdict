import * as vscode from 'vscode';
import { DEFAULT_CONTEXT_BUDGETS, type ContextBudgets } from '../app/reviewContext';

export interface ContextBudgetSettings {
  sectionBudget?: unknown;
  totalBudget?: unknown;
  maxLinkedItems?: unknown;
}

export interface ContextSourceDefaults {
  includeTitle: boolean;
  includeDescription: boolean;
  includeLinkedItems: boolean;
}

export const DEFAULT_CONTEXT_SOURCE_DEFAULTS: Readonly<ContextSourceDefaults> = {
  includeTitle: true,
  includeDescription: true,
  includeLinkedItems: true,
};

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

/** Normalize untrusted setting values before they cross into the app layer. */
export function normalizeContextBudgets(settings: ContextBudgetSettings): ContextBudgets {
  return {
    sectionBudget: positiveInteger(settings.sectionBudget, DEFAULT_CONTEXT_BUDGETS.sectionBudget),
    totalBudget: positiveInteger(settings.totalBudget, DEFAULT_CONTEXT_BUDGETS.totalBudget),
    maxLinkedItems: positiveInteger(settings.maxLinkedItems, DEFAULT_CONTEXT_BUDGETS.maxLinkedItems),
  };
}

/** The only reader for context budgets; lower layers receive the normalized snapshot. */
export function readContextBudgets(): ContextBudgets {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return normalizeContextBudgets({
    sectionBudget: config.get<unknown>('context.sectionBudget'),
    totalBudget: config.get<unknown>('context.totalBudget'),
    maxLinkedItems: config.get<unknown>('context.maxLinkedItems'),
  });
}

function configuredBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function normalizeContextSourceDefaults(settings: Partial<Record<keyof ContextSourceDefaults, unknown>>): ContextSourceDefaults {
  return {
    includeTitle: configuredBoolean(settings.includeTitle, DEFAULT_CONTEXT_SOURCE_DEFAULTS.includeTitle),
    includeDescription: configuredBoolean(
      settings.includeDescription,
      DEFAULT_CONTEXT_SOURCE_DEFAULTS.includeDescription,
    ),
    includeLinkedItems: configuredBoolean(
      settings.includeLinkedItems,
      DEFAULT_CONTEXT_SOURCE_DEFAULTS.includeLinkedItems,
    ),
  };
}

export function readContextSourceDefaults(): ContextSourceDefaults {
  const config = vscode.workspace.getConfiguration('codeVerdict');
  return normalizeContextSourceDefaults({
    includeTitle: config.get<unknown>('context.includeTitle'),
    includeDescription: config.get<unknown>('context.includeDescription'),
    includeLinkedItems: config.get<unknown>('context.includeLinkedItems'),
  });
}

export function contextSourceEnabledByDefault(
  source: 'title' | 'description' | 'linkedItem',
  defaults: ContextSourceDefaults,
): boolean {
  if (source === 'title') return defaults.includeTitle;
  if (source === 'description') return defaults.includeDescription;
  return defaults.includeLinkedItems;
}

export function readContextUsageEnabled(): boolean {
  const value = vscode.workspace.getConfiguration('codeVerdict').get<unknown>('contextUsage.enabled');
  return configuredBoolean(value, true);
}