import { describeProviderContract } from '../../platform/contract/providerContract';
import { FixtureConnection, fixtureProvider } from './fixtureProvider';

describeProviderContract('fixture', {
  capabilities: fixtureProvider.capabilities,
  makeConnection: () => fixtureProvider.connect({ instanceUrl: 'https://gitlab.example', credential: { kind: 'token', token: 'demo'  } }),
  makeFailingConnection: () => {
    const conn = new FixtureConnection();
    conn.simulate.staleAnchorKeys = new Set(['fails']);
    return conn;
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
