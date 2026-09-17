/**
 * A test double for an `InvestigationSource`, built from however many of the
 * five operations a test actually cares about.
 *
 * **Why this exists at all.** Until local git became the only investigation
 * source, a harness test wrote one fake `Connection` carrying every method the
 * attempt might call — the forge's and the five pinned operations alike — and
 * handed it to a member as both. The five came off `Connection`, so those bags
 * no longer typecheck as one object, and every test that used one would
 * otherwise grow its own two-object split. This is that split, written once.
 *
 * An operation the bag does not define answers `unavailable`, echoing the
 * request's own pin. That is the same shape the production dispatcher produces
 * for a capability a source does not declare, so a test that forgets to script
 * an operation sees a refusal rather than a crash — and the refusal names which
 * operation, which is what makes the mistake readable.
 *
 * Test-only. Nothing in `src/app`, `src/domain`, `src/localgit` or
 * `src/providers` imports it, and there is no production path that assembles a
 * source this way: production sources are the local git one and the demo pod's
 * sample data, each of which implements all five for real.
 */
import type {
  InvestigationOperations,
  InvestigationResult,
  InvestigationSnapshotRef,
  InvestigationSource,
  InvestigationSourceCapabilities,
} from '../platform/types';

/**
 * Everything supported, with a deliberately tiny page bound. Tiny because a
 * bound in a harness test is a *declared ceiling* compared against a policy
 * field, never a limit on how many entries a fake handler returns in one page —
 * the same reasoning the harness tests' own `PAGE_BOUND` constant carries.
 */
export const FAKE_SOURCE_CAPABILITIES: InvestigationSourceCapabilities = Object.freeze({
  manifests: { supported: true, pageBound: { maxPageSize: 1 } },
  diffReads: { supported: true, pageBound: { maxPageSize: 1 } },
  fileReads: { supported: true, pageBound: { maxPageSize: 1 } },
  repositorySearch: { supported: true, pageBound: { maxPageSize: 1 } },
  diffSearch: { supported: true, pageBound: { maxPageSize: 1 } },
  pagination: { maxPageSize: 1 },
});

export function fakeInvestigationSource(
  methods: Partial<InvestigationOperations>,
  capabilities: InvestigationSourceCapabilities = FAKE_SOURCE_CAPABILITIES,
): InvestigationSource {
  const missing = <T>(request: { snapshot: InvestigationSnapshotRef }, operation: string): Promise<InvestigationResult<T>> =>
    Promise.resolve({
      snapshot: request.snapshot,
      state: 'unavailable',
      reason: `This test source does not implement ${operation}.`,
    });
  return {
    capabilities,
    listChangedFiles: (request) => (methods.listChangedFiles ? methods.listChangedFiles(request) : missing(request, 'listChangedFiles')),
    readDiff: (request) => (methods.readDiff ? methods.readDiff(request) : missing(request, 'readDiff')),
    readFile: (request) => (methods.readFile ? methods.readFile(request) : missing(request, 'readFile')),
    searchRepository: (request) => (methods.searchRepository ? methods.searchRepository(request) : missing(request, 'searchRepository')),
    searchDiff: (request) => (methods.searchDiff ? methods.searchDiff(request) : missing(request, 'searchDiff')),
  };
}
