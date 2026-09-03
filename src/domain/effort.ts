export const EFFORT_LEVELS = [
  {
    id: 'none',
    label: 'None',
    description: 'nothing added',
    promptContribution: '',
  },
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'answer directly; do not deliberate',
    promptContribution: 'answer directly; do not deliberate',
  },
  {
    id: 'low',
    label: 'Low',
    description: 'brief check before answering',
    promptContribution: 'brief check before answering',
  },
  {
    id: 'medium',
    label: 'Medium',
    description: 'reason through the diff before reporting',
    promptContribution: 'reason through the diff before reporting',
  },
  {
    id: 'high',
    label: 'High',
    description: 'reason carefully; consider alternatives before reporting',
    promptContribution: 'reason carefully; consider alternatives before reporting',
  },
  {
    id: 'xhigh',
    label: 'Extra High',
    description: 'exhaustive reasoning; enumerate and discard alternatives',
    promptContribution: 'exhaustive reasoning; enumerate and discard alternatives',
  },
  {
    id: 'max',
    label: 'Max',
    description: 'no reasoning budget; take as long as needed',
    promptContribution: 'no reasoning budget; take as long as needed',
  },
] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number]['id'];

export const DEFAULT_EFFORT_LEVEL: EffortLevel = 'none';

export function isEffortLevel(value: unknown): value is EffortLevel {
  return EFFORT_LEVELS.some((level) => level.id === value);
}

export function normalizeEffortLevel(value: unknown): EffortLevel {
  return isEffortLevel(value) ? value : DEFAULT_EFFORT_LEVEL;
}

export function normalizeEffortsByModel(value: unknown): Record<string, EffortLevel> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(([modelId, effort]) => modelId !== '' && isEffortLevel(effort)),
  );
}

export function effortForModel(value: unknown, modelId: string | undefined): EffortLevel {
  if (modelId === undefined) return DEFAULT_EFFORT_LEVEL;
  return normalizeEffortsByModel(value)[modelId] ?? DEFAULT_EFFORT_LEVEL;
}

export function setEffortForModel(
  value: unknown,
  modelId: string,
  effort: EffortLevel,
): Record<string, EffortLevel> {
  return { ...normalizeEffortsByModel(value), [modelId]: effort };
}

export function effortPrompt(level: EffortLevel = DEFAULT_EFFORT_LEVEL): string {
  const contribution = EFFORT_LEVELS.find((candidate) => candidate.id === level)?.promptContribution ?? '';
  return contribution === '' ? '' : `Review effort instruction: ${contribution}.`;
}

export function effortLabel(level: unknown): string {
  const normalized = normalizeEffortLevel(level);
  return EFFORT_LEVELS.find((candidate) => candidate.id === normalized)?.label ?? 'None';
}