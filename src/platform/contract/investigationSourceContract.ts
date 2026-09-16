/**
 * The investigation-source contract: a reusable conformance suite every
 * `InvestigationSource` must pass.
 *
 * **Why it is its own suite now.** Every case below used to live inside
 * `providerContract.ts`, because a provider was the only thing that could
 * answer a revision-pinned operation. A provider answers none of them any more
 * — everything computable from two commits is computed from a local object
 * store — so a contract about those operations is not a contract about a
 * provider. Splitting them keeps each suite describing one thing: what a forge
 * must do, and what a source must do.
 *
 * Nothing about the cases themselves changed in the move. They pin snapshots
 * the same way, walk pagination the same way, and hold the same line on the
 * states that must never be guessed: `binary` only where the source read the
 * bytes, `contentDeclined` for content a source enumerated and would not serve,
 * and no claim that a pinned pair is absent from a store that does not speak
 * for the platform.
 *
 * Two implementations run it — the local git source over a real two-commit
 * repository, and the demo pod's in-memory sample source. Two is the point: one
 * implementation and a suite is a description of that implementation.
 */
import { describe, expect, it } from 'vitest';
import { investigationResultValue } from '../types';
import type { InvestigationSource, InvestigationSourceCapabilities } from '../types';

export interface InvestigationSourceContractHarness {
  makeSource(): InvestigationSource | Promise<InvestigationSource>;
  /**
   * What the source declares. Restated on the harness because the suite has to
   * decide which cases to register before any `it` body runs, and `makeSource`
   * may be async. The first case below asserts the source's own declaration is
   * this one, so a harness cannot claim capabilities its source does not.
   */
  capabilities: InvestigationSourceCapabilities;
  /** A source whose reads always fail with a `rateLimited` `ScmError` — exercises retryability without a real 429. Omit to skip that case. */
  makeRateLimitedSource?(): InvestigationSource | Promise<InvestigationSource>;
  /** The repository every snapshot below is pinned in. */
  repoId: string;
  /** The head every case pins to, unless it names a prior revision of its own. */
  headSha: string;
  /** The commit that head's diff is against. */
  baseSha: string;
  /** A non-binary path present in the diff at `baseSha..headSha`. */
  changedFilePath: string;
  /** A path known to be binary at `headSha`; omit to skip the binary case. */
  binaryFilePath?: string;
  /**
   * A changed file whose content this source enumerates and then declines to
   * render, with the revision pair that produces it when that is not the
   * harness's own. Omit to skip the declined-content case.
   */
  declinedContent?: { path: string; revision?: { baseSha: string; headSha: string } };
  /** A base/head pair strictly older than `headSha`, proving no branch-tip substitution (task 3.7). */
  priorRevision?: { baseSha: string; headSha: string };
  /**
   * Set when this source reads a store that is not authoritative about which
   * revisions the platform holds — a local object cache, which cannot tell a
   * commit it never fetched from one the platform no longer has. Such a source
   * must never report a pinned pair as not-found, because that is a claim about
   * the platform it is in no position to make (design D8).
   *
   * Omitted, the default, means this source speaks for whatever it reads, and
   * the suite requires it to state a pinned pair it does not hold as
   * not-found. Omission is the safe default on purpose: a new source that
   * forgets this field is held to the stricter rule, not excused from it.
   */
  revisionsNotAuthoritative?: true;
  /** A search query guaranteed to match nothing. */
  noMatchQuery: string;
  /** A search query guaranteed to match at least once under `changedFilePath`. */
  matchQuery: string;
}

export function describeInvestigationSourceContract(label: string, harness: InvestigationSourceContractHarness): void {
  describe(`investigation source contract: ${label}`, () => {
    const caps = harness.capabilities;
    const inv = harness;
    const expected = { repoId: harness.repoId };
    const snapshotAt = (headSha: string) => ({ repoId: harness.repoId, baseSha: harness.baseSha, headSha });

    it('declares exactly the capabilities this harness says it does', async () => {
      const source = await harness.makeSource();
      expect(source.capabilities).toEqual(caps);
    });

    if (caps.manifests.supported) {
      it('manifest pagination enumerates every changed file and terminates complete', async () => {
        const source = await harness.makeSource();
        const snapshot = snapshotAt(harness.headSha);
        const seenPaths = new Set<string>();
        let cursor: string | undefined;
        for (let page = 0; page < 50; page++) {
          const result = await source.listChangedFiles({ snapshot, cursor });
          expect(result.snapshot).toEqual(snapshot);
          for (const file of investigationResultValue(result) ?? []) seenPaths.add(file.path);
          if (result.state !== 'paginated') {
            expect(result.state).toBe('complete');
            break;
          }
          cursor = result.cursor;
        }
        expect(seenPaths.has(inv.changedFilePath)).toBe(true);
      });

      /**
       * The one answer only a provider can give, and the reason design D8's
       * refused-versus-gone rule is implementable at all.
       *
       * When a local fetch of a pinned commit fails, git cannot say whether
       * the remote refused an unadvertised object or the object is gone, and
       * its error text is not a contract across servers, versions and
       * configurations. So the host asks the platform for the change at the
       * same pinned pair. A manifest has no path parameter to get wrong, so
       * its `notFound` can mean one thing only: this platform does not hold
       * these revisions. `unavailable` is the state that says nothing about
       * existence — every provider answered it here once, which left the rule
       * with no signal to read and no shipped build able to exercise it.
       *
       * Every provider makes the same split, which is why this belongs in the
       * shared suite rather than three per-provider tests: a path-scoped read
       * keeps `unavailable` for the same pair, because its own `notFound`
       * already means "no such path".
       */
      const unheldPair = { repoId: expected.repoId, baseSha: 'no-such-base-revision', headSha: 'no-such-head-revision' };

      if (inv.revisionsNotAuthoritative) {
        it('never claims a pinned pair is absent, because its store does not speak for the platform', async () => {
          const source = await harness.makeSource();
          const result = await source.listChangedFiles({ snapshot: unheldPair });
          expect(result.snapshot).toEqual(unheldPair);
          // The other half of the same rule: a source reading a cache cannot
          // tell a commit it never fetched from one that is gone, and D8
          // resolves that ambiguity toward "nothing established" every time.
          expect(result.state).not.toBe('notFound');
        });
      } else {
        it('reports a pinned pair it does not hold as notFound on the manifest, distinctly from unavailable', async () => {
          const source = await harness.makeSource();
          const result = await source.listChangedFiles({ snapshot: unheldPair });
          expect(result.snapshot).toEqual(unheldPair);
          expect(result.state).toBe('notFound');
        });
      }
    }

    if (caps.fileReads.supported && inv.priorRevision) {
      const priorRevision = inv.priorRevision;
      it('pins a file read to the exact requested revision, never a branch tip (task 3.7)', async () => {
        const source = await harness.makeSource();
        const snapshot = { repoId: expected.repoId, baseSha: priorRevision.baseSha, headSha: priorRevision.headSha };
        const result = await source.readFile({ snapshot, revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 });
        expect(result.snapshot).toEqual(snapshot);
      });
    }

    if (caps.fileReads.supported) {
      it('bounds a file range read to the declared page bound', async () => {
        const source = await harness.makeSource();
        const bound = (caps.fileReads.pageBound ?? caps.pagination).maxPageSize;
        const result = await source.readFile({
          snapshot: snapshotAt(harness.headSha),
          revision: 'head',
          path: inv.changedFilePath,
          startLine: 1,
          endLine: bound + 1000,
        });
        const value = investigationResultValue(result);
        if (value) expect(value.endLine - value.startLine + 1).toBeLessThanOrEqual(bound);
      });

      if (inv.binaryFilePath) {
        const binaryFilePath = inv.binaryFilePath;
        it('reports a binary file as binary, never as empty text', async () => {
          const source = await harness.makeSource();
          const result = await source.readFile({
            snapshot: snapshotAt(harness.headSha),
            revision: 'head',
            path: binaryFilePath,
            startLine: 1,
            endLine: 1,
          });
          expect(result.state).toBe('binary');
        });
      }
    }

    if (caps.repositorySearch.supported) {
      it('reports an exhaustive no-match search as complete and empty, not unavailable', async () => {
        const source = await harness.makeSource();
        const result = await source.searchRepository({ snapshot: snapshotAt(harness.headSha), revision: 'head', query: inv.noMatchQuery });
        expect(result.state).toBe('complete');
        expect(investigationResultValue(result)).toEqual([]);
      });

      it('search returns at least one match for a query known to hit', async () => {
        const source = await harness.makeSource();
        const result = await source.searchRepository({ snapshot: snapshotAt(harness.headSha), revision: 'head', query: inv.matchQuery });
        expect(investigationResultValue(result)?.length ?? 0).toBeGreaterThan(0);
      });
    }

    if (inv.declinedContent && caps.manifests.supported && caps.diffReads.supported) {
      const declined = inv.declinedContent;
      /**
       * Content the platform enumerated and would not render is reported as
       * such, at both levels, and never as binary
       * (`add-local-git-investigation` task 3.7).
       *
       * The two assertions are one requirement: `contentDeclined` on the
       * entry says the manifest knows, and `binary: false` says the provider
       * did not resolve the ambiguity by guessing. A provider that cannot
       * tell "this content is not text" from "I did not compute this" must
       * claim neither, because one of those may close a file permanently and
       * the other may not.
       */
      it('reports content the platform declined to render as declined, at both the manifest entry and the read (task 3.7)', async () => {
        const source = await harness.makeSource();
        const snapshot = declined.revision
          ? { repoId: expected.repoId, ...declined.revision }
          : snapshotAt(harness.headSha);

        const manifest = await source.listChangedFiles({ snapshot });
        const entry = (investigationResultValue(manifest) ?? []).find((file) => file.path === declined.path);
        expect(entry, `${declined.path} must be enumerated: a declined file is one the platform named`).toBeDefined();
        expect(entry?.contentDeclined).toBe(true);
        expect(entry?.binary).toBe(false);

        const read = await source.readDiff({ snapshot, path: declined.path });
        expect(read.state).toBe('contentDeclined');
        expect(read.snapshot).toEqual(snapshot);
      });
    }

    it('withholds or reports unavailable for every operation this source does not declare supported', async () => {
      const source = await harness.makeSource();
      const snapshot = snapshotAt(harness.headSha);

      function assertNotComplete(result: { state: string } | undefined): void {
        if (result) expect(result.state).not.toBe('complete');
      }

      if (!caps.manifests.supported) assertNotComplete(await source.listChangedFiles({ snapshot }));
      if (!caps.diffReads.supported) assertNotComplete(await source.readDiff({ snapshot, path: inv.changedFilePath }));
      if (!caps.fileReads.supported) {
        assertNotComplete(
          await source.readFile({ snapshot, revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 }),
        );
      }
      if (!caps.repositorySearch.supported) {
        assertNotComplete(await source.searchRepository({ snapshot, revision: 'head', query: inv.matchQuery }));
      }
      if (!caps.diffSearch.supported) assertNotComplete(await source.searchDiff({ snapshot, query: inv.matchQuery }));
    });

    if (harness.makeRateLimitedSource && caps.fileReads.supported) {
      it('surfaces a rate-limited read as the neutral retryable error', async () => {
        const source = await harness.makeRateLimitedSource!();
        await expect(
          source.readFile({ snapshot: snapshotAt(harness.headSha), revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 }),
        ).rejects.toMatchObject({ kind: 'rateLimited' });
      });
    }
  });
}
