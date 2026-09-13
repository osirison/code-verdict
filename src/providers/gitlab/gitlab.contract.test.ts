import { describeProviderContract } from '../../platform/contract/providerContract';
import type { ConnectionConfig } from '../../platform/provider';
import { loadSpecFixtures } from '../../testing/specFixtures';
import { createGitLabProvider } from './gitlabProvider';
import { ADVANCED_TARGET_BRANCH_SHA, makeFakeGitLabFetch } from './fakeGitLab';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://gitlab.example',
  credential: { kind: 'token', token: 'glpat-test' },
};

const fixtures = loadSpecFixtures();
const diffRefs = (fixtures.gitlabMergeRequest as { diff_refs: { base_sha: string; start_sha: string } }).diff_refs;

describeProviderContract('gitlab (REST v4 against fake fetch)', {
  capabilities: createGitLabProvider().capabilities,
  makeConnection: () => createGitLabProvider(makeFakeGitLabFetch()).connect(CONFIG),
  makeFailingConnection: () =>
    createGitLabProvider(makeFakeGitLabFetch({ failDiscussionPostAt: 2 })).connect(CONFIG),
  makeRateLimitedDetailConnection: () =>
    createGitLabProvider(makeFakeGitLabFetch({ investigationRateLimited: true })).connect(CONFIG),
  // `main` gets a commit while the review is in flight. GitLab reports both
  // commits in one object, so the advance moves `diff_refs.start_sha` (the
  // target-branch commit the diff was started from) and leaves
  // `diff_refs.base_sha` (the merge base) where it is — this provider has
  // always read the right one, and this case is what keeps that deliberate
  // (task 5.2).
  makeMovingTargetBranchConnection: () => {
    const targetBranch = { tip: diffRefs.start_sha };
    return {
      conn: createGitLabProvider(makeFakeGitLabFetch({ targetBranch })).connect(CONFIG),
      advanceTargetBranch: () => {
        targetBranch.tip = ADVANCED_TARGET_BRANCH_SHA;
        return targetBranch.tip;
      },
    };
  },
  inputs: {
    repository: 'https://gitlab.com/hve/platform/core',
    group: 'group 4821',
    notVisible: '7777',
    noMatch: 'this is not a source',
  },
  expected: {
    repoId: '9101',
    repoPath: 'hve/platform/core',
    groupId: '4821',
  },
  crRef: { repoId: '9101', number: '2841' },
  anchor: { filePath: 'src/auth/token.ts', line: 63 },
});
