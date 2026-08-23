/**
 * The provider contract: a reusable conformance suite every `ScmProvider`
 * implementation must pass (fixture today, GitLab next, any future provider
 * after). Adding a provider means making this suite green — see
 * docs/ARCHITECTURE.md "Adding a provider".
 */
import { describe, expect, it } from 'vitest';
import type { Connection, ProviderCapabilities } from '../provider';
import type { ChangeRequestRef, ReviewCommentDraft } from '../types';

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
  });
}
