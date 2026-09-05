import { describeProviderContract } from '../../platform/contract/providerContract';
import type { ConnectionConfig } from '../../platform/provider';
import { createGitHubProvider } from './githubProvider';
import { makeFakeGitHubFetch } from './fakeGitHub';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://github.com',
  credential: { kind: 'token', token: 'ghp-test' },
};

describeProviderContract('github (REST + GraphQL against fake fetch)', {
  capabilities: createGitHubProvider().capabilities,
  makeConnection: () => createGitHubProvider(makeFakeGitHubFetch()).connect(CONFIG),
  // The batch 422s the way GitHub does on a bad position, and the per-comment
  // fallback then fails its second comment — the partial-failure case.
  makeFailingConnection: () =>
    createGitHubProvider(
      makeFakeGitHubFetch({ failReviewPositionOnBatch: true, failCommentAt: 2 }),
    ).connect(CONFIG),
  inputs: {
    repository: 'https://github.com/acme/core',
    group: 'https://github.com/orgs/acme',
    notVisible: 'acme/does-not-exist',
    noMatch: 'this is not a source',
  },
  expected: {
    repoId: 'acme/core',
    repoPath: 'acme/core',
    groupId: 'acme',
  },
  // The fake's threads are stateful, so a reply and a resolve can be read back.
  threadMutationsPersist: true,
  crRef: { repoId: 'acme/core', number: '2841' },
  anchor: { filePath: 'src/limiter.ts', line: 12 },
  makeRateLimitedInvestigationConnection: () =>
    createGitHubProvider(makeFakeGitHubFetch({ investigationRateLimited: true })).connect(CONFIG),
  investigation: {
    baseSha: '7c1de9a0b2f3c4d5e6f708192a3b4c5d6e7f8091',
    changedFilePath: 'src/limiter.ts',
    binaryFilePath: 'assets/logo.png',
    // Strictly older than #2841's own head — proves no branch-tip substitution (task 3.7).
    priorRevision: { baseSha: 'prior-base-1', headSha: 'prior-head-1' },
    noMatchQuery: 'ZZZ_NOPE_NEVER_MATCHES',
    matchQuery: 'context',
  },
});
