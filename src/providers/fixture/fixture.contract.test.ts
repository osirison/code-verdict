import { describeProviderContract } from '../../platform/contract/providerContract';
import { DIFF_REFS } from './data';
import { BINARY_FILE, CHANGED_HEAD_SNAPSHOT_SHA } from './harnessFixtures';
import { FixtureConnection, fixtureProvider } from './fixtureProvider';

describeProviderContract('fixture', {
  capabilities: fixtureProvider.capabilities,
  makeConnection: () => fixtureProvider.connect({ instanceUrl: 'https://gitlab.example', credential: { kind: 'token', token: 'demo'  } }),
  makeFailingConnection: () => {
    const conn = new FixtureConnection();
    conn.simulate.staleAnchorKeys = new Set(['fails']);
    return conn;
  },
  makeRateLimitedInvestigationConnection: () => {
    const conn = new FixtureConnection();
    conn.simulate.investigationRateLimited = true;
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
  // FixtureConnection keeps its threads in an instance Map and mutates them.
  threadMutationsPersist: true,
  crRef: { repoId: '9101', number: '2841' },
  anchor: { filePath: 'src/auth/token.ts', line: 63 },
  investigation: {
    baseSha: DIFF_REFS.base_sha,
    changedFilePath: 'src/auth/token.ts',
    binaryFilePath: BINARY_FILE.newPath,
    // Strictly older than CR 2841's own head \u2014 proves no branch-tip substitution (task 3.7).
    priorRevision: { baseSha: 'stale-base-1', headSha: CHANGED_HEAD_SNAPSHOT_SHA },
    noMatchQuery: 'ZZZ_NOPE_NEVER_MATCHES',
    matchQuery: 'refresh',
  },
});
