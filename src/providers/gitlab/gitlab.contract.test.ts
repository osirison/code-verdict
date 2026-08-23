import { describeProviderContract } from '../../platform/contract/providerContract';
import type { ConnectionConfig } from '../../platform/provider';
import { createGitLabProvider } from './gitlabProvider';
import { makeFakeGitLabFetch } from './fakeGitLab';

const CONFIG: ConnectionConfig = {
  instanceUrl: 'https://gitlab.example',
  credential: { kind: 'token', token: 'glpat-test' },
};

describeProviderContract('gitlab (REST v4 against fake fetch)', {
  capabilities: createGitLabProvider().capabilities,
  makeConnection: () => createGitLabProvider(makeFakeGitLabFetch()).connect(CONFIG),
  makeFailingConnection: () =>
    createGitLabProvider(makeFakeGitLabFetch({ failDiscussionPostAt: 2 })).connect(CONFIG),
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
