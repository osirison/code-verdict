import { readFileSync } from 'node:fs';
import type { HostDescriptor, Vocabulary } from '../platform/provider';
import { join } from 'node:path';

/** The reference payloads the spec ships — the source of truth for tests. */
export function loadSpecFixtures(): Record<string, unknown> {
  const path = join(process.cwd(), 'spec', 'specs', 'Code Verdict - API fixtures.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/**
 * Vocabularies for renderer tests. Two of them, deliberately: a test that
 * renders the same state under both is what proves the chrome reads nouns
 * from the provider instead of from a literal.
 */
export const GITLAB_VOCABULARY: Vocabulary = {
  platformName: 'GitLab',
  changeRequestNoun: 'merge request',
  changeRequestNounPlural: 'merge requests',
  changeRequestAbbrev: 'MR',
  repoNoun: 'project',
  repoNounPlural: 'projects',
  groupNoun: 'group',
  ciNoun: 'pipeline',
  ciNounPlural: 'pipelines',
  formatCrRef: (number) => `!${number}`,
};

export const GITHUB_VOCABULARY: Vocabulary = {
  platformName: 'GitHub',
  changeRequestNoun: 'pull request',
  changeRequestNounPlural: 'pull requests',
  changeRequestAbbrev: 'PR',
  repoNoun: 'repository',
  repoNounPlural: 'repositories',
  groupNoun: 'organization',
  ciNoun: 'check',
  ciNounPlural: 'checks',
  formatCrRef: (number) => `#${number}`,
};

export const GITLAB_HOST: HostDescriptor = {
  instanceUrlLabel: 'GitLab instance URL',
  defaultInstanceUrl: 'https://gitlab.com',
  tokenPlaceholder: 'glpat-…',
  tokenHint: 'a personal access token with `api` scope',
  sourceInputPlaceholder: 'https://gitlab.com/hve/platform/core · 9102 · group 4821',
  sourceInputHint: 'Accepts a full URL, a numeric project id, or “group <id>”.',
  sourceSamples: [
    { label: 'project URL', value: 'https://gitlab.com/hve/platform/core' },
    { label: 'project id', value: '9102' },
    { label: 'group 4821', value: 'group 4821' },
  ],
};
