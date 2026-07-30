import type { Category, ReviewItem, Severity } from './types';

export interface Criteria {
  severityFloor: Severity;
  /** Subset of the nine categories. */
  categories: Category[];
  /** 0-100 */
  minConfidence: number;
  extraInstructions: string;
}

export const SEVERITY_ORDER: readonly Severity[] = ['nit', 'minor', 'major', 'blocker'];

export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(floor);
}

export type FilterReason = 'belowSeverityFloor' | 'belowConfidence' | 'categoryOff';

/** Why an item fails the criteria, or null when it passes. */
export function filterReason(
  item: Pick<ReviewItem, 'severity' | 'category' | 'confidence'>,
  criteria: Criteria,
): FilterReason | null {
  if (!severityAtLeast(item.severity, criteria.severityFloor)) return 'belowSeverityFloor';
  if (item.confidence < criteria.minConfidence) return 'belowConfidence';
  if (!criteria.categories.includes(item.category)) return 'categoryOff';
  return null;
}

export function meetsCriteria(
  item: Pick<ReviewItem, 'severity' | 'category' | 'confidence'>,
  criteria: Criteria,
): boolean {
  return filterReason(item, criteria) === null;
}
