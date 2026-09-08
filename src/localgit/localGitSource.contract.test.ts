/**
 * The shared investigation-source conformance suite, run against the local git
 * source — task 8.8 of `add-local-git-investigation`.
 *
 * The suite is `src/platform/contract/investigationSourceContract.ts`. It used
 * to be part of the provider contract, and this file used to wrap the source in
 * a `Connection` full of stubs so that suite could reach it — sign-in,
 * resolving a repository, listing change requests, posting a review, none of
 * which a bare object store can answer. The provider stopped answering
 * investigation, the cases moved to a suite about sources, and every one of
 * those stubs went with them. What is left is the source and the facts the
 * contract holds it to.
 */
import { afterAll, describe, it } from 'vitest';
import { describeInvestigationSourceContract } from '../platform/contract/investigationSourceContract';
import { createTwoCommitRepository, gitExecutableVersion, runGit, type LocalGitFixture } from '../testing/localGitRepository';
import { createLocalGitSource, LOCAL_GIT_INVESTIGATION_CAPABILITIES } from './localGitSource';

const REPO_ID = 'acme/core';

const gitVersion = gitExecutableVersion();

if (gitVersion === undefined) {
  // A machine without git cannot run the local source at all, which design D8
  // gives its own state rather than a failure. Stated as a skip so the file
  // reports why it produced nothing.
  describe.skip('investigation source contract: local git investigation source', () => {
    it('needs a git executable on this machine', () => undefined);
  });
} else {
  const repo: LocalGitFixture = createTwoCommitRepository({ oversizedDiffLines: 20 });
  const store = `${repo.root}/contract-store.git`;
  const init = runGit(repo, ['init', '--bare', '--quiet', store]);
  if (init.status !== 0) throw new Error(`could not create the contract store: ${init.stderr}`);
  const push = runGit(repo, [
    'push',
    '--quiet',
    store,
    `${repo.baseSha}:refs/codeverdict/${repo.baseSha}`,
    `${repo.headSha}:refs/codeverdict/${repo.headSha}`,
  ]);
  if (push.status !== 0) throw new Error(`could not fill the contract store: ${push.stderr}`);

  afterAll(() => repo.cleanup());

  const source = createLocalGitSource({ gitDir: store, repoId: REPO_ID });

  describeInvestigationSourceContract('local git investigation source (task 8.8)', {
    makeSource: () => source,
    capabilities: LOCAL_GIT_INVESTIGATION_CAPABILITIES,
    repoId: REPO_ID,
    baseSha: repo.baseSha,
    headSha: repo.headSha,
    changedFilePath: repo.paths.modified,
    // The case a forge cannot satisfy: this one is binary because its content
    // is, proven by reading it, not guessed from an absent diff.
    binaryFilePath: repo.paths.binary,
    noMatchQuery: 'ZZZ_NO_MATCH_ZZZ',
    matchQuery: 'RATE',
    // This source reads an object store it fetched into, not the platform. A
    // pinned pair missing from it is a pair this source has not got, which is
    // not a statement that the platform no longer holds it — the exact
    // ambiguity design D8 refuses to resolve from here.
    revisionsNotAuthoritative: true,
    // No `priorRevision`: the fixture is exactly the pinned pair, and the
    // suite's prior-revision case needs a third, older commit.
    // No `declinedContent`: this source reads the content, so it has no entry
    // it enumerates and declines to render — which is the whole reason it
    // exists.
  });
}
