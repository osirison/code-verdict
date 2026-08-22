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
  crRef: { repoId: 'acme/core', number: '2841' },
  anchor: { filePath: 'src/limiter.ts', line: 12 },
});
