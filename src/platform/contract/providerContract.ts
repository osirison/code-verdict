/**
 * The provider contract: a reusable conformance suite every `ScmProvider`
 * implementation must pass (fixture today, GitLab next, any future provider
 * after). Adding a provider means making this suite green — see
 * docs/ARCHITECTURE.md "Adding a provider".
 */
import { describe, expect, it } from 'vitest';
import type { Connection, ProviderCapabilities } from '../provider';
import type { ChangeRequestRef, ReviewCommentDraft } from '../types';
import { investigationResultValue } from '../types';

export interface ProviderContractHarness {
  capabilities: ProviderCapabilities;
  makeConnection(): Connection | Promise<Connection>;
  /**
   * A connection whose SECOND line-comment write fails with a `staleAnchor`
   * error while the first succeeds — exercises partial-failure reporting.
   */
  makeFailingConnection?(): Connection | Promise<Connection>;
  /**
   * Whether THIS HARNESS's backing store actually remembers a
   * replyToThread/resolveThread write and plays it back on the next
   * listThreads — never a statement about the provider. Every provider must
   * implement both calls correctly; this only says whether the double behind
   * a given harness can observe that. A harness backed by a real emulator or
   * an in-memory fake can say true; one backed by a fixed, static response
   * table (as GitHub's and GitLab's REST fakes are today — see
   * fakeGitHub.ts's `graphqlResponse()` and fakeGitLab.ts's discussions
   * route, both of which hand back the same canned payload no matter what
   * was just posted) must leave it unset, or the case would fail for a
   * reason that has nothing to do with the provider under test.
   */
  threadMutationsPersist?: boolean;
  inputs: {
    /** Resolves to a repository (URL or path form). */
    repository: string;
    /** Resolves to a group; required when capabilities.groupHierarchy. */
    group?: string;
    /** A syntactically valid numeric id the token cannot see. */
    notVisible: string;
    /** Garbage that must resolve to noMatch, never silently added. */
    noMatch: string;
  };
  expected: {
    repoId: string;
    repoPath: string;
    groupId?: string;
  };
  /** An open change request that has a diff. */
  crRef: ChangeRequestRef;
  /** A file/line pair inside that diff a comment can anchor to. */
  anchor: { filePath: string; line: number };
  /**
   * Review-investigation inputs (design.md D7, tasks 3.6/3.7). Required only
   * once `capabilities.reviewInvestigation` is declared; every case below is
   * a no-op otherwise, until a provider's implementation and honest
   * capability declaration land together (section 4).
   */
  investigation?: {
    /** The base SHA `crRef`'s diff is relative to — `ChangeRequestDiff` itself carries only `headSha`. */
    baseSha: string;
    /** A non-binary path present in `crRef`'s diff. */
    changedFilePath: string;
    /** A path known to be binary at `crRef`'s head; omit to skip the binary case. */
    binaryFilePath?: string;
    /** A base/head pair strictly older than `crRef`'s current tip, proving no branch-tip substitution (task 3.7). */
    priorRevision?: { baseSha: string; headSha: string };
    /** A search query guaranteed to match nothing. */
    noMatchQuery: string;
    /** A search query guaranteed to match at least once under `changedFilePath`. */
    matchQuery: string;
  };
  /**
   * A connection whose review-investigation reads always fail with a
   * `rateLimited` `ScmError` — exercises task 3.5's retryability without a
   * real 429.
   */
  makeRateLimitedInvestigationConnection?(): Connection | Promise<Connection>;
}

export function describeProviderContract(label: string, harness: ProviderContractHarness): void {
  const { inputs, expected } = harness;

  describe(`provider contract: ${label}`, () => {
    it('testConnection reports the signed-in user', async () => {
      const conn = await harness.makeConnection();
      const status = await conn.testConnection();
      expect(status.ok).toBe(true);
      expect(status.username).toBeTruthy();
    });

    it('resolves a repository input', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.repository);
      expect(res.kind).toBe('repository');
      if (res.kind === 'repository') {
        expect(res.repo.id).toBe(expected.repoId);
        expect(res.repo.path).toBe(expected.repoPath);
      }
    });

    if (harness.capabilities.groupHierarchy) {
      it('resolves a group input to a repository chooser', async () => {
        const conn = await harness.makeConnection();
        const res = await conn.resolveSource(inputs.group as string);
        expect(res.kind).toBe('group');
        if (res.kind === 'group') {
          expect(res.group.id).toBe(expected.groupId);
          expect(res.repositories.length).toBeGreaterThan(0);
        }
      });
    }

    it('reports an unseen numeric id as notVisible, never adding it', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.notVisible);
      expect(res.kind).toBe('notVisible');
    });

    it('reports garbage input as noMatch', async () => {
      const conn = await harness.makeConnection();
      const res = await conn.resolveSource(inputs.noMatch);
      expect(res.kind).toBe('noMatch');
    });

    it('lists open change requests batched per repository', async () => {
      const conn = await harness.makeConnection();
      const crs = await conn.listOpenChangeRequests([expected.repoId]);
      expect(crs.length).toBeGreaterThan(0);
      for (const cr of crs) {
        expect(cr.ref.repoId).toBe(expected.repoId);
        expect(cr.state).toBe('open');
        expect(cr.headSha).toBeTruthy();
        expect(cr.webUrl).toBeTruthy();
      }
    });

    it('returns a diff whose anchors round-trip into a successful submit', async () => {
      const conn = await harness.makeConnection();
      const diff = await conn.getChangeRequestDiff(harness.crRef);
      expect(diff.headSha).toBeTruthy();
      expect(diff.files.length).toBeGreaterThan(0);

      const comments: ReviewCommentDraft[] = [
        {
          key: 'c1',
          body: 'Contract test comment one.',
          anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
        },
        {
          key: 'c2',
          body: 'Contract test comment two.',
          anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
          suggestion: { old: 'const a = 1', new: 'const a = 2' },
        },
      ];
      const result = await conn.submitReview(harness.crRef, {
        comments,
        summary: 'Contract test summary.',
      });

      expect(result.comments.map((c) => c.key)).toEqual(['c1', 'c2']);
      expect(result.comments.every((c) => c.ok)).toBe(true);
      expect(result.summaryPosted).toBe(true);
    });

    it('lists threads with notes and anchor presence', async () => {
      const conn = await harness.makeConnection();
      const threads = await conn.listThreads(harness.crRef);
      expect(threads.length).toBeGreaterThan(0);
      for (const t of threads) {
        expect(t.id).toBeTruthy();
        expect(t.notes.length).toBeGreaterThan(0);
        expect(typeof t.anchorPresent).toBe('boolean');
      }
    });

    // Closes the gap named in issue #33: every provider declares
    // replyToThread/resolveThread, and until now nothing in the shared suite
    // called either one. Gated on threadMutationsPersist — see that field's
    // comment for why a harness may legitimately sit this out.
    if (harness.threadMutationsPersist) {
      it('replyToThread posts a note that a subsequent listThreads returns on the same thread', async () => {
        const conn = await harness.makeConnection();
        const before = await conn.listThreads(harness.crRef);
        const target = before[0];
        expect(target).toBeDefined();
        // Captured as a number, not read off `target` afterwards: a provider
        // backed by an in-memory store may hand out live references, so the
        // object in `before` is the very one the reply mutates and comparing
        // against it compares a value with itself.
        const notesBefore = target?.notes.length ?? 0;
        const marker = 'Contract test reply — round trip check.';

        await conn.replyToThread(harness.crRef, target?.id as string, marker);

        const after = await conn.listThreads(harness.crRef);
        const updated = after.find((t) => t.id === target?.id);
        expect(updated?.notes.some((n) => n.body === marker)).toBe(true);
        expect(updated?.notes.length).toBe(notesBefore + 1);
      });

      it('resolveThread(true) marks a thread resolved, and resolveThread(false) reverses it', async () => {
        const conn = await harness.makeConnection();
        const threads = await conn.listThreads(harness.crRef);
        // Not threads[0]: a seeded fixture can start with its first thread
        // already resolved, which would make the "marks resolved" half of
        // this case pass trivially — it never toggled anything.
        const target = threads.find((t) => !t.resolved) ?? threads[0];
        expect(target).toBeDefined();

        await conn.resolveThread(harness.crRef, target?.id as string, true);
        const resolved = (await conn.listThreads(harness.crRef)).find((t) => t.id === target?.id);
        expect(resolved?.resolved).toBe(true);

        await conn.resolveThread(harness.crRef, target?.id as string, false);
        const reopened = (await conn.listThreads(harness.crRef)).find((t) => t.id === target?.id);
        expect(reopened?.resolved).toBe(false);
      });
    }

    if (harness.makeFailingConnection) {
      it('reports per-comment outcomes on partial failure and withholds the summary', async () => {
        const conn = await harness.makeFailingConnection!();
        const diff = await conn.getChangeRequestDiff(harness.crRef);
        const result = await conn.submitReview(harness.crRef, {
          comments: [
            {
              key: 'ok',
              body: 'Lands.',
              anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
            },
            {
              key: 'fails',
              body: 'Does not land.',
              anchor: { filePath: harness.anchor.filePath, line: harness.anchor.line, refs: diff.anchorRefs },
            },
          ],
          summary: 'Must not be posted.',
        });

        const [first, second] = result.comments;
        expect(first?.ok).toBe(true);
        expect(second?.ok).toBe(false);
        expect(second?.error?.kind).toBe('staleAnchor');
        expect(result.summaryPosted).toBe(false);
      });
    }

    // Review-investigation contract (design.md D7, tasks 3.6/3.7). Gated per
    // operation on the harness's own declared capability, mirroring
    // `groupHierarchy` above — every case here is a no-op until a provider
    // declares `reviewInvestigation` and implements it (section 4).
    if (harness.capabilities.reviewInvestigation && harness.investigation) {
      const caps = harness.capabilities.reviewInvestigation;
      const inv = harness.investigation;
      const snapshotAt = (headSha: string) => ({ repoId: expected.repoId, baseSha: inv.baseSha, headSha });

      if (caps.manifests.supported) {
        it('manifest pagination enumerates every changed file and terminates complete', async () => {
          const conn = await harness.makeConnection();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          const snapshot = snapshotAt(diff.headSha);
          const seenPaths = new Set<string>();
          let cursor: string | undefined;
          for (let page = 0; page < 50; page++) {
            const result = await conn.listChangedFiles!({ snapshot, cursor });
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
      }

      if (caps.fileReads.supported && inv.priorRevision) {
        const priorRevision = inv.priorRevision;
        it('pins a file read to the exact requested revision, never a branch tip (task 3.7)', async () => {
          const conn = await harness.makeConnection();
          const snapshot = { repoId: expected.repoId, baseSha: priorRevision.baseSha, headSha: priorRevision.headSha };
          const result = await conn.readFile!({ snapshot, revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 });
          expect(result.snapshot).toEqual(snapshot);
        });
      }

      if (caps.fileReads.supported) {
        it('bounds a file range read to the declared page bound', async () => {
          const conn = await harness.makeConnection();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          const bound = (caps.fileReads.pageBound ?? caps.pagination).maxPageSize;
          const result = await conn.readFile!({
            snapshot: snapshotAt(diff.headSha),
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
            const conn = await harness.makeConnection();
            const diff = await conn.getChangeRequestDiff(harness.crRef);
            const result = await conn.readFile!({
              snapshot: snapshotAt(diff.headSha),
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
          const conn = await harness.makeConnection();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          const result = await conn.searchRepository!({ snapshot: snapshotAt(diff.headSha), revision: 'head', query: inv.noMatchQuery });
          expect(result.state).toBe('complete');
          expect(investigationResultValue(result)).toEqual([]);
        });

        it('search returns at least one match for a query known to hit', async () => {
          const conn = await harness.makeConnection();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          const result = await conn.searchRepository!({ snapshot: snapshotAt(diff.headSha), revision: 'head', query: inv.matchQuery });
          expect(investigationResultValue(result)?.length ?? 0).toBeGreaterThan(0);
        });
      }

      if (caps.changeRequestDetails.supported) {
        it('normalizes change-request details with explicit unavailable sections, never a raw payload', async () => {
          const conn = await harness.makeConnection();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          const result = await conn.getChangeRequestDetails!({ snapshot: snapshotAt(diff.headSha), number: harness.crRef.number });
          const value = investigationResultValue(result);
          if (!value) return;
          expect(typeof value.title).toBe('string');
          expect(Array.isArray(value.unavailableSections)).toBe(true);
        });
      }

      it('withholds or reports unavailable for every operation the provider does not declare supported', async () => {
        const conn = await harness.makeConnection();
        const diff = await conn.getChangeRequestDiff(harness.crRef);
        const snapshot = snapshotAt(diff.headSha);

        function assertNotComplete(result: { state: string } | undefined): void {
          if (result) expect(result.state).not.toBe('complete');
        }

        if (!caps.manifests.supported) assertNotComplete(await conn.listChangedFiles?.({ snapshot }));
        if (!caps.diffReads.supported) assertNotComplete(await conn.readDiff?.({ snapshot, path: inv.changedFilePath }));
        if (!caps.fileReads.supported) {
          assertNotComplete(
            await conn.readFile?.({ snapshot, revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 }),
          );
        }
        if (!caps.repositorySearch.supported) {
          assertNotComplete(await conn.searchRepository?.({ snapshot, revision: 'head', query: inv.matchQuery }));
        }
        if (!caps.diffSearch.supported) assertNotComplete(await conn.searchDiff?.({ snapshot, query: inv.matchQuery }));
        if (!caps.changeRequestDetails.supported) {
          assertNotComplete(await conn.getChangeRequestDetails?.({ snapshot, number: harness.crRef.number }));
        }
        if (!caps.issueDetails.supported) {
          assertNotComplete(
            await conn.getIssueDetails?.({ snapshot, issueRepoId: expected.repoId, issueNumber: harness.crRef.number }),
          );
        }
      });

      if (harness.makeRateLimitedInvestigationConnection && caps.fileReads.supported) {
        it('surfaces a rate-limited investigation read as the neutral retryable error', async () => {
          const conn = await harness.makeRateLimitedInvestigationConnection!();
          const diff = await conn.getChangeRequestDiff(harness.crRef);
          await expect(
            conn.readFile!({ snapshot: snapshotAt(diff.headSha), revision: 'head', path: inv.changedFilePath, startLine: 1, endLine: 1 }),
          ).rejects.toMatchObject({ kind: 'rateLimited' });
        });
      }
    }
  });
}
