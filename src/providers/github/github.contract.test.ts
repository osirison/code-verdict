import { describeProviderContract } from '../../platform/contract/providerContract';
import type { ConnectionConfig } from '../../platform/provider';
import { createGitHubProvider } from './githubProvider';
import { ADVANCED_TARGET_BRANCH_SHA, makeFakeGitHubFetch } from './fakeGitHub';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://github.com',
  credential: { kind: 'token', token: 'ghp-test' },
};

/**
 * #2841 was cut from this commit and has not been rebased, so it is both the
 * tip `main` starts at in the fake and the pull's merge base — the two values
 * only diverge once a commit lands on `main`, which is exactly what
 * `makeMovingTargetBranchConnection` below does.
 */
const MERGE_BASE_SHA = '7c1de9a0b2f3c4d5e6f708192a3b4c5d6e7f8091';

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
  makeRateLimitedDetailConnection: () =>
    createGitHubProvider(makeFakeGitHubFetch({ investigationRateLimited: true })).connect(CONFIG),
  // `main` gets a commit while the review is in flight: the pull's `base.sha`
  // moves, its `merge_base_commit` does not.
  makeMovingTargetBranchConnection: () => {
    const targetBranch = { tip: MERGE_BASE_SHA };
    return {
      conn: createGitHubProvider(makeFakeGitHubFetch({ targetBranch })).connect(CONFIG),
      advanceTargetBranch: () => {
        targetBranch.tip = ADVANCED_TARGET_BRANCH_SHA;
        return targetBranch.tip;
      },
    };
  },
});
