import { describeProviderContract } from '../../platform/contract/providerContract';
import type { ConnectionConfig } from '../../platform/provider';
import { loadSpecFixtures } from '../../testing/specFixtures';
import { createGitLabProvider } from './gitlabProvider';
import { makeFakeGitLabFetch } from './fakeGitLab';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://gitlab.example',
  credential: { kind: 'token', token: 'glpat-test' },
};

const fixtures = loadSpecFixtures();
const diffRefs = (fixtures.gitlabMergeRequest as { diff_refs: { base_sha: string } }).diff_refs;

describeProviderContract('gitlab (REST v4 against fake fetch)', {
  capabilities: createGitLabProvider().capabilities,
  makeConnection: () => createGitLabProvider(makeFakeGitLabFetch()).connect(CONFIG),
  makeFailingConnection: () =>
    createGitLabProvider(makeFakeGitLabFetch({ failDiscussionPostAt: 2 })).connect(CONFIG),
  makeRateLimitedInvestigationConnection: () =>
    createGitLabProvider(makeFakeGitLabFetch({ investigationRateLimited: true })).connect(CONFIG),
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
  investigation: {
    baseSha: diffRefs.base_sha,
    changedFilePath: 'src/auth/token.ts',
    binaryFilePath: 'assets/logo.png',
    // Strictly older than !2841's own head — proves no branch-tip substitution (task 3.7).
    priorRevision: { baseSha: 'prior-base-1', headSha: 'prior-head-1' },
    noMatchQuery: 'ZZZ_NOPE_NEVER_MATCHES',
    matchQuery: 'refresh',
  },
});
