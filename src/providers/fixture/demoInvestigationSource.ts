/**
 * The demo pod's investigation source — the sample change every demo review
 * reads, answered from memory.
 *
 * **Why this is not the fixture provider any more.** A provider used to answer
 * the five revision-pinned operations, and the fixture provider answered them
 * like the two real ones. That ended when local git became the only
 * investigation source: a forge is never asked to compute a change, so the
 * five operations came off `Connection` and off every provider, fixture
 * included. What did not end is the demo pod, and the demo pod has nothing for
 * git to read — its revisions (`small-base-1`, `!2841`) exist in no repository
 * and on no remote, and its shas are not object ids at all.
 *
 * So the demo is *handed* a source instead of selecting one. The host
 * constructs this for a demo pod and passes it to source selection, which uses
 * it as given and skips the git probe, the object-source descriptor and the
 * fetch entirely (`app/investigationSourceSelection.ts`). It never competes
 * with local git and can never be reached by a connected pod: a real pod
 * supplies no such source, and there is no path that constructs one from a
 * connection.
 *
 * It is also what the shared conformance suite runs its investigation cases
 * against alongside the local git source, so the neutral contract keeps having
 * two independent implementations to hold it honest.
 *
 * Everything below — the scenario registry keyed by head sha, the
 * reconstruction of head-revision text from a unified diff, the oversized /
 * declined / binary / rename scenarios — moved here verbatim from
 * `fixtureProvider.ts`. Nothing about the sample data changed; only who serves
 * it did.
 */
import type {
  ChangedFileEntry,
  ChangedFileKind,
  ChangedFileManifestRequest,
  ChangedFileManifestResult,
  DiffPage,
  DiffPageRequest,
  DiffPageResult,
  DiffSearchMatch,
  DiffSearchRequest,
  DiffSearchResult,
  FileDiff,
  FileRange,
  FileRangeRequest,
  FileRangeResult,
  InvestigationSource,
  InvestigationSourceCapabilities,
  RepositorySearchRequest,
  RepositorySearchResult,
  SearchMatch,
} from '../../platform/types';
import { ScmError } from '../../platform/errors';
import * as data from './data';
// Task 1.3 deterministic harness fixtures — the investigation registry below
// reuses these verbatim instead of inventing new adversarial content.
import * as harnessFixtures from './harnessFixtures';

/**
 * What this source declares. Five operations and a page bound, and no
 * `changeRequestDetails`/`issueDetails` — those two are the connection's, and
 * the split is the whole point of `InvestigationSourceCapabilities`.
 */
export const DEMO_INVESTIGATION_CAPABILITIES: InvestigationSourceCapabilities = Object.freeze({
  manifests: { supported: true, pageBound: { maxPageSize: harnessFixtures.HUGE_REVIEW_PAGE_SIZE } },
  // Declared per operation rather than left to the shared fallback, and that is
  // not tidiness. The fallback is a manifest *file* count; a read pages in
  // *lines* and a search in *matches*, and a bound compared in the wrong unit is
  // how diff search shipped dead on both providers — 100 files against a
  // 50-match policy field refused every call, forever, on a source nobody had
  // checked. `investigationSourcePageBounds.test.ts` is the check that would
  // have caught it, and it holds this declaration to the same line as the local
  // git source's.
  diffReads: { supported: true, pageBound: { maxPageSize: 20_000, maxPageBytes: 256 * 1024 } },
  // Small on purpose: forces the reconstructed token.ts fixture content to
  // exercise `truncated`, not just `complete`, without a huge file.
  fileReads: { supported: true, pageBound: { maxPageSize: 8, maxPageBytes: 256 * 1024 } },
  repositorySearch: { supported: true, pageBound: { maxPageSize: 50 } },
  diffSearch: { supported: true, pageBound: { maxPageSize: 50 } },
  pagination: { maxPageSize: harnessFixtures.HUGE_REVIEW_PAGE_SIZE },
});

// ---- The sample dataset ----------------------------------------------------
//
// Independent of the demo-pod change-request content: these operations are
// revision-pinned and keyed by `headSha`, never by change-request identity, so
// the demo CR 2841 keeps serving its friendly onboarding diff through the
// connection's `getChangeRequestDiff` while its manifest, reads and searches
// come from this registry. Every entry is built from the task-1.3 harness
// fixtures (`./harnessFixtures.ts`) or the demo diff in `./data.ts`; nothing
// here is newly authored adversarial content.

interface InvestigationFile {
  entry: ChangedFileEntry;
  /** Original unified-diff hunk text, served by `readDiff`. */
  patch?: string;
  /** Deterministic reconstruction of head-revision text from `patch` (context + added lines), served by `readFile`/search. Absent for binary files. */
  lines?: readonly string[];
}

interface InvestigationScenario {
  readonly files: readonly InvestigationFile[];
  /** Paths whose diff is too large to read as a patch (`readDiff` reports `tooLarge`). */
  readonly oversizedPaths?: ReadonlySet<string>;
  /**
   * Paths this source enumerated and will not serve the content of (task
   * 3.7). Deliberately separate from `oversizedPaths`: that one is a measured
   * size, this one is an absence of measurement, and the difference is
   * whether a file may ever be closed on it.
   */
  readonly declinedPaths?: ReadonlySet<string>;
  /** `searchDiff` cannot state completeness against this scenario's diff. */
  readonly diffSearchUnknown?: boolean;
  /**
   * Repository content outside the diff — task 6.3's `AGENTS.md` chain reads
   * a directory that was never changed, so it cannot be represented as an
   * `InvestigationFile` (those are all diff-derived). `readFile` falls back
   * here when a path is not among the changed files.
   */
  readonly repoFiles?: readonly harnessFixtures.FixtureRepoFile[];
}

/** Keeps context and added lines, drops removed lines and hunk headers \u2014 a deterministic head-revision approximation, never invented file content. */
function linesFromUnifiedDiff(patch: string): string[] {
  const lines: string[] = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@') || raw.startsWith('Binary files ') || raw.startsWith('-')) continue;
    lines.push(raw.startsWith('+') || raw.startsWith(' ') ? raw.slice(1) : raw);
  }
  return lines;
}

function fileFromFileDiff(fd: FileDiff, kind: ChangedFileKind): InvestigationFile {
  const binary = fd.diff.startsWith('Binary files ');
  return {
    entry: {
      path: fd.newPath,
      oldPath: fd.isRenamed ? fd.oldPath : undefined,
      kind: fd.isRenamed ? 'renamed' : kind,
      binary,
      byteSize: binary ? 4096 : undefined,
    },
    patch: fd.diff,
    lines: binary ? undefined : linesFromUnifiedDiff(fd.diff),
  };
}

// The demo pod's own CR 2841 diff \u2014 its investigation manifest layers the
// huge/binary/renamed fixtures on top of these two real files.
const DEFAULT_INVESTIGATION_DIFF = data.DIFFS.find((d) => d.ref.repoId === '9101' && d.ref.number === '2841')!;

const INVESTIGATION_SNAPSHOTS: ReadonlyMap<string, InvestigationScenario> = new Map([
  [
    DEFAULT_INVESTIGATION_DIFF.headSha,
    {
      files: [
        ...DEFAULT_INVESTIGATION_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')),
        fileFromFileDiff(harnessFixtures.BINARY_FILE, 'added'),
        fileFromFileDiff(harnessFixtures.RENAMED_FILE, 'modified'),
      ],
    },
  ],
  [
    harnessFixtures.BINARY_AND_RENAMED_DIFF.headSha,
    { files: harnessFixtures.BINARY_AND_RENAMED_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.HUGE_REVIEW_DIFF.headSha,
    { files: harnessFixtures.HUGE_REVIEW_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.OVERSIZED_REVIEW_DIFF.headSha,
    {
      files: [
        {
          entry: {
            path: harnessFixtures.OVERSIZED_FILE_PATH,
            kind: 'modified',
            binary: false,
            byteSize: harnessFixtures.OVERSIZED_DIFF_BYTE_LENGTH,
          },
        },
      ],
      oversizedPaths: new Set([harnessFixtures.OVERSIZED_FILE_PATH]),
      diffSearchUnknown: true,
    },
  ],
  [
    harnessFixtures.DECLINED_CONTENT_DIFF.headSha,
    {
      files: harnessFixtures.DECLINED_CONTENT_DIFF.files.map((f) => {
        const file = fileFromFileDiff(f, 'modified');
        return f.newPath === harnessFixtures.DECLINED_CONTENT_FILE_PATH
          ? { ...file, entry: { ...file.entry, contentDeclined: true } }
          : file;
      }),
      declinedPaths: new Set([harnessFixtures.DECLINED_CONTENT_FILE_PATH]),
    },
  ],
  [
    harnessFixtures.CHANGED_HEAD_SNAPSHOT_SHA,
    { files: harnessFixtures.CHANGED_HEAD_SNAPSHOT_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.CHANGED_HEAD_LATER_SHA,
    { files: harnessFixtures.CHANGED_HEAD_LATER_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')) },
  ],
  [
    harnessFixtures.NESTED_AGENTS_MD_DIFF.headSha,
    {
      files: harnessFixtures.NESTED_AGENTS_MD_DIFF.files.map((f) => fileFromFileDiff(f, 'modified')),
      repoFiles: harnessFixtures.NESTED_AGENTS_MD,
    },
  ],
]);

function paginate<T>(
  items: readonly T[],
  cursor: string | undefined,
  pageSize: number,
): { page: readonly T[]; nextCursor?: string } {
  const start = cursor ? Number(cursor) : 0;
  const end = Math.min(start + pageSize, items.length);
  return { page: items.slice(start, end), nextCursor: end < items.length ? String(end) : undefined };
}

function searchScenario(scenario: InvestigationScenario, query: string, pathScope?: string): SearchMatch[] {
  const matches: SearchMatch[] = [];
  for (const file of scenario.files) {
    if (file.entry.binary || !file.lines) continue;
    if (pathScope && !file.entry.path.startsWith(pathScope)) continue;
    file.lines.forEach((line, index) => {
      if (line.includes(query)) matches.push({ path: file.entry.path, line: index + 1, excerpt: line.trim() });
    });
  }
  return matches;
}

/**
 * What a test may make this source do wrong, without the test reaching inside
 * it. The one flag left is the rate limit: it is how the harness's own
 * retry/limitation paths are exercised deterministically, and a source that
 * cannot be made to fail cannot prove the host handles failure.
 */
export interface DemoInvestigationSimulation {
  /** Every investigation read fails with the neutral rate-limited error. */
  investigationRateLimited?: boolean;
}

function investigationRateLimitedError(): ScmError {
  return new ScmError('rateLimited', 'Investigation read is rate limited', { retryAfterSeconds: 30 });
}

/**
 * One source over the sample dataset. `simulation` is read on every call
 * rather than captured once, so a test can turn the rate limit on midway
 * through a run the way a real platform would start refusing.
 */
export function createDemoInvestigationSource(simulation: DemoInvestigationSimulation = {}): InvestigationSource {
  return {
    capabilities: DEMO_INVESTIGATION_CAPABILITIES,
    async listChangedFiles(request: ChangedFileManifestRequest): Promise<ChangedFileManifestResult> {
      if (simulation.investigationRateLimited) throw investigationRateLimitedError();
      const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
      // `notFound`, not `unavailable`, and only here: this fixture holds every
      // revision it will ever hold, so a miss IS the platform stating that it
      // does not have these commits — which is the answer design D8's
      // refused-versus-gone rule reads off a manifest. A path-scoped read keeps
      // `unavailable` below, because its own `notFound` already means "no such
      // path". The two shipped providers make the same split.
      if (!scenario) return { snapshot: request.snapshot, state: 'notFound', reason: `Unknown revision: ${request.snapshot.headSha}` };
      const bound = DEMO_INVESTIGATION_CAPABILITIES.manifests.pageBound?.maxPageSize ?? DEMO_INVESTIGATION_CAPABILITIES.pagination.maxPageSize;
      const { page, nextCursor } = paginate(
        scenario.files.map((f) => f.entry),
        request.cursor,
        bound,
      );
      if (nextCursor) return { snapshot: request.snapshot, state: 'paginated', value: page, cursor: nextCursor };
      return { snapshot: request.snapshot, state: 'complete', value: page };
    },

    async readDiff(request: DiffPageRequest): Promise<DiffPageResult> {
      if (simulation.investigationRateLimited) throw investigationRateLimitedError();
      const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
      if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
      const file = scenario.files.find((f) => f.entry.path === request.path);
      if (scenario.oversizedPaths?.has(request.path)) {
        return { snapshot: request.snapshot, state: 'tooLarge', byteSize: file?.entry.byteSize };
      }
      if (scenario.declinedPaths?.has(request.path)) {
        // The patch is right there in `file.patch` and is never returned. That
        // is the fixture being faithful: a declined read is a decision about
        // serving, not a fact about the content.
        return { snapshot: request.snapshot, state: 'contentDeclined', reason: `The platform enumerated ${request.path} but did not serve its diff content.` };
      }
      if (!file) return { snapshot: request.snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
      if (file.entry.binary) return { snapshot: request.snapshot, state: 'binary', byteSize: file.entry.byteSize };
      const value: DiffPage = {
        path: file.entry.path,
        oldPath: file.entry.oldPath,
        isRenamed: file.entry.kind === 'renamed',
        patch: file.patch ?? '',
        positions: [],
      };
      return { snapshot: request.snapshot, state: 'complete', value };
    },

    async readFile(request: FileRangeRequest): Promise<FileRangeResult> {
      if (simulation.investigationRateLimited) throw investigationRateLimitedError();
      const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
      if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
      const file = scenario.files.find((f) => f.entry.path === request.path);
      const repoFile = !file ? scenario.repoFiles?.find((f) => f.path === request.path) : undefined;
      if (!file && !repoFile) return { snapshot: request.snapshot, state: 'notFound', reason: `No such path: ${request.path}` };
      if (file?.entry.binary) return { snapshot: request.snapshot, state: 'binary', byteSize: file.entry.byteSize };
      const lines = file ? file.lines ?? [] : (repoFile!.content.split(/\r?\n/));
      const bound = DEMO_INVESTIGATION_CAPABILITIES.fileReads.pageBound?.maxPageSize ?? DEMO_INVESTIGATION_CAPABILITIES.pagination.maxPageSize;
      const start = Math.max(1, request.startLine);
      if (start > lines.length) return { snapshot: request.snapshot, state: 'notFound', reason: 'startLine beyond file length' };
      const availableEnd = Math.min(request.endLine, lines.length);
      const boundedEnd = Math.min(availableEnd, start + bound - 1);
      const value: FileRange = { revision: request.revision, path: request.path, startLine: start, endLine: boundedEnd, text: lines.slice(start - 1, boundedEnd).join('\n') };
      if (boundedEnd < availableEnd) {
        return { snapshot: request.snapshot, state: 'truncated', value, knownRemainingUnits: availableEnd - boundedEnd };
      }
      return { snapshot: request.snapshot, state: 'complete', value };
    },

    async searchRepository(request: RepositorySearchRequest): Promise<RepositorySearchResult> {
      if (simulation.investigationRateLimited) throw investigationRateLimitedError();
      const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
      if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
      return { snapshot: request.snapshot, state: 'complete', value: searchScenario(scenario, request.query, request.pathScope) };
    },

    async searchDiff(request: DiffSearchRequest): Promise<DiffSearchResult> {
      if (simulation.investigationRateLimited) throw investigationRateLimitedError();
      const scenario = INVESTIGATION_SNAPSHOTS.get(request.snapshot.headSha);
      if (!scenario) return { snapshot: request.snapshot, state: 'unavailable', reason: `Unknown revision: ${request.snapshot.headSha}` };
      if (scenario.diffSearchUnknown) return { snapshot: request.snapshot, state: 'unknown', reason: 'Diff exceeds searchable size' };
      // Same rule both providers apply: content that was never served is an
      // unknown number of unsearched lines, so the search cannot call itself
      // complete over the remainder.
      const declinedInScope = [...(scenario.declinedPaths ?? [])].filter((path) => !request.pathScope || path.startsWith(request.pathScope));
      if (declinedInScope.length > 0) {
        return {
          snapshot: request.snapshot,
          state: 'unknown',
          reason: `${declinedInScope.length} file(s) in this comparison were enumerated without diff content and could not be searched`,
        };
      }
      const value: DiffSearchMatch[] = searchScenario(scenario, request.query, request.pathScope).map((m) => ({
        position: { path: m.path, side: 'new', line: m.line },
        excerpt: m.excerpt,
      }));
      return { snapshot: request.snapshot, state: 'complete', value };
    },
  };
}
